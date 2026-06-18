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
 *   niftySupertrendLongEntry  / niftySupertrendShortEntry  → CE/PE OPEN  (NIFTY days)
 *   niftySupertrendLongExit   / niftySupertrendShortExit   → CE/PE CLOSED (NIFTY days)
 *   sensexSupertrendLongEntry / sensexSupertrendShortEntry → CE/PE OPEN  (SENSEX days)
 *   sensexSupertrendLongExit  / sensexSupertrendShortExit  → CE/PE CLOSED (SENSEX days)
 *
 * Usage:  node monitor.js
 *         node monitor.js --ce open      (manual override: mark CE as open)
 *         node monitor.js --pe closed    (manual override: mark PE as closed)
 *         node monitor.js --itm 0        (force ATM strike, overrides day rule)
 *         node monitor.js --itm 1        (force ITM-1, overrides day rule)
 *         node monitor.js --itm 2        (force ITM-2, overrides day rule)
 */

import CDP from 'chrome-remote-interface';
import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Supertrend Monitor owns one dedicated NIFTY spot chart tab.
// The tab stays on NIFTY for spot price reads.
// When updating CE/PE alerts, it switches to the option, does the update,
// then switches back to NIFTY.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const POLL_MS = 60_000;
const STATE_FILE = './config/position.json';
const LOG_FILE = './logs/monitor.log';

// ---------------------------------------------------------------------------
// Logging — writes to console + log file
// ---------------------------------------------------------------------------
fs.mkdirSync('./logs', { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

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

// ---------------------------------------------------------------------------
// Bias monitor alert names (manual up/down direction).
// 6 alerts per instrument: 3 for "up" (CE), 3 for "down" (PE).
// Prefix convention: "0" sorts up-alerts to the top of the Alerts panel,
// "z" sorts down-alerts to the bottom.
// Only the today-instrument's chosen direction is ever active; the opposite
// direction's 3 alerts are deactivated.
// ---------------------------------------------------------------------------
export const BIAS_ALERT_NAMES = {
  NIFTY: {
    up: { entry: '0NiftyBiasEntry', exit: '0NiftyBiasExit', target: '0NiftyBiasTarget' },
    down: { entry: 'zNiftyBiasEntry', exit: 'zNiftyBiasExit', target: 'zNiftyBiasTarget' },
  },
  SENSEX: {
    up: { entry: '0SensexBiasEntry', exit: '0SensexBiasExit', target: '0SensexBiasTarget' },
    down: { entry: 'zSensexBiasEntry', exit: 'zSensexBiasExit', target: 'zSensexBiasTarget' },
  },
};

// Day-of-week instrument routing (IST weekday: 1=Mon … 5=Fri)
export const DAY_INSTRUMENT = { 1: 'NIFTY', 2: 'NIFTY', 3: 'SENSEX', 4: 'SENSEX', 5: 'NIFTY' };

// NIFTY ITM depth by day: Mon/Tue → ITM-2, Fri → ITM-1
export const NIFTY_ITM_BY_DAY = { 1: 2, 2: 2, 5: 1 };

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
// Start at 09:10 (pre-open) so alerts are updated from indicative price
// before Pine Script can fire at 09:15 market open.
const MARKET_OPEN_MIN = 9 * 60 + 10; // 09:10 pre-open
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
  const line = `[${istTimeStr()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

export function calcATM(spot, strikeInterval) {
  return Math.round(spot / strikeInterval) * strikeInterval;
}

// ---------------------------------------------------------------------------
// Bias strike: up = buy CALL (ITM strike below ATM), down = buy PUT (ITM strike
// above ATM). Mirrors the CE/PE strike math used for supertrend.
// Returns { strike, optType } — optType is 'CE' for up, 'PE' for down.
// ---------------------------------------------------------------------------
export function calcBiasStrike(atm, itmDepth, strikeInterval, direction) {
  if (direction === 'down') {
    return { strike: atm + itmDepth * strikeInterval, optType: 'PE' };
  }
  return { strike: atm - itmDepth * strikeInterval, optType: 'CE' };
}

// Which 3 bias alerts to activate vs deactivate for today's instrument + direction.
// Only today's instrument is touched — the other instrument's alerts are left alone.
export function biasAlertPlan(instrument, direction) {
  const sets = BIAS_ALERT_NAMES[instrument];
  if (!sets) return { activate: [], deactivate: [] };
  const active = direction === 'down' ? sets.down : sets.up;
  const opposite = direction === 'down' ? sets.up : sets.down;
  return {
    activate: [active.entry, active.exit, active.target],
    deactivate: [opposite.entry, opposite.exit, opposite.target],
  };
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
  lastATMUpdateTime: 0, // ms timestamp of last ATM-triggered alert update
  lastCEStrike: null, // strike CE alerts were last set to
  lastPEStrike: null, // strike PE alerts were last set to
  lastInstrument: null,
  lastITMDepth: null,
  lastLogSnapshot: [], // top of Log tab from previous tick — used to detect new fires
  // ── Bias monitor ──
  biasPosition: 'closed', // active-direction trade state (open/closed)
  biasDirection: null, // direction currently being operated on (up/down)
  lastBiasStrike: null, // strike the 3 bias alerts were last set to
  lastBiasActivatedDir: null, // direction whose alerts are currently activated
  lastBiasLogSnapshot: [], // bias-specific Log tab snapshot for diff detection
  biasEntryParked: false, // entry alert was price→0'd + disabled during an open trade
  stEnabledLast: null, // last-seen supertrend enabled flag (pause/resume edge detection)
  biasEnabledLast: null, // last-seen bias enabled flag (pause/resume edge detection)
};
let itmOverride = null; // set by --itm CLI flag (highest priority)
export const ATM_COOLDOWN_MS = 120_000; // 2 min cooldown after an ATM-triggered update

/**
 * Decide whether an ATM shift should trigger alert updates.
 * Returns { update: true } or { update: false, remaining: <seconds> }.
 */
export function shouldUpdateATM(
  { lastATMUpdateTime = 0 },
  { force = false, CEjustClosed = false, PEjustClosed = false, atmShifted = true } = {}
) {
  if (!atmShifted || force || CEjustClosed || PEjustClosed) return { update: true };
  const elapsed = Date.now() - lastATMUpdateTime;
  if (elapsed < ATM_COOLDOWN_MS) {
    return { update: false, remaining: Math.round((ATM_COOLDOWN_MS - elapsed) / 1000) };
  }
  return { update: true };
}

// Minimum valid spot price per instrument (rejects background tab garbage reads)
const MIN_SPOT = { NIFTY: 15000, SENSEX: 50000 };

export function todayIST() {
  const t = nowIST();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Position reset rules on startup / new trading day:
 *
 * A. Pre-market or off-market start (!isMarketHours):
 *    → CE/PE forced to 'closed'. No trades can be running outside market hours.
 *    → lastLogSnapshot is deleted so the tick will seal it with live history on the
 *      first force tick, preventing old history from being replayed.
 *
 * B. Market-hours start (monitor started late, isMarketHours = true):
 *    → CE/PE loaded as-is from position.json (starting point only).
 *    → lastLogSnapshot is deleted so processHistoryForPositionChanges runs the
 *      fresh-start scan when called.
 *    → Immediately after CDP connects, ALERT_HISTORY_SCRIPT is run and
 *      processHistoryForPositionChanges re-derives CE/PE from TV alert history.
 *      saveState() is called right away — position.json is correct before the
 *      first tick and before waitForAlertsReady completes.
 *
 * C. Continuous running, new calendar day (no restart):
 *    → loadState is NOT called. The tick detects isNewDay (todayIST !== state.lastDate).
 *    → Pre-market tick (9:10 AM): resets CE/PE and seals lastLogSnapshot so no
 *      prior-day history fires are replayed via diff-based detection.
 *    → Market-hours tick (started late): resets CE/PE and leaves lastLogSnapshot as-is
 *      (populated from continuous session) — diff-based detection catches only new fires.
 */
// position.json is grouped by strategy: { date, shared, supertrend, bias }.
// In-memory state stays flat; we group it on save and flatten on load.
// Loader is tolerant of the legacy flat format (reads flat fields as fallback).
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const sh = saved.shared || {};
      const st = saved.supertrend || {};
      const bi = saved.bias || {};
      const pick = (...vals) => vals.find((v) => v !== undefined);
      state.lastDate = pick(saved.date, saved.lastDate, state.lastDate);
      state.lastATM = pick(sh.lastATM, saved.lastATM, null);
      state.lastATMUpdateTime = pick(sh.lastATMUpdateTime, saved.lastATMUpdateTime, 0);
      state.lastInstrument = pick(sh.lastInstrument, saved.lastInstrument, null);
      state.lastITMDepth = pick(sh.lastITMDepth, saved.lastITMDepth, null);
      state.CE = pick(st.CE, saved.CE, 'closed');
      state.PE = pick(st.PE, saved.PE, 'closed');
      state.lastCEStrike = pick(st.lastCEStrike, saved.lastCEStrike, null);
      state.lastPEStrike = pick(st.lastPEStrike, saved.lastPEStrike, null);
      state.stEnabledLast = pick(st.enabled, saved.stEnabledLast, null);
      state.biasPosition = pick(bi.position, saved.biasPosition, 'closed');
      state.biasDirection = pick(bi.direction, saved.biasDirection, null);
      state.lastBiasStrike = pick(bi.lastStrike, saved.lastBiasStrike, null);
      state.lastBiasActivatedDir = pick(bi.activatedDir, saved.lastBiasActivatedDir, null);
      state.biasEntryParked = pick(bi.entryParked, saved.biasEntryParked, false);
      state.biasEnabledLast = pick(bi.enabled, saved.biasEnabledLast, null);
      // logSnapshots are session-only — never loaded, so each restart re-detects fresh.
      // Pre/off-market start: reset CE/PE/bias clean — no trades can run outside hours.
      if (!isMarketHours()) {
        state.CE = 'closed';
        state.PE = 'closed';
        state.biasPosition = 'closed';
        console.log('[STATE] Pre/off-market start — CE/PE + bias reset to closed');
      }
    }
  } catch (_e) {
    /* ignore missing/corrupt state file */
  }
}

function saveState() {
  try {
    state.lastDate = todayIST();
    const out = {
      date: state.lastDate,
      shared: {
        lastATM: state.lastATM,
        lastATMUpdateTime: state.lastATMUpdateTime,
        lastInstrument: state.lastInstrument,
        lastITMDepth: state.lastITMDepth,
      },
      supertrend: {
        enabled: state.stEnabledLast,
        CE: state.CE,
        PE: state.PE,
        lastCEStrike: state.lastCEStrike,
        lastPEStrike: state.lastPEStrike,
        logSnapshot: state.lastLogSnapshot,
      },
      bias: {
        enabled: state.biasEnabledLast,
        position: state.biasPosition,
        direction: state.biasDirection,
        lastStrike: state.lastBiasStrike,
        activatedDir: state.lastBiasActivatedDir,
        entryParked: state.biasEntryParked,
        // Note: the bias log diff-baseline is session-only (in-memory state.lastBiasLogSnapshot)
        // and not persisted — nothing reads it back, and it's just a copy of the full Log tab.
      },
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  } catch (_e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Background tab — used for price reads so the main chart is never touched
// ---------------------------------------------------------------------------
async function openBackgroundTab(port = 9222, timeoutMs = 90_000) {
  try {
    // Find the main TradingView chart URL
    const targets = await CDP.List({ port });
    const chartTarget = targets.find((t) => t.url && t.url.includes('tradingview'));
    if (!chartTarget) throw new Error('No TradingView chart target found');

    // Open a new tab with the same URL
    const newTarget = await CDP.New({ port, url: chartTarget.url });
    const client = await CDP({ target: newTarget.id, port });
    await Promise.all([client.Page.enable(), client.Runtime.enable()]);

    // Wait for TradingViewApi to be ready
    log(`Background tab: waiting for TradingView to load (up to ${timeoutMs / 1000}s)...`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await client.Runtime.evaluate({
        expression: 'typeof window.TradingViewApi !== "undefined"',
        returnByValue: true,
      }).catch(() => ({ result: { value: false } }));
      if (r?.result?.value === true) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    log('Background tab ready — main chart will not be disturbed for price reads');

    return {
      executeScript: async (expression) => {
        const result = await client.Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      },
      close: () => client.close().catch(() => {}),
    };
  } catch (e) {
    log(`Background tab unavailable (${e.message}) — price reads will use main chart`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDP scripts
// ---------------------------------------------------------------------------
// Gets spot price using background tab (no main chart disturbance) or falls
// back to switching the main chart if background tab is unavailable.
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

        // Primary: right-axis last-price button label (live price, works pre-open too)
        let price = null;
        const btnEls = Array.from(document.querySelectorAll('[class*="buttonText"]'))
          .filter(e => e.offsetParent !== null);
        for (const el of btnEls) {
          const n = parseFloat((el.textContent || '').replace(/,/g, ''));
          if (n > 5000 && n < 200000) { price = n; break; }
        }

        // Fallback: bars store close (stale during pre-open)
        if (!price) {
          const model = widget?._chartWidget?._modelWV?._value;
          const barsStore = model?.mainSeries?.()?.bars?.();
          if (barsStore && barsStore.size() > 0) {
            const b = barsStore.valueAt(barsStore.lastIndex());
            const v = Array.isArray(b) ? b : (b?.value || []);
            if (v.length >= 5) price = v[4];
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

export const ALERT_HISTORY_SCRIPT = `
  (async function() {
    try {
      const visibleTabs = () => Array.from(document.querySelectorAll('[role="tab"]'))
        .filter(t => !!t.offsetParent);

      const findTab = (label) => visibleTabs().find(t =>
        (t.textContent || '').trim().toLowerCase().includes(label));

      const allTabTexts = visibleTabs().map(t => t.textContent?.trim());

      // Click Log tab if Alerts panel is open
      const logTab = findTab('log');
      if (logTab) {
        logTab.click();
        await new Promise(r => setTimeout(r, 600));
      }

      const selectors = [
        '[data-name="alert-log-item"]',
        '[data-name="alert-history-item"]',
        '[class*="alertLogItem"]',
        '[class*="historyItem"]',
      ];
      let usedSel = '';
      for (const sel of selectors) {
        if (document.querySelector(sel)) { usedSel = sel; break; }
      }

      // Find virtual-list scroll container by computed overflowY
      const seedEl = usedSel ? document.querySelector(usedSel) : null;
      let scroller = null;
      if (seedEl) {
        let node = seedEl.parentElement;
        while (node && node !== document.body) {
          const oy = window.getComputedStyle(node).overflowY;
          if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
              node.scrollHeight > node.clientHeight + 2) { scroller = node; break; }
          node = node.parentElement;
        }
      }

      const readItem = (el) => ({
        name:   el.querySelector('[data-name="alert-log-item-name"]')?.innerText?.trim() ||
                el.querySelector('[class*="name"]')?.innerText?.trim()    || '',
        time:   el.querySelector('[data-name="alert-log-item-time"]')?.innerText?.trim() ||
                el.querySelector('[class*="time"]')?.innerText?.trim()    || '',
        symbol: el.querySelector('[data-name="alert-log-item-symbol"]')?.innerText?.trim() ||
                el.querySelector('[class*="symbol"]')?.innerText?.trim()  || '',
        raw:    el.innerText?.trim().slice(0, 80) || '',
      });

      // Collect items keyed by absY to dedup virtual-list re-renders across scroll positions
      const byAbsY = new Map();
      const readCurrent = () => {
        if (!usedSel) return;
        const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
        const scrollTop    = scroller ? scroller.scrollTop : 0;
        Array.from(document.querySelectorAll(usedSel)).forEach(el => {
          const rect = el.getBoundingClientRect();
          const absY = scrollerRect
            ? Math.round(rect.top - scrollerRect.top + scrollTop)
            : Math.round(rect.top * 10);
          if (!byAbsY.has(absY)) byAbsY.set(absY, readItem(el));
        });
      };

      // Scroll from top, stop once 30 items collected (newest are at top)
      if (scroller) scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 400));
      readCurrent();
      const countAfterTop = byAbsY.size;

      if (scroller && byAbsY.size < 30) {
        const scrollTo = async (pos) => {
          scroller.scrollTop = pos;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
        };
        const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
        let pos = step;
        while (pos <= scroller.scrollHeight && byAbsY.size < 30) {
          await scrollTo(pos);
          readCurrent();
          if (pos >= scroller.scrollHeight - scroller.clientHeight) break;
          pos += step;
        }
        // Reset to top so Log tab starts fresh next time
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
      }

      // Sort ascending absY = newest first (Log tab shows newest at top)
      const result = Array.from(byAbsY.entries())
        .sort((a, b) => a[0] - b[0])
        .slice(0, 30)
        .map(([, item]) => item);

      // Switch back to Alerts tab and wait for items to reload
      const alertsTab = findTab('alert');
      if (alertsTab) {
        alertsTab.click();
        await new Promise(r => setTimeout(r, 500));
      }

      return { items: result, diag: { allTabTexts, logTabFound: !!logTab, usedSel, scrollerFound: !!scroller, countAfterTop, itemCount: result.length } };
    } catch (e) {
      return { items: [], diag: { error: e.message } };
    }
  })()
`;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------
async function updateAlerts(cdpChart, cdpAlerts, side, strike, cfg, instrName) {
  const alertDefs = ALERT_NAMES[instrName]?.[side] ?? ALERT_NAMES.NIFTY[side];
  const symbol = buildSymbol(cfg, strike, side);
  const results = [];

  // Load the target option symbol on this chart tab before updating the alert.
  // The alert dropdown only shows: (1) alert's current symbol, (2) chart's current symbol.
  // We need (2) to be the new strike so we can select it.
  const exchange = cfg.spotSymbol.split(':')[0]; // 'NSE' for NIFTY, 'BSE' for SENSEX
  const qualifiedSymbol = `${exchange}:${symbol}`;

  // Check if the chart is already on the right symbol — skip switch + wait if so.
  const currentSymbol = await cdpChart.cdp
    .executeScript(`window.TradingViewApi?._activeChartWidgetWV?._value?.symbol?.() || ''`)
    .catch(() => '');
  const needsSwitch = currentSymbol !== qualifiedSymbol;

  if (needsSwitch) {
    // Ensure Alerts panel is OPEN before switching chart symbols.
    // TradingView re-filters the panel to the current chart's symbol on each switch.
    // If the panel is already open and showing all alerts when the switch happens,
    // the existing alert rows stay visible — preventing "not found" after the switch.
    await cdpAlerts.normalizeAlertsPanel();

    log(`  Loading ${qualifiedSymbol} on chart tab...`);
    await cdpChart.handle('chart_set_symbol', { symbol: qualifiedSymbol });
    // Wait for TradingView to settle after chart switch
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    log(`  Chart tab already on ${qualifiedSymbol}`);
  }

  for (const [role, name] of Object.entries(alertDefs)) {
    log(`  [${side}:${role}] "${name}" → ${symbol}`);
    let result;
    try {
      const r = await cdpAlerts.handle('alert_update_symbol', { alertName: name, symbol });
      if (r?.isError) {
        result = { name, symbol, success: false, error: r?.content?.[0]?.text || 'unknown error' };
      } else {
        const data = JSON.parse(r?.content?.[0]?.text || '{}');
        result = { name, symbol, success: data.success, message: data.message };
      }
    } catch (e) {
      result = { name, symbol, success: false, error: e.message };
    }
    const detail = result?.message || result?.error || '';
    if (result?.success) {
      log(`  [OK]   "${name}" updated to ${symbol}${detail ? ' — ' + detail : ''}`);
    } else {
      log(`  [FAIL] "${name}" not updated${detail ? ' — ' + detail : ''}`);
    }
    results.push(result);
    // Gap between edit dialogs — allow TV to settle after save animation
    await new Promise((r) => setTimeout(r, 1500));
  }

  return results;
}

// ---------------------------------------------------------------------------
// After updating CE+PE alerts, wait 3s then verify all 4 are active
// ---------------------------------------------------------------------------
async function verifyAlertStatus(cdpAlerts, instrName) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const r = await cdpAlerts.handle('alert_list', {});
    const data = JSON.parse(r?.content?.[0]?.text || '{}');
    const alerts = data.alerts || [];
    const names = ALERT_NAMES[instrName];
    const toCheck = [names.CE.entry, names.CE.exit, names.PE.entry, names.PE.exit];
    let allOk = true;
    for (const name of toCheck) {
      const found = alerts.find((a) => a.name === name);
      if (!found) {
        log(`  [STATUS] "${name}" — not found in panel`);
        allOk = false;
      } else if (!found.active) {
        log(`  [STATUS] "${name}" — STOPPED (${found.status}) — attempting to re-activate...`);
        const ar = await cdpAlerts.handle('alert_activate', { alertId: name });
        const ad = JSON.parse(ar?.content?.[0]?.text || '{}');
        if (ad.success) {
          log(`  [STATUS] "${name}" — re-activated ✓`);
        } else {
          log(`  [STATUS] "${name}" — re-activate failed: ${ad.message || 'unknown'}`);
        }
        allOk = false;
      } else {
        log(`  [STATUS] "${name}" — active ✓`);
      }
    }
    if (allOk) log('  [STATUS] All 4 alerts active ✓');
  } catch (e) {
    log(`  [STATUS] Could not verify alert status: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Bias alert updates — point the 3 active-direction alerts at one ITM option
// symbol AND set their price level to 0 via alert_update.
// ---------------------------------------------------------------------------
async function updateBiasAlerts(cdpChart, cdpAlerts, direction, strike, optType, cfg, instrName) {
  const set = BIAS_ALERT_NAMES[instrName]?.[direction];
  if (!set) return [];
  const symbol = buildSymbol(cfg, strike, optType);
  const exchange = cfg.spotSymbol.split(':')[0];
  const qualifiedSymbol = `${exchange}:${symbol}`;

  const currentSymbol = await cdpChart.cdp
    .executeScript(`window.TradingViewApi?._activeChartWidgetWV?._value?.symbol?.() || ''`)
    .catch(() => '');
  if (currentSymbol !== qualifiedSymbol) {
    await cdpAlerts.normalizeAlertsPanel();
    log(`  [BIAS] Loading ${qualifiedSymbol} on chart tab...`);
    await cdpChart.handle('chart_set_symbol', { symbol: qualifiedSymbol });
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    log(`  [BIAS] Chart tab already on ${qualifiedSymbol}`);
  }

  const results = [];
  for (const [role, name] of Object.entries(set)) {
    log(`  [BIAS:${direction}:${role}] "${name}" → ${symbol} @ 0`);
    let result;
    try {
      const r = await cdpAlerts.handle('alert_update', { alertName: name, symbol, level: 0 });
      if (r?.isError) {
        result = { name, symbol, success: false, error: r?.content?.[0]?.text || 'unknown error' };
      } else {
        const data = JSON.parse(r?.content?.[0]?.text || '{}');
        result = { name, symbol, success: data.success, message: data.message };
      }
    } catch (e) {
      result = { name, symbol, success: false, error: e.message };
    }
    const detail = result?.message || result?.error || '';
    if (result?.success) log(`  [OK]   "${name}" → ${symbol} @ 0${detail ? ' — ' + detail : ''}`);
    else log(`  [FAIL] "${name}" not updated${detail ? ' — ' + detail : ''}`);
    results.push(result);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results;
}

// When a bias trade is OPEN, the entry alert already fired: set its price to 0
// and disable it (don't change its symbol). Exit + Target are left untouched so
// the running trade can still close.
async function parkBiasEntry(cdpAlerts, instrName, direction, entrySymbol) {
  const set = BIAS_ALERT_NAMES[instrName]?.[direction];
  if (!set) return;
  await cdpAlerts.normalizeAlertsPanel();
  try {
    const r = await cdpAlerts.handle('alert_update', {
      alertName: set.entry,
      symbol: entrySymbol,
      level: 0,
    });
    const d = JSON.parse(r?.content?.[0]?.text || '{}');
    log(`  [BIAS] entry "${set.entry}" price→0 — ${d.success ? 'OK' : d.message || 'fail'}`);
  } catch (e) {
    log(`  [BIAS] entry price→0 error: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await cdpAlerts.handle('alert_deactivate', { alertId: set.entry });
    const d = JSON.parse(r?.content?.[0]?.text || '{}');
    log(`  [BIAS] disable entry "${set.entry}" — ${d.success ? 'OK' : d.message || 'fail'}`);
  } catch (e) {
    log(`  [BIAS] disable entry error: ${e.message}`);
  }
}

// Re-enable a bias entry alert that was parked+disabled during a trade.
async function reactivateBiasEntry(cdpAlerts, instrName, direction) {
  const set = BIAS_ALERT_NAMES[instrName]?.[direction];
  if (!set) return;
  await cdpAlerts.normalizeAlertsPanel();
  try {
    const r = await cdpAlerts.handle('alert_activate', { alertId: set.entry });
    const d = JSON.parse(r?.content?.[0]?.text || '{}');
    log(`  [BIAS] re-enable entry "${set.entry}" — ${d.success ? 'OK' : d.message || 'fail'}`);
  } catch (e) {
    log(`  [BIAS] re-enable entry error: ${e.message}`);
  }
}

// Deactivate the opposite direction's 3 alerts. Only today's instrument is touched.
// The chosen direction's 3 alerts are re-activated ONLY when flipping back to a
// direction that may have been deactivated by a prior flip (activateChosen=true).
// On first reconcile the chosen alerts are assumed already active, so we leave them
// alone — avoids redundant "already active" activate calls.
async function applyBiasActivation(cdpAlerts, instrName, direction, activateChosen = false) {
  const plan = biasAlertPlan(instrName, direction);
  if (!plan.deactivate.length) return;
  await cdpAlerts.normalizeAlertsPanel();
  const apply = async (tool, name) => {
    try {
      const r = await cdpAlerts.handle(tool, { alertId: name });
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      const verb = tool === 'alert_activate' ? 'activate' : 'deactivate';
      log(`  [BIAS] ${verb} "${name}" — ${d.success ? 'OK' : d.message || 'fail'}`);
    } catch (e) {
      log(`  [BIAS] ${tool} "${name}" error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  };
  for (const name of plan.deactivate) await apply('alert_deactivate', name);
  if (activateChosen) {
    for (const name of plan.activate) await apply('alert_activate', name);
  }
}

// Disable (deactivate) all of a strategy's alerts — used when a strategy is PAUSED.
async function deactivateAlerts(cdpAlerts, names, tag) {
  if (!names.length) return;
  await cdpAlerts.normalizeAlertsPanel();
  for (const name of names) {
    try {
      const r = await cdpAlerts.handle('alert_deactivate', { alertId: name });
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      log(`  [${tag}] disable "${name}" — ${d.success ? 'OK' : d.message || 'fail'}`);
    } catch (e) {
      log(`  [${tag}] disable "${name}" error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function supertrendAlertNames(instrName) {
  const n = ALERT_NAMES[instrName];
  return n ? [n.CE.entry, n.CE.exit, n.PE.entry, n.PE.exit] : [];
}

function biasAlertNames(instrName) {
  const s = BIAS_ALERT_NAMES[instrName];
  return s ? [s.up.entry, s.up.exit, s.up.target, s.down.entry, s.down.exit, s.down.target] : [];
}

export function processHistoryForPositionChanges(historyItems, stateObj, instrument = null) {
  // Detect new fires by comparing current log with the previous tick's snapshot.
  // TV's time field is often empty so key-based dedup breaks (same key every fire).
  // Instead: find items at the TOP of the current list that weren't at the top last tick.
  const prevSnapshot = stateObj.lastLogSnapshot || [];
  let newItems = [];

  if (prevSnapshot.length === 0) {
    // Fresh start — scan log from newest to oldest to determine current CE/PE state.
    // Default both sides to closed; only set open if a recent entry is found.
    // Only match today's instrument alerts to prevent cross-instrument contamination.
    // Stop scanning when we cross the day boundary: the first non-today-instrument
    // alert AFTER already having seen at least one today-instrument alert — this
    // prevents old NIFTY alerts from a previous week from reopening PE/CE on a new day.
    const alertsToScan = instrument ? [ALERT_NAMES[instrument]] : Object.values(ALERT_NAMES);
    const prevCE = stateObj.CE;
    const prevPE = stateObj.PE;
    stateObj.CE = 'closed';
    stateObj.PE = 'closed';
    let ceDone = false,
      peDone = false;
    let seenTodayInstr = false;
    for (const item of historyItems) {
      if (ceDone && peDone) break;
      const n = item.name;
      const isTodayInstr = alertsToScan.some(
        (a) => a.CE.entry === n || a.CE.exit === n || a.PE.entry === n || a.PE.exit === n
      );
      if (!isTodayInstr) {
        if (seenTodayInstr) break; // crossed the day boundary — stop scanning
        continue; // skip non-today items before seeing any today-instrument alerts
      }
      seenTodayInstr = true;
      if (!ceDone && alertsToScan.some((a) => a.CE.entry === n)) {
        stateObj.CE = 'open';
        ceDone = true;
        log(`[POSITION] CE OPENED from history (alert: ${n})`);
      } else if (!ceDone && alertsToScan.some((a) => a.CE.exit === n)) {
        stateObj.CE = 'closed';
        ceDone = true;
        log(`[POSITION] CE CLOSED from history (alert: ${n})`);
      }
      if (!peDone && alertsToScan.some((a) => a.PE.entry === n)) {
        stateObj.PE = 'open';
        peDone = true;
        log(`[POSITION] PE OPENED from history (alert: ${n})`);
      } else if (!peDone && alertsToScan.some((a) => a.PE.exit === n)) {
        stateObj.PE = 'closed';
        peDone = true;
        log(`[POSITION] PE CLOSED from history (alert: ${n})`);
      }
    }
    if (!seenTodayInstr) {
      // No today-instrument alerts found in the log at all — the log is empty or
      // contains only other days/instruments. Keep whatever was already in position.json
      // (user may have set it manually) rather than forcing both sides to 'closed'.
      stateObj.CE = prevCE;
      stateObj.PE = prevPE;
    }
    const changed = stateObj.CE !== prevCE || stateObj.PE !== prevPE;
    stateObj.lastLogSnapshot = historyItems.slice(0, 30);
    return changed;
  } else {
    // Find where the previous tick's top item appears in the current list.
    // Everything before it is new.
    const prevFirst = prevSnapshot[0];
    const boundaryIdx = historyItems.findIndex(
      (h) => h.name === prevFirst.name && h.symbol === prevFirst.symbol
    );
    if (boundaryIdx > 0) {
      newItems = historyItems.slice(0, boundaryIdx);
    } else if (boundaryIdx === -1) {
      // Previous top item no longer visible — log rolled over; process top 5 to be safe.
      newItems = historyItems.slice(0, 5);
    }
    // boundaryIdx === 0 → nothing new
  }

  // Save current log as snapshot for next tick (top 10 items)
  stateObj.lastLogSnapshot = historyItems.slice(0, 30);

  let changed = false;
  for (const item of newItems) {
    const name = item.name;
    const isCEEntry = Object.values(ALERT_NAMES).some((a) => a.CE.entry === name);
    const isCEExit = Object.values(ALERT_NAMES).some((a) => a.CE.exit === name);
    const isPEEntry = Object.values(ALERT_NAMES).some((a) => a.PE.entry === name);
    const isPEExit = Object.values(ALERT_NAMES).some((a) => a.PE.exit === name);

    if (isCEEntry) {
      stateObj.CE = 'open';
      changed = true;
      log(`[POSITION] CE OPENED  (alert: ${name})`);
    } else if (isCEExit) {
      stateObj.CE = 'closed';
      changed = true;
      log(`[POSITION] CE CLOSED  (alert: ${name})`);
    } else if (isPEEntry) {
      stateObj.PE = 'open';
      changed = true;
      log(`[POSITION] PE OPENED  (alert: ${name})`);
    } else if (isPEExit) {
      stateObj.PE = 'closed';
      changed = true;
      log(`[POSITION] PE CLOSED  (alert: ${name})`);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Bias position tracking — single position for the active direction.
// entry fired → open ; exit OR target fired → closed.
// Uses its own snapshot (state.lastBiasLogSnapshot) so it diffs the Log tab
// independently of the supertrend CE/PE tracker, even though both read the
// same history. Only the active direction's alerts can fire (the opposite
// direction is deactivated), so a single open/closed flag is sufficient.
// ---------------------------------------------------------------------------
export function processBiasHistory(historyItems, stateObj, instrument, direction) {
  const set = BIAS_ALERT_NAMES[instrument]?.[direction];
  if (!set) return false;
  const isEntry = (n) => n === set.entry;
  const isClose = (n) => n === set.exit || n === set.target;
  const isBias = (n) => isEntry(n) || isClose(n);

  const prevSnapshot = stateObj.lastBiasLogSnapshot || [];
  const prev = stateObj.biasPosition || 'closed';

  if (prevSnapshot.length === 0) {
    // Fresh start — scan newest→oldest, first relevant bias alert wins.
    let derived = 'closed';
    for (const item of historyItems) {
      const n = item.name;
      if (!isBias(n)) continue;
      derived = isEntry(n) ? 'open' : 'closed';
      break;
    }
    stateObj.biasPosition = derived;
    stateObj.lastBiasLogSnapshot = historyItems.slice(0, 30);
    return derived !== prev;
  }

  // Diff against previous snapshot top — everything above the boundary is new.
  const prevFirst = prevSnapshot[0];
  const boundaryIdx = historyItems.findIndex(
    (h) => h.name === prevFirst.name && h.symbol === prevFirst.symbol
  );
  let newItems = [];
  if (boundaryIdx > 0) newItems = historyItems.slice(0, boundaryIdx);
  else if (boundaryIdx === -1) newItems = historyItems.slice(0, 5);

  stateObj.lastBiasLogSnapshot = historyItems.slice(0, 30);

  let changed = false;
  for (const item of newItems) {
    const n = item.name;
    if (isEntry(n)) {
      if (stateObj.biasPosition !== 'open') {
        stateObj.biasPosition = 'open';
        changed = true;
        log(`[BIAS] position OPENED (alert: ${n})`);
      }
    } else if (isClose(n)) {
      if (stateObj.biasPosition !== 'closed') {
        stateObj.biasPosition = 'closed';
        changed = true;
        log(`[BIAS] position CLOSED (alert: ${n})`);
      }
    }
  }
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

  // Bias always starts PAUSED — it's manual trading, so it must be resumed
  // explicitly each session. Reset bias.enabled to false in the config on every
  // start/restart (the first force tick then disables the bias alerts).
  try {
    const cfgPath = './config/monitor-config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.bias?.enabled === true) {
      cfg.bias.enabled = false;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log('[BIAS] reset to PAUSED on startup — resume explicitly when ready');
    }
  } catch (_e) {
    /* ignore */
  }

  const todayInstr = INSTRUMENTS[DAY_INSTRUMENT[nowIST().getUTCDay()] || 'NIFTY'];
  console.log('\n=== Intraday Alert Monitor (NIFTY / SENSEX) ===');
  console.log(`Today's instrument : ${todayInstr.name}  (spot: ${todayInstr.spotSymbol})`);
  console.log(
    `Strike step        : ${todayInstr.strikeInterval}  |  ITM depth : ${todayInstr.itmDepth}  |  Poll : ${POLL_MS / 1000}s`
  );
  const todayAlerts = ALERT_NAMES[todayInstr.name] ?? ALERT_NAMES.NIFTY;
  console.log(`CE alerts          : ${todayAlerts.CE.entry} / ${todayAlerts.CE.exit}`);
  console.log(`PE alerts          : ${todayAlerts.PE.entry} / ${todayAlerts.PE.exit}`);
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

  // Prevent process crash on unhandled errors
  process.on('uncaughtException', (e) => log(`[CRASH] ${e.message}`));
  process.on('unhandledRejection', (e) => log(`[CRASH] ${e?.message || e}`));

  // ── Connect to this monitor's dedicated chart tab ─────────────────
  // Each monitor owns one NIFTY spot tab, auto-created if missing.
  // Tab stays on NIFTY for spot price reads.
  // Switches to CE/PE for alert updates, then switches back to NIFTY.
  let cdp;
  let bgCDP = null;

  try {
    // Merged monitor (supertrend + bias) owns a single chart tab.
    const tabId = await CDPManager.ensureMonitorTab('./logs/supertrend-tab.json', 9222);
    cdp = new CDPManager(tabId, './logs/supertrend-tab.json');
    await cdp.connect();
    log(`CDP connected (tab: ${tabId.slice(0, 16)})`);
    // bgCDP not needed — this tab stays on NIFTY for spot reads
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart = new ChartTools(cdp);

  // ── Market-hours restart: re-derive CE/PE from TV alert history immediately ──
  // loadState() loaded CE/PE from file which may be stale (monitor was down when
  // an alert fired). Read history now so position.json is correct before the first
  // tick — don't wait for waitForAlertsReady which can take up to 120s.
  if (isMarketHours()) {
    log('[STATE] Market hours restart — reading TV alert history to re-derive position...');
    try {
      const historyResult = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
      const historyItems =
        historyResult?.items ?? (Array.isArray(historyResult) ? historyResult : []);
      if (historyItems.length > 0) {
        processHistoryForPositionChanges(historyItems, state, todayInstr.name);
        saveState();
        log(
          `[STATE] Position re-derived: CE=${state.CE.toUpperCase()} PE=${state.PE.toUpperCase()}`
        );
      } else {
        log('[STATE] No alert history found — keeping loaded state');
      }
    } catch (e) {
      log(`[STATE] Could not read alert history on startup: ${e.message}`);
    }
  }

  // ── Wait for Alerts panel to sync from cloud after TV restart ────────────
  // Polls alert_list every 5s until all 4 supertrend alerts for today's
  // instrument are visible. Prevents "not found" failures on cold start.
  await (async function waitForAlertsReady() {
    const dayOfWeek = nowIST().getUTCDay();
    const instrName = DAY_INSTRUMENT[dayOfWeek] || 'NIFTY';
    const names = ALERT_NAMES[instrName];
    const required = [names.CE.entry, names.CE.exit, names.PE.entry, names.PE.exit];
    const TIMEOUT_MS = 120_000;
    const POLL_MS = 5_000;
    const deadline = Date.now() + TIMEOUT_MS;

    log(`Waiting for Alerts panel to load (${instrName}, up to ${TIMEOUT_MS / 1000}s)...`);
    while (Date.now() < deadline) {
      try {
        await cdpAlerts.normalizeAlertsPanel();
        const r = await cdpAlerts.handle('alert_list', {});
        const data = JSON.parse(r?.content?.[0]?.text || '{}');
        const alertNames = (data.alerts || []).map((a) => a.name);
        const found = required.filter((n) => alertNames.includes(n));
        if (found.length === required.length) {
          log(`Alerts panel ready — all ${required.length} ${instrName} alerts visible ✓`);
          return;
        }
        log(
          `Alerts loading... ${found.length}/${required.length} visible — retrying in ${POLL_MS / 1000}s`
        );
      } catch (_) {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    log(
      `[WARN] Alerts panel timed out — ${instrName} alerts not all visible. Proceeding anyway (may fail on first update).`
    );
  })();

  // Keyboard shortcuts
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    let ctrlCPending = false;
    let ctrlCTimer = null;

    async function shutdown() {
      log('Exiting...');
      saveState();
      if (bgCDP) bgCDP.close();
      await cdp.disconnect();
      process.exit(0);
    }

    process.stdin.on('keypress', async (ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        if (ctrlCPending) {
          clearTimeout(ctrlCTimer);
          await shutdown();
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
        await shutdown();
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
  const retryNextTick = { CE: false, PE: false, bias: false };

  async function tick(cdp, cdpChart, cdpAlerts, force = false) {
    try {
      // Fail fast if CDP dropped — jump straight to reconnect logic below
      if (!cdp.isConnected()) throw new Error('CDP not connected');

      // ignoreMarketHours (config) lets the tick run 24/7 — useful for off-hours
      // testing and crypto. The startup/force tick always bypasses this anyway.
      const ignoreMarketHours = loadConfig()?.ignoreMarketHours === true;
      if (!isMarketHours() && !force && !ignoreMarketHours) {
        log('Outside market hours — waiting');
        return;
      }

      // Fetch alert history early — needed before new-day logic to seal the snapshot
      const historyResult = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
      const historyItems =
        historyResult?.items ?? (Array.isArray(historyResult) ? historyResult : []);

      // New trading day — reset CE/PE to closed
      const isNewDay = todayIST() !== state.lastDate;
      if (isNewDay) {
        state.CE = 'closed';
        state.PE = 'closed';
        state.biasPosition = 'closed';
        if (!isMarketHours()) {
          // Pre-market (continuous running, new day): seal snapshot so no old history
          // fires are replayed — diff-based detection starts clean from today's fires only
          state.lastLogSnapshot = historyItems.slice(0, 30);
          state.lastBiasLogSnapshot = historyItems.slice(0, 30);
          log(`[STATE] New day pre-market (${todayIST()}) — CE/PE + bias reset to closed`);
        } else {
          // Started late during market hours: reset CE/PE but allow fresh-start scan
          // to re-derive open trades from TV alert history
          log(
            `[STATE] New day market hours (${todayIST()}) — CE/PE reset, re-deriving from history`
          );
        }
        saveState();
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

      // 2. Determine CE/PE position changes from alert history
      const prevCE = state.CE;
      const prevPE = state.PE;
      processHistoryForPositionChanges(historyItems, state, instrName);
      // If a trade just closed, force an immediate alert sync to the current strike —
      // ATM may have moved while the trade was running and the alerts are stale.
      const CEjustClosed = prevCE === 'open' && state.CE === 'closed';
      const PEjustClosed = prevPE === 'open' && state.PE === 'closed';
      if (CEjustClosed) log('[POSITION] CE closed — will sync CE alerts to current strike');
      if (PEjustClosed) log('[POSITION] PE closed — will sync PE alerts to current strike');

      // 2b. Bias monitor — manual direction with deferred flip while a trade is open.
      const biasCfg = config.bias || {};
      // Bias is PAUSED by default (manual trading) — runs only when explicitly
      // enabled AND a direction is configured.
      const biasEnabled =
        biasCfg.enabled === true && (biasCfg.direction === 'up' || biasCfg.direction === 'down');
      let biasJustClosed = false;
      let biasJustOpened = false;
      let biasEffectiveDir = null;
      let biasDirectionFlip = false;
      if (biasEnabled) {
        const requestedDir = biasCfg.direction === 'down' ? 'down' : 'up';
        const prevDir = state.biasDirection || null;
        // Track the position on the direction we were operating on (prevDir), else requested.
        const trackDir = prevDir || requestedDir;
        const prevBiasPos = state.biasPosition || 'closed';
        processBiasHistory(historyItems, state, instrName, trackDir);
        biasJustClosed = prevBiasPos === 'open' && state.biasPosition === 'closed';
        biasJustOpened = prevBiasPos === 'closed' && state.biasPosition === 'open';
        // Deferred flip: while a position is open, stay locked on the open direction.
        if (state.biasPosition === 'open' && prevDir) {
          biasEffectiveDir = prevDir;
          if (requestedDir !== prevDir)
            log(
              `[BIAS] flip to ${requestedDir.toUpperCase()} pending — position OPEN on ${prevDir.toUpperCase()}`
            );
        } else {
          biasEffectiveDir = requestedDir;
        }
        biasDirectionFlip = prevDir !== null && prevDir !== biasEffectiveDir;
        if (biasJustClosed) log('[BIAS] position closed — will sync bias alerts to current strike');
        if (biasDirectionFlip) log(`[BIAS] direction flip ${prevDir} → ${biasEffectiveDir}`);
      }

      // 3. Get spot price — tab is on NIFTY, reads directly without switching.
      const spot = await getSpot(cdp, cfg.spotSymbol);

      if (!spot || spot < (MIN_SPOT[instrName] || 10000)) {
        log(`${instrName} spot invalid (${spot}) — ignoring tick`);
        saveState();
        return;
      }

      const atm = calcATM(spot, cfg.strikeInterval);
      const atmShifted = state.lastATM !== null && state.lastATM !== atm;

      log(
        `${instrName}: ${spot.toFixed(2)}  ATM: ${atm}  ITM-${itmDepth}  (prev ATM: ${state.lastATM || '?'})  CE:${state.CE.toUpperCase()}  PE:${state.PE.toUpperCase()}`
      );

      // Cooldown (shared by supertrend + bias): update immediately on first ATM
      // shift, then block for the cooldown window. Trade-just-closed, force, and
      // a bias direction flip always bypass.
      const cooldownCheck = shouldUpdateATM(state, {
        force,
        CEjustClosed,
        PEjustClosed,
        atmShifted,
      });
      const cooldownBlocksATM = !cooldownCheck.update;
      if (cooldownBlocksATM) {
        log(
          `ATM shifted ${state.lastATM}→${atm} — cooldown active (${cooldownCheck.remaining}s remaining)`
        );
      } else if (atmShifted) {
        log(`ATM shifted: ${state.lastATM} → ${atm}`);
      }

      const ceStrike = atm - itmDepth * cfg.strikeInterval;
      const peStrike = atm + itmDepth * cfg.strikeInterval;

      // Supertrend is ENABLED by default (paused only when explicitly disabled).
      const stEnabled = config.supertrend?.enabled !== false;

      // Pause/resume edge detection (per strategy). On RESUME → force an immediate
      // update this tick. A paused strategy must have its alerts DISABLED — we do this
      // on the pause transition AND on the startup/force tick when it's already paused
      // (so a strategy that starts paused, e.g. bias by default, gets its alerts off).
      const stJustPaused = state.stEnabledLast === true && !stEnabled;
      const stJustResumed = state.stEnabledLast === false && stEnabled;
      const biasJustPaused = state.biasEnabledLast === true && !biasEnabled;
      const biasJustResumed = state.biasEnabledLast === false && biasEnabled;
      state.stEnabledLast = stEnabled;
      state.biasEnabledLast = biasEnabled;

      // Safety net: never disable a strategy's alerts while a trade is OPEN —
      // that would strand the running trade's exit/target. The UI also blocks
      // pausing while open; this guards against direct config edits.
      const stOpen = state.CE === 'open' || state.PE === 'open';
      const biasOpen = state.biasPosition === 'open';
      const stWantDisable = (stJustPaused || (force && !stEnabled)) && !stOpen;
      const biasWantDisable = (biasJustPaused || (force && !biasEnabled)) && !biasOpen;
      if ((stJustPaused || (force && !stEnabled)) && stOpen)
        log('[SUPERTREND] pause deferred — a trade is OPEN; alerts kept until it closes');
      if ((biasJustPaused || (force && !biasEnabled)) && biasOpen)
        log('[BIAS] pause deferred — a trade is OPEN; alerts kept until it closes');

      if (stWantDisable || biasWantDisable) {
        // Park the chart on spot first so the Alerts panel shows all alerts with
        // their Stop buttons — same setup the working reconcile/update path uses.
        await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (stWantDisable) {
        log('[SUPERTREND] paused — disabling its 4 alerts');
        await deactivateAlerts(cdpAlerts, supertrendAlertNames(instrName), 'ST');
      }
      if (biasWantDisable) {
        log('[BIAS] paused — disabling its alerts');
        await deactivateAlerts(cdpAlerts, biasAlertNames(instrName), 'BIAS');
        state.lastBiasActivatedDir = null; // force full reconcile (re-enable) on resume
        state.biasEntryParked = false;
      }

      // Shared ATM-driven trigger (also covers instrument/depth change + force).
      const atmDriven = !cooldownBlocksATM && (atmShifted || depthChanged || instrChanged || force);
      // Resume forces an immediate update regardless of ATM/cooldown.
      const needsUpdate = atmDriven || stJustResumed;

      // Supertrend has work? (mirrors the original early-return condition, minus cooldown).
      // A resume bypasses the cooldown to update immediately.
      const stHasWork =
        stEnabled &&
        (stJustResumed ||
          (!cooldownBlocksATM &&
            (atmShifted || depthChanged || instrChanged || force || CEjustClosed || PEjustClosed)));

      // Bias has work? Flip / just-opened / just-closed / resume / retry bypass the cooldown.
      const biasHasWork =
        biasEnabled &&
        (biasDirectionFlip ||
          biasJustClosed ||
          biasJustOpened ||
          biasJustResumed ||
          atmDriven ||
          retryNextTick.bias);

      if (!stHasWork && !biasHasWork) {
        saveState();
        return;
      }

      // 4 + 5. Supertrend CE/PE alert updates
      if (stHasWork) {
        // 4. Update CE alerts — skip if CE trade is running (don't move alerts mid-trade)
        if (state.CE === 'closed') {
          if (needsUpdate || CEjustClosed || retryNextTick.CE) {
            if (
              CEjustClosed &&
              !needsUpdate &&
              !retryNextTick.CE &&
              state.lastCEStrike === ceStrike
            ) {
              log(`CE exit sync skipped — strike unchanged (${ceStrike})`);
            } else {
              if (retryNextTick.CE) log(`Retrying CE alerts → strike: ${ceStrike}`);
              else if (CEjustClosed && !needsUpdate)
                log(`Syncing CE alerts after trade exit → strike: ${ceStrike}`);
              else log(`Updating CE alerts → ITM-${itmDepth} strike: ${ceStrike}`);
              const ceResults = await updateAlerts(
                cdpChart,
                cdpAlerts,
                'CE',
                ceStrike,
                cfg,
                instrName
              );
              const ceFailed = ceResults.some((r) => !r?.success);
              retryNextTick.CE = ceFailed;
              if (!ceFailed) state.lastCEStrike = ceStrike;
              await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
            }
          }
        } else {
          log(`CE trade is RUNNING — skipping CE alert update (alerts stay on current strike)`);
        }

        // 5. Update PE alerts — skip if PE trade is running (don't move alerts mid-trade)
        if (state.PE === 'closed') {
          if (needsUpdate || PEjustClosed || retryNextTick.PE) {
            if (
              PEjustClosed &&
              !needsUpdate &&
              !retryNextTick.PE &&
              state.lastPEStrike === peStrike
            ) {
              log(`PE exit sync skipped — strike unchanged (${peStrike})`);
            } else {
              // Brief stop at spot between CE and PE so the panel scroll position resets.
              await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
              await new Promise((r) => setTimeout(r, 1000));
              if (retryNextTick.PE) log(`Retrying PE alerts → strike: ${peStrike}`);
              else if (PEjustClosed && !needsUpdate)
                log(`Syncing PE alerts after trade exit → strike: ${peStrike}`);
              else log(`Updating PE alerts → ITM-${itmDepth} strike: ${peStrike}`);
              const peResults = await updateAlerts(
                cdpChart,
                cdpAlerts,
                'PE',
                peStrike,
                cfg,
                instrName
              );
              const peFailed = peResults.some((r) => !r?.success);
              retryNextTick.PE = peFailed;
              if (!peFailed) state.lastPEStrike = peStrike;
              await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
            }
          }
        } else {
          log(`PE trade is RUNNING — skipping PE alert update (alerts stay on current strike)`);
        }
      } // end stHasWork (supertrend block)

      // 5b. Bias alert updates — manual direction, 3 alerts on one ITM strike.
      if (biasHasWork) {
        const { strike: biasStrike, optType } = calcBiasStrike(
          atm,
          itmDepth,
          cfg.strikeInterval,
          biasEffectiveDir
        );
        // Flip / resume / first reconcile: deactivate the opposite direction.
        // Re-activate the chosen 3 on a flip-back or a resume (they were disabled).
        if (
          biasDirectionFlip ||
          biasJustResumed ||
          state.lastBiasActivatedDir !== biasEffectiveDir
        ) {
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
          await new Promise((r) => setTimeout(r, 1000));
          await applyBiasActivation(
            cdpAlerts,
            instrName,
            biasEffectiveDir,
            biasDirectionFlip || biasJustResumed
          );
          state.lastBiasActivatedDir = biasEffectiveDir;
          if (biasDirectionFlip) {
            // New direction starts flat — reset position + seal its log snapshot.
            state.biasPosition = 'closed';
            state.lastBiasLogSnapshot = historyItems.slice(0, 30);
          }
        }
        if (state.biasPosition === 'open') {
          // Trade running on the chosen direction. Don't move symbols.
          // On entry fire: set entry price→0 + disable it; leave exit/target running.
          if (biasJustOpened && !state.biasEntryParked) {
            const entrySymbol = buildSymbol(cfg, state.lastBiasStrike ?? biasStrike, optType);
            log(
              `BIAS trade OPENED (${biasEffectiveDir.toUpperCase()}) — parking entry (price→0 + disable); exit/target left running`
            );
            await parkBiasEntry(cdpAlerts, instrName, biasEffectiveDir, entrySymbol);
            state.biasEntryParked = true;
          } else {
            log('BIAS trade RUNNING — alerts untouched (entry parked, exit/target running)');
          }
        } else {
          // Position closed — update all 3 alerts: symbol → ITM strike, price → 0.
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
          await new Promise((r) => setTimeout(r, 1000));
          if (retryNextTick.bias)
            log(`Retrying BIAS ${biasEffectiveDir.toUpperCase()} alerts → strike: ${biasStrike}`);
          else
            log(
              `Updating BIAS ${biasEffectiveDir.toUpperCase()} alerts → ${optType} ITM-${itmDepth} strike: ${biasStrike} @ 0`
            );
          const biasResults = await updateBiasAlerts(
            cdpChart,
            cdpAlerts,
            biasEffectiveDir,
            biasStrike,
            optType,
            cfg,
            instrName
          );
          const biasFailed = biasResults.some((r) => !r?.success);
          retryNextTick.bias = biasFailed;
          if (!biasFailed) state.lastBiasStrike = biasStrike;
          // Re-enable the entry alert if it was parked+disabled during a prior trade.
          if (state.biasEntryParked) {
            await reactivateBiasEntry(cdpAlerts, instrName, biasEffectiveDir);
            state.biasEntryParked = false;
          }
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
        }
        state.biasDirection = biasEffectiveDir;
      }

      // 6. Verify supertrend alerts are active after updates (3s delay lets TV self-recover).
      //    Skipped when supertrend is paused — we don't manage its alerts then.
      if (stEnabled) await verifyAlertStatus(cdpAlerts, instrName);

      if (atmShifted && !cooldownBlocksATM) state.lastATMUpdateTime = Date.now();
      if (!cooldownBlocksATM) state.lastATM = atm;
      state.lastInstrument = instrName;
      state.lastITMDepth = itmDepth;
      saveState();
    } catch (e) {
      log(`[ERROR] ${e.message}`);
      if (!cdp.isConnected()) {
        log('CDP disconnected — reconnecting in 5s...');
        await new Promise((r) => setTimeout(r, 5000));
        try {
          await cdp.connect();
          if (bgCDP) {
            bgCDP.close();
            bgCDP = null;
          }
          bgCDP = await openBackgroundTab(9222, 15_000);
          log('CDP reconnected');
        } catch (re) {
          log(`Reconnect failed: ${re.message} — will retry next tick`);
        }
      }
    }
  }

  // Run immediately on start
  await tick(cdp, cdpChart, cdpAlerts, forceFirst);
  forceFirst = false;

  // Poll loop — skip tick if previous one is still running
  let tickRunning = false;
  async function runTickSafe(force) {
    if (tickRunning) {
      log('Tick skipped — previous still running');
      return;
    }
    tickRunning = true;
    try {
      await tick(cdp, cdpChart, cdpAlerts, force);
    } finally {
      tickRunning = false;
    }
  }

  setInterval(() => runTickSafe(false), POLL_MS);

  // Watch the config — react immediately to pause/resume (and itm/direction) changes
  // from the UI instead of waiting up to 60s for the next poll. A force tick applies
  // the change now, bypassing the ATM cooldown. We watch the config *directory* and
  // filter the filename, which survives the UI's atomic temp-file + rename write.
  let configWatchDebounce = null;
  try {
    fs.watch('./config', (_event, filename) => {
      // Strictly match the config file — never react to our own position.json writes
      // (a null filename on some platforms is ignored too, to avoid a write→tick loop).
      if (filename !== 'monitor-config.json') return;
      clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(() => {
        log('[CONFIG] changed — running immediate tick');
        runTickSafe(true);
      }, 400);
    });
  } catch (e) {
    log(`[CONFIG] watch unavailable: ${e.message}`);
  }
}

// Only auto-run when invoked directly, not when imported for tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
