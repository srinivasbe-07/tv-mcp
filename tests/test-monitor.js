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
  processHistoryForPositionChanges,
  shouldUpdateATM,
  ATM_COOLDOWN_MS,
  todayIST,
  buildAlertHistoryScript,
  ALERT_HISTORY_SCRIPT,
} from '../monitors/monitor.js';

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
// buildAlertHistoryScript — the in-browser Log reader is limit-parametrized so
// EOD reports can grab a full day (bias + supertrend fires share one Log tab and
// an active day exceeds the per-tick default of 30).
// ---------------------------------------------------------------------------
section('buildAlertHistoryScript — limit interpolation');
test('default limit is 30', () => {
  const s = buildAlertHistoryScript();
  return (s.match(/< 30\b/g) || []).length === 2 && s.includes('.slice(0, 30)');
});
test('large limit reaches the scroll guards + final slice', () => {
  const s = buildAlertHistoryScript(400);
  return (s.match(/< 400\b/g) || []).length === 2 && s.includes('.slice(0, 400)');
});
test('no stray 30-cap remains when a larger limit is requested', () => {
  const s = buildAlertHistoryScript(400);
  return !/< 30\b/.test(s) && !s.includes('.slice(0, 30)');
});
test('exported ALERT_HISTORY_SCRIPT equals the 30-limit build (per-tick reader)', () =>
  ALERT_HISTORY_SCRIPT === buildAlertHistoryScript(30));

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
test('Mon (1) NIFTY → ITM-2', () => calcITMDepth(1, 'NIFTY') === 2);
test('Tue (2) NIFTY → ITM-2', () => calcITMDepth(2, 'NIFTY') === 2);
test('Fri (5) NIFTY → ITM-1', () => calcITMDepth(5, 'NIFTY') === 1);
test('Wed (3) SENSEX → ITM-2', () => calcITMDepth(3, 'SENSEX') === 2);
test('Thu (4) SENSEX → ITM-2', () => calcITMDepth(4, 'SENSEX') === 2);
test('SENSEX ignores day rule', () => calcITMDepth(1, 'SENSEX') === 2); // Mon SENSEX still 2

section('calcITMDepth — user override takes priority');
test('override 0 (ATM) on Mon NIFTY', () => calcITMDepth(1, 'NIFTY', 0) === 0);
test('override 1 on Fri NIFTY', () => calcITMDepth(5, 'NIFTY', 1) === 1);
test('override 2 on Mon NIFTY', () => calcITMDepth(1, 'NIFTY', 2) === 2);
test('override 1 on SENSEX', () => calcITMDepth(3, 'SENSEX', 1) === 1);
test('override null = use day rule', () => calcITMDepth(1, 'NIFTY', null) === 2);

section('NIFTY_ITM_BY_DAY mapping');
test('Mon (1) = 2', () => NIFTY_ITM_BY_DAY[1] === 2);
test('Tue (2) = 2', () => NIFTY_ITM_BY_DAY[2] === 2);
test('Fri (5) = 1', () => NIFTY_ITM_BY_DAY[5] === 1);

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
  calcITMDepth(1, 'NIFTY', resolveOverride(null, null)) === 2);
test('config=undefined → falls through to day rule', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, undefined)) === 2);
test('config=99 (invalid) → falls through to day rule', () =>
  calcITMDepth(1, 'NIFTY', resolveOverride(null, 99)) === 2);
test('config=1 on SENSEX → ITM-1 override', () =>
  calcITMDepth(3, 'SENSEX', resolveOverride(null, 1)) === 1);

// ---------------------------------------------------------------------------
// processHistoryForPositionChanges
// ---------------------------------------------------------------------------
function makeState(overrides = {}) {
  return { CE: 'closed', PE: 'closed', seenHistoryKeys: [], lastLogSnapshot: [], ...overrides };
}

const CE_ENTRY = 'niftySupertrendLongEntry';
const CE_EXIT = 'niftySupertrendLongExit';
const PE_ENTRY = 'niftySupertrendShortEntry';
const PE_EXIT = 'niftySupertrendShortExit';

section('processHistoryForPositionChanges — basic transitions');
test('CE entry → CE becomes open', () => {
  const s = makeState();
  processHistoryForPositionChanges([{ name: CE_ENTRY, time: '09:15' }], s);
  return s.CE === 'open';
});
test('CE entry → returns changed=true', () => {
  const s = makeState();
  return processHistoryForPositionChanges([{ name: CE_ENTRY, time: '09:15' }], s) === true;
});
test('CE exit → CE becomes closed', () => {
  const s = makeState({ CE: 'open' });
  processHistoryForPositionChanges([{ name: CE_EXIT, time: '10:00' }], s);
  return s.CE === 'closed';
});
test('PE entry → PE becomes open', () => {
  const s = makeState();
  processHistoryForPositionChanges([{ name: PE_ENTRY, time: '09:15' }], s);
  return s.PE === 'open';
});
test('PE exit → PE becomes closed', () => {
  const s = makeState({ PE: 'open' });
  processHistoryForPositionChanges([{ name: PE_EXIT, time: '10:00' }], s);
  return s.PE === 'closed';
});

section('processHistoryForPositionChanges — no spurious changes');
test('empty history → changed=false', () => {
  const s = makeState();
  return processHistoryForPositionChanges([], s) === false;
});
test('unknown alert name → no state change', () => {
  const s = makeState();
  processHistoryForPositionChanges([{ name: 'someOtherAlert', time: '09:15' }], s);
  return s.CE === 'closed' && s.PE === 'closed';
});
test('CE already open, entry again → changed=false', () => {
  const s = makeState({ CE: 'open' });
  return processHistoryForPositionChanges([{ name: CE_ENTRY, time: '09:15' }], s) === false;
});
test('PE already closed, exit again → changed=false', () => {
  const s = makeState({ PE: 'closed' });
  return processHistoryForPositionChanges([{ name: PE_EXIT, time: '10:00' }], s) === false;
});

section('processHistoryForPositionChanges — deduplication (seenHistoryKeys)');
test('same alert seen twice → only processed once', () => {
  const s = makeState();
  const item = { name: CE_ENTRY, time: '09:15' };
  processHistoryForPositionChanges([item], s);
  const changed2 = processHistoryForPositionChanges([item], s);
  return s.CE === 'open' && changed2 === false;
});
test('same name, different time → treated as new alert', () => {
  const s = makeState({ CE: 'open' });
  // entry at 09:15 already seen, exit at 09:30 is new
  s.seenHistoryKeys = [`${CE_ENTRY}|09:15`];
  processHistoryForPositionChanges([{ name: CE_EXIT, time: '09:30' }], s);
  return s.CE === 'closed';
});
test('lastLogSnapshot updated after processing', () => {
  const s = makeState();
  processHistoryForPositionChanges(
    [
      { name: CE_ENTRY, time: '09:15' },
      { name: PE_ENTRY, time: '09:16' },
    ],
    s
  );
  return s.lastLogSnapshot.length === 2;
});
test('lastLogSnapshot capped at 30 items', () => {
  const s = makeState();
  const items = Array.from({ length: 35 }, (_, i) => ({ name: `alert${i}`, time: `${i}:00` }));
  processHistoryForPositionChanges(items, s);
  return s.lastLogSnapshot.length === 30;
});
test('seenHistoryKeys capped at 200 even with 201 items', () => {
  const s = makeState();
  s.seenHistoryKeys = Array.from({ length: 200 }, (_, i) => `alert|${i}`);
  processHistoryForPositionChanges([{ name: CE_ENTRY, time: '09:15' }], s);
  return s.seenHistoryKeys.length === 200;
});

section('processHistoryForPositionChanges — CE/PE independence');
// Use a non-empty snapshot so the diff-based path runs (the fresh-start scan
// re-derives BOTH sides from scratch, which is not what "independence" means).
test('CE change does not affect PE', () => {
  const base = [{ name: 'someOtherAlert', symbol: '' }];
  const s = { CE: 'closed', PE: 'open', lastLogSnapshot: base };
  processHistoryForPositionChanges([{ name: CE_ENTRY, symbol: '' }, ...base], s);
  return s.PE === 'open' && s.CE === 'open';
});
test('PE change does not affect CE', () => {
  const base = [{ name: 'someOtherAlert', symbol: '' }];
  const s = { CE: 'open', PE: 'open', lastLogSnapshot: base };
  processHistoryForPositionChanges([{ name: PE_EXIT, symbol: '' }, ...base], s);
  return s.CE === 'open' && s.PE === 'closed';
});
test('batch: CE entry + PE entry in one call', () => {
  const s = makeState();
  processHistoryForPositionChanges(
    [
      { name: CE_ENTRY, time: '09:15' },
      { name: PE_ENTRY, time: '09:15' },
    ],
    s
  );
  return s.CE === 'open' && s.PE === 'open';
});
test('batch: full cycle CE open → close in one call', () => {
  const s = makeState();
  // Log tab is newest-first: CE_EXIT@10:00 is more recent than CE_ENTRY@09:15
  processHistoryForPositionChanges(
    [
      { name: CE_EXIT, time: '10:00' },
      { name: CE_ENTRY, time: '09:15' },
    ],
    s
  );
  return s.CE === 'closed';
});

// ---------------------------------------------------------------------------
// shouldUpdateATM — ATM cooldown logic
// ---------------------------------------------------------------------------
section('shouldUpdateATM — ATM not shifted (always update)');
test('atmShifted=false → update regardless of cooldown', () => {
  const state = { lastATMUpdateTime: Date.now() }; // cooldown active
  return shouldUpdateATM(state, { atmShifted: false }).update === true;
});

section('shouldUpdateATM — no cooldown active');
test('fresh state (lastATMUpdateTime=0) → update', () => {
  return shouldUpdateATM({ lastATMUpdateTime: 0 }, { atmShifted: true }).update === true;
});
test('cooldown expired (>90s ago) → update', () => {
  const state = { lastATMUpdateTime: Date.now() - ATM_COOLDOWN_MS - 1000 };
  return shouldUpdateATM(state, { atmShifted: true }).update === true;
});

section('shouldUpdateATM — cooldown active');
test('within cooldown → blocked, remaining seconds returned', () => {
  const state = { lastATMUpdateTime: Date.now() - 30_000 }; // 30s ago
  const r = shouldUpdateATM(state, { atmShifted: true });
  return r.update === false && r.remaining > 0 && r.remaining <= 90;
});
test('cooldown just started → ~full window remaining', () => {
  const state = { lastATMUpdateTime: Date.now() };
  const r = shouldUpdateATM(state, { atmShifted: true });
  const fullSecs = ATM_COOLDOWN_MS / 1000;
  return r.update === false && r.remaining >= fullSecs - 1;
});

section('shouldUpdateATM — bypass conditions');
test('force=true bypasses cooldown', () => {
  const state = { lastATMUpdateTime: Date.now() };
  return shouldUpdateATM(state, { atmShifted: true, force: true }).update === true;
});
test('CEjustClosed bypasses cooldown', () => {
  const state = { lastATMUpdateTime: Date.now() };
  return shouldUpdateATM(state, { atmShifted: true, CEjustClosed: true }).update === true;
});
test('PEjustClosed bypasses cooldown', () => {
  const state = { lastATMUpdateTime: Date.now() };
  return shouldUpdateATM(state, { atmShifted: true, PEjustClosed: true }).update === true;
});

// ---------------------------------------------------------------------------
// todayIST
// ---------------------------------------------------------------------------
section('todayIST');
test('returns YYYY-MM-DD string', () => /^\d{4}-\d{2}-\d{2}$/.test(todayIST()));
test('year is plausible (2024–2099)', () => {
  const y = parseInt(todayIST().split('-')[0], 10);
  return y >= 2024 && y <= 2099;
});
test('month 01–12', () => {
  const m = parseInt(todayIST().split('-')[1], 10);
  return m >= 1 && m <= 12;
});
test('day 01–31', () => {
  const d = parseInt(todayIST().split('-')[2], 10);
  return d >= 1 && d <= 31;
});
test('stable within the same second (two calls match)', () => todayIST() === todayIST());

// ---------------------------------------------------------------------------
// processHistoryForPositionChanges — fresh-start scan (market-hours late start /
// same-day restart). lastLogSnapshot is empty → scan history newest-to-oldest.
// ---------------------------------------------------------------------------
section('processHistoryForPositionChanges — fresh-start scan (lastLogSnapshot empty)');

// Helper: make state with empty snapshot (simulates startup / new session)
function makeFreshState(overrides = {}) {
  return { CE: 'closed', PE: 'closed', lastLogSnapshot: [], ...overrides };
}

test('fresh-start: CE entry at top → CE=open', () => {
  const s = makeFreshState();
  processHistoryForPositionChanges([{ name: CE_ENTRY }], s);
  return s.CE === 'open' && s.PE === 'closed';
});
test('fresh-start: PE entry at top → PE=open', () => {
  const s = makeFreshState();
  processHistoryForPositionChanges([{ name: PE_ENTRY }], s);
  return s.CE === 'closed' && s.PE === 'open';
});
test('fresh-start: CE exit most recent (entry below it) → CE=closed', () => {
  // Newest-first: exit is at top → trade already closed
  const s = makeFreshState();
  processHistoryForPositionChanges([{ name: CE_EXIT }, { name: CE_ENTRY }], s);
  return s.CE === 'closed';
});
test('fresh-start: CE entry most recent (no exit) → CE=open', () => {
  // Newest-first: entry is at top → trade still running
  const s = makeFreshState();
  processHistoryForPositionChanges([{ name: CE_ENTRY }, { name: CE_EXIT }], s);
  return s.CE === 'open';
});
test('fresh-start: both sides — CE entry + PE exit most recent → CE=open PE=closed', () => {
  const s = makeFreshState();
  processHistoryForPositionChanges([{ name: CE_ENTRY }, { name: PE_EXIT }, { name: PE_ENTRY }], s);
  return s.CE === 'open' && s.PE === 'closed';
});
test('fresh-start: snapshot populated to top-30 after scan', () => {
  const s = makeFreshState();
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `other${i}` }));
  processHistoryForPositionChanges(items, s);
  return s.lastLogSnapshot.length === 30;
});
test('fresh-start: returns changed=true when state derived differs', () => {
  const s = makeFreshState();
  return processHistoryForPositionChanges([{ name: CE_ENTRY }], s) === true;
});
test('fresh-start: returns changed=false when derived state matches existing', () => {
  const s = makeFreshState({ CE: 'open' });
  return processHistoryForPositionChanges([{ name: CE_ENTRY }], s) === false;
});

// Fallback when the log has fires but NONE for today's instrument. A real trade
// opened today would show its entry fire (→ seenTodayInstr), so a stale 'open' here
// can't be live → reset to closed. Covers a leftover NIFTY open surfacing on a
// later SENSEX day even after lastInstrument has advanced to SENSEX.
test('fresh-start: stale open, log has non-today fires → CE reset to closed', () => {
  const s = makeFreshState({ CE: 'open', PE: 'closed', lastInstrument: 'SENSEX' });
  processHistoryForPositionChanges([{ name: 'someOtherAlert' }], s, 'SENSEX');
  return s.CE === 'closed' && s.PE === 'closed';
});
test('fresh-start: stale PE open, log has non-today fires → PE reset to closed', () => {
  const s = makeFreshState({ CE: 'closed', PE: 'open', lastInstrument: 'SENSEX' });
  processHistoryForPositionChanges([{ name: 'someOtherAlert' }], s, 'SENSEX');
  return s.PE === 'closed';
});
test('fresh-start: empty log → open preserved (panel not loaded, no data to trust)', () => {
  const s = makeFreshState({ CE: 'open', PE: 'closed', lastInstrument: 'SENSEX' });
  processHistoryForPositionChanges([], s, 'SENSEX');
  return s.CE === 'open';
});

// ---------------------------------------------------------------------------
// processHistoryForPositionChanges — new-day pre-market (snapshot pre-sealed).
// Snapshot is pre-populated with current history before processHistory is called,
// so old items are treated as already-seen and never re-open stale positions.
// ---------------------------------------------------------------------------
section('processHistoryForPositionChanges — new-day pre-market (snapshot sealed)');

test('sealed: stale CE entry in history → CE stays closed', () => {
  // Simulates: monitor sealed snapshot after new-day reset (pre-market).
  // History has only yesterday's CE entry (exit never fired).
  const staleItems = [{ name: CE_ENTRY, symbol: '' }];
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: staleItems.slice(0, 30) };
  processHistoryForPositionChanges(staleItems, s); // same items = nothing new at top
  return s.CE === 'closed' && s.PE === 'closed';
});
test('sealed: stale PE entry in history → PE stays closed', () => {
  const staleItems = [{ name: PE_ENTRY, symbol: '' }];
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: staleItems.slice(0, 30) };
  processHistoryForPositionChanges(staleItems, s);
  return s.PE === 'closed';
});
test('sealed: new CE entry fires today → CE opens via diff-based detection', () => {
  // Snapshot was sealed with yesterday's items. A new CE entry appears at top today.
  const yesterday = [{ name: 'someOtherAlert', symbol: '' }];
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: yesterday.slice(0, 30) };
  const todayHistory = [{ name: CE_ENTRY, symbol: '' }, ...yesterday];
  processHistoryForPositionChanges(todayHistory, s);
  return s.CE === 'open';
});
test('sealed: new CE exit fires today → CE closes', () => {
  const yesterday = [{ name: 'someOtherAlert', symbol: '' }];
  const s = { CE: 'open', PE: 'closed', lastLogSnapshot: yesterday.slice(0, 30) };
  const todayHistory = [{ name: CE_EXIT, symbol: '' }, ...yesterday];
  processHistoryForPositionChanges(todayHistory, s);
  return s.CE === 'closed';
});
test('sealed: snapshot updates to include new top item', () => {
  const yesterday = [{ name: 'base', symbol: '' }];
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: yesterday.slice(0, 30) };
  const todayHistory = [{ name: CE_ENTRY, symbol: '' }, ...yesterday];
  processHistoryForPositionChanges(todayHistory, s);
  return s.lastLogSnapshot[0].name === CE_ENTRY;
});

// ---------------------------------------------------------------------------
// processHistoryForPositionChanges — same-day restart (snapshot from prior tick).
// Only items newer than the last snapshot top are processed.
// ---------------------------------------------------------------------------
section('processHistoryForPositionChanges — same-day restart (diff-based)');

test('diff: item already in snapshot top → not reprocessed', () => {
  const existing = [{ name: CE_ENTRY, symbol: '' }];
  const s = { CE: 'open', PE: 'closed', lastLogSnapshot: existing };
  processHistoryForPositionChanges(existing, s); // same list, nothing new
  return s.CE === 'open'; // stays open, CE exit not fired
});
test('diff: new exit appears above snapshot boundary → CE closes', () => {
  const existing = [{ name: CE_ENTRY, symbol: '' }];
  const s = { CE: 'open', PE: 'closed', lastLogSnapshot: existing };
  const newHistory = [{ name: CE_EXIT, symbol: '' }, ...existing];
  processHistoryForPositionChanges(newHistory, s);
  return s.CE === 'closed';
});
test('diff: new PE entry appears above boundary → PE opens', () => {
  const existing = [{ name: 'other', symbol: '' }];
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: existing };
  const newHistory = [{ name: PE_ENTRY, symbol: '' }, ...existing];
  processHistoryForPositionChanges(newHistory, s);
  return s.PE === 'open';
});
test('diff: boundary item not found (log rolled) → processes top 5 only', () => {
  // Previous snapshot top item is gone from history (TV log rolled over)
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: [{ name: 'gone', symbol: '' }] };
  const newHistory = Array.from({ length: 10 }, (_, i) => ({ name: `item${i}`, symbol: '' }));
  newHistory.unshift({ name: CE_ENTRY, symbol: '' }); // CE entry is in top 5
  processHistoryForPositionChanges(newHistory, s);
  return s.CE === 'open'; // item in top 5 → processed
});
test('diff: boundary item not found, CE entry at index 6 → not processed', () => {
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: [{ name: 'gone', symbol: '' }] };
  // CE entry at position 6 (beyond top-5 fallback window)
  const newHistory = [
    { name: 'item0', symbol: '' },
    { name: 'item1', symbol: '' },
    { name: 'item2', symbol: '' },
    { name: 'item3', symbol: '' },
    { name: 'item4', symbol: '' },
    { name: CE_ENTRY, symbol: '' }, // index 5 — outside top-5
  ];
  processHistoryForPositionChanges(newHistory, s);
  return s.CE === 'closed';
});

// ---------------------------------------------------------------------------
// Market-hours restart: early history read re-derives CE/PE before first tick.
// Simulates: loadState() loaded stale state, CDP connects, history is read
// immediately via processHistoryForPositionChanges (fresh-start scan).
// ---------------------------------------------------------------------------
section('market-hours restart — early history read re-derives position');

test('market restart: stale PE=open corrected to closed when exit is newest history item', () => {
  const s = { CE: 'closed', PE: 'open', lastLogSnapshot: [] };
  const history = [
    { name: PE_EXIT, symbol: '' },
    { name: PE_ENTRY, symbol: '' },
  ];
  processHistoryForPositionChanges(history, s);
  return s.PE === 'closed';
});

test('market restart: stale CE=open corrected to closed when exit is newest history item', () => {
  const s = { CE: 'open', PE: 'closed', lastLogSnapshot: [] };
  const history = [
    { name: CE_EXIT, symbol: '' },
    { name: CE_ENTRY, symbol: '' },
  ];
  processHistoryForPositionChanges(history, s);
  return s.CE === 'closed';
});

test('market restart: CE=open preserved when entry is newest (trade still running)', () => {
  const s = { CE: 'closed', PE: 'closed', lastLogSnapshot: [] };
  const history = [{ name: CE_ENTRY, symbol: '' }];
  processHistoryForPositionChanges(history, s);
  return s.CE === 'open';
});

test('market restart: both sides re-derived correctly from mixed history', () => {
  // CE exited, PE still open
  const s = { CE: 'open', PE: 'closed', lastLogSnapshot: [] };
  const history = [
    { name: PE_ENTRY, symbol: '' },
    { name: CE_EXIT, symbol: '' },
    { name: CE_ENTRY, symbol: '' },
  ];
  processHistoryForPositionChanges(history, s);
  return s.CE === 'closed' && s.PE === 'open';
});

test('market restart: empty history leaves state unchanged', () => {
  const s = { CE: 'open', PE: 'open', lastLogSnapshot: [] };
  processHistoryForPositionChanges([], s);
  return s.CE === 'open' && s.PE === 'open';
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
