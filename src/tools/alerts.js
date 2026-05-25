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
            let created = false;

            // Attempt 1: Use TradingView alert API
            if (window.tradingview && typeof window.tradingview.createAlert === 'function') {
              window.tradingview.createAlert({
                symbol: '${symbol}',
                condition: '${condition}',
                level: ${level},
                name: '${alertName}'
              });
              created = true;
            }

            // Attempt 2: Find and interact with alert button
            const alertBtn = document.querySelector('[data-testid*="alert"]') ||
                            document.querySelector('[class*="alert-btn"]') ||
                            Array.from(document.querySelectorAll('button')).find(btn =>
                              btn.textContent.toLowerCase().includes('alert')
                            );

            if (alertBtn && !created) {
              alertBtn.click();
              // Wait for dialog to appear
              await new Promise(r => setTimeout(r, 500));

              // Fill in form fields
              const symbolInput = document.querySelector('input[placeholder*="symbol"]') ||
                                 document.querySelector('[name*="symbol"]');
              const levelInput = document.querySelector('input[placeholder*="level"]') ||
                               document.querySelector('input[type="number"]');
              const conditionSelect = document.querySelector('select[name*="condition"]') ||
                                    document.querySelector('[class*="condition"]');

              if (symbolInput) {
                symbolInput.value = '${symbol}';
                symbolInput.dispatchEvent(new Event('input', { bubbles: true }));
              }

              if (levelInput) {
                levelInput.value = ${level};
                levelInput.dispatchEvent(new Event('input', { bubbles: true }));
              }

              if (conditionSelect) {
                conditionSelect.value = '${condition}';
                conditionSelect.dispatchEvent(new Event('change', { bubbles: true }));
              }

              // Click create/save button
              const saveBtn = Array.from(document.querySelectorAll('button')).find(btn =>
                btn.textContent.toLowerCase().includes('create') ||
                btn.textContent.toLowerCase().includes('save')
              );

              if (saveBtn) {
                saveBtn.click();
                created = true;
              }
            }

            return {
              success: created,
              alertId: '${alertId}',
              symbol: '${symbol}',
              condition: '${condition}',
              level: ${level},
              name: '${alertName}',
              created: new Date().toISOString(),
              via: created ? 'api_or_ui' : 'simulated'
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
        (function() {
          try {
            const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
            const alerts = nameEls.map((nameEl, idx) => {
              let container = nameEl.parentElement;
              for (let i = 0; i < 6 && container; i++) {
                if (container.querySelector('[data-name="alert-delete-button"]')) break;
                container = container.parentElement;
              }
              const name = nameEl.innerText?.trim() || \`alert_\${idx}\`;
              const symbol = container?.querySelector('[data-name="alert-item-ticker"]')?.innerText?.trim() || '';
              const status = container?.querySelector('[data-name="alert-item-status"]')?.innerText?.trim() || '';
              return {
                id: name,
                name,
                symbol,
                status,
                active: !status.toLowerCase().includes('stop') && !status.toLowerCase().includes('pause'),
              };
            });

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
        (function() {
          try {
            const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
            const target = nameEls.find(el => el.innerText?.trim() === '${alertId}');
            if (!target) {
              return { success: false, alertId: '${alertId}', message: 'Alert not found — use the name shown in the Alerts panel' };
            }

            let container = target.parentElement;
            for (let i = 0; i < 6 && container; i++) {
              if (container.querySelector('[data-name="alert-delete-button"]')) break;
              container = container.parentElement;
            }

            const deleteBtn = container?.querySelector('[data-name="alert-delete-button"]');
            if (!deleteBtn) {
              return { success: false, alertId: '${alertId}', message: 'Delete button not found in item container' };
            }

            deleteBtn.click();
            return { success: true, alertId: '${alertId}', message: 'Alert deleted' };
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
