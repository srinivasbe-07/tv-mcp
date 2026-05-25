# setup.ps1 -- First-time setup for tv-mcp
# Checks Node.js, installs npm deps, verifies TradingView, prints MCP config.
# Usage:  .\setup.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pass = $true

Write-Host ""
Write-Host "=== tv-mcp Setup ===" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js
Write-Host "Checking Node.js..." -ForegroundColor DarkGray
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "  FAIL: Node.js not found." -ForegroundColor Red
    Write-Host "        Install from https://nodejs.org (v18 or newer)" -ForegroundColor Yellow
    $pass = $false
} else {
    $major = [int]($nodeVersion -replace 'v(\d+)\..*','$1')
    if ($major -lt 18) {
        Write-Host "  WARN: Node.js $nodeVersion found -- v18+ recommended." -ForegroundColor Yellow
    } else {
        Write-Host "  OK: Node.js $nodeVersion" -ForegroundColor Green
    }
}

# 2. npm install
Write-Host "Installing npm dependencies..." -ForegroundColor DarkGray
Set-Location $root
npm install --silent
if ($LASTEXITCODE -eq 0) {
    Write-Host "  OK: dependencies installed" -ForegroundColor Green
} else {
    Write-Host "  FAIL: npm install failed" -ForegroundColor Red
    $pass = $false
}

# 3. TradingView
Write-Host "Checking TradingView Desktop..." -ForegroundColor DarkGray
$tvPath = $null
$pkg = Get-AppxPackage -Name *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation "TradingView.exe"
    if (Test-Path $candidate) { $tvPath = $candidate }
}
if (-not $tvPath) {
    $candidate = "$env:LOCALAPPDATA\TradingView\TradingView.exe"
    if (Test-Path $candidate) { $tvPath = $candidate }
}
if ($tvPath) {
    Write-Host "  OK: $tvPath" -ForegroundColor Green
} else {
    Write-Host "  WARN: TradingView not found." -ForegroundColor Yellow
    Write-Host "        Install from https://www.tradingview.com/desktop/" -ForegroundColor Yellow
}

# 4. CDP connectivity
Write-Host "Checking CDP on port 9222..." -ForegroundColor DarkGray
try {
    $null = Invoke-WebRequest -Uri "http://localhost:9222/json/version" `
        -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    Write-Host "  OK: TradingView CDP is responding" -ForegroundColor Green
} catch {
    Write-Host "  INFO: TradingView not running (start it before using the MCP server)" -ForegroundColor DarkGray
}

# 5. Print MCP config
$serverPath = "$root\src\server.js" -replace '\\','/'

Write-Host ""
Write-Host "=== MCP Server Config ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Add this to your Claude config (see mcp.config.example.json for details):" -ForegroundColor White
Write-Host ""
Write-Host '  "tradingview": {' -ForegroundColor DarkYellow
Write-Host '    "command": "node",' -ForegroundColor DarkYellow
Write-Host "    `"args`": [`"$serverPath`"]" -ForegroundColor DarkYellow
Write-Host '  }' -ForegroundColor DarkYellow
Write-Host ""

# Summary
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($pass) {
    Write-Host "Setup complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Start everything:  .\start.ps1" -ForegroundColor White
    Write-Host "  Run demo:          node demo-tools.js" -ForegroundColor White
} else {
    Write-Host "Setup incomplete -- fix the errors above and re-run setup.ps1" -ForegroundColor Red
}
Write-Host ""
