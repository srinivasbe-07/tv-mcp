#!/usr/bin/env node
/**
 * Opens create alert dialog and inspects message button + sub-dialog
 * Usage: node scripts/diagnose-alert-dialog.js
 */

import { CDPManager } from '../src/cdp.js';

const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('CDP connected\n');

  // Open dialog
  await cdp.executeScript(`
    (async () => {
      let btn = document.querySelector('[data-name="set-alert-button"]');
      if (!btn) {
        const tab = document.querySelector('[data-name="alerts"], [aria-label="Alerts"]');
        if (tab) { tab.click(); await new Promise(r => setTimeout(r, 800)); }
        btn = document.querySelector('[data-name="set-alert-button"]');
      }
      if (btn) btn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1800));

  // Phase 1: Find message button
  const phase1 = await cdp.executeScript(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button[class*="apply-overflow-tooltip--check-children"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => ({ text: b.textContent?.trim().slice(0,80), className: b.className.slice(0,80) }));
      return btns;
    })()
  `);
  console.log('=== Message/Notif buttons (apply-overflow-tooltip--check-children) ===');
  phase1.forEach((b, i) => console.log(`[${i}]`, JSON.stringify(b)));

  // Phase 2: Click message button (first one, not notifications)
  console.log('\nClicking message button...');
  await cdp.executeScript(`
    (async () => {
      const msgBtn = Array.from(document.querySelectorAll('button[class*="apply-overflow-tooltip--check-children"]'))
        .find(b => {
          const t = b.textContent?.toLowerCase() || '';
          return b.offsetParent !== null && !t.includes('app,') && !t.includes('toasts') && !t.includes('webhook');
        });
      if (msgBtn) { console.log('MSG BTN FOUND:', msgBtn.textContent.trim().slice(0,40)); msgBtn.click(); }
      else console.log('MSG BTN NOT FOUND');
    })()
  `);
  await new Promise(r => setTimeout(r, 1200));

  // Phase 3: What's visible now (sub-dialog)
  const phase3 = await cdp.executeScript(`
    (function() {
      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, value: el.value?.slice(0,40), className: el.className.slice(0,60) }));
      const applyBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Apply');
      return { inputs, hasApply: !!applyBtn };
    })()
  `);
  console.log('\n=== After clicking message button ===');
  console.log('Inputs/textareas:', JSON.stringify(phase3.inputs, null, 2));
  console.log('Apply button visible:', phase3.hasApply);

} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect();
}
