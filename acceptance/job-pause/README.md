# Job pause checks (T-107)

These scripts measure what pausing a managed Job really does on this host.
Each one starts its own transient user units, named `t107-probe-<run>-<name>`,
with bounded memory, CPU and tasks. It only ever freezes, thaws, stops or
resets units it started itself, and it removes them when it ends. Results go
to the output directory you give it. Git ignores that directory.

| Script | What it measures |
| --- | --- |
| `fixture.py` | A process tree with a parent, 2 children and 2 grandchildren. Each process reports a counter that grows only while it runs, and records its SIGTERM handler running. |
| `probe.py OUT [experiment...]` | What systemd's freezer does to a Jobs-shaped unit: `freeze-thaw`, `timeout` (RuntimeMaxSec while frozen), `stop`, `thaw-stop`, `kill-frozen`, `runtime-property`, `exited`, `dead-frozen`. |
| `gpu_probe.cu` | A small CUDA workload. It runs an integer LCG over a buffer and checks 16 elements on the CPU at the end, so a lost or repeated launch shows up. |
| `gpu_yield.py OUT BINARY KERNEL_MS QUEUE [WINDOW] [MIB] [EXTRA]` | Two CUDA workloads, A and B, in their own units, over three windows: both running, A frozen, A thawed. Records each one's launches per second, B's completions around the freeze, nvidia-smi samples, A's process identity and whether the results are exact. |

Build the CUDA probe:

```sh
nvcc -O2 -arch=native -o OUT/bin/gpu_probe gpu_probe.cu
```

To keep the GPU check short and small, use 256 MiB buffers and windows of 8–10 s.
