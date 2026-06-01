#!/usr/bin/env node
/**
 * Diagnoses alert_delete flow:
 *   1. Lists all alert names visible in the Alerts panel
 *   2. Tries to delete 'TradeTarget' and reports each step
 *
 * Usage: node scripts/diagnose-alert-delete.js [alertName]
 *   Default alertName = TradeTarget
 *
 * Run WHILE TradeTarget/TradeEntry/TradeSL alerts are visible in TV.
 */

import { CDPManager } from '../src/cdp.js';

const targetName = process.argv[2] || 'TradeTarget';
const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('CDP connected\n');

  // Step 1: Ensure panel open
  console.log('── Step 1: Ensure Alerts panel open ──');
  await cdp.executeScript(`
    (async () => {
      if (!document.querySelector('[data-name="alert-item-name"]')) {
        const btn = document.querySelector('[data-name="alerts"]');
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // Step 2: List all alert names
  console.log('── Step 2: Alert names in DOM ──');
  const names = await cdp.executeScript(`
    Array.from(document.querySelectorAll('[data-name="alert-item-name"]'))
      .map(el => el.innerText?.trim())
  `);
  console.log('  Found:', names);

  // Step 3: Check delete button presence
  console.log(`\n── Step 3: Find delete button for "${targetName}" ──`);
  const btnCheck = await cdp.executeScript(`
    (function() {
      const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
      const target = nameEls.find(el => el.innerText?.trim() === '${targetName}');
      if (!target) return { found: false, reason: 'name element not in DOM' };

      let container = target.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        if (container.querySelector('[data-name="alert-delete-button"]')) break;
        container = container.parentElement;
      }
      const deleteBtn = container?.querySelector('[data-name="alert-delete-button"]');
      if (!deleteBtn) {
        // Also look for any buttons near the element
        let c2 = target.parentElement;
        const btns = [];
        for (let i = 0; i < 8 && c2; i++) {
          c2.querySelectorAll('button').forEach(b => btns.push({ text: b.textContent?.trim().slice(0,30), dataName: b.getAttribute('data-name'), visible: b.offsetParent !== null }));
          c2 = c2.parentElement;
        }
        return { found: false, reason: 'delete button not found', nearbyButtons: btns };
      }
      return { found: true, visible: deleteBtn.offsetParent !== null, dataName: deleteBtn.getAttribute('data-name') };
    })()
  `);
  console.log('  Result:', JSON.stringify(btnCheck, null, 2));

  // Step 4: Attempt delete and check for confirmation dialog
  if (btnCheck.found) {
    console.log(`\n── Step 4: Click delete button ──`);
    await cdp.executeScript(`
      (function() {
        const nameEls = Array.from(document.querySelectorAll('[data-name="alert-item-name"]'));
        const target = nameEls.find(el => el.innerText?.trim() === '${targetName}');
        if (!target) return;
        let container = target.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          if (container.querySelector('[data-name="alert-delete-button"]')) break;
          container = container.parentElement;
        }
        container?.querySelector('[data-name="alert-delete-button"]')?.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 800));

    // Check if a confirmation dialog appeared
    const afterClick = await cdp.executeScript(`
      (function() {
        const dialogs = Array.from(document.querySelectorAll('[class*="dialog"], [class*="popup"], [role="dialog"]'))
          .filter(d => d.offsetParent !== null)
          .map(d => ({
            tag: d.tagName,
            className: d.className.slice(0, 80),
            text: d.textContent?.trim().slice(0, 120),
            buttons: Array.from(d.querySelectorAll('button')).map(b => b.textContent?.trim().slice(0,30))
          }));
        const stillHasAlert = !!Array.from(document.querySelectorAll('[data-name="alert-item-name"]'))
          .find(el => el.innerText?.trim() === '${targetName}');
        return { dialogs, stillHasAlert };
      })()
    `);
    console.log('  Still in DOM:', afterClick.stillHasAlert);
    if (afterClick.dialogs.length) {
      console.log('  Dialogs visible after click:', JSON.stringify(afterClick.dialogs, null, 2));
    } else {
      console.log('  No dialog appeared after click');
    }
  }

} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect();
}
