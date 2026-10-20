# T-27: import a Claude Code session saved on the Core host

**Existing Claude session** in the create dialog adds a Claude Code session
saved on the Core host as an Agent.

## What it does

- **List** (`GET /api/claude/sessions`): one bounded page, newest first.
  - Each session's title, folder, branch and last saved time are shown.
  - Optionally only one folder's sessions are listed.
  - By default only sessions a person started are listed, as terminal
    `/resume` does; SDK and script sessions can be included.
  - The list says which sessions are already an Agent.
- **Preview** (`POST /api/claude/sessions/preview`):
  - How many prompts Claude saved, and its newest six messages.
  - Images and sub-agents.
  - Whether the chain starts at a compaction, and whether the folder still
    exists.
  - `occupancy: "unknown"`: Claude Code keeps no lock on a session and the
    SDK reports no owner. Yuzuno never claims a session is free.
- **Import** (`POST /api/claude/sessions/import`): the session id, plus the
  name, Project (or none) and folder the user confirmed.
  - Claude's saved conversation becomes the Agent's turns, marked as sent
    outside Yuzuno.
  - The Agent is left disconnected. Nothing runs until the user sends.
  - A session already bound to a local Agent returns that Agent. This is
    checked again in the inserting transaction, so retries and concurrent
    imports return the same Agent.
- **Continue**: the user's first message resumes that same session through
  the existing send path. Its reconnect read adds only what was saved since.
  No saved prompt is sent again.

Reads go through the SDK's session readers only (`listSessions`,
`getSessionInfo`, `getSessionMessages`, `listSubagents`). They run in a bridge
that starts no query, so no hook runs and no session is written, resumed or
forked.

## Live lab

```sh
YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \
  python3 acceptance/t27-import/live.py <empty lab folder>
```

**Core:** one lab Core on port 4591 with its own data, never the daily one.

**Native sessions:** real Claude Code (`claude -p --model haiku`) creates the
lab's own sessions in `~/.t27-lab/<lab>/`:
- **S:** two prompts and one Bash `ls` call.
- **N:** one prompt.
- **M:** one prompt; its folder is then renamed.

No other session is imported. The unfiltered list is read once, for its count
and time only. In the browser, its first, unfiltered page is answered empty,
so screenshots hold only the lab's sessions.

**probe.mjs:** reads a session straight from the SDK, read only.

**browser.mjs:** drives the dialog in Chromium:
- imports N with a keyboard choice, a Project and the folder;
- shows S as already imported, dark and 390 px wide.

## Results

**Live lab `evidence-7debee8`** (Job 5bc2c3fc, 2026-10-17): **26 passed, 0 failed**.

- **Candidate:** 7debee8, 0 uncommitted. The Core binary sha256 is `1d3b06c9…`.
- **Gate:** the live lab ran only after Core, web and bridge tests and a dry browser pass in the same Job had all passed.
- **Claude Code:** 2.1.280, SDK 0.3.296.

| Check | Observed |
|---|---|
| Lab sessions | S `94dc796e…` (two prompts, Bash `ls`), N, M; print-mode `--resume` kept S's id |
| List | Unfiltered first page bounded (20, more follow, 0.28 s; count and time only). `dir=app/`: S and N, unbound, with their folder. A page of one says the next offset; M (another folder) is absent |
| Default list | `claude -p` sessions count as programmatic: listed only with the scripts filter |
| Preview | S: 2 prompts, newest messages user/assistant, model `claude-haiku-4-5-20251001`, `occupancy: "unknown"` |
| Refused (400, nothing created) | Unknown id; malformed id; another folder than S's; M, whose folder is gone. M's preview says `folderExists: false` |
| Import | One Agent: S's session, lab Project, `app/`, disconnected/offline. Turns `native-<uuid>` for S's two prompts, completed, origin outside. The Bash call is a completed `claudeToolUse` with its output |
| Read only | S's file is the same size, mtime and message count before and after listing, previewing and importing |
| Dedup | Again with another name, and twice at once: the same Agent; 1 Agent in total. The list and preview name it |
| Browser | N chosen with the keyboard (Enter on its row). Its folder and the chosen Project are shown, and adding it makes one disconnected Agent in that Project; N's file is unchanged. S shows "Already in your workspace" / "Open agent", 390 px wide with no overflow |
| Continue S | The turn completed in S. S gained exactly one prompt, whose uuid is the turn's id; the saved prompts were not sent again. The Agent's turns are S's two, then the new one. The reply named the code word from the imported history (an observation, not a check) |
| Daily | 4317 listener (pid 1880103), daily web/dist and `~/.claude/settings.json` hashes unchanged |

The 7debee8 screenshots showed two problems:
- the scripts filter's checkbox sat on its own line;
- the "dark" screenshot was light, because the app's own appearance setting decides the theme.

**Fix, 4cfed84** (CSS and lab scripts only; `core/` and `runtimes/` are identical to 7debee8): Job 74e37382 re-ran the import UI test (4/4) and the dry browser pass (no model) with new assertions: a one-line checkbox row (13 px), and `data-theme="dark"` actually applied in the narrow view. Both pass. The paid live path was not repeated.
