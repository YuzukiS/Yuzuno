# Jobs budget capacity (T-64)

The default remains up to 4 CPU and 8192 MiB RAM, with no swap. An explicitly
saved budget is preserved across upgrades and restarts. The configurable ceiling
is 75% of logical CPU quota and at most half of total RAM, also leaving the
existing Core/desktop headroom. Swap remains capped at a quarter of the smaller
of total RAM and configured swap. Current available RAM is checked separately
before each admission; other applications and Windows remain outside this budget.

On the 32-CPU / 40107-MiB host this permits 6 CPU / 10240 MiB / 0 swap as a
conservative two-job configuration, without automatically applying it. Each
2-CPU / 4096-MiB worker reserves another 100 mCPU / 64 MiB for collection, so two
need 4200 mCPU and 8320 MiB. The default cannot admit both. Queue reasons report
the actual requirement, availability and deficit.

Saving a budget wakes the existing queue. It does not change accepted commands,
resource snapshots, or running cgroup limits. Lowering below outstanding
reservations pauses all new admissions, including zero-swap jobs when existing
swap reservations exceed the new budget. Accepted jobs too large for the new
budget stay queued until capacity is raised; cancellation is not required.
FIFO, exclusive execution, process limits, and the shared two-heavy-work rule
remain in place.

Validation uses the affected Rust Jobs tests, Jobs UI tests/typecheck, and
`check.py`. The latter reuses the existing isolated `local_jobs_lab` example,
starts three normal Jobs with 2 CPU / 4 GiB limits, and performs negligible work
while waiting for a release file. It checks raising/lowering budgets, concurrent
admission of two, retention of the third, immutable running limits, rejected
out-of-range configuration, and persistence. It never opens daily data, calls a
model, allocates the reserved memory, or cancels another workspace's Jobs.

Build the example into the worktree's `target/debug/examples/local_jobs_lab`
(or copy the completed shared-target build there), then run the short controller
with `timeout --signal=INT 120 python3 -B acceptance/t64/check.py` on the host.
The controller's three workers are actual resource-limited Jobs in its isolated
Core. Compilation and regression tests use the shared managed Jobs budget.
Evidence is written under this worktree's `target/t64/` and
`target/t47/lab-t64-*`. Product review and exact-commit CI are separate gates;
completion of the validation Job alone does not imply review, merge or release.

Validated on implementation commit `2769bdf`: 21 Jobs Rust tests, Web typecheck,
14 Jobs UI tests, and all four live acceptance checks passed. The three actual
workers completed with 2 CPU / 4 GiB / 0 swap limits, TasksMax 512, and less than
15 MiB peak RAM each. No cleanup errors were reported. Raw evidence is retained
in `target/t64/live-report.json`, `core-job-2769bdf.json`,
`web-job-2769bdf.json`, and their associated logs.
