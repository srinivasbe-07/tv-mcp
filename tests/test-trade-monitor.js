#!/usr/bin/env node
/**
 * Unit tests for trade-monitor.js — createTradeAlerts.
 * No CDP / TradingView required — runs standalone.
 *
 * Usage:  node tests/test-trade-monitor.js
 */

import { createTradeAlerts, _resetLastAlertCandleTime } from '../monitors/trade-monitor.js';

// ---------------------------------------------------------------------------
// Minimal async test runner
// ---------------------------------------------------------------------------
let pass = 0,
  fail = 0;

async function test(name, fn) {
  try {
    const ok = await fn();
    if (ok) {
      console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
      pass++;
    } else {
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
      fail++;
    }
  } catch (e) {
    console.log(`  \x1b[31mERROR\x1b[0m ${name}: ${e.message}`);
    fail++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMock({ entryOk = true, slOk = true, targetOk = true } = {}) {
  const calls = [];
  const handle = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'alert_delete') {
      return { content: [{ type: 'text', text: '{}' }] };
    }
    let success;
    if (args.name === 'TradeEntry') success = entryOk;
    else if (args.name === 'TradeSL') success = slOk;
    else if (args.name === 'TradeTarget') success = targetOk;
    else success = true;
    const msg = success ? 'Alert created' : 'Plan limit reached';
    return { content: [{ type: 'text', text: JSON.stringify({ success, message: msg }) }] };
  };
  return { handle, calls };
}

function makeCandle(overrides = {}) {
  return { time: 1000, open: 100, high: 110, low: 95, close: 105, ...overrides };
}

const BASE_ARGS = { target: 120, sl: 0, symbol: 'BTCUSD', algotest: null, _delayMs: 0 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== trade-monitor.js unit tests ===');

section('createTradeAlerts — happy path');

await test('all succeed → lastAlertCandleTime updated (no duplicate on next call)', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  const candle = makeCandle({ time: 42 });
  await createTradeAlerts(
    mock,
    'up',
    candle,
    BASE_ARGS.target,
    BASE_ARGS.sl,
    BASE_ARGS.symbol,
    BASE_ARGS.algotest,
    0
  );
  // Call again with same candle — should be skipped (duplicate guard)
  const calls1 = mock.calls.filter((c) => c.tool === 'alert_create').length;
  await createTradeAlerts(
    mock,
    'up',
    candle,
    BASE_ARGS.target,
    BASE_ARGS.sl,
    BASE_ARGS.symbol,
    BASE_ARGS.algotest,
    0
  );
  const calls2 = mock.calls.filter((c) => c.tool === 'alert_create').length;
  return calls1 === 3 && calls2 === 3; // no extra calls on duplicate
});

await test('LONG (bias=up) → TradeEntry uses candle.high with crosses_up', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  const candle = makeCandle({ high: 110, low: 95 });
  await createTradeAlerts(mock, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const entry = mock.calls.find((c) => c.args?.name === 'TradeEntry');
  return entry?.args?.level === 110 && entry?.args?.condition === 'crosses_up';
});

await test('SHORT (bias=down) → TradeEntry uses candle.low', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  const candle = makeCandle({ high: 110, low: 95 });
  await createTradeAlerts(mock, 'down', candle, 80, 0, 'BTCUSD', null, 0);
  const entry = mock.calls.find((c) => c.args?.name === 'TradeEntry');
  return entry?.args?.level === 95;
});

await test('LONG → Entry crosses_up, SL crosses_down, Target crosses_down (pullback to target)', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  await createTradeAlerts(
    mock,
    'up',
    makeCandle({ high: 110, low: 95 }),
    120,
    0,
    'BTCUSD',
    null,
    0
  );
  const entry = mock.calls.find((c) => c.args?.name === 'TradeEntry');
  const sl = mock.calls.find((c) => c.args?.name === 'TradeSL');
  const tgt = mock.calls.find((c) => c.args?.name === 'TradeTarget');
  return (
    entry?.args?.condition === 'crosses_up' &&
    sl?.args?.condition === 'crosses_down' &&
    tgt?.args?.condition === 'crosses_down'
  );
});

await test('explicit sl used over auto', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  const candle = makeCandle({ high: 110, low: 95 });
  await createTradeAlerts(mock, 'up', candle, 120, 90, 'BTCUSD', null, 0);
  const sl = mock.calls.find((c) => c.args?.name === 'TradeSL');
  return sl?.args?.level === 90; // explicit SL, not candle.low (95)
});

section('createTradeAlerts — alert failure handling');

await test('TradeEntry fails → no TradeSL or TradeTarget called', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock({ entryOk: false });
  const candle = makeCandle({ time: 99 });
  await createTradeAlerts(mock, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const creates = mock.calls.filter((c) => c.tool === 'alert_create');
  return creates.length === 1 && creates[0].args.name === 'TradeEntry';
});

await test('TradeEntry fails → lastAlertCandleTime NOT updated (will retry next candle match)', async () => {
  _resetLastAlertCandleTime();
  const mock1 = makeMock({ entryOk: false });
  const candle = makeCandle({ time: 77 });
  await createTradeAlerts(mock1, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  // Now retry with a succeeding mock and same candle — should NOT be skipped
  const mock2 = makeMock();
  await createTradeAlerts(mock2, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const creates2 = mock2.calls.filter((c) => c.tool === 'alert_create');
  return creates2.length === 3;
});

await test('TradeSL fails → TradeEntry was created, TradeTarget not called', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock({ slOk: false });
  await createTradeAlerts(mock, 'up', makeCandle(), 120, 0, 'BTCUSD', null, 0);
  const creates = mock.calls.filter((c) => c.tool === 'alert_create').map((c) => c.args.name);
  return creates.length === 2 && creates[0] === 'TradeEntry' && creates[1] === 'TradeSL';
});

await test('TradeSL fails → lastAlertCandleTime NOT updated', async () => {
  _resetLastAlertCandleTime();
  const mock1 = makeMock({ slOk: false });
  const candle = makeCandle({ time: 55 });
  await createTradeAlerts(mock1, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const mock2 = makeMock();
  await createTradeAlerts(mock2, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  return mock2.calls.filter((c) => c.tool === 'alert_create').length === 3;
});

await test('TradeTarget fails → Entry + SL created, lastAlertCandleTime NOT updated', async () => {
  _resetLastAlertCandleTime();
  const mock1 = makeMock({ targetOk: false });
  const candle = makeCandle({ time: 33 });
  await createTradeAlerts(mock1, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const creates1 = mock1.calls.filter((c) => c.tool === 'alert_create').map((c) => c.args.name);
  // Retry — should NOT be skipped since lastAlertCandleTime was not set
  const mock2 = makeMock();
  await createTradeAlerts(mock2, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  return creates1.length === 3 && mock2.calls.filter((c) => c.tool === 'alert_create').length === 3;
});

section('createTradeAlerts — duplicate guard');

await test('same candle.time after success → skips (zero alert_create calls)', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  const candle = makeCandle({ time: 11 });
  await createTradeAlerts(mock, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  const mock2 = makeMock();
  await createTradeAlerts(mock2, 'up', candle, 120, 0, 'BTCUSD', null, 0);
  return mock2.calls.filter((c) => c.tool === 'alert_create').length === 0;
});

await test('different candle.time after success → creates alerts again', async () => {
  _resetLastAlertCandleTime();
  const mock = makeMock();
  await createTradeAlerts(mock, 'up', makeCandle({ time: 1 }), 120, 0, 'BTCUSD', null, 0);
  const mock2 = makeMock();
  await createTradeAlerts(mock2, 'up', makeCandle({ time: 2 }), 120, 0, 'BTCUSD', null, 0);
  return mock2.calls.filter((c) => c.tool === 'alert_create').length === 3;
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(45));
console.log(
  `Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`
);
if (fail > 0) process.exit(1);
