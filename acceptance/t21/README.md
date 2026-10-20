# T-21 acceptance: follow-ups while Claude works

`live.py` runs an isolated lab Core on port 4483 with its own data folder.
It uses this checkout's Core build and bridge (overriding the inherited
`YUZUNO_CLAUDE_BRIDGE`) and the web build in `target/t21/web-dist`.

Claude runs as Haiku with the normal CLI login and manual permissions. The
lab approves only its own `python3 -c '... time.sleep(...)'` commands.

Every `start` and `stop` records a receipt in `evidence/lab-receipts.json`:
- the source HEAD and whether tracked files differed;
- the Core, bridge and web hashes;
- the Core's PID and start time;
- that this exact process exited, and that no bridge from this checkout was
  left running.

The daily Core is compared only by its listener and the digest of its
`web/dist`.

```
python3 acceptance/t21/live.py start
python3 acceptance/t21/live.py fold      # follow-up during three sequential tool calls
python3 acceptance/t21/live.py next      # follow-up right after a tool-free prompt
python3 acceptance/t21/live.py unknown   # Core stops while a follow-up is queued, then reconnects
python3 acceptance/t21/live.py stop
```

## What Claude does with a message sent while it works (CLI 2.1.280)

From the CLI's own schema descriptions:

- A message sent mid-turn with the default priority is "folded into the
  running turn between tool rounds, once taken off the queue". The turn's
  result then lists its uuid in `user_message_uuids`.
- A turn started by a typed prompt names the folded message only on its
  result, not on later replies.
- A message still queued when the turn ends runs as the next turn, which
  names it like any prompt.
- `priority: 'now'` stops the running turn instead. Yuzuno never uses it.

## What the user sees

- **Sending.** The composer stays open while your turn runs ("Send while
  working"). Each follow-up carries its own `clientMessageId`, so a repeated
  click returns the same receipt.
- **Queued.** Once the bridge has it queued at Claude, it appears in the turn
  where you sent it, marked "Sent to Claude · not read yet".
- **Read.** When Claude names it, the mark goes away.
- **Next turn.** If the turn ended first, the follow-up moves to its own next
  turn and is marked read there once Claude names it.
- **Unknown.** If the connection ends first, it is marked "Not confirmed read
  · not sent again". This holds up no later message.
- **Refused.** If the bridge had already ended the turn, the follow-up is
  refused and your draft is kept.
- **Not offered.** While only a turn of Claude's own is running, there is no
  turn of yours to add to, so a follow-up is not offered.

## Results

All runs below used source HEAD `3a1f9ce` with no changes to tracked files
(2026-10-14). Later commits change this README and, for R1's finding, how
Core shows a follow-up whose connection ended just after Claude took it.
That fix has a unit test, not a live rerun. Artifacts (sha256 prefix):

- Core `59832eede50c14ee`
- bridge `6e6d880d7041623d`
- web `index.html` `7383d779f92eefeb`

Each lab Core was this checkout's process, and each was verified exited with
no bridge left running: PID 1334247, then PID 1338710 after the `unknown`
case restarted it. The daily Core's listener and `web/dist` digest were
unchanged.

**Real Claude (Haiku):**

- **fold** (`evidence/fold.json`). The follow-up was sent during the second of
  three sleeps.
  - The first receipt was `queued`. A repeated click with the same id got the
    same receipt and one `message/requested` row.
  - Claude named it in the same turn, so the receipt became `accepted` there.
    It sits between the turn's two replies, with no delivery mark left.
  - The final reply ended with "banana", as the follow-up asked.
- **next** (`evidence/next.json`). The follow-up was sent right after a
  tool-free prompt. It was `queued`, then ran as its own next turn, which
  named it: `accepted` in that turn. The prompt's turn kept "first", the
  follow-up's turn has "second".
- **unknown** (`evidence/unknown.json`). Core stopped while the follow-up was
  queued during a sleep, then reconnected.
  - The receipt became `unknown` with its reason, and the item in the turn is
    marked unknown.
  - The turn became `outcomeUnknown`.
  - There was still one `message/requested` row, and the session reconnected.

**Not run live:** an interrupt that leaves a follow-up in `still_queued`, and
a follow-up refused because the turn had just ended. The bridge and Core unit
tests cover these.

**Local tests on `3a1f9ce`, capped:**

- bridge: 43/43;
- Core: the full `cargo test --locked -- --test-threads=1`;
- web: typecheck, build, and the CI web script. In the full run, 32 of its
  34 files passed, including `ui.test.mjs` (62 tests).

The other two, `recovery-ui.test.mjs` and `session-import-ui.test.mjs`,
failed some local runs at a load average near 18. Their steps wait a fixed
25 ms, and neither file's code is changed here. CI on the exact HEAD is the
check that counts.
