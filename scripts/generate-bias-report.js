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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export { classify, parseTrades, parseOpenTrades, ALERT_NAMES as BIAS_REPORT_ALERTS };

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

// Bias alert names — up = CE side (0 prefix), down = PE side (z prefix).
const ALERT_NAMES = {
  NIFTY: {
    CE: { entry: '0NiftyBiasEntry', exit: '0NiftyBiasExit', target: '0NiftyBiasTarget' },
    PE: { entry: 'zNiftyBiasEntry', exit: 'zNiftyBiasExit', target: 'zNiftyBiasTarget' },
  },
  SENSEX: {
    CE: { entry: '0SensexBiasEntry', exit: '0SensexBiasExit', target: '0SensexBiasTarget' },
    PE: { entry: 'zSensexBiasEntry', exit: 'zSensexBiasExit', target: 'zSensexBiasTarget' },
  },
};

const EXCHANGE = { NIFTY: 'NSE', SENSEX: 'BSE' };
const LOT_SIZES = { NIFTY: 65, SENSEX: 20 };
const LOTS = { NIFTY: 10, SENSEX: 15 };
const SL = { NIFTY: 15, SENSEX: 35 }; // initial stop-loss (points)
// Exit w/SL is a stepped trailing stop: for every TRAIL_STEP points of favourable
// movement, the stop ratchets up to TRAIL_GAP points behind that milestone.
const TRAIL_STEP = { NIFTY: 10, SENSEX: 22 };
const TRAIL_GAP = { NIFTY: 12, SENSEX: 25 };
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
//  • Exit w/SL  — stepped trailing stop. Initial stop = entry − SL. Each time the
//    running high clears another TRAIL_STEP-point milestone above entry, the stop
//    ratchets up to (milestone − TRAIL_GAP); it never moves down. The trade exits
//    at the stop if a bar's low breaches it, otherwise at the actual exit price.
//  • Exit w/Tgt — fixed bracket: target hit intraday → +TARGET_L; else the actual
//    exit clamped to [−SL, +TARGET_L].
// tradeBars must be chronological (oldest → newest) and carry high/low/close.
export function computeExitValues(instrument, entry, exitRaw, tradeBars = []) {
  if (entry === null || exitRaw === null) {
    return { exitSL: null, exitTgt: null, exitNSL: exitRaw, tgtPts: null };
  }
  const sl = SL[instrument] ?? 15;
  const step = TRAIL_STEP[instrument] ?? 10;
  const gap = TRAIL_GAP[instrument] ?? 12;
  const tgL = TARGET_L[instrument] ?? 31;

  // ── Exit w/SL: stepped trailing stop ──
  let stop = entry - sl;
  let maxHigh = entry;
  let exitSLPrice = exitRaw;
  let stopped = false;
  for (const bar of tradeBars) {
    // The stop reflects highs seen on prior bars — check this bar's low against it first.
    if (bar.low <= stop) {
      exitSLPrice = stop;
      stopped = true;
      break;
    }
    if (bar.high > maxHigh) maxHigh = bar.high;
    const steps = Math.floor((maxHigh - entry) / step);
    if (steps >= 1) {
      const newStop = entry + steps * step - gap;
      if (newStop > stop) stop = newStop;
    }
  }
  // Never stopped out → exit at the actual price, but never worse than the locked stop.
  if (!stopped && exitRaw < stop) exitSLPrice = stop;

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
    exitSL: parseFloat(exitSLPrice.toFixed(2)),
    exitTgt: exitTgtPrice,
    exitNSL: parseFloat(exitRaw.toFixed(2)),
    tgtPts,
  };
}

function parseRaw(raw) {
  const lines = raw.split('\n');
  const symbol = (lines[1] || '').split(',')[0].trim();
  const time = (lines[2] || '').trim();
  return { symbol, time };
}

// Classify a bias alert → { instrument, side (CE/PE), event (entry|exit|target) }
function classify(alertName) {
  for (const [instr, sides] of Object.entries(ALERT_NAMES)) {
    for (const [side, roles] of Object.entries(sides)) {
      if (alertName === roles.entry) return { instrument: instr, side, event: 'entry' };
      if (alertName === roles.exit) return { instrument: instr, side, event: 'exit' };
      if (alertName === roles.target) return { instrument: instr, side, event: 'target' };
    }
  }
  return null;
}

// Pair bias entry → (exit OR target). exitType records which one closed it.
function parseTrades(snapshot, instrFilter = null) {
  const items = [...snapshot].reverse(); // oldest → newest
  const trades = [];
  const pending = {};
  let idSeq = 1;

  for (const item of items) {
    const meta = classify(item.name);
    if (!meta) continue;
    if (instrFilter && meta.instrument !== instrFilter) continue;
    const { symbol, time } = parseRaw(item.raw);
    const { instrument, side, event } = meta;

    if (event === 'entry') {
      pending[side] = { instrument, symbol, entryTime: time };
    } else if ((event === 'exit' || event === 'target') && pending[side]) {
      trades.push({
        id: idSeq++,
        instrument,
        side,
        entrySymbol: pending[side].symbol,
        exitSymbol: symbol,
        entryTime: pending[side].entryTime,
        exitTime: time,
        exitType: event, // 'exit' (SL/signal) or 'target'
        lots: LOTS[instrument],
        lotSize: LOT_SIZES[instrument],
        entryPrice: null,
        exitPrice: null,
      });
      pending[side] = null;
    }
  }
  return trades;
}

function parseOpenTrades(snapshot, startId = 1, instrFilter = null) {
  const items = [...snapshot].reverse();
  const pending = {};
  for (const item of items) {
    const meta = classify(item.name);
    if (!meta) continue;
    if (instrFilter && meta.instrument !== instrFilter) continue;
    const { symbol, time } = parseRaw(item.raw);
    const { instrument, side, event } = meta;
    if (event === 'entry') pending[side] = { instrument, symbol, entryTime: time };
    else if (event === 'exit' || event === 'target') pending[side] = null;
  }
  const EOD_EXIT = '15:26:00';
  let idSeq = startId;
  return Object.entries(pending)
    .filter(([, v]) => v)
    .map(([side, info]) => ({
      id: idSeq++,
      instrument: info.instrument,
      side,
      entrySymbol: info.symbol,
      exitSymbol: info.symbol,
      entryTime: info.entryTime,
      exitTime: EOD_EXIT,
      exitType: 'eod',
      lots: LOTS[info.instrument],
      lotSize: LOT_SIZES[info.instrument],
      entryPrice: null,
      exitPrice: null,
    }));
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
  const instrFilter = position.shared?.lastInstrument || position.lastInstrument || 'NIFTY';

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

  // The monitor only writes logSnapshot to position.json during live market-hours
  // ticks. When the market is off (weekend / holiday / after close) it's empty —
  // read the Alerts Log tab live from TradingView instead. Gated on isMarketOff()
  // so we never switch the Log tab while the monitor is actively trading.
  if (snapshot.length === 0 && isMarketOff()) {
    console.log('position.json has no alert snapshot — reading Alerts Log tab live...');
    try {
      snapshot = await readLiveAlertLog(cdp);
      console.log(`  read ${snapshot.length} alert log item(s) live`);
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

  const trades = parseTrades(snapshot, instrFilter);
  const openTrades = parseOpenTrades(snapshot, trades.length + 1, instrFilter);
  const allTrades = [...trades, ...openTrades];

  if (allTrades.length === 0) {
    console.log('No bias trade pairs found in the alert snapshot');
    await cdp.disconnect();
    process.exit(0);
  }
  console.log(`Bias trades found: ${allTrades.length}`);
  for (const t of allTrades)
    console.log(`  ${t.side} ${t.entrySymbol}  ${t.entryTime} → ${t.exitTime} (${t.exitType})`);

  const symWindows = {};
  for (const t of allTrades) {
    const entryUnix = istTimeToUnix(t.entryTime, today);
    const exitUnix = istTimeToUnix(t.exitTime, today);
    for (const sym of [t.entrySymbol, t.exitSymbol]) {
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
    const exitUnix = istTimeToUnix(t.exitTime, today);
    t.entryPrice = findPrice(barsCache[t.entrySymbol], entryUnix);
    t.exitPrice = findPrice(barsCache[t.exitSymbol], exitUnix);

    const tradeBars = (barsCache[t.entrySymbol] || [])
      .filter((b) => b.time >= entryUnix - 60 && b.time <= exitUnix)
      .sort((a, b) => a.time - b.time);

    const derived = computeExitValues(t.instrument, t.entryPrice, t.exitPrice, tradeBars);
    t.exitSL = derived.exitSL;
    t.exitTgt = derived.exitTgt;
    t.exitNSL = derived.exitNSL;
    t.tgtPts = derived.tgtPts;

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

  await cdp.disconnect();

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const output = { date: today, instrument: instrFilter, strategy: 'bias', trades: allTrades };
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
