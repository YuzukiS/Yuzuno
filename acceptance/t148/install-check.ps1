# T-148 Windows check; see README.md here. Set the four $T148* values first.
$ErrorActionPreference = 'Stop'
$product = 'Yuzuno T148'
$identifier = 'dev.yuzuno.workspace.t148'
$binary = 'yuzuno-t148.exe'
$installDir = Join-Path $env:LOCALAPPDATA $product
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$dataDirs = @((Join-Path $env:LOCALAPPDATA $identifier), (Join-Path $env:APPDATA $identifier))
$startShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk"
$out = $T148Out
$report = [ordered]@{ checks = @(); startedAt = (Get-Date).ToUniversalTime().ToString('o') }

function Check([string]$Name, [bool]$Ok, $Details = $null) {
  $report.checks += [ordered]@{ name = $Name; ok = $Ok; details = $Details }
  if (-not $Ok) { throw "FAILED: $Name" }
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class T148Window {
  const string U = "user32.dll";
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport(U)] public static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport(U)] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr data);
  [DllImport(U)] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport(U)] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport(U)] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport(U)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport(U, CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, StringBuilder text);
  [DllImport(U, CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport(U)] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport(U)] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport(U)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  // The largest visible top-level window of at least 200 x 150.
  public static IntPtr Largest(uint pid) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows((w, d) => {
      uint p; GetWindowThreadProcessId(w, out p); Rect r;
      if (p != pid || !IsWindowVisible(w) || !GetWindowRect(w, out r)) return true;
      long width = r.Right - r.Left, height = r.Bottom - r.Top;
      if (width >= 200 && height >= 150 && width * height > area) { best = w; area = width * height; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string Text(IntPtr window) {
    var text = new StringBuilder(4096);
    SendMessage(window, 0x000D, (IntPtr)4096, text); // WM_GETTEXT
    return text.ToString();
  }
  public static List<string> Texts(IntPtr parent) {
    var texts = new List<string>();
    EnumChildWindows(parent, (w, d) => {
      if (!IsWindowVisible(w)) return true;
      var name = new StringBuilder(64); GetClassName(w, name, 64);
      var text = Text(w);
      if (text.Length > 0) texts.Add(name + ": " + text);
      return true;
    }, IntPtr.Zero);
    return texts;
  }
}
'@
[void][T148Window]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Capture([IntPtr]$Window, [string]$Name) {
  $rect = New-Object T148Window+Rect
  [void][T148Window]::GetWindowRect($Window, [ref]$rect)
  $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try { $ok = [T148Window]::PrintWindow($Window, $dc, 2) } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
  $path = Join-Path $out $Name
  try { if ($ok) { $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } } finally { $bitmap.Dispose() }
  return $(if ($ok) { $path } else { $null })
}
function Wait-Window([int]$ProcessId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $window = [T148Window]::Largest([uint32]$ProcessId)
    if ($window -ne [IntPtr]::Zero) { return $window }
    Start-Sleep -Milliseconds 200
  }
  return [IntPtr]::Zero
}
# The test app gets an unused Core address, so it never connects to a Core on this PC.
function Set-LabCore {
  $dir = Join-Path $env:APPDATA $identifier
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir 'core.json'), '{"coreUrl":"http://127.0.0.1:1"}')
}
function Show-App([int]$ProcessId, [string]$Name) {
  $window = Wait-Window $ProcessId 30
  Check "The app shows its window ($Name)" ($window -ne [IntPtr]::Zero)
  Start-Sleep -Seconds 4
  $shown = [ordered]@{ title = [T148Window]::Text($window); screenshot = (Capture $window $Name) }
  $all = @(Get-CimInstance Win32_Process)
  $tree = @((Get-TestProcesses).pid)
  do { $n = $tree.Count; $tree = @($tree + @($all | Where-Object { $tree -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Sort-Object -Unique) } while ($tree.Count -gt $n)
  $links = @(Get-NetTCPConnection | Where-Object { $_.RemotePort -eq 4317 -and $tree -contains $_.OwningProcess } | ForEach-Object { "$($_.OwningProcess) $($_.RemoteAddress) $($_.State)" })
  Check "The test app has no connection to port 4317 ($Name)" (-not $links.Count) ([ordered]@{ processes = $tree; links = $links })
  return $shown
}
function Get-TestProcesses {
  @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $binary -or $_.Name -eq "$product.exe" } | ForEach-Object {
    [ordered]@{ pid = $_.ProcessId; path = $_.ExecutablePath; commandLine = $_.CommandLine } })
}
function Wait-TestProcess([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $found = @(Get-TestProcesses)
    if ($found.Count) { return $found[0] }
    Start-Sleep -Milliseconds 300
  }
  return $null
}
function Stop-TestApp {
  foreach ($p in Get-TestProcesses) {
    $process = Get-Process -Id $p.pid -ErrorAction SilentlyContinue
    if ($process) { [void]$process.CloseMainWindow(); if (-not $process.WaitForExit(15000)) { Stop-Process -Id $p.pid -Force } }
  }
}
function Get-Entry([string]$Name) {
  $entry = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Name" -ErrorAction SilentlyContinue
  if (-not $entry) { return $null }
  [ordered]@{ displayVersion = $entry.DisplayVersion; installLocation = $entry.InstallLocation; uninstallString = $entry.UninstallString; mainBinaryName = $entry.MainBinaryName }
}
function Get-Others {
  [ordered]@{
    yuzuno = Get-Entry 'Yuzuno'
    yuzunoLab = Get-Entry 'Yuzuno Lab'
    processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^yuzuno' -and $_.Name -ne $binary } |
      ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" } | Sort-Object)
  }
}
function Get-State {
  $exe = Join-Path $installDir $binary
  [ordered]@{
    entry = Get-Entry $product
    installDirExists = Test-Path -LiteralPath $installDir
    files = if (Test-Path -LiteralPath $installDir) { @(Get-ChildItem -LiteralPath $installDir -Recurse -File | ForEach-Object { $_.FullName.Substring($installDir.Length + 1) } | Sort-Object) } else { @() }
    exeVersion = if (Test-Path -LiteralPath $exe) { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } else { $null }
    startMenuShortcut = Test-Path -LiteralPath $startShortcut
    desktopShortcut = Test-Path -LiteralPath $desktopShortcut
    dataDirs = @($dataDirs | Where-Object { Test-Path -LiteralPath $_ })
    processes = @(Get-TestProcesses)
  }
}

$others = $null
try {
  if (Test-Path -LiteralPath $out) { throw "$out already exists; use a new folder." }
  New-Item -ItemType Directory -Path $out | Out-Null
  $before = Get-State
  $report.before = $before
  Check 'The test identity is absent before the run' (-not $before.entry -and -not $before.installDirExists -and
    -not $before.startMenuShortcut -and -not $before.desktopShortcut -and -not $before.dataDirs.Count -and -not $before.processes.Count) $before
  $others = Get-Others
  $report.othersBefore = $others
  Set-LabCore

  # 1. The interactive first install: one page, the progress, then the app.
  $setup = Start-Process -FilePath $T148InstallerA -PassThru
  $window = Wait-Window $setup.Id 30
  Check 'The installer shows a window' ($window -ne [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  $page = [ordered]@{ title = [T148Window]::Text($window); controls = @([T148Window]::Texts($window)); screenshot = (Capture $window 'install-1-confirm.png') }
  $report.confirmPage = $page
  $button = [T148Window]::GetDlgItem($window, 1)
  Check "The page's button says Install" ([T148Window]::Text($button) -eq '&Install') ([T148Window]::Text($button))
  Check 'The page names the per-user install folder' (($page.controls -join "`n").Contains($installDir)) $installDir
  [void][T148Window]::PostMessage($window, 0x0111, [IntPtr]1, $button) # WM_COMMAND IDOK
  $progress = @()
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $setup.HasExited -and (Get-Date) -lt $deadline) {
    if ($progress.Count -lt 3) {
      Start-Sleep -Milliseconds 250
      $now = [T148Window]::Largest([uint32]$setup.Id)
      if ($now -ne [IntPtr]::Zero) {
        $shot = Capture $now "install-2-progress-$($progress.Count + 1).png"
        if ($shot) { $progress += [ordered]@{ screenshot = $shot; controls = @([T148Window]::Texts($now)) } }
      }
    } else { Start-Sleep -Milliseconds 300 }
  }
  Check 'The installer finishes by itself within two minutes, with exit code 0' ($setup.HasExited -and $setup.ExitCode -eq 0) $setup.ExitCode
  $report.progressPages = $progress
  $app = Wait-TestProcess 30
  Check 'The installed app opens after the install' ($null -ne $app -and $app.path -eq (Join-Path $installDir $binary)) $app
  $report.firstStart = Show-App $app.pid 'install-3-app.png'
  $installed = Get-State
  $report.afterInstall = $installed
  Check 'The install has its uninstall entry, the app, its notices and both shortcuts' (
    $installed.entry.displayVersion -eq '0.3.1' -and $installed.exeVersion -eq '0.3.1' -and
    $installed.files -contains $binary -and $installed.files -contains 'uninstall.exe' -and
    $installed.files -contains 'licenses\THIRD_PARTY_NOTICES-desktop.txt' -and
    $installed.startMenuShortcut -and $installed.desktopShortcut) $installed
  Stop-TestApp

  # 2. The in-app update's installer run, as the updater starts it.
  $update = Start-Process -FilePath $T148InstallerB -ArgumentList '/P', '/UPDATE', '/R', '/ARGS' -PassThru
  $updateWindow = Wait-Window $update.Id 30
  if ($updateWindow -ne [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 300
    $report.passivePage = [ordered]@{ controls = @([T148Window]::Texts($updateWindow)); screenshot = (Capture $updateWindow 'update-1-passive.png') }
  }
  Check 'The passive update finishes by itself with exit code 0' ($update.WaitForExit(120000) -and $update.ExitCode -eq 0) $update.ExitCode
  $restarted = Wait-TestProcess 30
  Check 'The updated app opens again (/R)' ($null -ne $restarted) $restarted
  $report.afterUpdateStart = Show-App $restarted.pid 'update-2-app.png'
  $updated = Get-State
  $report.afterUpdate = $updated
  Check 'The update replaced the app in place and kept the entry and shortcuts' (
    $updated.entry.displayVersion -eq '0.3.2' -and $updated.exeVersion -eq '0.3.2' -and
    $updated.entry.installLocation -eq $installed.entry.installLocation -and
    $updated.startMenuShortcut -and $updated.desktopShortcut) $updated
  Stop-TestApp

  # 3. The Installed apps entry's uninstaller.
  $uninstaller = (($updated.entry.uninstallString) -replace '"', '')
  Start-Process -FilePath $uninstaller -ArgumentList '/S' | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while (((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $installDir)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $removed = Get-State
  $report.afterUninstall = $removed
  Check 'The uninstaller removes the entry, the install folder and both shortcuts' (
    -not $removed.entry -and -not $removed.installDirExists -and -not $removed.startMenuShortcut -and -not $removed.desktopShortcut) $removed

  # 4. The portable copy, after the installed copy's data is gone.
  foreach ($path in $dataDirs) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
  Check 'The test identity has no data folder before the portable copy runs' (-not (Get-State).dataDirs.Count)
  Set-LabCore
  $folder = Join-Path $out 'portable'
  Expand-Archive -LiteralPath $T148PortableZip -DestinationPath $folder
  $exe = @(Get-ChildItem -LiteralPath $folder -Recurse -Filter "$product.exe")
  Check 'The ZIP holds one app, its README and its notices' ($exe.Count -eq 1 -and
    (Test-Path -LiteralPath (Join-Path $exe[0].DirectoryName 'README.txt')) -and
    (Test-Path -LiteralPath (Join-Path $exe[0].DirectoryName 'licenses\THIRD_PARTY_NOTICES-desktop.txt'))) ($exe | ForEach-Object FullName)
  $portable = Start-Process -FilePath $exe[0].FullName -PassThru
  $report.portable = Show-App $portable.Id 'portable-1-app.png'
  $report.portable.state = Get-State
  Check 'Running it adds no uninstall entry, install folder or shortcut' (
    -not $report.portable.state.entry -and -not $report.portable.state.installDirExists -and
    -not $report.portable.state.startMenuShortcut -and -not $report.portable.state.desktopShortcut) $report.portable.state
  Check 'Its data goes to the identity folder the README names' ($report.portable.state.dataDirs -contains (Join-Path $env:LOCALAPPDATA $identifier)) $report.portable.state.dataDirs
  Stop-TestApp
  $report.passed = $true
} catch {
  $report.passed = $false
  $report.error = $_.ToString()
} finally {
  # Cleanup, whatever happened.
  Stop-TestApp
  if (Test-Path -LiteralPath (Join-Path $installDir 'uninstall.exe')) {
    Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' | Out-Null
    $deadline = (Get-Date).AddSeconds(90)
    while ((Test-Path -LiteralPath $uninstallKey) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  }
  foreach ($path in @($dataDirs) + @($installDir, (Join-Path $out 'portable'))) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
  foreach ($path in $startShortcut, $desktopShortcut) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
  $after = Get-State
  $report.cleanedUp = $after
  $clean = -not $after.entry -and -not $after.installDirExists -and -not $after.startMenuShortcut -and
    -not $after.desktopShortcut -and -not $after.dataDirs.Count -and -not $after.processes.Count
  $report.checks += [ordered]@{ name = 'Nothing of the test identity is left'; ok = $clean; details = $after }
  if ($others) {
    $now = Get-Others
    $same = ($now | ConvertTo-Json -Depth 4) -eq ($others | ConvertTo-Json -Depth 4)
    $report.checks += [ordered]@{ name = "The regular app's and Yuzuno Lab's entries and processes are unchanged"; ok = $same; details = $now }
    if (-not $same) { $report.passed = $false }
  }
  if (-not $clean) { $report.passed = $false }
  $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  if (Test-Path -LiteralPath $out) { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'report.json') -Encoding UTF8 }
  $report | ConvertTo-Json -Depth 8
  if (-not $report.passed) { exit 1 }
}
