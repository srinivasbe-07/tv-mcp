#!/usr/bin/env node
/**
 * Supertrend alert recovery / verification script
 *
 * Reads position.json before updating — skips open trades to avoid
 * moving alerts mid-trade. Use --force to override.
 *
 * Usage:
 *   node scripts/test-supertrend-alerts.js                     ← today's instrument, spot from chart
 *   node scripts/test-supertrend-alerts.js --instr NIFTY       ← force NIFTY
 *   node scripts/test-supertrend-alerts.js --instr SENSEX      ← force SENSEX
 *   node scripts/test-supertrend-alerts.js --spot 23400        ← manual spot price
 *   node scripts/test-supertrend-alerts.js --itm 1             ← force ITM-1
 *   node scripts/test-supertrend-alerts.js --force             ← update all 4 regardless of position
 *   node scripts/test-supertrend-alerts.js --instr NIFTY --instr SENSEX  ← test both
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';
import fs from 'fs';

// ── Constants (mirrors monitor.js) ──────────────────────────────────────────
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

const INSTRUMENTS = {
  NIFTY: {
    name: 'NIFTY',
    spotSymbol: 'NSE:NIFTY',
    strikeInterval: 50,
    expiryDay: 2,
    symbolPrefix: 'NIFTY',
  },
  SENSEX: {
    name: 'SENSEX',
    spotSymbol: 'BSE:SENSEX',
    strikeInterval: 100,
    expiryDay: 4,
    symbolPrefix: 'BSX',
  },
};

const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const NIFTY_ITM_BY_DAY = { 1: 2, 2: 2, 5: 1 };

function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function calcATM(spot, step) {
  return Math.round(spot / step) * step;
}
function getExpiryDate(expiryDay) {
  const t = nowIST();
  const daysUntil = (expiryDay - t.getUTCDay() + 7) % 7;
  const d = new Date(t);
  d.setUTCDate(t.getUTCDate() + daysUntil);
  return d;
}
function buildSymbol(cfg, strike, type) {
  const d = getExpiryDate(cfg.expiryDay);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${cfg.symbolPrefix}${yy}${mm}${dd}${type === 'CE' ? 'C' : 'P'}${strike}`;
}

// ── Read position.json ────────────────────────────────────────────────────────
function loadPosition() {
  try {
    const p = JSON.parse(fs.readFileSync('./config/position.json', 'utf8'));
    const st = p.supertrend || p; // grouped (new) or flat (legacy)
    return { CE: st.CE || 'closed', PE: st.PE || 'closed' };
  } catch {
    return { CE: 'closed', PE: 'closed' };
  }
}

// ── Parse CLI args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const instrArgs = [];
let spotArg = null;
let itmArg = null;
let forceArg = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--instr' && argv[i + 1]) instrArgs.push(argv[++i].toUpperCase());
  if (argv[i] === '--spot' && argv[i + 1]) spotArg = parseFloat(argv[++i]);
  if (argv[i] === '--itm' && argv[i + 1]) itmArg = parseInt(argv[++i]);
  if (argv[i] === '--force') forceArg = true;
}
const day = nowIST().getUTCDay();
const instrsToTest = instrArgs.length ? instrArgs : [DAY_INSTRUMENT[day] || 'NIFTY'];

// ── Load position ─────────────────────────────────────────────────────────────
const position = loadPosition();
console.log(`Position: CE=${position.CE.toUpperCase()}  PE=${position.PE.toUpperCase()}`);
if (forceArg) {
  console.log('--force: updating all 4 alerts regardless of position\n');
} else {
  if (position.CE === 'open')
    console.log('  CE trade RUNNING → CE alerts will be skipped (use --force to override)');
  if (position.PE === 'open')
    console.log('  PE trade RUNNING → PE alerts will be skipped (use --force to override)');
  console.log('');
}

// ── Connect ───────────────────────────────────────────────────────────────────
const cdp = new CDPManager();
try {
  await cdp.connect();
  console.log('CDP connected\n');
} catch (e) {
  console.error('CDP connect failed:', e.message);
  console.error('Start TradingView first:  .\\launch-tv.ps1');
  process.exit(1);
}

const cdpAlerts = new AlertTools(cdp);
const cdpChart = new ChartTools(cdp);

// ── Run for each instrument ───────────────────────────────────────────────────
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

for (const instrName of instrsToTest) {
  const cfg = INSTRUMENTS[instrName];
  if (!cfg) {
    console.error(`Unknown instrument: ${instrName} (use NIFTY or SENSEX)`);
    continue;
  }
  const alertDefs = ALERT_NAMES[instrName];
  const itmDepth =
    itmArg !== null ? itmArg : instrName === 'SENSEX' ? 2 : (NIFTY_ITM_BY_DAY[day] ?? 2);
  const exchange = cfg.spotSymbol.split(':')[0];

  // Get spot price
  let spot = spotArg;
  if (!spot) {
    try {
      await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
      await new Promise((r) => setTimeout(r, 2000));
      const r = await cdpChart.handle('quote_get', {});
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      spot = d.close || d.price || d.last;
    } catch (_) {
      /* ignore */
    }
  }
  if (!spot) {
    console.error(`Could not read ${instrName} spot price. Provide --spot <price>.`);
    totalFailed += 4;
    continue;
  }

  const atm = calcATM(spot, cfg.strikeInterval);
  const ceStrike = atm - itmDepth * cfg.strikeInterval;
  const peStrike = atm + itmDepth * cfg.strikeInterval;
  const ceSymbol = buildSymbol(cfg, ceStrike, 'CE');
  const peSymbol = buildSymbol(cfg, peStrike, 'PE');

  console.log(`── ${instrName} ──────────────────────────────────────────────`);
  console.log(`  Spot: ${spot}   ATM: ${atm}   ITM-${itmDepth}`);
  console.log(`  CE: ${ceSymbol}   PE: ${peSymbol}`);
  console.log('');

  const tests = [
    { name: alertDefs.CE.entry, symbol: ceSymbol, side: 'CE', role: 'entry' },
    { name: alertDefs.CE.exit, symbol: ceSymbol, side: 'CE', role: 'exit' },
    { name: alertDefs.PE.entry, symbol: peSymbol, side: 'PE', role: 'entry' },
    { name: alertDefs.PE.exit, symbol: peSymbol, side: 'PE', role: 'exit' },
  ];

  for (const t of tests) {
    // Skip if trade is running for this side (unless --force)
    if (!forceArg && position[t.side] === 'open') {
      console.log(`  [${t.side}:${t.role}] "${t.name}" → SKIPPED (trade running)`);
      totalSkipped++;
      continue;
    }

    process.stdout.write(`  [${t.side}:${t.role}] "${t.name}" → ${t.symbol} ... `);
    try {
      await cdpChart.handle('chart_set_symbol', { symbol: `${exchange}:${t.symbol}` });
      await new Promise((r) => setTimeout(r, 3000));
      const r = await cdpAlerts.handle('alert_update_symbol', {
        alertName: t.name,
        symbol: t.symbol,
      });
      const data = JSON.parse(r?.content?.[0]?.text || '{}');
      if (r?.isError || !data.success) {
        console.log(`✗ FAIL — ${r?.content?.[0]?.text || 'unknown'}`);
        totalFailed++;
      } else {
        console.log(`✓ OK${data.alreadyCorrect ? ' (already correct)' : ''}`);
        totalPassed++;
      }
    } catch (e) {
      console.log(`✗ ERROR — ${e.message}`);
      totalFailed++;
    }
    await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('── Summary ──────────────────────────────────────────────────');
if (totalSkipped > 0)
  console.log(`  Skipped : ${totalSkipped} (trade running — use --force to override)`);
if (totalFailed === 0 && totalPassed > 0) {
  console.log(`  Updated : ${totalPassed} ✓  All stable`);
} else if (totalFailed > 0) {
  console.log(`  Updated : ${totalPassed} ✓`);
  console.log(`  Failed  : ${totalFailed} ✗  Check alert names in TradingView`);
} else if (totalPassed === 0 && totalSkipped > 0) {
  console.log('  No alerts updated — all sides have open trades');
}

await cdp.disconnect();
