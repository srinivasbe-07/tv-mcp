#!/usr/bin/env node
/**
 * Post-market report generator for Supertrend trades.
 *
 * Parses today's CE/PE entry+exit pairs from config/position.json,
 * fetches 1m OHLCV for each option symbol from TradingView,
 * looks up the close price at the alert fire time,
 * and writes logs/daily-trades-YYYY-MM-DD.json.
 *
 * Usage:
 *   node scripts/generate-daily-report.js
 *   node scripts/generate-daily-report.js 2026-06-07   ← specific date
 *
 * Requires TradingView running with CDP on port 9222.
 * Run after market close (3:30 PM IST).
 */

import { CDPManager } from '../src/cdp.js';
import { ChartTools } from '../src/tools/chart.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Market close guard — NSE closes at 15:30 IST (Mon–Fri)
function checkMarketClosed() {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = istNow.getUTCDay(); // 0=Sun, 6=Sat
  const hhmm = istNow.getUTCHours() * 100 + istNow.getUTCMinutes();

  if (day === 0 || day === 6) {
    console.log('Weekend — no market today. Report can be run for a past date:');
    console.log('  node scripts/generate-daily-report.js 2026-06-06');
    process.exit(0);
  }
  if (hhmm < 1530) {
    const remaining = 1530 - hhmm;
    const h = Math.floor(remaining / 100);
    const m = remaining % 100;
    const waitStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    console.error(
      `Market is still open. Run this script after 3:30 PM IST (${waitStr} remaining).`
    );
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const POSITION_FILE = path.join(ROOT, 'config', 'position.json');
const SUPERTREND_TAB = path.join(LOGS_DIR, 'supertrend-tab.json');

const ALERT_NAMES = {
  NIFTY: {
    CE: { entry: 'niftySupertrendLongEntry', exit: 'niftySupertrendLongExit' },
    PE: { entry: 'niftySupertrendShortEntry', exit: 'niftySupertrendShortExit' },
  },
  SENSEX: {
    CE: { entry: 'sensexSupertrendLongEntry', exit: 'sensexSupertrendLongExit' },
    PE: { entry: 'sensexSupertrendShortEntry', exit: 'sensexSupertrendShortExit' },
  },
};

const EXCHANGE = { NIFTY: 'NSE', SENSEX: 'BSE' };
const LOT_SIZES = { NIFTY: 65, SENSEX: 20 };
const LOTS = { NIFTY: 10, SENSEX: 15 };

// SL/target constants for derived exit calculations
const SL = { NIFTY: 15, SENSEX: 35 }; // max loss in pts
const TARGET_G = { NIFTY: 50, SENSEX: 100 }; // max gain for exitSL
const TARGET_L = { NIFTY: 31, SENSEX: 70 }; // max gain for tgtPts

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Compute Unix timestamps for 9:00 IST and 16:00 IST on a given date (IST = UTC+5:30)
function dateToISTRange(dateStr) {
  const baseS = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
  return {
    from: baseS + 3.5 * 3600, // 09:00 IST
    to: baseS + 10.5 * 3600, // 16:00 IST
  };
}

// Scroll the TradingView chart timescale to show the target date, so historical bars are loaded.
async function scrollChartToDate(cdp, dateStr) {
  const { from, to } = dateToISTRange(dateStr);
  const result = await cdp.executeScript(`
    (function() {
      try {
        const model = window.TradingViewApi
          ?._activeChartWidgetWV?._value
          ?._chartWidget?._modelWV?._value;
        const ts = model?.timeScale?.();
        if (ts?.setVisibleRange) {
          ts.setVisibleRange({ from: ${from}, to: ${to} });
          return 'ok-model';
        }
        const cw = window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget;
        if (cw?.setVisibleRange) {
          cw.setVisibleRange({ from: ${from}, to: ${to} });
          return 'ok-widget';
        }
        return 'no-api';
      } catch(e) { return 'err: ' + e.message; }
    })()
  `);
  return result?.result?.value ?? result;
}

// tradeBars: 1m bars between entry and exit, sorted oldest-first.
// Scans each bar's high/low to check if SL or target was touched during the trade.
// This correctly captures cases where price hit the target but Supertrend exit fired later at a lower price.
function computeExitValues(instrument, entry, exitRaw, tradeBars = []) {
  if (entry === null || exitRaw === null) {
    return { exitSL: null, exitNSL: exitRaw, tgtPts: null };
  }
  const sl = SL[instrument] || 15;
  const tgG = TARGET_G[instrument] || 50;
  const tgL = TARGET_L[instrument] || 31;

  // Exit w/SL: clamp actual exit to [entry-SL, entry+TARGET_G].
  // No intraday SL scan — Supertrend exit is the source of truth for stops.
  // Intraday scan only for TARGET_G: if price touched entry+50 during the trade, credit full target.
  let exitSLPrice = clamp(exitRaw, entry - sl, entry + tgG);
  for (const bar of tradeBars) {
    if (bar.high >= entry + tgG) {
      exitSLPrice = entry + tgG;
      break;
    }
  }

  // TgtPts: actual clamped result (-SL to TARGET_L)
  // ExitTgt: always entry + TARGET_L (fixed target exit, independent of actual outcome)
  let tgtHit = false;
  for (const bar of tradeBars) {
    if (bar.high >= entry + tgL) {
      tgtHit = true;
      break;
    }
  }
  const tgtPts = tgtHit ? tgL : parseFloat((exitSLPrice - entry).toFixed(2));
  const exitTgtPrice = parseFloat((entry + tgL).toFixed(2));

  return {
    exitSL: parseFloat(exitSLPrice.toFixed(2)),
    exitTgt: exitTgtPrice,
    exitNSL: parseFloat(exitRaw.toFixed(2)),
    tgtPts: tgtPts,
  };
}

// Parse symbol and alert-fire time from TradingView alert log raw text.
// Format: "alertName\nSYMBOL, 1m\nHH:MM:SS\nWebhook..."
function parseRaw(raw) {
  const lines = raw.split('\n');
  const symbol = (lines[1] || '').split(',')[0].trim();
  const time = (lines[2] || '').trim();
  return { symbol, time };
}

function classify(alertName) {
  for (const [instr, sides] of Object.entries(ALERT_NAMES)) {
    for (const [side, roles] of Object.entries(sides)) {
      if (alertName === roles.entry) return { instrument: instr, side, event: 'entry' };
      if (alertName === roles.exit) return { instrument: instr, side, event: 'exit' };
    }
  }
  return null;
}

// Reconstruct trade pairs from alert log snapshot (oldest-first processing).
function parseTrades(snapshot) {
  const items = [...snapshot].reverse(); // oldest → newest
  const trades = [];
  const pending = {}; // side → { instrument, symbol, entryTime }
  let idSeq = 1;

  for (const item of items) {
    const meta = classify(item.name);
    if (!meta) continue;
    const { symbol, time } = parseRaw(item.raw);
    const { instrument, side, event } = meta;

    if (event === 'entry') {
      pending[side] = { instrument, symbol, entryTime: time };
    } else if (event === 'exit' && pending[side]) {
      trades.push({
        id: idSeq++,
        instrument,
        side,
        entrySymbol: pending[side].symbol,
        exitSymbol: symbol,
        entryTime: pending[side].entryTime,
        exitTime: time,
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

// Convert "HH:MM:SS" IST to Unix seconds (UTC) for a given YYYY-MM-DD date.
function istTimeToUnix(timeStr, dateStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const istMinutes = h * 60 + m;
  const utcMinutes = istMinutes - 330; // IST = UTC+5:30
  const utcH = Math.floor(utcMinutes / 60);
  const utcM = utcMinutes % 60;
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCHours(utcH, utcM, s || 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Find the close price from bars at the given alert-fire Unix timestamp.
// Alert fires at bar close; bar.time is bar open (start of minute).
// So the matching bar has bar.time = alertUnix - 60.
// Accept any bar within ±90 seconds to handle timezone edge cases.
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

async function fetchBarsForSymbol(cdp, cdpChart, qualifiedSymbol, targetDate) {
  await cdpChart.handle('chart_set_symbol', { symbol: qualifiedSymbol });
  await new Promise((r) => setTimeout(r, 3000));
  await cdpChart.handle('chart_set_timeframe', { timeframe: '1' });
  await new Promise((r) => setTimeout(r, 2000));

  // For past dates, scroll the chart to that date so TradingView loads historical bars.
  const scrollResult = await scrollChartToDate(cdp, targetDate);
  console.log(`  scroll to ${targetDate}: ${scrollResult}`);
  await new Promise((r) => setTimeout(r, 4000)); // wait for TV to fetch historical data

  const result = await cdpChart.handle('data_get_ohlcv', { summary: false, limit: 2000 });
  const data = JSON.parse(result?.content?.[0]?.text || '{}');
  return data.bars || [];
}

async function main() {
  const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = dateArg || istNow.toISOString().slice(0, 10);
  console.log(`Generating report for: ${today}\n`);

  // Read position.json
  const position = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
  const snapshot = position.lastLogSnapshot || [];
  if (snapshot.length === 0) {
    console.error('position.json has no alert snapshot — nothing to parse');
    process.exit(1);
  }

  const trades = parseTrades(snapshot);
  if (trades.length === 0) {
    console.log('No complete trade pairs found in position.json');
    process.exit(0);
  }

  console.log(`Trades found: ${trades.length}`);
  for (const t of trades) {
    console.log(`  ${t.side} ${t.entrySymbol}  ${t.entryTime} → ${t.exitTime}`);
  }

  // Connect to TradingView using supertrend tab
  let tabId = null;
  try {
    tabId = JSON.parse(fs.readFileSync(SUPERTREND_TAB, 'utf8')).targetId;
  } catch {
    /**/
  }
  const cdp = new CDPManager(tabId);
  try {
    await cdp.connect();
    console.log('\nCDP connected');
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }
  const cdpChart = new ChartTools(cdp);

  // Fetch 1m OHLCV for each unique option symbol (cache to avoid redundant chart switches)
  const allSymbols = [...new Set(trades.flatMap((t) => [t.entrySymbol, t.exitSymbol]))];
  const barsCache = {};
  for (const sym of allSymbols) {
    const instrument = sym.startsWith('BSX') ? 'SENSEX' : 'NIFTY';
    const qualified = `${EXCHANGE[instrument]}:${sym}`;
    console.log(`\nFetching 1m bars for ${qualified}...`);
    barsCache[sym] = await fetchBarsForSymbol(cdp, cdpChart, qualified, today);
    console.log(`  ${barsCache[sym].length} bars loaded`);
  }

  // Look up entry and exit prices from OHLCV
  console.log('\nPrice lookup:');
  for (const t of trades) {
    const entryUnix = istTimeToUnix(t.entryTime, today);
    const exitUnix = istTimeToUnix(t.exitTime, today);
    t.entryPrice = findPrice(barsCache[t.entrySymbol], entryUnix);
    t.exitPrice = findPrice(barsCache[t.exitSymbol], exitUnix);

    // Bars between entry and exit (inclusive), sorted oldest-first — for intraday SL/target scan
    const tradeBars = (barsCache[t.entrySymbol] || [])
      .filter((b) => b.time >= entryUnix - 60 && b.time <= exitUnix)
      .sort((a, b) => a.time - b.time);

    const derived = computeExitValues(t.instrument, t.entryPrice, t.exitPrice, tradeBars);
    t.exitSL = derived.exitSL;
    t.exitTgt = derived.exitTgt;
    t.exitNSL = derived.exitNSL;
    t.tgtPts = derived.tgtPts;

    // Max intraday points above entry during the trade (how far price moved favorably)
    t.maxReach =
      tradeBars.length > 0 && t.entryPrice !== null
        ? parseFloat(
            Math.max(0, ...tradeBars.map((b) => parseFloat(b.high) - t.entryPrice)).toFixed(2)
          )
        : 0;

    // Auto-classify outcome for notes (priority order):
    //   price reach upto X points → maxReach >= 20 (highest priority — notable move regardless of exit)
    //   SL HIT          → loss >= full SL threshold and reach < 20
    //   PINE SCRIPT SL  → small loss, reach < 20 (pine exited without notable move)
    const REACH_THRESHOLD = 20;
    let autoNotes = '';
    if (t.entryPrice !== null && t.exitPrice !== null) {
      const slPts = SL[t.instrument] || 15;
      if (t.maxReach >= REACH_THRESHOLD) {
        autoNotes = `price reach upto ${t.maxReach} points`;
      } else if (t.entryPrice - t.exitPrice >= slPts) {
        autoNotes = 'SL HIT';
      } else if (t.exitPrice < t.entryPrice) {
        autoNotes = 'PINE SCRIPT SL';
      }
    }
    t.notes = autoNotes;

    const ep = t.entryPrice?.toFixed(2) ?? 'NOT FOUND';
    const xp = t.exitPrice?.toFixed(2) ?? 'NOT FOUND';
    console.log(
      `  ${t.side} ${t.entrySymbol}  entry=${ep}  exit=${xp}  exitSL=${t.exitSL ?? 'N/A'}  tgtPts=${t.tgtPts ?? 'N/A'}  reach=${t.maxReach}  notes=${t.notes || '—'}`
    );
  }

  await cdp.disconnect();

  // Write JSON report
  const output = { date: today, instrument: position.lastInstrument || 'NIFTY', trades };
  const outFile = path.join(LOGS_DIR, `daily-trades-${today}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  const missing = trades.filter((t) => t.entryPrice === null || t.exitPrice === null).length;
  console.log(`\nSaved → ${outFile}`);
  if (missing > 0)
    console.warn(`  ${missing} trade(s) have missing prices — check TradingView chart data`);
}

// Only run when executed directly (not when imported for tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export {
  dateToISTRange,
  istTimeToUnix,
  findPrice,
  computeExitValues,
  parseRaw,
  classify,
  parseTrades,
};
