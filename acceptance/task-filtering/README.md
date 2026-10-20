# Task board filters cover the whole task set (T-7)

Branch `feat/task-filtering`, base `4f152ca`, with `main` 206bd98 merged in. Not merged into `main`. The daily Core on port 4317, its `web/dist`, its data and the live binary were not touched; the pid and hash were the same before and after.

## What changed

- **Core** (`collaboration_store::task_list`): new `statuses` array, matching any of the listed statuses. It is applied before paging and to the counts, like every other condition. `status` keeps its meaning for existing clients and MCP callers. Sending both, an empty list, a duplicate or an unknown status is an input error. The MCP schema describes the new field.
- **Board** (`CollaborationBoard.tsx`):
  - **One set of conditions.** Status, owner and project all go to Core, so the list, its counts and every page share one set of conditions. "Open tasks" sends `statuses` (todo, doing, blocked, review). Nothing is filtered locally from a loaded page, and the list shows "Showing N of M".
  - **Changing conditions.** The list starts again from nothing and the previous request is aborted. Its late response, error and completion are ignored. "No tasks match" appears only after Core has answered.
  - **Background updates.** Workspace revisions arrive every few seconds, changed or not; Core-status reconnects and machine checks trigger them too. With only the first page loaded, the board quietly reloads it. With later pages loaded, it keeps them and compares Core's counts and first 200 matching tasks with what is loaded. One request is used, at Core's largest page size. If they differ, a sticky "Tasks changed since these pages loaded · Refresh tasks" notice appears.
  - **Saved tasks.** A saved task that no longer matches leaves the list, and the counts follow.

## Checks

| Check | Result |
|---|---|
| Rust: `cargo test --locked -j 2 -- --test-threads=1` | 175/175, including 4 in `core/tests/task_filtering.rs`: a match after the first hundred, 137 matches over two pages, open statuses with archive/project/owner combinations, invalid input |
| UI: `node web/tools/task-filtering-ui.test.mjs` | 11/11 after R1. The first 8 also ran against main's board: 0/8 there |
| All other UI test files | ui 46, collaboration 10, projects 14, machines 3, remote 7, connection 7, artifact-groups 3, intelligent-ui 13, intelligent-ui-storage 7, auto-read 12 |
| Isolated Core 4393 (`live.py run`), 210 tasks through the real API | 3/3 |
| One headless Chromium on it (`live-ui.mjs`) | 14/14 after R1 |

**What the browser run covered:**

- Hana's only open task, #140, appears at once as "1 of 1".
- Mori's 137 open tasks show as "100 of 137"; Load more brings exactly the 137 expected, in order.
- A real unrelated broadcast (a machine check) keeps both pages without a notice.
- A real title edit to a task on page two shows the notice. It stays in view while scrolled, nothing is dropped, and Refresh starts again from page one.
- An edit draft survives background activity.
- Switching Project gives exactly that project's matches.
- Rapid owner switches settle on the last choice.
- There were no page errors.

Screenshots and JSON results are local and not committed.

## R1 rework (Opus R1 FAIL on 099fda2, one P2)

**Finding.** The empty state had an added `!loading` condition. With one page loaded, every background reload (the 5 s poll, SSE, focus) unmounted the empty state and its "Create a task" button: keyboard focus fell to `<body>` and the area flickered.

**Fix.** Remove `!loading`, a frontend-only change. Changing conditions still resets the page to null, so "No tasks match" waits for Core's answer through the "Gathering…" branch.

**Tests.**
- `task-filtering-ui` test 10: a held background reload keeps the same focused button. It fails on 099fda2 and passes now.
- Test 11: new conditions still show no empty state or old cards before Core answers.
- The file is now 11/11, and stable over 3 runs.

**Browser.** In a fresh lab run with one Chromium, a real background reload happened during the wait. The browser check now passes 14/14, including "an empty result keeps Create a task focused through background reloads", and the isolated Core run passes 3/3. All other UI test files pass, and no Cargo was run: the Core is unchanged since 3f0de16.

## Limits

- An edit to a task beyond the first 200 loaded matches that leaves the counts unchanged (for example, a title change) is not detected in the background. It appears after Refresh tasks or a change of conditions. The UI test pins this behaviour. Changes that move a task into or out of the filter, or change its status, alter Core's counts and are flagged anywhere in the list.
- `collaboration-ui.test.mjs` test 2 is intermittently flaky on `main` and was not touched; it passed in this run.
