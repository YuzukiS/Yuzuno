# OpenCode Agents (experimental)

Core can run an Agent on [OpenCode](https://github.com/anomalyco/opencode),
talking to OpenCode's own server (`opencode serve`) on loopback. This is off by
default. A Core started with `YUZUNO_EXPERIMENTAL_OPENCODE=1` offers
**OpenCode** when creating an Agent; without it, Core refuses the harness and
the UI does not offer it. The switch decides only creation: an existing
OpenCode Agent keeps working either way.

**Moving to OpenCode 2.x (T-32).** Core is moving from OpenCode 1.19.3 to 2.x,
one part of the protocol at a time. It starts, checks and stops OpenCode as 2.x
does, and takes any 2.x: it is checked against 2.2.5, and a newer one is noted
in the Agent's settings, not refused. An OpenCode that is not 2.x is refused
with the version it says it is.

Each part moves in two steps. First the routes: what connecting, a session's
snapshot and its event stream read now uses 2.x's own routes (`/api/…`), in
2.x's envelope (`{data}`). Then what those carry: until their own parts land,
the messages and their events (with a session's status), then permission
requests and questions, keep 1.19.3's shape in Core and in its tests, inside
2.x's envelope. Calls outside connecting still use 1.19.3's routes until their
parts: sending a message, a command, compaction, rewind, fork, answering a
request, interrupting, Workspace MCP and the model list. So messages to an
OpenCode 2.x Agent do not work yet, which is why creating one stays behind the
experimental switch. A session's status is read from the sessions 2.x lists as
running (`/api/session/active`). Busy on the real binary is first observed in
slice 4 (first execution, stub provider): until then only its idle reading and
its answer's shape are checked against a real OpenCode.

An OpenCode Agent made before this change was made with 1.19.3. It is kept to
read: its conversation stays in Yuzuno, and it is never started again, because
2.x would migrate its database in place. To go on, create a new OpenCode Agent.
A new Agent keeps the version of the OpenCode that made its database. Before
an Agent has a session, nothing of Yuzuno's is in its database: one already in
its folder (1.19.3 made it, but its session never reached Yuzuno) is moved
aside into a `set-aside-N` folder beside it, never deleted, and 2.x starts on
a new one.

## What it does

- **Where:** the machine running Core only, in the folder you choose. Core
  starts one `opencode serve` per Agent, listening on `127.0.0.1` behind a
  password of its own, and ends it with the Agent.
- **OpenCode's own folders:** an Agent's OpenCode keeps its data (such as
  its log) and its state in the Agent's own folder in Yuzuno's data
  (`opencode/<Agent>/xdg`). Its downloads, such as provider
  packages and tools, go to one cache that Yuzuno's OpenCode Agents share
  (`opencode/cache`). Your own OpenCode folders under `~/.local` and
  `~/.cache` are never used. Its configuration stays yours
  (`~/.config/opencode`): your providers, agents, MCP servers and
  permission rules. So it does not see a login made with `opencode auth
  login`, which 2.x keeps in your own OpenCode's database: until Yuzuno
  offers a login for an Agent, provider keys come from your environment and
  your OpenCode config.
- **Updates and the models list:** OpenCode is started with
  `OPENCODE_DISABLE_AUTOUPDATE=1`, although `opencode serve` 2.2.5 never
  updates itself anyway. Updating OpenCode is yours to do; Yuzuno takes any
  2.x and notes one newer than the verified release. It is also started with
  `OPENCODE_DISABLE_MODELS_FETCH=1`, so an OpenCode Yuzuno starts makes no
  network request of its own besides your model provider's. Its models are
  the installed release's own catalog and those in your OpenCode config, so
  the list moves on with an OpenCode update.
- **Model, login and permissions:** OpenCode's own configuration, unless a
  model, and one of its variants, is chosen in the Agent's settings from what
  its OpenCode's configured providers list (`/config/providers`, names only).
  The choice goes with each new message, and one OpenCode no longer lists
  refuses the message before anything is sent. Yuzuno reads no OpenCode
  credentials, keeps nothing else of a provider's record, and adds no
  permission rules.
- **Requests:** a permission OpenCode asks for is answered **Allow once** or
  **Reject**; nothing lasting is offered. OpenCode rejects the session's other
  waiting requests along with a rejected one. Its questions are answered in
  its own form.
- **Images:** a message can carry images, as for Codex and Claude, when the
  Agent has a model chosen in its settings that OpenCode lists as reading
  images. With OpenCode's own default, or a model that doesn't read images,
  the message is refused and the draft keeps its text and images: OpenCode
  itself would give such a model a line of text in place of each image and
  send the rest. Large images are scaled or compressed as for Claude; the
  conversation shows the originals.
- **Commands:** typing `/` lists the commands OpenCode's configuration
  defines (`/config`'s `command`): their names and descriptions only, never
  a template or anything else of the configuration. A message
  `/<name> [arguments]` for a listed one runs as that command, once, under
  the message's ID: OpenCode expands its template, shell lines (`!`)
  included, as it would in OpenCode itself. A command that names a model of
  its own, or an agent that has one, runs with that model; otherwise the
  Agent's chosen model and variant go with it. A command can't carry images:
  the message is refused and the draft keeps its text and images. Any other
  text, an unlisted `/<name>` included, is sent as a message. A command that
  runs as a sub-agent asks through that sub-agent's session. Delivery is
  confirmed when OpenCode stores the message; one whose shell lines run
  longer than about 20 seconds shows as unconfirmed until it is.
- **Adding to a running turn:** while OpenCode works, a message sent with
  the composer's "send while working" joins that turn. OpenCode stores it at
  once and answers it from its next step, in the same run, as its own TUI does
  (where it shows as queued until then). The turn ends once its newest
  message is answered, or once OpenCode is idle after going on under a
  message of its own (as after an automatic compaction). It is refused, and the draft kept, while a permission
  or question waits for you, while the turn is being interrupted, or for a
  command, which only runs on its own.
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
  the Agent, or Core stops normally (Ctrl+C or SIGTERM), Core asks that
  Agent's OpenCode to end (SIGTERM), and OpenCode 2.x ends them in its own
  teardown, which it gives 10 seconds. Core waits at most 12 seconds, then
  ends whatever of OpenCode is left. If Core or OpenCode is killed instead,
  or OpenCode does not end in time, a command still running goes on until it
  ends by itself. On a Core that is not on Linux or macOS, Core ends OpenCode
  at once and its tools' commands are not ended: the SIGTERM and the wait are
  Unix-only, and OpenCode 2.2.5 has no route to ask it to stop.

## What OpenCode does by itself

- **Port:** OpenCode reads the port Core asks for (`0`) as 4096 when that is
  free, otherwise any free port. Core uses the address OpenCode prints, so the
  first OpenCode Agent may hold port 4096; another `opencode serve` you start
  then uses a different port.
- **Dependencies:** OpenCode may download the packages its configured
  plugins and providers need, into the cache Yuzuno's OpenCode Agents share
  (`opencode/cache/npm` in Yuzuno's data), whatever its other settings.

## Not yet

Remote machines, and following OpenCode's sub-agent sessions. (Rewind is
OpenCode's own revert: see [Rewind](rewind.md#opencode).) Commands OpenCode makes of its MCP servers'
prompts and of its skills are not in its configuration, so they are not
listed, and `/<name>` for one is sent as text.
