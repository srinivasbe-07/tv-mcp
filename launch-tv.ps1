# launch-tv.ps1 -- Launch TradingView Desktop with CDP enabled on port 9222
# Auto-discovers the install path (works after app updates).
# Usage:  .\launch-tv.ps1
#         .\launch-tv.ps1 -Port 9223   (alternate port)

param(
    [int]$Port = 9222,
    [int]$TimeoutSec = 300
)

Write-Output "launch-tv.ps1: checking CDP on port $Port ..."

# If CDP is already responding, nothing to do
try {
    $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
        -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    Write-Output "TradingView CDP already running on port $Port"
    exit 0
} catch {}

# Discover TradingView executable
$tvPath = $null

# Option A: Non-MSIX .exe installer -- preferred (accepts CDP flags)
$candidate = "$env:LOCALAPPDATA\TradingView\TradingView.exe"
Write-Output "Checking installer path: $candidate"
if (Test-Path $candidate) { $tvPath = $candidate }

# Option B: MSIX / Microsoft Store install -- fallback (cold start takes ~90s for CDP to bind)
if (-not $tvPath) {
    Write-Output "Not found via installer — searching MSIX packages (may take a moment)..."
    $pkg = Get-AppxPackage -Name *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg) {
        $candidate = Join-Path $pkg.InstallLocation "TradingView.exe"
        if (Test-Path $candidate) { $tvPath = $candidate }
    }
}

if (-not $tvPath) {
    Write-Output "ERROR: TradingView not found. Install from https://www.tradingview.com/desktop/"
    exit 1
}

Write-Output "Found TradingView: $tvPath"

# Kill any existing instance (it was not launched with CDP)
$running = Get-Process -Name TradingView -ErrorAction SilentlyContinue
if ($running) {
    Write-Output "Closing existing TradingView instance (no CDP)..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Launch with CDP
Write-Output "Launching TradingView with --remote-debugging-port=$Port ..."
Start-Process -FilePath $tvPath -ArgumentList "--remote-debugging-port=$Port"

# Poll until CDP responds (cold start can take 90+ seconds)
Write-Output "Waiting for CDP on port $Port (cold start can take up to ${TimeoutSec}s) ..."
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
        Write-Output "  still waiting... ($elapsed/$TimeoutSec s)"
    }
}

if ($ready) {
    Write-Output "TradingView CDP is ready on port $Port"
    exit 0
} else {
    Write-Output "TIMEOUT: CDP did not respond after ${TimeoutSec}s."
    exit 1
}
