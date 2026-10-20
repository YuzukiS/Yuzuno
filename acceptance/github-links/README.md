# GitHub links — T-40

Projects explicitly link GitHub.com repositories. A task can link multiple
existing PRs and optional Issues, displayed as compact task-card summaries and
an expandable check list in task details. Stable repository IDs plus object
kind/number identify the association; rename refreshes the readable name.
Project/repository membership is many-to-many. No association comes from cwd.

GitHub facts never change task status, task version, reviews, native sessions,
read cursors or deployment state. Unlink only removes a Yuzuno association.
Removing a Project repository retains existing task links. Project tasks must
first link that repository in Project settings; unscoped tasks accept explicit
full Issue/PR URLs.

## Shared boundary

The UI posts to `/api/collaboration/{operation}`; authenticated MCP invokes the
same Workspace service and validation:

- `github_repositories`: `projectId`, `action` (list/link/unlink), `input` or
  `repositoryId` for the corresponding action.
- `github_links`: `taskId` (canonical T-N or legacy UUID), `action`, `input`
  (full GitHub.com Issue/PR URL), or `linkId`.
- `github_refresh`: exactly one `projectId` (repository metadata) or `taskId`
  (that task's linked objects). Returns cached data and `refreshing`. List again
  to observe completion.

The existing official `gh` on the **Core host** supplies authentication, including
private-repository access. Yuzuno neither reads tokens nor changes account/config.
No gh login, remote mutation, OAuth flow or review execution is implemented.
Missing CLI, authentication, permission/404, offline/timeout and rate-limit errors
are classified without exposing raw CLI diagnostics. GH credentials stay out of
stored JSON, SSE and logs. No additional npm/Cargo dependency is introduced.

`gh api --hostname github.com --method GET` receives structured argv and explicit,
validated repository paths. Each read is capped at 12 seconds and 2 MiB stdout;
a whole lookup/refresh has 25 seconds, foreground slot wait has 2 seconds. Two
refresh jobs run concurrently (a PR job reads checks/statuses in parallel).
Queued jobs must acquire update admission before starting; accepted operations
run to completion even if an MCP caller disconnects. SQLite work uses `ws.stored`
and the existing single writer, never a lock held during network IO.

Snapshots persist separately from task records. Refreshes coalesce by stable
object identity, with 30-second cooldown (five minutes after rate limiting).
Open detail panels refresh every two minutes while visible and poll only the
local cache while a read is running. Board queries include cached summaries in
one bounded query; SSE/keystrokes do not trigger GitHub network reads. Older than
three minutes or a failed refresh is explicitly stale. Closing/changing the panel
aborts its reads and ignores late responses; drafts are not reset by refreshing.

## CI evidence

PR metadata supplies the observed head SHA. Both check runs and legacy statuses
are fetched for that exact SHA, and the SHA/observation time are displayed.
Pending/running, failed, cancelled, no checks, skipped/neutral, unknown and success
remain distinct. Missing/mismatched SHA or truncated check lists (over 100 runs
or statuses) yield **unknown**, never a green claim. Failed reads preserve the
last successful snapshot and show its age/error. This is delivery information,
not branch-protection evaluation or a merge gate.

Official references:

- [gh api](https://cli.github.com/manual/gh_api)
- [Check runs](https://docs.github.com/en/rest/checks/runs)
- [Combined commit statuses](https://docs.github.com/en/rest/commits/statuses)
- [Repository endpoints](https://docs.github.com/en/rest/repos/repos)

## Verification

Deterministic Core tests cover strict URLs/argv, current-vs-old SHA, incomplete
checks, all CI result categories, missing CLI and sanitized error classes,
coalesced refresh, real fixture 404 preserving cached data, removing an association
during refresh, deadline termination, M:N repository links, multiple PRs, optional
Issues, duplicate links/unlinks, rename, Store restart and unchanged task status.
The built-UI tests cover task summaries, link/unlink, failed-link drafts, stale
snapshots, mismatched-SHA display, refresh while typing, and late replies after
changing tasks. Existing Project and collaboration interaction tests also pass.

Real isolated acceptance uses `core/examples/github_links_acceptance.rs`: the
production HTTP/MCP router, a **seeded no-model Agent**, new data directory, port
4491 and independent production UI. It starts no Codex/Claude harness and reads
only existing GitHub objects. `live.mjs` links the existing YuzukiS/Yuzuno PR #8
through the GUI, compares the HTTP and authenticated MCP results, checks exact
head CI, duplicates/unlinks, draft preservation and task independence. Headless
Chromium screenshots cover light/dark at 20px, widths 1440 and 760. `issue-read.py`
reads an existing public cli/cli Issue without creating samples on GitHub.

Local 2026-10-14 receipts (not uploaded):

- `target/github-links/browser-final/receipt.json`: PASS; PR #8, merged,
  head `f5aaa4d27e6b21a48df574485c2dc186627977fb`, successful current-head checks.
- `target/github-links/browser-final/issue-receipt.json`: PASS; cli/cli #14692,
  open, with `gh version 2.102.0`.
- `target/github-links/ui-tests-final.log`: new UI 3 + Project 14 pass;
  `collaboration-tests-final.log`: collaboration 10 pass.
- `target/github-links/core-tests.log`: 222 passed, two intentionally ignored
  native tests before final timeout/run-to-completion refinement;
  `core-final.log`: final seven focused tests passed and acceptance host built.

The initial UI fixture used fixed waits and failed under load. The first CI run
also caught a click on the disabled task-board button before workspace loading
finished, followed by leaked test timers. The fixture now waits for the enabled
button and actual task list, closes its window on setup failure, and exercises a
delayed workspace response. An existing message-view assertion was updated to allow
the new read-only GitHub queries. Initial default input styling was refined and
the real browser check rerun. No failed attempt is counted as a pass.

Limits: no arbitrary GitHub Enterprise host, branch-protection rules, webhook,
remote mutations, account switching or review/deployment certification. Real
checks were observed rather than deliberately changing remote CI; transitions,
errors, truncation and renames use deterministic fixtures. Browser coverage is
headless Chromium, not the user's Tauri window. No daily Core/DB/web/dist was
modified. Existing worktrees and acceptance data are retained.

## Reproduce safely

Set TMPDIR and CARGO_TARGET_DIR under the project's target directory. Use the
shared `target/heavy-slot.sh`, cargo `-j4`, and serial Rust tests. Build the web
with `vite build --outDir <isolated-directory>` and set `YUZUNO_UI_DIST` for tests.
Do not run the default web build against the daily checkout.

Build `--example github_links_acceptance`, then run it with a **new** absolute
data directory, isolated UI directory and unused non-4317 port. For live.mjs set
`YUZUNO_GITHUB_TEST_URL`, `YUZUNO_GITHUB_TEST_DATA`, `YUZUNO_GITHUB_TEST_OUTPUT` and
`YUZUNO_BROWSER_BIN`. The local MCP credential fixture is mode 0600 and is not
printed or included in receipts. Stop only this owned test host after acceptance.
