<#
T-137 on an ordinary Windows account, under the test identity Yuzuno T137 only
(README, "On an ordinary account"). identity-command.py puts this text after
upgrade-steps.ps1's in one -Command, after lines that set $T137Out (an empty
folder), $T137Old, $T137OldSha256, $T137New and $T137NewSha256. No script file
runs and the execution policy is not changed.

It refuses to start unless nothing of the test identity exists. The app never
starts: its Core is set to http://127.0.0.1:1/, where nothing listens, before
anything is installed, and the silent installs start no process (checked).
Whatever happens, it then removes everything of the test identity, and only
that, and checks that the other Yuzuno entries, folders and keys (the regular
app, Yuzuno Lab) are as they were. Every step goes into $T137Out\report.json;
the exit status is 0 only if all passed, 2 if it refused to start, else 1.
#>
$ErrorActionPreference = 'Stop'
$identity = 'dev.yuzuno.workspace.t137'
$p = [pscustomobject]@{ product = 'Yuzuno T137'; identifier = $identity; token = [guid]::NewGuid().ToString('N')
    testCoreUrl = 'http://127.0.0.1:1/'
    old = [pscustomobject]@{ path = $T137Old; sha256 = "$T137OldSha256".ToLowerInvariant(); version = '0.2.0' }
    new = [pscustomobject]@{ path = $T137New; sha256 = "$T137NewSha256".ToLowerInvariant(); version = '0.2.1' } }
$Names = 'Yuzuno T137|dev\.yuzuno\.workspace\.t137|yuzuno-t137'
$local = $env:LOCALAPPDATA
$roaming = $env:APPDATA
# Everything of the test identity, by its exact names. Nothing else is removed.
$own = [ordered]@{
    installFolder = Join-Path $local $p.product
    localData = Join-Path $local $identity
    roamingData = Join-Path $roaming $identity
    startShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$($p.product).lnk"
    desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$($p.product).lnk"
    uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($p.product)"
    productKey = "HKCU:\Software\yuzuno\$($p.product)" }
$ownLeaves = @($p.product, $identity, "$($p.product).lnk")
# The other Yuzuno identities: their uninstall entries, folders and keys, by name.
function Others {
    $entries = foreach ($root in $uninstallKeys) {
        if (Test-Path $root) {
            Get-ChildItem $root | ForEach-Object { Get-ItemProperty $_.PSPath } |
                Where-Object { $_.DisplayName -like 'Yuzuno*' -and $_.DisplayName -notmatch $Names } |
                ForEach-Object { "$($_.DisplayName) | $($_.DisplayVersion) | $($_.InstallLocation) | $($_.UninstallString)" }
        }
    }
    $folders = foreach ($place in $local, $roaming) {
        Get-ChildItem -LiteralPath $place -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'yuzuno' -and $_.Name -notmatch $Names } | ForEach-Object { $_.FullName }
    }
    $keys = Get-ChildItem 'HKCU:\Software\yuzuno' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -notmatch $Names } | ForEach-Object { $_.Name }
    [ordered]@{ entries = @($entries | Sort-Object); folders = @($folders | Sort-Object); keys = @($keys | Sort-Object) }
}
function Save {
    $failed = @($steps | Where-Object { -not $_.ok })
    $report = [ordered]@{ product = $p.product; old = $p.old; new = $p.new
        passed = ($failed.Count -eq 0 -and $steps.Count -gt 1)
        firstFailure = if ($failed.Count) { $failed[0].name } else { $null }; steps = $steps }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $T137Out 'report.json') -Encoding UTF8
    return $report.passed
}

# Before anything: only reads.
$refusals = @()
if (-not ($local -and $roaming -and [IO.Path]::IsPathRooted($local) -and [IO.Path]::IsPathRooted($roaming))) {
    $refusals += 'LOCALAPPDATA and APPDATA are not set' }
$outReady = $T137Out -and [IO.Path]::IsPathRooted("$T137Out") -and (Test-Path -LiteralPath $T137Out -PathType Container)
if (-not $outReady) { $refusals += 'T137Out is not an existing folder' }
elseif (@(Get-ChildItem -LiteralPath $T137Out -Force).Count) { $refusals += 'T137Out is not empty' }
$present = @($own.Keys | Where-Object { Test-Path -LiteralPath $own[$_] })
$before = Snapshot
if ($present.Count -or $before.files.Count -or $before.keys.Count -or $before.entries.Count) {
    $refusals += "the test identity already exists: $($present -join ', ')" }
if (Get-Process -Name 'yuzuno-t137' -ErrorAction SilentlyContinue) { $refusals += 'a yuzuno-t137 process is running' }
if ($refusals.Count) {
    Step 'start' $false ([ordered]@{ refusals = $refusals })
    if ($outReady) { [void](Save) }
    [Console]::Error.WriteLine('Refusing: ' + ($refusals -join '; '))
    exit 2
}
$others = Others
Step 'start' $true ([ordered]@{ own = $own; others = $others })

try {
    # The app's Core, before anything is installed.
    New-Item -ItemType Directory -Force -Path $own.roamingData | Out-Null
    [IO.File]::WriteAllText((Join-Path $own.roamingData 'core.json'), (@{ coreUrl = $p.testCoreUrl } | ConvertTo-Json -Compress))
    Invoke-UpgradeSteps
}
catch {
    Step 'stopped' $false "$($_.Exception.Message)"
}
finally {
    # Remove everything of the test identity, whatever happened.
    try {
        $stopped = Running $own.installFolder
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path.StartsWith($own.installFolder + '\', [StringComparison]::OrdinalIgnoreCase) } |
            Stop-Process -Force
        $entry = @(Entries | Where-Object { $_.name -eq $p.product })
        $uninstaller = Join-Path $own.installFolder 'uninstall.exe'
        if ($entry.Count -and (Test-Path -LiteralPath $uninstaller)) {
            [void](Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru)
            [void](Wait-Gone { @(Entries | Where-Object { $_.name -eq $p.product }).Count -gt 0 } 120)
        }
        $removed = [ordered]@{}
        foreach ($name in @($own.Keys)) {
            $path = $own[$name]
            if ((Split-Path -Leaf $path) -notin $ownLeaves) { throw "not the test identity's: $path" }
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Recurse -Force
                $removed[$name] = -not (Test-Path -LiteralPath $path)
            }
        }
        $left = Snapshot
        $othersAfter = Others
        $same = ($others | ConvertTo-Json -Compress -Depth 4) -eq ($othersAfter | ConvertTo-Json -Compress -Depth 4)
        $clean = ($left.files.Count + $left.keys.Count + $left.entries.Count) -eq 0 -and
            -not (Get-Process -Name 'yuzuno-t137' -ErrorAction SilentlyContinue)
        Step 'cleanup' ($clean -and $same) ([ordered]@{ stopped = $stopped; removed = $removed; left = $left
            othersUnchanged = $same; othersAfter = $othersAfter })
    }
    catch {
        Step 'cleanup' $false "$($_.Exception.Message)"
    }
}
if (Save) { exit 0 } else { exit 1 }
