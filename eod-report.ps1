# End-of-day report runner
# Fetches option prices from TradingView and saves to logs/daily-trades-YYYY-MM-DD.json
# Usage:  .\eod-report.ps1
#         .\eod-report.ps1 2026-06-07    <- specific date (bypasses market close check)

param([string]$Date = "")

Write-Host ""
Write-Host "=== EOD Report ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Fetching prices from TradingView..." -ForegroundColor Yellow

if ($Date -ne "") {
    node scripts/generate-daily-report.js $Date
} else {
    node scripts/generate-daily-report.js
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Failed — check TradingView is running with CDP on port 9222." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Done. Open http://localhost:3000/supertrend-reports to view." -ForegroundColor Green
