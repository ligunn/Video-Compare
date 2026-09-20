<#
  Real-process end-to-end check of the control commands (what the taskbar jump list and the Start Menu
  shortcuts run): launch the app, send --suspend / --resume / --quit through the single-instance lock, and
  report RAM and dedicated GPU memory of THIS instance's process tree at each step.

  Safe next to a running Video Compare: it uses its own --user-data-dir (so its own single-instance lock and
  profile) and only ever touches the PIDs it started itself.

  pwsh tools\e2e-commands.ps1 <video-a> <video-b>
#>
param(
  [Parameter(Mandatory)][string]$A,
  [Parameter(Mandatory)][string]$B,
  [int]$SettleSeconds = 6
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe  = (Resolve-Path (Join-Path $root 'node_modules\electron\dist\electron.exe')).Path
$prof = Join-Path ([IO.Path]::GetTempPath()) ("vc-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$common = @("`"$root`"", "--user-data-dir=`"$prof`"")

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select-Object ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($rootPid)
  do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
  return @($ids)
}
function Sample([string]$label, [int]$rootPid) {
  $ids = Get-Tree $rootPid
  $ram = [math]::Round(((Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
  $vram = 0
  try {
    $c = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples
    foreach ($s in $c) { if ($s.InstanceName -match '^pid_(\d+)_' -and $ids -contains [int]$Matches[1]) { $vram += $s.CookedValue } }
  } catch { $vram = -1 * 1MB }
  [pscustomobject]@{ Step = $label; Procs = $ids.Count; 'RAM MB' = $ram; 'VRAM MB' = [math]::Round($vram / 1MB) }
}

$rows = @()
$main = Start-Process -FilePath $exe -ArgumentList ($common + "`"$A`"", "`"$B`"") -PassThru
"launched PID $($main.Id) with profile $prof"
Start-Sleep -Seconds ($SettleSeconds + 4)
$rows += Sample 'running, 2 videos loaded (paused)' $main.Id

Start-Process -FilePath $exe -ArgumentList ($common + '--suspend') -Wait
Start-Sleep -Seconds $SettleSeconds
$rows += Sample 'after --suspend' $main.Id

Start-Process -FilePath $exe -ArgumentList ($common + '--resume') -Wait
Start-Sleep -Seconds $SettleSeconds
$rows += Sample 'after --resume' $main.Id

$rows | Format-Table -AutoSize | Out-String | Write-Host

$tree = Get-Tree $main.Id
Start-Process -FilePath $exe -ArgumentList ($common + '--quit') -Wait
$gone = $false
for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (-not (Get-Process -Id $tree -ErrorAction SilentlyContinue)) { $gone = $true; break } }
"--quit closed every process of this instance ($($tree.Count) PIDs): $gone"
if (-not $gone) { Get-Process -Id $tree -ErrorAction SilentlyContinue | Stop-Process -Force }   # only PIDs we started
Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
if (-not $gone) { exit 1 }
