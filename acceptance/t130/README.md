# T-130: bounded Jobs discovery

The MCP default now lists the calling Agent's Jobs in compact pages. Explicit
Agent/task filters keep their cross-Agent meaning; `scope: "workspace"` restores
global discovery. `projectId` selects the task's current Project, with explicit
null selecting tasks without one. Moving an Agent does not change that selection.
These filters do not change authorization or environment redaction.

The GUI still calls the existing global list function, with 50 history rows and
its independent live set. No GUI, scheduler, resource accounting, `job_get`, or
`job_run_get` behavior was changed. The MCP-specific implementation lives in
`core/src/jobs/list.rs`; the schema and Agent skill describe its contract.

History retains its integer `before` cursor. MCP history and live pages each have
`limit` 1–50 (default 10), in descending creation order. Live discovery includes
queued/waiting Jobs and all reservations, including unknown outcomes, even when
older than the current history page. Follow the independent `liveBefore` cursor
while `liveHasMore`. `liveJobIds` identifies that live page and `liveJobs` includes
only rows not already in `jobs`; a response serializes each Job at most once.
Both pages are current views, not frozen snapshots. Changing filters starts a
different traversal; callers collecting across calls should retain seen IDs.

## Validation

Managed Job `1af90dc9-3eaf-4fbe-a3ff-df2830d6e63b`, attempt
`fcda3c7b-c020-41cb-99ce-feeef878af24`, executed candidate
`90e008f354974978ec9acfa292d74fdbcb999176` on 2026-10-18,
19:45:53–19:47:03 UTC. `cargo test -p yuzuno-workspace --lib jobs:: -- --nocapture`
passed all 103 Jobs tests, including six new query tests. Reservation: 2 CPU,
4096 MiB RAM, zero swap; measured memory peak 3,603,116,032 bytes; exit 0.

The new temporary Store fixtures cover:

- Default self, explicit Agent/task intersections and legacy task UUIDs, all
  Workspace access, Project membership from tasks across Agents, an Agent move,
  a task move, and explicit no-Project tasks.
- Limits 1 and 50, default 10, invalid/overflow parameters, incompatible scopes,
  unknown Project/task IDs, independent live/history pages, overlap elimination,
  old reserved unknown Jobs, queued/waiting Jobs, and empty terminal pages.
- The shared dispatch's GUI path still has its global 50-row history and full
  independent live set. Both MCP projections omit env/argv; compact rows cap
  Unicode reason text without changing retained detail and preserve pause/remote
  machine/stage identifiers. Existing `job_get` actor redaction remains unchanged.

The first Job (`a5cb45a6-b2bc-4931-923f-c88101b85689`) stopped during compilation:
rusqlite does not bind `u64`. The corrected SQL parameter casts the already
validated 1–50 limit to `i64`. It was not a passing test run.

After main added T-129 resource summaries, integration commit
`f07b619ba545a0919eeeb1deb5496c8e2e7da78e` merged main
`354121abd4a6aa2df92b8ec378cdee236ea503c4`. The single conflict was adjacent
`job_list` / `job_get` descriptions; the new query definition and main's
`resourceSummary` definition were both retained. Resource accounting, budget,
run and detail implementations were preserved from main.

Managed Job `df86309e-89a4-4a29-9ea4-c1337eba81fb`, attempt
`ff81ba25-4f5e-435f-994e-0ca910944ec0`, validated that integration on 2026-10-18,
20:22:56–20:24:16 UTC with the same command plus `--locked`: 112 tests passed,
zero failed, one ignored. The ignored existing resource-summary test requires
external captured evidence (`YUZUNO_RESOURCE_FIXTURES`); it was not exercised.
This run included all six query fixtures and the new resource-summary regression
tests. The response-size receipt below was reproduced exactly. Reservation:
2 CPU, 5120 MiB RAM, zero swap; exit 0. The subsequent candidate only adds this
integration record; independent review and CI identify the final candidate.

## Response-size receipt

`response-size.json` retains the emitted receipt. It uses 120 synthetic Jobs,
two Agents and two Projects: 70 finished Jobs followed by 50 queued Jobs, with
every tenth Job owned by the caller. No research data or live workspace contents
were read. Bytes count compact JSON of the tool payload, excluding the MCP
transport wrapper; this is a representative fixture, not a production benchmark.

| Query | History rows | Additional live rows | Serialized bytes |
| --- | ---: | ---: | ---: |
| Prior Workspace default | 50 | 50 (duplicated history rows) | 75,396 |
| New default self | 10 | 0 | 4,517 |
| New explicit Workspace | 10 | 0 | 4,712 |
| New explicit Project | 10 | 0 | 4,744 |
| New Workspace, compact false | 10 | 0 | 8,653 |

The new responses retain `liveJobIds` and live pagination flags, so zero
additional live rows here does not mean no live work. The fixture's live rows
already appear in each history page. Separate tests place active Jobs beyond the
history page and traverse all of them. The reduction combines narrower default
scope, bounded pages, deduplication and the compact field projection; it does not
represent an equal-row comparison of field projection alone.

This source change is not deployed on the daily Core. Older running Cores and
already loaded tool schemas retain their old behavior until upgraded/refreshed.
