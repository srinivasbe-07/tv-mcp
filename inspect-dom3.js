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

  // 1. Get active chart widget via TradingViewApi
  await run('Active chart widget methods', `
    (function() {
      const api = window.TradingViewApi;
      if (!api) return 'no TradingViewApi';
      const wv = api._activeChartWidgetWV;
      if (!wv) return 'no _activeChartWidgetWV';
      const widget = wv._value;
      if (!widget) return 'no widget value';
      const methods = Object.keys(widget).filter(k => typeof widget[k] === 'function');
      return { methodCount: methods.length, methods: methods.slice(0, 40) };
    })()`);

  // 2. Get symbol and price from chart widget
  await run('Chart widget symbol/price', `
    (function() {
      try {
        const api = window.TradingViewApi;
        const widget = api._activeChartWidgetWV._value;
        const result = {};
        // try common method names
        const tryMethods = ['symbol', 'symbolInfo', 'symbolInterval', 'resolution',
          'interval', 'getSymbol', 'getResolution', 'lastBar', 'priceFormatter'];
        for (const m of tryMethods) {
          try {
            if (typeof widget[m] === 'function') result[m] = widget[m]();
            else if (widget[m] !== undefined) result[m] = widget[m];
          } catch(e) { result[m] = 'error: ' + e.message; }
        }
        return result;
      } catch(e) { return e.message; }
    })()`);

  // 3. Alert delete button
  await run('Alert delete button', `
    (function() {
      const alertWidget = document.querySelector('.widgetbar-widget-alerts');
      if (!alertWidget) return 'no alert widget';
      // Look for delete/remove buttons inside
      const btns = alertWidget.querySelectorAll('button, [role="button"], [class*="delete"], [class*="remove"], [class*="close"]');
      return Array.from(btns).slice(0, 10).map(e => ({
        tag: e.tagName,
        class: e.className.slice(0, 100),
        text: e.innerText?.slice(0, 30),
        title: e.getAttribute('title'),
        ariaLabel: e.getAttribute('aria-label')
      }));
    })()`);

  // 4. Alert item structure
  await run('Alert items structure', `
    (function() {
      const alertWidget = document.querySelector('.widgetbar-widget-alerts');
      if (!alertWidget) return 'no alert widget';
      const items = alertWidget.querySelectorAll('[class*="item"],[class*="row"],[class*="alert-"]');
      return Array.from(items).slice(0, 5).map(e => ({
        class: e.className.slice(0, 100),
        text: e.innerText?.slice(0, 60),
        children: e.children.length
      }));
    })()`);

  // 5. Timeframe dropdown — click the interval title to reveal options
  await run('Timeframe interval title', `
    (function() {
      const el = document.querySelector('[title="Change interval"]');
      if (!el) return 'not found';
      return {
        tag: el.tagName,
        class: el.className.slice(0, 100),
        text: el.innerText,
        parent: el.parentElement?.className?.slice(0, 100)
      };
    })()`);

  // 6. Search button — for symbol change
  await run('Symbol search button', `
    (function() {
      const btn = document.querySelector('[class*="searchButton"]');
      if (!btn) return 'not found';
      return {
        tag: btn.tagName,
        class: btn.className.slice(0, 100),
        text: btn.innerText,
        title: btn.getAttribute('title'),
        ariaLabel: btn.getAttribute('aria-label')
      };
    })()`);

  // 7. Price from DOM — deeper look at lastGroup
  await run('Price from lastGroup', `
    (function() {
      const groups = document.querySelectorAll('[class*="lastGroup"]');
      return Array.from(groups).slice(0, 5).map(g => ({
        class: g.className.slice(0, 80),
        html: g.innerHTML?.slice(0, 200),
        text: g.innerText?.slice(0, 80)
      }));
    })()`);

  await cdp.disconnect();
}

main().catch(console.error);
