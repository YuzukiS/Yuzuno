# T-71: refresh a retained run after monitoring stops

Original base: `2f685995096b2ed09b42a7b16aede2f78b1394b8`. Follow-up to
PR #48 on the same task; the original review and delivery history remains
intact. Before review the branch was rebased without conflicts through
`690d7c786eb1545963fb4bfd7383f73b9f1d3ea6` (Claude history) onto
`c40b8367d2dd0f7882e6265cceb3abd5dfb309e7` (T-82 status bar). Neither
changed this fix's source; the added status-bar regression verifies their
integration. The candidate branch is `fix/t71-history-refresh`.

Reproduction: old PR head A has a Running observation, its monitor stops,
new head B is watched, and GitHub cancels A. Before this fix `ci_refresh`
returned `nothing` for A while `ci_get` could show newer Cancelled jobs.
Tests-only commit `060c9fdef8c5844e50996268d4f47d2df3d26a52`, Job
`c7cd9bd4-57b5-4851-b11a-7ec70b401359`, reproduced the assertion failure
(`nothing` vs `checked`, test exit 101). The Job succeeded by verifying this
expected failure, not by claiming the implementation passed.

The follow-up adds a single exact-attempt read when no active monitor can
check a known run. It validates repository ID, run ID, attempt and SHA and
updates only the existing run's facts; it does not resume, renew, reschedule
or create a watch. Paused monitors do not drain completion mail. Reads use
the existing gate/ETag cache, GitHub poll interval and global rate cooldown.
Concurrent successes share cached answers; failed exact reads also share a
bounded ten-second in-memory error cache. No-run refresh still checks only
active view targets. Active monitoring retains its existing behavior.

`runWatched` in list/detail results describes current monitoring across all
subscribers and is not stored in the GitHub observation. Unwatched running
records appear as “Last seen running” in History and are excluded by
`runActive`, including the T-82 status bar consumer. Their remote status is
not fabricated. One-off refresh can then reveal the real terminal result.

Run `acceptance/t71-followup/check.sh` through a resource-bounded Yuzuno Job,
with the shared heavy-slot wrapper, cargo on PATH and an isolated cargo
target. It runs CI-monitor regressions, UI tests, typecheck, isolated Vite
build and controlled browser checks. Build/report output stays under
`target/t71-followup/check`. Set `YUZUNO_BROWSER_BIN` if Chromium is elsewhere.
Set absolute `T71_CHECK_OUT` to retain a separate candidate's output.

Coverage includes stopped A vs active B and another attempt, durable update,
paused/expired state preservation, no unwanted mail, unknown/incorrect
identities, 401/404/503 failures, 403/429 Retry-After, 304, poll interval,
repeat/concurrent checks, no inference from jobs to overall run state, and
stale cache protection. The browser checks light/dark at 390/1440 px and
20 px reading size. These are controlled fixtures, not live GitHub timing
claims. No daily Core, daily browser or daily `web/dist` is touched.

Recorded local evidence:
- Job `bc47c1d1-6b25-4c06-9321-e5752dff79ec`, candidate `95bdbb5`:
  CI-monitor tests 19/19, strict CI UI 3/3, Jobs UI 24/24, historical browser
  5/5 and existing CI browser 6/6 passed. Typecheck/build failed because the
  original shared node_modules lacked already-declared CodeMirror packages.
- Only this worktree's dependency symlink was corrected to an installed
  dependency tree with an identical package-lock. No manifests changed.
- Job `3486c63a-5ec6-4fe2-bdfc-ed5808873869`, candidate `5e89ef4`:
  typecheck, isolated Vite build, strict CI UI 3/3, Jobs UI 24/24 and
  historical browser 5/5 passed. This also checked the neutral historical
  status mark. Reports and screenshots are under `target/t71-followup/check-2`.
- Rebase did not change this fix's source; final candidate review and CI
  are recorded on the linked PR/task separately from these local checks.
- Job `4225ea87-e0fb-494a-b27a-435df211a553`, candidate `9ab1bf9` on
  `690d7c7`: CI-monitor 19/19, strict CI UI 3/3, Jobs UI 24/24, typecheck
  and Agent skill validation passed.

The T-82 integration regression verifies that an unwatched run is excluded
from the status-bar count, stopping a monitored run emits no false completion
notice, and an exact refresh reports only a real new terminal result. The
status bar continues to read cached lists only, without extra GitHub reads.

After deployment: open an old unwatched Running CI record, confirm its
historical label, click “Check CI with GitHub now”, and confirm both the row
and heading update. The monitor must remain stopped. Open a different run
while a check is pending: its steps and feedback must not be replaced by the
old response. In a stopped or paused record, failure/limiting must preserve
the previous observation and explain why the check could not complete.

Reference: [GitHub's exact workflow attempt read](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt).
