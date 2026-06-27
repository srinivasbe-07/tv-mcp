#!/usr/bin/env node
/**
 * UI Server — Supertrend Monitor
 *
 * Pages:
 *   http://localhost:3000            → Dashboard
 *   http://localhost:3000/supertrend → Supertrend Monitor
 *   http://localhost:3000/bias       → Bias Monitor (shares the merged monitor.js process)
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
app.get('/bias', (_req, res) => res.sendFile(path.join(__dirname, 'bias.html')));
// Legacy path — the pattern monitor was merged into the bias monitor.
app.get('/pattern', (_req, res) => res.redirect(301, '/bias'));
app.get('/test-alerts', (_req, res) => res.sendFile(path.join(__dirname, 'test-alerts.html')));
app.get('/supertrend-reports', (_req, res) =>
  res.sendFile(path.join(__dirname, 'supertrend-reports.html'))
);
app.get('/1min-reports', (_req, res) => res.sendFile(path.join(__dirname, '1min-reports.html')));
app.get('/3min-reports', (_req, res) => res.sendFile(path.join(__dirname, '3min-reports.html')));
// Bias EOD report — reuses the 1-min reports UI, pointed at bias data by the page.
app.get('/bias-reports', (_req, res) => res.sendFile(path.join(__dirname, '1min-reports.html')));

app.use(express.static(__dirname, { index: false }));

// ── Process state ────────────────────────────────────────────────
let stProc = null;
let tvProc = null;
let tvReady = false;

// ── SSE — single unified stream ───────────────────────────────────
let allClients = [];
let stLog = [];
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
serverLogStream.write(`[${new Date().toTimeString().slice(0, 8)}] === server started ===\n`);
function serverLog(line) {
  const ts = new Date().toTimeString().slice(0, 8);
  try {
    serverLogStream.write(`[${ts}] ${line}\n`);
  } catch (_e) {
    /* ignore log write errors */
  }
}

function pushST(line) {
  const t = line.trim();
  if (!t) return;
  serverLog(t);
  stLog.push(t);
  if (stLog.length > 200) stLog.shift();
  broadcast(allClients, 'stlog', { line: t });
}

function pushLog(line) {
  const t = line.trim();
  if (!t) return;
  serverLog(t);
  patLog.push(t);
  if (patLog.length > 200) patLog.shift();
  broadcast(allClients, 'log', { line: t });
}

function getStatus() {
  return {
    tv: tvReady ? 'running' : tvProc ? 'starting' : 'stopped',
    st: stProc ? 'running' : 'stopped',
  };
}

function broadcastStatus() {
  broadcast(allClients, 'status', getStatus());
}

function broadcastPosition(pos) {
  broadcast(allClients, 'position', pos);
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
    // Manual CE/PE override → merge into the grouped supertrend section.
    current.supertrend = { ...(current.supertrend || {}), ...req.body };
    fs.writeFileSync(POSITION_FILE, JSON.stringify(current, null, 2));
    res.json({ ok: true });
    broadcastPosition(current);
    const st = current.supertrend;
    pushST(`[UI] Position updated — CE:${st.CE?.toUpperCase()}  PE:${st.PE?.toUpperCase()}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Status ────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json(getStatus()));

// ── SSE — single unified stream (all pages share this) ───────────
function handleStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  patLog
    .slice(-50)
    .forEach((line) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
  stLog
    .slice(-50)
    .forEach((line) => res.write(`event: stlog\ndata: ${JSON.stringify({ line })}\n\n`));
  reportLog
    .slice(-80)
    .forEach((line) => res.write(`event: replog\ndata: ${JSON.stringify({ line })}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
  res.write(`event: repstatus\ndata: ${JSON.stringify({ running: reportRunning })}\n\n`);
  try {
    const pos = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    res.write(`event: position\ndata: ${JSON.stringify(pos)}\n\n`);
  } catch (_e) {
    /* ignore */
  }
  allClients.push(res);
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      /* client gone — cleaned up on close */
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    allClients = allClients.filter((c) => c !== res);
  });
}

app.get('/api/stream', handleStream);
app.get('/api/events', handleStream);
app.get('/api/st/events', handleStream);
app.get('/api/report/events', handleStream);

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
    try {
      tvProc.kill();
    } catch (_e) {
      /* already gone */
    }
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

    // Read position — skip open trades (same guard as test-supertrend-alerts.js).
    // position.json is grouped by strategy now; read the supertrend section.
    let position = { CE: 'closed', PE: 'closed' };
    try {
      const raw = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
      const st = raw.supertrend || raw; // grouped (new) or flat (legacy)
      position = { CE: st.CE || 'closed', PE: st.PE || 'closed' };
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

// ── Bias Alert Test ───────────────────────────────────────────────
// Verifies the bias alerts (up=CE entry/exit/target, down=PE entry/exit/target)
// can be updated. Mirrors /api/test/supertrend but updates symbol + price 0.
// 6 SHARED bias alerts reused for both NIFTY and SENSEX (see BIAS_ALERT_NAMES in
// monitors/monitor.js) — testing either instrument repoints the same 6 alerts.
const SHARED_BIAS_TEST = {
  up: { entry: '0BiasEntry', exit: '0BiasExit', target: '0BiasTarget' },
  down: { entry: 'zBiasEntry', exit: 'zBiasExit', target: 'zBiasTarget' },
};
const BIAS_TEST_NAMES = {
  NIFTY: SHARED_BIAS_TEST,
  SENSEX: SHARED_BIAS_TEST,
};

app.post('/api/test/bias', async (req, res) => {
  const { instr = 'NIFTY', spot: spotOverride = null, itmOverride = null, dir = null } = req.body;
  const instrName = instr.toUpperCase();
  const cfg = INSTRUMENTS_TEST[instrName];
  const names = BIAS_TEST_NAMES[instrName];
  if (!cfg || !names) return res.status(400).json({ error: `Unknown instrument: ${instrName}` });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (msg) => emit('log', { msg });

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
    return res.end();
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
      emit('done', { error: `Could not read ${instrName} spot. Enter it manually.` });
      return res.end();
    }

    const atm = calcATMTest(spot, cfg.strikeInterval);
    // up = CE (strike below ATM), down = PE (strike above ATM)
    const ceStrike = atm - itmDepth * cfg.strikeInterval;
    const peStrike = atm + itmDepth * cfg.strikeInterval;
    const upSymbol = buildSymbolTest(cfg, ceStrike, 'CE');
    const downSymbol = buildSymbolTest(cfg, peStrike, 'PE');
    log(`Spot: ${spot}  ATM: ${atm}  ITM-${itmDepth}`);
    log(`UP → ${upSymbol}   DOWN → ${downSymbol}`);

    const dirs = dir ? [dir.toLowerCase()] : ['up', 'down'];
    const tests = [];
    for (const d of dirs) {
      const sym = d === 'up' ? upSymbol : downSymbol;
      for (const role of ['entry', 'exit', 'target']) {
        tests.push({ name: names[d][role], symbol: sym, dir: d, role });
      }
    }

    const results = [];
    for (const t of tests) {
      try {
        await cdpAlerts.normalizeAlertsPanel();
        log(`[${t.dir}:${t.role}] Switching chart to ${t.symbol}...`);
        await cdpChart.handle('chart_set_symbol', { symbol: `${exchange}:${t.symbol}` });
        await new Promise((r) => setTimeout(r, 3000));
        log(`[${t.dir}:${t.role}] Updating "${t.name}" → ${t.symbol} @ 0...`);
        const r = await cdpAlerts.handle('alert_update', {
          alertName: t.name,
          symbol: t.symbol,
          level: 0,
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
        log(`[${t.dir}:${t.role}] ${success ? '✓ OK' : '✗ FAIL'} — ${message}`);
        const result = {
          name: t.name,
          symbol: t.symbol,
          dir: t.dir,
          role: t.role,
          success,
          message,
        };
        results.push(result);
        emit('result', result);
      } catch (e) {
        log(`[${t.dir}:${t.role}] ✗ ERROR — ${e.message}`);
        const result = {
          name: t.name,
          symbol: t.symbol,
          dir: t.dir,
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
    log('Bias test complete — switching back to spot chart');
    emit('done', { results, spot, atm, itmDepth, upSymbol, downSymbol });
  } finally {
    await cdp.disconnect().catch(() => {});
    res.end();
  }
});

// ── Bias Monitor API ──────────────────────────────────────────────
// The bias monitor runs inside the merged monitor process (monitor.js),
// so its direction/active live in the bias block of monitor-config.json.
// Process start/stop is shared with supertrend via /api/st/*.
function loadStConfig() {
  try {
    return JSON.parse(fs.readFileSync(ST_CONFIG, 'utf8'));
  } catch (_e) {
    return {};
  }
}
function saveStConfig(cfg) {
  fs.writeFileSync(ST_CONFIG + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(ST_CONFIG + '.tmp', ST_CONFIG);
}

// ── Bias day H/L lines ────────────────────────────────────────────
// Bias is UI-only now (no alert ops, no run/pause, no direction). Position/direction
// status reaches the page via the position SSE. The only setting is which days' H/L
// to draw — two independent day-offset lists (dayHighs / dayLows) persisted in
// position.json (0=today, 1=prev day,…). Legacy single dayLines = both H and L.
// The monitor reads these and draws on its cooldown (idle) tick.
function cleanDayList(a) {
  if (!Array.isArray(a)) return null;
  const out = a.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 60);
  return [...new Set(out)].sort((x, y) => x - y);
}
app.get('/api/bias/daylines', (_req, res) => {
  try {
    const p = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    const arr = (a) => (Array.isArray(a) ? a : []);
    if (!p.dayHighs && !p.dayLows && Array.isArray(p.dayLines)) {
      // Legacy: dayLines meant draw both H and L for each offset.
      res.json({ ok: true, dayHighs: p.dayLines, dayLows: p.dayLines });
    } else {
      res.json({ ok: true, dayHighs: arr(p.dayHighs), dayLows: arr(p.dayLows) });
    }
  } catch (_e) {
    res.json({ ok: true, dayHighs: [], dayLows: [] });
  }
});

app.post('/api/bias/daylines', (req, res) => {
  const dayHighs = cleanDayList(req.body.dayHighs);
  const dayLows = cleanDayList(req.body.dayLows);
  if (dayHighs === null || dayLows === null)
    return res.json({ ok: false, error: 'dayHighs and dayLows must be arrays' });
  try {
    let p = {};
    try {
      p = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
    } catch (_e) {
      /* new file */
    }
    p.dayHighs = dayHighs;
    p.dayLows = dayLows;
    // Bump a nonce so the monitor redraws once even when the offsets are unchanged —
    // a re-Apply re-captures today's (offset 0) live high/low, then freezes it again.
    p.dayLinesNonce = Date.now();
    delete p.dayLines; // migrated to separate H/L lists
    fs.writeFileSync(POSITION_FILE + '.tmp', JSON.stringify(p, null, 2));
    fs.renameSync(POSITION_FILE + '.tmp', POSITION_FILE);
    res.json({ ok: true, dayHighs, dayLows });
    pushST(
      `[UI] Day lines set — highs [${dayHighs.join(', ')}] lows [${dayLows.join(', ')}] — monitor will redraw on cooldown`
    );
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Supertrend run/pause. Supertrend is enabled by default (enabled !== false).
app.get('/api/supertrend/enabled', (_req, res) => {
  const cfg = loadStConfig();
  res.json({ enabled: cfg.supertrend?.enabled !== false });
});

app.post('/api/supertrend/enabled', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.json({ ok: false, error: 'Invalid enabled flag' });
  const cfg = loadStConfig();
  cfg.supertrend = { ...(cfg.supertrend || {}), enabled };
  saveStConfig(cfg);
  res.json({ ok: true });
  pushST(`[UI] Supertrend strategy ${enabled ? 'RESUMED' : 'PAUSED'}`);
});

// ── EOD Report ────────────────────────────────────────────────────
const reportLog = [];
let reportRunning = false;

function pushReport(line) {
  if (!line.trim()) return;
  reportLog.push(line);
  if (reportLog.length > 300) reportLog.shift();
  broadcast(allClients, 'replog', { line });
}

function broadcastReportStatus() {
  broadcast(allClients, 'repstatus', { running: reportRunning });
}

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
      broadcast(allClients, 'done', {});
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
const DIR_BIAS = path.join(ROOT, 'logs', 'bias', '1min');

// The reports UI (1min-reports.html) is shared by supertrend (/1min-reports) and
// bias (/bias-reports); requests pass strategy=bias to route to the bias folder.
// Trade JSON + per-trade screenshots both live under the strategy's dir.
const reportDir = (strategy) => (strategy === 'bias' ? DIR_BIAS : DIR_1MIN);

// ── Trade screenshots ─────────────────────────────────────────────
// GET /api/report/screenshots?date=YYYY-MM-DD
// SSE stream: reads daily-trades JSON → navigates TradingView per trade
// → scrolls to full entry→exit window → captures one screenshot per trade.
// Saved to {strategy dir}/{instrument}/{date}/{symbol}_{time}.png
//   supertrend → logs/supertrend/1min/…   bias (strategy=bias) → logs/bias/1min/…
const EXCHANGE_MAP = { NIFTY: 'NSE', SENSEX: 'BSE' };

function istTimeToUnixLocal(timeStr, dateStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const utcMs =
    new Date(`${dateStr}T00:00:00Z`).getTime() + (h * 60 + m - 330) * 60000 + (s || 0) * 1000;
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
  const done = (ok, msg) => {
    emit('done', { ok, msg });
    res.end();
  };

  if (shotRunning) return done(false, 'Screenshot capture already running');

  const baseDir = reportDir(req.query.strategy);
  const tradeFile = path.join(baseDir, `daily-trades-${date}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
  } catch {
    return done(false, `No trade file found for ${date}`);
  }

  const trades = (record.trades || []).filter((t) => t.entryTime && t.entrySymbol);
  if (trades.length === 0) return done(false, 'No trades in file');

  const instrument = (record.instrument || 'NIFTY').toLowerCase();
  shotRunning = true;
  const screenshotDir = path.join(baseDir, instrument, date);
  fs.mkdirSync(screenshotDir, { recursive: true });
  // Clear existing snapshots for this date before re-capturing
  try {
    fs.readdirSync(screenshotDir)
      .filter((f) => f.endsWith('.png'))
      .forEach((f) => fs.unlinkSync(path.join(screenshotDir, f)));
  } catch {
    /**/
  }

  let cdp;
  try {
    log('Connecting to TradingView...');
    // Auto-probe for the chart tab with active TradingViewApi (same approach as generate-daily-report.js)
    cdp = new CDPManager(null);
    await cdp.connect();
    log('Connected');

    const cdpChart = new ChartTools(cdp);
    const files = [];

    const doZoom = (from, to) => `(function() {
      const cw = window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget;
      const ts    = cw?._modelWV?._value?.timeScale?.();
      const model = cw?._modelWV?._value;
      if (!ts || !model) return 'no-api';
      try {
        const barsStore = model.mainSeries?.()?.bars?.();
        if (!barsStore || barsStore.size() === 0) return 'no-bars';
        const first = barsStore.firstIndex();
        const last  = barsStore.lastIndex();
        let fi = -1, ti = -1, fiBest = Infinity, tiBest = Infinity;
        for (let i = first; i <= last; i++) {
          const b = barsStore.valueAt(i);
          const v = Array.isArray(b) ? b : (b?.value || []);
          const t = v[0];
          if (t == null) continue;
          const df = Math.abs(t - ${from}), dt = Math.abs(t - ${to});
          if (df < fiBest) { fiBest = df; fi = i; }
          if (dt < tiBest) { tiBest = dt; ti = i; }
        }
        if (fi < 0) return 'not-found';
        // Reject if closest bar is more than 20 min away from target
        const fbar = barsStore.valueAt(fi);
        const fv = Array.isArray(fbar) ? fbar : (fbar?.value || []);
        if (Math.abs((fv[0] || 0) - ${from}) > 1200) return 'too-far:' + fv[0];
        const pfi = Math.max(first, fi - 15);
        const pti = Math.min(last,  ti + 15);
        ts.scrollToBar?.(fi);
        ts.zoomToBarsRange?.(pfi, pti);
        return 'ok:' + pfi + '-' + pti;
      } catch(e) { return 'err:' + e.message; }
    })()`;

    const scrollToRange = async (from, to) => {
      // First attempt: bars already loaded (works when symbol's last data is target date)
      const r1 = await cdp.executeScript(doZoom(from, to));
      if (String(r1).startsWith('ok')) return r1;

      // Chart is showing a different day (e.g. today for still-active CE options).
      // Ask TV to fetch the target date's data via loadRange, then poll until bars arrive.
      await cdp.executeScript(`(function(){
        const cw = window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget;
        try { cw?.loadRange?.({ from: ${from - 3600}, to: ${to + 3600} }); } catch(e) {}
      })()`);

      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await cdp.executeScript(doZoom(from, to));
        if (String(r).startsWith('ok')) return r;
      }
      return 'no-data';
    };

    for (const t of trades) {
      const timeStr = (t.entryTime || '').slice(0, 5).replace(':', '-');
      const label = `${t.entrySymbol}_${timeStr}`;
      const sym = t.entrySymbol;
      const instr = sym.startsWith('BSX') ? 'SENSEX' : 'NIFTY';
      const qualified = `${EXCHANGE_MAP[instr]}:${sym}`;
      const entryUnix = istTimeToUnixLocal(t.entryTime, date);
      const exitTime = t.exitTime || '15:26:00';
      const exitUnix = istTimeToUnixLocal(exitTime, date);
      const from = entryUnix - 15 * 60;
      const to = exitUnix + 15 * 60;

      log(`Trade ${label}: switching to ${qualified}...`);
      await cdpChart.handle('chart_set_symbol', { symbol: qualified });
      await new Promise((r) => setTimeout(r, 3000));
      await cdpChart.handle('chart_set_timeframe', { timeframe: '1' });
      await new Promise((r) => setTimeout(r, 2000));

      // Unpin chart from live mode by pressing Left arrow, then scroll to trade window
      await cdp.client.Input.dispatchKeyEvent({
        type: 'keyDown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
      });
      await cdp.client.Input.dispatchKeyEvent({
        type: 'keyUp',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
      });
      await new Promise((r) => setTimeout(r, 300));

      let scrollResult = await scrollToRange(from, to);
      log(`  scroll: ${scrollResult}`);
      await new Promise((r) => setTimeout(r, 2500));
      if (!String(scrollResult).startsWith('ok')) {
        scrollResult = await scrollToRange(from, to);
        log(`  scroll retry: ${scrollResult}`);
        await new Promise((r) => setTimeout(r, 2500));
      }

      try {
        const shot = await cdp.takeScreenshot();
        const outPath = path.join(screenshotDir, `${label}.png`);
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        files.push(`${label}.png`);
        log(`✓ Saved ${label}.png`);
        emit('file', { name: `${label}.png`, date, instrument });
      } catch (e) {
        log(`✗ Screenshot failed for ${label}: ${e.message}`);
      }
    }

    done(true, `${files.length} screenshot(s) saved to ${path.relative(ROOT, screenshotDir)}/`);
  } catch (e) {
    done(false, `Error: ${e.message}`);
  } finally {
    shotRunning = false;
    if (cdp) await cdp.disconnect().catch(() => {});
  }
});

// List saved screenshots for a date
app.get('/api/report/screenshots/list', (req, res) => {
  const { date, instrument } = req.query;
  if (!date || !instrument) return res.json([]);
  const dir = path.join(reportDir(req.query.strategy), instrument.toLowerCase(), date);
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    res.json(files);
  } catch {
    res.json([]);
  }
});

// Serve a saved screenshot image
app.get('/api/screenshots/:instrument/:date/:file', (req, res) => {
  const { instrument, date, file } = req.params;
  if (
    !/^[a-zA-Z]+$/.test(instrument) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^[\w-]+\.png$/.test(file)
  )
    return res.status(400).send('Invalid');
  const filePath = path.join(reportDir(req.query.strategy), instrument.toLowerCase(), date, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Delete a single saved screenshot
app.delete('/api/screenshots/:instrument/:date/:file', (req, res) => {
  const { instrument, date, file } = req.params;
  if (
    !/^[a-zA-Z]+$/.test(instrument) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^[\w-]+\.png$/.test(file)
  )
    return res.status(400).json({ ok: false, error: 'Invalid' });
  const filePath = path.join(reportDir(req.query.strategy), instrument.toLowerCase(), date, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Open a snapshot's folder in Windows Explorer with the file selected
app.post('/api/screenshots/:instrument/:date/:file/reveal', (req, res) => {
  const { instrument, date, file } = req.params;
  if (
    !/^[a-zA-Z]+$/.test(instrument) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^[\w-]+\.png$/.test(file)
  )
    return res.status(400).json({ ok: false, error: 'Invalid' });
  const filePath = path.join(reportDir(req.query.strategy), instrument.toLowerCase(), date, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
  // explorer /select highlights the file in its folder. It returns exit code 1
  // even on success, so we don't treat a non-zero exit as an error.
  exec(`explorer /select,"${filePath}"`, () => {});
  res.json({ ok: true });
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

function saveTradesFile(dir, date, trades, instrument, note, brokerage) {
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
  // Per-day brokerage (paper-trading cost, editable). null clears the override
  // back to the default (₹200 × trade count, computed in the UI).
  if (brokerage !== undefined) {
    if (brokerage === null) delete record.brokerage;
    else record.brokerage = brokerage;
  }
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
}

// 1-min report endpoints
app.get('/api/report/data', (_req, res) => res.json(readTradesDir(DIR_1MIN)));

app.post('/api/report/save', (req, res) => {
  const { date, trades, note, brokerage } = req.body;
  if (!date || !trades)
    return res.status(400).json({ ok: false, error: 'date and trades required' });
  try {
    saveTradesFile(DIR_1MIN, date, trades, undefined, note, brokerage);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 3-min report endpoints
app.get('/api/3min-report/data', (_req, res) => res.json(readTradesDir(DIR_3MIN)));

app.post('/api/3min-report/save', (req, res) => {
  const { date, trades, instrument, note, brokerage } = req.body;
  if (!date || !trades)
    return res.status(400).json({ ok: false, error: 'date and trades required' });
  try {
    saveTradesFile(DIR_3MIN, date, trades, instrument, note, brokerage);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Bias report endpoints (same schema/UI as supertrend 1-min) ────
// DIR_BIAS is defined near DIR_1MIN so the shared screenshot endpoints can route to it.
app.get('/api/bias-report/data', (_req, res) => res.json(readTradesDir(DIR_BIAS)));

app.post('/api/bias-report/save', (req, res) => {
  const { date, trades, note, brokerage } = req.body;
  if (!date || !trades)
    return res.status(400).json({ ok: false, error: 'date and trades required' });
  try {
    saveTradesFile(DIR_BIAS, date, trades, undefined, note, brokerage);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Run generate-bias-report.js — EOD bias report
app.post('/api/bias-report/run', (req, res) => {
  if (reportRunning) return res.json({ ok: false, message: 'Already running' });
  reportRunning = true;
  broadcastReportStatus();

  const date = (req.body?.date || '').trim();
  const dateArg = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  pushReport(`[BIAS REPORT] Fetching bias trade prices for ${dateArg || 'today'}...`);

  const args = ['scripts/generate-bias-report.js', '--skip-market-check'];
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
      pushReport('[BIAS REPORT] ✓ Done — opening report...');
      broadcast(allClients, 'done', {});
    } else {
      pushReport(`[BIAS REPORT] ✗ Failed (exit ${code})`);
    }
    reportRunning = false;
    broadcastReportStatus();
  });
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`UI Server →  http://localhost:${PORT}            (Dashboard)`);
  console.log(`             http://localhost:${PORT}/supertrend (Supertrend Monitor)`);
  console.log(`             http://localhost:${PORT}/bias       (Bias Monitor)`);
  console.log(`             http://localhost:${PORT}/bias-reports (Bias EOD Reports)`);
  console.log(`             http://localhost:${PORT}/test-alerts (Supertrend Alert Test)`);
  console.log(`             http://localhost:${PORT}/supertrend-reports (Trade Reports Dashboard)`);
  console.log(`             http://localhost:${PORT}/1min-reports (1-Min Reports)`);
  console.log(`             http://localhost:${PORT}/3min-reports (3-Min Reports)`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(
      `\n[ERROR] Port ${PORT} is already in use.\nKill the old server first:\n  netstat -ano | findstr :${PORT}\n  taskkill /PID <pid> /F\n`
    );
  else console.error('[ERROR]', e.message);
  process.exit(1);
});
