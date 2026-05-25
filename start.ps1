# start.ps1 -- One command: launch TradingView + start the MCP server
# Usage:  .\start.ps1               (launches TV then MCP server)
#         .\start.ps1 -SkipTV       (MCP server only, TV already running)
#         .\start.ps1 -Port 9223    (alternate CDP port)

param(
    [switch]$SkipTV,
    [int]$Port = 9222
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Step 1: Launch TradingView
if (-not $SkipTV) {
    Write-Host "=== Step 1: Launching TradingView ===" -ForegroundColor Cyan
    & "$root\launch-tv.ps1" -Port $Port
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TradingView launch failed. Aborting." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
} else {
    Write-Host "Skipping TradingView launch (-SkipTV)." -ForegroundColor DarkGray
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
            -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        Write-Host "CDP confirmed on port $Port." -ForegroundColor Green
    } catch {
        Write-Host "WARNING: CDP not responding on port $Port." -ForegroundColor Yellow
        Write-Host "Start TradingView with:  .\launch-tv.ps1" -ForegroundColor Yellow
    }
    Write-Host ""
}

# Step 2: Start MCP server
Write-Host "=== Step 2: Starting tv-mcp MCP server ===" -ForegroundColor Cyan

if (-not (Test-Path "$root\node_modules")) {
    Write-Host "node_modules not found. Running npm install..." -ForegroundColor Yellow
    Set-Location $root
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed. Run setup.ps1 first." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
}

Write-Host "Server starting (Ctrl+C to stop)..." -ForegroundColor Green
Set-Location $root
node src/server.js
