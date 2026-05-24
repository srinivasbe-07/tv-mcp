import { exec } from 'child_process';
import { promisify } from 'util';

const _execAsync = promisify(exec);

export class UtilityTools {
  constructor(cdp) {
    this.cdp = cdp;
  }

  getTools() {
    return [
      {
        name: 'tv_health_check',
        description: 'Check if TradingView is connected and healthy',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'tv_launch',
        description: 'Launch TradingView with Chrome DevTools Protocol enabled',
        inputSchema: {
          type: 'object',
          properties: {
            port: {
              type: 'number',
              description: 'CDP port (default: 9222)',
              default: 9222,
            },
          },
        },
      },
      {
        name: 'capture_screenshot',
        description: 'Capture a screenshot of the chart',
        inputSchema: {
          type: 'object',
          properties: {
            region: {
              type: 'string',
              enum: ['full', 'chart', 'strategy_tester'],
              description: 'Region to capture (default: chart)',
              default: 'chart',
            },
          },
        },
      },
    ];
  }

  async handle(toolName, args) {
    switch (toolName) {
      case 'tv_health_check':
        return await this.healthCheck(args);
      case 'tv_launch':
        return await this.launch(args);
      case 'capture_screenshot':
        return await this.captureScreenshot(args);
      default:
        return this.error(`Unknown utility tool: ${toolName}`);
    }
  }

  async healthCheck(_args) {
    try {
      if (!this.cdp.isConnected()) {
        return this.success({
          status: 'disconnected',
          connected: false,
          port: 9222,
          message:
            'TradingView is not connected. Start TradingView with --remote-debugging-port=9222',
        });
      }

      // Try to get chart data
      try {
        const data = await this.cdp.getTradingViewChartData();

        return this.success({
          status: 'connected',
          connected: true,
          port: 9222,
          tradingview: data,
          timestamp: new Date().toISOString(),
          message: 'TradingView MCP is healthy and connected',
        });
      } catch (error) {
        return this.success({
          status: 'connected_but_no_data',
          connected: true,
          port: 9222,
          message: 'Connected to Chrome DevTools, but unable to read TradingView data',
          error: error.message,
        });
      }
    } catch (error) {
      return this.error(`Health check failed: ${error.message}`);
    }
  }

  async launch(args) {
    try {
      const { port = 9222 } = args;

      // Detect OS and launch TradingView
      const platform = process.platform;
      let command = null;

      if (platform === 'darwin') {
        // macOS
        command = `/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=${port}`;
      } else if (platform === 'win32') {
        // Windows
        command = `"%LOCALAPPDATA%\\TradingView\\TradingView.exe" --remote-debugging-port=${port}`;
      } else if (platform === 'linux') {
        // Linux
        command = `/opt/TradingView/tradingview --remote-debugging-port=${port}`;
      }

      if (!command) {
        return this.error(`Unsupported platform: ${platform}`);
      }

      return this.success({
        success: true,
        platform,
        command,
        port,
        message: `To launch TradingView with debugging, run: ${command}`,
        note: 'For manual launch, use the scripts in the scripts/ directory',
      });
    } catch (error) {
      return this.error(`Failed to launch: ${error.message}`);
    }
  }

  async captureScreenshot(args) {
    try {
      const { region = 'chart' } = args;

      try {
        const screenshot = await this.cdp.takeScreenshot(region);

        return this.success({
          success: true,
          region,
          format: 'png',
          size: screenshot.data.length,
          timestamp: new Date().toISOString(),
          data: screenshot.data.slice(0, 100) + '...', // Truncated for display
          message: `Screenshot captured (${region} region)`,
        });
      } catch (screenshotError) {
        return this.success({
          success: false,
          region,
          error: screenshotError.message,
          message: 'Note: Screenshot capture requires TradingView widget API integration',
        });
      }
    } catch (error) {
      return this.error(`Failed to capture screenshot: ${error.message}`);
    }
  }

  success(data) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  error(message) {
    return {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };
  }
}
