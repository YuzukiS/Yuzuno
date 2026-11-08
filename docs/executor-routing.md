# Executor routing

Executor routing will start each new executor with the first of an ordered
list of candidates whose conditions hold: a harness, a model, and an account
or API key. It is built in slices. This page describes what exists at this
version; a later slice adds to it.

| Slice | What it adds | State |
| --- | --- | --- |
| S1a | Routing keys: the key file, its write-only routes, reading a key through 1Password | Done |
| S1b | Accounts: claude-swap's accounts and how a binding to one resolves, its launcher, Codex homes | This version |
| S1c | Handing a key or account to one executor's harness process | Later |
| S2–S4 | Readings, routing itself, the Settings page | Later |

Nothing at this version starts an executor with a routing key or an account:
S1a keeps keys and reads them on request, S1b lists accounts and resolves a
binding, and S1c will hand one to an executor.

## Routing keys

A routing key is an API key an executor may later be started with: for
Anthropic (Claude Code), OpenAI (Codex) or DeepSeek (OpenCode). Each key has an
id (1 to 48 of `a-z`, `0-9` and `-`) and chooses its source:

- **local**: you enter the value, and Core keeps it in the key file.
- **1password**: you enter an `op://vault/item/field` reference (or
  `op://vault/item/section/field`). Core keeps only the reference and reads the
  value through the 1Password CLI when it is needed, with a 1Password service
  account's token. The token is itself kept in the key file.

### The key file

The file is `secrets/routing-keys.json` in the Workspace folder.

- It is created with mode 0600 in a folder with mode 0700, and no moment
  passes with wider permissions, whatever the umask. Each change writes a new
  file beside it and renames it into place, so a reader sees the old file or
  the new one, whole.
- Core refuses to use it, and says why, when another user owns it, when its
  mode gives the group or others any access, when it is a link, or when the
  folder can be written by other users. `chmod 600` the file (or `chmod 700`
  the folder) and Core uses it again.
- **What it protects against:** the computer's other users. **It does not
  protect against programs that run as you**, and that includes the Agents'
  own shell tools: anything running as your user can read the file, exactly
  as it can read the Claude and Codex login files. A later slice says, for
  each harness, whether its tool processes also see a key in their
  environment.
- It is never copied: a Workspace backup leaves the `secrets` folder out with
  its reason, a restore cannot write into it, the update helper copies only
  the database, and the storage overview shows the folder by name only. A
  restored or moved Workspace starts without keys: enter them again.
- No journal row, task, Brief, log or error text holds a value. Errors name a
  key's id or the file, never a value.

### Writing keys

Keys and the token are written only through these routes, on Core's own port,
for your own browser. They are not on the phone entry, no Workspace tool an
Agent can call reaches them, and a request carrying any `Authorization`
header (an Agent's credential) is refused with 403.

| Route | What it does |
| --- | --- |
| `GET /api/routing/keys` | Each key's id, provider, source, `set` and `setAt`, and a 1Password key's reference; whether the token is set. Never a value. |
| `PUT /api/routing/keys/{id}` | `{"source":"local","provider":…,"value":…}` or `{"source":"1password","provider":…,"reference":…}`. Answers as a read does. |
| `DELETE /api/routing/keys/{id}` | Forgets the key. |
| `POST /api/routing/keys/{id}/check` | For a 1Password key: whether its reference names a field the token can read, without reading the value. |
| `GET /api/routing/1password` | Whether the token is set, and whether `op` is installed here, its version, and whether it has service accounts. |
| `PUT` / `DELETE /api/routing/1password/token` | Keeps or forgets the service account's token. |

Like the OpenCode login, these routes rely on Core's browser boundary: it
stops other computers, web pages and the phone entry. A program running as
you on this computer can reach Core's port as your browser does, and so
could write a key. It still cannot read one back through Core.

### Keys in 1Password

Core runs the 1Password CLI (`op`, or the program `YUZUNO_OP_BIN` names) with
an environment of its own: `PATH` and `HOME` from Core's, and the token as
`OP_SERVICE_ACCOUNT_TOKEN`. Nothing else of Core's environment reaches `op`
(in particular no `OP_CONNECT_*`, which would take precedence over the token),
and the token reaches nothing but `op`.

- **Version.** Service accounts need op 2.18.0 or later. Core reads
  `op --version` before each use. See
  [Use service accounts with 1Password CLI](https://www.1password.dev/service-accounts/use-with-1password-cli).
- **Reading a key**: `op read --no-newline <reference>`, once. The value is
  kept in memory for the one process it is handed to, and never written to
  disk. See [op read](https://www.1password.dev/cli/reference/commands/read).
- **Checking a reference**: `op read --no-newline "<reference>?attribute=type"`.
  It answers the field's type, never its value. See
  [secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax).
- **Request limits.** A service account may make a limited number of reads an
  hour, and each `op read` costs three
  ([rate limits](https://www.1password.dev/service-accounts/rate-limits)).
- Give the service account access to only the vault that holds these keys.

When a key cannot be read, Core says why, in English and Chinese, and never
passes on what `op` printed. A routing candidate that uses the key then counts
as unavailable, and the next one is tried.

| Code | Reason |
| --- | --- |
| `tokenMissing` | The 1Password service account's token is not set / 1Password 服务账号的令牌没设置 |
| `referenceNotFound` | 1Password has no `op://…` / 1Password 里找不到 `op://…` |
| `unreachable` | 1Password is unreachable; the key cannot be fetched / 1Password 连不上，取不到 key (also a run longer than 30 s) |
| `tokenRejected` | 1Password refused the service account's token / 1Password 不接受服务账号的令牌 |
| `rateLimited` | The service account's request limit is reached; try again later / 服务账号的 1Password 请求次数到上限了，稍后再试 |
| `opMissing`, `opTooOld` | `op` is not installed here, or older than 2.18.0 |
| `failed` | Any other failure, with `op`'s exit code |

op documents no exit codes for these cases, so Core tells them apart by the
words of `op`'s message.

### With an older Core

An older Core has none of these routes and never reads the key file: it
leaves the `secrets` folder as it is, and a newer Core uses it again. A file
written by a later Core (a higher `version`) is not changed by this one.

## Accounts

### claude-swap accounts

Several Claude subscription accounts are managed by
[claude-swap](https://github.com/realiti4/claude-swap) (`cswap`), as
[Claude account management](claude-swap.md) describes. Core reads its
accounts and never handles their logins: claude-swap keeps each account's
profile, refreshes its tokens and guards the default login.

- **The list.** Core runs `cswap list --json` (schema 1). The command is a
  setting: a name on `PATH` (`cswap`, the default) or an absolute path, set
  with `PUT /api/routing/cswap {"command": …}`. `GET /api/routing/accounts`
  answers each account's slot number, whether it is the host's current
  default login, its label (its alias, else its email) and its usage status;
  or why the list cannot be read (`cswapMissing`, `cswapError` with only the
  error's type, `cswapSchema`, `cswapTimeout` after 60 s, `cswapFailed`).
  The email is shown to your browser only and never kept.
- **Binding.** An executor will be bound to an account by its fingerprint: a
  hash of the account's email and organization. No email is kept, and slot
  numbers, which claude-swap lets move, are not relied on.
- **At each launch** the binding is resolved again from a fresh list:
  - the account that is the host's current default login starts on the plain
    host login, as a candidate with the host login does: claude-swap's
    `--require-session` refuses that account, and the host login is that same
    account;
  - any other listed account starts through
    `cswap run <slot> --require-session`;
  - an account no longer listed is gone, and the executor does not start.
    Core never starts it as another account. A refusal at launch (the account
    became the default login after the list was read) fails that start the
    same way: an executor is never moved to another account during its life.
- **The launcher.** claude-swap 1.0.0's `run` has no quiet or JSON option and
  prints a notice to stdout before it execs Claude Code, while the Agent SDK
  reads Claude's JSON from that stdout. So a Claude executor on an account
  will start through `runtimes/claude/cswap-claude`. It runs
  `runtimes/claude/cswap-run.py` with claude-swap's own Python (the
  interpreter its `cswap` script names on its first line), which points
  Python's `sys.stdout` at stderr, writing through at once, leaves file
  descriptor 1 alone, and calls `cswap run <slot> --require-session -- …`.
  claude-swap then execs Claude, which writes to the original stdout.
- This was written against claude-swap **1.0.0** and tested only with
  stand-ins: a stub `cswap` and a stub `claude_swap` package. Whether it works
  with a real claude-swap and two real accounts is a separate check, made with
  your own install.

### Codex homes

Each Codex account is a `CODEX_HOME` folder you name, signed in with
`codex login` there. `PUT /api/routing/codex-homes {"homes": [{id, label, home}]}`
replaces the list (at most 16). Each home must be an absolute folder that
exists, belongs to Core's user and no other user can write into, and is listed
once. The host's own login (`~/.codex`, or Core's `CODEX_HOME`) needs no entry.

These routes are on Core's own port only, like the routing keys', and refuse
any `Authorization` header: the cswap command is a program Core runs.

