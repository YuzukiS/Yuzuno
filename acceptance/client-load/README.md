# YN-211: client cold start and background cost

What the client costs apart from Core:
- from a cold or a warm start to its first usable action;
- while it is in the foreground, minimized and restored.

The setup is a lab Core with scripted runtimes and a fixed workload. The client is either Chromium on Linux or the desktop app's lab copy in a real WebView2 on Windows. Nothing here changes product code.

## Fixed setup (the 2026-11-17 run)

| Part | Value |
| --- | --- |
| Source | `main` `5e4563563e12d1876c29f34c28ed5b5bb1e623d1` (after core.37 was cut) |
| Core | `cargo build --locked --release`, sha256 `3d6c9c80a0abfc92d26ad4c6b61837f2a57e61d670f0b5da11dbca3d507137a8` |
| Web UI | `npm --prefix web run build` at that commit: `index-DwKVXUq8.js` 4,119,347 B, `index-BmJSJ4yL.css` 660,007 B |
| Lab Core | port 4461 behind this harness's proxy on 4462, its own data folder, never 4317 |
| Runtimes | `acceptance/turn-cost/fake_codex.py` (no model) |
| Linux client | Chromium 153.0.8010.52 (Arch), headless, 1440×1000, `--no-sandbox` as Playwright starts it, WSL2 kernel 6.18 |
| Windows client | desktop app built from the same commit under its own identity (`dev.yuzuno.workspace.yn211lab`, no updater key), WebView2 157.0.4341.46, Windows 11 Pro 26300, Ryzen 9 9950X3D2 (32 threads) |

### Workload F12

12 Codex Agents.
- A1 has `warmup:40:20` (40 completed command Items of 20 KB) and 6 short replies.
- The other Agents have 3 short replies each.
- Sizes: `/api/workspace` 21 KB, A1's record 190 KB.

### Loads

- **L0 quiet:** no Turn running.
- **L4:** A1–A4 each stream `run:D:0:0:10`, 10 message deltas/s each, for the whole window. That is 15.3 Core events/s per Agent, measured on Core's own stream (job p1), and about 56 events/s that the page handles.
- The page shows A1, so one of the four streams is on screen.

## Method

### M1: start to first usable action

Each start gets a new client process, then:
1. The probe (`Page.addScriptToEvaluateOnNewDocument`) is in the workspace page from its first script.
2. It clicks A1's row as soon as the rail shows all 12 Agents.
3. It records "usable" when A1's conversation is mounted with ≥ 3 Turns and a composer that takes input, plus two animation frames.

Times are measured from the client process's start. On Windows the desktop's connection page checks `/api/health` before it opens the workspace. The proxy holds that request until the probe is in place, and that hold is subtracted (it was 0 ms in every run: CDP was attached first).

What cold, warm and Core-warm mean here:
- **Cold:** a new user-data folder: no HTTP cache, no V8 code cache, no stored page state. On Windows this is through `WEBVIEW2_USER_DATA_FOLDER`; the lab process tree's own `--user-data-dir` shows it was used.
- **Warm:** the same folder started again after a clean close.
- **Core warm:** Core keeps running across all runs, and one start before them is discarded.
- **OS file cache:** not cleared (that needs root or an administrator). It is warm for all counted runs.

Cache hits are taken from three sources together, never from `transferSize` alone:
- the proxy's count of requests that reached Core;
- CDP `Network.responseReceived` `fromDiskCache`;
- Resource Timing.

There are two variants, 5 cold/warm pairs each:
- **shipped:** Core's own headers. Every response is `Cache-Control: no-store` (`core/src/server.rs` `harden`).
- **cacheable-simulated:** the proxy rewrites hashed `/assets/*` to `public, max-age=31536000, immutable`. This is a simulation of a header change, not something Core does.

The two variants ran one after the other, not interleaved, so compare within a variant first.

### M2: foreground, minimized, restored

- **Windows:** per load, 3 rounds of foreground 30 s, minimized 30 s and restored 30 s, then one minimized window of 360 s in 30 s buckets. Minimize and restore are real (`ShowWindow`).
- **Linux:** foreground only, 3 × 30 s per load. Headless Chromium never hides a page, so Linux has no hidden window.

How each window is checked and measured:
- **Pure windows:** a window counts only if every 1 s `IsIconic` sample and the page's `visibilityState` at its start and end agree with its state. All 20 Windows windows (per load 3 rounds × 3 states, plus one 360 s window) and all 6 Linux windows were pure.
- **CPU:** Core is the lab Core process (`/proc`). The scripted runtimes are its children, reported apart. The client is every process in its tree, by role (`--type=`): Windows `Get-Process` CPU time, Linux `/proc`.
- **Host load:** WSL `/proc/stat` and Windows `GetSystemTimes` are recorded per window; noisy windows are marked, not dropped.
- **Restore catch-up:** a probe is armed while the page is hidden and starts on its own `visibilitychange`. Caught up means:
  - the page's EventSource has handed it a message whose ID is at least the one Core had sent when the restore began;
  - A1's last Turn shows the newest streamed chunk (only when a stream is running: under L0 there is no chunk to look for);
  - two frames have passed.
  It is timed from just before `ShowWindow`, on the same Windows clock as the page. Reaching an ID shows that events up to it arrived; it does not show that each one was applied or drawn.
- **CDP's own effect:** CDP is attached all along. Each window makes two `Runtime.evaluate` calls, at its start and end; each wakes the renderer once. `Network` and `Page` are disabled after the start. In YN-199, raw CDP evaluation did not keep a minimized page visible; Playwright's `connectOverCDP` did, so it is not used.

## Results

### M1: ms from process start to first usable (median, min–max, n = 5 each)

| Platform | Variant | Cold | Warm | Response bytes, Core → client, warm | Main JS on warm start |
| --- | --- | ---: | ---: | ---: | --- |
| Windows WebView2 | shipped | 845 (820–913) | 837 (774–908) | 5.29 MB | fetched again 5/5 |
| Windows WebView2 | cacheable-simulated | 817 (780–855) | 767 (744–799) | 0.45 MB | disk cache 5/5 |
| Linux Chromium | shipped | 938 (777–1033) | 939 (791–1176) | 5.28 MB | fetched again 5/5 |
| Linux Chromium | cacheable-simulated | 795 (754–863) | 763 (718–876) | 0.44 MB | disk cache 5/5 |

The two variants ran one after the other, not interleaved, so the warm medians of the two variants (Windows 837 and 767 ms, Linux 939 and 763 ms) differ by order and time as well as by the header. They are not a measured saving. What is measured is the bytes: with hashed assets cacheable, each warm start received about 4.84 MB less response body (on both platforms), and its main JS came from the disk cache instead of from Core (5/5). Whether the JS was compiled again was not measured.

Windows, shipped, cold, in parts:
- process start → workspace navigation: 386 ms. This is WebView2's start, the connection page and its health check.
- navigation → rail ready: about 370 ms.
- click → A1 mounted: 61 ms.
- long tasks: 112 ms in total. On Linux they total 332 ms.

CPU per start:
- **Client:** 1.7–2.2 CPU-s on Windows (all its processes since their start), 1.8–2.4 CPU-s on Linux.
- **Core:** 0.03–0.06 CPU-s.

CPU seconds are summed over processes and threads that run in parallel: they are not the share of the 0.8–0.95 s wall time on the critical path.

### M2: Windows desktop, cores (median of pure windows)

| Load / state | Client | Renderer | GPU | Core | Page events/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| L0 foreground | 0.003 | 0.001 | 0 | 0.003 | 0 |
| L0 minimized | 0.001 | 0.001 | 0 | 0.003 | 0 |
| L0 restored | 0.004 (0.003–0.010) | 0.002 | 0 | 0.003 | 0 |
| L0 minimized 360 s | 0.003 | 0.001 | 0 | 0.003 | 0 |
| L4 foreground | 0.471 (0.439–0.779) | 0.357 | 0.103 | 0.051 | 55.9 |
| L4 minimized | 0.065 (0.042–0.073) | 0.053 | 0 | 0.041 | 57.6 |
| L4 minimized 360 s | 0.050 (30 s buckets 0.039–0.061, no trend) | 0.042 | 0 | 0.039 | 56.0 |
| L4 restored | 0.509 (0.409–0.528) | 0.342 | 0.075 | 0.056 | 55.9 |

The scripted runtimes used 0.006–0.007 cores under L4.

Host load:
- L4 rounds 1–2 ran while other Jobs kept WSL about 70% and Windows about 89% busy.
- Round 3 and the 360 s window ran at about 6% and 20%.
- The 0.779 foreground value is round 1 (busy). Round 3 (quiet) is 0.471 in the foreground and 0.042 minimized.

Renderer private memory grew from 75–80 MiB (L0) to about 245 MiB while A1's streamed reply grew long, and fell to 104–140 MiB minimized.

### Restore catch-up (Windows)

- **Page visible:** 15–28 ms after `ShowWindow`, in all 8 restores.
- **Event ID reached:** at the same moment, in all 8. While hidden, the page's EventSource handed it 57 messages/s and its highest ID kept up with Core's. That shows the events arrived; it does not show that each was applied or drawn.
- **Newest text drawn (L4, 4 restores):**
  - Round 1: A1's newest chunk showed at 24 ms; two frames later, at 52 ms.
  - Rounds 2, 3 and the 360 s window: not confirmed within 20 s, once A1's streamed reply was past roughly 58 KB (chunk 1625 onward). The cause was not checked (for example how a long reply is shown). They are reported as **not confirmed**, not as slow.
- **L0 (4 restores):** there is no stream, so there was no text to check. Visible plus two frames came at 19–43 ms.

### M2: Linux Chromium, foreground

- **L0:** client 0.012 cores (0.010–0.027), Core 0.003.
- **L4:** client 0.446 (0.387–0.484; renderer 0.351, GPU 0.085), Core 0.033.

## Conclusions

1. **During a start, the client uses far more CPU than Core.**
   - First usable takes 0.8–0.95 s. In that time the client used 1.7–2.4 CPU-s and Core 0.03–0.06.
   - CPU seconds are not critical-path time, so this does not say how much of the 0.8–0.95 s waits on Core's answers.
   - On Windows, 386 ms of the 845 ms cold median pass before the workspace page starts loading (WebView2's start, the connection page and its check). That part is wall time.
2. **A warm start fetches all of the UI's code again.**
   - Core sends `no-store` for everything, so each warm start received the 4.1 MB JS and 0.66 MB CSS again (5/5 on each platform).
   - With hashed `/assets/` cacheable (simulated by the proxy), each warm start received about 4.84 MB less response body, and the main JS came from the disk cache (5/5).
   - What that does to the time to first usable is not shown here: the two variants ran one after the other, so their warm medians (Windows 837 and 767 ms, Linux 939 and 763 ms) are not a measured saving. Compilation was not measured, and neither was a slower link.
   - An interleaved comparison of the two headers (and one over a remote link) would show whether this is worth doing before any split of the entry bundle.
3. **Minimizing on Windows lowers the client's CPU.** With 4 Agents streaming, the client falls from about 0.47 to 0.04–0.07 cores (−86%) and stays there over 6 minutes. While minimized, the page kept receiving events and its highest event ID kept up with Core's. After a restore, the newest text was drawn in 1 of 4 checks (52 ms); the other 3 are not confirmed.
4. **What remains while minimized is not explained yet.** About 0.04–0.05 renderer cores at about 56 events/s, unchanged after 5 minutes. One hypothesis is that it is the page handling those events rather than timers; a comparison (minimized with the stream on and with it off, or at two event rates) would test it. It was not run here. Core's share at that load is 0.04 cores.
5. **Quiet idle is small; it depends on platform and state.**
   - Windows client: 0.003 foreground, 0.001 minimized, 0.004 restored, 0.003 over 360 s minimized.
   - Linux client, foreground: 0.012.
   - Core: 0.003 in every L0 window.

## Not measured, or not shown by this

- **macOS desktop (WKWebView), iOS Safari and the home-screen app:** no device in this run. Chromium's numbers say nothing about WebKit.
- **Windows' WSL VM as a whole:** `vmmem` also holds the daily Core. Only the lab Core process is counted.
- **Real input latency (INP):** clicks are scripted.
- **Two frames:** they are a paint opportunity, not proof that the screen showed it.
- **Remote links:** the cacheable variant was measured on loopback only.
- **OS file cache:** not cleared, so a first start after boot is slower than "cold" here.
- **Long streamed replies:** the text half of the catch-up check is not confirmed past about 58 KB.
- **Each event applied:** event IDs show arrival, not that every event was applied or drawn.
- **Compilation:** whether a warm start compiled the JS again was not measured.
- **Samples:** 5 pairs per variant and 3 windows per state, with noisy host windows marked. These are bounded samples, not a latency target.

## Run it

These commands need a worktree with Core built in release mode and `web/dist` built. Pick ports that are free; never 4317.

```sh
# Linux Chromium. Its singleton socket needs a short TMPDIR (≤ ~60 characters).
node acceptance/client-load/run.mjs --platform linux --core target/release/yuzuno-workspace \
  --web web/dist --out <results>/linux --chromium-tmp <short-dir>

# Windows desktop lab copy (from WSL, interop on, mirrored networking so Windows' localhost is WSL's).
node acceptance/client-load/run.mjs --platform windows --core target/release/yuzuno-workspace \
  --web web/dist --out <results>/windows \
  --desktop 'C:\<build>\yuzuno-lab-copy.exe' --lab-root 'C:\<build>\client-load-lab'
```

The Windows lab copy is built with a separate identity, so it shares no data folder, saved Core or WebView profile with an installed app:

```powershell
$env:TAURI_CONFIG = '{"identifier":"dev.yuzuno.workspace.<lab>","productName":"Yuzuno Lab Copy"}'
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\Yuzuno\build\<lab>"
.\scripts\desktop.ps1 -Release -BuildOnly
```

What the Windows side does:
- It starts, samples, minimizes, restores and stops only the process it started, checked by process ID, start time and path.
- It reads nothing of an installed app's folders.
- At the start it renames the lab identity's own `core.json` aside, never deleting it. A saved entry of an earlier lab Core (another Workspace at the same address) would otherwise stop the lab copy's start.

`--smoke` runs one pair with 5 s windows.

The 2026-11-17 run used this harness with one extra proxy counter of event-stream blocks. Its figure could not be explained and is not reported; the committed harness has `coreEventIds` (the growth of Core's event IDs per window) instead. Nothing else differs.
