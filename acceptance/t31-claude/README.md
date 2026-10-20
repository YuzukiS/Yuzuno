# T-31 acceptance: images in local Claude conversations

`live.py` runs an isolated lab Core on port 4491 with its own data folder.
It uses this checkout's Core build and bridge (overriding the inherited
`YUZUNO_CLAUDE_BRIDGE`) and the web build in `target/t31c/web-dist`.

Claude runs as Haiku with the normal CLI login and manual permissions. The
lab approves only its own `python3 -c '... time.sleep(...)'` commands.

The script makes its own test images with Pillow. Each is either a short
code in large letters on a plain background, or a filled circle. They
contain nothing sensitive.

Every `start` and `stop` records a receipt in `evidence/lab-receipts.json`:
- the source HEAD and whether tracked files differed;
- the Core, bridge and web hashes;
- the Core's PID and start time;
- that this exact process exited, and that no bridge from this checkout was
  left running.

The daily Core is compared only by its listener and the digest of its
`web/dist`.

```
python3 acceptance/t31-claude/live.py start
python3 acceptance/t31-claude/live.py new      # two images with text, then one large image alone
python3 acceptance/t31-claude/live.py follow   # an image sent as a follow-up while Claude runs tools
python3 acceptance/t31-claude/live.py stop
```

## Limits, kept apart

**The official API** (vision docs, read 2026-10-15):
- The Claude API, used directly, takes up to 10 MB base64 per image. Amazon
  Bedrock and Google Cloud take 5 MB.
- Images may be up to 8000 px a side. Once a request holds more than 20
  images, the limit is 2000 px for every image in it.
- A request may be at most 32 MB, and that includes the resent history.
- Supported formats are JPEG, PNG, GIF and WebP.

**The installed CLI 2.1.280**, read from its own code:
- **New prompts are resized.** For an image in a typed or SDK prompt, the
  CLI scales it to at most 2000 px a side. It then recompresses anything
  over 512,000 bytes as JPEG. If that fails, the image becomes the text
  "[Image could not be processed: …]".
- **Follow-ups are not resized.** A message folded into a running turn
  keeps its image blocks exactly as sent.
- **Every request checks every image.** Before each request, each image in
  the whole conversation is checked against a 5 MiB base64 default. One
  oversized image would therefore fail every later request.

**Yuzuno's choice for this milestone:**
- Every image sent to Claude must be at most 2000 px a side and 512,000
  bytes. This follows the CLI's sizes for a new prompt and applies to
  follow-ups too.
- It is a verified implementation budget, not an API limit. The bytes need
  not match what the CLI itself would make.
- A larger image is sent as a copy that Core makes once, off the async
  workers, beside the original: `<id>.claude.png` if a PNG fits, else
  `<id>.claude.jpg`. The original stays what the conversation and its full
  preview show.
- The composer tells the user: "Large images are scaled or compressed when
  sent to Claude · originals are kept."
- The bridge receives only file references, never image data. It reads each
  file, checks it again, and encodes it at the SDK boundary.

## Results

All runs below used source HEAD `8fc86c0` with no changes to tracked files
(2026-10-15). Artifacts (sha256 prefix):

- Core `3cc12ff4f525ed59`
- bridge `f0182e052f401ec8`
- web `index.html` `4349828a12c5fe12`

The lab Core was PID 3023339. It was verified exited with no bridge left
running, and the daily Core's listener and `web/dist` digest were unchanged.

The first `new` run stopped at its last step. Its preview read-back asked
the image route for `thumb=1`, which the route rejects, so the script now
asks for `thumb=true`; the run below used the fixed script.

Later commits change that script, this README, comments, and the composer's
note on large images. Core and bridge behavior is unchanged, so these runs
were not repeated.

**Real Claude (Haiku):**

- **new** (`evidence/new.json`).
  - Two images with a question: the receipt was `accepted`, and the turn
    shows both images. Claude replied "K7Q4 is written in the first image;
    the second has a blue circle."
  - Reusing that message id with other images was refused ("同一消息编号不能提交不同的内容"),
    and the first message was recorded as sent once.
  - A 3000×1200 image alone: Core made one fitted copy
    (`….claude.png`, 2000×800). The turn shows the original. Claude replied
    "Z9M2 is written in the image."
  - All three previews read back through the image route.
- **follow** (`evidence/follow.json`). During the first of three sleeps, the
  follow-up "Also end your final sentence with the code written in this
  image." was sent with one image.
  - The receipt was first `queued`.
  - Claude then read it in the same turn, so the receipt became `accepted`.
    The item shows the image, with no delivery mark left.
  - Claude's final sentence ended with "P5X8", and the follow-up was
    recorded as sent once.

**Browser (isolated fixture, no Core).** `web/tools/image-input-browser.mjs`
ran in a scope with 3 GiB, no swap and 512 tasks. It passed all 9 checks
with no page errors. The Claude fixture now offers "Add images".

**Not run live:** an unknown or refused image follow-up. These take the same
receipt path as text, which T-21 checked live. The Core and bridge unit tests
cover refusals here.
