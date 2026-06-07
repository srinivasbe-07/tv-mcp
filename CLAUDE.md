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

| Step | Action                                                                     |
| ---- | -------------------------------------------------------------------------- |
| 1    | Click **▶ Start TV** — waits until TradingView CDP is ready (green banner) |
| 2    | Click **▶ Start** on Pattern Monitor and/or Supertrend Monitor             |
| 3    | Live status + logs appear in each panel                                    |
| 4    | Click **Open ↗** to open the full control page in a new tab                |

### Pages

| URL                                        | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `http://localhost:3000`                    | Dashboard — overview + start/stop all processes                  |
| `http://localhost:3000/pattern`            | Pattern Monitor — full config, log, candle feed                  |
| `http://localhost:3000/supertrend`         | Supertrend Monitor — ITM override, CE/PE position, generate EOD report |
| `http://localhost:3000/test-alerts`        | **Supertrend Alert Test** — verify NIFTY & SENSEX alerts         |
| `http://localhost:3000/supertrend-reports` | **Trade Reports** — paper trade journal, P&L stats, filters      |

### Keys (still work when running from terminal directly)

| Key | Action                           |
| --- | -------------------------------- |
| `a` | Toggle active (pause/resume)     |
| `f` | Flip bias (up ↔ down)            |
| `r` | Apply config changes immediately |
| `q` | Quit                             |

### Config file: `config/pattern-monitor-config.json`

Edit and save — changes apply instantly (no restart needed).

| Field             | Example          | Notes                              |
| ----------------- | ---------------- | ---------------------------------- |
| `bias`            | `"up"`           | `up` = buy/call, `down` = sell/put |
| `zone`            | `[73356, 73293]` | Order doesn't matter               |
| `target`          | `73500`          | Profit target price                |
| `sl`              | `0`              | 0 = auto (candle extreme)          |
| `importantLevels` | `[73600]`        | Key S/R levels                     |
| `active`          | `true`           | false = paused                     |

---

## Pattern Monitor

### What It Does

Watches candlestick patterns forming inside a configured price zone. When a reversal pattern appears, it automatically creates 3 TradingView alerts (Entry, SL, Target) on the relevant option or spot symbol.

### Patterns Detected

| Pattern           | Bias    | Condition                                              |
| ----------------- | ------- | ------------------------------------------------------ |
| Hammer            | up      | Long lower wick ≥ 2× body, small upper wick            |
| Bullish Engulfing | up      | Current green candle fully engulfs previous red candle |
| Doji              | up/down | Body ≤ 10% of total range                              |
| Shooting Star     | down    | Long upper wick ≥ 2× body, small lower wick            |

### On Every Candle Close It

1. Reads last completed candle (configurable timeframe, default 3-min)
2. Checks if candle is **inside the zone** — if not, skips
3. In **Options Mode**: switches to the ITM option chart, reads option candles for pattern detection
4. Detects pattern on candle (option candle in options mode, spot candle otherwise)
5. If pattern found → creates 3 alerts (Entry, SL, Target) and logs `[SIGNAL]`
6. Watches 15-min candles for **liquidity grab** near key levels → auto-flips bias
7. Checks if TradeSL or TradeTarget fired → cleans up all 3 alerts on exit
8. Trails SL to breakeven once price reaches entry + trail points

### Alerts Created on Signal

| Name          | Condition    | Level                                | Fires |
| ------------- | ------------ | ------------------------------------ | ----- |
| `TradeEntry`  | crosses up   | Candle HIGH                          | Once  |
| `TradeSL`     | crosses down | Candle LOW (or config `sl`)          | Once  |
| `TradeTarget` | crosses up   | Config `target` (or auto swing high) | Once  |

### Options Mode

When `optionsMode: true` in config (and no custom `symbol`):

- Spot enters zone → monitor switches chart to the **ITM option** (CE for bias=up, PE for bias=down)
- Pattern detection runs on **option candles**, not spot candles
- Alerts are created on the option symbol (e.g. `NIFTY260603C23300`)
- ITM depth: Fri = ITM-1, Mon/Tue = ITM-2, SENSEX = ITM-2
- Target 0 = auto (uses swing high from recent option bars)

### Liquidity Grab & Bias Auto-Flip

Monitors 15-min candles for a wick that reaches/exceeds a key level but closes back:

- **bias=up**: wick above a resistance level + Shooting Star or Doji + closes below level → flip to `down`
- **bias=down**: wick below a support level + Hammer or Doji + closes above level → flip to `up`

Key levels used = last 10 days H/L (auto-fetched daily) + `importantLevels` from config.

### Trail SL to Breakeven

When price reaches `entry + trailToCostPoints`, TradeSL is moved to entry (breakeven):

- NIFTY default: 15 pts
- SENSEX default: 35 pts
- Crypto/custom: disabled (0)
- Set `trailToCostPoints: 0` in config to disable

### Chart Drawings

The monitor draws directly on TradingView:

- **Zone** — box between zone top and bottom (blue = up bias, red = down bias)
- **Important levels** — horizontal lines at each `importantLevels` price
- **Nearest day level** — closest resistance (above price) and support (below price) from last 10 days
- Drawings persist across restarts via `logs/drawn-ids.json`
- Lines can be **dragged** on chart — drag sync writes new price back to config automatically

### Config (`config/pattern-monitor-config.json`)

| Field               | Example          | Notes                                                    |
| ------------------- | ---------------- | -------------------------------------------------------- |
| `bias`              | `"up"`           | `up` = buy CE/call, `down` = sell PE/put                 |
| `zone`              | `[23356, 23293]` | Entry zone — order doesn't matter                        |
| `target`            | `23500`          | Profit target price (0 = auto in options mode)           |
| `sl`                | `0`              | Stop loss price (0 = auto candle extreme)                |
| `importantLevels`   | `[23600]`        | Key S/R levels for liquidity grab detection              |
| `active`            | `true`           | false = paused (no pattern detection)                    |
| `candleTimeframe`   | `3`              | Candle size: 1, 3, 5, or 15 min                          |
| `optionsMode`       | `true`           | Watch ITM option chart for patterns                      |
| `itmOverride`       | `null`           | null = auto day rule, 0 = ATM, 1 = ITM-1, 2 = ITM-2      |
| `trailToCostPoints` | `15`             | Points above entry to trail SL to breakeven (0 = off)    |
| `ignoreMarketHours` | `false`          | true = run 24/7 (for crypto)                             |
| `symbol`            | `"BTCUSD"`       | Override instrument (omit for NIFTY/SENSEX auto routing) |

Config changes apply on the next candle close — no restart needed.

### What It Does NOT Do

- Does not manage Supertrend alerts — that is the Supertrend Monitor's job
- Does not place orders — only creates TradingView alerts
- Does not detect bearish patterns (Shooting Star, Bearish Engulfing) for entries — bias determines direction

---

## Supertrend Alert Test (`/test-alerts`)

A dedicated UI page for verifying that all 8 supertrend alerts exist in TradingView and can be updated correctly. Use this after TradingView restarts, after renaming alerts, or when debugging alert update failures.

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
Step 4  ATM Cooldown: update immediately on first ATM shift, then lock for 90s
        └── ATM shifts → update alerts NOW (same tick)
        └── Next 90s → further ATM shifts blocked ("cooldown active Xs remaining")
        └── After 90s → next ATM shift updates again
        └── Force tick (startup) → always bypasses cooldown
        └── Trade just closed → always bypasses cooldown (sync to current strike)
Step 5  Nothing changed (ATM same, depth same, instrument same, not force, no trade just closed)?
        └── save state & exit — no alert updates needed
Step 6  Calculate strikes
        └── CE strike = ATM − (itmDepth × stepSize)
        └── PE strike = ATM + (itmDepth × stepSize)
Step 7  Update CE alerts
        └── CE = OPEN        → SKIP  (logged: "CE trade is RUNNING — skipping")
        └── CE just CLOSED   → FORCE sync to current strike (ATM may have moved during trade)
        └── CE = CLOSED + ATM shifted → update to new strike
Step 8  Update PE alerts
        └── PE = OPEN        → SKIP  (logged: "PE trade is RUNNING — skipping")
        └── PE just CLOSED   → FORCE sync to current strike
        └── PE = CLOSED + ATM shifted → update to new strike
Step 9  Wait 3s → verify all 4 alerts are active → auto re-activate any stopped
Step 10 Save position.json
```

**Key points:**

- Position state (Step 2) is always read _before_ any alert update (Steps 7–8) — if an entry fires between ticks, the next tick blocks the update automatically.
- When a trade exits (OPEN → CLOSED), alerts are **immediately synced** to the current strike even if ATM hasn't shifted — because ATM may have moved while updates were blocked during the trade.

### Alert Update Behaviour by Position State

| State                | CE alerts                      | PE alerts                      |
| -------------------- | ------------------------------ | ------------------------------ |
| CE=closed, PE=closed | ✓ Updated on ATM shift         | ✓ Updated on ATM shift         |
| CE=open, PE=closed   | ✗ Skipped — trade running      | ✓ Updated on ATM shift         |
| CE=closed, PE=open   | ✓ Updated on ATM shift         | ✗ Skipped — trade running      |
| CE=open, PE=open     | ✗ Skipped — trade running      | ✗ Skipped — trade running      |
| CE just closed       | ✓ Force sync to current strike | (PE continues normally)        |
| PE just closed       | (CE continues normally)        | ✓ Force sync to current strike |

A running trade's alerts **never move** — they stay on the exact entry strike.
When the trade exits, alerts are synced to current ITM strike immediately.

---

### Startup Sequence

```
1. Connect to dedicated chart tab (logs/supertrend-tab.json)
2. Poll alert_list every 5s until all 4 today-instrument alerts visible (up to 120s)
   → prevents "not found" failures when TV just restarted and alerts haven't synced
3. First force tick → update CE + PE alerts immediately (bypasses 90s cooldown)
4. Verify status → re-activate any stopped alerts
5. Enter 60s poll loop
```

---

### Position State

Stored in `config/position.json`. Updated automatically from alert history each tick.

**Manual override** via Supertrend UI page or CLI:

```
node monitors/monitor.js --ce open --pe closed
node monitors/monitor.js --itm 1    ← force ITM-1 regardless of day rule
node monitors/monitor.js --itm 2    ← force ITM-2
```

---

### Dedicated Chart Tab

The monitor claims one TradingView chart tab on first start, saves ID to `logs/supertrend-tab.json`, and reuses it on restart. If the tab is gone (TV restarted), it scans live tabs and claims the first one not already owned by the pattern monitor.

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

Then open **http://localhost:3000/supertrend-reports** (or click **View Reports** on the Supertrend page).

---

### EOD Workflow (after market close)

| Method          | Command / Action                                             |
| --------------- | ------------------------------------------------------------ |
| UI button       | Go to `http://localhost:3000/supertrend` → click **Generate Report** |
| PowerShell      | `.\eod-report.ps1`                                           |
| Node            | `node scripts/generate-daily-report.js`                      |
| Specific date   | `.\eod-report.ps1 2026-06-07`                                |

The script fetches the option entry/exit prices from TradingView for each trade logged that day, computes clamped exit values, and saves to `logs/daily-trades-YYYY-MM-DD.json`. The reports page auto-opens when generation finishes.

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
      "entryTime": "09:32",
      "lots": 10,
      "lotSize": 65,
      "entryPrice": 123.50,
      "exitSL": 108.50,
      "exitNSL": 95.00,
      "tgtPts": 31.00,
      "charges": 150
    }
  ]
}
```

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
- **Time ranges** — define one or more time windows; trades outside all windows are excluded from stats
- **Monthly summary cards** — one card per P&L type showing totals for the filtered data
- **Day accordions** — expand each trading day to see the trade table

---

### Time Range Filter

Multiple ranges can be active simultaneously. A trade is included if it falls within **any** defined range.

| Action          | How                                              |
| --------------- | ------------------------------------------------ |
| Add a range     | Click **+ Add Range** → set From and To times    |
| Remove a range  | Click **✕** on that range row                   |
| Clear all       | Click **✕ Clear All** (appears when ≥1 range set) |

Example: set 09:30–11:00 and 14:30–15:00 to see only opening and closing session trades.

---

### Trade Table Columns

| Column        | What it shows                                                     |
| ------------- | ----------------------------------------------------------------- |
| Time          | Entry time (HH:MM)                                                |
| Lots          | Number of lots traded                                             |
| Entry         | Option entry price                                                |
| Exit w/SL     | Exit price clamped to SL/target range (see below)                 |
| Exit w/oSL    | Actual exit price, no clamping                                    |
| Tgt Pts       | Points clamped to max target (see below)                          |
| P&L w/SL ₹   | P&L using clamped exit — simulates disciplined SL + target        |
| P&L w/oSL ₹  | P&L using actual exit — what actually happened                    |
| P&L Tgt ₹    | P&L based on Tgt Pts — simulates taking full target every time    |

P&L = (exit − entry) × lots × lotSize. Green = profit, red = loss.

---

### Clamping Logic

Clamping prevents outlier exits from skewing the "disciplined" P&L columns.

| Constant     | NIFTY | SENSEX | Meaning                                       |
| ------------ | ----- | ------ | --------------------------------------------- |
| SL           | 15    | 35     | Max loss per lot in option points              |
| TARGET_G     | 50    | 100    | Max gain for exit price clamp (Exit w/SL col) |
| TARGET_L     | 31    | 70     | Max gain for Tgt Pts clamp                    |
| Lot size     | 65    | 20     | Qty per lot                                   |
| Default lots | 10    | 15     | Used if lots not set in trade                 |

- **exitSL** = `clamp(exitPrice, entry − SL, entry + TARGET_G)`
- **tgtPts** = `clamp(exitPrice − entry, −SL, TARGET_L)`

---

### Monthly Summary Cards

Three cards — one per P&L type (w/SL, w/oSL, Tgt):

| Stat              | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Net P&L           | Sum of all day P&Ls for the filtered trades                      |
| Net Capital       | ₹2,00,000 (initial) ± Net P&L                                    |
| Win Rate          | % of trades with positive P&L                                    |
| Max Drawdown      | Largest peak-to-trough cumulative P&L decline (worst losing run) |
| Max Run-Up        | Largest trough-to-peak cumulative P&L gain (best winning run)    |

Drawdown/Run-Up show the date of occurrence in brackets. These are calculated on the **filtered** data (instrument + time ranges applied).

---

### Daily Table Footer

Each day's trade table has two footer rows:

| Row             | Columns                                          |
| --------------- | ------------------------------------------------ |
| **Day Total**   | Sum of P&L for all 3 types for that day          |
| **Max Drawdown**| Intra-day peak-to-trough for each P&L type       |
| **Max Run-Up**  | Intra-day trough-to-peak for each P&L type       |

---

### Editing Trades

All trades can be edited directly on the page (no restart needed):

| Action       | How                                                          |
| ------------ | ------------------------------------------------------------ |
| Edit a row   | Click **✏ Edit** → modify fields inline → click **✓ Save**   |
| Delete a row | Click **✗** (red)                                            |
| Add a row    | Hover between rows → click **+ Add Row Here**                |
| Save to disk | Click **💾 Save Changes** (appears when unsaved edits exist) |

Edits are in memory until saved. The Save button persists changes to the JSON file on disk.

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
