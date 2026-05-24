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
        description: 'Delete an alert by ID',
        inputSchema: {
          type: 'object',
          properties: {
            alertId: {
              type: 'string',
              description: 'ID of the alert to delete',
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
        (function() {
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
            let alerts = [];

            // Attempt 1: Use TradingView API
            if (window.tradingview && typeof window.tradingview.getAlerts === 'function') {
              const tvAlerts = window.tradingview.getAlerts();
              if (Array.isArray(tvAlerts)) {
                alerts = tvAlerts.map((alert, idx) => ({
                  id: alert.id || \`alert_\${idx}\`,
                  symbol: alert.symbol || 'UNKNOWN',
                  condition: alert.condition || 'unknown',
                  level: alert.level || 0,
                  name: alert.name || alert.symbol,
                  created: alert.created || new Date().toISOString(),
                  active: alert.active !== false
                }));
              }
            }

            // Attempt 2: Scrape from alerts panel/dialog
            if (alerts.length === 0) {
              const alertRows = document.querySelectorAll('[class*="alert-row"]') ||
                              document.querySelectorAll('[class*="alert-item"]') ||
                              document.querySelectorAll('[data-testid*="alert"]');

              alertRows.forEach((row, idx) => {
                const text = row.textContent || '';
                const cells = row.querySelectorAll('td, div[class*="cell"]');

                let symbol = 'UNKNOWN';
                let condition = 'unknown';
                let level = 0;

                if (cells.length > 0) symbol = cells[0]?.textContent?.trim() || symbol;
                if (cells.length > 1) condition = cells[1]?.textContent?.trim() || condition;
                if (cells.length > 2) level = parseFloat(cells[2]?.textContent?.trim()) || 0;

                alerts.push({
                  id: \`alert_\${idx}\`,
                  symbol: symbol,
                  condition: condition,
                  level: level,
                  name: \`\${symbol} \${condition} \${level}\`,
                  created: new Date().toISOString(),
                  active: true
                });
              });
            }

            // If still no alerts, return empty list
            return {
              alerts: alerts,
              total: alerts.length,
              active: alerts.filter(a => a.active).length,
              found: alerts.length > 0
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
            let deleted = false;

            // Attempt 1: Use TradingView API
            if (window.tradingview && typeof window.tradingview.deleteAlert === 'function') {
              window.tradingview.deleteAlert('${alertId}');
              deleted = true;
            }

            // Attempt 2: Find alert row and click delete button
            if (!deleted) {
              const alertRows = document.querySelectorAll('[class*="alert-row"]') ||
                              document.querySelectorAll('[class*="alert-item"]') ||
                              document.querySelectorAll('[data-testid*="alert"]');

              for (const row of alertRows) {
                if (row.textContent.includes('${alertId}')) {
                  // Found the alert row, look for delete button
                  const deleteBtn = row.querySelector('[class*="delete"]') ||
                                   row.querySelector('[title*="Delete"]') ||
                                   row.querySelector('button[aria-label*="Delete"]') ||
                                   Array.from(row.querySelectorAll('button')).find(btn =>
                                     btn.textContent.toLowerCase().includes('delete') ||
                                     btn.getAttribute('title')?.toLowerCase().includes('delete')
                                   );

                  if (deleteBtn) {
                    deleteBtn.click();
                    deleted = true;
                    break;
                  }
                }
              }
            }

            return {
              success: deleted,
              alertId: '${alertId}',
              deleted: new Date().toISOString(),
              message: deleted ? 'Alert deleted successfully' : 'Could not locate alert to delete'
            };
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
