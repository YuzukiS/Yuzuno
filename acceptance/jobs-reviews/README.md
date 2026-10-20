# T-66: PR reviews as the third Jobs source

Jobs now has three sources: **Local**, **GitHub Actions** and **Reviews**. Reviews shows every PR review in the Workspace in one place, with its state, conclusion and whether the PR has since changed. Each review opens its full report in the original task. The list is read only. Reviews still start only from a task's PR (or `review_start`); this adds no start, retry or cancel control, no new review state and no new notification.

## Core

`GET /api/reviews?agentId=|taskId=|reviewId=&before=` (`core/src/pr_review/store.rs`, `index_pr_reviews`):

- **Order and paging:** newest first by row, 20 per page with `hasMore`/`nextBefore`, as the task's own review list does.
- **Scopes:** all reviews (Workspace), one task, or the reviews one Agent requested. The Agent filter matches only the recorded `requestedBy` with kind `agent`. It never uses the notification recipient or the task's assignee. Reviews the user started are shown as requested by you, under Workspace. Older records without `requestedBy` show **Requester unknown** under Workspace only.
- **One review:** `taskId` with `reviewId` reads that row directly, however old. Links use this, never paging.
- **Rows are summaries:** task T-N and title, PR, round, status, phase, conclusion, requested and actual reviewer, fixed SHAs, times, error, requester, `findingsCount` and `outdated`. No report, findings text or source evidence. The report is read only when opened in its task.
- **Outdated** compares both fixed base and head with the task's current PR link, as the task view does. The links are read once per task on the page. `null` means the current PR revision is unknown.
- **Refresh:** whenever a review is created or changes, Core also publishes `workspace.changed` with scope `jobs`, which the app already routes to Jobs. There is no per-Agent watcher and no polling.
- `review_get` (and the task's report read) now also return the row's `cursor`, so a linked review can sit in order among loaded pages.

## Jobs → Reviews (`web/src/ReviewJobs.tsx`)

- Workspace / Agent / Task scopes share the Jobs scope bar. With an Agent selected, the list says it shows the reviews that Agent requested itself.
- Each row: state (and Outdated), PR and round, task T-N and title, reviewer, short reviewed head, time taken (or so far), requester and request time. The reviewer is the confirmed harness and model, or the requested one marked "(requested)" when no model was confirmed.
- States: Preparing, Reviewing (with its phase), No actionable findings, Changes requested, Conclusion unknown, Failed, Cancelled, Outcome unknown. Unknown is never a pass. A failed review with no actual model says **Model not confirmed**; it does not claim where it failed.
- **Earlier reviews** loads the next page. A refresh re-reads every page already loaded, up to ten pages (200 reviews), so no retained row keeps stale facts such as Outdated; beyond that, older rows are dropped and can be loaded again. Older pages loaded while a refresh runs are kept.
- A link opens Jobs in its task's scope with that review selected, read directly however old. Each refresh (Jobs change, Refresh, window visible again) reads it again while it is selected, so a failed read can be retried and its state and Outdated stay current. Changing scope drops the link.
- A hidden window does not refresh; it reads once when it is visible again. Changing scope or closing Jobs aborts requests still on their way, and a late answer for an old scope is dropped.
- Empty and error states are shown; Refresh reads again.
- **Open full report in T-N** closes Jobs (one dialog at a time) and opens the task with that review scrolled to and its original report open (`yuzuno:open-task-review`).

## Links to one review

- **Task:** the board's PR reviews (`PrReviews`) take the linked review id, read it directly, show it in order among the loaded rounds and open its original report.
- **Mail:** in the board's Messages, Core's own review result mail (system sender with `reviewId`) has **Open review**. Mail from an Agent never gets this link, even if it carries a `reviewId`.
- **Conversation mail notice:** `openJobs({ source: "reviews", taskId, reviewId })` opens Jobs on that review. The button in the delivered-mail rows depends on T-54 (Dev 5), which adds review metadata to those rows; whichever lands second adds it there.
- Following a link creates no review, notification or read receipt.

## Real records, read only

`target/t66/lab/lab.py` (not committed) copies Dev 6's stopped T-60 review lab, which holds four real reviews of PR #37 and no Agents, with SQLite's backup API from a read-only handle. A lab Core built from this branch serves the copy on port 4466 with `--codex /bin/false`, so no model can start. It makes only GET review reads, and a headless Chromium walkthrough records every request.

| Check | Result |
|---|---|
| Workspace | All four, newest first, one page: round 4 no findings (requested by you), round 1 changes requested with 1 finding, round 2 failed, round 3 completed with conclusion unknown. All name T-60 and its title. |
| Summaries | No report, findings text or source evidence in any row. |
| Failed round 2 | `failed`, no actual model: shown as **Failed** with **Model not confirmed** and its retained error. |
| Outdated | Round 1 `true` (reviewed head 3af05d9, PR now edb6225); rounds 3 and 4 `false`; round 2 `null` (no fixed SHAs). |
| Agent scope (Dev 3) | Rounds 1–3 only. Round 4, which the user started, stays under Workspace. |
| Link to one review | `taskId=T-60&reviewId=…` returns just that row. |
| Browser | Jobs → Reviews lists the four; no start, cancel or new-job control. **Open full report in T-60** closes Jobs and opens T-60 with round 1 outlined, its finding and its original report open. No horizontal overflow at 390 px. |
| Requests | GETs, plus the board's own collaboration reads (`task_list`, `task_get`, `github_links`, `peers_list`; `github_refresh` blocked so nothing left the host). No review start or cancel. |
| Data | The four review rows are identical after the run; the source lab's files hash the same. |

Screenshots and both reports are kept with the lab, under the project `target/t66/lab/`.

## Checks

- **Core** (`core/src/pr_review/tests.rs`): two reviews running at once on two tasks stay apart; summaries only; failed before a model, unknown, changes requested and no findings; the Agent filter excludes a review the user requested for that Agent; old records without a requester; a direct link to one review, and nothing for the same id under another task; outdated after a head change and after a base change; 45 reviews page as 20/20/5 with no repeats.
- **Web** (`web/tools/jobs-ui.test.mjs`, `pr-reviews-ui.test.mjs`, `collaboration-ui.test.mjs`): the scopes, states and paging; a refresh re-reads the loaded pages, so an older row's Outdated updates, and stops at ten pages; a link keeps to its task's scope and is re-read on each refresh, including a retry after a failed read; opening the report closes Jobs and names the task and review; a link reads an old review directly; a late answer for an old scope, a hidden window and a failed read; the task view opens the linked review with its report; review mail opens its task at that review, and Agent mail does not. None of them sends a write.
