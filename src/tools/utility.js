import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import http from 'http';

const execAsync = promisify(exec);

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

      // Already connected — nothing to do
      if (this.cdp.isConnected()) {
        return this.success({
          success: true,
          already_running: true,
          connected: true,
          port,
          message: 'TradingView is already running and connected',
        });
      }

      const platform = process.platform;
      let tvExe = null;

      if (platform === 'win32') {
        // Option A: MSIX / Microsoft Store install — path changes on each app update
        try {
          const { stdout } = await execAsync(
            'powershell -Command "(Get-AppxPackage -Name *TradingView* | Select-Object -First 1).InstallLocation"',
            { timeout: 5000 }
          );
          const loc = stdout.trim();
          if (loc) tvExe = `${loc}\\TradingView.exe`;
        } catch {}

        // Option B: non-MSIX .exe installer
        if (!tvExe) {
          tvExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
        }

        // Kill any existing instance so it restarts with the debug flag
        try {
          await execAsync('taskkill /IM TradingView.exe /F', { timeout: 3000 });
          await new Promise((r) => setTimeout(r, 2000));
        } catch {} // fine if nothing was running

        spawn(tvExe, [`--remote-debugging-port=${port}`], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else if (platform === 'darwin') {
        tvExe = '/Applications/TradingView.app/Contents/MacOS/TradingView';
        try {
          await execAsync('pkill -f TradingView', { timeout: 3000 });
          await new Promise((r) => setTimeout(r, 2000));
        } catch {}
        spawn(tvExe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
      } else if (platform === 'linux') {
        tvExe = '/opt/TradingView/tradingview';
        try {
          await execAsync('pkill -f tradingview', { timeout: 3000 });
          await new Promise((r) => setTimeout(r, 2000));
        } catch {}
        spawn(tvExe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
      } else {
        return this.error(`Unsupported platform: ${platform}`);
      }

      // Poll localhost:PORT/json/version until CDP is ready (up to 30s)
      const ready = await this._pollCDP(port, 30000);

      if (ready) {
        // Reset retry counter so connect() works after previous failures
        this.cdp.retryCount = 0;
        await this.cdp.connect();
        return this.success({
          success: true,
          platform,
          port,
          message: `TradingView launched and CDP connected on port ${port}`,
        });
      }

      return this.success({
        success: false,
        platform,
        port,
        message: 'TradingView launched but CDP did not respond within 30s',
        hint:
          platform === 'win32'
            ? 'MSIX sandbox may block the debug flag — install the non-MSIX .exe from tradingview.com/desktop'
            : 'Check that TradingView started correctly',
      });
    } catch (error) {
      return this.error(`Failed to launch TradingView: ${error.message}`);
    }
  }

  // Poll http://localhost:PORT/json/version every 1s until it responds or timeout elapses.
  _pollCDP(port, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const attempt = () => {
        const req = http.get(
          { hostname: 'localhost', port, path: '/json/version', timeout: 1000 },
          (res) => {
            res.resume();
            resolve(true);
          }
        );
        req.on('error', () => {
          if (Date.now() - start < timeoutMs) setTimeout(attempt, 1000);
          else resolve(false);
        });
        req.on('timeout', () => req.destroy());
      };
      attempt();
    });
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
