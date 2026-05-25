#!/usr/bin/env node
/**
 * tv-mcp CLI — call any tool directly from the terminal.
 *
 * Usage:
 *   node cli.js <tool-name> [--key value ...]
 *
 * Examples:
 *   node cli.js chart_get_state
 *   node cli.js chart_set_symbol --symbol BTCUSD
 *   node cli.js chart_set_timeframe --timeframe 60
 *   node cli.js quote_get
 *   node cli.js data_get_ohlcv --summary true --limit 5
 *   node cli.js alert_list
 *   node cli.js alert_create --symbol NSE:NIFTY --condition above --level 25000 --name "My Alert"
 *   node cli.js alert_delete --alertId "My Alert"
 *   node cli.js capture_screenshot
 *   node cli.js tv_health_check
 */

import { CDPManager } from './src/cdp.js';
import { ChartTools } from './src/tools/chart.js';
import { PineTools } from './src/tools/pine.js';
import { AlertTools } from './src/tools/alerts.js';
import { UtilityTools } from './src/tools/utility.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const toolName = process.argv[2];

if (!toolName || toolName === '--help' || toolName === '-h') {
  console.log('Usage: node cli.js <tool-name> [--key value ...]');
  console.log('');
  console.log('Tools:');
  console.log('  Chart:   chart_get_state, quote_get, data_get_ohlcv, chart_set_symbol, chart_set_timeframe');
  console.log('  Pine:    pine_get_source, pine_set_source, pine_smart_compile, pine_get_errors, pine_save');
  console.log('  Alerts:  alert_create, alert_list, alert_delete');
  console.log('  Utility: tv_health_check, tv_launch, capture_screenshot');
  console.log('');
  console.log('Examples:');
  console.log('  node cli.js chart_set_symbol --symbol BTCUSD');
  console.log('  node cli.js alert_create --symbol NSE:NIFTY --condition above --level 25000');
  console.log('  node cli.js alert_delete --alertId "0-NiftyDailyBull"');
  process.exit(0);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const raw = argv[i + 1];
      if (!raw || raw.startsWith('--')) { args[key] = true; continue; }
      if (raw === 'true') args[key] = true;
      else if (raw === 'false') args[key] = false;
      else if (raw !== '' && !isNaN(raw)) args[key] = Number(raw);
      else args[key] = raw;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(3));

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------
const cdp = new CDPManager();
const chart = new ChartTools(cdp);
const pine = new PineTools(cdp);
const alerts = new AlertTools(cdp);
const utility = new UtilityTools(cdp);

const ROUTE = {
  chart_get_state: chart, quote_get: chart, data_get_ohlcv: chart,
  chart_set_symbol: chart, chart_set_timeframe: chart,
  pine_get_source: pine, pine_set_source: pine, pine_smart_compile: pine,
  pine_get_errors: pine, pine_save: pine,
  alert_create: alerts, alert_list: alerts, alert_delete: alerts,
  tv_health_check: utility, tv_launch: utility, capture_screenshot: utility,
};

const handler = ROUTE[toolName];
if (!handler) {
  console.error(`Unknown tool: "${toolName}"`);
  console.error('Run  node cli.js --help  for a list of tools.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
async function main() {
  try {
    await cdp.connect();
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }

  try {
    const raw = await handler.handle(toolName, args);

    if (raw?.isError) {
      console.error('Error:', raw.content?.[0]?.text);
      await cdp.disconnect();
      process.exit(1);
    }

    // Pretty-print the result
    const text = raw?.content?.[0]?.text;
    try {
      // Omit base64 data field from screenshot output to keep terminal readable
      const parsed = JSON.parse(text);
      if (parsed?.data && typeof parsed.data === 'string' && parsed.data.length > 200) {
        parsed.data = `<base64 PNG, ${parsed.data.length} chars>`;
      }
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(text);
    }
  } catch (e) {
    console.error('Tool error:', e.message);
    await cdp.disconnect();
    process.exit(1);
  }

  await cdp.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
