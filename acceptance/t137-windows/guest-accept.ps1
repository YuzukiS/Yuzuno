<#
T-137: the Yuzuno desktop's install, upgrade and uninstall, run INSIDE a
disposable Windows guest prepared by prepare.py (README). It writes nothing
before guest-lib.ps1's Get-Admission passes: this machine's identity is present
and is not the host's that prepare.py recorded; it is Windows Sandbox or the
guest registered in params.json; and it has no Yuzuno install or data yet.

  powershell -NoProfile -File C:\t137\harness\guest-accept.ps1 -Params C:\t137\config\params.json

Steps: check both packages (SHA-256, version) and that the WebView2 runtime is
there (the offline guest cannot download it); install the old package silently;
seed a test connection (core.json) and a marker in each app data folder;
install the new package over it; check the version changed,
the seeded data is unchanged and nothing new is named "-next"; uninstall with
the registered uninstaller; record what is left. Every step is recorded in
C:\t137\out\result.json, the first failure included; the exit status is 0
only if every check passed. Nothing here bypasses a signature, SmartScreen or
another protection: a prompt is recorded as what happened.
#>
param([Parameter(Mandatory = $true)][string]$Params)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guest-lib.ps1')
$p = Get-Content -Raw -LiteralPath $Params | ConvertFrom-Json
$out = $p.results
$steps = New-Object System.Collections.ArrayList
function Step([string]$name, [bool]$ok, $details) {
    [void]$steps.Add([ordered]@{ name = $name; ok = $ok; details = $details; at = (Get-Date).ToUniversalTime().ToString('o') })
}
function Save {
    $failed = @($steps | Where-Object { -not $_.ok })
    $result = [ordered]@{ product = $p.product; old = $p.old; new = $p.new
        passed = ($failed.Count -eq 0 -and $steps.Count -gt 0)
        firstFailure = if ($failed.Count) { $failed[0].name } else { $null }; steps = $steps }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding UTF8
    return $result.passed
}
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
function Entries {
    foreach ($root in $uninstallKeys) {
        if (Test-Path $root) {
            Get-ChildItem $root | ForEach-Object { Get-ItemProperty $_.PSPath } |
                Where-Object { $_.DisplayName -like "$($p.product)*" } |
                # The installer may write InstallLocation in quotes, as it does UninstallString.
                ForEach-Object { [ordered]@{ key = $_.PSPath; name = $_.DisplayName; version = $_.DisplayVersion
                    location = "$($_.InstallLocation)".Trim().Trim('"'); uninstall = $_.UninstallString } }
        }
    }
}
# What the product may create, by its name and identifier: folders, shortcuts, keys.
$places = @($env:LOCALAPPDATA, $env:APPDATA, [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), $env:ProgramFiles)
function Snapshot {
    $files = foreach ($place in $places) {
        if ($place -and (Test-Path $place)) {
            Get-ChildItem -LiteralPath $place -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'yuzuno' } | ForEach-Object { $_.FullName }
        }
    }
    $keys = Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'yuzuno' } | ForEach-Object { $_.Name }
    [ordered]@{ files = @($files | Sort-Object); keys = @($keys | Sort-Object); entries = @(Entries) }
}
function Hash([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
# The runtime the app needs, where its installer looks for it (per machine, then per user).
function Get-WebView2Version {
    $client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\$client", "HKLM:\SOFTWARE\$client", "HKCU:\Software\$client") {
        $pv = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue).pv
        if ($pv -and $pv -ne '0.0.0.0') { return "$pv" }
    }
    $null
}
function Wait-Gone([scriptblock]$present, [int]$seconds) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end -and (& $present)) { Start-Sleep -Milliseconds 500 }
    -not (& $present)
}

# 1. Only in a disposable guest that is not the host, from a blank start. Up to
# here everything only read; nothing is written unless this passes.
$facts = Get-GuestFacts
$before = Snapshot
$blank = ($before.files.Count -eq 0 -and $before.keys.Count -eq 0 -and $before.entries.Count -eq 0)
$admission = Get-Admission $facts $p $blank
# No raw identifier or path is recorded on a refusal: it may be on the host.
$seen = [ordered]@{ kind = $admission.kind; manufacturer = $facts.manufacturer; model = $facts.model
    executionPolicy = "$(Get-ExecutionPolicy)" }
if (-not $admission.admitted) {
    $counts = [ordered]@{ files = $before.files.Count; keys = $before.keys.Count; entries = $before.entries.Count }
    Step 'admission' $false ([ordered]@{ reasons = $admission.reasons; seen = $seen; baselineCounts = $counts })
    # Only into a results folder that already exists (the guest's mapped one); none is created.
    if (Test-Path -LiteralPath $out -PathType Container) { [void](Save) }
    # Not Write-Error: with ErrorActionPreference Stop it would end the script with 1.
    [Console]::Error.WriteLine('Refusing: ' + ($admission.reasons -join '; '))
    exit 2
}
Step 'admission' $true $seen

try {
    # 2. The packages are the ones prepared.
    foreach ($pkg in @($p.old, $p.new)) {
        $info = (Get-Item -LiteralPath $pkg.path).VersionInfo
        $sig = Get-AuthenticodeSignature -LiteralPath $pkg.path
        $ok = (Hash $pkg.path) -eq $pkg.sha256 -and $info.ProductVersion -eq $pkg.version
        Step "package $($pkg.version)" $ok ([ordered]@{ path = $pkg.path; productVersion = $info.ProductVersion
            productName = $info.ProductName; authenticode = "$($sig.Status)" })
        if (-not $ok) { throw "package $($pkg.path) is not the prepared one" }
    }
    $webview = Get-WebView2Version
    Step 'WebView2 runtime present' ([bool]$webview) ([ordered]@{ version = $webview })
    if (-not $webview) { throw 'no WebView2 runtime: the installer would try to download it and the guest is offline (a gap, not a pass)' }

    # 3. The old package, silently.
    $run = Start-Process -FilePath $p.old.path -ArgumentList '/S' -Wait -PassThru
    $old = @(Entries)
    $ok = $run.ExitCode -eq 0 -and $old.Count -eq 1 -and $old[0].version -eq $p.old.version
    Step 'install old' $ok ([ordered]@{ exitCode = $run.ExitCode; entries = $old; after = (Snapshot) })
    if (-not $ok) { throw 'the old package did not install as expected' }

    # 4. A test connection and a marker in each app data folder.
    $roaming = Join-Path $env:APPDATA $p.identifier
    $local = Join-Path $env:LOCALAPPDATA $p.identifier
    New-Item -ItemType Directory -Force -Path $roaming, $local | Out-Null
    $seeded = [ordered]@{}
    $core = Join-Path $roaming 'core.json'
    [IO.File]::WriteAllText($core, (@{ coreUrl = $p.testCoreUrl } | ConvertTo-Json -Compress))
    foreach ($file in @($core, (Join-Path $roaming 't137-marker.txt'), (Join-Path $local 't137-marker.txt'))) {
        if (-not (Test-Path $file)) { [IO.File]::WriteAllText($file, "T-137 $($p.token)") }
        $seeded[$file] = Hash $file
    }
    Step 'seed test data' $true $seeded

    # 5. The new package over it.
    $run = Start-Process -FilePath $p.new.path -ArgumentList '/S' -Wait -PassThru
    $new = @(Entries)
    $kept = [ordered]@{}
    foreach ($file in $seeded.Keys) { $kept[$file] = (Test-Path $file) -and (Hash $file) -eq $seeded[$file] }
    $ok = $run.ExitCode -eq 0 -and $new.Count -eq 1 -and $new[0].version -eq $p.new.version -and
        $new[0].location -eq $old[0].location -and -not ($kept.Values -contains $false)
    $afterUpgrade = Snapshot
    Step 'upgrade keeps the install and the data' $ok ([ordered]@{ exitCode = $run.ExitCode; entries = $new; kept = $kept; after = $afterUpgrade })

    # 6. Nothing the product made is named "-next".
    $named = @($afterUpgrade.files + $afterUpgrade.keys + ($new | ForEach-Object { $_.name, $_.location, $_.uninstall })) |
        Where-Object { $_ -match 'yuzuno[-_ ]?next' }
    Step 'no "-next" in names' ($named.Count -eq 0) ([ordered]@{ found = $named })

    # 7. Uninstall with the registered uninstaller, silently.
    $command = $new[0].uninstall
    $exe = if ($command -match '^"([^"]+)"') { $Matches[1] } else { ($command -split ' ')[0] }
    # The install folder: the entry's InstallLocation, else the uninstaller's folder.
    $folder = if ($new[0].location) { $new[0].location } else { Split-Path -Parent $exe }
    $run = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
    $gone = Wait-Gone { @(Entries).Count -gt 0 } 120
    $left = Snapshot
    Step 'uninstall' ($run.ExitCode -eq 0 -and $gone) ([ordered]@{ exitCode = $run.ExitCode; entryGone = $gone
        installFolder = $folder; installFolderGone = -not (Test-Path -LiteralPath $folder)
        left = $left; seededLeft = @($seeded.Keys | Where-Object { Test-Path $_ }) })
}
catch {
    Step 'stopped' $false "$($_.Exception.Message)"
}
if (Save) { exit 0 } else { exit 1 }
