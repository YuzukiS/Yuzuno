# Jobs on a remote Linux machine

A job can run on a registered SSH machine instead of this Core's host: `job_submit` with `machineId` set to the machine's id from the Machines list. The same Jobs panel, `job_get`, `job_logs`, `job_cancel` and mail follow it. Exit status, output and processes belong to that machine. Closing the client, or an SSH connection dropping, is never taken as the job finishing.

Windows on the PC this Core's WSL runs on is a built-in machine of the same kind, reached through WSL interop instead of SSH: see [Windows on this PC](#windows-on-this-pc). A Mac is an SSH machine too, in the limited mode only: see [A Mac over SSH](#a-mac-over-ssh).

## How it works

- **Identity.** Core reaches the machine as the Machines feature does: OpenSSH with that machine's own configuration and keys, in batch mode and with strict host keys. It sends a fixed helper (`core/src/jobs/remote_job.py`) as `python3 -c`, and passes the request as JSON on stdin. Core never reads or copies credentials, and installs nothing resident on the machine.
- **Attempts.** Each attempt has a private folder on the machine, `<data root>/jobs/<jobId>/<attempt>/`. A supervisor there runs the command in its own session and process group, keeps its output in a 2 MiB ring and writes the outcome once.
- **The data root.** Everything Yuzuno writes on a machine is under its data root: `~/.yuzuno` unless the machine entry names another (`dataRoot`, a folder in that account's home such as `~/jobs-lab/.yuzuno`, or an absolute one). Its parent must exist; the root itself is created owner-only. When Core pins the machine for a job, the helper reports the absolute folder that root is there; Core records it before the start leaves, and every later check, cancel and output read goes there. Changing the machine's root affects only jobs pinned afterwards. A job started by a Core from before data roots is in `~/.yuzuno-next` and is still found there.
- **The machine entry.** A job is bound to the machine as it is registered when the job is accepted, read in the same transaction that queues it, with its SSH destination. While the job is unfinished, the Machines page refuses to remove that machine or change its SSH destination. A job never starts at a destination other than the one it was accepted for.
- **Slots.** At most the machine's `maxJobs` attempts hold slots there at once (2 unless set), within its own `budget` when one is set (see Limits). A slot is taken when Core reserves the attempt, before anything is sent, and is kept in Core's database: a Core restart keeps it, and it is released only by an outcome that is certain.

### Starting once

1. **Pin the machine.** Core asks the machine to identify itself (`hello`): a hash of its machine-id (the raw ID stays on the machine) and its boot. Core records that machine with the attempt, and the digest of the request (argv, cwd, env, timeout). Nothing has been started yet; if the machine does not answer, the job waits, and a cancel needs no machine at all.
2. **Record the start, then send it.** Core records that the start is being sent before it sends it, and never sends it twice, including after a restart.
3. **On the machine,** under the attempt's lock, the helper refuses a start for another machine (`expectHost`) or with a digest that does not match its command, before writing anything. It then writes and syncs `intent.json` (Workspace, machine entry, this machine, its boot, the digest). That is the commit point: from then on the attempt exists there, and a repeated start finds it, or answers `conflict` if the same start key comes with another request or Workspace.
4. **Launch.** The supervisor holds a lock for its whole life, so whether it is alive is a fact, not a guess. It writes `launching.json`, forks the command's process, records it in `started.json` (boot, PID, `/proc` start time, process group and session), and only then lets that process run the command. If the supervisor dies before recording it, the process exits without running the command. So when there is no `started.json`, nothing ran.

### Checking an attempt

Every later request names the Workspace, the machine entry, the digest and the pinned machine. A machine that is not the pinned one answers `other_host`, and another record answers `conflict`; neither is ever taken for this attempt.

| What the machine finds | What Core records |
|---|---|
| The supervisor is alive and the command runs | `running` |
| An outcome | That outcome (`succeeded`, `failed`, `cancelled`, `rejected`) |
| The machine restarted since the command started | `interrupted`: its processes ended with that boot (as for local jobs) |
| The supervisor is gone, nothing was recorded as started | `rejected`: nothing ran |
| The supervisor is gone without an outcome | `unknown`, slot held, saying whether the command or other processes of its group still run; a command still running past its timeout is stopped at the next check (see Stopping) |
| Another machine behind the name, another record, an unreadable record, or the attempt's folder gone after the machine acknowledged it | `unknown`, slot held |
| No answer | `unknown`, slot held; you are told once, and the same attempt is checked again when the machine answers |

- **A start that went unanswered.** The next check carries a fence. If the start never arrived, the fence makes that final: a late start is refused, and the job is `rejected`, certainly not started. If it did arrive, it is that same attempt.
- **Unknown keeps the slot.** Only an outcome that is certain releases it. Cancelling an `unknown` attempt goes to the pinned machine; if that machine cannot be reached, or the name now reaches another machine, the slot stays held until it can be.

### Stopping

Cancel and timeouts stop the attempt's process group: TERM, then KILL from 5 seconds on, repeated until no process of the group is left. Each process is checked before every signal: same boot, same process group and session, started no earlier than the command. Where the machine has pidfds, the process is opened before the check, so its PID cannot change hands in between. Nothing is matched by name.

When the command exits on its own, the supervisor stops whatever is left of its group the same way, as systemd does for a local job. The outcome is written only once nothing of the group is left. A cancel after the supervisor died stops the group from the helper, and records `cancelled` only once the group is empty. Each such call waits at most 4 s. KILL follows from 5 s after the first TERM any of them sent, which the helper keeps with the attempt (`stopping.json`: on that boot's monotonic clock, with the command's identity, never moved later), so a process that ignores TERM is stopped by a later call. A record that cannot be read or is not this attempt's never brings a KILL forward; one that cannot be written is reported with the attempt's state, and the next call starts again from TERM.

**A timeout after the supervisor died.** The supervisor records the deadline it counts to (`deadline.json`, on that boot's monotonic clock, with the command's identity). If the supervisor is gone, the first status check that reaches the machine after that deadline, while the command itself still runs as its group's leader, stops the group as such a cancel does (a paused scope is thawed first). Once nothing of the group is left it records `failed`, `timeout after N s; its supervisor was gone, so its process group was stopped here`, which releases the slot. Nothing is applied:
- before the deadline, or while the machine cannot be reached: the timeout is applied by the next check that reaches it, not on time;
- in another boot (the attempt is `interrupted`), or when the deadline's record or the command's identity cannot be confirmed (an attempt started before this record keeps its slot `unknown` until a cancel);
- once the command had exited before a check applied the timeout: its exit status was not recorded, so a child it left behind stays `unknown` until a cancel;
- while something of the group is still running at the end of the call: nothing is recorded, and the next check goes on, with KILL from 5 s after the first TERM, as for that cancel. It goes on also once the command itself has ended on that TERM and only others of its group are left. A stop that a cancel began is left to the cancel and never recorded as a timeout.

**A process group is not a cgroup.** A process that starts its own session or process group leaves the attempt's group. It is not seen, not stopped and not counted by cancel or the outcome. Where the attempt's limits are held in its own systemd scope (see Limits below), every process it starts stays in that scope and under its limits, even one that leaves the group; cancel still stops only the group.

## Limits

Each attempt carries its declared CPU, RAM and swap and the machine's mode, bound by the attempt's digest when it takes its slot. A later change of the machine's mode, a Core restart or a recovery never rewrites a reserved attempt's mode. Before the command runs, the helper reads what the account can enforce:
- whether its systemd user manager answers;
- which cgroup controllers it was delegated;
- whether the kernel accounts swap (`memory.swap.max`);
- whether the account lingers.

- **Holding.** The supervisor moves the command's waiting process, and a keeper that outlives it, into a transient scope of the account's systemd with MemoryMax (MemorySwapMax where swap is accounted, CPUQuota where the cpu controller is delegated). It reads them back from the cgroup. If they are not in force, the command never runs and the job is not started. Peak memory and OOM kills are read while the keeper holds the scope; an OOM kill is named in the outcome. A limit is held only in a scope that lasts: a scope belongs to the account's user manager, which may stop when the account's last session ends unless it lingers.
- **Modes.**
  - `strict`, what a machine added from now on gets, starts nothing a machine cannot hold, a non-lingering account included.
  - `limited` runs with what can be held and records the rest as declared only. On an account that does not linger it holds nothing: no scope is made, and CPU, memory and swap are all declared only. The command then runs in its own process group, as before limits. That only removes the scope that a stopping user manager would end. Whether a process outlives the account's last session still depends on the host's logind settings (`KillUserProcesses`, `UserStopDelaySec`), and is not promised.
  - A machine registered before limits, or set back to it, has no mode: it keeps the record-only behaviour it had. Its attempts carry no limits (digest v1), nothing is held, and nothing is refused for lack of it.
- **Older Cores.** A saved mode, `budget` or `maxJobs` is a setting that Core builds from before limits (core.11 and earlier) would ignore, so while one is saved they cannot open this Workspace. A machine added now is strict, so it is such a setting too. Setting a machine back to record-only, or clearing a setting, does not by itself let them open it again: the other conditions still apply (a machine's data root or containment, Windows' ceiling, unfinished remote or Windows attempts). While an update drains, saving such a setting, or adding a machine without choosing record-only, is refused as other new work is (`workspace_updating`). Nothing is cleared or unlocked automatically.
- **Budgets are not limits.** A machine's `budget` and `maxJobs` decide when an attempt may take a slot: a reservation. Whether its declared CPU and RAM are also held while it runs is the mode's part, above.
- **Where they are set.** An SSH machine's `maxJobs`, `budget` and mode are in its editor on the Machines page (`POST`/`PUT /api/machines`: a setting left out keeps its value, and a new machine is strict unless it says otherwise; null clears a setting, and null for the mode is the record-only one). Windows' ceiling is the Windows cell of the Jobs panel (`POST /api/jobs/windows`, `maxJobs` 1–64 or null for the default). A change applies to attempts that have not taken a slot yet; running ones keep theirs.
- **What a job records.** The running reason and the job's limits say what was held:
  - memory held in its scope or declared only, and swap declared only where the kernel does not account it;
  - the same for CPU;
  - that nothing is held when a limited account does not linger;
  - that limits are only recorded for a record-only machine.
- **Older systemd.** systemd 249 (Ubuntu 22.04) has no `OOMPolicy` for scopes. The scope is asked for again without it only on systemd's exact answer that the property does not exist, after checking that no unit was created.
- **Windows.** The attempt's Job Object holds the declared CPU as a hard cap on its share of all processors, and memory as a job-wide limit on committed memory, read back before the command runs. Committed memory includes the paging file and is not resident memory as a cgroup counts it; an allocation beyond it fails and nothing is killed. The job records the Job's peak committed memory as Windows reports it. Windows' peak counters include a commit it refused, so a job its limit stopped can show a peak above that limit, while the private memory its processes held stayed under it (`acceptance/windows-jobs`, native control).

## Capabilities

| | This host (local jobs) | Remote Linux machine | Windows on this PC |
|---|---|---|---|
| CPU and RAM | Reserved in this host's budget and enforced by systemd (cgroup limits) | Held in the attempt's own systemd scope where the account's user manager has the controllers and lingers, read back before the command runs; `strict` (new machines) starts nothing it cannot hold, `limited` records what is only declared and holds nothing on a non-lingering account; a machine registered before limits only records them (see Limits) | Held by the attempt's Job Object: a hard CPU cap and a job-wide committed-memory limit, read back before the command runs (see Limits) |
| Admission | This host's budget, slots, disk reserve and GPUs | Per machine: `maxJobs` attempts at once (2 unless set), within the machine's own `budget` when set; this host's budget is not used | This host's budget, which Windows and this WSL share (one PC: never counted twice nor added), and at most Windows' `maxJobs` attempts at once (2 unless set, 1–64, in this host's Jobs settings: `POST /api/jobs/windows`); only a ceiling, never extra budget |
| GPU admission | By device UUID (T-106) | Not available. A request with `gpu` is refused | Not available. A request with `gpu` is refused |
| Exclusive | Alone among this host's jobs | Not available. Refused | Not available. Refused |
| Pause and resume | Freezes the job's cgroup (T-107) | Only for an attempt that runs in a scope of its own there (its limits are held: strict, or limited on an account that lingers): the scope is frozen through the account's systemd and read back from its cgroup. Otherwise refused with the reason (see Pause and resume) | Not available. A pause is refused with the reason |
| Git guard | Checked on this host | Not available. Set `guardGit` to `false` | Not available. Set `guardGit` to `false` |
| Inputs | Small files on this host, frozen by SHA-256 at submit and checked again before the command starts; one missing at submit is recorded as missing | Small files on that machine, frozen there at submit and checked again there before the command starts; one missing, unreadable or too large refuses the submit (see Inputs and artifacts) | Small files on Windows, read by its native helper there (never through `/mnt`): a drive path or one relative to `cwd`, frozen by SHA-256 and the final path Windows gives at submit, and checked again while the command is still suspended. One missing, unreadable (a file another program holds open for writing is), not a regular file or too large refuses the submit |
| Artifacts | Checked on this host after a clean exit; downloadable from the job panel | Checked on that machine after a clean exit by the same rules; recorded with the machine and its path there, never copied or downloadable here (see Inputs and artifacts) | Checked on Windows by its native helper after a clean exit, by the same rules; json and jsonl by its own syntax check with stated bounds (see [Windows inputs and artifacts](#windows-inputs-and-artifacts)); recorded with the final path, never copied or downloadable here |
| Outputs | Downloadable from the job panel | Not available: declare artifacts. Refused | Not available. Refused |
| Output | `job_logs` | `job_logs`, read from the pinned machine over SSH | `job_logs`, read through the helper |
| Cancel and timeout | The job's control group | The attempt's process group, each process checked before every signal. A process that leaves the group is not stopped | The attempt's own Windows Job Object, which every child joins |
| Lost connection | Not applicable | `unknown` with the slot held, then the same attempt is checked | A failed interop call, a helper that cannot be run once the start was sent, or a Core restart: `unknown` with the slot held, then the same attempt is checked |
| Runs of stages (T-105) | Yes | Not available. A stage with `machineId` is refused | Not available. A stage with `machineId` is refused |

## Submitting

```json
{
  "requestId": "eval-2026-10-18",
  "taskId": "T-1",
  "name": "Evaluate on the lab box",
  "machineId": "<id from the Machines list>",
  "cwd": "/home/me/project",
  "argv": ["/home/me/project/.venv/bin/python", "-m", "eval.run", "--config", "configs/eval.yaml"],
  "env": {"HOME": "/home/me", "PATH": "/home/me/project/.venv/bin:/usr/bin:/bin"},
  "resources": {"cpuMillis": 4000, "memoryMiB": 8192, "swapMiB": 0},
  "guardGit": false,
  "timeoutSeconds": 14400
}
```

- `cwd` and every path are on that machine.
- Pass the environment the command needs. It does not inherit a login shell's.
- Keep the project's own scheduling and frameworks inside the command; this executor runs one command per attempt.
- The machine needs Linux, `python3` 3.6 or newer, and a machine-id (`/etc/machine-id`). Without a machine-id, Core cannot tell it apart from another machine reached by the same name, and refuses to start there. If the machine cannot run the helper (no `python3`, or one too old for it), the job ends not started, with the shell's message, before anything is sent there. Other failures of the helper before the start (a crash, a kill) may pass: the job waits and Core asks again.
- The account's shell must be POSIX-compatible (sh, bash, zsh, dash), because the helper is passed as one quoted `python3 -c` argument. Whatever its login scripts print is ignored. The helper marks its reply line with a nonce Core sends for that call, so nothing else passes for a reply, a forged line included. Several reply lines, a cut-off line, a reply that does not match the exit status, or more than 256 KiB of output count as no reply. Before anything was sent the job waits and Core asks again; afterwards it stays `unknown`.
- The helper keeps its reply line, the mark, the call's nonce and the newline included, within 224 KiB, leaving the rest of the 256 KiB for what login scripts print. A terminal reply that would be longer (many artifacts with long paths) comes without their paths (see Inputs and artifacts); an inspect that would be longer refuses the submit with its size; nothing else can be.
- The attempt's folder is its record. Deleting it while the job is unfinished loses that record: the job stays `unknown`.

## Inputs and artifacts

On an SSH machine both are files on that machine, named from the job's `cwd` there. Core reads nothing on this host for them, whichever machine the submitting Agent runs on, and copies nothing in either direction: there is no file transfer or sync.

- **Inputs are frozen at submit, on the machine.** `job_submit` asks the machine (one SSH call, at most 30 seconds, read-only) for each input's SHA-256, the file its path leads to (links followed) and its size. Each input must be a regular file of at most 2 MiB, and all of them at most 16 MiB together, as on this host.
  - **Refused submits.** An input that is missing, not a regular file, unreadable or too large refuses the submit with the reason, and no job is created. A machine that does not answer refuses it too, as do inputs whose details would not fit one reply (such as 128 inputs with paths of about 1 KB): the reason gives the size. This differs from this host, where an input missing at submit is recorded as missing.
  - **Change during the read.** A file that changes, or a path that is replaced, while it is being read is never frozen.
  - **What the job records.** The machine that answered (`snapshot.hostId`) and how it was registered then (`snapshot.frozenOn`). The job is inserted only if the machine still has the same SSH destination.
  - **Retries.** A repeated submit with the same `requestId` returns the job first inserted, with what was frozen then.
- **Checked again before the start, there.** The attempt starts only on the machine that answered at submit: a name that now reaches another machine is not started, and nothing is sent there. Its supervisor reads every input again after its limits are in place and before the command runs. A missing file, other content or another file at the path rejects the attempt: `Inputs changed on this machine while queued (…); command was not started`.
  - This is a check before the start, not a read-only snapshot of the files while the command runs.
- **Artifacts are checked there after a clean exit.** The rules are those for local jobs (`host.py`):
  - a regular file inside `cwd`;
  - at least `minBytes`;
  - complete JSON (at most 16 MiB) or newline-terminated JSON lines (each at most 16 MiB);
  - its SHA-256, or none above 1 GiB (then only as `bytes`, identified by size and modification time).
  - **Failures.** Any failure fails the job: `Exit 0, but declared artifacts failed verification: …`.
  - **Not checked.** A non-zero exit, a timeout, a cancel or rejected inputs are reported as such, and the artifacts are not checked.
  - **Where results go.** The check is written to the attempt's own `artifacts.json` and returned with its outcome: each file's path there (`absolutePath`), size and SHA-256. `result.artifactsOn` names the machine (`machineId`, `name`, `hostId`).
  - **A reply too long for one reply.** When the outcome with every artifact's check would be longer than one reply may carry (for example 17 or more artifacts with paths of about 4 KB of CJK characters, or 12 with emoji; ASCII paths never reach it within submit's limits), the machine reports each check without its path and absolute path, by its index and the SHA-256 of its path. Core puts each declared path back where that SHA-256 matches. `result.artifactsOmitted` says what was left out: the fields, the number of checks, the size the reply would have been, any check that matched no declared artifact, and where the whole check is (the attempt's `artifacts.json` on that machine). The reason says so too. The outcome, its reason and exit, and every check's result are as reported; the absolute paths are not copied here.
  - **No download.** The job panel shows the machine and path and offers no download. The artifact download endpoint refuses a remote job.
- **Files from before.** Each artifact records whether its path held a file before the command ran (`preExisting`) and, if so, whether that file is unchanged (`unchangedSinceStart`). This is an observation, not a verdict: a file left by an earlier run passes when it meets the rules, as on this host. For an output that only this attempt can have written, give it a path of its own (for example, one that names the run). The receipt is always this attempt's own: another attempt's `artifacts.json` is never read.
- **The digest binds them.** An attempt with inputs or artifacts is pinned with digest v3, which binds:
  - each input's path, resolved path and SHA-256;
  - each artifact's path, format and `minBytes`;
  - whether limits are carried.

  An attempt without inputs or artifacts (empty lists included) keeps v1 or v2, byte for byte.
- **Older Cores.** While a remote job is queued, Core builds from before data roots cannot open the Workspace (older_cores.rs). They also cannot open it while a machine has a setting they would ignore (a mode, which every machine added now has; a budget; or `maxJobs`), or while an attempt runs outside the legacy root. Otherwise such a Core may open it with a started v3 attempt:
  - it sends each request with the digest pinned with the attempt and does not compute it again after the start (core.11: `bound` in remote.rs);
  - its helper checks the digest only at a start (core.11: `start` in remote_job.py);
  - the attempt's own supervisor, already running, still applies the input and artifact checks.

  That Core reports the outcome and its reason, without the per-file artifact details.
- **Bound at submit.** A job with inputs or artifacts is bound when it is submitted, not when it starts: its digest (the v3 request, with the limits mode the machine has then) is recorded with the job and marked `prebound`. This is what a Core that knows data roots but not inputs and artifacts (a build from T-137 slice A up to the one before them; no release was cut in between) does with such a job if it opens the Workspace while the job is still queued, as after a rollback: it pins the machine as usual but keeps the recorded digest (it records a digest only where none is), sends its own shorter request with it, and the machine refuses that start before writing anything. The job ends as not started, with that reason, and its command never runs without its checks. This is a **safe fail**, not support for running such a job on that Core. Core builds from before data roots (core.11 and earlier) cannot open the Workspace while it is queued (above).
- **Its mode is the one it was bound with.** If the machine's limits mode changes while the job waits, it is not started (the reason says to submit it again): it is neither run in the mode it was bound with nor bound again. Its slot and budget are admitted when it starts, as for every job.

## Pause and resume

The user can pause a remote job as a local one (T-107), only when its attempt runs in a scope of its own on the machine: the transient systemd scope that holds its limits there (a strict machine, or a limited one whose account lingers).

- **What is frozen.** Only that scope, and only once the helper has proven it is this attempt's:
  - the unit named for the attempt (`yuzuno-remote-job-<attempt>.scope`), as its supervisor recorded it with its cgroup;
  - which the account's systemd still describes as this attempt's, with that cgroup;
  - in the boot its processes started in.

  No path in a request is used, and the account's session scope or another job is never touched.
- **Read back.** The freeze or thaw goes through the account's systemd (`systemctl --user freeze`/`thaw`), and the job is `paused` only once the scope's own `cgroup.events` reads frozen. One that has not taken hold after 8 s is `requested` (pausing) or `resuming`.
- **What stays.** Memory and the machine's reservation stay, and the job keeps `status: running` and its slot. Its timeout keeps counting: the supervisor, outside the scope, stops a paused job that reaches it.
- **Cancel and timeouts while paused.** The scope is thawed first, so its processes act on TERM, then its process group is stopped as usual. The same happens when the supervisor is gone and cancel stops what is left, except that nothing reads the attempt's output any more: a process that writes output after the TERM (a shell reporting the child the TERM ended, for instance) ends on SIGPIPE before its own handler runs.
- **A lost reply.** A pause or resume whose reply does not come back is `unknown`, never taken for paused or running. Each status reply carries the scope's freezer state, which settles it. A scope frozen or thawed outside Yuzuno is shown as such.
- **No scope of its own.** A record-only machine, or a limited machine whose account does not linger, cannot pause: the pause is refused with the reason and nothing is changed. Nothing is stopped with signals instead, and the account's linger or sshd is never changed to make it possible.

## Windows on this PC

`machineId: "windows"` runs a job on Windows on the PC this Core's WSL runs on. It is a built-in machine, not a Machines entry. Core offers it only when it runs in WSL with Windows interop on; a Core on plain Linux has no Windows machine. Everything in [How it works](#how-it-works) holds there too: the machine is pinned before the start, the start is recorded before it is sent and never sent twice, a start that never arrived is fenced, and whatever cannot be settled for certain is `unknown` with its slot held.

### Requirements

- Windows x64 with .NET Framework 4 (v4.0.30319), which Windows 10 and 11 include. Nothing is installed on Windows.
- A Core running in WSL with Windows interop on.
- A Core release that ships the helper (below). A release without it does not run Windows jobs.

### The helper

- Core runs a native Windows helper for every call. The request goes in as JSON on stdin, and the reply comes back as one line marked with the call's nonce, exactly as for the Linux helper.
- The helper is `core/src/jobs/windows_job.cs`, built by the C# compiler that ships with Windows' .NET Framework 4. No PowerShell is used, and no execution policy or other Windows setting is read or changed.
- **It ships in the signed Core release** as `runtimes/windows-jobs/yuzuno-jobs-helper.exe` with `windows-helper.json`, and is never compiled on a user's machine.
  - `tools/build-windows-helper.py`, run as a Job on a WSL host, builds it from a named commit with fixed flags (`/noconfig /target:exe /platform:x64 /optimize`, references `System.dll`, `System.Web.Extensions.dll` and `System.Management.dll`, no debug symbols). Its record keeps the source commit and the source's SHA-256, the compiler's path, SHA-256 and version line, the flags, the protocol, and the helper's SHA-256 and size.
  - That compiler is not deterministic: it stamps a time and a module ID into the file, so a rebuild gives other bytes. The committed file is the release input; its record and the Job that built it say where it came from. Neither is a reproducible build.
  - Committed as `runtimes/windows-jobs/`, it is a fixed release input. `tools/build-core-artifact.py` refuses it unless its record names this tree's `windows_job.cs` by SHA-256 and its protocol. `tools/package-release.py --windows-helper` ships it only if its bytes, size and execute bit match the record. `tools/core-release.py` requires the package to equal the fixed inputs, and the release signature covers it like every other file.
- **Core runs only those bytes.** A managed Core takes the helper's path and SHA-256 from its release manifest, verified when it starts, and reads the file again before every call. A file in an installed release that no longer matches its manifest also fails that release's verification, so Core does not start from it. A development Core uses a helper only when given one explicitly, `YUZUNO_WINDOWS_JOBS_HELPER` with `YUZUNO_WINDOWS_JOBS_HELPER_SHA256`; a managed Core ignores both. There is no copy in the data folder to fall back to.
- **When the helper cannot be used** (no helper in the release, other bytes, another protocol, or WSL interop off), nothing is run. Before the start was sent, the job ends as not started, with the reason. Once the start was sent, the attempt is `unknown` with its slot held, and Core checks the same attempt again when the helper can be used; it is never ended or started again because of this.
- **Identity.** `hello` reports the helper's protocol, and Core starts nothing with a helper that speaks another one. It also reports a salted hash of the installation's `MachineGuid` (never the value itself), the boot time and the Windows version from WMI, and the SHA-256 of the answering file. Core keeps what it checked and what the helper said of itself apart, with the attempt (`remote.helper`); the helper's own word is only reported.

### Upgrades and rollback

- A running attempt's supervisor runs from the helper's own content-addressed copy, `<data root>\bin\yuzuno-jobs-helper-<SHA-256>.exe`, so replacing Core never replaces the program a running attempt depends on. Those copies and every attempt folder stay as they are: nothing is cleaned up automatically, and no unknown folder is deleted.
- An attempt that an older Core already pinned (with the digest of its request without limits) but had not yet started is started as it was pinned: without limits, its CPU and RAM declared only, and said so. Any other attempt carries its limits.
- Each attempt records the protocol of the helper that started it. The helper of any release that speaks the same protocol checks, cancels and reads it. A helper of another protocol answers that it is unclear for status, cancel and output alike, before it writes anything there; Core shows the attempt `unknown` with that reason and its slot held. Nothing is recovered automatically.
- A release can be rolled back to when its install format is compatible. That does not mean it can manage the Windows attempts of a newer one: a release without the helper, or with one of another protocol, leaves them as described above, and a release from before Windows jobs does not handle them at all.
- A release from before data roots (core.11 and earlier) looks only in `%LOCALAPPDATA%\yuzuno-next` and `~/.yuzuno-next`. It would report an attempt sent elsewhere whose start reply was lost as not started while it may run, and it does not count Windows Jobs in this PC's budget. So while any Windows Job, or any remote Job not started or started in another root, is unfinished, such a release cannot open the Workspace at all: its lock file is read-only and that release stops before it reads anything. The same holds while an open remote Agent is in another root or contained, or a machine has its own root, containment or Jobs limits (a mode, budget or maxJobs). Any SSH machine added by this release has one, since it is strict unless it chose record-only (`limitMode: null`), which keeps it out of this rule. Nothing is changed to lift it; it lifts when Core next starts or stops with none of these left.

### Attempts and processes

- Everything the helper writes is under its data root, `%LOCALAPPDATA%\YuzunoData\windows-jobs` by default (outside `%LOCALAPPDATA%\Yuzuno`, where the desktop app installs, so installing, updating or removing the app leaves it alone): each attempt's private folder `jobs\<jobId>\<attempt>\`, with the same records as on Linux, and the copies in `bin\`. A folder in that chain, or a parent of the root, that is a link (reparse point) is refused.
- **The supervisor** is a detached copy of the helper started from that local copy. It inherits no handle (it would hold Core's reply open) and is given its lock by handle duplication. It leaves the interop call's Windows Job when Windows allows it; whether it did is recorded.
- **The command** is created suspended inside a Windows Job Object of its own, named after the attempt and 128 random bits; a name that already exists is refused. It is recorded in `started.json` (PID, creation time, Job name, boot) and only then resumed. Every process it starts joins that Job, so the tree belongs to the attempt; nothing is matched by process name or command line. The Job is kill-on-close: if the supervisor dies, the attempt's processes end with it, and Core shows the attempt `unknown` with its slot held until a cancel settles it.
- **Cancel and timeout** terminate that Job Object at once, and again every second until it is empty. The outcome is written once the Job holds no process.
- **After a natural exit,** the helper records what is in the Job at that moment (PID, image, creation time). Only if something is, the Job gets up to 5 s to empty by itself (a console command's host closes by then). What is still in it after that was left by the command: it is stopped, counted in the reason and listed with the outcome. A command that leaves a background `ping` ends as `success; 2 process(es) still in its Job Object 5 s after it exited were stopped`: the ping and the console host it kept open. Names are for the record only; the Job Object decides what belongs to the attempt. If the Job cannot be emptied within 60 s, no outcome is written and Core shows the attempt `unknown`.

### Submitting to Windows

```json
{
  "requestId": "isaac-smoke-2026-10-18",
  "taskId": "T-1",
  "name": "IsaacLab smoke test on Windows",
  "machineId": "windows",
  "cwd": "C:\\work\\project",
  "argv": ["C:\\work\\project\\.venv\\Scripts\\python.exe", "-m", "smoke"],
  "resources": {"cpuMillis": 4000, "memoryMiB": 8192, "swapMiB": 0},
  "guardGit": false,
  "timeoutSeconds": 3600
}
```

- `cwd` is a Windows drive path, such as `C:\work`, and every path is on Windows.
- The command keeps its Windows environment. No Linux `PATH` or `LANG` is added; `env` entries override variables of the same name, compared without case.
- Name programs by full path where you can. `C:\Windows\System32\cmd.exe /d /c …` turns off cmd's AutoRun.

### Windows inputs and artifacts

`inputs` and `artifacts` work as on a Linux machine, with Windows paths, and are files of this PC's Windows: its native helper reads and checks them there. Core never reads them through `/mnt`, never copies or downloads them, and nothing of this host is resolved for them.

- **Paths.** An input is a drive path (`D:\data\a.txt`) or a path relative to `cwd`; an artifact is a path relative to `cwd`. `\` and `/` both separate; `..`, a drive-relative `C:x`, a rooted `\x` and a `:` (an alternate data stream) are refused at submit.
- **Which file.** The helper opens the path once, links followed, and reads everything on that handle: the final path Windows gives (case and `\\?\` normalized by Windows; a mapped drive may name its network share), and the file's identity (volume serial number, file index, size, last write and change time) before and after, with the path opened again after. A file replaced or written meanwhile is never taken for the one read. An artifact counts only if its final path is inside the final path of `cwd`.
- **Sharing.** While a file is read, writers and deleters are refused. A file another program holds open for writing, or without sharing it, cannot be read: an input then refuses the submit, an artifact fails its check. It is not retried.
- **Inputs** are frozen at submit with their final path and SHA-256 (at most 2 MiB each, 16 MiB together) and checked again by the supervisor while the command is created but still suspended in its Job Object: one that changed means not started. This is a check before the start, not a read-only snapshot while the command runs, and no protection against this account's own programs rewriting files.
- **Artifacts** are checked after a clean exit as on this host: a regular file, at least `minBytes`, SHA-256 up to 1 GiB, json up to 16 MiB whole, jsonl read in the same 1 MiB steps with lines up to 16 MiB and a terminated last line. What each path held before the command ran is recorded (`preExisting`, `unchangedSinceStart`), not judged.
- **JSON.** json and jsonl are read by the helper's own syntax check, which follows Python's `json.loads` on bytes (the rule this host and Linux machines use) and builds nothing: the encoding as `json` detects it (UTF-8 with or without its byte order mark, UTF-16 or UTF-32), strict decoding that lets surrogates pass, scalars as whole documents, NaN, Infinity and -Infinity accepted, nothing after the value; for jsonl, lines that are only whitespace are skipped. Its bounds are its own and stated: nesting deeper than 1000 levels, or an integer of more than 4300 digits, leaves the check **not completed** (the artifact is not verified, and the reason says so), never called malformed. Python's own limits depend on its version (3.14 here reads 5000 levels and refuses 100000 levels and integers over 4300 digits), so these are the only deliberate differences. `acceptance/windows-jobs/json_diff.py` compares the two on the same bytes.

## A Mac over SSH

A Mac registered on the Machines page runs jobs as any SSH machine does: the same helper over `python3 -c`, the same pinning, start-once, fencing, `unknown` with the slot held, and cancel of the attempt's process group (T-186). What differs is what macOS can hold.

- **Requirements.** A `python3` of 3.6 or newer. macOS's `/usr/bin/python3` is Apple's stand-in until the Command Line Tools are installed (`xcode-select --install`); with only the stand-in, a job is not started and the reason says so. Tested with Python 3.9.6 from Xcode, on macOS 27.0.1 (arm64). Nothing is installed on the Mac and no daemon is left running.
- **The mode.** Choose `limited` in the machine's editor. macOS has no cgroup, so no CPU, memory or swap limit can be held there: in `strict` (the default for a machine added now) every job is refused before its command runs, with that reason, and nothing is started.
- **What a job is told.** The helper names the platform when Core first pins the machine for an attempt; from then on the job's capabilities are a Mac's, its running reason ends "macOS holds no CPU or RAM limit (it has no cgroup): they are reserved for this Core's admission and recorded only", and its limits carry the helper's own caveats. A job submitted after the machine last answered as a Mac is told so from the start. Before any attempt has reached a machine, Linux or Mac, a job is told that its platform is not known yet and that nothing is promised to be held: its declared resources are reserved for admission and recorded until the machine answers.
- **Admission is unchanged.** The machine's `maxJobs` and `budget` still decide when an attempt takes a slot: a reservation in this Core, not a limit on the Mac.
- **Pause** is refused on a Mac with its reason: pause freezes only an attempt's own scope, and macOS gives an attempt none. Nothing is stopped with signals instead.
- **Identity.** The machine is identified by a hash of its IOPlatformUUID, as a Linux machine is by its machine-id; a boot by `kern.bootsessionuuid`; a process by boot, PID and its start time from libproc. Cancel and timeouts check each process that way before signalling it.
- **Environment.** Jobs get the same default `PATH` as on Linux (`/usr/local/bin:/usr/bin:/bin`), which does not include Homebrew's `/opt/homebrew/bin` on Apple silicon; pass the `PATH` a job needs in `env`.
- **Data root.** As on Linux, `~/.yuzuno` unless the machine names another. A Mac that also runs Yuzuno for other purposes is best given a root of its own for jobs.
- **Tested** (`acceptance/remote-jobs/mac.py`, an isolated Core reaching the Mac over its existing SSH alias): the platform at hello and what the job is told; a run and its output; a failure and a timeout; an input frozen there and an artifact checked there; cancel of the attempt's group, its child included, with another job's process left running; pause and strict refused; a repeated submission and a Core restart mid-run that never start twice; the Mac unreachable mid-run and a lost start reply, each `unknown` with the slot held and then the same attempt, run once. The helper's own checks on the Mac: `core/src/jobs/darwin_job_tests.py`, `core/src/jobs/darwin_end_to_end_tests.py`. The helper's Linux behaviour is unchanged (`helper_test.py`, the executor tests and `check.py`, the same before and after).
- **Not tested.** A real network cut (the unreachable Mac and the lost reply were made on Core's side, by the lab's `ssh` wrapper); a Mac rebooted between a start and its next check; a Mac without the Command Line Tools (the stand-in is recognised from Apple's messages); Intel Macs.

## What was tested

- **The helper on its own** (`acceptance/remote-jobs/helper_test.py`):
  - `hello` without the raw machine-id, and a machine without one is refused;
  - a run that is kept with its output, a repeated start that does not launch twice, and an identity taken from `/proc`;
  - failure, timeout, and a program that cannot be run;
  - cancel of the process tree that leaves other processes alone;
  - a command that exits leaving a child: the outcome is written only after the child is stopped;
  - a supervisor that dies: lost, not finished, until cancel stops the group;
  - a supervisor that dies, then the command exits leaving a child: still no outcome, until cancel stops the child;
  - a supervisor that dies, then its command runs past its timeout: the next status stops the group and records the timeout, and then the same outcome stays. Before the deadline, after the command exited, after a restart, or with a deadline record or a leader that is not this start's: no outcome. A command that ignores TERM, or one that ends on TERM and leaves a child that ignores it: no outcome from the call that sent TERM, KILLed and timed out by a later one, the first TERM's time unchanged; a cancel's stop is never taken for a timeout; a first TERM whose time cannot be recorded: reported, no outcome;
  - a cancel after the supervisor died, with a child that ignores TERM: KILLed by a later call; a first-TERM record that is another attempt's, boot's or process's, on another clock or unreadable never brings the KILL forward and is replaced;
  - pause: an attempt without a scope of its own, or a recorded scope that is not its own, is never frozen; its own scope is frozen, read back from its cgroup and resumed; cancel thaws a paused attempt first, so its processes act on TERM, also when its supervisor is gone, and a paused attempt that reaches its timeout is stopped. The scope tests need this account's systemd user manager with the memory controller, and are skipped where there is none;
  - the same start key with another command, Workspace or a forged digest;
  - another machine behind the name, a fence that makes a start that never arrived final, a restarted machine, an unreadable record, and refusals that start nothing.
  - a terminal reply too long for one reply (Job 85755f3e's sample, and the longest submit allows: control characters, emoji, a folder named in bytes that are not UTF-8): within 224 KiB with every check, its paths left out and named, the whole check kept in `artifacts.json`, the same for a cancel or a repeated start; the frame measured with its mark, nonce and newline; an inspect too long for one reply refused with its size.
- **Core's executor through its own reconciliation** (`core/src/jobs/remote_tests.rs`), over stand-ins for OpenSSH:
  - success with its output, and the attempt pinned to the machine with its digest, Workspace and machine entry;
  - a machine removed between reading it and queueing the job: refused, nothing queued; a new SSH destination before the start: not started, nothing sent;
  - removing a machine or changing its SSH destination, refused while its job is queued, running or unknown, and allowed once it finished;
  - a Core draining for an update starts nothing new there;
  - declared resources that stay out of this host's budget;
  - a lost start acknowledgement: the same attempt is found and runs once;
  - a start that never arrived: fenced, `rejected`, and the late start refused;
  - a Core that stopped after pinning, or after recording the start but before sending it: it neither starts twice nor guesses;
  - a machine that does not answer, which keeps the slot, is told once, and is checked again;
  - a name that now reaches another machine: `unknown` and held, a cancel cannot release it, and it goes through once the name reaches the machine again;
  - a supervisor that dies, then the command exits leaving a sleep child: `unknown` and held until cancel stops the child;
  - a supervisor that dies, then the timeout passes: `unknown` and held until the next check, which stops the command and records the timeout; the slot is released, and each is told once;
  - a supervisor that dies, then a cancel of a command that ignores TERM: `unknown` and held after the first check, cancelled and released by the next;
  - a restarted machine (`interrupted`) and an unreadable record (held, even after a cancel);
  - cancel of the process tree, and a cancel before anything was sent;
  - failures, refusals, per-machine slots, and GPU and stages refused;
  - pause refused for an attempt without a scope of its own there; for one in its own scope, the job as the machine answered, a reply that does not come back settled by the next status, and a status read around a resume settling it once;
  - a machine without `python3`, or with one too old for the helper: not started, with the shell's message, nothing sent; a helper killed at the first contact: the job waits and runs once the machine answers; a helper that breaks after the start was sent: `unknown`, held;
  - a login script that prints to stdout before every command: replies and output are read as usual;
  - forged reply lines (unmarked, or with another call's nonce) with no helper run: never an outcome, the job stays `unknown`. Several reply lines, a cut-off line, a reply that does not match the exit status, or output over the limit are no reply either;
  - a terminal reply too long for one reply (18 artifacts with paths of about 3.8 KB of CJK characters), here reached through a cancel after the attempt had ended: the same attempt ends, released and told once, each check with its declared path back and what was left out named; a check whose path digest matches no declared artifact is shown without a path and counted; inputs too long for one inspect reply refuse the submit with the size.
- **Real OpenSSH on an isolated Core** (`acceptance/remote-jobs/check.py`), with user-level `sshd`s on 127.0.0.1 and the machine registered through the Machines API:
  - a run and its output, and a failure that prints `DONE`;
  - sshd stopped mid-run and started again;
  - a repeated submission and a Core restart mid-run;
  - cancel;
  - the machine's alias re-pointed mid-run at a second `sshd` that has its own host key and machine identity, then pointed back;
  - a supervisor killed mid-run, then its command exiting with a child left;
  - GPU refused, and pause for an attempt without a scope of its own.

  This is the same physical host over loopback, not a separate remote Linux machine. For a real one, see the next section.

## Accepting on an independent machine

These tools in `acceptance/remote-jobs/` check the executor on a real Linux machine that this account can already reach over SSH:

| Tool | What it checks |
|---|---|
| `independent.py --target <alias> [--remote-root <root>] [--clean]` | a run's lifecycle and the machine's limits: the items below |
| `io.py --target <alias> --remote-root <root>` | inputs frozen and artifacts checked there; an input changed while the job is queued; missing and malformed artifacts; a same-named file on this host never read for an input; a start whose reply is lost, with its inputs and artifacts; a failed command told apart from failed artifacts |
| `pause.py --target <alias> --remote-root <root> [--expect scope\|none]` | where the attempt runs in a scope of its own there: the pause read back from its cgroup, a resume whose reply is lost settled by the machine's status, and cancel and a timeout while paused thawing it first. Without one: the pause refused, with nothing changed |
| `rollback.py ... --expect red\|green` | a job with inputs and artifacts, queued by this Core and then handled by an older Core on the same Workspace, as after a rollback: `green` expects it not started there, `red` reproduces a Core from before that check |
| `agents.mjs` | Claude Agents and Jobs on different machines through one isolated Core: an Agent on the remote machine runs a Job on the Core host, and one on the Core host runs a Job on the remote machine. It runs real model turns |

`load.py` is the small CPU and memory load the resource items run there.

- **Guards.** Every connection uses batch mode and strict host keys: an unknown or changed host key stops the run, and it is never accepted. If the Jobs helper reports the same machine identity as this host (loopback, or a namespace of this machine), the run stops there: that is not an independent machine.
- **Read-only first.** It reads the OS, distribution, kernel, `python3` and whether a machine-id exists. The report keeps them, whether the account is root, and the first characters of the app-specific machine hash: never the raw machine-id, the account name or an address.
- **Isolated.** A separate acceptance Core with its own folder and port, so the daily Core and its machine entries are never touched. The machine is registered there with the data root `--remote-root` names (`~/.yuzuno` unless given; its parent must exist), in the limited mode. Short commands (echo, `sleep` up to 60 s, and `load.py`'s loads) run in `<root>/acceptance/<run>` there, and every file the run and its jobs create is under that root. Faults are only the run's own: the acceptance Core's `ssh` is a wrapper that can fail its calls or drop a reply. The machine, its sshd, its account and the network are never touched.
- **Kept.** What a run created there, its folder and its jobs' attempt folders under `<root>/jobs`, is kept as evidence. `independent.py --clean` removes exactly those, and nothing else.
- **What each item covers.** The report of `independent.py` names the coverage of every item. The resource items follow what the machine's helper reports it can enforce: held where it can, recorded as declared only where it cannot, and strict starting nothing it cannot hold.

  | Item | Coverage |
  |---|---|
  | The machine registers and its check reaches it over SSH | the real machine |
  | A run, its output, success and failure, including a failure that prints `DONE` | the real machine; this host's budget is untouched |
  | Strict starts nothing where the machine cannot hold the declared limits | the real machine; the helper's own facts decide |
  | Memory over a 64 MiB limit, the command's own cgroup, and a job within its limit with its peak | the real machine: held in the attempt's own scope where the account can hold memory and lingers; otherwise declared only |
  | CPU of 500 millicores for two busy workers | the real machine: limited where the cpu controller is delegated and limits are held; otherwise declared, and measured as used |
  | A start whose reply is lost | the real machine; the acceptance Core's own `ssh` wrapper drops the reply |
  | The control connection lost mid-run | the real machine keeps running; only the acceptance Core's `ssh` calls fail |
  | Same `requestId`, and a Core restart mid-run | the real machine; the acceptance Core is restarted |
  | Cancel of the process tree; a supervisor killed, with a child left | the real machine; the run kills only its own attempt's supervisor |
  | GPU refused, and pause for an attempt without a scope of its own | the acceptance Core, and the real machine for the paused job. An attempt in a scope of its own is not paused here: `pause.py` checks that |
  | A real reboot | not covered: never done in acceptance; simulated in the fixtures |
  | The SSH name pointed at another machine | not covered there (needs a second machine); covered by `check.py` over loopback |
  | The account's last session ending while a job runs | not covered: no session is logged out and the user manager is never stopped. Whether a process outlives it depends on the host's logind settings, which the run neither reads nor changes |

- **Run so far.** `independent.py`, `io.py` and `pause.py` have each run on one independent Linux machine: Ubuntu 22.04 with cgroup v2, an account that does not linger, and only the memory and pids controllers delegated. Every item of the first two passed there, limited held nothing, and the pause was refused with nothing changed. Still not covered on a real machine:
  - pause and resume in a scope of its own, and cancel or a timeout while paused: that account does not linger;
  - a CPU limit held: its cpu controller is not delegated;
  - a real reboot, the SSH name pointed at another machine, and the account's last session ending;
  - changes made since those runs, such as Core's shared SSH connection for helper calls (T-163), and `independent.py`'s pause item as it is now.

`acceptance/remote-jobs/independent_selftest.sh` runs `independent.py` over a loopback `sshd`, so a change to it can be checked without a remote machine. It covers the unknown host key, the same-machine guard, and every item with `--allow-same-host`, which reports `independent: false`; then that `--clean` leaves nothing under the data root, and nothing outside it in the remote HOME. It is not acceptance on an independent machine.
