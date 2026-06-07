#!/usr/bin/env node
/**
 * Unit tests for generate-daily-report.js pure functions
 * and supertrend-reports.html client-side logic (inlined).
 *
 * No TradingView or CDP connection required.
 * Usage: node tests/test-reports.js
 */

import {
  dateToISTRange,
  istTimeToUnix,
  findPrice,
  computeExitValues,
  parseRaw,
  classify,
  parseTrades,
} from '../scripts/generate-daily-report.js';

// ---------------------------------------------------------------------------
// Minimal test runner (same style as test-monitor.js)
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

console.log('\n=== generate-daily-report.js unit tests ===');

// ---------------------------------------------------------------------------
// dateToISTRange
// ---------------------------------------------------------------------------
section('dateToISTRange');
test('from = 09:00 IST = UTC 03:30', () => {
  const { from } = dateToISTRange('2026-06-05');
  const d = new Date(from * 1000);
  return d.getUTCHours() === 3 && d.getUTCMinutes() === 30;
});
test('to = 16:00 IST = UTC 10:30', () => {
  const { to } = dateToISTRange('2026-06-05');
  const d = new Date(to * 1000);
  return d.getUTCHours() === 10 && d.getUTCMinutes() === 30;
});
test('range spans correct date', () => {
  const { from } = dateToISTRange('2026-06-05');
  const d = new Date(from * 1000);
  return d.getUTCFullYear() === 2026 && d.getUTCMonth() === 5 && d.getUTCDate() === 5;
});
test('from < to', () => {
  const { from, to } = dateToISTRange('2026-06-05');
  return from < to;
});
test('window is 7 hours (25200s)', () => {
  const { from, to } = dateToISTRange('2026-06-05');
  return to - from === 7 * 3600;
});

// ---------------------------------------------------------------------------
// istTimeToUnix
// ---------------------------------------------------------------------------
section('istTimeToUnix');
test('09:15:00 IST on 2026-06-05 → UTC 03:45', () => {
  const unix = istTimeToUnix('09:15:00', '2026-06-05');
  const d = new Date(unix * 1000);
  return d.getUTCHours() === 3 && d.getUTCMinutes() === 45 && d.getUTCSeconds() === 0;
});
test('15:30:00 IST → UTC 10:00', () => {
  const unix = istTimeToUnix('15:30:00', '2026-06-05');
  const d = new Date(unix * 1000);
  return d.getUTCHours() === 10 && d.getUTCMinutes() === 0;
});
test('12:00:00 IST → UTC 06:30 same day', () => {
  const unix = istTimeToUnix('12:00:00', '2026-06-05');
  const d = new Date(unix * 1000);
  return d.getUTCHours() === 6 && d.getUTCMinutes() === 30 && d.getUTCDate() === 5;
});
test('seconds preserved', () => {
  const unix = istTimeToUnix('10:30:45', '2026-06-05');
  return new Date(unix * 1000).getUTCSeconds() === 45;
});

// ---------------------------------------------------------------------------
// findPrice
// ---------------------------------------------------------------------------
section('findPrice — exact bar match');
// Alert fires at bar close (bar.time = alertUnix - 60)
test('finds bar whose time = alertUnix - 60', () => {
  const alertUnix = 1000000;
  const bars = [{ time: alertUnix - 60, close: '123.45' }];
  return findPrice(bars, alertUnix) === 123.45;
});
test('accepts bar within ±90s tolerance', () => {
  const alertUnix = 1000000;
  const bars = [{ time: alertUnix - 90, close: '99.00' }];
  return findPrice(bars, alertUnix) === 99.0;
});
test('rejects bar more than 90s from target (alertUnix-60)', () => {
  // target = alertUnix - 60; bar must be within ±90 of target
  // bar at alertUnix - 151 → diff = |alertUnix-151 - (alertUnix-60)| = 91 > 90 → rejected
  const alertUnix = 1000000;
  const bars = [{ time: alertUnix - 151, close: '99.00' }];
  return findPrice(bars, alertUnix) === null;
});
test('picks closest bar when multiple candidates', () => {
  const alertUnix = 1000000;
  const bars = [
    { time: alertUnix - 80, close: '10.00' },
    { time: alertUnix - 60, close: '20.00' }, // closest
    { time: alertUnix - 50, close: '30.00' },
  ];
  return findPrice(bars, alertUnix) === 20.0;
});
test('returns null for empty bars', () => findPrice([], 1000000) === null);
test('returns null for null bars', () => findPrice(null, 1000000) === null);

// ---------------------------------------------------------------------------
// computeExitValues — NIFTY (SL=15, TARGET_G=50, TARGET_L=31)
// ---------------------------------------------------------------------------
section('computeExitValues — null inputs');
test('null entry → all null except exitNSL', () => {
  const r = computeExitValues('NIFTY', null, 200);
  return r.exitSL === null && r.tgtPts === null && r.exitNSL === 200;
});
test('null exit → all null', () => {
  const r = computeExitValues('NIFTY', 200, null);
  return r.exitSL === null && r.tgtPts === null && r.exitNSL === null;
});

section('computeExitValues — no trade bars (simple clamp)');
test('profit < TARGET_G: exitSL clamped to exitRaw', () => {
  // entry=200, exit=220 (profit=20), TARGET_G=50 → exitSL = 220 (within range)
  const { exitSL } = computeExitValues('NIFTY', 200, 220, []);
  return exitSL === 220;
});
test('profit > TARGET_G: exitSL capped at entry+50', () => {
  const { exitSL } = computeExitValues('NIFTY', 200, 260, []);
  return exitSL === 250;
});
test('loss < SL: exitSL clamped to exitRaw', () => {
  // entry=200, exit=190 (loss=10 < SL=15) → exitSL = 190
  const { exitSL } = computeExitValues('NIFTY', 200, 190, []);
  return exitSL === 190;
});
test('loss > SL: exitSL floored at entry-15', () => {
  // entry=200, exit=180 (loss=20 > SL=15) → exitSL = 185
  const { exitSL } = computeExitValues('NIFTY', 200, 180, []);
  return exitSL === 185;
});
test('exitNSL always equals raw exit', () => {
  const { exitNSL } = computeExitValues('NIFTY', 200, 175, []);
  return exitNSL === 175;
});
test('tgtPts = exitSL - entry when no target hit', () => {
  // entry=200, exit=210, exitSL=210, tgtPts=10
  const { tgtPts } = computeExitValues('NIFTY', 200, 210, []);
  return tgtPts === 10;
});
test('tgtPts clamped to -SL when big loss', () => {
  const { tgtPts } = computeExitValues('NIFTY', 200, 150, []);
  return tgtPts === -15;
});
test('exitTgt = entry + TARGET_L always (fixed target exit)', () => {
  const { exitTgt } = computeExitValues('NIFTY', 200, 210, []);
  return exitTgt === 231; // 200 + 31
});
test('exitTgt fixed even when actual exit was a loss', () => {
  const { exitTgt } = computeExitValues('NIFTY', 200, 190, []);
  return exitTgt === 231; // still 200 + 31, not 190
});

section('computeExitValues — intraday bar scan');
test('bar high hits TARGET_G → exitSL = entry+50', () => {
  const bars = [{ high: 251 }]; // 200+50=250 → bar.high=251 >= 250
  const { exitSL } = computeExitValues('NIFTY', 200, 210, bars);
  return exitSL === 250;
});
test('bar high hits TARGET_L → tgtPts = 31', () => {
  const bars = [{ high: 232 }]; // 200+31=231 → bar.high=232 >= 231
  const { tgtPts } = computeExitValues('NIFTY', 200, 220, bars);
  return tgtPts === 31;
});
test('bar high just below TARGET_L → tgtPts not credited', () => {
  const bars = [{ high: 230 }]; // 200+31=231, bar.high=230 < 231
  const { tgtPts } = computeExitValues('NIFTY', 200, 210, bars);
  return tgtPts === 10; // exitSL-entry = 210-200
});
test('TARGET_G scan: first bar touching triggers, subsequent bars ignored', () => {
  const bars = [{ high: 255 }, { high: 270 }];
  const { exitSL } = computeExitValues('NIFTY', 200, 220, bars);
  return exitSL === 250; // capped at entry+50
});

section('computeExitValues — SENSEX (SL=35, TARGET_G=100, TARGET_L=70)');
test('SENSEX loss > 35 → exitSL = entry-35', () => {
  const { exitSL } = computeExitValues('SENSEX', 500, 440, []);
  return exitSL === 465;
});
test('SENSEX profit > 100 → exitSL = entry+100', () => {
  const { exitSL } = computeExitValues('SENSEX', 500, 620, []);
  return exitSL === 600;
});
test('SENSEX bar hits TARGET_L=70 → tgtPts=70', () => {
  const bars = [{ high: 571 }]; // 500+70=570 → bar.high=571 >= 570
  const { tgtPts } = computeExitValues('SENSEX', 500, 540, bars);
  return tgtPts === 70;
});

// ---------------------------------------------------------------------------
// auto-classification of notes (maxReach + autoNotes logic, inlined)
// ---------------------------------------------------------------------------
section('auto-classification: notes');
const SL_INLINE = { NIFTY: 15, SENSEX: 35 };
const REACH_THRESHOLD = 20; // same constant as in generate-daily-report.js

function autoNotes(instrument, entryPrice, exitPrice, maxReach = 0) {
  if (entryPrice === null || exitPrice === null) return '';
  const slPts = SL_INLINE[instrument] || 15;
  if (entryPrice - exitPrice >= slPts) return 'SL HIT';
  if (maxReach >= REACH_THRESHOLD) return `price reach upto ${maxReach} points`;
  if (exitPrice < entryPrice) return 'PINE SCRIPT SL';
  return '';
}

test('loss = exactly SL → SL HIT', () => autoNotes('NIFTY', 200, 185, 0) === 'SL HIT');
test('loss > SL → SL HIT', () => autoNotes('NIFTY', 200, 180, 0) === 'SL HIT');
test('SL HIT wins even when reach >= 20', () => autoNotes('NIFTY', 200, 184, 25) === 'SL HIT');
test('reach >= 20 + small loss → price reach upto X', () =>
  autoNotes('NIFTY', 200, 196, 42) === 'price reach upto 42 points');
test('reach >= 20 + profit → price reach upto X', () =>
  autoNotes('NIFTY', 200, 215, 25) === 'price reach upto 25 points');
test('reach = exactly 20 → price reach upto X', () =>
  autoNotes('NIFTY', 200, 198, 20) === 'price reach upto 20 points');
test('reach < 20 + small loss → PINE SCRIPT SL', () =>
  autoNotes('NIFTY', 200, 190, 10) === 'PINE SCRIPT SL');
test('profit + reach < 20 → empty', () => autoNotes('NIFTY', 200, 210, 5) === '');
test('null entry → empty', () => autoNotes('NIFTY', null, 200, 30) === '');
test('SENSEX SL threshold = 35', () => autoNotes('SENSEX', 500, 465, 0) === 'SL HIT');
test('SENSEX reach >= 20 → price reach note', () =>
  autoNotes('SENSEX', 500, 495, 22) === 'price reach upto 22 points');
test('exit == entry + no reach → empty (break-even)', () => autoNotes('NIFTY', 200, 200, 0) === '');

// ---------------------------------------------------------------------------
// auto-classification: maxReach
// ---------------------------------------------------------------------------
section('auto-classification: maxReach');
function calcMaxReach(entryPrice, tradeBars) {
  if (!tradeBars.length || entryPrice === null) return 0;
  return parseFloat(
    Math.max(0, ...tradeBars.map((b) => parseFloat(b.high) - entryPrice)).toFixed(2)
  );
}

test('single bar above entry → correct reach', () => calcMaxReach(200, [{ high: 225 }]) === 25);
test('multiple bars → uses highest high', () =>
  calcMaxReach(200, [{ high: 210 }, { high: 230 }, { high: 215 }]) === 30);
test('all bars below entry → 0 (no negative reach)', () =>
  calcMaxReach(200, [{ high: 195 }, { high: 190 }]) === 0);
test('empty bars → 0', () => calcMaxReach(200, []) === 0);
test('null entry → 0', () => calcMaxReach(null, [{ high: 220 }]) === 0);
test('reach rounded to 2 decimal places', () => calcMaxReach(200, [{ high: 200.333 }]) === 0.33);

// ---------------------------------------------------------------------------
// parseRaw
// ---------------------------------------------------------------------------
section('parseRaw — alert log raw text parsing');
const RAW_SAMPLE = 'niftySupertrendLongEntry\nNIFTY260609C23400, 1m\n09:15:00\nWebhook message';

test('extracts symbol correctly', () => parseRaw(RAW_SAMPLE).symbol === 'NIFTY260609C23400');
test('extracts time correctly', () => parseRaw(RAW_SAMPLE).time === '09:15:00');
test('symbol stripped of exchange prefix', () => {
  const raw = 'alertName\nNSE:NIFTY, 1m\n10:30:00\n';
  return parseRaw(raw).symbol === 'NSE:NIFTY'; // keeps as-is, split on comma
});
test('handles missing lines gracefully', () => {
  const r = parseRaw('alertName');
  return r.symbol === '' && r.time === '';
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------
section('classify — alert name → instrument/side/event');
test('niftySupertrendLongEntry  → NIFTY CE entry', () => {
  const r = classify('niftySupertrendLongEntry');
  return r.instrument === 'NIFTY' && r.side === 'CE' && r.event === 'entry';
});
test('niftySupertrendLongExit   → NIFTY CE exit', () => {
  const r = classify('niftySupertrendLongExit');
  return r.instrument === 'NIFTY' && r.side === 'CE' && r.event === 'exit';
});
test('niftySupertrendShortEntry → NIFTY PE entry', () => {
  const r = classify('niftySupertrendShortEntry');
  return r.instrument === 'NIFTY' && r.side === 'PE' && r.event === 'entry';
});
test('niftySupertrendShortExit  → NIFTY PE exit', () => {
  const r = classify('niftySupertrendShortExit');
  return r.instrument === 'NIFTY' && r.side === 'PE' && r.event === 'exit';
});
test('sensexSupertrendLongEntry → SENSEX CE entry', () => {
  const r = classify('sensexSupertrendLongEntry');
  return r.instrument === 'SENSEX' && r.side === 'CE' && r.event === 'entry';
});
test('sensexSupertrendShortExit → SENSEX PE exit', () => {
  const r = classify('sensexSupertrendShortExit');
  return r.instrument === 'SENSEX' && r.side === 'PE' && r.event === 'exit';
});
test('unknown name → null', () => classify('unknownAlert') === null);
test('empty string → null', () => classify('') === null);

// ---------------------------------------------------------------------------
// parseTrades — alert history → trade pairs
// ---------------------------------------------------------------------------
section('parseTrades — CE trade pair');
function makeItem(name, symbol, time) {
  return { name, raw: `${name}\n${symbol}, 1m\n${time}\n` };
}

const CE_ENTRY = 'niftySupertrendLongEntry';
const CE_EXIT = 'niftySupertrendLongExit';
const PE_ENTRY = 'niftySupertrendShortEntry';
const PE_EXIT = 'niftySupertrendShortExit';

test('single CE entry+exit → one trade', () => {
  // snapshot is newest-first (as it comes from TV alert log)
  const snap = [
    makeItem(CE_EXIT, 'NIFTY260609C23400', '10:30:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  const trades = parseTrades(snap);
  return trades.length === 1;
});
test('CE trade has correct instrument and side', () => {
  const snap = [
    makeItem(CE_EXIT, 'NIFTY260609C23400', '10:30:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  const t = parseTrades(snap)[0];
  return t.instrument === 'NIFTY' && t.side === 'CE';
});
test('CE trade entrySymbol and exitSymbol correct', () => {
  const snap = [
    makeItem(CE_EXIT, 'NIFTY260609C23450', '10:30:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  const t = parseTrades(snap)[0];
  return t.entrySymbol === 'NIFTY260609C23400' && t.exitSymbol === 'NIFTY260609C23450';
});
test('CE trade entryTime and exitTime correct', () => {
  const snap = [
    makeItem(CE_EXIT, 'NIFTY260609C23400', '10:30:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  const t = parseTrades(snap)[0];
  return t.entryTime === '09:15:00' && t.exitTime === '10:30:00';
});

section('parseTrades — PE trade pair');
test('single PE entry+exit → one trade', () => {
  const snap = [
    makeItem(PE_EXIT, 'NIFTY260609P23500', '11:00:00'),
    makeItem(PE_ENTRY, 'NIFTY260609P23500', '10:00:00'),
  ];
  return parseTrades(snap).length === 1 && parseTrades(snap)[0].side === 'PE';
});

section('parseTrades — multiple trades');
test('two CE trades → two records', () => {
  const snap = [
    makeItem(CE_EXIT, 'NIFTY260609C23400', '14:00:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '13:00:00'),
    makeItem(CE_EXIT, 'NIFTY260609C23400', '11:00:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  return parseTrades(snap).length === 2;
});
test('CE + PE simultaneously → two trades', () => {
  const snap = [
    makeItem(PE_EXIT, 'NIFTY260609P23500', '11:00:00'),
    makeItem(CE_EXIT, 'NIFTY260609C23400', '11:00:00'),
    makeItem(PE_ENTRY, 'NIFTY260609P23500', '09:20:00'),
    makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00'),
  ];
  const trades = parseTrades(snap);
  return (
    trades.length === 2 &&
    trades.some((t) => t.side === 'CE') &&
    trades.some((t) => t.side === 'PE')
  );
});
test('exit without matching entry → ignored', () => {
  const snap = [makeItem(CE_EXIT, 'NIFTY260609C23400', '10:00:00')];
  return parseTrades(snap).length === 0;
});
test('entry without matching exit → not included as trade', () => {
  const snap = [makeItem(CE_ENTRY, 'NIFTY260609C23400', '09:15:00')];
  return parseTrades(snap).length === 0;
});
test('SENSEX trade pair classified correctly', () => {
  const snap = [
    makeItem('sensexSupertrendLongExit', 'BSX260606C79000', '11:00:00'),
    makeItem('sensexSupertrendLongEntry', 'BSX260606C79000', '09:30:00'),
  ];
  const t = parseTrades(snap)[0];
  return t.instrument === 'SENSEX' && t.lotSize === 20;
});

// ---------------------------------------------------------------------------
// Client-side logic (inlined from supertrend-reports.html)
// ---------------------------------------------------------------------------
console.log('\n=== supertrend-reports.html client logic (inlined) ===');

// -- tradeInAnyRange --
function tradeInAnyRange(entryTime, ranges) {
  if (!ranges || ranges.length === 0) return true;
  const t = (entryTime || '').slice(0, 5);
  if (!t) return true;
  return ranges.some(({ from, to }) => {
    if (!from && !to) return true;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });
}

section('tradeInAnyRange');
test('no ranges → always true', () => tradeInAnyRange('09:30', []) === true);
test('null ranges → always true', () => tradeInAnyRange('09:30', null) === true);
test('in range → true', () => tradeInAnyRange('10:00', [{ from: '09:15', to: '11:00' }]) === true);
test('before from → false', () =>
  tradeInAnyRange('09:00', [{ from: '09:15', to: '11:00' }]) === false);
test('after to → false', () =>
  tradeInAnyRange('12:00', [{ from: '09:15', to: '11:00' }]) === false);
test('on from boundary → true', () =>
  tradeInAnyRange('09:15', [{ from: '09:15', to: '11:00' }]) === true);
test('on to boundary → true', () =>
  tradeInAnyRange('11:00', [{ from: '09:15', to: '11:00' }]) === true);
test('matches second of two ranges', () =>
  tradeInAnyRange('14:30', [
    { from: '09:15', to: '11:00' },
    { from: '14:00', to: '15:30' },
  ]) === true);
test('matches neither range → false', () =>
  tradeInAnyRange('12:00', [
    { from: '09:15', to: '11:00' },
    { from: '14:00', to: '15:30' },
  ]) === false);
test('missing entryTime → true', () =>
  tradeInAnyRange('', [{ from: '09:15', to: '11:00' }]) === true);
test('only from set, time >= from → true', () =>
  tradeInAnyRange('10:00', [{ from: '09:15', to: '' }]) === true);
test('only from set, time < from → false', () =>
  tradeInAnyRange('09:00', [{ from: '09:15', to: '' }]) === false);
test('only to set, time <= to → true', () =>
  tradeInAnyRange('09:30', [{ from: '', to: '10:00' }]) === true);

// -- getEffectiveMaxReach --
function getEffectiveMaxReach(t) {
  if (t.maxReach !== undefined && t.maxReach !== null) return t.maxReach;
  const m = (t.notes || '').match(/reach\s+(?:up\s*to\s+)?(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

section('getEffectiveMaxReach');
test('numeric maxReach field → returned directly', () =>
  getEffectiveMaxReach({ maxReach: 42 }) === 42);
test('maxReach=0 → 0 (not falsy-skipped)', () => getEffectiveMaxReach({ maxReach: 0 }) === 0);
test('maxReach missing → parse from notes text', () =>
  getEffectiveMaxReach({ notes: 'price reach upto 100 points' }) === 100);
test('reach without upto → also parsed', () =>
  getEffectiveMaxReach({ notes: 'price reach 55 points' }) === 55);
test('decimal reach value parsed', () => getEffectiveMaxReach({ notes: 'reach 31.5' }) === 31.5);
test('no reach in notes → 0', () => getEffectiveMaxReach({ notes: 'SL HIT' }) === 0);
test('maxReach=null → falls through to notes', () =>
  getEffectiveMaxReach({ maxReach: null, notes: 'price reach upto 77 points' }) === 77);
test('no notes, no maxReach → 0', () => getEffectiveMaxReach({}) === 0);
test('auto-generated decimal format "upto 42.00" → 42', () =>
  getEffectiveMaxReach({ notes: 'price reach upto 42.00 points' }) === 42);

// -- notesClass --
function notesClass(notes) {
  if (!notes) return '';
  const n = notes.toUpperCase();
  if (n.includes('PINE SCRIPT')) return 'pine-sl';
  if (n.includes('SL HIT')) return 'sl-hit';
  return '';
}

section('notesClass');
test('"SL HIT" → sl-hit', () => notesClass('SL HIT') === 'sl-hit');
test('"sl hit" lowercase → sl-hit', () => notesClass('sl hit') === 'sl-hit');
test('"PINE SCRIPT SL" → pine-sl', () => notesClass('PINE SCRIPT SL') === 'pine-sl');
test('"Pine Script SL Hit" → pine-sl', () => notesClass('Pine Script SL Hit') === 'pine-sl');
test('"PINE SCRIPT SL HIT" → pine-sl (PINE first)', () =>
  notesClass('PINE SCRIPT SL HIT') === 'pine-sl');
test('empty string → empty', () => notesClass('') === '');
test('null → empty', () => notesClass(null) === '');
test('unrecognized text → empty', () => notesClass('took profit') === '');
test('"price reach upto 42 points" → empty (not SL type)', () =>
  notesClass('price reach upto 42 points') === '');

// -- tradePassesFilters (standalone, no global state needed) --
function tradePassesFilters_test(t, ranges, noteFilter, minReach) {
  if (!tradeInAnyRange(t.entryTime || t.time, ranges)) return false;
  const anyNoteChecked = noteFilter.slHit || noteFilter.pineSL;
  if (anyNoteChecked) {
    const n = (t.notes || '').toUpperCase();
    const pass =
      (noteFilter.slHit && n.includes('SL HIT') && !n.includes('PINE SCRIPT')) ||
      (noteFilter.pineSL && n.includes('PINE SCRIPT'));
    if (!pass) return false;
  }
  if (minReach !== null && minReach !== undefined && minReach > 0) {
    if (getEffectiveMaxReach(t) < minReach) return false;
  }
  return true;
}

const NO_FILTER = { slHit: false, pineSL: false };

section('tradePassesFilters — time range');
test('no ranges → passes', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '' }, [], NO_FILTER, null) === true);
test('in range → passes', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: '' },
    [{ from: '09:15', to: '11:00' }],
    NO_FILTER,
    null
  ) === true);
test('outside range → blocked', () =>
  tradePassesFilters_test(
    { entryTime: '08:00', notes: '' },
    [{ from: '09:15', to: '11:00' }],
    NO_FILTER,
    null
  ) === false);

section('tradePassesFilters — notes filter');
test('slHit=true, trade has SL HIT → passes', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'SL HIT' },
    [],
    { slHit: true, pineSL: false },
    null
  ) === true);
test('slHit=true, trade has PINE SCRIPT SL HIT → blocked (pine takes precedence)', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'PINE SCRIPT SL HIT' },
    [],
    { slHit: true, pineSL: false },
    null
  ) === false);
test('pineSL=true, trade has Pine Script SL Hit → passes', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'Pine Script SL Hit' },
    [],
    { slHit: false, pineSL: true },
    null
  ) === true);
test('pineSL=true, trade has plain SL HIT → blocked', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'SL HIT' },
    [],
    { slHit: false, pineSL: true },
    null
  ) === false);
test('both false, no notes → passes', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '' }, [], NO_FILTER, null) === true);
test('both true, trade profit (no notes) → blocked', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: '' },
    [],
    { slHit: true, pineSL: true },
    null
  ) === false);
test('slHit=true, trade has "price reach upto X" → blocked (not SL HIT)', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'price reach upto 42 points' },
    [],
    { slHit: true, pineSL: false },
    null
  ) === false);
test('pineSL=true, trade has "price reach upto X" → blocked (not PINE SCRIPT)', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'price reach upto 42 points' },
    [],
    { slHit: false, pineSL: true },
    null
  ) === false);
test('both false + "price reach upto X" notes → passes (no filter active)', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'price reach upto 42 points' },
    [],
    NO_FILTER,
    null
  ) === true);

section('tradePassesFilters — reach filter');
test('reach >= min → passes', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '', maxReach: 25 }, [], NO_FILTER, 20) ===
  true);
test('reach < min → blocked', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '', maxReach: 15 }, [], NO_FILTER, 20) ===
  false);
test('reach = min exactly → passes', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '', maxReach: 20 }, [], NO_FILTER, 20) ===
  true);
test('minReach=0 → not filtered', () =>
  tradePassesFilters_test({ entryTime: '10:00', notes: '', maxReach: 0 }, [], NO_FILTER, 0) ===
  true);
test('reach in old notes text → parsed and compared', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'price reach upto 30 points' },
    [],
    NO_FILTER,
    25
  ) === true);

section('tradePassesFilters — combined (AND logic)');
test('in range + SL HIT + reach OK → passes', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'SL HIT', maxReach: 10 },
    [{ from: '09:15', to: '11:00' }],
    { slHit: true, pineSL: false },
    5
  ) === true);
test('in range + SL HIT + reach too low → blocked', () =>
  tradePassesFilters_test(
    { entryTime: '10:00', notes: 'SL HIT', maxReach: 3 },
    [{ from: '09:15', to: '11:00' }],
    { slHit: true, pineSL: false },
    5
  ) === false);
test('out of range despite matching notes → blocked', () =>
  tradePassesFilters_test(
    { entryTime: '12:00', notes: 'SL HIT', maxReach: 20 },
    [{ from: '09:15', to: '11:00' }],
    { slHit: true, pineSL: false },
    5
  ) === false);

// -- recalcEditRow logic (clamp computations) --
const SL_PTS = { NIFTY: 15, SENSEX: 35 };
const TGT_G = { NIFTY: 50, SENSEX: 100 };
const TGT_L = { NIFTY: 31, SENSEX: 70 };
const LOT_SIZES = { NIFTY: 65, SENSEX: 20 };

function recalc(instr, entry, exitNSL, lots) {
  const slPts = SL_PTS[instr] || 15;
  const tgG = TGT_G[instr] || 50;
  const tgL = TGT_L[instr] || 31;
  const lotSz = LOT_SIZES[instr] || 65;
  const exitSL = parseFloat(Math.max(entry - slPts, Math.min(entry + tgG, exitNSL)).toFixed(2));
  const tgtPts = parseFloat(Math.max(-slPts, Math.min(tgL, exitNSL - entry)).toFixed(2));
  const exitTgt = parseFloat((entry + tgL).toFixed(2));
  const pSL = Math.round((exitSL - entry) * lots * lotSz);
  const pTgt = Math.round(tgL * lots * lotSz);
  const pNSL = Math.round((exitNSL - entry) * lots * lotSz);
  return { exitSL, tgtPts, exitTgt, pSL, pTgt, pNSL };
}

section('recalcEditRow — exit clamp (NIFTY)');
test('profit within range → exitSL = exitNSL', () => recalc('NIFTY', 200, 220, 10).exitSL === 220);
test('profit > TARGET_G → exitSL capped', () => recalc('NIFTY', 200, 260, 10).exitSL === 250);
test('loss within SL → exitSL = exitNSL', () => recalc('NIFTY', 200, 190, 10).exitSL === 190);
test('loss > SL → exitSL floored', () => recalc('NIFTY', 200, 180, 10).exitSL === 185);

section('recalcEditRow — tgtPts and exitTgt');
test('tgtPts = exitNSL - entry for small profit', () =>
  recalc('NIFTY', 200, 210, 10).tgtPts === 10);
test('tgtPts capped at TARGET_L=31', () => recalc('NIFTY', 200, 240, 10).tgtPts === 31);
test('tgtPts capped at -SL=-15 for big loss', () => recalc('NIFTY', 200, 170, 10).tgtPts === -15);
test('exitTgt = entry + TARGET_L always', () => recalc('NIFTY', 200, 210, 10).exitTgt === 231);
test('exitTgt fixed even on a loss trade', () => recalc('NIFTY', 200, 185, 10).exitTgt === 231);
test('pTgt = TARGET_L * lots * lotSize always', () =>
  recalc('NIFTY', 200, 210, 10).pTgt === 31 * 10 * 65); // 20150
test('SENSEX pTgt = 70 * 15 * 20 = 21000', () =>
  recalc('SENSEX', 500, 540, 15).pTgt === 70 * 15 * 20);

section('recalcEditRow — P&L computation');
test('profit 10pts, 10 lots, 65 lotSize → pNSL = +6500', () =>
  recalc('NIFTY', 200, 210, 10).pNSL === 6500);
test('loss 10pts → pNSL = -6500', () => recalc('NIFTY', 200, 190, 10).pNSL === -6500);
test('pSL uses clamped exit, not raw', () =>
  recalc('NIFTY', 200, 180, 10).pSL === Math.round((185 - 200) * 10 * 65)); // floor at 185
test('SENSEX 70pt gain, 15 lots, 20 lotSize → pNSL = +21000', () =>
  recalc('SENSEX', 500, 570, 15).pNSL === 21000);

// ---------------------------------------------------------------------------
// entry time sort (renderDay behaviour)
// ---------------------------------------------------------------------------
section('entry time sort');
function sortTrades(trades) {
  return [...trades].sort((a, b) =>
    (a.entryTime || a.time || '').localeCompare(b.entryTime || b.time || '')
  );
}

test('unsorted trades sorted by entryTime', () => {
  const trades = [{ entryTime: '14:00' }, { entryTime: '09:15' }, { entryTime: '11:30' }];
  const sorted = sortTrades(trades);
  return (
    sorted[0].entryTime === '09:15' &&
    sorted[1].entryTime === '11:30' &&
    sorted[2].entryTime === '14:00'
  );
});
test('already sorted → unchanged', () => {
  const trades = [{ entryTime: '09:00' }, { entryTime: '10:00' }];
  const sorted = sortTrades(trades);
  return sorted[0].entryTime === '09:00';
});
test('falls back to .time field', () => {
  const trades = [{ time: '15:00' }, { time: '08:00' }];
  const sorted = sortTrades(trades);
  return sorted[0].time === '08:00';
});
test('same entryTime → stable (order preserved)', () => {
  const trades = [
    { entryTime: '10:00', id: 1 },
    { entryTime: '10:00', id: 2 },
  ];
  const sorted = sortTrades(trades);
  return sorted[0].id === 1 && sorted[1].id === 2;
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log('\n' + '─'.repeat(50));
console.log(
  `Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m  (${total} total)\n`
);
process.exit(fail > 0 ? 1 : 0);
