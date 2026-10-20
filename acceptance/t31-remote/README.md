# T-31: image input over SSH

This slice adds images to existing remote Codex and Claude conversations. The
local milestones remain PR #21 and PR #35. Base: `7b9c1f39d98b2d6a085ef453cf783a2242f2e3c5`.
The implementation and acceptance ran in a separate worktree and isolated Core
data directories. The daily Core was not restarted or deployed.

## Transfer contract

Core retains immutable, Agent-owned originals for drafts and history. Send
copies travel over the existing authenticated, strict-host-key SSH destination;
no image server or credentials are installed. Codex receives native
`localImage` paths on the execution machine. Claude receives the existing
checked-file descriptors and native image blocks, with at most 512,000 bytes
per fitted image and the existing 4 MiB bridge frame limit.

The private remote cache binds workspace, Agent, machine, target and harness.
Each request binds the current runtime instance, session, cwd and connection
generation, independently of the disk copy's identity. Identical content reuses
an immutable owner-scoped path across reconnects; older scoped paths remain
readable and can also be reused.
The receiver checks digests, format, count and byte limits; uses held directory
descriptors, no-follow opens, locks, atomic writes and fsync; and rechecks the
runtime before acknowledging. Core checks the returned manifest and fences
the live destination again before native submission. One transfer permit is
acquired before decoding and retained by the preparation worker on cancellation.
Concurrent transfers wait at most 75 seconds for that permit without reading
image bytes; the SSH exchange has its own 75-second deadline.

Limits are eight images, 10 MiB per original, 40 MiB per message, and 256 MiB /
4,096 entries per Agent cache. Full caches reject new copies without removing
history. Reconnects and retries reuse identical files; changed stored bytes are
refused. Transfer failures do not submit native input. Unknown native receipts
keep the existing no-resend behavior. Closing retains copies for resume;
explicit deletion waits up to ten seconds for the remote runtime to stop and
removes only that Agent's cache after confirming this, preserving Core originals. Unconfirmed cleanup leaves the
closed Agent available for a later deletion attempt. Before SSH can create a
copy, Core fsyncs an owner-bound cleanup obligation in the original-image
directory. Cancellation, timeout or a lost receipt never clears it. A closed
Agent with only uploaded drafts and no transfer obligation can be deleted
without SSH; an Agent with a possible transfer still requires confirmation.
For older builds without the marker, a persisted image-send attempt is
conservative cleanup evidence, including rejected or unknown native receipts.
If initial remote cache creation was interrupted before `owner.json` existed,
cleanup can remove only an empty cache or its private lock/temporary owner-write
files, after runtime shutdown is confirmed. Unknown content or links still
refuse deletion.

## Real Mac model evidence

The authorized Mac used its own existing accounts and CLI installations. No
credentials were copied and no global configuration or user sessions changed.
All fixtures were generated locally without sensitive content. Random codes
appeared only in image pixels, never in prompts.

| Harness | Native versions / model | Text plus two images | Image only | Added during execution |
| --- | --- | --- | --- | --- |
| Codex | CLI 0.162.1, `gpt-6.1-sol`, low effort | `004E6D`, `7D758D`, both blue circles | `127C5F`, blue circle | `8B33DC`, blue circle |
| Claude | CLI 2.1.267, SDK 0.3.296, `haiku` | `9C4EAF`, red square; `21EC19`, blue circle | `3B7C33`, blue circle | `7DBF21`, blue circle |

Both harnesses identified all four codes. The in-progress follow-up was bound
to the active turn. Exact request retry produced the same receipt without a
new turn; changing image identity under the same request ID was rejected.
Core originals remained byte-identical. Claude's 3,042,228-byte, 3000×1800
original produced a 511,587-byte remote copy; the original remained unchanged.

Recognition records:

- Codex: Job `1fc55366-eb4d-46f2-98a1-c99c596f007a`,
  `target/t31-remote/native-v1/report.json`, script `12a704a`, binary `22d93d1`.
- Claude: Job `5b13fd7f-8a83-45cb-8cd8-b7f8e4d9d62f`,
  `target/t31-remote/native-v3/report.json`, script `dfe5a0b`, binary `542865b`.

These whole Jobs ended in failure after the named recognition checks; they
are not presented as whole-run passes. The first next failed while archiving
Claude's runtime. The second next misclassified Codex's transient initial
`uncertain/connecting` state with no error. The archive correction is described
below; the latter was an acceptance-script correction.

Finishing checks reopen only these positively completed native sessions,
verify the same native identity, all historical codes and original hashes,
and do not resend model prompts. Changing the dedicated remote ownership
record is rejected before native submission; retry retains the rejected
receipt and turn count. Both finishing runs below passed: the real browser
opened the original, reloaded and reopened it with the same dimensions and no
page errors. Close retained copies; explicit deletion removed the owned remote
cache and retained the Core originals.

| Harness | Finishing Job | Source / binary | Original preview |
| --- | --- | --- | --- |
| Codex | `496a611c-3b9a-46c1-9667-757b3ca21b81` | `a583741` / `542865b` | 700×360 |
| Claude | `668b3b08-bdc2-4998-b1c1-919bf3231061` | `62bb39d` / `62bb39d` | 3000×1800 |

Reports, preview JSON and screenshots are retained under
`target/t31-remote/native-finish-codex-v3/` and
`target/t31-remote/native-finish-claude-v4/`. Both completed Agents were deleted
by their passing runs. Subsequent cache reuse and cleanup-obligation changes
were checked with the controlled regressions below; the model prompts were
not repeated and these deleted Agents were not reopened.

## Controlled regression evidence

These tests use controlled filesystem/runtime fixtures, not model inference:

| Coverage | Result | Job / evidence |
| --- | --- | --- |
| Rust image preparation and reply validation, including Python receiver subprocess cases | 8 passed | `70991014-b6c8-4264-a047-05635cab0dc7` |
| Python receiver on Linux and actual Mac Python 3.9.6 | 10 passed on each | `668b3b08-bdc2-4998-b1c1-919bf3231061` (Linux) / `8cb4f8ec-4754-4a30-b321-9e6384d0aa78` (Mac); process metadata/socket is a fixture |
| Pre-review Rust reply / receiver regression plus product rebuild | 2 Rust passed, including all 10 receiver cases | `668b3b08-bdc2-4998-b1c1-919bf3231061` |
| Claude state transitions, image wiring, generations and unknown-receipt behavior | 60 passed | `03dbec5c-5d86-4293-bd8f-83c7fbc7be29` |
| Remote runtime archives, SSH and identity boundaries | 9 passed | `dc30c4c7-ca77-4b9a-a00e-c9da88c2d199` |
| Web build and type check | Passed | `35eb7a6d-0bdb-4d37-959c-72acbebb747e` |
| Local / remote browser fixtures | 10 passed each | `c9006205-b210-45ba-83dd-83eb5809b2c8` / `edb2dbe3-d006-4c4f-aa51-a9fb8419b787` |

Receiver cases cover truncated/partial batches and retry, changed bytes and
format, foreign owner, runtime mismatch, machine/target separation, count and
byte limits, symlinks, quota, interrupted temporary writes, and deletion while
live versus stopped. Browser fixtures cover clipboard/picker deduplication,
hover/full preview/Escape, Agent switch and reload drafts, failed-send retention,
new typing during send, image-only history, and original-owner fork previews.
They do not substitute for the real model evidence above. Linux remote model
inference and native desktop clients were not exercised by this slice.

### R1 corrections

R1 `ac1aedf7-b54a-43b6-8e79-2749bea8860f` reviewed `72d274e` against
`7b9c1f3`, with all 20 diffs inspected and complete context. Its retained
conclusion is `unknown`: the original report says `patch is correct` but has
two P3 findings. It is not presented as a passing review. That head's CI run
`39077299803`, attempt 1, passed. The lead requested both narrow corrections
before the second review.

- `aed0b6e` adds regressions without changing the `72d274e` product. Negative
  control Job `6dbf63d4-7090-42ab-8758-8a6599882637` reproduced both failures:
  reconnect created a new image path, and deleting a closed draft-only Agent
  incorrectly entered SSH validation. Logs are in
  `target/t31-remote/r1-negative-source/negative-{0,1}.log`.
- `88434a7` separates transfer identity from immutable storage identity and
  persists owner-bound cleanup obligations before SSH. Job
  `1cd96ae1-2d55-43cb-9d5d-7d8acd22f3b3` passed 5 Rust tests (including 13
  Linux receiver cases), 2 Workspace lifecycle tests and all 13 receiver
  cases on the actual Mac. It checks unchanged bytes and entry count across
  runtime instances/generations, existing-path reuse at both cache limits,
  legacy-path readability, draft-only deletion without SSH, failure retention,
  restart, changed destination, malformed records and symlinks. Logs:
  `target/t31-remote/r1-fixes/`.
- `cd243f5` retains cleanup for pre-marker image-send attempts regardless of
  accepted/rejected/unknown status and adds a Claude regression for different
  fitted bytes under one original ID. Job
  `28628152-a5c6-4b95-92d0-ff359abbb0bf` passed the 5 Rust tests (now including
  14 Linux receiver cases), 3 Workspace lifecycle tests and the new Claude
  variant case on the Mac. Logs: `target/t31-remote/r1-final/`. The 13 earlier
  Mac cases remain applicable: the receiver implementation did not change
  after `88434a7`.

These are controlled transport/lifecycle checks, not another model run.
Different content can still fill the bounded cache. An Agent with a possible
transfer still needs remote cleanup confirmation; offline force deletion is
outside this slice. Core originals and native submission receipt semantics
remain unchanged.

### R2 corrections and acceptance status

R2 `0c46e5e1-8245-4227-8518-89e8395f3b02` reviewed
`45615d84d5f461cc8d2449f71438ff52b9098c9e` against `7b9c1f3`. It inspected
all 21 diffs with complete context, 54 source calls and no failed reads. Its
retained conclusion is also `unknown`: the original report says `patch is
correct` but contains two new P3 findings. That head's CI run `39078901850`,
attempt 1, passed Core, Web UI, Claude bridge and report-only lint. Neither
review is represented as approval. Both authorized rounds are used; there is
no third review and the post-R2 changes have no independent review result.

The lead authorized these two narrow corrections and their regression/CI
evidence before a user acceptance decision:

- Concurrent image transfers now wait for the existing single permit for up
  to 75 seconds. No image preparation occurs while waiting. Cancellation
  removes the waiter; timeout returns before creating a cleanup obligation or
  submitting native input. The preparation worker still retains its permit
  if its caller is cancelled.
- Deletion can recover an interrupted initial cache setup without `owner.json`
  only after runtime shutdown is confirmed. Every entry must first be checked
  as a private regular lock or bounded managed temporary file. Unknown files,
  directories and links refuse deletion before any removal. Existing owner
  identity checks remain in force.

Negative-control commit `0f219b1` adds tests to the unchanged `45615d8` product.
Job `87c0f308-94ea-4d9f-aa9f-aec7d0c1f0a7` reproduced both expected failures:
`Missing image ownership record` and immediate concurrent-transfer rejection.
Logs are in `target/t31-remote/r2-negative-source/negative-{0,1}.log`.

Product fixes and expanded regressions are committed through
`c139bea27b699b067ffe816c04cdfe074f9a8434`. Job
`fc5ca610-ec3f-45e2-a778-73a16b970f82` passed all 7 Rust module tests
(including all 16 Linux receiver cases), 3 Workspace lifecycle tests and all
16 receiver cases on the authorized Mac. Queue tests cover a second request
continuing after release, cancellation and timeout before transfer, with the
original preserved. Recovery tests cover empty/temporary setup debris and
unknown content, directory and symlink refusal, including no partial removal
before failure. The Job used 2 CPU / 6 GiB / no swap and peaked at
5,451,493,376 bytes. Logs: `target/t31-remote/r2-fixes/`.

These are controlled regressions; the real model evidence above was not
repeated. Exact CI evidence for the final pushed head is recorded separately
in T-31 with both review reports; earlier green runs do not cover that head.
Merge requires the user's acceptance of the
post-R2 candidate; this document does not claim that acceptance or deployment.

## Failures retained and scope of fixes

- SDK 0.3.296's optional local platform CLI packages made the old remote
  archive exceed 256 MiB. `5ee60b8` excludes precisely its eight platform CLI
  package names. The bridge explicitly uses the execution machine's existing
  CLI. JavaScript dependencies and the archive limit remain unchanged. A
  sparse oversized-package regression passes. Dependency layout upgrades
  require another archive check; this is not a claim about future SDK layouts.
- `native-v2`, Job `7279c3d8-d31b-4f00-9e92-c09e44778990`, reached a 35-second
  unknown initialization outcome before any image upload or prompt. No old
  request was resent. Root cause remains undetermined. Direct catalog-only
  diagnosis `d3151668-896e-44dc-93bc-c09772592518` and full Core→host→bridge→MCP
  start-only diagnosis `673a90fb-3b7c-4d6c-ad63-c02fa2339fbb` then passed with
  the same CLI/SDK and normal defaults; the uninstrumented real Claude image
  run also passed its recognition checks. This does not prove the earlier
  startup timeout was fixed.
- Real Claude close returned just before its remote host finished exiting.
  The original cleanup safely refused the immediate deletion and retained
  copies (Job `cede10c5-1edf-4a2f-b9c5-388987ef813a`). A delayed-exit regression
  failed before `62bb39d` and passed after it. Cleanup now passively checks
  process state for up to ten seconds under the lifecycle lock; it never
  signals a PID or probes a still-live host's socket. Live, recycled or
  unconfirmed process state still refuses deletion. The real Claude finishing
  run then passed without resending prompts.
- Finishing scripts initially selected both the thumbnail and hover image,
  then waited for an offscreen lazy thumbnail. Their failed Jobs remain in
  the task record. Selector and scroll/wait fixes change acceptance code only.
- The expanded Mac receiver run initially failed in fixture setup because
  macOS's default per-user temporary directory exceeded AF_UNIX's path limit
  (Job `fc82ae44-1102-4a42-911a-bf914749d550`). `86ebfef` uses a unique private
  `/tmp` fixture, without changing product paths. The repeated Mac receiver
  suite passed all ten cases in Job `8cb4f8ec-4754-4a30-b321-9e6384d0aa78`.

## Reproduction

`native.py` requires explicit `T31_REMOTE_TARGET`, `T31_REMOTE_CODEX`, and
`T31_CORE_BIN`, plus built web assets and installed Claude runtime dependencies.
Set `T31_CORE_SOURCE_HEAD` to the binary's source revision and a fresh
`T31_RUN_DIR` under this worktree's `target/t31-remote/native-*`. Submit through
a resource-bounded Job with the committed source, existing heavy slot, and
authorized SSH target. `T31_HARNESSES` can select one harness. It creates only
isolated Core/Agent sessions; it stops on unknown input or pending approval.

`T31_FINISH_SOURCE` can reuse a prior isolated data directory only after the
script checks completed known native sessions. It preserves the original
report and saves a new one. A successful explicit deletion is terminal for
that Agent's finishing run; do not rerun against the deleted Agent.
`diagnose.py` and `diagnose-core.py` retain the bounded, no-prompt diagnostics
used for the earlier initialization incident; they are not image acceptance.
