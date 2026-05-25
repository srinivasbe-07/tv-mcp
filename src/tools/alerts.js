export class AlertTools {
  constructor(cdp) {
    this.cdp = cdp;
  }

  getTools() {
    return [
      {
        name: 'alert_create',
        description: 'Create a price or volume alert',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Symbol for the alert',
            },
            condition: {
              type: 'string',
              enum: ['above', 'below', 'crosses'],
              description: 'Alert condition',
            },
            level: {
              type: 'number',
              description: 'Price level for the alert',
            },
            name: {
              type: 'string',
              description: 'Name for the alert',
            },
          },
          required: ['symbol', 'condition', 'level'],
        },
      },
      {
        name: 'alert_list',
        description: 'List all active alerts',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'alert_delete',
        description: 'Delete an alert by name (the name shown in the Alerts panel)',
        inputSchema: {
          type: 'object',
          properties: {
            alertId: {
              type: 'string',
              description: 'Name of the alert to delete (as shown in the Alerts panel)',
            },
          },
          required: ['alertId'],
        },
      },
    ];
  }

  async handle(toolName, args) {
    switch (toolName) {
      case 'alert_create':
        return await this.create(args);
      case 'alert_list':
        return await this.list(args);
      case 'alert_delete':
        return await this.delete(args);
      default:
        return this.error(`Unknown alert tool: ${toolName}`);
    }
  }

  async create(args) {
    try {
      const { symbol, condition, level, name } = args;

      if (!symbol || !condition || level === undefined) {
        return this.error('Symbol, condition, and level are required');
      }

      const alertId = `alert_${Date.now()}`;
      const alertName = name || `${symbol} ${condition} ${level}`;

      const script = `
        (async function() {
          try {
            // Step 1: Switch chart to target symbol so the dialog inherits it
            const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
            if (widget && typeof widget.setSymbol === 'function') {
              widget.setSymbol('${symbol}');
              await new Promise(r => setTimeout(r, 900));
            }

            // Step 2: Open Create Alert dialog (opens directly to conditions form using current chart symbol)
            const createBtn = document.querySelector('[data-name="set-alert-button"]');
            if (!createBtn) return { success: false, message: 'Create Alert button not found' };

            createBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Step 3: Set price level using React native setter to trigger state update
            const priceInput = document.querySelector('input.input-gr1VjUfr');
            if (!priceInput) return { success: false, message: 'Conditions form did not open after symbol selection' };

            priceInput.focus();
            await new Promise(r => setTimeout(r, 100));
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(priceInput, String(${level}));
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 400));
            priceInput.dispatchEvent(new Event('blur', { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));

            // Step 4: Click the Create button in the footer
            const form = document.querySelector('.form-h6NNXQD2');
            const submitBtn = form?.querySelector('[class*="submitBtn-"]') ||
                              document.querySelector('[class*="submitBtn-"]');
            if (!submitBtn) return { success: false, message: 'Create button not found in dialog footer' };

            submitBtn.click();
            await new Promise(r => setTimeout(r, 2000));

            // Step 5: Success = dialog closed (price input no longer in DOM)
            const dialogStillOpen = !!document.querySelector('input.input-gr1VjUfr');
            const success = !dialogStillOpen;

            return {
              success,
              alertId: '${alertId}',
              symbol: '${symbol}',
              condition: '${condition}',
              level: ${level},
              name: '${alertName}',
              created: new Date().toISOString(),
              message: success
                ? 'Alert created — dialog closed successfully'
                : 'Dialog still open — check plan limits or try again',
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to create alert: ${error.message}`);
    }
  }

  async list(_args) {
    try {
      const script = `
        (async function() {
          try {
            // Find the virtual-list scroll container by walking up from a known alert item
            const seedEl = document.querySelector('[data-name="alert-item-name"]');
            let scroller = null;
            let node = seedEl?.parentElement;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) { scroller = node; break; }
              node = node.parentElement;
            }

            // Read currently visible items, keyed by absolute Y-position in the virtual list.
            // Using absY (not name) as the dedup key correctly handles multiple alerts with the same name.
            const readCurrent = (byAbsY) => {
              const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
              const scrollTop = scroller ? scroller.scrollTop : 0;
              const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
              nameEls.forEach(nameEl => {
                let container = nameEl.parentElement;
                for (let i = 0; i < 6 && container; i++) {
                  if (container.querySelector('[data-name="alert-delete-button"]')) break;
                  container = container.parentElement;
                }
                const name = nameEl.innerText?.trim() || '';
                const symbol = container?.querySelector('[data-name="alert-item-ticker"]')?.innerText?.trim() || '';
                const status = container?.querySelector('[data-name="alert-item-status"]')?.innerText?.trim() || '';
                const rect = nameEl.getBoundingClientRect();
                const absY = scrollerRect
                  ? Math.round(rect.top - scrollerRect.top + scrollTop)
                  : 0;
                if (!byAbsY.has(absY)) {
                  byAbsY.set(absY, { name, symbol, status, absY });
                }
              });
            };

            const byAbsY = new Map();

            // Scroll from top through bottom in ~60% viewport steps, wait 600ms each for virtual re-render
            if (scroller) scroller.scrollTop = 0;
            await new Promise(r => setTimeout(r, 500));
            readCurrent(byAbsY);

            if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
              const maxScroll = scroller.scrollHeight - scroller.clientHeight;
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              for (let pos = step; pos < maxScroll; pos += step) {
                scroller.scrollTop = pos;
                await new Promise(r => setTimeout(r, 600));
                readCurrent(byAbsY);
              }
              // Always read at exact bottom too
              scroller.scrollTop = maxScroll;
              await new Promise(r => setTimeout(r, 600));
              readCurrent(byAbsY);
              // Restore to top
              scroller.scrollTop = 0;
              await new Promise(r => setTimeout(r, 300));
            }

            const alerts = Array.from(byAbsY.values())
              .sort((a, b) => a.absY - b.absY)
              .map((item, idx) => ({
                id: String(idx),
                name: item.name,
                symbol: item.symbol,
                status: item.status,
                active: !item.status.toLowerCase().includes('stop') && !item.status.toLowerCase().includes('pause'),
              }));

            return {
              alerts,
              total: alerts.length,
              active: alerts.filter(a => a.active).length,
              found: alerts.length > 0,
            };
          } catch (e) {
            return { error: e.message, alerts: [], total: 0 };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to list alerts: ${error.message}`);
    }
  }

  async delete(args) {
    try {
      const { alertId } = args;

      if (!alertId) {
        return this.error('Alert ID is required');
      }

      const script = `
        (async function() {
          try {
            // Find scroll container
            const seedEl = document.querySelector('[data-name="alert-item-name"]');
            let scroller = null;
            let node = seedEl?.parentElement;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) { scroller = node; break; }
              node = node.parentElement;
            }

            const tryDelete = () => {
              const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
              const target = nameEls.find(el => el.innerText?.trim() === '${alertId}');
              if (!target) return false;
              let container = target.parentElement;
              for (let i = 0; i < 6 && container; i++) {
                if (container.querySelector('[data-name="alert-delete-button"]')) break;
                container = container.parentElement;
              }
              const deleteBtn = container?.querySelector('[data-name="alert-delete-button"]');
              if (!deleteBtn) return false;
              deleteBtn.click();
              return true;
            };

            // Try at current position first
            if (tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };

            // Scroll through list to find and delete the alert
            if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
              const maxScroll = scroller.scrollHeight - scroller.clientHeight;
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              for (let pos = step; pos <= maxScroll; pos += step) {
                scroller.scrollTop = pos;
                await new Promise(r => setTimeout(r, 600));
                if (tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };
              }
              // Try exact bottom too
              scroller.scrollTop = maxScroll;
              await new Promise(r => setTimeout(r, 600));
              if (tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };
              scroller.scrollTop = 0;
            }

            return { success: false, alertId: '${alertId}', message: 'Alert not found — use the name shown in the Alerts panel' };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to delete alert: ${error.message}`);
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
