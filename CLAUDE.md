# TradingView MCP — Claude Instructions

This MCP server lets you control TradingView Desktop via Chrome DevTools Protocol.
**Prerequisite**: TradingView must be running with `--remote-debugging-port=9222`. Call `tv_health_check` first if unsure.

---

## Daily Workflow — Trade Monitor

### Every day (fresh start)

```
.\start-pattern-monitor.ps1
```

Closes any existing TradingView, launches it with CDP, then starts the trade monitor.

### TradingView already open

```
.\start-pattern-monitor.ps1 -SkipTV
```

### Keys while monitor is running

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
