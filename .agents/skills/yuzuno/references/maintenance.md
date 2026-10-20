# Maintaining the yuzuno skill

## Brief attachment references (source feature; requires a containing Core release)

New or replaced sections reject `unused_attachment` when a registered file is not used by a reachable `Attachments.items` entry or chart `data.attachment`. The error names the registration and gives a repair: add the body reference, use a supported chart data file, or remove the registration in a `put`. Files and layout are never automatically removed or rewritten.

Existing sections/history remain readable. Block edits check the final merged body and preserve already-unused legacy registrations, so an unrelated text update still works. Removing the last reference to a previously used attachment is rejected atomically; the old body, snapshots and Ask state remain. A full `put` checks all registrations. Read the connected Core's `brief_guide attachments`; an older Core may not enforce this rule.

## Home content editors (source feature; requires a containing Core/UI release)

The user can select a project's content editors. `brief_get` reports the caller's current capabilities: `editContent:false` with `writeOwnAsk:true` means Ask-only, allowing own valid Asks and optional noChange without a per-turn obligation. `writeOwnAsk:false` means read-only, including no noChange writes (for example, another project, an archived project or a closed Agent). Regular content from revoked authors stays in team details/history without being marked Seen. Asks and native approvals remain available. Running Claude Stop checks and Codex reminder dispatch re-read current permission. A missing capabilities field means the older Core's rules still apply; do not assume this source feature is deployed or that a particular project's editor list applies elsewhere.

## Codex account usage (source feature; requires a containing Core/UI release)

The Agent information panel can show account-wide Codex Plan usage and manually refresh it. These facts come from that Agent's connected native runtime, not its context/token meter or the local model catalog. Check source, observation time and reset deadline in Details. API-key, disconnected, unsupported or absent data is unknown/unavailable; an elapsed reset does not prove restored quota. Refresh is read-only and does not start a model turn, change limits or block execution. No new Agent tool is required. Do not infer this capability exists in an older installed Core from repository source alone.

For people changing Yuzuno or this skill. Ordinary task work needs only [When changes take effect](#when-changes-take-effect).

## Source and distribution

- There is one source: `.agents/skills/yuzuno/` in the Yuzuno repository. `.claude/skills/yuzuno` is a relative link to it. Do not keep a second copy for either Harness, or anywhere else.
- Core compiles that folder into its binary and serves it as the `yuzuno_guide` tool. Each `## ` section of SKILL.md and each reference file is one topic; `core/src/guide.rs` maps them, and its tests fail when a section or file has no topic. Links between the files become topic pointers. An answer names the Core release it comes from and the guide's revision, the SHA-256 of the compiled files.
  - An Agent in any project connected to that Core reads the guide of that Core's release, with no checkout and nothing installed. The yuzuno MCP server's instructions and each session's notice name the tool; neither carries the guide itself.
  - A release serves the text it was built from. A change here reaches Agents elsewhere only with the next Core release that contains it.
- Discovery of the skill itself, as tested with Codex 0.162.1, Claude Code 2.1.280 and Core 2026.10.16-core.5:
  - Codex reads `.agents/skills` (also `.codex/skills`) at the root of the Git repository that contains the session's working directory, from subfolders and worktrees too, plus the user folder `~/.agents/skills`.
  - Claude Code reads the project's `.claude/skills` and the user folder `~/.claude/skills`, following links. Yuzuno's Claude bridge loads user, project and local settings, so Workspace Claude Agents see project skills.
  - An Agent therefore gets the skill when its working directory is a checkout or worktree of this repository at a commit that contains it.
- Outside this repository nothing needs installing. If a user still wants a `yuzuno` entry in their own skill folders, it should only point at the tool, for example a `SKILL.md` such as:

  ```markdown
  ---
  name: yuzuno
  description: Working in a Yuzuno Workspace when its yuzuno MCP tools are connected.
  ---
  Read the connected Core's working guide with the yuzuno_guide tool: its overview first, then the topic you need.
  It matches that Core's release; each tool's schema in your session is the authority for its parameters.
  ```

  Yuzuno never installs, links or changes it, and the user decides. Do not link a checkout's folder there instead: the link follows that checkout's branch, not the Core the Agent is connected to.

## When changes take effect

Measured with `acceptance/t69/session_probe.py`, Claude Code 2.1.280 and Codex 0.162.1:

- **A skill added or removed:** a running session lists the change from its next turn. That held for a live Claude session, a live Codex app-server thread and a resumed Codex thread. New sessions always do.
- **A skill's text changed:** it is read when the model opens the skill. A session that already read the old text may keep acting on it: Codex did, in a live and in a resumed thread. Claude read the new text when it used the skill again.
- **Reaching running Agents:** when a change matters to running work, say so in the dispatch or message to the Agents concerned and ask them to re-read the skill, or to start a new session. Send a targeted note, not a broadcast.
- **When a change exists for an Agent:** only once its checkout contains the commit. Merging to main does not update other worktrees.
- **`yuzuno_guide`:** its answer is the running Core's guide, so after a Core upgrade the next call has the new release's text. A session started before its Core had the tool keeps the tool list and server instructions it loaded at start and does not see `yuzuno_guide` until it reconnects or a new session starts; the session notice is sent again on start and resume. This follows from how tool lists load and was not measured with the probe.
- **Tool schemas:** they come from the connected Core, separately from skills. After a Core upgrade, a running session can keep the schema it loaded earlier. If a tool rejects or lacks a field your instructions mention, the session needs to reconnect or restart; do not guess.

## What belongs here

- This guide covers how to use Yuzuno well: which tool to choose, how asynchronous work resumes, and what to report.
- It does not cover:
  - The tool catalog or parameters; the schemas are the source.
  - Project rules: review rounds, who merges, test commands, paths, budgets. Those live in project instructions.
  - Guarantees Core already enforces: permissions, identity, idempotency, admission.
- **Deployed capabilities only.** Describe what a deployed Core offers, and set `metadata.checked-against` to the release last checked. A capability merged but not yet deployed waits until it is; if older releases matter, say from which release it applies.
- **Workarounds.** A temporary workaround names when it applies and when to remove it. Remove it once the fix is deployed.
- **Corrections.** Fix a real misuse with the narrowest change. Do not add a rule per incident.

## Keeping it current

- A PR that changes what an Agent should do updates the relevant section in the same PR. That covers a tool's meaning, its notification, recovery, or recommended use. The PR template asks; "not applicable" is a fine answer, and refactors or styling need nothing.
- Reviewers check that the guide matches the behaviour the PR ships.
- `python3 scripts/check_agent_skills.py` checks the format, the links and the Claude link. CI runs it through `scripts/test_agent_skills.py`.
  - Add `--codex` to confirm that the installed Codex discovers the skill; this makes no model call.
- When a change touches a decision covered by `acceptance/t69/skill_eval.py`, run the affected scenarios. They call paid models, so run them deliberately; they are not a gate.


## Codex context window settings

Each Codex Agent can save its own context-window override and optional automatic-compaction threshold in Agent settings. A blank window inherits the native configuration/model default. With a custom window, a blank threshold follows 90% of that window, replacing any inherited lower threshold; native Codex still enforces its model limits and headroom. These are per-Agent settings, never edits to the global Codex config.

Saving does not change an already loaded thread's window. Use **Apply now** under Context window in the Agent settings while that conversation is idle: Core verifies native idle state, no pending approvals or uncertain sends, unsubscribes and resumes the same thread ID without stopping the app-server. A new empty conversation must finish its first turn before this reload, because native Codex may not have persisted a resumable thread yet. It never interrupts, forks or silently starts a replacement thread. A remote runtime that has not reported support refuses custom settings; a loaded remote resume alone is not proof the overrides took effect.

If native resume rejects an Apply, the app-server stays alive and the original thread remains pending recovery. Settings remain editable: save a corrected value or default, then reconnect to resume that same thread with the latest saved settings. A timed-out resume retains its original request until the outcome is known; reconnect checks that request without sending it again. Refresh context status shows whether reconnection is still needed.

If saved overrides prevent reconnecting after runtime capability loss, **Reset to automatic** (under Context window) remains available even when the model catalog cannot load. It only clears those two saved overrides, preserving the model, effort and permissions without contacting or restarting the native runtime. Reconnect when available to use native defaults.

An unconfirmed conversation rewind also blocks Apply, even when native history appears idle. Resolve or check that rewind first; applying settings never retries or dismisses it. Rewind's explicit **Keep current history** recovery preserves the Agent's context window, compaction threshold and reasoning effort when it reconnects.

The displayed usage denominator always comes from native `tokenUsage.modelContextWindow`, not the requested number. After requesting application it stays unknown until a new turn's native usage event. Resume can replay a cached window from before the settings changed, including after a Core restart; reconnect retains unknown or last-known usage until a new turn reports. When a surviving remote thread is already running, usage for the active turn confirmed in its resumed snapshot is accepted; replay from older turns remains suppressed. A resume acknowledgment means settings were submitted; another subscriber or native runtime restriction can keep the previous configuration. Model switching resets the editor's context overrides to automatic; save and apply that choice explicitly. Parameter acceptance does not establish the model provider's maximum context capacity.
