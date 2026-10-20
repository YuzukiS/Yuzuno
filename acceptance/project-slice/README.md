# Project management within one Workspace

Branch `feat/project-slice`. Shared task T-2 holds the scope. This record covers its initial isolated acceptance. The slice was subsequently merged into `main` and deployed on port 4317 in the [four-slice integration](../four-slice-merge/README.md).

## What changed

- **Core**: `projects`, `project_agents` and `project_tasks` tables. Membership is kept out of Agent and task JSON, because older builds deserialize those records into typed structs and rewrite them without unknown fields. `project_agents` cascades when an Agent is deleted (every Core enables foreign keys). Each open also removes orphan links left by manual edits made with foreign keys off.
- **API**: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/{id}` (a project still in use can only be archived) and `POST /api/agents/{id}/project`. Agent creation accepts `projectId` and the optional `saveProjectDefault`. `/api/workspace` returns `workspace.id` and `projects`. Default folders are validated on their own machine when saved; they pre-fill new agents and impose no boundary.
- **Tasks/MCP**: `projectId` follows these rules.

  | Operation | Absent | `null` |
  |---|---|---|
  | create | the creating Agent's project at that moment; none for the user, or when that project is archived (the answer then carries `projectNotice`) | no project |
  | update | keep | clear |
  | list | all projects; an unknown ID is an error | only tasks without a project |

  Updates share the task's version check, version bump and activity record. Retries replay the first answer. `peers_list` reports each Agent's project, and the read-only `projects_list` returns every project with its archived state.
- **UI**:
  - The bottom-left card is the Workspace/project scope switcher. Its dot shows whether Core is reachable, not Codex catalog state.
  - Rail, Catch-up and the task board follow the scope, which is remembered per `workspaceId`.
  - Requests in other projects are counted in the rail and listed in Catch-up under "Waiting in other projects", archived projects included. Opening one moves the window to that agent's project.
  - Switching scope never selects another agent; if the open agent leaves the scope, Catch-up is shown instead.
  - Agents move between projects from Conversation actions.
  - New agents start in the viewed project with its default folder.
  - "Manage projects" covers rename, per-machine default folders, members, archive and delete-when-empty. It also groups agents without a project by folder, as suggestions only.

## Checks

| Check | Command | Result |
|---|---|---|
| Rust | `cargo test --locked -- --test-threads=1` | 147/147, including 9 in `core/tests/projects.rs` |
| UI | `npm --prefix web test` | ui 37, collaboration 10, projects 13 pass |
| Rollback with real binaries | `python3 acceptance/project-slice/rollback.py --new target/debug/yuzuno-workspace --old <main 446d500 build>` | 15/15 |
| Real model + browser | `live.py start`, `live.py seed`, `live.py mcp`, `node live-ui.mjs`, `live.py stop` | seed 4/4, MCP 2/2, browser 11/11, daily unchanged |

**Rollback.** The new Core creates projects, members and tasks. Next, the `main` Core edits a task and deletes a closed Agent. A link is then orphaned by hand with foreign keys off. Finally the new Core reopens. Results:

- Memberships and task links survive.
- The deleted Agent's link was removed by the cascade (its presence beforehand is asserted).
- No Agent JSON carries `projectId`.
- The reopen removes the orphan.
- Project moves still use the version check.

**Real scenario.** This ran on an isolated Core on port 4337 with a lab Workspace under `lab/` and official Codex 0.162.1:

- `Hotfix` works in a git worktree outside the main folder (`git rev-parse` → `hotfix …/lab/app-hotfix`) and belongs to App.
- `Main` (App) called `task_create` through its MCP tools without `projectId`. T-1 landed in App and was assigned to `Reader` in Research.
- `Reader` ran with a read-only sandbox and raised a real `item/commandExecution/requestApproval`.
- In Chromium:
  - App lists Main and Hotfix and shows "1 waiting in other projects".
  - Switching App → Research → No project → App left every agent's `reviewedSeq` unchanged; Hotfix and Reader stayed unread throughout.
  - Catch-up lists Reader's request under "Waiting in other projects". Opening it switches to Research and shows the approval card.
  - App's board shows T-1 owned by Reader.
  - The entry still works at 390 px.

Local evidence, not committed: `rollback-result.json`, `live-state.json`, `live-ui-result.json`, `screenshots/` and the lab Workspace in `lab/`.

## Code review fixes

All findings of the branch review are fixed. The six UI regressions below fail against the pre-fix build (5c4815a) and pass now; the mock Core returns fresh objects per response, as the real Core does.

- Unsaved default-folder edits survive the periodic workspace refresh; saving one machine keeps the others' edits.
- Every Agent returned after a record update (close, reopen, settings…) carries its `projectId`.
- Deleting the scope's last agent shows Catch-up instead of opening, and reading, another project's agent.
- A new or moved agent outside the current scope moves the window to its project, so it stays listed.
- Delete is disabled while tasks are still linked (`projectUsage` in `/api/workspace`). A folder suggestion that partly fails still refreshes and names the agents left.
- An Agent in an archived project files tasks under no project (decided by the user). Real Codex returned `null project_archived`.
- `task_list` rejects unknown project IDs. The MCP schemas describe each tool's own default. Real Codex listed projects through `projects_list`.
- The New agent dialog keeps a typed folder across reopening. The version-conflict panel shows project names. Project links for a page of tasks are fetched with one query. Duplicated scope helpers are removed.

## Not covered

- With parallel test threads, the existing `collaboration_store` tests that drop and immediately reopen a Store intermittently fail with `lock acquisition failed because the operation would block`. `main` (446d500) shows the same failure: 2 of 4 runs in this check. The likely cause is a concurrent test's child process briefly holding the inherited lock descriptor; this slice does not change that. All tests pass single-threaded.

- Remote (SSH) default folders reuse the existing SSH `canonicalize` helper. No SSH machine was used in this slice, and no Mac mini project folder was saved.
- Claude agents use the same membership code but were not part of the real-model run.
- Workspace rename, machine edit/delete, a multi-Workspace picker and starting Core are separate work.
