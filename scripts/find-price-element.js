#!/usr/bin/env node
/**
 * Diagnostic: find which DOM element / internal API shows the live current price in TV.
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
      // ── Strategy 1: known TV right-axis price label selectors (hashed class search) ──
      // TV uses hashed classnames, so we search by partial substring on className
      const allEls = Array.from(document.querySelectorAll('*'));

      function matchesAny(el, substrings) {
        const cls = (el.className || '').toString();
        return substrings.some(s => cls.toLowerCase().includes(s));
      }

      const priceKeywords = ['lastvalue', 'pricevalue', 'currentprice', 'pricelabel',
        'lastprice', 'latestprice', 'pricescale', 'priceaxis', 'price-axis',
        'current-price', 'last-price', 'pricetag', 'price-tag'];

      const selectorHits = [];
      for (const el of allEls) {
        if (!el.offsetParent && el.tagName !== 'BODY') continue;
        if (matchesAny(el, priceKeywords)) {
          const txt = el.textContent?.trim().replace(/,/g, '');
          const num = parseFloat(txt);
          if (num > 5000 && num < 200000) {
            selectorHits.push({
              tag: el.tagName,
              text: el.textContent?.trim().slice(0, 30),
              cls: (el.className || '').toString().slice(0, 80),
              id: el.id || '',
            });
          }
        }
      }

      // ── Strategy 2: scan ALL visible text nodes for 4–6 digit numbers ──
      // Includes elements regardless of offsetParent; checks all text nodes
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const priceTexts = [];
      while (walker.nextNode()) {
        const txt = walker.currentNode.textContent?.trim();
        if (!txt) continue;
        const clean = txt.replace(/,/g, '');
        const num = parseFloat(clean);
        if (/^\\d{4,6}(\\.\\d+)?$/.test(clean) && num > 5000 && num < 200000) {
          const parent = walker.currentNode.parentElement;
          priceTexts.push({
            text: txt,
            tag: parent?.tagName,
            cls: (parent?.className || '').toString().slice(0, 80),
            id: parent?.id || '',
            visible: !!parent?.offsetParent,
          });
        }
      }

      // ── Strategy 3: TV internal widget API paths ──
      let widgetInfo = {};
      try {
        // Try several known paths to the chart widget
        const paths = [
          () => window.TradingViewApi?._activeChartWidgetWV?._value,
          () => window.tvWidget?._iFrame?.contentWindow?.tvWidget?.activeChart?.(),
          () => window.TradingView?.activeChart?.(),
        ];

        let widget = null;
        for (const p of paths) {
          try { widget = p(); } catch(_) {}
          if (widget) break;
        }

        if (widget) {
          const model = widget?._chartWidget?._modelWV?._value;
          const series = model?.mainSeries?.();
          const barsStore = series?.bars?.();
          let barClose = null;
          if (barsStore && barsStore.size() > 0) {
            const b = barsStore.valueAt(barsStore.lastIndex());
            const v = Array.isArray(b) ? b : (b?.value || []);
            if (v.length >= 5) barClose = v[4];
          }

          // Try to read real-time price from series (not from bars)
          let realtimePrice = null;
          try { realtimePrice = series?.lastValueData?.()?.price; } catch(_) {}
          try { if (!realtimePrice) realtimePrice = series?.lastValue?.(); } catch(_) {}
          try { if (!realtimePrice) realtimePrice = series?.data?.last?.()?.close; } catch(_) {}

          // Pricescale methods
          let priceScaleVal = null;
          try {
            const ps = widget?._chartWidget?.getPanes?.()[0]?.getLeftPriceScale?.() ||
                       widget?._chartWidget?.getPanes?.()[0]?.getRightPriceScale?.();
            priceScaleVal = ps?.mainSource?.()?.lastValueData?.()?.price;
          } catch(_) {}

          widgetInfo = {
            symbol: widget.symbol?.() || null,
            barClose,
            realtimePrice,
            priceScaleVal,
            seriesKeys: series ? Object.keys(series).slice(0, 30) : [],
          };
        } else {
          widgetInfo = { error: 'No widget found on any known path' };
        }
      } catch(e) {
        widgetInfo = { error: e.message };
      }

      // ── Strategy 4: check price axis DOM container for any labels ──
      const priceAxisLabels = [];
      const candidates = document.querySelectorAll('[class*="axis"], [class*="scale"], [class*="label"]');
      for (const el of candidates) {
        if (!el.offsetParent) continue;
        const txt = el.textContent?.trim();
        const clean = txt?.replace(/,/g, '') || '';
        const num = parseFloat(clean);
        if (num > 5000 && num < 200000 && /^\\d{4,6}(\\.\\d+)?$/.test(clean)) {
          priceAxisLabels.push({
            text: txt,
            cls: (el.className || '').toString().slice(0, 80),
          });
        }
      }

      return { selectorHits, priceTexts: priceTexts.slice(0, 30), widgetInfo, priceAxisLabels };
    })()
  `);

  // ── Key comparison: DOM Close vs barClose ──
  const domPrices = (result?.priceTexts || [])
    .filter(p => p.cls.includes('valueValue'))
    .map(p => parseFloat(p.text.replace(/,/g, '')));
  const domClose = domPrices[domPrices.length - 1] ?? null; // last = Close
  const barClose = result?.widgetInfo?.barClose ?? null;

  console.log('=== KEY COMPARISON (pre-open diagnostic) ===');
  console.log(`  DOM valueValue elements (O/H/L/C): ${domPrices.join(', ')}`);
  console.log(`  DOM Close (4th valueValue):        ${domClose}`);
  console.log(`  Widget barClose (bars store):      ${barClose}`);
  console.log(`  MATCH: ${domClose === barClose ? 'YES (no pre-open diff)' : 'NO → DOM has live/indicative price!'}`);

  console.log('\n=== Selector hits (class keyword match) ===');
  console.log(JSON.stringify(result?.selectorHits, null, 2));

  console.log('\n=== All price-like text nodes ===');
  console.log(JSON.stringify(result?.priceTexts, null, 2));

  console.log('\n=== Widget internal API ===');
  console.log(JSON.stringify(result?.widgetInfo, null, 2));

  console.log('\n=== Price axis DOM labels ===');
  console.log(JSON.stringify(result?.priceAxisLabels, null, 2));

} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect?.();
}
