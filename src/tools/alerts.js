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
              enum: ['above', 'below', 'crosses', 'crosses_up', 'crosses_down'],
              description:
                'Alert condition — crosses_up: crossing up, crosses_down: crossing down, above: greater than, below: less than',
            },
            level: {
              type: 'number',
              description: 'Price level for the alert',
            },
            name: {
              type: 'string',
              description: 'Name for the alert',
            },
            message: {
              type: 'string',
              description: 'Alert notification message (also sent as webhook body)',
            },
            webhook: {
              type: 'string',
              description: 'Webhook URL to call when alert fires',
            },
            once: {
              type: 'boolean',
              description:
                'If true, alert fires only once then stops (default: false = every time)',
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
      {
        name: 'alert_update_symbol',
        description: 'Update the symbol on an existing alert without changing any other settings',
        inputSchema: {
          type: 'object',
          properties: {
            alertName: {
              type: 'string',
              description: 'Name of the alert to update (as shown in the Alerts panel)',
            },
            symbol: {
              type: 'string',
              description: 'New symbol to set on the alert (e.g. NIFTY260527C23950)',
            },
          },
          required: ['alertName', 'symbol'],
        },
      },
      {
        name: 'alert_get_history',
        description: 'Get recently fired alerts from the alert log/history panel',
        inputSchema: {
          type: 'object',
          properties: {},
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
      case 'alert_update_symbol':
        return await this.updateSymbol(args);
      case 'alert_get_history':
        return await this.getHistory(args);
      default:
        return this.error(`Unknown alert tool: ${toolName}`);
    }
  }

  async create(args) {
    try {
      const { symbol, condition, level, name, message, webhook, once } = args;

      if (!symbol || !condition || level === undefined) {
        return this.error('Symbol, condition, and level are required');
      }

      const alertId = `alert_${Date.now()}`;
      const alertName = name || `${symbol} ${condition} ${level}`;
      const alertMessage = message || '';
      const webhookUrl = webhook || '';
      const fireOnce = once === true;

      const script = `
        (async function() {
          try {
            // Step 1: Switch chart to target symbol so the dialog inherits it
            const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
            if (widget && typeof widget.setSymbol === 'function') {
              widget.setSymbol('${symbol}');
              await new Promise(r => setTimeout(r, 900));
            }

            // Step 2: Ensure Alerts panel is open, then open Create Alert dialog
            let createBtn = document.querySelector('[data-name="set-alert-button"]');
            if (!createBtn) {
              // Try to open the Alerts panel via sidebar button
              const alertsTab = document.querySelector(
                '[data-name="alerts"], [data-id="alerts"], [aria-label="Alerts"], button[id*="alert"]'
              );
              if (alertsTab) {
                alertsTab.click();
                await new Promise(r => setTimeout(r, 800));
              }
              createBtn = document.querySelector('[data-name="set-alert-button"]');
            }
            if (!createBtn) return { success: false, message: 'Create Alert button not found — open the Alerts panel in TradingView' };

            createBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Step 3: Set condition type (Crossing Up / Crossing Down / Greater Than / Less Than)
            const condMap = {
              crosses_up:   'Crossing Up',
              crosses_down: 'Crossing Down',
              crosses:      'Crossing',
              above:        'Greater Than',
              below:        'Less Than',
            };
            const condLabel = condMap['${condition}'];
            if (condLabel) {
              // Find the condition dropdown button (shows current condition text, e.g. "Greater Than")
              const condBtn = Array.from(document.querySelectorAll('button, [class*="select-"]')).find(el => {
                const txt = el.textContent?.trim();
                return txt === 'Greater Than' || txt === 'Less Than' ||
                       txt === 'Crossing' || txt === 'Crossing Up' || txt === 'Crossing Down';
              });
              if (condBtn && condBtn.textContent?.trim() !== condLabel) {
                condBtn.click();
                await new Promise(r => setTimeout(r, 400));
                const option = Array.from(document.querySelectorAll('[class*="item-"], [role="option"], li'))
                  .find(el => el.textContent?.trim() === condLabel);
                if (option) {
                  option.click();
                  await new Promise(r => setTimeout(r, 300));
                }
              }
            }

            // Step 4: Set "Only Once" frequency if requested
            if (${fireOnce}) {
              const onceBtn = Array.from(
                document.querySelectorAll('button, [class*="button-"], [role="radio"], [class*="item-"]')
              ).find(el => {
                const txt = el.textContent?.trim();
                return txt === 'Only Once' || txt === 'Once' || txt === 'Only once';
              });
              if (onceBtn) {
                onceBtn.click();
                await new Promise(r => setTimeout(r, 200));
              }
            }

            // Step 5: Set price level
            const priceInput = document.querySelector('input.input-gr1VjUfr');
            if (!priceInput) return { success: false, message: 'Conditions form did not open after symbol selection' };

            priceInput.focus();
            await new Promise(r => setTimeout(r, 100));
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(priceInput, String(${level}));
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 400));
            priceInput.dispatchEvent(new Event('blur', { bubbles: true }));
            await new Promise(r => setTimeout(r, 400));

            // Step 6: Set alert name — try multiple strategies
            const allTextInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'));
            const nameInput =
              // Strategy 1: placeholder mentions "name"
              allTextInputs.find(i => i !== priceInput && i.placeholder?.toLowerCase().includes('name')) ||
              // Strategy 2: inside a container with "name" label
              allTextInputs.find(i => {
                if (i === priceInput) return false;
                const wrap = i.closest('[class*="field"], [class*="row"], [class*="input"], [class*="wrap"]');
                return wrap?.textContent?.toLowerCase().includes('name');
              }) ||
              // Strategy 3: first text input that is NOT the price input (fallback)
              allTextInputs.find(i => i !== priceInput && i.value !== String(${level}));

            if (nameInput && '${alertName}') {
              nameInput.focus();
              await new Promise(r => setTimeout(r, 100));
              nativeSetter.call(nameInput, '${alertName}');
              nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
              nameInput.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
            }

            // Step 7: Set message (textarea on Conditions tab)
            const msgArea = document.querySelector('textarea');
            if (msgArea && '${alertMessage}') {
              const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              taSetter.call(msgArea, '${alertMessage}');
              msgArea.dispatchEvent(new InputEvent('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 200));
            }

            // Step 8: Webhook — navigate to Notifications tab, enable webhook, set URL
            if ('${webhookUrl}') {
              const allTabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab-"], [class*="Tab"]'));
              const notifTab = allTabs.find(e =>
                e.textContent?.trim().toLowerCase().includes('notification')
              );
              if (notifTab) {
                notifTab.click();
                await new Promise(r => setTimeout(r, 600));

                // Enable webhook checkbox if not already checked
                const allLabels = Array.from(document.querySelectorAll('label'));
                const webhookLabel = allLabels.find(l =>
                  l.textContent?.toLowerCase().includes('webhook')
                );
                if (webhookLabel) {
                  const chk = webhookLabel.querySelector('input[type="checkbox"]') ||
                    document.getElementById(webhookLabel.htmlFor);
                  if (chk && !chk.checked) {
                    chk.click();
                    await new Promise(r => setTimeout(r, 400));
                  }
                }

                // Set webhook URL in the input that appears after enabling
                const webhookInput = Array.from(document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])')).find(i =>
                  i.placeholder?.toLowerCase().includes('webhook') ||
                  i.placeholder?.toLowerCase().includes('url') ||
                  i.closest('[class*="webhook"]')
                );
                if (webhookInput) {
                  nativeSetter.call(webhookInput, '${webhookUrl}');
                  webhookInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 200));
                }
              }
            }

            // Step 9: Click Create/Save button
            const form = document.querySelector('.form-h6NNXQD2');
            const submitBtn = form?.querySelector('[class*="submitBtn-"]') ||
                              document.querySelector('[class*="submitBtn-"]');
            if (!submitBtn) return { success: false, message: 'Create button not found in dialog footer' };

            submitBtn.click();
            await new Promise(r => setTimeout(r, 2000));

            // Step 10: Success = dialog closed (check multiple indicators)
            const priceInputGone   = !document.querySelector('input.input-gr1VjUfr');
            const submitBtnGone    = !document.querySelector('[class*="submitBtn-"]');
            const formGone         = !document.querySelector('.form-h6NNXQD2');
            // Dialog is closed if at least 2 of the 3 indicators say it's gone
            const closedCount = [priceInputGone, submitBtnGone, formGone].filter(Boolean).length;
            const success = closedCount >= 2;

            // Verify name was actually set by checking alert list
            const alertItems = document.querySelectorAll('[data-name="alert-item-name"]');
            const nameFound = Array.from(alertItems).some(el => el.textContent?.trim() === '${alertName}');

            return {
              success,
              nameSet: nameFound,
              alertId: '${alertId}',
              symbol: '${symbol}',
              condition: '${condition}',
              level: ${level},
              name: '${alertName}',
              webhookSet: !!'${webhookUrl}',
              created: new Date().toISOString(),
              message: success
                ? (nameFound ? 'Alert created successfully' : 'Alert created but name may not have been set — check TradingView')
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
                  : Math.round(rect.top * 10);
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

  async updateSymbol(args) {
    try {
      const { alertName, symbol } = args;
      if (!alertName || !symbol) return this.error('alertName and symbol are required');

      // Step 0: Ensure the Alerts panel is open and visible.
      // Chart symbol switches (e.g. to NSE:NIFTY) can cause TradingView to hide
      // or switch away from the Alerts panel. Click [data-name="alerts"] if needed,
      // then wait for alert items to be fully rendered in the DOM.
      await this.cdp.executeScript(`
        (async function() {
          const hasItems = document.querySelector('[data-name="alert-item-name"]');
          if (!hasItems) {
            const btn = document.querySelector('[data-name="alerts"]');
            if (btn) {
              btn.click();
              // Wait for items to render — poll up to 3 seconds
              for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (document.querySelector('[data-name="alert-item-name"]')) break;
              }
            }
          }
        })()
      `);

      // Step 1: Find and JS-click the edit button for the target alert.
      // TradingView's edit buttons have visibility:hidden until hover, so CDP physical click
      // can't hit them (hit-testing skips hidden elements). JS .click() fires directly on
      // the element regardless of visibility and correctly opens the right alert's dialog.
      // We walk up from each edit button to its row's name element to ensure correct matching.
      const clickResult = await this.cdp.executeScript(`
        (async function() {
          const findScroller = () => {
            const seed = document.querySelector('[data-name="alert-item-name"]');
            let node = seed?.parentElement;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) return node;
              node = node.parentElement;
            }
            return null;
          };
          const clickEdit = () => {
            const editBtns = Array.from(document.querySelectorAll('[data-name="alert-edit-button"]'));
            for (const btn of editBtns) {
              let node = btn.parentElement;
              let depth = 0;
              while (node && depth < 10) {
                const nameEl = node.querySelector('[data-name="alert-item-name"]');
                if (nameEl) {
                  if (nameEl.innerText?.trim() === '${alertName}') { btn.click(); return true; }
                  break; // wrong alert row — try next button
                }
                node = node.parentElement;
                depth++;
              }
            }
            return false;
          };
          // Always scroll to top first — after a previous dialog saves, the virtual list
          // may be at an arbitrary scroll position where the target item isn't in the DOM.
          const scroller = findScroller();
          if (scroller) {
            scroller.scrollTop = 0;
            await new Promise(r => setTimeout(r, 300));
          }
          if (clickEdit()) return { clicked: true };
          if (scroller) {
            const maxScroll = scroller.scrollHeight - scroller.clientHeight;
            const step = Math.max(80, Math.floor(scroller.clientHeight * 0.6));
            for (let pos = step; pos <= maxScroll; pos += step) {
              scroller.scrollTop = pos;
              await new Promise(r => setTimeout(r, 400));
              if (clickEdit()) return { clicked: true };
            }
            scroller.scrollTop = maxScroll;
            await new Promise(r => setTimeout(r, 400));
            if (clickEdit()) return { clicked: true };
          }
          return { clicked: false };
        })()
      `);
      if (!clickResult?.clicked) {
        return this.error(`Alert "${alertName}" not found in Alerts panel`);
      }

      // Step 2: Wait for edit dialog to open
      await this.cdp.delay(1500);

      // Step 3: Click the activeArea symbol button in the dialog header to open the dropdown,
      // then immediately JS-click the matching item — all in one executeScript so the dropdown
      // cannot close between the two operations (timing window issue with separate CDP calls).
      const selectResult = await this.cdp.executeScript(`
        (async function() {
          const nl = String.fromCharCode(10);
          const dialog = document.querySelector('[class*="dialog-"][class*="popup-"]');
          if (!dialog) return { found: false, error: 'no dialog' };

          const headerBtn = [...dialog.querySelectorAll('[class*="activeArea-"]')].find(e => e.clientHeight > 0);
          if (!headerBtn) return { found: false, error: 'no header button' };
          const currentSymbol = headerBtn.textContent?.trim() || '';

          // If already correct, skip dropdown interaction entirely
          if (currentSymbol.toUpperCase() === '${symbol}'.toUpperCase()) {
            return { found: true, alreadyCorrect: true, currentSymbol };
          }

          // Open symbol dropdown
          headerBtn.click();
          await new Promise(r => setTimeout(r, 600));

          const items = [...document.querySelectorAll('[class*="button-fOp9u5tE"]')]
            .filter(e => e.offsetWidth > 0 && e.offsetHeight > 0);
          const available = items.map(e => {
            const t = e.querySelector('[class*="symbolsDropdownItemTitle-"]');
            return (t?.textContent?.trim() || e.textContent?.trim())?.split(nl)[0] || '';
          });
          const match = items.find((e, i) => available[i]?.toUpperCase() === '${symbol}'.toUpperCase());
          if (!match) {
            // Close dropdown
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { found: false, available, currentSymbol };
          }

          match.click();
          await new Promise(r => setTimeout(r, 600));
          return { found: true, available, currentSymbol };
        })()
      `);

      if (!selectResult?.found) {
        // Close dialog
        await this.cdp.executeScript(`
          (function() {
            const dialog = document.querySelector('[class*="dialog-"][class*="popup-"]');
            const cancel = [...(dialog?.querySelectorAll('button') || [])].find(b => b.textContent?.trim() === 'Cancel');
            if (cancel) cancel.click();
          })()
        `);
        return this.error(
          `Symbol "${symbol}" not in alert dropdown. Available: [${selectResult?.available?.filter(Boolean).join(', ')}]. ` +
            `Add "${symbol}" to the chart as a comparison first (chart_add_comparison), then retry.`
        );
      }

      // Step 5: Click Save and verify dialog closes.
      // Success criterion: the submitBtn disappears (unique to the edit dialog).
      // Using dialog/popup class is unreliable — TradingView may show a notification
      // that matches the same selector right after Save.
      await this.cdp.delay(300);
      const saveResult = await this.cdp.executeScript(`
        (async function() {
          const dialog = document.querySelector('[class*="dialog-"][class*="popup-"]');
          if (!dialog) return { success: true, msg: 'Dialog already closed' };
          const symBtn = [...dialog.querySelectorAll('[class*="activeArea-"]')].find(e => e.clientHeight > 0);
          const shownSymbol = symBtn?.textContent?.trim() || '';
          const saveBtn = dialog.querySelector('[class*="submitBtn-"]') ||
                          [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save');
          if (!saveBtn) return { success: false, msg: 'Save button not found', shownSymbol };
          saveBtn.click();
          // Wait for edit dialog to close — check submitBtn absence (unique to the edit form)
          for (var i = 0; i < 16; i++) {
            await new Promise(r => setTimeout(r, 250));
            if (!document.querySelector('[class*="submitBtn-"]')) {
              return { success: true, shownSymbol, msg: 'Saved' };
            }
          }
          return { success: false, shownSymbol, msg: 'Dialog still open after Save' };
        })()
      `);

      return this.success({
        success: saveResult?.success || false,
        alertName,
        previousSymbol: selectResult?.currentSymbol,
        newSymbol: symbol,
        shownInDialog: saveResult?.shownSymbol,
        message: saveResult?.msg || 'Unknown',
      });
    } catch (error) {
      return this.error(`Failed to update alert symbol: ${error.message}`);
    }
  }

  async getHistory(_args) {
    try {
      const script = `
        (function() {
          try {
            // Alert log items in the history tab
            const selectors = [
              '[data-name="alert-log-item"]',
              '[data-name="alert-history-item"]',
              '[class*="alertLogItem"]',
              '[class*="historyItem"]',
            ];
            let items = [];
            for (const sel of selectors) {
              items = Array.from(document.querySelectorAll(sel));
              if (items.length > 0) break;
            }

            if (items.length === 0) {
              // Fallback: read text rows from the alert log tab panel
              const logPanel = document.querySelector('[data-name="alert-log-list"]') ||
                               document.querySelector('[class*="alertLog"]');
              if (logPanel) {
                const rows = Array.from(logPanel.querySelectorAll('div[class]'))
                  .filter(d => d.children.length >= 2 && d.clientHeight > 10 && d.clientHeight < 80);
                return {
                  items: rows.slice(0, 20).map(r => ({ text: r.innerText?.trim() })),
                  source: 'fallback_rows',
                  count: rows.length,
                };
              }
              return { items: [], count: 0, message: 'Alert history tab may not be visible' };
            }

            return {
              items: items.slice(0, 20).map(el => ({
                name: el.querySelector('[data-name="alert-log-item-name"]')?.innerText?.trim() ||
                      el.querySelector('[class*="name"]')?.innerText?.trim() || '',
                time: el.querySelector('[data-name="alert-log-item-time"]')?.innerText?.trim() ||
                      el.querySelector('[class*="time"]')?.innerText?.trim() || '',
                symbol: el.querySelector('[data-name="alert-log-item-symbol"]')?.innerText?.trim() ||
                        el.querySelector('[class*="symbol"]')?.innerText?.trim() || '',
                message: el.querySelector('[class*="message"]')?.innerText?.trim() || '',
              })),
              count: items.length,
            };
          } catch (e) {
            return { error: e.message, items: [] };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get alert history: ${error.message}`);
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
