[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('State', 'Install', 'Launch', 'Capture', 'Close', 'Connections', 'Uninstall')]
    [string]$Action,
    [string]$Installer,
    [string]$Executable,
    [string]$CoreUrl,
    [int]$CdpPort,
    [int]$CorePort,
    [int]$DesktopProcessId,
    [string]$OutputPath,
    [string]$LabBuildRoot
)
# Windows half of the T-13 desktop update lab (desktop/tests/update-lab.py).
# Every action is confined to the Yuzuno Lab identity (desktop/tauri.lab.conf.json):
# its install folder, uninstall entry, WebView data and lab build output. It
# refuses any other path or process, and never touches the regular app.
$ErrorActionPreference = 'Stop'
$product = 'Yuzuno Lab'
$identifier = 'dev.yuzuno.workspace.lab'
$installDir = Join-Path $env:LOCALAPPDATA $product
$installedExe = Join-Path $installDir 'yuzuno-lab.exe'
$labBuild = if ($LabBuildRoot) { [IO.Path]::GetFullPath($LabBuildRoot) } else { Join-Path $env:LOCALAPPDATA 'Yuzuno\build\desktop-lab\release' }
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$webviewData = Join-Path $env:LOCALAPPDATA $identifier
$appData = Join-Path $env:APPDATA $identifier

function Test-Under([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    return $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
}
if (-not (Test-Under $labBuild (Join-Path $env:LOCALAPPDATA 'Yuzuno\build')) -or
        (Split-Path (Split-Path $labBuild -Parent) -Leaf) -notlike '*-lab' -or
        (Split-Path $labBuild -Leaf) -ne 'release') {
    throw 'LabBuildRoot must be a separate *-lab\release directory under Yuzuno\build.'
}
function Get-LabProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'yuzuno-lab.exe' -and $_.ExecutablePath -and ((Test-Under $_.ExecutablePath $installDir) -or (Test-Under $_.ExecutablePath $labBuild))
    } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath; commandLine = $_.CommandLine } })
}
function Get-OtherYuzunoProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.Name -match '^yuzuno' -and
        -not ((Test-Under $_.ExecutablePath $installDir) -or (Test-Under $_.ExecutablePath $labBuild))
    } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath } })
}
function Get-LabProcess([int]$Id) {
    $process = @(Get-LabProcesses | Where-Object { $_.pid -eq $Id })
    if ($process.Count -ne 1) { throw "Process $Id is not a Yuzuno Lab process." }
    $process[0]
}
function Get-State {
    $record = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
    $version = if (Test-Path -LiteralPath $installedExe) { (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion } else { $null }
    [pscustomobject]@{
        installed = [bool]$record
        displayVersion = if ($record) { $record.DisplayVersion } else { $null }
        installLocation = if ($record) { $record.InstallLocation } else { $null }
        mainBinaryName = if ($record) { $record.MainBinaryName } else { $null }
        installDirExists = Test-Path -LiteralPath $installDir
        installedExeVersion = $version
        startMenuShortcut = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk")
        desktopShortcut = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk")
        webviewDataExists = Test-Path -LiteralPath $webviewData
        appDataExists = Test-Path -LiteralPath $appData
        resumeMarkerExists = Test-Path -LiteralPath (Join-Path $appData 'resume-after-update.json')
        labProcesses = @(Get-LabProcesses)
        otherYuzunoProcesses = @(Get-OtherYuzunoProcesses)
    }
}

switch ($Action) {
    'State' { Get-State | ConvertTo-Json -Depth 4 }
    'Install' {
        if (-not (Test-Under $Installer $labBuild)) { throw 'Only a lab installer from the lab build folder may run.' }
        if ((Get-LabProcesses).Count) { throw 'Close Yuzuno Lab before installing.' }
        # Passive, and /NS: no Start menu or desktop shortcut. Without /R the
        # installer does not start the app.
        $run = Start-Process -FilePath $Installer -ArgumentList '/P', '/NS' -PassThru
        if (-not $run.WaitForExit(180000)) {
            Stop-Process -Id $run.Id
            throw 'The lab installer did not finish within three minutes; it was stopped.'
        }
        if ($run.ExitCode -ne 0) { throw "The lab installer exited with $($run.ExitCode)." }
        Get-State | ConvertTo-Json -Depth 4
    }
    'Launch' {
        $exe = if ($Executable) { $Executable } else { $installedExe }
        if (-not ((Test-Under $exe $installDir) -or (Test-Under $exe $labBuild))) { throw 'Only a Yuzuno Lab executable may start.' }
        if ((Get-LabProcesses).Count) { throw 'Yuzuno Lab is already running.' }
        $core = [Uri]$CoreUrl
        if (-not $core.IsLoopback -or $core.Scheme -ne 'http') { throw 'The lab connects only to a loopback lab Core.' }
        if ($CdpPort -lt 9300 -or $CdpPort -gt 9399) { throw 'Use a lab DevTools port between 9300 and 9399.' }
        if (Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction SilentlyContinue) { throw "Port $CdpPort is in use." }
        # Test-only DevTools listener, for this lab process's WebView only.
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
        $process = Start-Process -FilePath $exe -ArgumentList '--core-url', $CoreUrl -PassThru
        [pscustomobject]@{ pid = $process.Id; path = $exe } | ConvertTo-Json
    }
    'Capture' {
        $lab = Get-LabProcess $DesktopProcessId
        $window = (Get-Process -Id $lab.pid).MainWindowHandle
        if ($window -eq 0) { throw 'Yuzuno Lab has no visible window.' }
        Add-Type -AssemblyName System.Drawing
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class YuzunoLabWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
        [void][YuzunoLabWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
        $rect = New-Object YuzunoLabWindow+Rect
        [void][YuzunoLabWindow]::GetWindowRect($window, [ref]$rect)
        $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $dc = $graphics.GetHdc()
        if (-not [YuzunoLabWindow]::PrintWindow($window, $dc, 2)) { throw 'Native Lab window capture failed.' }
        $graphics.ReleaseHdc($dc)
        $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose(); $bitmap.Dispose()
        # Tao can retain WS_CAPTION while hiding the frame in WM_NCCALCSIZE.
        # Record the raw bit; the WebView checks Tauri's isDecorated state.
        [pscustomobject]@{ pid = $lab.pid; output = $OutputPath; captionStyleBit = ([YuzunoLabWindow]::GetWindowLong($window, -16) -band 0x00C00000) -eq 0x00C00000 } | ConvertTo-Json
    }
    'Close' {
        $lab = Get-LabProcess $DesktopProcessId
        $process = Get-Process -Id $lab.pid
        [void]$process.CloseMainWindow()
        if (-not $process.WaitForExit(15000)) { Stop-Process -Id $lab.pid }
        [pscustomobject]@{ pid = $lab.pid; closed = $true } | ConvertTo-Json
    }
    'Connections' {
        # The lab WebView's own processes are the ones using the lab profile.
        $webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
            Where-Object { $_.CommandLine -like "*$webviewData*" } | ForEach-Object { $_.ProcessId })
        $open = @(Get-NetTCPConnection -RemotePort $CorePort -State Established -ErrorAction SilentlyContinue |
            Where-Object { $webviews -contains $_.OwningProcess })
        [pscustomobject]@{ labWebViewProcesses = $webviews.Count; establishedToCore = $open.Count } | ConvertTo-Json
    }
    'Uninstall' {
        if ((Get-LabProcesses).Count) { throw 'Close Yuzuno Lab before uninstalling.' }
        $uninstaller = Join-Path $installDir 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            # The uninstaller re-runs itself from a temporary copy; wait for its result.
            Start-Process -FilePath $uninstaller -ArgumentList '/S' | Out-Null
            $deadline = (Get-Date).AddSeconds(90)
            while (((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $installedExe)) -and
                    (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        }
        # The lab's own WebView and app data, by exact lab identifier.
        foreach ($path in $webviewData, $appData) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
        Get-State | ConvertTo-Json -Depth 4
    }
}
