# T-6: consistent Core connection state

Isolated preview: **http://127.0.0.1:4391**. Its clearly labelled controls inject
synthetic HTTP/SSE faults into the real built UI. There is no running Core behind
this preview, no Harness, real conversation data, SSH, write API or forwarding.
The mock intercepts every API call, rejects writes and never falls through to
network. The server binds only localhost and serves an allowlist of static files.

Worktree: `/home/developer/yuzuno-next/.claude/worktrees/workspace-connection`.
Branch: `feat/workspace-connection`. Review base:
`4f152caabdb23353e4c106197a43224fb4fc5134`, including the reviewed T-5 Machines
slice. T-6 was initially based on `4511ee25`, then rebased onto the Lead-requested
T-5 HEAD before review. The only conflict was the test command; both suites were
retained. Main and the daily build/window were not modified by this work.

## Behavior

The top bar, bottom-left Workspace indicator and footer now derive their Core
status from the same HTTP snapshot evidence. The legacy `runtime.connected`
field describes the Codex catalog probe, so it no longer decides Workspace/Core
connectivity. Its explicit error is still shown separately as a Codex model-list
problem. There are no new automatic catalog or Claude bridge probes.

| Evidence | Shared Core label | Event stream |
| --- | --- | --- |
| First snapshot pending | Connecting to Core | Connecting until `onopen` |
| Snapshot successful, including Codex catalog failure | Core connected | Independent state |
| HTTP successful, SSE error | Core connected | Live updates reconnecting |
| HTTP 500, SSE open | Core update failed | Live updates connected |
| Network failure and SSE disconnected | Core unreachable | Live updates reconnecting |
| Snapshot request/body exceeds 10 seconds | Core request timed out | Independent state |
| Invalid JSON response | Core update failed | Independent state; does not imply Core is offline |
| Read-only design specimen | Preview · no Core | No actual subscription |

Hover the three indicators for the same detailed explanation. The Workspace
indicator exposes it via its accessible label too. A reconnect banner describes
the fallback; HTTP failure text says when cached data is displayed. Existing
conversation, draft, outgoing-message and Pending behavior remains in place.

`useWorkspaceEvents` keeps the existing 160ms event coalescing, five-second
visible-page polling and focus refresh. Browser EventSource owns reconnects;
`onopen` refreshes snapshots to fill the gap. A quiet open stream is not treated
as disconnected. Cleanup disposes callbacks, timers, focus listeners and the old
EventSource; late callbacks from that subscription are ignored.

Only `useSnapshot` GETs use the new ten-second deadline. It covers fetching and
reading the response body, aborts a stalled request and releases the refresh
queue even if a transport ignores AbortSignal. Late old responses cannot update
state after timeout, Agent/path change or disposal. This adds no write retries
and changes no Core, transport, database, API protocol, SSH or Tauri code.

## Manual acceptance

1. Open 4391 and type a draft into the Codex fixture conversation. The fixture
   has one synthetic Pending request; do not approve it (writes are rejected).
2. Select **Codex 目录失败**: all Core indicators remain connected. Switch to the
   Claude fixture; its conversation remains available in the UI.
3. Select **仅 SSE 断开**: the separate live-update banner appears while Core
   remains connected. Select **正常 / 恢复** to clear the banner and refresh.
4. Select **HTTP 500 + SSE 正常**: the UI says update failed, includes HTTP 500,
   and still reports that the event stream is connected.
5. Select **HTTP + SSE 断开**, then recover. Cached conversation, draft and the
   one Pending remain; no turn, approval or message is sent automatically.
6. Select **快照挂起** and wait ten seconds. A timeout replaces the indefinite
   wait. Recover (an already-running held request can take another deadline),
   then **释放旧响应**: stale responses must not replace the recovered state.
7. Open Workspace → **Machines…**: the integrated T-5 entry still works. Merely
   opening it reads the mock list; it does not test machines or start a Harness.
8. Check Appearance light/dark at 20px and a narrow window. Draft text remains.

These are frontend fault simulations, not claims that real Codex/Claude sessions
or SSH endpoints were executed successfully. No native connection was interrupted
to manufacture a test failure. T-3's private replay payload is not used here.

## Verification

- TypeScript typecheck and isolated Vite production build passed. Build output is
  `target/workspace-connection-dist`, not `web/dist`. The existing chunk-size
  warning remains.
- Combined frontend suite: **103 tests** (46 conversation, 10 collaboration,
  14 project, 3 machine, 3 artifact, 13 interactive-result schema, 7 result storage,
  7 new connection tests).
- Targeted tests cover the failure combinations after an initial successful load, exact
  status agreement, Claude selection under Codex catalog failure, silent SSE,
  reopen refresh, cached data/draft/Pending retention, a stalled JSON body and
  coalesced recovery, late old response rejection, Agent switching and explicit
  subscription cleanup. Unit deadlines are accelerated; browser tests use the
  actual ten seconds.
- Headless Chromium checks the failure combinations and recovery, light/dark
  20px, 390px layout without horizontal overflow, the integrated Machines entry,
  and no browser errors or actual API/write network traffic. Only localhost
  static assets are requested. Browser instances close in `finally`.
- Daily 4317 process identity and UI asset hashes match the pre-existing baseline.
  Previous 4387 and 4389 labs are retained without modification.

Generated evidence is ignored by git: `browser/report.json`, four theme/viewport
screenshots and `target/connection-{typecheck,build,targeted,integrated-regression,browser}.log`.
The implementation awaits independent Lead/Opus review; no merge or daily
deployment is implied by this local acceptance.

## Reproduce

Installed worktree-local frontend dependencies are required. No new dependency
was added. From `web/`:

```sh
npm run typecheck
./node_modules/.bin/vite build --outDir ../target/workspace-connection-dist
YUZUNO_UI_DIST=../target/workspace-connection-dist npm test
```

From the worktree root:

```sh
python3 acceptance/workspace-connection/lab.py
# Separate shell, after coordinating the shared browser slot:
node acceptance/workspace-connection/browser.mjs
```

Do not run `npm run build` for this isolated lab, as it targets `web/dist`.
Stop only the owned Python static server when finished, never the daily Core.

## R1 rework: real acceptance scripts

Independent Opus R1 found one P2: the real-Core browser script and two native
script waits still expected the old footer copy, `Workspace service online`.
Those three waits now target
`.statusbar [data-core-status="Core connected"]`. This still requires a successful
Core snapshot, and targeting the footer also works when a narrow viewport hides
the top-bar indicator. A repository search found no further executable waits on
the old copy. The generic snapshot timeout message now says “snapshot” so Agent
detail timeouts are not incorrectly named workspace snapshots.

Rework validation on 2026-10-13:

- Typecheck and isolated build passed; the seven connection tests passed again.
  The earlier 103-test regression remains the baseline for unchanged behavior.
- Both changed scripts pass `node --check`.
- The existing `npm run test:browser -- --live` **passed against a real isolated
  Core at 4392**, without mocked fetch/EventSource, request interception or seeded
  Agent data. It loaded the newly built UI and real `/api/health`, `/api/workspace`
  and `/api/events`. Startup Codex catalog probing failed as intended because the
  lab used a nonexistent Codex executable; no Harness started. Core still showed
  connected, exercising the corrected selector and the original T-6 distinction.
- This run reused the existing T-5 lab binary with SHA-256
  `bcfe99e6f5a9cabb9cb8aaec3be5603d485bbaa8f0eb9bbb984d02bd25f0823a` and a fresh
  data directory. No Cargo build was needed. No Agent was created; Chromium and
  the owned 4392 Core exited successfully afterward.
- Windows Tauri/WebView2 execution was **not run**. No isolated native test window
  was provisioned or connected through CDP, and the daily window was not touched.
  Native evidence is limited to syntax checks and the shared selector exercised
  in Chromium; it is not a claim of native end-to-end acceptance.

Evidence: `real-core-report.json`, the generated `real-core-*/browser/` report and
screenshot, and `target/connection-r1-{typecheck,build,targeted,real-core}.log`.
Reproduce the bounded real-Core run from the worktree root:

```sh
python3 acceptance/workspace-connection/real-core.py
```

The runner uses only its fresh 4392 child, runs the read-only browser path (never
`--exercise`), and stops that child in `finally`. It does not install dependencies
or connect to the daily Core. R2 is pending; no merge or daily switch is implied.
