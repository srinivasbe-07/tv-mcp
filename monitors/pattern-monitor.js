#!/usr/bin/env node
/**
 * Pattern Monitor
 *
 * Watches 1-min candles in a configured zone.
 * When Hammer / Engulfing / Doji forms in the zone:
 *   → Creates 3 alerts: TradeEntry, TradeSL, TradeTarget
 *
 * Watches 15-min candles for liquidity grab near key levels → auto-flips bias.
 * Key levels = last 3 days H/L (auto-fetched) + importantLevels (configured).
 * Tolerance = 50pts NIFTY / 100pts SENSEX.
 *
 * Config: config/trade-config.json (re-read every tick)
 *         config/algotest-config.json (loaded once at startup)
 *
 * Usage:  node monitors/pattern-monitor.js
 * Keys:   [a] toggle active  [f] manual flip bias  [q] quit
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const CONFIG_FILE = './config/pattern-monitor-config.json';
const ALGOTEST_FILE = './config/algotest-config.json';
const LOG_FILE = './logs/pattern-monitor.log';
const DRAWN_IDS_FILE = './logs/drawn-ids.json';
// ms until the next candle boundary (e.g. 09:03:00, 09:06:00 for 3-min)
function msUntilNextCandleClose(tfMinutes) {
  const msPerCandle = tfMinutes * 60 * 1000;
  return msPerCandle - (Date.now() % msPerCandle);
}

import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const isMain = path.resolve(process.argv[1] || '') === path.resolve(__filename);

if (isMain) fs.mkdirSync('./logs', { recursive: true });
const logStream = isMain ? fs.createWriteStream(LOG_FILE, { flags: 'a' }) : null;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const INSTRUMENTS = { NIFTY: 'NSE:NIFTY', SENSEX: 'BSE:SENSEX' };
const TOLERANCE = { NIFTY: 50, SENSEX: 100 };
// Points above entry at which SL is trailed to breakeven (cost)
const TRAIL_POINTS = { NIFTY: 15, SENSEX: 35 };

// Options mode: ITM CE option config per instrument
const OPTION_INSTR = {
  NIFTY: { strikeInterval: 50, expiryDay: 2, symbolPrefix: 'NIFTY' }, // expiry Tuesday
  SENSEX: { strikeInterval: 100, expiryDay: 4, symbolPrefix: 'BSX' }, // expiry Thursday
};
// ITM depth for pattern monitor: Fri=ITM-1, Mon/Tue=ITM-2, SENSEX=ITM-2
const PATTERN_ITM_BY_DAY = { 1: 2, 2: 2, 5: 1 };

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
  const line = `[${timeStr()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
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
  } catch (_e) {
    /* ignore */
  }
}

function validateConfig(cfg) {
  const errors = [];

  if (!cfg.bias || !['up', 'down'].includes(cfg.bias))
    errors.push(`bias must be "up" or "down" (got: ${JSON.stringify(cfg.bias)})`);

  const za = cfg.zone || [];
  if (za.length < 2)
    errors.push('zone must have 2 price levels e.g. [73400, 73600]');
  else if (!za[0] || !za[1])
    errors.push('zone prices cannot be 0');
  else if (Math.abs(za[0] - za[1]) < 1)
    errors.push('zone top and bottom cannot be the same price');

  // target=0 allowed only in optionsMode (auto swing high)
  if (!cfg.optionsMode && (!cfg.target || cfg.target <= 0))
    errors.push('target must be > 0 (or set optionsMode:true for auto target)');

  return errors;
}

function loadAlgotest() {
  try {
    return JSON.parse(fs.readFileSync(ALGOTEST_FILE, 'utf8'));
  } catch (_e) {
    return {};
  }
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
  return candle.low <= zone.top && candle.high >= zone.bottom;
}

// ---------------------------------------------------------------------------
// Key levels: last 3 days H/L + user importantLevels
// ---------------------------------------------------------------------------
function nearestLevel(price, levels, tolerance) {
  return levels.find((l) => Math.abs(price - l) <= tolerance) ?? null;
}

function isLiquidityGrab(curr, prev, bias, levels, tolerance) {
  if (bias === 'up') {
    // Wick must actually reach/exceed the level AND close back below it
    const wickedAbove = curr.high > prev.high && curr.close < prev.high;
    const pattern = isShootingStar(curr) || isDoji(curr);
    const level = levels.find((l) => curr.high >= l && curr.close < l) ?? null;
    return wickedAbove && pattern && level !== null ? level : null;
  } else {
    // Wick must actually reach/go below the level AND close back above it
    const wickedBelow = curr.low < prev.low && curr.close > prev.low;
    const pattern = isHammer(curr) || isDoji(curr);
    const level = levels.find((l) => curr.low <= l && curr.close > l) ?? null;
    return wickedBelow && pattern && level !== null ? level : null;
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
// Options mode helpers
// ---------------------------------------------------------------------------
function calcATM(spot, strikeInterval) {
  return Math.round(spot / strikeInterval) * strikeInterval;
}

function getExpiryDate(expiryDay) {
  const t = nowIST();
  const day = t.getUTCDay();
  const daysUntil = (expiryDay - day + 7) % 7;
  const d = new Date(t);
  d.setUTCDate(t.getUTCDate() + daysUntil);
  return d;
}

function buildOptionSymbol(instrName, spot, itmDepth, bias = 'up') {
  const instr = OPTION_INSTR[instrName];
  if (!instr) return null;
  const atm = calcATM(spot, instr.strikeInterval);
  // ITM call: strike below spot; ITM put: strike above spot
  const strike =
    bias === 'up' ? atm - itmDepth * instr.strikeInterval : atm + itmDepth * instr.strikeInterval;
  const optionType = bias === 'up' ? 'C' : 'P';
  const d = getExpiryDate(instr.expiryDay);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${instr.symbolPrefix}${yy}${mm}${dd}${optionType}${strike}`;
}

function calcSwingHigh(bars) {
  return Math.max(...bars.map((b) => b.high));
}

// ---------------------------------------------------------------------------
// Create trade alerts (Entry + SL + Target)
// ---------------------------------------------------------------------------
let lastAlertCandleTime = null;
let tradeEntryLevel = null; // saved on alert creation — used for trail SL to breakeven
let slTrailedToBreakeven = false;
let activeTradeSymbol = null; // option symbol when in options mode

async function createTradeAlerts(
  cdpAlerts,
  bias,
  candle,
  target,
  sl,
  symbol,
  algotest,
  _delayMs = 1000
) {
  if (lastAlertCandleTime === candle.time) {
    log('  Alerts already created for this candle — skipping duplicate');
    return;
  }

  const isLong = bias === 'up';
  const tradeType = isLong ? 'LONG' : 'SHORT';
  const entryLevel = isLong ? candle.high : candle.low;
  const slLevel = sl || (isLong ? candle.low : candle.high);

  log(`  [${tradeType}] Entry:${entryLevel}  SL:${slLevel}  Target:${target}`);

  const webhook = algotest?.webhookUrl || '';
  const token = algotest?.accessToken || '';
  const entryMsg = token ? JSON.stringify({ access_token: token, alert_name: 'Entry' }) : '';
  const exitMsg  = token ? JSON.stringify({ access_token: token, alert_name: 'Exit' })  : '';

  for (const name of ['TradeEntry', 'TradeSL', 'TradeTarget']) {
    try {
      await cdpAlerts.handle('alert_delete', { alertId: name });
      await new Promise((r) => setTimeout(r, 500));
    } catch (_e) {
      /* ignore */
    }
  }

  const parseAlertResult = (r) => {
    try {
      return JSON.parse(r?.content?.[0]?.text || '{}');
    } catch (_) {
      return {};
    }
  };

  const r1 = await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_up',
    level: entryLevel,
    name: 'TradeEntry',
    message: entryMsg,
    webhook,
    once: true,
  });
  const d1 = parseAlertResult(r1);
  if (!d1.success) {
    log(`  [FAIL] TradeEntry: ${d1.message || 'unknown error'}`);
    return;
  }
  log(`  [OK] TradeEntry at ${entryLevel}${d1.nameSet === false ? ' [WARN: name not set]' : ''}`);

  await new Promise((r) => setTimeout(r, _delayMs));

  const r2 = await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_down',
    level: slLevel,
    name: 'TradeSL',
    message: exitMsg,
    webhook,
    once: true,
  });
  const d2 = parseAlertResult(r2);
  if (!d2.success) {
    log(`  [FAIL] TradeSL: ${d2.message || 'unknown error'}`);
    return;
  }
  log(`  [OK] TradeSL at ${slLevel}${d2.nameSet === false ? ' [WARN: name not set]' : ''}`);

  await new Promise((r) => setTimeout(r, _delayMs));

  const r3 = await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_down',
    level: target,
    name: 'TradeTarget',
    message: exitMsg,
    webhook,
    once: true,
  });
  const d3 = parseAlertResult(r3);
  if (!d3.success) {
    log(`  [FAIL] TradeTarget: ${d3.message || 'unknown error'}`);
    return;
  }
  log(`  [OK] TradeTarget at ${target}${d3.nameSet === false ? ' [WARN: name not set]' : ''}`);

  lastAlertCandleTime = candle.time;
  tradeEntryLevel = entryLevel;
  slTrailedToBreakeven = false;
  log(`  All 3 alerts created${webhook ? ' (Algotest webhook set)' : ''}`);
  return true;
}

// ---------------------------------------------------------------------------
// Cleanup: delete remaining trade alerts once an exit alert fires
// ---------------------------------------------------------------------------
const TRADE_ALERT_NAMES = ['TradeEntry', 'TradeSL', 'TradeTarget'];

async function cleanupFiredAlerts(cdp, cdpAlerts) {
  try {
    const result = await cdpAlerts.handle('alert_list', {});
    const data = JSON.parse(result.content[0].text);
    const alerts = data.alerts || [];

    const tradeAlerts = alerts.filter((a) => TRADE_ALERT_NAMES.includes(a.name));
    if (tradeAlerts.length === 0) {
      log('[RESET] No trade alerts found on TradingView — clearing trade state');
      lastAlertCandleTime = null;
      tradeEntryLevel = null;
      slTrailedToBreakeven = false;
      activeTradeSymbol = null;
      return;
    }

    const targetFired = tradeAlerts.some((a) => a.name === 'TradeTarget' && !a.active);
    const slFired = tradeAlerts.some((a) => a.name === 'TradeSL' && !a.active);
    if (!targetFired && !slFired) return;

    if (targetFired) {
      log('[TARGET HIT] Trade closed at target');
      log('[TARGET HIT] Set new levels then set active: true to resume');
    } else {
      log('[SL HIT] Stop loss triggered — cleaning up trade alerts');
    }

    for (const name of TRADE_ALERT_NAMES) {
      try {
        await cdpAlerts.handle('alert_delete', { alertId: name });
        await new Promise((r) => setTimeout(r, 300));
      } catch (_e) {
        /* ignore */
      }
    }
    lastAlertCandleTime = null;
    tradeEntryLevel = null;
    slTrailedToBreakeven = false;
    activeTradeSymbol = null;

    // Clear chart then re-apply current config
    log('[CLEANUP] Clearing chart and re-applying config...');
    await clearAllDrawings(cdp);
    await new Promise((r) => setTimeout(r, 1000));
    const c = loadConfig();
    if (c) {
      const instrName = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
      const sym = c.symbol || INSTRUMENTS[instrName];
      lastDayLevelDate = ''; // force re-fetch
      lastDrawnNearestKey = ''; // force redraw
      await refreshDayBars(cdp, sym);
      if (c.active) {
        const _za = c.zone || [];
        const z =
          _za.length >= 2
            ? { top: Math.max(_za[0], _za[1]), bottom: Math.min(_za[0], _za[1]) }
            : null;
        if (z) {
          const ok = await drawZone(cdp, z, c.bias);
          if (ok) lastDrawnZoneKey = `${z.bottom}-${z.top}-${c.bias}`;
        }
        if ((c.importantLevels || []).length) {
          const ok = await drawImportantLevels(cdp, c.importantLevels);
          if (ok) lastDrawnImportantKey = c.importantLevels.join(',');
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Trail SL to breakeven once price reaches trailToCostAt
// ---------------------------------------------------------------------------
async function trailSLToBreakeven(cdp, cdpAlerts, cfg, symbol, trailPoints) {
  if (!trailPoints || !tradeEntryLevel || cfg.bias !== 'up' || slTrailedToBreakeven) return;

  const trailTrigger = tradeEntryLevel + trailPoints;
  const tf = String(cfg.candleTimeframe || '3');
  const liveBars = await fetchBars(cdp, activeTradeSymbol || symbol, tf, 3);
  const live = liveBars[liveBars.length - 1];
  if (!live || live.close < trailTrigger) return;

  log(
    `[TRAIL SL] Price ${live.close} reached ${trailTrigger} (entry ${tradeEntryLevel} + ${trailPoints}pts) — moving TradeSL to breakeven`
  );
  try {
    await cdpAlerts.handle('alert_delete', { alertId: 'TradeSL' });
    await new Promise((r) => setTimeout(r, 500));

    const algotest = loadAlgotest();
    const token = algotest?.accessToken || '';
    const exitMsg = token ? JSON.stringify({ access_token: token, alert_name: 'square_off' }) : '';
    const webhook = algotest?.webhookUrl || '';

    const r = await cdpAlerts.handle('alert_create', {
      symbol,
      condition: 'crosses_down',
      level: tradeEntryLevel,
      name: 'TradeSL',
      message: exitMsg,
      webhook,
    });
    const d = JSON.parse(r?.content?.[0]?.text || '{}');
    if (d.success) {
      log(`[TRAIL SL] TradeSL moved to ${tradeEntryLevel} (breakeven) — trade now risk-free`);
      slTrailedToBreakeven = true;
    } else {
      log(`[TRAIL SL] Failed to move SL: ${d.message || 'unknown error'}`);
    }
  } catch (e) {
    log(`[TRAIL SL] Error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Persist drawn entity IDs across restarts so old lines can be removed
// ---------------------------------------------------------------------------
function loadDrawnIds() {
  try {
    return JSON.parse(fs.readFileSync(DRAWN_IDS_FILE, 'utf8'));
  } catch (_e) {
    return { levelIds: [], zoneIds: [], importantIds: [] };
  }
}

function saveDrawnIds() {
  try {
    fs.writeFileSync(
      DRAWN_IDS_FILE,
      JSON.stringify({
        levelIds: drawnLevelIds,
        zoneIds: drawnZoneIds,
        importantIds: drawnImportantIds,
      })
    );
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Clear all drawings from the chart on startup
// ---------------------------------------------------------------------------
async function clearAllDrawings(cdp) {
  const script = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return { error: 'No chart' };

        // Method 1: removeAllShapes (newer TV versions)
        if (typeof chart.removeAllShapes === 'function') {
          chart.removeAllShapes();
          return { ok: true, removed: 'all', method: 'removeAllShapes' };
        }

        // Method 2: getAllShapes + removeEntity (widely supported)
        if (typeof chart.getAllShapes === 'function') {
          const shapes = chart.getAllShapes() || [];
          let count = 0;
          shapes.forEach(s => {
            try { chart.removeEntity(s.id); count++; } catch(_) {}
          });
          return { ok: true, removed: count, method: 'getAllShapes' };
        }

        return { ok: false, error: 'No clear API available' };
      } catch(e) { return { error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(script).catch(() => null);
  if (result?.ok) {
    log(`Chart cleared: ${result.removed} shapes removed (${result.method})`);
    drawnLevelIds = [];
    drawnZoneIds = [];
    drawnImportantIds = [];
    lastDrawnZoneKey = '';
    lastDrawnImportantKey = '';
    saveDrawnIds();
    return true;
  }
  log(`Chart clear failed: ${result?.error || 'unknown'}`);
  return false;
}

// ---------------------------------------------------------------------------
// Draw horizontal lines on the chart for key levels
// ---------------------------------------------------------------------------
const _persistedIds = loadDrawnIds();
let drawnLevelIds = _persistedIds.levelIds;
let drawnImportantIds = _persistedIds.importantIds || [];

async function drawDayLevels(cdp, levelObjects) {
  const removeScript = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return;
        ${JSON.stringify(drawnLevelIds)}.forEach(id => { try { chart.removeEntity(id); } catch(_e) {} });
      } catch(_e) {}
    })()
  `;
  await cdp.executeScript(removeScript).catch(() => {});
  drawnLevelIds = [];

  const drawScript = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { error: 'Drawing API not available' };
        const levels = ${JSON.stringify(levelObjects)};
        const ids = [];
        for (const { price, label, color } of levels) {
          try {
            const id = await chart.createShape(
              { price },
              { shape: 'horizontal_line', lock: false,
                overrides: { linecolor: color, linewidth: 1, linestyle: 2,
                             showLabel: true, text: label } }
            );
            if (id) ids.push(id);
          } catch(_e) {}
        }
        return { ids };
      } catch(e) { return { error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(drawScript).catch(() => null);
  if (result?.ids?.length) {
    drawnLevelIds = result.ids;
    saveDrawnIds();
    log(`Drew ${result.ids.length} level lines on chart`);
  } else {
    log(`Level lines: ${result?.error || 'drawing API not available'}`);
  }
}

// ---------------------------------------------------------------------------
// Draw zone lines (top + bottom) — redrawn only when zone changes
// ---------------------------------------------------------------------------
let drawnZoneIds = _persistedIds.zoneIds;
let lastDrawnZoneKey = '';

async function drawZone(cdp, zone, bias) {
  const removeScript = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return;
        ${JSON.stringify(drawnZoneIds)}.forEach(id => { try { chart.removeEntity(id); } catch(_e) {} });
      } catch(_e) {}
    })()
  `;
  await cdp.executeScript(removeScript).catch(() => {});
  drawnZoneIds = [];

  const color = bias === 'up' ? '#FFD700' : '#FF6B6B';
  const top = zone.top;
  const bottom = zone.bottom;

  const drawScript = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { error: 'No drawing API' };
        const ids = [];
        const t = Math.floor(Date.now() / 1000);
        for (const price of [${top}, ${bottom}]) {
          try {
            const id = await chart.createShape(
              { time: t, price },
              { shape: 'horizontal_line', lock: false,
                overrides: { linecolor: '${color}', linewidth: 3, linestyle: 0,
                             showLabel: false } }
            );
            if (id) ids.push(id);
          } catch(_e) {}
        }
        return { ids };
      } catch(e) { return { error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(drawScript).catch(() => null);
  if (result?.ids?.length) {
    drawnZoneIds = result.ids;
    saveDrawnIds();
    log(`Zone drawn: ${zone.bottom} - ${zone.top}`);
    return true;
  }
  log(`Zone draw failed: ${result?.error || 'unknown error'}`);
  return false;
}

// ---------------------------------------------------------------------------
// Draw important levels (user-configured S/R) — purple lines
// ---------------------------------------------------------------------------
let lastDrawnImportantKey = '';

async function drawImportantLevels(cdp, levels) {
  const removeScript = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return;
        ${JSON.stringify(drawnImportantIds)}.forEach(id => { try { chart.removeEntity(id); } catch(_e) {} });
      } catch(_e) {}
    })()
  `;
  await cdp.executeScript(removeScript).catch(() => {});
  drawnImportantIds = [];
  saveDrawnIds();

  if (!levels.length) return true;

  const levelObjects = levels.map((price) => ({ price, label: `L ${price}`, color: '#AA44FF' }));
  const drawScript = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { error: 'No drawing API' };
        const levels = ${JSON.stringify(levelObjects)};
        const ids = [];
        const t = Math.floor(Date.now() / 1000);
        for (const { price, label, color } of levels) {
          try {
            const id = await chart.createShape(
              { time: t, price },
              { shape: 'horizontal_line', lock: false,
                overrides: { linecolor: color, linewidth: 1, linestyle: 1,
                             showLabel: true, text: label } }
            );
            if (id) ids.push(id);
          } catch(_e) {}
        }
        return { ids };
      } catch(e) { return { error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(drawScript).catch(() => null);
  if (result?.ids?.length) {
    drawnImportantIds = result.ids;
    saveDrawnIds();
    log(`Important levels drawn: ${levels.join(', ')}`);
    return true;
  }
  log(`Important levels: ${result?.error || 'drawing API not available'}`);
  return false;
}

// ---------------------------------------------------------------------------
// Clear only zone + important level lines (keep day H/L)
// ---------------------------------------------------------------------------
async function clearZoneAndLevels(cdp) {
  const removeScript = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return;
        ${JSON.stringify(drawnZoneIds)}.forEach(id => { try { chart.removeEntity(id); } catch(_e) {} });
        ${JSON.stringify(drawnImportantIds)}.forEach(id => { try { chart.removeEntity(id); } catch(_e) {} });
      } catch(_e) {}
    })()
  `;
  await cdp.executeScript(removeScript).catch(() => {});
  drawnZoneIds = [];
  drawnImportantIds = [];
  lastDrawnZoneKey = '';
  lastDrawnImportantKey = '';
  saveDrawnIds();
  log('Zone and important levels cleared');
}

// ---------------------------------------------------------------------------
// Cache up to D-10 — fetched once per day.
// Draw only nearest resistance (lowest high above price) + nearest support (highest low below price).
// ---------------------------------------------------------------------------
let cachedDayBars = [];   // [{high, low, date, label}, ...] D-1 first (newest)
let cachedDayLevels = []; // flat prices used for liquidity grab detection
let lastDayLevelDate = '';
let lastDrawnNearestKey = ''; // "resistance:support" — skip redraw if unchanged
let brokenHighs = new Set(); // day highs confirmed broken by 15-min close — never return
let brokenLows  = new Set(); // day lows confirmed broken by 15-min close — never return

async function refreshDayBars(cdp, symbol) {
  const todayStr = nowIST().toISOString().slice(0, 10);
  if (todayStr === lastDayLevelDate && cachedDayBars.length) return;
  const dailyBars = await fetchBars(cdp, symbol, 'D', 12);
  const completed = dailyBars.slice(0, -1).slice(-10); // last 10 completed days
  if (!completed.length) {
    log('Day levels: no completed bars yet');
    return;
  }
  cachedDayBars = [...completed].reverse().map((b, i) => ({
    high: b.high, low: b.low,
    date: new Date(b.time * 1000).toISOString().slice(0, 10),
    label: `D-${i + 1}`,
  }));
  cachedDayLevels = cachedDayBars.flatMap((d) => [d.high, d.low]);
  lastDayLevelDate = todayStr;
  lastDrawnNearestKey = ''; // force redraw on next updateNearestDayLevel
  brokenHighs = new Set(); // fresh day — reset broken level memory
  brokenLows  = new Set();
  cachedDayBars.forEach((d) =>
    log(`${d.label} (${d.date}): H=${d.high.toFixed(0)}  L=${d.low.toFixed(0)}`)
  );
}

// Called every tick — draws nearest resistance + support from D-1..D-10.
// Only redraws when the nearest levels change (price crosses a level).
async function updateNearestDayLevel(cdp, close) {
  if (!cachedDayBars.length) return;

  // Mark any level that the 15-min close has crossed as permanently broken
  cachedDayBars.forEach((d) => {
    if (close > d.high) brokenHighs.add(d.high);
    if (close < d.low)  brokenLows.add(d.low);
  });

  // Only consider unbroken levels
  const activeHighs = cachedDayBars.map((d) => d.high).filter((h) => !brokenHighs.has(h));
  const activeLows  = cachedDayBars.map((d) => d.low).filter((l) => !brokenLows.has(l));

  const resistance = activeHighs.filter((h) => h > close).sort((a, b) => a - b)[0];
  const support    = activeLows.filter((l) => l < close).sort((a, b) => b - a)[0];

  const key = `${resistance ?? ''}:${support ?? ''}`;
  if (key === lastDrawnNearestKey) return;

  const levels = [];
  if (resistance != null) {
    const src = cachedDayBars.find((d) => d.high === resistance);
    levels.push({ price: resistance, label: `${src.label} H`, color: '#FF4444' });
  }
  if (support != null) {
    const src = cachedDayBars.find((d) => d.low === support);
    levels.push({ price: support, label: `${src.label} L`, color: '#22BB44' });
  }
  await drawDayLevels(cdp, levels);
  lastDrawnNearestKey = key;
  log(`Day levels: R=${resistance?.toFixed(0) ?? 'none'}  S=${support?.toFixed(0) ?? 'none'}`);
}

// ---------------------------------------------------------------------------
// Drag sync — read zone/important level positions from chart, update config
// ---------------------------------------------------------------------------
async function checkDraggedLevels(cdp, cfg) {
  if (!drawnZoneIds.length && !drawnImportantIds.length) return;

  const script = `
    (function() {
      const chart = window.TradingViewApi?.activeChart?.();
      if (!chart) return null;
      const ids = ${JSON.stringify([...drawnZoneIds, ...drawnImportantIds])};
      const result = {};
      for (const id of ids) {
        try {
          const pts = chart.getShapeById(id)?.getPoints?.();
          if (pts?.[0]?.price != null) result[id] = pts[0].price;
        } catch(_) {}
      }
      return result;
    })()
  `;
  const prices = await cdp.executeScript(script).catch(() => null);
  if (!prices) return;

  let changed = false;

  // Zone lines
  if (drawnZoneIds.length === 2) {
    const p0 = prices[drawnZoneIds[0]];
    const p1 = prices[drawnZoneIds[1]];
    if (p0 != null && p1 != null) {
      const newTop    = Math.max(p0, p1);
      const newBottom = Math.min(p0, p1);
      const cfgArr    = cfg.zone || [];
      const cfgTop    = cfgArr.length >= 2 ? Math.max(...cfgArr) : null;
      const cfgBottom = cfgArr.length >= 2 ? Math.min(...cfgArr) : null;
      if (cfgTop == null || Math.abs(newTop - cfgTop) > 1 || Math.abs(newBottom - cfgBottom) > 1) {
        cfg.zone = [Math.round(newTop), Math.round(newBottom)];
        lastDrawnZoneKey = `${newBottom}-${newTop}-${cfg.bias}`; // prevent redundant redraw
        log(`[DRAG] Zone → ${newBottom.toFixed(0)} - ${newTop.toFixed(0)}`);
        changed = true;
      }
    }
  }

  // Important levels
  if (drawnImportantIds.length > 0) {
    const newLevels = drawnImportantIds.map((id) => prices[id]).filter((p) => p != null);
    if (newLevels.length === drawnImportantIds.length) {
      const cfgLevels = cfg.importantLevels || [];
      const same =
        newLevels.length === cfgLevels.length &&
        newLevels.every((p, i) => Math.abs(p - cfgLevels[i]) <= 1);
      if (!same) {
        cfg.importantLevels = newLevels.map((p) => Math.round(p));
        lastDrawnImportantKey = cfg.importantLevels.join(','); // prevent redundant redraw
        log(`[DRAG] Important levels → ${cfg.importantLevels.join(', ')}`);
        changed = true;
      }
    }
  }

  if (changed) saveConfig(cfg);
}

// ---------------------------------------------------------------------------
// Draw a text label on chart when liquidity grab detected
// ---------------------------------------------------------------------------
async function drawLiquidityGrabLabel(cdp, price, bias, dayLabel) {
  const direction = bias === 'up' ? '▲ Liq Grab' : '▼ Liq Grab';
  const text = dayLabel ? `${direction} @ ${dayLabel}` : direction;
  const script = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return;
        const t = Math.floor(Date.now() / 1000);
        await chart.createShape(
          { time: t, price: ${price} },
          {
            shape: 'text',
            lock: true,
            overrides: {
              text: ${JSON.stringify(text)},
              color: '#FF6B6B',
              fontsize: 14,
              bold: true,
              fixedSize: true,
            }
          }
        );
      } catch(_e) {}
    })()
  `;
  await cdp.executeScript(script).catch(() => {});
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------
let last15mCandleTime = 0; // timestamp of last 15-min candle we checked

async function tick(cdp, cdpAlerts) {
  try {
    if (!cdp.isConnected()) throw new Error('CDP not connected');

    const cfg = loadConfig();
    if (!cfg) {
      log(`${CONFIG_FILE} missing — skipping`);
      return;
    }

    if (!cfg.ignoreMarketHours && !isMarketHours()) {
      log('Outside market hours — waiting');
      return;
    }

    if (!cfg.active) {
      log('Paused (active: false) — configure zones then set active: true');
      return;
    }

    const instrName = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
    const symbol = cfg.symbol || INSTRUMENTS[instrName];

    // On restart: if trade alerts already exist in TradingView, resume tracking them
    if (!lastAlertCandleTime) {
      try {
        const listResult = await cdpAlerts.handle('alert_list', {});
        const listData = JSON.parse(listResult.content[0].text);
        const existing = (listData.alerts || []).filter(
          (a) => TRADE_ALERT_NAMES.includes(a.name) && a.active
        );
        if (existing.length > 0) {
          log(`[RESUME] Found ${existing.length} active trade alert(s) — skipping new creation`);
          lastAlertCandleTime = -1; // sentinel: trade in progress, candle time unknown
        }
      } catch (_) {}
    }

    // Clean up if SL/Target fired — resets lastAlertCandleTime to null on exit
    if (lastAlertCandleTime) await cleanupFiredAlerts(cdp, cdpAlerts);

    // Trade still active — check trail SL, then skip pattern detection
    if (lastAlertCandleTime) {
      // trailToCostPoints: user override; absent = use instrument default; 0 = disabled
      const trailPoints =
        cfg.trailToCostPoints != null
          ? cfg.trailToCostPoints
          : cfg.symbol
            ? 0
            : TRAIL_POINTS[instrName] || 0;
      await trailSLToBreakeven(cdp, cdpAlerts, cfg, symbol, trailPoints);
      log('Trade active — waiting for SL or Target to hit, no new setups');
      return;
    }

    const tolerance = cfg.tolerance || TOLERANCE[instrName];
    const zoneArr = cfg.zone || [];
    const zone =
      zoneArr.length >= 2
        ? { top: Math.max(zoneArr[0], zoneArr[1]), bottom: Math.min(zoneArr[0], zoneArr[1]) }
        : null;
    const target = cfg.target;
    const sl = cfg.sl || 0;
    const algotest = loadAlgotest();

    if (!zone) {
      log(`Zone not configured — edit trade-config.json`);
      return;
    }
    const isOptionsMode = cfg.optionsMode && !cfg.symbol;
    if (!target && !isOptionsMode) {
      log(`Target not configured — edit trade-config.json`);
      return;
    }

    const slDesc = sl ? String(sl) : 'auto (candle extreme)';
    const tgtDesc = target ? String(target) : isOptionsMode ? 'auto (swing high)' : '?';
    log(
      `${cfg.symbol || instrName} | bias:${cfg.bias.toUpperCase()} | zone:${zone.bottom}-${zone.top} | target:${tgtDesc} | SL:${slDesc}${isOptionsMode ? ' | OPTIONS MODE' : ''}`
    );
    if (isOptionsMode) {
      const itmDepth = PATTERN_ITM_BY_DAY[nowIST().getUTCDay()] ?? 2;
      const zoneSpot = (zone.top + zone.bottom) / 2;
      const previewSym = buildOptionSymbol(instrName, zoneSpot, itmDepth, cfg.bias);
      log(`Options: will watch ${previewSym} (ITM-${itmDepth}) when spot enters zone`);
    }

    // ── Refresh D-1..D-10 cache once per day ─────────────────────────────
    await refreshDayBars(cdp, symbol);

    // bias=up → only day HIGHS (resistance); bias=down → only day LOWS (support)
    // Also exclude already-grabbed levels
    const activeDayLevels = cfg.bias === 'up'
      ? cachedDayBars.map((d) => d.high).filter((h) => !brokenHighs.has(h))
      : cachedDayBars.map((d) => d.low).filter((l) => !brokenLows.has(l));
    const allLevels = [...activeDayLevels, ...(cfg.importantLevels || [])];

    // ── Draw zone lines when zone changes ─────────────────────────────────────
    const zoneKey = `${zone.bottom}-${zone.top}-${cfg.bias}`;
    if (zoneKey !== lastDrawnZoneKey) {
      const ok = await drawZone(cdp, zone, cfg.bias);
      if (ok) lastDrawnZoneKey = zoneKey;
    }

    // ── Draw important levels when they change ────────────────────────────────
    const importantKey = (cfg.importantLevels || []).join(',');
    if (importantKey !== lastDrawnImportantKey) {
      const ok = await drawImportantLevels(cdp, cfg.importantLevels || []);
      if (ok) lastDrawnImportantKey = importantKey;
    }

    // ── Sync dragged lines back to config ────────────────────────────────────
    await checkDraggedLevels(cdp, cfg);

    // ── Pattern check (configurable timeframe, default 3-min) ────────────────
    const tf = String(cfg.candleTimeframe || '3');
    const bars = await fetchBars(cdp, symbol, tf, 5);

    if (bars.length < 3) {
      log(`Not enough ${tf}-min bars`);
    } else {
      const curr = bars[bars.length - 2]; // last completed candle
      const prev = bars[bars.length - 3];

      // Retry day level draw if not yet drawn (chart wasn't ready at startup)
      if (!lastDrawnNearestKey && cachedDayBars.length) {
        await updateNearestDayLevel(cdp, curr.close);
      }

      if (!isInZone(curr, zone)) {
        log(`${tf}-min candle H:${curr.high} L:${curr.low} — outside zone`);
      } else {
        // In options mode: fetch ITM CE option candles for pattern detection
        let patternCandle = curr;
        let patternPrev = prev;
        let tradeSymbol = symbol;
        let optBars = null;

        if (isOptionsMode) {
          const itmDepth = PATTERN_ITM_BY_DAY[nowIST().getUTCDay()] ?? 2;
          const spotPrice = bars[bars.length - 1]?.close || curr.close;
          const optSym = buildOptionSymbol(instrName, spotPrice, itmDepth, cfg.bias);
          if (optSym) {
            optBars = await fetchBars(cdp, optSym, tf, 10);
            if (optBars.length >= 3) {
              patternCandle = optBars[optBars.length - 2];
              patternPrev = optBars[optBars.length - 3];
              tradeSymbol = optSym;
              log(
                `Options mode: ${optSym} (ITM-${itmDepth}) O:${patternCandle.open} H:${patternCandle.high} L:${patternCandle.low} C:${patternCandle.close}`
              );
            } else {
              log(`Options mode: waiting for option bars (${optSym})`);
              return;
            }
          }
        }

        const pattern =
          cfg.bias === 'up'
            ? detectBullishPattern(patternCandle, patternPrev)
            : detectBearishPattern(patternCandle, patternPrev);

        if (pattern) {
          // Auto target: swing high from recent option (or spot) bars
          let effectiveTarget = target;
          if (!effectiveTarget && isOptionsMode) {
            const swingBars = (optBars || bars).slice(0, -1); // exclude forming candle
            effectiveTarget = calcSwingHigh(swingBars);
            log(`Auto target (swing high): ${effectiveTarget}`);
          }
          if (!effectiveTarget) {
            log(`[SIGNAL] ${pattern} in zone but no target — set target in config`);
            return;
          }

          log(
            `[SIGNAL] ${pattern} in zone! O:${patternCandle.open} H:${patternCandle.high} L:${patternCandle.low} C:${patternCandle.close}`
          );
          const created = await createTradeAlerts(
            cdpAlerts,
            cfg.bias,
            patternCandle,
            effectiveTarget,
            sl,
            tradeSymbol,
            algotest
          );
          if (created) {
            activeTradeSymbol = tradeSymbol;
            const entryLevel = cfg.bias === 'up' ? patternCandle.high : patternCandle.low;
            const checkBars = await fetchBars(cdp, tradeSymbol, tf, 3);
            const live = checkBars[checkBars.length - 1];
            if (live) {
              const missed = cfg.bias === 'up' ? live.close > entryLevel : live.close < entryLevel;
              if (missed) {
                log(
                  `[MISSED?] Price ${live.close} already ${cfg.bias === 'up' ? 'above' : 'below'} entry ${entryLevel} — entry may have been missed`
                );
              } else {
                log(
                  `[WATCHING] Price ${live.close} — entry ${entryLevel} not yet crossed, alert is live`
                );
              }
            }
          }
        } else {
          log(
            `Candle in zone — no pattern | curr O:${patternCandle.open} H:${patternCandle.high} L:${patternCandle.low} C:${patternCandle.close} | prev O:${patternPrev.open} H:${patternPrev.high} L:${patternPrev.low} C:${patternPrev.close}`
          );
        }
      }
    }

    // ── 15-min check — fires on every new completed 15-min candle ───────────
    const bars15m = await fetchBars(cdp, symbol, '15', 4);

    if (bars15m.length >= 3) {
      const curr15 = bars15m[bars15m.length - 2];
      const prev15 = bars15m[bars15m.length - 3];

      if (curr15.time > last15mCandleTime) {
        last15mCandleTime = curr15.time;

        // ── Update nearest day level based on 15-min close ────────────────────
        await updateNearestDayLevel(cdp, curr15.close);

        // ── Zone break: 15-min close outside zone → zone not respected → pause
        const zoneBroken = cfg.bias === 'up' ? curr15.close < zone.bottom : curr15.close > zone.top;

        if (zoneBroken) {
          const boundary = cfg.bias === 'up' ? zone.bottom : zone.top;
          log(
            `[ZONE BREAK] 15-min closed ${curr15.close} ${cfg.bias === 'up' ? 'below' : 'above'} zone ${boundary} — zone not respected`
          );
          log(`[ZONE BREAK] Monitor PAUSED — reconfigure zones then set active: true`);
          cfg.active = false;
          saveConfig(cfg);
        } else {
          // ── Liquidity grab check ──────────────────────────────────────────
          const grabbedLevel = isLiquidityGrab(curr15, prev15, cfg.bias, allLevels, tolerance);

          if (grabbedLevel !== null) {
            const newBias = cfg.bias === 'up' ? 'down' : 'up';
            const dayInfo = cachedDayBars.find((d) => d.high === grabbedLevel || d.low === grabbedLevel);
            const levelDesc = dayInfo
              ? `${dayInfo.label} ${dayInfo.high === grabbedLevel ? 'H' : 'L'} (${grabbedLevel.toFixed(0)})`
              : `important level (${grabbedLevel.toFixed(0)})`;

            // Remove grabbed level — same behaviour for day levels and important levels
            if (dayInfo) {
              // Day level → add to broken set (filters it from future allLevels + chart)
              if (cfg.bias === 'up') brokenHighs.add(grabbedLevel);
              else brokenLows.add(grabbedLevel);
              lastDrawnNearestKey = ''; // force day level line to redraw without grabbed level
            } else {
              // Important level → remove from config array + save + redraw
              cfg.importantLevels = (cfg.importantLevels || []).filter(
                (l) => Math.abs(l - grabbedLevel) > 1
              );
              lastDrawnImportantKey = ''; // force important level lines to redraw
            }

            // Draw label on chart so user sees it visually
            const labelTag = dayInfo ? dayInfo.label : 'Key Level';
            await drawLiquidityGrabLabel(cdp, grabbedLevel, cfg.bias, labelTag);

            log(
              `[FLIP] Liquidity grab at ${levelDesc} → bias ${cfg.bias.toUpperCase()} → ${newBias.toUpperCase()}`
            );
            log(`[FLIP] Monitor PAUSED — update zones + target then set active: true`);
            cfg.bias = newBias;
            cfg.active = false;
            saveConfig(cfg);
          } else {
            log(
              `15-min check: no zone break, no liquidity grab (H:${curr15?.high} L:${curr15?.low})`
            );
          }
        }
      }
    }
  } catch (e) {
    log(`[ERROR] ${e.message}`);
    if (!cdp.isConnected()) {
      log('CDP disconnected — reconnecting in 5s...');
      await new Promise((r) => setTimeout(r, 5000));
      try {
        await cdp.connect();
        log('CDP reconnected');
      } catch (re) {
        log(`Reconnect failed: ${re.message} — will retry next tick`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(`\nERROR: ${CONFIG_FILE} not found.`);
    process.exit(1);
  }

  const instrName = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
  const effectiveSymbol = cfg.symbol || INSTRUMENTS[instrName];
  const effectiveTolerance = cfg.tolerance || TOLERANCE[instrName];

  console.log('\n=== Trade Setup Monitor ===');
  console.log(`Symbol     : ${effectiveSymbol}${cfg.symbol ? ' (override)' : ' (day-based)'}`);
  console.log(`Candle TF  : ${cfg.candleTimeframe || 3}-min`);
  console.log(`Tolerance  : ${effectiveTolerance}${cfg.tolerance ? ' (override)' : ' (default)'}`);
  console.log(`Market Hrs : ${cfg.ignoreMarketHours ? 'ignored (24x7 mode)' : 'IST 09:15–15:30'}`);
  console.log(`Bias       : ${cfg.bias?.toUpperCase()}`);
  const _za = cfg.zone || [];
  console.log(
    `Zone       : ${_za.length >= 2 ? `${Math.min(_za[0], _za[1])} – ${Math.max(_za[0], _za[1])}` : 'not set'}`
  );
  console.log(`Target     : ${cfg.target || 'not set'}`);
  console.log(`SL         : ${cfg.sl || 'auto (candle extreme)'}`);
  console.log(`Levels     : ${(cfg.importantLevels || []).join(', ') || 'none'}`);
  const effectiveTrailPts =
    cfg.trailToCostPoints != null
      ? cfg.trailToCostPoints
      : cfg.symbol
        ? 0
        : TRAIL_POINTS[DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY'] || 0;
  console.log(
    `Trail SL   : ${effectiveTrailPts ? `move to breakeven after +${effectiveTrailPts}pts from entry${cfg.trailToCostPoints != null ? ' (config)' : ' (default)'}` : 'disabled'}`
  );
  const at = loadAlgotest();
  console.log(
    `Algotest   : ${at.webhookUrl ? 'configured' : 'not configured (edit config/algotest-config.json)'}`
  );
  console.log(`Active     : ${cfg.active}`);
  if (!cfg.active) console.log('  ⚠  Monitor is PAUSED — configure zones then set active: true');
  console.log('\nKeys: [a] toggle active  [f] flip bias  [r] apply config now  [q] quit\n');

  process.on('uncaughtException', (e) => log(`[CRASH] ${e.message}`));
  process.on('unhandledRejection', (e) => log(`[CRASH] ${e?.message || e}`));

  log(`${'='.repeat(50)}`);
  log(`=== Monitor started ===`);
  const _startZa = cfg.zone || [];
  log(
    `Symbol: ${effectiveSymbol} | Bias: ${cfg.bias?.toUpperCase()} | Zone: ${_startZa.join('-')} | Active: ${cfg.active}`
  );

  const cdp = new CDPManager();
  try {
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    log(`CDP connect failed: ${e.message}`);
    process.exit(1);
  }

  const cdpAlerts = new AlertTools(cdp);

  let sigintPending = false;
  let sigintTimer = null;
  process.on('SIGINT', async () => {
    if (sigintPending) {
      clearTimeout(sigintTimer);
      log('Exiting...');
      await clearAllDrawings(cdp);
      await cdp.disconnect();
      process.exit(0);
    } else {
      sigintPending = true;
      log('Press Ctrl+C again within 3s to exit, or [q] to quit');
      sigintTimer = setTimeout(() => {
        sigintPending = false;
        log('Exit cancelled — still running');
      }, 3000);
    }
  });

  // Retry startup clear until chart is ready — TV Desktop can take up to ~60s to fully load
  let chartReady = false;
  for (let attempt = 1; attempt <= 12; attempt++) {
    chartReady = await clearAllDrawings(cdp);
    if (chartReady) break;
    log(`Chart not ready yet — retrying in 5s (attempt ${attempt}/12)...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!chartReady) log('Warning: chart may not be fully loaded — drawings will retry each tick');
  await new Promise((r) => setTimeout(r, 1000));

  // Draw levels on startup
  const startCfg = loadConfig();
  if (startCfg) {
    const startInstr = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
    const startSym = startCfg.symbol || INSTRUMENTS[startInstr];

    // Cache D-1..D-10 at startup then draw nearest levels using latest price
    await refreshDayBars(cdp, startSym);
    const initBars = await fetchBars(cdp, startSym, '15', 4);
    if (initBars.length >= 2) {
      await updateNearestDayLevel(cdp, initBars[initBars.length - 2].close);
    }

    // Zone + important levels only when active and config is valid
    if (startCfg.active) {
      const startErrors = validateConfig(startCfg);
      if (startErrors.length) {
        startErrors.forEach((e) => log(`[INVALID CONFIG] ${e}`));
        log('[INVALID CONFIG] Setting active:false — fix config then set active:true');
        startCfg.active = false;
        saveConfig(startCfg);
      } else {
        const _sza = startCfg.zone || [];
        const startZone =
          _sza.length >= 2
            ? { top: Math.max(_sza[0], _sza[1]), bottom: Math.min(_sza[0], _sza[1]) }
            : null;
        if (startZone) {
          const ok = await drawZone(cdp, startZone, startCfg.bias);
          if (ok) lastDrawnZoneKey = `${startZone.bottom}-${startZone.top}-${startCfg.bias}`;
        }
        if ((startCfg.importantLevels || []).length) {
          const ok = await drawImportantLevels(cdp, startCfg.importantLevels);
          if (ok) lastDrawnImportantKey = startCfg.importantLevels.join(',');
        }
      }
    }
  }

  // Auto-redraw zone + important levels when config file is saved
  let configWatchDebounce = null;
  fs.watch(CONFIG_FILE, () => {
    clearTimeout(configWatchDebounce);
    configWatchDebounce = setTimeout(async () => {
      const c = loadConfig();
      if (!c) return;

      // Ignore config changes while a trade is active
      if (lastAlertCandleTime) {
        log('[CONFIG] Trade active — config change ignored until trade ends');
        return;
      }

      if (!c.active) {
        // active=false → clear zone and important levels, keep day H/L
        log('[CONFIG] active: false — clearing zone and important levels');
        await clearZoneAndLevels(cdp);
        return;
      }

      // active=true → validate first, then redraw
      const cfgErrors = validateConfig(c);
      if (cfgErrors.length) {
        cfgErrors.forEach((e) => log(`[INVALID CONFIG] ${e}`));
        log('[INVALID CONFIG] Setting active:false — fix config then set active:true');
        c.active = false;
        saveConfig(c);
        await clearZoneAndLevels(cdp);
        return;
      }

      // valid → redraw zone + important levels if changed
      const _cza = c.zone || [];
      const z =
        _cza.length >= 2
          ? { top: Math.max(_cza[0], _cza[1]), bottom: Math.min(_cza[0], _cza[1]) }
          : null;
      const newZoneKey = z ? `${z.bottom}-${z.top}-${c.bias}` : '';
      const newImportantKey = (c.importantLevels || []).join(',');
      if (newZoneKey !== lastDrawnZoneKey || newImportantKey !== lastDrawnImportantKey) {
        log('[CONFIG] Change detected — redrawing levels...');
        if (newZoneKey !== lastDrawnZoneKey) {
          if (z?.top && z?.bottom) {
            const ok = await drawZone(cdp, z, c.bias);
            if (ok) lastDrawnZoneKey = newZoneKey;
          } else {
            lastDrawnZoneKey = newZoneKey;
          }
        }
        if (newImportantKey !== lastDrawnImportantKey) {
          const ok = await drawImportantLevels(cdp, c.importantLevels || []);
          if (ok) lastDrawnImportantKey = newImportantKey;
        }
      }
      executeTick().catch(() => {});
    }, 300);
  });

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    let ctrlCPending = false;
    let ctrlCTimer = null;

    process.stdin.on('keypress', async (_ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        if (ctrlCPending) {
          clearTimeout(ctrlCTimer);
          log('Exiting...');
          await clearAllDrawings(cdp);
          await cdp.disconnect();
          process.exit(0);
        } else {
          ctrlCPending = true;
          log('Press Ctrl+C again within 3s to exit, or [q] to quit');
          ctrlCTimer = setTimeout(() => {
            ctrlCPending = false;
            log('Exit cancelled — still running');
          }, 3000);
        }
        return;
      }
      if (key.name === 'q') {
        if (ctrlCTimer) clearTimeout(ctrlCTimer);
        log('Exiting...');
        await clearAllDrawings(cdp);
        await cdp.disconnect();
        process.exit(0);
      }
      if (key.name === 'a') {
        const c = loadConfig();
        if (c) {
          c.active = !c.active;
          saveConfig(c);
          log(`Monitor ${c.active ? 'ACTIVE' : 'PAUSED'}`);
        }
      }
      if (key.name === 'f') {
        const c = loadConfig();
        if (c) {
          c.bias = c.bias === 'up' ? 'down' : 'up';
          c.active = false;
          saveConfig(c);
          log(`[MANUAL FLIP] Bias → ${c.bias.toUpperCase()} | PAUSED — update zones + target`);
        }
      }
      if (key.name === 'r') {
        const c = loadConfig();
        if (c) {
          const _rza = c.zone || [];
          const _rz =
            _rza.length >= 2
              ? { top: Math.max(_rza[0], _rza[1]), bottom: Math.min(_rza[0], _rza[1]) }
              : null;
          log(`[REFRESH] Applying config changes immediately...`);
          lastDrawnZoneKey = '';
          lastDrawnImportantKey = '';
          if (_rz) await drawZone(cdp, _rz, c.bias);
          await drawImportantLevels(cdp, c.importantLevels || []);
        }
      }
    });
  }

  await tick(cdp, cdpAlerts);

  let tickRunning = false;

  async function executeTick() {
    if (tickRunning) {
      log('Tick skipped — previous still running');
      return;
    }
    tickRunning = true;
    try {
      await tick(cdp, cdpAlerts);
    } finally {
      tickRunning = false;
    }
  }

  async function runTick() {
    await executeTick();
    // Re-read timeframe from config so changes take effect without restart
    const nextCfg = loadConfig();
    const nextTf = parseInt(nextCfg?.candleTimeframe || 3, 10);
    const delay = msUntilNextCandleClose(nextTf);
    log(`Next tick in ${Math.round(delay / 1000)}s (at next ${nextTf}-min candle close)`);
    setTimeout(runTick, delay);
  }

  const initTf = parseInt(loadConfig()?.candleTimeframe || 3, 10);
  const firstDelay = msUntilNextCandleClose(initTf);
  log(
    `Aligned — first tick in ${Math.round(firstDelay / 1000)}s (at next ${initTf}-min candle close)`
  );
  setTimeout(runTick, firstDelay);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { createTradeAlerts };
export function _resetLastAlertCandleTime() {
  lastAlertCandleTime = null;
  tradeEntryLevel = null;
  slTrailedToBreakeven = false;
  activeTradeSymbol = null;
}
