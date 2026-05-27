# start.ps1 -- Launch TradingView with CDP, then start the monitor
# Usage:  .\start.ps1
#         .\start.ps1 --itm 1      (pass extra args to monitor.js)

param(
    [int]$Port = 9222,
    [int]$TimeoutSec = 120,
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$MonitorArgs
)

# -- Step 1: Check if TradingView + CDP already running
try {
    $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
        -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    Write-Host "TradingView CDP already running on port $Port" -ForegroundColor Green
} catch {

    # -- Step 2: Find TradingView executable
    $tvPath = $null

    $candidate = "$env:LOCALAPPDATA\TradingView\TradingView.exe"
    if (Test-Path $candidate) { $tvPath = $candidate }

    if (-not $tvPath) {
        $pkg = Get-AppxPackage -Name *TradingView* -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pkg) {
            $candidate = Join-Path $pkg.InstallLocation "TradingView.exe"
            if (Test-Path $candidate) { $tvPath = $candidate }
        }
    }

    if (-not $tvPath) {
        Write-Host "ERROR: TradingView not found." -ForegroundColor Red
        Write-Host "Install from https://www.tradingview.com/desktop/" -ForegroundColor Yellow
        exit 1
    }

    # Kill existing instance if it has no CDP
    $running = Get-Process -Name TradingView -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "Closing existing TradingView instance (no CDP)..." -ForegroundColor Yellow
        $running | Stop-Process -Force
        Start-Sleep -Seconds 2
    }

    Write-Host "Launching TradingView with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
    Start-Process -FilePath $tvPath -ArgumentList "--remote-debugging-port=$Port"

    # -- Step 3: Wait for CDP
    Write-Host "Waiting for CDP on port $Port (cold start can take up to ${TimeoutSec}s) ..." -ForegroundColor Cyan
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
        if ($elapsed % 10 -eq 0) {
            Write-Host "  still waiting... ($elapsed/$TimeoutSec s)" -ForegroundColor DarkGray
        }
    }

    if (-not $ready) {
        Write-Host ""
        Write-Host "Still waiting for CDP (TradingView is slow to start) ..." -ForegroundColor Yellow
        while (-not $ready) {
            Start-Sleep -Seconds 5
            try {
                $null = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" `
                    -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                $ready = $true
            } catch {
                Write-Host "  still waiting..." -ForegroundColor DarkGray
            }
        }
    }

    Write-Host "TradingView CDP is ready on port $Port" -ForegroundColor Green
}

# -- Step 4: Start the monitor (auto-restarts on crash, stops cleanly on [q])
Write-Host ""
Write-Host "Starting monitor... (press [q] to quit)" -ForegroundColor Cyan
while ($true) {
    node monitors/monitor.js @MonitorArgs
    $code = $LASTEXITCODE
    if ($code -eq 0) { break }
    Write-Host ""
    Write-Host "Monitor stopped (code $code) — restarting in 5s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}