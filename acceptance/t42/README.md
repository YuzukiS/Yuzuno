# T-42: persistent PR reviews

Implementation worktree: `/home/developer/yuzuno-next/.claude/worktrees/t42-pr-review`, branch `feat/t42-pr-review`, base `663a80fcc8c1b66d330cbf663ddee2791e9681ba`.

The final candidate also integrates main `a170045482f87b6088712e4169a5f16ce18bb91b` (T-31 image input). The only manual merge resolution retains both module declarations in `core/src/lib.rs`; review behavior is unchanged. The PR's CI validates the combined tree. Native evidence below predates that integration.

It subsequently integrates main `f5ba8d15b3b1f0e97f0a9963e1d47ce2ca6d37a2` (T-38 clarification forms). This merge is automatic: `lib.rs` adds the clarification module, while the existing Claude/Workspace message and receipt paths gain T-38's changes. No review module, reviewer entry point or review UI code changes in that merge; the final PR CI checks the combined candidate.

Core owns each review independently of the requesting Agent. GUI and authenticated MCP share start/list/get/cancel. A receipt commits before source preparation begins. Identical actor/request keys return the existing run; changed payloads fail, and explicit new requests retain separate rounds. Task status/result submission never starts a review.

Settings stores the default Harness/model in Workspace SQLite. Accepted runs freeze that setting and their notification recipient. Codex defaults to `gpt-6.1-sol`; Claude choices come from the native catalog. The installed catalog resolved `default` to `claude-opus-5-5[1m]` during acceptance. There is no automatic Harness/account fallback.

## Fixed source and isolation

GitHub PR base/head SHAs are resolved once, compared with the displayed SHAs when supplied, and used to compute the whole merge-base..head diff. The first version rejects unsupported binary/missing/truncated patches, 300-file compare boundaries, incomplete trees, oversized source (750 KB) and path indexes (150 KB), rather than silently reviewing a partial PR. It retains full patch/source JSON under Core's `pr-reviews/<reviewId>/source.json` and each extra context read alongside it. The database retains the original report and normalized finding locations. Cache freshness and both-SHA report obsolescence remain separate.

Both reviewers expose `source_read(path, revision=head|mergeBase)` for unchanged callers/types/configuration/tests. Core resolves only the frozen revision, validates relative paths and records path/revision/blob. Each extra file is limited to 100 KB, with 32 reads/750 KB overall; failed reads make a clean conclusion unknown. Source is data, never a checkout or executable.

Codex uses an ephemeral official app-server thread and native `turn/start.outputSchema`. Native `review/start` was measured to return rendered review text, so it is not used as a structured report transport. The installed 0.162.1 runtime rejects old `readOnly.access`; the implementation uses a named restricted filesystem profile, network disabled, no approvals, and checks the effective profile/model/instruction sources. Shell, apps, hooks, plugins, memory, multi-agent and other execution features are disabled. Native apply-patch capability is still subject to the read-only sandbox; any observed command/file-change/other unauthorized tool attempt stops the review.

Claude uses a separate official SDK 0.3.296 query and its existing host login. No author session, Workspace MCP or filesystem settings are inherited. Built-in tools are empty; only the Core source tool and native StructuredOutput tool are exposed and checked. Skills, auto-memory, hooks and cloud MCP connectors are disabled for this query. SDK outputFormat returns the original result and structured report. Cancellation closes only the owned bridge/query, with shutdown confirmation required.

Terminal run/report, task activity and a normal mailbox notification commit in one transaction. The sender is `{kind: system, id: core, name: Yuzuno Core}`. MCP requests notify their actual caller; GUI requests explicitly choose a recipient or task-only display. Existing doorbell rules govern delivery and preserve mail for closed/offline/limited Agents. Startup turns interrupted runs into unknown and notifies once; it never resumes paid reviews automatically.

## Real acceptance

All runs used a separate Core on port **4475**, its own database under `target/t42/lab/data`, and a new acceptance Dev Agent. Existing daily Core/UI, Dev2/Dev3, and retained T13 lab on 4473 were untouched. Existing GitHub PR `YuzukiS/Yuzuno#1` was read without repository mutation.

- Codex run `5fa7da4a-136f-4e18-9324-068aecafb89a`: actual `gpt-6.1-sol`, completed, 14 fixed-version context reads. The original author Turn contained only `review_start`, ended while Core was preparing/running, then a new normal doorbell Turn called `peer_read` and `review_get`.
- Claude run `c245b7ed-689b-4985-839f-de9d7149d5c8`: actual `claude-opus-5-5[1m]`, completed, four unchanged-source reads, the same after-Turn mailbox/report chain. Both reports and Core system messages retained; neither marks the acceptance task done.
- Real Chromium rendered the same persisted review IDs, actual models and source-read evidence with no page errors. GUI run `71c02b03-89ef-48fa-9527-95660de857af` started through the shared service, was cancelled after actual Codex startup, retained its report, and emitted one system notification. Repeating the exact HTTP request before/after cancellation returned that same ID. Changing Workspace settings while it ran left its frozen Codex setting unchanged.
- `native-context.mjs` supplies a deliberately small, inert units-regression fixture. Real Claude read the unchanged caller and found the cents-to-dollars regression at changed line 2. Its native tool list contained only StructuredOutput and `mcp__review__source_read`; no delegated agents or command execution occurred.
- An early Codex compatibility attempt is retained as unknown with the exact rejected permission parameter. It was not silently retried or mislabelled passing. The corrected request used a distinct run.

Reproduction entry points: `native-flow.py` requests a review through the native lab Dev and observes Core (the Agent does not poll); `browser.mjs` checks retained UI identity; `gui-cancel.mjs` exercises GUI cancellation/idempotency/settings freezing. Scripts require an explicitly prepared isolated 4475 lab and preserve generated evidence under `target/t42`, which is not committed. No credentials are copied into acceptance artifacts.

## Checks

- Seven focused Core tests: durable request dedupe/settings freezing, history/recovery, full-patch rejection, both-SHA obsolescence, finding validation, context limits, atomic/deduplicated system notification including a closed recipient and restart.
- Core library regression suite: 251 passed initially, three failures diagnosed. The new tool-schema description was corrected and its test passed. Two unrelated Unix-socket tests needed a shorter temporary path; all five remote tests passed with a private `/mnt` mount backed by this worktree's `.t` directory (no host `/mnt` writes).
- UI production build/typecheck; three review UI tests and three existing GitHub UI tests passed. All 43 existing Claude bridge tests passed.
- Independent R1 found that periodic refresh discarded loaded older review pages. The fix merges records by review ID while retaining the oldest pagination boundary and mounted report. A 60-record UI regression first failed on the original code (20 rows remained instead of 42 after two new records), then passed with active/idle timer refreshes, an expanded older report, continued pagination, no duplicate rows, exhausted history and a task switch. The production UI build and all four focused review UI tests passed after the fix; no native reviewer behavior changed or paid acceptance run was repeated.
- R2 found that retained historical rows kept their old revision-validity metadata. The authorized point fix derives validity for every rendered row from its frozen base/head and the current linked PR snapshot, preserving Core's unknown/null semantics and the separate cache-stale warning. A 45-record regression reproduced the missing warning before the fix, then passed for head-only/base-only changes, restoration to the reviewed versions, missing frozen/current versions, a removed link, and stale snapshots with matching or changed versions. The older report stays expanded throughout. The production UI build and all five focused review UI tests passed; this follow-up does not change Core or start another full review round.
- CI/independent review status is tracked on the PR and T-42. These local results do not replace Lead's independent review.

## Official references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): isolated threads, dynamic tools and per-turn outputSchema.
- [Codex permission profiles](https://learn.chatgpt.com/docs/permissions): restricted read roots and disabled command networking.
- [Claude SDK structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs).
- [Claude SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
- [Claude settings-source isolation and its limits](https://code.claude.com/docs/en/agent-sdk/claude-code-features).

Protocol/schema probes and upstream Codex source references are retained under `target/t42/research` and `target/t42/protocol`. This feature relies on the installed native APIs; unsupported models or isolation settings fail explicitly.
