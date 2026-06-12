#!/usr/bin/env node
/**
 * UI Server — Supertrend Monitor
 *
 * Pages:
 *   http://localhost:3000            → Dashboard
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

const ST_CONFIG = path.join(ROOT, 'config', 'monitor-config.json');
const POSITION_FILE = path.join(ROOT, 'config', 'position.json');
const NSE_HOLIDAYS_FILE = path.join(ROOT, 'config', 'nse-holidays.json');
const _ST_LOG = path.join(ROOT, 'logs', 'monitor.log');
const SERVER_LOG = path.join(ROOT, 'logs', 'server.log');
const LAUNCH_TV_PS = path.join(ROOT, 'launch-tv.ps1');

const app = express();
app.use(express.json());
const PORT = 3000;

app.use(express.json());

// ── Pages (must be before express.static so routes take priority) ─
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/supertrend', (_req, res) => res.sendFile(path.join(__dirname, 'supertrend.html')));
app.get('/pattern', (_req, res) => res.sendFile(path.join(__dirname, 'pattern.html')));
app.get('/test-alerts', (_req, res) => res.sendFile(path.join(__dirname, 'test-alerts.html')));
app.get('/supertrend-reports', (_req, res) =>
  res.sendFile(path.join(__dirname, 'supertrend-reports.html'))
);
app.get('/1min-reports', (_req, res) => res.sendFile(path.join(__dirname, '1min-reports.html')));
app.get('/3min-reports', (_req, res) => res.sendFile(path.join(__dirname, '3min-reports.html')));

app.use(express.static(__dirname, { index: false }));

// ── Process state ────────────────────────────────────────────────
let stProc = null;
let tvProc = null;
let tvReady = false;

// ── SSE clients ───────────────────────────────────────────────────
let stClients = [];
let stLog = [];
let patClients = [];
let patLog = [];

function broadcast(clients, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.splice(
    0,
    clients.length,
    ...clients.filter((r) => {
      try {
        r.write(msg);
        return true;
      } catch (_e) {
        return false;
      }
    })
  );
}

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const serverLogStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
serverLogStream.on('error', (e) => console.error('[server.log]', e.message));
function serverLog(line) {
  const ts = new Date().toTimeString().slice(0, 8);
  try { serverLogStream.write(`[${ts}] ${line}\n`); } catch (_e) {}
}

function pushST(line) {
  const t = line.trim();
  if (!t) return;
  serverLog(t);
  stLog.push(t);
  if (stLog.length > 200) stLog.shift();
  broadcast(stClients, 'log', { line: t });
}

function pushLog(line) {
  const t = line.trim();
  if (!t) return;
  patLog.push(t);
  if (patLog.length > 200) patLog.shift();
  broadcast(patClients, 'log', { line: t });
}

function getStatus() {
  return {
    tv: tvReady ? 'running' : tvProc ? 'starting' : 'stopped',
    st: stProc ? 'running' : 'stopped',
  };
}

function broadcastStatus() {
  const s = getStatus();
  broadcast(stClients, 'status', s);
  broadcast(patClients, 'status', s);
}

function broadcastPosition(pos) {
  broadcast(stClients, 'position', pos);
}

// Watch position file — broadcast to all pages when monitor.js updates it
fs.watch(POSITION_FILE, () => {
  try {
    const pos = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    broadcastPosition(pos);
  } catch (_e) {
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
  } catch (_e) {
    /* ignore */
  }
  stClients.push(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_e) {} }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    stClients = stClients.filter((c) => c !== res);
  });
});

// ── SSE — Pattern Monitor / TV startup (left panel) ──────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  patLog
    .slice(-50)
    .forEach((line) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  patClients.push(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_e) {} }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    patClients = patClients.filter((c) => c !== res);
  });
});

// ── TradingView ───────────────────────────────────────────────────
app.post('/api/tv/start', (_req, res) => {
  if (tvReady) return res.json({ ok: true, message: 'Already running' });
  if (tvProc) return res.json({ ok: false, message: 'Already starting' });

  pushLog('[UI] Starting TradingView...');
  pushST('[UI] Starting TradingView...');

  tvProc = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', LAUNCH_TV_PS], {
    cwd: ROOT,
  });
  tvProc.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (!line) return;
    pushLog(`[TV] ${line}`);
    pushST(`[TV] ${line}`);
    if (line.includes('CDP is ready') || line.includes('already running')) {
      tvReady = true;
      broadcastStatus();
    }
  });
  tvProc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (!line) return;
    pushLog(`[TV] ${line}`);
    pushST(`[TV] ${line}`);
  });
  tvProc.on('error', (err) => {
    tvProc = null;
    tvReady = false;
    pushLog(`[TV] Failed to start script: ${err.message}`);
    pushST(`[TV] Failed to start script: ${err.message}`);
    broadcastStatus();
  });
  tvProc.on('close', (code) => {
    tvProc = null;
    if (code !== 0) tvReady = false;
    pushLog(`[TV] Script exited (${code})`);
    pushST(`[TV] Script exited (${code})`);
    broadcastStatus();
  });
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/tv/stop', (_req, res) => {
  if (tvProc) {
    try { tvProc.kill(); } catch (_e) { /* already gone */ }
    tvProc = null;
  }
  exec('taskkill /IM TradingView.exe /F', () => {});
  tvReady = false;
  pushST('[UI] TradingView stopped');
  broadcastStatus();
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

    // Read position — skip open trades (same guard as test-supertrend-alerts.js)
    let position = { CE: 'closed', PE: 'closed' };
    try {
      position = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    } catch (_) {
      /* default closed */
    }
    log(`Position: CE=${position.CE.toUpperCase()}  PE=${position.PE.toUpperCase()}`);

    const results = [];
    for (const t of tests) {
      if (position[t.side] === 'open') {
        log(`[${t.side}:${t.role}] "${t.name}" → SKIPPED (trade running)`);
        results.push({
          name: t.name,
          symbol: t.symbol,
          side: t.side,
          role: t.role,
          success: null,
          message: 'SKIPPED — trade running',
        });
        emit('result', {
          name: t.name,
          symbol: t.symbol,
          side: t.side,
          role: t.role,
          success: null,
          message: 'SKIPPED — trade running',
        });
        continue;
      }

      await cdpAlerts.normalizeAlertsPanel();

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
          } catch (_e) {
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

// ── Pattern Monitor API (stub — replace with real implementation) ──
const PM_CONFIG_FILE = path.join(ROOT, 'config', 'pattern-monitor-config.json');

function loadPmConfig() {
  try {
    return JSON.parse(fs.readFileSync(PM_CONFIG_FILE, 'utf8'));
  } catch (_e) {
    return { bias: null, importantLevels: [] };
  }
}
function savePmConfig(cfg) {
  fs.writeFileSync(PM_CONFIG_FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(PM_CONFIG_FILE + '.tmp', PM_CONFIG_FILE);
}

app.get('/api/pm/config', (_req, res) => res.json(loadPmConfig()));

app.post('/api/pm/bias', (req, res) => {
  const { bias } = req.body;
  if (!['up', 'down'].includes(bias)) return res.json({ ok: false, error: 'Invalid bias' });
  const cfg = loadPmConfig();
  cfg.bias = bias;
  savePmConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/pm/levels', (req, res) => {
  const { importantLevels } = req.body;
  if (!Array.isArray(importantLevels)) return res.json({ ok: false, error: 'Invalid levels' });
  const cfg = loadPmConfig();
  cfg.importantLevels = importantLevels.map(Number).filter((n) => n > 0);
  savePmConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/pm/start', (_req, res) => res.json({ ok: true }));
app.post('/api/pm/stop', (_req, res) => res.json({ ok: true }));
app.post('/api/pm/restart', (_req, res) => res.json({ ok: true }));

app.get('/api/pm/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Send dummy log lines for preview
  const lines = [
    '[09:15:02] === Pattern Monitor started ===',
    '[09:15:03] Fetched Day H/L: D-1 to D-10',
    '[09:15:03] Day levels: R=24500  S=24100',
    '[09:15:04] Drew 2 level lines on chart',
    '[09:15:04] Important levels drawn: 24450, 24380',
    '[09:30:02] 15-min candle close — checking levels',
    '[09:30:02] Price 24320 — between levels, no action',
    '[09:45:02] [BREAK] Level 24450 broken — close 24462 above level',
    '[09:45:03] Drew next level: D-3 H 24580',
    '[10:00:02] 15-min candle close — checking levels',
    '[10:00:02] Price 24510 — between levels, no action',
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i < lines.length) {
      res.write(`event: log\ndata: ${JSON.stringify({ line: lines[i++] })}\n\n`);
    }
  }, 400);
  req.on('close', () => clearInterval(iv));
});

// ── EOD Report ────────────────────────────────────────────────────
const reportLog = [];
const reportClients = [];
let reportRunning = false;

function pushReport(line) {
  if (!line.trim()) return;
  reportLog.push(line);
  if (reportLog.length > 300) reportLog.shift();
  const payload = JSON.stringify({ line });
  reportClients.forEach((r) => r.write(`event: log\ndata: ${payload}\n\n`));
}

function broadcastReportStatus() {
  const payload = JSON.stringify({ running: reportRunning });
  reportClients.forEach((r) => r.write(`event: status\ndata: ${payload}\n\n`));
}

app.get('/api/report/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  reportLog
    .slice(-80)
    .forEach((l) => res.write(`event: log\ndata: ${JSON.stringify({ line: l })}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify({ running: reportRunning })}\n\n`);
  reportClients.push(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_e) {} }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    const i = reportClients.indexOf(res);
    if (i >= 0) reportClients.splice(i, 1);
  });
});

// Run generate-daily-report.js — JSON file is the permanent record
app.post('/api/report/run', (req, res) => {
  if (reportRunning) return res.json({ ok: false, message: 'Already running' });
  reportRunning = true;
  broadcastReportStatus();

  const date = (req.body?.date || '').trim();
  const dateArg = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  const label = dateArg || 'today';
  pushReport(`[REPORT] Fetching trade prices for ${label} from TradingView...`);

  const args = ['scripts/generate-daily-report.js'];
  if (dateArg) args.push(dateArg);
  const proc = spawn('node', args, { cwd: ROOT });
  proc.stdout.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .forEach((l) => l.trim() && pushReport(l))
  );
  proc.stderr.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .forEach((l) => l.trim() && pushReport(`[ERR] ${l.trim()}`))
  );
  proc.on('close', (code) => {
    if (code === 0) {
      pushReport('[REPORT] ✓ Done — opening report...');
      // Signal the UI to open the reports page
      reportClients.forEach((r) => r.write(`event: done\ndata: {}\n\n`));
    } else {
      pushReport(`[REPORT] ✗ Failed (exit ${code})`);
    }
    reportRunning = false;
    broadcastReportStatus();
  });

  res.json({ ok: true });
});

const DIR_1MIN = path.join(ROOT, 'logs', 'supertrend', '1min');
const DIR_3MIN = path.join(ROOT, 'logs', 'supertrend', '3min');

// ── Trade screenshots ─────────────────────────────────────────────
// GET /api/report/screenshots?date=YYYY-MM-DD
// SSE stream: reads daily-trades JSON → navigates TradingView per trade
// → scrolls to full entry→exit window → captures one screenshot per trade.
// Saved to logs/supertrend/1min/screenshots/{date}/{id}-{side}.png
const EXCHANGE_MAP = { NIFTY: 'NSE', SENSEX: 'BSE' };

function istTimeToUnixLocal(timeStr, dateStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const utcMs = new Date(`${dateStr}T00:00:00Z`).getTime() + (h * 60 + m - 330) * 60000 + (s || 0) * 1000;
  return Math.floor(utcMs / 1000);
}

let shotRunning = false;

app.get('/api/report/screenshots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emit = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  const log = (msg) => emit('log', { msg });
  const done = (ok, msg) => { emit('done', { ok, msg }); res.end(); };

  if (shotRunning) return done(false, 'Screenshot capture already running');

  const tradeFile = path.join(DIR_1MIN, `daily-trades-${date}.json`);
  let record;
  try { record = JSON.parse(fs.readFileSync(tradeFile, 'utf8')); }
  catch { return done(false, `No trade file found for ${date}`); }

  const trades = (record.trades || []).filter(t => t.entryTime && t.entrySymbol);
  if (trades.length === 0) return done(false, 'No trades in file');

  shotRunning = true;
  const screenshotDir = path.join(DIR_1MIN, 'screenshots', date);
  fs.mkdirSync(screenshotDir, { recursive: true });

  let cdp;
  try {
    log('Connecting to TradingView...');
    let tabId = null;
    try { tabId = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'supertrend-tab.json'), 'utf8')).targetId; } catch { /**/ }
    cdp = new CDPManager(tabId);
    await cdp.connect();
    log('Connected');

    const cdpChart = new ChartTools(cdp);
    const files = [];

    for (const t of trades) {
      const label = `${t.id ?? ''}-${t.side}`.replace(/^-/, '');
      const sym = t.entrySymbol;
      const instr = sym.startsWith('BSX') ? 'SENSEX' : 'NIFTY';
      const qualified = `${EXCHANGE_MAP[instr]}:${sym}`;
      const entryUnix = istTimeToUnixLocal(t.entryTime, date);
      const exitTime = t.exitTime || '15:26:00';
      const exitUnix = istTimeToUnixLocal(exitTime, date);

      log(`Trade ${label}: switching to ${qualified}...`);
      await cdpChart.handle('chart_set_symbol', { symbol: qualified });
      await new Promise(r => setTimeout(r, 2500));
      await cdpChart.handle('chart_set_timeframe', { timeframe: '1' });
      await new Promise(r => setTimeout(r, 1500));

      // Scroll to show full entry→exit with 15-min padding on each side
      const from = entryUnix - 15 * 60;
      const to = exitUnix + 15 * 60;
      await cdp.executeScript(`
        (function() {
          try {
            const ts = window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget?._modelWV?._value?.timeScale?.();
            if (ts?.setVisibleRange) { ts.setVisibleRange({ from: ${from}, to: ${to} }); return 'ok'; }
            return 'no-api';
          } catch(e) { return 'err:' + e.message; }
        })()`);
      await new Promise(r => setTimeout(r, 1500));

      try {
        const shot = await cdp.takeScreenshot();
        const outPath = path.join(screenshotDir, `${label}.png`);
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        files.push(`${label}.png`);
        log(`✓ Saved ${label}.png`);
        emit('file', { name: `${label}.png`, date });
      } catch (e) {
        log(`✗ Screenshot failed for ${label}: ${e.message}`);
      }
    }

    done(true, `${files.length} screenshot(s) saved to screenshots/${date}/`);
  } catch (e) {
    done(false, `Error: ${e.message}`);
  } finally {
    shotRunning = false;
    if (cdp) await cdp.disconnect().catch(() => {});
  }
});

// NSE holidays config
app.get('/api/holidays', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(NSE_HOLIDAYS_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json({});
  }
});

function readTradesDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.match(/^daily-trades-\d{4}-\d{2}-\d{2}\.json$/));
  } catch {
    return {};
  }
  const result = {};
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      result[data.date] = data;
    } catch {
      /* skip corrupt */
    }
  }
  return result;
}

function saveTradesFile(dir, date, trades, instrument, note) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `daily-trades-${date}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    record = { date, instrument: instrument || 'NIFTY' };
  }
  record.trades = trades;
  if (note !== undefined) record.note = note || '';
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
}

// 1-min report endpoints
app.get('/api/report/data', (_req, res) => res.json(readTradesDir(DIR_1MIN)));

app.post('/api/report/save', (req, res) => {
  const { date, trades, note } = req.body;
  if (!date || !trades)
    return res.status(400).json({ ok: false, error: 'date and trades required' });
  try {
    saveTradesFile(DIR_1MIN, date, trades, undefined, note);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 3-min report endpoints
app.get('/api/3min-report/data', (_req, res) => res.json(readTradesDir(DIR_3MIN)));

app.post('/api/3min-report/save', (req, res) => {
  const { date, trades, instrument, note } = req.body;
  if (!date || !trades)
    return res.status(400).json({ ok: false, error: 'date and trades required' });
  try {
    saveTradesFile(DIR_3MIN, date, trades, instrument, note);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`UI Server →  http://localhost:${PORT}            (Dashboard)`);
  console.log(`             http://localhost:${PORT}/supertrend (Supertrend Monitor)`);
  console.log(`             http://localhost:${PORT}/pattern    (Pattern Monitor)`);
  console.log(`             http://localhost:${PORT}/test-alerts (Supertrend Alert Test)`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(
      `\n[ERROR] Port ${PORT} is already in use.\nKill the old server first:\n  netstat -ano | findstr :${PORT}\n  taskkill /PID <pid> /F\n`
    );
  else console.error('[ERROR]', e.message);
  process.exit(1);
});
