# T-69 acceptance: the yuzuno skill

The skill is `.agents/skills/yuzuno/` (one source). `.claude/skills/yuzuno` links to it. Maintenance rules are in its `references/maintenance.md`.

- `python3 scripts/check_agent_skills.py [--codex]` checks the format, the links and the Claude link. CI runs it through `scripts/test_agent_skills.py`. With `--codex`, it asks the installed Codex app-server what it discovers; that is not a model call.
- `session_probe.py` shows when added skills and edited skill text reach a running, resumed or new session.
- `skill_eval.py` forward-tests a few decisions. It runs realistic requests through Claude Code or Codex against `fixture_mcp.py`, in a throwaway repository, with and without the skill, and grades the tool calls made.
  - The fixture is a stand-in for Core's `yuzuno` MCP server. Its tool descriptions are read from this checkout's Core source, and every call is answered with canned results. Nothing reaches a real Core, GitHub or Jobs.
  - The runs call paid models; they are not a gate.

## Discovery (Codex 0.162.1, Claude Code 2.1.280, 2026-10-16)

- **Codex:** `skills/list` on a throwaway repo found skills under `.agents/skills` and `.codex/skills` at the Git root, from the root and from a subfolder, with scope `repo`. It did not find `skills/` or `.claude/skills`. User skills come from `~/.agents/skills`. From this worktree it finds `yuzuno`.
- **Claude Code:** the session's init event listed `yuzuno` through the `.claude/skills` link in every with-skill run below, and in none of the without runs.
- **Yuzuno's Claude bridge:** it uses `settingSources: ['user', 'project', 'local']`, so Workspace Agents load project skills.

## When changes take effect

`session_probe.py` asked "which probe- skills do you have, and what is probe-a's answer word" before and after adding `probe-late` and changing probe-a's word from APPLE to BANANA.

| Session | Sees probe-late | Answer |
|---|---|---|
| Claude, same live session, next turn (Haiku 4.5) | yes | BANANA (it invoked the skill again) |
| Claude, resumed in a new process | yes | BANANA |
| Codex, same live app-server thread, next turn (gpt-6-astra, low) | yes | APPLE (kept the text read before) |
| Codex, `exec resume` | yes | APPLE |
| Codex, new thread | yes | BANANA |

A new skill reaches running sessions on their next turn. Changed text reaches a session only when it reads the file again, so changes that matter to running work must be pointed out to the Agents concerned.

## Forward-test

Models: Claude Sonnet 5 and Codex gpt-6-astra at medium effort. Each request plays the role of a dispatch for task T-7.

| Request | Claude + skill | Claude without | Codex + skill | Codex without |
|---|---|---|---|---|
| Check the branch and working tree | pass: git directly | pass | pass | — |
| Run the 10-minute test suite | pass: `job_budget`, `job_submit`, no polling | **fail**: ran `cargo test` directly 4×, then asked for approval | pass | **fail**: polled `job_get`/`job_logs` 4× |
| Start the review for a pushed PR | pass: `review_list`, `review_start`, `ci_subscribe` | pass | pass | — |
| `review_start` timed out | pass: `review_list`, no new run | pass | pass: same `requestId` | pass: same `requestId` |
| "Check with GitHub now", no `ci_refresh` | pass after the fix below | **fail**: "had Yuzuno check directly with GitHub" | pass | pass |
| Report the finished work | pass: `task_submit_result`, status review, `dispatchId`, no `peer_send` | pass | pass | pass |

Runs:
- Job e91b7a0b ran all scenarios on 04b35cb.
- Job 4a37bdd7 re-ran the last two rows on c39f691; c39f691 changes only the entry's CI line.
- Job 2def325b ran on e20cb9c and was the Codex half of the first pass.

### Changes the runs led to

- **Sonnet skipped the skill for the test suite.** It ran the suite directly, because the first description did not name long or heavy commands. The description now names the decisions the skill covers, and the same request went to a Job.
- **Claude claimed a fresh GitHub check.** With only `ci_get`, it said it had "checked with GitHub just now", because the entry had said `ci_get` or `ci_refresh` "to look now". The entry now says what each returns and asks for CI state to be reported with its observation times.
- **Review R1 corrected that wording.** The first fix called all of `ci_get` "Core's last observation". In fact its run is the stored observation, but its jobs/steps page is read through a short shared cache and may be newer. The entry, the delivery reference and the fixture now say so: in the fixture the page carries its own, newer time.

### Harness problems found and fixed

- **Transcript parser:** it failed on non-message stream events.
- **Fixture task:** it did not match some requests.
- **"Report the finished work":** the fixture's CI and review records first contradicted the request. Claude with the skill checked them and declined to report a clean result, which is the wanted behaviour; it was graded as a failure until the fixture was corrected.
- **Grader:** it missed the phrase "check directly with GitHub". The table uses the corrected grader, re-applied to the saved replies.

### Limits

- **Few runs:** one run per cell, so this shows decisions, not rates.
- **Not a real Core:** the fixture shows what an Agent attempts, not what Core then enforces. Core still enforces admission, idempotency and permissions on its own.
- **Untested here:** remote Agents, and older Cores beyond a missing `ci_refresh`.
