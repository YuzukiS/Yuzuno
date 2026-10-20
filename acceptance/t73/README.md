# T73: on-demand source at fixed Git revisions

A normal small edit in a large text file no longer causes the entire review to
fail a 1 MB blob gate. Core freezes the repository identity and base/head/merge
base, fetches an independent bare Git object store with `blob:none`, and gives
both isolated reviewers five structured tools: `review_changes`, `source_diff`,
`source_paths`, `source_search`, and `source_read`. The first prompt contains only
revision/budget metadata and the first change-manifest page. Git is required on
the Core host; its HTTPS credential helper uses the host's existing official gh
login. No checkout, author worktree, repository hooks, textconv, external diff,
submodules, symlink targets, arbitrary revisions, or model-selected commands are
used. The temporary object cache is removed at completion; response originals
and fixed revision/blob/range receipts remain with the report.

GitHub's [compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
limits its file list to 300 even when commit pages continue; its
[recursive tree API](https://docs.github.com/en/rest/git/trees#get-a-tree) can
truncate at 100,000 entries or 7 MB. Those responses cannot establish complete
review coverage. Only comparison identity metadata is taken from the compare
API. Git enumerates the fixed change manifest and supplies complete per-file
diffs; [partial clone](https://git-scm.com/docs/partial-clone) defers blob transfer
until needed. Renames are represented as deletion plus addition to avoid fetching
unrelated files for similarity heuristics.

Each response is at most 64 KB; source reads are inclusive, 1-based, and at most
500 lines. Diff pages return byte offsets, path pages return integer cursors, and
literal text/symbol searches return continuation cursors, at most 20 matches from
8 files per page, plus explicit skipped non-text/non-regular paths. Search previews
can be truncated and are marked accordingly. Callers must continue a search
before claiming it is exhaustive. Full ranges are available through source_read.

These are explicit product budgets, not model or GitHub size limits: 1.5 MB of
source context including failed responses, 160 calls, the existing 900-second
review deadline, 45 seconds per Git operation, a 256 MiB temporary object budget,
16 MiB per metadata operation, and a 16 MB local diff cache. A reached budget or
unavailable required source is reported as incomplete, never a clean result.
Binary/non-UTF8 changed files, links and submodules remain explicit unsupported
coverage. Models retain their existing restricted tools, actual model records,
report persistence, outdating and notification deduplication contracts.

Core records which complete diff pages were delivered and all remaining byte
ranges/files. Delivery is evidence availability, not proof that a model reasoned
correctly; the native conclusion is still required. A valid but oversized source
range creates a coverage gap. Only later delivered ranges for the same fixed
revision and path can cover it; partial ranges or other versions/paths do not.
All failure originals remain. Invalid parameters without an identifiable source
range are recorded separately from missing readable source. Actual missing
source and terminal budgets cannot be cleared by a model assertion.

Validation on 2026-10-16:

- Job `4a1f78df-53b3-40cc-8225-c8e9fe2faf3b`: 15 focused Core tests, two explicit
  acceptance tests, and two Claude schema/isolation tests passed. Limits were
  2 CPU / 4 GiB / zero swap, cargo -j2 and the shared heavy-slot gate. Peak memory
  was 2,953,011,200 bytes; process limits remained at 512, reservation released.
- The real Linux source file identified in `evidence.json` is 4,345,221 bytes and
  41,664 lines. Its downloaded bytes reproduce Git blob SHA
  `3088a4a13cb50b918dd190711ec2a84532a28200`. A controlled local commit adds one
  comment to that exact source: the complete diff is 170 bytes, and lines
  1300–1302 remain readable with verified provenance. No model was used for this
  backend test; the upstream source artifact is retained locally, not committed.
- A separate read-only network probe exercised the production GitHub identity
  and partial-fetch code against published Yuzuno commits
  `951f487fbc71122e5f48e37c7d14d8c9237f2684` and
  `8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b`, with no checkout or template hooks.
- Regressions cover the T68 501-line failure followed by complete split coverage,
  partial/wrong-revision/wrong-path recovery, actually missing source, unchanged
  callers, CRLF/UTF8, many-path paging, undelivered diff pages, terminal budgets,
  byte-limit fail-fast behavior and cancellation of Git descendants.

The first validation Job `df62298e-f531-4a92-8633-18a9a9e829da` found a real pipe
limit bug: stdout filled while the combined read awaited stderr EOF, delaying
rejection until the deadline. Each pipe now rejects independently as soon as its
budget is exceeded; the regression requires failure within two seconds. That
failed run remains in `target/t73/core-tests-v1.log` and `job-v1-terminal.json`.
Successful logs/receipts are in the same ignored directory. Independent native
review and exact-commit CI are separate gates; these tests are not self-approval.

CI exposed an environment dependency in the new options-only Claude test: it
looked for an installed native CLI, which CI intentionally omits. The test now
provides a temporary inert executable and restores PATH; product code is
unchanged. All 51 bridge tests passed in Job
`fc95269a-9df2-4f4b-b53d-1d2f4d0a2c43` without relying on a native Claude install.

Published core.5 independent review R1 (`7b573f67-39ab-406d-a393-ef792d2daef7`,
actual Codex `gpt-6.1-sol`) requested one P2 change: 12,000 raw diff bytes can
exceed the 64 KB response budget after sixfold JSON control-character escaping.
Diff pages now shrink against their serialized envelope while preserving UTF-8
boundaries and contiguous offsets. Manifest/path pages also adapt to serialized
size, and search accounts for skipped-path bytes. Job
`b6d25e29-4b5c-4ab9-ba97-2788bd7ced4f` passed all 17 focused Core tests plus the
real-source test, including lossless reconstruction of control-character/UTF-8
diffs and continuation across highly escaped paths. R1 is retained unchanged;
this fix requires a new independent review of the new candidate.
