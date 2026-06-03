# Pattern Monitor — Progress Tracker

Mark each item `[x]` when completed.

---

## 1. Project Cleanup

- [x] 1.1 Rewrote `pattern-monitor.js` from scratch
- [x] 1.2 Removed 23 unnecessary files
- [x] 1.3 Committed to git

---

## 2. Pine Script

- [x] 2.1 Created `scripts/pine/pattern-candles.pine`
- [x] 2.2 Fixed `range` reserved keyword error
- [x] 2.3 Removed labels/markers — body color only
- [x] 2.4 Loaded in TradingView manually

---

## 3. Design & Documentation

- [x] 3.1 Created `docs/pattern-monitor-design.md`
- [x] 3.2 Documented reversal vs continuation logic
- [x] 3.3 Defined Section 1 (Setup on Load) and Section 2 (15-min Logic)
- [x] 3.4 Created Mermaid flow diagram
- [x] 3.5 Clarified two UIs — Browser UI (config) vs TradingView (display)
- [x] 3.6 Config finalised — only `bias` + `importantLevels`
- [x] 3.7 Confirmed no `active` flag — monitor always runs
- [x] 3.8 Dynamic day H/L cache — start D-10, auto-expand +3 when exhausted
- [x] 3.9 Level break rule — close beyond = broken, draw next level
- [x] 3.10 Liquidity grab rule — wick + close back + pattern = flip bias

---

## 4. Browser UI — pattern.html

- [x] 4.1 Page created at `localhost:3000/pattern`
- [x] 4.2 Header — TV status, Pattern start/stop/restart, bias chip
- [x] 4.3 Left panel — Bias toggle (▲ BUY/CALL | ▼ SELL/PUT)
- [x] 4.4 Left panel — Important levels (add / remove / apply)
- [x] 4.5 Right panel — Stats row (Bias, Resistance, Support, Last Event)
- [x] 4.6 Right panel — 15-min Candle Feed (with WATCH / BREAK / FLIP tags)
- [x] 4.7 Right panel — Monitor Log (divided with header)
- [x] 4.8 Dummy data loads on startup for preview

---

## 5. Dashboard

- [x] 5.1 Restored old dashboard from git (two-panel layout)
- [x] 5.2 Supertrend restart button — always visible, disabled when stopped
- [ ] 5.3 Pattern Monitor panel — replace old fields (Zone/Target/SL) with new fields (Bias/Resistance/Support/Last Event)
- [ ] 5.4 Pattern Monitor panel — wire live log from PM SSE

---

## 6. Server — API & Process Management

- [ ] 6.1 Add `pmProc` variable for process tracking
- [ ] 6.2 Add `pmClients` + `pmLog` for SSE
- [ ] 6.3 Update `getStatus()` to include `pm` state
- [ ] 6.4 `POST /api/pm/start` — spawn pattern monitor process
- [ ] 6.5 `POST /api/pm/stop` — kill process
- [ ] 6.6 `POST /api/pm/restart` — stop then start
- [ ] 6.7 `GET /api/pm/events` — real SSE log stream
- [ ] 6.8 `GET /api/pm/config` — read config file
- [ ] 6.9 `POST /api/pm/bias` — save bias + redraw TV immediately
- [ ] 6.10 `POST /api/pm/levels` — save levels + redraw TV immediately
- [ ] 6.11 Atomic config write (tmp file + rename)

---

## 7. Pattern Monitor Logic

- [ ] 7.1 Config — remove `zone`, `active`, `candleTimeframe` — keep only `bias` + `importantLevels`
- [ ] 7.2 Always 15-min — hardcoded, no config option
- [ ] 7.3 On load — clear all chart drawings
- [ ] 7.4 On load — fetch day H/L (D-1 to D-10)
- [ ] 7.5 On load — draw nearest resistance + support lines on chart
- [ ] 7.6 On load — draw important levels on chart
- [ ] 7.7 On stop — clear all chart drawings
- [ ] 7.8 Every 15-min close — check if price closed beyond active level
- [ ] 7.9 Level broken — mark broken, draw next nearest level on chart
- [ ] 7.10 Every 15-min close — check for liquidity grab at level
- [ ] 7.11 Liquidity grab detected — flip bias in config + redraw chart levels
- [ ] 7.12 All levels exhausted — fetch 3 more days, draw next level
- [ ] 7.13 Config file watch — redraw chart immediately on bias/levels change

---

## 8. TBD — Not Yet Discussed

- [ ] 8.1 Pattern detection for trade alerts — decide trigger and which alerts to update
