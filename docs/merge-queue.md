# Merge queue

Core's merge queue merges a reviewed pull request once CI has tested exactly
what the merge lands on main, and records the evidence on its task. It is
phase 4 of the [executor model](executor-model.md).

## What Core writes, and when

Core writes to GitHub only while the repository's switch is on. The switch is
off by default, and only the user can turn it on: in Projects, each linked
repository has the switch (`PUT /api/merge-queue/repositories/{id}` with
`{"enabled": true}`; there is no MCP tool). Turning it on first lists these
writes; turning it off saves at once. On YuzukiS/Yuzuno it stays off until a
Core with the queue is installed and the user turns it on; until then merges
happen by hand.

In the dry-run build of the queue, a switch that was on only let Core check.
That consent does not carry over: the first time this build opens a Workspace,
Core turns every switch from before off once and says so in the repository's
`switches` journal. Every entry from before that still held its PR stops with
`dry_run_ended`. Such an entry cannot be retried; release the PR again.

While the switch is on, Core makes only these writes, with the Core host's gh
login:

- The merge itself: `PUT pulls/{n}/merge` with `merge_method=merge` and
  `sha` set to the released head, so GitHub refuses it if the head moved. It is
  never a squash, a rebase or an admin merge.
- A batch, when CI tested an older main: the branch `queue/merge-{entry}` at
  the current main, the released head merged into it (`POST merges`), and a
  draft PR from it, whose pull_request event runs CI.
- Removing that batch afterwards: closing its PR and deleting its branch.
  Core records the branch before it asks GitHub to create it, so a branch
  whose creation answer was lost is still deleted; a 404 or 422 then means it
  never existed.

Core never force-pushes. It closes only the batch PRs it opened and deletes
only the `queue/merge-{entry}` branches it created. It never starts, reruns or
cancels a workflow.

## Who may release

Releasing puts one PR head in the queue. These conditions are checked when the
entry is created:

- **The repository's switch is on.**
- **The caller may release.** The user may. An Agent may only if it is the
  task's active dispatcher and a lead of the task's Project. The task's
  executor can never release its own PR.
- **The PR is linked to the task** and its repository to the task's Project.
- **The PR's base is the repository's default branch.** The queue merges into that branch only; a PR into another base is refused, naming both.
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
decides the outcome. Core reads the entry again right before its check. If the
entry's anchor changes while the check runs, because an unpause or another
entry's check that ended a pause re-anchored it, the outcome is dropped and the
entry is checked again from the new anchor.

1. The PR is open, not a draft, at the released head, and on the base branch it
   was released for.
2. The last completed review round still passes at that head. If a round is
   running, Core waits for it.
3. Two reads of the base branch name the same commit.
4. The repository's queue is not paused (see below).
5. Main is healthy. No push run of CI on the base branch since the entry's
   anchor ended `failure`, `timed_out` or `startup_failure`. The anchor is the
   main read at release (or at the last retry or unpause) and the time of that
   read. Runs of the anchor main itself count. Runs of older commits that began
   before the anchor do not. Running, superseded and green runs are fine. A red
   run stops the entry and pauses the repository's queue.
6. The newest run of every workflow on the head has finished green (success,
   skipped or neutral). CI, and any workflow named in `requireWorkflows`, ran.
   Every page of the run list is read; if more runs exist than Core reads, the
   entry stops.
7. GitHub reports the PR as mergeable and its merge state as clean. This is
   judged on a second read of the PR, taken after the head's runs finished. If
   GitHub reports the merge state as `unstable` or `blocked` while a check run
   or commit status on the head is still pending, the entry waits for it.
8. The gate. Either the PR's merge ref is the merge of the current main and the
   head, and every CI job checked out exactly that merge commit (the slot); or
   the entry's batch was built on the current main, its PR is still Core's own
   at the batch commit, its CI is green, and every CI job checked out the merge
   of main and the batch commit, whose tree is the batch's tree. Core reads
   every job (all pages), and each job's log, at most 4 MiB, for the
   `HEAD is now at …` line, keeping the log's sha256.

If the PR's own CI tested the head on an older main, Core builds a batch on the
current main and waits for CI on it. A batch on a main that has since moved is
removed, and a new one is built.

Once every check holds, the entry merges, one merge at a time per repository:

1. Core sends one merge request per merge. Right before it, Core reads the PR
   and main again. The request pins the head but not the base, so this is what
   keeps an untested merge off main. If the head moved, or the PR is no longer
   open (merged outside the queue too), the entry stops with `merge_refused`.
   If main moved since the check, nothing is sent and every check runs again on
   the new main. Reads that keep failing here (eight in a row) stop the entry
   with `github_unreachable`, with no pause: nothing was sent. Otherwise Core
   journals the request, then sends it, with a deadline of its own (60 s,
   longer than a read's), since GitHub can take longer to merge than to
   answer a read. The remaining window is one round trip, which the
   post-check covers.
2. A certain answer decides: merged goes on to the post-check, and a refusal
   stops the entry with `merge_refused`. An uncertain answer (a timeout, a
   dropped connection after sending, a 5xx, an answer Core cannot read) is
   never followed by a second request, and Core does not try to work out
   whether it merged: the entry stops with `merge_unknown`, the repository's
   queue pauses, and the mail is urgent. A person checks main before
   unpausing. The same holds when Core finds a journaled request with no
   recorded answer, for example after it stopped while the request was in
   flight. Two answers certainly merged nothing, and the entry stays
   `merging` and sends the request again:
   - a request that never reached GitHub (gh could not start, has no login,
     or could not open a connection) is tried again shortly; after five in a
     row the entry stops with `github_unreachable`, no pause;
   - a refusal from GitHub's rate limit (a 429, or a 403 that names the rate
     limit) is sent again after the cooldown.

   Core reads the repository's pause each time it journals the request. If
   the queue paused meanwhile, for example on another entry's red main CI,
   nothing is journaled or sent: the entry goes back to `waiting` and is
   checked again once the queue is unpaused.
3. The post-check: the merge commit's parents are the main before and the
   head, and its tree is the tree CI tested. Otherwise the entry stops with
   `post_check_failed` and the repository's queue pauses: something landed that
   CI did not test, and a person has to look. Core makes no automatic revert.
   If the merge commit cannot be read eight times in a row, the entry stops
   with `post_check_unverified` and the queue pauses the same way; an entry
   never ends `done` without its post-check. The repository's next merge
   waits until this post-check has run.
4. Core removes its batch, if there was one. If the removal fails, Core
   records why and tries again later; a failed removal never delays the
   post-check or following main CI. While the switch is off, or GitHub's rate
   limit refuses the request, Core waits and does not count it as a failure.
   Turning the switch on again makes the removal due at once. After eight
   other failures in a row Core stops trying, marks the removal `failed`, and
   says in the entry which branch and PR to remove by hand. This holds for the
   batch of a stopped or cancelled entry too.
5. Core follows main's push CI on the merge commit. Green ends the entry at
   `done`. Red ends it at `done` with the failure recorded, and pauses the
   repository's queue. The next entry does not wait for this run; only a red
   result stops it.

While a run is still going, an entry waits and checks again later, at most
every 10 minutes. After six hours of waiting it stops. Time while the
repository's queue is paused does not count: a paused entry waits for the
unpause however long it takes. While GitHub reads are
cooling down, the entry waits until the cooldown ends. Each GitHub read holds
one of Core's shared GitHub slots only while it runs; job-log downloads hold
none.

## Landing

Each repository names how its checked entries land: `landing` in
`GET /api/merge-queue/repositories/{id}`, set by the user with
`PUT /api/merge-queue/repositories/{id}` and `{"landing": …}` (no MCP tool).
There are three tiers:

| Landing | What lands the merge | In this Core |
| --- | --- | --- |
| `core-merge` | Core sends the merge request itself, as described above. Any repository can use it; it needs no branch protection or paid plan. | Yes, the default. |
| `github-auto-merge` | GitHub, once the repository's required checks pass; Core queues and updates the branch. For repositories with branch protection. | No: refused with "comes in core.25". |
| `github-merge-queue` | GitHub's own merge queue, where the repository has one (organization-owned repositories). | No: refused with "comes in core.25". |

A refused landing saves nothing. Setting the landing leaves the switch as it
is, and the switch journal records the change. A merge records the landing it
started with. If a repository names a landing this Core does not have (a
later Core set it), a checked entry stays `ready` and Core sends nothing; a
merge begun that way goes back to `waiting`, unsent.

## Pauses

A repository's queue pauses on red main CI, a failed post-check, a
post-check Core could not run (`post_check_unverified`), or a merge whose
outcome is unknown (`merge_unknown`). The rule behind the list: a stop after
which main may carry a merge Core sent but never verified pauses the queue
until a person has looked; a stop after which Core certainly merged nothing
does not. While it is
paused, entries are still checked but none merges, and the pause and its end
are mailed, urgent, to the releaser and the leads of the repository's Projects.

A pause belongs to the base branch it was recorded on. Only an entry on that
branch can end it by a newer green main, and only that branch's waiting entries
are re-anchored when it ends.

`merge_unpause` ends a pause. Only a lead of a Project the repository is linked
to, or the user, may call it. Retried with the same `requestId`, it returns its
first answer without checking the pause again or reading GitHub; another payload
under that `requestId` is refused. A pause for red main CI also ends by itself once
main has moved past the red commit and CI on the new main is green. Either way,
Core journals what ended the pause and re-anchors every waiting entry at the
current main, so their main CI counts from there on.

An unpause while main is still the red commit of a red-main pause accepts that
red run: the lead has looked at it and lets the queue go on, for example so a
fix can merge onto that main. The acceptance belongs to that main: every entry
anchored there no longer counts that one run (by its id), whether the unpause
re-anchored it, it is retried, or it is released there later. Any other red run
still stops them, and each entry still needs green CI of its own on that main,
by slot or batch, before it merges. Once main moves on, the acceptance no longer
applies. The unpause's answer, its journal line and its mail name the accepted
run.

## States

| State | Meaning |
| --- | --- |
| `queued` | Released, not yet checked. |
| `waiting` | A check could not decide yet. `detail` says why. |
| `ready` | Every check held, but the entry cannot merge yet: the switch is off, or another merge of the repository is in flight or has not had its post-check yet. It is checked again before it merges. While the switch is off it is not checked at all; turning the switch on makes it due at once. |
| `merging` | The merge request is journaled or sent. |
| `merged` | GitHub merged it; Core follows main's push CI. |
| `done` | Main's push CI on the merge commit finished. |
| `stopped` | A check decided against. `reason` is one of `head_moved`, `pr_not_open`, `base_changed`, `review_not_passing`, `main_red`, `ci_red`, `conflict`, `nothing_to_merge`, `merge_blocked`, `batch_changed`, `checkout_mismatch`, `checkout_unproven`, `merge_refused`, `merge_unknown`, `post_check_failed`, `post_check_unverified`, `gh_too_old`, `wait_timeout`, `github_unreachable` or `dry_run_ended`. |
| `cancelled` | Cancelled by the Agent that released it, or by the user. |

`merge_retry` checks a stopped entry again from the start. Only the Agent that
released it, or the user, may call it; Core checks that before it reads
anything from GitHub. It reads main first and anchors the entry there, so a red
main run from before the retry no longer counts once main is green again. It
never reruns CI: a red job has to be rerun by other means first. An entry
stopped with `dry_run_ended` cannot be retried.

## Requirements

The Core host needs **gh 2.97.0 or later**. Job logs are read with
`gh api --allow-escape-sequences`, so their bytes, and the sha256 kept of them,
are what GitHub sent. gh added the flag in 2.97.0, where `gh api` began to
neutralize escape sequences ([GHSA-3m3g-3wcr-px46](https://github.com/cli/cli/security/advisories/GHSA-3m3g-3wcr-px46)).
With an older gh the check stops with `gh_too_old`, naming the flag and the
version.

## Evidence

When an entry merges, ends or stops, Core writes a comment to the task as
Yuzuno Core, with the evidence record attached as `mergeEvidence`. It also
mails the Agent that released the entry and the task's executor.

The record holds:

- the release (who, when, which request);
- the review round;
- main at release and at the check, with the CI runs examined;
- the gate: the merge ref or the batch (its branch, commit, PR and tree), and
  each CI job's checkout and log sha256;
- the merge: each request sent, the merge commit, and the post-check of its
  parents and tree;
- the batch's removal;
- main's push CI on the merge commit;
- the stop reason and detail, if any.

`merge_get` returns an entry with its history and evidence. `merge_list` lists
entries.
