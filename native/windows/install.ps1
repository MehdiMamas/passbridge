# Registers the iCloud password helper for Chromium browsers on Windows, plus the
# PassBridge policy host. Run once from this folder:
#   powershell -ExecutionPolicy Bypass -File ./native/windows/install.ps1
$ErrorActionPreference = "Stop"

$ExtId = "pejdijmoenmkgeppbflobdenhhabjlaj"
$AppleHost = "com.apple.passwordmanager"
$Alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\iCloudPasswordsExtensionHelper.exe"
$Dest = Join-Path $env:LOCALAPPDATA "PassBridge"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Test-BadManifest([string]$ManifestPath) {
  if (-not $ManifestPath) { return $true }
  if (-not (Test-Path -LiteralPath $ManifestPath)) { return $true }
  if ($ManifestPath -match '\\Program Files\\WindowsApps\\') { return $true }
  try {
    $json = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  } catch {
    return $true
  }
  $exe = [string]$json.path
  if (-not $exe) { return $true }
  if ($exe -match '\\Program Files\\WindowsApps\\') { return $true }
  return $false
}

function Read-Default([string]$KeyPath) {
  if (-not (Test-Path -LiteralPath $KeyPath)) { return $null }
  return (Get-Item -LiteralPath $KeyPath).GetValue("")
}

function Set-Default([string]$KeyPath, [string]$Value) {
  New-Item -Path $KeyPath -Force | Out-Null
  Set-Item -LiteralPath $KeyPath -Value $Value
}

$candidates = @(
  "HKLM:\Software\Google\Chrome\NativeMessagingHosts\$AppleHost",
  "HKLM:\Software\WOW6432Node\Google\Chrome\NativeMessagingHosts\$AppleHost",
  "HKLM:\Software\Microsoft\Edge\NativeMessagingHosts\$AppleHost",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$AppleHost",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$AppleHost"
)

$existing = $null
foreach ($key in $candidates) {
  $path = Read-Default $key
  if ($path) { $existing = $path; break }
}

$appleManifest = Join-Path $Dest "com.apple.passwordmanager.json"
if (Test-BadManifest $existing) {
  if (-not (Test-Path -LiteralPath $Alias)) {
    throw "iCloudPasswordsExtensionHelper.exe was not found. Install iCloud for Windows from the Microsoft Store and turn on Passwords."
  }
  $body = @{
    name = $AppleHost
    description = "Apple iCloud password manager host via the WindowsApps alias"
    path = $Alias
    type = "stdio"
    allowed_origins = @(
      "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/",
      "chrome-extension://mfbcdcnpokpoajjciilocoachedjkima/"
    )
  } | ConvertTo-Json -Depth 4
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  [System.IO.File]::WriteAllText($appleManifest, $body + "`n", $Utf8)
  $register = $appleManifest
  Write-Output "wrote $appleManifest -> $Alias"
} else {
  $register = $existing
  Write-Output "keeping existing helper manifest: $existing"
}

$browsers = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Vivaldi\NativeMessagingHosts"
)

foreach ($root in $browsers) {
  Set-Default (Join-Path $root $AppleHost) $register
  Write-Output "registered ${AppleHost} for $root"
}

# the WindowsApps python.exe is the Microsoft Store installer stub, not Python
$py = $null
foreach ($name in @("py", "python")) {
  foreach ($cmd in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) {
    if ($cmd.Source -like "*\WindowsApps\*") { continue }
    & $cmd.Source -c "import winreg" 2>$null
    if ($LASTEXITCODE -eq 0) { $py = $cmd.Source; break }
  }
  if ($py) { break }
}
if (-not $py) {
  Write-Output ""
  Write-Output "Python was not found, so the update, policy and agent sign-in helpers were NOT installed."
  Write-Output "Without them every update asks for the PassBridge folder and Chrome asks to save each file."
  Write-Output "Install Python from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this script again."
  Write-Output "Password fill does not need Python."
  exit 0
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force (Join-Path $Here "passbridge-policy.py") (Join-Path $Dest "passbridge-policy.py")
# the release zip has the updater beside this script; a repo checkout keeps it one folder up
$updaterSrc = Join-Path $Here "passbridge-updater.py"
if (-not (Test-Path -LiteralPath $updaterSrc)) { $updaterSrc = Join-Path (Split-Path -Parent $Here) "passbridge-updater.py" }
Copy-Item -Force $updaterSrc (Join-Path $Dest "passbridge-updater.py")
# agent sign-in: the relay host and its command-line client; the release zip has them beside this script
foreach ($agentFile in @("passbridge-agent.py", "passbridge-agent-cli.py")) {
  $agentSrc = Join-Path $Here $agentFile
  if (-not (Test-Path -LiteralPath $agentSrc)) { $agentSrc = Join-Path (Split-Path -Parent $Here) $agentFile }
  Copy-Item -Force $agentSrc (Join-Path $Dest $agentFile)
}
# the release zip says which version this is, so the extension knows when the helper is behind
$versionSrc = Join-Path $Here "VERSION"
if (Test-Path -LiteralPath $versionSrc) { Copy-Item -Force $versionSrc (Join-Path $Dest "helper-version") }

# hosts earlier versions installed: the pairing-code reader and the verification-code setup helper
$retired = @("com.passbridge.autopair", "com.passbridge.totpsetup", "com.openpasswords.policy", "com.openpasswords.autopair")
$retiredFiles = @(
  "passbridge-autopair.py", "passbridge-autopair.cmd", "com.passbridge.autopair.json",
  "passbridge-totpsetup.py", "passbridge-totpsetup.ps1", "passbridge-totpsetup.cmd", "com.passbridge.totpsetup.json",
  "password-manager.reg"
)
foreach ($file in $retiredFiles) {
  $old = Join-Path $Dest $file
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
}

function Write-HostCmd([string]$ScriptName, [string]$CmdName) {
  $cmdPath = Join-Path $Dest $CmdName
  $scriptPath = Join-Path $Dest $ScriptName
  $lines = @(
    "@echo off",
    "`"$py`" -u `"$scriptPath`" %*"
  )
  [System.IO.File]::WriteAllText($cmdPath, ($lines -join "`r`n") + "`r`n", $Utf8)
  return $cmdPath
}

$policyCmd = Write-HostCmd "passbridge-policy.py" "passbridge-policy.cmd"

function Write-NmManifest([string]$Name, [string]$Description, [string]$ExePath) {
  $file = Join-Path $Dest "$Name.json"
  $body = @{
    name = $Name
    description = $Description
    path = $ExePath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtId/")
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($file, $body + "`n", $Utf8)
  return $file
}

$policyManifest = Write-NmManifest "com.passbridge.policy" "PassBridge policy helper" $policyCmd
$updaterCmd = Write-HostCmd "passbridge-updater.py" "passbridge-updater.cmd"
$updaterManifest = Write-NmManifest "com.passbridge.updater" "PassBridge updater" $updaterCmd
$agentCmd = Write-HostCmd "passbridge-agent.py" "passbridge-agent.cmd"
$agentManifest = Write-NmManifest "com.passbridge.agent" "PassBridge agent sign-in" $agentCmd

foreach ($root in $browsers) {
  Set-Default (Join-Path $root "com.passbridge.policy") $policyManifest
  Set-Default (Join-Path $root "com.passbridge.updater") $updaterManifest
  Set-Default (Join-Path $root "com.passbridge.agent") $agentManifest
  foreach ($old in $retired) {
    $oldKey = Join-Path $root $old
    if (Test-Path -LiteralPath $oldKey) { Remove-Item -LiteralPath $oldKey -Force }
  }
}

Write-Output ""
Write-Output "Helpers installed to $Dest"
Write-Output "Updates now install by themselves: no folder picker and no Save prompts."
Write-Output "Fully quit the browser (check the tray) and reopen it once so it finds the helpers."
