#!/usr/bin/env node
/**
 * Trade Setup Monitor
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
 * Usage:  node monitors/trade-monitor.js
 * Keys:   [a] toggle active  [f] manual flip bias  [q] quit
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const CONFIG_FILE = './config/trade-config.json';
const ALGOTEST_FILE = './config/algotest-config.json';
const LOG_FILE = './logs/trade-monitor.log';
const POLL_MS = 60_000;

fs.mkdirSync('./logs', { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };
const INSTRUMENTS = { NIFTY: 'NSE:NIFTY', SENSEX: 'BSE:SENSEX' };
const TOLERANCE = { NIFTY: 50, SENSEX: 100 };

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
  logStream.write(line + '\n');
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
    // Shooting star or doji wicks above prev high but closes below it — near a resistance level
    const wickedAbove = curr.high > prev.high && curr.close < prev.high;
    const pattern = isShootingStar(curr) || isDoji(curr);
    const level = nearestLevel(curr.high, levels, tolerance);
    return wickedAbove && pattern && level !== null ? level : null;
  } else {
    // Hammer or doji wicks below prev low but closes above it — near a support level
    const wickedBelow = curr.low < prev.low && curr.close > prev.low;
    const pattern = isHammer(curr) || isDoji(curr);
    const level = nearestLevel(curr.low, levels, tolerance);
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
// Create trade alerts (Entry + SL + Target)
// ---------------------------------------------------------------------------
let lastAlertCandleTime = null;

async function createTradeAlerts(cdpAlerts, bias, candle, target, sl, symbol, algotest) {
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
  const exitMsg = token ? JSON.stringify({ access_token: token, alert_name: 'square_off' }) : '';

  for (const name of ['TradeEntry', 'TradeSL', 'TradeTarget']) {
    try {
      await cdpAlerts.handle('alert_delete', { alertId: name });
      await new Promise((r) => setTimeout(r, 500));
    } catch (_e) {
      /* ignore */
    }
  }

  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_up',
    level: entryLevel,
    name: 'TradeEntry',
    message: entryMsg,
    webhook,
    once: true,
  });
  await new Promise((r) => setTimeout(r, 1000));

  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_down',
    level: slLevel,
    name: 'TradeSL',
    message: exitMsg,
    webhook,
  });
  await new Promise((r) => setTimeout(r, 1000));

  await cdpAlerts.handle('alert_create', {
    symbol,
    condition: 'crosses_down',
    level: target,
    name: 'TradeTarget',
    message: exitMsg,
    webhook,
  });

  lastAlertCandleTime = candle.time;
  log(
    `  [OK] TradeEntry + TradeSL + TradeTarget created${webhook ? ' (Algotest webhook set)' : ''}`
  );
}

// ---------------------------------------------------------------------------
// Cleanup: delete remaining trade alerts once an exit alert fires
// ---------------------------------------------------------------------------
const TRADE_ALERT_NAMES = ['TradeEntry', 'TradeSL', 'TradeTarget'];

async function cleanupFiredAlerts(cdpAlerts) {
  try {
    const result = await cdpAlerts.handle('alert_list', {});
    const data = JSON.parse(result.content[0].text);
    const alerts = data.alerts || [];

    const tradeAlerts = alerts.filter((a) => TRADE_ALERT_NAMES.includes(a.name));
    if (tradeAlerts.length === 0) return;

    // If SL or Target fired (inactive/stopped) → delete all remaining trade alerts
    const exitFired = tradeAlerts.some(
      (a) => (a.name === 'TradeSL' || a.name === 'TradeTarget') && !a.active
    );
    if (!exitFired) return;

    log('[CLEANUP] Exit alert fired — deleting all trade alerts');
    for (const name of TRADE_ALERT_NAMES) {
      try {
        await cdpAlerts.handle('alert_delete', { alertId: name });
        await new Promise((r) => setTimeout(r, 300));
      } catch (_e) {
        /* ignore */
      }
    }
    lastAlertCandleTime = null;
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Draw horizontal lines on the chart for key levels
// ---------------------------------------------------------------------------
let drawnLevelIds = [];

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
    (function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { error: 'Drawing API not available' };
        const levels = ${JSON.stringify(levelObjects)};
        const ids = [];
        for (const { price, label, color } of levels) {
          try {
            const id = chart.createShape(
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
    log(`Drew ${result.ids.length} level lines on chart`);
  } else {
    log(`Level lines: ${result?.error || 'drawing API not available'}`);
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------
let last15mCheckAt = 0;
let cachedDayLevels = []; // refreshed once per day
let lastDayLevelDate = '';

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

    // Clean up any remaining alerts if an exit alert already fired
    if (lastAlertCandleTime) await cleanupFiredAlerts(cdpAlerts);

    const instrName = DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY';
    const symbol = cfg.symbol || INSTRUMENTS[instrName];
    const tolerance = cfg.tolerance || TOLERANCE[instrName];
    const zone = cfg.bias === 'up' ? cfg.buyZone : cfg.sellZone;
    const target = cfg.bias === 'up' ? cfg.buyTarget : cfg.sellTarget;
    const sl = cfg.bias === 'up' ? cfg.buySL || 0 : cfg.sellSL || 0;
    const algotest = loadAlgotest();

    if (!zone || !zone.top || !zone.bottom) {
      log(`Zone not configured — edit trade-config.json`);
      return;
    }
    if (!target) {
      log(`Target not configured — edit trade-config.json`);
      return;
    }

    const slDesc = sl ? String(sl) : 'auto (candle extreme)';
    log(
      `${instrName} | bias:${cfg.bias.toUpperCase()} | zone:${zone.bottom}-${zone.top} | target:${target} | SL:${slDesc}`
    );

    // ── Refresh last 3 days H/L once per day ──────────────────────────────
    const todayStr = nowIST().toISOString().slice(0, 10);
    if (todayStr !== lastDayLevelDate) {
      const dailyBars = await fetchBars(cdp, symbol, 'D', 5);
      const completed = dailyBars.slice(0, -1).slice(-3); // exclude today's forming bar
      cachedDayLevels = completed.flatMap((b) => [b.high, b.low]);
      lastDayLevelDate = todayStr;
      log(`Day levels (last 3 days): ${cachedDayLevels.map((l) => l.toFixed(0)).join(', ')}`);

      // Draw horizontal lines on chart — D-1 is yesterday, D-2 two days ago, D-3 three days ago
      const levelObjects = completed.flatMap((b, i) => [
        { price: b.high, label: `D-${3 - i} H`, color: '#FF4444' },
        { price: b.low, label: `D-${3 - i} L`, color: '#22BB44' },
      ]);
      await drawDayLevels(cdp, levelObjects);
    }

    const allLevels = [...cachedDayLevels, ...(cfg.importantLevels || [])];

    // ── 1-min pattern check ────────────────────────────────────────────────
    const bars1m = await fetchBars(cdp, symbol, '1', 5);

    if (bars1m.length < 3) {
      log('Not enough 1-min bars');
    } else {
      const curr = bars1m[bars1m.length - 2]; // last completed candle
      const prev = bars1m[bars1m.length - 3];

      // ── Zone break: 1-min close below/above zone → pause, user must re-enable
      const zoneBroken = cfg.bias === 'up' ? curr.close < zone.bottom : curr.close > zone.top;

      if (zoneBroken) {
        const boundary = cfg.bias === 'up' ? zone.bottom : zone.top;
        log(
          `[ZONE BREAK] 1-min closed ${curr.close} ${cfg.bias === 'up' ? 'below' : 'above'} zone ${boundary} — pausing`
        );
        log(`[ZONE BREAK] Monitor PAUSED — reconfigure zones then set active: true`);
        cfg.active = false;
        saveConfig(cfg);
      } else if (!isInZone(curr, zone)) {
        log(`1-min candle H:${curr.high} L:${curr.low} — outside zone`);
      } else {
        const pattern =
          cfg.bias === 'up' ? detectBullishPattern(curr, prev) : detectBearishPattern(curr, prev);

        if (pattern) {
          log(
            `[SIGNAL] ${pattern} in zone! O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close}`
          );
          await createTradeAlerts(cdpAlerts, cfg.bias, curr, target, sl, symbol, algotest);
        } else {
          log(
            `Candle in zone — no pattern (O:${curr.open} H:${curr.high} L:${curr.low} C:${curr.close})`
          );
        }
      }
    }

    // ── 15-min liquidity grab check (every 15 min) ─────────────────────────
    if (Date.now() - last15mCheckAt >= 15 * 60 * 1000) {
      last15mCheckAt = Date.now();

      const bars15m = await fetchBars(cdp, symbol, '15', 4);

      if (bars15m.length >= 3) {
        const curr15 = bars15m[bars15m.length - 2];
        const prev15 = bars15m[bars15m.length - 3];

        // ── Liquidity grab check ────────────────────────────────────────────
        const grabbedLevel = isLiquidityGrab(curr15, prev15, cfg.bias, allLevels, tolerance);

        if (grabbedLevel !== null) {
          const newBias = cfg.bias === 'up' ? 'down' : 'up';
          log(
            `[FLIP] Liquidity grab near level ${grabbedLevel} → bias ${cfg.bias.toUpperCase()} → ${newBias.toUpperCase()}`
          );
          log(`[FLIP] Monitor PAUSED — update zones + target then set active: true`);
          cfg.bias = newBias;
          cfg.active = false;
          saveConfig(cfg);
        } else {
          log(`15-min check: no liquidity grab (H:${curr15?.high} L:${curr15?.low})`);
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
  console.log(`Tolerance  : ${effectiveTolerance}${cfg.tolerance ? ' (override)' : ' (default)'}`);
  console.log(`Market Hrs : ${cfg.ignoreMarketHours ? 'ignored (24x7 mode)' : 'IST 09:15–15:30'}`);
  console.log(`Bias       : ${cfg.bias?.toUpperCase()}`);
  console.log(`Buy Zone   : ${cfg.buyZone?.bottom} – ${cfg.buyZone?.top}`);
  console.log(`Sell Zone  : ${cfg.sellZone?.bottom} – ${cfg.sellZone?.top}`);
  console.log(`Buy Target : ${cfg.buyTarget}`);
  console.log(`Sell Target: ${cfg.sellTarget}`);
  console.log(`Buy SL     : ${cfg.buySL || 'auto (candle low)'}`);
  console.log(`Sell SL    : ${cfg.sellSL || 'auto (candle high)'}`);
  console.log(`Levels     : ${(cfg.importantLevels || []).join(', ') || 'none'}`);
  const at = loadAlgotest();
  console.log(
    `Algotest   : ${at.webhookUrl ? 'configured' : 'not configured (edit config/algotest-config.json)'}`
  );
  console.log(`Active     : ${cfg.active}`);
  if (!cfg.active) console.log('  ⚠  Monitor is PAUSED — configure zones then set active: true');
  console.log('\nKeys: [a] toggle active  [f] manual flip bias  [q] quit\n');

  process.on('uncaughtException', (e) => log(`[CRASH] ${e.message}`));
  process.on('unhandledRejection', (e) => log(`[CRASH] ${e?.message || e}`));

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

    let ctrlCPending = false;
    let ctrlCTimer = null;

    process.stdin.on('keypress', async (_ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        if (ctrlCPending) {
          clearTimeout(ctrlCTimer);
          log('Exiting...');
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
    });
  }

  await tick(cdp, cdpAlerts);

  let tickRunning = false;
  setInterval(async () => {
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
  }, POLL_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
