#!/usr/bin/env node
/**
 * Trade Setup Monitor
 *
 * Watches 1-min candles in a configured zone.
 * When Hammer / Engulfing / Doji forms in the zone:
 *   → Creates 3 alerts: TradeEntry, TradeSL, TradeTarget
 *
 * Watches 15-min candles for liquidity grab → auto-flips bias.
 *
 * Config: trade-config.json (edit any time — re-read every tick)
 * {
 *   "bias": "up",
 *   "buyZone":  { "top": 23950, "bottom": 23900 },
 *   "sellZone": { "top": 24100, "bottom": 24050 },
 *   "target": 24100,
 *   "active": true
 * }
 *
 * Usage:  node trade-monitor.js
 * Keys:   [a] toggle active  [f] manual flip bias  [q] quit
 */

import { CDPManager } from './src/cdp.js';
import { AlertTools } from './src/tools/alerts.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const CONFIG_FILE = './trade-config.json';
const POLL_MS = 60_000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

// Day → instrument
const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const INSTRUMENTS = {
  NIFTY: 'NSE:NIFTY',
  SENSEX: 'BSE:SENSEX',
};

// ---------------------------------------------------------------------------
// IST helpers
// ---------------------------------------------------------------------------
function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function isMarketHours() {
  const t = nowIST();
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  return min >= MARKET_OPEN_MIN && min <= MARKET_CLOSE_MIN;
}

function timeStr() {
  const t = nowIST();
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
}

function log(msg) {
  console.log(`[${timeStr()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (_e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Candle pattern detection
// ---------------------------------------------------------------------------
function isHammer(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0 || body === 0) return false;
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return lower >= 2 * body && upper <= body;
}

function isShootingStar(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0 || body === 0) return false;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper >= 2 * body && lower <= body;
}

function isDoji(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return false;
  return body <= range * 0.1;
}

function isBullishEngulfing(curr, prev) {
  return (
    curr.close > curr.open &&
    prev.close < prev.open &&
    curr.open <= prev.close &&
    curr.close >= prev.open
  );
}

function isBearishEngulfing(curr, prev) {
  return (
    curr.close < curr.open &&
    prev.close > prev.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open
  );
}

function detectBullishPattern(curr, prev) {
  if (isHammer(curr)) return 'Hammer';
  if (isDoji(curr)) return 'Doji';
  if (prev && isBullishEngulfing(curr, prev)) return 'BullishEngulfing';
  return null;
}

function detectBearishPattern(curr, prev) {
  if (isShootingStar(curr)) return 'ShootingStar';
  if (isDoji(curr)) return 'Doji';
  if (prev && isBearishEngulfing(curr, prev)) return 'BearishEngulfing';
  return null;
}

function isInZone(candle, zone) {
  // Candle touches or overlaps the zone
  return candle.low <= zone.top && candle.high >= zone.bottom;
}

function isLiquidityGrab(curr, prev, bias) {
  if (bias === 'up') {
    // Shooting star or doji that wicks above prev high but closes below it
    return curr.high > prev.high && curr.close < prev.high && (isShootingStar(curr) || isDoji(curr));
  } else {
    // Hammer or doji that wicks below prev low but closes above it
    return curr.low < prev.low && curr.close > prev.low && (isHammer(curr) || isDoji(curr));
  }
}

// ---------------------------------------------------------------------------
// Fetch OHLCV — switch chart briefly, read bars, restore
// ---------------------------------------------------------------------------
async function fetchBars(cdp, symbol, timeframe, limit) {
  const script = `
    (async function() {
      try {
        const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
        if (!widget) return { bars: [], error: 'No chart widget' };

        const prevSymbol = widget.symbol?.() || '';
        const prevTf     = widget.resolution?.() || '';
        const needSymbol = prevSymbol !== '${symbol}';
        const needTf     = prevTf     !== '${timeframe}';

        if (needSymbol) {
          for (const m of ['setSymbol','changeSymbol','setTicker']) {
            if (typeof widget[m] === 'function') { widget[m]('${symbol}'); break; }
          }
          await new Promise(r => setTimeout(r, 1800));
        }
        if (needTf) {
          for (const m of ['setResolution','setInterval','changeResolution']) {
            if (typeof widget[m] === 'function') { widget[m]('${timeframe}'); break; }
          }
          await new Promise(r => setTimeout(r, 1800));
        }

        // Read bars from model
        let bars = [];
        const model = widget?._chartWidget?._modelWV?._value;
        const store = model?.mainSeries?.()?.bars?.();
        if (store && store.size() > 0) {
          const last  = store.lastIndex();
          const first = store.firstIndex();
          const from  = Math.max(first, last - ${limit} + 1);
          for (let i = from; i <= last; i++) {
            const b = store.valueAt(i);
            if (!b) continue;
            const v = Array.isArray(b) ? b : (b.value || []);
            if (v.length >= 5)
              bars.push({ time: v[0], open: +v[1], high: +v[2], low: +v[3], close: +v[4] });
          }
        }

        // Restore
        if (needTf) {
          for (const m of ['setResolution','setInterval','changeResolution']) {
            if (typeof widget[m] === 'function') { widget[m](prevTf); break; }
          }
          await new Promise(r => setTimeout(r, 500));
        }
        if (needSymbol) {
          for (const m of ['setSymbol','changeSymbol','setTicker']) {
            if (typeof widget[m] === 'function') { widget[m](prevSymbol); break; }
          }
          await new Promise(r => setTimeout(r, 500));
        }

        return { bars, switched: needSymbol || needTf };
      } catch (e) {
        return { bars: [], error: e.message };
      }
    })()
  `;
  const result = await cdp.executeScript(script);
  return result?.bars || [];
}

// ---------------------------------------------------------------------------
// Create trade alerts (Entry + SL + Target)
// ---------------------------------------------------------------------------
let lastAlertCandleTime = null;

async function createTradeAlerts(cdpAlerts, bias, candle, target, symbol) {
  if (lastAlertCandleTime === candle.time) {
    log('  Alerts already created for this candle — skipping duplicate');
    return;
  }

  const isLong = bias === 'up';
  const entryLevel = isLong ? candle.high : candle.low;
  const slLevel = isLong ? candle.low : candle.high;

  log(`  [${isLong ? 'LONG' : 'SHORT'}] Entry:${entryLevel}  SL:${slLevel}  Target:${target}`);

  // Delete any existing trade alerts
  for (const name of ['TradeEntry', 'TradeSL', 'TradeTarget']) {
    try {
      await cdpAlerts.handle('alert_delete', { alertId: name });
      await new Promise((r) => setTimeout(r, 500));
    } catch (_e) { /* ignore — alert may not exist */ }
  }

  // Create Entry
  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: isLong ? 'above' : 'below',
    level: entryLevel,
    name: 'TradeEntry',
  });
  await new Promise((r) => setTimeout(r, 1000));

  // Create SL
  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: isLong ? 'below' : 'above',
    level: slLevel,
    name: 'TradeSL',
  });
  await new Promise((r) => setTimeout(r, 1000));

  // Create Target
  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: isLong ? 'above' : 'below',
    level: target,
    name: 'TradeTarget',
  });

  lastAlertCandleTime = candle.time;
  log('  [OK] TradeEntry + TradeSL + TradeTarget created');
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------
let last15mCheckAt = 0;

async function tick(cdp, cdpAlerts) {
  try {
    if (!isMarketHours()) {
      log('Outside market hours — waiting');
      return;
    }

    const cfg = loadConfig();
    if (!cfg) { log(`${CONFIG_FILE} missing — skipping`); return; }
    if (!cfg.active) { log('Paused (active: false) — edit trade-config.json to resume'); return; }

    const instrName = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
    const symbol = INSTRUMENTS[instrName];
    const zone = cfg.bias === 'up' ? cfg.buyZone : cfg.sellZone;

    if (!zone) {
      log(`No ${cfg.bias === 'up' ? 'buyZone' : 'sellZone'} in config — skipping`);
      return;
    }

    log(`${instrName} | bias:${cfg.bias.toUpperCase()} | zone:${zone.bottom}-${zone.top} | target:${cfg.target}`);

    // ── 1-min pattern check ────────────────────────────────────────────────
    const bars1m = await fetchBars(cdp, symbol, '1', 5);

    if (bars1m.length < 3) {
      log('Not enough 1-min bars');
    } else {
      const curr = bars1m[bars1m.length - 2]; // last completed candle
      const prev = bars1m[bars1m.length - 3];

      if (!isInZone(curr, zone)) {
        log(`1-min candle H:${curr.high} L:${curr.low} — outside zone`);
      } else {
        const pattern =
          cfg.bias === 'up'
            ? detectBullishPattern(curr, prev)
            : detectBearishPattern(curr, prev);

        if (pattern) {
          log(`[SIGNAL] ${pattern} in zone! O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close}`);
          await createTradeAlerts(cdpAlerts, cfg.bias, curr, cfg.target, symbol);
        } else {
          log(`Candle in zone — no pattern yet (O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close})`);
        }
      }
    }

    // ── 15-min liquidity grab check (every 15 min) ─────────────────────────
    if (Date.now() - last15mCheckAt >= 15 * 60 * 1000) {
      last15mCheckAt = Date.now();

      const bars15m = await fetchBars(cdp, symbol, '15', 4);

      if (bars15m.length >= 2) {
        const curr15 = bars15m[bars15m.length - 2];
        const prev15 = bars15m[bars15m.length - 3];

        if (prev15 && isLiquidityGrab(curr15, prev15, cfg.bias)) {
          const newBias = cfg.bias === 'up' ? 'down' : 'up';
          log(`[FLIP] Liquidity grab on 15-min → bias ${cfg.bias.toUpperCase()} → ${newBias.toUpperCase()}`);
          cfg.bias = newBias;
          saveConfig(cfg);
        } else {
          log(`15-min check: no liquidity grab (curr H:${curr15?.high} L:${curr15?.low})`);
        }
      }
    }
  } catch (e) {
    log(`[ERROR] ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(`\nERROR: ${CONFIG_FILE} not found.`);
    console.error('Copy trade-config.example.json → trade-config.json and configure it.\n');
    process.exit(1);
  }

  console.log('\n=== Trade Setup Monitor ===');
  console.log(`Bias      : ${cfg.bias?.toUpperCase()}`);
  console.log(`Buy Zone  : ${cfg.buyZone?.bottom} – ${cfg.buyZone?.top}`);
  console.log(`Sell Zone : ${cfg.sellZone?.bottom} – ${cfg.sellZone?.top}`);
  console.log(`Target    : ${cfg.target}`);
  console.log(`Active    : ${cfg.active}`);
  console.log('\nKeys: [a] toggle active  [f] manual flip bias  [q] quit\n');

  const cdp = new CDPManager();
  try {
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    process.exit(1);
  }

  const cdpAlerts = new AlertTools(cdp);

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (_ch, key) => {
      if (!key) return;
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        log('Exiting...');
        await cdp.disconnect();
        process.exit(0);
      }
      if (key.name === 'a') {
        const c = loadConfig();
        if (c) { c.active = !c.active; saveConfig(c); log(`Monitor ${c.active ? 'ACTIVE' : 'PAUSED'}`); }
      }
      if (key.name === 'f') {
        const c = loadConfig();
        if (c) {
          c.bias = c.bias === 'up' ? 'down' : 'up';
          saveConfig(c);
          log(`[MANUAL FLIP] Bias → ${c.bias.toUpperCase()}`);
        }
      }
    });
  }

  await tick(cdp, cdpAlerts);
  setInterval(() => tick(cdp, cdpAlerts), POLL_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
