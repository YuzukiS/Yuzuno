# T-30 fix: a fresh Claude Agent's MCP service status

A new Claude Agent's MCP status read as "The Claude session changed during the
read" until its first turn. The T-29 live lab found this.

## Cause

- Claude Code names a new session on a `SessionStart` hook, before any turn.
- The bridge keeps that id.
- Core names the Agent's session only from a turn's events, so it has none yet.
- Main kept a status reply only when the two ids were equal.

## Fix

In `core/src/claude_mcp.rs`, until Core names a session, the connection's own
session is the Agent's. Other sessions are still refused by:
- the generation fence;
- the bridge's own check across a read;
- once Core has named a session, the requirement that a reply be for it.

## Live lab

```sh
YUZUNO_LAB_OLD_CORE=<Core with main's MCP read> YUZUNO_LAB_CORE=<candidate> \
  python3 acceptance/t30-mcp-session/live.py <empty lab folder>
```

- **Cores:** two lab Cores on ports 4581 and 4582, each with its own data;
  never the daily Core.
- **Claude Code:** real, working in `~/.t30-lab/<lab>/<old|new>`.
- **probe.mjs:** reads Claude Code's own MCP servers for the folder straight
  from the SDK, with no prompt.
- **Model calls:** none. The only turn is `/context`, which Claude Code
  answers itself.

## Results

Evidence run: `evidence-908dbd0`, Job 08c503cb, 2026-10-17. Result: **6 passed, 0 failed**.

- **Candidate:** at 908dbd0 with 0 uncommitted files; Core binary sha256 `fc77204a…`.
- **Old Core:** T-29's frozen build `82874be1…`, built from 6adac43. Its
  `claude_mcp.rs` and `mcp-status.mjs` are byte-identical to main 0c5c332,
  which the build script checks.

| Check | Observed |
|---|---|
| Old Core, fresh Agent | Core `claudeSessionId` null → `failed` / `changed` (the false report) |
| New Core, fresh Agent | Core `claudeSessionId` null → `ready` / `observed` |
| Servers | `claude-design`, `claude.ai Claude Docs`, `plugin:expo:expo`, `plugin:yuzuno:yuzuno-peers` (Claude Code's own) plus Core's `yuzuno` |
| After `/context` | Core named `dd0b319b…`; status `ready` with `sessionId` `dd0b319b…` |
| After a lab Core restart | `unavailable` / `not_connected` |
| Daily Core | 4317 listener, daily web/dist and `~/.claude/settings.json` unchanged |
