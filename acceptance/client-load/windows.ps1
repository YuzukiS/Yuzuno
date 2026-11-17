# The Windows side of acceptance/client-load: run.mjs calls it through WSL
# interop. It only starts, samples, minimizes, restores and stops the lab copy
# of the desktop app it started itself (checked by process ID, start time and
# path), and reads (never changes) anything else.
#
#   -Action info    -Folders 'a;b'    versions; the state of these folders
#   -Action launch  -Exe -Udf -Port -CoreUrl   start the lab app; prints its pid and start
#   -Action tree    -Id -Start        its processes, each with its role and data folder
#   -Action sample  -Id -Start -IntervalMs     one JSON line per interval, until the app ends or MaxSeconds
#   -Action show    -Id -Start -How minimize|restore
#   -Action stop    -Id -Start -Exe   close its window, then end it if it stays
#   -Action aside   -Folders path     move the lab identity's saved Core list aside (renamed, never deleted)
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$Exe, [string]$Udf, [int]$Port, [string]$CoreUrl,
    [int]$Id, [string]$Start, [int]$IntervalMs = 1000, [int]$MaxSeconds = 3600, [string]$How,
    [string]$Folders
)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Yn211 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
'@

function Out-Json($value) { ConvertTo-Json -InputObject $value -Compress -Depth 6 }

# The process this script started, only if it is still that process.
function Get-Owned {
    $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    if ($p.StartTime.ToUniversalTime().ToString('o') -ne $Start) { throw "process $Id is not the one started at $Start" }
    return $p
}

function Get-Tree([int]$root) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath)
    $ids = @($root)
    for ($i = 0; $i -lt 6; $i++) {
        $ids = @($ids + @($all | Where-Object { $_.ParentProcessId -in $ids } | ForEach-Object { $_.ProcessId }) | Sort-Object -Unique)
    }
    foreach ($row in ($all | Where-Object { $_.ProcessId -in $ids })) {
        $line = [string]$row.CommandLine
        $role = if ($row.ProcessId -eq $root) { 'shell' } elseif ($line -match '--type=([a-z-]+)') {
            if ($matches[1] -eq 'utility' -and $line -match '--utility-sub-type=([A-Za-z.]+)') { "utility:$($matches[1])" } else { $matches[1] }
        } else { 'browser' }
        $udf = if ($line -match '--user-data-dir="?([^" ]+)') { $matches[1] } else { $null }
        [pscustomobject]@{ pid = $row.ProcessId; parent = $row.ParentProcessId; name = $row.Name; role = $role; path = $row.ExecutablePath; userDataDir = $udf }
    }
}

switch ($Action) {
    'info' {
        $webview = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv
        $os = Get-CimInstance Win32_OperatingSystem
        $found = foreach ($f in @($Folders -split ';' | Where-Object { $_ })) {
            $item = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
            if ($item) {
                $newest = Get-ChildItem -LiteralPath $f -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc | Select-Object -Last 1
                [pscustomobject]@{ path = $f; exists = $true; newestWriteUtc = if ($newest) { $newest.LastWriteTimeUtc.ToString('o') } else { $null } }
            } else { [pscustomobject]@{ path = $f; exists = $false; newestWriteUtc = $null } }
        }
        $daily = @(Get-Process -Name 'yuzuno-desktop' -ErrorAction SilentlyContinue | ForEach-Object {
            [pscustomobject]@{ pid = $_.Id; start = $_.StartTime.ToUniversalTime().ToString('o'); version = $_.FileVersion } })
        Out-Json ([pscustomobject]@{ webview2 = $webview; os = "$($os.Caption) $($os.Version)"; cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
            logicalCpus = [Environment]::ProcessorCount; memoryGiB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
            otherDesktopProcesses = $daily; folders = @($found) })
    }
    'launch' {
        if (-not (Test-Path -LiteralPath $Exe)) { throw "no $Exe" }
        $env:WEBVIEW2_USER_DATA_FOLDER = $Udf
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
        $env:YUZUNO_CORE_URL = $CoreUrl
        $p = Start-Process -FilePath $Exe -PassThru
        Out-Json ([pscustomobject]@{ pid = $p.Id; start = $p.StartTime.ToUniversalTime().ToString('o'); startUnixMs = [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() })
    }
    'tree' {
        $p = Get-Owned
        if (-not $p) { Out-Json @(); break }
        Out-Json @(Get-Tree $Id)
    }
    'sample' {
        $p = Get-Owned
        if (-not $p) { throw "process $Id has ended" }
        $roles = @{}
        foreach ($row in (Get-Tree $Id)) { $roles[[int]$row.pid] = $row.role }
        $next = [DateTime]::UtcNow
        $until = $next.AddSeconds($MaxSeconds)
        while ([DateTime]::UtcNow -lt $until) {
            $idle = 0; $kernel = 0; $user = 0
            [void][Yn211.Native]::GetSystemTimes([ref]$idle, [ref]$kernel, [ref]$user)
            # Processes the tree gained since (a renderer started later).
            if (($roles.Count -lt 3) -or ((Get-Random -Maximum 10) -eq 0)) {
                foreach ($row in (Get-Tree $Id)) { $roles[[int]$row.pid] = $row.role }
            }
            $procs = foreach ($procId in @($roles.Keys)) {
                $q = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($q) { [pscustomobject]@{ pid = $procId; role = $roles[$procId]; cpuMs = [math]::Round($q.TotalProcessorTime.TotalMilliseconds, 1)
                    workingSetMiB = [math]::Round($q.WorkingSet64 / 1MB, 1); privateMiB = [math]::Round($q.PrivateMemorySize64 / 1MB, 1) } }
            }
            $main = Get-Process -Id $Id -ErrorAction SilentlyContinue
            if (-not $main) { Out-Json ([pscustomobject]@{ atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ended = $true }); break }
            $hwnd = $main.MainWindowHandle
            Out-Json ([pscustomobject]@{ atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); iconic = [Yn211.Native]::IsIconic($hwnd)
                window = [int64]$hwnd; systemTicks = @{ idle = $idle; kernel = $kernel; user = $user }; procs = @($procs) })
            [Console]::Out.Flush()
            $next = $next.AddMilliseconds($IntervalMs)
            $wait = [int][math]::Max(0, ($next - [DateTime]::UtcNow).TotalMilliseconds)
            Start-Sleep -Milliseconds $wait
        }
    }
    'show' {
        $p = Get-Owned
        if (-not $p) { throw "process $Id has ended" }
        $code = switch ($How) { 'minimize' { 6 } 'restore' { 9 } default { throw "show how: $How" } }
        # Its time just before ShowWindow, on this PC's clock (the page's clock too).
        $beforeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $done = [Yn211.Native]::ShowWindow($p.MainWindowHandle, $code)
        Start-Sleep -Milliseconds 200
        Out-Json ([pscustomobject]@{ how = $How; beforeMs = $beforeMs; atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); iconic = [Yn211.Native]::IsIconic($p.MainWindowHandle); previous = $done })
    }
    'stop' {
        $p = Get-Owned
        if (-not $p) { Out-Json ([pscustomobject]@{ stopped = 'already' }); break }
        if ($p.Path -ne $Exe) { throw "process $Id runs $($p.Path), not $Exe" }
        $tree = @(Get-Tree $Id | ForEach-Object { $_.pid })
        [void]$p.CloseMainWindow()
        $closed = $p.WaitForExit(10000)
        if (-not $closed) { Stop-Process -Id $Id -Force }
        # Its WebView2 processes end with it; wait for them, so the next run's profile is free.
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline -and @($tree | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0) { Start-Sleep -Milliseconds 200 }
        $left = @($tree | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        Out-Json ([pscustomobject]@{ stopped = if ($closed) { 'closed' } else { 'ended' }; left = $left })
    }
    'aside' {
        # Only the lab identity's own saved Cores: a saved entry of an earlier
        # lab Core (another Workspace at the same address) would stop its start.
        $path = $Folders
        if ($path -notmatch '\\dev\.yuzuno\.workspace\.yn211lab\\core\.json$') { throw "not the lab identity's core.json: $path" }
        if (Test-Path -LiteralPath $path) {
            $moved = "$path.aside-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            Move-Item -LiteralPath $path -Destination $moved
            Out-Json ([pscustomobject]@{ moved = $moved })
        } else { Out-Json ([pscustomobject]@{ moved = $null }) }
    }
    default { throw "unknown action $Action" }
}
