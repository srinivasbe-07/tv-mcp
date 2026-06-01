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

const server = app.listen(PORT, () => {
  console.log(`UI Server →  http://localhost:${PORT}            (Dashboard)`);
  console.log(`             http://localhost:${PORT}/pattern    (Pattern Monitor)`);
  console.log(`             http://localhost:${PORT}/supertrend (Supertrend Monitor)`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE')
    console.error(
      `\n[ERROR] Port ${PORT} is already in use.\nKill the old server first:\n  netstat -ano | findstr :${PORT}\n  taskkill /PID <pid> /F\n`
    );
  else console.error('[ERROR]', e.message);
  process.exit(1);
});
