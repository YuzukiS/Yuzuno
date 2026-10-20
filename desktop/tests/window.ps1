[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$DesktopProcessId,
    [ValidateSet('Inspect', 'Connection', 'Close', 'Capture')][string]$Action = 'Inspect',
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $DesktopProcessId
if ($process.ProcessName -ne 'yuzuno-desktop') { throw 'Only a Yuzuno desktop process may be inspected.' }
if ($process.MainWindowHandle -eq 0) { throw 'Yuzuno has no visible native window.' }
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class YuzunoWindowAcceptance {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int position);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$window = $process.MainWindowHandle
switch ($Action) {
    'Inspect' {
        [pscustomobject]@{Id=$process.Id;Name=$process.ProcessName;Title=$process.MainWindowTitle;Handle=$window.ToInt64()} | ConvertTo-Json
    }
    'Connection' {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate($DesktopProcessId)
        Start-Sleep -Milliseconds 150
        if ([YuzunoWindowAcceptance]::GetForegroundWindow() -ne $window) { throw 'Yuzuno is not foreground; no input sent.' }
        $shell.SendKeys('^,')
    }
    'Close' { if (-not $process.CloseMainWindow()) { throw 'Native window did not accept close.' } }
    'Capture' {
        if (-not $OutputPath) { throw '-OutputPath is required for capture.' }
        # PowerShell is otherwise DPI-unaware: GetWindowRect would return
        # virtual dimensions while PrintWindow emits physical pixels.
        [void][YuzunoWindowAcceptance]::SetThreadDpiAwarenessContext([IntPtr](-4))
        $rect = New-Object YuzunoWindowAcceptance+Rect
        [void][YuzunoWindowAcceptance]::GetWindowRect($window, [ref]$rect)
        $bitmap = New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $dc = $graphics.GetHdc()
        try {
            if (-not [YuzunoWindowAcceptance]::PrintWindow($window, $dc, 2)) { throw 'Native window capture failed.' }
        } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
        try { $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $bitmap.Dispose() }
    }
}
