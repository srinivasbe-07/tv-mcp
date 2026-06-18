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
  INSTRUMENTS,
} from '../monitors/monitor.js';

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
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(45));
console.log(
  `Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`
);
process.exit(fail > 0 ? 1 : 0);
