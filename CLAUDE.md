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

| URL                                | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `http://localhost:3000`            | Dashboard — overview + start/stop all processes   |
| `http://localhost:3000/pattern`    | Pattern Monitor — full config, log, candle feed   |
| `http://localhost:3000/supertrend` | Supertrend Monitor — ITM override, CE/PE position |

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

## Supertrend Monitor

### What It Does

Automatically keeps 4 TradingView alerts pointed at the correct ITM option strike as NIFTY/SENSEX spot price moves during the day. Without it, you'd have to manually edit each alert every time the ATM shifts.

### Instrument Routing

| Day       | Instrument | Strike Step | ITM Depth |
| --------- | ---------- | ----------- | --------- |
| Mon / Tue | NIFTY      | 50          | ITM-2     |
| Wed / Thu | SENSEX     | 100         | ITM-2     |
| Fri       | NIFTY      | 50          | ITM-1     |

### Alert Names (must exist in TradingView before starting)

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

### Every 60 Seconds It

1. Reads spot price (NIFTY or SENSEX) from its dedicated chart tab
2. Calculates ATM — rounds spot to nearest strike interval
3. Confirms ATM shift across 2 consecutive ticks (avoids false updates on noise)
4. Updates CE alerts → switches chart to CE option → updates entry + exit → switches back
5. Updates PE alerts → switches chart to PE option → updates entry + exit → switches back
6. Reads alert history → if entry alert fired → marks CE/PE as `OPEN`; if exit fired → marks as `CLOSED`
7. Skips updating a side when its position is `OPEN` (don't move the alert mid-trade)

### Position State

Stored in `config/position.json`. Updated automatically by alert history. Can also be overridden manually via the Supertrend page (CE/PE buttons) or CLI flags:

```
node monitors/monitor.js --ce open --pe closed
node monitors/monitor.js --itm 1    ← force ITM-1 regardless of day rule
```

### Dedicated Chart Tab

The monitor claims one TradingView chart tab on first start and saves its ID to `logs/supertrend-tab.json`. On restart it reuses the same tab. If TradingView was restarted, it scans live tabs and claims an unclaimed one.

**Requirement**: Have at least 2 chart tabs open in TradingView when running both monitors simultaneously (one per monitor).

### What It Does NOT Do

- Does not place orders — only manages TradingView alerts
- Does not create alerts — the 8 alerts above must already exist in TradingView
- Does not manage the Supertrend indicator itself — that lives on your chart

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
