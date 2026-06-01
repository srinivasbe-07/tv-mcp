#!/usr/bin/env node
/**
 * Test cleanup flow:
 *   1. Creates TradeEntry / TradeSL / TradeTarget alerts
 *   2. Polls alert history every 10s
 *   3. When TradeEntry fires (inactive) + SL or Target fires (in history) → deletes all 3
 *
 * Usage: node scripts/test-alert-cleanup.js [entry] [sl] [target]
 *
 * Set prices CLOSE to current market price so they fire quickly, e.g.:
 *   node scripts/test-alert-cleanup.js 73600 73400 73800
 *
 * Then in TradingView, watch the alerts fire — script will auto-delete all 3.
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import fs from 'fs';

const entry = parseFloat(process.argv[2]) || 73600;
const sl = parseFloat(process.argv[3]) || 73400;
const target = parseFloat(process.argv[4]) || 73800;

let webhook = '',
  token = '';
try {
  const a = JSON.parse(fs.readFileSync('./config/algotest-config.json', 'utf8'));
  webhook = a.webhookUrl || '';
  token = a.accessToken || '';
} catch (_) {
  /* ignore */
}

const entryMsg = token ? JSON.stringify({ access_token: token, alert_name: 'Entry' }) : '';
const exitMsg = token ? JSON.stringify({ access_token: token, alert_name: 'Exit' }) : '';
const NAMES = ['TradeEntry', 'TradeSL', 'TradeTarget'];

const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('CDP connected\n');
  const alerts = new AlertTools(cdp);

  // ── Step 1: Delete old alerts ──────────────────────────────────────
  console.log('Deleting old trade alerts...');
  for (const n of NAMES) {
    try {
      await alerts.handle('alert_delete', { alertId: n });
    } catch (_) {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // ── Step 2: Snapshot current history (ignore pre-existing fires) ───
  let seenKeys = new Set();
  try {
    const h = await alerts.handle('alert_get_history', {});
    const hd = JSON.parse(h?.content?.[0]?.text || '{}');
    seenKeys = new Set((hd.alerts || []).map((i) => `${i.name}|${i.time}`));
    console.log(`History snapshot: ${seenKeys.size} existing entries ignored\n`);
  } catch (_) {
    /* ignore */
  }

  // ── Step 3: Create 3 alerts ────────────────────────────────────────
  console.log('Creating alerts...');
  const createOne = async (name, condition, level, message, once) => {
    const r = await alerts.handle('alert_create', {
      symbol: 'BTCUSD',
      condition,
      level,
      name,
      message,
      webhook,
      once,
    });
    const d = JSON.parse(r?.content?.[0]?.text || '{}');
    console.log(
      `  ${d.success ? '✓' : '✗'} ${name} @ ${level}  [${once ? 'Once only' : 'Every time'}]`
    );
    await new Promise((r) => setTimeout(r, 800));
  };

  await createOne('TradeEntry', 'crosses_up', entry, entryMsg, true);
  await createOne('TradeSL', 'crosses_down', sl, exitMsg, false);
  await createOne('TradeTarget', 'crosses_down', target, exitMsg, false);

  console.log('\n✓ Alerts created. Waiting for them to fire...');
  console.log('  - TradeEntry fires when BTCUSD crosses UP through', entry);
  console.log('  - TradeSL fires when BTCUSD crosses DOWN through', sl);
  console.log('  - TradeTarget fires when BTCUSD crosses DOWN through', target);
  console.log('\nPolling every 10s. Press Ctrl+C to stop.\n');

  // ── Step 4: Poll loop ──────────────────────────────────────────────
  let tradeEntryFired = false;
  let iteration = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, 10000));
    iteration++;
    const now = new Date().toLocaleTimeString('en-IN', { hour12: false });
    process.stdout.write(`[${now}] Poll #${iteration} — `);

    // Check alert_list for TradeEntry inactive (Once only → fired)
    try {
      const listResult = await alerts.handle('alert_list', {});
      const listData = JSON.parse(listResult?.content?.[0]?.text || '{}');
      const tradeAlerts = (listData.alerts || []).filter((a) => NAMES.includes(a.name));

      if (tradeAlerts.length === 0) {
        console.log('No trade alerts found — already deleted or not created');
        break;
      }

      const entryAlert = tradeAlerts.find((a) => a.name === 'TradeEntry');
      if (entryAlert && !entryAlert.active) {
        if (!tradeEntryFired) {
          tradeEntryFired = true;
          console.log('\n  ✓ TradeEntry fired! Position OPEN. Watching for SL/Target...');
        } else {
          process.stdout.write('entry fired, watching SL/Target — ');
        }
      } else {
        process.stdout.write(`entry ${entryAlert?.active ? 'active (waiting)' : 'not found'} — `);
      }
    } catch (e) {
      process.stdout.write(`alert_list error: ${e.message} — `);
    }

    // Check history for new TradeSL or TradeTarget fires
    let exitFired = '',
      exitTime = '';
    try {
      const hResult = await alerts.handle('alert_get_history', {});
      const hData = JSON.parse(hResult?.content?.[0]?.text || '{}');
      for (const item of hData.alerts || []) {
        const key = `${item.name}|${item.time}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (item.name === 'TradeSL' || item.name === 'TradeTarget') {
          exitFired = item.name;
          exitTime = item.time;
        }
      }
    } catch (e) {
      process.stdout.write(`history error: ${e.message}`);
    }

    if (exitFired && !tradeEntryFired) {
      console.log(`${exitFired} fired but no entry yet — ignoring (no position open)`);
      continue;
    }

    if (exitFired && tradeEntryFired) {
      console.log(`\n  ✓ ${exitFired} fired at ${exitTime} — trade CLOSED`);
      console.log('  Deleting all 3 alerts...');
      for (const n of NAMES) {
        try {
          await alerts.handle('alert_delete', { alertId: n });
          console.log(`    ✓ Deleted ${n}`);
          await new Promise((r) => setTimeout(r, 400));
        } catch (_) {
          console.log(`    ✗ ${n} not found (already gone)`);
        }
      }
      console.log('\n✓ Cleanup complete. Trade cycle finished.\n');
      break;
    }

    console.log('no exit yet');
  }
} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect();
}
