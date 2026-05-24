# Complete Test Cases - All 16 Tools

**Purpose**: Comprehensive testing specification for all TradingView MCP tools  
**Status**: Ready for automation and manual testing  
**Total Test Cases**: 16 (one per tool)

---

## Quick Start: Run Automated Tests

```bash
cd C:\study\MCP\tv-mcp
node test-all-tools.js
```

**Output**:

- Console output with real-time results
- `test-results.log` - Detailed log file
- `test-results.json` - Machine-readable results

---

## Test Structure

Each test case has:

- **Name**: Tool name (e.g., `chart_get_state`)
- **Description**: What it does
- **Params**: Input parameters
- **Expected Fields**: Required fields in response
- **Success Criteria**: What counts as passing
- **Failure Cases**: What should be handled gracefully

---

## Category 1: Chart Tools (5 Tests)

### TEST-001: chart_get_state

**Purpose**: Verify tool can extract current chart state

**Tool Name**: `chart_get_state`

**Input Parameters**:

```json
{}
```

**Expected Response**:

```json
{
  "symbol": "AAPL",
  "timeframe": "D",
  "chartType": "Candle",
  "indicators": [],
  "status": "live"
}
```

**Expected Fields**:

- ✅ `symbol` (string)
- ✅ `timeframe` (string)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ Response has valid JSON format
- ✅ Contains `symbol` and `timeframe`
- ✅ Response time < 1 second

**Failure Handling**:

- If API unavailable → Use DOM fallback
- If DOM unavailable → Return error hint
- Never crash

**Test Command**:

```
Use chart_get_state
```

**Expected Outcome**:

- 🟢 Pass: Returns symbol and timeframe
- 🟡 Acceptable: Returns error with helpful hint
- 🔴 Fail: Crashes or invalid response

---

### TEST-002: quote_get

**Purpose**: Verify tool can extract current price

**Tool Name**: `quote_get`

**Input Parameters**:

```json
{}
```

**Expected Response**:

```json
{
  "symbol": "AAPL",
  "price": "150.25",
  "ohlc": {
    "open": "149.50",
    "high": "151.00",
    "low": "149.00",
    "close": "150.25"
  },
  "volume": 25000000,
  "change": "2.50",
  "changePercent": "1.67",
  "timestamp": "2026-05-24T10:30:00Z"
}
```

**Expected Fields**:

- ✅ `price` (number or string)
- ✅ `symbol` (string)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `price` is a valid number (or parseable)
- ✅ Has timestamp
- ✅ Response time < 1 second

**Failure Handling**:

- If live data unavailable → Return fallback price
- If symbol unavailable → Return "UNKNOWN"
- Never crash

**Test Command**:

```
Use quote_get
```

**Expected Outcome**:

- 🟢 Pass: Returns real price data
- 🟡 Acceptable: Returns fallback price with note
- 🔴 Fail: Crashes or null price

---

### TEST-003: data_get_ohlcv

**Purpose**: Verify tool can extract OHLCV bars

**Tool Name**: `data_get_ohlcv`

**Input Parameters**:

```json
{
  "summary": true,
  "limit": 50
}
```

**Expected Response (Summary Mode)**:

```json
{
  "summary": true,
  "count": 50,
  "bars": [
    {
      "time": 1716543000,
      "open": 150.0,
      "high": 151.5,
      "low": 149.5,
      "close": 150.5,
      "volume": 1500000
    },
    ...5 bars total
  ],
  "stats": {
    "high": "151.50",
    "low": "149.00",
    "close": "150.25",
    "avg": "150.15",
    "totalVolume": 7500000
  }
}
```

**Expected Fields**:

- ✅ `bars` (array with OHLCV data)
- ✅ `stats` (object with high/low/close/avg)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ Returns array of bars
- ✅ Each bar has OHLCV
- ✅ Summary mode returns 5 bars max
- ✅ Full mode returns all bars
- ✅ Response time < 2 seconds

**Failure Handling**:

- If real data unavailable → Generate realistic sample
- If limit too high → Cap at max 100 bars
- Never crash

**Test Command**:

```
Use data_get_ohlcv with summary=true
Use data_get_ohlcv with summary=false, limit=100
```

**Expected Outcome**:

- 🟢 Pass: Returns real bars with stats
- 🟡 Acceptable: Returns sample data with note
- 🔴 Fail: Crashes or empty bars

---

### TEST-004: chart_set_symbol

**Purpose**: Verify tool can change chart symbol

**Tool Name**: `chart_set_symbol`

**Input Parameters**:

```json
{
  "symbol": "GOOGL"
}
```

**Expected Response**:

```json
{
  "success": true,
  "symbol": "GOOGL",
  "via": "api_or_ui",
  "timestamp": "2026-05-24T10:30:00Z"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `symbol` (string, matches input)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `symbol` matches input
- ✅ Response time < 2 seconds

**Failure Handling**:

- If API unavailable → Try UI interaction
- If UI unavailable → Return success=false with hint
- Never crash

**Test Command**:

```
Use chart_set_symbol with symbol="GOOGL"
Use chart_set_symbol with symbol="BTC/USD"
```

**Expected Outcome**:

- 🟢 Pass: Successfully changes symbol
- 🟡 Acceptable: Returns success=false with method hint
- 🔴 Fail: Crashes or invalid response

---

### TEST-005: chart_set_timeframe

**Purpose**: Verify tool can change chart timeframe

**Tool Name**: `chart_set_timeframe`

**Input Parameters**:

```json
{
  "timeframe": "5"
}
```

**Expected Response**:

```json
{
  "success": true,
  "timeframe": "5",
  "via": "api_or_ui",
  "timestamp": "2026-05-24T10:30:00Z"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `timeframe` (string, matches input)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `timeframe` matches input
- ✅ Response time < 2 seconds

**Valid Timeframes**:

- "1", "5", "15", "30", "60" (minutes)
- "D" (daily), "W" (weekly), "M" (monthly)

**Test Command**:

```
Use chart_set_timeframe with timeframe="5"
Use chart_set_timeframe with timeframe="D"
Use chart_set_timeframe with timeframe="W"
```

**Expected Outcome**:

- 🟢 Pass: Successfully changes timeframe
- 🟡 Acceptable: Returns success=false with hint
- 🔴 Fail: Crashes or invalid response

---

## Category 2: Pine Script Tools (5 Tests)

### TEST-006: pine_get_source

**Purpose**: Verify tool can read Pine Script source

**Tool Name**: `pine_get_source`

**Input Parameters**:

```json
{}
```

**Expected Response**:

```json
{
  "source": "//@version=5\nindicator('My Indicator')\nplot(close)",
  "language": "pine",
  "version": 5,
  "lines": 3,
  "found": true
}
```

**Expected Fields**:

- ✅ `source` (string with code)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ Returns non-empty source string
- ✅ Source is valid Pine Script (contains @version)
- ✅ Response time < 1 second

**Failure Handling**:

- If no editor → Return sample Pine Script
- If editor empty → Return empty string with note
- Never crash

**Test Command**:

```
Use pine_get_source
```

**Expected Outcome**:

- 🟢 Pass: Returns real script source
- 🟡 Acceptable: Returns sample script with note
- 🔴 Fail: Crashes or invalid response

---

### TEST-007: pine_set_source

**Purpose**: Verify tool can inject Pine Script code

**Tool Name**: `pine_set_source`

**Input Parameters**:

```json
{
  "source": "//@version=5\nindicator('Test')\nplot(close)"
}
```

**Expected Response**:

```json
{
  "success": true,
  "lines": 3,
  "via": "editor_injection",
  "message": "Source code injected"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `lines` (number, code line count)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `lines` count matches code
- ✅ Response time < 2 seconds

**Failure Handling**:

- If CodeMirror available → Use that
- If Monaco available → Use that
- If textarea available → Use that
- If nothing → Return success=false
- Never crash

**Test Command**:

```
Use pine_set_source with source="//@version=5\nindicator('Test')\nplot(close)"
```

**Expected Outcome**:

- 🟢 Pass: Successfully injects code
- 🟡 Acceptable: Returns success=false with method tried
- 🔴 Fail: Crashes or invalid response

---

### TEST-008: pine_smart_compile

**Purpose**: Verify tool detects compilation errors

**Tool Name**: `pine_smart_compile`

**Input Parameters**:

```json
{
  "timeoutMs": 10000
}
```

**Expected Response (Success)**:

```json
{
  "success": true,
  "status": "compiled",
  "errors": [],
  "warnings": [],
  "compilationTime": 234.5,
  "errorCount": 0,
  "warningCount": 0
}
```

**Expected Response (With Errors)**:

```json
{
  "success": false,
  "status": "error",
  "errors": [
    {
      "line": 5,
      "message": "undefined variable 'x'"
    }
  ],
  "warnings": [],
  "compilationTime": 156.2,
  "errorCount": 1,
  "warningCount": 0
}
```

**Expected Fields**:

- ✅ `status` (string: "compiled" or "error")
- ✅ `errors` (array)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `status` is valid (compiled/error/warning)
- ✅ `errors` is array
- ✅ Response time < 5 seconds

**Failure Handling**:

- If compiler unavailable → Return status="error"
- If timeout → Return with partial results
- Never crash

**Test Command**:

```
Use pine_smart_compile
```

**Expected Outcome**:

- 🟢 Pass: Detects errors correctly
- 🟡 Acceptable: Returns empty error list
- 🔴 Fail: Crashes or invalid status

---

### TEST-009: pine_get_errors

**Purpose**: Verify tool extracts compilation errors

**Tool Name**: `pine_get_errors`

**Input Parameters**:

```json
{}
```

**Expected Response (No Errors)**:

```json
{
  "errors": [],
  "warnings": [],
  "hasErrors": false,
  "errorCount": 0,
  "warningCount": 0,
  "status": "ok"
}
```

**Expected Response (With Errors)**:

```json
{
  "errors": [
    {
      "line": 1,
      "message": "Syntax error on line 1"
    }
  ],
  "warnings": [
    {
      "line": 5,
      "message": "Unused variable"
    }
  ],
  "hasErrors": true,
  "errorCount": 1,
  "warningCount": 1,
  "status": "error"
}
```

**Expected Fields**:

- ✅ `errors` (array)
- ✅ `warnings` (array)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ Both `errors` and `warnings` are arrays
- ✅ Response time < 1 second

**Failure Handling**:

- If no errors → Return empty arrays
- If no editor → Return empty arrays with note
- Never crash

**Test Command**:

```
Use pine_get_errors
```

**Expected Outcome**:

- 🟢 Pass: Returns correct error list
- 🟡 Acceptable: Returns empty error list
- 🔴 Fail: Crashes or invalid response

---

### TEST-010: pine_save

**Purpose**: Verify tool can save Pine Script

**Tool Name**: `pine_save`

**Input Parameters**:

```json
{
  "name": "MyStrategy"
}
```

**Expected Response**:

```json
{
  "success": true,
  "name": "MyStrategy",
  "saved": "2026-05-24T10:30:00Z",
  "message": "Script saved successfully"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `name` (string, matches input)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `name` matches input
- ✅ Has timestamp
- ✅ Response time < 3 seconds

**Failure Handling**:

- If save button unavailable → Try publish button
- If nothing available → Return success=false
- Never crash

**Test Command**:

```
Use pine_save with name="MyStrategy"
```

**Expected Outcome**:

- 🟢 Pass: Successfully saves script
- 🟡 Acceptable: Returns success=false with hint
- 🔴 Fail: Crashes or invalid response

---

## Category 3: Alert Tools (3 Tests)

### TEST-011: alert_list

**Purpose**: Verify tool can list all active alerts

**Tool Name**: `alert_list`

**Input Parameters**:

```json
{}
```

**Expected Response (No Alerts)**:

```json
{
  "alerts": [],
  "total": 0,
  "active": 0,
  "found": false
}
```

**Expected Response (With Alerts)**:

```json
{
  "alerts": [
    {
      "id": "alert_1",
      "symbol": "AAPL",
      "condition": "above",
      "level": 150,
      "name": "AAPL above 150",
      "created": "2026-05-24T10:00:00Z",
      "active": true
    },
    {
      "id": "alert_2",
      "symbol": "GOOGL",
      "condition": "below",
      "level": 2500,
      "name": "GOOGL below 2500",
      "created": "2026-05-24T09:00:00Z",
      "active": true
    }
  ],
  "total": 2,
  "active": 2,
  "found": true
}
```

**Expected Fields**:

- ✅ `alerts` (array)
- ✅ `total` (number)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `alerts` is array
- ✅ `total` matches array length
- ✅ Response time < 1 second

**Failure Handling**:

- If no alerts → Return empty array
- If API unavailable → Try DOM scraping
- Never crash

**Test Command**:

```
Use alert_list
```

**Expected Outcome**:

- 🟢 Pass: Returns real alerts list
- 🟡 Acceptable: Returns empty alert list
- 🔴 Fail: Crashes or invalid response

---

### TEST-012: alert_create

**Purpose**: Verify tool can create new alert

**Tool Name**: `alert_create`

**Input Parameters**:

```json
{
  "symbol": "AAPL",
  "condition": "above",
  "level": 150
}
```

**Expected Response**:

```json
{
  "success": true,
  "alertId": "alert_12345",
  "symbol": "AAPL",
  "condition": "above",
  "level": 150,
  "name": "AAPL above 150",
  "created": "2026-05-24T10:30:00Z",
  "via": "api_or_ui"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `alertId` (string)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `alertId` is non-empty string
- ✅ Response time < 3 seconds

**Valid Conditions**:

- "above", "below", "crosses"

**Failure Handling**:

- If API unavailable → Try form interaction
- If form unavailable → Return success=false
- Never crash

**Test Command**:

```
Use alert_create with symbol="AAPL", condition="above", level=150
Use alert_create with symbol="GOOGL", condition="below", level=2500
```

**Expected Outcome**:

- 🟢 Pass: Successfully creates alert
- 🟡 Acceptable: Returns success=false with hint
- 🔴 Fail: Crashes or invalid response

---

### TEST-013: alert_delete

**Purpose**: Verify tool can delete alert

**Tool Name**: `alert_delete`

**Input Parameters**:

```json
{
  "alertId": "alert_1"
}
```

**Expected Response**:

```json
{
  "success": true,
  "alertId": "alert_1",
  "deleted": "2026-05-24T10:30:00Z",
  "message": "Alert deleted successfully"
}
```

**Expected Fields**:

- ✅ `success` (boolean)
- ✅ `alertId` (string, matches input)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `success` is boolean
- ✅ `alertId` matches input
- ✅ Response time < 2 seconds

**Failure Handling**:

- If API unavailable → Try UI button
- If alert not found → Return success=false
- Never crash

**Test Command**:

```
Use alert_delete with alertId="alert_1"
```

**Expected Outcome**:

- 🟢 Pass: Successfully deletes alert
- 🟡 Acceptable: Returns success=false with hint
- 🔴 Fail: Crashes or invalid response

---

## Category 4: Utility Tools (3 Tests)

### TEST-014: tv_health_check

**Purpose**: Verify TradingView connection is healthy

**Tool Name**: `tv_health_check`

**Input Parameters**:

```json
{}
```

**Expected Response (Connected)**:

```json
{
  "status": "connected",
  "connected": true,
  "port": 9222,
  "tradingview": {
    "title": "AAPL on TradingView",
    "status": "connected"
  },
  "timestamp": "2026-05-24T10:30:00Z",
  "message": "TradingView MCP is healthy and connected"
}
```

**Expected Response (Disconnected)**:

```json
{
  "status": "disconnected",
  "connected": false,
  "port": 9222,
  "message": "TradingView is not connected. Start TradingView with --remote-debugging-port=9222"
}
```

**Expected Fields**:

- ✅ `status` (string)
- ✅ `connected` (boolean)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `status` is valid (connected/disconnected)
- ✅ `connected` is boolean
- ✅ Response time < 1 second

**Failure Handling**:

- If not connected → Return helpful message
- If connection times out → Retry up to 3 times
- Never crash

**Test Command**:

```
Use tv_health_check
```

**Expected Outcome**:

- 🟢 Pass: Shows connected=true
- 🟡 Acceptable: Shows connected=false with hint
- 🔴 Fail: Crashes or invalid status

---

### TEST-015: tv_launch

**Purpose**: Get TradingView launch command

**Tool Name**: `tv_launch`

**Input Parameters**:

```json
{
  "port": 9222
}
```

**Expected Response (Windows)**:

```json
{
  "success": true,
  "platform": "win32",
  "command": "\"%LOCALAPPDATA%\\TradingView\\TradingView.exe\" --remote-debugging-port=9222",
  "port": 9222,
  "message": "To launch TradingView with debugging, run: ..."
}
```

**Expected Response (macOS)**:

```json
{
  "success": true,
  "platform": "darwin",
  "command": "/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222",
  "port": 9222,
  "message": "To launch TradingView with debugging, run: ..."
}
```

**Expected Fields**:

- ✅ `command` (string)
- ✅ `platform` (string)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `command` contains executable path
- ✅ `command` contains port number
- ✅ `platform` matches OS
- ✅ Response time < 1 second

**Failure Handling**:

- If unsupported platform → Return error message
- Never crash

**Test Command**:

```
Use tv_launch
Use tv_launch with port=9223
```

**Expected Outcome**:

- 🟢 Pass: Returns correct launch command
- 🟡 Acceptable: Returns error for unsupported platform
- 🔴 Fail: Crashes or invalid command

---

### TEST-016: capture_screenshot

**Purpose**: Capture chart screenshot

**Tool Name**: `capture_screenshot`

**Input Parameters**:

```json
{
  "region": "chart"
}
```

**Expected Response (Success)**:

```json
{
  "success": true,
  "region": "chart",
  "format": "png",
  "size": 45678,
  "timestamp": "2026-05-24T10:30:00Z",
  "data": "iVBORw0KGgoAAAANSUhEUgAA...[binary PNG data]",
  "message": "Screenshot captured (chart region)"
}
```

**Expected Response (Failure)**:

```json
{
  "success": false,
  "region": "chart",
  "error": "Screenshot capture failed",
  "message": "Note: Screenshot capture requires TradingView widget API integration"
}
```

**Expected Fields**:

- ✅ `data` (string with base64 PNG) OR `error` (string)

**Success Criteria**:

- ✅ Tool executes without error
- ✅ `data` field has valid base64 PNG
- ✅ OR `error` field with helpful message
- ✅ Response time < 2 seconds

**Valid Regions**:

- "full", "chart", "strategy_tester"

**Failure Handling**:

- If screenshot fails → Return error message
- If region invalid → Use default "chart"
- Never crash

**Test Command**:

```
Use capture_screenshot with region="chart"
Use capture_screenshot with region="full"
```

**Expected Outcome**:

- 🟢 Pass: Returns PNG data
- 🟡 Acceptable: Returns error with hint
- 🔴 Fail: Crashes or invalid response

---

## Test Execution Summary

### Manual Testing

Run tests one by one in Claude Code:

```
Use [tool_name] [with params]
```

### Automated Testing

Run all tests at once:

```bash
node test-all-tools.js
```

### Expected Results

#### Perfect Run (All Green)

```
Total Tests: 16
Passed: 16 (100%)
Failed: 0 (0%)
Errors: 0 (0%)

✅ ALL TESTS PASSED!
```

#### Good Run (Mostly Green)

```
Total Tests: 16
Passed: 14 (87.5%)
Failed: 2 (12.5%)
Errors: 0 (0%)

⚠️ 2 tests need attention
```

#### Needs Work (Some Failures)

```
Total Tests: 16
Passed: 10 (62.5%)
Failed: 4 (25%)
Errors: 2 (12.5%)

⚠️ 6 tests need attention
```

---

## Test Report Template

After running tests, document:

```markdown
# Phase 3 Test Results

## Summary

- Date: [date]
- TradingView: [Connected/Disconnected]
- Total Tests: 16
- Passed: [count]
- Failed: [count]
- Errors: [count]

## By Category

- Chart Tools: [count] passed
- Pine Tools: [count] passed
- Alert Tools: [count] passed
- Utility Tools: [count] passed

## Detailed Results

[List each test with Pass/Fail/Error]

## Issues Found

[List any failures and errors]

## Recommendations

[What to fix next]
```

---

**Status**: ✅ Test cases complete and ready for automation!
