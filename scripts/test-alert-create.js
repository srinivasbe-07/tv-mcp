#!/usr/bin/env node
/**
 * Test alert creation — creates TradeEntry, TradeSL, TradeTarget
 * Usage: node scripts/test-alert-create.js [entryPrice] [slPrice] [targetPrice]
 * Example: node scripts/test-alert-create.js 73510 73450 73872
 */

import { CDPManager } from '../src/cdp.js';
import { AlertTools } from '../src/tools/alerts.js';
import fs from 'fs';

const entry  = parseFloat(process.argv[2]) || 73510;
const sl     = parseFloat(process.argv[3]) || 73450;
const target = parseFloat(process.argv[4]) || 73872;

let webhook = '';
let token   = '';
try {
  const a = JSON.parse(fs.readFileSync('./config/algotest-config.json', 'utf8'));
  webhook = a.webhookUrl || '';
  token   = a.accessToken || '';
} catch (_) {}

const entryMsg = token ? JSON.stringify({ access_token: token, alert_name: 'Entry' }) : '';
const exitMsg  = token ? JSON.stringify({ access_token: token, alert_name: 'Exit'  }) : '';

const ALERTS = [
  { name: 'TradeEntry',  condition: 'crosses_up',  level: entry,  message: entryMsg, once: true  },
  { name: 'TradeSL',     condition: 'crosses_down', level: sl,     message: exitMsg,  once: false },
  { name: 'TradeTarget', condition: 'crosses_down', level: target, message: exitMsg,  once: false },
];

console.log('\n── Alert Create Test ───────────────────────────');
console.log(`  Entry   : ${entry}   SL: ${sl}   Target: ${target}`);
console.log(`  Webhook : ${webhook || '(none)'}`);
console.log(`  Token   : ${token   ? token.slice(0,8)+'...' : '(none)'}`);
console.log('────────────────────────────────────────────────\n');

const cdp = new CDPManager();

try {
  await cdp.connect();
  console.log('CDP connected\n');

  const alerts = new AlertTools(cdp);

  // Delete existing
  for (const a of ALERTS) {
    try { await alerts.handle('alert_delete', { alertId: a.name }); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('Old alerts deleted\n');

  // Create each alert and report result
  for (const a of ALERTS) {
    console.log(`Creating ${a.name} @ ${a.level} ...`);
    const result = await alerts.handle('alert_create', {
      symbol:    'BTCUSD',
      condition: a.condition,
      level:     a.level,
      name:      a.name,
      message:   a.message,
      webhook,
      once:      a.once,
    });

    let data = {};
    try { data = JSON.parse(result?.content?.[0]?.text || '{}'); } catch (_) {}

    if (data.success) {
      console.log(`  ✓ Created`);
      console.log(`  name set   : ${data.nameSet !== false ? '✓' : '✗ NOT SET'}`);
    } else {
      console.log(`  ✗ FAILED: ${data.message || 'unknown'}`);
    }
    console.log();

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Done — check TradingView Alerts panel:');
  console.log('  1. Name should be TradeEntry / TradeSL / TradeTarget');
  console.log('  2. Click Edit message → check Alert name + Message fields');
  console.log('  3. Click Notifications tab → check Webhook is ticked');

} catch (e) {
  console.error('Error:', e.message);
} finally {
  await cdp.disconnect();
}
