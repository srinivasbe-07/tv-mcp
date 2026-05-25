#!/usr/bin/env node
/**
 * Run every tool against the live TradingView CDP connection on port 9222.
 */

import { CDPManager } from './src/cdp.js';
import { ChartTools } from './src/tools/chart.js';
import { PineTools } from './src/tools/pine.js';
import { AlertTools } from './src/tools/alerts.js';
import { UtilityTools } from './src/tools/utility.js';

const cdp = new CDPManager();
const chart = new ChartTools(cdp);
const pine = new PineTools(cdp);
const alert = new AlertTools(cdp);
const util = new UtilityTools(cdp);

const TOOLS = [
  // Utility (no CDP needed for tv_launch, try health_check first)
  { label: 'tv_health_check', fn: () => util.healthCheck({}) },
  { label: 'tv_launch', fn: () => util.launch({}) },
  { label: 'capture_screenshot', fn: () => util.captureScreenshot({ region: 'chart' }) },

  // Chart
  { label: 'chart_get_state', fn: () => chart.getChartState({}) },
  { label: 'quote_get', fn: () => chart.getQuote({}) },
  { label: 'data_get_ohlcv', fn: () => chart.getOHLCV({ summary: true, limit: 10 }) },
  { label: 'chart_set_symbol', fn: () => chart.setSymbol({ symbol: 'AAPL' }) },
  { label: 'chart_set_timeframe', fn: () => chart.setTimeframe({ timeframe: 'D' }) },

  // Pine
  { label: 'pine_get_source', fn: () => pine.getSource({}) },
  {
    label: 'pine_set_source',
    fn: () => pine.setSource({ source: "//@version=5\nindicator('Test')\nplot(close)" }),
  },
  { label: 'pine_smart_compile', fn: () => pine.smartCompile({ timeoutMs: 5000 }) },
  { label: 'pine_get_errors', fn: () => pine.getErrors({}) },
  { label: 'pine_save', fn: () => pine.save({ name: 'TestScript' }) },

  // Alerts
  { label: 'alert_list', fn: () => alert.list({}) },
  {
    label: 'alert_create',
    fn: () => alert.create({ symbol: 'AAPL', condition: 'above', level: 200, name: 'Test Alert' }),
  },
  { label: 'alert_delete', fn: () => alert.delete({ alertId: 'alert_test' }) },
];

function parseResult(raw) {
  if (!raw || !raw.content) return raw;
  try {
    return JSON.parse(raw.content[0].text);
  } catch {
    return raw.content[0]?.text;
  }
}

async function main() {
  console.log('Connecting to TradingView via CDP on port 9222…');
  try {
    await cdp.connect();
    console.log('Connected.\n');
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    process.exit(1);
  }

  let passed = 0,
    failed = 0;

  for (const { label, fn } of TOOLS) {
    process.stdout.write(`▶ ${label.padEnd(24)}`);
    try {
      const raw = await fn();
      const data = parseResult(raw);
      const isError = raw?.isError === true;
      if (isError) {
        failed++;
        console.log(`FAIL  ${raw.content?.[0]?.text ?? JSON.stringify(data)}`);
      } else {
        passed++;
        console.log(`OK    ${JSON.stringify(data).slice(0, 120)}`);
      }
    } catch (e) {
      failed++;
      console.log(`ERROR ${e.message}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed / ${TOOLS.length} total`);

  await cdp.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main();
