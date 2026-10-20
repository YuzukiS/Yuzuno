# First three lines — results and stopping point

Date: 2026-10-12. Scope: local Codex GUI, runtime feasibility, and a minimum Catch-up experiment. Stop here for review before expanding the product.

## 1. Local GUI and Core

The new project directly integrates native Codex threads, turns, items, approvals and user questions. SQLite persists the identity independently of the native thread, PID and UI. A single loopback Core serves the web assets and API; the Tauri client is a thin native window. The launcher reuses a healthy local Core instead of tying its lifetime to the window.

The visual direction is warm ivory, yuzu yellow, leaf green and restrained coral attention markers. Compact native workspace chrome, a narrow agent rail, readable turn content and an optional context panel take priority over dashboard cards. Small vector citrus characters add warmth without obscuring the work. Browser and native clients share content, while the native shell uses the operating system's title bar.

The actual implementation includes create/send, native execution items, fold/copy/navigation, draft preservation, command/file approval and user questions, Interrupt, explicit unread review, and bounded text/image file previews. Catch-up currently presents source records. It does not claim to generate summaries.

Validation is deliberately split: frontend build and in-process Core checks are executable in this environment; socket-based browser/native integration and successful model inference are not. The sandbox rejects even local socket creation. Native system dependencies are also missing. Therefore this line has implementation evidence, but **has not passed the real GUI vertical-slice acceptance criterion**.

The [real Core smoke run](../experiments/runtime/core-observations.json) additionally passed `Workspace::create → send → native user item → Interrupt → native completion → Store reopen`. It used the actual Codex binary in a fresh unauthenticated profile, without an HTTP listener. All five identity/history persistence checks passed. This verifies the implemented transport and state path while leaving inference, actual approval exchange and GUI interaction explicitly unverified.

One recovery corner remains: a newly created native thread with no first Turn may not yet exist in the harness's persistent history. If Core itself restarts at that point and native resume returns not found, this version reports the error instead of automatically replacing the thread. A safe empty-session retry must be added and tested before daily-use acceptance. Reopening only the GUI leaves Core alive and does not take this path.

Continuation update: this corner has now been fixed and tested for newly journaled empty sessions. See the [live acceptance continuation](live-acceptance.md) and [real recovery observations](../experiments/runtime/empty-session-results.md). The paragraph above records the first-stage state.

Final verification: 16 Rust tests pass; Clippy passes with warnings denied; clean offline npm installation, production build and 7 JSDOM interaction/sanitization checks pass. The Catch-up evaluator verifies all 22 excerpts against the original read-only SQLite source and passes five provenance/state-boundary negative checks. These are distinct from the still-pending real browser and native GUI acceptance.

Open the [standalone GUI design preview](../web/dist/design-preview.html) to inspect the design without a running service. It is visibly labelled sample content and makes no runtime calls. See [frontend validation notes](../web/README.md).

## 2. Remote persistence and accounts

See the [runtime report](../experiments/runtime/RESULTS.md) and its raw observations. Isolated real Codex app-server probes passed initialization, user-message materialization, Interrupt and session recovery in a new process. They did not complete a successful model response.

The Mac mini was identified in the old development node registry, but its stored loopback relay endpoint is not an SSH address. The environment also prohibits SSH socket creation. Remote launch, client disconnection while a task continues, replay and reconnection remain unverified. We did not substitute another machine or touch the old daemon.

The user has one Codex account and multiple Claude accounts. Empty isolated Codex profiles confirmed storage separation and no inherited account; this is **not** a two-account identity-isolation test. The official daemon's shared environment means per-client account parameters are not a credible isolation boundary. Claude's documented `CLAUDE_CONFIG_DIR` separation is the relevant next real account experiment, including the documented macOS Keychain behavior. No credentials were copied or read into reports.

The [official daemon implementation notes](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md) and [Claude authentication documentation](https://code.claude.com/docs/en/authentication) support these design constraints; runtime feasibility still needs the missing on-machine observations.

## 3. Minimum Catch-up

The [experiment](../experiments/catchup/RESULTS.md) contains four real multi-agent windows and 22 source excerpts, with original row keys and full-body hashes verified. The [comparison page](../experiments/catchup/output/comparison.html) puts raw excerpts beside a curated reference. It is an offline reference produced by the implementing Agent, not an independent model evaluation or a measured 30-second user test.

The most useful failures are concrete: latest commentary is not a final answer; waiting for another agent is not awaiting the user; identical content under two agent IDs is not independent verification; an intention to stop is not proof of a stopped process. The GUI consequently keeps unread, pending and runtime state separate, and Catch-up results are tied to unread completed turns rather than the latest historical final.

## Next, in this order

1. On an ordinary host, launch the actual Tauri window and run one real task through approval/question, an intentional error, Interrupt, copy, artifact preview and window reopening. Inspect the actual rendering and interaction at normal desktop sizes. Resolve every reason this still forces a return to the terminal before adding more product surface.
2. Use the Mac mini's actual SSH endpoint for an isolated remote daemon task: disconnect the client mid-turn, reopen it, compare retained events and results, then test daemon restart separately from client restart. Pin and record the tested Codex version. In parallel, test the user's two Claude profiles through official login and config/keychain separation; do not invent a two-Codex-account test with one account.
3. Run real work with two local agents and one remote agent. Compare a plain native-final list against an on-demand summary over the same complete turns; measure what the user can correctly explain in 30 seconds, including uncertainty and required actions. Only then choose how much summary generation/caching is justified.

Do not begin a generic multi-harness adapter, background Observer, account manager, remote supervisor, mobile hosting or broad Skills platform as a prerequisite to those observations.
