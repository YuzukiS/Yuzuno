// T-108 acceptance fixture: small, bounded loads on Windows, as
// acceptance/remote-jobs/load.py gives on Linux (Windows has no Python here).
// The acceptance run compiles it with Windows' own .NET Framework 4 compiler
// into its own folder; it is not part of any release.
//
//   load.exe memory <stepMiB> <maxMiB> <holdSeconds>
//   load.exe cpu <workers> <seconds>
//
// Each prints one JSON line per event, flushed at once:
// - memory commits <stepMiB> at a time (every page written) up to <maxMiB>,
//   printing {"load": "memory", "mib": total} after each step, holds it and
//   exits 0. Where a commit limit refuses a step, it prints
//   {"load": "memory", "mib": total, "refused": step} and exits 3.
// - cpu keeps <workers> threads busy for <seconds>, then prints
//   {"load": "cpu", "workers": n, "wall": s, "cpu": s, "cores": cpu / wall}.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

static class Load
{
    static void Say(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static string Number(double value)
    {
        return value.ToString("0.###", CultureInfo.InvariantCulture);
    }

    static int Main(string[] args)
    {
        int a, b;
        double c;
        if (args.Length == 4 && args[0] == "memory" && int.TryParse(args[1], out a) && int.TryParse(args[2], out b)
            && double.TryParse(args[3], NumberStyles.Float, CultureInfo.InvariantCulture, out c)
            && a >= 1 && a <= 256 && b >= a && b <= 4096 && c >= 0 && c <= 120)
            return Memory(a, b, c);
        if (args.Length == 3 && args[0] == "cpu" && int.TryParse(args[1], out a)
            && double.TryParse(args[2], NumberStyles.Float, CultureInfo.InvariantCulture, out c)
            && a >= 1 && a <= 16 && c > 0 && c <= 120)
            return Cpu(a, c);
        Console.Error.WriteLine("usage: load.exe memory <stepMiB 1-256> <maxMiB up to 4096> <holdSeconds up to 120> | cpu <workers 1-16> <seconds up to 120>");
        return 2;
    }

    static int Memory(int step, int max, double hold)
    {
        List<byte[]> chunks = new List<byte[]>();
        int total = 0;
        try
        {
            while (total + step <= max)
            {
                byte[] chunk = new byte[step * 1024 * 1024];
                for (int i = 0; i < chunk.Length; i += 4096) chunk[i] = 1;
                chunks.Add(chunk);
                total += step;
                Say("{\"load\": \"memory\", \"mib\": " + total + "}");
            }
        }
        catch (OutOfMemoryException)
        {
            Say("{\"load\": \"memory\", \"mib\": " + total + ", \"refused\": " + step + "}");
            return 3;
        }
        Say("{\"load\": \"memory\", \"mib\": " + total + ", \"holding\": " + Number(hold) + "}");
        Thread.Sleep((int)(hold * 1000));
        Say("{\"load\": \"memory\", \"mib\": " + total + ", \"done\": true}");
        GC.KeepAlive(chunks);
        return 0;
    }

    static int Cpu(int workers, double seconds)
    {
        Process self = Process.GetCurrentProcess();
        TimeSpan before = self.TotalProcessorTime;
        Stopwatch wall = Stopwatch.StartNew();
        List<Thread> threads = new List<Thread>();
        for (int i = 0; i < workers; i++)
        {
            Thread thread = new Thread(delegate()
            {
                Stopwatch spin = Stopwatch.StartNew();
                while (spin.Elapsed.TotalSeconds < seconds) { }
            });
            thread.Start();
            threads.Add(thread);
        }
        foreach (Thread thread in threads) thread.Join();
        self.Refresh();
        double used = (self.TotalProcessorTime - before).TotalSeconds;
        double elapsed = wall.Elapsed.TotalSeconds;
        Say("{\"load\": \"cpu\", \"workers\": " + workers + ", \"wall\": " + Number(elapsed) + ", \"cpu\": " + Number(used)
            + ", \"cores\": " + Number(used / elapsed) + "}");
        return 0;
    }
}
