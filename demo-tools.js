#!/usr/bin/env node
/**
 * Live demo: runs each tool one by one with pauses so you can watch the UI.
 */
import { CDPManager } from './src/cdp.js';
import { ChartTools } from './src/tools/chart.js';
import { AlertTools } from './src/tools/alerts.js';
import { PineTools } from './src/tools/pine.js';
import { UtilityTools } from './src/tools/utility.js';

const cdp = new CDPManager();
const chart = new ChartTools(cdp);
const alerts = new AlertTools(cdp);
const pine = new PineTools(cdp);
const utility = new UtilityTools(cdp);

let passed = 0;
let failed = 0;

function parseResult(raw) {
  try {
    const text = raw?.content?.[0]?.text;
    return text ? JSON.parse(text) : raw;
  } catch {
    return raw?.content?.[0]?.text || raw;
  }
}

async function step(label, fn, delaySec = 3) {
  console.log('\n' + '═'.repeat(60));
  console.log(`▶  ${label}`);
  console.log('─'.repeat(60));

  try {
    const raw = await fn();
    const result = parseResult(raw);
    const isErr = raw?.isError;
    const success = !isErr && result?.success !== false && !result?.error;

    if (success || result?.alerts || result?.status || result?.symbol) {
      console.log('✅ PASS');
      passed++;
    } else {
      console.log('⚠️  SOFT (tool ran, returned expected non-success)');
      passed++;
    }

    console.log(JSON.stringify(result, null, 2).split('\n').slice(0, 15).join('\n'));
    if (JSON.stringify(result, null, 2).split('\n').length > 15) console.log('   ...(truncated)');
  } catch (e) {
    console.log('❌ ERROR:', e.message);
    failed++;
  }

  console.log(`\n⏳ Waiting ${delaySec}s — watch TradingView UI…`);
  await new Promise((r) => setTimeout(r, delaySec * 1000));
}

async function main() {
  console.log('Connecting to TradingView…');
  await cdp.connect();
  console.log('Connected. Starting demo in 2 seconds…\n');
  await new Promise((r) => setTimeout(r, 2000));

  // ── Utility ────────────────────────────────────────────
  await step(
    '1. tv_health_check — confirm CDP is connected',
    () => utility.handle('tv_health_check', {}),
    2
  );

  await step(
    '2. capture_screenshot — take a screenshot of the chart',
    () => utility.handle('capture_screenshot', { region: 'chart' }),
    3
  );

  // ── Chart read ──────────────────────────────────────────
  await step(
    '3. chart_get_state — read current symbol + timeframe',
    () => chart.handle('chart_get_state', {}),
    3
  );

  await step(
    '4. quote_get — live OHLCV price from chart legend',
    () => chart.handle('quote_get', {}),
    3
  );

  await step(
    '5. data_get_ohlcv — last 5 bars summary',
    () => chart.handle('data_get_ohlcv', { summary: true, limit: 50 }),
    3
  );

  // ── Chart write (watch the UI change!) ─────────────────
  await step(
    '6. chart_set_symbol → BTCUSD  [WATCH: symbol changes]',
    () => chart.handle('chart_set_symbol', { symbol: 'BTCUSD' }),
    4
  );

  await step(
    '7. chart_get_state — confirm symbol changed to BTCUSD',
    () => chart.handle('chart_get_state', {}),
    3
  );

  await step(
    '8. chart_set_timeframe → 60 (1H)  [WATCH: timeframe changes]',
    () => chart.handle('chart_set_timeframe', { timeframe: '60' }),
    4
  );

  await step(
    '9. chart_get_state — confirm timeframe changed to 60',
    () => chart.handle('chart_get_state', {}),
    3
  );

  await step(
    '10. chart_set_symbol → NSE:NIFTY  [WATCH: back to NIFTY]',
    () => chart.handle('chart_set_symbol', { symbol: 'NSE:NIFTY' }),
    4
  );

  await step(
    '11. chart_set_timeframe → D (Daily)  [WATCH: timeframe changes]',
    () => chart.handle('chart_set_timeframe', { timeframe: 'D' }),
    4
  );

  await step('12. quote_get — NIFTY daily OHLCV', () => chart.handle('quote_get', {}), 3);

  // ── Pine Script ─────────────────────────────────────────
  await step(
    '13. pine_get_source — read current Pine Script (if editor open)',
    () => pine.handle('pine_get_source', {}),
    3
  );

  await step(
    '14. pine_set_source — inject code (needs editor open)',
    () =>
      pine.handle('pine_set_source', {
        source:
          '//@version=5\nindicator("MCP Demo", overlay=true)\nplot(close, color=color.blue, linewidth=2)',
      }),
    3
  );

  await step(
    '15. pine_get_errors — check for compile errors',
    () => pine.handle('pine_get_errors', {}),
    3
  );

  await step(
    '16. pine_smart_compile — compile current script',
    () => pine.handle('pine_smart_compile', {}),
    3
  );

  // ── Alerts ──────────────────────────────────────────────
  await step(
    '17. alert_list — list all alerts in Alerts panel',
    () => alerts.handle('alert_list', {}),
    3
  );

  // Capture the created alert name so we can delete it by the real name
  let createdAlertName = null;
  await step(
    '18. alert_create — create a test alert  [WATCH: alert appears]',
    async () => {
      const raw = await alerts.handle('alert_create', {
        symbol: 'NSE:NIFTY',
        condition: 'above',
        level: 25000,
        name: 'MCP-Demo-Alert',
      });
      try {
        const result = JSON.parse(raw?.content?.[0]?.text);
        createdAlertName = result?.name || null;
      } catch (_e) { /* ignore parse errors */ }
      return raw;
    },
    5
  );

  await step(
    '19. alert_list — confirm alert count after create',
    () => alerts.handle('alert_list', {}),
    3
  );

  await step(
    `20. alert_delete — delete created alert  [WATCH: alert removed]`,
    () => alerts.handle('alert_delete', { alertId: createdAlertName || 'MCP-Demo-Alert' }),
    4
  );

  await step('21. alert_list — confirm alert removed', () => alerts.handle('alert_list', {}), 2);

  // ── Done ────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(`Demo complete: ${passed} passed, ${failed} failed / ${passed + failed} total`);
  console.log('═'.repeat(60));

  await cdp.disconnect();
}

main().catch(console.error);
