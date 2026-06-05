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
  lastInstrument: null,
  lastITMDepth: null,
  lastLogSnapshot: [], // top of Log tab from previous tick — used to detect new fires
};
let itmOverride = null; // set by --itm CLI flag (highest priority)
export const ATM_COOLDOWN_MS = 90_000; // 90s cooldown after an ATM-triggered update

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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
      delete state.seenHistoryKeys; // legacy field
      delete state.lastLogSnapshot; // session-only — always re-detect on restart
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
// Deactivate a list of alerts by name (called when update fails)
// ---------------------------------------------------------------------------
async function deactivateAlerts(cdpAlerts, names) {
  for (const name of names) {
    try {
      const r = await cdpAlerts.handle('alert_deactivate', { alertId: name });
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      if (d.success)
        log(`  [PAUSED] "${name}" deactivated — will re-activate after successful update`);
      else log(`  [WARN] Could not deactivate "${name}": ${d.message || 'unknown'}`);
    } catch (_e) {
      /* ignore */
    }
  }
}

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

export function processHistoryForPositionChanges(historyItems, stateObj) {
  // Detect new fires by comparing current log with the previous tick's snapshot.
  // TV's time field is often empty so key-based dedup breaks (same key every fire).
  // Instead: find items at the TOP of the current list that weren't at the top last tick.
  const prevSnapshot = stateObj.lastLogSnapshot || [];
  let newItems = [];

  if (prevSnapshot.length === 0) {
    // Fresh start — scan log from newest to oldest to determine current CE/PE state.
    // Stop once both sides are determined (most recent event wins per side).
    let changed = false;
    let ceDone = false,
      peDone = false;
    for (const item of historyItems) {
      if (ceDone && peDone) break;
      const n = item.name;
      if (!ceDone && Object.values(ALERT_NAMES).some((a) => a.CE.entry === n)) {
        if (stateObj.CE !== 'open') changed = true;
        stateObj.CE = 'open';
        ceDone = true;
        log(`[POSITION] CE OPENED from history (alert: ${n})`);
      } else if (!ceDone && Object.values(ALERT_NAMES).some((a) => a.CE.exit === n)) {
        if (stateObj.CE !== 'closed') changed = true;
        stateObj.CE = 'closed';
        ceDone = true;
        log(`[POSITION] CE CLOSED from history (alert: ${n})`);
      }
      if (!peDone && Object.values(ALERT_NAMES).some((a) => a.PE.entry === n)) {
        if (stateObj.PE !== 'open') changed = true;
        stateObj.PE = 'open';
        peDone = true;
        log(`[POSITION] PE OPENED from history (alert: ${n})`);
      } else if (!peDone && Object.values(ALERT_NAMES).some((a) => a.PE.exit === n)) {
        if (stateObj.PE !== 'closed') changed = true;
        stateObj.PE = 'closed';
        peDone = true;
        log(`[POSITION] PE CLOSED from history (alert: ${n})`);
      }
    }
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
    const tabId = await CDPManager.ensureMonitorTab('./logs/supertrend-tab.json', 9222, [
      './logs/pattern-tab.json',
    ]);
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
  // Tracks CE/PE sides whose last update failed — forces retry next tick

  async function tick(cdp, cdpChart, cdpAlerts, force = false) {
    try {
      // Fail fast if CDP dropped — jump straight to reconnect logic below
      if (!cdp.isConnected()) throw new Error('CDP not connected');

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
      const prevCE = state.CE;
      const prevPE = state.PE;
      const historyResult = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
      const historyItems =
        historyResult?.items ?? (Array.isArray(historyResult) ? historyResult : []);
      processHistoryForPositionChanges(historyItems, state);
      // If a trade just closed, force an immediate alert sync to the current strike —
      // ATM may have moved while the trade was running and the alerts are stale.
      const CEjustClosed = prevCE === 'open' && state.CE === 'closed';
      const PEjustClosed = prevPE === 'open' && state.PE === 'closed';
      if (CEjustClosed) log('[POSITION] CE closed — will sync CE alerts to current strike');
      if (PEjustClosed) log('[POSITION] PE closed — will sync PE alerts to current strike');

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

      // Cooldown: update immediately on first ATM shift, block for 90s after.
      // Trade-just-closed and force always bypass.
      const cooldownCheck = shouldUpdateATM(state, {
        force,
        CEjustClosed,
        PEjustClosed,
        atmShifted,
      });
      if (!cooldownCheck.update) {
        log(
          `ATM shifted ${state.lastATM}→${atm} — cooldown active (${cooldownCheck.remaining}s remaining)`
        );
        saveState();
        return;
      }

      if (
        !atmShifted &&
        !depthChanged &&
        !instrChanged &&
        !force &&
        !CEjustClosed &&
        !PEjustClosed
      ) {
        saveState();
        return;
      }

      if (atmShifted) log(`ATM shifted: ${state.lastATM} → ${atm}`);

      const ceStrike = atm - itmDepth * cfg.strikeInterval;
      const peStrike = atm + itmDepth * cfg.strikeInterval;

      const needsUpdate = atmShifted || depthChanged || instrChanged || force;

      // 4. Update CE alerts — skip if CE trade is running (don't move alerts mid-trade)
      if (state.CE === 'closed') {
        if (needsUpdate || CEjustClosed) {
          if (CEjustClosed && !needsUpdate)
            log(`Syncing CE alerts after trade exit → strike: ${ceStrike}`);
          else log(`Updating CE alerts → ITM-${itmDepth} strike: ${ceStrike}`);
          const ceResults = await updateAlerts(cdpChart, cdpAlerts, 'CE', ceStrike, cfg, instrName);
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
          if (ceResults.some((r) => !r?.success)) {
            const failedNames = ceResults
              .filter((r) => !r?.success)
              .map((r) => r.name)
              .filter(Boolean);
            await deactivateAlerts(cdpAlerts, failedNames);
            log(`[WARN] CE update failed — manual check required.`);
          }
        }
      } else {
        log(`CE trade is RUNNING — skipping CE alert update (alerts stay on current strike)`);
      }

      // 5. Update PE alerts — skip if PE trade is running (don't move alerts mid-trade)
      if (state.PE === 'closed') {
        if (needsUpdate || PEjustClosed) {
          // Brief stop at spot between CE and PE so the panel scroll position resets.
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
          await new Promise((r) => setTimeout(r, 1000));
          if (PEjustClosed && !needsUpdate)
            log(`Syncing PE alerts after trade exit → strike: ${peStrike}`);
          else log(`Updating PE alerts → ITM-${itmDepth} strike: ${peStrike}`);
          const peResults = await updateAlerts(cdpChart, cdpAlerts, 'PE', peStrike, cfg, instrName);
          await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
          if (peResults.some((r) => !r?.success)) {
            const failedNames = peResults
              .filter((r) => !r?.success)
              .map((r) => r.name)
              .filter(Boolean);
            await deactivateAlerts(cdpAlerts, failedNames);
            log(`[WARN] PE update failed — manual check required.`);
          }
        }
      } else {
        log(`PE trade is RUNNING — skipping PE alert update (alerts stay on current strike)`);
      }

      // 6. Verify all 4 alerts are active after updates (3s delay lets TV self-recover)
      await verifyAlertStatus(cdpAlerts, instrName);

      if (atmShifted) state.lastATMUpdateTime = Date.now();
      state.lastATM = atm;
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
  setInterval(async () => {
    if (tickRunning) {
      log('Tick skipped — previous still running');
      return;
    }
    tickRunning = true;
    try {
      await tick(cdp, cdpChart, cdpAlerts, false);
    } finally {
      tickRunning = false;
    }
  }, POLL_MS);
}

// Only auto-run when invoked directly, not when imported for tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
