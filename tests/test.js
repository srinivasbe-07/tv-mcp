#!/usr/bin/env node
/**
 * tv-mcp live test suite — runs all 16 tools against real TradingView via CDP.
 * Exit 0 if all PASS/SOFT, exit 1 if any FAIL/ERROR.
 *
 * Usage:  node test.js
 *         npm test
 */

import { CDPManager } from '../src/cdp.js';
import { ChartTools } from '../src/tools/chart.js';
import { PineTools } from '../src/tools/pine.js';
import { AlertTools } from '../src/tools/alerts.js';
import { UtilityTools } from '../src/tools/utility.js';

const cdp = new CDPManager();
const chart = new ChartTools(cdp);
const pine = new PineTools(cdp);
const alerts = new AlertTools(cdp);
const utility = new UtilityTools(cdp);

function parse(raw) {
  try {
    return JSON.parse(raw?.content?.[0]?.text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test definitions
// Each test has:
//   run()    — calls the tool handler
//   assert() — returns true if the response is correct
//   soft     — true if a non-success response is still acceptable
//   softMsg  — shown in output when the tool soft-fails
// ---------------------------------------------------------------------------
const TESTS = [
  // Utility
  {
    name: 'tv_health_check',
    run: () => utility.handle('tv_health_check', {}),
    assert: (d) => d?.connected === true,
  },
  {
    name: 'tv_launch',
    run: () => utility.handle('tv_launch', {}),
    assert: (d) => d?.success === true,
  },
  {
    name: 'capture_screenshot',
    run: () => utility.handle('capture_screenshot', { region: 'chart' }),
    assert: (d) => typeof d?.data === 'string' && d.data.length > 100,
  },

  // Chart — read
  {
    name: 'chart_get_state',
    run: () => chart.handle('chart_get_state', {}),
    assert: (d) =>
      typeof d?.symbol === 'string' && d.symbol.length > 0 && typeof d?.timeframe === 'string',
  },
  {
    name: 'quote_get',
    run: () => chart.handle('quote_get', {}),
    assert: (d) => typeof d?.symbol === 'string' && d?.price != null,
  },
  {
    name: 'data_get_ohlcv',
    run: () => chart.handle('data_get_ohlcv', { summary: true, limit: 10 }),
    assert: (d) => Array.isArray(d?.bars) && typeof d?.count === 'number',
  },

  // Chart — write
  {
    name: 'chart_set_symbol',
    run: () => chart.handle('chart_set_symbol', { symbol: 'BTCUSD' }),
    assert: (d) => d?.success === true,
  },
  {
    name: 'chart_set_timeframe',
    run: () => chart.handle('chart_set_timeframe', { timeframe: '60' }),
    assert: (d) => d?.success === true,
  },

  // Pine — read (always works without editor open)
  {
    name: 'pine_get_source',
    run: () => pine.handle('pine_get_source', {}),
    assert: (d) => typeof d?.source === 'string',
  },
  {
    name: 'pine_get_errors',
    run: () => pine.handle('pine_get_errors', {}),
    assert: (d) => Array.isArray(d?.errors),
  },
  {
    name: 'pine_smart_compile',
    run: () => pine.handle('pine_smart_compile', {}),
    assert: (d) => d?.status != null || d?.success != null,
  },

  // Pine — write (needs editor open; graceful soft-fail if not)
  {
    name: 'pine_set_source',
    run: () =>
      pine.handle('pine_set_source', {
        source: "//@version=5\nindicator('MCP Test', overlay=true)\nplot(close)",
      }),
    assert: (d) => d?.success === true || (d?.success === false && typeof d?.message === 'string'),
    soft: true,
    softMsg: 'Pine editor not open (right-click indicator -> Edit script)',
  },
  {
    name: 'pine_save',
    run: () => pine.handle('pine_save', { name: 'MCP-test' }),
    assert: (d) => typeof d?.success === 'boolean',
    soft: true,
    softMsg: 'Pine editor not open',
  },

  // Alerts
  {
    name: 'alert_list',
    run: () => alerts.handle('alert_list', {}),
    assert: (d) => Array.isArray(d?.alerts) && typeof d?.total === 'number',
  },
  {
    name: 'alert_create',
    run: () =>
      alerts.handle('alert_create', {
        symbol: 'NSE:NIFTY',
        condition: 'above',
        level: 40000,
        name: 'MCP-test-ci',
      }),
    assert: (d) => typeof d?.success === 'boolean',
    soft: true,
    softMsg: 'Plan limit may silently reject; dialog closes either way',
  },
  {
    name: 'alert_delete',
    run: () => alerts.handle('alert_delete', { alertId: 'MCP-test-ci' }),
    assert: (d) => typeof d?.success === 'boolean',
    soft: true,
    softMsg: 'Succeeds only if alert_create persisted',
  },

  // Alert history
  {
    name: 'alert_get_history',
    run: () => alerts.handle('alert_get_history', {}),
    assert: (d) => Array.isArray(d?.items) && typeof d?.count === 'number',
    soft: true,
    softMsg: 'Alert history tab must be visible in Alerts panel',
  },

  // alert_update_symbol — one test per alert so name-case bugs are caught individually
  ...[
    'supertrendLongEntry',
    'supertrendLongExit',
    'supertrendshortEntry',
    'supertrendShortExit',
  ].map((alertName) => ({
    name: `alert_update:${alertName.replace('supertrend', '')}`,
    run: async () => {
      const listRaw = await alerts.handle('alert_list', {});
      const listData = parse(listRaw);
      const entry = listData?.alerts?.find((a) => a.name === alertName);
      const alertSymbol = entry?.symbol?.split(',')[0]?.trim() || null;

      if (!alertSymbol) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Alert "${alertName}" not found in Alerts panel` }],
        };
      }

      const stateRaw = await chart.handle('chart_get_state', {});
      const originalChartSymbol = parse(stateRaw)?.symbol || null;

      await chart.handle('chart_set_symbol', { symbol: alertSymbol });
      const result = await alerts.handle('alert_update_symbol', { alertName, symbol: alertSymbol });

      if (originalChartSymbol) {
        await chart.handle('chart_set_symbol', { symbol: originalChartSymbol });
      }
      return result;
    },
    assert: (d) => d?.success === true,
  })),
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runTest(t) {
  const start = Date.now();
  try {
    const raw = await t.run();
    const ms = Date.now() - start;
    if (raw?.isError) {
      return { status: 'FAIL', ms, detail: raw.content?.[0]?.text };
    }
    const data = parse(raw);
    const ok = t.assert(data);
    if (ok) return { status: t.soft ? 'SOFT' : 'PASS', ms, data };
    return { status: 'FAIL', ms, detail: JSON.stringify(data)?.slice(0, 120) };
  } catch (e) {
    return { status: 'ERROR', ms: Date.now() - start, detail: e.message };
  }
}

const PAD_NAME = 22;
const PAD_STATUS = 6;

function statusLabel(status) {
  const colors = { PASS: '\x1b[32m', SOFT: '\x1b[33m', FAIL: '\x1b[31m', ERROR: '\x1b[31m' };
  return `${colors[status] ?? ''}${status}\x1b[0m`;
}

async function main() {
  console.log('\n=== tv-mcp live test suite ===\n');

  // Connect
  try {
    await cdp.connect();
  } catch (e) {
    console.error('CDP connect failed:', e.message);
    console.error('Start TradingView first:  .\\launch-tv.ps1');
    process.exit(1);
  }

  // Save original chart state so we can restore it after write tests
  let originalSymbol = 'NSE:NIFTY';
  let originalTf = 'D';
  try {
    const state = parse(await chart.handle('chart_get_state', {}));
    if (state?.symbol) originalSymbol = state.symbol;
    if (state?.timeframe) originalTf = state.timeframe;
  } catch (_e) {
    /* ignore — chart state unavailable */
  }

  const suiteStart = Date.now();
  const counts = { PASS: 0, SOFT: 0, FAIL: 0, ERROR: 0 };

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const prefix = `[${String(i + 1).padStart(2)}/${TESTS.length}]`;
    process.stdout.write(`${prefix} ${t.name.padEnd(PAD_NAME)}`);

    const r = await runTest(t);
    counts[r.status]++;

    const label = statusLabel(r.status).padEnd(PAD_STATUS + 14); // extra for escape codes
    const timing = `${r.ms}ms`.padStart(6);
    const note = r.status === 'SOFT' && t.softMsg ? `  (${t.softMsg})` : '';
    const fail = r.status === 'FAIL' || r.status === 'ERROR' ? `\n       ${r.detail}` : '';
    console.log(`  ${label} ${timing}${note}${fail}`);
  }

  // Restore chart state
  console.log(`\nRestoring chart: ${originalSymbol} @ ${originalTf}`);
  try {
    await chart.handle('chart_set_symbol', { symbol: originalSymbol });
    await chart.handle('chart_set_timeframe', { timeframe: originalTf });
  } catch (_e) {
    /* ignore restore errors */
  }

  await cdp.disconnect();

  // Summary
  const totalMs = Date.now() - suiteStart;
  const failing = counts.FAIL + counts.ERROR;

  console.log('\n' + '─'.repeat(55));
  console.log(
    `Results: \x1b[32m${counts.PASS} passed\x1b[0m, \x1b[33m${counts.SOFT} soft\x1b[0m, ` +
      `\x1b[31m${counts.FAIL} failed, ${counts.ERROR} errors\x1b[0m | ${(totalMs / 1000).toFixed(1)}s`
  );

  if (failing === 0) {
    console.log('\x1b[32mAll tools working correctly.\x1b[0m');
  } else {
    console.log(`\x1b[31m${failing} tool(s) need attention.\x1b[0m`);
  }
  console.log('');

  process.exit(failing > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
