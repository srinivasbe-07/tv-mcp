@echo off
REM ===========================================================================
REM Launch TradingView Desktop (MSIX install) with Chrome DevTools Protocol
REM enabled on port 9222 for our MCP server.
REM
REM IMPORTANT:
REM   1. Close any running TradingView window first (otherwise the new instance
REM      will just refocus the existing one and the debug flag is ignored).
REM   2. MSIX/UWP apps run in an App Container sandbox that MAY strip
REM      command-line arguments. If port 9222 is not reachable after launch,
REM      see TROUBLESHOOTING at the bottom of this file.
REM ===========================================================================

setlocal

REM Exact path discovered for this machine (MSIX install)
set TV_PATH=C:\Program Files\WindowsApps\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\TradingView.exe

if not exist "%TV_PATH%" (
    echo.
    echo TradingView executable not found at:
    echo   %TV_PATH%
    echo.
    echo The MSIX package may have been updated. Run this to find the new path:
    echo   powershell -c "Get-AppxPackage -Name *radingView* ^| Select-Object InstallLocation"
    echo.
    pause
    exit /b 1
)

echo.
echo Closing any existing TradingView windows...
taskkill /IM TradingView.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul

echo Launching TradingView with debug port 9222...
echo   "%TV_PATH%" --remote-debugging-port=9222
echo.

start "" "%TV_PATH%" --remote-debugging-port=9222

echo Waiting 5 seconds for app to start...
timeout /t 5 /nobreak >nul

echo.
echo Testing CDP port 9222...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -TimeoutSec 3 -UseBasicParsing; Write-Host 'SUCCESS - CDP is responding:'; Write-Host $r.Content } catch { Write-Host 'FAILED - port 9222 is not responding.'; Write-Host 'This usually means the MSIX sandbox stripped the debug flag.'; Write-Host 'See TROUBLESHOOTING below.' }"

echo.
echo ===========================================================================
echo TROUBLESHOOTING (if port 9222 not responding):
echo ===========================================================================
echo Option 1: Download the non-MSIX installer (.exe) from
echo           https://www.tradingview.com/desktop/
echo           Uninstall the MSIX version first, then install the .exe version.
echo           Regular .exe installs accept the debug flag without restrictions.
echo.
echo Option 2: Pivot to TradingView Web in Chrome with --remote-debugging-port.
echo           Ask Claude to switch to "Path 2" approach.
echo ===========================================================================
echo.
pause
