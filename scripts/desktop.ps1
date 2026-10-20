[CmdletBinding()]
param(
    [string]$CoreUrl,
    [string]$DesktopBin,
    [switch]$Release,
    [switch]$BuildOnly,
    [switch]$Check,
    [switch]$Test,
    # Build the NSIS installer and its signed updater artifact with the
    # official Tauri CLI. Implies a release build.
    [switch]$Bundle,
    # Bundle under a separate identity (desktop/tauri.lab.conf.json): its own
    # install folder, uninstall entry and WebView data, for update testing.
    [switch]$Lab,
    # Version to bundle, overriding tauri.conf.json (lab old/new builds).
    [string]$Version,
    # minisign private key that signs the updater artifact (never in the repo).
    [string]$SigningKeyPath,
    # Public key built into the desktop (plugins > updater > pubkey); every
    # update is verified against it. Without one, the build cannot update.
    [string]$UpdatePublicKeyPath,
    # Hard memory limit for the whole build (cargo, rustc, linker, bundler).
    [ValidateRange(1, 64)]
    [int]$MemoryLimitGB = 8,
    # Cargo features for a run, build, check or test (for example the lab-only
    # lab-open-failure); bundles never take features.
    [string[]]$Features
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopDir = Join-Path $repoRoot 'desktop'
$manifest = Join-Path $desktopDir 'Cargo.toml'
# Matches the locked tauri crate (desktop/Cargo.lock); bump both together.
$tauriCliVersion = '2.12.3'

if ($PSBoundParameters.ContainsKey('DesktopBin')) {
    if ($BuildOnly -or $Check -or $Test -or $Bundle) { throw '-DesktopBin cannot be combined with building.' }
    $executable = (Resolve-Path -LiteralPath $DesktopBin).Path
    $desktopArgs = @()
    if ($PSBoundParameters.ContainsKey('CoreUrl')) { $desktopArgs += @('--core-url', $CoreUrl) }
    & $executable @desktopArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    return
}
if (($Lab -or $Version -or $SigningKeyPath) -and -not $Bundle) { throw '-Lab, -Version and -SigningKeyPath apply to -Bundle.' }
if ($SigningKeyPath -and -not $UpdatePublicKeyPath) { throw '-SigningKeyPath needs the matching -UpdatePublicKeyPath.' }
if ($Bundle -and ($Check -or $Test)) { throw '-Bundle cannot be combined with -Check or -Test.' }
if ($Bundle -and $Features) { throw '-Features cannot be combined with -Bundle.' }

$cargoCommand = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue
$yuzunoToolchains = Join-Path $env:LOCALAPPDATA 'Yuzuno\toolchains'
$privateCargo = Join-Path $yuzunoToolchains 'cargo\bin\cargo.exe'
if (-not $cargoCommand -and -not (Test-Path -LiteralPath $privateCargo)) {
    throw 'Install Rust for Windows (MSVC toolchain), then reopen PowerShell. See desktop/README.md.'
}

# Windows processes are outside any WSL memory limit. Every build runs in a
# job object: past the limit Windows fails the allocation, and closing the job
# ends every process left in it.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class YuzunoLimitedProcess {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ExtendedLimit info, uint length, IntPtr returned);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint JobMemory = 0x200, KillOnJobClose = 0x2000, CreateSuspended = 0x4, UseStdHandles = 0x100;
    public static long PeakBytes;

    public static int Run(string commandLine, string directory, long limitBytes) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try {
            var limit = new ExtendedLimit();
            limit.Basic.LimitFlags = JobMemory | KillOnJobClose;
            limit.JobMemoryLimit = new UIntPtr((ulong)limitBytes);
            if (!SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(limit))) throw new Win32Exception();
            ExtendedLimit configured;
            if (!QueryInformationJobObject(job, 9, out configured, (uint)Marshal.SizeOf(limit), IntPtr.Zero)) throw new Win32Exception();
            if (configured.JobMemoryLimit.ToUInt64() != (ulong)limitBytes ||
                configured.Basic.LimitFlags != (JobMemory | KillOnJobClose))
                throw new InvalidOperationException("Build job did not retain the requested memory and child-process limits.");
            Console.WriteLine("desktop build: verified job limit {0} bytes; child breakaway disabled", limitBytes);
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(startup);
            startup.dwFlags = (int)UseStdHandles;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            ProcessInformation process;
            // Suspended until it is in the job, so nothing it starts escapes the limit.
            if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended, IntPtr.Zero, directory, ref startup, out process)) throw new Win32Exception();
            try {
                if (!AssignProcessToJobObject(job, process.hProcess)) {
                    var error = new Win32Exception();
                    TerminateProcess(process.hProcess, 1);
                    throw error;
                }
                bool member;
                if (!IsProcessInJob(process.hProcess, job, out member) || !member) {
                    TerminateProcess(process.hProcess, 1);
                    throw new InvalidOperationException("Build process is outside its memory-limited job.");
                }
                if (ResumeThread(process.hThread) == 0xFFFFFFFF) throw new Win32Exception();
                WaitForSingleObject(process.hProcess, 0xFFFFFFFF);
                uint code;
                GetExitCodeProcess(process.hProcess, out code);
                ExtendedLimit used;
                if (!QueryInformationJobObject(job, 9, out used, (uint)Marshal.SizeOf(limit), IntPtr.Zero)) throw new Win32Exception();
                PeakBytes = (long)used.PeakJobMemoryUsed.ToUInt64();
                return unchecked((int)code);
            } finally {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        } finally {
            CloseHandle(job);
        }
    }
}
'@

function Join-CommandLine([string[]]$Arguments) {
    # CommandLineToArgvW quoting, so each argument arrives exactly as given.
    ($Arguments | ForEach-Object {
        if ($_ -ne '' -and $_ -notmatch '[\s"]') { return $_ }
        '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    }) -join ' '
}

function Invoke-Limited([string]$Program, [string[]]$Arguments, [string]$Directory) {
    $limit = [int64]$MemoryLimitGB * 1GB
    $code = [YuzunoLimitedProcess]::Run((Join-CommandLine (@($Program) + $Arguments)), $Directory, $limit)
    $peak = [math]::Round([YuzunoLimitedProcess]::PeakBytes / 1MB)
    Write-Host "desktop build: exit $code, peak $peak MiB of a $MemoryLimitGB GiB limit"
    return $code
}

# A public installer carries the app's notices: desktop/licenses, written in WSL
# by tools/desktop_notices.py for this Cargo.lock, plus the standard library's
# notices from the toolchain that builds the app.
$noticesNames = @('LICENSE', 'THIRD_PARTY_NOTICES-desktop.txt', 'rust-std-COPYRIGHT-library.html')
$tauriNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'

function Read-DesktopNotices([string]$Folder) {
    $path = Join-Path $Folder 'notices.json'
    if (-not (Test-Path -LiteralPath $path)) {
        throw 'Generate the notices first, in WSL: python3 tools/desktop_notices.py --out desktop/licenses (see desktop/README.md).'
    }
    $record = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    $lock = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $desktopDir 'Cargo.lock')).Hash.ToLowerInvariant()
    if ($record.target -ne 'x86_64-pc-windows-msvc' -or $record.cargoLockSha256 -ne $lock) {
        throw 'desktop/licenses was generated for another Cargo.lock or target; generate it again.'
    }
    foreach ($file in $record.files.PSObject.Properties) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Folder $file.Name)).Hash.ToLowerInvariant()
        if ($actual -ne $file.Value) { throw "desktop/licenses/$($file.Name) changed after it was generated; generate it again." }
    }
    return $record
}

# The installer's own code comes from the NSIS folder the Tauri CLI bundles
# with; its files must be those whose license texts the notices reproduce.
function Assert-InstallerSources($Record, [bool]$Required) {
    if (-not (Test-Path -LiteralPath $tauriNsis)) {
        if ($Required) { throw "The Tauri CLI's NSIS folder $tauriNsis is missing after bundling." }
        return
    }
    foreach ($entry in $Record.installer) {
        if ($entry.cli -and $entry.cli -ne $tauriCliVersion) {
            throw "The notices record $($entry.name) for Tauri CLI $($entry.cli), not $tauriCliVersion; trace it again in tools/desktop-license-sources."
        }
        foreach ($file in @($entry.files | Where-Object { $_ })) {
            $path = Join-Path $tauriNsis ($file.path -replace '/', '\')
            $actual = if (Test-Path -LiteralPath $path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() } else { 'missing' }
            if ($actual -ne $file.sha256) {
                throw "$path ($actual) is not the file whose license text the notices reproduce for $($entry.name); trace it again in tools/desktop-license-sources."
            }
        }
    }
}

$cargoProgram = if ($cargoCommand) { $cargoCommand.Source } else { $privateCargo }
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:LOCALAPPDATA 'Yuzuno\build\desktop' }

# A dedicated Yuzuno toolchain (and the pinned Tauri CLI) may be installed
# without modifying global PATH. Scope their environment to this invocation.
$previous = @{}
foreach ($name in 'CARGO_HOME', 'RUSTUP_HOME', 'PATH', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'TAURI_CONFIG',
        'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD') {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:CARGO_BUILD_JOBS = '4'
    if (-not $cargoCommand) {
        $env:CARGO_HOME = Join-Path $yuzunoToolchains 'cargo'
        $env:RUSTUP_HOME = Join-Path $yuzunoToolchains 'rustup'
        $env:PATH = "$(Split-Path -Parent $privateCargo);$env:PATH"
    }
    $keyConfig = $null
    if ($UpdatePublicKeyPath) {
        $publicKey = (Get-Content -Raw -LiteralPath $UpdatePublicKeyPath).Trim()
        $keyConfig = @{ plugins = @{ updater = @{ pubkey = $publicKey } } } | ConvertTo-Json -Compress -Depth 4
    }
    if ($Bundle) {
        $cli = Join-Path $yuzunoToolchains "tauri-cli\$tauriCliVersion"
        $cliScript = Join-Path $cli 'node_modules\@tauri-apps\cli\tauri.js'
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
        if (-not $node) { throw 'Bundling uses the official Tauri CLI, which needs Node.js on this machine.' }
        if (-not (Test-Path -LiteralPath $cliScript)) {
            $npm = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
            New-Item -ItemType Directory -Force -Path $cli | Out-Null
            # npm.cmd runs in cmd.exe, which cannot start in a \\wsl$ folder.
            Push-Location -LiteralPath $cli
            try {
                & $npm.Source install --prefix $cli --no-save --no-audit --no-fund --ignore-scripts "@tauri-apps/cli@$tauriCliVersion"
            } finally { Pop-Location }
            if ($LASTEXITCODE -ne 0) { throw "Could not install @tauri-apps/cli $tauriCliVersion" }
        }
        $env:CARGO_TARGET_DIR = if ($Lab) { "$targetDir-lab" } else { $targetDir }
        if ($SigningKeyPath) {
            $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw -LiteralPath $SigningKeyPath).Trim()
            if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }
        }
        $notices = $null
        if (-not $Lab) {
            # Lab installers are for update tests only and carry no notices.
            $licenses = Join-Path $desktopDir 'licenses'
            $notices = Read-DesktopNotices $licenses
            $sysroot = (& rustc --print sysroot | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or -not $sysroot) { throw 'rustc --print sysroot failed.' }
            $std = Join-Path $sysroot 'share\doc\rust\COPYRIGHT-library.html'
            if (-not (Test-Path -LiteralPath $std)) { throw "The toolchain has no $std; the standard library notices cannot be included." }
            Copy-Item -LiteralPath $std (Join-Path $licenses 'rust-std-COPYRIGHT-library.html') -Force
            Assert-InstallerSources $notices $false
        }
        $tauriArgs = @($cliScript, 'build', '--bundles', 'nsis', '--ci')
        if ($notices) {
            $resources = [ordered]@{}
            foreach ($name in $noticesNames) { $resources["licenses/$name"] = "licenses/$name" }
            $tauriArgs += @('--config', (@{ bundle = @{ resources = $resources } } | ConvertTo-Json -Compress -Depth 4))
        }
        if ($Lab) { $tauriArgs += @('--config', (Join-Path $desktopDir 'tauri.lab.conf.json')) }
        if ($Version) { $tauriArgs += @('--config', (@{ version = $Version } | ConvertTo-Json -Compress)) }
        if ($keyConfig) { $tauriArgs += @('--config', $keyConfig) }
        if (-not $SigningKeyPath) { $tauriArgs += @('--config', '{"bundle":{"createUpdaterArtifacts":false}}') }
        $tauriArgs += @('--', '--locked')
        $exit = Invoke-Limited $node.Source $tauriArgs $desktopDir
        if ($exit -eq 0 -and $notices) {
            Assert-InstallerSources $notices $true
            $built = Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter '*-setup.exe' |
                Sort-Object LastWriteTime | Select-Object -Last 1
            Write-Host "desktop notices: check $($built.FullName) in WSL with tools/desktop_installer_check.py --licenses desktop/licenses"
        }
        if ($exit -eq 0 -and $SigningKeyPath) {
            # Core offers a desktop-<version> release only with these asset names.
            $bundled = if ($Version) { $Version } else { (Get-Content -Raw (Join-Path $desktopDir 'tauri.conf.json') | ConvertFrom-Json).version }
            $bundleDir = Join-Path $env:CARGO_TARGET_DIR 'release\bundle'
            $installer = Get-ChildItem -LiteralPath (Join-Path $bundleDir 'nsis') -Filter "*_$($bundled)_x64-setup.exe" |
                Sort-Object LastWriteTime | Select-Object -Last 1
            if (-not $installer -or -not (Test-Path -LiteralPath "$($installer.FullName).sig")) {
                throw "The signed installer for $bundled was not found under $bundleDir\nsis."
            }
            $publish = Join-Path $bundleDir "desktop-release\desktop-$bundled"
            New-Item -ItemType Directory -Force -Path $publish | Out-Null
            Copy-Item -LiteralPath $installer.FullName (Join-Path $publish 'yuzuno-desktop-windows-x86_64-setup.exe') -Force
            Copy-Item -LiteralPath "$($installer.FullName).sig" (Join-Path $publish 'yuzuno-desktop-windows-x86_64-setup.exe.sig') -Force
            Write-Host "desktop release desktop-$($bundled): $publish"
        }
    } else {
        # This script starts only the desktop window. Core, Codex, and workspace
        # files remain wherever Core runs (for example WSL).
        if ($keyConfig) { $env:TAURI_CONFIG = $keyConfig }
        $cargoArgs = @('run', '--locked', '--manifest-path', $manifest, '--target-dir', $targetDir)
        if ($BuildOnly) { $cargoArgs[0] = 'build' }
        if ($Check) { $cargoArgs[0] = 'check' }
        if ($Test) { $cargoArgs[0] = 'test' }
        if ($Release) { $cargoArgs += '--release' }
        if ($Features) { $cargoArgs += @('--features', ($Features -join ',')) }
        if ($Test) { $cargoArgs += @('--', '--test-threads=1') }
        if (-not $BuildOnly -and -not $Check -and -not $Test -and $PSBoundParameters.ContainsKey('CoreUrl')) {
            $cargoArgs += @('--', '--core-url', $CoreUrl)
        }
        $exit = Invoke-Limited $cargoProgram $cargoArgs $repoRoot
    }
} finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
if ($exit -ne 0) { exit $exit }
