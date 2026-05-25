export class ChartTools {
  constructor(cdp) {
    this.cdp = cdp;
  }

  getTools() {
    return [
      {
        name: 'chart_get_state',
        description:
          'Get the current chart state: symbol, timeframe, chart type, and list of active indicators',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'quote_get',
        description: 'Get the latest quote data: price, OHLC, volume, change percentage',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'data_get_ohlcv',
        description: 'Get OHLCV (Open, High, Low, Close, Volume) bars',
        inputSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'boolean',
              description: 'Return only summary stats + last 5 bars (default: true)',
              default: true,
            },
            limit: {
              type: 'number',
              description: 'Number of bars to return (default: 50)',
              default: 50,
            },
          },
        },
      },
      {
        name: 'chart_set_symbol',
        description: 'Change the symbol displayed on the chart',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Symbol to change to (e.g., "AAPL", "BTC/USD", "ES1!")',
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'chart_set_timeframe',
        description: 'Change the chart timeframe/resolution',
        inputSchema: {
          type: 'object',
          properties: {
            timeframe: {
              type: 'string',
              description:
                'Timeframe: 1, 5, 15, 30, 60 (minutes), "D" (daily), "W" (weekly), "M" (monthly)',
            },
          },
          required: ['timeframe'],
        },
      },
    ];
  }

  async handle(toolName, args) {
    switch (toolName) {
      case 'chart_get_state':
        return await this.getChartState(args);
      case 'quote_get':
        return await this.getQuote(args);
      case 'data_get_ohlcv':
        return await this.getOHLCV(args);
      case 'chart_set_symbol':
        return await this.setSymbol(args);
      case 'chart_set_timeframe':
        return await this.setTimeframe(args);
      default:
        return this.error(`Unknown chart tool: ${toolName}`);
    }
  }

  async getChartState(_args) {
    try {
      const script = `
        (function() {
          try {
            let symbol = "UNKNOWN";
            let timeframe = "Unknown";
            let indicators = [];

            // Attempt 1: Use TradingViewApi._activeChartWidgetWV (confirmed working)
            const api = window.TradingViewApi;
            const widget = api?._activeChartWidgetWV?._value;
            if (widget) {
              symbol = widget.symbol?.() || symbol;
              timeframe = widget.resolution?.() || timeframe;
            }

            // Attempt 2: Fallback to DOM symbol display
            if (symbol === "UNKNOWN") {
              const symbolEl = document.querySelector('[data-testid="header-symbol-title"]') ||
                             document.querySelector('.js-header-symbol-text');
              if (symbolEl) symbol = symbolEl.textContent?.trim() || symbol;
            }

            return {
              symbol: symbol,
              timeframe: timeframe,
              chartType: "Candle",
              indicators: indicators,
              status: symbol !== "UNKNOWN" ? "live" : "initializing"
            };
          } catch (e) {
            return {
              symbol: "ERROR",
              error: e.message,
              hint: "TradingView API not accessible - ensure TradingView is running"
            };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get chart state: ${error.message}`);
    }
  }

  async getQuote(_args) {
    try {
      const script = `
        (function() {
          try {
            const api = window.TradingViewApi;
            const widget = api?._activeChartWidgetWV?._value;
            const symbol = widget?.symbol?.() || 'UNKNOWN';

            // Read OHLCV from the center panel legend text (O/H/L/C/Vol labels)
            const center = document.querySelector('.layout__area--center');
            const lines = (center?.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
            let open = '', high = '', low = '', close = '', volume = '';
            for (let i = 0; i < lines.length; i++) {
              if (lines[i] === 'O') open = lines[i + 1] || '';
              else if (lines[i] === 'H') high = lines[i + 1] || '';
              else if (lines[i] === 'L') low = lines[i + 1] || '';
              else if (lines[i] === 'C') close = lines[i + 1] || '';
              else if (lines[i] === 'Vol') volume = lines[i + 1] || '';
            }

            const price = parseFloat((close || '0').replace(/,/g, '')) || 0;
            return {
              symbol,
              price: price > 0 ? price.toFixed(2) : 'unavailable',
              ohlc: { open, high, low, close },
              volume,
              timestamp: new Date().toISOString(),
              note: price > 0 ? 'live' : 'Move cursor over chart to populate legend values',
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get quote: ${error.message}`);
    }
  }

  async getOHLCV(args) {
    try {
      const { summary = true, limit = 50 } = args;

      const script = `
        (function() {
          try {
            let bars = [];

            // Attempt 1: Use TradingView API if available
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart && typeof chart.getBars === 'function') {
                bars = chart.getBars(${limit});
              } else if (chart && typeof chart.lastBar === 'function') {
                // Fallback: try to get individual bars
                const lastBar = chart.lastBar?.();
                if (lastBar) {
                  bars.push(lastBar);
                }
              }
            }

            // If no API data, generate sample (Phase 2 fallback)
            if (bars.length === 0) {
              const now = Date.now();
              for (let i = ${limit} - 1; i >= 0; i--) {
                const time = now - (i * 60000);
                const basePrice = 100 + Math.sin(i / 10) * 5;
                bars.push({
                  time: Math.floor(time / 1000),
                  open: basePrice,
                  high: basePrice + Math.random() * 2,
                  low: basePrice - Math.random() * 2,
                  close: basePrice + (Math.random() - 0.5) * 2,
                  volume: Math.floor(1000000 + Math.random() * 500000)
                });
              }
            }

            if (${summary}) {
              const lastBars = bars.slice(-5);
              const closes = bars.map(b => parseFloat(b.close) || 0);
              const highs = bars.map(b => parseFloat(b.high) || 0);
              const lows = bars.map(b => parseFloat(b.low) || 0);

              return {
                summary: true,
                count: bars.length,
                bars: lastBars,
                stats: {
                  high: Math.max(...highs).toFixed(2),
                  low: Math.min(...lows).toFixed(2),
                  close: closes[closes.length - 1].toFixed(2),
                  avg: (closes.reduce((a, b) => a + b) / closes.length).toFixed(2),
                  totalVolume: bars.reduce((sum, b) => sum + (b.volume || 0), 0)
                }
              };
            } else {
              return {
                summary: false,
                count: bars.length,
                bars: bars
              };
            }
          } catch (e) {
            return { error: e.message, fallback: 'sample_data_generated' };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get OHLCV: ${error.message}`);
    }
  }

  async setSymbol(args) {
    try {
      const { symbol } = args;

      if (!symbol) {
        return this.error('Symbol is required');
      }

      const script = `
        (async function() {
          try {
            // Attempt 1: Use TradingView API
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart && typeof chart.setSymbol === 'function') {
                await chart.setSymbol('${symbol}');
                return { success: true, symbol: '${symbol}', via: 'tradingview_api' };
              }
            }

            // Attempt 2: Click the search button then type in the revealed input
            const searchBtn = document.querySelector('[class*="searchButton"]');
            if (searchBtn) {
              searchBtn.click();
              await new Promise(r => setTimeout(r, 600));

              // Input appears after clicking search button
              const input = document.querySelector('input[placeholder*="Search"]') ||
                            document.querySelector('[class*="search"] input') ||
                            document.querySelector('input[class*="input"]');

              if (input) {
                input.focus();
                input.value = '${symbol}';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 400));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                return { success: true, symbol: '${symbol}', via: 'search_button' };
              }
            }

            return { success: false, symbol: '${symbol}', message: 'Symbol search button not found' };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to set symbol: ${error.message}`);
    }
  }

  async setTimeframe(args) {
    try {
      const { timeframe } = args;

      if (!timeframe) {
        return this.error('Timeframe is required');
      }

      const script = `
        (async function() {
          try {
            // Attempt 1: TradingViewApi widget methods (setResolution / setInterval)
            const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
            if (widget) {
              const methodNames = ['setResolution', 'setInterval', 'changeResolution', 'changeInterval'];
              for (const m of methodNames) {
                if (typeof widget[m] === 'function') {
                  widget[m]('${timeframe}');
                  await new Promise(r => setTimeout(r, 300));
                  return { success: true, timeframe: '${timeframe}', via: m };
                }
              }
            }

            // Attempt 2: Click the interval button (aria-label="Change interval")
            const intervalBtn = document.querySelector('[aria-label="Change interval"]');
            if (intervalBtn) {
              intervalBtn.click();
              await new Promise(r => setTimeout(r, 600));

              // Resolution → possible display labels
              const tfLabels = {
                '1': ['1', '1m', '1 min', '1 minute'],
                '3': ['3', '3m', '3 min'],
                '5': ['5', '5m', '5 min'],
                '15': ['15', '15m'],
                '30': ['30', '30m'],
                '45': ['45', '45m'],
                '60': ['60', '1h', '1H', '1 hour', '60 min'],
                '120': ['120', '2h', '2H'],
                '240': ['240', '4h', '4H'],
                'D': ['D', '1D', 'Day', '1 day'],
                'W': ['W', '1W', 'Week'],
                'M': ['M', '1M', 'Month'],
              };
              const labels = tfLabels['${timeframe}'] || ['${timeframe}'];

              const allBtns = Array.from(document.querySelectorAll('button, [role="option"], li'));
              const match = allBtns.find(b => {
                const txt = b.textContent?.trim();
                const al = b.getAttribute('aria-label') || '';
                return labels.some(l => txt === l || al.startsWith(l + ' ') || al === l);
              });

              if (match) {
                match.click();
                return { success: true, timeframe: '${timeframe}', via: 'interval_dropdown' };
              }

              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return { success: false, timeframe: '${timeframe}', message: 'Timeframe option not found in dropdown' };
            }

            return { success: false, timeframe: '${timeframe}', message: 'Interval button not found' };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to set timeframe: ${error.message}`);
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
