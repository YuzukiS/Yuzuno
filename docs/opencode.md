# OpenCode Agents (experimental)

Core can run an Agent on [OpenCode](https://github.com/anomalyco/opencode),
talking to OpenCode's own server (`opencode serve`) on loopback. This is off by
default. A Core started with `YUZUNO_EXPERIMENTAL_OPENCODE=1` offers
**OpenCode** when creating an Agent; without it, Core refuses the harness and
the UI does not offer it. The switch decides only creation: an existing
OpenCode Agent keeps working either way.

**Moving to OpenCode 2.x (T-32).** Core is moving from OpenCode 1.19.3 to 2.x,
one part of the protocol at a time. It starts, checks and stops OpenCode as 2.x
does, and takes any 2.x from 2.0.7: it is checked against 2.2.5; the routes and
events Core reads exist from 2.0.7. A newer one is noted in the Agent's
settings, not refused. Before 2.0.29, a turn that ended unsuccessfully while no
stream was open shows without OpenCode's error text. An older 2.x is refused
with both versions, saying to update it, and an OpenCode that is not 2.x is
refused with the version it says it is. Logging an Agent in to a provider here
needs 2.0.20 or newer; an older 2.x says to update OpenCode to log in here,
with the version it runs.

Each part moves in two steps. First the routes: what connecting, a session's
snapshot and its event stream read uses 2.x's own routes (`/api/…`), in 2.x's
envelope (`{data}`). Then what those carry. A session's messages and their
events are now read as 2.x writes them: one answer per step, its text,
reasoning and tool calls in order, and an `idle` message at each turn's end.
An answer belongs to the newest message before it in its turn, so a message
added to a running turn is answered from the step after OpenCode takes it up.
A message counts as delivered once 2.x admits it, as once 1.19.3 stored it; a
whole read finds one not yet taken up in the session's inbox. Text appears as
it streams, in batches: a batch is written out when a further piece arrives a
quarter of a second or more after the batch began, or when the entry ends, so
text that streams and then pauses shows at the next piece or the entry's end.
A turn ends with 2.x's own end of its run: succeeded, failed with its error,
or interrupted. Text gathered for an entry is also written out by its answer's
next event, by its step's end and by the run's end. A shell command typed in
OpenCode shows in the Turn as a command, with what it printed; the text of
OpenCode's own synthetic messages (a shell's output passed to the model, say)
is not shown.

Sending is 2.x's too: a message goes through 2.x's prompt under the ID Yuzuno
chose, its images as `data:` URIs, and is delivered once OpenCode admits it.
2.x's prompt carries no model, so a model chosen in the Agent's settings is
made the session's before a message when the session's is another, or none
yet; 2.x keeps a note of each change in the session. The models come from
2.x's list (`/api/model`), and interrupting is 2.x's interrupt. A session's
status is read from the sessions 2.x lists as running (`/api/session/active`).

Still to move: compaction, rewind and fork.
- **Compaction, rewind and fork:** they still read 1.19.3's messages, so on a
  session of 2.x's they refuse before doing anything ("not yet on OpenCode
  2.x"). Core's tests of them use a 1.19.3 mode of its stand-in OpenCode,
  removed once their parts land.

So creating an OpenCode Agent stays behind the experimental switch.

Two things a reader of a 2.x session sees differently. Text still streaming
when Yuzuno reads the session whole (after its stream broke, say) is what has
streamed so far: 2.x keeps no text until its entry ends, so the read keeps
what Yuzuno already had. And a turn running when OpenCode shut down has no
end of 2.x's (it would resume it), so Yuzuno shows its outcome as unknown.

An experimental 2.x Agent made before its data and state moved to its own
folder leaves what OpenCode kept in the user's own folders behind, such as
its rewind snapshots: they stay there, and the Agent no longer sees them.
A new Agent's database never takes in your 1.x `auth.json`: 2.x imports that
file only when it migrates a database that already holds sessions, never
into a new one, and Yuzuno never lets 2.x open a 1.19.3 database.

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
  2.x from 2.0.7 and notes one newer than the verified release. It is also
  started with `OPENCODE_DISABLE_MODELS_FETCH=1`, so an OpenCode Yuzuno starts makes no
  network request of its own besides your model provider's. Its models are
  the installed release's own catalog and those in your OpenCode config, so
  the list moves on with an OpenCode update.
- **Model, login and permissions:** OpenCode's own configuration, unless a
  model, and one of its variants, is chosen in the Agent's settings from what
  its OpenCode's configured providers list (`/api/model`, names only). The
  choice is made the session's before a new message when the session's is
  another, and one OpenCode no longer lists refuses the message before
  anything is sent. Yuzuno reads no OpenCode credentials, keeps nothing else
  of a provider's or a model's record (its settings and headers can hold
  keys), and adds no permission rules.
- **Workspace MCP:** each Agent's OpenCode is given the Workspace's MCP
  server, `yuzuno`, with that Agent's own credential. Its tools
  (`yuzuno_task_get` and the rest) are offered to the model as tools of their
  own, not behind OpenCode's `execute`. OpenCode keeps the server in its
  memory, for the Agent's folder only, with OAuth off: nothing is written to a
  configuration file, and OpenCode lists its status only. A message goes only
  once OpenCode lists it connected; one still connecting is waited for, up to
  12 seconds. OpenCode drops it with the folder when it unloads an idle folder
  (after an hour without session events) or reloads it; it is handed over
  again before the next message, which then goes. Handed over again unchanged,
  it changes nothing. When OpenCode reports it failed, or needing
  authentication, a message is refused with what OpenCode reported;
  reconnecting the Agent has OpenCode try it again, on the same process.
  Nothing OpenCode answers about it is shown or kept with the credential in
  it.
- **Requests:** a permission OpenCode asks for (the tool and what it acts
  on, as OpenCode names them) is answered **Allow once** or **Reject**;
  nothing lasting is offered, and Yuzuno never saves a permission rule in
  OpenCode. A reject ends the turn, which shows as declined, and OpenCode
  rejects the session's other waiting requests with it. OpenCode's
  questions are answered in their card, each with one of its choices or, where
  it takes it, text of your own; declining one ends the turn the same way. A
  form Yuzuno can't fill (one that isn't a question or a web search
  provider's choice, or that asks for a secret, something done outside
  OpenCode, or an answer the card doesn't take) says why and can only be
  declined, or the turn interrupted. An answer OpenCode can't take is refused
  with its reason and can be given again. Only a question's answer is kept in
  Yuzuno's journal. A request asked by a sub-agent is answered in its own
  session. OpenCode ends a declined turn as it ends one when it stops, with
  no end of its own: Yuzuno tells it declined only as it sees that end
  happen. Read afterwards (its event stream broke meanwhile, or Core
  restarted), such a turn shows its outcome as unknown.
- **Images:** a message can carry images, as for Codex and Claude, when the
  Agent has a model chosen in its settings that OpenCode lists as reading
  images. With OpenCode's own default, or a model that doesn't read images,
  the message is refused and the draft keeps its text and images: OpenCode
  itself would give such a model a line of text in place of each image and
  send the rest. Large images are scaled or compressed as for Claude; the
  conversation shows the originals.
- **Commands:** typing `/` lists the commands OpenCode offers (2.x's own
  list: its configuration's, its own such as `init` and `review`, and its MCP
  servers' prompts): their names and descriptions only, never a template.
  A message `/<name> [arguments]` for a listed one runs as that command, once,
  and only while the Agent is idle. OpenCode expands its template, shell
  lines (`!`) included, as it would itself, and admits the result as a
  message of its own, which the Turn follows; delivery is confirmed once
  OpenCode admits it. One whose shell lines run longer than about 15 seconds
  shows as unconfirmed until then.
  - The Agent's chosen model and variant are made the session's first, as
    for a message. A command that names a model or an agent of its own makes
    those the session's, and they stay so: Yuzuno makes its chosen model the
    session's again before the next message, but never switches the agent.
  - A command that admits nothing and leaves OpenCode idle (such as
    `/goal pause`) ends its Turn saying so.
  - A command that runs as a sub-agent ends its Turn at once, saying so.
    OpenCode runs it in the background and later hands its result to the
    session in a run of its own, which is no Yuzuno Turn. Its permission
    requests and questions still come to this Agent.
  - `/goal` and `/schedule` start work of their own later, in runs Yuzuno
    cannot follow yet: they are not offered, and a message naming them is
    refused.
  - A command can't carry images: the message is refused and the draft keeps
    its text and images.
  - Any other text, an unlisted `/<name>` included, is sent as a message.
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

## Logging in to a provider

An OpenCode Agent is logged in through its own OpenCode, from its settings
("Log in to a provider"), once per Agent: Yuzuno copies no login from one
Agent or from your own OpenCode to another, and never imports a 1.x
`auth.json`.

- **How:** with an API key, or a sign-in on the provider's own page that
  gives a link and a code to enter (a device sign-in, GitHub Copilot's say).
  A sign-in whose page sends your browser back to this computer (`localhost`)
  isn't offered here: Yuzuno starts it, sees where it sends you, cancels it at
  once and says to sign in from OpenCode itself. Methods that need anything
  but text and choices, or a command, are signed in from OpenCode itself too.
  A method's questions come filled in with their defaults, and a hidden one's
  default is sent for it, as OpenCode itself does.
  OpenCode's environment variables (an `OPENROUTER_API_KEY`, say) are listed
  by name.
- **Where the key goes:** to that Agent's OpenCode only, which keeps it in its
  own database (`opencode/<agent>/opencode.db` in Yuzuno's data, readable by
  you alone). Yuzuno passes it on once and keeps it nowhere: not in its
  database or journal, which note which provider and label only, not in its
  logs, not in an error, which gives OpenCode's status and kind only, and not
  in the page, whose key field is emptied after each request. Yuzuno never
  reads a login back from OpenCode. The Workspace backup leaves the Agents'
  OpenCode folders out.
- **When:** the Agent must be connected. A login applies from the Agent's
  next model call, a running turn's included. Log out removes it from the
  Agent's OpenCode.
- **Only you:** the login is on Yuzuno's page on this computer only, not from
  a phone, and no Agent can log an Agent in. A program on this computer that
  can reach Yuzuno's local port is not stopped by this.
- **When the Agent's database is kept or moved:** deleting an OpenCode Agent
  keeps its folder, and a database Yuzuno moves aside (`set-aside-N`) is kept
  too. Before either, with OpenCode stopped, Yuzuno removes every login from
  that database, overwriting where it was. What can't be read as a database (a
  WAL left without its database, or a damaged `opencode.db`) is overwritten
  with zeros and removed instead, so it never keeps the Agent from starting or
  being deleted. A database still in use refuses the start or the delete, with
  the reason: stop what is using it, or try again.
- **Needs** OpenCode 2.0.20 or newer.
- **Limits:** a sign-in in progress is lost if the Agent's OpenCode restarts;
  start it again. Overwriting acts on the files' contents: what the disk has
  already freed (a WAL emptied by SQLite, a journal it made and removed while
  trying a damaged file) or keeps elsewhere (copy-on-write, snapshots, flash
  storage) isn't overwritten.

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
OpenCode's own revert: see [Rewind](rewind.md#opencode).)
