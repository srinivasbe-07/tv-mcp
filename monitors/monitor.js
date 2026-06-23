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
    // Preserve the UI-owned dayLines selection living in position.json — the monitor
    // reads it (loadDayLines) but never authoritatively writes it, so pass through.
    let dayLines = [];
    try {
      const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(prev.dayLines)) dayLines = prev.dayLines;
    } catch (_e) {
      /* ignore */
    }
    const out = {
      date: state.lastDate,
      dayLines,
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

// Build the in-browser Alerts "Log" tab reader. `limit` caps how many items are
// collected (newest-first). The monitor's per-tick position diffing only needs the
// most recent handful, so it uses the small default (30) to keep ticks fast. EOD
// report generators pass a large limit to capture a full trading day — both bias
// and supertrend fires share this one Log tab, so an active day can exceed 100
// interleaved items and 30 would silently drop the morning's trades.
export function buildAlertHistoryScript(limit = 30) {
  return `
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

      // Scroll from top, stop once ${limit} items collected (newest are at top)
      if (scroller) scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 400));
      readCurrent();
      const countAfterTop = byAbsY.size;

      if (scroller && byAbsY.size < ${limit}) {
        const scrollTo = async (pos) => {
          scroller.scrollTop = pos;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
        };
        const step = Math.max(100, Math.floor(scroller.clientHeight * 0.6));
        let pos = step;
        while (pos <= scroller.scrollHeight && byAbsY.size < ${limit}) {
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
        .slice(0, ${limit})
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
}

// Per-tick monitor reader — small, fast (most-recent items only, for diffing).
export const ALERT_HISTORY_SCRIPT = buildAlertHistoryScript(30);

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

// Bias alert symbol/price updates were removed: the monitor no longer edits bias
// alert symbols or prices (that caused TV to auto-fill the current price on a symbol
// change and trigger immediately). Bias now only enables the chosen direction and
// disables the opposite — see the bias block in tick(). You set strikes manually.

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
// Day H/L line drawing (user-selected days)
//
// The user picks a list of day offsets (position.json → dayLines), e.g. [0,1,2]:
//   0 = today's H/L, 1 = previous day's H/L, 2 = 2 days prior, …
// The monitor draws a HIGH (red) and LOW (green) line for each selected day, on the
// spot chart. Only our own lines are removed before redrawing (manual drawings are
// left untouched). Drawing happens on an IDLE tick (supertrend not updating), i.e.
// during the cooldown, so it never clashes with supertrend's chart/alert work.
// ---------------------------------------------------------------------------
const DRAWN_IDS_FILE = './logs/drawn-ids.json';
let MONITOR_TAB_ID = ''; // chart tab the monitor draws on (for diagnostics)
let lastDayLinesKey = ''; // signature of what's drawn — skip redraw when unchanged
let lastDayLinesDrawAt = 0; // throttle today's developing-H/L refresh

function loadDrawnIds() {
  try {
    return JSON.parse(fs.readFileSync(DRAWN_IDS_FILE, 'utf8'));
  } catch (_e) {
    return { levelIds: [] };
  }
}
let drawnLevelIds = loadDrawnIds().levelIds || [];
function saveDrawnIds() {
  try {
    fs.writeFileSync(DRAWN_IDS_FILE, JSON.stringify({ levelIds: drawnLevelIds }));
  } catch (_e) {
    /* ignore */
  }
}

// Read the user's day-line offsets from position.json (UI-owned). e.g. [0,1,2].
function loadDayLines() {
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const arr = Array.isArray(p.dayLines) ? p.dayLines : [];
    return arr.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 60);
  } catch (_e) {
    return [];
  }
}

// Bias position/direction for the UI — derived from the alert log across BOTH
// directions (no direction config anymore). Newest relevant fire wins:
// entry → open, exit/target → closed.
export function deriveBiasStatus(historyItems, instrName) {
  const sets = BIAS_ALERT_NAMES[instrName];
  if (!sets) return { position: 'closed', direction: null };
  for (const item of historyItems || []) {
    const n = item.name;
    for (const dir of ['up', 'down']) {
      const s = sets[dir];
      if (!s) continue;
      if (n === s.entry) return { position: 'open', direction: dir };
      if (n === s.exit || n === s.target) return { position: 'closed', direction: dir };
    }
  }
  return { position: 'closed', direction: null };
}

// Fetch daily bars by briefly switching the tab to the spot symbol on the Daily
// timeframe and restoring it — atomic inside one evaluate so the read never lands
// mid-switch (the bug that put option prices in the levels array).
async function fetchDailyBars(cdp, symbol, limit, tf = 'D') {
  const script = `
    (async function() {
      try {
        const widget = window.TradingViewApi?._activeChartWidgetWV?._value;
        if (!widget) return { bars: [], error: 'No chart widget' };
        const prevSymbol = widget.symbol?.() || '';
        const prevTf     = widget.resolution?.() || '';
        const needSymbol = prevSymbol !== '${symbol}';
        const needTf     = prevTf !== '${tf}';
        if (needSymbol) {
          for (const m of ['setSymbol','changeSymbol','setTicker']) {
            if (typeof widget[m] === 'function') { widget[m]('${symbol}'); break; }
          }
          await new Promise(r => setTimeout(r, 1800));
        }
        if (needTf) {
          for (const m of ['setResolution','setInterval','changeResolution']) {
            if (typeof widget[m] === 'function') { widget[m]('${tf}'); break; }
          }
          await new Promise(r => setTimeout(r, 1800));
        }
        let bars = [];
        const store = widget?._chartWidget?._modelWV?._value?.mainSeries?.()?.bars?.();
        if (store && store.size() > 0) {
          const last = store.lastIndex();
          const first = store.firstIndex();
          const from = Math.max(first, last - ${limit} + 1);
          for (let i = from; i <= last; i++) {
            const b = store.valueAt(i);
            if (!b) continue;
            const v = Array.isArray(b) ? b : (b.value || []);
            if (v.length >= 5)
              bars.push({ time: v[0], high: +v[2], low: +v[3], close: +v[4] });
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
        return { bars };
      } catch (e) { return { bars: [], error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(script).catch(() => null);
  return result?.bars || [];
}

// Cache the last `days` completed daily bars once per day (refetch if `days`
// changes); also capture today's developing bar for the include-today option.
// True once window.TradingViewApi.activeChart().createShape exists — the chart can
// take ~tens of seconds to expose the drawing API after a tab (re)load.
async function drawingApiReady(cdp) {
  return (
    (await cdp
      .executeScript(`typeof window.TradingViewApi?.activeChart?.()?.createShape === 'function'`)
      .catch(() => false)) === true
  );
}
async function waitForDrawingApi(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await drawingApiReady(cdp)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// Remove our previously-drawn lines and draw the new ones in ONE atomic script.
// The authoritative list of OUR entity IDs lives in the page (window.__biasLevelIds)
// so removeEntity always gets the exact original id (correct type — coercing it to a
// String, as before, broke removeEntity for non-string ids and orphaned old lines
// like the D-2/D-3 levels). drawn-ids.json is a best-effort fallback used only to
// clear lines left over from a previous run after a TV/tab reload.
async function drawLevels(cdp, levelObjects, spotSymbol) {
  const persisted = JSON.stringify(drawnLevelIds);
  const spot = JSON.stringify(spotSymbol || '');
  const script = `
    (async function() {
      try {
        const chart = window.TradingViewApi?.activeChart?.();
        if (!chart || typeof chart.createShape !== 'function') return { ready: false };
        // The price-anchored lines only render on the SPOT chart — on an option chart
        // (price range ~hundreds vs ~24000) createShape returns null and nothing shows.
        // Force the chart onto spot here, inside the same script, so the draw is reliable.
        const __spot = ${spot};
        const __w = window.TradingViewApi?._activeChartWidgetWV?._value;
        if (__spot && __w && __w.symbol && __w.symbol() !== __spot) {
          for (const m of ['setSymbol','changeSymbol','setTicker']) {
            if (typeof __w[m] === 'function') { __w[m](__spot); break; }
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        window.__biasLevelIds = window.__biasLevelIds || [];
        // Remove ALL horizontal lines first — ours AND any orphans left by older runs
        // (we no longer have their ids). Other drawing types are left untouched. This
        // is the reliable way to stop stale D-2/D-3 lines lingering on the chart.
        let __removed = 0;
        if (typeof chart.getAllShapes === 'function') {
          for (const s of (chart.getAllShapes() || [])) {
            if (s && s.name === 'horizontal_line') { try { chart.removeEntity(s.id); __removed++; } catch(_e) {} }
          }
        } else {
          for (const id of window.__biasLevelIds.concat(${persisted})) { try { chart.removeEntity(id); } catch(_e) {} }
        }
        window.__biasLevelIds = [];
        const levels = ${JSON.stringify(levelObjects)};
        const serializable = [];
        for (const { price, label, color } of levels) {
          try {
            const id = await chart.createShape(
              { price },
              { shape: 'horizontal_line', lock: false,
                overrides: { linecolor: color, linewidth: 1, linestyle: 2, showLabel: true, text: label } }
            );
            if (id != null) {
              window.__biasLevelIds.push(id); // keep the REAL id (any type) in the page
              if (typeof id === 'string' || typeof id === 'number') serializable.push(id);
            }
          } catch(_e) {}
        }
        return { ready: true, ids: serializable, count: window.__biasLevelIds.length, removed: __removed, symbol: chart.symbol?.() || '' };
      } catch(e) { return { ready: false, error: e.message }; }
    })()
  `;
  const result = await cdp.executeScript(script).catch((e) => ({ ready: false, error: e.message }));
  if (!result?.ready) {
    log(
      `[LEVELS] draw skipped — drawing API not ready${result?.error ? ` (${result.error})` : ''}`
    );
    return false; // keep drawnLevelIds; caller keeps its key so it retries next tick
  }
  drawnLevelIds = result.ids || []; // persist only serializable ids (best-effort)
  saveDrawnIds();
  log(
    `[LEVELS] drew ${result.count} line(s) (cleared ${result.removed ?? 0} old) on chart "${result.symbol}" (tab ${MONITOR_TAB_ID})`
  );
  return true;
}

// Draw H/L lines for the user-selected day offsets (position.json → dayLines).
// offset 0 = today (developing bar), 1 = previous day, 2 = 2 days prior, …
// Redraws when the selection changes, on force (startup), or — if "today" (0) is
// selected — every few minutes so today's developing H/L stays current. Completed
// days are static, so a no-today selection draws once. Empty selection clears all.
async function updateDayLines(cdp, spotSymbol, force = false) {
  const offsets = loadDayLines();
  const key = 'days:' + offsets.join(',');
  const offsetsChanged = key !== lastDayLinesKey;
  const refreshToday = offsets.includes(0) && Date.now() - lastDayLinesDrawAt > 2 * 60_000;
  if (!force && !offsetsChanged && !refreshToday) return;

  let levels = [];
  if (offsets.length) {
    const maxOff = Math.max(...offsets);
    const bars = await fetchDailyBars(cdp, spotSymbol, maxOff + 3); // oldest → newest
    if (bars.length < 1) {
      log('[LINES] no daily bars yet — will retry');
      return;
    }
    for (const off of offsets) {
      const idx = bars.length - 1 - off; // 0 = last bar (today)
      if (idx < 0) {
        log(`[LINES] day ${off}: not enough history`);
        continue;
      }
      const b = bars[idx];
      const label = off === 0 ? 'Today' : `D-${off}`;
      levels.push({ price: b.high, label: `${label} H`, color: '#FF4444' });
      levels.push({ price: b.low, label: `${label} L`, color: '#22BB44' });
    }
  }

  const drew = await drawLevels(cdp, levels, spotSymbol);
  if (!drew) return; // API not ready — retry next idle tick
  lastDayLinesKey = key;
  lastDayLinesDrawAt = Date.now();
  log(`[LINES] drew day lines for offsets [${offsets.join(', ')}]`);
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

  // Bias run state on startup is decided AFTER reading TV history below: RUNNING if a
  // bias position is open (a mid-trade restart keeps managing it), otherwise PAUSED.

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
    MONITOR_TAB_ID = tabId.slice(0, 16);
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

  // ── Draw the user's day H/L lines immediately on connect ─────────
  // Drawing needs only the chart + daily bars, not the alerts panel — so do it now,
  // BEFORE waitForAlertsReady (which can take up to 120s). Lines are drawn from the
  // persisted day-offset selection (position.json → dayLines).
  try {
    await cdpChart.handle('chart_set_symbol', { symbol: todayInstr.spotSymbol });
    log('[LINES] waiting for chart drawing API...');
    const ready = await waitForDrawingApi(cdp, 60000);
    if (!ready) {
      log('[LINES] drawing API not ready after 60s — will draw on a later tick');
    } else {
      await updateDayLines(cdp, todayInstr.spotSymbol, true);
      log('[LINES] startup draw complete');
    }
  } catch (e) {
    log(`[LINES] startup draw failed: ${e.message}`);
  }

  // ── Startup state from TV history (before the alerts-panel wait / first tick) ──
  // Re-derive CE/PE and the bias position (UI status only) from the live alert log so
  // position.json (and the UI, which watches it) is correct immediately — don't wait
  // for waitForAlertsReady (up to 120s).
  if (isMarketHours()) {
    log('[STATE] Market-hours start — reading TV alert history to re-derive positions...');
    try {
      const historyResult = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
      const historyItems =
        historyResult?.items ?? (Array.isArray(historyResult) ? historyResult : []);
      if (historyItems.length > 0) {
        processHistoryForPositionChanges(historyItems, state, todayInstr.name);
        const bs = deriveBiasStatus(historyItems, todayInstr.name);
        state.biasPosition = bs.position;
        state.biasDirection = bs.direction;
        log(
          `[STATE] Re-derived: CE=${state.CE.toUpperCase()} PE=${state.PE.toUpperCase()} BIAS=${state.biasPosition.toUpperCase()}`
        );
      } else {
        log('[STATE] No alert history found — keeping loaded state');
      }
    } catch (e) {
      log(`[STATE] Could not read alert history on startup: ${e.message}`);
    }
  } else {
    // Pre/off-market: no trade can be open.
    state.biasPosition = 'closed';
  }
  saveState();

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

      // 2b. Bias is now UI-only: the monitor NEVER touches bias alerts. It just
      // derives the bias position (open/closed) + last direction from the alert log
      // for the UI status and EOD reports.
      const bs = deriveBiasStatus(historyItems, instrName);
      state.biasPosition = bs.position;
      state.biasDirection = bs.direction;

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
      state.stEnabledLast = stEnabled;

      // Supertrend: never disable while a trade is OPEN (would strand exit/target).
      const stOpen = state.CE === 'open' || state.PE === 'open';
      const stWantDisable = (stJustPaused || (force && !stEnabled)) && !stOpen;
      if ((stJustPaused || (force && !stEnabled)) && stOpen)
        log('[SUPERTREND] pause deferred — a trade is OPEN; alerts kept until it closes');

      if (stWantDisable) {
        // Park the chart on spot first so the Alerts panel shows all alerts.
        await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
        await new Promise((r) => setTimeout(r, 1500));
        log('[SUPERTREND] paused — disabling its 4 alerts');
        await deactivateAlerts(cdpAlerts, supertrendAlertNames(instrName), 'ST');
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

      // Supertrend idle this tick → draw the day H/L lines now, during the cooldown,
      // so the line drawing never clashes with supertrend's chart/alert work.
      if (!stHasWork) {
        try {
          await updateDayLines(cdp, cfg.spotSymbol, force);
        } catch (e) {
          log(`[LINES] ${e.message}`);
        }
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

  // Poll loop — skip tick if previous one is still running. A config-triggered
  // force tick (pause/resume/direction/itm change) that arrives mid-tick is NOT
  // dropped: it's queued and run as soon as the current tick finishes, so UI
  // toggles always apply promptly instead of waiting up to 60s for the next poll.
  let tickRunning = false;
  let pendingForce = false;
  async function runTickSafe(force) {
    if (tickRunning) {
      if (force) {
        pendingForce = true;
        log('Tick busy — queued an immediate re-run for the config change');
      } else {
        log('Tick skipped — previous still running');
      }
      return;
    }
    tickRunning = true;
    try {
      await tick(cdp, cdpChart, cdpAlerts, force);
    } finally {
      tickRunning = false;
    }
    if (pendingForce) {
      pendingForce = false;
      await runTickSafe(true);
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
