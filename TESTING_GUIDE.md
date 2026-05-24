# TradingView MCP - Testing Guide

## Testing Options

### Option 1: Claude Code (Recommended)

**Best for**: Full integration testing with Claude

### Option 2: Direct Terminal Test

**Best for**: Quick tool testing without Claude

### Option 3: Test Script

**Best for**: Automated testing of all tools

---

## Option 1: Test with Claude Code

### Step 1: Configure MCP in Claude Code

Edit `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:\\study\\MCP\\tv-mcp\\src\\server.js"]
    }
  }
}
```

### Step 2: Start the Server

```bash
cd C:\study\MCP\tv-mcp
npm start
```

### Step 3: Test in Claude Code

Ask Claude any of these:

**Health Check:**

```
Use tv_health_check to verify TradingView is connected
```

**Chart Operations:**

```
Use chart_get_state to see the current chart
Use quote_get to get the latest price
Use data_get_ohlcv to get candle data with summary=true
```

**Pine Script:**

```
Use pine_get_source to see the current script
```

**Alerts:**

```
Use alert_list to see all alerts
```

---

## Option 2: Direct Terminal Testing

### Step 1: Start the Server

```bash
npm start
```

### Step 2: Create a Test Script

Create `test-mcp.js` in your project:

```javascript
// test-mcp.js
import { spawn } from 'child_process';

// Start the server
const server = spawn('node', ['src/server.js'], {
  cwd: process.cwd(),
});

// Give server time to start
await new Promise((resolve) => setTimeout(resolve, 1000));

// Send a tool call request
const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'tv_health_check',
    arguments: {},
  },
};

console.log('Sending request:', request);
console.log('Waiting for response...\n');

// Listen for output
server.stdout.on('data', (data) => {
  console.log('SERVER OUTPUT:', data.toString());
});

server.stderr.on('data', (data) => {
  console.log('SERVER ERROR:', data.toString());
});

// Send request to server stdin
server.stdin.write(JSON.stringify(request) + '\n');

// Cleanup after 5 seconds
setTimeout(() => {
  server.kill();
  process.exit(0);
}, 5000);
```

### Step 3: Run the Test

```bash
node test-mcp.js
```

---

## Option 3: Simple Test Script (Recommended for Quick Testing)

Create `test-tools.sh` (Mac/Linux) or `test-tools.bat` (Windows):

### Windows (test-tools.bat)

```batch
@echo off
cd C:\study\MCP\tv-mcp

REM Start the server in background
start /B node src/server.js > server.log 2>&1

REM Give server time to start
timeout /t 2 /nobreak

REM Run tests
echo Testing tv_health_check...
node -e "console.log('Server is running. Check server.log for output')"

REM Keep the server running
timeout /t 10 /nobreak
taskkill /F /IM node.exe
```

### Mac/Linux (test-tools.sh)

```bash
#!/bin/bash
cd C:\study\MCP\tv-mcp

# Start server in background
node src/server.js > server.log 2>&1 &
SERVER_PID=$!

# Wait for startup
sleep 2

# Run tests
echo "Server started with PID: $SERVER_PID"
echo "Check server.log for output"

# Keep running
sleep 10

# Cleanup
kill $SERVER_PID
```

---

## Testing Strategy: Test Each Tool

### 1. Health Check (Connectivity Test)

**What it tests**: Is the server running and can it reach TradingView?

**Expected Output (without TradingView running)**:

```json
{
  "status": "disconnected",
  "connected": false,
  "message": "TradingView is not connected..."
}
```

**Expected Output (with TradingView running)**:

```json
{
  "status": "connected",
  "connected": true,
  "message": "TradingView MCP is healthy and connected"
}
```

---

### 2. Chart Tools

**chart_get_state** - Get chart info

- Symbol, timeframe, indicators
- Currently returns sample data (Phase 2 will make real)

**quote_get** - Get price data

- Current price, OHLC, volume
- Currently returns sample data

**data_get_ohlcv** - Get candle data

- Test with `summary: true` (compact)
- Test with `summary: false` (all bars)

**chart_set_symbol** - Change symbol

- Test: `symbol: "AAPL"`
- Test: `symbol: "BTC/USD"`

**chart_set_timeframe** - Change timeframe

- Test: `timeframe: "D"` (daily)
- Test: `timeframe: "5"` (5 min)

---

### 3. Pine Script Tools

**pine_get_source** - Read current script

- Should return sample Pine Script code

**pine_set_source** - Inject code

- Test with simple code
- Test with complex code

**pine_smart_compile** - Compile script

- Should return compilation status
- Should detect errors (Phase 2)

**pine_get_errors** - Get compilation errors

- Currently empty (will return real errors in Phase 2)

**pine_save** - Save script

- Test: `name: "MyStrategy"`

---

### 4. Alert Tools

**alert_list** - List all alerts

- Returns sample alerts (2 alerts)

**alert_create** - Create alert

- Test: `symbol: "AAPL", condition: "above", level: 150`
- Test: `symbol: "GOOGL", condition: "below", level: 2500`

**alert_delete** - Delete alert

- Test: `alertId: "alert_1"`

---

### 5. Utility Tools

**tv_health_check** - Connection status

- PRIMARY TEST - run first!

**tv_launch** - Launch TradingView

- Returns launch command for your platform

**capture_screenshot** - Grab screenshot

- Test: `region: "chart"`

---

## Full Testing Checklist

```
CONNECTIVITY
  [ ] tv_health_check returns status (run first!)
  [ ] Server logs show connection attempts

CHART TOOLS
  [ ] chart_get_state returns data
  [ ] quote_get returns price data
  [ ] data_get_ohlcv returns bars
  [ ] chart_set_symbol accepts symbol
  [ ] chart_set_timeframe accepts timeframe

PINE SCRIPT TOOLS
  [ ] pine_get_source returns code
  [ ] pine_set_source accepts code
  [ ] pine_smart_compile returns status
  [ ] pine_get_errors returns empty list
  [ ] pine_save accepts name

ALERTS
  [ ] alert_list returns sample alerts
  [ ] alert_create returns success
  [ ] alert_delete returns success

UTILITY
  [ ] tv_launch returns command
  [ ] capture_screenshot returns data

LOGGING
  [ ] Check tradingview-mcp.log for timestamps
  [ ] No error messages in log
  [ ] All tool calls logged
```

---

## Running Tests in Order

### Test 1: Server Startup (Do this first)

```bash
cd C:\study\MCP\tv-mcp
npm start
```

**Expected Output:**

```
[timestamp] Starting TradingView MCP Server v0.1.0
[timestamp] Waiting for MCP client connection...
```

✅ If you see this, the server is working!

---

### Test 2: Claude Code Integration

1. Open Claude Code
2. Ask: "Use tv_health_check"
3. Check response

**Expected:**

- Either: "connected: true" (if TradingView is running)
- Or: "status: disconnected" (normal if TradingView not running)

Either is fine - it proves the tool works!

---

### Test 3: Individual Tool Testing

In Claude Code, test each tool:

```
Use chart_get_state
Use quote_get
Use data_get_ohlcv with summary=true
Use alert_list
Use pine_get_source
```

All should return JSON data!

---

## Success Criteria

✅ Server starts without errors  
✅ tv_health_check works  
✅ All 16 tools are callable  
✅ Tools return JSON responses  
✅ No crashes or exceptions  
✅ Logs are clean

---

## Next: Phase 2 Testing

Once all tools are tested with sample data, Phase 2 will:

1. Connect to real TradingView via CDP
2. Extract real chart data
3. Make real Pine Script calls
4. Return actual values instead of samples

Then we'll test again with real TradingView running!

---

## Troubleshooting Tests

### Server won't start

- Check Node.js version: `node --version` (need 18+)
- Check dependencies: `npm install`
- Check file permissions

### Tools return errors

- Check log file: `tail -f tradingview-mcp.log`
- Verify tool names match exactly
- Check argument types

### No response in Claude Code

- Verify MCP config is correct
- Restart Claude Code
- Check server is still running

---

## Which Testing Method to Use?

| Method              | Best For         | Setup Time |
| ------------------- | ---------------- | ---------- |
| **Claude Code**     | Full integration | 5 min      |
| **Terminal Script** | Quick checks     | 2 min      |
| **Test Script**     | Automation       | 10 min     |

**Recommendation**: Start with **Claude Code** + `tv_health_check`!

---

**Ready to test?** Pick an option above and let me know how it goes! 🚀
