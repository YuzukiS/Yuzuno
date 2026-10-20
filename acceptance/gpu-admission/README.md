# GPU admission (T-106)

`check.py` drives an isolated Core (the `local_jobs_lab` example, its own data and port) whose jobs run as real systemd user units on the real local GPU. The GPU work is `gpu_fixture.cu`: it reports the device CUDA gives it (by UUID), holds a few hundred MiB and keeps the device busy with a simple kernel for a few seconds. Nothing trains, calls a model or uses the network.

| Check | Why |
| --- | --- |
| GPUs are sampled by UUID through NVML, the same UUIDs nvidia-smi reports | An index can change; a UUID does not |
| A second exclusive GPU job waits, naming the device and its holder, while a CPU job behind it runs | One managed GPU job per device by default; CPU work is not held behind a GPU waiter |
| Each GPU job sees only its reserved device | `CUDA_VISIBLE_DEVICES` is the reserved UUID, read back from inside the command |
| A device closed to new jobs holds a new GPU job with the reason until it is opened; an Agent cannot reopen a close the user made | The user can keep a card for other work |
| Shared GPU jobs wait until the user opens the device for sharing, then run together | Sharing is the user's opt-in |
| A request larger than any device can give one job (its total less the memory kept free), or for an unknown UUID, is refused at submit | It could never start, and would hold its device while waiting |

Not covered here (store tests in `core/src/jobs/gpu_tests.rs`): a missing, failed or stale sample, project turns and aging, the exclusive barrier, reservations kept through unknown, cancelling and pause, and settings kept across a restart.

Build the lab from the same HEAD and run it under the Jobs budget (the lab job needs at least 2000 mCPU: a Core started inside a smaller CPU quota computes a lower budget ceiling):

```sh
cargo build -p yuzuno-workspace --example local_jobs_lab
nvcc -O2 -arch=native -o /path/to/gpu_fixture acceptance/gpu-admission/gpu_fixture.cu
T106_PORT=4606 T106_FIXTURE=/path/to/gpu_fixture python3 acceptance/gpu-admission/check.py
```

The job needs `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` of the user manager. On WSL, nvidia-smi is in `/usr/lib/wsl/lib`, which is not on a service's PATH. The lab budget is 1200 mCPU / 1600 MiB. Its folder is `target/t47/lab-r106-*`; `report.json` there lists the checks that passed and keeps GPU UUIDs by prefix only. The cleanup stops only units whose specs are in that folder.

`probe.py` (read-only) compares what nvidia-smi and NVML report on a host. `fixture_check.py` validates the fixture once: the selected UUID, a kernel that really ran, and an unknown UUID leaving no device.
