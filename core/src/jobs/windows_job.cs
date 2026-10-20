// Native helper for Yuzuno Jobs on Windows, reached from this Core's WSL
// through interop (remote.rs, Machine::Windows). It speaks remote_job.py's
// requests and replies: a JSON request on stdin, one reply line on stdout
// ("YUZUNO-JOBS-REPLY ", the request's replyNonce, a space, then JSON);
// a refusal (nothing was started) replies {"error": ...} and exits 3.
//
// Written for the C# 5 compiler that ships with .NET Framework 4 (csc.exe
// v4.0.30319). tools/build-windows-helper.py builds it from a fixed commit,
// with the flags it records in runtimes/windows-jobs/windows-helper.json
// (no default response file, every reference named, x64, no debug symbols),
// and the result ships in the signed Core release; Core runs only those bytes.
// (mscorlib is implicit. x64: a 32-bit process would read the WOW64 registry
// view, which has no MachineGuid.)
//
// Arguments: [--root <folder>] [--test-actions]; `supervise <attempt folder>`
// is the supervisor. Everything it writes is under the data root: the one
// Core recorded for the attempt (an absolute folder, or %LOCALAPPDATA%\ and
// a relative one), by default %LOCALAPPDATA%\YuzunoData\windows-jobs: each
// attempt's private folder
// <root>\jobs\<jobId>\<attempt>\ and the helper's verified copy in
// <root>\bin. The attempt folder has remote_job.py's files: lock,
// intent.json (the commit point), fenced.json, spec.json, supervisor.lock
// (held open, unshared, by the supervisor for its whole life),
// supervisor.json, started.json, log-0.bin/log-1.bin (the 2 MiB output ring),
// cancel.json and result.json (written once, and only when the attempt's Job
// Object holds no process). Every call reads MachineGuid (registry) and
// LastBootUpTime (WMI) afresh.
//
// The command runs in its own Job Object, named after the attempt and 128
// random bits (recorded in started.json; a name that already exists is
// refused, so a Job found by that name is this attempt's own). The command is
// created suspended, assigned to the Job, recorded in started.json, and only
// then resumed, so every process it starts belongs to the attempt (children
// join their parent's Job). Cancel and timeouts terminate that Job Object;
// nothing is matched by process name or command line. The Job is
// KILL_ON_JOB_CLOSE: if the supervisor dies, the attempt's processes end with
// it, and status reports the attempt as lost (unknown in Core).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

class Refused : Exception { public Refused(string message) : base(message) { } }
class Busy : Exception { }
class Unclear : Exception { public Unclear(string message) : base(message) { } }

static class Native
{
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const uint CREATE_NEW_PROCESS_GROUP = 0x200;
    public const uint DETACHED_PROCESS = 0x8;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    public const int JobObjectBasicAccountingInformation = 1;
    public const int JobObjectExtendedLimitInformation = 9;
    public const int JobObjectCpuRateControlInformation = 15;
    public const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
    public const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
    public const uint JOB_OBJECT_QUERY = 0x4;
    public const uint JOB_OBJECT_TERMINATE = 0x8;
    public const int HANDLE_FLAG_INHERIT = 1;
    public const uint STARTF_USESTDHANDLES = 0x100;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint STILL_ACTIVE = 259;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    /// ControlFlags, then the union whose CpuRate member is used here: the
    /// share of all processors' cycles per 10,000.
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { public uint ControlFlags; public uint CpuRate; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_CPU_RATE_CONTROL_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_CPU_RATE_CONTROL_INFORMATION info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);
    public const int JobObjectBasicProcessIdList = 3;
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, string environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    public static extern void SetLastError(uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint SYNCHRONIZE = 0x100000;
    public const uint DUPLICATE_SAME_ACCESS = 0x2;
    public const int ERROR_ACCESS_DENIED = 5;
    public const int ERROR_ALREADY_EXISTS = 183;
    public const uint PROCESS_TERMINATE = 0x1;
}

static class Common
{
    public const int Segment = 1024 * 1024;
    public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    public static readonly Encoding Utf8 = new UTF8Encoding(false);

    public static double Now() { return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds; }

    /// This boot, as Windows records its start (Win32_OperatingSystem's
    /// LastBootUpTime, fixed for one boot). A value computed from the tick
    /// count would drift by milliseconds between reads.
    public static string BootId()
    {
        using (System.Management.ManagementObjectSearcher search = new System.Management.ManagementObjectSearcher(
            "SELECT LastBootUpTime FROM Win32_OperatingSystem"))
        {
            foreach (System.Management.ManagementBaseObject os in search.Get())
            {
                string value = os["LastBootUpTime"] as string;
                if (!string.IsNullOrEmpty(value)) return value;
            }
        }
        throw new Unclear("this boot's start time cannot be read");
    }

    public static Dictionary<string, object> ReadJson(string path)
    {
        string text;
        try { text = File.ReadAllText(path, Utf8); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        try { return Json.Deserialize<Dictionary<string, object>>(text); }
        catch (Exception) { throw new Unclear(Path.GetFileName(path) + " cannot be read"); }
    }

    /// Written whole or not at all: a temporary file, flushed to disk, then renamed.
    public static void Atomic(string path, object value)
    {
        string temporary = Path.Combine(Path.GetDirectoryName(path), "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N"));
        using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            byte[] bytes = Utf8.GetBytes(Json.Serialize(value));
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        File.Move(temporary, path);
    }

    public static Dictionary<string, object> Outcome(string root, Dictionary<string, object> intent, string status, string reason, object code)
    {
        return Outcome(root, intent, status, reason, code, null);
    }

    /// The outcome, written once. `evidence` (report only) holds what was in
    /// the attempt's Job Object when the command exited and what was still
    /// there and stopped after the grace, by PID, image and creation time.
    public static Dictionary<string, object> Outcome(string root, Dictionary<string, object> intent, string status, string reason,
        object code, Dictionary<string, object> evidence)
    {
        Dictionary<string, object> existing = ReadJson(Path.Combine(root, "result.json"));
        if (existing != null) return existing;
        Dictionary<string, object> value = new Dictionary<string, object>();
        value["jobId"] = intent["jobId"]; value["attempt"] = intent["attempt"]; value["status"] = status;
        value["reason"] = reason; value["exitCode"] = code; value["signal"] = null; value["finishedAtUnix"] = Now();
        if (evidence != null) foreach (KeyValuePair<string, object> entry in evidence) value[entry.Key] = entry.Value;
        Atomic(Path.Combine(root, "result.json"), value);
        return value;
    }

    /// The processes in a Job Object, by PID, image name and creation time,
    /// for reports only: what belongs to the attempt is decided by the Job
    /// (its handle), never by a name.
    public static List<object> Members(IntPtr job)
    {
        List<object> members = new List<object>();
        int size = 8 + 256 * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero)) return members;
            int listed = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < listed && i < 256; i++)
            {
                int pid = (int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                string image = null, created = null;
                IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (process != IntPtr.Zero)
                {
                    try
                    {
                        long creation, exit, kernel, user;
                        if (Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)) created = creation.ToString();
                        StringBuilder path = new StringBuilder(1024);
                        int length = path.Capacity;
                        if (Native.QueryFullProcessImageName(process, 0, path, ref length)) image = Path.GetFileName(path.ToString());
                    }
                    finally { Native.CloseHandle(process); }
                }
                Dictionary<string, object> member = new Dictionary<string, object>();
                member["pid"] = pid; member["image"] = image; member["creation"] = created;
                members.Add(member);
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        return members;
    }

    /// A new Job Object name for the attempt: its ID and 128 random bits,
    /// recorded in started.json. A Job found by that name is this attempt's
    /// own (creation refuses a name that already exists), so nothing that
    /// merely looks like it is ever queried or terminated.
    public static string NewJobName(string attempt)
    {
        byte[] random = new byte[16];
        using (RNGCryptoServiceProvider generator = new RNGCryptoServiceProvider()) generator.GetBytes(random);
        StringBuilder suffix = new StringBuilder();
        foreach (byte b in random) suffix.Append(b.ToString("x2"));
        return "Local\\yuzuno-job-" + attempt + "-" + suffix;
    }

    /// Whether the process recorded in `identity` (PID and creation time)
    /// is still that process and still running.
    public static bool Alive(Dictionary<string, object> identity)
    {
        if (identity == null || !(identity["pid"] is int)) return false;
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (int)identity["pid"]);
        if (process == IntPtr.Zero) return false;
        try
        {
            long creation, exit, kernel, user;
            uint code;
            if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
            if (creation.ToString() != Convert.ToString(identity["creation"])) return false;
            return Native.GetExitCodeProcess(process, out code) && code == Native.STILL_ACTIVE;
        }
        finally { Native.CloseHandle(process); }
    }

    /// Whether the attempt's supervisor is alive: it holds supervisor.lock
    /// open with no sharing for its whole life.
    public static bool SupervisorAlive(string root)
    {
        string path = Path.Combine(root, "supervisor.lock");
        if (!File.Exists(path)) return false;
        try
        {
            using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) { }
            return false;
        }
        catch (IOException) { return true; }
    }

    /// How many processes the attempt's Job Object (by its recorded name)
    /// holds, or -1 when the Job no longer exists (its last handle closed:
    /// nothing of it is left).
    public static int Active(string jobName)
    {
        IntPtr job = Native.OpenJobObject(Native.JOB_OBJECT_QUERY, false, jobName);
        if (job == IntPtr.Zero) return -1;
        try
        {
            Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
            if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, out info,
                Marshal.SizeOf(typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
                throw new Unclear("the attempt's Job Object cannot be queried");
            return (int)info.ActiveProcesses;
        }
        finally { Native.CloseHandle(job); }
    }
}

static class Program
{
    const string Mark = "YUZUNO-JOBS-REPLY ";
    static readonly Regex Id = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    static readonly Regex Key = new Regex("^[A-Za-z0-9._:-]{1,128}$");
    static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$");
    static readonly Regex Host = new Regex("^[0-9a-f]{32}$");
    static readonly Regex Nonce = new Regex("^[0-9a-f]{32}$");
    const int Page = 32768;
    /// The request/reply protocol this helper speaks; Core refuses a helper
    /// that reports another one (remote.rs WINDOWS_PROTOCOL).
    const int Protocol = 1;

    /// Everything this helper writes lives under this folder: the one Core
    /// names with --root, by default DefaultRoot. Attempts go in
    /// <root>\jobs, the helper's copy for supervisors in <root>\bin.
    static string DataRoot;
    /// A root given as this prefix and a relative folder is under this
    /// account's local application data, wherever that is.
    const string LocalAppData = "%LOCALAPPDATA%\\";
    /// Outside %LOCALAPPDATA%\Yuzuno, where the desktop app installs: its
    /// installer and uninstaller never touch these records.
    const string DefaultRoot = LocalAppData + "YuzunoData\\windows-jobs";
    /// --test-actions: the acceptance run's own calls may also use
    /// test-kill-supervisor. Core never passes it.
    static bool TestActions;

    static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "supervise") return Supervisor.Run(args[1]);
        string mark = Mark;
        Dictionary<string, object> reply;
        string host;
        try
        {
            ParseArguments(args);
            string text;
            using (StreamReader input = new StreamReader(Console.OpenStandardInput(), Common.Utf8)) text = input.ReadToEnd();
            Dictionary<string, object> request;
            try { request = Common.Json.Deserialize<Dictionary<string, object>>(text); }
            catch (Exception) { throw new Refused("The request must be a JSON object"); }
            if (request == null) throw new Refused("The request must be a JSON object");
            string nonce = request.ContainsKey("replyNonce") ? request["replyNonce"] as string : null;
            if (nonce != null && Nonce.IsMatch(nonce)) mark = Mark + nonce + " ";
            host = HostId();
            string action = request.ContainsKey("action") ? request["action"] as string : null;
            try
            {
                switch (action)
                {
                    case "hello": reply = Hello(); break;
                    case "start": reply = Start(request, host); break;
                    case "status": reply = Status(request, host); break;
                    case "cancel": reply = Cancel(request, host); break;
                    case "logs": reply = Logs(request, host); break;
                    case "test-kill-supervisor":
                        RequireAcceptanceRoot();
                        reply = KillSupervisor(request);
                        break;
                    case "test-job-processes":
                        RequireAcceptanceRoot();
                        reply = JobProcesses(request);
                        break;
                    default: throw new Refused("Unknown action");
                }
            }
            catch (Busy) { reply = Map("status", "busy", "reason", "Another connection is working on this attempt"); }
            catch (Unclear error) { reply = Map("status", "unclear", "reason", error.Message); }
        }
        catch (Refused error)
        {
            Send(mark, Map("error", error.Message));
            return 3;
        }
        reply["hostId"] = host;
        try { reply["bootId"] = Common.BootId(); }
        catch (Unclear) { reply["bootId"] = null; }
        Send(mark, reply);
        return 0;
    }

    static void Send(string mark, object value)
    {
        byte[] bytes = Common.Utf8.GetBytes(mark + Common.Json.Serialize(value) + "\n");
        using (Stream output = Console.OpenStandardOutput())
        {
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }
    }

    static Dictionary<string, object> Map(params object[] pairs)
    {
        Dictionary<string, object> value = new Dictionary<string, object>();
        for (int i = 0; i + 1 < pairs.Length; i += 2) value[(string)pairs[i]] = pairs[i + 1];
        return value;
    }

    /// This installation, as an app-specific hash of its MachineGuid; the
    /// value itself never leaves this machine.
    static string HostId()
    {
        object guid = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", null);
        if (!(guid is string) || ((string)guid).Length == 0)
            throw new Refused("This Windows installation has no MachineGuid, so Core cannot tell it apart from another one");
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(Common.Utf8.GetBytes("yuzuno-jobs-windows-host-v1:" + (string)guid));
            return Hex(digest).Substring(0, 32);
        }
    }

    static string FileDigest(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream image = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            return Hex(sha.ComputeHash(image));
    }

    static string Hex(byte[] bytes)
    {
        StringBuilder text = new StringBuilder();
        foreach (byte b in bytes) text.Append(b.ToString("x2"));
        return text.ToString();
    }

    /// Windows as WMI names it (caption and version). Environment.OSVersion
    /// reports 6.2 to programs without a compatibility manifest.
    static string WindowsVersion()
    {
        try
        {
            using (System.Management.ManagementObjectSearcher search = new System.Management.ManagementObjectSearcher(
                "SELECT Caption, Version FROM Win32_OperatingSystem"))
            {
                foreach (System.Management.ManagementBaseObject os in search.Get())
                    return (os["Caption"] as string ?? "Windows") + " " + (os["Version"] as string ?? "");
            }
        }
        catch (Exception) { }
        return Environment.OSVersion.VersionString;
    }

    static Dictionary<string, object> Hello()
    {
        // Writes nothing. localAppData lets an acceptance run name its own data
        // root under this account's folder before anything is written.
        return Map("status", "hello", "platform", "Windows", "protocol", Protocol, "os", WindowsVersion(),
            // Which helper answered: the SHA-256 of this very executable.
            "helperSha256", FileDigest(System.Reflection.Assembly.GetExecutingAssembly().Location),
            "dataRoot", DataRoot, "localAppData", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
    }

    /// Whether --root named an absolute folder: an acceptance run's own. A
    /// root under %LOCALAPPDATA%\ never is.
    static bool ExplicitRoot;

    /// Test actions act only inside an acceptance run's own root: named
    /// explicitly, not a link, and holding the marker the run wrote when it
    /// created that root. A production or any other root is refused.
    static void RequireAcceptanceRoot()
    {
        if (!TestActions || !ExplicitRoot) throw new Refused("Unknown action");
        string marker = Path.Combine(DataRoot, "acceptance-run.json");
        if (!Directory.Exists(DataRoot) || (File.GetAttributes(DataRoot) & FileAttributes.ReparsePoint) != 0
            || !File.Exists(marker) || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0)
            throw new Refused("test actions run only in an acceptance run's own data root");
    }

    static void ParseArguments(string[] args)
    {
        string given = DefaultRoot;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--root" && i + 1 < args.Length) given = args[++i];
            else if (args[i] == "--test-actions") TestActions = true;
            else throw new Refused("Unknown argument " + args[i]);
        }
        if (given.StartsWith(LocalAppData, StringComparison.OrdinalIgnoreCase))
        {
            string relative = given.Substring(LocalAppData.Length);
            foreach (string part in relative.Split('\\'))
                if (!Regex.IsMatch(part, "^[A-Za-z0-9._ -]+$") || part.Trim('.', ' ').Length == 0)
                    throw new Refused("The data root under %LOCALAPPDATA% must be a relative folder of plain names");
            DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), relative);
        }
        else
        {
            DataRoot = given;
            ExplicitRoot = true;
        }
        if (!Regex.IsMatch(DataRoot, @"^[A-Za-z]:\\[^\\]") || DataRoot.IndexOfAny(Path.GetInvalidPathChars()) >= 0)
            throw new Refused("The data root must be an absolute folder on a local drive");
        DataRoot = Path.GetFullPath(DataRoot).TrimEnd('\\');
        // Its existing parents (below the drive root) must not be links
        // either, or "under the data root" would mean somewhere else.
        for (DirectoryInfo parent = new DirectoryInfo(DataRoot).Parent; parent != null && parent.Parent != null; parent = parent.Parent)
        {
            if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new Refused(parent.FullName + " is a link; the data root must not be under one");
        }
    }

    /// Makes (if asked) and checks each folder of a chain under the data
    /// root: a folder that is a link (any reparse point) or not a folder is
    /// never this helper's.
    public static void CheckFolders(IEnumerable<string> chain, bool create)
    {
        foreach (string directory in chain)
        {
            if (create) Directory.CreateDirectory(directory);
            FileAttributes attributes = File.GetAttributes(directory);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
                throw new Refused(directory + " is not this helper's folder");
        }
    }

    static string Text(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) ? value as string : null;
    }

    /// The attempt's folder; with `create`, made if missing. A folder that is
    /// a link or not a folder is never this helper's.
    static string AttemptDir(Dictionary<string, object> request, bool create)
    {
        string job = Text(request, "jobId"), attempt = Text(request, "attempt");
        if (job == null || !Id.IsMatch(job) || attempt == null || !Id.IsMatch(attempt))
            throw new Refused("jobId and attempt must be job and attempt UUIDs");
        string[] chain = { DataRoot, Path.Combine(DataRoot, "jobs"), Path.Combine(DataRoot, "jobs", job),
            Path.Combine(DataRoot, "jobs", job, attempt) };
        if (!create && !Directory.Exists(chain[3])) return null;
        CheckFolders(chain, create);
        return chain[3];
    }

    /// Every action on an attempt holds its lock, one at a time.
    static FileStream Locked(string root)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            try { return new FileStream(Path.Combine(root, "lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException)
            {
                if (DateTime.UtcNow >= deadline) throw new Busy();
                Thread.Sleep(100);
            }
        }
    }

    static Dictionary<string, object> Binding(Dictionary<string, object> request)
    {
        string workspace = Text(request, "workspaceKey"), machine = Text(request, "machineId");
        string digest = Text(request, "digest"), expect = Text(request, "expectHost");
        if (workspace == null || !Key.IsMatch(workspace) || machine == null || !Key.IsMatch(machine)
            || digest == null || !Hex64.IsMatch(digest) || expect == null || !Host.IsMatch(expect))
            throw new Refused("workspaceKey, machineId, digest and expectHost are required");
        return Map("workspaceKey", workspace, "machineId", machine, "digest", digest, "expectHost", expect);
    }

    static string Conflict(Dictionary<string, object> intent, Dictionary<string, object> bound)
    {
        foreach (string key in new[] { "workspaceKey", "machineId", "digest" })
            if (!intent.ContainsKey(key) || (intent[key] as string) != (string)bound[key]) return "its " + key + " differs";
        return null;
    }

    /// An attempt is read and acted on only by a helper of the protocol that
    /// started it: an upgraded or rolled-back helper never guesses at another
    /// one's records, and leaves the attempt and its folder as they are.
    static void SameProtocol(Dictionary<string, object> intent)
    {
        object written = intent.ContainsKey("protocol") ? intent["protocol"] : null;
        if (!(written is int) || (int)written != Protocol)
            throw new Unclear("it was started by a Windows Jobs helper of protocol " + (written ?? "unknown")
                + ", and this helper speaks " + Protocol + "; nothing there was changed");
    }

    /// What the attempt runs, encoded without ambiguity exactly as Core and
    /// remote_job.py do (environment keys in code point order).
    static string Digest(IList argv, string cwd, Dictionary<string, object> env, int timeout, Dictionary<string, object> limits)
    {
        MemoryStream data = new MemoryStream();
        Action<string> put = delegate(string text)
        {
            byte[] bytes = Common.Utf8.GetBytes(text);
            byte[] head = Common.Utf8.GetBytes(bytes.Length + ":");
            data.Write(head, 0, head.Length);
            data.Write(bytes, 0, bytes.Length);
            data.WriteByte((byte)',');
        };
        // A start that carries limits is v2 and binds them too.
        put(limits != null ? "yuzuno-remote-job-v2" : "yuzuno-remote-job-v1");
        put(argv.Count.ToString());
        foreach (object item in argv) put((string)item);
        put(cwd);
        List<string> keys = new List<string>(env.Keys);
        keys.Sort(delegate(string a, string b) { return CompareUtf8(a, b); });
        put(keys.Count.ToString());
        foreach (string key in keys) { put(key); put((string)env[key]); }
        put(timeout.ToString());
        if (limits != null)
        {
            put((string)limits["mode"]);
            foreach (string key in new string[] { "cpuMillis", "memoryMiB", "swapMiB" }) put(((int)limits[key]).ToString());
        }
        using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(data.ToArray()));
    }

    /// The limits a start carries (Core's spec), refused when malformed; null
    /// for a start without them (v1).
    static Dictionary<string, object> RequestLimits(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("limits")) return null;
        Dictionary<string, object> limits = request["limits"] as Dictionary<string, object>;
        if (limits == null || !(limits.ContainsKey("mode") && (limits["mode"] as string == "strict" || limits["mode"] as string == "limited")))
            throw new Refused("limits must name mode strict or limited, and cpuMillis, memoryMiB and swapMiB");
        foreach (string key in new string[] { "cpuMillis", "memoryMiB", "swapMiB" })
            if (!limits.ContainsKey(key) || !(limits[key] is int) || (int)limits[key] < (key == "swapMiB" ? 0 : 1))
                throw new Refused("limits must name mode strict or limited, and cpuMillis, memoryMiB and swapMiB");
        return limits;
    }

    /// How an attempt's declared resources are held here: a Job Object holds
    /// both, so strict and limited alike run, with what Windows counts said.
    static Dictionary<string, object> LimitPlan(Dictionary<string, object> limits)
    {
        return Map("mode", limits["mode"], "cpuMillis", limits["cpuMillis"], "memoryMiB", limits["memoryMiB"],
            "swapMiB", limits["swapMiB"], "memory", "limited", "cpu", "limited", "caveats", new List<object> {
                "memory is limited as the Job Object's committed memory (what its processes reserved, paging file included), " +
                "not resident memory as a Linux cgroup counts it; an allocation beyond it fails, nothing is killed",
                "swapMiB has no separate meaning on Windows: the committed-memory limit includes the paging file",
                "CPU is a hard cap on the Job Object's share of all this PC's processors" });
    }

    /// UTF-8 byte order, which is code point order (UTF-16 ordinal order is not).
    static int CompareUtf8(string a, string b)
    {
        byte[] x = Common.Utf8.GetBytes(a), y = Common.Utf8.GetBytes(b);
        for (int i = 0; i < x.Length && i < y.Length; i++) if (x[i] != y[i]) return x[i].CompareTo(y[i]);
        return x.Length.CompareTo(y.Length);
    }

    /// Where the attempt is, from its records and its Job Object. Writes the
    /// outcome when it is settled for certain (a restart, a command never run).
    static Dictionary<string, object> State(string root, Dictionary<string, object> intent)
    {
        Dictionary<string, object> result = Common.ReadJson(Path.Combine(root, "result.json"));
        Dictionary<string, object> started = Common.ReadJson(Path.Combine(root, "started.json"));
        if (result != null) return Map("status", "terminal", "result", result, "started", started);
        string boot = Common.BootId();
        bool supervised = Common.SupervisorAlive(root);
        if (started != null)
        {
            if ((started["bootId"] as string) != boot)
                return Map("status", "terminal", "started", started, "result", Common.Outcome(root, intent, "interrupted",
                    "Windows restarted; this attempt's processes ended with that boot", null));
            int active = Math.Max(0, Common.Active((string)started["jobObject"]));
            bool leader = Common.Alive(started);
            if (supervised)
                return Map("status", leader ? "running" : (active > 0 ? "stopping" : "settling"), "started", started, "processes", active);
            return Map("status", "lost", "started", started, "leaderAlive", leader, "processes", active);
        }
        if (supervised) return Map("status", "starting");
        // The supervisor is gone and recorded no command. The command is
        // resumed only after started.json is written, so nothing ran.
        if (File.Exists(Path.Combine(root, "cancel.json")))
            return Map("status", "terminal", "result", Common.Outcome(root, intent, "cancelled", "Cancelled before the command started", null));
        string why = (intent["bootId"] as string) != boot ? "Windows restarted before the command started"
            : "its supervisor exited before starting the command";
        return Map("status", "terminal", "result", Common.Outcome(root, intent, "rejected", "Not started on this machine: " + why, null));
    }

    static Dictionary<string, object> Start(Dictionary<string, object> request, string host)
    {
        IList argv = request.ContainsKey("argv") ? request["argv"] as IList : null;
        Dictionary<string, object> env = request.ContainsKey("env") ? request["env"] as Dictionary<string, object> : null;
        string cwd = Text(request, "cwd");
        object timeoutValue = request.ContainsKey("timeoutSeconds") ? request["timeoutSeconds"] : null;
        if (argv == null || argv.Count == 0 || !(argv[0] is string) || ((string)argv[0]).Length == 0)
            throw new Refused("argv must be a list of strings whose first names the program");
        foreach (object item in argv) if (!(item is string)) throw new Refused("argv must be a list of strings whose first names the program");
        if (env == null) throw new Refused("env must map strings to strings");
        foreach (object value in env.Values) if (!(value is string)) throw new Refused("env must map strings to strings");
        if (!(timeoutValue is int) || (int)timeoutValue < 1 || (int)timeoutValue > 604800) throw new Refused("timeoutSeconds must be 1-604800");
        if (cwd == null || !Regex.IsMatch(cwd, @"^[A-Za-z]:[\\/]")) throw new Refused("cwd must be an absolute Windows path");
        int timeout = (int)timeoutValue;
        Dictionary<string, object> limits = RequestLimits(request);
        Dictionary<string, object> bound = Binding(request);
        if (Digest(argv, cwd, env, timeout, limits) != (string)bound["digest"])
            throw new Refused("The digest does not match the command sent with it; nothing was started");
        if (host != (string)bound["expectHost"]) return Map("status", "other_host");
        string root = AttemptDir(request, true);
        using (Locked(root))
        {
            Dictionary<string, object> intent = Common.ReadJson(Path.Combine(root, "intent.json"));
            Dictionary<string, object> reply;
            if (intent != null)
            {
                // This start key was used before: the same request finds its
                // attempt, another one is never taken for it.
                string reason = Conflict(intent, bound);
                if (reason != null) return Map("status", "conflict", "reason", reason);
                SameProtocol(intent);
                reply = State(root, intent);
                reply["duplicate"] = true;
                return reply;
            }
            if (File.Exists(Path.Combine(root, "fenced.json")))
                throw new Refused("Core gave up on this start before it arrived; nothing was started");
            if (!Directory.Exists(cwd)) throw new Refused("The working directory " + cwd + " does not exist on this machine");
            Dictionary<string, object> spec = Map("jobId", request["jobId"], "attempt", request["attempt"],
                "argv", argv, "cwd", cwd, "env", env, "timeoutSeconds", timeout);
            if (limits != null) spec["limits"] = limits;
            Common.Atomic(Path.Combine(root, "spec.json"), spec);
            intent = Map("workspaceKey", bound["workspaceKey"], "machineId", bound["machineId"], "digest", bound["digest"],
                "jobId", request["jobId"], "attempt", request["attempt"], "hostId", host, "bootId", Common.BootId(),
                "createdAtUnix", Common.Now(), "protocol", Protocol);
            if (limits != null) intent["limits"] = LimitPlan(limits);
            // The commit point: from here on this attempt exists on this machine.
            Common.Atomic(Path.Combine(root, "intent.json"), intent);
            string failure = Launch(root);
            if (failure != null)
            {
                Common.Outcome(root, intent, "rejected", "Not started on this machine: its supervisor could not start: " + failure, null);
                return State(root, intent);
            }
            DateTime deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(root, "started.json"))
                && !File.Exists(Path.Combine(root, "result.json")))
                Thread.Sleep(50);
            reply = State(root, intent);
            reply["duplicate"] = false;
            return reply;
        }
    }

    /// Starts the attempt's supervisor from the helper's copy on this
    /// machine's own drive, detached and with no handle of this call
    /// inherited (it would hold Core's reply open), and hands it
    /// supervisor.lock, held unshared, before it runs. Null when it started.
    static string Launch(string root)
    {
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string bin = Path.Combine(DataRoot, "bin");
        CheckFolders(new[] { DataRoot, bin }, true);
        string digest = FileDigest(self);
        string copy = Path.Combine(bin, "yuzuno-jobs-helper-" + digest + ".exe");
        if (!File.Exists(copy))
        {
            string temporary = copy + "." + Guid.NewGuid().ToString("N");
            File.Copy(self, temporary);
            try { File.Move(temporary, copy); } catch (IOException) { File.Delete(temporary); }
        }
        // Whatever is there now must be exactly this helper, and a plain file.
        // It stays open, with writing and deleting denied, until the
        // supervisor has been created from it, so it cannot be swapped between.
        if ((File.GetAttributes(copy) & FileAttributes.ReparsePoint) != 0)
            return "the helper's copy at " + copy + " is a link";
        using (FileStream pinned = new FileStream(copy, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            string found;
            using (SHA256 sha = SHA256.Create()) found = Hex(sha.ComputeHash(pinned));
            if (found != digest) return "the helper's copy at " + copy + " is not this helper";
            return StartSupervisor(root, copy);
        }
    }

    static string StartSupervisor(string root, string copy)
    {
        FileStream hold = new FileStream(Path.Combine(root, "supervisor.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        try
        {
            Native.STARTUPINFO startup = new Native.STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
            Native.PROCESS_INFORMATION process;
            string line = Supervisor.CommandLine(new object[] { copy, "supervise", root });
            uint flags = Native.CREATE_SUSPENDED | Native.DETACHED_PROCESS | Native.CREATE_NEW_PROCESS_GROUP | Native.CREATE_UNICODE_ENVIRONMENT;
            // Out of the interop call's Job when Windows allows it, so the
            // supervisor outlives this call; whether it broke away is recorded
            // in launch.json, and whether it must is what the acceptance run checks.
            bool brokeAway = true;
            if (!Native.CreateProcess(copy, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false,
                    flags | Native.CREATE_BREAKAWAY_FROM_JOB, null, root, ref startup, out process))
            {
                int error = Marshal.GetLastWin32Error();
                brokeAway = false;
                if (error != Native.ERROR_ACCESS_DENIED
                    || !Native.CreateProcess(copy, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, flags, null, root, ref startup, out process))
                    return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message;
            }
            try
            {
                IntPtr inChild;
                if (!Native.DuplicateHandle(Native.GetCurrentProcess(), hold.SafeFileHandle.DangerousGetHandle(), process.hProcess,
                        out inChild, 0, false, Native.DUPLICATE_SAME_ACCESS))
                {
                    // Still suspended: it never ran.
                    Native.TerminateProcess(process.hProcess, 1);
                    return "its lock could not be handed over";
                }
                Common.Atomic(Path.Combine(root, "supervisor.handle"), Map("handle", inChild.ToInt64().ToString()));
                Common.Atomic(Path.Combine(root, "launch.json"), Map("breakaway", brokeAway, "atUnix", Common.Now()));
                Native.ResumeThread(process.hThread);
            }
            finally
            {
                Native.CloseHandle(process.hThread);
                Native.CloseHandle(process.hProcess);
            }
            return null;
        }
        finally { hold.Dispose(); }
    }

    /// The attempt's folder and binding for a request about it, or the reply
    /// that says why there is none to act on. A fence makes a missing start final.
    static string Find(Dictionary<string, object> request, string host, bool fence, out Dictionary<string, object> bound,
        out Dictionary<string, object> reply)
    {
        bound = Binding(request);
        reply = null;
        if (host != (string)bound["expectHost"]) { reply = Map("status", "other_host"); return null; }
        string root = AttemptDir(request, fence);
        if (root == null) reply = Map("status", "absent");
        return root;
    }

    static Dictionary<string, object> Checked(string root, Dictionary<string, object> bound, bool fence, out Dictionary<string, object> reply)
    {
        reply = null;
        Dictionary<string, object> intent = Common.ReadJson(Path.Combine(root, "intent.json"));
        if (intent == null)
        {
            if (!fence) { reply = Map("status", "absent"); return null; }
            if (!File.Exists(Path.Combine(root, "fenced.json"))) Common.Atomic(Path.Combine(root, "fenced.json"), Map("atUnix", Common.Now()));
            reply = Map("status", "fenced");
            return null;
        }
        string reason = Conflict(intent, bound);
        if (reason != null) { reply = Map("status", "conflict", "reason", reason); return null; }
        SameProtocol(intent);
        return intent;
    }

    static Dictionary<string, object> Status(Dictionary<string, object> request, string host)
    {
        bool fence = request.ContainsKey("fence") && request["fence"] is bool && (bool)request["fence"];
        Dictionary<string, object> bound, reply;
        string root = Find(request, host, fence, out bound, out reply);
        if (reply != null) return reply;
        using (Locked(root))
        {
            Dictionary<string, object> intent = Checked(root, bound, fence, out reply);
            return reply ?? State(root, intent);
        }
    }

    static Dictionary<string, object> Cancel(Dictionary<string, object> request, string host)
    {
        // Only a start this machine never acknowledged may be fenced: a record
        // lost after it was acknowledged is absent, never "not started".
        bool fence = request.ContainsKey("fence") && request["fence"] is bool && (bool)request["fence"];
        Dictionary<string, object> bound, reply;
        string root = Find(request, host, fence, out bound, out reply);
        if (reply != null) return reply;
        using (Locked(root))
        {
            Dictionary<string, object> intent = Checked(root, bound, fence, out reply);
            if (reply != null) return reply;
            if (!File.Exists(Path.Combine(root, "cancel.json"))) Common.Atomic(Path.Combine(root, "cancel.json"), Map("requestedAtUnix", Common.Now()));
            reply = State(root, intent);
            string status = (string)reply["status"];
            if (status == "starting" || status == "running" || status == "stopping" || status == "settling")
            {
                // The supervisor terminates the Job Object and records the outcome.
                DateTime deadline = DateTime.UtcNow.AddSeconds(8);
                while (DateTime.UtcNow < deadline && !File.Exists(Path.Combine(root, "result.json"))) Thread.Sleep(100);
                return State(root, intent);
            }
            if (status == "lost" && StopJob((string)((Dictionary<string, object>)reply["started"])["jobObject"]))
            {
                Common.Outcome(root, intent, "cancelled",
                    "Cancelled; its supervisor was gone, so what was left of its Job Object was stopped here", null);
                return State(root, intent);
            }
            return reply;
        }
    }

    /// Terminates the attempt's Job Object, by the random name its supervisor
    /// recorded, if anything still holds it open, and says whether nothing of
    /// it is left within a few seconds.
    static bool StopJob(string jobName)
    {
        IntPtr job = Native.OpenJobObject(Native.JOB_OBJECT_TERMINATE | Native.JOB_OBJECT_QUERY, false, jobName);
        if (job != IntPtr.Zero)
        {
            Native.TerminateJobObject(job, 1);
            Native.CloseHandle(job);
        }
        DateTime deadline = DateTime.UtcNow.AddSeconds(4);
        while (DateTime.UtcNow < deadline)
        {
            if (Common.Active(jobName) <= 0) return true;
            Thread.Sleep(100);
        }
        return false;
    }

    /// Acceptance only (--test-actions, which Core never passes; the run names
    /// its own --root): terminates this attempt's supervisor, and only it. The
    /// process is opened by its recorded PID, its creation time is checked on
    /// that same handle, and that handle terminates it, so a reused PID is
    /// never hit. Only an attempt folder under this run's data root is used.
    static Dictionary<string, object> KillSupervisor(Dictionary<string, object> request)
    {
        string root = AttemptDir(request, false);
        if (root == null) return Map("status", "absent");
        using (Locked(root))
        {
            Dictionary<string, object> supervisor = Common.ReadJson(Path.Combine(root, "supervisor.json"));
            if (supervisor == null || !(supervisor["pid"] is int)) return Map("status", "absent", "reason", "no supervisor was recorded");
            // SYNCHRONIZE as well: the wait below confirms the termination on this handle.
            IntPtr process = Native.OpenProcess(Native.PROCESS_TERMINATE | Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE,
                false, (int)supervisor["pid"]);
            if (process == IntPtr.Zero) return Map("status", "gone");
            try
            {
                long creation, exit, kernel, user;
                if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)
                    || creation.ToString() != Convert.ToString(supervisor["creation"]))
                    return Map("status", "gone", "reason", "that PID is now another process; nothing was terminated");
                if (!Native.TerminateProcess(process, 1)) throw new Win32Failure("TerminateProcess");
                if (Native.WaitForSingleObject(process, 5000) != Native.WAIT_OBJECT_0)
                    return Map("status", "unconfirmed", "reason", "terminated, but its exit was not seen within 5 s");
                return Map("status", "killed");
            }
            finally { Native.CloseHandle(process); }
        }
    }

    /// Acceptance only (--test-actions): how many processes the attempt's
    /// Job Object holds, by the random name its supervisor recorded (-1: the
    /// Job no longer exists), so a run can show that a cancel left nothing.
    static Dictionary<string, object> JobProcesses(Dictionary<string, object> request)
    {
        string root = AttemptDir(request, false);
        if (root == null) return Map("status", "absent");
        // The supervisor is checked whether or not it recorded a command: a
        // missing started.json does not mean no supervisor was started.
        bool supervised = Common.SupervisorAlive(root);
        Dictionary<string, object> started = Common.ReadJson(Path.Combine(root, "started.json"));
        object active = started == null ? null : (object)Common.Active((string)started["jobObject"]);
        Dictionary<string, object> launch = Common.ReadJson(Path.Combine(root, "launch.json"));
        return Map("status", "processes", "processes", active, "supervisorAlive", supervised,
            "commandRecorded", started != null, "breakaway", launch == null ? null : launch["breakaway"]);
    }

    static Dictionary<string, object> Logs(Dictionary<string, object> request, string host)
    {
        Dictionary<string, object> bound, reply;
        string root = Find(request, host, false, out bound, out reply);
        if (reply != null && (string)reply["status"] != "absent") return reply;
        List<KeyValuePair<long, byte[]>> chunks = new List<KeyValuePair<long, byte[]>>();
        if (root != null)
        {
            Dictionary<string, object> refusal;
            Checked(root, bound, false, out refusal);
            if (refusal != null && (string)refusal["status"] == "conflict") return refusal;
            for (int index = 0; index < 2; index++)
            {
                string path = Path.Combine(root, "log-" + index + ".bin");
                if (!File.Exists(path)) continue;
                byte[] data;
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    data = new byte[Math.Min(stream.Length, Common.Segment + 8)];
                    int read = 0;
                    while (read < data.Length) { int n = stream.Read(data, read, data.Length - read); if (n <= 0) break; read += n; }
                    if (read < data.Length) Array.Resize(ref data, read);
                }
                if (data.Length < 8) continue;
                long at = 0;
                for (int i = 0; i < 8; i++) at = (at << 8) | data[i];
                byte[] part = new byte[data.Length - 8];
                Array.Copy(data, 8, part, 0, part.Length);
                chunks.Add(new KeyValuePair<long, byte[]>(at, part));
            }
        }
        chunks.Sort(delegate(KeyValuePair<long, byte[]> a, KeyValuePair<long, byte[]> b) { return a.Key.CompareTo(b.Key); });
        long oldest = chunks.Count > 0 ? chunks[0].Key : 0;
        long total = chunks.Count > 0 ? chunks[chunks.Count - 1].Key + chunks[chunks.Count - 1].Value.Length : 0;
        object offset = request.ContainsKey("offset") ? request["offset"] : null;
        long requested = (offset is int && (int)offset >= 0) ? (int)offset : (offset is long && (long)offset >= 0) ? (long)offset : Math.Max(0, total - Page);
        long begin = Math.Min(Math.Max(requested, oldest), total);
        long end = Math.Min(begin + Page, total);
        MemoryStream output = new MemoryStream();
        foreach (KeyValuePair<long, byte[]> chunk in chunks)
        {
            long lo = Math.Max(0, Math.Min(begin - chunk.Key, chunk.Value.Length));
            long hi = Math.Max(0, Math.Min(end - chunk.Key, chunk.Value.Length));
            if (hi > lo) output.Write(chunk.Value, (int)lo, (int)(hi - lo));
        }
        return Map("status", "logs", "jobId", request["jobId"], "offset", begin, "nextOffset", end, "oldestOffset", oldest,
            "totalBytes", total, "truncated", requested < oldest, "text", Common.Utf8.GetString(output.ToArray()),
            "retainedBytesLimit", 2 * Common.Segment);
    }
}

/// The attempt's supervisor: a detached copy of this helper started by
/// `start` (`yuzuno-jobs-helper.exe supervise <attempt folder>`), from the
/// helper's copy on a local drive, never from the WSL path, so that it keeps
/// running while WSL or Core restarts.
static class Supervisor
{
    /// How long the Job may take to empty by itself after the command exited
    /// (Windows' console host closing) before what is left counts as left over.
    const int LeftoverGraceSeconds = 5;
    /// How long the supervisor keeps terminating a Job that will not empty
    /// before it gives up without writing an outcome.
    const int StopSeconds = 60;

    public static int Run(string root)
    {
        Dictionary<string, object> intent = Common.ReadJson(Path.Combine(root, "intent.json"));
        Dictionary<string, object> spec = Common.ReadJson(Path.Combine(root, "spec.json"));
        Dictionary<string, object> handed = Common.ReadJson(Path.Combine(root, "supervisor.handle"));
        if (intent == null || spec == null || handed == null) return 2;
        // supervisor.lock, opened unshared by the start that launched this
        // supervisor and kept open for its whole life: whoever can open it
        // knows the supervisor is gone.
        SafeFileHandle hold = new SafeFileHandle(new IntPtr(long.Parse((string)handed["handle"])), true);
        string attempt = (string)intent["attempt"];
        long created, exited, kernel, user;
        Native.GetProcessTimes(Native.GetCurrentProcess(), out created, out exited, out kernel, out user);
        Common.Atomic(Path.Combine(root, "supervisor.json"), Map("pid", System.Diagnostics.Process.GetCurrentProcess().Id,
            "creation", created.ToString(), "bootId", Common.BootId(), "startedAtUnix", Common.Now()));
        if (File.Exists(Path.Combine(root, "cancel.json")))
        {
            Common.Outcome(root, intent, "cancelled", "Cancelled before the command started", null);
            GC.KeepAlive(hold);
            return 0;
        }
        Common.Atomic(Path.Combine(root, "launching.json"), Map("atUnix", Common.Now()));
        Ring ring = new Ring(root);
        IntPtr job, outputRead;
        Native.PROCESS_INFORMATION process;
        string jobName = Common.NewJobName(attempt);
        // The attempt's plan (a start with limits): held by its Job Object,
        // read back before the command may run.
        Dictionary<string, object> plan = intent.ContainsKey("limits") ? intent["limits"] as Dictionary<string, object> : null;
        Dictionary<string, object> held;
        try
        {
            process = CreateCommand(jobName, (IList)spec["argv"], (string)spec["cwd"],
                Environment((Dictionary<string, object>)spec["env"]), plan, out job, out outputRead, out held);
        }
        catch (Win32Failure error)
        {
            Common.Outcome(root, intent, "rejected", "Not started on this machine: " + error.Message, null);
            GC.KeepAlive(hold);
            return 0;
        }
        long commandCreated;
        Native.GetProcessTimes(process.hProcess, out commandCreated, out exited, out kernel, out user);
        Dictionary<string, object> started = Map("jobId", intent["jobId"], "attempt", attempt, "pid", process.dwProcessId,
            "creation", commandCreated.ToString(), "jobObject", jobName, "bootId", Common.BootId(),
            "supervisorPid", System.Diagnostics.Process.GetCurrentProcess().Id, "startedAtUnix", Common.Now());
        if (plan != null)
        {
            Dictionary<string, object> used = new Dictionary<string, object>(plan);
            used["held"] = held;
            started["limits"] = used;
        }
        // Recorded before the command runs a single instruction.
        Common.Atomic(Path.Combine(root, "started.json"), started);
        Native.ResumeThread(process.hThread);
        Native.CloseHandle(process.hThread);
        Thread reader = new Thread(delegate()
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read))
            {
                byte[] buffer = new byte[65536];
                int n;
                while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) ring.Write(buffer, n);
            }
        });
        reader.IsBackground = true;
        reader.Start();
        DateTime deadline = DateTime.UtcNow.AddSeconds((int)spec["timeoutSeconds"]);
        string why = null;
        DateTime lastTerminate = DateTime.MinValue;
        while (Native.WaitForSingleObject(process.hProcess, 200) != Native.WAIT_OBJECT_0)
        {
            if (why == null)
            {
                if (File.Exists(Path.Combine(root, "cancel.json"))) why = "cancel";
                else if (DateTime.UtcNow > deadline) why = "timeout";
            }
            // A cancel or timeout acts at once, and again every second until the command is gone.
            if (why != null && DateTime.UtcNow - lastTerminate >= TimeSpan.FromSeconds(1))
            {
                Native.TerminateJobObject(job, 1);
                lastTerminate = DateTime.UtcNow;
            }
        }
        uint code;
        Native.GetExitCodeProcess(process.hProcess, out code);
        Native.CloseHandle(process.hProcess);
        // The command has exited; nothing of its Job Object may outlive it,
        // and the outcome is written only once nothing is left. After a
        // natural exit, what is still in the Job is recorded (report only),
        // and, only if something is, the Job gets a bounded grace to empty by
        // itself; whatever is still there after it was left by the command.
        Dictionary<string, object> evidence = new Dictionary<string, object>();
        int leftovers = 0;
        if (why == null && Common.Active(jobName) > 0)
        {
            evidence["inJobAtExit"] = Common.Members(job);
            DateTime grace = DateTime.UtcNow.AddSeconds(LeftoverGraceSeconds);
            while (DateTime.UtcNow < grace && Common.Active(jobName) > 0) Thread.Sleep(50);
            leftovers = Math.Max(0, Common.Active(jobName));
            if (leftovers > 0) evidence["leftoverProcesses"] = Common.Members(job);
        }
        // Bounded: if the Job cannot be emptied, no outcome is written (the
        // attempt reads as lost, unknown in Core) rather than a false one.
        DateTime stopBy = DateTime.UtcNow.AddSeconds(StopSeconds);
        while (Common.Active(jobName) > 0)
        {
            if (DateTime.UtcNow > stopBy) { GC.KeepAlive(hold); return 3; }
            Native.TerminateJobObject(job, 1);
            Thread.Sleep(100);
        }
        reader.Join(5000);
        if (plan != null)
        {
            // The plan, what its Job Object held, and the most committed memory
            // its processes reached together.
            Dictionary<string, object> used = new Dictionary<string, object>(plan);
            used["held"] = held;
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION peak = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            if (Native.QueryInformationJobObject(job, Native.JobObjectExtendedLimitInformation, out peak,
                Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero))
                used["peakJobMemoryBytes"] = peak.PeakJobMemoryUsed.ToUInt64();
            evidence["limits"] = used;
        }
        Native.CloseHandle(job);
        string note = leftovers > 0
            ? "; " + leftovers + " process(es) still in its Job Object " + LeftoverGraceSeconds + " s after it exited were stopped" : "";
        object exitCode = (long)code;
        if (why == "cancel" || File.Exists(Path.Combine(root, "cancel.json")))
            Common.Outcome(root, intent, "cancelled", "Cancelled; its Job Object was terminated", exitCode, evidence);
        else if (why == "timeout")
            Common.Outcome(root, intent, "failed", "timeout after " + spec["timeoutSeconds"] + " s; its Job Object was terminated", exitCode, evidence);
        else if (code == 0)
            Common.Outcome(root, intent, "succeeded", "success" + note, exitCode, evidence);
        else
            Common.Outcome(root, intent, "failed", "exit-code " + code + (code >= 0x80000000 ? " (0x" + code.ToString("X8") + ")" : "") + note,
                exitCode, evidence);
        GC.KeepAlive(hold);
        return 0;
    }

    static Dictionary<string, object> Map(params object[] pairs)
    {
        Dictionary<string, object> value = new Dictionary<string, object>();
        for (int i = 0; i + 1 < pairs.Length; i += 2) value[(string)pairs[i]] = pairs[i + 1];
        return value;
    }

    /// This process's environment with the job's entries over it (names
    /// compare without case, as on Windows), as a sorted Unicode block.
    static string Environment(Dictionary<string, object> overrides)
    {
        SortedDictionary<string, string> block = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
            block[(string)entry.Key] = (string)entry.Value;
        foreach (KeyValuePair<string, object> entry in overrides) block[entry.Key] = (string)entry.Value;
        StringBuilder text = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in block) text.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        return text.Append('\0').ToString();
    }

    /// Two segments of 1 MiB, each headed by its start offset (8 bytes, big
    /// endian), as for local and remote Linux jobs.
    class Ring
    {
        readonly string root;
        FileStream file;
        long total;
        int index, used;

        public Ring(string root) { this.root = root; Open(0); }

        void Open(int next)
        {
            if (file != null) file.Dispose();
            index = next;
            used = 0;
            file = new FileStream(Path.Combine(root, "log-" + index + ".bin"), FileMode.Create, FileAccess.Write, FileShare.Read | FileShare.Delete);
            byte[] head = new byte[8];
            for (int i = 0; i < 8; i++) head[i] = (byte)(total >> (56 - 8 * i));
            file.Write(head, 0, 8);
            file.Flush();
        }

        public void Write(byte[] data, int count)
        {
            int at = 0;
            while (at < count)
            {
                int room = Common.Segment - used;
                if (room <= 0) { Open(1 - index); continue; }
                int part = Math.Min(room, count - at);
                file.Write(data, at, part);
                file.Flush();
                used += part;
                total += part;
                at += part;
            }
        }
    }

    /// The command, created suspended inside a new KILL_ON_JOB_CLOSE Job
    /// Object named after the attempt, its stdout and stderr on one pipe.
    /// Returns the process information; the caller records it and only then
    /// calls ResumeThread.
    public static Native.PROCESS_INFORMATION CreateCommand(string jobName, IList argv, string cwd, string environment,
        Dictionary<string, object> plan, out IntPtr job, out IntPtr outputRead, out Dictionary<string, object> held)
    {
        outputRead = IntPtr.Zero;
        held = null;
        // A successful CreateJobObject leaves the last error as it was unless the
        // name existed; clear it so an earlier call's error is never read here.
        Native.SetLastError(0);
        job = Native.CreateJobObject(IntPtr.Zero, jobName);
        if (job == IntPtr.Zero) throw new Win32Failure("CreateJobObject");
        if (Marshal.GetLastWin32Error() == Native.ERROR_ALREADY_EXISTS)
        {
            // Someone else's Job with this name: never configured, used or terminated here.
            Native.CloseHandle(job);
            job = IntPtr.Zero;
            throw new Win32Failure("CreateJobObject (a Job Object with this attempt's name already exists)", Native.ERROR_ALREADY_EXISTS);
        }
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        ulong memoryLimit = 0;
        if (plan != null)
        {
            // Job-wide committed memory: an allocation beyond it fails.
            memoryLimit = (ulong)(int)plan["memoryMiB"] * 1024 * 1024;
            limits.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = new UIntPtr(memoryLimit);
        }
        if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits,
            Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw new Win32Failure("SetInformationJobObject");
        if (plan != null)
        {
            // A hard cap on the Job's share of all processors, per 10,000 cycles.
            int processors = System.Environment.ProcessorCount;
            uint rate = (uint)Math.Max(1L, Math.Min(10000L, (long)(int)plan["cpuMillis"] * 10 / processors));
            uint flags = Native.JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | Native.JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
            Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu = new Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
            cpu.ControlFlags = flags;
            cpu.CpuRate = rate;
            if (!Native.SetInformationJobObject(job, Native.JobObjectCpuRateControlInformation, ref cpu,
                Marshal.SizeOf(typeof(Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION))))
            {
                Win32Failure failure = new Win32Failure("SetInformationJobObject (CPU rate)");
                Native.CloseHandle(job);
                job = IntPtr.Zero;
                throw failure;
            }
            // Read back from the Job Object before any process of the command exists.
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION memoryBack = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpuBack = new Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
            bool read = Native.QueryInformationJobObject(job, Native.JobObjectExtendedLimitInformation, out memoryBack,
                    Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), IntPtr.Zero)
                && Native.QueryInformationJobObject(job, Native.JobObjectCpuRateControlInformation, out cpuBack,
                    Marshal.SizeOf(typeof(Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION)), IntPtr.Zero);
            if (!read || (memoryBack.BasicLimitInformation.LimitFlags & Native.JOB_OBJECT_LIMIT_JOB_MEMORY) == 0
                || memoryBack.JobMemoryLimit.ToUInt64() != memoryLimit || (cpuBack.ControlFlags & flags) != flags || cpuBack.CpuRate != rate)
            {
                Native.CloseHandle(job);
                job = IntPtr.Zero;
                throw new Win32Failure("its Job Object does not hold the limits it was given", true);
            }
            held = Map("jobMemoryLimitBytes", memoryBack.JobMemoryLimit.ToUInt64(), "cpuRate", cpuBack.CpuRate,
                "cpuRatePer", 10000, "processors", processors);
        }
        Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES();
        inheritable.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
        inheritable.bInheritHandle = true;
        IntPtr outputWrite;
        if (!Native.CreatePipe(out outputRead, out outputWrite, ref inheritable, 0)) throw new Win32Failure("CreatePipe");
        // Only the writing end goes to the command.
        Native.SetHandleInformation(outputRead, Native.HANDLE_FLAG_INHERIT, 0);
        Native.STARTUPINFO startup = new Native.STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
        startup.dwFlags = Native.STARTF_USESTDHANDLES;
        startup.hStdInput = IntPtr.Zero;
        startup.hStdOutput = outputWrite;
        startup.hStdError = outputWrite;
        Native.PROCESS_INFORMATION process;
        bool created = Native.CreateProcess(null, new StringBuilder(CommandLine(argv)), IntPtr.Zero, IntPtr.Zero, true,
            Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW,
            environment, cwd, ref startup, out process);
        int error = Marshal.GetLastWin32Error();
        Native.CloseHandle(outputWrite);
        if (!created)
        {
            Native.CloseHandle(outputRead);
            outputRead = IntPtr.Zero;
            Native.CloseHandle(job);
            job = IntPtr.Zero;
            throw new Win32Failure("CreateProcess", error);
        }
        if (!Native.AssignProcessToJobObject(job, process.hProcess))
        {
            int assignError = Marshal.GetLastWin32Error();
            // Never run a command whose processes would not belong to the
            // attempt: the process this call just created, still suspended
            // (it has not run an instruction), is terminated by its own handle,
            // and every handle of this attempt is closed.
            Native.TerminateProcess(process.hProcess, 1);
            Native.WaitForSingleObject(process.hProcess, 5000);
            Native.CloseHandle(process.hThread);
            Native.CloseHandle(process.hProcess);
            Native.CloseHandle(outputRead);
            outputRead = IntPtr.Zero;
            Native.CloseHandle(job);
            job = IntPtr.Zero;
            throw new Win32Failure("AssignProcessToJobObject", assignError);
        }
        return process;
    }

    /// argv as one command line that CommandLineToArgvW (and the Microsoft C
    /// runtime) splits back into the same arguments.
    public static string CommandLine(IList argv)
    {
        StringBuilder line = new StringBuilder();
        foreach (object item in argv)
        {
            string argument = (string)item;
            if (line.Length > 0) line.Append(' ');
            if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                line.Append(argument);
                continue;
            }
            line.Append('"');
            int backslashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') { line.Append('\\', backslashes * 2 + 1); line.Append('"'); }
                else { line.Append('\\', backslashes); line.Append(c); }
                backslashes = 0;
            }
            line.Append('\\', backslashes * 2);
            line.Append('"');
        }
        return line.ToString();
    }
}

class Win32Failure : Exception
{
    public Win32Failure(string call) : this(call, Marshal.GetLastWin32Error()) { }
    public Win32Failure(string call, int code)
        : base(call + " failed: " + new System.ComponentModel.Win32Exception(code).Message + " (" + code + ")") { }
    /// A failure that is no Win32 error code, said as it is.
    public Win32Failure(string message, bool plain) : base(message) { }
}
