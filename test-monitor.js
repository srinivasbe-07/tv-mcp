#!/usr/bin/env node
/**
 * Unit tests for monitor.js pure functions.
 * No CDP / TradingView required — runs standalone.
 *
 * Usage:  node test-monitor.js
 */

import {
  calcATM,
  buildSymbol,
  getExpiryDate,
  loadHolidays,
  DAY_INSTRUMENT,
  INSTRUMENTS,
  NIFTY_ITM_BY_DAY,
  calcITMDepth,
} from './monitor.js';

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------
let pass = 0,
  fail = 0;

function test(name, fn) {
  try {
    const ok = fn();
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
// Helpers
function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

console.log('\n=== monitor.js unit tests ===');

// ---------------------------------------------------------------------------
// calcATM
// ---------------------------------------------------------------------------
section('calcATM (NIFTY, step=50)');
test('23933 → 23950', () => calcATM(23933, 50) === 23950);
test('23924 → 23900', () => calcATM(23924, 50) === 23900);
test('23925 → 23950', () => calcATM(23925, 50) === 23950); // .5 rounds up
test('23975 → 24000', () => calcATM(23975, 50) === 24000);
test('24000 → 24000', () => calcATM(24000, 50) === 24000); // exact multiple

section('calcATM (SENSEX, step=100)');
test('75440 → 75400', () => calcATM(75440, 100) === 75400);
test('75450 → 75500', () => calcATM(75450, 100) === 75500); // .5 rounds up
test('75499 → 75500', () => calcATM(75499, 100) === 75500);
test('82000 → 82000', () => calcATM(82000, 100) === 82000);

// ---------------------------------------------------------------------------
// DAY_INSTRUMENT routing
// ---------------------------------------------------------------------------
section('DAY_INSTRUMENT routing');
test('Mon (1) → NIFTY', () => DAY_INSTRUMENT[1] === 'NIFTY');
test('Tue (2) → NIFTY', () => DAY_INSTRUMENT[2] === 'NIFTY');
test('Wed (3) → SENSEX', () => DAY_INSTRUMENT[3] === 'SENSEX');
test('Thu (4) → SENSEX', () => DAY_INSTRUMENT[4] === 'SENSEX');
test('Fri (5) → NIFTY', () => DAY_INSTRUMENT[5] === 'NIFTY');

// ---------------------------------------------------------------------------
// INSTRUMENTS config
// ---------------------------------------------------------------------------
section('INSTRUMENTS config — NIFTY');
test('strikeInterval = 50', () => INSTRUMENTS.NIFTY.strikeInterval === 50);
test('itmDepth = 2', () => INSTRUMENTS.NIFTY.itmDepth === 2);
test('expiryDay = 2 (Tuesday)', () => INSTRUMENTS.NIFTY.expiryDay === 2);
test('symbolPrefix = NIFTY', () => INSTRUMENTS.NIFTY.symbolPrefix === 'NIFTY');
test('spotSymbol = NSE:NIFTY', () => INSTRUMENTS.NIFTY.spotSymbol === 'NSE:NIFTY');

section('INSTRUMENTS config — SENSEX');
test('strikeInterval = 100', () => INSTRUMENTS.SENSEX.strikeInterval === 100);
test('itmDepth = 2', () => INSTRUMENTS.SENSEX.itmDepth === 2);
test('expiryDay = 4 (Thursday)', () => INSTRUMENTS.SENSEX.expiryDay === 4);
test('symbolPrefix = BSX', () => INSTRUMENTS.SENSEX.symbolPrefix === 'BSX');
test('spotSymbol = BSE:SENSEX', () => INSTRUMENTS.SENSEX.spotSymbol === 'BSE:SENSEX');

// ---------------------------------------------------------------------------
// buildSymbol
// ---------------------------------------------------------------------------
section('buildSymbol — NIFTY');
test('CE starts with NIFTY', () => buildSymbol(INSTRUMENTS.NIFTY, 23850, 'CE').startsWith('NIFTY'));
test('CE contains C', () => /C\d+$/.test(buildSymbol(INSTRUMENTS.NIFTY, 23850, 'CE')));
test('PE contains P', () => /P\d+$/.test(buildSymbol(INSTRUMENTS.NIFTY, 23850, 'PE')));
test('CE ends with strike', () => buildSymbol(INSTRUMENTS.NIFTY, 23850, 'CE').endsWith('23850'));
test('PE ends with strike', () => buildSymbol(INSTRUMENTS.NIFTY, 23850, 'PE').endsWith('23850'));
test('format NIFTYYYMMDDCNNNNN', () =>
  /^NIFTY\d{6}C\d+$/.test(buildSymbol(INSTRUMENTS.NIFTY, 23850, 'CE')));

section('buildSymbol — SENSEX');
test('CE starts with BSX', () => buildSymbol(INSTRUMENTS.SENSEX, 75500, 'CE').startsWith('BSX'));
test('CE contains C', () => /C\d+$/.test(buildSymbol(INSTRUMENTS.SENSEX, 75500, 'CE')));
test('PE contains P', () => /P\d+$/.test(buildSymbol(INSTRUMENTS.SENSEX, 75500, 'PE')));
test('CE ends with strike', () => buildSymbol(INSTRUMENTS.SENSEX, 75500, 'CE').endsWith('75500'));
test('format BSXYYMMDDCNNNNN', () =>
  /^BSX\d{6}C\d+$/.test(buildSymbol(INSTRUMENTS.SENSEX, 75500, 'CE')));

// ---------------------------------------------------------------------------
// getExpiryDate — never a weekend, never a holiday
// ---------------------------------------------------------------------------
const holidays = loadHolidays();

section('getExpiryDate — NIFTY (Tuesday expiry)');
test('not Saturday or Sunday', () => {
  const d = getExpiryDate(INSTRUMENTS.NIFTY.expiryDay);
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
});
test('not a listed holiday', () => {
  const d = getExpiryDate(INSTRUMENTS.NIFTY.expiryDay);
  return !holidays.has(toDateStr(d));
});

section('getExpiryDate — SENSEX (Thursday expiry, holiday-aware)');
test('not Saturday or Sunday', () => {
  const d = getExpiryDate(INSTRUMENTS.SENSEX.expiryDay);
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
});
test('not a listed holiday', () => {
  const d = getExpiryDate(INSTRUMENTS.SENSEX.expiryDay);
  return !holidays.has(toDateStr(d));
});
test('May 28 2026 is holiday → expiry shifts to May 27', () => {
  // Only meaningful before the holiday date passes
  const now = new Date();
  if (now >= new Date('2026-05-29')) return true; // holiday week passed, skip
  const d = getExpiryDate(INSTRUMENTS.SENSEX.expiryDay);
  return d.getUTCDate() === 27 && d.getUTCMonth() + 1 === 5 && d.getUTCFullYear() === 2026;
});

// ---------------------------------------------------------------------------
// ITM strike calculation (integration of calcATM + buildSymbol)
// ---------------------------------------------------------------------------
section('ITM-2 strike derivation');
test('NIFTY 23933 → CE strike 23850', () => {
  const cfg = INSTRUMENTS.NIFTY;
  const atm = calcATM(23933, cfg.strikeInterval); // 23950
  const ce = atm - cfg.itmDepth * cfg.strikeInterval; // 23850
  return ce === 23850;
});
test('NIFTY 23933 → PE strike 24050', () => {
  const cfg = INSTRUMENTS.NIFTY;
  const atm = calcATM(23933, cfg.strikeInterval); // 23950
  const pe = atm + cfg.itmDepth * cfg.strikeInterval; // 24050
  return pe === 24050;
});
test('SENSEX 75450 → CE strike 75300', () => {
  const cfg = INSTRUMENTS.SENSEX;
  const atm = calcATM(75450, cfg.strikeInterval); // 75500
  const ce = atm - cfg.itmDepth * cfg.strikeInterval; // 75300
  return ce === 75300;
});
test('SENSEX 75450 → PE strike 75700', () => {
  const cfg = INSTRUMENTS.SENSEX;
  const atm = calcATM(75450, cfg.strikeInterval); // 75500
  const pe = atm + cfg.itmDepth * cfg.strikeInterval; // 75700
  return pe === 75700;
});

// ---------------------------------------------------------------------------
// calcITMDepth — day-based rule + user override
// ---------------------------------------------------------------------------
section('calcITMDepth — day-based (no override)');
test('Mon (1) NIFTY → ITM-1', () => calcITMDepth(1, 'NIFTY') === 1);
test('Tue (2) NIFTY → ITM-1', () => calcITMDepth(2, 'NIFTY') === 1);
test('Fri (5) NIFTY → ITM-2', () => calcITMDepth(5, 'NIFTY') === 2);
test('Wed (3) SENSEX → ITM-2', () => calcITMDepth(3, 'SENSEX') === 2);
test('Thu (4) SENSEX → ITM-2', () => calcITMDepth(4, 'SENSEX') === 2);
test('SENSEX ignores day rule', () => calcITMDepth(1, 'SENSEX') === 2); // Mon SENSEX still 2

section('calcITMDepth — user override takes priority');
test('override 0 (ATM) on Mon NIFTY', () => calcITMDepth(1, 'NIFTY', 0) === 0);
test('override 1 on Fri NIFTY', () => calcITMDepth(5, 'NIFTY', 1) === 1);
test('override 2 on Mon NIFTY', () => calcITMDepth(1, 'NIFTY', 2) === 2);
test('override 1 on SENSEX', () => calcITMDepth(3, 'SENSEX', 1) === 1);
test('override null = use day rule', () => calcITMDepth(1, 'NIFTY', null) === 1);

section('NIFTY_ITM_BY_DAY mapping');
test('Mon (1) = 1', () => NIFTY_ITM_BY_DAY[1] === 1);
test('Tue (2) = 1', () => NIFTY_ITM_BY_DAY[2] === 1);
test('Fri (5) = 2', () => NIFTY_ITM_BY_DAY[5] === 2);

// ---------------------------------------------------------------------------
// monitor-config.json override priority
// Mirrors the inline logic in tick():
//   configItm = [0,1,2].includes(config.itmOverride) ? config.itmOverride : null
//   effectiveOverride = cliOverride !== null ? cliOverride : configItm
// ---------------------------------------------------------------------------
function resolveOverride(cliOverride, configOverride) {
  const configItm = [0, 1, 2].includes(configOverride) ? configOverride : null;
  return cliOverride !== null ? cliOverride : configItm;
}

section('config-file override priority');
test('config=1, no CLI → ITM-1 on Mon NIFTY', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, 1)) === 1);
test('config=2, no CLI → ITM-2 on Mon NIFTY', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, 2)) === 2);
test('config=0 (ATM), no CLI → 0 on Fri NIFTY', () =>
  calcITMDepth(5, 'NIFTY', resolveOverride(null, 0)) === 0);
test('CLI=2 beats config=0', () => calcITMDepth(1, 'NIFTY', resolveOverride(2, 0)) === 2);
test('CLI=1 beats config=2', () => calcITMDepth(5, 'NIFTY', resolveOverride(1, 2)) === 1);
test('config=null → falls through to day rule', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, null)) === 1);
test('config=undefined → falls through to day rule', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, undefined)) === 1);
test('config=99 (invalid) → falls through to day rule', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, 99)) === 1);
test('config=1 on SENSEX → ITM-1 override', () =>
  calcITMDepth(3, 'SENSEX', resolveOverride(null, 1)) === 1);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(45));
console.log(
  `Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`
);
process.exit(fail > 0 ? 1 : 0);
