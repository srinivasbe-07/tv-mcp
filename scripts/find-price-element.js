#!/usr/bin/env node
/**
 * Diagnostic: find which DOM element shows the live current price in TV.
 * Run during pre-open (9:00-9:15) when live price differs from yesterday's close.
 *
 * Usage: node scripts/find-price-element.js
 */

import { CDPManager } from '../src/cdp.js';

const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('[CDP] Connected\n');

  const result = await cdp.executeScript(`
    (function() {
      // Strategy 1: look for TV's price scale label elements (right-axis price tag)
      const priceSelectors = [
        '[class*="lastValue"]',
        '[class*="priceValue"]',
        '[class*="currentPrice"]',
        '[class*="price-axis"]',
        '[class*="priceLabel"]',
        '[class*="lastPrice"]',
        '[class*="latestPrice"]',
      ];

      const found = [];
      for (const sel of priceSelectors) {
        const els = Array.from(document.querySelectorAll(sel)).filter(e => e.offsetParent !== null);
        for (const el of els.slice(0, 3)) {
          const txt = el.textContent?.trim();
          if (txt && /^[\\d,]+\\.?\\d*$/.test(txt.replace(/,/g, ''))) {
            found.push({ selector: sel, text: txt, cls: el.className.slice(0, 60) });
          }
        }
      }

      // Strategy 2: search all visible elements for text matching a price pattern
      // (5-6 digit number like 74361 or 23297)
      const allEls = Array.from(document.querySelectorAll('*'))
        .filter(e => {
          if (!e.offsetParent) return false;
          const children = e.children.length;
          if (children > 3) return false; // skip containers
          const txt = e.textContent?.trim();
          return txt && /^\\d{4,6}(\\.\\d+)?$/.test(txt);
        });

      const priceEls = allEls.slice(0, 20).map(e => ({
        tag: e.tagName,
        text: e.textContent?.trim(),
        cls: e.className.slice(0, 60),
        id: e.id || '',
        dataName: e.getAttribute('data-name') || '',
      }));

      // Strategy 3: TV internal quote API
      let quotePrice = null;
      try {
        const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
        const sym = widget?.symbol?.();
        quotePrice = { symbol: sym };
      } catch(_) {}

      return { selectorHits: found, priceEls, quotePrice };
    })()
  `);

  console.log('=== Selector hits ===');
  console.log(JSON.stringify(result?.selectorHits, null, 2));

  console.log('\n=== Price-like elements ===');
  console.log(JSON.stringify(result?.priceEls, null, 2));

  console.log('\n=== Quote API ===');
  console.log(JSON.stringify(result?.quotePrice, null, 2));

} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect?.();
}
