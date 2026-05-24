# How to Run Tests - Quick Guide

**Purpose**: Run automated test suite for all 16 tools  
**Time**: 5 minutes total  
**Requirements**: Node.js, TradingView (optional for full testing)

---

## Method 1: Automated Test Suite (Recommended)

### Step 1: Open Terminal

```bash
cd C:\study\MCP\tv-mcp
```

### Step 2: Run Tests

```bash
node test-all-tools.js
```

### Step 3: Watch Output

**Console Output**:
```
============================================================
TradingView MCP - Automated Test Suite
============================================================
Total test cases: 16

Running tests...
------------------------------------------------------------
Testing: chart_get_state - Get current chart symbol and timeframe
  ✅ PASSED (125ms)
  Details: All validations passed

Testing: quote_get - Get current price quote
  ✅ PASSED (98ms)
  Details: All validations passed

[... 14 more tests ...]

------------------------------------------------------------
TEST SUMMARY
------------------------------------------------------------
Total Tests: 16
Passed: 16 (100.0%)
Failed: 0 (0.0%)
Errors: 0 (0.0%)

By Category:
  Chart: 5/5 passed (100.0%)
  Pine: 5/5 passed (100.0%)
  Alert: 3/3 passed (100.0%)
  Utility: 3/3 passed (100.0%)

============================================================
✅ ALL TESTS PASSED!
============================================================

Results saved to: C:\study\MCP\tv-mcp\test-results.json
```

### Step 4: Check Results File

```bash
# View JSON results
type test-results.json

# View log file
type test-results.log
```

---

## Method 2: Manual Testing in Claude Code

### Step 1: Setup (5 min)
- Launch TradingView with CDP
- Start server: `npm start`
- Restart Claude Code

### Step 2: Test Each Tool

**Test Chart Tools**:
```
Use chart_get_state
Use quote_get
Use data_get_ohlcv with summary=true
Use chart_set_symbol with symbol="GOOGL"
Use chart_set_timeframe with timeframe="5"
```

**Test Pine Tools**:
```
Use pine_get_source
Use pine_set_source with source="//@version=5\nindicator('Test')\nplot(close)"
Use pine_smart_compile
Use pine_get_errors
Use pine_save with name="TestStrategy"
```

**Test Alert Tools**:
```
Use alert_list
Use alert_create with symbol="AAPL", condition="above", level=150
Use alert_delete with alertId="alert_1"
```

**Test Utility Tools**:
```
Use tv_health_check
Use tv_launch
Use capture_screenshot with region="chart"
```

### Step 3: Document Results

For each tool, record:
- ✅ PASS - Tool works
- ⚠️ FALLBACK - Uses fallback strategy
- ❌ FAIL - Tool failed
- ⚠️ ERROR - Tool crashed

---

## Understanding Test Results

### Result Codes

| Code | Meaning | Action |
|------|---------|--------|
| ✅ PASS | Tool works correctly | Move to next tool |
| ⚠️ FALLBACK | Using fallback strategy | Document which strategy |
| ❌ FAIL | Tool didn't work | Note the error |
| ⚠️ ERROR | Tool crashed | Check logs |

### Sample Results

#### Perfect Result ✅
```json
{
  "name": "chart_get_state",
  "status": "passed",
  "duration": 125,
  "details": {
    "validation": "All validations passed",
    "response": "{\"symbol\":\"AAPL\",\"timeframe\":\"D\"}"
  }
}
```

#### Fallback Result ⚠️
```json
{
  "name": "chart_get_state",
  "status": "passed",
  "duration": 234,
  "details": {
    "validation": "All validations passed",
    "response": "{\"symbol\":\"AAPL\",\"via\":\"dom_parsing\"}"
  }
}
```

#### Failure Result ❌
```json
{
  "name": "chart_get_state",
  "status": "failed",
  "duration": 45,
  "details": {
    "validation": "Missing expected field: symbol",
    "response": "{\"error\":\"Not found\"}"
  }
}
```

---

## Quick Test Checklist

### Before Testing
- [ ] TradingView running on port 9222
- [ ] Server running: `npm start`
- [ ] Claude Code restarted
- [ ] All 16 tools visible in tool list

### During Testing
- [ ] Record each tool result
- [ ] Note any errors
- [ ] Check response time
- [ ] Verify data accuracy

### After Testing
- [ ] Review test-results.json
- [ ] Document findings
- [ ] Identify any failures
- [ ] Plan next steps

---

## Test Result Interpretation

### All Passed (100%)
```
✅ Phase 2 Implementation Verified!
→ Move to Phase 4 (CLAUDE.md Decision Tree)
```

### Most Passed (80%+)
```
🟡 Phase 2 Implementation Mostly Good
→ Fix failures, then move to Phase 4
```

### Some Passed (60-80%)
```
⚠️ Phase 2 Implementation Needs Work
→ Debug failures, refine strategies
→ Re-test before Phase 4
```

### Few Passed (<60%)
```
❌ Phase 2 Implementation Issues
→ Major refactoring needed
→ Review code and fallback strategies
```

---

## Common Issues & Solutions

### Issue: "Test timeout"
**Solution**: 
1. Ensure server running: `npm start`
2. Check TradingView responsive
3. Restart everything

### Issue: "Tool not found"
**Solution**:
1. Verify tool name correct
2. Check server logs
3. Restart Claude Code

### Issue: "All tests fail"
**Solution**:
1. Check TradingView running
2. Check server running
3. Check CDP port 9222 listening

### Issue: "Some tests pass, some fail"
**Solution**:
1. Check TradingView stability
2. Look for pattern (e.g., all Pine tools fail)
3. Check specific tool implementation

---

## Advanced: Custom Test

Create custom test by editing `test-all-tools.js`:

```javascript
// Add new test case
{
  name: "custom_tool",
  description: "What this does",
  params: { /* params */ },
  expectedFields: ["field1", "field2"],
  category: "Custom",
}
```

Then run:
```bash
node test-all-tools.js
```

---

## Test Output Files

### test-results.log
Human-readable log of all tests:
```
[timestamp] Testing: chart_get_state - ...
[timestamp]   ✅ PASSED (125ms)
[timestamp]   Details: All validations passed
```

### test-results.json
Machine-readable results for analysis:
```json
{
  "summary": {
    "total": 16,
    "passed": 16,
    "failed": 0,
    "errors": 0
  },
  "tests": [ ... ]
}
```

---

## Test Timeline

### Expected Timing
- Automated suite: < 5 seconds total
- Manual testing: ~ 15 minutes (all 16 tools)
- Documentation: ~ 10 minutes

**Total: ~30 minutes for complete testing**

---

## Next Steps After Testing

### If All Pass ✅
1. ✅ Document results in `PHASE3_RESULTS.md`
2. ✅ Commit to git
3. ✅ Move to Phase 4

### If Some Fail ❌
1. 📝 Document failures in `PHASE3_FAILURES.md`
2. 🔧 Fix code in `src/tools/`
3. 🧪 Re-test
4. ✅ When fixed, proceed to Phase 4

### If Most Fail ⚠️
1. 📋 Create `PHASE3_REFACTOR.md`
2. 🔍 Analyze root causes
3. 🛠️ Major refactor of problematic tools
4. 🧪 Re-test everything
5. 📚 Document changes
6. ✅ Then proceed

---

## Final Checklist

```markdown
# Phase 3 Testing Checklist

## Preparation
- [ ] Read TEST_CASES.md
- [ ] Setup environment
- [ ] Run automated tests

## Testing
- [ ] All 16 tools tested
- [ ] Results documented
- [ ] Issues identified

## Results
- [ ] test-results.json created
- [ ] test-results.log created
- [ ] Findings documented

## Decision
- [ ] Decision made for next phase
- [ ] Issues logged if any
- [ ] Ready to proceed
```

---

## Summary

**Running Tests - 3 Options**:

1. **Automated** (Recommended)
   ```bash
   node test-all-tools.js
   ```

2. **Manual in Claude Code**
   ```
   Use [tool_name] [with params]
   ```

3. **Hybrid** (Best)
   - Run automated for quick overview
   - Run manual for detailed testing
   - Document both results

**Expected Time**: 5-30 minutes depending on method

**Success Metric**: All 16 tools return valid responses

**Next Action**: Review results and proceed to Phase 4 🚀

---

**Ready to test?** Run: `node test-all-tools.js`
