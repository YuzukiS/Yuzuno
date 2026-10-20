# T-65 acceptance: several follow-ups while Claude works

`live.py` runs an isolated lab Core on port 4493 with its own data folder. It
uses this checkout's Core build and bridge (overriding the inherited
`YUZUNO_CLAUDE_BRIDGE`) and the web build in `target/t65/web-dist`.

Claude runs as Haiku with the normal CLI login and manual permissions. The lab
approves only its own `python3 -c '... time.sleep(...)'` commands.

Every `start` and `stop` records a receipt in `evidence/lab-receipts.json`:
- the source HEAD and whether tracked files differed;
- the Core, bridge and web hashes;
- the Core's PID and start time;
- that the process exited, and that no bridge from this checkout was left
  running.

The daily Core is compared only by its listener and its `web/dist` digest.

```
python3 acceptance/t65/live.py start
python3 acceptance/t65/live.py several   # two follow-ups during a multi-step turn
python3 acceptance/t65/live.py next      # two follow-ups right after a tool-free prompt
python3 acceptance/t65/live.py stop
```

## The bug (user report, 2026-10-15)

A Claude follow-up queued at Claude held back every later message:
- Core's send gate treated `queued` like a send whose outcome is unknown.
- The bridge allowed only one unconfirmed follow-up at a time.

The refused next message was shown as "Delivery unconfirmed · draft kept",
although it was refused before anything was sent.

In the user's own session, the queued follow-up became `accepted` when its turn
ended normally: the result's `user_message_uuids` named it. No receipt was
edited.

## What the SDK (0.3.296) says

- A turn's result lists in `user_message_uuids` every user message the turn
  consumed: members of a batch merged into the turn, then follow-ups folded in
  between tool rounds. The list holds at most 64 entries.
- A turn started by a typed prompt usually names a folded follow-up only on its
  result. So until then the follow-up is sent but not confirmed; nothing
  shows it was "not read".
- An interrupt receipt lists the messages still queued (`still_queued`).

## What changed

- **Core gate.** Only a send whose outcome is unknown (`sending`, `uncertain`)
  holds back the next message. A `queued` follow-up has been sent and holds
  nothing back.
- **Refusals before sending.** Any refusal before Core records the send comes
  back as `message_not_submitted`. This includes a follow-up to a turn that has
  ended. The client keeps the draft, drops its old message id and turn, and
  shows no delivery to confirm.
- **Bridge, several waiting.** Several follow-ups may wait at once, in order,
  each confirmed only by its own uuid.
- **Bridge, moving a follow-up on.** A follow-up runs as the next turn only on
  evidence. Either the result's complete list leaves it out (a list at the
  64-entry cap may be cut short), or the interrupt receipt names it in
  `still_queued`, before or after the result. Several such follow-ups run as
  one turn, which the first one starts and the rest join.
- **Bridge, without evidence.** A follow-up claims no turn. The next native turn
  is held until a frame names the follow-up, which makes that turn the
  follow-up's.
- **Wording.** The UI now says "Sent · waiting for Claude to confirm" and "Not
  confirmed by Claude · not sent again" instead of "not read".
- **Hide.** A preview that was refused, or whose delivery is unknown, can be
  hidden. Hiding is remembered locally. It does not mark the message sent,
  keeps the receipt and the draft's message id, and sends nothing.

## Results

All runs below used source HEAD `e8252ef` with no changes to tracked files
(2026-10-15). Artifacts (sha256 prefix):
- Core `85b6f7bb35d56958` (built from e48b063; e8252ef changes only the bridge,
  its test and README)
- bridge `9901840e023078cd`
- web `index.html` `6bed1f74c0769d60`

The lab Core was PID 3286697. It was verified exited with no bridge left
running, and the daily Core was unchanged.

**Real Claude (Haiku):**

- **several** (`evidence/several.json`). During the first of three sleeps:
  - Two follow-ups were sent one after the other. Both receipts were `queued`;
    the second was not held back.
  - A repeated click returned the same receipt.
  - Reusing the first id with changed text returned HTTP 400 with code
    `message_not_submitted`. No receipt was made.
  - Claude read both in that turn, so both receipts became `accepted` there.
    Its final sentence used both words: "…like a banana and kiwi arrangement".
  - Each follow-up was recorded as sent once.
- **next** (`evidence/next.json`). Two follow-ups were sent right after a
  tool-free prompt.
  - The prompt's turn ended before Claude took them.
  - Both ran next as one turn, and Claude confirmed both there. It answered
    "second" and "third".

**After R1 (`ceb1a1b`).** R1 found one P2: a turn adopted from one waiting
follow-up could miss another one it later named. The fix changes only the
bridge, so both scenarios ran once more, on HEAD `ceb1a1b` with a clean tree
(lab PID 3327900, exited, no bridge left, daily Core unchanged):
- **several:** passed as before. Both follow-ups were `queued`, then both were
  confirmed in the same turn. The changed reuse of an id was
  `message_not_submitted`, and each was sent once.
- **next:** delivery passed. Both follow-ups ran next as one turn, and Claude
  confirmed both there.
  - The script's reply check failed. The two follow-ups each said "Reply with
    exactly: …", and run together those instructions conflict. Haiku answered
    only "third"; the run on `e8252ef` had answered both.
  - The script now asks each follow-up to include its word instead. It was not
    rerun.

**Not run live:** an interrupt with follow-ups still queued, a result without a
complete list, and a list at the 64-entry cap. The bridge unit tests cover
these.
