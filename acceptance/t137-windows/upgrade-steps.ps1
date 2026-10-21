<#
T-137: the install, upgrade and uninstall steps, the same in a disposable guest
(guest-accept.ps1, the real identity) and on an ordinary account under a test
identity (identity-check.ps1). The caller sets $p (as in params.json: product,
identifier, token, testCoreUrl, and old and new with path, sha256 and version)
and $Names, a pattern for the names the product creates, then calls
Invoke-UpgradeSteps inside its own try. Every step goes into $steps. Nothing
here bypasses a signature, SmartScreen or another protection: a prompt is
recorded as what happened.
#>
$steps = New-Object System.Collections.ArrayList
function Step([string]$name, [bool]$ok, $details) {
    [void]$steps.Add([ordered]@{ name = $name; ok = $ok; details = $details; at = (Get-Date).ToUniversalTime().ToString('o') })
}
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
function Entries {
    foreach ($root in $uninstallKeys) {
        if (Test-Path $root) {
            Get-ChildItem $root | ForEach-Object { Get-ItemProperty $_.PSPath } |
                Where-Object { $_.DisplayName -like "$($p.product)*" } |
                # The installer may write InstallLocation in quotes, as it does UninstallString.
                ForEach-Object { [ordered]@{ key = $_.PSPath; name = $_.DisplayName; version = $_.DisplayVersion
                    location = "$($_.InstallLocation)".Trim().Trim('"'); uninstall = $_.UninstallString; publisher = $_.Publisher } }
        }
    }
}
# What the product may create, by the names in $Names: folders, shortcuts, keys.
$places = @($env:LOCALAPPDATA, $env:APPDATA, [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), $env:ProgramFiles)
function Snapshot {
    $files = foreach ($place in $places) {
        if ($place -and (Test-Path $place)) {
            Get-ChildItem -LiteralPath $place -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match $Names } | ForEach-Object { $_.FullName }
        }
    }
    # Keys under HKCU\Software, and one level below a key named yuzuno: the
    # installer's HKCU\Software\<publisher>\<product>.
    $keys = Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue |
        ForEach-Object { $_; if ($_.PSChildName -match 'yuzuno') { Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue } } |
        Where-Object { $_.PSChildName -match $Names } | ForEach-Object { $_.Name }
    [ordered]@{ files = @($files | Sort-Object); keys = @($keys | Sort-Object); entries = @(Entries) }
}
function Hash([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
# Processes started from a folder. A silent install starts none: the app opens
# only after an install given /R.
function Running([string]$folder) {
    if (-not $folder) { return @() }
    $prefix = $folder.TrimEnd('\') + '\'
    @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { "$($_.Name) $($_.Id)" })
}
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

function Invoke-UpgradeSteps {
    # The packages are the ones prepared.
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
    if (-not $webview) { throw 'no WebView2 runtime: the installer would try to download it (a gap, not a pass)' }

    # The old package, silently.
    $run = Start-Process -FilePath $p.old.path -ArgumentList '/S' -Wait -PassThru
    $old = @(Entries)
    $running = if ($old.Count -eq 1) { Running $old[0].location } else { @() }
    $ok = $run.ExitCode -eq 0 -and $old.Count -eq 1 -and $old[0].version -eq $p.old.version -and $running.Count -eq 0
    Step 'install old' $ok ([ordered]@{ exitCode = $run.ExitCode; entries = $old; running = $running; after = (Snapshot) })
    if (-not $ok) { throw 'the old package did not install as expected' }

    # A test connection and a marker in each app data folder.
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

    # The new package over it.
    $run = Start-Process -FilePath $p.new.path -ArgumentList '/S' -Wait -PassThru
    $new = @(Entries)
    $kept = [ordered]@{}
    foreach ($file in $seeded.Keys) { $kept[$file] = (Test-Path $file) -and (Hash $file) -eq $seeded[$file] }
    $running = Running $old[0].location
    $ok = $run.ExitCode -eq 0 -and $new.Count -eq 1 -and $new[0].version -eq $p.new.version -and
        $new[0].location -eq $old[0].location -and -not ($kept.Values -contains $false) -and $running.Count -eq 0
    $afterUpgrade = Snapshot
    Step 'upgrade keeps the install and the data' $ok ([ordered]@{ exitCode = $run.ExitCode; entries = $new; kept = $kept
        running = $running; after = $afterUpgrade })

    # Nothing the product made is named "-next".
    $named = @($afterUpgrade.files + $afterUpgrade.keys + ($new | ForEach-Object { $_.name, $_.location, $_.uninstall })) |
        Where-Object { $_ -match 'yuzuno[-_ ]?next' }
    Step 'no "-next" in names' ($named.Count -eq 0) ([ordered]@{ found = $named })

    # Uninstall with the registered uninstaller, silently.
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
