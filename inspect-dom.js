#!/usr/bin/env node
/**
 * Inspect TradingView DOM to find correct selectors for failing tools.
 */

import { CDPManager } from './src/cdp.js';

const cdp = new CDPManager();

async function run(label, script) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(50 - label.length)}\n`);
  try {
    const result = await cdp.executeScript(script);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

async function main() {
  console.log('Connecting…');
  await cdp.connect();
  console.log('Connected.\n');

  // 1. quote_get — find price elements
  await run('PRICE ELEMENTS', `
    (function() {
      const selectors = [
        '[class*="price"]', '[class*="last"]', '[class*="close"]',
        '[data-field="last_price"]', '[class*="priceValue"]',
        '[class*="tickerPrice"]', '[class*="lastPrice"]',
      ];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,3).map(e => ({
          tag: e.tagName, class: e.className.slice(0,80), text: e.innerText?.slice(0,40)
        }));
      }
      return found;
    })()`);

  // 2. chart_set_symbol — find symbol search input
  await run('SYMBOL INPUT', `
    (function() {
      const selectors = [
        '[class*="symbol"]', '[class*="ticker"]', '[class*="search"]',
        'input[placeholder*="symbol"]', 'input[placeholder*="Search"]',
        '[data-name="legend-source-title"]', '[class*="legendMainSourceTitle"]',
      ];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,3).map(e => ({
          tag: e.tagName, class: e.className.slice(0,80), text: e.innerText?.slice(0,40)
        }));
      }
      return found;
    })()`);

  // 3. chart_set_timeframe — find timeframe buttons
  await run('TIMEFRAME BUTTONS', `
    (function() {
      const selectors = [
        '[class*="timeframe"]', '[class*="interval"]', '[class*="period"]',
        '[data-value]', 'button[class*="button"]',
      ];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,5).map(e => ({
          tag: e.tagName, class: e.className.slice(0,80),
          text: e.innerText?.slice(0,20), dataValue: e.getAttribute('data-value')
        }));
      }
      return found;
    })()`);

  // 4. pine_set_source — find code editor
  await run('CODE EDITOR', `
    (function() {
      const selectors = [
        '.cm-editor', '.CodeMirror', '.monaco-editor',
        'textarea', '[class*="editor"]', '[class*="codemirror"]',
        '[class*="pine"]', '.cm-content',
      ];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,3).map(e => ({
          tag: e.tagName, class: e.className.slice(0,80),
          contentEditable: e.contentEditable, hasCodeMirror: !!e.CodeMirror
        }));
      }
      return found;
    })()`);

  // 5. alert_delete — find alert rows in UI
  await run('ALERT UI', `
    (function() {
      const selectors = [
        '[class*="alert"]', '[data-name*="alert"]',
        '[class*="alertList"]', '[class*="alertItem"]',
        '[class*="alertRow"]',
      ];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,3).map(e => ({
          tag: e.tagName, class: e.className.slice(0,80), text: e.innerText?.slice(0,40)
        }));
      }
      return found;
    })()`);

  // 6. Global TradingView API — what's actually exposed
  await run('TRADINGVIEW GLOBAL API', `
    (function() {
      const keys = Object.keys(window).filter(k =>
        k.toLowerCase().includes('trading') ||
        k.toLowerCase().includes('tv') ||
        k.toLowerCase().includes('chart') ||
        k.toLowerCase().includes('pine')
      );
      const api = {};
      for (const k of keys.slice(0, 20)) {
        api[k] = typeof window[k];
      }
      return api;
    })()`);

  await cdp.disconnect();
}

main().catch(console.error);
