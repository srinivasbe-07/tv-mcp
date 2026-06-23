/**
 * Fetch India VIX daily OHLC for a date from TradingView (via CDP) and format it
 * as the day-note VIX line the reports parse / filter on, e.g.
 *   "vix open: 12.67 low: 12.07 high: 13.64 close: 12.77"
 *
 * Used by the EOD report generators (supertrend + bias) so the VIX is recorded
 * automatically instead of being typed by hand.
 */

const VIX_SYMBOL = 'NSE:INDIAVIX';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pick the daily bar that belongs to dateStr (YYYY-MM-DD). Daily bars are keyed
// near UTC midnight of the trading day, so match the closest bar within a day.
// Pure + exported for tests.
export function pickDailyBar(bars, dateStr) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const targetUnix = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
  let best = null;
  let bestDiff = Infinity;
  for (const b of bars) {
    const diff = Math.abs(b.time - targetUnix);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = b;
    }
  }
  if (!best || bestDiff > 86400) return null; // must be within a day of the target
  const r4 = (x) => parseFloat(parseFloat(x).toFixed(4));
  return { open: r4(best.open), high: r4(best.high), low: r4(best.low), close: r4(best.close) };
}

// Format a VIX OHLC object as the day-note line (matches the user's hand-typed style).
// India VIX is quoted to 4 decimals, so show 4 places (incl. trailing zeros).
export function formatVixNote(vix) {
  if (!vix) return '';
  const f = (x) => (x === null || x === undefined ? '' : Number(x).toFixed(4));
  return `vix open: ${f(vix.open)} low: ${f(vix.low)} high: ${f(vix.high)} close: ${f(vix.close)}`;
}

// Scroll the chart timescale so the daily bars around the date are loaded.
async function scrollDaily(cdp, fromUnix, toUnix) {
  await cdp.executeScript(`
    (function(){try{
      const m=window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget?._modelWV?._value;
      const ts=m?.timeScale?.();
      if(ts?.setVisibleRange){ts.setVisibleRange({from:${fromUnix},to:${toUnix}});return 'ok-model';}
      const cw=window.TradingViewApi?._activeChartWidgetWV?._value?._chartWidget;
      if(cw?.setVisibleRange){cw.setVisibleRange({from:${fromUnix},to:${toUnix}});return 'ok-widget';}
      return 'no-api';
    }catch(e){return 'err: '+e.message;}})()
  `);
}

// Fetch India VIX daily OHLC for dateStr. Returns { open, high, low, close } or
// null (symbol unavailable / no bar / any error) — callers treat null as "skip".
export async function fetchVixForDate(cdp, cdpChart, dateStr) {
  try {
    await cdpChart.handle('chart_set_symbol', { symbol: VIX_SYMBOL });
    await sleep(3000);
    await cdpChart.handle('chart_set_timeframe', { timeframe: 'D' });
    await sleep(2000);
    const targetUnix = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
    await scrollDaily(cdp, targetUnix - 30 * 86400, targetUnix + 5 * 86400);
    await sleep(2000);

    let bars = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await cdpChart.handle('data_get_ohlcv', { summary: false, limit: 500 });
      const data = JSON.parse(result?.content?.[0]?.text || '{}');
      bars = data.bars || [];
      if (pickDailyBar(bars, dateStr)) break;
      await sleep(1500);
    }
    return pickDailyBar(bars, dateStr);
  } catch {
    return null;
  }
}
