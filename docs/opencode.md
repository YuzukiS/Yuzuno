# OpenCode Agents (experimental)

Core can run an Agent on [OpenCode](https://github.com/anomalyco/opencode)
1.19.3, talking to OpenCode's own server (`opencode serve`) on loopback. This
is off by default. A Core started with `YUZUNO_EXPERIMENTAL_OPENCODE=1` offers
**OpenCode** when creating an Agent; without it, Core refuses the harness and
the UI does not offer it. The switch decides only creation: an existing
OpenCode Agent keeps working either way.

## What it does

- **Where:** the machine running Core only, in the folder you choose. Core
  starts one `opencode serve` per Agent, listening on `127.0.0.1` behind a
  password of its own, and ends it with the Agent.
- **Model, login and permissions:** OpenCode's own configuration. Yuzuno
  offers no model choice, reads no OpenCode credentials or configuration, and
  adds no permission rules.
- **Requests:** a permission OpenCode asks for is answered **Allow once** or
  **Reject**; nothing lasting is offered. OpenCode rejects the session's other
  waiting requests along with a rejected one. Its questions are answered in
  its own form.
- **History:** each Agent keeps its session in an OpenCode database in Core's
  data folder (`opencode/<agent id>/opencode.db`). Deleting the Agent keeps
  it, as deleting a Codex or Claude Agent keeps their native sessions.
- **After Core restarts:** an Agent connects again when it is used, by a
  reconnect or a message. Its OpenCode starts again on the same session; a
  turn that was running shows its outcome as unknown and is never sent again.
  If one was running, the first message only connects again and is not sent,
  as for Codex: send it again once you have seen how that turn ended.
- **Stopping:** OpenCode runs the commands of its tools (a shell command,
  for example) apart from itself, so they do not end with it. When you close
  the Agent, or Core stops normally (Ctrl+C), Core first asks that Agent's
  OpenCode to end them, waits at most 5 seconds, then ends OpenCode. If Core
  or OpenCode is killed instead, or OpenCode does not answer in time, a
  command still running goes on until it ends by itself.

## What OpenCode does by itself

- **Port:** OpenCode reads the port Core asks for (`0`) as 4096 when that is
  free, otherwise any free port. Core uses the address OpenCode prints, so the
  first OpenCode Agent may hold port 4096; another `opencode serve` you start
  then uses a different port.
- **Dependencies:** when it starts, OpenCode may download or update its own
  plugin dependencies into its configuration folder (for example
  `~/.config/opencode/node_modules`), whatever its other settings.

## Not yet

Remote machines, images, rewind, slash commands, model choice, messages added
to a running turn, and following OpenCode's sub-agent sessions.
