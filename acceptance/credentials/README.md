# T-17: Workspace MCP credentials

2026-10-14. Isolated branch `feat/t17-mcp-credentials`, based on merged T-14/T-15
(`main` at `6714dd9`). No daily Core, database, CLI account settings,
or main-worktree web assets were changed. Yuzuno-Task: T-17.

## Result and boundary

Claude's Workspace Bearer token travels through the official Agent SDK
`Query.setMcpServers()` stdin control channel after native initialization. It
is absent from launch options, argv and environment additions. There is no new
credential file, custom process launcher or platform-specific ACL/cleanup code.
The SDK's original process lifecycle remains responsible for native shutdown.
Initialization plus MCP registration share one 30-second deadline; failure,
timeout or closure never publishes ready or enqueues a model prompt.

The registration payload preserves other SDK MCP servers. User/project/local
settings, plugin servers, allowed tools and hooks retain their existing behavior.
Only the existing `mcp__yuzuno__*` grant is appended. Bridge diagnostics mask the
Workspace secret before truncation, including tokens split across stderr chunks;
event encoding masks any complete echoed secret without serializing ordinary
stream events twice.

Core rotates its existing per-Agent credentials after acquiring the Workspace
lock at startup. It does not read or change Claude/Codex account credentials.
The token is still stored in the existing private Core database and temporarily
held in native/bridge memory. This removes ordinary process-list exposure; it
does not protect against the same OS user inspecting process memory, stdin or
the private database. Deliberate external protocol tracing is outside this
boundary. There is one official transport path on all platforms; Windows native
execution was not tested on this Linux/WSL host.

## Existing sessions after rotation

Fresh local or remote native processes receive current configuration through
their normal startup/resume path. A surviving remote runtime may retain a loaded
thread's old MCP configuration. Core calls read-only `mcpServer/tool/call` /
`peers_list` once during attachment and checks successful tool output plus the
Workspace, Agent and current credential epoch. A catalog entry or JSON-RPC ACK
alone cannot establish readiness. Probe failures distinguish unsupported,
timeout, native failure, tool failure, invalid provenance and observed 401.

Readiness belongs to a native connection generation and Core epoch. A late
probe cannot update a replacement connection. A failed probe preserves native
execution state and permits read/reconcile, existing approval responses,
interrupt and explicit close. It blocks new turns, steering/answer fallbacks
and mailbox delivery before reserving a sending receipt. Normal and urgent
mail remain pending. No previous prompt is replayed.

For `/messages`, existing client IDs return their existing receipts first.
New input passes admission under the send gate, including any necessary native
attach/probe, before `message/requested`. Offline idle sessions still attach
automatically; uncertain/offline active work still requires a check-only action.
Readiness and generation are checked again before native submission. An explicit
`message_not_submitted` HTTP error keeps a stale UI's draft without inventing an
uncertain delivery preview; lost HTTP responses retain the original retry ID.

The existing recovery notice shows the reason, retains drafts and offers
reconnect. Reconnect releases the SSH subscription and resumes the same native
thread, then checks again. When the current connection owns an unresolved native
request, reconnect retains that transport, including after a response was sent
but before native resolution. The pending check and detach share the owner lock.
The remote helper retains a process and the RPC transport forwards live events;
neither establishes that native approvals will be replayed after resubscription.
The implementation therefore does not depend on such replay. A missing readiness
record can also be recovered by explicit reconnect. It never stops the remote
runtime automatically. If
the runtime still cannot refresh, the user can interrupt/finish the original
turn and explicitly close/reopen the Agent, preserving the native session.
Readiness changes invalidate detail with existing `agent.changed`; they do not
advance journal `lastSeq`, unread state or native runtime status. Detail reads
and serialization stay on the blocking pool using `client_detail` trimming.
Both `backgroundShells` and `collaboration` are live detail snapshots; reading
them does not hold the native event owner while serializing conversation history.

## Official APIs inspected

- Installed `@anthropic-ai/claude-agent-sdk` **0.3.296**, `sdk.d.ts:3204–3226`
  and `sdk.mjs`: `setMcpServers` sends `mcp_set_servers` through the SDK's stdin
  transport, returns `added/removed/errors`, replaces dynamic/SDK servers and
  leaves settings/plugin servers alone. The old constructor `mcpServers`
  path generated inline `--mcp-config` JSON.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) also
  supports `--mcp-config` paths. A private-file approach was considered, then
  removed after the official stdin API worked with the installed CLI.
- [Official Codex thread processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs),
  inspected 2026-10-14: loaded threads can ignore resume config overrides;
  current upstream can unload an idle, unsubscribed thread when overrides differ.
  The MCP reload path uses the current session's config layers, which does not
  prove that new resume overrides replaced a busy session's token. The installed
  **Codex 0.162.1** protocol schema supports `mcpServer/tool/call`.

## Real native acceptance

Run only in an isolated worktree after building Core/bridge/UI:

```sh
/home/developer/yuzuno-next/target/heavy-slot.sh python3 acceptance/credentials/native.py --remote
```

The one-shot script uses a new private `target/credentials-*` directory and Core
port **4487**, creates new local Claude/Codex Agents and optionally a new Mac
mini runtime, then closes only those Agents and its own Core. It reads tokens
only from its own database into memory, compares them without printing them,
and reports booleans. No approvals are automatically accepted. The remote busy
case runs only `/bin/sleep 120` and explicitly interrupts that owned test turn.

Successful pre-R1 run: `target/credentials-40fcfc0337d7/result.json` (generated
private evidence, intentionally untracked). Claude **2.1.280** with SDK
**0.3.296**, Linux Codex **0.162.1**, Mac mini Codex **0.162.1**:

- Each native model called `peers_list` successfully before and after restart.
- All Agent IDs and native session/thread IDs stayed the same. Reconnect did
  not append model turns. All old credentials returned HTTP 401; every new
  credential returned HTTP 200 with the matching authenticated Agent identity.
- Owned process argv and Core diagnostics contained no old or new token.
- A busy surviving remote runtime kept its instance and real `working` state.
  Its probe returned `toolError`; the UI does not falsely label it HTTP 401.
  Steering was rejected before native submission (this older run still created
  a rejected receipt, the R1 finding fixed below), the turn count stayed fixed,
  interrupt still worked, and explicit close/reopen restored the same thread
  on a new runtime. A subsequent real native MCP call succeeded.
- All test Agents, their remote runtime and the isolated Core were closed;
  the report has no cleanup items needing inspection.

An earlier idle-remote check observed automatic recovery on the same runtime
instance with successful current-epoch provenance. That is allowed: no forced
close/reopen is needed when the probe proves success. Earlier acceptance-only
failures were an overly strict expectation that idle recovery must fail, a
wrong message request field, and a text assertion matching model reasoning
instead of tool results/final answers. The final runner checks actual native
tool items and final replies.

## Automated coverage

Bridge tests exercise preserved SDK servers/settings/tools/hooks, official SDK
subprocess argv versus stdin, split-stderr masking, event/error redaction,
bounded registration, initialization/registration closure races and failures.
Core tests cover old/new credential authorization and restart identity, probe
provenance, stale generations, native controls while unready, no input/mail
submission and unchanged read-state counters. The full-app UI test covers
composer and async-answer gating, retained text, native interrupt, reconnect
ACK versus verified readiness, and refresh at an unchanged Agent revision.

Validation logs remain under ignored `target/t17-*-tests.log`. CI is required
before independent Lead/Opus review; this note does not claim that review or
authorize deployment.

Pre-R1 local regression results: Core **322 passed, 4 explicitly ignored** (the
pre-existing installed-CLI/private-database cases), bridge **28 passed**.
Web typecheck/build and all **22 test files** passed, including the full-app
collaboration recovery case and all five recovery component cases.

## R1 finding and R2 validation

Real independent Opus R1 found `/messages` created a sending receipt before
collaboration admission. That finding is fixed in the R2 candidate on `6714dd9`;
it is not claimed to have passed the final independent review yet.

`core/src/collaboration_admission_tests.rs` uses actual loopback HTTP requests
and isolated protocol fixtures. It verifies ordinary, expected-Turn and async
answer admission without receipt/journal/user-item/turn submission; restored
readiness; existing client-ID retrieval while unready; delayed native attachment
and transport failure without an unsent receipt; automatic idle recovery;
check-only offline active recovery; recovery from missing readiness; and native
approval response before/after reconnect without generation replacement.
The detail test holds the native owner during GET, observes both live fields and
`agent.changed`, and checks unchanged revision, `lastSeq` and unread counts.

The full-app UI checks both live fields refreshing at the same revision, retained
composer/async drafts, interrupt availability, and an explicit admission refusal
without an uncertain preview. Existing lost-response/idempotence and native
approval tests remain in the affected regression set. Claude's shell snapshot
update still precedes the Evidence early return, and both Codex event routes
retain their shell refresh hook.

The native runner now asserts HTTP admission refusal and absence of a receipt.
The full native three-harness experiment was not repeated for R2; its earlier
credential transport/rotation evidence above remains explicitly tied to the
pre-R1 run. R2 validation logs are `target/t17-r2-{core,combined,web}-tests.log`.
The affected Core suites all pass (collaboration, receipts, permissions, remote
recovery, background shells, concurrency, timing, live events and output on
demand). Web typecheck/build and 58 tests across the full-app, recovery and
conversation-time files pass. The runner also passes Python syntax validation.
The first R2 CI run exposed the existing project fixture's premature mount wait:
the initial "All projects" shell satisfied it before the workspace response.
The fixture now waits for that response; all 14 project tests pass locally.
