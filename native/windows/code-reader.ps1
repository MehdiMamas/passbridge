# Reads the 6-digit code iCloud for Windows shows when an agent signs in to an Apple Account: presses Allow on
# the prompt once, reads the code from the next window, presses Done, and prints ONE JSON line on stdout:
#   {"ok":true,"code":"123456"}   or   {"ok":false,"error":"<name>"}
# It is started by the PassBridge relay, which reads that line from a pipe nobody else can reach. It writes nothing
# to disk and nothing to stderr, and takes no code from or puts none in its arguments or environment.
# Only windows of the processes named in code-reader.json (next to this file) count.
# Never run it where its output is logged.
#   -SelfTest <dir>  replays the fixtures in <dir> against the decision logic (no UI is touched)
param([string]$SelfTest)
$ErrorActionPreference = 'Stop'

function Test-Configured($cfg) {
  $all = @($cfg.processNames) + @($cfg.allowAutomationId, $cfg.doneAutomationId, $cfg.codePattern)
  foreach ($v in $all) {
    if ([string]$v -like 'TODO-DESCRIBE*') { return $false }
  }
  return (@($cfg.processNames).Count -gt 0)
}

function Test-IsCode([string]$text, [string]$pattern) {
  return ($text.Trim() -match $pattern)
}

# fresh: windows that were not there when the request came in. each has Key, Process, Buttons (AutomationIds), Texts
function Get-Decision($fresh, $cfg) {
  $relevant = @()
  foreach ($w in @($fresh)) {
    if (@($cfg.processNames) -notcontains $w.Process) { continue }
    $hasAllow = (@($w.Buttons) -contains $cfg.allowAutomationId)
    $codes = @()
    foreach ($t in @($w.Texts)) {
      if ($t -and (Test-IsCode $t $cfg.codePattern)) {
        $d = ([string]$t) -replace '\D', ''
        if ($codes -notcontains $d) { $codes += $d }
      }
    }
    if ($hasAllow -or $codes.Count -gt 0) {
      $relevant += , @{ Window = $w; HasAllow = $hasAllow; Codes = $codes }
    }
  }
  if ($relevant.Count -eq 0) { return @{ Kind = 'wait' } }
  if ($relevant.Count -gt 1) { return @{ Kind = 'several' } }
  $r = $relevant[0]
  if ($r.Codes.Count -ge 2) { return @{ Kind = 'failed' } }
  if ($r.Codes.Count -eq 1) { return @{ Kind = 'code'; Code = $r.Codes[0]; Key = $r.Window.Key } }
  if ($r.HasAllow) { return @{ Kind = 'allow'; Key = $r.Window.Key } }
  return @{ Kind = 'wait' }
}

# the whole read, shared by the real screen and the fixtures.
# list: scriptblock returning the current windows; press: scriptblock (key, automationId); wait: scriptblock; clock: scriptblock returning ms
function Invoke-Read($cfg, $list, $press, $wait, $clock) {
  if (-not (Test-Configured $cfg)) { return @{ Result = 'not_configured' } }
  $baseline = @{}
  foreach ($w in @(& $list)) { $baseline[$w.Key] = $true }
  $pressed = @{}
  while ((& $clock) -lt [int]$cfg.timeoutMs) {
    $fresh = @()
    foreach ($w in @(& $list)) {
      if ($baseline.ContainsKey($w.Key)) { continue }
      # an Allow button already pressed is not a second prompt
      if ($pressed.ContainsKey($w.Key)) {
        $w = @{ Key = $w.Key; Process = $w.Process; Texts = $w.Texts; Buttons = @(@($w.Buttons) | Where-Object { $_ -ne $cfg.allowAutomationId }) }
      }
      $fresh += , $w
    }
    $d = Get-Decision $fresh $cfg
    switch ($d.Kind) {
      'several' { return @{ Result = 'several_prompts' } }
      'failed' { return @{ Result = 'reader_failed' } }
      'allow' {
        if (-not $pressed.ContainsKey($d.Key)) {
          $pressed[$d.Key] = $true
          & $press $d.Key $cfg.allowAutomationId | Out-Null
        }
      }
      'code' {
        & $press $d.Key $cfg.doneAutomationId | Out-Null
        return @{ Result = 'ok'; Code = $d.Code }
      }
    }
    & $wait
  }
  return @{ Result = 'no_prompt' }
}

function Invoke-SelfTest([string]$dir) {
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' | Sort-Object Name)
  $failed = ($files.Count -eq 0)
  foreach ($f in $files) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    try {
      $fx = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
      $state = @{ Tick = 0; Pressed = @() }
      $timeline = @($fx.timeline | Sort-Object { [int]$_.tick })
      $list = {
        $cur = @()
        foreach ($e in $timeline) {
          if ([int]$e.tick -le $state.Tick) { $cur = @($e.windows) }
        }
        $out = @()
        foreach ($w in $cur) { $out += , @{ Key = $w.key; Process = $w.process; Buttons = @($w.buttons); Texts = @($w.texts) } }
        $out
      }.GetNewClosure()
      $press = { param($key, $id) $state.Pressed += ($key + ':' + $id); $true }.GetNewClosure()
      $wait = { $state.Tick += 1 }.GetNewClosure()
      $clock = { $state.Tick * 200 }.GetNewClosure()
      $out = Invoke-Read $fx.config $list $press $wait $clock
      $wantCode = $null
      if ($fx.expect.PSObject.Properties['code']) { $wantCode = [string]$fx.expect.code }
      $wantPressed = (@($fx.expect.pressed) -join ',')
      $good = ($out.Result -eq [string]$fx.expect.result) -and ([string]$out.Code -eq [string]$wantCode) -and ((@($state.Pressed) -join ',') -eq $wantPressed)
    } catch {
      $good = $false
    }
    if ($good) { [Console]::Out.WriteLine('PASS ' + $name) } else { [Console]::Out.WriteLine('FAIL ' + $name); $failed = $true }
  }
  if ($failed) { exit 1 }
  exit 0
}

function Write-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
}

if ($SelfTest) { Invoke-SelfTest $SelfTest }

try {
  $cfgPath = Join-Path $PSScriptRoot 'code-reader.json'
  if (-not (Test-Path -LiteralPath $cfgPath)) { Write-Result ([ordered]@{ ok = $false; error = 'not_configured' }); exit 0 }
  $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
  # nothing is touched until the real prompt is described
  if (-not (Test-Configured $cfg)) { Write-Result ([ordered]@{ ok = $false; error = 'not_configured' }); exit 0 }

  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $A = [System.Windows.Automation.AutomationElement]
  $T = [System.Windows.Automation.TreeScope]
  $elements = @{}
  $list = {
    $elements.Clear()
    $out = @()
    $procs = @{}
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { @($cfg.processNames) -contains $_.ProcessName })) { $procs[[int]$p.Id] = $p.ProcessName }
    if ($procs.Count -eq 0) { return $out }
    foreach ($win in $A::RootElement.FindAll($T::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      $procId = [int]$win.Current.ProcessId
      if (-not $procs.ContainsKey($procId)) { continue }
      $key = [string]$procId + '-' + (($win.GetRuntimeId()) -join '.')
      $buttons = @()
      $texts = @()
      $byId = @{}
      foreach ($e in $win.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $cur = $e.Current
        if ($cur.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $cur.AutomationId) {
          $buttons += $cur.AutomationId
          if (-not $byId.ContainsKey($cur.AutomationId)) { $byId[$cur.AutomationId] = $e }
        }
        if ($cur.Name) { $texts += $cur.Name }
      }
      $elements[$key] = $byId
      $out += , @{ Key = $key; Process = $procs[$procId]; Buttons = $buttons; Texts = $texts }
    }
    $out
  }
  $press = {
    param($key, $id)
    $el = $elements[$key][$id]
    if ($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  }
  $clock0 = [System.Diagnostics.Stopwatch]::StartNew()
  $res = Invoke-Read $cfg $list $press { Start-Sleep -Milliseconds 200 } { $clock0.ElapsedMilliseconds }
  if ($res.Result -eq 'ok') { Write-Result ([ordered]@{ ok = $true; code = $res.Code }) }
  else { Write-Result ([ordered]@{ ok = $false; error = $res.Result }) }
  exit 0
} catch {
  # no message: an error text must not carry anything from the prompt
  Write-Result ([ordered]@{ ok = $false; error = 'reader_failed' })
  exit 1
}
