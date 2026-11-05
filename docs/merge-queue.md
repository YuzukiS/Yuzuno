# Merge queue

Core's merge queue checks that a pull request may merge, and records the
evidence on its task. It is phase 4 of the [executor model](executor-model.md).

**This release is a dry run.** An entry ends at `ready` (it would merge now) or
`stopped` (with a reason). Core writes nothing to GitHub: it merges nothing,
pushes nothing and reruns nothing. Merges still happen outside Core.

## Who may release

Releasing puts one PR head in the queue. These conditions are checked when the
entry is created:

- **The repository's switch is on.** It is off by default, and only the user
  can turn it on (`PUT /api/merge-queue/repositories/{id}`, with no MCP tool).
- **The caller may release.** The user may. An Agent may only if it is the
  task's active dispatcher and a lead of the task's Project. The task's
  executor can never release its own PR.
- **The PR is linked to the task** and its repository to the task's Project.
- **The review passes.** Releasing is the lead's statement that the project's
  review pair is complete. Core checks that the last completed review round of
  the PR reviewed exactly the released head and passes the review policy
  (`no_findings`, or `approved_with_notes` with P3 notes only). The entry
  records that round's ID. A head committed after the last round has no passing
  review of its own, so it is refused.
- **No other entry holds the PR.**

Core does not ask the user for exceptions. A head that does not meet these
conditions is merged by a person, or reviewed again first.

## What Core checks

Every check reads GitHub afresh, in this order. The first condition that fails
decides the outcome.

1. The PR is open, not a draft, at the released head, and on the base branch it
   was released for.
2. The last completed review round still passes at that head. If a round is
   running, Core waits for it.
3. Two reads of the base branch name the same commit.
4. Main is healthy. No push run of CI on the base branch since the main seen at
   release ended `failure`, `timed_out` or `startup_failure`. Running,
   superseded and green runs are fine.
5. The newest run of every workflow on the head has finished green (success,
   skipped or neutral). CI, and any workflow named in `requireWorkflows`, ran.
6. GitHub reports the PR as mergeable and its merge state as clean.
7. The PR's merge ref is the merge of the current main and the head. Its tree is
   what a merge would land.
8. Every CI job that ran checked out exactly that merge commit. Core reads each
   job's log, at most 4 MiB, for the `HEAD is now at …` line, and keeps the log's
   sha256. If a job tested the head on an older main, the entry stops with
   `needs_batch`. A later release adds batch runs on the current main.

While a run is still going, the entry waits and checks again later, at most
every 10 minutes. After six hours of waiting it stops. While GitHub reads are
cooling down, the entry waits until the cooldown ends.

## States

| State | Meaning |
| --- | --- |
| `queued` | Released, not yet checked. |
| `waiting` | A check could not decide yet. `detail` says why. |
| `ready` | Every check held. The evidence record shows what would merge. |
| `stopped` | A check decided against. `reason` is one of `head_moved`, `pr_not_open`, `base_changed`, `review_not_passing`, `main_red`, `ci_red`, `conflict`, `merge_blocked`, `needs_batch`, `checkout_mismatch`, `checkout_unproven`, `wait_timeout` or `github_unreachable`. |
| `cancelled` | Cancelled by the Agent that released it, or by the user. |

`merge_retry` checks a stopped entry again from the start. It never reruns CI:
a red job has to be rerun by other means first.

## Evidence

When an entry becomes `ready` or `stopped`, Core writes a comment to the task
as Yuzuno Core, with the evidence record attached as `mergeEvidence`. It also
mails the Agent that released the entry and the task's executor.

The record holds:

- the release (who, when, which request);
- the review round;
- main at release and at the check, with the CI runs examined;
- the gate: the merge ref, its parents and tree, and each CI job's checkout and
  log sha256;
- the merge that would run (`PUT …/pulls/{n}/merge`, pinned to the head, as a
  merge commit);
- the stop reason and detail, if any.

`merge_get` returns an entry with its history and evidence. `merge_list` lists
entries.
