# keep-awake.ps1 - stop the laptop sleeping/locking ONLY while this runs.
#
# Standalone - has nothing to do with the UI server or monitors.
# Run it when you actually trade; close it (or let it auto-stop) the rest of the day.
#
#   .\keep-awake.ps1            -> keep awake until you press Ctrl+C or close the window
#   .\keep-awake.ps1 -Market    -> keep awake now, then auto-stop at 15:30 (market close)
#
# When it stops, normal Windows power settings resume - so leave "Sleep" set to
# your usual value (e.g. 10 min) and DON'T use the global "never sleep" change.

param([switch]$Market)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)
$KEEP_AWAKE = [uint32]'0x80000003'
$RESUME     = [uint32]'0x80000000'   # ES_CONTINUOUS alone -> clear the request

[Awake]::SetThreadExecutionState($KEEP_AWAKE) | Out-Null
Write-Host "[keep-awake] ON  - laptop will NOT sleep or lock." -ForegroundColor Green

try {
  if ($Market) {
    $stop = (Get-Date).Date.AddHours(15).AddMinutes(30)   # 15:30 today (local clock)
    if ((Get-Date) -ge $stop) { Write-Host "Already past 15:30 - exiting."; return }
    Write-Host ("[keep-awake] Will auto-stop at {0:HH:mm}." -f $stop) -ForegroundColor Cyan
    while ((Get-Date) -lt $stop) { Start-Sleep -Seconds 30 }
  } else {
    Write-Host "[keep-awake] Press Ctrl+C (or close this window) to stop." -ForegroundColor Cyan
    while ($true) { Start-Sleep -Seconds 30 }
  }
}
finally {
  [Awake]::SetThreadExecutionState($RESUME) | Out-Null
  Write-Host "`n[keep-awake] OFF - normal sleep/lock restored." -ForegroundColor Yellow
}
