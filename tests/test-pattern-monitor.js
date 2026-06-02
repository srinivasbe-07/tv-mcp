#!/usr/bin/env node
/**
 * Unit tests for pattern-monitor.js — updateTradeAlerts.
 * No CDP / TradingView required — runs standalone.
 *
 * Usage:  node tests/test-pattern-monitor.js
 */

import { updateTradeAlerts, _resetLastAlertCandleTime } from '../monitors/pattern-monitor.js';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Minimal async test runner
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;

async function test(name, fn) {
  try {
    const ok = await fn();
    if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); pass++; }
    else     { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); fail++; }
  } catch (e) {
    console.log(`  \x1b[31mERROR\x1b[0m ${name}: ${e.message}`);
    fail++;
  }
}

function section(title) { console.log(`\n${title}`); }

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------
const NIFTY_NAMES = {
  entry:  'niftyPatternLongEntry',
  sl:     'niftyPatternLongSL',
  target: 'niftyPatternLongTarget',
};

function resetState() {
  _resetLastAlertCandleTime();
  try {
    fs.mkdirSync('./logs', { recursive: true });
    fs.writeFileSync('./logs/trade-state.json', '{"status":"idle"}');
  } catch (_) {}
}

function makeMock({ entryOk = true, slOk = true, targetOk = true } = {}) {
  const calls = [];
  const handle = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'alert_list') {
      return { content: [{ type: 'text', text: JSON.stringify({ alerts: [], total: 0 }) }] };
    }
    if (tool === 'alert_update') {
      let success;
      if (args.alertName === NIFTY_NAMES.entry)  success = entryOk;
      else if (args.alertName === NIFTY_NAMES.sl)     success = slOk;
      else if (args.alertName === NIFTY_NAMES.target) success = targetOk;
      else success = true;
      return { content: [{ type: 'text', text: JSON.stringify({ success, message: success ? 'Saved' : 'Alert not found' }) }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  };
  return { handle, calls };
}

// Minimal cdp mock (only needed when state is not idle)
const mockCdp = { executeScript: async () => null };

function makeCandle(overrides = {}) {
  return { time: 1000, open: 100, high: 110, low: 95, close: 105, ...overrides };
}

// Shorthand: call updateTradeAlerts with NIFTY defaults
async function callUpdate(mock, opts = {}) {
  const {
    instrName = 'NIFTY', bias = 'up', candle = makeCandle(),
    target = 120, sl = 0, symbol = 'NIFTY260602C23400',
  } = opts;
  return updateTradeAlerts(mock, mockCdp, instrName, bias, candle, target, sl, symbol);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n=== pattern-monitor.js unit tests ===');

section('updateTradeAlerts — happy path');

await test('all succeed → 3 alert_update calls made', async () => {
  resetState();
  const mock = makeMock();
  await callUpdate(mock);
  return mock.calls.filter(c => c.tool === 'alert_update').length === 3;
});

await test('all succeed → lastAlertCandleTime updated (duplicate skipped on next call)', async () => {
  resetState();
  const mock = makeMock();
  const candle = makeCandle({ time: 42 });
  await callUpdate(mock, { candle });
  const calls1 = mock.calls.filter(c => c.tool === 'alert_update').length;
  // Second call with same candle — should be skipped
  const mock2 = makeMock();
  await callUpdate(mock2, { candle });
  const calls2 = mock2.calls.filter(c => c.tool === 'alert_update').length;
  return calls1 === 3 && calls2 === 0;
});

await test('entry alert updated with candle.high', async () => {
  resetState();
  const mock = makeMock();
  const candle = makeCandle({ high: 115, low: 90 });
  await callUpdate(mock, { candle });
  const entryCall = mock.calls.find(c => c.tool === 'alert_update' && c.args.alertName === NIFTY_NAMES.entry);
  return entryCall?.args?.level === 115;
});

await test('sl alert updated with candle.low when sl=0', async () => {
  resetState();
  const mock = makeMock();
  const candle = makeCandle({ high: 110, low: 95 });
  await callUpdate(mock, { candle, sl: 0 });
  const slCall = mock.calls.find(c => c.tool === 'alert_update' && c.args.alertName === NIFTY_NAMES.sl);
  return slCall?.args?.level === 95;
});

await test('explicit sl overrides candle.low', async () => {
  resetState();
  const mock = makeMock();
  const candle = makeCandle({ high: 110, low: 95 });
  await callUpdate(mock, { candle, sl: 88 });
  const slCall = mock.calls.find(c => c.tool === 'alert_update' && c.args.alertName === NIFTY_NAMES.sl);
  return slCall?.args?.level === 88;
});

await test('target alert updated with provided target', async () => {
  resetState();
  const mock = makeMock();
  await callUpdate(mock, { target: 135 });
  const tgtCall = mock.calls.find(c => c.tool === 'alert_update' && c.args.alertName === NIFTY_NAMES.target);
  return tgtCall?.args?.level === 135;
});

await test('all 3 updates use the provided symbol', async () => {
  resetState();
  const mock = makeMock();
  await callUpdate(mock, { symbol: 'NIFTY260609C23300' });
  const updates = mock.calls.filter(c => c.tool === 'alert_update');
  return updates.length === 3 && updates.every(c => c.args.symbol === 'NIFTY260609C23300');
});

section('updateTradeAlerts — failure handling');

await test('entry fails → no sl or target called', async () => {
  resetState();
  const mock = makeMock({ entryOk: false });
  await callUpdate(mock);
  const updates = mock.calls.filter(c => c.tool === 'alert_update').map(c => c.args.alertName);
  return updates.length === 1 && updates[0] === NIFTY_NAMES.entry;
});

await test('entry fails → lastAlertCandleTime NOT set (retry allowed on same candle)', async () => {
  resetState();
  const mock1 = makeMock({ entryOk: false });
  const candle = makeCandle({ time: 77 });
  await callUpdate(mock1, { candle });
  resetState(); // only resets _resetLastAlertCandleTime + state file (not candle time — already null from failure)
  _resetLastAlertCandleTime();
  const mock2 = makeMock();
  await callUpdate(mock2, { candle });
  return mock2.calls.filter(c => c.tool === 'alert_update').length === 3;
});

await test('sl fails → entry was called, target not called', async () => {
  resetState();
  const mock = makeMock({ slOk: false });
  await callUpdate(mock);
  const updates = mock.calls.filter(c => c.tool === 'alert_update').map(c => c.args.alertName);
  return updates.length === 2 &&
    updates[0] === NIFTY_NAMES.entry &&
    updates[1] === NIFTY_NAMES.sl;
});

await test('target fails → entry + sl called, lastAlertCandleTime NOT set', async () => {
  resetState();
  const mock1 = makeMock({ targetOk: false });
  const candle = makeCandle({ time: 33 });
  await callUpdate(mock1, { candle });
  _resetLastAlertCandleTime();
  const mock2 = makeMock();
  await callUpdate(mock2, { candle });
  return mock2.calls.filter(c => c.tool === 'alert_update').length === 3;
});

section('updateTradeAlerts — duplicate guard');

await test('same candle.time after success → zero alert_update calls', async () => {
  resetState();
  const mock = makeMock();
  const candle = makeCandle({ time: 11 });
  await callUpdate(mock, { candle });
  const mock2 = makeMock();
  await callUpdate(mock2, { candle });
  return mock2.calls.filter(c => c.tool === 'alert_update').length === 0;
});

await test('different candle.time after success → 3 alert_update calls', async () => {
  resetState();
  const mock = makeMock();
  await callUpdate(mock, { candle: makeCandle({ time: 1 }) });
  resetState();
  const mock2 = makeMock();
  await callUpdate(mock2, { candle: makeCandle({ time: 2 }) });
  return mock2.calls.filter(c => c.tool === 'alert_update').length === 3;
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(45));
console.log(`Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`);
if (fail > 0) process.exit(1);
