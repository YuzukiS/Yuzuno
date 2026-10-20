# Four-slice integration

The user authorized merging the other three Agents' worktrees alongside native session import, with this integration responsible for verification and the Core/UI switch. Daily work is checked for idle Turns and pending requests before switching.

**Status: merged into `main` and deployed to the daily Core/UI on port 4317.** Dev 1, Dev 2 and Dev 3 recovered the same native sessions; no new Turn was sent.

## Included work

| Source | Reviewed head | Included behavior |
| --- | --- | --- |
| `feat/claude-p0` | `2142cd5` | Claude context estimates, reasoning summaries, native session approval offers, permission modes, runtime/account/usage facts and failure diagnostics |
| `feat/project-slice` | `2534e39` | Projects inside one Workspace, explicit Agent/task membership, default folders, scoped views and project-aware MCP |
| `feat/ui-refine` | `123d1b9` | Five palettes, compact conversation layout, current request, vertical Turn dock, grouped artifacts and outgoing-message feedback |
| `feat/codex-session-import` | `2cd9e30` | Explicit local native Codex session preview/import, saved model/effort, offline handoff and paged history |

The UI worktree's previously uncommitted source was first preserved as `123d1b9`. All four source worktrees were clean and their heads unchanged when integrated. Their existing acceptance records and original commits remain available; no worktree was deleted.

## Integration fixes

- Both Project and import migrations/routes are retained. Imported Agents carry the new optional fields, and duplicate import preserves existing Project membership without putting it into Agent JSON.
- Scope switching and the coalesced snapshot refresh hook work together. Opening a newly imported or existing Agent reveals its Project scope.
- The Turn dock, current-request display and search distinguish loaded history from a complete conversation. Loading earlier native pages retains reading position.
- Once an outgoing message appears in native history, its optimistic preview is removed. It cannot reappear when a later history window omits that old Turn.
- Claude diagnostics read fixed 4 KiB chunks and retain an 8 KiB tail, including output without line breaks. This bounds the reader as well as its final diagnostic text.
- Long account identifiers wrap within the Inspector. A browser assertion covers the text and panel boundaries.

## Candidate verification

All build caches are on disk, outside `/tmp` tmpfs. Rust compilation uses at most two jobs and tests run serially. Browser suites run one Chromium instance at a time.

| Check | Result |
| --- | --- |
| Full Rust suite | 166 passed, 2 pre-existing ignored tests |
| UI / collaboration / Projects / artifacts | 46 / 10 / 13 / 3 passed |
| Session-import UI | 15 passed |
| Claude UI / official SDK bridge | 6 / 22 passed |
| TypeScript and production build | Passed |
| UI refinement browser fixtures | 18 scenarios passed |
| Session-import browser fixtures | 7 scenarios passed |
| Combined Claude/Projects/import browser fixture | 5 groups passed, 11 screenshots, no page errors or external requests |
| Real Core browser | Imported-history paging/refresh, loaded Turn dock, and import dialog in light/dark at 1440/390px and 20px passed |

The combined fixture exercises native-looking Claude reasoning/context/runtime facts, transient `acceptEdits` versus the chosen default, an exact session approval response, Project filtering with out-of-scope pending work, and the import dialog. All writes are to a memory fixture, never a real Agent.

The isolated real Core on port 4385 reads the previously created native fork. Import, Project assignment, duplicate import, bounded history loading and Workspace membership projection passed without resuming or sending a model prompt. The previous slice had already verified a real continuation and `peers_list` on this fork. The original conversation was not resumed or sent input by these tests.

SSH Project default folders and a new paid Claude Turn were not repeated in this integration. Existing native execution evidence is distinguished from this round's regression checks.

## Cutover procedure and evidence

`switch.py` is a foreground, one-shot switch. Its plan pins the old process, candidate and source hashes, the validated UI assets, and the expected idle Agent set. It backs up SQLite and the previous executable/UI, preserves the existing data directory and port, and checks identity/history/read cursors before reconnecting the same native sessions. Recovery sends no prompt, approval, task or read receipt. Authenticated MCP health calls are limited to `task_list` and `projects_list`. Rollback restores the executable and UI without overwriting the user's database.

`daily-browser.mjs` inspects the published UI using a separate headless browser, with automatic read marking disabled and write requests blocked. Existing user windows are not controlled.

Local gitignored evidence includes `sources.json`, `core-tests.log`, `lab-check.json`, `browser-live.json`, `browser/report.json`, `ui-refine/report.json`, `session-import-browser/report.json`, `plan.json`, `switch.json`, `daily-browser-report.json`, database/executable backups, screenshots and logs. No credentials, native conversations or Workspace databases are committed.

## Completed deployment

- All four branches are ancestors of `main`; the original source worktrees remain intact and clean.
- The deployment binary was built from the main checkout into an independent target directory, so its Claude bridge reference does not depend on retaining the integration worktree. The staged UI hashes exactly matched the browser-tested bundle.
- The first attempt hit a startup assertion with no detailed traceback and automatically restored the previous executable and UI. The original database was retained, and all three old sessions were reconnected. The exact backup then passed isolated candidate startup/data checks. Startup identity checks were moved after readiness and detailed diagnostics added; the first attempt is preserved under `attempt-1/`. Its exact original assertion site was not recorded.
- The subsequent guarded cutover completed. All three Agent IDs, native Session IDs, messages, settings and read cursors were retained. Each reconnected Agent passed authenticated `task_list` and `projects_list` health checks.
- The published UI passed **21** read-only browser checks across all three real conversations, Permissions, tasks/messages, light/dark, 20px and narrow layouts. No page/HTTP errors or unexpected writes occurred; histories, read positions and board records remained unchanged.
- The daily preview endpoint successfully read the original conversation's saved `gpt-6-astra` / `ultra` settings. Subsequent user adoption exposed a native writer lock retained by the original shared daemon even while idle. Finishing a Turn was insufficient; the user approved a separate official fork. See the [handoff follow-up](../session-handoff/README.md).
- All integration-owned test Core, native and Chromium processes were stopped. The existing native client requires a refresh, not a Tauri reinstall.
