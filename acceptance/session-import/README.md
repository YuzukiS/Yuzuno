# Existing local Codex session import

This slice adds explicit native session import and continuation, using the official Codex app-server rather than copying conversation text into a new prompt. This record covers its initial isolated implementation and acceptance in `feat/codex-session-import`, while other daily Agents were working. It was subsequently merged and deployed in the [four-slice integration](../four-slice-merge/README.md).

## Interface and lifecycle

1. Open **New agent → Existing Codex session** and paste a session UUID.
2. Preview the saved conversation, working directory, model and reasoning effort. Choose an Agent name and subsequent permissions using the existing Permissions component.
3. **Add to workspace** creates an Offline record. It does not resume, send input, interrupt the source client, or change its settings.
4. Release the native session in the original client before reconnecting or sending a message from Yuzuno. A completed Turn is not a released writer lock: a shared daemon can retain an idle session. Where releasing only that session is unavailable, explicitly authorize an official fork through a completed Turn, then import the new session ID. Never delete the lock or stop a shared daemon as an automatic workaround.

The same Core-host Codex profile must be able to read the session. Remote session adoption, Claude import and cross-profile credential handling are outside this slice. No new package dependency was introduced.

Native history and saved instructions remain with Codex. The live processes, sub-agents and client-specific tool implementations of the previous client are not portable state. The real continuation below verifies retained conversational context and Yuzuno MCP access; it does not claim to migrate an executing tool or a live sub-agent.

## Protocol and storage

- Official reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server). Real acceptance used installed Codex **0.162.1** and its generated protocol schema.
- `thread/read` with `includeTurns:false` reads metadata; `thread/turns/list` reads three full Turns per page. `itemsView:"notLoaded"` reads IDs/statuses for the historical baseline. A live preview caught and corrected an invalid enum before any model input was sent.
- `thread/resume` uses `excludeTurns:true`, the saved model and explicit `config.model_reasoning_effort`. The latter matters: the native probe demonstrated that omission could inherit the local configuration's different effort.
- `codex_imports` records provenance and the first-handoff gate; `codex_import_turns` suppresses historical completion notices. The transaction prevents duplicate local native-session records. Closed Agents are reused rather than duplicated.
- Before explicit handoff, model-menu reads and collaboration doorbells cannot implicitly resume the imported session. Missing native history cannot trigger the existing empty-session replacement path.
- Earlier pages stay in the selected UI conversation only. Reconciliation refreshes the native cursor and resolves any cached unfinished Turn against its actual history, including when it has moved outside the recent window.
- Read RPCs are serialized and closed after use, including cancellation. Historical snapshots are not duplicated into the journal. The baseline currently supports up to 5,000 Turns; it fails explicitly beyond that bound.

## Verified

The original conversation was read for preview only. All mutating native acceptance used a **fork through its last completed Turn** and a separate Core/database on port **4383**.

- Core: **145 passed, 2 ignored**, serial execution. Seven new integration tests cover read-only preview, duplicate adoption, first handoff, missing-session behavior, historical unread suppression, paging and reconciliation.
- UI: existing **37 + 10** tests, **14** import-specific tests (including missing history-page ordering), **5** remote-creation regressions, TypeScript and production build passed. Seven fixture browser checks passed, including reading-position preservation.
- Real native fork: previewed **47 historical Turns**, imported three recent Turns Offline with zero unread, and returned the same Agent on a second import.
- Explicit resume kept `gpt-6-astra`, `ultra`, the original working directory and the same native thread ID.
- Exactly one new read-only model Turn recalled the agreed Workspace-wide task numbering, normal/urgent doorbell behavior and external-worktree rule. Its one `peers_list` call succeeded. No original-session prompt or interrupt was sent.
- Restarting only the isolated Core recovered the same Agent, session, settings and completed result without replaying the prompt.
- Chromium against the real Core checked earlier-history loading and refresh retention, plus light/dark, desktop/390px and 20px text layouts. No page errors or unexpected write requests occurred.
- Daily process identity and all daily UI asset hashes remained unchanged.

Memory observations are point samples, not hard ceilings: the isolated Core was about **29 MiB RSS** after the model Turn; the recovered process tree was about **655 MiB RSS**, including both the existing catalog app-server and the resumed Agent's app-server. Browser JS heap was about **6 MiB** for recent history and **12 MiB** after one older page. Build caches are on the worktree's disk-backed `target/`, not `/tmp` tmpfs. Test runtimes are closed after acceptance.

## Reproduction and local evidence

```sh
CARGO_BUILD_JOBS=2 cargo test --locked -- --test-threads=1
cd web
npm run typecheck
npm test
npm run test:session-import
node tools/remote-ui.test.mjs
npm run test:session-import:browser
npm run build -- --configLoader runner
```

`native_probe.py` is read-only by default. Its explicit `--fork --last-turn ...` creates a native fork; use a completed source Turn. `lab.py` owns only its recorded port-4383 process and separate database. `live_check.py run` is intentionally one-shot and sends one real read-only prompt to the recorded fork; it never retries an ambiguous submission. `recover` and `cleanup` use the recorded Agent. `browser-live.mjs` allows only read requests and the preview endpoint.

Local, gitignored evidence includes `native-probe.json`, `live-check.json`, `core-tests.log`, `browser-live.json`, `post-recovery-memory.json`, `browser/`, and `screenshots/`. Native history, credentials, database files, build output and screenshots are not committed. `lab.py verify-daily` verifies that this acceptance did not switch the daily deployment.
