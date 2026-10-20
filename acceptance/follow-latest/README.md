# T-35: return to latest and preserve the reader's choice

The fixed product base is `6673c3ef237a934fd5220cb6ce15738ec78d79bf`.
Product changes were validated at `423d075b2a045cae3e40d7081b620377462637df`.
The task dispatch is `ba941e92-9f01-4285-b6d2-904dbee2617f`.

## Reproduction and change

The older observation that Back to latest sometimes stopped 200–300 px above
the bottom did not reproduce on this base. The button already uses instant
scrolling. A distinct failure within the task's acceptance criteria did:
with 48 turns and a short latest turn, a real upward wheel initially moved
1200 px away from the bottom, then variable-height measurement returned the
reader to the bottom and resumed following without another user action.

The initial `ConversationRows` layout effects could run before the ancestor
scroll element's ref was attached. Returning at that point left the observer
unbound and visible row heights unmeasured because the effect's ref dependency
did not change. The first upward scroll then triggered late measurement.

The diagnostic trace shows scrollTop 10161 after the wheel, then a row leaving
the DOM reduced scrollHeight by 596. The measurement correction wrote 11635;
the browser clamped it to the bottom, 10765, and `onScroll` resumed following.
The write's stack identifies `ConversationRows`' measurement correction.

`ConversationWindow` now publishes the attached scroll element after commit.
Nested row lists bind their observers and measure when that element becomes
available. The fix leaves App's following policy and T-79's button/indicator
changes intact. No Agent tool contract changes were made; skill sync is N/A.

## Evidence

All runs used the isolated `t35-follow-latest` worktree, the shared two-heavy-job
slot wrapper, and Yuzuno Job resource limits of 2 CPU / 3072 MiB / zero swap.
The browser intercepts every request at a synthetic origin; it never reaches
the daily Core. SSE deltas are generated every 25 ms through the app's normal
event handler. No page errors or write requests were recorded.

| Run | Job | Outcome |
| --- | --- | --- |
| Initial setup | `a4518f36-239c-4c1a-b955-24988f5e9adf` | Build stopped on missing CodeMirror in an old dependency tree; browser did not run. |
| Baseline, driver `9b1a550` | `a1ff7435-5497-4a76-a27f-672360e4919d` | Build passed; 6/8 browser cases passed. Both short-tail cases reproduced the wheel bounce. |
| Diagnostic, driver `e2d89a5` | `80bebb68-53ad-40d9-8659-0c116c2f7250` | Reproduced the short-tail bounce with bounded geometry/write traces. A 350 ms delayed return from an earlier page reached the tail and followed growth. |
| Candidate `423d075` | `169e9042-7a34-4a8d-9c2c-b7eea0da7113` | Typecheck/build, 10/10 browser cases, UI 84/84 and live-detail 12/12 passed. |

The dependency correction reused the complete T-77/T-67 dependency tree after
verifying its package lock was byte-identical. Retained Job snapshots identify
the exact scripts and Git head. All raw logs and screenshots remain under
`target/t35/{baseline-setup-failed,baseline,diagnostic,candidate-v1}` with Job
receipts in `target/t35/*-job.json`. `comparison.json` contains compact measured
results from the retained baseline and candidate reports.

The final browser matrix covers long conversations, a single oversized turn,
a short latest turn, a bounded API body window, and return from an older API
page with 350 ms latency, each with ordinary and reduced motion. Every case
checks real upward-wheel reading, clicking Back to latest during growth,
continued following, cancellation while output grows, anchor preservation,
explicit resumption, and Agent switching while another Agent is producing
output. Tail DOM must be mounted before the final bottom-distance assertion;
an empty loading pane is not accepted as success.

The earlier diagnostic's switch-back sample had no mounted turns and was not
accepted as switch coverage. The final candidate adds the tail-DOM requirement
and passes with nonempty rendered content in all ten cases.

## Re-running

Run resource-heavy work as a Yuzuno Job, with dependencies matching
`web/package-lock.json` and an isolated output directory. The browser driver is
`web/tools/follow-latest-check.mjs`; it requires `YUZUNO_UI_DIST` and
`YUZUNO_CHECK_OUTPUT`. Optional `T35_SHAPES`, `T35_MOTIONS`, and `T35_TRACE` select
bounded diagnostic cases and traces. `T35_HEAD` records the product revision.
`candidate-v1.sh` records the production diff, builds, executes the matrix, and
runs the two relevant existing test files. `diagnostic.sh` deliberately reuses
and hashes the retained baseline build rather than rebuilding the candidate.

These are deterministic synthetic Linux Chromium checks at 1440×1000 and
20 px text. They do not establish Windows/native WebView performance, live
Core transport behavior, or a general latency percentile. No deployment or
merge is implied by local test success.
