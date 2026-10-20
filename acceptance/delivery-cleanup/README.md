# T-80: terminal delivery and CI cleanup

The change is source-only until a Core containing it is installed. The daily Core and daily web/dist are not replaced by this validation.

Delivery ends on task done/cancelled/archive, an observed PR merge, or explicit stop. Its first terminal state, reason and timestamp are durable, including across reopening the task and restarting Core. Stopping automation does not cancel a reviewer or a GitHub Actions run. Ready-for-merge, waiting-for-fixes and CI failure remain nonterminal.

Each CI subscription retains separate manual/delivery-round interests keyed by the original request receipt. Flow cleanup releases its own interests; task/PR cleanup releases matching candidate interests. Watch capacity is still capped at 50 distinct active targets. Multiple Agents/tasks share remote observations without sharing ownership. A specific run subscription can finish post-merge verification after task closure, closing after its latest freshly observed attempt has a retained completion notification (or expiry/explicit stop). Historical reports, run attempts, mailbox receipts and interest closure reasons are retained. Old request replay never renews a watch; a new request explicitly renews it. Legacy subscription ownership is reconstructed from request receipts; unknown provenance is treated conservatively as manual.

## Validation

All checks use an isolated worktree/data/build directory via Yuzuno Jobs and `/home/developer/yuzuno-next/target/heavy-slot.sh`, with 2 CPU, 4096 MiB RAM, no swap, and collector headroom. `validate.sh` writes under `target/t80`, never web/dist.

- Job `12a1f629-f95f-431c-8d63-c0cca98f43c5`, commit `f4fde88b1542fb10b69ba5a7c5996a2d8886578c`: failed Rust test compilation (`E0624`, two CI store methods were module-private); 3 UI tests, typecheck and isolated Vite build passed. Logs retained in `target/t80/check-1`.
- Job `91b711da-8cb3-4a48-bcc3-6fdb5a9c21c1`, commit `3e9e64e7c412982e8f56f033b85fd5100f2336b7`: 13 delivery, 12 CI, 41 collaboration tests passed; 4 UI tests, typecheck and isolated Vite build passed. Peak memory 2,437,206,016 bytes. Logs retained in `target/t80/check-2`.
- Tests cover task terminal states, idempotent stop after task closure, unchanged terminal state after reopening/restart, retained running review, lost CI replies and stop/setup race, legacy/manual/automatic shared subscription IDs, other Agent/task interests, 50-watch cap reclamation, post-merge run completion, new same-SHA attempts and old request replay. Existing failure/fix/readiness tests continue to pass.
- The isolated runtime test runs the actual result transaction, delivery worker, CI service and notifier. GitHub and native review source preparation use local fixtures; it makes no paid model call, no external workflow and no daily-data mutation. Store tests use temporary SQLite stores. UI tests use JSDOM; they do not operate a daily window.

## Manual acceptance on an isolated Core with this change

1. Enable a fixed task/PR delivery and submit its candidate. Add a manual CI subscription for the same Agent/task/PR; the subscription ID may be shared.
2. Stop the delivery: its state is stopped, its original evidence remains, and the manual CI interest stays active. Explicit CI unsubscribe stops all interests for that subscription.
3. On another flow, close or archive its task, then call delivery_stop twice. The original terminal outcome and timestamp remain unchanged; the stop is accepted. Reopen the task or restart the isolated Core: it does not resume the closed flow.
4. Subscribe two tasks/Agents to one candidate; close just one task. Only its interest closes. Fill the 50-watch quota with candidate interests, close their task, then subscribe a new target: the quota is available again.
5. Keep an explicit main run subscription active while marking its task done. Its eventual completion still creates one mail and then closes that interest. Use a new requestId to subscribe to a same-SHA rerun; the new attempt creates one new mail. Replaying an old requestId must not resume an inactive subscription.
6. Read CI subscription history and the task's delivery panel: closure reasons are visible, retained evidence still opens, and terminal flows offer no next-candidate action. CI success/failed/fix-wait states alone do not close an open delivery.

Final exact-head CI and independent review are recorded on T-80 and its PR, with the original dispatch ID. Lead owns merge and completion; this change adds no automatic merge/deployment authority.

## Independent review round 1

Review `8dcdd78d-ab7d-47c5-817f-6ab700265904` inspected all 15 complete diffs at `f6144684984fe9e0ff15b63b82bdc3da5e82d8fe`, with zero unresolved/failed source requests. It requested one P2 fix: converting both renewed-interest and observation timestamps to integer seconds could accept old terminal evidence in the same second and close the renewed run subscription too early.

The fix compares full RFC3339 timestamps and requires a strictly later observation; malformed or indistinguishable timestamps retain monitoring. `renewal_in_same_second_cannot_close_on_cached_terminal_evidence` pins an old observation and a fractional renewal time within one second, verifies monitoring remains active, then supplies a newer attempt/observation and verifies exactly one additional completion mail. It uses explicit fixture times without sleeping. This does not restart a reviewer or reset the original two-round cap.

The final UI-only Job `1df7ad45-3b87-4ad0-94ac-a34248218af8` at `f614468` passed both CI UI tests, typecheck and isolated Vite build; logs are in `target/t80/check-3` (peak memory 562,114,560 bytes). The round-1 fix changes only Core freshness logic, its tests and this record; UI source/build is unchanged.
