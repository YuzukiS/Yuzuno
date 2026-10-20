// T-108 acceptance fixture: the Job Object memory limit observed with native
// calls (Lead seq 3930), beside load.cs's .NET allocations. The acceptance run
// compiles it with Windows' own .NET Framework 4 compiler into its own folder;
// it is not part of any release.
//
//   native.exe alloc <stepMiB> <maxMiB>    VirtualAlloc(MEM_COMMIT) steps
//   native.exe pair <parentMiB> <childMiB> commit here, then in a child process
//
// Each prints one JSON line per event, flushed at once:
// - start: whether this process is in a Job Object, that Job's limit flags,
//   JobMemoryLimit and PeakJobMemoryUsed as this process sees them before its
//   first allocation, its own PrivateUsage, and the size and field offsets of
//   JOBOBJECT_EXTENDED_LIMIT_INFORMATION as compiled here (x64: 144 bytes,
//   JobMemoryLimit at 120, PeakJobMemoryUsed at 136).
// - step: after each commit that succeeded (every page written): the MiB
//   committed by these steps, PrivateUsage and the Job's peak.
// - refused: the commit that failed, with GetLastError; then exit 3.
// - child (pair): the child's own lines, then its exit code.
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct BASIC
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO { public ulong A, B, C, D, E, F; }

    [StructLayout(LayoutKind.Sequential)]
    public struct EXTENDED
    {
        public BASIC BasicLimitInformation; public IO IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct COUNTERS
    {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
            QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out EXTENDED info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool K32GetProcessMemoryInfo(IntPtr process, out COUNTERS counters, uint cb);
}

static class Program
{
    const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, PAGE_READWRITE = 0x04;
    const int JobObjectExtendedLimitInformation = 9;
    const long MIB = 1024 * 1024;

    static void Say(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static ulong PrivateUsage()
    {
        Native.COUNTERS counters;
        return Native.K32GetProcessMemoryInfo(Native.GetCurrentProcess(), out counters, (uint)Marshal.SizeOf(typeof(Native.COUNTERS)))
            ? counters.PrivateUsage.ToUInt64() : 0;
    }

    /// This process's Job as it sees it ("null" when the query fails: no Job).
    static string Job(out ulong peak)
    {
        Native.EXTENDED info;
        peak = 0;
        if (!Native.QueryInformationJobObject(IntPtr.Zero, JobObjectExtendedLimitInformation, out info,
            Marshal.SizeOf(typeof(Native.EXTENDED)), IntPtr.Zero))
            return "{\"queryError\": " + Marshal.GetLastWin32Error() + "}";
        peak = info.PeakJobMemoryUsed.ToUInt64();
        return "{\"limitFlags\": " + info.BasicLimitInformation.LimitFlags + ", \"jobMemoryLimit\": " + info.JobMemoryLimit.ToUInt64()
            + ", \"processMemoryLimit\": " + info.ProcessMemoryLimit.ToUInt64() + ", \"peakJobMemoryUsed\": " + peak
            + ", \"peakProcessMemoryUsed\": " + info.PeakProcessMemoryUsed.ToUInt64() + "}";
    }

    static void Start(string mode)
    {
        bool inJob;
        Native.IsProcessInJob(Native.GetCurrentProcess(), IntPtr.Zero, out inJob);
        ulong peak;
        string job = Job(out peak);
        Say("{\"event\": \"start\", \"mode\": \"" + mode + "\", \"pid\": " + Process.GetCurrentProcess().Id + ", \"inJob\": "
            + (inJob ? "true" : "false") + ", \"job\": " + job + ", \"privateUsage\": " + PrivateUsage()
            + ", \"struct\": {\"extendedSize\": " + Marshal.SizeOf(typeof(Native.EXTENDED))
            + ", \"jobMemoryLimitOffset\": " + Marshal.OffsetOf(typeof(Native.EXTENDED), "JobMemoryLimit")
            + ", \"peakJobMemoryUsedOffset\": " + Marshal.OffsetOf(typeof(Native.EXTENDED), "PeakJobMemoryUsed") + "}}");
    }

    /// Commits `step` MiB at a time up to `max`; 0 when all fitted, 3 when one was refused.
    static int Alloc(int step, int max)
    {
        long total = 0;
        while (total + step <= max)
        {
            IntPtr block = Native.VirtualAlloc(IntPtr.Zero, new UIntPtr((ulong)(step * MIB)), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (block == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                ulong peak;
                string job = Job(out peak);
                Say("{\"event\": \"refused\", \"committedMiB\": " + total + ", \"stepMiB\": " + step + ", \"lastError\": " + error
                    + ", \"privateUsage\": " + PrivateUsage() + ", \"job\": " + job + "}");
                return 3;
            }
            for (long offset = 0; offset < step * MIB; offset += 4096) Marshal.WriteByte(block, (int)offset, 1);
            total += step;
            ulong after;
            Job(out after);
            Say("{\"event\": \"step\", \"committedMiB\": " + total + ", \"privateUsage\": " + PrivateUsage() + ", \"peakJobMemoryUsed\": " + after + "}");
        }
        return 0;
    }

    static int Pair(int parent, int child)
    {
        int code = Alloc(parent, parent);
        if (code != 0) return code;
        ProcessStartInfo start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
            "alloc " + child + " " + child);
        start.UseShellExecute = false;
        start.RedirectStandardOutput = true;
        using (Process process = Process.Start(start))
        {
            string line;
            while ((line = process.StandardOutput.ReadLine()) != null) Say("{\"event\": \"child\", \"line\": " + line + "}");
            process.WaitForExit();
            ulong peak;
            string job = Job(out peak);
            Say("{\"event\": \"childExit\", \"exitCode\": " + process.ExitCode + ", \"job\": " + job + "}");
            return process.ExitCode == 0 ? 0 : 4;
        }
    }

    static int Main(string[] args)
    {
        int a, b;
        if (args.Length == 3 && (args[0] == "alloc" || args[0] == "pair") && int.TryParse(args[1], out a) && int.TryParse(args[2], out b)
            && a >= 1 && a <= 512 && b >= 1 && b <= 1024)
        {
            Start(args[0]);
            return args[0] == "alloc" ? Alloc(a, b) : Pair(a, b);
        }
        Console.Error.WriteLine("usage: native.exe alloc <stepMiB> <maxMiB> | pair <parentMiB> <childMiB>");
        return 2;
    }
}
