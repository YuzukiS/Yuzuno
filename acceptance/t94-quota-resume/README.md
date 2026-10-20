# T-94: continue automatically after a Claude usage limit resets

When Claude's usage limit stops a Claude agent, Yuzuno can wait for Claude's
reset and then send one message to continue the task in the same session.
This is off by default.

## Claude Code's own setting does not apply

Claude Code has `autoContinueAtUsageLimit`. CLI 2.1.280 arms it only in an
interactive launch:
- its gate is `Wmt(){return id()&&!At()&&!Ut()}`, where `id()` is
  `launchOptions.isInteractive()`;
- `-p`/`--print`, `--sdk-url` or a stdout that is not a terminal makes a
  launch non-interactive.

SDK 0.3.296 starts the CLI with stream-json over pipes, so the setting never
arms in an SDK session, Yuzuno's included.

`native.py` finds each of these facts by its code shape in the installed
binary and SDK, and records its byte offset and the binary's sha256.

## What Yuzuno does (`core/src/claude_quota.rs`)

**Setting:** a workspace default, which starts off, and each agent's own
choice ("Usage limit" under *At a glance*).

**Arming:** one intent for a turn, only when all of these hold:
- the turn failed;
- it is the agent's latest turn;
- Claude's latest `rate_limit_event`, reported during that turn, says
  `rejected` with a `resetsAt`, and overage is not in use;
- the reset is at most 24 h away, as in Claude Code.

Network, API and other failures arm nothing. So does a limit without a reset
time; no time is guessed.

**Timing:** the continue goes 60 s after Claude's reset. Agents of one
account waiting for the same reset go 30 s apart.

**Sending:** one fixed message, marked `[Yuzuno · automatic continue]`, goes
through the ordinary message path with client message id
`quota-resume-<intent>`. A restart or a second timer therefore never sends it
twice. A send that a stop of Core interrupted is settled from that message's
receipt.

Nothing earlier is sent again. Approvals still ask. The account, the model
and overage are never changed.

**Checked again just before sending.** It is cancelled instead when:
- the setting is off;
- the agent is closed or deleted;
- its session changed;
- anything newer than the stopped turn exists, such as the user's input;
- an earlier message's delivery is unconfirmed.

"Don't continue automatically" also cancels it.

**Limited again:** a continue that the limit stops again is armed once more,
only for a later reset, up to 3 attempts in all. A "Continue now" that Claude
refuses before the reset was the user's own try: the automatic continue waits
again for the reset Claude reported, as the same attempt.

## Live lab

```sh
YUZUNO_LAB_CORE=<candidate Core> YUZUNO_LAB_WEB=<candidate web/dist> \
  python3 acceptance/t94-quota-resume/live.py <empty lab folder>
```

An account's limit is never run into on purpose.

**Scripted phase:** the candidate Core and web run over the Core tests'
scripted SDK. It reproduces the limit as CLI 2.1.280 reported it on
2026-10-17. Checks:
- the notice and the agent's row, light and wide, and dark and 390 px wide;
- "Don't continue automatically" pressed with the keyboard;
- a continue due in a few seconds while the lab Core stops and starts again:
  it is sent exactly once.

**Real phase:** one turn of real Claude Code (`haiku`) with automatic continue
on. Checks:
- the real `rate_limit_event` arrives during the turn, with the fields the
  check reads;
- a completed turn arms nothing.

The daily Core, its web and `~/.claude/settings.json` are compared before and
after.

## Results

**Native, `evidence-c2c2286-native.json`** (Job 3ea9c6cc): Claude Code 2.1.280 (sha256 `1e08503d…`) and SDK 0.3.296. Every fact was found:

| Fact | Byte offset |
|---|---|
| setting | 191231130 |
| `isInteractive` check | 190400213 |
| gate | 203610503 |
| arms only on rejected with a reset | 203610877 |
| non-interactive launch | 192668682 |
| SDK stream-json args | sdk.mjs 1144700 |

Conclusion: the setting cannot arm in an SDK session.

**Live lab `evidence-c2c2286`** (Job 3ea9c6cc): 11 passed, 0 failed.
- **Candidate:** c2c2286, Core binary sha256 `7b1126cf…`.
- **Gate:** the lab ran only after these passed in the same Job:
  - Core: lib `claude` 88, and integration `claude_quota_resume`, `claude_history_backfill` and `claude_session_import`;
  - web: typecheck and `quota-resume-ui` 4/4;
  - bridge 72/72.

| Check | Observed |
|---|---|
| Waiting | A stopped turn waits: `resetsAt` from Claude, `dueAt` = reset + 60 s, attempt 1 |
| Notice | Says the limit, the reset, about when it continues, that nothing is sent again and that approvals still ask; offers "Continue now" and "Don’t continue automatically" |
| Row | "Usage limit" shows the agent's own choice |
| Dark, narrow | Dark theme applied (`data-theme`), 390 px wide, no overflow |
| Cancel | "Don’t continue automatically", pressed with Enter: state `cancelled`, reason given, no buttons left |
| Restart | Continue due in 12 s; nothing sent before the lab Core stopped. After it started again: exactly one `[Yuzuno · automatic continue]` message in the same session, intent `sent`; still one a few seconds later |
| Real event | One haiku turn. Claude's `rate_limit_event` (`allowed_warning`, `seven_day`, `resetsAt` 1792699200, no overage) was recorded 761 ms after the turn started, so it counts as reported during the turn |
| Real quiet | A completed turn with automatic continue on: no stop, no intent |
| Daily | 4317 listener (pid 1880103), daily web/dist and `~/.claude/settings.json` unchanged |

The c2c2286 screenshot cut off the row's select ("Continue after the r…"). c8dd9f9 shortens the labels and lets the select fill its cell; it changes CSS, labels and the lab only, and `core/` and `runtimes/` are unchanged.

**Recheck `scripted-c8dd9f9`** (Job 3a8f7db0): 9 passed, 0 failed.
- Ran with c2c2286's Core binary (`7b1126cf…`), reused only after checking that `core/` and `runtimes/` are identical, and a fresh web build.
- Web typecheck, `quota-resume-ui` 4/4 and bridge 72/72 passed first.
- Every scripted check passed again, plus a new one: the chosen "Continue after reset" fits its box.
- The paid real phase was not repeated (`YUZUNO_LAB_SKIP_REAL=1`); its Core code is unchanged.
