#!/usr/bin/env node
// Test ALERT_HISTORY_SCRIPT scrolling — prints itemCount + top 5 entries.
// Usage: node scripts/test-log-scroll.js

import { CDPManager } from '../src/cdp.js';
import { ALERT_HISTORY_SCRIPT } from '../monitors/monitor.js';

const cdp = new CDPManager(null, null);

try {
  await cdp.connect();
  console.log('Connected to TradingView CDP\n');

  console.log('Running ALERT_HISTORY_SCRIPT...');
  const result = await cdp.executeScript(ALERT_HISTORY_SCRIPT);

  const d = result?.diag || {};
  console.log('\n--- Diagnostics ---');
  console.log('Tabs visible   :', d.allTabTexts);
  console.log('Log tab found  :', d.logTabFound);
  console.log('Selector used  :', d.usedSel || '(none matched)');
  console.log('Scroller found :', d.scrollerFound);
  console.log('Items at top   :', d.countAfterTop, '(before scroll loop)');
  console.log('Items total    :', d.itemCount,     '(after scroll)');

  const items = result?.items || [];
  if (items.length > 0) {
    console.log(`\n--- Top 5 of ${items.length} log entries ---`);
    items.slice(0, 5).forEach((it, i) => {
      console.log(`  [${i + 1}] name:"${it.name}"  time:"${it.time}"  symbol:"${it.symbol}"`);
    });
  } else {
    console.log('\nNo log items — Log tab is empty or selector did not match.');
  }

  if (d.scrollerFound && d.itemCount > d.countAfterTop) {
    console.log(`\n✓ Scroll worked: ${d.countAfterTop} at top → ${d.itemCount} after scroll`);
  } else if (d.scrollerFound) {
    console.log(`\n✓ Scroller found — all ${d.itemCount} items visible without scrolling`);
  } else {
    console.log(`\n✓ No virtual list scroller — ${d.itemCount} items read directly`);
  }

} catch (err) {
  console.error('Error:', err.message);
  console.error('Is TradingView running with --remote-debugging-port=9222?');
} finally {
  await cdp.disconnect?.();
}
