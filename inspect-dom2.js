#!/usr/bin/env node
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

  // 1. Explore ChartApiInstance
  await run(
    'ChartApiInstance keys',
    `
    (function() {
      if (!window.ChartApiInstance) return 'not found';
      return Object.keys(window.ChartApiInstance).slice(0, 30);
    })()`
  );

  // 2. Explore TradingViewApi
  await run(
    'TradingViewApi keys',
    `
    (function() {
      if (!window.TradingViewApi) return 'not found';
      return Object.keys(window.TradingViewApi).slice(0, 30);
    })()`
  );

  // 3. Explore _exposed_chartWidgetCollection
  await run(
    '_exposed_chartWidgetCollection',
    `
    (function() {
      const c = window._exposed_chartWidgetCollection;
      if (!c) return 'not found';
      const keys = Object.keys(c);
      if (!keys.length) return 'empty';
      const first = c[keys[0]];
      return { count: keys.length, firstKeys: Object.keys(first).slice(0, 20) };
    })()`
  );

  // 4. Get real price from ChartApiInstance
  await run(
    'Real price data',
    `
    (function() {
      try {
        const c = window._exposed_chartWidgetCollection;
        if (!c) return 'no chart collection';
        const keys = Object.keys(c);
        const widget = c[keys[0]];
        const wkeys = Object.keys(widget);
        // look for methods related to symbol/price
        const priceMethods = wkeys.filter(k =>
          typeof widget[k] === 'function' &&
          (k.includes('price') || k.includes('symbol') || k.includes('quote') ||
           k.includes('series') || k.includes('chart') || k.includes('data'))
        );
        return { priceMethods: priceMethods.slice(0, 20) };
      } catch(e) { return e.message; }
    })()`
  );

  // 5. Pine editor — CodeMirror 6 uses cm-content
  await run(
    'Pine editor (CodeMirror 6)',
    `
    (function() {
      const selectors = ['.cm-content', '.cm-editor', '.cm-scroller', '[class*="cm-"]'];
      const found = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) found[sel] = Array.from(els).slice(0,3).map(e => ({
          tag: e.tagName,
          class: e.className.slice(0, 80),
          contentEditable: e.contentEditable,
          textLength: e.innerText?.length
        }));
      }
      return found;
    })()`
  );

  // 6. TVScript API
  await run(
    'TVScript keys',
    `
    (function() {
      if (!window.TVScript) return 'not found';
      return Object.keys(window.TVScript).slice(0, 20);
    })()`
  );

  // 7. Alert list items in DOM
  await run(
    'Alert list items',
    `
    (function() {
      const widgets = document.querySelectorAll('[class*="alert"]');
      return Array.from(widgets).slice(0, 10).map(e => ({
        tag: e.tagName,
        class: e.className.slice(0, 100),
        text: e.innerText?.slice(0, 60),
        children: e.children.length
      }));
    })()`
  );

  // 8. Timeframe toolbar
  await run(
    'Timeframe toolbar',
    `
    (function() {
      // Look for the timeframe selector in the top toolbar
      const candidates = document.querySelectorAll('[class*="interval"],[class*="resolution"],[class*="timeframe"]');
      return Array.from(candidates).slice(0, 10).map(e => ({
        tag: e.tagName,
        class: e.className.slice(0, 100),
        text: e.innerText?.slice(0, 30),
        role: e.getAttribute('role'),
        title: e.getAttribute('title')
      }));
    })()`
  );

  await cdp.disconnect();
}

main().catch(console.error);
