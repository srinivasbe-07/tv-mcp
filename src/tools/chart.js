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

            // Primary: walk chart model → mainSeries() → bars() → valueAt(i)
            // Each bar is [timestamp, open, high, low, close, volume]
            const model = window.TradingViewApi
              ?._activeChartWidgetWV?._value
              ?._chartWidget?._modelWV?._value;
            const barsStore = model?.mainSeries?.()?.bars?.();

            if (barsStore && barsStore.size() > 0) {
              const lastIdx = barsStore.lastIndex();
              const firstIdx = barsStore.firstIndex();
              const startIdx = Math.max(firstIdx, lastIdx - ${limit} + 1);
              for (let i = startIdx; i <= lastIdx; i++) {
                const b = barsStore.valueAt(i);
                if (!b) continue;
                const v = Array.isArray(b) ? b : (b.value || []);
                if (v.length >= 5) {
                  bars.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] ?? 0 });
                }
              }
            }

            // Fallback: read single bar from center panel legend
            if (bars.length === 0) {
              const center = document.querySelector('.layout__area--center');
              const lines = (center?.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
              let o='', h='', l='', c='', v='';
              for (let i = 0; i < lines.length; i++) {
                if (lines[i] === 'O') o = lines[i+1] || '';
                else if (lines[i] === 'H') h = lines[i+1] || '';
                else if (lines[i] === 'L') l = lines[i+1] || '';
                else if (lines[i] === 'C') c = lines[i+1] || '';
                else if (lines[i] === 'Vol') v = lines[i+1] || '';
              }
              if (c) bars = [{ time: Math.floor(Date.now()/1000), open: o, high: h, low: l, close: c, volume: v }];
            }

            const source = bars.length > 1 ? 'series_api' : bars.length === 1 ? 'center_panel' : 'unavailable';

            if (${summary}) {
              const last5 = bars.slice(-5);
              const closes = bars.map(b => parseFloat(b.close) || 0).filter(Boolean);
              const highs  = bars.map(b => parseFloat(b.high)  || 0).filter(Boolean);
              const lows   = bars.map(b => parseFloat(b.low)   || 0).filter(Boolean);
              return {
                summary: true,
                source,
                count: bars.length,
                bars: last5,
                stats: closes.length ? {
                  high: Math.max(...highs).toFixed(2),
                  low:  Math.min(...lows).toFixed(2),
                  close: closes[closes.length - 1].toFixed(2),
                  avg:  (closes.reduce((a, b) => a + b, 0) / closes.length).toFixed(2),
                } : null,
              };
            }
            return { summary: false, source, count: bars.length, bars };
          } catch (e) {
            return { error: e.message };
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
            // Attempt 1: TradingViewApi widget.setSymbol()
            const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
            if (widget) {
              const methodNames = ['setSymbol', 'changeSymbol', 'setTicker'];
              for (const m of methodNames) {
                if (typeof widget[m] === 'function') {
                  widget[m]('${symbol}');
                  await new Promise(r => setTimeout(r, 500));
                  return { success: true, symbol: '${symbol}', via: m };
                }
              }
            }

            // Attempt 2: Keyboard search — stable data-name button + execCommand input
            const searchBtn = document.querySelector('[data-name="header-toolbar-quick-search"]');
            if (searchBtn) {
              searchBtn.click();
              await new Promise(r => setTimeout(r, 600));

              // React-controlled input: focus + execCommand to trigger synthetic events
              const input = document.querySelector('input.input-qm7Rg5MB') ||
                            document.querySelector('input[role="searchbox"]') ||
                            document.querySelector('input[class*="input"]');

              if (input) {
                input.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, '${symbol}');
                await new Promise(r => setTimeout(r, 1000));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
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
