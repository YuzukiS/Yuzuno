# Stop at a checkpoint and resume (T-109)

A small Lightning 2.5.0 training on CPU that follows the Jobs checkpoint
protocol, and a check that runs it through the real host helper and systemd.
No Core, no GPU, nothing installed outside the folder you choose.

- `setup.sh ENV_DIR` makes a task-local environment from the pins it holds:
  CPU PyTorch 2.5.1, Lightning 2.5.0 (and `pytorch-lightning`, which it requires
  unpinned, at the same release) and the versions they resolved with, installed
  with `--no-deps`. It fails if a CUDA package is installed. `--resolve`
  resolves afresh, to update the pins.
- `train.py` is the command. On SIGTERM, Lightning's handler raises
  `SIGTERMException` at the end of the batch and `OnExceptionCheckpoint` saves
  the trainer state into `$YUZUNO_CHECKPOINT_DIR`. The script then writes
  `manifest.json` last and exits 75. With `$YUZUNO_RESUME_FROM` it continues
  through `trainer.fit(ckpt_path=...)`. Left alone, `SIGTERMException` would
  exit 0 and look like a finished run; exiting 75 is the script's job.
- `check.py PYTHON OUT_DIR` runs three scenarios:
  - **stop-resume**:
    - Stops a training in its own worker unit, asking twice.
    - Checks the wrapper's verification, that the attempt's groups are empty, and what the checkpoint holds.
    - Resumes it as a new attempt from the same model, optimizer momentum, scheduler and global step.
    - Compares its final weights with an uninterrupted run. Each run writes
      `trace.jsonl` (each step's starting weights and loss), to find the step
      where two runs part if they do.
  - **tampered**: a changed checkpoint rejects the resumed attempt before the command starts.
  - **wrong-code**: a stop that exits a code other than the declared one is not resumable, and says why.

```sh
acceptance/t109-checkpoint/setup.sh target/t109/env
/usr/bin/python3 acceptance/t109-checkpoint/check.py target/t109/env/bin/python target/t109/check
```

Run both as Jobs; check.py starts its own user units, so give its Job
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. The setup downloads about
200 MB.

What it does not show:

- **Exact results elsewhere.** This example makes the result exact by
  construction: one CPU thread, no dropout, and each step's batch drawn
  from the global step. Another training is exactly as resumable as the
  state it saves (RNG, data loader positions, environment).
- **GPU memory.** Freeing GPU memory has not been measured here.
- **Core's own handling.** Core's records, mail, grace period and resume
  are covered by `core/src/jobs/checkpoint_tests.rs`. The wrapper's corner
  cases (a stop before the command starts, after it exits, a shell that does
  not forward) are covered by `acceptance/local-jobs/checkpoint_host_test.py`.
