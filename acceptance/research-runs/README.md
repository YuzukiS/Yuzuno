# Runs of stages (T-105)

`check.py` drives an isolated Core (the `local_jobs_lab` example, its own data and port) whose stages run as real systemd user units. `fixture.py` stands in for a CPU training stage and an API evaluation; nothing calls a model, trains or uses the network.

Each check is a failure the read-only WF audit (2026-10-17) found in real research scripts, now caught by Jobs:

| Check | Old failure |
| --- | --- |
| A failed upstream leaves its analysis waiting, never started | A watchdog skipped a failed run, still ran the analysis and wrote DONE |
| Exit 0 without the declared checkpoint is a failure | `train; echo done` made a failed training look finished |
| A truncated `final.json` is not complete JSON | A result was taken as done because its file existed |
| An upstream artifact changed between stages rejects the next stage | A later stage read a file that was overwritten in between |
| A declared retryable exit becomes a new attempt, both costs kept | API disconnects were rerun from scratch and their spend kept by hand |
| An exit not declared retryable is told once, not rerun | Budget stops and code errors must not be retried |
| An explicit retry is idempotent; after a code change it is rejected | Reruns after edits silently used new code |
| Explicit reuse only for an identical, intact attempt | A stale result was reused although its config or file changed |
| Core stopped mid-run: the stage finishes alone, the next starts once | Restarts reran stages or mailed twice |
| Cancelling a run stops the process group; waiting stages never start | Stopping a lane's shell left its child running |
| In a Git repository with the guard on, a declared tracked artifact written by an earlier stage does not reject the next; an undeclared tracked change does, by name | Results committed in the repository changed between stages unnoticed |
| a → b → c with the guard on: b rewriting a's tracked artifact rejects c, checked against a's attempt | A file left out of the guard for an indirect upstream went unchecked |
| A rename of undeclared tracked code onto a declared artifact still rejects the next stage | A rename hid the removal of its source |

`T105_ONLY=guard` runs only the last two, each recorded on its own, and `T105_LAB_BIN` selects another build of the lab, for example to show them failing on an earlier one.

Run it under the Jobs budget, after building the example from the same HEAD:

```sh
cargo build -p yuzuno-workspace --example local_jobs_lab
T105_PORT=4605 python3 acceptance/research-runs/check.py
```

The job needs `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` of the user manager. The lab budget is 1200 mCPU / 400 MiB, so at most two 96 MiB stage units run at once. Its folder is `target/t47/lab-r105-*`, and `report.json` there lists the checks that passed. The cleanup stops only units whose specs are in that folder.
