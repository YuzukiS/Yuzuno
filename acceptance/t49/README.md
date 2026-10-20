# T-49: GitHub Actions in Jobs

Base: `21727d25e9abd8f424dfdc30550fbf01a142504a`. Isolated worktree: `.claude/worktrees/t49-ci-monitor`.

Explicit PR/run subscriptions pin the full expected commit and associate an existing task and requesting Agent. Core monitors independently of the native Turn. Jobs has Local and GitHub Actions sources, shared workspace/Agent/task scope, a PR-detail subscription shortcut, and conversation cards. CI never creates a local reservation or changes task/PR/review state. Logs and artifacts stay on native GitHub links; there is no trigger, cancel, rerun or workflow-write capability.

## Contract and bounds

- `ci_subscribe(requestId, taskId, url, expectedSha)`, `ci_list`, `ci_get(runKey, page)` and `ci_unsubscribe(subscriptionId)` share GUI/MCP implementation. MCP identity remains authenticated. Same-request retries retrieve a durable receipt; multiple subscribers share target and run facts.
- Facts use repository ID + run ID + attempt. PR subscriptions retain their original SHA and display the current PR head separately. Same-SHA reruns are distinct attempts; unfinished historical attempts are reconciled explicitly. Third-party commit checks never become Actions runs.
- One Core scheduler serializes CI work and shares the existing two GitHub-read slots and official `gh` authentication. Network IO stays outside Store locks. Minimum observation cadence is 60 seconds, 300 seconds after all observed runs complete. TTLs, ETags/304, `x-poll-interval`, pagination and global `Retry-After`/rate-limit reset cooldowns bound reads. Failures retain facts, back off to one hour and pause after eight consecutive failures. Resubscribing resumes monitoring.
- Subscriptions last seven days and can be stopped/renewed. Limits: 50 active targets, 2,000 subscription records, 10,000 retained attempts and 256 cache entries. A target observation has a 60-second deadline, ten pages of 100 runs and ten unfinished historical attempts. Detail reads fetch one page of 100 jobs, up to ten pages, with 500 steps per job. Truncation remains visible alongside native links.
- Terminal observation and each subscription's notification receipt commit together, with batches capped at 100 notifications and durable backlog recovery on later ticks. Missing terminal conclusions wait for evidence. Existing normal system mailbox messages carry immutable `kind: ci`, outcome, run/attempt, actual/expected SHA, PR/task metadata. Existing mailbox admission controls paused/closed Agent wakeups; CI never starts a native Agent watcher.
- Viewing does not call peer_read. CI completion does not imply task done, review approval or PR merge. A detail-read error is separate from the last known remote outcome.

## Targeted validation

Core tests cover shared subscriptions/idempotency, pinned SHA, task/Agent scope, ownership, stop, trusted normal metadata, no local reservations, restart notification deduplication, same-SHA attempts, mixed/paged jobs and unknown outcomes. A scheduler fixture covers ETag 304, API 429 cooldown/recovery, changed PR head and reconciliation of an unobserved previous-attempt terminal result. No paid model is involved.

Jobs UI tests cover existing local behavior plus CI source isolation, old-SHA disclosure, paged jobs/steps, explicit subscription retry, stop without remote cancellation, and retained facts on detail errors. GitHub link checks use the built task surface. Browser and real remote-run evidence is retained under this worktree's ignored `target/t49/` and linked from T-49/its PR when captured.

Heavy commands use the shared two-slot gate, Cargo `-j4`/serial tests at 4 GiB/zero swap, and Node/browser at 3 GiB/2 GiB heap/zero swap. Temporary files use this worktree's disk directory. The 4481 Lab has an independent database and no Harness/model. Daily Core, release assets and other retained Labs are untouched.

## Official references

- [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs): repository-scoped Actions records, head-SHA filters, run and attempt observations.
- [Workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs): attempt-specific jobs, steps and pagination.
- [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api): authenticated conditional requests and rate-limit backoff. Personal Core uses bounded polling without requiring a public webhook endpoint.

Validation completed before live acceptance: six focused CI Core tests, seven GitHub regressions, eight Jobs UI tests, three GitHub link UI tests, typecheck/build, and four browser theme/width cases at 20px. Screenshots were inspected. User approved isolated mock-task records after automatic-review rejection; details are recorded in [AUTO_REVIEW.md](AUTO_REVIEW.md). The existing no-model acceptance host supports explicit fixture-only resume for restart checks.
