#!/usr/bin/env node
/**
 * Intraday Alert Monitor — NIFTY & SENSEX
 *
 * Mon/Tue/Fri → NIFTY  (strike step 50, expiry Tuesday)
 * Wed/Thu     → SENSEX (strike step 100, expiry Thursday)
 *
 * Polls spot price every 60s during market hours.
 * Updates the 4 Supertrend alert symbols to the new ITM-2 strike
 * only when ATM shifts or the instrument changes day-to-day.
 *
 * Position state is tracked by reading TradingView's alert history:
 *   supertrendLongEntry / supertrendshortEntry  → position OPEN
 *   supertrendLongExit  / supertrendShortExit   → position CLOSED
 *
 * Usage:  node monitor.js
 *         node monitor.js --ce open      (manual override: mark CE as open)
 *         node monitor.js --pe closed    (manual override: mark PE as closed)
 *         node monitor.js --itm 0        (force ATM strike, overrides day rule)
 *         node monitor.js --itm 1        (force ITM-1, overrides day rule)
 *         node monitor.js --itm 2        (force ITM-2, overrides day rule)
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const POLL_MS = 60_000;
const STATE_FILE = './position.json';

const CE_ALERTS = { entry: 'supertrendLongEntry', exit: 'supertrendLongExit' };
const PE_ALERTS = { entry: 'supertrendshortEntry', exit: 'supertrendShortExit' };

// Day-of-week instrument routing (IST weekday: 1=Mon … 5=Fri)
export const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };

// NIFTY ITM depth by day: Mon/Tue closer to expiry → ITM-1; Fri further → ITM-2
export const NIFTY_ITM_BY_DAY = { 1: 1, 2: 1, 5: 2 };

// Returns ITM depth for given day + instrument (override via CLI --itm flag)
export function calcITMDepth(dayOfWeek, instrument, cliOverride = null) {
  if (cliOverride !== null) return cliOverride;
  if (instrument === 'SENSEX') return 2;
  return NIFTY_ITM_BY_DAY[dayOfWeek] ?? 2;
}

export const INSTRUMENTS = {
  NIFTY: {
    name: 'NIFTY',
    spotSymbol: 'NSE:NIFTY',
    strikeInterval: 50,
    itmDepth: 2,
    expiryDay: 2, // Tuesday
    symbolPrefix: 'NIFTY',
  },
  SENSEX: {
    name: 'SENSEX',
    spotSymbol: 'BSE:SENSEX',
    strikeInterval: 100,
    itmDepth: 2,
    expiryDay: 4, // Thursday (holiday shifts handled automatically)
    symbolPrefix: 'BSX',
  },
};

// IST = UTC + 5h30m
const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowIST() {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs);
}

function isMarketHours() {
  const t = nowIST();
  const day = t.getUTCDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return false;
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  return min >= MARKET_OPEN_MIN && min <= MARKET_CLOSE_MIN;
}

function istTimeStr() {
  const t = nowIST();
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
}

function log(msg) {
  console.log(`[${istTimeStr()}] ${msg}`);
}

export function calcATM(spot, strikeInterval) {
  return Math.round(spot / strikeInterval) * strikeInterval;
}

// Load NSE holidays from holidays.json — returns a Set of 'YYYY-MM-DD' strings
export function loadHolidays() {
  try {
    const raw = JSON.parse(fs.readFileSync('./config/holidays.json', 'utf8'));
    return new Set(raw.holidays || []);
  } catch {
    return new Set();
  }
}

function toDateStr(d) {
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getExpiryDate(expiryDay) {
  const t = nowIST();
  const day = t.getUTCDay();
  const daysUntil = (expiryDay - day + 7) % 7;

  const target = new Date(t);
  target.setUTCDate(t.getUTCDate() + daysUntil);

  // If expiry day is a holiday, shift back to the previous trading day
  const holidays = loadHolidays();
  let expiry = new Date(target);
  while (holidays.has(toDateStr(expiry)) || expiry.getUTCDay() === 0 || expiry.getUTCDay() === 6) {
    expiry.setUTCDate(expiry.getUTCDate() - 1);
  }
  return expiry;
}

export function buildSymbol(cfg, strike, type) {
  const d = getExpiryDate(cfg.expiryDay);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${cfg.symbolPrefix}${yy}${mm}${dd}${type === 'CE' ? 'C' : 'P'}${strike}`;
}

// ---------------------------------------------------------------------------
// Config file (re-read every tick so live edits apply within 60s)
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync('./config/monitor-config.json', 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
let state = {
  CE: 'closed',
  PE: 'closed',
  lastATM: null,
  lastInstrument: null,
  lastITMDepth: null,
  seenHistoryKeys: [],
};
let itmOverride = null; // set by --itm CLI flag (highest priority)

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
    }
  } catch (_e) {
    /* ignore missing/corrupt state file */
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// CDP scripts
// ---------------------------------------------------------------------------
// Gets spot price by briefly switching chart to the given symbol, reading price, then restoring.
// Takes ~3s but is reliable regardless of watchlist/layout state.
async function getSpot(cdp, spotSymbol) {
  const script = `
    (async function() {
      try {
        const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
        if (!widget) return { price: null, error: 'No chart widget' };

        // Save current symbol so we can restore it
        const prevSymbol = widget.symbol?.() || '';

        // Switch to target spot index
        const setMethods = ['setSymbol', 'changeSymbol', 'setTicker'];
        let switched = false;
        for (const m of setMethods) {
          if (typeof widget[m] === 'function') {
            widget[m]('${spotSymbol}');
            switched = true;
            break;
          }
        }
        if (!switched) return { price: null, error: 'No setSymbol method on widget' };

        // Wait for chart to load
        await new Promise(r => setTimeout(r, 2000));

        // Read last close from bars store
        let price = null;
        const model = widget?._chartWidget?._modelWV?._value;
        const barsStore = model?.mainSeries?.()?.bars?.();
        if (barsStore && barsStore.size() > 0) {
          const b = barsStore.valueAt(barsStore.lastIndex());
          const v = Array.isArray(b) ? b : (b?.value || []);
          if (v.length >= 5) price = v[4]; // close
        }

        // Fallback: chart legend
        if (!price || price < 10000) {
          const center = document.querySelector('.layout__area--center');
          const lines = (center?.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i] === 'C') {
              const p = parseFloat((lines[i+1] || '').replace(/,/g,''));
              if (p > 10000) { price = p; break; }
            }
          }
        }

        // Restore previous symbol
        if (prevSymbol && prevSymbol !== '${spotSymbol}') {
          for (const m of setMethods) {
            if (typeof widget[m] === 'function') { widget[m](prevSymbol); break; }
          }
          await new Promise(r => setTimeout(r, 1500));
        }

        return { price, prevSymbol, source: 'chart_switch' };
      } catch (e) {
        return { price: null, error: e.message };
      }
    })()
  `;
  const result = await cdp.executeScript(script);
  return result?.price || null;
}

const ALERT_HISTORY_SCRIPT = `
  (function() {
    try {
      const selectors = [
        '[data-name="alert-log-item"]',
        '[data-name="alert-history-item"]',
        '[class*="alertLogItem"]',
        '[class*="historyItem"]',
      ];
      let items = [];
      for (const sel of selectors) {
        items = Array.from(document.querySelectorAll(sel));
        if (items.length) break;
      }

      return items.slice(0, 30).map(el => ({
        name:    el.querySelector('[data-name="alert-log-item-name"]')?.innerText?.trim()   ||
                 el.querySelector('[class*="name"]')?.innerText?.trim()    || '',
        time:    el.querySelector('[data-name="alert-log-item-time"]')?.innerText?.trim()   ||
                 el.querySelector('[class*="time"]')?.innerText?.trim()    || '',
        symbol:  el.querySelector('[data-name="alert-log-item-symbol"]')?.innerText?.trim() ||
                 el.querySelector('[class*="symbol"]')?.innerText?.trim()  || '',
      }));
    } catch (e) {
      return [];
    }
  })()
`;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------
async function updateAlerts(cdpChart, cdpAlerts, side, strike, cfg) {
  const alertDefs = side === 'CE' ? CE_ALERTS : PE_ALERTS;
  const symbol = buildSymbol(cfg, strike, side);
  const results = [];

  // Switch chart to the target symbol so it appears as $ChartMainSeries$ in the alert dropdown.
  // The dropdown only shows: alert's current symbol + chart's current main symbol.
  log(`  Switching chart to ${symbol}`);
  await cdpChart.handle('chart_set_symbol', { symbol: `NSE:${symbol}` });
  // Wait for TradingView to settle after chart switch before interacting with alerts panel
  await new Promise((r) => setTimeout(r, 3000));

  for (const [role, name] of Object.entries(alertDefs)) {
    log(`  Updating ${side} ${role}: "${name}" → ${symbol}`);
    let lastResult = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        log(`  Retrying ${name} (attempt 2)...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        const r = await cdpAlerts.handle('alert_update_symbol', { alertName: name, symbol });
        if (r?.isError) {
          lastResult = {
            name,
            symbol,
            success: false,
            error: r?.content?.[0]?.text || 'unknown error',
          };
        } else {
          const data = JSON.parse(r?.content?.[0]?.text || '{}');
          lastResult = { name, symbol, success: data.success, message: data.message };
        }
      } catch (e) {
        lastResult = { name, symbol, success: false, error: e.message };
      }
      if (lastResult?.success) break;
    }
    if (lastResult?.success) {
      log(`  [OK] ${name} → ${symbol}`);
    } else {
      log(`  [WARN] ${name}: ${lastResult?.error || lastResult?.message || 'failed'}`);
    }
    results.push(lastResult);
    // Gap between edit dialogs — allow TV to settle after save animation
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results;
}

function processHistoryForPositionChanges(historyItems) {
  const seenSet = new Set(state.seenHistoryKeys);
  let changed = false;

  for (const item of historyItems) {
    const key = `${item.name}|${item.time}`;
    if (seenSet.has(key)) continue;
    seenSet.add(key);

    const name = item.name;
    if (name === CE_ALERTS.entry) {
      if (state.CE !== 'open') {
        state.CE = 'open';
        changed = true;
        log(`[POSITION] CE OPENED  (alert: ${name})`);
      }
    } else if (name === CE_ALERTS.exit) {
      if (state.CE !== 'closed') {
        state.CE = 'closed';
        changed = true;
        log(`[POSITION] CE CLOSED  (alert: ${name})`);
      }
    } else if (name === PE_ALERTS.entry) {
      if (state.PE !== 'open') {
        state.PE = 'open';
        changed = true;
        log(`[POSITION] PE OPENED  (alert: ${name})`);
      }
    } else if (name === PE_ALERTS.exit) {
      if (state.PE !== 'closed') {
        state.PE = 'closed';
        changed = true;
        log(`[POSITION] PE CLOSED  (alert: ${name})`);
      }
    }
  }

  // Keep only last 200 seen keys to avoid unbounded growth
  state.seenHistoryKeys = [...seenSet].slice(-200);
  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Parse CLI overrides: node monitor.js --ce open --pe closed --itm 1
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--ce') state.CE = argv[i + 1] === 'open' ? 'open' : 'closed';
    if (argv[i] === '--pe') state.PE = argv[i + 1] === 'open' ? 'open' : 'closed';
    if (argv[i] === '--itm') {
      const v = parseInt(argv[i + 1], 10);
      itmOverride = [0, 1, 2].includes(v) ? v : null; // 0=ATM, 1=ITM-1, 2=ITM-2
    }
  }

  loadState();

  const todayInstr = INSTRUMENTS[DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY'];
  console.log('\n=== Intraday Alert Monitor (NIFTY / SENSEX) ===');
  console.log(`Today's instrument : ${todayInstr.name}  (spot: ${todayInstr.spotSymbol})`);
  console.log(
    `Strike step        : ${todayInstr.strikeInterval}  |  ITM depth : ${todayInstr.itmDepth}  |  Poll : ${POLL_MS / 1000}s`
  );
  console.log(`CE alerts          : ${CE_ALERTS.entry} / ${CE_ALERTS.exit}`);
  console.log(`PE alerts          : ${PE_ALERTS.entry} / ${PE_ALERTS.exit}`);
  console.log(`Position state     : CE=${state.CE.toUpperCase()}  PE=${state.PE.toUpperCase()}`);
  const startConfig = loadConfig();
  const startConfigItm = [0, 1, 2].includes(startConfig.itmOverride)
    ? startConfig.itmOverride
    : null;
  const startEffective = itmOverride !== null ? itmOverride : startConfigItm;
  const todayDepth = startEffective ?? calcITMDepth(nowIST().getUTCDay(), todayInstr.name);
  const itmSource =
    itmOverride !== null
      ? '(--itm flag)'
      : startConfigItm !== null
        ? '(monitor-config.json)'
        : '(day-based)';
  console.log(`ITM depth          : ITM-${todayDepth}  ${itmSource}`);
  console.log(
    `Last ATM           : ${state.lastATM || 'unknown'}  (${state.lastInstrument || 'unknown'}, ITM-${state.lastITMDepth ?? '?'})`
  );
  console.log(
    '\nKeys: [c] toggle CE position  [p] toggle PE position  [u] force update  [q] quit\n'
  );

  const cdp = new CDPManager();
  try {
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart = new ChartTools(cdp);

  // Keyboard shortcuts
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (ch, key) => {
      if (!key) return;
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        log('Exiting...');
        saveState();
        await cdp.disconnect();
        process.exit(0);
      }
      if (key.name === 'c') {
        state.CE = state.CE === 'open' ? 'closed' : 'open';
        saveState();
        log(`[MANUAL] CE position set to ${state.CE.toUpperCase()}`);
      }
      if (key.name === 'p') {
        state.PE = state.PE === 'open' ? 'closed' : 'open';
        saveState();
        log(`[MANUAL] PE position set to ${state.PE.toUpperCase()}`);
      }
      if (key.name === 'u') {
        log('[MANUAL] Force update triggered');
        await tick(cdp, cdpChart, cdpAlerts, true);
      }
    });
  }

  let forceFirst = true;

  async function tick(cdp, cdpChart, cdpAlerts, force = false) {
    try {
      if (!isMarketHours() && !force) {
        log('Outside market hours — waiting');
        return;
      }

      // 1. Determine today's instrument (NIFTY Mon/Tue/Fri, SENSEX Wed/Thu)
      const dayOfWeek = nowIST().getUTCDay();
      const instrName = DAY_INSTRUMENT[dayOfWeek] || 'NIFTY';
      const cfg = INSTRUMENTS[instrName];

      // Priority: CLI --itm > monitor-config.json itmOverride > day-based rule
      const config = loadConfig();
      const configItm = [0, 1, 2].includes(config.itmOverride) ? config.itmOverride : null;
      const effectiveOverride = itmOverride !== null ? itmOverride : configItm;
      const itmDepth = calcITMDepth(dayOfWeek, instrName, effectiveOverride);
      const instrChanged = state.lastInstrument !== null && state.lastInstrument !== instrName;
      const depthChanged = state.lastITMDepth !== null && state.lastITMDepth !== itmDepth;

      if (instrChanged)
        log(`Instrument changed: ${state.lastInstrument} → ${instrName} — forcing sync`);
      if (depthChanged)
        log(`ITM depth changed: ITM-${state.lastITMDepth} → ITM-${itmDepth} — forcing sync`);

      // 2. Check alert history for position changes
      const history = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
      if (Array.isArray(history)) {
        processHistoryForPositionChanges(history);
      }

      // 3. Get spot price (briefly switches chart to spot symbol then restores)
      const spot = await getSpot(cdp, cfg.spotSymbol);

      if (!spot) {
        log(`${instrName} spot unavailable — chart may not have loaded`);
        saveState();
        return;
      }

      const atm = calcATM(spot, cfg.strikeInterval);
      const atmShifted = state.lastATM !== null && state.lastATM !== atm;

      log(
        `${instrName}: ${spot.toFixed(2)}  ATM: ${atm}  ITM-${itmDepth}  (prev ATM: ${state.lastATM || '?'})  CE:${state.CE.toUpperCase()}  PE:${state.PE.toUpperCase()}`
      );

      if (!atmShifted && !depthChanged && !instrChanged && !force) {
        saveState();
        return;
      }

      if (atmShifted) log(`ATM shifted: ${state.lastATM} → ${atm}`);

      const ceStrike = atm - itmDepth * cfg.strikeInterval;
      const peStrike = atm + itmDepth * cfg.strikeInterval;

      // 4. Update CE alerts if no CE position
      if (state.CE === 'closed') {
        log(`Updating CE alerts → ITM-2 strike: ${ceStrike}`);
        await updateAlerts(cdpChart, cdpAlerts, 'CE', ceStrike, cfg);
      } else {
        log(`CE position OPEN — skipping CE symbol update`);
      }

      // 5. Update PE alerts if no PE position
      if (state.PE === 'closed') {
        log(`Updating PE alerts → ITM-2 strike: ${peStrike}`);
        await updateAlerts(cdpChart, cdpAlerts, 'PE', peStrike, cfg);
      } else {
        log(`PE position OPEN — skipping PE symbol update`);
      }

      state.lastATM = atm;
      state.lastInstrument = instrName;
      state.lastITMDepth = itmDepth;
      saveState();
    } catch (e) {
      log(`[ERROR] ${e.message}`);
    }
  }

  // Run immediately on start
  await tick(cdp, cdpChart, cdpAlerts, forceFirst);
  forceFirst = false;

  // Poll loop
  setInterval(() => tick(cdp, cdpChart, cdpAlerts, false), POLL_MS);
}

// Only auto-run when invoked directly, not when imported for tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
