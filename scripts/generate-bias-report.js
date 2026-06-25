#!/usr/bin/env node
/**
 * Post-market report generator for BIAS trades.
 *
 * Mirrors generate-daily-report.js (supertrend) but parses the manual-bias
 * alerts: entry → (exit OR target) pairs, mapping up→CE and down→PE.
 * Writes logs/bias/1min/daily-trades-YYYY-MM-DD.json in the SAME schema
 * as the supertrend report, so the reports UI can render it identically.
 *
 * Usage:
 *   node scripts/generate-bias-report.js
 *   node scripts/generate-bias-report.js 2026-06-07   ← specific date
 *
 * Requires TradingView running with CDP on port 9222. Run after market close.
 */

import { CDPManager } from '../src/cdp.js';
import { ChartTools } from '../src/tools/chart.js';
import { isMarketOff, readLiveAlertLog, lastTradingDay } from './read-live-log.js';
import { fetchVixForDate, formatVixNote } from './fetch-vix.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export {
  classify,
  parseTrades,
  instrumentForDate,
  isNonTradingDay,
  ALERT_NAMES as BIAS_REPORT_ALERTS,
};

function checkMarketClosed() {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = istNow.getUTCDay();
  const hhmm = istNow.getUTCHours() * 100 + istNow.getUTCMinutes();
  if (day === 0 || day === 6) {
    console.log('Weekend — no market today. Run for a past date:');
    console.log('  node scripts/generate-bias-report.js 2026-06-06');
    process.exit(0);
  }
  if (hhmm < 1530) {
    const remaining = 1530 - hhmm;
    const h = Math.floor(remaining / 100);
    const m = remaining % 100;
    console.error(
      `Market is still open. Run after 3:30 PM IST (${h > 0 ? `${h}h ${m}m` : `${m}m`} remaining).`
    );
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs', 'bias', '1min');
const POSITION_FILE = path.join(ROOT, 'config', 'position.json');
const SUPERTREND_TAB = path.join(ROOT, 'logs', 'supertrend-tab.json');

// Bias alert names — 6 SHARED alerts reused for both NIFTY and SENSEX
// (up = CE side, 0 prefix; down = PE side, z prefix). Because the names no
// longer carry the instrument, the report decides NIFTY vs SENSEX from the
// report DATE via the day-of-week rule (instrumentForDate below).
const ALERT_NAMES = {
  CE: { entry: '0BiasEntry', exit: '0BiasExit', target: '0BiasTarget' },
  PE: { entry: 'zBiasEntry', exit: 'zBiasExit', target: 'zBiasTarget' },
};

// Day-of-week instrument routing (matches the monitor): Mon/Tue/Fri → NIFTY,
// Wed/Thu → SENSEX. The monitor's routing is purely weekday-based — holidays
// only shift expiry, never which index trades on a weekday — so this matches it.
const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
function instrumentForDate(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return DAY_INSTRUMENT[day] || 'NIFTY';
}

// Reuse config/holidays.json (the same file the monitor uses) to flag a report
// date that isn't a trading session. Read from ROOT so it works regardless of cwd.
const HOLIDAYS_FILE = path.join(ROOT, 'config', 'holidays.json');
function loadHolidays() {
  try {
    return new Set(JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8')).holidays || []);
  } catch {
    return new Set();
  }
}
// True when the date is a weekend or an NSE holiday → no trading session that day.
function isNonTradingDay(dateStr, holidays = loadHolidays()) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 || holidays.has(dateStr);
}

const EXCHANGE = { NIFTY: 'NSE', SENSEX: 'BSE' };
const LOT_SIZES = { NIFTY: 65, SENSEX: 20 };
const LOTS = { NIFTY: 10, SENSEX: 15 };
const SL = { NIFTY: 15, SENSEX: 35 }; // initial stop-loss (points)
// Exit w/SL is a stepped trailing stop: the stop starts at entry−SL and, for every
// TRAIL_STEP points of favourable movement, RISES by TRAIL_RISE points (cumulative).
// So after n steps the stop sits at  entry − SL + n·TRAIL_RISE.
// e.g. NIFTY:  −15, −3, 9, 21, 33, …   (move 0, 10, 20, 30, 40, …)
//      SENSEX: −35, −10, 15, 40, 65, … (move 0, 22, 44, 66, 88, …)
// Because TRAIL_RISE > TRAIL_STEP, the stop accelerates and eventually overtakes
// the move (locking in more than the latest milestone) — this is intended.
const TRAIL_STEP = { NIFTY: 10, SENSEX: 22 };
const TRAIL_RISE = { NIFTY: 12, SENSEX: 25 };
const TARGET_L = { NIFTY: 31, SENSEX: 35 }; // Exit w/Tgt fixed target (points)

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function scrollChartToRange(cdp, fromUnix, toUnix) {
  const result = await cdp.executeScript(`
    (function() {
      try {
        const model = window.TradingViewApi
          ?._activeChartWidgetWV?._value
          ?._chartWidget?._modelWV?._value;
        const ts = model?.timeScale?.();
        if (ts?.setVisibleRange) { ts.setVisibleRange({ from: ${fromUnix}, to: ${toUnix} }); return 'ok-model'; }
        const cw = window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget;
        if (cw?.setVisibleRange) { cw.setVisibleRange({ from: ${fromUnix}, to: ${toUnix} }); return 'ok-widget'; }
        return 'no-api';
      } catch(e) { return 'err: ' + e.message; }
    })()
  `);
  return result?.result?.value ?? result;
}

// Bias exit model:
//  • SL Target / Exit w/SL — a pure stepped trailing stop. The stop level is set
//    by how far price ran in the trade's favour (the running high, "maxReach"):
//    steps = floor(maxReach / TRAIL_STEP), and the locked level (slTarget, in
//    points) = −SL + steps·TRAIL_RISE — the schedule −15, −3, 9, 21 … for NIFTY.
//    Exit w/SL price = entry + slTarget. The actual signal/exit price does NOT
//    affect this (it lives in the Manual Exit column); the trade is modelled as
//    always exiting at the ratcheted trailing stop for the peak it reached.
//  • Exit w/Tgt — fixed bracket: target hit intraday → +TARGET_L; else the actual
//    exit clamped to [−SL, +TARGET_L].
// tradeBars must be chronological (oldest → newest) and carry high/low/close.
export function computeExitValues(instrument, entry, exitRaw, tradeBars = []) {
  if (entry === null || exitRaw === null) {
    return { exitSL: null, exitTgt: null, exitNSL: exitRaw, tgtPts: null, slTarget: null };
  }
  const sl = SL[instrument] ?? 15;
  const step = TRAIL_STEP[instrument] ?? 10;
  const rise = TRAIL_RISE[instrument] ?? 12;
  const tgL = TARGET_L[instrument] ?? 31;

  // ── SL Target + Exit w/SL: trailing-stop level for the peak reached ──
  let maxHigh = entry;
  for (const bar of tradeBars) if (bar.high > maxHigh) maxHigh = bar.high;
  const steps = Math.max(0, Math.floor((maxHigh - entry) / step));
  const slTarget = parseFloat((-sl + steps * rise).toFixed(2)); // locked level, points
  const exitSLPrice = parseFloat((entry + slTarget).toFixed(2));

  // ── Exit w/Tgt: fixed SL/target bracket ──
  let tgtHit = false;
  for (const bar of tradeBars) {
    if (bar.high >= entry + tgL) {
      tgtHit = true;
      break;
    }
  }
  const tgtPts = tgtHit ? tgL : parseFloat(clamp(exitRaw - entry, -sl, tgL).toFixed(2));
  const exitTgtPrice = parseFloat((entry + tgL).toFixed(2));

  return {
    exitSL: exitSLPrice,
    exitTgt: exitTgtPrice,
    exitNSL: parseFloat(exitRaw.toFixed(2)),
    tgtPts,
    slTarget,
  };
}

function parseRaw(raw) {
  const lines = raw.split('\n');
  const symbol = (lines[1] || '').split(',')[0].trim();
  const time = (lines[2] || '').trim();
  return { symbol, time };
}

// Classify a bias alert → { side (CE/PE), event (entry|exit|target) }
// Names are shared across instruments, so the instrument is NOT derived here —
// it comes from the report date (instrumentForDate) and is attached in parseTrades.
function classify(alertName) {
  for (const [side, roles] of Object.entries(ALERT_NAMES)) {
    if (alertName === roles.entry) return { side, event: 'entry' };
    if (alertName === roles.exit) return { side, event: 'exit' };
    if (alertName === roles.target) return { side, event: 'target' };
  }
  return null;
}

// Pair bias entry → (exit OR target). One trade per ENTRY fire.
//
// Behaviour (per CE/PE side, which fire independently):
//   - Every entry produces a trade row.
//   - Its close is the matching exit/target that fires AFTER it and BEFORE the
//     next entry of the same side.
//   - If several exits/targets fire in that window, keep the LATEST one and
//     ignore the rest.
//   - If NO exit/target fires before the next entry, the row is left with a
//     blank exit (exitTime '', exitType 'manual') so it can be filled in by hand.
//   - Closes that appear before any entry (e.g. yesterday's dangling exit) are
//     skipped — there is no open entry to attach them to.
function parseTrades(snapshot, instrument = 'NIFTY') {
  const items = [...snapshot].reverse(); // oldest → newest

  // Split into per-side sequences — an exit/target only closes an entry of the
  // same side (0/up → CE, z/down → PE). The instrument is shared across all
  // fires of the day and supplied by the caller (day-of-week rule).
  const bySide = { CE: [], PE: [] };
  for (const item of items) {
    const meta = classify(item.name);
    if (!meta) continue;
    const { symbol, time } = parseRaw(item.raw);
    bySide[meta.side].push({ ...meta, instrument, symbol, time });
  }

  const trades = [];
  for (const side of ['CE', 'PE']) {
    const seq = bySide[side];
    let i = 0;
    while (i < seq.length) {
      if (seq[i].event !== 'entry') {
        i++; // close with no preceding open entry → skip
        continue;
      }
      const entry = seq[i];
      // Walk forward to the next entry, keeping the LATEST close seen on the way.
      let j = i + 1;
      let close = null;
      while (j < seq.length && seq[j].event !== 'entry') {
        close = seq[j]; // overwrite → ends on the latest exit/target before next entry
        j++;
      }
      trades.push({
        id: 0, // assigned after chronological sort below
        instrument: entry.instrument,
        side,
        entrySymbol: entry.symbol,
        exitSymbol: close ? close.symbol : entry.symbol,
        entryTime: entry.time,
        exitTime: close ? close.time : '', // blank → fill manually
        exitType: close ? close.event : 'manual', // 'exit' | 'target' | 'manual'
        lots: LOTS[entry.instrument],
        lotSize: LOT_SIZES[entry.instrument],
        entryPrice: null,
        exitPrice: null,
      });
      i = j; // continue from the next entry
    }
  }

  // Interleave CE/PE chronologically by entry time, then number sequentially.
  trades.sort((a, b) => a.entryTime.localeCompare(b.entryTime));
  trades.forEach((t, k) => (t.id = k + 1));
  return trades;
}

function istTimeToUnix(timeStr, dateStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const utcMinutes = h * 60 + m - 330;
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCHours(Math.floor(utcMinutes / 60), utcMinutes % 60, s || 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function findPrice(bars, alertUnix) {
  if (!bars || bars.length === 0) return null;
  const target = alertUnix - 60;
  let best = null,
    bestDiff = Infinity;
  for (const bar of bars) {
    const diff = Math.abs(bar.time - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = bar;
    }
  }
  return bestDiff <= 90 ? parseFloat(best.close) : null;
}

async function fetchBarsForSymbol(cdp, cdpChart, qualifiedSymbol, fromUnix, toUnix) {
  await cdpChart.handle('chart_set_symbol', { symbol: qualifiedSymbol });
  await new Promise((r) => setTimeout(r, 3000));
  await cdpChart.handle('chart_set_timeframe', { timeframe: '1' });
  await new Promise((r) => setTimeout(r, 2000));
  const padded = { from: fromUnix - 1800, to: toUnix + 1800 };
  let scrollResult = await scrollChartToRange(cdp, padded.from, padded.to);
  console.log(`  scroll to trade window: ${scrollResult}`);
  let bars = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await cdpChart.handle('data_get_ohlcv', { summary: false, limit: 2000 });
    const data = JSON.parse(result?.content?.[0]?.text || '{}');
    bars = data.bars || [];
    const windowBars = bars.filter((b) => b.time >= fromUnix - 120 && b.time <= toUnix + 60);
    if (windowBars.length > 0) {
      console.log(
        `  ${bars.length} bars loaded (${windowBars.length} in window) on attempt ${attempt}`
      );
      return bars;
    }
    console.log(`  attempt ${attempt}: 0 bars in window, retrying…`);
    await scrollChartToRange(cdp, padded.from, padded.to);
  }
  console.warn(`  WARNING: no bars in trade window after 10 attempts`);
  return bars;
}

async function main() {
  const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  // Default to the last completed trading session, not the calendar date — the
  // alert log has no date, so a report run after close / weekend / holiday must
  // be dated to the session the fires belong to (e.g. Sat run → Fri's trades).
  const today = dateArg || lastTradingDay();
  console.log(`Generating BIAS report for: ${today}\n`);

  const position = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
  // The supertrend logSnapshot is the full Alerts Log tab — it contains bias fires too.
  let snapshot = position.supertrend?.logSnapshot || position.lastLogSnapshot || [];
  // Bias alerts are shared across instruments, so the instrument comes from the
  // report DATE via the day-of-week rule (Mon/Tue/Fri → NIFTY, Wed/Thu → SENSEX).
  const instrFilter = instrumentForDate(today);
  console.log(`Instrument for ${today} (day rule): ${instrFilter}`);
  if (isNonTradingDay(today)) {
    console.warn(
      `⚠ ${today} is a weekend or NSE holiday (config/holidays.json) — not a trading session; the report may be empty.`
    );
  }

  // Connect to TradingView first — needed both for the live-log fallback below
  // and for fetching option bars later.
  let tabId = null;
  try {
    tabId = JSON.parse(fs.readFileSync(SUPERTREND_TAB, 'utf8')).targetId;
  } catch {
    /**/
  }
  const cdp = new CDPManager(tabId);
  try {
    await cdp.connect();
    console.log('CDP connected');
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }
  const cdpChart = new ChartTools(cdp);

  // The monitor only stores the most-recent 30 fires in position.json (enough for
  // its per-tick position diffing). That truncates an active day — and since bias
  // and supertrend share one Log tab, the morning's trades fall off the snapshot.
  // So when the market is off (weekend / holiday / after close) read the FULL Log
  // tab live and use it whenever it captured more fires than the stored snapshot.
  // Gated on isMarketOff() so we never switch the Log tab while the monitor trades.
  if (isMarketOff()) {
    const reason =
      snapshot.length === 0
        ? 'position.json has no alert snapshot'
        : `position.json snapshot is capped at ${snapshot.length} items`;
    console.log(`${reason} — reading full Alerts Log tab live...`);
    try {
      const live = await readLiveAlertLog(cdp);
      console.log(`  read ${live.length} alert log item(s) live`);
      if (live.length > snapshot.length) snapshot = live;
    } catch (e) {
      console.error('  live alert log read failed:', e.message);
    }
  }
  if (snapshot.length === 0) {
    console.error(
      'No alert snapshot to parse — position.json is empty and no live log was available.'
    );
    await cdp.disconnect();
    process.exit(1);
  }

  const allTrades = parseTrades(snapshot, instrFilter);

  if (allTrades.length === 0) {
    console.log('No bias trade pairs found in the alert snapshot');
    await cdp.disconnect();
    process.exit(0);
  }
  console.log(`Bias trades found: ${allTrades.length}`);
  for (const t of allTrades)
    console.log(
      `  ${t.side} ${t.entrySymbol}  ${t.entryTime} → ${t.exitTime || '(manual)'} (${t.exitType})`
    );

  // Build per-symbol fetch windows. Entry-only trades (blank exit) contribute
  // just their entry time — the exit half is filled in manually later.
  const symWindows = {};
  for (const t of allTrades) {
    const entryUnix = istTimeToUnix(t.entryTime, today);
    const hasExit = !!t.exitTime;
    const exitUnix = hasExit ? istTimeToUnix(t.exitTime, today) : entryUnix;
    const syms = hasExit ? [t.entrySymbol, t.exitSymbol] : [t.entrySymbol];
    for (const sym of syms) {
      if (!symWindows[sym]) symWindows[sym] = { from: entryUnix - 120, to: exitUnix };
      else {
        symWindows[sym].from = Math.min(symWindows[sym].from, entryUnix - 120);
        symWindows[sym].to = Math.max(symWindows[sym].to, exitUnix);
      }
    }
  }

  const allSymbols = [...new Set(allTrades.flatMap((t) => [t.entrySymbol, t.exitSymbol]))];
  const barsCache = {};
  for (const sym of allSymbols) {
    const instrument = sym.startsWith('BSX') ? 'SENSEX' : 'NIFTY';
    const qualified = `${EXCHANGE[instrument]}:${sym}`;
    const { from, to } = symWindows[sym];
    console.log(`\nFetching 1m bars for ${qualified}...`);
    barsCache[sym] = await fetchBarsForSymbol(cdp, cdpChart, qualified, from, to);
  }

  console.log('\nPrice lookup:');
  for (const t of allTrades) {
    const entryUnix = istTimeToUnix(t.entryTime, today);
    t.entryPrice = findPrice(barsCache[t.entrySymbol], entryUnix);

    // Entry-only trade (no exit/target fired) → fill entry price, leave the exit
    // side blank for manual entry. exitType 'manual' flags it in the report.
    if (!t.exitTime) {
      t.exitPrice = null;
      t.exitSL = null;
      t.exitTgt = null;
      t.exitNSL = null;
      t.tgtPts = null;
      t.slTarget = null;
      t.maxReach = 0;
      t.notes = '';
      const ep0 = t.entryPrice?.toFixed(2) ?? 'NOT FOUND';
      console.log(`  ${t.side} ${t.entrySymbol}  entry=${ep0}  exit=(manual)`);
      continue;
    }

    const exitUnix = istTimeToUnix(t.exitTime, today);
    t.exitPrice = findPrice(barsCache[t.exitSymbol], exitUnix);

    const tradeBars = (barsCache[t.entrySymbol] || [])
      .filter((b) => b.time >= entryUnix - 60 && b.time <= exitUnix)
      .sort((a, b) => a.time - b.time);

    const derived = computeExitValues(t.instrument, t.entryPrice, t.exitPrice, tradeBars);
    t.exitSL = derived.exitSL;
    t.exitTgt = derived.exitTgt;
    t.exitNSL = derived.exitNSL;
    t.tgtPts = derived.tgtPts;
    t.slTarget = derived.slTarget; // locked trailing-stop level (points) → Exit w/SL = entry + slTarget

    t.maxReach =
      tradeBars.length > 0 && t.entryPrice !== null
        ? parseFloat(
            Math.max(0, ...tradeBars.map((b) => parseFloat(b.high) - t.entryPrice)).toFixed(2)
          )
        : 0;

    const REACH_THRESHOLD = 20;
    let autoNotes = '';
    if (t.entryPrice !== null && t.exitPrice !== null) {
      const slPts = SL[t.instrument] || 15;
      if (t.exitType === 'target') autoNotes = 'TARGET HIT';
      else if (t.maxReach >= REACH_THRESHOLD) autoNotes = `price reach upto ${t.maxReach} points`;
      else if (t.entryPrice - t.exitPrice >= slPts) autoNotes = 'SL HIT';
      else if (t.exitPrice < t.entryPrice) autoNotes = 'EXIT SIGNAL';
    }
    t.notes = autoNotes;

    const ep = t.entryPrice?.toFixed(2) ?? 'NOT FOUND';
    const xp = t.exitPrice?.toFixed(2) ?? 'NOT FOUND';
    console.log(
      `  ${t.side} ${t.entrySymbol}  entry=${ep}  exit=${xp}  tgtPts=${t.tgtPts ?? 'N/A'}  notes=${t.notes || '—'}`
    );
  }

  // Open the India VIX chart and record the day's OHLC into the day note (the
  // reports parse/filter VIX from this). Best-effort — failure leaves note blank.
  let vixNote = '';
  console.log('\nFetching India VIX (NSE:INDIAVIX) daily OHLC...');
  const vix = await fetchVixForDate(cdp, cdpChart, today);
  if (vix) {
    vixNote = formatVixNote(vix);
    console.log(`  ${vixNote}`);
  } else {
    console.warn('  could not read India VIX — leaving VIX note blank');
  }

  await cdp.disconnect();

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const output = {
    date: today,
    instrument: instrFilter,
    strategy: 'bias',
    trades: allTrades,
    note: vixNote,
  };
  const outFile = path.join(LOGS_DIR, `daily-trades-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved → ${outFile}`);
}

// Only auto-run when invoked directly, not when imported for tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Allow --skip-market-check for off-hours testing
  if (!process.argv.includes('--skip-market-check')) checkMarketClosed();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
