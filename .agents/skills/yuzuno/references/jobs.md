# Jobs

Jobs run a command on the Core host under a reserved share of the machine and report the outcome through your mailbox. They are for local work; remote CI is watched with the `ci_*` tools instead. Exact fields and limits are in the `job_*` tool schemas.

## Finding a Job

MCP `job_list` defaults to your own Agent and compact rows, with 10 entries per history/live page. Use `job_get` for a known Job's full details; listing is for discovery, not polling.

- An explicit `agentId` or `taskId` does not also add your own Agent. A task filter includes work by every Agent on that task unless you explicitly narrow it.
- Use `scope: "workspace"` to discover Jobs across the Workspace. Use `projectId` (or `scope: "project"` with `projectId`) to select by the Job's task's current Project. `projectId: null` selects tasks without a Project, regardless of the Agent's Project. Moving an Agent does not move its Jobs' task membership. These filters are not access controls.
- `limit` is 1–50, default 10, for **each** history and live page. `compact: false` returns the previous list fields, still without environment variables. It does not return full Job detail.
- `jobs` is the history page, including live Jobs, newest first. Pass `nextBefore` as `before` while `hasMore` is true, preserving filters. Existing integer history cursors still work.
- The live page is independent of history: it includes queued/waiting Jobs and Jobs holding reservations, including unknown outcomes. `liveJobIds` identifies that page; `liveJobs` supplies only its rows absent from `jobs`, so a response never repeats a Job's full row. Follow `nextLiveBefore` as `liveBefore` while `liveHasMore`, keeping filters. An empty `liveJobs` can mean all live rows are already in `jobs`; check `liveJobIds` and `liveHasMore` rather than interpreting it as no active work.
- Both pages are current observations, not a frozen snapshot. Omit `liveBefore` for a fresh first live page when intentionally checking new work; retain seen IDs across pages if you need a unique collection. At most twice `limit` distinct rows are serialized in a response. The GUI retains its existing global history and independent live list.

Use the parameters your session advertises: a session that loaded its tool schema before a Core upgrade keeps it until it reconnects.

## Before submitting

- Read `job_budget` and request what the command really needs, including memory headroom. The reservation is admission control, not a promise of speed.
- `requestCapacity.submission.maxRequest` is the single-request ceiling after subtracting a new collector (100m CPU, 64 MiB) from the total budget. `requestCapacity.snapshot.maxRequest` also deducts existing reservations and respects the latest host RAM/headroom. Use `meetsMinimum`: false means no request fits the schema minimum; null means host capacity is unknown. The existing `available` remains budget minus reservations, including existing collectors; do not treat it as the request size or subtract those collectors again. These local snapshots do not guarantee immediate start: queue order, slots, exclusive work, GPU and disk can still require waiting.
- `job_budget` also shows the free space of Core's data folder and each live Job's working directory. Below the reserve no new Job starts; it waits in the queue with a "Waiting for disk space" reason. That is a check before each start, not a quota: a Job that writes a lot can still fill the disk, so leave room for what it writes.
- A Job does not inherit your shell. Pass absolute paths and the environment the command needs (for example `HOME` and `PATH`), and use your own worktree as `cwd`.
- Freeze what the Job will read. With `guardGit`, a queued Job is rejected if tracked files change before it launches, so commit first and do not commit, amend or switch branches until it has started. Untracked files are not frozen: list small inputs such as the script itself or fixtures in `inputs`.
- Declare report files in `outputs`, set a realistic `timeoutSeconds`, and use a stable `requestId`.
- Do not start a second resource manager inside the Job (for example a scope that escapes its cgroup). Project limits such as concurrency slots or memory caps come from the project's instructions.

## GPUs

- A command that uses a local NVIDIA GPU declares `gpu` with the `memoryMiB` it needs on the card, with margin. Admission reserves a device by UUID together with CPU and RAM and sets `CUDA_VISIBLE_DEVICES` to the reserved UUIDs: use that, never pick a device yourself. A GPU command without `gpu` is invisible to admission.
- By default a GPU job is the only managed GPU job on its device. `mode: "shared"` runs beside other shared jobs only on a device the user opened for sharing.
- A GPU job waits, with the device and the reason named, while its device is in use, closed to new jobs, short of memory or not freshly sampled; CPU jobs behind it still start. Free memory is the whole card's, other programs included, and nothing isolates or limits what a job really uses: stay within what you declared.
- `job_gpu_admission` closes or opens a device to new jobs; jobs already on it keep it. Use it when the user or the project asks, not to get ahead of other work. A device the user closed stays closed until the user opens it.
- The queue takes projects in turn and tries a job that has waited over 30 minutes first. A job short of the shared CPU/RAM budget is never passed; a job waiting only for a GPU holds just that device.

## After submitting

- The call returns a Job identifier and usually `queued`. End the turn or do independent work; a system mail reports success, failure or cancellation. Use `job_get` and `job_logs` to read evidence after that mail, or to diagnose — not to poll.
- A lost reply is retried with the same `requestId`. There is no automatic rerun: after a failure, read the evidence, fix the cause, then submit again explicitly with a new `requestId`.
- `job_cancel` stops your own Job; cancelling before launch starts nothing. Cancelling a Job does not cancel its task.
- An `unknown` outcome is not success. A Job's result is evidence for the task, never its completion.
- `job_get.resourceSummary` and existing completion mail compare actual peak memory and average CPU cores with the declared request. CPU time divided by worker monotonic start-to-exit wall time gives average cores; pauses count in that wall time. Measurements include the worker wrapper and exclude its collector. Missing or invalid counters and remote execution stay unknown (`null`), not zero. Failed attempts may have valid measurements; cancellation or interruption may lack them. Use measurements to inform the next request, with margin; they do not automatically resize it.
- `rejected` with "Not started" means no process was created (for example the disk was full before launch) and nothing is held: submit again with a new `requestId` once the cause is gone.

## Paused Jobs

The user can pause a running Job to free the machine, for example for a game. Every process of the Job is frozen in place. It keeps `status: running`, its memory, GPU memory and whole reservation, so nothing else is admitted into its share. Work it had already sent to a GPU still finishes.

- `job_get` shows `pause.state`, which is one of `requested`, `paused`, `resuming`, `failed` or `unknown`. A system mail tells you when the Job is paused and when it is resumed.
- Only the user resumes a Job. Do not cancel it, resubmit it or read its silence as a failure; report it as paused.
- Its `timeoutSeconds` keeps counting while it is paused. A paused Job that reaches its timeout is stopped as failed with reason `timeout`, without running again.
- Connections, leases or API sessions it held may have expired by the time it resumes. The command has to cope with that; Core never replays a call.

## Stopping at a checkpoint

A command that can save its whole state and exit at a safe point may declare it in `job_submit`'s `checkpoint`: the `signal` it saves on (`SIGTERM`, `SIGINT` or `SIGUSR1`), the `graceSeconds` it needs (10–900, shorter than `timeoutSeconds`) and the `stoppedExitCode` that means it stopped (1–125). Only a Job on this Core's host takes it: not with `machineId`, not in a run's stages. Without it the user has pause and cancel only.

On a Core whose release includes T-109 (an older one refuses the field), the user can then stop it at a checkpoint. Unlike a pause, the attempt ends and frees its memory. The attempt's wrapper sends `signal` to the command itself, so make the command the Job's `argv`, not a shell that runs it. The command then does its part:

1. Save everything it needs to continue into `$YUZUNO_CHECKPOINT_DIR`, a new folder for each attempt.
2. Write `manifest.json` there last: `{"attempt": "$YUZUNO_JOB_ATTEMPT", "nonce": <the nonce in the JSON file at $YUZUNO_CHECKPOINT_REQUEST>, "files": [{"path": <relative>}]}`, at most 1000 files. It may add `progress`.
3. Exit `stoppedExitCode`.

The wrapper then checks the exit code, that the manifest names this attempt and this stop, and every listed file as a regular file in that folder, with its own SHA-256. Only then does `job_get` show `checkpointStop.state` `checkpointed`: the Job is `cancelled` and `result.checkpoint.ok` is true. Anything else is `notResumable`, with the reason. A command still running `graceSeconds` after the stop is cancelled; once it has exited, checking its files counts against `timeoutSeconds` instead. The reservation is released only once every process of the attempt has exited.

- A system mail tells you when the user stops a Job at a checkpoint. Do not resubmit it; report it as stopped at a checkpoint, or as not resumable and why.
- Only the user resumes it. That makes a new Job with the same submission, linked by `checkpointFrom` (and `resumeOf` in lists). Its command gets `$YUZUNO_RESUME_FROM`, the path of that manifest, and has to load from it. The wrapper checks the files again before the command starts; a changed checkpoint rejects the attempt instead of starting it from scratch. A Core from before checkpoints that picks up a queued resumed Job rejects it the same way, saying its guarded inputs changed; it never starts it without the checkpoint.
- How much continues exactly is the command's: save the model, optimizer, scheduler, step counters and random or data positions it needs. acceptance/t109-checkpoint is a small Lightning example.

## On a remote Linux machine

`job_submit` with `machineId` (a registered SSH machine from the Machines list) runs the command on that machine instead of this Core's host. Use it only when the user or the project asks for that machine.

- `cwd` and every path are on that machine. Pass the environment the command needs in `env`; it does not inherit a login shell's. Set `guardGit` to `false`.
- Without `machineId` a job runs on this Core's host, never on the machine your Agent itself runs on. To run where your Agent runs, pass `machineId` `"agent"`: Core resolves it from your Agent's own record when the job is submitted (its registered machine, or this Core's host for an Agent here) and the job keeps that machine; a retry with the same `requestId` is the same job. `"local"` names this Core's host. The receipt's `target` names the machine the job runs on and what you asked for. With no calling Agent, or if your Agent's machine is no longer registered, `"agent"` is refused rather than replaced by another machine.
- The machine has its own admission, not this host's budget: at most its `maxJobs` attempts at once (2 unless set), and, when it has a `budget`, CPU and RAM admission against it. The user sets both, and its limit mode, in the machine's editor on the Machines page.
- Declared CPU, RAM and swap go with the attempt. The helper holds what the account's systemd user manager can (memory, swap where the kernel accounts it, and CPU where that controller is delegated) in the attempt's own scope, and reads them back before the command runs. It does so only when the account lingers, since otherwise that manager may stop with the account's last session. The machine's mode decides the rest:
  - `strict`, what a machine added now gets: a limit it cannot hold means the job is not started.
  - `limited`, which the user chooses: the job runs and records what is only declared. On a non-lingering account nothing is held.
  - No mode (a machine registered before limits): resources are only recorded, as before.

  The running reason says which. Read the job's limits before relying on a hard limit there. A machine's budget and maxJobs only decide when a job may start.
- `inputs` and `artifacts` are files on that machine, named from its `cwd` there; nothing on this host is read or written for them, wherever your Agent runs.
  - **Inputs are frozen at submit.** They are read there in one SSH call of at most 30 seconds: small files, at most 2 MiB each and 16 MiB together. One that is missing, unreadable or too large refuses the submit and no job is created; locally such an input is only recorded as missing.
  - **Checked again before the start, there.** A changed, replaced or missing input rejects the job before the command runs.
  - **Artifacts are checked there after a clean exit.** The rules are the local ones, and the job is failed if one does not pass. A non-zero exit, timeout or cancel is reported as such, without an artifact check.
  - **They stay there.** The result names the machine (`result.artifactsOn`) and each file's path there. Nothing is copied or offered for download, so read them on that machine.
  - **Files from before.** `preExisting` and `unchangedSinceStart` record whether a file was already there before the command ran. They do not decide pass or fail: give an output only this attempt may write a path of its own.
- On Cores newer than 2026.10.19-core.12 (older ones refuse it), the user can pause a job there only while its attempt runs in a scope of its own on that machine (its limits are held: strict, or limited on an account that lingers); it is frozen there as a local job is, and the pause rules above apply. Otherwise a pause is refused with the reason, and nothing is stopped instead.
- `gpu`, `exclusive`, `outputs` (declare `artifacts`) and runs of stages are refused, and so is pause on Windows.
- Cancel and timeouts stop the attempt's process group. A process that starts its own session or group leaves it and is not stopped, so do not daemonize from the command.
- A lost connection, a supervisor that died or a name that now reaches another machine leaves the job `unknown`, its slot held. Core checks the same attempt again and never starts it twice. Do not resubmit to "retry" an unknown job; report it as unknown, and cancel it only if the work should stop.
- `machineId` `"windows"` is Windows on the PC this Core's WSL runs on, offered only when Core runs in WSL with Windows interop on. `cwd` is a Windows drive path such as `C:\work`, and the command keeps its Windows environment. The same rules apply, and `gpu`, `outputs`, pause and stages are refused. On Cores newer than 2026.10.19-core.12, `inputs` and `artifacts` are files of that PC's Windows (older ones refuse them), read and checked there by its native helper, never through /mnt: inputs are drive paths or paths relative to `cwd`, artifacts paths relative to `cwd` (Windows separators). A file another program holds open for writing, or without sharing it, cannot be read: an input then refuses the submit, an artifact fails its check. json and jsonl artifacts there are read by the helper's own syntax check, which follows Python's json reading with stated bounds (nesting deeper than 1000 levels or an integer of more than 4300 digits leaves the check not completed, never called malformed). Its Job Object holds the declared CPU (a hard cap on its share of all processors) and memory (a job-wide limit on committed memory: an allocation beyond it fails, nothing is killed), and it reserves from this host's Jobs budget, which Windows and this WSL share. At most Windows' `maxJobs` attempts run at once (2 unless the user set another, in the Jobs panel's Windows cell); it is only a ceiling, never extra budget. Cancel and timeouts end the attempt's own Windows Job Object, children included; a process still in it 5 s after the command exits is stopped and named in the reason. Core runs only the helper its release ships (it needs Windows' own .NET Framework 4), checked byte for byte. If there is none, it differs, or interop is off, the job ends as not started before its start is sent, and is `unknown` after. Report that as it is; do not try to supply a helper yourself.

## Runs of stages

When a piece of work has a few steps where a later one may only start after an earlier one truly succeeded (prepare → train → evaluate, API trials → judge), submit them as one `job_run_submit` instead of chaining them in a script. Each stage attempt is an ordinary Job in the same queue and budget; `needs` names the earlier stages it depends on. Keep a single long command a plain `job_submit`, and do not make a Job per iteration or per API request.

- One command per stage. Do not wrap stages in `a; b; echo done`, `wait` or polling loops (`pgrep`, DONE markers): a later command hides the real exit status, and a marker is not a result.
- Declare in `artifacts` the files a clean exit must leave, with `format` `json` or `jsonl` where it applies. Exit 0 with a missing, empty or partly written artifact is a failure, and nothing that needs the stage starts. The check is structure only; if a scientific criterion decides success, make a stage that checks it and exits non-zero.
- A stage that failed or was cancelled leaves the stages that need it waiting, never started, with the reason. Retry it with `job_run_retry`, or stop with `job_run_cancel`. A retry runs the same frozen inputs: after a code or configuration change it is rejected, so submit a new run.
- Set `waitForAnalysis: true` on a stage when its successful result needs Agent analysis before anything depending on it may start. Omit it for the usual automatic chaining. Its Job stays `succeeded`, releases CPU/RAM/GPU, slots and exclusive reservations, and retains logs and artifacts; `waiting_analysis` belongs to the run/stage. Independent branches continue. Even a final-stage gate needs a decision before the run completes. The gate survives Core restart or an offline Agent; never create a sleep, watch or polling Job to wait for analysis.
- The gate sends one durable mailbox message identifying the run, stage, successful Job/attempt and artifact evidence. Read `job_run_get`, `job_get`/`job_logs` and the artifacts, then call `job_run_decide` with the current `runId`, `stage`, `gateId` (`stage.analysis.id`), `attemptId`, a stable `requestId`, and `decision: "continue"` or `"cancel"`; `reason` records your analysis. Only the run's owner Agent or the user may decide. Keep the identical request for a lost reply; a stale gate or attempt is rejected, and a cancelled run cannot be revived.
- Continue only releases the already frozen DAG. It still passes update-drain admission, resource and cost budgets, and the original Git/input/artifact checks. It grants no new permission for experiments, GPU time, API costs or other work. A changed command or input requires a new run with explicit reuse; a reused successful result always gets this new run's own gate and decision. Cancel stops the run while preserving succeeded Jobs and their evidence. Local run stages only: remote/Windows stages remain unsupported.
- Every stage freezes its inputs at submission. With `guardGit`, tracked files that earlier stages declare as artifacts are left out of a later stage's guard and checked by digest against the attempt that last declared them. Any other tracked change between stages, a rename or copy included, rejects that stage, naming the file. Declare as artifacts the tracked files your stages write.
- Declare `retry` only for infrastructure failures the command reports with its own exit code (for example 75 for a dropped API connection), or `interrupted` for a host restart. Budget stops, experiment stop rules and code errors exit with other codes and are never retried.
- To record API cost, append one JSON line per call to `$YUZUNO_JOB_USAGE_FILE`, such as `{"usd": 0.0123, "source": "openrouter usage.cost"}`, with `null` when the cost is unknown. Each attempt has its own file, and failed attempts count. `costLimitUsd` stops new attempts once recorded cost reaches it. Calls in flight or never recorded can exceed it, so it is not a provider cap; report it that way. For progress when output is quiet, replace `$YUZUNO_JOB_PROGRESS_FILE` with small JSON.
- To skip a stage that already succeeded, name its job in `reuse`. Core accepts it only if the command, environment, frozen code and inputs, artifact contract and upstream artifacts are identical and its artifacts are unchanged, and it refuses with the reason otherwise. An existing output file is never a result by itself.
- Jobs get no Core or MCP connection; a stage that calls Core must handle losing it, for example with a declared retryable exit code.
- One mail arrives when the run succeeds or its cancellation completes. A stage that ends without success and without a declared retry mails on its own, naming what waits. Read `job_run_get` for every attempt, its artifacts and the recorded cost. Report a failure with the stage, attempt, reason and the cost recorded (known and unknown).
- Each `job_run_get` attempt has its own `resourceSummary`; retries remain separate and a reused producer is not execution in this run. Do not sum concurrent memory peaks. Completion mail shows up to 12 attempts; the run query retains all attempts.

## Where a result came from

- `job_provenance` exports what Core recorded about one Job (`jobId`) or every attempt of a run (`runId`): a versioned JSON `manifest` (schema `yuzuno.provenance`) and a short Markdown `report` written from it. Each attempt keeps its own outcome, exit status, machine and executor, Git and frozen-input digests, identity, resources, artifacts with SHA-256 and where they stay, and whether early output was overwritten. Each item is marked `verified`, `declared`, `notRecorded` or `unknown`.
- It restates records only: no working file is read again and no machine is asked, so an offline machine's Jobs export too. It does not show that a result can be reproduced, and files may have changed since; say so when you cite it.
- Command arguments, environment values, absolute paths, output, chat and file contents are left out. Inputs outside the working directory and Git root keep only their digest. Show the user the report before it leaves the Workspace. Artifacts are not copied: a local one downloads from its Job after Core checks it again, and a remote one stays on its machine.
