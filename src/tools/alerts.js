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
            // Step 1: Open Create Alert dialog
            const createBtn = document.querySelector('[data-name="set-alert-button"]');
            if (!createBtn) return { success: false, message: 'Create Alert button not found' };

            createBtn.click();
            await new Promise(r => setTimeout(r, 800));

            // Step 2: Symbol search dialog appears first — type and confirm symbol
            const symbolInput = document.querySelector('input.input-qm7Rg5MB') ||
                                document.querySelector('input[role="searchbox"]');
            if (symbolInput) {
              symbolInput.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, '${symbol}');
              await new Promise(r => setTimeout(r, 1000));
              symbolInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              await new Promise(r => setTimeout(r, 800));
            }

            // Step 3: Conditions form — set the price level input
            const priceInput = document.querySelector('input.input-gr1VjUfr') ||
                               document.querySelector('[class*="input-gr1VjUfr"]');
            if (priceInput) {
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(priceInput, String(${level}));
              priceInput.dispatchEvent(new Event('input', { bubbles: true }));
              priceInput.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
            }

            // Step 4: Click Submit / Create
            const submitBtn = Array.from(document.querySelectorAll('button')).find(b => {
              const txt = b.textContent?.trim().toLowerCase();
              return txt === 'submit' || txt === 'create' || txt === 'save' || txt === 'ok';
            });
            if (submitBtn) {
              submitBtn.click();
              await new Promise(r => setTimeout(r, 300));
              return {
                success: true,
                alertId: '${alertId}',
                symbol: '${symbol}',
                condition: '${condition}',
                level: ${level},
                name: '${alertName}',
                created: new Date().toISOString(),
              };
            }

            return {
              success: false,
              message: 'Alert form opened but Submit button not found — dialog structure may differ',
              symbol: '${symbol}',
              level: ${level},
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
