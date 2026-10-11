# Removes the HKCU native-messaging registrations and helper files this install added.
# Does not touch HKLM keys written by iCloud for Windows.
$ErrorActionPreference = "Stop"

$Dest = Join-Path $env:LOCALAPPDATA "PassBridge"
$AppleManifest = Join-Path $Dest "com.apple.passwordmanager.json"
$browsers = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Vivaldi\NativeMessagingHosts"
)

function Read-Default([string]$KeyPath) {
  if (-not (Test-Path -LiteralPath $KeyPath)) { return $null }
  return (Get-Item -LiteralPath $KeyPath).GetValue("")
}

foreach ($root in $browsers) {
  $appleKey = Join-Path $root "com.apple.passwordmanager"
  $current = Read-Default $appleKey
  if ($current -and $current -eq $AppleManifest) {
    Remove-Item -LiteralPath $appleKey -Force
    Write-Output "removed $appleKey"
  }
  foreach ($name in @("com.passbridge.policy", "com.passbridge.autopair", "com.passbridge.totpsetup", "com.openpasswords.policy", "com.openpasswords.autopair")) {
    $key = Join-Path $root $name
    if (Test-Path -LiteralPath $key) {
      Remove-Item -LiteralPath $key -Force
      Write-Output "removed $key"
    }
  }
}

$policies = @(
  "HKCU:\Software\Policies\Google\Chrome",
  "HKCU:\Software\Policies\Microsoft\Edge",
  "HKCU:\Software\Policies\BraveSoftware\Brave",
  "HKCU:\Software\Policies\Chromium",
  "HKCU:\Software\Policies\Vivaldi"
)
function Read-Policy([string]$Key) {
  if (-not (Test-Path -LiteralPath $Key)) { return $null }
  return (Get-Item -LiteralPath $Key).GetValue("PasswordManagerEnabled", $null)
}

$locked = @()
foreach ($key in $policies) {
  $value = Read-Policy $key
  if ($null -eq $value -or [int]$value -ne 0) { continue }
  Remove-ItemProperty -LiteralPath $key -Name "PasswordManagerEnabled" -ErrorAction SilentlyContinue
  if ($null -eq (Read-Policy $key)) { Write-Output "cleared PasswordManagerEnabled on $key" }
  else { $locked += $key }
}

# the policy helper falls back to an elevated reg import when HKCU\Software\Policies is locked, so undo it the same way.
# the import runs as whichever admin approves UAC, so it names this user's hive by SID instead of HKEY_CURRENT_USER.
if ($locked.Count -gt 0) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $lines = @("Windows Registry Editor Version 5.00", "")
  foreach ($key in $locked) {
    $lines += "[" + ($key -replace "^HKCU:\\", "HKEY_USERS\$sid\") + "]"
    $lines += '"PasswordManagerEnabled"=-'
    $lines += ""
  }
  $regFile = Join-Path $env:TEMP ("passbridge-clear-" + [guid]::NewGuid().ToString("N") + ".reg")
  Set-Content -LiteralPath $regFile -Value ($lines -join "`r`n") -Encoding Unicode
  try {
    $proc = Start-Process -FilePath reg.exe -ArgumentList @("import", $regFile) -Verb RunAs -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "reg import exited with $($proc.ExitCode)" }
  } catch {
    Write-Output "couldn't clear the policy: $_"
  } finally {
    Remove-Item -LiteralPath $regFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($key in $locked) {
    if ($null -eq (Read-Policy $key)) { Write-Output "cleared PasswordManagerEnabled on $key" }
    else { Write-Output "PasswordManagerEnabled is still set on $key. An administrator can delete it in regedit under HKEY_USERS\$sid." }
  }
}

foreach ($dir in @($Dest, (Join-Path $env:LOCALAPPDATA "OpenPasswords"))) {
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-Output "removed $dir"
  }
}

Write-Output "Fully quit and reopen the browser."
