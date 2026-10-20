# Research pipelines with local GPU jobs

How to move a research pipeline that uses the local NVIDIA GPU onto Jobs: the GPU stage declares what it needs, admission picks the device, and CPU stages around it run in the same queue and budget. The project keeps its own scientific configuration and its framework's own scheduling inside each stage. Exact fields are in the `job_submit` and `job_run_submit` tool schemas.

## What admission does and does not do

| Does | Does not |
|---|---|
| Reserves a device by UUID for a job that declares `gpu.memoryMiB`, together with its CPU and RAM | Isolate GPU memory, cap it or divide compute: the job can still use more than it declared |
| Starts the job only while the latest sample shows that much free memory, less what managed jobs reserve and the memory kept free (default 1024 MiB) | Count programs outside this Core as reservations; they show up only as less free memory |
| Gives one managed GPU job a device by default; `mode: "shared"` only on a device the user opened for sharing | Read the GPU process list: on WSL it can be empty while the card is in use |
| Sets `CUDA_VISIBLE_DEVICES` to the reserved UUIDs | Preempt, move or pause running work for a GPU job |
| Lets CPU work behind a waiting GPU job start | Predict run times or backfill |

The most one job can ask of a device is its total memory less the memory kept free: 31583 MiB on a 32607 MiB RTX 5090 with the default. A larger request is refused at submit. A requirement measured on a bigger card (for example 40.7 GiB) must be measured again, and reduced if needed, on this one.

## Sizing a GPU stage

- Measure the stage's peak GPU memory on a short run, for example with `nvidia-smi --query-gpu=memory.used --format=csv -lms 500` beside it. Declare that peak plus a margin for allocator fragmentation as `memoryMiB`.
- Inside the job, the reserved device is device 0: PyTorch's `cuda:0`, JAX's first device. Do not set `CUDA_VISIBLE_DEVICES` in the command or its `env`.
- A stage that needs two devices declares `count: 2`. A stage that must use one particular card names it in `devices` by UUID, from `job_budget`.
- On WSL, `nvidia-smi` is in `/usr/lib/wsl/lib`, which is not on a job's `PATH`. Call it by full path if a stage needs it.

## Inference, then CPU analysis

The shape of the synthetic model pilot: a GPU stage writes predictions, and a CPU stage analyses them. The analysis does not hold the GPU, and it starts only after inference exited 0 with complete output.

```json
{
  "requestId": "infer-analyse-2026-10-18",
  "taskId": "T-1",
  "name": "Inference then analysis",
  "stages": [
    {
      "key": "infer",
      "cwd": "/home/me/project",
      "argv": ["/home/me/project/.venv/bin/python", "-m", "eval.infer", "--config", "configs/eval.yaml", "--out", "out/predictions.jsonl"],
      "env": {"HOME": "/home/me", "PATH": "/home/me/project/.venv/bin:/usr/bin:/bin"},
      "resources": {"cpuMillis": 2000, "memoryMiB": 8192, "swapMiB": 0},
      "gpu": {"memoryMiB": 12000},
      "artifacts": [{"path": "out/predictions.jsonl", "format": "jsonl"}],
      "timeoutSeconds": 14400
    },
    {
      "key": "analyse",
      "needs": ["infer"],
      "cwd": "/home/me/project",
      "argv": ["/home/me/project/.venv/bin/python", "-m", "eval.analyse", "--in", "out/predictions.jsonl", "--out", "out/report.json"],
      "env": {"HOME": "/home/me", "PATH": "/home/me/project/.venv/bin:/usr/bin:/bin"},
      "resources": {"cpuMillis": 4000, "memoryMiB": 4096, "swapMiB": 0},
      "artifacts": [{"path": "out/report.json", "format": "json"}],
      "timeoutSeconds": 3600
    }
  ]
}
```

## CPU, GPU and CPU stages

The shape of the tennis-track pilot: CPU preprocessing, a GPU stage, then CPU evaluation. While the GPU stage waits for the card, preprocessing for another run can still use the CPU.

```json
{
  "requestId": "track-run-2026-10-18",
  "taskId": "T-1",
  "name": "Track: prepare, detect, evaluate",
  "stages": [
    {
      "key": "prepare",
      "cwd": "/home/me/track",
      "argv": ["/home/me/track/.venv/bin/python", "prepare.py", "--clips", "data/clips", "--out", "work/frames.npz"],
      "env": {"HOME": "/home/me", "PATH": "/home/me/track/.venv/bin:/usr/bin:/bin"},
      "resources": {"cpuMillis": 4000, "memoryMiB": 6144, "swapMiB": 0},
      "artifacts": [{"path": "work/frames.npz", "minBytes": 1024}]
    },
    {
      "key": "detect",
      "needs": ["prepare"],
      "cwd": "/home/me/track",
      "argv": ["/home/me/track/.venv/bin/python", "detect.py", "--in", "work/frames.npz", "--out", "work/tracks.json"],
      "env": {"HOME": "/home/me", "PATH": "/home/me/track/.venv/bin:/usr/bin:/bin"},
      "resources": {"cpuMillis": 2000, "memoryMiB": 8192, "swapMiB": 0},
      "gpu": {"memoryMiB": 18000},
      "artifacts": [{"path": "work/tracks.json", "format": "json"}],
      "retry": {"attempts": 2, "interrupted": true}
    },
    {
      "key": "evaluate",
      "needs": ["detect"],
      "cwd": "/home/me/track",
      "argv": ["/home/me/track/.venv/bin/python", "evaluate.py", "--tracks", "work/tracks.json", "--out", "work/metrics.json"],
      "env": {"HOME": "/home/me", "PATH": "/home/me/track/.venv/bin:/usr/bin:/bin"},
      "resources": {"cpuMillis": 2000, "memoryMiB": 2048, "swapMiB": 0},
      "artifacts": [{"path": "work/metrics.json", "format": "json"}]
    }
  ]
}
```

Paths, modules and figures above are placeholders. Use the project's own entry points and configuration, and the sizes you measured.

## Reading a waiting GPU job

| Reason starts with | Meaning | What to do |
|---|---|---|
| Waiting for a current GPU sample | No sample yet, sampling failed, or the last one is older than 60 s | Usually clears on the next sample. If sampling keeps failing, the reason says why (no NVML and no nvidia-smi). |
| … is in use by managed job … | Another managed GPU job holds the device | Wait. The job starts when that one ends. |
| … has too little free memory for N MiB … | Free memory, less managed reservations and the memory kept free, is below the request | Something else is using the card, or the request is large. The GPU list in the Jobs panel shows the latest free memory. |
| … is closed to new jobs | The user (or an Agent) closed the device to new jobs | Only the user reopens a close the user made. |
| … is not open for sharing | A shared-mode job, on a device not opened for sharing | Ask the user, or submit in exclusive mode. |
| … is held for an earlier job waiting for it | An earlier GPU job is waiting for this device | Wait. CPU jobs are not held by this. |
| … can never hold N MiB | The request is above the device's total less the memory kept free | Reduce the request, or ask the user to lower the memory kept free. |
