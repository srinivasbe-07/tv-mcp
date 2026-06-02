#!/usr/bin/env node
/**
 * UI Server — Pattern Monitor + Supertrend Monitor
 *
 * Pages:
 *   http://localhost:3000            → Pattern Monitor
 *   http://localhost:3000/supertrend → Supertrend Monitor
 *
 * Usage: node ui/server.js
 */

import express from 'express';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import { ChartTools } from '../src/tools/chart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PATTERN_CONFIG = path.join(ROOT, 'config', 'pattern-monitor-config.json');
const ST_CONFIG = path.join(ROOT, 'config', 'monitor-config.json');
const POSITION_FILE = path.join(ROOT, 'config', 'position.json');
const _PATTERN_LOG = path.join(ROOT, 'logs', 'pattern-monitor.log');
const _ST_LOG = path.join(ROOT, 'logs', 'monitor.log');
const LAUNCH_TV_PS = path.join(ROOT, 'launch-tv.ps1');

const app = express();
const PORT = 3000;

app.use(express.json());

// ── Pages (must be before express.static so routes take priority) ─
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/pattern', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/supertrend', (_req, res) => res.sendFile(path.join(__dirname, 'supertrend.html')));
app.get('/test-alerts', (_req, res) => res.sendFile(path.join(__dirname, 'test-alerts.html')));
app.get('/test-pattern-alerts', (_req, res) => res.sendFile(path.join(__dirname, 'test-pattern-alerts.html')));

app.use(express.static(__dirname, { index: false }));

// ── Process state ────────────────────────────────────────────────
let monitorProc = null;
let stProc = null;
let tvProc = null;
let tvReady = false;

// ── SSE clients — separate channels per page ─────────────────────
let patternClients = [];
let stClients = [];

let patternLog = [];
let stLog = [];

function broadcast(clients, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.splice(
    0,
    clients.length,
    ...clients.filter((r) => {
      try {
        r.write(msg);
        return true;
      } catch (_) {
        return false;
      }
    })
  );
}

function pushPattern(line) {
  const t = line.trim();
  if (!t) return;
  patternLog.push(t);
  if (patternLog.length > 200) patternLog.shift();
  broadcast(patternClients, 'log', { line: t });
}

function pushST(line) {
  const t = line.trim();
  if (!t) return;
  stLog.push(t);
  if (stLog.length > 200) stLog.shift();
  broadcast(stClients, 'log', { line: t });
}

function getStatus() {
  return {
    tv: tvReady ? 'running' : tvProc ? 'starting' : 'stopped',
    monitor: monitorProc ? 'running' : 'stopped',
    st: stProc ? 'running' : 'stopped',
  };
}

function broadcastStatus() {
  const s = getStatus();
  broadcast(patternClients, 'status', s);
  broadcast(stClients, 'status', s);
}

function broadcastPosition(pos) {
  broadcast(patternClients, 'position', pos);
  broadcast(stClients, 'position', pos);
}

// Watch position file — broadcast to all pages when monitor.js updates it
fs.watch(POSITION_FILE, () => {
  try {
    const pos = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    broadcastPosition(pos);
  } catch (_) {
    /* ignore */
  }
});

// ── Pattern Monitor config ────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(PATTERN_CONFIG, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const current = JSON.parse(fs.readFileSync(PATTERN_CONFIG, 'utf8'));
    const updated = { ...current, ...req.body };
    lastConfigWrite = Date.now();
    fs.writeFileSync(PATTERN_CONFIG, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
    pushPattern(`[UI] Config saved`);
    broadcast(patternClients, 'config', updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Watch config file for external changes (e.g. drag sync from pattern-monitor.js)
let lastConfigWrite = 0;
fs.watch(PATTERN_CONFIG, () => {
  if (Date.now() - lastConfigWrite < 500) return; // skip our own POST writes
  try {
    const cfg = JSON.parse(fs.readFileSync(PATTERN_CONFIG, 'utf8'));
    broadcast(patternClients, 'config', cfg);
  } catch (_) {
    /* ignore */
  }
});

// ── Supertrend config + state ─────────────────────────────────────
app.get('/api/st/config', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(ST_CONFIG, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/st/config', (req, res) => {
  try {
    const current = JSON.parse(fs.readFileSync(ST_CONFIG, 'utf8'));
    fs.writeFileSync(ST_CONFIG, JSON.stringify({ ...current, ...req.body }, null, 2));
    res.json({ ok: true });
    pushST(`[UI] Supertrend config saved`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/st/position', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/st/position', (req, res) => {
  try {
    const current = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    const updated = { ...current, ...req.body };
    fs.writeFileSync(POSITION_FILE, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
    broadcastPosition(updated);
    pushST(
      `[UI] Position updated — CE:${updated.CE?.toUpperCase()}  PE:${updated.PE?.toUpperCase()}`
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Status ────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json(getStatus()));

// ── SSE — Pattern Monitor ─────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  patternLog
    .slice(-50)
    .forEach((line) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  try {
    const pos = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    res.write(`event: position\ndata: ${JSON.stringify(pos)}\n\n`);
  } catch (_) {
    /* ignore */
  }
  patternClients.push(res);
  req.on('close', () => {
    patternClients = patternClients.filter((c) => c !== res);
  });
});

// ── SSE — Supertrend ──────────────────────────────────────────────
app.get('/api/st/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  stLog
    .slice(-50)
    .forEach((line) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  try {
    const pos = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    res.write(`event: position\ndata: ${JSON.stringify(pos)}\n\n`);
  } catch (_) {
    /* ignore */
  }
  stClients.push(res);
  req.on('close', () => {
    stClients = stClients.filter((c) => c !== res);
  });
});

// ── TradingView ───────────────────────────────────────────────────
app.post('/api/tv/start', (_req, res) => {
  if (tvReady) return res.json({ ok: true, message: 'Already running' });
  if (tvProc) return res.json({ ok: false, message: 'Already starting' });

  pushPattern('[UI] Starting TradingView...');
  pushST('[UI] Starting TradingView...');

  tvProc = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', LAUNCH_TV_PS], {
    cwd: ROOT,
  });
  tvProc.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (!line) return;
    pushPattern(`[TV] ${line}`);
    pushST(`[TV] ${line}`);
    if (line.includes('CDP is ready') || line.includes('already running')) {
      tvReady = true;
      broadcastStatus();
    }
  });
  tvProc.stderr.on('data', (d) => {
    pushPattern(`[TV] ${d}`);
    pushST(`[TV] ${d}`);
  });
  tvProc.on('close', (code) => {
    tvProc = null;
    if (code !== 0) tvReady = false;
    const msg = `[TV] Script exited (${code})`;
    pushPattern(msg);
    pushST(msg);
    broadcastStatus();
  });
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/tv/stop', (_req, res) => {
  exec('taskkill /IM TradingView.exe /F', () => {
    tvReady = false;
    tvProc = null;
    pushPattern('[UI] TradingView stopped');
    pushST('[UI] TradingView stopped');
    broadcastStatus();
  });
  res.json({ ok: true });
});

// ── Pattern Monitor process ───────────────────────────────────────
app.post('/api/monitor/start', (_req, res) => {
  if (monitorProc) return res.json({ ok: false, message: 'Already running' });
  pushPattern('[UI] Starting pattern monitor...');
  monitorProc = spawn('node', ['monitors/pattern-monitor.js'], { cwd: ROOT });
  monitorProc.stdout.on('data', (d) => d.toString().split('\n').forEach(pushPattern));
  monitorProc.stderr.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .forEach((l) => {
        if (l.trim()) pushPattern(`[ERR] ${l.trim()}`);
      })
  );
  monitorProc.on('close', (code) => {
    pushPattern(`[UI] Pattern monitor stopped (${code})`);
    monitorProc = null;
    broadcastStatus();
  });
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/monitor/stop', (_req, res) => {
  if (!monitorProc) return res.json({ ok: false });
  monitorProc.kill('SIGINT');
  res.json({ ok: true });
});

app.post('/api/monitor/restart', (_req, res) => {
  pushPattern('[UI] Restarting pattern monitor...');
  const doStart = () => {
    monitorProc = spawn('node', ['monitors/pattern-monitor.js'], { cwd: ROOT });
    monitorProc.stdout.on('data', (d) => d.toString().split('\n').forEach(pushPattern));
    monitorProc.stderr.on('data', (d) =>
      d
        .toString()
        .split('\n')
        .forEach((l) => {
          if (l.trim()) pushPattern(`[ERR] ${l.trim()}`);
        })
    );
    monitorProc.on('close', (code) => {
      pushPattern(`[UI] Pattern monitor stopped (${code})`);
      monitorProc = null;
      broadcastStatus();
    });
    broadcastStatus();
  };
  if (monitorProc) {
    monitorProc.once('close', () => setTimeout(doStart, 500));
    monitorProc.kill('SIGINT');
  } else {
    doStart();
  }
  res.json({ ok: true });
});

// ── Supertrend Monitor process ────────────────────────────────────
app.post('/api/st/start', (_req, res) => {
  if (stProc) return res.json({ ok: false, message: 'Already running' });
  pushST('[UI] Starting supertrend monitor...');
  stProc = spawn('node', ['monitors/monitor.js'], { cwd: ROOT });
  stProc.stdout.on('data', (d) => d.toString().split('\n').forEach(pushST));
  stProc.stderr.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .forEach((l) => {
        if (l.trim()) pushST(`[ERR] ${l.trim()}`);
      })
  );
  stProc.on('close', (code) => {
    pushST(`[UI] Supertrend monitor stopped (${code})`);
    stProc = null;
    broadcastStatus();
  });
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/st/stop', (_req, res) => {
  if (!stProc) return res.json({ ok: false });
  stProc.kill('SIGINT');
  res.json({ ok: true });
});

app.post('/api/st/restart', (_req, res) => {
  pushST('[UI] Restarting supertrend monitor...');
  const doStart = () => {
    stProc = spawn('node', ['monitors/monitor.js'], { cwd: ROOT });
    stProc.stdout.on('data', (d) => d.toString().split('\n').forEach(pushST));
    stProc.stderr.on('data', (d) =>
      d
        .toString()
        .split('\n')
        .forEach((l) => {
          if (l.trim()) pushST(`[ERR] ${l.trim()}`);
        })
    );
    stProc.on('close', (code) => {
      pushST(`[UI] Supertrend monitor stopped (${code})`);
      stProc = null;
      broadcastStatus();
    });
    broadcastStatus();
  };
  if (stProc) {
    stProc.once('close', () => setTimeout(doStart, 500));
    stProc.kill('SIGINT');
  } else {
    doStart();
  }
  res.json({ ok: true });
});

// ── Supertrend Alert Test ─────────────────────────────────────────
const ALERT_NAMES_TEST = {
  NIFTY: {
    CE: { entry: 'niftySupertrendLongEntry', exit: 'niftySupertrendLongExit' },
    PE: { entry: 'niftySupertrendShortEntry', exit: 'niftySupertrendShortExit' },
  },
  SENSEX: {
    CE: { entry: 'sensexSupertrendLongEntry', exit: 'sensexSupertrendLongExit' },
    PE: { entry: 'sensexSupertrendShortEntry', exit: 'sensexSupertrendShortExit' },
  },
};
const INSTRUMENTS_TEST = {
  NIFTY: { spotSymbol: 'NSE:NIFTY', strikeInterval: 50, expiryDay: 2, symbolPrefix: 'NIFTY' },
  SENSEX: { spotSymbol: 'BSE:SENSEX', strikeInterval: 100, expiryDay: 4, symbolPrefix: 'BSX' },
};
const NIFTY_ITM_BY_DAY_TEST = { 1: 2, 2: 2, 5: 1 };

function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function calcATMTest(spot, step) {
  return Math.round(spot / step) * step;
}
function getExpiryDateTest(expiryDay) {
  const t = nowIST();
  const daysUntil = (expiryDay - t.getUTCDay() + 7) % 7;
  const d = new Date(t);
  d.setUTCDate(t.getUTCDate() + daysUntil);
  return d;
}
function buildSymbolTest(cfg, strike, type) {
  const d = getExpiryDateTest(cfg.expiryDay);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${cfg.symbolPrefix}${yy}${mm}${dd}${type === 'CE' ? 'C' : 'P'}${strike}`;
}

app.post('/api/test/supertrend', async (req, res) => {
  const { instr = 'NIFTY', spot: spotOverride = null, itmOverride = null, side = null } = req.body;
  const instrName = instr.toUpperCase();
  const cfg = INSTRUMENTS_TEST[instrName];
  if (!cfg) return res.status(400).json({ error: `Unknown instrument: ${instrName}` });

  // Stream logs + results via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (msg) => emit('log', { msg });

  const alertDefs = ALERT_NAMES_TEST[instrName];
  const day = nowIST().getUTCDay();
  const itmDepth =
    itmOverride !== null
      ? itmOverride
      : instrName === 'SENSEX'
        ? 2
        : (NIFTY_ITM_BY_DAY_TEST[day] ?? 2);
  const exchange = cfg.spotSymbol.split(':')[0];

  let cdp;
  try {
    log('Connecting to TradingView CDP...');
    cdp = new CDPManager();
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    emit('done', { error: `CDP connect failed: ${e.message}` });
    res.end();
    return;
  }

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart = new ChartTools(cdp);

  try {
    let spot = spotOverride;
    if (!spot) {
      log(`Reading ${instrName} spot price from chart...`);
      await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
      await new Promise((r) => setTimeout(r, 2000));
      const r = await cdpChart.handle('quote_get', {});
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      spot = d.close || d.price || d.last;
    }
    if (!spot) {
      emit('done', { error: `Could not read ${instrName} spot price. Enter it manually.` });
      res.end();
      return;
    }

    const atm = calcATMTest(spot, cfg.strikeInterval);
    const ceStrike = atm - itmDepth * cfg.strikeInterval;
    const peStrike = atm + itmDepth * cfg.strikeInterval;
    const ceSymbol = buildSymbolTest(cfg, ceStrike, 'CE');
    const peSymbol = buildSymbolTest(cfg, peStrike, 'PE');

    log(`Spot: ${spot}   ATM: ${atm}   ITM-${itmDepth}`);
    log(`CE → ${ceSymbol}   PE → ${peSymbol}`);

    const allTests = [
      { name: alertDefs.CE.entry, symbol: ceSymbol, side: 'CE', role: 'entry' },
      { name: alertDefs.CE.exit, symbol: ceSymbol, side: 'CE', role: 'exit' },
      { name: alertDefs.PE.entry, symbol: peSymbol, side: 'PE', role: 'entry' },
      { name: alertDefs.PE.exit, symbol: peSymbol, side: 'PE', role: 'exit' },
    ];
    const tests = side ? allTests.filter((t) => t.side === side.toUpperCase()) : allTests;

    const results = [];
    for (const t of tests) {
      // Ensure Alerts panel is open and showing items BEFORE the chart switch.
      // If the panel is closed or another panel is active when the chart switches,
      // TradingView re-filters it to the new symbol — hiding the supertrend alerts.
      await cdp
        .executeScript(
          `
        (async function() {
          const hasItems = () => !!document.querySelector('[data-name="alert-item-name"]');
          if (!hasItems()) {
            const btn = document.querySelector('[data-name="alerts"]');
            if (!btn) return;
            const isActive = btn.classList.toString().includes('active') ||
                             !!document.querySelector('[data-name="set-alert-button"]');
            if (isActive) { btn.click(); await new Promise(r => setTimeout(r, 400)); }
            btn.click();
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 250));
              if (hasItems()) break;
            }
          }
        })()
      `
        )
        .catch(() => {});

      log(`[${t.side}:${t.role}] Switching chart to ${t.symbol}...`);
      try {
        await cdpChart.handle('chart_set_symbol', { symbol: `${exchange}:${t.symbol}` });
        await new Promise((r) => setTimeout(r, 3000));
        log(`[${t.side}:${t.role}] Updating "${t.name}"...`);
        const r = await cdpAlerts.handle('alert_update_symbol', {
          alertName: t.name,
          symbol: t.symbol,
        });
        const rawText = r?.content?.[0]?.text || '{}';
        let data = {};
        if (!r?.isError) {
          try {
            data = JSON.parse(rawText);
          } catch (_) {
            /* ignore */
          }
        }
        const success = !r?.isError && !!data.success;
        const message = r?.isError ? rawText : data.message || rawText;
        log(`[${t.side}:${t.role}] ${success ? '✓ OK' : '✗ FAIL'} — ${message}`);
        const result = {
          name: t.name,
          symbol: t.symbol,
          side: t.side,
          role: t.role,
          success,
          message,
        };
        results.push(result);
        emit('result', result);
      } catch (e) {
        log(`[${t.side}:${t.role}] ✗ ERROR — ${e.message}`);
        const result = {
          name: t.name,
          symbol: t.symbol,
          side: t.side,
          role: t.role,
          success: false,
          message: e.message,
        };
        results.push(result);
        emit('result', result);
      }
      await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
      await new Promise((r) => setTimeout(r, 1500));
    }

    log('Test complete — switching back to spot chart');
    emit('done', { results, spot, atm, itmDepth, ceSymbol, peSymbol });
  } finally {
    await cdp.disconnect().catch(() => {});
    res.end();
  }
});

// ── Pattern Alert Test ────────────────────────────────────────────
const PATTERN_ALERT_NAMES_TEST = {
  NIFTY:  { entry: 'niftyPatternLongEntry',  sl: 'niftyPatternLongSL',  target: 'niftyPatternLongTarget'  },
  SENSEX: { entry: 'sensexPatternLongEntry', sl: 'sensexPatternLongSL', target: 'sensexPatternLongTarget' },
};
const PATTERN_ITM_BY_DAY_TEST = { 1: 2, 2: 2, 5: 1 };

app.post('/api/test/pattern', async (req, res) => {
  const { instr = 'NIFTY', spot: spotOverride = null, bias = 'up', itmOverride = null } = req.body;
  const instrName = instr.toUpperCase();
  const cfg = INSTRUMENTS_TEST[instrName];
  if (!cfg) return res.status(400).json({ error: `Unknown instrument: ${instrName}` });
  const names = PATTERN_ALERT_NAMES_TEST[instrName];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (msg) => emit('log', { msg });

  let cdp;
  try {
    log('Connecting to TradingView CDP...');
    cdp = new CDPManager();
    await cdp.connect();
    log('CDP connected');
  } catch (e) {
    emit('done', { error: `CDP connect failed: ${e.message}` });
    res.end();
    return;
  }

  const cdpAlerts = new AlertTools(cdp);
  const cdpChart = new ChartTools(cdp);

  try {
    // Read spot price
    let spot = spotOverride;
    if (!spot) {
      log(`Reading ${instrName} spot price from chart...`);
      await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
      await new Promise((r) => setTimeout(r, 2000));
      const r = await cdpChart.handle('quote_get', {});
      const d = JSON.parse(r?.content?.[0]?.text || '{}');
      spot = d.close || d.price || d.last;
    }
    if (!spot) {
      emit('done', { error: `Could not read ${instrName} spot. Enter it manually.` });
      res.end();
      return;
    }

    // Calculate option symbol
    const day = nowIST().getUTCDay();
    const itmDepth =
      itmOverride !== null ? itmOverride : (instrName === 'SENSEX' ? 2 : (PATTERN_ITM_BY_DAY_TEST[day] ?? 2));
    const atm = calcATMTest(spot, cfg.strikeInterval);
    const optType = bias === 'up' ? 'CE' : 'PE';
    const strike =
      bias === 'up'
        ? atm - itmDepth * cfg.strikeInterval
        : atm + itmDepth * cfg.strikeInterval;
    const symbol = buildSymbolTest(cfg, strike, optType);
    const exchange = cfg.spotSymbol.split(':')[0];

    log(`Spot: ${spot}   ATM: ${atm}   ITM-${itmDepth}   ${optType}`);
    log(`Option: ${symbol}`);

    // Switch chart to option (needed so symbol appears in alert dropdown)
    log(`Switching chart to ${symbol}...`);
    await cdpChart.handle('chart_set_symbol', { symbol: `${exchange}:${symbol}` });
    await new Promise((r) => setTimeout(r, 3000));

    // Derive test levels from last completed bar
    let entry, sl, target;
    try {
      const barsR = await cdpChart.handle('data_get_ohlcv', { symbol, timeframe: '3', bars: 5 });
      const bars = JSON.parse(barsR?.content?.[0]?.text || '{}').bars || [];
      const last = bars[bars.length - 2] || bars[bars.length - 1];
      if (last) {
        entry = last.high;
        sl = last.low;
        target = Math.round((entry + (entry - sl)) * 100) / 100;
        log(`Levels from last bar — Entry:${entry}  SL:${sl}  Target:${target}`);
      }
    } catch { /* ignore */ }
    if (!entry) {
      entry = strike + 10;
      sl = Math.max(1, strike - 10);
      target = strike + 30;
      log(`Levels (fallback) — Entry:${entry}  SL:${sl}  Target:${target}`);
    }

    // Update the 3 fixed alerts
    const tests = [
      { name: names.entry,  level: entry,  role: 'entry'  },
      { name: names.sl,     level: sl,     role: 'sl'     },
      { name: names.target, level: target, role: 'target' },
    ];

    const results = [];
    for (const t of tests) {
      log(`[${t.role}] Updating "${t.name}" @ ${t.level}...`);
      try {
        const r = await cdpAlerts.handle('alert_update', {
          alertName: t.name,
          symbol,
          level: t.level,
        });
        const rawText = r?.content?.[0]?.text || '{}';
        let data = {};
        if (!r?.isError) { try { data = JSON.parse(rawText); } catch { /* ignore */ } }
        const success = !r?.isError && !!data.success;
        const message = r?.isError ? rawText : (data.message || rawText);
        log(`[${t.role}] ${success ? '✓ OK' : '✗ FAIL'} — ${message}`);
        const result = { name: t.name, symbol, level: t.level, role: t.role, success, message };
        results.push(result);
        emit('result', result);
      } catch (e) {
        log(`[${t.role}] ✗ ERROR — ${e.message}`);
        const result = { name: t.name, symbol, level: t.level, role: t.role, success: false, message: e.message };
        results.push(result);
        emit('result', result);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    log('Done — switching back to spot chart');
    await cdpChart.handle('chart_set_symbol', { symbol: cfg.spotSymbol });
    emit('done', { results, spot, atm, itmDepth, symbol });
  } finally {
    await cdp.disconnect().catch(() => {});
    res.end();
  }
});

const server = app.listen(PORT, () => {
  console.log(`UI Server →  http://localhost:${PORT}            (Dashboard)`);
  console.log(`             http://localhost:${PORT}/pattern    (Pattern Monitor)`);
  console.log(`             http://localhost:${PORT}/supertrend (Supertrend Monitor)`);
  console.log(`             http://localhost:${PORT}/test-alerts (Supertrend Alert Test)`);
  console.log(`             http://localhost:${PORT}/test-pattern-alerts (Pattern Alert Test)`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(
      `\n[ERROR] Port ${PORT} is already in use.\nKill the old server first:\n  netstat -ano | findstr :${PORT}\n  taskkill /PID <pid> /F\n`
    );
  else console.error('[ERROR]', e.message);
  process.exit(1);
});
