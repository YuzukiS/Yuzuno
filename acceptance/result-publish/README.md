# T-37 acceptance: result_publish

`live.py` runs a lab Core on port 4494 with its own data folder, built from this
branch. `browser.mjs` reads the recorded Turns in headless Chromium.
`codex-instructions.py` probes the installed Codex app-server directly. Evidence
JSON, screenshots and the lab folder are local only (git-ignored).

There are two rounds, then an integration check:
- **Round 1:** the tool with no capability notice.
- **Round 2:** after the Lead asked that Agents know about the capability without the user mentioning it. It adds a once-per-session notice.
- **Integration on main 9ca6e6e:** after T-20 merged, with a small receipt.

## Evidence limits (from the R1 evidence audit)

These narrow what the runs below show.
- **Provenance:** the run records of rounds 1 and 2 have only timestamps. They hold no candidate SHA, no Core/validator/web artifact hash and no Core PID, and these are not added after the fact. Only the integration run below records them.
- **Tool calls:** the `toolCalls` / "Tool calls" columns collect only `result_publish` and `peers_list` calls. "None" means neither of those ran; other tools are not counted.
- **Natural tasks:** "6/6" is two fresh Agents, one per Harness, each doing the three tasks in sequence in one session. The later tasks had the earlier successful calls in context. These are single samples, not a success rate.
- **Configured instructions:** composing Codex `developer_instructions` was shown for the sessionFlags (`-c`) layer only. Other user and project config layers were not exercised.
- **Restarts:** the standalone probe shows a real process restart. The integrated `rules` restart has a rollout count but no Core PIDs from before and after, so it alone does not prove that Core restarted.
- **Codex degradation:** in round 2, Codex never tried the unavailable tool. Its degradation evidence is round 1 (codex 12 and 13).
- **Browser counts:** these are assertions. "Draws its table or chart" checks `tbody tr > 0`, which for a BarChart is its equivalent data table, not the chart itself. "Read once" asserts at most once.
- **Candidate 9f8f4df:** commit `88b39d8..9f8f4df` changed only acceptance files (this README, `live.py`, `browser.mjs`, and the new `codex-instructions.py`). The product source is identical, but it is not README-only.
- **Release install:** a real managed-release install is not covered.
- **Turn pinning:** a result is pinned to the Agent, session and Turn. No connection generation is stored; a reconnect starts a new Turn.

## What is real and what is simulated

| Part | Kind |
| --- | --- |
| Lab Core, its MCP endpoint, SQLite, the generated validator under Node | real, this branch |
| Codex (gpt-6.1-sol, low effort) and Claude Code (Sonnet 5; one Haiku 4.5 run) Turns and tool calls | real Harnesses, normal CLI logins, no credential copied |
| `probe` and `basics` | **simulated Harness**: this script calls the lab MCP endpoint with the lab Agent's own credential, read from the lab database |
| `no-node` | Core's Node (`YUZUNO_NODE`) points at a missing file. The host still has Node, so Codex runs. Claude's bridge uses the same setting, so Claude was not run in that mode |
| `no-validator` | `YUZUNO_RESULT_VALIDATOR=""`, which is what a managed release without the bundle gets |
| `rules` | a configured Codex `developer_instructions`, passed by a `codex -c` wrapper (the sessionFlags layer); nothing in `~/.codex` is written. Project rules come from `AGENTS.md` / `CLAUDE.md` in `lab/rules-work` |
| `codex-instructions.py` | a separate `codex app-server` (0.162.1) run by the script, with no Core. It reads the rollout of its own thread from `~/.codex/sessions` |
| The induced case | the prompt **tells** the model to submit an invalid result first. This exercises the feedback loop; it does not show a natural mistake |

## Round 1 runs (2026-10-14)

Builds:
- **A:** the first build, which did not tell Agents where results appear.
- **B:** same source as the final commit. It adds "displayed at the end of this Turn, below your reply" to the description and the accepted answer.
- **C:** a reverted experiment with a stronger MCP server instruction.
- **D:** a rebuild of B.

| # | Harness | Case | Build | Tool calls | Shown |
| --- | --- | --- | --- | --- | --- |
| codex 1 | Codex | bare request | A | none, Markdown table | — |
| codex 4 | Codex | request + button line | A | peers_list, result_publish ✓ | v1 |
| codex 5 | Codex | simple question | A | none, one sentence | — |
| codex 6 | Codex | induced error | A | rejected `row_mismatch`, then ✓ | v1 (1 rejection stored) |
| codex 7 | Codex | bare request | B | none, Markdown table | — |
| codex 8 | Codex | request + button line | B | ✓, reply says "the table below" | v1 |
| codex 9 | Codex | bare request | C | none | — |
| codex 10 | Codex | user asks "Show the comparison as a table I can sort" | D | ✓, reply says "appear below" | v1 |
| codex 12 | Codex | same as 10, `no-validator` | D | `validator_unavailable`; answered with a static table, said why | — (0 rejections) |
| codex 13 | Codex | same as 10, `no-node` | D | `validator_unavailable`; answered with a static table, said why | — (0 rejections) |
| codex 14 | Codex | simple question | D | none, one sentence | — |
| codex 15 | Codex | induced error | D | rejected `row_mismatch`, then ✓ | v1 (1 rejection stored) |
| claude 1 | Claude **Haiku** | request + button line | A | ToolSearch found the tool, but Haiku reloaded `peers_list` repeatedly without calling it, then wrote Markdown | — |
| claude 2 | Claude Sonnet | request + button line | A | ✓, reply said "live above" (the cue for build B's wording) | v1 |
| claude 3 | Claude Sonnet | bare request | B | none, bullet text | — |
| claude 4 | Claude Sonnet | request + button line | B | ✓, reply says "shown below" | v1 |
| claude 5 | Claude Sonnet | simple question | B | none, one sentence | — |
| claude 6 | Claude Sonnet | induced error | B | rejected `row_mismatch`, then ✓ | v1 (1 rejection stored) |
| claude 7 | Claude Sonnet | bare request | C | none | — |
| claude 8 | Claude Sonnet | user asks for a sortable table | D | ✓, reply says "shown below" | v1 |

No reply repeated the result or a `yuzuno-ui` block.

### What this shows and what it does not

- **No template needed:** without the old template, a request that asks for a table or chart produces a useful result. The request can be the button's one line or the user's own words (codex 4, 8, 10; claude 2, 4, 8).
- **Bare requests stay text:** in round 1, a request that does not ask for one stayed text in every sample (codex 1, 7, 9; claude 3, 7). That shows only that the tool was not used in these runs.
  - **Observed:** both Harnesses load MCP tools on demand.
    - Claude 1 loaded `result_publish` and `peers_list` with `ToolSearch` before it could call them.
    - Asked to list its yuzuno tools without calling any, Codex replied that none were in its context (lab Turn 2). Asked to call `peers_list`, it found it and listed `result_publish` among the yuzuno tools (lab Turn 3).
  - **Inferred:** with no mention of the capability, the models did not look for such a tool. Round 2 tests exactly that.
  - A stronger "when to use it" sentence in the MCP server instructions (build C) changed nothing, so it was reverted.
- **Simple questions** get plain text with no tool call.
- **Errors can be corrected:** both Harnesses read `{code, path, reason}` and fixed the result on the next call. The rejection counted once (`rejectionsLeft: 2`); only the accepted version is displayed.
- **Haiku 4.5** could not finish the two-step flow (peers_list, then result_publish) in its one run.

### Simulated-Harness probe (`probe`, build D, Codex Agent): 10/10

All against the real lab Core:
- **While idle:** `activeTurnId` is null, and a call naming the last Turn gets `no_active_turn`.
- **During a real running Turn:** `activeTurnId` equals that Turn, and a call naming the previous Turn gets `stale_turn`.
- **Retries:** the same `requestId` returns the identical first answer, both during and after the Turn. A different payload under that `requestId` gets `idempotency_conflict`.
- **After the Turn:** a new request gets `no_active_turn`.
- **Storage:** one row, shown with that Turn.

### basics (`basics`, build D): all three modes

Core starts in normal, `no-node` and `no-validator` mode. Each time:
- tools/list has the same 13 tools, result_publish included;
- peers_list, task_create, task_get, task_comment and peer_read succeed;
- `/api/updates` and `/api/health` answer;
- a result_publish with no Turn is refused without a receipt.

No panic in the lab log.

### Browser (`browser.mjs` as it was in round 1, build D): 27/27

For every recorded Turn above, the conversation shows exactly the accepted results; Turns with none show nothing. Each result:
- draws its table below the reply, with the published title;
- is read once;
- causes no writes besides the conversation's read receipt;
- produces no page errors.

### Daily Core

The 4317 listener (same pid) and the hash of `/home/developer/yuzuno-next/web/dist` were the same before and after (`evidence/daily.json`).

## Round 2: once-per-session capability notice (build 88b39d8)

The notice is one paragraph generated with the tool description (`contract.ts` → `contract.json` `capability`):
- comparisons and data worth exploring suit a table or chart;
- simple questions, confirmations and text-only requests stay plain text;
- fix the problems the tool returns, and don't repeat an accepted result.

How it reaches each Harness:
- **Claude:** appended to the bridge's existing collaboration system-prompt append. Claude Code applies it at every start and does not record it in the session.
- **Codex:** sent as `developerInstructions` on `thread/start` only, and only when the Yuzuno MCP is attached. Nothing is written to user files or account config.

### Codex semantics, probed first (`codex-instructions.py`, codex-cli 0.162.1)

Setup: a configured `developer_instructions` "KIWI" (`-c`), plus an `AGENTS.md` "PAPAYA" in the folder. Outcomes are the model's answers plus the developer messages recorded in the rollout.

| Case | Instructions in effect |
| --- | --- |
| no `developerInstructions` | KIWI, PAPAYA |
| `developerInstructions` = notice "MANGO" | **MANGO, PAPAYA: the configured KIWI is replaced** |
| `developerInstructions` = configured + notice | KIWI, MANGO, PAPAYA, once each |
| resume (new app-server process), with or without the field | KIWI, MANGO, PAPAYA. The rollout still holds one KIWI and one MANGO developer message |

So Core reads the effective `developer_instructions` for the Agent's cwd (`config/read`) and puts it before the notice. If it cannot be read, nothing is added. Resume sends no `developerInstructions` (existing `resume_params` behaviour), and Codex records none again.

### Runs: build 88b39d8, fresh Agents, Codex gpt-6.1-sol low and Claude Sonnet 5

The three tasks are fixed, worth a table or chart, and contain no word about tables, charts, results or tools.

| Case | Codex | Claude |
| --- | --- | --- |
| cache choice (comparison) | ✓ Table + Sources | ✓ Table |
| endpoint latencies p50/p95 (data) | ✓ BarChart + Table | ✓ Table |
| Python dependency managers (comparison) | ✓ Table + Sources (default title applied) | ✓ Table |
| "Just confirm in one sentence" | text, no tool | text, no tool |
| "Plain text only please: no tables, charts or interactive results" | text, no tool | text, no tool |
| `no-validator`, latency task again (resumed session) | text, no attempt; the same session had already published for this question | tried, `validator_unavailable`, then text saying why |

Each case ran once, and there were no other runs. One fresh Agent per Harness did the three tasks in sequence, then the two text cases. With the notice, all 6 natural-task Turns published, with no rejection (see Evidence limits).

### Native rules kept (`rules` mode)

Fresh Agents in `lab/rules-work`, run on the dependency-manager task.
- **New session:** both published.
  - Codex kept the `AGENTS.md` rule ("-- project rule") and the configured developer rule ("-- dev rule").
  - Claude kept the `CLAUDE.md` rule.
- **After a Core restart (sessions resumed):** a confirmation question still followed every rule.
- **Codex rollout after the restart:** two Turns in, it holds the developer rule once and the notice once (`evidence/codex-r-rollout.json`), so nothing accumulates.

### Browser (`browser.mjs`): 73/73 assertions

Covers every Turn recorded in both rounds:
- each shows exactly its accepted results, below the reply, with the published title and a non-empty table (`tbody tr > 0`);
- each version is read at most once;
- no writes besides the read receipt, and no page errors.

The daily Core and its web/dist were unchanged; no panic in the lab log.

### Limits

- **Single samples:** each case was run once per Harness. "Not every question gets a card" is by design; the tool stays optional.
- **Haiku 4.5:** stays as in round 1 (one run, it did not finish the two-step call).
- **Wording:** one Sonnet reply in round 2 still said the table was "above". The tool answer says "below your reply".
- **Older sessions:** Codex sessions started before this build get no notice when resumed, and Core does not add it to them.

## Integration on main 9ca6e6e (T-20 merged)

The branch was rebased with no conflicts. The R1 candidate is kept as `t37-r1-9f8f4df`, locally and on origin.

**What T-20 changed.** Claude's own output is now shown as a native Turn. If it opens while one of the Agent's prompts is running, it is marked `_yuzunoUnmatched`, because nothing yet says whose it is. The mark clears only when Claude's result says it started that Turn itself. The R1 candidate pinned results to the latest in-progress Turn, so a result could have been tied to such a guess.

**Fix (`4e0e9c0`).** The Agent brief carries the mark. While it is set, `peers_list` gives no `activeTurnId` and `result_publish` answers `no_active_turn`.

**Test.** `claude::tests::results_go_only_to_confirmed_turns_through_native_output_and_close` drives T-20's own event dispatch, fake bridge and close path. In order:
1. A prompt's result is accepted.
2. Unmatched native output is refused, both for the prompt and for the native Turn.
3. Claude's confirmed own Turn is accepted, and the earlier prompt Turn becomes `stale_turn`.
4. After a close, the old Turn gets `no_active_turn`.
5. On the next Turn it gets `stale_turn`, and a retry replays its first answer.
6. Results stay on their own Turns (1, 0, 1, 0).

A mutation run without the check fails at step 2.

**Suites.** Core passes the full serial suite (231 lib tests plus integration), the bridge passes 39 tests (T-20's and T-37's), and the web passes 32 test files.

**Receipt.** Run with `live.py start normal` on HEAD `4e0e9c0`, worktree clean for core, web/src and runtimes:

| | sha256 / value |
| --- | --- |
| Core binary | `8bb2f8f6436a2193a6b74a7e963a073f5afb8071c38d6e9721970a0b69d88f09` |
| validator.mjs | `c14906e5647e500d9ed3b2b60e14b6bdf15b47b2d02e5a05adcfef8b5ad40546` |
| contract.json | `48e59e0442d1720126f2cc4e3f04f37b60c969003206261d7ef70b8a02c55a34` |
| bridge.mjs | `f0afa6f64958e4d43c979e64f36b1a5a3ca9939c829feb67b7d7c3044c63c73d` |
| web/dist (all files) | `15e4a485103ac1005544d9ff77e2224b100bda57ad2e2371aed12abc99b42ffa` |
| lab Core PID | 1222932, the same process listening on 4494 |

**Real Claude run.** A fresh Sonnet Agent got the latency task (`claude-i-latency-1`). Its `peers_list` returned `activeTurnId` equal to that Turn's id. `result_publish` was accepted for that Turn (BarChart, Table, Text), so the notice carried by the merged bridge append still reached Claude. The first record cut the tool output before that field; `activeTurnIdSeen` was set afterwards from the full output and is labelled so in the record.

**Browser:** 76/76 assertions over every recorded Turn.

**Daily Core:** 4317 and its web/dist were unchanged, and there was no panic in the lab log.

## Not covered here

- Revision chains, the per-Turn limits, the Turn changing during a check, a hung or tampered validator, and deleting an Agent's results. These are covered by Core tests (`core/src/results.rs`), using the real bundle under Node.
- The UI states for read failures, missing results and invalid stored specs, and the isolation of selection per version. These are covered by `web/tools/turn-results-ui.test.mjs`.
- A managed release built with `package-release.py` and installed. Covered instead:
  - packaging is tested in `tools/package-release.test.py`;
  - a fixture release with the validator verifies and runs it away from the checkout, and an older release without it still verifies (`results.rs`).
