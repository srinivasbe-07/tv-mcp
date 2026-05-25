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
            // Count alerts before creation to verify later
            const countBefore = document.querySelectorAll('[data-name="alert-item-name"]').length;

            // Step 1: Open Create Alert dialog
            const createBtn = document.querySelector('[data-name="set-alert-button"]');
            if (!createBtn) return { success: false, message: 'Create Alert button not found' };

            createBtn.click();
            await new Promise(r => setTimeout(r, 800));

            // Step 2: Symbol picker — type and confirm with Enter
            const symbolInput = document.querySelector('input.input-qm7Rg5MB') ||
                                document.querySelector('input[role="searchbox"]');
            if (symbolInput) {
              symbolInput.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, '${symbol}');
              await new Promise(r => setTimeout(r, 1000));
              symbolInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              await new Promise(r => setTimeout(r, 1200));
            }

            // Step 3: Conditions form — set price level via execCommand + blur to trigger React
            const priceInput = document.querySelector('input.input-gr1VjUfr');
            if (!priceInput) return { success: false, message: 'Conditions form did not open after symbol selection' };

            priceInput.click();
            await new Promise(r => setTimeout(r, 100));
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, String(${level}));
            priceInput.dispatchEvent(new Event('blur', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));

            // Step 4: Read the auto-generated alert name from the Message field
            const form = document.querySelector('.form-h6NNXQD2');
            const autoName = form?.querySelector('[class*="button-KijOUKJc"]')?.innerText?.trim() || '${alertName}';

            // Step 5: Click the Create button (.submitBtn-m9pp3wEB in footer)
            const submitBtn = form?.querySelector('[class*="submitBtn-"]') ||
                              document.querySelector('[class*="submitBtn-"]');
            if (!submitBtn) return { success: false, message: 'Create button not found in dialog footer' };

            submitBtn.click();
            await new Promise(r => setTimeout(r, 1200));

            // Step 6: Verify alert was actually saved (count should increase)
            const countAfter = document.querySelectorAll('[data-name="alert-item-name"]').length;
            const saved = countAfter > countBefore;

            return {
              success: saved,
              alertId: '${alertId}',
              symbol: '${symbol}',
              condition: '${condition}',
              level: ${level},
              name: autoName,
              created: new Date().toISOString(),
              countBefore,
              countAfter,
              message: saved
                ? 'Alert created — use the name field to delete it'
                : \`Alert form submitted but count unchanged (\${countBefore} alerts). You may be at your plan limit.\`,
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
