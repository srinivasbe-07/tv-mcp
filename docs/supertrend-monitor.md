# Supertrend Monitor — Complete Flow Reference

`monitors/monitor.js` — polls every 60 seconds during market hours (09:10–15:30 IST, Mon–Fri).

---

## 1. Startup Flow

```mermaid
flowchart TD
    A([Start monitor.js]) --> B[loadState\nread position.json]
    B --> C{isMarketHours?}

    C -->|No — pre/off-market| D[Reset CE = closed\nPE = closed\ndelete lastLogSnapshot]
    C -->|Yes — market hours| E[Keep CE/PE from file\ndelete lastLogSnapshot]

    D --> F[Print startup banner\nCE=CLOSED  PE=CLOSED]
    E --> G[Print startup banner\nCE=? PE=? from file]

    F --> H[Connect CDP to TV chart tab]
    G --> H

    H --> I{isMarketHours?}
    I -->|Yes| J[Read TV alert history\nfresh-start scan\nRe-derive CE/PE\nsaveState immediately]
    I -->|No| K[Skip — state already correct]

    J --> L[waitForAlertsReady\npoll alert_list every 5s\nup to 120s]
    K --> L

    L --> M[First tick — force = true\nbypasses cooldown\nupdates CE + PE alerts]
    M --> N([Enter 60s poll loop])
```

---

## 2. Per-Tick Flow

```mermaid
flowchart TD
    A([tick]) --> B{isMarketHours\nOR force?}
    B -->|No| C[log: Outside market hours\nreturn]
    B -->|Yes| D[Fetch TV alert history\nALERT_HISTORY_SCRIPT]

    D --> E{todayIST ≠ state.lastDate\nnew trading day?}
    E -->|Yes + pre-market| F[Reset CE/PE = closed\nSeal lastLogSnapshot\nwith current history\nsaveState]
    E -->|Yes + market hours| G[Reset CE/PE = closed\nlastLogSnapshot stays empty\nfresh-start scan will run\nsaveState]
    E -->|No| H[Continue]
    F --> H
    G --> H

    H --> I[processHistoryForPositionChanges\nupdate CE/PE state]

    I --> J[getSpot — read spot price from TV]
    J --> K{spot valid?}
    K -->|No| L[log: invalid spot\nsaveState, return]
    K -->|Yes| M[calcATM\ncheck instrument + ITM depth]

    M --> N{shouldUpdateATM\ncooldown check}
    N -->|Cooldown active\nnot bypassed| O[log: cooldown Xs remaining\nsaveState, return]
    N -->|OK to update| P{atmShifted OR depthChanged\nOR instrChanged OR force\nOR justClosed OR retryNextTick?}
    P -->|No| Q[Nothing changed\nsaveState, return]
    P -->|Yes| R[Update CE alerts]

    R --> S[Update PE alerts]
    S --> T[verifyAlertStatus\nwait 3s, check all 4 active\nre-activate if stopped]
    T --> U[saveState]
```

---

## 3. processHistoryForPositionChanges

Called every tick at step 2. Behaviour depends on whether `lastLogSnapshot` is populated.

```mermaid
flowchart TD
    A([processHistoryForPositionChanges\nhistoryItems, state]) --> B{state.lastLogSnapshot\nempty?}

    B -->|Yes — fresh-start scan| C[Scan history newest → oldest\nStop once both CE + PE determined]
    C --> D{Item is CE entry?}
    D -->|Yes| E[CE = open\nceDone = true]
    D -->|No| F{Item is CE exit?}
    F -->|Yes| G[CE = closed\nceDone = true]
    F -->|No| H[skip]
    E --> I{Item is PE entry?}
    G --> I
    H --> I
    I -->|Yes| J[PE = open\npeDone = true]
    I -->|No| K{Item is PE exit?}
    K -->|Yes| L[PE = closed\npeDone = true]
    K -->|No| M[skip]
    J --> N{ceDone AND peDone?}
    L --> N
    M --> N
    N -->|No| C
    N -->|Yes| O[lastLogSnapshot = historyItems top 30\nreturn changed]

    B -->|No — diff-based detection| P[Find boundary: where does\nprevSnapshot top appear\nin current history?]
    P --> Q{boundaryIdx?}
    Q -->|0 — nothing new| R[Update snapshot\nreturn false]
    Q -->|> 0 — new items found| S[newItems = historyItems 0..boundaryIdx]
    Q -->|-1 — log rolled over| T[newItems = top 5 items]
    S --> U[Process each new item\nupdate CE/PE on match]
    T --> U
    U --> V[Update lastLogSnapshot\nreturn changed]
```

---

## 4. Alert Update Decision — per side

Same logic applies to both CE and PE (substitute CE↔PE).

```mermaid
flowchart TD
    A([Should update CE alerts?]) --> B{state.CE === 'open'?}
    B -->|Yes — trade running| C[SKIP\nlog: CE trade is RUNNING]
    B -->|No — CE closed| D{needsUpdate OR\nCEjustClosed OR\nretryNextTick.CE?}

    D -->|No| E[No action]
    D -->|Yes| F{CEjustClosed AND\nnot needsUpdate AND\nnot retry AND\nlastCEStrike === ceStrike?}

    F -->|Yes — strike unchanged| G[SKIP sync\nlog: CE exit sync skipped]
    F -->|No| H[Call updateAlerts\nnormalizeAlertsPanel\nchart → CE strike\nalert_update_symbol × 2\nchart → spotSymbol]

    H --> I{All updates\nsucceeded?}
    I -->|Yes| J[state.lastCEStrike = ceStrike\nretryNextTick.CE = false]
    I -->|No| K[retryNextTick.CE = true\nlastCEStrike unchanged\nnext tick will retry]
```

---

## 5. ATM Cooldown Logic

```mermaid
flowchart TD
    A([shouldUpdateATM]) --> B{force OR\nCEjustClosed OR\nPEjustClosed?}
    B -->|Yes| C[✓ Update — bypass cooldown]
    B -->|No| D{atmShifted?}
    D -->|No| E[✓ Update — not an ATM shift\nno cooldown applies]
    D -->|Yes| F{elapsed ≥ 60s\nsince lastATMUpdateTime?}
    F -->|Yes| G[✓ Update — cooldown expired]
    F -->|No| H[✗ Block — cooldown active\nlog remaining seconds]
```

---

## 6. Position State Transitions

```mermaid
stateDiagram-v2
    direction LR
    [*] --> CE_closed : startup / pre-market reset
    [*] --> PE_closed : startup / pre-market reset

    state "CE = closed" as CE_closed
    state "CE = open" as CE_open
    state "PE = closed" as PE_closed
    state "PE = open" as PE_open

    CE_closed --> CE_open : niftySupertrendLongEntry fires\n(or fresh-start scan finds entry as newest)
    CE_open --> CE_closed : niftySupertrendLongExit fires\n(or fresh-start scan finds exit as newest)

    PE_closed --> PE_open : niftySupertrendShortEntry fires\n(or fresh-start scan finds entry as newest)
    PE_open --> PE_closed : niftySupertrendShortExit fires\n(or fresh-start scan finds exit as newest)

    CE_open --> CE_closed : new trading day detected\n(CE/PE always reset to closed at day start)
    PE_open --> PE_closed : new trading day detected
```

---

## 7. All Use Cases

### Startup use cases

| Scenario                               | What happens                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Start before 09:10 (pre-market)        | CE/PE reset to closed in `loadState()`. Snapshot sealed on first tick so yesterday's history is never replayed.                        |
| Start after 15:30 (post-market)        | Same as pre-market — CE/PE reset to closed.                                                                                            |
| Start during market hours, same day    | CE/PE loaded from file. Immediately after CDP connects, TV alert history is read and CE/PE is re-derived and saved to `position.json`. |
| Start during market hours, new day     | CE/PE loaded from file, then reset to closed in first tick (new-day detection). Fresh-start scan re-derives any already-open trades.   |
| Continuous running, midnight crossover | First pre-market tick detects `lastDate ≠ today`, resets CE/PE=closed, seals snapshot.                                                 |

### Alert update use cases

| Scenario                             | CE alerts                                           | PE alerts                       |
| ------------------------------------ | --------------------------------------------------- | ------------------------------- |
| ATM shifts, no trade running         | Updated immediately (first shift)                   | Updated immediately             |
| ATM shifts again within 60s          | Blocked by cooldown                                 | Blocked by cooldown             |
| ATM shifts, CE trade running         | Skipped — trade running                             | Updated                         |
| ATM shifts, PE trade running         | Updated                                             | Skipped — trade running         |
| CE trade exits                       | Force-sync CE to current strike (cooldown bypassed) | Continues normally              |
| PE trade exits                       | Continues normally                                  | Force-sync PE to current strike |
| CE exit sync, strike unchanged       | Skipped — already on correct strike                 | —                               |
| Alert update fails (panel not ready) | `retryNextTick.CE = true` — retries every 60s       | Same                            |
| `force = true` (startup first tick)  | Always updates, bypasses cooldown                   | Always updates                  |
| Instrument changes day-to-day        | Both sides updated                                  | Both sides updated              |
| ITM depth changes (config edit)      | Both sides updated                                  | Both sides updated              |

### Position state use cases

| Scenario                                                 | Behaviour                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| PE exit fired while monitor was down                     | Market-hours restart reads history → finds exit → PE=closed saved immediately       |
| PE entry fired while monitor was down                    | Market-hours restart reads history → finds entry → PE=open preserved                |
| Both CE and PE trades running                            | Fresh-start scan finds both entries → CE=open, PE=open. Both alert updates skipped. |
| History log rolled over (> 30 items since last snapshot) | Diff detects no boundary → processes top 5 items as fallback                        |
| TradingView restarted, history empty                     | `historyItems.length === 0` → loaded state kept as-is                               |

### Alert panel use cases

| Scenario                                       | Behaviour                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Alerts panel on Log tab after history read     | `normalizeAlertsPanel` always clicks Alerts tab before every update |
| Alerts panel closed                            | `normalizeAlertsPanel` opens it, clicks Alerts tab                  |
| Alert not found on first attempt               | `retryNextTick = true` → retry on next 60s tick                     |
| Alert stopped/inactive after update            | `verifyAlertStatus` re-activates it (3s after update)               |
| All 4 alerts not found in `waitForAlertsReady` | Polls every 5s up to 120s — TV may still be syncing from cloud      |

---

## 8. Key Constants

| Constant                     | Value      | Purpose                                       |
| ---------------------------- | ---------- | --------------------------------------------- |
| `POLL_MS`                    | 60 000 ms  | Tick interval                                 |
| `ATM_COOLDOWN_MS`            | 60 000 ms  | Min gap between ATM-shift updates             |
| `MARKET_OPEN_MIN`            | 09:10 IST  | Start of market hours                         |
| `MARKET_CLOSE_MIN`           | 15:30 IST  | End of market hours                           |
| `waitForAlertsReady` timeout | 120 000 ms | Max wait for alerts panel on startup          |
| Chart settle wait            | 3 000 ms   | After chart symbol switch before alert update |
| Between alert dialogs        | 1 500 ms   | After each `alert_update_symbol` call         |

---

## 9. Instrument Routing

| Day       | Instrument | Strike step | ITM depth | Expiry   |
| --------- | ---------- | ----------- | --------- | -------- |
| Monday    | NIFTY      | 50          | ITM-2     | Tuesday  |
| Tuesday   | NIFTY      | 50          | ITM-2     | Tuesday  |
| Wednesday | SENSEX     | 100         | ITM-2     | Thursday |
| Thursday  | SENSEX     | 100         | ITM-2     | Thursday |
| Friday    | NIFTY      | 50          | ITM-1     | Tuesday  |

Strike formula: CE = ATM − (itmDepth × step), PE = ATM + (itmDepth × step).
Expiry shifts back if the expiry day is a holiday (checked against `config/holidays.json`).
