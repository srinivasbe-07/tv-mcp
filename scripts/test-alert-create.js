#!/usr/bin/env node
/**
 * Test pattern alert updates — updates the 3 pre-existing fixed alerts
 * (niftyPatternLong* or sensexPatternLong*) with the correct option symbol and price levels.
 *
 * Usage:
 *   node scripts/test-alert-create.js
 *       Auto-reads spot from chart, calculates today's ITM option symbol
 *
 *   node scripts/test-alert-create.js --symbol NIFTY260602C23200 --entry 161 --sl 140 --target 200
 *       Use a specific symbol and levels
 *
 *   node scripts/test-alert-create.js --bias up --spot 23305 --itm 2
 *       Force bias + spot + ITM depth (skips chart read)
 *
 *   node scripts/test-alert-create.js --instr SENSEX
 *       Force SENSEX instrument
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';

// ── Instrument config (mirrors pattern-monitor.js) ───────────────────────────
const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const PATTERN_ITM_BY_DAY = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 1 };
const INSTRUMENTS = {
  NIFTY: { spotSymbol: 'NSE:NIFTY', strikeInterval: 50, expiryDay: 2, prefix: 'NIFTY' },
  SENSEX: { spotSymbol: 'BSE:SENSEX', strikeInterval: 100, expiryDay: 4, prefix: 'BSX' },
};
const PATTERN_ALERT_NAMES = {
  NIFTY: {
    entry: 'niftyPatternLongEntry',
    sl: 'niftyPatternLongSL',
    target: 'niftyPatternLongTarget',
  },
  SENSEX: {
    entry: 'sensexPatternLongEntry',
    sl: 'sensexPatternLongSL',
    target: 'sensexPatternLongTarget',
  },
};

function nowIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000);
}
function calcATM(spot, step) {
  return Math.round(spot / step) * step;
}
function getExpiry(expiryDay) {
  const t = nowIST();
  const days = (expiryDay - t.getUTCDay() + 7) % 7 || 7;
  const d = new Date(t);
  d.setUTCDate(t.getUTCDate() + days);
  return d;
}
function buildOptionSymbol(instrName, spot, itmDepth, bias) {
  const cfg = INSTRUMENTS[instrName];
  if (!cfg) return null;
  const atm = calcATM(spot, cfg.strikeInterval);
  const strike =
    bias === 'up' ? atm - itmDepth * cfg.strikeInterval : atm + itmDepth * cfg.strikeInterval;
  const d = getExpiry(cfg.expiryDay);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const type = bias === 'up' ? 'C' : 'P';
  return `${cfg.prefix}${yy}${mm}${dd}${type}${strike}`;
}

// ── Parse CLI args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const symbolArg = arg('--symbol');
const instrArg = (arg('--instr') || '').toUpperCase();
const biasArg = (arg('--bias') || 'up').toLowerCase();
const spotArg = arg('--spot') ? parseFloat(arg('--spot')) : null;
const itmArg = arg('--itm') ? parseInt(arg('--itm')) : null;
const entryArg = arg('--entry') ? parseFloat(arg('--entry')) : null;
const slArg = arg('--sl') ? parseFloat(arg('--sl')) : null;
const targetArg = arg('--target') ? parseFloat(arg('--target')) : null;

// ── Main ──────────────────────────────────────────────────────────────────────
const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('[CDP] Connected\n');

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart = new ChartTools(cdp);

  // ── Resolve instrument ──────────────────────────────────────────────────────
  const day = nowIST().getUTCDay();
  const instrName = instrArg && INSTRUMENTS[instrArg] ? instrArg : DAY_INSTRUMENT[day] || 'NIFTY';
  const names = PATTERN_ALERT_NAMES[instrName];
  const instrCfg = INSTRUMENTS[instrName];

  // ── Resolve symbol and levels ───────────────────────────────────────────────
  let symbol = symbolArg;
  let entry = entryArg;
  let sl = slArg;
  let target = targetArg;

  if (!symbol) {
    const itmDepth = itmArg ?? PATTERN_ITM_BY_DAY[day] ?? 2;
    let spot = spotArg;

    if (!spot) {
      console.log(`Reading ${instrName} spot price from chart ...`);
      await cdpChart.handle('chart_set_symbol', { symbol: instrCfg.spotSymbol });
      await new Promise((r) => setTimeout(r, 2000));
      const q = await cdpChart.handle('quote_get', {});
      const d = JSON.parse(q?.content?.[0]?.text || '{}');
      spot = d.close || d.price || d.last;
      if (!spot) {
        console.error('Could not read spot price — pass --spot <price> manually');
        process.exit(1);
      }
      console.log(`  Spot: ${spot}`);
    }

    const atm = calcATM(spot, instrCfg.strikeInterval);
    symbol = buildOptionSymbol(instrName, spot, itmDepth, biasArg);
    console.log(`\nInstrument : ${instrName}   Spot: ${spot}   ATM: ${atm}   ITM-${itmDepth}`);
    console.log(`Symbol     : ${symbol}   Bias: ${biasArg.toUpperCase()}\n`);
  }

  // ── Switch chart to option symbol (required for symbol dropdown in edit dialog) ──
  console.log(`Switching chart to ${symbol} ...`);
  await cdpChart.handle('chart_set_symbol', { symbol });
  await new Promise((r) => setTimeout(r, 2500));

  // ── Derive default levels from a recent bar if not provided ────────────────
  if (!entry || !sl || !target) {
    console.log('Fetching recent bars to derive default levels ...');
    try {
      const barsResult = await cdpChart.handle('data_get_ohlcv', {
        symbol,
        timeframe: '3',
        bars: 5,
      });
      const bars = JSON.parse(barsResult?.content?.[0]?.text || '{}').bars || [];
      const last = bars[bars.length - 2] || bars[bars.length - 1];
      if (last) {
        entry = entry ?? last.high;
        sl = sl ?? Math.round((last.high - 5) * 100) / 100;
        target = target ?? Math.round((last.high + 10) * 100) / 100;
        console.log(`  Default from candle — Entry:${entry}  SL:${sl}  Target:${target}`);
      }
    } catch (_) {
      /* ignore */
    }
  }

  if (!entry || !sl || !target) {
    console.error('Could not determine entry/sl/target. Pass --entry --sl --target manually.');
    process.exit(1);
  }

  // ── Print plan ──────────────────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────');
  console.log(`Symbol  : ${symbol}`);
  console.log(`Entry   : ${entry}  → ${names.entry}`);
  console.log(`SL      : ${sl}  → ${names.sl}`);
  console.log(`Target  : ${target}  → ${names.target}`);
  console.log('─────────────────────────────────────────────────\n');

  // ── Update alerts ────────────────────────────────────────────────────────────
  const updates = [
    { alertName: names.entry, level: entry },
    { alertName: names.sl, level: sl },
    { alertName: names.target, level: target },
  ];

  let allOk = true;
  for (const u of updates) {
    process.stdout.write(`Updating ${u.alertName} @ ${u.level} ... `);
    const r = await cdpAlerts.handle('alert_update', {
      alertName: u.alertName,
      symbol,
      level: u.level,
    });

    let d = {};
    try {
      d = JSON.parse(r?.content?.[0]?.text || '{}');
    } catch (_) {
      /* ignore */
    }

    if (d.success) {
      console.log('✓');
      console.log(`  symbol   : ${d.previousSymbol} → ${d.newSymbol}`);
      console.log(
        `  level    : ${d.level}  set:${d.levelSet ? '✓' : '✗ WARN: level may not have committed'}`
      );
    } else {
      allOk = false;
      console.log('✗ FAILED');
      console.log(`  message  : ${d.message || d.error || 'unknown'}`);
    }
    console.log();
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('─────────────────────────────────────────────────');
  console.log(
    allOk ? '✓ All 3 alerts updated successfully' : '⚠ Some updates failed — check output above'
  );
} catch (e) {
  console.error('Fatal error:', e.message);
} finally {
  await cdp.disconnect?.();
}
