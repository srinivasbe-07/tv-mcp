#!/usr/bin/env node
/**
 * Test pattern alert creation — creates TradeEntry, TradeSL, TradeTarget
 * on the correct option symbol (or any custom symbol).
 *
 * Usage:
 *   node scripts/test-alert-create.js
 *       Auto-reads spot from chart, calculates today's ITM option symbol
 *
 *   node scripts/test-alert-create.js --symbol NIFTY260602C23200 --entry 23250 --sl 23100 --target 23500
 *       Use a specific symbol and levels
 *
 *   node scripts/test-alert-create.js --bias up --spot 23305 --itm 2
 *       Force bias + spot + ITM depth (skips chart read)
 *
 *   node scripts/test-alert-create.js --cleanup
 *       Just delete TradeEntry / TradeSL / TradeTarget, no creation
 *
 *   node scripts/test-alert-create.js --bias down --spot 23400 --itm 1 --entry 23350 --sl 23450 --target 23100
 *       Full manual override
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';
import fs from 'fs';

// ── Instrument config (mirrors pattern-monitor.js) ───────────────────────────
const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const PATTERN_ITM_BY_DAY = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 };
const INSTRUMENTS = {
  NIFTY:  { spotSymbol: 'NSE:NIFTY',   strikeInterval: 50,  expiryDay: 2, prefix: 'NIFTY' },
  SENSEX: { spotSymbol: 'BSE:SENSEX',  strikeInterval: 100, expiryDay: 4, prefix: 'BSX'   },
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
  const strike = bias === 'up'
    ? atm - itmDepth * cfg.strikeInterval   // CE: ITM = below ATM
    : atm + itmDepth * cfg.strikeInterval;  // PE: ITM = above ATM
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
const hasFlag = (flag) => argv.includes(flag);

const cleanupOnly = hasFlag('--cleanup');
const symbolArg   = arg('--symbol');
const biasArg     = (arg('--bias') || 'up').toLowerCase();
const spotArg     = arg('--spot')   ? parseFloat(arg('--spot'))   : null;
const itmArg      = arg('--itm')    ? parseInt(arg('--itm'))      : null;
const entryArg    = arg('--entry')  ? parseFloat(arg('--entry'))  : null;
const slArg       = arg('--sl')     ? parseFloat(arg('--sl'))     : null;
const targetArg   = arg('--target') ? parseFloat(arg('--target')) : null;

// ── Load algotest webhook config (optional) ───────────────────────────────────
let webhook = '';
let token = '';
try {
  const a = JSON.parse(fs.readFileSync('./config/algotest-config.json', 'utf8'));
  webhook = a.webhookUrl || '';
  token   = a.accessToken || '';
} catch (_) { /* no algotest config — fine */ }

// ── Main ──────────────────────────────────────────────────────────────────────
const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('[CDP] Connected\n');

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart  = new ChartTools(cdp);

  // ── Cleanup existing trade alerts ──────────────────────────────────────────
  console.log('Deleting any existing TradeEntry / TradeSL / TradeTarget ...');
  for (const name of ['TradeEntry', 'TradeSL', 'TradeTarget']) {
    try {
      await cdpAlerts.handle('alert_delete', { alertId: name });
      await new Promise(r => setTimeout(r, 400));
    } catch (_) { /* ignore if not found */ }
  }
  console.log('  Done\n');

  if (cleanupOnly) {
    console.log('--cleanup flag set — exiting after delete.');
    process.exit(0);
  }

  // ── Resolve symbol and levels ───────────────────────────────────────────────
  let symbol = symbolArg;
  let entry  = entryArg;
  let sl     = slArg;
  let target = targetArg;

  if (!symbol) {
    // Auto-calculate option symbol from spot price
    const day = nowIST().getUTCDay();
    const instrName = DAY_INSTRUMENT[day] || 'NIFTY';
    const itmDepth = itmArg ?? (PATTERN_ITM_BY_DAY[day] ?? 2);
    const cfg = INSTRUMENTS[instrName];

    let spot = spotArg;
    if (!spot) {
      console.log(`Reading ${instrName} spot price from chart ...`);
      await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
      await new Promise(r => setTimeout(r, 2000));
      const q = await cdpChart.handle('quote_get', {});
      const d = JSON.parse(q?.content?.[0]?.text || '{}');
      spot = d.close || d.price || d.last;
      if (!spot) {
        console.error(`Could not read spot price — pass --spot <price> manually`);
        process.exit(1);
      }
      console.log(`  Spot: ${spot}`);
    }

    const atm = calcATM(spot, cfg.strikeInterval);
    symbol = buildOptionSymbol(instrName, spot, itmDepth, biasArg);
    console.log(`\nInstrument : ${instrName}   Spot: ${spot}   ATM: ${atm}   ITM-${itmDepth}`);
    console.log(`Symbol     : ${symbol}   Bias: ${biasArg.toUpperCase()}\n`);

    // Switch chart to option symbol so create dialog opens on the right symbol
    console.log(`Switching chart to ${symbol} ...`);
    await cdpChart.handle('chart_set_symbol', { symbol: `NSE:${symbol}` });
    await new Promise(r => setTimeout(r, 2500));
  }

  // Derive default levels from a recent bar if not provided
  if (!entry || !sl || !target) {
    console.log('Fetching recent bars to derive default levels ...');
    try {
      const barsResult = await cdpChart.handle('data_get_ohlcv', { symbol, timeframe: '3', bars: 5 });
      const bars = JSON.parse(barsResult?.content?.[0]?.text || '{}').bars || [];
      const last = bars[bars.length - 2] || bars[bars.length - 1]; // last CLOSED candle
      if (last) {
        entry  = entry  ?? last.high;
        sl     = sl     ?? Math.round((last.high - 5) * 100) / 100;   // entry - 5
        target = target ?? Math.round((last.high + 10) * 100) / 100;  // entry + 10
        console.log(`  Default from candle — Entry:${entry}  SL:${sl}  Target:${target}`);
      }
    } catch (_) { /* ignore */ }
  }

  if (!entry || !sl || !target) {
    console.error('Could not determine entry/sl/target. Pass --entry --sl --target manually.');
    process.exit(1);
  }

  // ── Print plan ──────────────────────────────────────────────────────────────
  const entryMsg = token ? JSON.stringify({ access_token: token, alert_name: 'Entry' }) : '';
  const exitMsg  = token ? JSON.stringify({ access_token: token, alert_name: 'Exit'  }) : '';

  const alerts = [
    { name: 'TradeEntry',  condition: 'crosses_up',   level: entry,  message: entryMsg, once: true  },
    { name: 'TradeSL',     condition: 'crosses_down',  level: sl,     message: exitMsg,  once: false },
    { name: 'TradeTarget', condition: 'crosses_up',    level: target, message: exitMsg,  once: false },
  ];

  console.log('─────────────────────────────────────────────────');
  console.log(`Symbol  : ${symbol}`);
  console.log(`Entry   : ${entry}  (crosses UP,   once)`);
  console.log(`SL      : ${sl}  (crosses DOWN, every time)`);
  console.log(`Target  : ${target}  (crosses UP,   every time)`);
  console.log(`Webhook : ${webhook || '(none)'}`);
  console.log('─────────────────────────────────────────────────\n');

  // ── Create alerts ────────────────────────────────────────────────────────────
  let allOk = true;
  for (const a of alerts) {
    process.stdout.write(`Creating ${a.name} @ ${a.level} ... `);
    const r = await cdpAlerts.handle('alert_create', {
      symbol,
      condition: a.condition,
      level: a.level,
      name: a.name,
      message: a.message,
      webhook,
      once: a.once,
    });

    let d = {};
    try { d = JSON.parse(r?.content?.[0]?.text || '{}'); } catch (_) { /* ignore */ }

    if (d.success) {
      console.log(`✓`);
      console.log(`  price verified : ${d.priceVerified ? '✓' : '✗  WARN: price may not have been set correctly'}`);
      console.log(`  price selector : ${d.priceInputSrc}`);
      console.log(`  name set       : ${d.nameSet ? '✓' : '✗  WARN: name not visible in panel after creation'}`);
      console.log(`  name method    : ${d.nameSetMethod}`);
      if (!d.nameSet && d.nameDiag) {
        const nd = d.nameDiag;
        console.log(`  name btn found : ${nd.strategyB_btnFound} (${nd.strategyB_btnText || 'n/a'})`);
        console.log(`  name input     : found=${nd.nameInputFound} tag=${nd.nameInputTag || 'n/a'} cls=${nd.nameInputCls || 'n/a'}`);
        if (nd.subDialogInputs) console.log(`  sub inputs     : ${nd.subDialogInputs.join(' | ')}`);
        if (!nd.strategyB_btnFound) {
          console.log(`  visible btns   : ${(nd.visibleBtns || []).map(b => b.text || b.label).filter(Boolean).join(' | ')}`);
        }
      }
    } else {
      allOk = false;
      console.log(`✗ FAILED`);
      console.log(`  message        : ${d.message || d.error || 'unknown'}`);
      console.log(`  price selector : ${d.priceInputSrc || 'n/a'}`);
      if (d.diag?.visibleInputs) {
        console.log(`  visible inputs : ${d.diag.visibleInputs.join(' | ')}`);
      }
      if (d.nameDiag) {
        console.log(`  name diag      : ${JSON.stringify(d.nameDiag).slice(0, 300)}`);
      }
    }
    console.log();
    await new Promise(r => setTimeout(r, 1200));
  }

  // ── Verify via alert_list ────────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────');
  console.log('Verifying via alert_list ...');
  await new Promise(r => setTimeout(r, 1000));
  const listR = await cdpAlerts.handle('alert_list', {});
  let listData = {};
  try { listData = JSON.parse(listR?.content?.[0]?.text || '{}'); } catch (_) { /* ignore */ }
  const found = (listData.alerts || []).filter(a => ['TradeEntry','TradeSL','TradeTarget'].includes(a.name));

  console.log(`\nFound ${found.length}/3 trade alerts in panel:`);
  for (const a of found) {
    console.log(`  ✓ ${a.name}  active:${a.active}  symbol:${a.symbol || 'n/a'}`);
  }
  const missing = ['TradeEntry','TradeSL','TradeTarget'].filter(n => !found.some(a => a.name === n));
  for (const n of missing) {
    console.log(`  ✗ ${n}  — NOT FOUND in panel (name may not have been set)`);
  }

  console.log('\n' + (allOk && found.length === 3 ? '✓ All 3 alerts created and visible' : '⚠ Some alerts failed — check output above'));

} catch (e) {
  console.error('Fatal error:', e.message);
} finally {
  await cdp.disconnect?.();
}
