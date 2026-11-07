# Rewind a conversation

The **Rewind** action at the right of a reply's footer previews going back to
before that turn. The selected turn and all later turns leave the native
conversation; earlier turns stay. Confirm the preview to proceed. The original
text is added to that Agent's draft when the request succeeds or its outcome
is unknown. A definite refusal adds nothing. Edit it and send when ready;
nothing is sent automatically. Reattach any original images.

Finish the current turn and pending answers first. A changed conversation,
restarted connection or expired preview requires a new preview. A preview
lasts 10 minutes. Core keeps the native history it read for the preview until
then, and frees it on its own once the preview expires: no further request or
preview is needed. Rewind does not
undo files, shell commands, submitted Jobs, PRs, approvals or other external
effects. Their execution records remain, as does an archive of the removed
native history and Core's prior view, linked by the rewind attempt ID.

## Current capabilities

| Runtime | Local | SSH |
| --- | --- | --- |
| Codex conversation | `thread/revert`, persistent paginated sessions, verified on 0.162.1; old/temporary sessions are unavailable | Not yet verified; disabled |
| Codex files | No file restore through conversation rewind | Unavailable |
| Claude conversation | Unavailable in the current integration (CLI 2.1.280 / SDK 0.3.296) | Unavailable |
| Claude files | Existing native checkpoint preview and restore | Not supported by the current file-checkpoint integration |
| OpenCode conversation and files | OpenCode 2.x's own revert (`POST /api/session/:id/revert/stage`, then `…/revert/commit`), together; see [OpenCode](#opencode) | Unavailable |

Claude's file option opens the existing file-checkpoint preview. It restores
only files covered by Claude Code's checkpoint and leaves conversation history
unchanged. A native user-message UUID is required; a Yuzuno turn ID is not a
checkpoint ID. The preview identifies missing checkpoints and concurrent file
changes. The final result distinguishes restored, partial, failed and
unconfirmed outcomes. There is no combined conversation-and-files operation in
these verified runtime versions.

## When a result is not confirmed

Use **Check outcome** or reconnect. Core checks the same native session against
the exact expected history prefix; it does not resend the rewind. New messages
are blocked while an attempt is unresolved. An unchanged or different native
history is not proof that a delayed operation cannot still happen, so it stays
unconfirmed. Reconnection still reconciles ordinary state. If checking cannot
resolve it, **Keep current history** explicitly accepts the current native
history and releases the input block. Core first verifies the local runtime is
idle, waits for it to exit, reconnects, and reads the durable history. It never
resends the rewind or a prompt. A different history is recorded as **resolved**,
not a successful rewind; the original attempt and archive remain. A native
refusal preserves the existing history.

The preview loads history only when opened, with limits of 1,000 turns and a
32 MiB archive. Exceeding either limit refuses the operation. Rendering reply
footers does not scan native histories or file checkpoints.

## OpenCode

On an OpenCode Agent, **Rewind** is OpenCode's own revert. The selected turn and
later turns leave the conversation; OpenCode deletes them from its session as
soon as the files are back. Each file that a later step of OpenCode's changed
goes back as that step's snapshot holds it, from the first step after the turn.
It is not a conversation-only rewind.

The preview lists each such file: what it is now and what it becomes. A change
made to it since, by you or another Agent, is overwritten. OpenCode keeps its
snapshots in Core's own data folder for the Agent; Core reads each file from
there. Before it asks OpenCode, Core keeps a copy of each file in its own data
folder, under `opencode/<agent>/revert/<attempt>`, not in the Agent's folder.
It keeps the copies of the newest three reverts whose outcome is known,
removing older ones when it makes a new copy; a revert not yet confirmed keeps
its copy. Files can be sent back only when Core can tell exactly what OpenCode
will write:

- OpenCode was started by Core from its native executable, not a script or
  wrapper, and Core's environment sets no Git variables;
- each path is plain, not `.gitattributes`, and Git would not convert the file
  on checkout;
- every step after the turn has a snapshot and a list of its files (OpenCode
  would pass over a step without one in silence);
- at most 200 files, 8 MiB each and 32 MiB in all.

Otherwise a revert with files is refused before anything is asked. A turn with
no file to send back needs none of this.

A revert is refused while anything runs or waits for an answer, while an
earlier rewind, compaction or message is unconfirmed, or while the session
already holds a revert (one another client staged included). Confirming reads
everything again and refuses on any change; then OpenCode is asked once to
stage the revert.

- **Reverted:** OpenCode staged the revert. Each file is reported on its own:
  as the snapshot holds it, still as before, or neither. Nothing is overwritten
  to fix it. Then Core asks OpenCode to commit it, which deletes the messages;
  if that answer is lost, OpenCode commits it itself before its next prompt or
  compaction. The original text is added to the draft.
- **Not reverted:** OpenCode refused before it changed any file (busy, no such
  session, folder or message, a request it could not read), or its request
  ended without a revert and a new read finds the messages and every file as
  before. No turn leaves and no text is added.
- **Not yet confirmed:** new messages, commands, `/compact` and another revert
  wait. A restore OpenCode could not finish (it answers an error) may have sent
  some files back: each file is listed as it is now, Core's copy is named, and
  nothing is put back on its own. **Check outcome** settles what can be told:
  - a revert OpenCode staged but Core could not record is recorded;
  - if Core stopped before the request went out, nothing was asked, and it is
    not reverted (the copies stay where they were kept);
  - a request with no answer kept is reverted if OpenCode's session now holds
    the revert, which OpenCode keeps only once its files are sent back, or if
    its messages from the turn on are gone, committed already;
  - one whose session holds none and still has those messages is read again,
    and is not reverted only if the messages and every file are as before.
    Otherwise it stays unconfirmed: OpenCode may have changed files before it
    stopped.

  There is no **Keep current history** for OpenCode, and the revert is never
  asked for again.

A revert another client of the same OpenCode commits deletes those messages
too: their turns leave this Agent's conversation as well.

OpenCode's undo of a staged revert is not offered: Core commits each revert
once its files are checked.

## Protocol evidence

The installed Codex 0.162.1 schema and an isolated real app-server probe confirm
`thread/revert({threadId,beforeTurnId})`; `thread/rollback` is no longer a method.
The response contains metadata, not the retained turns. Core verifies paginated
history afterwards, drains queued native events, persists the new projection
and preserves the archive before allowing more input. See the official
[app-server documentation](https://learn.chatgpt.com/docs/app-server).

For Claude, the installed SDK's `Query` methods and `SDKControlRequestInner`
provide `rewindFiles` / `rewind_files`, but no conversation-rewind control.
Session mutation exports provide fork, delete, rename and tag, not in-place
conversation truncation. `resumeSessionAt` selects a prefix when resuming;
`resumeDropsTurn` validates a discarded turn. In an isolated test, initializing
that resume without a new prompt did not persist the prefix: the next plain
resume still read both original turns. These options are not presented as a
completed rewind, and Core does not edit Claude's session files or send a hidden
prompt. See [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

Reproducible isolated probes and focused checks are in
[`acceptance/t114-rewind`](../acceptance/t114-rewind). Model responses in the
conversation probes are deterministic loopback fixtures; the native CLI/SDK
and Core processes are real. No account credentials or daily Agent sessions
are used.
