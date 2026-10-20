$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$roots = @($all | Where-Object { $_.Name -in @('yuzuno-lab.exe','yuzuno-desktop.exe') })
$ids = @($roots | ForEach-Object { $_.ProcessId })
for ($i=0; $i -lt 5; $i++) {
  $ids = @($ids + @($all | Where-Object { $_.ParentProcessId -in $ids } | ForEach-Object { $_.ProcessId }) | Sort-Object -Unique)
}
$before = @{}
foreach ($procId in $ids) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { $before[$procId] = $p.CPU }
}
$start = Get-Date
Start-Sleep -Seconds 3
$seconds = ((Get-Date)-$start).TotalSeconds
$apps = @()
foreach ($procId in $ids) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $meta = $all | Where-Object { $_.ProcessId -eq $procId } | Select-Object -First 1
  if ($p) {
    $role = if ($meta.CommandLine -match '--type=([^ ]+)') { $matches[1] } else { 'shell/browser' }
    $apps += [pscustomobject]@{ pid=$procId; parent=$meta.ParentProcessId; name=$p.ProcessName; role=$role; version=$p.FileVersion; path=$p.Path; cpuOneCorePct=[math]::Round(($p.CPU-$before[$procId])/$seconds*100,2); workingSetMiB=[math]::Round($p.WorkingSet64/1MB,1); privateMiB=[math]::Round($p.PrivateMemorySize64/1MB,1) }
  }
}
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
[pscustomobject]@{ at=(Get-Date).ToUniversalTime().ToString('o'); seconds=$seconds; totalCpuPct=$cpu.PercentProcessorTime; memoryKiB=@{total=$os.TotalVisibleMemorySize; free=$os.FreePhysicalMemory; virtualTotal=$os.TotalVirtualMemorySize; virtualFree=$os.FreeVirtualMemory}; apps=$apps } | ConvertTo-Json -Depth 5
