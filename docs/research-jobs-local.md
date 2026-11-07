# Jobs on this machine: how Core watches them

A local Job's attempt runs as two transient units of your systemd user manager. Neither Core nor its helper keeps asking systemd about it while it runs: both read the units' own cgroup files, which the kernel keeps up to date. systemd is asked only when something happens to the attempt (T-59).

## The two units

- **The worker** (`yuzuno-job-<jobId>.service`) runs the command with the Job's limits: memory, swap, its CPU grant (below) and at most 512 tasks. It writes the attempt's start receipt (`started.json`: its boot, its systemd invocation and its cgroup) before the command starts. It writes `command.json` once the command exists.
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

- **A process left behind.** A command that exits but leaves a process running in its worker's cgroup keeps the attempt open until that cgroup is empty, as it did before T-59. Such a process might be a `nohup … &`, a daemon or a forked helper. Meanwhile the Job shows running and keeps its reservation.
  - **A leftover that still holds the Job's output:** the command's wrapper waits for it, and the Job's time limit stops it at the end. The outcome reads `timeout`.
  - **A leftover that detached from the output:** the time limit does not end it. The collector records `unknown` at its own deadline (the Job's time plus 20 s), and Core settles the attempt once the cgroup empties, or when it is cancelled.

  What T-59 changed is only how the collector waits: it reads the cgroup's `cgroup.events` instead of asking systemd every 0.5 s.
- **Core restarts.** Nothing about an attempt is kept in memory across a restart. The new Core reads the same files and asks what they call for. An attempt that ended while Core was stopped is settled on its first tick.
- **The machine restarted.** An attempt of an earlier boot is recorded `interrupted`.
- **The collector died or was stopped.** The worker goes on. Core asks once when the collector's cgroup goes, and again once the worker's cgroup empties; then it records the outcome from systemd itself. Until then the worker's own systemd time limit still applies, but no collector enforces a service run's end time.
- **The collector's launch record is still missing** 30 s after Core first saw the attempt. Core asks systemd itself.
- **A helper run fails** (for example, systemctl timed out). The attempt shows `unknown` with the reason, and Core asks again on the schedule above.

## How many Jobs there are

`job_budget` counts this host's own Jobs three ways, and the top bar's Jobs badge shows them as running / queued / waiting:
- `activeCount`: those holding one of the `maxActive` slots;
- `queuedCount`: those waiting in the queue;
- `waitingCount`: those that exist but wait for an earlier stage of their run, or for its analysis (T-69). They are not in the queue until that stage succeeds, so neither of the other two counts them.
  A stage that can't start until someone retries or cancels is not counted: one behind a stage that failed, was cancelled or has an unknown outcome (directly or through another waiting stage), or one held back by the run's cost limit. Its run shows it as failed, unknown or blocked.

## A Job's CPU: the grant and the raise

A Job asks for CPU as one value (`cpuMillis`) or as a range (`cpuMillisMin` up to `cpuMillisMax`, with `cpuPolicy`) (T-64). Admission reserves the minimum and the collector, as it reserved `cpuMillis` before. What the Job runs with is Core's grant.

**At the start.** In the transaction that reserves it, Core decides the grant:
- `grant = clamp(free − headroom, min, max)`;
- free is the budget less what every Job holding it has now: its current grant and its collector, or, for a Job without a grant (a Windows Job, or one reserved by an older Core), its reservation;
- headroom is the Job's own collector, 100 mCPU;
- the grant is the minimum while another queued local Job waits for CPU, and always with `cpuPolicy: "fixed"`;
- a Job with one value has min = max, so its grant is that value, as before.

**Which queued Jobs wait for CPU** (YN-6). A queued Job waits for CPU when only CPU, or nothing, keeps it from starting: it would start if its CPU need were zero.
- One that fits and waits only for its turn counts too. Admission starts one Job per pass, so a burst of Jobs that all fit starts at their minimums but the last, as before, and the quotas stay within the budget.
- One waiting for its RAM or swap reservation (even if it is also short of CPU), for host memory or behind a Job that is, for a GPU, for disk space, for a slot, for an exclusive Job or for its executor's release does not count. Neither does a run's stage waiting for its upstream, which is not queued yet.
- Admission reads this in the transaction that reserves a Job, with the scan's own checks and order. For the Job it reserves, it reads the others after that Job holds its reservation, slot and GPUs. When it reserves none, it reads them as they are, and if none waits for CPU it plans the raises in that same transaction.
- `job_budget`'s `cpuWaiting` gives how many waited for CPU at the last pass (`count`) and since when (`since`, null with none). It is 0 with nothing queued and null before any pass.

The grant becomes the worker's `CPUQuota` (cgroup `cpu.max`), and its `CPUWeight` is its minimum / 20, so that 2000 mCPU is systemd's default of 100. The worker checks both before the command starts. The Job records the grant and its inputs: `cpuRequested`, `cpuGrantedAtStart`, `cpuGrant` and `cpuCurrent`. `cpuGrant` has the budget, held, free, headroom, queue length, maxActive and time, and also:
- `cpuWaiting`: how many queued Jobs waited for CPU once this one held its reservation;
- `rule`: `range` (the clamp decided it), `cpuWaiting` (they held it at its minimum) or `fixed`;
- `heldBy`: the first of them, in admission order, when `rule` is `cpuWaiting`.

A grant recorded without `rule` was decided by the earlier rule, under which any queued Job held it at its minimum.

**While it runs.** On a Jobs tick that starts no Job and finds no queued Job waiting for CPU, Core raises running elastic Jobs, the oldest start first: each takes what is still free, up to its maximum. Jobs queued for anything else don't stop it.
- The raise is `systemctl --user set-property --runtime <worker> CPUQuota=`, applied by systemd at once; the worker cgroup's `cpu.max`, read back, confirms it.
- Each raise is appended to the Job's `cpuChanges`, with the queue's length then and `cpuWaiting: 0`, and `cpuCurrent` follows it. A raise systemd refused is kept as `cpuRaiseRefusal` and not asked again for the same value.
- Nothing is ever lowered. A Job that starts later, whether queued after the raise or waiting meanwhile for RAM, a GPU or the like, starts at its own minimum or more, so CPU quotas can add up to more than the budget until the raised Jobs end. When Jobs then contend, their weights share the CPU.
- The reservation stays the minimum throughout. Memory is untouched (lowering it is `job_lower_memory`, unchanged).

**What the command reads.** `YUZUNO_JOB_CPU_MILLIS` is the grant at its start. The file `YUZUNO_JOB_CPU_FILE` names holds the grant now, on one line in millicores: Core writes it before the launch, and again after each raise once `cpu.max` allows it. Rust (`available_parallelism`), Cargo, libtest and Ninja read the quota when a process starts, so a raise helps the next process, not one already running.

**Where the weight counts.** `cpu.weight` only shares CPU among siblings of one parent cgroup. The worker units are services in the systemd user manager's `app.slice` (`/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/`), beside each other and their collectors. On the WSL host checked (2026-11-06), Core itself runs in `/init.scope` at the root, outside the user manager. A Job's weight is therefore its share among Jobs only; between Core and the Jobs, `init.scope` and `user.slice` share the CPU at their own weights (100 each there).

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
