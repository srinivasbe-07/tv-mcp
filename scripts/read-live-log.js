/**
 * Shared helper: read the TradingView Alerts "Log" tab live via CDP.
 *
 * The EOD report generators normally parse `position.json`'s `logSnapshot`,
 * which the monitor only writes during live market-hours ticks. When the report
 * is run while the market is off (weekend, holiday, or after close) the monitor
 * is idle and that snapshot is empty/stale — so the reports have nothing to
 * parse. This helper reads the Log tab directly from TradingView instead.
 *
 * It is gated on `isMarketOff()` so the live read only happens when the market
 * is closed: during market hours the running monitor owns the Alerts panel and
 * keeps position.json fresh, so we never switch the Log tab out from under it.
 *
 * Reuses ALERT_HISTORY_SCRIPT + loadHolidays from the monitor so the two stay
 * in lockstep.
 */
import { ALERT_HISTORY_SCRIPT, loadHolidays } from '../monitors/monitor.js';

const MARKET_OPEN_MIN = 9 * 60 + 10; // 09:10 IST pre-open
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST close

// True when the NSE market is currently CLOSED — weekend, a listed NSE holiday,
// or outside the 09:10–15:30 IST trading window. `now` and `holidays` are
// injectable for tests.
export function isMarketOff(now = new Date(), holidays = loadHolidays()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return true;
  const ds = ist.toISOString().slice(0, 10);
  if (holidays.has(ds)) return true;
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return min < MARKET_OPEN_MIN || min > MARKET_CLOSE_MIN;
}

function isWorkingDay(d, holidays) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidays.has(d.toISOString().slice(0, 10));
}

// The most recent completed trading session as 'YYYY-MM-DD' (IST). Used as the
// default report date: the alert Log tab carries only HH:MM:SS (no date) and
// position.json's `date` is just the last-saved date, so a report run after
// close / over a weekend / on a holiday must be dated to the session the fires
// actually belong to — not the calendar "today".
//   - During or after today's session (working day, ≥ 09:10 IST) → today
//   - Before today's open, or weekend / holiday → walk back to the previous
//     working day
export function lastTradingDay(now = new Date(), holidays = loadHolidays()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  // If today's session hasn't opened yet (or today is a non-working day), the
  // latest completed session is on an earlier day — step back at least one day.
  if (!isWorkingDay(d, holidays) || min < MARKET_OPEN_MIN) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  while (!isWorkingDay(d, holidays)) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Normalize the various shapes ALERT_HISTORY_SCRIPT can come back as into a
// plain array of { name, time, symbol, raw } items.
//   - CDPManager.executeScript returns the resolved value directly → { items, diag }
//   - some callers hand back the raw CDP response → { result: { value: { items } } }
//   - or an array directly
export function extractSnapshotItems(historyResult) {
  if (!historyResult) return [];
  if (Array.isArray(historyResult)) return historyResult;
  if (Array.isArray(historyResult.items)) return historyResult.items;
  const v = historyResult?.result?.value;
  if (Array.isArray(v?.items)) return v.items;
  if (Array.isArray(v)) return v;
  return [];
}

// Run ALERT_HISTORY_SCRIPT on a connected CDPManager and return the log items.
export async function readLiveAlertLog(cdp) {
  const historyResult = await cdp.executeScript(ALERT_HISTORY_SCRIPT);
  return extractSnapshotItems(historyResult);
}
