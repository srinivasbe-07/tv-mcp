# TradingView MCP — Claude Instructions

This MCP server lets you control TradingView Desktop via Chrome DevTools Protocol.
**Prerequisite**: TradingView must be running with `--remote-debugging-port=9222`. Call `tv_health_check` first if unsure.

---

## Daily Workflow — UI Dashboard (New)

### Every day

```
npm run ui
```

Then open **http://localhost:3000** in the browser.

| Step | Action                                                                                     |
| ---- | ------------------------------------------------------------------------------------------ |
| 1    | Click **▶ Start TV** — waits until TradingView CDP is ready (green banner)                 |
| 2    | Click **▶ Start** on the Supertrend Monitor (this one process runs both Supertrend + Bias) |
| 3    | Live status + logs appear in each panel                                                    |
| 4    | Click **Open ↗** to open the full control page in a new tab                                |

> **Note:** Supertrend and Bias are now **one merged process** (`monitors/monitor.js`) sharing a single TradingView window/tab. There is no separate Bias process to start — starting the Supertrend monitor runs both. The `/bias` page just sets the bias direction. Bias runs whenever a `bias.direction` is configured (no separate on/off).

### Pages

| URL                                        | Purpose                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `http://localhost:3000`                    | Dashboard — overview + start/stop the monitor                          |
| `http://localhost:3000/bias`               | Bias Monitor — manual up/down direction, live status, EOD report       |
| `http://localhost:3000/bias-reports`       | **Bias EOD Reports** — same UI as 1-min reports, bias trades           |
| `http://localhost:3000/supertrend`         | Supertrend Monitor — ITM override, CE/PE position, generate EOD report |
| `http://localhost:3000/test-alerts`        | **Supertrend Alert Test** — verify NIFTY & SENSEX alerts               |
| `http://localhost:3000/supertrend-reports` | **Trade Reports Dashboard** — consolidated P&L for both strategies     |
| `http://localhost:3000/1min-reports`       | **1-Min Reports** — auto-generated trades, full filters & edit         |
| `http://localhost:3000/3min-reports`       | **3-Min Reports** — manual paper trades, full filters & edit           |

(`/pattern` redirects to `/bias` — the old pattern monitor was merged into the bias monitor.)

### Config file: `config/monitor-config.json`

Edit and save — changes apply on the next 60s tick (no restart needed).

| Field                | Example | Notes                                                             |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `itmOverride`        | `null`  | null = day rule, 0 = ATM, 1 = ITM-1, 2 = ITM-2 (both strats)      |
| `supertrend.enabled` | `true`  | Supertrend Run/Pause — **default enabled** (paused only if false) |
| `bias.enabled`       | `false` | Bias Run/Pause — **default paused** (runs only when `true`)       |
| `bias.direction`     | `"up"`  | `up` = buy CE/call, `down` = buy PE/put                           |
| `ignoreMarketHours`  | `false` | `true` = run ticks 24/7 (off-hours testing / crypto)              |

**Run/Pause per strategy** (toggle on each page): both strategies share one monitor process.

- **Pause** disables that strategy's alerts (deactivates all of them) and stops managing them. **Resume** re-enables the alerts and immediately updates them.
- Changes apply **immediately** — the monitor watches `monitor-config.json` and runs a tick the moment you toggle (no 60s wait).
- Supertrend defaults to running; **Bias defaults to paused and is reset to paused on every monitor start/restart** (manual trading — resume it explicitly each session).
- **You can't pause a strategy while one of its trades is OPEN** — the toggle is disabled in the UI, and the monitor defers the disable until the trade closes (so a running trade never loses its exit/target alerts).

---

## Bias Monitor

### What It Does

Keeps a manually-chosen **direction's** 3 alerts (Entry / Exit / Target) pointed at the current ITM option strike — the same way the Supertrend Monitor keeps its CE/PE alerts on the right strike, but with the direction set by **you** (UI toggle) instead of by an indicator.

It runs **inside the merged monitor process** (`monitors/monitor.js`) — supertrend and bias share one TradingView window/tab, and their alert updates run sequentially in one 60s tick so they never collide on the single Alerts panel. There is no separate bias process. (Pattern detection from the old pattern monitor has been removed.)

### Alert Names (must already exist in TradingView)

6 per instrument — 3 for `up` (CE), 3 for `down` (PE). Only the today-instrument's chosen direction is active; the opposite direction's 3 alerts are **deactivated**.

| Instrument | Direction | Entry              | Exit              | Target              |
| ---------- | --------- | ------------------ | ----------------- | ------------------- |
| NIFTY      | up        | `0NiftyBiasEntry`  | `0NiftyBiasExit`  | `0NiftyBiasTarget`  |
| NIFTY      | down      | `zNiftyBiasEntry`  | `zNiftyBiasExit`  | `zNiftyBiasTarget`  |
| SENSEX     | up        | `0SensexBiasEntry` | `0SensexBiasExit` | `0SensexBiasTarget` |
| SENSEX     | down      | `zSensexBiasEntry` | `zSensexBiasExit` | `zSensexBiasTarget` |

(`0` prefix sorts up-alerts to the top of the Alerts panel; `z` sorts down-alerts to the bottom.)

### Every 60s tick, the bias block

1. Reads `bias.direction` (up/down) from `config/monitor-config.json` (bias runs whenever a direction is set)
2. Derives the bias position (open/closed) from the Alerts **Log** tab — entry fired = OPEN, exit/target fired = CLOSED
3. Picks the chosen 3 alerts by direction; strike = up → CE (ATM − depth·step), down → PE (ATM + depth·step) — same ATM/ITM-depth/day rule as supertrend
4. **No open trade** → updates all 3 chosen alerts via `alert_update`: **symbol → ITM strike AND price → 0**
5. **Deactivates** the opposite direction's 3 alerts (re-activates the chosen 3 only on a flip-back, when they may have been disabled)
6. **Trade OPEN** → does **not** move symbols; on the entry fire it sets the **entry price → 0 and disables the entry** alert; leaves **exit + target untouched**; re-enables the entry when the trade closes
7. Shares the supertrend ATM cooldown; a direction flip / just-opened / just-closed / retry bypasses the cooldown

### Direction & Deferred Flip

- Set direction with the `/bias` page toggle (or edit `bias.direction` in config).
- If you flip while a trade is **OPEN**, the flip is **deferred** — logged as "flip pending" — and applied automatically once the position closes, so a running trade never loses its exit/target alert.

### EOD Report (`/bias-reports`)

Same as the supertrend EOD report, for bias trades. Click **↧ EOD Report** on the `/bias` page (or `npm run report:bias` / `node scripts/generate-bias-report.js [YYYY-MM-DD]`).

- Parses bias **entry → (exit OR target)** pairs from the alert log, maps up→CE / down→PE.
- **Alert source**: uses `position.json`'s `logSnapshot` (written by the monitor during market hours). When the market is **off** (weekend / holiday / after close) that snapshot is empty, so the report reads the Alerts **Log** tab live from TradingView instead. The live read is skipped during market hours so it never disturbs the running monitor — same fallback applies to the supertrend EOD report.
- Fetches each option's 1m prices from TradingView and computes two exit models (bias-specific, **different from supertrend**):
  - **Exit w/SL** — stepped **trailing stop**: initial SL **NIFTY 15 / SENSEX 35** pts; for every **NIFTY 10 / SENSEX 22** pts of favourable movement the stop ratchets up to **NIFTY 12 / SENSEX 25** pts behind that milestone (never moves down). Exits at the stop if a 1m bar's low breaches it, else at the actual exit price.
  - **Exit w/Tgt** — fixed bracket: **NIFTY SL 15 / target 31**, **SENSEX SL 35 / target 35**. Target hit intraday → +target; else actual exit clamped to [−SL, +target].
- **Bias-only UI differences** (the shared `1min-reports.html` hides these when on `/bias-reports`):
  - **Exit w/oSL** (raw, unclamped) columns + summary card — hidden (`exitNSL` is still stored as the trailing-stop input).
  - **PB Entry** (pullback) card and its edit-mode inputs — removed (pullback doesn't apply to bias).
  - **Candle** column and the **CANDLE ≥** filter — removed.
  - **PINE SCRIPT SL** notes option + filter — removed (bias has no Pine-script exits).
- `exitType` records whether the trade closed on `exit` (SL/signal) or `target`; notes auto-classify **TARGET HIT / SL HIT / price reach upto X / EXIT SIGNAL**.
- Saves to `logs/bias/1min/daily-trades-YYYY-MM-DD.json` (same schema as supertrend).
- View at **`/bias-reports`** — the same reports UI as `/1min-reports`, pointed at bias data (month tabs, filters, P&L, inline edit, Excel export). Inline edits recompute with simple clamp logic (intraday bars aren't available in the browser); re-run the report to restore exact trailing-stop values.

### What It Does NOT Do

- Does not detect candlestick patterns (removed) — direction is manual
- Does not place orders — only manages TradingView alerts
- Does not create alerts — the 12 bias alerts must already exist
- Does not yet draw previous-day H/L levels (planned — phase 2)

---

## Supertrend Alert Test (`/test-alerts`)

A dedicated UI page for verifying that all 8 supertrend alerts exist in TradingView and can be updated correctly. Use this after TradingView restarts, after renaming alerts, or when debugging alert update failures.

The page also has a **BIAS ALERTS** section (NIFTY + SENSEX) that tests the 6 bias alerts per instrument (UP=CE entry/exit/target, DOWN=PE entry/exit/target) via `/api/test/bias` — same flow, updating each to its ITM strike at price 0.

### How to access

```
npm run ui   ← start the UI server first
```

Then open **http://localhost:3000/test-alerts**

### What it does

- Two cards side by side — **NIFTY** and **SENSEX**
- Each card shows the 4 alert names for that instrument (CE entry/exit, PE entry/exit)
- Click **▶ Test NIFTY Alerts** or **▶ Test SENSEX Alerts** to run
- Real-time log panel streams each step as it happens
- Each alert row updates to ✓ or ✗ as soon as its result arrives
- Summary bar shows spot / ATM / ITM-depth used

### Inputs

| Field        | Notes                                                                                |
| ------------ | ------------------------------------------------------------------------------------ |
| Spot Price   | Leave blank to auto-read from TradingView chart. Enter manually if market is closed. |
| ITM Override | Auto = use day rule. Override to ATM/ITM-1/ITM-2 if needed.                          |

### What the test actually does

For each of the 4 alerts it:

1. Switches the chart tab to the calculated option symbol
2. Calls `alert_update_symbol` to update the alert to that symbol
3. Reports ✓ OK / ✗ FAIL with the message from TradingView

### Terminal alternative

```
node scripts/test-supertrend-alerts.js                    # today's instrument
node scripts/test-supertrend-alerts.js --instr NIFTY      # force NIFTY
node scripts/test-supertrend-alerts.js --instr SENSEX     # force SENSEX
node scripts/test-supertrend-alerts.js --instr NIFTY --instr SENSEX  # both
node scripts/test-supertrend-alerts.js --spot 23400 --itm 1          # overrides
```

### Common failure causes

| Error                           | Fix                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Alert not found in Alerts panel | Alert name in TradingView doesn't exactly match — check spelling and case            |
| CDP connect failed              | TradingView not running or CDP not on port 9222                                      |
| Could not read spot price       | Market closed — enter spot price manually in the input field                         |
| Symbol not in alert dropdown    | Option symbol not available on this chart tab — try force-updating or switching tabs |

---

## Supertrend Monitor

### What It Does

Automatically keeps 4 TradingView alerts pointed at the correct ITM option strike as NIFTY/SENSEX spot price moves during the day. Without it, you'd have to manually edit each alert every time the ATM shifts.

---

### Prerequisites

1. **8 alerts must exist in TradingView** with these exact names (case-sensitive):

| Instrument | Side | Role  | Alert Name                   |
| ---------- | ---- | ----- | ---------------------------- |
| NIFTY      | CE   | Entry | `niftySupertrendLongEntry`   |
| NIFTY      | CE   | Exit  | `niftySupertrendLongExit`    |
| NIFTY      | PE   | Entry | `niftySupertrendShortEntry`  |
| NIFTY      | PE   | Exit  | `niftySupertrendShortExit`   |
| SENSEX     | CE   | Entry | `sensexSupertrendLongEntry`  |
| SENSEX     | CE   | Exit  | `sensexSupertrendLongExit`   |
| SENSEX     | PE   | Entry | `sensexSupertrendShortEntry` |
| SENSEX     | PE   | Exit  | `sensexSupertrendShortExit`  |

2. **2 chart tabs open in TradingView** when running both monitors (one tab per monitor).

3. **Start the monitor by 9:12 AM** so alerts are updated before Pine Script fires at 9:15.

---

### Recommended Start Time

| Start time  | Behaviour                                                    |
| ----------- | ------------------------------------------------------------ |
| **9:00 AM** | Best — reads pre-open indicative price, updates by 9:01-9:02 |
| 9:10 AM     | Good — interval ticks pick up pre-open price, done by 9:12   |
| 9:12 AM     | OK — first force tick updates in ~30s, done before 9:15      |
| After 9:14  | ⚠️ Risky — may not complete before Pine Script fires         |

The **first tick always runs with `force=true`**, bypassing both market hours and the 90s cooldown — so alerts are always updated immediately on startup regardless of whether ATM changed overnight.

---

### Instrument Routing

| Day       | Instrument | Strike Step | ITM Depth |
| --------- | ---------- | ----------- | --------- |
| Mon / Tue | NIFTY      | 50          | ITM-2     |
| Wed / Thu | SENSEX     | 100         | ITM-2     |
| Fri       | NIFTY      | 50          | ITM-1     |

### Option Symbol Format

```
NIFTY → NIFTY{YY}{MM}{DD}C{strike}   e.g. NIFTY260603C23300
SENSEX→ BSX{YY}{MM}{DD}C{strike}     e.g. BSX260605P79000
```

Expiry: NIFTY = next Tuesday, SENSEX = next Thursday (shifts back if holiday).

---

### Every 60 Seconds It (exact sequence)

```
Step 1  Identify instrument (NIFTY / SENSEX by day) + read itmOverride from config
Step 2  Read alert Log tab → detect new entry/exit fires → update CE/PE position state
        └── entry alert fired → CE or PE = OPEN  (logged: [POSITION] CE OPENED)
        └── exit  alert fired → CE or PE = CLOSED (logged: [POSITION] CE CLOSED)
Step 3  Read spot price from dedicated chart tab → calculate ATM
        └── spot invalid → save state & skip tick
Step 4  ATM Cooldown: update immediately on first ATM shift, then lock for 120s
        └── ATM shifts → update alerts NOW (same tick)
        └── Next 120s → further ATM shifts blocked ("cooldown active Xs remaining")
        └── After 120s → next ATM shift updates again
        └── Force tick (startup) → always bypasses cooldown
        └── Trade just closed → always bypasses cooldown (sync to current strike)
Step 5  Nothing changed (ATM same, depth same, instrument same, not force, no trade just closed,
        no retry pending)?
        └── save state & exit — no alert updates needed
Step 6  Calculate strikes
        └── CE strike = ATM − (itmDepth × stepSize)
        └── PE strike = ATM + (itmDepth × stepSize)
Step 7  Update CE alerts
        └── CE = OPEN              → SKIP  (logged: "CE trade is RUNNING — skipping")
        └── CE just CLOSED         → FORCE sync to current strike (ATM may have moved during trade)
        └── CE = CLOSED + ATM shifted → update to new strike
        └── CE = CLOSED + prev update failed → retry (logged: "Retrying CE alerts")
Step 8  Update PE alerts
        └── PE = OPEN              → SKIP  (logged: "PE trade is RUNNING — skipping")
        └── PE just CLOSED         → FORCE sync to current strike
        └── PE = CLOSED + ATM shifted → update to new strike
        └── PE = CLOSED + prev update failed → retry (logged: "Retrying PE alerts")
Step 9  Wait 3s → verify all 4 alerts are active → auto re-activate any stopped
Step 10 Save position.json
```

**Key points:**

- Position state (Step 2) is always read _before_ any alert update (Steps 7–8) — if an entry fires between ticks, the next tick blocks the update automatically.
- When a trade exits (OPEN → CLOSED), alerts are **immediately synced** to the current strike even if ATM hasn't shifted — because ATM may have moved while updates were blocked during the trade.
- When an alert update fails (e.g. alerts panel not loaded), the side is flagged for retry. The next tick forces the update regardless of whether ATM has shifted. Retries continue every 60s until the update succeeds.

### Alert Update Behaviour by Position State

| State                 | CE alerts                                   | PE alerts                                   |
| --------------------- | ------------------------------------------- | ------------------------------------------- |
| CE=closed, PE=closed  | ✓ Updated on ATM shift                      | ✓ Updated on ATM shift                      |
| CE=open, PE=closed    | ✗ Skipped — trade running                   | ✓ Updated on ATM shift                      |
| CE=closed, PE=open    | ✓ Updated on ATM shift                      | ✗ Skipped — trade running                   |
| CE=open, PE=open      | ✗ Skipped — trade running                   | ✗ Skipped — trade running                   |
| CE just closed        | ✓ Force sync to current strike              | (PE continues normally)                     |
| PE just closed        | (CE continues normally)                     | ✓ Force sync to current strike              |
| CE prev update failed | ✓ Retry next tick (every 60s until success) | (PE continues normally)                     |
| PE prev update failed | (CE continues normally)                     | ✓ Retry next tick (every 60s until success) |

A running trade's alerts **never move** — they stay on the exact entry strike.
When the trade exits, alerts are synced to current ITM strike immediately.

---

### Startup Sequence

```
1. Connect to dedicated chart tab (logs/supertrend-tab.json)
2. Position reset (before first tick):
   └── Pre/off-market start → CE/PE forced to 'closed' (no trades outside market hours)
   └── Market-hours start   → read TV alert history immediately, re-derive CE/PE,
                              save to position.json — no waiting for first tick
3. Poll alert_list every 5s until all 4 today-instrument alerts visible (up to 120s)
   → prevents "not found" failures when TV just restarted and alerts haven't synced
4. First force tick → update CE + PE alerts immediately (bypasses 120s cooldown)
5. Verify status → re-activate any stopped alerts
6. Enter 60s poll loop
```

---

### Position State

Stored in `config/position.json`, **grouped by strategy** (one file, two strategies kept separate). Updated automatically from alert history each tick:

```json
{
  "date": "2026-06-18",
  "shared":     { "lastATM", "lastATMUpdateTime", "lastInstrument", "lastITMDepth" },
  "supertrend": { "enabled", "CE", "PE", "lastCEStrike", "lastPEStrike", "logSnapshot" },
  "bias":       { "enabled", "position", "direction", "lastStrike", "activatedDir", "entryParked", "logSnapshot" }
}
```

All readers (UI pages, EOD report scripts) flatten this with a fallback to the legacy flat format.

**Manual override** via Supertrend UI page or CLI:

```
node monitors/monitor.js --ce open --pe closed
node monitors/monitor.js --itm 1    ← force ITM-1 regardless of day rule
node monitors/monitor.js --itm 2    ← force ITM-2
```

---

### Dedicated Chart Tab

The merged monitor (supertrend + bias) claims one TradingView chart tab on first start, saves ID to `logs/supertrend-tab.json`, and reuses it on restart. If the tab is gone (TV restarted), it scans live tabs and claims the first available chart tab.

---

### What It Does NOT Do

- Does not place orders — only manages TradingView alerts
- Does not create alerts — the 8 alerts must already exist in TradingView
- Does not manage the Supertrend indicator itself — that lives on your chart

---

## Supertrend Trade Reports (`/supertrend-reports`)

A paper-trading journal. After each trading day, generate a report to capture option entry/exit prices; view all historical data month-wise with P&L stats. Use this at the end of each month to decide whether to go live the following month.

### How to access

```
npm run ui   ← start the UI server first
```

Then open **http://localhost:3000/supertrend-reports** (dashboard) → click card to open **http://localhost:3000/1min-reports** or **http://localhost:3000/3min-reports**.

---

### EOD Workflow (after market close)

| Method        | Command / Action                                                     |
| ------------- | -------------------------------------------------------------------- |
| UI button     | Go to `http://localhost:3000/supertrend` → click **Generate Report** |
| PowerShell    | `.\eod-report.ps1`                                                   |
| Node          | `node scripts/generate-daily-report.js`                              |
| Specific date | `.\eod-report.ps1 2026-06-07`                                        |

The script fetches the option entry/exit prices from TradingView for each trade logged that day, scrolls the chart to the target date to load historical bars, computes clamped exit values, auto-classifies the outcome (SL HIT / PINE SCRIPT SL), and saves to `logs/daily-trades-YYYY-MM-DD.json`. The reports page auto-opens when generation finishes.

---

### Data Storage

Each trading day is one JSON file: `logs/daily-trades-YYYY-MM-DD.json`

```json
{
  "date": "2026-06-07",
  "instrument": "NIFTY",
  "trades": [
    {
      "id": 1,
      "instrument": "NIFTY",
      "side": "CE",
      "entrySymbol": "NIFTY260609C23400",
      "exitSymbol": "NIFTY260609C23400",
      "entryTime": "09:32:00",
      "exitTime": "10:15:00",
      "lots": 10,
      "lotSize": 65,
      "entryPrice": 123.5,
      "exitSL": 138.5,
      "exitTgt": 154.5,
      "exitNSL": 142.0,
      "tgtPts": 31.0,
      "maxReach": 35.25,
      "notes": "PINE SCRIPT SL"
    }
  ]
}
```

Fields auto-populated by the generator:

| Field      | How set                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exitSL`   | `clamp(exitNSL, entry − SL, entry + TARGET_G)` — intraday bar scan for TARGET_G                                                                                                                 |
| `exitTgt`  | `entry + TARGET_L` always (fixed target exit price, e.g. entry 100 + 31 = 131)                                                                                                                  |
| `exitNSL`  | Raw exit price from TradingView at the alert-fire minute                                                                                                                                        |
| `tgtPts`   | `clamp(exitNSL − entry, −SL, TARGET_L)` — or TARGET_L if intraday bar hit it                                                                                                                    |
| `maxReach` | Max `(bar.high − entry)` across all 1m bars during the trade (stored, not shown)                                                                                                                |
| `notes`    | Auto-classified in priority order: `"price reach upto X points"` if `maxReach ≥ 20`; `"SL HIT"` if loss ≥ SL and reach < 20; `"PINE SCRIPT SL"` if exit < entry and reach < 20; blank if profit |

Files are never overwritten by the generator — delete the file to re-import for a date.

---

### Importing Historical Excel Data

One-time import from `Daily_PL_Tracker.xlsx` (sheets: "ST Strategy" for May, "ST Strategy - June 2026" for June):

```
node scripts/import-excel-history.js
```

Requires Python + openpyxl (`pip install openpyxl`). Skips dates that already have a JSON file.

---

### Reports Page Layout

- **Month tabs** at the top — one tab per calendar month with data
- **Instrument filter** — All / NIFTY / SENSEX (shows/hides day blocks and recalculates summary)
- **Date filter** — dropdown showing only dates that have trades; filters the month to one specific day
- **Time ranges** — define one or more time windows; trades outside all windows are excluded from stats
- **Notes filter** — checkboxes for SL HIT and PINE SCRIPT SL; Reach ≥ N input to find high-reach trades
- **Monthly summary cards** — one card per P&L type showing totals for the filtered data
- **Day accordions** — expand each trading day to see the trade table

---

### Filters

All filters combine with AND logic — a trade must satisfy every active filter to appear.

#### Time Range Filter

Multiple ranges can be active simultaneously. A trade is included if it falls within **any** defined range.

| Action         | How                                           |
| -------------- | --------------------------------------------- |
| Add a range    | Click **+ Add Range** → set From and To times |
| Remove a range | Click **✕** on that range row                 |
| Apply          | Click **▶ Apply** to update the table         |
| Clear all      | Click **✕ Clear All**                         |

Example: set 09:30–11:00 and 14:30–15:00 to see only opening and closing session trades.

#### Notes Filter

| Control            | What it filters                                                     |
| ------------------ | ------------------------------------------------------------------- |
| **SL HIT**         | Trades with notes = `"SL HIT"` (loss ≥ SL and reach < 20)           |
| **PINE SCRIPT SL** | Trades with notes = `"PINE SCRIPT SL"` (small loss, reach < 20)     |
| **REACH ≥ N**      | Trades where `maxReach` ≥ N — includes `"price reach upto X"` notes |
| **▶ Apply**        | Apply the current notes + reach filter                              |
| **✕ Clear**        | Reset notes + reach filter                                          |

`REACH ≥` works with both new data (numeric `maxReach` field) and old data (parses `"price reach upto X points"` from notes text). Trades with `"price reach upto X"` notes are not matched by the SL HIT or PINE SCRIPT SL checkboxes.

#### Date Filter

Dropdown at the top of each month tab. Shows only dates that have at least one trade. Selecting a date hides all other days and recalculates the summary for that day only.

---

### Trade Table Columns

| Column      | What it shows                                                 |
| ----------- | ------------------------------------------------------------- |
| Time        | Entry time (HH:MM)                                            |
| Symbol      | Option symbol at entry (e.g. `NIFTY260609C23400`)             |
| Lots        | Number of lots traded                                         |
| Entry       | Option entry price                                            |
| Exit w/SL   | Exit price clamped to SL/target range (see below)             |
| Exit w/Tgt  | `entry + TARGET_L` always — where the target exit would be    |
| Exit w/oSL  | Actual exit price, no clamping                                |
| Tgt Pts     | `clamp(exitNSL − entry, −SL, TARGET_L)` — actual clamped pts  |
| Notes       | Auto-classified: SL HIT / price reach upto X / PINE SCRIPT SL |
| P&L w/SL ₹  | P&L using clamped exit — simulates disciplined SL + target    |
| P&L w/Tgt ₹ | `tgtPts × lots × lotSize` — P&L with SL and target discipline |
| P&L w/oSL ₹ | P&L using actual exit — what actually happened                |

P&L = (exit − entry) × lots × lotSize. Green = profit, red = loss. Trades sorted by entry time.

---

### Clamping Logic

Clamping prevents outlier exits from skewing the "disciplined" P&L columns.

| Constant     | NIFTY | SENSEX | Meaning                                       |
| ------------ | ----- | ------ | --------------------------------------------- |
| SL           | 15    | 35     | Max loss per lot in option points             |
| TARGET_G     | 50    | 100    | Max gain for exit price clamp (Exit w/SL col) |
| TARGET_L     | 31    | 70     | Max gain for Tgt Pts clamp                    |
| Lot size     | 65    | 20     | Qty per lot                                   |
| Default lots | 10    | 15     | Used if lots not set in trade                 |

- **exitSL** = `clamp(exitPrice, entry − SL, entry + TARGET_G)`
- **exitTgt** = `entry + TARGET_L` (always fixed — shows where target would be)
- **tgtPts** = `clamp(exitPrice − entry, −SL, TARGET_L)` (actual clamped result, can be negative)

---

### Monthly Summary Cards

Three cards — one per P&L type (w/SL, w/oSL, Tgt):

| Stat         | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| Net P&L      | Sum of all day P&Ls for the filtered trades (gross)              |
| Brokerage    | Total paper-trading brokerage for the month (deducted)           |
| Net (after)  | Net P&L − Brokerage                                              |
| Net Capital  | ₹2,00,000 (initial) ± Net (after brokerage)                      |
| Win Rate     | % of trades with positive P&L                                    |
| Max Drawdown | Largest peak-to-trough cumulative P&L decline (worst losing run) |
| Max Run-Up   | Largest trough-to-peak cumulative P&L gain (best winning run)    |

Drawdown/Run-Up show the date of occurrence in brackets. These are calculated on the **filtered** data (instrument + time ranges applied).

**Brokerage** (paper-trading cost) reduces every P&L type. Default = **₹200 × number of trades** per day, editable per day in the daily footer (see below) and persisted to the day's JSON (`brokerage` field; cleared back to default when set equal to it). The **Capital** card shows the month's total brokerage split by **NIFTY** and **SENSEX**. Applies to the 1-Min (supertrend), Bias, and 3-Min report pages.

---

### Daily Table Footer

Each day's trade table has two footer rows:

| Row                     | Columns                                                    |
| ----------------------- | ---------------------------------------------------------- |
| **Day Total**           | Sum of P&L for all 3 types for that day (gross)            |
| **Brokerage**           | Editable ₹ input (default ₹200 × trades); shown as −amount |
| **Net after Brokerage** | Day Total − Brokerage for each P&L type                    |
| **Max Drawdown**        | Intra-day peak-to-trough for each P&L type                 |
| **Max Run-Up**          | Intra-day trough-to-peak for each P&L type                 |

Edit the **Brokerage** input to override that day's cost; clearing it (or setting it back to ₹200 × trades) reverts to the default. The day chip in the accordion header shows **Net after Brokerage** (w/SL).

---

### Editing Trades

All trades can be edited directly on the page (no restart needed):

| Action         | How                                                                      |
| -------------- | ------------------------------------------------------------------------ |
| Edit a row     | Click **✏ Edit** → modify fields inline → click **✓ Save**               |
| Focus an input | **Double-click** anywhere in the cell to focus the input inside it       |
| Auto-calculate | Change **Entry** or **Exit w/oSL** — all derived fields update instantly |
| Delete a row   | Click **✗** (red)                                                        |
| Add a row      | Hover between rows → click **+ Add Row Here**                            |

**✓ Save writes immediately to the JSON file on disk** — no separate "Save Changes" step. Trades are re-sorted by entry time after every save. Delete also saves immediately.

#### Auto-Calculation in Edit Mode

When **Entry** price or **Exit w/oSL** changes, the following are recalculated in real-time:

- **Exit w/SL** = `clamp(exitNSL, entry − SL, entry + TARGET_G)`
- **Tgt Pts** = `clamp(exitNSL − entry, −SL, TARGET_L)`
- **Exit w/Tgt** = `entry + TARGET_L` (always fixed target price)
- **P&L preview** (w/SL | w/Tgt | w/oSL) shown live in the P&L cell

---

### Download Excel

Click **↧ Download Excel** on any month tab to export all visible (filtered) trades to an `.xlsx` file. SheetJS is loaded on first click (CDN) — requires internet connection.

---

## Tool Routing — Natural Language → Tool

### Price & Chart State

| User says                             | Tool(s) to call                                                |
| ------------------------------------- | -------------------------------------------------------------- |
| "What's NIFTY / BTC / AAPL at?"       | `chart_set_symbol` → `quote_get`                               |
| "Current price / quote"               | `quote_get` (no symbol switch needed if already on that chart) |
| "What's on the chart right now?"      | `chart_get_state`                                              |
| "Show me the last N bars / OHLCV"     | `data_get_ohlcv`                                               |
| "Is TradingView connected / working?" | `tv_health_check`                                              |
| "Take a screenshot / show the chart"  | `capture_screenshot`                                           |

### Chart Navigation

| User says                    | Tool(s) to call                                          |
| ---------------------------- | -------------------------------------------------------- |
| "Switch to / show X"         | `chart_set_symbol(symbol=X)`                             |
| "Change to daily / 1H / 15m" | `chart_set_timeframe(timeframe=...)`                     |
| "Switch to X on Y timeframe" | `chart_set_symbol` → `chart_set_timeframe`               |
| "Go back to NIFTY daily"     | `chart_set_symbol(NSE:NIFTY)` → `chart_set_timeframe(D)` |

### Alerts

| User says                      | Tool(s) to call                                                |
| ------------------------------ | -------------------------------------------------------------- |
| "Create alert for X when Y"    | `chart_set_symbol(X)` → `alert_create`                         |
| "Alert me if BTC crosses 100k" | `alert_create(symbol=BTCUSD, condition=crosses, level=100000)` |
| "List / show my alerts"        | `alert_list`                                                   |
| "How many alerts do I have?"   | `alert_list` (check `total` field)                             |
| "Delete alert named X"         | `alert_delete(alertId=X)` — X is the name in the Alerts panel  |

### Pine Script

| User says                              | Tool(s) to call                                              |
| -------------------------------------- | ------------------------------------------------------------ |
| "What indicator is loaded?"            | `pine_get_source`                                            |
| "Write / replace / inject Pine Script" | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Any compile errors?"                  | `pine_get_errors`                                            |
| "Compile / apply the indicator"        | `pine_smart_compile`                                         |
| "Save the script"                      | `pine_save`                                                  |

---

## Multi-Step Workflows

### "What is [symbol] trading at?"

```
1. chart_set_symbol(symbol=<symbol>)
2. quote_get()                         ← returns live OHLCV
```

### "Show me [symbol] on [timeframe]"

```
1. chart_set_symbol(symbol=<symbol>)
2. chart_set_timeframe(timeframe=<tf>)
3. chart_get_state()                   ← confirm both changed
```

### "Create a price alert for [symbol] at [level]"

```
1. alert_list()                        ← check current count / plan headroom
2. chart_set_symbol(symbol=<symbol>)   ← alert_create will switch chart first, but verify
3. alert_create(symbol=<symbol>, condition=above|below|crosses, level=<level>)
4. alert_list()                        ← verify count increased by 1
```

### "Write a Pine Script indicator"

```
1. pine_set_source(source=<code>)      ← editor must be open (right-click indicator → Edit)
2. pine_smart_compile()
3. pine_get_errors()                   ← if errors, fix source and repeat
4. pine_save()                         ← optional: save to TradingView cloud
```

### "Compare price before and after switching symbol"

```
1. chart_get_state()   ← note current symbol
2. quote_get()         ← get price A
3. chart_set_symbol()
4. quote_get()         ← get price B
```

---

## Symbol Format Reference

| Market      | Format                    | Examples                                       |
| ----------- | ------------------------- | ---------------------------------------------- |
| NSE (India) | `NSE:SYMBOL`              | `NSE:NIFTY`, `NSE:RELIANCE`, `NSE:BANKNIFTY`   |
| Crypto      | bare or exchange-prefixed | `BTCUSD`, `BITSTAMP:BTCUSD`, `ETHUSD`          |
| US Stocks   | bare ticker               | `AAPL`, `MSFT`, `TSLA`                         |
| Futures     | root + `1!`               | `ES1!`, `NQ1!`, `CL1!`                         |
| Options     | full TV format            | `NIFTY260526C23950` (as shown in Alerts panel) |

## Timeframe Reference

| Value                           | Meaning    |
| ------------------------------- | ---------- |
| `1`, `3`, `5`, `15`, `30`, `45` | Minutes    |
| `60`, `120`, `240`              | 1H, 2H, 4H |
| `D`                             | Daily      |
| `W`                             | Weekly     |
| `M`                             | Monthly    |

---

## Known Limitations & Caveats

### Alerts

- **Plan limit**: `alert_create` returns `success: true` when the dialog closes, but if you're at your plan's active-alert limit TradingView silently rejects the alert. Always verify with `alert_list` afterward — if `total` didn't increase, the plan is full.
- **alert_delete uses names**: Pass the exact name shown in the Alerts panel (e.g., `"0-NiftyDailyBull"`), not a numeric ID.
- **Duplicate names**: Multiple alerts can share the same name. `alert_delete` deletes the first visible match; call it multiple times to remove all copies.

### Pine Script

- **Editor must be open**: `pine_set_source` fails if the Pine Script editor isn't open. To open it: right-click an indicator on the chart → "Edit script".
- `pine_save` requires the user to be logged into TradingView.

### Screenshots

- `capture_screenshot` returns a base64 PNG. Decode and display it if the user wants to see the chart visually.

### quote_get

- Returns the last bar's OHLCV from the chart legend. Values are empty if no bar is hovered. Move the cursor over the chart or read the rightmost bar automatically by not hovering.

### General

- All tools require TradingView Desktop to be running with CDP on port 9222.
- If a tool returns an error about connection, call `tv_health_check` to diagnose, then `tv_launch` to restart TradingView if needed.
