#!/usr/bin/env node
/**
 * Unit tests for the bias-monitor pure functions in monitor.js.
 * No CDP / TradingView required — runs standalone.
 *
 * Usage:  node tests/test-bias.js
 */

import {
  BIAS_ALERT_NAMES,
  calcATM,
  calcBiasStrike,
  biasAlertPlan,
  processBiasHistory,
  deriveBiasStatus,
  INSTRUMENTS,
} from '../monitors/monitor.js';
import {
  classify,
  parseTrades,
  parseOpenTrades,
  computeExitValues,
} from '../scripts/generate-bias-report.js';
import { isMarketOff, extractSnapshotItems, lastTradingDay } from '../scripts/read-live-log.js';

// ---------------------------------------------------------------------------
// Minimal test runner (same style as test-monitor.js)
// ---------------------------------------------------------------------------
let pass = 0,
  fail = 0;

function test(name, fn) {
  try {
    if (fn()) {
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

console.log('\n=== bias-monitor unit tests ===');

// ---------------------------------------------------------------------------
// BIAS_ALERT_NAMES — exact names the user specified
// ---------------------------------------------------------------------------
section('BIAS_ALERT_NAMES — NIFTY');
test('up entry  = 0NiftyBiasEntry', () => BIAS_ALERT_NAMES.NIFTY.up.entry === '0NiftyBiasEntry');
test('up exit   = 0NiftyBiasExit', () => BIAS_ALERT_NAMES.NIFTY.up.exit === '0NiftyBiasExit');
test('up target = 0NiftyBiasTarget', () => BIAS_ALERT_NAMES.NIFTY.up.target === '0NiftyBiasTarget');
test('down entry  = zNiftyBiasEntry', () =>
  BIAS_ALERT_NAMES.NIFTY.down.entry === 'zNiftyBiasEntry');
test('down exit   = zNiftyBiasExit', () => BIAS_ALERT_NAMES.NIFTY.down.exit === 'zNiftyBiasExit');
test('down target = zNiftyBiasTarget', () =>
  BIAS_ALERT_NAMES.NIFTY.down.target === 'zNiftyBiasTarget');

section('BIAS_ALERT_NAMES — SENSEX');
test('up entry  = 0SensexBiasEntry', () => BIAS_ALERT_NAMES.SENSEX.up.entry === '0SensexBiasEntry');
test('up exit   = 0SensexBiasExit', () => BIAS_ALERT_NAMES.SENSEX.up.exit === '0SensexBiasExit');
test('up target = 0SensexBiasTarget', () =>
  BIAS_ALERT_NAMES.SENSEX.up.target === '0SensexBiasTarget');
test('down entry  = zSensexBiasEntry', () =>
  BIAS_ALERT_NAMES.SENSEX.down.entry === 'zSensexBiasEntry');
test('down exit   = zSensexBiasExit', () =>
  BIAS_ALERT_NAMES.SENSEX.down.exit === 'zSensexBiasExit');
test('down target = zSensexBiasTarget', () =>
  BIAS_ALERT_NAMES.SENSEX.down.target === 'zSensexBiasTarget');

// ---------------------------------------------------------------------------
// calcBiasStrike — up = CE (below ATM), down = PE (above ATM)
// ---------------------------------------------------------------------------
section('calcBiasStrike — NIFTY (step 50)');
test('up ITM-2 @ ATM 23950 → CE 23850', () => {
  const r = calcBiasStrike(23950, 2, 50, 'up');
  return r.strike === 23850 && r.optType === 'CE';
});
test('down ITM-2 @ ATM 23950 → PE 24050', () => {
  const r = calcBiasStrike(23950, 2, 50, 'down');
  return r.strike === 24050 && r.optType === 'PE';
});
test('up ITM-1 @ ATM 23950 → CE 23900', () => calcBiasStrike(23950, 1, 50, 'up').strike === 23900);
test('down ITM-1 @ ATM 23950 → PE 24000', () =>
  calcBiasStrike(23950, 1, 50, 'down').strike === 24000);
test('up ATM (depth 0) → CE at ATM', () => calcBiasStrike(23950, 0, 50, 'up').strike === 23950);

section('calcBiasStrike — SENSEX (step 100)');
test('up ITM-2 @ ATM 75500 → CE 75300', () => {
  const r = calcBiasStrike(75500, 2, 100, 'up');
  return r.strike === 75300 && r.optType === 'CE';
});
test('down ITM-2 @ ATM 75500 → PE 75700', () => {
  const r = calcBiasStrike(75500, 2, 100, 'down');
  return r.strike === 75700 && r.optType === 'PE';
});

section('calcBiasStrike — matches supertrend CE/PE math');
test('up strike == ST ceStrike', () => {
  const cfg = INSTRUMENTS.NIFTY;
  const atm = calcATM(23933, cfg.strikeInterval);
  const ce = atm - 2 * cfg.strikeInterval;
  return calcBiasStrike(atm, 2, cfg.strikeInterval, 'up').strike === ce;
});
test('down strike == ST peStrike', () => {
  const cfg = INSTRUMENTS.NIFTY;
  const atm = calcATM(23933, cfg.strikeInterval);
  const pe = atm + 2 * cfg.strikeInterval;
  return calcBiasStrike(atm, 2, cfg.strikeInterval, 'down').strike === pe;
});
test('unknown direction defaults to up/CE', () =>
  calcBiasStrike(23950, 2, 50, 'sideways').optType === 'CE');

// ---------------------------------------------------------------------------
// biasAlertPlan — activate chosen direction, deactivate opposite
// ---------------------------------------------------------------------------
section('biasAlertPlan — NIFTY up');
test('activates the 3 up alerts', () => {
  const p = biasAlertPlan('NIFTY', 'up');
  return (
    p.activate.length === 3 &&
    p.activate.includes('0NiftyBiasEntry') &&
    p.activate.includes('0NiftyBiasExit') &&
    p.activate.includes('0NiftyBiasTarget')
  );
});
test('deactivates the 3 down alerts', () => {
  const p = biasAlertPlan('NIFTY', 'up');
  return (
    p.deactivate.length === 3 &&
    p.deactivate.includes('zNiftyBiasEntry') &&
    p.deactivate.includes('zNiftyBiasExit') &&
    p.deactivate.includes('zNiftyBiasTarget')
  );
});

section('biasAlertPlan — NIFTY down (mirror)');
test('activates the 3 down alerts', () => {
  const p = biasAlertPlan('NIFTY', 'down');
  return p.activate.includes('zNiftyBiasEntry') && p.deactivate.includes('0NiftyBiasEntry');
});

section('biasAlertPlan — SENSEX + edge cases');
test('SENSEX up activates 0Sensex* and deactivates zSensex*', () => {
  const p = biasAlertPlan('SENSEX', 'up');
  return p.activate.includes('0SensexBiasTarget') && p.deactivate.includes('zSensexBiasTarget');
});
test('only touches today instrument — NIFTY plan has no SENSEX names', () => {
  const p = biasAlertPlan('NIFTY', 'up');
  const all = [...p.activate, ...p.deactivate];
  return all.every((n) => n.includes('Nifty'));
});
test('unknown instrument → empty plan', () => {
  const p = biasAlertPlan('BANKNIFTY', 'up');
  return p.activate.length === 0 && p.deactivate.length === 0;
});

// ---------------------------------------------------------------------------
// processBiasHistory — single-position open/closed tracking
// ---------------------------------------------------------------------------
const UP_ENTRY = '0NiftyBiasEntry';
const UP_EXIT = '0NiftyBiasExit';
const UP_TGT = '0NiftyBiasTarget';

function freshBiasState(overrides = {}) {
  return { biasPosition: 'closed', lastBiasLogSnapshot: [], ...overrides };
}

section('processBiasHistory — fresh-start scan');
test('entry at top → open', () => {
  const s = freshBiasState();
  processBiasHistory([{ name: UP_ENTRY, symbol: '' }], s, 'NIFTY', 'up');
  return s.biasPosition === 'open';
});
test('exit newest (entry below) → closed', () => {
  const s = freshBiasState();
  processBiasHistory(
    [
      { name: UP_EXIT, symbol: '' },
      { name: UP_ENTRY, symbol: '' },
    ],
    s,
    'NIFTY',
    'up'
  );
  return s.biasPosition === 'closed';
});
test('target newest → closed', () => {
  const s = freshBiasState();
  processBiasHistory(
    [
      { name: UP_TGT, symbol: '' },
      { name: UP_ENTRY, symbol: '' },
    ],
    s,
    'NIFTY',
    'up'
  );
  return s.biasPosition === 'closed';
});
test('entry newest (no exit) → open', () => {
  const s = freshBiasState();
  processBiasHistory(
    [
      { name: UP_ENTRY, symbol: '' },
      { name: UP_EXIT, symbol: '' },
    ],
    s,
    'NIFTY',
    'up'
  );
  return s.biasPosition === 'open';
});
test('no bias alerts in history → stays closed', () => {
  const s = freshBiasState();
  processBiasHistory([{ name: 'someOther', symbol: '' }], s, 'NIFTY', 'up');
  return s.biasPosition === 'closed';
});
test('opposite-direction alert ignored for active direction', () => {
  // We are tracking 'up' but only a down-entry exists → up stays closed
  const s = freshBiasState();
  processBiasHistory([{ name: 'zNiftyBiasEntry', symbol: '' }], s, 'NIFTY', 'up');
  return s.biasPosition === 'closed';
});
test('returns changed=true when derived differs', () => {
  const s = freshBiasState();
  return processBiasHistory([{ name: UP_ENTRY, symbol: '' }], s, 'NIFTY', 'up') === true;
});

section('processBiasHistory — diff-based (snapshot from prior tick)');
test('new entry above boundary → opens', () => {
  const base = [{ name: 'other', symbol: '' }];
  const s = { biasPosition: 'closed', lastBiasLogSnapshot: base };
  processBiasHistory([{ name: UP_ENTRY, symbol: '' }, ...base], s, 'NIFTY', 'up');
  return s.biasPosition === 'open';
});
test('new exit above boundary → closes', () => {
  const base = [{ name: UP_ENTRY, symbol: '' }];
  const s = { biasPosition: 'open', lastBiasLogSnapshot: base };
  processBiasHistory([{ name: UP_EXIT, symbol: '' }, ...base], s, 'NIFTY', 'up');
  return s.biasPosition === 'closed';
});
test('nothing new → unchanged', () => {
  const base = [{ name: UP_ENTRY, symbol: '' }];
  const s = { biasPosition: 'open', lastBiasLogSnapshot: base };
  const changed = processBiasHistory(base, s, 'NIFTY', 'up');
  return changed === false && s.biasPosition === 'open';
});

section('processBiasHistory — guards');
test('unknown instrument/direction → false, no change', () => {
  const s = freshBiasState({ biasPosition: 'open' });
  const changed = processBiasHistory([{ name: UP_ENTRY, symbol: '' }], s, 'BANKNIFTY', 'up');
  return changed === false && s.biasPosition === 'open';
});
test('snapshot sealed to top-30', () => {
  const s = freshBiasState();
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`, symbol: '' }));
  processBiasHistory(items, s, 'NIFTY', 'up');
  return s.lastBiasLogSnapshot.length === 30;
});

// ---------------------------------------------------------------------------
// deriveBiasStatus — UI status from the alert log, direction-agnostic (scans both
// up & down sets; newest relevant fire wins). Used by the UI-only bias monitor.
// ---------------------------------------------------------------------------
const N = BIAS_ALERT_NAMES.NIFTY;
section('deriveBiasStatus');
test('up entry → open/up', () => {
  const r = deriveBiasStatus([{ name: N.up.entry }], 'NIFTY');
  return r.position === 'open' && r.direction === 'up';
});
test('down entry → open/down', () => {
  const r = deriveBiasStatus([{ name: N.down.entry }], 'NIFTY');
  return r.position === 'open' && r.direction === 'down';
});
test('up exit → closed/up', () => {
  const r = deriveBiasStatus([{ name: N.up.exit }], 'NIFTY');
  return r.position === 'closed' && r.direction === 'up';
});
test('down target → closed/down', () => {
  const r = deriveBiasStatus([{ name: N.down.target }], 'NIFTY');
  return r.position === 'closed' && r.direction === 'down';
});
test('newest relevant fire wins (down entry above up exit)', () => {
  const r = deriveBiasStatus([{ name: N.down.entry }, { name: N.up.exit }], 'NIFTY');
  return r.position === 'open' && r.direction === 'down';
});
test('non-bias rows ignored → first bias wins', () => {
  const r = deriveBiasStatus([{ name: 'niftySupertrendLongEntry' }, { name: N.up.entry }], 'NIFTY');
  return r.position === 'open' && r.direction === 'up';
});
test('no bias alerts → closed/null', () => {
  const r = deriveBiasStatus([{ name: 'niftySupertrendLongEntry' }], 'NIFTY');
  return r.position === 'closed' && r.direction === null;
});
test('empty history → closed/null', () => {
  const r = deriveBiasStatus([], 'NIFTY');
  return r.position === 'closed' && r.direction === null;
});
test('unknown instrument → closed/null', () => {
  const r = deriveBiasStatus([{ name: N.up.entry }], 'BANKNIFTY');
  return r.position === 'closed' && r.direction === null;
});

// ---------------------------------------------------------------------------
// EOD report parsing (generate-bias-report.js): classify / parseTrades / parseOpenTrades
// ---------------------------------------------------------------------------
const mk = (name, sym, time) => ({
  name,
  symbol: '',
  raw: `${name}\n${sym}, 1m\n${time}\nWebhook`,
});

section('classify (bias report)');
test('0NiftyBiasEntry → NIFTY/CE/entry', () => {
  const c = classify('0NiftyBiasEntry');
  return c && c.instrument === 'NIFTY' && c.side === 'CE' && c.event === 'entry';
});
test('zSensexBiasTarget → SENSEX/PE/target', () => {
  const c = classify('zSensexBiasTarget');
  return c && c.instrument === 'SENSEX' && c.side === 'PE' && c.event === 'target';
});
test('zNiftyBiasExit → NIFTY/PE/exit', () => {
  const c = classify('zNiftyBiasExit');
  return c && c.instrument === 'NIFTY' && c.side === 'PE' && c.event === 'exit';
});
test('non-bias alert → null', () => classify('niftySupertrendLongEntry') === null);

section('parseTrades — entry → exit / target');
test('entry → exit pairs into one trade', () => {
  // snapshot is newest-first
  const snap = [
    mk('0SensexBiasExit', 'BSX260618C77300', '11:30:00'),
    mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00'),
  ];
  const t = parseTrades(snap, 'SENSEX');
  return (
    t.length === 1 &&
    t[0].side === 'CE' &&
    t[0].exitType === 'exit' &&
    t[0].entryTime === '11:00:00' &&
    t[0].exitTime === '11:30:00'
  );
});
test('entry → target closes the trade (exitType=target)', () => {
  const snap = [
    mk('0SensexBiasTarget', 'BSX260618C77300', '11:30:00'),
    mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00'),
  ];
  const t = parseTrades(snap, 'SENSEX');
  return t.length === 1 && t[0].exitType === 'target';
});
test('lone entry (no close) → no completed trade', () => {
  const snap = [mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00')];
  return parseTrades(snap, 'SENSEX').length === 0;
});
test('instrFilter excludes other instrument', () => {
  const snap = [
    mk('0NiftyBiasExit', 'NIFTY260603C23300', '11:30:00'),
    mk('0NiftyBiasEntry', 'NIFTY260603C23300', '11:00:00'),
  ];
  return parseTrades(snap, 'SENSEX').length === 0 && parseTrades(snap, 'NIFTY').length === 1;
});
test('down (PE) entry/exit pairs correctly', () => {
  const snap = [
    mk('zSensexBiasExit', 'BSX260618P77600', '12:00:00'),
    mk('zSensexBiasEntry', 'BSX260618P77600', '11:45:00'),
  ];
  const t = parseTrades(snap, 'SENSEX');
  return t.length === 1 && t[0].side === 'PE';
});

section('parseOpenTrades — entry with no close → open at EOD');
test('lone entry → 1 open trade (EOD exit)', () => {
  const snap = [mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00')];
  const o = parseOpenTrades(snap, 1, 'SENSEX');
  return o.length === 1 && o[0].exitTime === '15:26:00' && o[0].exitType === 'eod';
});
test('entry then exit → no open trade', () => {
  const snap = [
    mk('0SensexBiasExit', 'BSX260618C77300', '11:30:00'),
    mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00'),
  ];
  return parseOpenTrades(snap, 1, 'SENSEX').length === 0;
});
test('entry then target → no open trade', () => {
  const snap = [
    mk('0SensexBiasTarget', 'BSX260618C77300', '11:30:00'),
    mk('0SensexBiasEntry', 'BSX260618C77300', '11:00:00'),
  ];
  return parseOpenTrades(snap, 1, 'SENSEX').length === 0;
});

// ---------------------------------------------------------------------------
// computeExitValues — stepped trailing stop (Exit w/SL) + fixed bracket (Exit w/Tgt)
// ---------------------------------------------------------------------------
const bar = (high, low) => ({ high, low, close: (high + low) / 2 });

section('computeExitValues — trailing stop (NIFTY: SL15 step10 gap12)');
test('no bars, profit exit → exit at actual; tgtPts clamped', () => {
  const r = computeExitValues('NIFTY', 100, 105, []);
  return r.exitSL === 105 && r.tgtPts === 5 && r.exitTgt === 131;
});
test('initial stop hit → exit at entry−15', () => {
  const r = computeExitValues('NIFTY', 100, 84, [bar(101, 84)]);
  return r.exitSL === 85 && r.tgtPts === -15;
});
test('trails to 98 after +10 milestone, then stopped', () => {
  const r = computeExitValues('NIFTY', 100, 99, [bar(110, 100), bar(112, 108), bar(111, 97)]);
  return r.exitSL === 98;
});
test('+20 milestone → stop 108, stopped on next bar', () => {
  const r = computeExitValues('NIFTY', 100, 100, [bar(120, 100), bar(120, 107)]);
  return r.exitSL === 108;
});
test('+30 milestone → stop 118; never stopped → exit at actual', () => {
  const r = computeExitValues('NIFTY', 100, 130, [bar(135, 100)]);
  return r.exitSL === 130;
});

section('computeExitValues — fixed bracket (Exit w/Tgt)');
test('NIFTY target 131 hit intraday → tgtPts 31', () => {
  const r = computeExitValues('NIFTY', 100, 120, [bar(131, 100)]);
  return r.tgtPts === 31 && r.exitTgt === 131;
});
test('SENSEX target 35 / SL 35 (target hit)', () => {
  const r = computeExitValues('SENSEX', 200, 236, [bar(236, 200)]);
  return r.exitTgt === 235 && r.tgtPts === 35;
});
test('SENSEX no target → loss clamped to −35; stop floor 165', () => {
  const r = computeExitValues('SENSEX', 200, 150, [bar(205, 200)]);
  return r.exitSL === 165 && r.tgtPts === -35;
});

// ---------------------------------------------------------------------------
// read-live-log helpers: isMarketOff (live-log fallback gate) + extractSnapshotItems
// ---------------------------------------------------------------------------
// Build a Date for a desired IST wall-clock time (isMarketOff adds +5:30 internally).
const atIST = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 3600 * 1000);
const HOL = new Set(['2026-06-26']); // Jun 26 2026 is a Friday NSE holiday

section('isMarketOff — weekend / holiday / hours');
test('Saturday noon → off', () => isMarketOff(atIST(2026, 6, 20, 12, 0), HOL) === true);
test('Sunday noon → off', () => isMarketOff(atIST(2026, 6, 21, 12, 0), HOL) === true);
test('Monday noon → on (not off)', () => isMarketOff(atIST(2026, 6, 15, 12, 0), HOL) === false);
test('Friday holiday (Jun 26) noon → off', () =>
  isMarketOff(atIST(2026, 6, 26, 12, 0), HOL) === true);
test('Monday 09:00 pre-open → off', () => isMarketOff(atIST(2026, 6, 15, 9, 0), HOL) === true);
test('Monday 09:10 open → on', () => isMarketOff(atIST(2026, 6, 15, 9, 10), HOL) === false);
test('Monday 15:30 close → on', () => isMarketOff(atIST(2026, 6, 15, 15, 30), HOL) === false);
test('Monday 15:31 after close → off', () => isMarketOff(atIST(2026, 6, 15, 15, 31), HOL) === true);

section('lastTradingDay — most recent completed session (NSE holidays injected)');
// Jun 2026: 15=Mon … 19=Fri, 20=Sat, 21=Sun. Jun 26 (Fri) is an NSE holiday.
test('Saturday → previous Friday', () =>
  lastTradingDay(atIST(2026, 6, 20, 10, 0), HOL) === '2026-06-19');
test('Sunday → previous Friday', () =>
  lastTradingDay(atIST(2026, 6, 21, 18, 0), HOL) === '2026-06-19');
test('Friday after close → same Friday', () =>
  lastTradingDay(atIST(2026, 6, 19, 16, 0), HOL) === '2026-06-19');
test('Friday during market → same Friday', () =>
  lastTradingDay(atIST(2026, 6, 19, 12, 0), HOL) === '2026-06-19');
test('Monday pre-open → previous Friday (today not yet opened)', () =>
  lastTradingDay(atIST(2026, 6, 15, 8, 0), HOL) === '2026-06-12');
test('Monday after open → same Monday', () =>
  lastTradingDay(atIST(2026, 6, 15, 9, 30), HOL) === '2026-06-15');
test('Saturday Jun 27 → skips Fri Jun 26 holiday → Thu Jun 25', () =>
  lastTradingDay(atIST(2026, 6, 27, 10, 0), HOL) === '2026-06-25');

section('extractSnapshotItems — shape normalization');
test('{items} → items array', () => extractSnapshotItems({ items: [{ name: 'a' }] }).length === 1);
test('array passthrough', () => extractSnapshotItems([{ name: 'a' }, { name: 'b' }]).length === 2);
test('raw CDP {result:{value:{items}}}', () =>
  extractSnapshotItems({ result: { value: { items: [{ name: 'a' }] } } }).length === 1);
test('null → empty', () => extractSnapshotItems(null).length === 0);
test('object without items → empty', () => extractSnapshotItems({ diag: {} }).length === 0);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(45));
console.log(
  `Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`
);
process.exit(fail > 0 ? 1 : 0);
