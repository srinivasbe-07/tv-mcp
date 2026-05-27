# start-trading.ps1 -- Launch TradingView + Intraday Alert Monitor
# Usage:  .\start-trading.ps1
#         .\start-trading.ps1 -SkipTV        (TV already running)
#         .\start-trading.ps1 -Itm 1         (force ITM-1 today)
#         .\start-trading.ps1 -Itm 0         (force ATM today)

param(
    [switch]$SkipTV,
    [int]$Port = 9222,
    [ValidateSet('', '0', '1', '2')]
    [string]$Itm = ''
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Step 1: Launch TradingView ───────────────────────────────────────────────
if (-not $SkipTV) {
    Write-Host ""
    Write-Host "=== Step 1: Launching TradingView ===" -ForegroundColor Cyan
    & "$root\launch-tv.ps1" -Port $Port
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TradingView launch failed. Aborting." -ForegroundColor Red
        Read-Host "Press Enter to close"
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

# ── Step 2: Start monitor ────────────────────────────────────────────────────
Write-Host "=== Step 2: Starting Intraday Alert Monitor ===" -ForegroundColor Cyan

if (-not (Test-Path "$root\node_modules")) {
    Write-Host "node_modules not found. Running npm install..." -ForegroundColor Yellow
    Set-Location $root
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed. Run setup.ps1 first." -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }
    Write-Host ""
}

Set-Location $root

$monitorArgs = @()
if ($Itm -ne '') { $monitorArgs = @('--itm', $Itm) }

Write-Host "Keys: [c] toggle CE  [p] toggle PE  [u] force update  [q] quit" -ForegroundColor DarkGray
Write-Host ""

node monitors/monitor.js @monitorArgs
