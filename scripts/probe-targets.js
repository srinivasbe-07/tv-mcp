#!/usr/bin/env node
/**
 * Probes all CDP targets and identifies Spot / CE / PE chart tabs.
 * Run with TradingView open and 3 chart layouts visible.
 *
 * Usage: node scripts/probe-targets.js
 */
import CDP from 'chrome-remote-interface';

const PORT = 9222;

async function probeTarget(target) {
  let client;
  try {
    client = await CDP({ host: 'localhost', port: PORT, target: target.id });
    const { Runtime } = client;
    await Runtime.enable();

    const { result } = await Runtime.evaluate({
      expression: `
        (function() {
          try {
            const api = window.TradingViewApi;
            if (!api) return { hasTVApi: false };

            const widget = api._activeChartWidgetWV?._value;
            const chart  = api.activeChart?.();
            const symbol = widget?.symbol?.() || chart?.symbol?.() || null;
            const tf     = widget?.resolution?.() || chart?.resolution?.() || null;

            return {
              hasTVApi:       true,
              symbol,
              timeframe:      tf,
              hasCreateShape: typeof chart?.createShape === 'function',
              hasAlertBtn:    !!document.querySelector('[data-name="set-alert-button"]'),
              alertItems:     document.querySelectorAll('[data-name="alert-item-name"]').length,
            };
          } catch(e) {
            return { hasTVApi: false, error: e.message };
          }
        })()
      `,
      returnByValue: true,
    });

    return result?.value ?? { hasTVApi: false, error: 'no value' };
  } catch (e) {
    return { hasTVApi: false, error: e.message };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

function classifySymbol(symbol) {
  if (!symbol) return 'unknown';
  const s = symbol.toUpperCase();
  if (s.includes('NIFTY') && !s.match(/\d{5,}/)) return 'SPOT';
  if (s.match(/[CP]\d{4,}$/)) return s.includes('C') ? 'CE' : 'PE';
  if (s.includes('SENSEX') && !s.match(/\d{5,}/)) return 'SPOT';
  return 'other';
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nProbing CDP targets on port ${PORT}...\n`);

let targets;
try {
  targets = await CDP.List({ host: 'localhost', port: PORT });
} catch (e) {
  console.error(`Cannot reach CDP on port ${PORT}: ${e.message}`);
  process.exit(1);
}

console.log(`Found ${targets.length} total target(s)\n`);

const chartTargets = [];

for (const t of targets) {
  if (t.type !== 'page' && t.type !== 'webview') continue;

  process.stdout.write(`Probing ${t.id.slice(0, 20)}... `);
  const info = await probeTarget(t);

  if (!info.hasTVApi) {
    console.log('no TradingViewApi');
    continue;
  }

  const role = classifySymbol(info.symbol);
  chartTargets.push({ id: t.id, title: t.title, ...info, role });
  console.log(`✓  ${info.symbol || '?'} (${role})`);
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('CHART TARGETS WITH TradingViewApi');
console.log('═'.repeat(60));

if (!chartTargets.length) {
  console.log('\n✗  No chart targets found. Is TradingView running?\n');
  process.exit(1);
}

const spotTargets = chartTargets.filter((t) => t.role === 'SPOT');
const ceTargets = chartTargets.filter((t) => t.role === 'CE');
const peTargets = chartTargets.filter((t) => t.role === 'PE');
const otherTargets = chartTargets.filter((t) => !['SPOT', 'CE', 'PE'].includes(t.role));

function printGroup(label, list) {
  console.log(`\n── ${label} ─────────────────────────────────`);
  if (!list.length) {
    console.log('  (none found)');
    return;
  }
  for (const t of list) {
    console.log(`  ID        : ${t.id}`);
    console.log(`  Symbol    : ${t.symbol}`);
    console.log(`  Timeframe : ${t.timeframe}`);
    console.log(`  Drawing   : createShape=${t.hasCreateShape ? '✓' : '✗'}`);
    console.log(`  Alerts    : btn=${t.hasAlertBtn ? '✓' : '✗'}  items=${t.alertItems}`);
  }
}

printGroup('SPOT tab (zone drawing)', spotTargets);
printGroup('CALL / CE tab', ceTargets);
printGroup('PUT / PE tab', peTargets);
if (otherTargets.length) printGroup('Other chart targets', otherTargets);

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('VERDICT');
console.log('═'.repeat(60));

const hasSpot = spotTargets.length >= 1;
const hasCE = ceTargets.length >= 1;
const hasPE = peTargets.length >= 1;

if (hasSpot && hasCE && hasPE) {
  console.log('\n✅  All 3 tabs found — multi-tab assignment READY.\n');
  console.log('   Spot tab ID : ' + spotTargets[0].id);
  console.log('   CE tab ID   : ' + ceTargets[0].id);
  console.log('   PE tab ID   : ' + peTargets[0].id);
} else {
  console.log('\n⚠  Missing tabs:');
  if (!hasSpot) console.log('   ✗  NIFTY spot tab — open a chart layout showing NSE:NIFTY');
  if (!hasCE) console.log('   ✗  CE tab — open a chart layout showing a NIFTY CE option');
  if (!hasPE) console.log('   ✗  PE tab — open a chart layout showing a NIFTY PE option');
  console.log('\n   In TradingView: use the layout tabs (top) to open 3 separate charts.\n');
}
