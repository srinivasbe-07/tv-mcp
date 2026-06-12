# launch-tv.ps1 -- Launch TradingView Desktop with CDP enabled on port 9222
# Auto-discovers the install path (works after app updates).
# Usage:  .\launch-tv.ps1
#         .\launch-tv.ps1 -Port 9223   (alternate port)

param(
    [int]$Port = 9222,
    [int]$TimeoutSec = 300
)

Write-Host "launch-tv.ps1: checking CDP on port $Port ..."

# If CDP is already responding, nothing to do
try {
    $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
        -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    Write-Host "TradingView CDP already running on port $Port" -ForegroundColor Green
    exit 0
} catch {}

# Discover TradingView executable
$tvPath = $null

# Option A: Non-MSIX .exe installer -- preferred (accepts CDP flags)
$candidate = "$env:LOCALAPPDATA\TradingView\TradingView.exe"
Write-Host "Checking installer path: $candidate"
if (Test-Path $candidate) { $tvPath = $candidate }

# Option B: MSIX / Microsoft Store install -- fallback (cold start takes ~90s for CDP to bind)
if (-not $tvPath) {
    Write-Host "Not found via installer -- searching MSIX packages (may take a moment)..."
    $pkg = Get-AppxPackage -Name *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg) {
        $candidate = Join-Path $pkg.InstallLocation "TradingView.exe"
        if (Test-Path $candidate) { $tvPath = $candidate }
    }
}

if (-not $tvPath) {
    Write-Host "ERROR: TradingView not found. Install from https://www.tradingview.com/desktop/" -ForegroundColor Red
    exit 1
}

Write-Host "Found TradingView: $tvPath" -ForegroundColor DarkGray

# Kill any existing instance (it was not launched with CDP)
$running = Get-Process -Name TradingView -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Closing existing TradingView instance (no CDP)..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Launch with CDP
Write-Host "Launching TradingView with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
Start-Process -FilePath $tvPath -ArgumentList "--remote-debugging-port=$Port"

# Poll until CDP responds (cold start can take 90+ seconds)
Write-Host "Waiting for CDP on port $Port (cold start can take up to ${TimeoutSec}s) ..." -ForegroundColor Cyan
$elapsed = 0
$ready = $false

while ($elapsed -lt $TimeoutSec) {
    Start-Sleep -Seconds 1
    $elapsed++
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $ready = $true
        break
    } catch {}
    if ($elapsed % 10 -eq 0) {
        Write-Host "  still waiting... ($elapsed/$TimeoutSec s)" -ForegroundColor DarkGray
    }
}

if ($ready) {
    Write-Host "TradingView CDP is ready on port $Port" -ForegroundColor Green
    exit 0
} else {
    Write-Host "TIMEOUT: CDP did not respond after ${TimeoutSec}s." -ForegroundColor Red
    exit 1
}
