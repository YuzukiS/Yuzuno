[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Paths', 'Launch', 'CloseWindow', 'Kill')]
    [string]$Action,
    [string]$CoreUrl,
    [int]$CdpPort,
    [int]$DesktopProcessId
)
# Windows half of the T-171 start lab (desktop/tests/start-lab.py). It runs
# only the lab build of the desktop (identifier dev.yuzuno.workspace.t171lab,
# built into Yuzuno\build\t171-desktop) and touches only that identity's
# folders. The regular app, its saved Core and its WebView data are never
# read or changed.
$ErrorActionPreference = 'Stop'
$identifier = 'dev.yuzuno.workspace.t171lab'
$executable = Join-Path $env:LOCALAPPDATA 'Yuzuno\build\t171-desktop\debug\yuzuno-desktop.exe'
$appData = Join-Path $env:APPDATA $identifier
$webviewData = Join-Path $env:LOCALAPPDATA $identifier

function Get-LabProcess([int]$Id) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $Id"
    if (-not $process -or $process.ExecutablePath -ne $executable) { throw "Process $Id is not the T-171 lab window." }
    $process
}

switch ($Action) {
    'Paths' {
        [pscustomobject]@{ executable = $executable; appData = $appData; webviewData = $webviewData } | ConvertTo-Json
    }
    'Launch' {
        if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the lab desktop first.' }
        if ($CdpPort -lt 9300 -or $CdpPort -gt 9399) { throw 'Use a DevTools port in 9300-9399.' }
        # Test-only DevTools port for this window; normal launches have none.
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
        $arguments = @()
        if ($CoreUrl) { $arguments = @('--core-url', $CoreUrl) }
        $process = if ($arguments.Count) {
            Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
        } else {
            Start-Process -FilePath $executable -PassThru
        }
        [pscustomobject]@{ pid = $process.Id } | ConvertTo-Json
    }
    'CloseWindow' {
        # What the window's close button does: WM_CLOSE to its main window.
        $process = Get-LabProcess $DesktopProcessId
        $handle = Get-Process -Id $process.ProcessId
        $sent = $handle.CloseMainWindow()
        $exited = $handle.WaitForExit(15000)
        [pscustomobject]@{ pid = $process.ProcessId; closeSent = $sent; exited = $exited } | ConvertTo-Json
    }
    'Kill' {
        $process = Get-LabProcess $DesktopProcessId
        Stop-Process -Id $process.ProcessId -Force
        [pscustomobject]@{ killed = $process.ProcessId } | ConvertTo-Json
    }
}
