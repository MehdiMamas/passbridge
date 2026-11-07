# Prints the 6-digit code iCloud for Windows shows while pairing, for when its window can't be seen
# (it is excluded from screen capture, so remote desktop shows a black box).
# Reads the window's UI Automation text. Writes nothing to disk; exits 1 when no code window is up.
# Its output is the code: never run it where stdout is logged.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$helpers = @(Get-Process -Name iCloudPasswordsExtensionHelper -ErrorAction SilentlyContinue | ForEach-Object Id)
if (-not $helpers) { exit 1 }
foreach ($w in $A::RootElement.FindAll($T::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($helpers -notcontains $w.Current.ProcessId) { continue }
  foreach ($e in $w.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    $n = $e.Current.Name
    if ($n -and $n -match '^\s*(\d{3})\s?(\d{3})\s*$') {
      [Console]::Out.Write($Matches[1] + $Matches[2])
      exit 0
    }
  }
}
exit 1
