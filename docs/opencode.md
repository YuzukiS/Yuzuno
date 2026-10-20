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
to a running turn, and following OpenCode's sub-agent sessions. A process
that OpenCode moves out of its own process group is not ended with it.
