# T-16: Core backlog note

When the conversation seems not to update, the status bar can say whether Core itself is behind. It does so only when Core is actually behind.

## What is measured

For each Agent connection, Core counts every native event its transport has read but its consumer has not finished applying. It also records how long the oldest of those has waited.
- The count includes the event being applied (waiting for the Agent's ownership lock or the database).
- It also includes one waiting for room in the full queue.
- Arrival times are kept in memory per connection, on Core's monotonic clock (`core/src/backlog.rs`). There are no database writes and no event content.
- Nothing about the queue changes: its bound (256), order, EventBarrier, storage and retries are untouched.
- EventBarrier markers share the queue but are never counted.

`GET /api/backlog` returns `{observedAt, agents: {<id>: {generation, pending, oldestMs}}}`. It lists only Agents whose current connection Core is applying events for. A missing Agent is **unknown**, not zero: not connected, connection closing, or replaced by a newer generation. A closing connection keeps its count, because a shutdown that fails leaves the same connection open. An entry is dropped only once no connection of its generation remains.

## Limits

It reports only what Core itself holds:
- When the queue is full, Core stops reading. Anything still in the runtime's output pipe, the SDK, the network or the browser is invisible.
- Model thinking, long tools and quiet periods are not lag and are never shown.
- Nothing is interrupted, stopped or restarted.

## The note

`web/src/CoreBacklog.tsx` sits in the status bar after the live-updates status. While the window is visible and live updates are open, it reads the route every 5 s, and at once when the window becomes visible again.

**Core is catching up on output; status may lag** appears when an Agent's oldest unapplied event has waited **5 s or more in two reads in a row**. It goes away at the first read below that. Its details list each Agent that is behind, with its event count, the oldest wait and the observation time.

The note is cleared instead of showing anything stale when:
- a read fails;
- the Agent has no connection;
- live updates drop.

Core's own status stays as it is. An older Core without the route answers with its web app's page (or 404). It is then asked once and not again. A server error or a network failure is only unknown for now, and the next read tries again.

## Threshold sample

`cargo test --lib backlog_sample -- --ignored --nocapture --test-threads=1` drives a live Codex connection (scripted runtime, debug build, nothing blocked) and records the worst backlog Core reached:

| Burst | Events | Most pending | Oldest wait | Caught up in |
|---|---|---|---|---|
| 500 deltas | 500 | 258 | 67 ms | 122 ms |
| 5,000 deltas | 5,000 | 258 | 170 ms | 1.7 s |
| 50 Turns (start, 20 deltas, end) | 1,100 | 258 | 171 ms | 0.5 s |
| 200 Turns | 4,400 | 258 | 310 ms | 2.9 s |

- **Most pending** is 258: the queue (256), the event being applied, and the one waiting for room.
- **Oldest wait** stays under about 0.3 s even when catching up takes seconds.
- The 5 s threshold over two reads is therefore more than 15× the worst normal case, so bursts never show. When application itself slows down (lock or database contention), the wait grows with the time each event takes, and the note appears.

## Checks

- **Core** (`core/src/backlog.rs` tests):
  - an event counts from arrival until applied, including while it waits for the Agent's lock with the queue empty;
  - a burst while held, then catching up;
  - one Agent's backlog is independent of another's;
  - `/api/backlog` answers over HTTP while consumption lags;
  - an update barrier still waits behind earlier events and is not counted;
  - a runtime that ends makes the Agent unknown, and a reconnect starts a new generation at zero;
  - the same checks on the Claude bridge path.
- **Web:**
  - `web/tools/core-backlog.test.mjs` covers the streak rule;
  - `web/tools/core-backlog-ui.test.mjs` runs the real app on the connection fixture. It covers a spike with no note, the note with details and its clearing, failed reads, a missing Agent and lost live updates as unknown, and an older Core asked once.
