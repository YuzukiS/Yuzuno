# T-50: compact, trustworthy mailbox doorbells

Base `aa901e33446379817e891d6d00226de92ba6081f`, isolated worktree `.claude/worktrees/t50-mail-notice`, branch `feat/t50-mail-notice`.

After independent R1 passed on `7a63601`, the final candidate integrates Dev 1's frozen T-47 head `5303f387f907a1f2b33cc7cd8a863f6c70c4a588`, which already includes T-46 main `dd6d5d9`. The merge was automatic. Shared collaboration/runtime/module-registration changes retain both sides; T-50's added/removed shared lines and all nonshared source blobs are unchanged. `target/t50/integration-check.json` records those checks. Exact final-head CI validates the combined tree; no full local matrix, browser run, systemd workload or paid native acceptance is repeated for this merge.

Collapsed notices show sender/short name, type/result and the actual normal/urgent priority. Two type/result groups plus a remainder represent mixed batches. Long names truncate visually and remain available on expansion; the original delivery pointer is still collapsed. Viewing never calls peer_read, marks mail read, reads current Jobs, or changes wakeup rules.

## Trust and history

- `insert_message` derives a small `notice` from the authenticated author and immutable system metadata. Public peer_send rejects metadata, and an Agent/user author always remains a peer even if its name or prose says Job/CI. Other system operations (including PR creation/review) use the short System fallback.
- Only `{kind:"system",id:"core"}` may classify a Job/CI result. No body keyword classification. Unrecognized/missing structured fields fall back safely.
- The existing reservation transaction captures its exact eligible recipient/priority/pending/unread range. Its bounded `delivery.detail.mailbox` includes after/through sequences, message/result counts, at most two groups and a remaining count. Same Job/CI event identity+attempt+status coalesces within that batch; the producer remains responsible for durable cross-delivery notification deduplication. The mailbox itself is preserved.
- Completion, uncertain outcomes and restart retain that snapshot and native client/turn/session bindings. Read projection queries the current conversation's loaded native bindings through expression indexes; it neither scans all old mailbox bodies nor queries current execution state. Historical deliveries without a snapshot use Workspace mail and any known priority.
- Existing normal/urgent admission, native start/steer/Claude hook behavior, recipient scope and peer_read semantics are unchanged. Streamed Item replacement preserves the already projected snapshot.

## Producer contract

T-47's actual Job producer (`981cb504`, Dev 1) fixes these fields when sending:

```json
{
  "sender": { "kind": "system", "id": "core", "name": "Yuzuno Core" },
  "priority": "normal",
  "metadata": {
    "kind": "job",
    "status": "failed",
    "jobId": "job-uuid",
    "attempt": "attempt-uuid",
    "name": "单测",
    "systemdResult": "oom-kill"
  }
}
```

Lifecycle statuses: succeeded, failed, cancelled, interrupted, rejected, unknown. Only `failed + systemdResult=oom-kill` or `failed + systemdResult=timeout` refines the displayed outcome to out of memory or timed out. Missing evidence remains an ordinary failure; unknown remains unknown even if a result string is present. The metadata uses the matching attempt's machine evidence, not the reason prose. Dev 1 confirmed this shape and its real bounded-OOM Lab notification; T-50 does not modify the Jobs module or navigation.

Read-only inspection of Dev 1's stopped `lab-1f4b89d17d` SQLite confirmed ten actual normal/Core Job notifications with this UUID-attempt contract, including succeeded, exit-code failure, cancellation without evidence, rejected and `failed + oom-kill`. Only notification metadata was read; the retained comparison is `target/t50/t47-producer-readonly.json`. This supplements the fixtures without rerunning that Lab.

The CI contract fixture uses the same Core sender and `metadata:{kind:"ci",runId:<stable nonempty string>,attempt:<run attempt>,name:"PR #27",status:<passed|failed|cancelled|skipped|pending|unknown>}`. `runId` identifies the monitored remote run; producers must distinguish different runs and attempts and deduplicate their notifications. **T-50 has no live CI producer or CI watcher acceptance. T-49 supplies that integration later.**

## Validation and evidence

- Four focused Store/projection tests cover author trust, the actual Job UUID-attempt/systemdResult shape, all supported outcomes, exact reservation scope, duplicate event grouping, immutable history, restart, manual pasted-text isolation, safe legacy projection and index plans.
- Forty-two collaboration regressions pass, including a new actual Core peer_send→reservation→native start/steer→read projection test. Its native process is a scripted protocol fixture, with no paid model or live user session. `target/t50/peer-deliveries.json` contains the resulting normal/urgent snapshots and binding evidence.
- Typecheck, eleven collaboration UI tests and ten live-update tests pass. The UI checks all result labels/priorities, at most two groups plus remainder, expansion, unchanged authors/copy order, and no API reads on viewing.
- `web/tools/mailbox-notice-browser.mjs` renders those Core-produced peer snapshots plus explicit Job/CI fixtures. Light/dark × 1440/390px × 20px font checks pass with no overflow, at most two summary lines, keyboard expansion, no API calls or browser errors. Screenshots inspected: `target/t50/browser/light-1440-20px.png` and `dark-390-20px.png`; report and all four screenshots are retained in the same directory.
- Heavy commands use the shared two-slot gate; Cargo is `-j4`, serial tests, 4 GiB/zero swap; Node/browser are 3 GiB/zero swap with 2 GiB heap and deadlines. Chromium's short private TMPDIR mount is backed by this worktree's disk directory. Daily Core/UI/data and other retained Labs are untouched.

Independent review and exact-head CI are tracked on the existing T-50 task and delivery PR. No full local matrix or paid native acceptance is repeated for this slice.
