# launch-tv.ps1 -- Launch TradingView Desktop with CDP enabled on port 9222
# Auto-discovers the install path (works after app updates).
# Usage:  .\launch-tv.ps1
#         .\launch-tv.ps1 -Port 9223   (alternate port)

param(
    [int]$Port = 9222,
    [int]$TimeoutSec = 30
)

# Discover TradingView executable
$tvPath = $null

# Option A: MSIX / Microsoft Store install (most common on Windows)
$pkg = Get-AppxPackage -Name *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation "TradingView.exe"
    if (Test-Path $candidate) { $tvPath = $candidate }
}

# Option B: Non-MSIX .exe installer (fallback)
if (-not $tvPath) {
    $candidate = "$env:LOCALAPPDATA\TradingView\TradingView.exe"
    if (Test-Path $candidate) { $tvPath = $candidate }
}

if (-not $tvPath) {
    Write-Host "ERROR: TradingView not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install TradingView Desktop from https://www.tradingview.com/desktop/" -ForegroundColor Yellow
    Write-Host "Then re-run this script." -ForegroundColor Yellow
    exit 1
}

Write-Host "Found TradingView: $tvPath" -ForegroundColor DarkGray

# Kill any existing instance
$running = Get-Process -Name TradingView -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Closing existing TradingView instance..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Launch with CDP
Write-Host "Launching TradingView with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
Start-Process -FilePath $tvPath -ArgumentList "--remote-debugging-port=$Port"

# Poll until CDP responds
Write-Host "Waiting for CDP to be ready on port $Port ..." -ForegroundColor Cyan
$elapsed = 0
$ready = $false

while ($elapsed -lt $TimeoutSec) {
    Start-Sleep -Seconds 1
    $elapsed++
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
            -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        $ready = $true
        break
    } catch {}
    if ($elapsed % 5 -eq 0) {
        Write-Host "  still waiting... ($elapsed/$TimeoutSec s)" -ForegroundColor DarkGray
    }
}

if ($ready) {
    Write-Host ""
    Write-Host "TradingView CDP is ready on port $Port" -ForegroundColor Green
    Write-Host "You can now start the MCP server:  npm start" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "TIMEOUT: CDP did not respond after ${TimeoutSec}s." -ForegroundColor Red
    Write-Host ""
    Write-Host "Common cause: MSIX sandbox strips command-line arguments." -ForegroundColor Yellow
    Write-Host "Fix: download the non-MSIX .exe installer from https://www.tradingview.com/desktop/" -ForegroundColor Yellow
    Write-Host "     Uninstall the Store version first, then install the .exe version." -ForegroundColor Yellow
    exit 1
}
