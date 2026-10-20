# T-70: the Agent list shows an idle Agent still waiting on its jobs

An Agent that submits a local Job and ends its Turn used to show **Ready** in the Agent list while the Job was still queued or running. It now shows **Waiting · Job** until its last Job ends. This is a label only: the Agent's own state, scheduling and whether you can message it are unchanged. Only the Agent list changes; the conversation header keeps the native state.

## What decides the label

- **Core** (`GET /api/jobs/live`, `jobs/store.rs` `live_job_counts`): one row per Agent with unfinished local Jobs, `{agents: {<agentId>: {active, unknown}}}`. Unfinished is the live set the Jobs list already keeps visible: queued, or still holding a reservation (starting, running, cancelling, and unknown). `unknown` counts those whose outcome Core could not confirm. Finished history and job details are not read; the answer is bounded by the number of Agents.
- **Agent list** (`AgentRailRow`): only when the Agent is shown as plainly idle (not closed, compacting, working, waiting for you, offline, in error or needing a result check):
  - any Job queued or running → **Waiting · Job**, with the count in the tooltip; if some others have an unknown outcome, the tooltip says they still hold their reservation and to check Jobs;
  - only Jobs with an unknown outcome → **Check job**; they are never called running or finished;
  - none → the usual label.
- Jobs belong to an Agent by its stable id. Another Agent's Jobs never change a row. Several Jobs keep the label until the last one ends. Whether the result mail was read does not matter.

## How it stays current

- `web/src/live-jobs.ts` holds one Workspace-wide snapshot outside React state. Each row subscribes to its own Agent (`useSyncExternalStore`), and an Agent whose counts did not change keeps the same snapshot object, so a Job change re-renders only rows whose counts changed and never the conversation.
- App reads it again on the existing Jobs signal (`jobsRevision`): every `workspace.changed` with scope `jobs`, a reconnect, and a reset. There is no polling and no per-Agent request. It does not depend on the selected conversation, on Jobs being open, or on any history page.
- A newer read supersedes one still on its way; a late answer never overwrites a newer one. Another workspace starts empty at once, and the old workspace's late answer is dropped. A failed read keeps the last snapshot until the next Job change or reconnect.

## Checks

- **Core** (`core/src/jobs/tests.rs`): two Agents' Jobs counted apart; starting and running stay unfinished, a succeeded Job drops out; an unknown Job is counted apart while it holds its reservation; a cancelled queued Job ends at once and the Agent disappears. `core/tests/jobs_live.rs`: `/api/jobs/live` answers as the summary, not as a Job named "live", next to `/api/jobs/{id}`.
- **Store and row** (`web/tools/live-jobs-ui.test.mjs`): Waiting · Job, Check job, running and unknown together (tooltip says to check), cleared; waiting for you keeps priority; another Agent unaffected; a late read and a failed read; a workspace switch clears at once and drops the old answer; unchanged counts do not re-render a row, and an Agent without Jobs is not re-rendered when another's change.
- **App** (`web/tools/ui.test.mjs`): with Jobs closed and another conversation selected, an idle Agent shows Waiting · Job while a working Agent stays Working; after `workspace.changed` (jobs) events it stays while one of two Jobs remains, shows Check job when only an unknown one remains, and returns to Ready when the last ends.
