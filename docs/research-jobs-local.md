# Jobs on this machine: how Core watches them

A local Job's attempt runs as two transient units of your systemd user manager. Neither Core nor its helper keeps asking systemd about it while it runs: both read the units' own cgroup files, which the kernel keeps up to date. systemd is asked only when something happens to the attempt (T-59).

## The two units

- **The worker** (`yuzuno-job-<jobId>.service`) runs the command with the Job's limits: memory, swap, CPU and at most 512 tasks. It writes the attempt's start receipt (`started.json`: its boot, its systemd invocation and its cgroup) before the command starts. It writes `command.json` once the command exists.
- **The collector** (`yuzuno-job-<jobId>-collector.service`) is `host.py supervise`, outside the worker's limits (64 MiB, a tenth of a CPU, 16 tasks). It starts the worker and records how the attempt ended, so an outcome is recorded even while Core is stopped or restarting. Its first record is `launch.json`, with its own cgroup.

## While an attempt runs

**The collector:**
1. It starts the worker with `systemd-run`, then asks systemd once for the worker's invocation and cgroup.
2. Every 0.5 s it reads that cgroup's own files: `cgroup.events` (whether anything still runs in it) and `pids.*` (the counters an outcome keeps). It also checks the run's end time.
3. A service run's absolute end is recorded in `deadline.json` before the worker is sent SIGTERM, and SIGKILL follows 3 s later.
4. Once the cgroup is empty, the collector asks systemd how the worker ended. It asks again every 0.5 s to 2 s until systemd can say. Then it records the outcome (`result.json`) and stops and resets the worker's unit.
5. If no ending can be read within the run's time plus 20 s, the outcome is `unknown`.

**Core,** every 2 s (or at once when a Job changes):
1. It reads each active attempt's records and both units' `cgroup.events`.
2. An attempt that runs as before starts no process. Its pause state comes from the worker's `cgroup.events`.
3. Core starts the host helper (`python3 host.py`, with the systemctl calls it makes) only when the files say one of these happened:
   - the worker started: its first running reading keeps systemd's own evidence;
   - the command's own start was recorded;
   - an outcome was recorded and nothing of either unit runs any more: the attempt is settled and its reservation released;
   - the worker ended with its collector gone, or the collector ended with no outcome;
   - the attempt belongs to an earlier boot;
   - a cancel was asked: the helper stops both units, and is asked again when their cgroups change;
   - a record or a cgroup file can't be read.

**When the helper runs again:**
- **A worker that ended while its collector runs** is the collector's to record. Core waits 2 s for that before asking itself.
- **A state that is the same as when the helper was last asked about it** is asked about again after 2 s, then 4 s, and so on up to once a minute. A change is asked about at once.

**Process count:** one attempt that ends normally starts fewer than twenty processes all told:
- the helper two or three times: its start, its command's start if that came later, and its settling, each with two systemctl calls;
- five or six systemd calls of the collector's own.

That count doesn't depend on how long the attempt runs or how many Jobs run beside it.

## When something goes wrong

- **Core restarts.** Nothing about an attempt is kept in memory across a restart. The new Core reads the same files and asks what they call for. An attempt that ended while Core was stopped is settled on its first tick.
- **The machine restarted.** An attempt of an earlier boot is recorded `interrupted`.
- **The collector died or was stopped.** The worker goes on. Core asks once when the collector's cgroup goes, and again once the worker's cgroup empties; then it records the outcome from systemd itself. Until then the worker's own systemd time limit still applies, but no collector enforces a service run's end time.
- **The collector's launch record is still missing** 30 s after Core first saw the attempt. Core asks systemd itself.
- **A helper run fails** (for example, systemctl timed out). The attempt shows `unknown` with the reason, and Core asks again on the schedule above.

## Reading a running Job

`job_get`'s `usage` of a running local Job is read from the worker's cgroup, with no helper run. It uses systemd's names and units:
- `MemoryCurrent`, `MemoryPeak`, `MemoryMax` and `MemorySwapMax`, in bytes;
- `CPUUsageNSec`, in nanoseconds;
- `TasksMax`.

A limit that is unset reads `infinity`. `usage` is `null` once the worker's cgroup is gone; the outcome's systemd evidence then has the totals. `job_get` still runs the helper once for the attempt's own reports (artifacts, usage files, progress).

## What this replaced

Before T-59:
- the collector ran `systemctl --user show` every 0.5 s for each running Job;
- Core ran `python3 host.py reconcile` every 2 s for each active Job, each run making one or two `systemctl show` calls;
- `job_get` ran `python3 host.py inspect` (one more `systemctl show`) on every read.

A slow systemd also made such a Job show `unknown` briefly whenever one of those calls timed out.
