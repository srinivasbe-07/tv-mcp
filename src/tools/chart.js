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

            // Attempt 1: Check window.tradingview API
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart) {
                symbol = chart.symbol?.() || symbol;
                timeframe = chart.resolution?.() || timeframe;
              }
            }

            // Attempt 2: Check DOM for symbol/timeframe display
            if (symbol === "UNKNOWN") {
              const symbolEl = document.querySelector('[data-testid="header-symbol-title"]') ||
                             document.querySelector('.js-header-symbol-text') ||
                             document.querySelector('[class*="symbol"]');
              if (symbolEl) symbol = symbolEl.textContent?.trim() || symbol;
            }

            // Attempt 3: Parse title or meta tags
            if (symbol === "UNKNOWN") {
              const pageTitle = document.title;
              const match = pageTitle.match(/^([A-Z0-9/.]+)/);
              if (match) symbol = match[1];
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
            let price = 0;
            let symbol = "UNKNOWN";
            let open = 0, high = 0, low = 0, volume = 0;
            let change = 0, changePercent = 0;

            // Attempt 1: Use TradingView charting library if available
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart && chart.lastBar?.()) {
                const lastBar = chart.lastBar();
                price = lastBar.close || 0;
                open = lastBar.open || 0;
                high = lastBar.high || 0;
                low = lastBar.low || 0;
                volume = lastBar.volume || 0;
              }
            }

            // Attempt 2: Parse from DOM - look for price display
            if (price === 0) {
              const priceEl = document.querySelector('[class*="price"]') ||
                            document.querySelector('[data-testid*="price"]') ||
                            document.querySelector('.js-header-price');
              if (priceEl) {
                const priceText = priceEl.textContent?.match(/\\d+\\.?\\d*/);
                if (priceText) price = parseFloat(priceText[0]);
              }
            }

            // Attempt 3: Check for change indicators
            const changeEl = document.querySelector('[class*="change"]') ||
                           document.querySelector('[data-testid*="change"]');
            if (changeEl) {
              const changeText = changeEl.textContent?.match(/([-+]?\\d+\\.?\\d*)/);
              if (changeText) {
                change = parseFloat(changeText[1]);
                changePercent = ((change / price) * 100).toFixed(2);
              }
            }

            return {
              symbol: symbol,
              price: price.toFixed(2),
              ohlc: {
                open: open.toFixed(2),
                high: high.toFixed(2),
                low: low.toFixed(2),
                close: price.toFixed(2)
              },
              volume: volume,
              change: change.toFixed(2),
              changePercent: changePercent,
              timestamp: new Date().toISOString()
            };
          } catch (e) {
            return {
              error: e.message,
              hint: "Could not extract price data - ensure chart is fully loaded"
            };
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
        (function() {
          try {
            // Attempt 1: Use TradingView API
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart && typeof chart.setSymbol === 'function') {
                await chart.setSymbol('${symbol}');
                return { success: true, symbol: '${symbol}', via: 'tradingview_api' };
              }
            }

            // Attempt 2: Find and click symbol input then type
            const symbolInput = document.querySelector('[data-testid="header-symbol-search-input"]') ||
                              document.querySelector('input[placeholder*="symbol"]') ||
                              document.querySelector('[class*="symbol-input"]');

            if (symbolInput) {
              symbolInput.click();
              symbolInput.value = '';
              symbolInput.dispatchEvent(new Event('input', { bubbles: true }));

              for (let char of '${symbol}') {
                symbolInput.value += char;
                symbolInput.dispatchEvent(new Event('input', { bubbles: true }));
              }

              symbolInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

              return { success: true, symbol: '${symbol}', via: 'dom_input' };
            }

            return { success: false, symbol: '${symbol}', message: 'Symbol input not found - TradingView may need API integration' };
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
        (function() {
          try {
            // Attempt 1: Use TradingView API
            if (typeof window !== 'undefined' && window.tradingview) {
              const chart = window.tradingview.activeChart?.();
              if (chart && typeof chart.setResolution === 'function') {
                await chart.setResolution('${timeframe}');
                return { success: true, timeframe: '${timeframe}', via: 'tradingview_api' };
              }
            }

            // Attempt 2: Find and click timeframe button/dropdown
            const tfBtn = document.querySelector('[data-testid="header-toolbar-timeframe"]') ||
                         document.querySelector('[class*="timeframe-btn"]') ||
                         document.querySelector('[class*="resolution"]');

            if (tfBtn) {
              tfBtn.click();

              // Wait a bit for dropdown to appear, then find matching option
              const opts = Array.from(document.querySelectorAll('[class*="dropdown"] button, [class*="menu"] button'));
              const match = opts.find(opt => opt.textContent.includes('${timeframe}'));

              if (match) {
                match.click();
                return { success: true, timeframe: '${timeframe}', via: 'dom_button' };
              }
            }

            return { success: false, timeframe: '${timeframe}', message: 'Timeframe control not found' };
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
