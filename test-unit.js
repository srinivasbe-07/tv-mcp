#!/usr/bin/env node
/**
 * Unit tests for monitor.js pure logic.
 * No TradingView or CDP connection required.
 * Usage: node test-unit.js
 */

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Inline the monitor's pure functions (no imports needed)
// ---------------------------------------------------------------------------
const STRIKE_INTERVAL = 50;
const ITM_DEPTH = 2;

function calcATM(spot) {
  return Math.round(spot / STRIKE_INTERVAL) * STRIKE_INTERVAL;
}

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function buildSymbol(strike, type, expiryDate) {
  const d = expiryDate;
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `NIFTY${yy}${mm}${dd}${type === 'CE' ? 'C' : 'P'}${strike}`;
}

function getNextTuesdayFrom(date) {
  const day = date.getUTCDay();
  const daysUntil = (2 - day + 7) % 7;
  const expiry = new Date(date);
  expiry.setUTCDate(date.getUTCDate() + daysUntil);
  return expiry;
}

// Holiday-aware expiry: if Tuesday is a holiday, walk back to previous trading day
function getExpiryDateFrom(date, holidays = new Set()) {
  const day = date.getUTCDay();
  const daysUntil = (2 - day + 7) % 7;
  const tuesday = new Date(date);
  tuesday.setUTCDate(date.getUTCDate() + daysUntil);

  let expiry = new Date(tuesday);
  while (holidays.has(toDateStr(expiry)) || expiry.getUTCDay() === 0 || expiry.getUTCDay() === 6) {
    expiry.setUTCDate(expiry.getUTCDate() - 1);
  }
  return expiry;
}

function isMarketHoursAt(istHour, istMin, weekday) {
  // weekday: 0=Sun 1=Mon ... 6=Sat
  if (weekday === 0 || weekday === 6) return false;
  const min = istHour * 60 + istMin;
  return min >= 9 * 60 + 15 && min <= 15 * 60 + 30;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n=== monitor.js unit tests ===\n');

// --- calcATM ---
console.log('calcATM:');
assert('24049.9 rounds to 24050', calcATM(24049.9) === 24050, `got ${calcATM(24049.9)}`);
assert('24024   rounds to 24000', calcATM(24024)   === 24000, `got ${calcATM(24024)}`);
assert('24026   rounds to 24050', calcATM(24026)   === 24050, `got ${calcATM(24026)}`);
assert('23975   rounds to 24000', calcATM(23975)   === 24000, `got ${calcATM(23975)}`);
assert('23950   stays at 23950',  calcATM(23950)   === 23950, `got ${calcATM(23950)}`);

// --- ITM-2 strike derivation ---
console.log('\nITM-2 strikes:');
const atm = calcATM(24049.9); // 24050
const ceStrike = atm - ITM_DEPTH * STRIKE_INTERVAL;
const peStrike = atm + ITM_DEPTH * STRIKE_INTERVAL;
assert('CE strike = ATM - 100 = 23950', ceStrike === 23950, `got ${ceStrike}`);
assert('PE strike = ATM + 100 = 24150', peStrike === 24150, `got ${peStrike}`);

// --- buildSymbol ---
console.log('\nbuildSymbol:');
const tuesday = new Date(Date.UTC(2026, 4, 26)); // May 26 2026 = Tuesday
assert(
  'CE symbol format correct',
  buildSymbol(23950, 'CE', tuesday) === 'NIFTY260526C23950',
  `got ${buildSymbol(23950, 'CE', tuesday)}`
);
assert(
  'PE symbol format correct',
  buildSymbol(24150, 'PE', tuesday) === 'NIFTY260526P24150',
  `got ${buildSymbol(24150, 'PE', tuesday)}`
);
assert(
  'CE uses C not CE',
  buildSymbol(23950, 'CE', tuesday).includes('C23950') && !buildSymbol(23950, 'CE', tuesday).includes('CE'),
  buildSymbol(23950, 'CE', tuesday)
);
assert(
  'PE uses P not PE',
  buildSymbol(24150, 'PE', tuesday).includes('P24150') && !buildSymbol(24150, 'PE', tuesday).includes('PE'),
  buildSymbol(24150, 'PE', tuesday)
);

// --- getNextTuesdayFrom ---
console.log('\ngetNextTuesdayFrom:');
const monday    = new Date(Date.UTC(2026, 4, 25)); // Monday May 25
const tuesdayD  = new Date(Date.UTC(2026, 4, 26)); // Tuesday May 26
const wednesday = new Date(Date.UTC(2026, 4, 27)); // Wednesday May 27
const sunday    = new Date(Date.UTC(2026, 4, 24)); // Sunday May 24

const fromMon = getNextTuesdayFrom(monday);
const fromTue = getNextTuesdayFrom(tuesdayD);
const fromWed = getNextTuesdayFrom(wednesday);
const fromSun = getNextTuesdayFrom(sunday);

assert('Monday   → next Tuesday (May 26)', fromMon.getUTCDate() === 26, `got ${fromMon.toUTCString()}`);
assert('Tuesday  → same day (May 26)',     fromTue.getUTCDate() === 26, `got ${fromTue.toUTCString()}`);
assert('Wednesday→ next Tuesday (Jun 2)',  fromWed.getUTCDate() === 2,  `got ${fromWed.toUTCString()}`);
assert('Sunday   → next Tuesday (May 26)', fromSun.getUTCDate() === 26, `got ${fromSun.toUTCString()}`);

// --- isMarketHours ---
console.log('\nisMarketHours:');
assert('09:15 Mon = open',        isMarketHoursAt(9,  15, 1) === true);
assert('09:14 Mon = not open',    isMarketHoursAt(9,  14, 1) === false);
assert('15:30 Mon = open',        isMarketHoursAt(15, 30, 1) === true);
assert('15:31 Mon = closed',      isMarketHoursAt(15, 31, 1) === false);
assert('12:00 Mon = open',        isMarketHoursAt(12, 0,  1) === true);
assert('12:00 Sat = closed',      isMarketHoursAt(12, 0,  6) === false);
assert('12:00 Sun = closed',      isMarketHoursAt(12, 0,  0) === false);
assert('09:15 Fri = open',        isMarketHoursAt(9,  15, 5) === true);

// --- 2026 NSE holiday list (official) ---
const NSE_2026 = new Set([
  '2026-01-15','2026-01-26','2026-03-03','2026-03-26','2026-03-31',
  '2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26',
  '2026-09-14','2026-10-02','2026-10-20','2026-11-10','2026-11-24',
  '2026-12-25',
]);

// --- Holiday-aware expiry ---
console.log('\ngetExpiryDateFrom (holiday handling):');

// Tuesday Apr 14 2026 is a holiday (Dr. Ambedkar Jayanti) — should use Monday Apr 13
const monApr13  = new Date(Date.UTC(2026, 3, 13)); // Mon Apr 13
const tueApr14  = new Date(Date.UTC(2026, 3, 14)); // Tue Apr 14 — HOLIDAY
const holidays  = new Set(['2026-04-14']);

const fromMonHoliday = getExpiryDateFrom(monApr13, holidays);
assert(
  'Mon Apr 13 + holiday Tue Apr 14 → expiry is Mon Apr 13',
  fromMonHoliday.getUTCDate() === 13,
  `got ${toDateStr(fromMonHoliday)}`
);

// Normal Tuesday (no holiday) — expiry stays on Tuesday
const monMay25 = new Date(Date.UTC(2026, 4, 25)); // Mon May 25
const fromMonNormal = getExpiryDateFrom(monMay25, new Set());
assert(
  'Mon May 25 + no holiday → expiry is Tue May 26',
  fromMonNormal.getUTCDate() === 26,
  `got ${toDateStr(fromMonNormal)}`
);

// Both Tuesday AND Monday are holidays — should fall back to Friday
const monHol    = new Date(Date.UTC(2026, 5, 1));  // Mon Jun 1
const doubleHol = new Set(['2026-06-01', '2026-06-02']); // Mon + Tue both holidays
const fromDouble = getExpiryDateFrom(monHol, doubleHol);
assert(
  'Mon Jun 1 + Mon+Tue holidays → expiry falls back to Fri May 29',
  fromDouble.getUTCDate() === 29 && fromDouble.getUTCDay() === 5,
  `got ${toDateStr(fromDouble)} day=${fromDouble.getUTCDay()}`
);

// 2026 actual Tuesday holidays — all should shift to Monday
const tueTuesdayHolidays = [
  { mon: [2026,2,2],  tue: [2026,2,3],  label: 'Mar 3 Holi → Mon Mar 2',          expectDate: 2  },
  { mon: [2026,2,30], tue: [2026,2,31], label: 'Mar 31 Mahavir → Mon Mar 30',      expectDate: 30 },
  { mon: [2026,3,13], tue: [2026,3,14], label: 'Apr 14 Ambedkar → Mon Apr 13',     expectDate: 13 },
  { mon: [2026,9,19], tue: [2026,9,20], label: 'Oct 20 Dussehra → Mon Oct 19',     expectDate: 19 },
  { mon: [2026,10,9], tue: [2026,10,10],label: 'Nov 10 Diwali → Mon Nov 9',        expectDate: 9  },
  { mon: [2026,10,23],tue: [2026,10,24],label: 'Nov 24 Gurpurb → Mon Nov 23',      expectDate: 23 },
];
for (const { mon, label, expectDate } of tueTuesdayHolidays) {
  const monDate = new Date(Date.UTC(mon[0], mon[1], mon[2]));
  const result  = getExpiryDateFrom(monDate, NSE_2026);
  assert(label, result.getUTCDate() === expectDate, `got ${toDateStr(result)}`);
}

// Non-Tuesday holidays should NOT affect expiry
assert(
  'Jan 15 (Thu) holiday does not affect Tue Jan 20 expiry',
  getExpiryDateFrom(new Date(Date.UTC(2026,0,19)), NSE_2026).getUTCDate() === 20,
  `got ${toDateStr(getExpiryDateFrom(new Date(Date.UTC(2026,0,19)), NSE_2026))}`
);

// Wednesday — next Tuesday has no holiday
const wedMay27   = new Date(Date.UTC(2026, 4, 27)); // Wed May 27
const fromWedHol = getExpiryDateFrom(wedMay27, new Set());
assert(
  'Wed May 27 + no holiday → expiry is Tue Jun 2',
  fromWedHol.getUTCDate() === 2 && fromWedHol.getUTCMonth() === 5,
  `got ${toDateStr(fromWedHol)}`
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${'─'.repeat(45)}`);
console.log(
  `Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m | ${total} total`
);
if (failed === 0) console.log('\x1b[32mAll unit tests pass.\x1b[0m');
console.log('');
process.exit(failed > 0 ? 1 : 0);
