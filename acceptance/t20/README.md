# T-20 acceptance: Claude's own turns after a background task

`live.py` runs an isolated lab Core on port 4483 with its own data folder,
this checkout's Core build and bridge, and the web build in
`target/t20/web-dist`. A shell inside a Yuzuno session inherits
`YUZUNO_CLAUDE_BRIDGE` (the daily release's bridge); `live.py` sets it to this
checkout's bridge. Every `start`/`stop` records a receipt in
`evidence/lab-receipts-<lab>.json`:

- the source HEAD and whether tracked files differed;
- sha256 of the Core binary, the bridge and the web build;
- the Core's PID and start time;
- at stop, that this exact process exited and that no bridge from this
  checkout is left running.

Two labs:

- **Real (`lab/`):** Claude Haiku with the normal CLI login, manual
  permissions. The lab approves only its own shell commands.
  ```
  python3 acceptance/t20/live.py start
  python3 acceptance/t20/live.py background              # a 20 s background shell; its end makes Claude continue
  python3 acceptance/t20/live.py restart                 # leave a 600 s shell running, restart Core, send again
  python3 acceptance/t20/live.py probe --slash --interrupt   # /cost, then an interrupted foreground tool
  node acceptance/t20/ui.mjs                             # read-only Chromium check, light and dark
  python3 acceptance/t20/live.py stop
  ```
- **Controlled (`lab-fake/`):** the real Core, bridge and web.
  `fake-node.sh` starts the bridge with `fake-sdk.mjs` in place of the
  Claude Agent SDK. It answers each prompt without a prompt uuid or origin,
  like a producer that reports neither, so nothing can match the prompt to
  its result. After the Close step, `stuck-ui.mjs` switches it to stamped
  replies.
  ```
  python3 acceptance/t20/live.py start --fake
  python3 acceptance/t20/live.py stuck --fake            # runs stuck-ui.mjs in Chromium
  python3 acceptance/t20/live.py stop --fake
  ```

The daily Core is not read or written. Only its listener (`ss`) and the
digest of `web/dist` are compared before and after each lab.

## What Claude reports (CLI 2.1.280, SDK 0.3.296)

- `init.capabilities`: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`,
  `msg_lifecycle_v1`, `mcp_read_resource_v1`, `mcp_tool_ui_meta_v1`. The
  SDK documents the first two (and `queued_notifications`). None promises
  `user_message_uuid`. `msg_lifecycle_v1` is real, but its frames
  (`command_lifecycle`) are not in the public types, so attribution does
  not rely on it.
- **Prompt turns:** the uuid was on the first model reply and on the result,
  including an interrupted turn's `error_during_execution` result. A local
  command (`/cost`) replied without it; only its result carried it. So a
  missing uuid is not evidence that a turn is not the prompt's.
- **Claude's own turns** (a background shell's notice): no uuid; the result
  has `origin: {kind: "task-notification"}`. `queued_turn_count` was 0 even
  on the notice result that ran while the prompt was queued, so it is not
  used.
- The SDK says uuids are absent from older producers, and no capability
  marks a producer that has them. A producer that reports neither uuid nor
  origin is reproduced only in the controlled lab.

## Results

Recorded per run, with the build they ran on; see the receipts. Earlier
builds' results are kept separately and do not stand for the final
candidate.

### Earlier builds (2026-10-14, before R1)

- **Daily 4926c08 bridge.** The first lab run used the daily bridge by
  mistake. The continuation after the shell finished came with
  `turnId: null` and was not shown (`evidence/before-old-bridge.png`).
- **b1f91f5 and pre-rebase builds.** Background, restart, `/cost` and
  interrupt cases passed. The interrupt result was stamped (journal rows
  272–289 in `evidence/journal-reworked-bridge.txt`).
- **1df8be6 (rebased, R1 candidate).** Background, restart, `/cost` and the
  UI check passed again. The interrupt case was **not** rerun on this build.

### Final candidate: runs on fe4881c (2026-10-14)

All runs below used source HEAD `fe4881c` with no changes to tracked files.
The only later commit changes this README. Artifacts (sha256 prefix):

- Core `ac2c7c485c925449`
- bridge `eb2bdf1b1fd6ebfe`
- web `index.html` `cf96177e70154657`

Every lab Core was this checkout's process (PID and start time recorded),
and each was verified exited with no bridge left running:

- `lab-fake`: Core PID 982524;
- `lab`: Core PID 983667, then PID 985257 after the restart case.

**Controlled (`stuck --fake`, `evidence/stuck-ui.json`):**

1. The fake SDK named no prompt. The reply was shown apart as "Claude output
   not matched to a message", while the prompt's turn kept running.
2. An acknowledged interrupt (`still_queued: []`) did not end the turn.
3. The Close dialog said what happens without a confirmed stop. Close ended
   the connection after the stop wait.
4. The prompt's turn became `outcomeUnknown`, with a readable reason in the
   turn. The session was kept.
5. The one bridge process of that connection exited (PID and start time
   checked).
6. Reopen resumed the same session in a new bridge process. With replies now
   stamped, the next message was answered in its own turn. Nothing was sent
   again, and there were no page errors.

**Real Claude (`lab`):**

- **background.** The prompt's turn kept its own reply. The continuation
  streamed as Claude's own turn, was seen `working`, and has origin
  `task-notification` (`evidence/background.json`).
- **restart.** The stopped shell's empty notice turn added no turn. The prompt
  got `t20-resumed` in its own turn, and earlier turns were unchanged
  (`evidence/restart.json`).
- **probe, on a fresh agent.**
  - `/cost`'s unmarked reply went to its own turn.
  - The interrupted foreground tool ended its own turn as `interrupted`
    (`evidence/probe.json`).
  - On the long-lived lab agent, Haiku first answered without starting the
    tool. That is model behaviour; the probe then used a fresh agent.
- **ui.** Light and dark: each native turn is labelled with what started it,
  prompt turns show only their own replies, and there were no page errors
  and no writes besides the read receipt (`evidence/ui.json`).

The daily Core's listener and `web/dist` digest were unchanged across every
lab. T-12's update drain was not run end to end. Its `status` contract is
covered only by the controlled bridge test.

### After merging main eb8656d (T-33 composer, front end only)

The merge `82b67e4` changes no Core or bridge file against fe4881c. The Core
binary hash is unchanged (`ac2c7c485c925449`), as is the bridge
(`eb2bdf1b1fd6ebfe`); the web build is new (`index.html` `81d23ba755b5c582`).
`799cb82` drives T-33's composer by its `[data-composer-input]` hook. On
`799cb82` (no tracked changes):

- `stuck --fake` passed every step again through the new composer
  (lab-fake Core PID 1013276).
- `ui.mjs` passed in light and dark (lab Core PID 1015209).
- Both Cores were verified exited with no bridge left.

The real-Claude cases above exercise only the Core and bridge, which are
unchanged, so they were not repeated.
