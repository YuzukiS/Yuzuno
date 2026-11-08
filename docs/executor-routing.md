# Executor routing

Executor routing will start each new executor with the first of an ordered
list of candidates whose conditions hold: a harness, a model, and an account
or API key. It is built in slices. This page describes what exists at this
version; a later slice adds to it.

| Slice | What it adds | State |
| --- | --- | --- |
| S1a | Routing keys: the key file, its write-only routes, reading a key through 1Password | Done |
| S1b | Accounts: claude-swap's accounts and how a binding to one resolves, its launcher, Codex homes | Done |
| S1c | Handing a key or account to one executor's harness process: Claude Code, OpenCode and Codex | Done |
| S2a | Readings: time windows and the daily API spend, read-only | Done |
| S3a | The policy: kept, checked and served; a template fixed against routing | Done |
| S2b | Readings: subscription quotas (claude-swap, Codex) | Done |
| S3b1 | Choosing a candidate: Core's evaluator, `evaluate` and `simulate` | Done |
| S3b2 | The choice at dispatch, waiting for a candidate, `route_json`, `choices` | Done |
| S3b3 | A real DeepSeek executor through routing: a lab check | This version |
| S4 | The Settings page (YN-49) | Later |

An executor starts with a routing key or account only when its runtime
profile names one. Routing sets it at the executor's dispatch, while the
routing policy is on ([Routing at dispatch](#routing-at-dispatch-s3b2)).

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

Settings → Executor routing → Accounts and keys writes them through these
routes: a key's value or the token is typed into a password field, sent once
and never shown again, and claude-swap's accounts are shown by number and
fingerprint only.

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
  default login, its label (its alias, else `Account-<number>`, never its email) and its usage status;
  or why the list cannot be read (`cswapMissing`, `cswapError` with only the
  error's type, `cswapSchema`, `cswapTimeout` after 60 s, `cswapFailed`).
  No email is shown or kept.
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
once. The host's own login (`~/.codex`, or Core's `CODEX_HOME`) needs no entry, and `login`, the name routing gives it, is no home's id.
An executor bound to a home runs its app-server there, and Core reads its
history and its sub-agents there too.

These routes are on Core's own port only, like the routing keys', and refuse
any `Authorization` header: the cswap command is a program Core runs.

## Starting an executor with a key or account

[An executor's account or key](executor-model.md#an-executors-account-or-key)
has the rules: where the profile lives, that each start reads it again, and
that an executor is never moved to another account. This is what each harness
gets, and what its tools can see. The key goes to that executor's process only:
Core's own environment never holds it, so no other Agent, Job, review run or
catalog read sees it.

| Harness | Profile | What its process gets | What its tool commands can see |
| --- | --- | --- | --- |
| Claude Code | API key (Anthropic) | `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | Not the key: with the scrub, Claude Code strips credentials from the environment of its Bash commands, hooks and stdio MCP servers ([env vars](https://code.claude.com/docs/en/env-vars)). On Linux the scrub also runs Bash commands in their own PID namespace. |
| Claude Code | claude-swap account | `YUZUNO_CSWAP_PYTHON` and `YUZUNO_CSWAP_ACCOUNT` for the launcher, which `cswap run` turns into that account's `CLAUDE_CONFIG_DIR` | The profile folder's path, as with any `CLAUDE_CONFIG_DIR`. Its login files are files, readable by anything running as you. |
| OpenCode | API key | Its provider's variable: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | **The key.** OpenCode's shell tool runs with the server's environment. Its per-session environment setting covers the main session but not sub-sessions, so it is not used. This is a known limit. A login saved in that Agent's OpenCode takes precedence over the variable. |
| Codex | Codex home | `CODEX_HOME` set to that home | The home's path. Its login file (`auth.json`, or the system keyring if the home is set up so) is readable by anything running as you. |
| Codex | API key (OpenAI) | `CODEX_HOME` set to Core's own `codex-api-home` folder in the Workspace folder (mode 0700), `-c cli_auth_credentials_store="ephemeral"`, and the key sent once over its connection, after `initialize`, with `account/login/start {"type": "apiKey"}` ([app-server](https://developers.openai.com/codex/app-server)) | Not the key: it is in no environment variable, and the ephemeral store keeps it in that app-server's memory only, never in `auth.json` ([authentication](https://developers.openai.com/codex/auth)). `codex app-server` does not read `CODEX_API_KEY`, which is for `codex exec`. |

A key from 1Password is read once at each start (`op read`), held in memory and
handed to that process (for Codex, sent over its connection). Why it cannot be read fails the start with its reason
(see [Keys in 1Password](#keys-in-1password)).

An executor with a profile cannot be forked (Codex or OpenCode): the fork
would be a new Agent with no profile, so on another account, and a Codex
fork's session would be in the source's home. Copy what you need instead.

Apart from the scrub above, none of this protects a key from a program
deliberately reading another process's environment or files as you: the 0600
file, `/proc/<pid>/environ` and login files are all yours to read.

## Readings

These are what routing decides with, as Core last observed them. Nothing
here runs a model, calls a network service, or holds a key's value.

### Time windows

A schedule is weekly slots, read in `UTC` or the Core host's `local` time.

- `days` run from 1 (Monday) to 7 (Sunday).
- `from` and `to` are `HH:MM`. `from` is inclusive and `to` exclusive, and `to` may be `24:00`.
- A slot whose `to` is not after its `from` runs past midnight into the next day.

The built-in preset `deepseek-peak` is DeepSeek's peak hours: UTC Monday to
Friday, 01:00–04:00 and 06:00–10:00. Holidays count as working days. DeepSeek
off-peak is `inside: false` on this schedule. Presets are offered for a
policy to copy; a policy always holds its schedule inline.

### The daily API spend

For an executor started with a routing key, Core counts what each turn
cost, as its harness reports it:

- **Claude Code:** what the turn added to its result's `total_cost_usd`. Claude Code reports that as the running total of its session, so Core keeps the last total it saw from each executor, across restarts, and counts the increase. A total below the last (after `/clear`, or in a new session) counts from zero. A zero total, as a crashed turn reports, counts nothing.
- **OpenCode:** each finished step's `cost`, the executor's sub-agents' too.
- **Codex:** not counted yet. Routing (S3) treats a Codex API-key candidate's spend as unknown.

Each entry is counted once, by key id, on the Core host's local date.

- An executor on a login or a claude-swap account spends no key and counts nothing.
- An OpenCode answer that finished while Core was not connected to it is not counted.
- Entries are kept 40 days, also after their Agent is deleted.

This is what the harnesses report: **an estimate, not a bill**.

### `GET /api/routing/readings`

This route is read-only and has the same boundary as the routing keys:
- it is on Core's own port, for your own browser;
- it is not on the phone entry;
- it refuses any `Authorization` header.

It answers from what Core last observed and starts no read itself.

```jsonc
{ "at": "2026-11-08T04:30:00+00:00",
  "staleAfterSeconds": 600,
  "spend": { "day": "2026-11-08", "zone": "local", "utcOffset": "+08:00",
    "resetsAt": "2026-11-08T16:00:00+00:00",          // the next local midnight
    "totalUsd": 1.23, "byKey": { "deepseek": 0.81 }, "note": "…", "noteZh": "…" },
  "presets": { "deepseek-peak": { "schedule": { "timeZone": "UTC", "slots": […] },
    "inside": false, "changesAt": "2026-11-09T01:00:00+00:00" } } }
```

### Subscription quotas

These are what is left of each account's 5-hour and weekly windows.

- **When they are read:** in the background every 5 minutes, while the policy is on and a candidate needs them:
  - a Claude Code candidate on a claude-swap pool, or on the host login with a `quota` condition;
  - a Codex candidate on the host login or a Codex home, with a `quota` condition.

  Otherwise nothing is read. `cswap` is `null` and `codex` is empty until the first read.
- **claude-swap accounts** come from `cswap list --json`. claude-swap reads each account's usage from Anthropic itself; its `pct` is the share used, and the readings show what is left. An account claude-swap has no usage for (an expired login, say) carries `unknown` with the claude-swap status as its code. When `cswap` cannot be run, `cswap.unavailable` says why.
- **Codex** quotas are read for the host's own login and for each listed Codex home. Each read starts a `codex app-server` in that home, asks `account/read`, then `account/rateLimits/read`, and ends it. It runs no model. A login that is not a ChatGPT subscription (an API key, say) has no quota and carries `unknown`. A home taken off the list leaves the readings at the next refresh.
- **A reading over 10 minutes old is `stale`**, and routing reads it as unknown.
- **No label or email is ever shown:** an account is its number and fingerprint.

```jsonc
  "cswap": { "observedAt": "…", "unavailable": { "code": "…", "message": "…", "messageZh": "…" },   // unavailable only when it could not be read
    "accounts": [ { "number": 2, "fingerprint": "3f2a…", "active": false,
      "fiveHour": { "leftPct": 71, "resetsAt": "…" }, "week": { "leftPct": 40, "resetsAt": "…" },
      "observedAt": "…", "source": "cswap",           // "cswap" | "agent" (reported by a running Agent)
      "unknown": { "code": "…", "message": "…", "messageZh": "…" } } ] },
  "codex": [ { "home": "login", "fiveHour": { … }, "week": { … }, "observedAt": "…", "source": "codex" },
             { "home": "work", "unknown": { … } } ]
```

S3 adds `spend.capUsd` and `spend.byCandidate`.

## Shapes for routing and its Settings page

These shapes are fixed ahead of their code, so that routing (S3) and the
Settings page (YN-49) can be built against them at once.

The rules for every shape:
- Times are RFC 3339.
- Ids are 1 to 48 of `a-z`, `0-9` and `-`.
- No shape holds a key's value, an email or a token.
- Fields a later Core adds are kept by a save: on the policy, on each candidate and on each condition.

### The policy: `GET` and `PUT /api/routing/policy` (S3a)

These routes are on the same boundary as the routing keys. No Workspace tool
writes the policy.

At this version the policy is kept, checked and served, and nothing yet
chooses by it: S3b will. It is kept in the Workspace's database as the JSON
that was saved, under `executors.routing`.

A save checks the policy strictly:
- an `apiKey` credential's key must be set and fit the harness;
- a Codex home must be listed;
- a schedule's days and times must be well formed.

A credential or condition of a kind a later Core added is kept, and routing
reads it as unknown. A template whose `routing` is `"fixed"` starts its
executors as it says, whatever the policy is.

```jsonc
// GET → 200. Before the first save: { "version": 0, "policy": { "enabled": false, "candidates": [], "whenNone": "wait" }, … }
{ "version": 3, "updatedAt": "…", "limits": { "candidates": 8 },
  "policy": {
    "enabled": true,                                  // false: executors start as their template says
    "whenNone": "wait",                               // the only value in this version
    "dailyApiCapUsd": 5,                              // optional: the total across apiKey candidates
    "candidates": [
      { "id": "c-deepseek", "label": "DeepSeek off-peak", // label optional, at most 60; empty shows "harness · model"
        "enabled": true,
        "harness": "opencode",                        // "claude" | "codex" | "opencode"
        "model": "deepseek/deepseek-flash",           // as that harness names it; empty is its default
        "reasoningEffort": "high",                    // Codex only, optional
        "credential": { "kind": "apiKey", "keyId": "deepseek" },
        "conditions": [                               // all must hold
          { "kind": "timeWindow", "inside": false, "minMinutesLeft": 30,
            "schedule": { "timeZone": "UTC", "slots": [ { "days": [1,2,3,4,5], "from": "01:00", "to": "04:00" },
                                                        { "days": [1,2,3,4,5], "from": "06:00", "to": "10:00" } ] } },
          { "kind": "dailyApiCap", "usd": 2 } ],
        "unknown": "skip" } ] } }                     // "skip" (the default) | "pass"

// PUT { "expectedVersion": 3, "policy": { … } } → 200, the same as GET with the new version
// A stale version → 409 { "code": "version_conflict", "error": "…", "current": { "version", "policy", "updatedAt" } }
// A refused field → 400 { "code": "invalid", "error": "…", "path": "candidates[2].conditions[0].usd" }
```

`credential` takes one of these forms:
- `{ "kind": "login" }`: the host's own login for that harness.
- `{ "kind": "pool", "manager": "cswap", "accounts": "all" | ["<fingerprint>", …], "pick": "mostRemaining" }`: Claude Code only.
- `{ "kind": "apiKey", "keyId": "<routing key id>" }`. Its provider comes from the key; a provider that doesn't fit the harness is refused:
  - Claude Code takes `anthropic`;
  - Codex takes `openai`;
  - OpenCode takes `deepseek`, `anthropic` or `openai`.
- `{ "kind": "codexHome", "id": "<Codex home id>" }`: Codex only. Use one candidate per home.

`conditions[]` entries take one of these forms:
- `{ "kind": "timeWindow", "inside": bool, "schedule": { "timeZone": "UTC" | "local", "slots": […] }, "minMinutesLeft"?: n }`. With `minMinutesLeft`, the condition must still hold for that many more minutes.
- `{ "kind": "quota", "fiveHourLeftPct"?: n, "weekLeftPct"?: n }`: for `login`, `pool` and `codexHome` credentials. It is the share left.
- `{ "kind": "dailyApiCap", "usd": n }`: this candidate's own cap, for `apiKey` credentials. The Workspace's `dailyApiCapUsd` always applies too.

### `route_json`: why a candidate was chosen (S3b)

It is kept on the dispatch, beside `choice_json`, and shown in `task_get` under `executorSlot.route`.

```jsonc
{ "policyVersion": 4, "evaluatedAt": "…", "at": "dispatch",      // "dispatch" | "start" | "preview"
  "chosen": "c-deepseek",                                         // null when none could be chosen
  "account": { "number": 2, "fingerprint": "3f2a…" },             // or { "home": "work" }, when the credential has one
  "candidates": [
    { "id": "c-claude", "label": "Claude pool", "harness": "claude", "model": "opus",
      "state": "skipped",                                         // chosen | skipped | unknown | failed | notTried | off
      "reasons": [ { "code": "quotaLow", "message": "…", "messageZh": "…",
                     "params": { "until": "…" }, "condition": 0 } ], // params carry ISO times for the user's own time zone
      "readings": [ { "what": "fiveHourLeft", "account": "2", "value": 12, "observedAt": "…", "source": "cswap" } ],
      "accounts": [ { "number": 2, "fingerprint": "3f2a…", "state": "low" } ] } ],   // pick | ok | low | unknown
  "changedAtStart": { "from": "c-claude", "reason": "…" },        // only when the start-time check chose another
  "earliest": { "at": "…", "candidate": "c-claude" } }            // only when none could be chosen
```

### How a candidate is chosen (S3b1)

Candidates are read in order, and the first one that meets every rule below
is chosen. The other candidates are marked `notTried`.

- **Turned on:** a candidate turned off is `off`.
- **Not already failed:** one that already failed to start this executor is `failed`, so each is tried once.
- **Runs on the machine:** a credential other than `login`, and any OpenCode candidate, runs on this Core host only (`hostOnly`).
- **Its credential is there:**
  - an `apiKey` key must be set (`keyMissing`);
  - a Codex home must be listed (`homeMissing`).
- **A pool picks an account:** among its accounts for which each `quota` condition holds, the one with the most of min(5-hour, week) left. Ties go to the lower number. Each account is marked `pick`, `ok`, `low` or `unknown`.
- **Its conditions hold:**
  - `timeWindow`: `outsideWindow`, or `windowEndsSoon` when fewer than `minMinutesLeft` minutes are left;
  - `quota`: `quotaLow`;
  - `dailyApiCap`: `dailyCapReached`, counted on its key's spend today.
- **Under the Workspace's daily cap:** for every `apiKey` candidate, `workspaceCapReached`.

A reading that is missing, stale or unknown, or a kind this Core doesn't
know, is unknown. Codex API-key spend is unknown too. The candidate's
`unknown` rule then decides: `skip`, the default, marks it `unknown`, and
`pass` lets it be chosen, with the unknowns kept as its reasons.

When none is chosen, `earliest` names the soonest time a reason gives
(`params.until`), such as the end of a time window or a quota's reset.

`POST /api/routing/evaluate` and `POST /api/routing/simulate` (below) use
this evaluator, with the readings as Core last observed them.

### Routing at dispatch (S3b2)

When the policy is on and the template is not `routing: "fixed"`, a
dispatch is routed:

- **A candidate is chosen in the dispatch's own transaction.** It reads the
  readings as Core last observed them, and gives the executor:
  - its harness, model and effort. Its permissions are the template's for that harness, else that harness's defaults;
  - its account or key: its runtime profile, set as soon as the executor exists and before it can start.
  A candidate that runs on this Core host only makes it run here. The record
  of why is kept on the dispatch (`route_json`), in `task_get` under
  `executorSlot.route`, and in `GET /api/routing/choices`.
- **When none can be chosen, the executor waits.** It is made with the
  harness of the first candidate that could run there, and stays in the
  queue while executors after it start. At each slot pass routing is read
  again, among the candidates of its harness only. The first that holds
  gives it its model, effort and account or key (`changedAtStart`), and it
  starts in turn. **An executor's harness is fixed at its dispatch.**
  If none ever could, it is released and starts in turn as it would without
  routing, on the host's own login: its route says `released`, with
  `routingOff` when routing was turned off, or `noCandidate` when no candidate
  it could be given is left: none enabled of its harness that is not excluded
  for it after a failed start and, while it waits on another machine, not this
  Core host's only.
- **A start that fails for certain** is rebuilt once, as before. The rebuild
  leaves out the candidate the failed executor was started with
  (`excluded`), so it tries the next one.
- **An executor already routed is not routed again at its start,** nor ever
  moved to another account once started.

### A real DeepSeek executor: the lab check (S3b3)

`routing_policy::e2e_tests` holds one ignored test that runs a real OpenCode
executor on DeepSeek through routing, in a lab Core: the test's own
Workspace, serving Core's routes on a free loopback port, so dispatch, the
slot pass, mail delivery and the executor's MCP are Core's own. It checks
that:

- the dispatch chooses the DeepSeek candidate, and the executor is OpenCode on `deepseek/deepseek-flash` with that key's profile;
- the key is in its own `opencode serve` (and what that started) and in no other process of the lab Core, Core's own included;
- its first turn, from the assignment's mail, completes, and its result is on the task;
- the turn's cost counts toward the key's day;
- no file of the lab Core but its key store holds the key.

It runs only in a lab Job, never against the daily Core. It needs:
- `YUZUNO_OPENCODE_BIN`, a real OpenCode 2.x;
- `YN34_DEEPSEEK_KEY_FILE`, a key file of 0600 that only the test reads, into the lab's key store;
- `XDG_CONFIG_HOME` and `TMPDIR` in a lab folder removed afterwards.

```sh
cargo test --locked --lib -- --ignored --exact --nocapture \
  routing_policy::e2e_tests::a_routed_deepseek_executor_does_one_real_turn_and_submits_its_result_with_its_key_in_its_own_process_only
```

### More routes in S3b

- `POST /api/routing/evaluate { policy?, at?, assume? }` answers one `route_json` with `at: "preview"`.
  - `policy` is an unsaved draft; by default, the saved one.
  - `assume` takes `{ accountsUsedUp: [fingerprint], codexUsedUp: [home], spendCapReached, onePasswordDown }`.
    A Codex home assumed used up fails its quota condition even before Core has a reading of it; a claude-swap account is known only from a reading.
- `POST /api/routing/simulate { policy?, from, to, stepMinutes, assume? }` answers `{ segments: [ { from, to, chosen } ] }`. It keeps the current readings and varies only the time.
- `GET /api/routing/choices?limit=20` answers `{ choices: [ { dispatchId, taskId, agentId, executorName?, route } ] }`, newest first. `executorName` is there while the executor's record is kept.
