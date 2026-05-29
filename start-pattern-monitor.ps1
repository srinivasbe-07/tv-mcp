# start-pattern-monitor.ps1 -- Launch TradingView + Trade Setup Monitor
# Usage:  .\start-pattern-monitor.ps1
#         .\start-pattern-monitor.ps1 -SkipTV    (TradingView already running)

param(
    [switch]$SkipTV,
    [int]$Port = 9222
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ── Step 1: Launch TradingView ───────────────────────────────────────────────
if (-not $SkipTV) {
    Write-Host ""
    Write-Host "=== Step 1: Launching TradingView ===" -ForegroundColor Cyan
    & "$root\launch-tv.ps1" -Port $Port
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TradingView still loading - monitor will retry CDP connection automatically." -ForegroundColor Yellow
    }
    Write-Host ""
} else {
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
            -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        Write-Host "CDP confirmed on port $Port." -ForegroundColor Green
    } catch {
        Write-Host "WARNING: CDP not responding on port $Port - monitor will retry automatically." -ForegroundColor Yellow
    }
    Write-Host ""
}

# ── Step 2: Start trade monitor (auto-restarts on crash) ────────────────────
Write-Host "=== Step 2: Starting Trade Monitor ===" -ForegroundColor Cyan
Write-Host "Config : config/pattern-monitor-config.json  (edit live - reloaded every tick)" -ForegroundColor DarkGray
Write-Host "Log    : logs/pattern-monitor.log" -ForegroundColor DarkGray
Write-Host "Keys   : [a] toggle active  [f] flip bias  [q] quit" -ForegroundColor DarkGray
Write-Host ""

while ($true) {
    node monitors/pattern-monitor.js
    $code = $LASTEXITCODE
    if ($code -eq 0) { break }
    Write-Host ""
    Write-Host "Monitor stopped (exit code $code) - restarting in 5s... (press Ctrl+C to abort)" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
