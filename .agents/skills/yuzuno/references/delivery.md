# Delivering a code change

The order below is the usual shape; your project's instructions decide who may push, merge or deploy, how many review rounds are allowed and which tests are required.

## Candidate

- Commit, push the branch, and create or update the PR — with `github_pr_submit` (asynchronous; the result arrives by mail) or with the project's own git tooling.
- Link the PR to the task with `github_links` so reviews and CI can refer to it. A new commit is a new candidate: CI, reviews and your result must name the exact head.

## Explicit delivery flow (when available)

- Use `delivery_get` to read the actual Workspace review settings and any existing flow. Only explicitly authorized tasks use `delivery_enable`: one linked PR, full base/head, and a cap of one or two registered review attempts. The assigned open local Agent receives the results. Existing matching manual reviews are reused.
- Submit `task_submit_result` with status `review`, your original `dispatchId` when required, and the exact `delivery` candidate returned by `delivery_get`. This atomically queues that authorized review and exact-commit CI subscription. An ordinary result without `delivery` starts neither. Finish the turn or do independent work; do not also start a replacement review.
- A new push invalidates old readiness. After checking a completed review, `delivery_continue` explicitly authorizes the next candidate within the original cap, followed by another matching result. Registered failed attempts consume the cap too. An unfinished or `unknown` review cannot be replaced this way: retain its review/request IDs and reconcile manually.
- `delivery_get` shows evidence, observation times and the next action. `ready_to_merge` refers to the fixed review and observed GitHub Actions workflows, not permission to merge, branch-protection approval or deployment. `delivery_stop` prevents future automation without cancelling already running operations. Do not emulate these tools on an older Core.

### Lifecycle cleanup (T-80 source; requires a Core with this change)

- Task done/cancelled/archive and an observed PR merge close automatic delivery and retain its terminal state, reason, time, operation IDs and evidence. `ready_to_merge`, `waiting_fix` and CI failure are not terminal. Reopening a task does not reopen its finished delivery or reset the review cap.
- `delivery_stop` remains idempotent after the task is closed. It releases only that flow's CI interests, including prior rounds; a manual subscription sharing the same ID remains independent. It does not cancel a running reviewer or any remote workflow.
- PR candidate subscriptions close on task closure or an observed PR merge. Other tasks/Agents sharing a watch retain their own interests. An explicit run subscription can still finish post-merge verification after task closure; Core retains it until its latest observed attempt finishes and its completion mail is recorded (or its seven-day expiry / explicit unsubscribe). Subscribe to the actual main run URL for this purpose, not the merged PR URL, or, where the Core has commit watches (below), to the merge commit before its run exists. A commit watch is retained after task closure until every run it found has finished at its latest attempt with its mail recorded, and complete, successful reads after your request have seen nothing new for ten minutes. A new run or attempt, a changed status, a failed read or an incomplete run list starts those ten minutes again. This is the product's bounded discovery window for later workflows of the same push, not a guarantee that no later workflow will start.
- `ci_unsubscribe` explicitly stops all interests in your chosen subscription. `ci_list` retains inactive subscriptions, interest closure reasons, runs and mail history. To watch a same-SHA rerun after cleanup, use a **new** `ci_subscribe` requestId (and reopen the task for a PR candidate; a specific run may be subscribed on a done task). Replaying an old requestId only retrieves its existing subscription and never renews or reactivates it. A new request needs a fresh run observation; it cannot treat a cached old green as new verification.

## CI

- `ci_subscribe` with the PR or run URL and the exact head SHA sends one mail per completed run attempt. A newer head needs its own subscription.
- After a merge, watch the merge commit itself, with no need to wait for its run to appear.
  - Pass its commit URL (`https://github.com/{owner}/{repo}/commit/{sha}`), `expectedSha` set to that SHA, and the exact `branch` and `event` of the runs to watch. For a merge to main that is usually `main` and `push`; check the repository's workflows rather than guessing.
  - Until a run exists the watch shows `waiting_for_run` and reads less often: every 30 s for ten minutes, every two minutes until an hour, then every ten minutes. The Agent rail shows it as waiting for its first run, still monitored, with its last successful check; only a failed or overdue read turns that into Check CI.
  - Only runs of that SHA, branch, event and repository count. A PR run of the same commit, another branch's run or a fork's run never does, and a newer main commit never replaces the watched one.
  - Each finished attempt mails once. If no matching run was observed by the seven-day expiry, one mail per subscription says so, with any failed reads or an incomplete run list. It reports what Yuzuno observed, not that GitHub never had such a run, and it is not a pass. Replaying an old requestId neither renews the watch nor mails again.
- `ci_get` returns the run as Core last observed it and one page of its jobs and steps, which Core reads through a short shared cache (an expired cache means one conditional GitHub read); each part carries its own observation time. `ci_refresh` asks GitHub about the run and its visible pages now, within GitHub's poll interval and cooldowns. Neither reruns or cancels CI.
- A known `runKey` can be checked once with `ci_refresh` even when its monitor is stopped, expired or paused. This does not resume or renew monitoring. `runWatched` describes current monitoring separately from the last observed GitHub status; an unwatched Running record is historical, not proof it is still running. Refresh reads the exact recorded attempt and retains old facts on failure.

## Independent review

- In releases with review policy 2, a complete, valid review that explicitly says the patch is correct and contains only P3 suggestions can conclude `approved_with_notes`. Keep those suggestions visible. P0–P2 findings, an incorrect or unknown verdict, incomplete coverage and invalid or unconfirmed output never pass under this exception. `no_findings` still means a passing review without findings.
- Read the stored `policyVersion` and `reasonCodes` with the evidence. Reasons distinguish incomplete coverage, unsupported source, model uncertainty or conflicting verdicts, an invalid report, and failed, cancelled or unconfirmed execution. Codes explain the outcome; they are not permission to ignore it. Older records keep their original verdict and raw report; do not reclassify an old `unknown` merely because its findings are P3. Passing still needs the exact candidate, CI and the project's merge authority.

- Source versions with `coveragePolicyVersion: 2` also accept a complete `source_read` of an **added regular text file** as `full_added_source` evidence. Every delivered range must name the same frozen revision, blob and mode, include its change-manifest metadata, and together cover the whole file. An empty file requires an actual successful empty read. Missing, truncated, failed or budget-rejected responses count for nothing. Modified and removed files still need their complete diff; a rename remains deletion plus addition, so reading only its new path is insufficient. Binary files, links and submodules are not eligible.
- `coverage.coveredFileCount` counts unique covered files. `deliveredCompleteDiffs` remains the actual complete-diff count; it is never increased by a source read. `coveredFiles` names the selected proof's `deliveredVia` (`source_diff` or `source_read`), `evidenceKind`, fixed identity and, for full added source, receipt numbers. A complete diff takes precedence if both forms were delivered. This coverage version is stamped when a new review is registered; absent/older versions remain diff-only, and old reports or verdicts are not reinterpreted.
- From `coveragePolicyVersion: 3` (review policy 3), a review also records `scope`. It names its frozen base, head and merge base, and the policy it used. For every changed path it gives each side's blob and mode, every fact Core found for the path, and a `state` that names the first fact in this order:
  - `covered`, with T-134's `evidenceKind`;
  - `excluded`, by a rule of the base's policy;
  - `unsupported`, as `binary`, `not_utf8`, `symlink`, `submodule` or `special_file`, with its side and, for a regular file, its content's SHA-256;
  - `budget_exhausted`, either `diff_exceeds_context` (the complete diff is larger than the whole review context; a large file with a small diff stays readable) or `context_exhausted` (a budget ran out first);
  - `read_failed`, with the unresolved requests;
  - `not_read`, with any `remainingByteRanges`.

  Each fact says when it was found:
  - `before_review`: links, submodules and policy exclusions, known from tree metadata alone. The reviewer is told not to request them, and no changed blob is fetched for them.
  - `during_review`: something the reviewer's own request ran into.
  - `after_review`: Core's bounded check of what was left uncovered, made only once the reviewer has finished and outside its deadline, so it can't take budget or time from the review. A cancellation or its own time limit only stops the check (`scope.checkAfterReview: "stopped"`), never the completed result. Its gaps are recorded as `not_checked_after_review`.

  Such paths set `unsupported_source`, `diff_too_large` or `scope_excluded` and keep the review incomplete. None of them is ever "covered", and nothing here approves a review.
- **Scope policy.** It is the file `.yuzuno/review-scope.json`, read only at the PR's frozen base, so a head can't exempt itself. Its schema is `{"version":1,"exclude":[{"path":"exact/path" or "dir/**","reason":"…"}]}`, with at most 50 rules and 8 KB. Rules use no other globs and no `.`, `..` or absolute paths, and the policy file itself is always reviewed.
  - Without the file, every changed path is in scope. A file that can't be used excludes nothing. It adds `scope_policy_invalid` only to an incomplete review, so a review that covered every path still passes.
  - When excluded paths are the only gap, `scopeConclusion` shows the verdict within the policy's scope. It is for information only: the review's conclusion stays `unknown`, and delivery ignores it.
- **Repeat rounds.** If the latest completed round of the exact same base and head recorded such permanent gaps, `review_start` refuses before a round exists and names them. Report the gap instead, with any evidence. `acknowledgeUnreviewable: true` reviews the other paths anyway. It only acknowledges the gap: it is not an approval, doesn't lift a round limit and doesn't change the result.
- **Evidence for an uncovered path.** `review_evidence_add` records a source review, build provenance, an artifact hash, a signature or a behaviour test. It can reference another review or Job of the task, a CI run of the same repository, or an https link.
  - The record is bound to one review's base, head, merge base and that path's blobs and modes. It shows as bound to this candidate only when all of these match.
  - After a new head it shows as another candidate's. Add it again with `previousEvidenceId` to bind it to the new review; the old record stays.
  - Core fetches and verifies nothing, and the note is yours. "Bound to this candidate" is an identity match only. `artifactMatchesHeadContent` says only that the registered SHA-256 equals the hash of the fixed Git content Core read, not that the referenced Job's or link's artifact was retrieved or checked. Evidence never changes a review's conclusion or whether it passes.
  - The permanent gaps are paths no further round of the same head can cover. That says nothing about whether any other gap may be retried or continued.
- **Continuing a round** (Cores newer than 2026.10.19-core.12). `review_continue` asks for a bounded continuation of one completed round of the same frozen snapshot, for the changed paths it left `not_read` or `read_failed`.
  - It is a new isolated reviewer run with its own record, round number and cost, not a resumed session. It gets only what the parent round left of its 160 calls, 1.5 MB and 900 000 ms, to the exact millisecond; nothing is refilled.
  - A PR gets at most two started review rounds when one of them is a continuation, counted across every task linked to that PR. Only a round recorded with a ledger that failed before its native start was recorded provably started nothing; older rounds and unknown ones count.
  - Core refuses it before it exists, starting no model, when the parent:
    - isn't `completed` with `ledger.nativeCompletion: "confirmed"` (its native run completed and shut down, and its report was stored before the check after the review);
    - predates usage ledgers (every round recorded before such a Core);
    - is itself a continuation or already has one;
    - stopped at a terminal limit or has nothing left to read;
    - was judged with another snapshot, policy or reviewer setting;
    - left too little of its budget.
  - Paths no review of the snapshot can cover need `acknowledgeUnreviewable: true`; the result then can't pass.
  - Before its reviewer starts, Core re-fetches the snapshot and checks that it is the parent's, that every response the parent delivered still matches its recorded `responseSha256`, and that the unread paths fit the remaining bytes. Otherwise it ends `failed` with `continuation_refused` and `nativeStartedAt` unset: no model ran, and the parent's one continuation remains.
  - Under an authorized delivery of this candidate it must be one of the delivery's attempts, so use `delivery_continue` first. Manually it is a counted round like any other, and your project's round limit applies.
  - Its reviewer gets the parent's conclusion, findings and coverage as an earlier model's untrusted output, never as instructions. Re-sent material counts against the remaining bytes.
  - Its coverage, scope and conclusion are over both rounds. Each covered path names the review whose reads proved it (`byReview`). The parent's unresolved requests stay unresolved until it covers their path. The parent's findings are carried unchanged with their `origin`, and a blocking finding from either round blocks; one not repeated isn't resolved. The parent's own record never changes.
  - `ledger` records each run's calls, bytes, operation time and the harness's own usage report, and for a continuation the `cumulative` total. Claude's reported cost is its own estimate, not a bill; Codex reports none, so it is `unknown`, never 0.
  - A round whose native run completed and shut down but which Core restarted during the check after the review finishes as `completed` with `scope.checkAfterReview: "interrupted"`; without that confirmation it is unknown, as before.
  - After a lost reply, repeat the same requestId. A continuation left unknown by a restart is never run again; reconcile it from its record.
- **Reviewing a new head incrementally** (source update; requires a containing Core release). `review_start` with `previousReviewId` reviews a new head of the PR after one completed full round of another head.
  - It is a new round with its own record, a normal budget and its own cost. It counts toward the same two started rounds per PR as a continuation.
  - Only that round's proofs of changed paths whose status and both sides' blob and mode are identical, under the same merge base, carry over, each naming that round (`byReview`) and the head it read (`provedAtRevision`). Every other changed path is a target the reviewer must read completely. A new merge base makes every path a target.
  - A carried proof only shows that an earlier reviewer read that diff. The reviewer is asked to check how this head's changes affect carried paths and to say what it checked; if it can't tell, the verdict is unknown.
  - Core refuses it before it exists, starting no model, when the earlier round isn't a completed full round with a confirmed native completion and a ledger, used another reviewer or policy, or reviewed this same head (that is `review_continue`'s case).
  - Before its reviewer starts, Core checks that the earlier round's retained responses still match their hashes, and that the fetched head isn't the earlier one and changes something. Otherwise it ends `failed` with `incremental_refused` and `nativeStartedAt` unset, and it doesn't count.
  - The earlier findings stay, with their `origin`, and a P0–P2 one keeps blocking. One is settled only when this round marks it `fixed` with fix paths whose head object (blob and mode) differs from that head's and that this round read completely itself. A path that left the PR, a finding not repeated, or a missing, duplicate or invalid answer settles nothing; the finding stays `still_valid` with the reason. Settled ones are listed in `settledFindings` with what settled them. The earlier round's own verdict isn't carried.
  - `ledger.cumulative` shows both rounds' calls, bytes and time, and each run's own usage report under `runs`; a cost one of them didn't report stays unknown. The earlier round's record never changes.

- Check `review_list` for the same base and head first, so a round is not started twice.
- Start it yourself with `review_start` on the task's PR link and the fixed base and head, once the candidate is frozen and your targeted checks pass. It may run while CI runs. Finish the turn; the report arrives by mail and `review_get` reads its summary (`view: "full"` adds the original report and per-file evidence).
  - Take `baseSha` and `headSha` from the PR link (`github_links`, `snapshot.baseSha` and `snapshot.headSha`). The PR's base is the commit GitHub recorded for it, often behind the target branch's current tip: do not substitute main's head. If you are unsure of the base, omit `baseSha` alone: the round reviews your fixed `headSha` against the PR's current base.
  - An abbreviation of 4 to 39 hexadecimal characters works too, if it is exactly one commit of the link's repository: Core resolves it on GitHub and records the full SHA. An ambiguous one, a branch or another revision expression is refused, not guessed. Task materials take abbreviations the same way, resolved in their `repositoryId`.
- Verify each finding against the code. Fix what is in scope, then give the new head its own CI and the next round as the project allows. Raise scope or verdict disputes with whoever owns that decision.
- A review is evidence, not approval: it does not merge, run code or complete the task. Failures of the review service itself are not review rounds; report them rather than retrying without limit.

### Fixed-source tool errors

Where the running reviewer advertises it, `source_search` accepts an omitted first-page `cursor` as `0:1`; subsequent pages require the returned `nextCursor`. This is a reviewer tool contract, not an additional Workspace tool or permission. Older Core versions may still require the initial cursor explicitly.

The reviewer must correct failed arguments using the returned error and schema. Three identical unsuccessful calls stop the review early with incomplete coverage; the overall 160-call / 1.5 MB budget remains unchanged. Failed requests remain in the report. A successful correction can resolve a parameter failure only within its recorded source scope, and does not itself prove any additional diff or line coverage. Missing source, mismatched revisions/paths, partial range recovery and exhausted budgets remain incomplete. Inspect the original receipts, `resolvedByReceipt` and `terminalLimit` before interpreting a recovered or failed review; do not erase a failed attempt or launch an extra round without authorization.

In source versions supporting `searchRecovery` evidence, a non-parameter `source_search` failure can recover through successful pages at the same frozen revision and literal query, beginning at the same parsed cursor. Core compares the prefixes' actual matching path sets in that frozen tree; adding or removing a trailing slash alone proves nothing (`src` may also match `src-extra`). Follow every returned `nextCursor` until the chain ends. Partial chains, skipped source entries, other failures and terminal limits remain incomplete. The report retains the original failure, path-set fingerprint, successful receipt chain and final `resolvedByReceipt`. This source capability does not imply it is deployed on an older connected Core or repair the underlying I/O failure.

## Result

- `task_submit_result` on the same task: exact head, CI run, review identifier and conclusion, tests and their scope, known limits, and links. Pass `dispatchId` when you were dispatched and your tools accept it.
- Use status `review` unless you were asked to report `done`. Do not describe a merge or deployment you did not observe; after someone else merges or deploys, their record states it.
