#!/usr/bin/env node
/**
 * Quick diagnostic: checks what TradingView APIs are available via CDP.
 * Usage: node scripts/diagnose-chart.js
 */
import { CDPManager } from '../src/cdp.js';

const cdp = new CDPManager();
await cdp.connect();

const script = `
(function() {
  const api = window.TradingViewApi;
  if (!api) return { error: 'window.TradingViewApi is undefined' };

  const activeChart = api.activeChart?.();
  const widget = api._activeChartWidgetWV?._value;

  return {
    apiKeys: Object.keys(api).slice(0, 20),
    activeChart: activeChart ? {
      ok: true,
      hasCreateShape: typeof activeChart.createShape === 'function',
      symbol: activeChart.symbol?.() || 'unknown',
    } : null,
    widget: widget ? {
      ok: true,
      symbol: widget.symbol?.() || 'unknown',
      resolution: widget.resolution?.() || 'unknown',
    } : null,
  };
})()
`;

const result = await cdp.executeScript(script);
console.log(JSON.stringify(result, null, 2));
await cdp.disconnect?.();
process.exit(0);
