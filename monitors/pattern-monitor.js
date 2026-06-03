#!/usr/bin/env node
/**
 * Pattern Monitor (v2 — simplified)
 *
 * Every candle close:
 *   1. Read last completed candle on configured timeframe
 *   2. If candle is inside zone → detect pattern
 *   3. If pattern found → update 3 pre-existing TradingView alerts
 *
 * Patterns: Hammer, Doji, BullishEngulfing (bias=up) | ShootingStar, Doji (bias=down)
 * Alerts:   niftyPatternLongEntry / niftyPatternLongSL / niftyPatternLongTarget
 *           sensexPatternLongEntry / sensexPatternLongSL / sensexPatternLongTarget
 *
 * Config:   config/pattern-monitor-config.json  (re-read every tick)
 * Keys:     [a] toggle active   [q] quit
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONFIG_FILE = './config/pattern-monitor-config.json';
const LOG_FILE    = './logs/pattern-monitor.log';

const INSTRUMENTS = {
  NIFTY:  'NSE:NIFTY',
  SENSEX: 'BSE:SENSEX',
};

const ALERT_NAMES = {
  NIFTY: {
    entry:  'niftyPatternLongEntry',
    sl:     'niftyPatternLongSL',
    target: 'niftyPatternLongTarget',
  },
  SENSEX: {
    entry:  'sensexPatternLongEntry',
    sl:     'sensexPatternLongSL',
    target: 'sensexPatternLongTarget',
  },
};

const MARKET_OPEN_MIN  = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

// ---------------------------------------------------------------------------
// IST helpers
// ---------------------------------------------------------------------------
function nowIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000);
}

function isMarketHours() {
  const t   = nowIST();
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  return min >= MARKET_OPEN_MIN && min <= MARKET_CLOSE_MIN;
}

function timeStr() {
  const t = nowIST();
  return [t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
fs.mkdirSync('./logs', { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(msg) {
  const line = `[${timeStr()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
function msUntilNextCandle(tfMinutes) {
  const ms = tfMinutes * 60 * 1000;
  return ms - (Date.now() % ms);
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------
function isHammer(c) {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (!range || !body) return false;
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return lower >= 2 * body && upper <= body;
}

function isShootingStar(c) {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (!range || !body) return false;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper >= 2 * body && lower <= body;
}

function isDoji(c) {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  return range > 0 && body <= range * 0.1;
}

function isBullishEngulfing(curr, prev) {
  return (
    curr.close > curr.open &&
    prev.close < prev.open &&
    curr.open  <= prev.close &&
    curr.close >= prev.open
  );
}

function detectPattern(bias, curr, prev) {
  if (bias === 'up') {
    if (isHammer(curr))                      return 'Hammer';
    if (isDoji(curr))                        return 'Doji';
    if (prev && isBullishEngulfing(curr, prev)) return 'BullishEngulfing';
  } else {
    if (isShootingStar(curr)) return 'ShootingStar';
    if (isDoji(curr))         return 'Doji';
  }
  return null;
}

function isInZone(candle, zone) {
  return candle.low <= zone.top && candle.high >= zone.bottom;
}

// ---------------------------------------------------------------------------
// Fetch OHLCV bars from TradingView chart
// ---------------------------------------------------------------------------
async function fetchBars(cdp, symbol, timeframe, limit) {
  const script = `
    (async function() {
      try {
        const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
        if (!widget) return { bars: [] };

        const prevSymbol = widget.symbol?.() || '';
        const prevTf     = widget.resolution?.() || '';
        const needSymbol = prevSymbol !== '${symbol}';
        const needTf     = prevTf     !== '${timeframe}';

        if (needSymbol) {
          for (const m of ['setSymbol','changeSymbol','setTicker'])
            if (typeof widget[m] === 'function') { widget[m]('${symbol}'); break; }
          await new Promise(r => setTimeout(r, 1800));
        }
        if (needTf) {
          for (const m of ['setResolution','setInterval','changeResolution'])
            if (typeof widget[m] === 'function') { widget[m]('${timeframe}'); break; }
          await new Promise(r => setTimeout(r, 1800));
        }

        const model = widget?._chartWidget?._modelWV?._value;
        const store = model?.mainSeries?.()?.bars?.();
        const bars  = [];
        if (store && store.size() > 0) {
          const last = store.lastIndex();
          const from = Math.max(store.firstIndex(), last - ${limit} + 1);
          for (let i = from; i <= last; i++) {
            const b = store.valueAt(i);
            const v = Array.isArray(b) ? b : (b?.value || []);
            if (v.length >= 5)
              bars.push({ time: +v[0], open: +v[1], high: +v[2], low: +v[3], close: +v[4] });
          }
        }

        if (needTf) {
          for (const m of ['setResolution','setInterval','changeResolution'])
            if (typeof widget[m] === 'function') { widget[m](prevTf); break; }
          await new Promise(r => setTimeout(r, 500));
        }
        if (needSymbol) {
          for (const m of ['setSymbol','changeSymbol','setTicker'])
            if (typeof widget[m] === 'function') { widget[m](prevSymbol); break; }
          await new Promise(r => setTimeout(r, 500));
        }

        return { bars };
      } catch (e) { return { bars: [], error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(script);
  return result?.bars || [];
}

// ---------------------------------------------------------------------------
// Zone drawing
// ---------------------------------------------------------------------------
let drawnZoneIds = [];
let lastZoneKey  = '';

async function drawZone(cdp, zone, bias) {
  if (drawnZoneIds.length) {
    const ids = JSON.stringify(drawnZoneIds);
    await cdp.executeScript(
      `(function(){try{const c=window.TradingViewApi?.activeChart?.();${ids}.forEach(id=>{try{c.removeEntity(id)}catch(_){}});}catch(_){}})() `
    ).catch(() => {});
    drawnZoneIds = [];
  }

  const color  = bias === 'up' ? '#FFD700' : '#FF6B6B';
  const script = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { ids: [] };
        const ids = [];
        for (const price of [${zone.top}, ${zone.bottom}]) {
          const id = await chart.createShape(
            { time: Math.floor(Date.now() / 1000), price },
            { shape: 'horizontal_line', lock: false,
              overrides: { linecolor: '${color}', linewidth: 3, linestyle: 0, showLabel: false } }
          );
          if (id) ids.push(id);
        }
        return { ids };
      } catch (e) { return { ids: [], error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(script).catch(() => null);
  if (result?.ids?.length) {
    drawnZoneIds = result.ids;
    log(`Zone drawn: ${zone.bottom} - ${zone.top}`);
    return true;
  }
  log(`Zone draw failed: ${result?.error || 'unknown'}`);
  return false;
}

async function clearDrawings(cdp) {
  const script = `
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart) return false;
        if (typeof chart.removeAllShapes === 'function') { chart.removeAllShapes(); return true; }
        if (typeof chart.getAllShapes === 'function') {
          (chart.getAllShapes() || []).forEach(s => { try { chart.removeEntity(s.id); } catch(_) {} });
          return true;
        }
        return false;
      } catch (_) { return false; }
    })()
  `;
  const ok = await cdp.executeScript(script).catch(() => false);
  drawnZoneIds = [];
  lastZoneKey  = '';
  if (ok) log('Chart cleared');
}

// ---------------------------------------------------------------------------
// Alert update
// ---------------------------------------------------------------------------
async function updateAlerts(cdpAlerts, names, symbol, entry, sl, target) {
  const parse = r => {
    try { return JSON.parse(r?.content?.[0]?.text || '{}'); } catch (_) { return {}; }
  };

  await cdpAlerts.normalizeAlertsPanel();

  const r1 = await cdpAlerts.handle('alert_update', { alertName: names.entry,  symbol, level: entry  });
  const d1 = parse(r1);
  log(`  [Entry]  ${d1.success ? 'OK' : 'FAIL'} @ ${entry}  — ${d1.message || d1.error || ''}`);
  if (!d1.success) { log('  Aborting — entry update failed'); return false; }
  await new Promise(r => setTimeout(r, 500));

  const r2 = await cdpAlerts.handle('alert_update', { alertName: names.sl,     symbol, level: sl     });
  const d2 = parse(r2);
  log(`  [SL]     ${d2.success ? 'OK' : 'FAIL'} @ ${sl}     — ${d2.message || d2.error || ''}`);
  if (!d2.success) { log('  Aborting — SL update failed'); return false; }
  await new Promise(r => setTimeout(r, 500));

  const r3 = await cdpAlerts.handle('alert_update', { alertName: names.target, symbol, level: target });
  const d3 = parse(r3);
  log(`  [Target] ${d3.success ? 'OK' : 'FAIL'} @ ${target} — ${d3.message || d3.error || ''}`);

  return d1.success && d2.success && d3.success;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------
let lastSignalCandleTime = null;

async function tick(cdp, cdpAlerts) {
  if (!cdp.isConnected()) throw new Error('CDP not connected');

  const cfg = loadConfig();
  if (!cfg) { log('Config missing'); return; }

  if (!cfg.ignoreMarketHours && !isMarketHours()) {
    log('Outside market hours — waiting');
    return;
  }

  if (!cfg.active) {
    log('Paused (active: false) — set active:true to resume');
    return;
  }

  const instr  = (cfg.instrument || 'NIFTY').toUpperCase();
  const symbol = INSTRUMENTS[instr] || INSTRUMENTS.NIFTY;
  const names  = ALERT_NAMES[instr]  || ALERT_NAMES.NIFTY;
  const tf     = String(cfg.candleTimeframe || 3);

  const zoneArr = cfg.zone || [];
  if (zoneArr.length < 2) { log('zone not set in config'); return; }
  const zone = { top: Math.max(...zoneArr), bottom: Math.min(...zoneArr) };

  // Redraw zone lines if zone or bias changed
  const zoneKey = `${zone.bottom}-${zone.top}-${cfg.bias}`;
  if (zoneKey !== lastZoneKey) {
    const ok = await drawZone(cdp, zone, cfg.bias);
    if (ok) lastZoneKey = zoneKey;
  }

  // Fetch last 5 candles (need at least 3: prev, curr completed, live)
  const bars = await fetchBars(cdp, symbol, tf, 5);
  if (bars.length < 3) { log(`Not enough ${tf}-min bars (got ${bars.length})`); return; }

  const curr = bars[bars.length - 2]; // last completed candle
  const prev = bars[bars.length - 3];

  log(`${instr} | bias:${cfg.bias.toUpperCase()} | zone:${zone.bottom}-${zone.top} | O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close}`);

  if (!isInZone(curr, zone)) {
    log('Candle outside zone — no action');
    return;
  }

  if (curr.time === lastSignalCandleTime) {
    log('Signal already fired for this candle — skipping');
    return;
  }

  const pattern = detectPattern(cfg.bias, curr, prev);
  if (!pattern) {
    log(`Candle in zone — no pattern (curr O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close})`);
    return;
  }

  // Entry / SL from candle extremes
  const entry = cfg.bias === 'up' ? curr.high : curr.low;
  const sl    = cfg.bias === 'up' ? curr.low  : curr.high;

  // Target: use config value if set, otherwise auto swing high from completed bars
  const completedBars = bars.slice(0, -1); // exclude live candle
  const swingHigh     = Math.max(...completedBars.map(b => b.high));
  const swingLow      = Math.min(...completedBars.map(b => b.low));
  const autoTarget    = cfg.bias === 'up' ? swingHigh : swingLow;
  const target        = cfg.target || autoTarget;

  log(`[SIGNAL] ${pattern} in zone | Entry:${entry}  SL:${sl}  Target:${target}`);

  const ok = await updateAlerts(cdpAlerts, names, symbol, entry, sl, target);
  if (ok) {
    lastSignalCandleTime = curr.time;
    log('All 3 alerts updated ✓');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(`ERROR: ${CONFIG_FILE} not found`);
    process.exit(1);
  }

  log('='.repeat(50));
  log('=== Pattern Monitor started ===');
  log(`Instrument: ${cfg.instrument || 'NIFTY'} | Bias: ${cfg.bias} | Zone: ${cfg.zone} | TF: ${cfg.candleTimeframe || 3}min | Active: ${cfg.active}`);

  // Connect to a dedicated chart tab (avoids stomping on supertrend's tab)
  let cdp;
  try {
    const tabId = await CDPManager.ensureMonitorTab('./logs/pattern-tab.json', 9222, [
      './logs/supertrend-tab.json',
    ]);
    cdp = new CDPManager(tabId, './logs/pattern-tab.json');
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    log(`CDP connect failed: ${e.message}`);
    process.exit(1);
  }

  const cdpAlerts = new AlertTools(cdp);

  // Clear all chart drawings on startup (retry until chart is ready)
  for (let i = 1; i <= 12; i++) {
    const ok = await cdp.executeScript(
      `(function(){try{const c=window.TradingViewApi?.activeChart?.();if(!c)return false;if(typeof c.removeAllShapes==='function'){c.removeAllShapes();return true;}return false;}catch(_){return false;}})() `
    ).catch(() => false);
    if (ok) { log('Chart cleared'); break; }
    log(`Chart not ready — retrying (${i}/12)...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Watch config file — redraw zone when it changes
  let watchDebounce = null;
  fs.watch(CONFIG_FILE, () => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(async () => {
      const c = loadConfig();
      if (!c) return;
      log('[CONFIG] Changed');
      lastZoneKey = ''; // force zone redraw on next tick
      if (c.active) {
        const za = c.zone || [];
        if (za.length >= 2) {
          const z  = { top: Math.max(...za), bottom: Math.min(...za) };
          const ok = await drawZone(cdp, z, c.bias);
          if (ok) lastZoneKey = `${z.bottom}-${z.top}-${c.bias}`;
        }
      }
    }, 300);
  });

  // Keyboard controls
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (_ch, key) => {
      if (!key) return;
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        log('Exiting...');
        await clearDrawings(cdp);
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
    });
  }

  process.on('uncaughtException',  e => log(`[CRASH] ${e.message}`));
  process.on('unhandledRejection', e => log(`[CRASH] ${e?.message || e}`));

  // Tick loop
  let tickRunning = false;

  async function runTick() {
    if (!tickRunning) {
      tickRunning = true;
      try {
        await tick(cdp, cdpAlerts);
      } catch (e) {
        log(`[ERROR] ${e.message}`);
        if (!cdp.isConnected()) {
          log('CDP disconnected — reconnecting in 5s...');
          await new Promise(r => setTimeout(r, 5000));
          try {
            await cdp.connect();
            log('CDP reconnected');
          } catch (_) {
            log('Reconnect failed — will retry next tick');
          }
        }
      } finally {
        tickRunning = false;
      }
    }

    const nextCfg = loadConfig();
    const nextTf  = parseInt(nextCfg?.candleTimeframe || 3, 10);
    const delay   = msUntilNextCandle(nextTf) + 2000;
    log(`Next tick in ${Math.round(delay / 1000)}s`);
    setTimeout(runTick, delay);
  }

  const initTf     = parseInt(cfg.candleTimeframe || 3, 10);
  const firstDelay = msUntilNextCandle(initTf) + 2000;
  log(`First tick in ${Math.round(firstDelay / 1000)}s (at next ${initTf}-min candle close)`);
  setTimeout(runTick, firstDelay);
}

main().catch(e => { console.error(e); process.exit(1); });
