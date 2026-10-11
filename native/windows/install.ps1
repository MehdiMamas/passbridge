# Registers the iCloud password helper for Chromium browsers on Windows, plus the
# PassBridge policy and pairing-code hosts. Run once from this folder:
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
  if (-not [System.IO.Path]::IsPathRooted($exe) -and $ManifestPath -match '\\Program Files\\WindowsApps\\') {
    return $true
  }
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
  Write-Output "Python was not found, so the policy and pairing-code helpers were not registered."
  Write-Output "Install Python, then run this script again. Password fill does not need them."
  exit 0
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force (Join-Path $Here "passbridge-policy.py") (Join-Path $Dest "passbridge-policy.py")
Copy-Item -Force (Join-Path $Here "passbridge-autopair.py") (Join-Path $Dest "passbridge-autopair.py")
Copy-Item -Force (Join-Path $Here "passbridge-totpsetup.py") (Join-Path $Dest "passbridge-totpsetup.py")
Copy-Item -Force (Join-Path $Here "passbridge-totpsetup.ps1") (Join-Path $Dest "passbridge-totpsetup.ps1")

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
$pairCmd = Write-HostCmd "passbridge-autopair.py" "passbridge-autopair.cmd"
$totpCmd = Write-HostCmd "passbridge-totpsetup.py" "passbridge-totpsetup.cmd"

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
$pairManifest = Write-NmManifest "com.passbridge.autopair" "PassBridge pairing-code reader" $pairCmd
$totpManifest = Write-NmManifest "com.passbridge.totpsetup" "PassBridge verification-code setup helper" $totpCmd

foreach ($root in $browsers) {
  Set-Default (Join-Path $root "com.passbridge.policy") $policyManifest
  Set-Default (Join-Path $root "com.passbridge.autopair") $pairManifest
  Set-Default (Join-Path $root "com.passbridge.totpsetup") $totpManifest
  foreach ($old in @("com.openpasswords.policy", "com.openpasswords.autopair")) {
    $oldKey = Join-Path $root $old
    if (Test-Path -LiteralPath $oldKey) { Remove-Item -LiteralPath $oldKey -Force }
  }
}

Write-Output ""
Write-Output "Helpers installed to $Dest"
Write-Output "Fully quit and reopen the browser, then use the popup toggles."
