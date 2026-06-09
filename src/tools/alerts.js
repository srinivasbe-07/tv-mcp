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
        name: 'alert_update',
        description: 'Update both the symbol and price level on an existing alert',
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
            level: {
              type: 'number',
              description: 'New price level for the alert',
            },
          },
          required: ['alertName', 'symbol', 'level'],
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

  async normalizeAlertsPanel() {
    await this.cdp
      .executeScript(
        `(async function() {
          const hasItems = () => !!document.querySelector('[data-name="alert-item-name"]');

          const btn = document.querySelector('[data-name="alerts"]');
          if (!btn) return;

          const visibleTabs = () => Array.from(document.querySelectorAll('[role="tab"]'))
            .filter(t => !!t.offsetParent);

          // True only when the Alerts panel itself is in focus (has an Alerts or Log tab).
          // Tabs from other panels (Data Window, Watchlist etc.) don't match this.
          const alertsPanelActive = () => visibleTabs().some(t => {
            const txt = (t.textContent || t.innerText || '').trim().toLowerCase();
            return txt === 'alerts' || txt.startsWith('alert') || txt === 'log';
          });

          const findAlertsTab = () => visibleTabs().find(t => {
            const txt = (t.textContent || t.innerText || '').trim().toLowerCase();
            return txt === 'alerts' || txt.startsWith('alert');
          });

          // Step 1: Bring Alerts panel into focus if it isn't already.
          // Covers: panel closed, panel collapsed, another panel is open.
          if (!alertsPanelActive()) {
            btn.click();
            for (let i = 0; i < 16; i++) {
              await new Promise(r => setTimeout(r, 250));
              if (alertsPanelActive()) break;
            }
          }

          // Step 2: Always click the Alerts tab — guards against being stuck on the Log tab
          // after ALERT_HISTORY_SCRIPT reads history, or after a chart symbol switch causes
          // TV to re-render the panel in a different state.
          const alertsTab = findAlertsTab();
          if (alertsTab) {
            alertsTab.click();
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 250));
              if (hasItems()) break;
            }
          }

          // Step 3: If panel is open (tabs visible) but still empty, force-toggle
          // close+reopen to recover from broken/unloaded state.
          if (!hasItems() && alertsPanelActive()) {
            btn.click(); // close
            await new Promise(r => setTimeout(r, 400));
            btn.click(); // reopen
            for (let i = 0; i < 20; i++) {
              await new Promise(r => setTimeout(r, 250));
              if (hasItems()) break;
            }
            const tab = findAlertsTab();
            if (tab) {
              tab.click();
              for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (hasItems()) break;
              }
            }
          }
        })()`
      )
      .catch(() => {});
  }

  async handle(toolName, args) {
    switch (toolName) {
      case 'alert_create':
        return await this.create(args);
      case 'alert_list':
        return await this.list(args);
      case 'alert_delete':
        return await this.delete(args);
      case 'alert_activate':
        return await this.activate(args);
      case 'alert_deactivate':
        return await this.deactivate(args);
      case 'alert_update_symbol':
        return await this.updateSymbol(args);
      case 'alert_update':
        return await this.update(args);
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
            // Step 1: Switch chart to target symbol only if not already there.
            // Switching to the same symbol causes a brief chart reload that
            // collapses the Alerts panel — skipping avoids "Create Alert button not found".
            const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
            if (widget && typeof widget.setSymbol === 'function') {
              const currentSymbol = widget.symbol?.() || '';
              const needsSwitch = currentSymbol.replace(/^[A-Z]+:/, '') !== '${symbol}'.replace(/^[A-Z]+:/, '');
              if (needsSwitch) {
                widget.setSymbol('${symbol}');
                await new Promise(r => setTimeout(r, 900));
              }
            }

            // Step 2: Ensure Alerts panel is open on the Alerts list tab.
            // Handles: (a) panel closed, (b) log tab active, (c) panel collapsed.
            {
              const btn = document.querySelector('[data-name="alerts"]');
              if (btn) {
                const hasCreateBtn = () => !!document.querySelector('[data-name="set-alert-button"]');
                if (!hasCreateBtn()) {
                  // Log tab active — walk up from a log item to find and click the Alerts tab
                  const logItem = document.querySelector('[data-name="alert-log-item"]');
                  if (logItem) {
                    let container = logItem.parentElement;
                    for (let depth = 0; depth < 15; depth++) {
                      if (!container || container === document.body) break;
                      const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
                      if (tabs.length >= 1) {
                        const target = tabs.find(t => t.getAttribute('aria-selected') !== 'true') || tabs[0];
                        target.click();
                        await new Promise(r => setTimeout(r, 600));
                        break;
                      }
                      container = container.parentElement;
                    }
                  }
                  if (!hasCreateBtn()) {
                    // Panel closed or collapsed — isA is TV's minified active class
                    const classes = btn.classList.toString();
                    const isActive = classes.includes('active') || classes.includes('isA') ||
                                     !!document.querySelector('[data-name="set-alert-button"]');
                    if (isActive) { btn.click(); await new Promise(r => setTimeout(r, 400)); }
                    btn.click();
                    for (let i = 0; i < 16; i++) {
                      await new Promise(r => setTimeout(r, 250));
                      if (hasCreateBtn()) break;
                    }
                  }
                }
              }
            }
            let createBtn = document.querySelector('[data-name="set-alert-button"]');
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

            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

            // Step 4: Set price level.
            // input.input-gr1VjUfr is TV's minified class — falls back to first visible
            // non-checkbox input if the class has changed in a newer TV build.
            let priceInputSrc = 'not-found';
            let priceInput = document.querySelector('input.input-gr1VjUfr');
            if (priceInput) {
              priceInputSrc = 'class:input-gr1VjUfr';
            } else {
              priceInput = Array.from(document.querySelectorAll('input')).find(i =>
                i.offsetParent !== null && !['checkbox', 'radio', 'hidden'].includes(i.type)
              );
              priceInputSrc = priceInput ? 'fallback:first-visible-input' : 'not-found';
            }
            if (!priceInput) return {
              success: false,
              message: 'Price input not found — TV dialog may have changed',
              diag: {
                priceInputSrc,
                visibleInputs: Array.from(document.querySelectorAll('input'))
                  .filter(i => i.offsetParent !== null)
                  .map(i => i.className.slice(0, 50) + '/' + i.type + '/' + i.placeholder)
                  .slice(0, 8),
              },
            };

            priceInput.focus();
            await new Promise(r => setTimeout(r, 100));
            nativeSetter.call(priceInput, '');
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 100));
            nativeSetter.call(priceInput, String(${level}));
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            priceInput.dispatchEvent(new Event('change', { bubbles: true }));
            priceInput.blur();
            await new Promise(r => setTimeout(r, 400));
            const priceVerified = priceInput.value === String(${level});

            // Step 5: Set trigger frequency.
            // TV may carry over the previous alert's frequency setting, so always set explicitly.
            let onceBtnFound = false;
            let onceOptions = [];
            {
              const isVis2 = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
              const targetLabel = ${fireOnce} ? 'once only' : 'every time';

              // Find the frequency combo — shows current selection text
              const freqCombo = Array.from(document.querySelectorAll('button, [class*="select-"], [role="combobox"], [role="button"]'))
                .find(el => isVis2(el) && (() => {
                  const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                  return t.includes('every time') || t.includes('once per bar') || t.includes('once only');
                })());

              if (freqCombo) {
                const currentTxt = (freqCombo.innerText || freqCombo.textContent || '').trim().toLowerCase();
                if (!currentTxt.includes(targetLabel)) {
                  freqCombo.click();
                  await new Promise(r => setTimeout(r, 400));

                  const dropItems = Array.from(document.querySelectorAll('[role="option"], [class*="item-"], li'))
                    .filter(el => isVis2(el));
                  onceOptions = dropItems.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean).slice(0, 20);

                  const targetItem = dropItems.find(el => {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return txt.startsWith(targetLabel);
                  });

                  if (targetItem) {
                    targetItem.click();
                    onceBtnFound = true;
                    await new Promise(r => setTimeout(r, 300));
                  } else {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                  }
                } else {
                  onceBtnFound = true; // already correct
                }
              } else {
                onceOptions = ['freq-combo-not-found'];
              }
            }

            // Step 6+7: Set alert name + message.
            // Strategy A — direct input visible in the main form (some TV versions).
            // Strategy B — "Name and Message" button opens a sub-dialog (current TV).
            const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            let nameSetMethod = 'none';
            let nameDiag = {};

            const setInputVal = (inp, val) => {
              inp.focus();
              nativeSetter.call(inp, '');
              inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
              nativeSetter.call(inp, val);
              inp.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.blur();
            };

            // Snapshot of visible buttons for diagnostics (captured before clicking anything)
            const visibleBtns = Array.from(document.querySelectorAll('button'))
              .filter(b => b.offsetParent !== null)
              .map(b => ({
                text: b.textContent?.trim().slice(0, 50),
                cls: b.className.slice(0, 60),
                label: b.getAttribute('aria-label'),
              }))
              .filter(b => b.text || b.label)
              .slice(0, 15);
            nameDiag.visibleBtns = visibleBtns;

            // Strategy A: name input directly visible in main form
            const directNameInput = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(i =>
              i.offsetParent !== null && i !== priceInput && !i.classList.toString().includes('gr1VjUfr')
            );
            nameDiag.strategyA = !!directNameInput;

            if (directNameInput) {
              await new Promise(r => setTimeout(r, 100));
              setInputVal(directNameInput, '${alertName}');
              await new Promise(r => setTimeout(r, 300));
              const directMsgArea = Array.from(document.querySelectorAll('textarea')).find(t => t.offsetParent !== null);
              if (directMsgArea && '${alertMessage}') {
                taSetter.call(directMsgArea, '${alertMessage}');
                directMsgArea.dispatchEvent(new InputEvent('input', { bubbles: true }));
                directMsgArea.blur();
                await new Promise(r => setTimeout(r, 200));
              }
              nameSetMethod = 'direct';
            } else {
              // Strategy B: find "Message" / "Name and Message" button and click it
              const EXCL = ['app,', 'toasts', 'webhook', 'sound', 'create', 'save', 'cancel', 'notification', 'delete'];
              const isExcluded = (b) => {
                const txt = b.textContent?.trim() || '';
                const low = txt.toLowerCase();
                // Exclude condition preview buttons (e.g. "NIFTY260609P23500 Crossing Up 140.50")
                if (/crossing|greater than|less than/i.test(txt)) return true;
                return EXCL.some(w => low.includes(w));
              };

              const msgBtn =
                // Match by text — try both "Message" and "Name and Message" on any clickable element
                Array.from(document.querySelectorAll('button, [role="button"]')).find(b =>
                  b.offsetParent !== null && !isExcluded(b) && (
                    b.textContent?.trim() === 'Message' ||
                    b.textContent?.trim() === 'Name and Message' ||
                    b.textContent?.includes('Name and Message') ||
                    b.getAttribute('aria-label')?.toLowerCase().includes('message')
                  )
                ) ||
                // Match by known class (may change between TV versions) — exclude Delete
                Array.from(document.querySelectorAll('button[class*="apply-overflow-tooltip--check-children"]'))
                  .find(b => b.offsetParent !== null && !isExcluded(b)) ||
                // Fallback: any overflow/apply-common button not in exclusion list
                Array.from(document.querySelectorAll('button[class*="overflow"], button[class*="apply-common"]'))
                  .find(b => b.offsetParent !== null && !isExcluded(b));

              nameDiag.strategyB_btnFound = !!msgBtn;
              nameDiag.strategyB_btnText = msgBtn?.textContent?.trim().slice(0, 50);

              if (msgBtn) {
                msgBtn.click();

                const isVis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

                // Initial settle wait — gives the previous dialog's DOM time to clear
                // before polling for the new sub-dialog's fields.
                await new Promise(r => setTimeout(r, 500));

                // Poll up to 3s for the sub-dialog fields to appear.
                // Name field may be a textarea (not input) — search both.
                let allFields = [];
                for (let poll = 0; poll < 16; poll++) {
                  await new Promise(r => setTimeout(r, 250));
                  allFields = Array.from(document.querySelectorAll('input, textarea'))
                    .filter(el => isVis(el) && el !== priceInput);
                  if (allFields.length >= 1) break;
                }

                nameDiag.subDialogFields = allFields.map(el => ({
                  tag: el.tagName, type: el.type || '',
                  placeholder: (el.placeholder || '').slice(0, 30),
                  rows: el.rows || '', cls: el.className.slice(0, 40),
                }));

                // First field = name, first textarea after that = message
                const nameField = allFields[0];
                const msgField  = allFields.find(el => el.tagName === 'TEXTAREA' && el !== nameField);

                nameDiag.nameInputFound = !!nameField;
                nameDiag.nameInputTag   = nameField?.tagName;

                if (nameField) {
                  await new Promise(r => setTimeout(r, 150));
                  if (nameField.tagName === 'INPUT') {
                    setInputVal(nameField, '${alertName}');
                  } else {
                    // textarea — use taSetter so React sees the change
                    taSetter.call(nameField, '${alertName}');
                    nameField.dispatchEvent(new InputEvent('input', { bubbles: true }));
                    nameField.blur();
                  }
                  await new Promise(r => setTimeout(r, 200));
                  nameSetMethod = 'subdialog';
                } else {
                  nameSetMethod = 'subdialog-no-input';
                }

                if (msgField && '${alertMessage}') {
                  taSetter.call(msgField, '${alertMessage}');
                  msgField.dispatchEvent(new InputEvent('input', { bubbles: true }));
                  msgField.blur();
                  await new Promise(r => setTimeout(r, 200));
                }

                const applyBtn = Array.from(document.querySelectorAll('button')).find(b =>
                  b.offsetParent !== null && b.textContent?.trim() === 'Apply'
                );
                if (applyBtn) {
                  applyBtn.click();
                  // Poll for sub-dialog to close (price input reappears when back to main dialog)
                  for (let i = 0; i < 8; i++) {
                    await new Promise(r => setTimeout(r, 150));
                    if (isVis(priceInput)) break;
                  }
                }
              } else {
                nameSetMethod = 'not-found';
              }
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
            // Poll for dialog to close — same 2-of-3 threshold as the success check below
            for (let i = 0; i < 20; i++) {
              await new Promise(r => setTimeout(r, 200));
              const goneCount = [
                !document.querySelector('[class*="submitBtn-"]'),
                !document.querySelector('input.input-gr1VjUfr'),
                !document.querySelector('.form-h6NNXQD2'),
              ].filter(Boolean).length;
              if (goneCount >= 2) break;
            }

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
              nameSetMethod,
              priceInputSrc,
              priceVerified,
              onceBtnFound,
              onceOptions,
              nameDiag,
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
            // Find the virtual-list scroll container using computed overflow style
            const seedEl = document.querySelector('[data-name="alert-item-name"]');
            let scroller = null;
            let node = seedEl?.parentElement;
            while (node && node !== document.body) {
              const oy = window.getComputedStyle(node).overflowY;
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                  node.scrollHeight > node.clientHeight + 2) { scroller = node; break; }
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

            if (scroller) {
              const scrollTo = async (pos) => {
                scroller.scrollTop = pos;
                scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
                await new Promise(r => setTimeout(r, 600));
              };
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              let pos = step;
              while (pos <= scroller.scrollHeight) {
                await scrollTo(pos);
                readCurrent(byAbsY);
                if (pos >= scroller.scrollHeight - scroller.clientHeight) break;
                pos += step;
              }
              await scrollTo(scroller.scrollHeight - scroller.clientHeight);
              readCurrent(byAbsY);
              scroller.scrollTop = 0;
              scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
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

            const tryDelete = async () => {
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
              // Wait for confirmation dialog and click Yes/Delete/OK
              await new Promise(r => setTimeout(r, 400));
              const confirmBtn = Array.from(document.querySelectorAll('button')).find(b => {
                const txt = (b.textContent || '').trim().toLowerCase();
                return txt === 'yes' || txt === 'delete' || txt === 'ok';
              });
              if (confirmBtn) confirmBtn.click();
              await new Promise(r => setTimeout(r, 300));
              return true;
            };

            // Try at current position first
            if (await tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };

            // Scroll through list to find and delete the alert
            if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
              const maxScroll = scroller.scrollHeight - scroller.clientHeight;
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              for (let pos = step; pos <= maxScroll; pos += step) {
                scroller.scrollTop = pos;
                await new Promise(r => setTimeout(r, 600));
                if (await tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };
              }
              // Try exact bottom too
              scroller.scrollTop = maxScroll;
              await new Promise(r => setTimeout(r, 600));
              if (await tryDelete()) return { success: true, alertId: '${alertId}', message: 'Alert deleted' };
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

  async activate(args) {
    try {
      const { alertId } = args;
      if (!alertId) return this.error('alertId is required');

      const script = `
        (async function() {
          try {
            const seedEl = document.querySelector('[data-name="alert-item-name"]');
            let scroller = null;
            let node = seedEl?.parentElement;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) { scroller = node; break; }
              node = node.parentElement;
            }

            const tryActivate = () => {
              const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
              const target = nameEls.find(el => el.innerText?.trim() === '${alertId}');
              if (!target) return false;
              let container = target.parentElement;
              for (let i = 0; i < 6 && container; i++) {
                if (container.querySelector('[data-name="alert-delete-button"]')) break;
                container = container.parentElement;
              }
              // Restart button: TV uses data-name="alert-toggle-button" or a play-icon button.
              // Exclude edit and delete buttons — pick the remaining action button.
              const restartBtn =
                container?.querySelector('[data-name="alert-toggle-button"]') ||
                container?.querySelector('[data-name="alert-play-button"]') ||
                Array.from(container?.querySelectorAll('button') || []).find(b =>
                  b !== container.querySelector('[data-name="alert-edit-button"]') &&
                  b !== container.querySelector('[data-name="alert-delete-button"]') &&
                  b.offsetParent !== null
                );
              if (!restartBtn) return false;
              restartBtn.click();
              return true;
            };

            if (tryActivate()) return { success: true, alertId: '${alertId}' };

            if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
              const maxScroll = scroller.scrollHeight - scroller.clientHeight;
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              for (let pos = step; pos <= maxScroll; pos += step) {
                scroller.scrollTop = pos;
                await new Promise(r => setTimeout(r, 600));
                if (tryActivate()) return { success: true, alertId: '${alertId}' };
              }
              scroller.scrollTop = maxScroll;
              await new Promise(r => setTimeout(r, 600));
              if (tryActivate()) return { success: true, alertId: '${alertId}' };
              scroller.scrollTop = 0;
            }

            return { success: false, alertId: '${alertId}', message: 'Alert not found or no restart button' };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to activate alert: ${error.message}`);
    }
  }

  async deactivate(args) {
    try {
      const { alertId } = args;
      if (!alertId) return this.error('alertId is required');

      const script = `
        (async function() {
          try {
            const seedEl = document.querySelector('[data-name="alert-item-name"]');
            let scroller = null;
            let node = seedEl?.parentElement;
            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) { scroller = node; break; }
              node = node.parentElement;
            }

            const tryDeactivate = () => {
              const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
              const target = nameEls.find(el => el.innerText?.trim() === '${alertId}');
              if (!target) return false;
              let container = target.parentElement;
              for (let i = 0; i < 6 && container; i++) {
                if (container.querySelector('[data-name="alert-delete-button"]')) break;
                container = container.parentElement;
              }
              // Check current state — skip if already stopped/paused
              const statusEl = container?.querySelector('[data-name="alert-item-status"]');
              const status = (statusEl?.innerText || '').trim().toLowerCase();
              if (status.includes('stop') || status.includes('pause')) {
                return 'already_stopped';
              }
              // Stop button uses the same toggle selector as the restart button
              const stopBtn =
                container?.querySelector('[data-name="alert-toggle-button"]') ||
                Array.from(container?.querySelectorAll('button') || []).find(b =>
                  b !== container.querySelector('[data-name="alert-edit-button"]') &&
                  b !== container.querySelector('[data-name="alert-delete-button"]') &&
                  b.offsetParent !== null
                );
              if (!stopBtn) return false;
              stopBtn.click();
              return true;
            };

            const r = tryDeactivate();
            if (r === 'already_stopped') return { success: true, alertId: '${alertId}', message: 'Already stopped' };
            if (r) return { success: true, alertId: '${alertId}' };

            if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
              const maxScroll = scroller.scrollHeight - scroller.clientHeight;
              const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
              for (let pos = step; pos <= maxScroll; pos += step) {
                scroller.scrollTop = pos;
                await new Promise(r => setTimeout(r, 600));
                const r2 = tryDeactivate();
                if (r2 === 'already_stopped') return { success: true, alertId: '${alertId}', message: 'Already stopped' };
                if (r2) return { success: true, alertId: '${alertId}' };
              }
              scroller.scrollTop = maxScroll;
              await new Promise(r => setTimeout(r, 600));
              const r3 = tryDeactivate();
              if (r3 === 'already_stopped') return { success: true, alertId: '${alertId}', message: 'Already stopped' };
              if (r3) return { success: true, alertId: '${alertId}' };
              scroller.scrollTop = 0;
            }

            return { success: false, alertId: '${alertId}', message: 'Alert not found or no stop button' };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to deactivate alert: ${error.message}`);
    }
  }

  async updateSymbol(args) {
    try {
      const { alertName, symbol } = args;
      if (!alertName || !symbol) return this.error('alertName and symbol are required');

      // Step 0: Ensure the Alerts panel is active and showing items.
      // Handles 3 problem states:
      //   (a) Panel closed — click to open
      //   (b) Panel collapsed — click to expand
      //   (c) Log/Trade History tab selected — click alerts button to switch back
      // Always activate the Alerts button rather than only when items are missing.
      await this.normalizeAlertsPanel();

      // Step 1: Find and JS-click the edit button for the target alert.
      // TradingView's edit buttons have visibility:hidden until hover, so CDP physical click
      // can't hit them (hit-testing skips hidden elements). JS .click() fires directly on
      // the element regardless of visibility and correctly opens the right alert's dialog.
      // We walk up from each edit button to its row's name element to ensure correct matching.
      const clickResult = await this.cdp.executeScript(`
        (async function() {
          // Use computed overflow style — more reliable than scrollHeight delta for virtual lists.
          const findScroller = () => {
            const seed = document.querySelector('[data-name="alert-item-name"]');
            if (!seed) return null;
            let node = seed.parentElement;
            while (node && node !== document.body) {
              const oy = window.getComputedStyle(node).overflowY;
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                  node.scrollHeight > node.clientHeight + 2) return node;
              node = node.parentElement;
            }
            return null;
          };
          const scrollTo = async (scroller, pos) => {
            scroller.scrollTop = pos;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            // Poll until virtual list re-renders the item or timeout
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 100));
              if (document.querySelectorAll('[data-name="alert-item-name"]').length >
                  (scroller._prevCount || 0)) break;
            }
            scroller._prevCount = document.querySelectorAll('[data-name="alert-item-name"]').length;
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
                  break;
                }
                node = node.parentElement;
                depth++;
              }
            }
            return false;
          };
          // Scroll to top first so virtual list starts from a known position.
          const scroller = findScroller();
          if (scroller) await scrollTo(scroller, 0);
          if (clickEdit()) return { clicked: true };
          if (scroller) {
            const step = Math.max(60, Math.floor(scroller.clientHeight * 0.5));
            let pos = step;
            while (pos <= scroller.scrollHeight) {
              await scrollTo(scroller, pos);
              if (clickEdit()) return { clicked: true };
              if (pos >= scroller.scrollHeight - scroller.clientHeight) break;
              pos += step;
            }
            // Final pass: scroll to absolute bottom
            await scrollTo(scroller, scroller.scrollHeight - scroller.clientHeight);
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

  async update(args) {
    try {
      const { alertName, symbol, level } = args;
      if (!alertName || !symbol || level === undefined)
        return this.error('alertName, symbol, and level are required');

      // Step 0: Ensure Alerts panel is showing items
      await this.normalizeAlertsPanel();

      // Step 1: Find and JS-click the edit button for the target alert
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
                  break;
                }
                node = node.parentElement;
                depth++;
              }
            }
            return false;
          };
          const scroller = findScroller();
          if (scroller) { scroller.scrollTop = 0; await new Promise(r => setTimeout(r, 300)); }
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

      // Step 3: Select symbol in dropdown
      const selectResult = await this.cdp.executeScript(`
        (async function() {
          const nl = String.fromCharCode(10);
          const dialog = document.querySelector('[class*="dialog-"][class*="popup-"]');
          if (!dialog) return { found: false, error: 'no dialog' };
          const headerBtn = [...dialog.querySelectorAll('[class*="activeArea-"]')].find(e => e.clientHeight > 0);
          if (!headerBtn) return { found: false, error: 'no header button' };
          const currentSymbol = headerBtn.textContent?.trim() || '';
          if (currentSymbol.toUpperCase() === '${symbol}'.toUpperCase()) {
            return { found: true, alreadyCorrect: true, currentSymbol };
          }
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
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { found: false, available, currentSymbol };
          }
          match.click();
          await new Promise(r => setTimeout(r, 600));
          return { found: true, available, currentSymbol };
        })()
      `);

      if (!selectResult?.found) {
        await this.cdp.executeScript(`
          (function() {
            const dialog = document.querySelector('[class*="dialog-"][class*="popup-"]');
            const cancel = [...(dialog?.querySelectorAll('button') || [])].find(b => b.textContent?.trim() === 'Cancel');
            if (cancel) cancel.click();
          })()
        `);
        return this.error(
          `Symbol "${symbol}" not in alert dropdown. Available: [${selectResult?.available?.filter(Boolean).join(', ')}]. ` +
            `Switch the chart tab to "${symbol}" first, then retry.`
        );
      }

      // Step 4: Update price level
      await this.cdp.delay(300);
      const levelResult = await this.cdp.executeScript(`
        (async function() {
          try {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            let priceInput = document.querySelector('input.input-gr1VjUfr');
            if (!priceInput) {
              priceInput = Array.from(document.querySelectorAll('input')).find(i =>
                i.offsetParent !== null && !['checkbox', 'radio', 'hidden'].includes(i.type)
              );
            }
            if (!priceInput) return { found: false };
            priceInput.focus();
            await new Promise(r => setTimeout(r, 100));
            nativeSetter.call(priceInput, '');
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 100));
            nativeSetter.call(priceInput, String(${level}));
            priceInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            priceInput.dispatchEvent(new Event('change', { bubbles: true }));
            priceInput.blur();
            await new Promise(r => setTimeout(r, 300));
            return { found: true, verified: priceInput.value === String(${level}) };
          } catch(e) {
            return { error: e.message };
          }
        })()
      `);

      // Step 5: Click Save
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
        level,
        levelSet: levelResult?.found && levelResult?.verified,
        shownInDialog: saveResult?.shownSymbol,
        message: saveResult?.msg || 'Unknown',
      });
    } catch (error) {
      return this.error(`Failed to update alert: ${error.message}`);
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
