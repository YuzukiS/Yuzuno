---
name: yuzuno
description: How to work as an Agent in a Yuzuno Workspace when its yuzuno MCP tools are connected. Use before running builds, test suites, browsers or other long or resource-heavy commands, which may belong in a Job; when taking, delivering or reporting a shared task; when starting a review, CI watch or PR operation; when writing or updating a Project Brief section; and after a timeout, lost reply or mailbox notification.
metadata:
  short-description: Work in a Yuzuno Workspace
  checked-against: Yuzuno 2026.10.19-core.12
---

# Working in a Yuzuno Workspace

The Core you are connected to is the authority. Tool names, parameters and guarantees come from the tool schemas and results in your session; this guide says when to use which and how the steps connect. If a tool or parameter named here is missing from your session, that capability is not available to you now: do not simulate it or report it as available.

The connected Core also serves this guide, written for its own release, as the `yuzuno_guide` tool: an Agent in any project reads it there by topic, without a checkout of this repository.

Core enforces identity, permissions, idempotency, resource admission and state checks. This guide grants nothing and does not widen your task. Project conventions — review rounds, who merges or deploys, test commands, paths, machine budgets — come from your dispatch materials and the project's own instructions, not from here.

## Taking a task

- A task is an outcome, not a turn. Read it with `task_get`: it answers with the task as it is now and its current delivery; page its history with `view: "activity"` and ask for `view: "full"` only when you need the whole record. When you were dispatched, read the fixed materials with `task_get` and the message's `dispatchId`, and keep that `dispatchId` for the result; never substitute a newer one.
- Reading files, running commands, tests, retries and native sub-agents are execution of that task, not new tasks. Create a task only for a separate outcome someone else could own.
- You own the whole delivery, including its evidence. Keep the identifiers you produce (commit, PR, Job, review, CI run) and cite them in progress and in the result.
- When handling a conversation rewind or file restore, follow [references/rewind.md](references/rewind.md): native conversation history, files and external operations have separate outcomes.

## Direct command or Job

Decide by what the work needs, not by a fixed number of seconds.

For discovery, use the scoped, bounded `job_list`; it defaults to your own Agent. A known Job belongs in `job_get`. See [references/jobs.md](references/jobs.md#finding-a-job) for Project/Workspace scope and the separate history/live cursors. Do not list the whole Workspace merely to find your own work.

- Run directly: reads, searches, git inspection, small edits, quick checks you will wait for anyway.
- Submit a Job when the work needs queueing or a resource reservation (full builds, large test suites, browsers, benchmarks, batches of model calls), or should finish in the background and report through the mailbox. See [references/jobs.md](references/jobs.md) before your first submission in a session.
- A few dependent steps where one may start only after another truly succeeded (prepare, train, evaluate) are one run of stages, not a shell chain or a wait loop: see [references/jobs.md](references/jobs.md#runs-of-stages).
- Core admits Jobs within the shared machine budget. Do not broadcast "holding heavy work" to others or wait on each other by message.
- Keep preparation, result collection and notification inside the operation that needs them. Do not create an extra Job only to receive a mailbox notification.

For per-Agent Codex context windows, compaction thresholds and safe application to an existing conversation, see [Context window settings](references/maintenance.md#codex-context-window-settings).

## Asynchronous operations

`job_submit`, `review_start`, `github_pr_submit`, `ci_subscribe`, `task_dispatch` and similar tools return an identifier at once and continue in Core.

- Keep the identifier and finish your turn, or do independent work. The result arrives as a mailbox notification; read it with `peer_read` when notified. Do not poll, sleep or watch.
- After a lost reply, timeout or unknown result, repeat the identical call with the same `requestId`, or read the operation's state. A new `requestId` starts a new operation — for a review, a new paid round.
- Do not send receipt-only acknowledgements. Write to others with a question, a decision or a useful result.

## Delivering

Report what is true, in separate terms: result submitted, review passed, merged, deployed. Merged to the main branch does not mean running on the user's Core.

- Fix the candidate (commit, push, PR linked to the task with `github_links`) and get independent review plus CI for that exact head. If this task has an explicitly authorized `delivery_*` flow, submit its matching candidate and let it reuse the registered operations; otherwise start `review_start` yourself when the project authorizes it. Details: [references/delivery.md](references/delivery.md).
- `ci_subscribe` notifies you per completed run. `ci_get` returns the run as Core last observed it plus a jobs/steps page read through a short shared cache, each with its own observation time; only `ci_refresh` asks GitHub about the run now. Report CI state with those times rather than as "just checked".
- Submit with `task_submit_result`: exact commit, CI run, review identifier and conclusion, tests, known limits. Use status `review` unless you are told to report `done`.
- If your result notifies the dispatcher automatically (a dispatched task and a `task_submit_result` that takes `dispatchId`), do not also `peer_send` the same news.

## Showing a result

- `result_publish` is optional: use it only when a table, chart or short form helps more than text.
- Its description is only a summary, short enough for every supported native client to show it whole. Before your first result in a session, read `result_guide`. Pass the `components` you need, or nothing for the whole guide. The guide has each component's exact props, limits and rules, from the same contract Core checks results with.
- A rejection names the guide and the components its problems are in. Fix them and call again with a new `requestId`.
- To suggest a status change to an existing task, publish a `TaskStatus` component (task, status, reason). It changes nothing by itself: the user sees the task as Core reads it, may edit your proposal, and confirms or declines. Don't also change the task with `task_update`, and don't count a published proposal as the change.

## Keeping the Project Brief

- Nothing requires a Brief update each Turn: update it when something changed. Read `brief_get` for your Project's `you.capabilities`; `keys: []` lists the sections without their bodies and `keys: ["plan"]` reads just those. Pass its `version` as `expectedVersion`. On Cores up to 2026.10.19-core.12, `requiresTurnUpdate:true` still asks for an accepted `brief_update` (or `noChange:true`) every Turn; follow what your connected Core reports.
- Where an outcome goes: a lasting finding, decision or stage result in a short report linked to its task and sources; the current state in a status; a choice for the user in an Ask. `result_publish` shows only in this Turn and never reaches Home. A content editor sees this as `homeHint` in `brief_get`, in task results it submits or receives, and in `result_publish`: advice, not a request to write. A status past its `validFor` (`you.staleStatus`) is refreshed when there are new facts, not to look current.
- The user selects Home content editors per Project. `editContent:false` with `writeOwnAsk:true` means Ask-only: submit valid Asks when you need an answer and maintain or resolve your own Asks; reports and status are not yours to write. `writeOwnAsk:false` means read-only. Do not invent questions to satisfy a reminder. Internal progress and delivery belong in tasks and mail. Never grant yourself access.
- The tool descriptions and Core's rules are a summary. Before your first section in a session, read `brief_guide`: pass a `part`, or nothing for the whole guide. It has the section kinds, components, limits and errors, from the same contract Core checks sections with.

### Write for Home

For regular content you own, select what helps the user understand the project or decide what to do. Do not turn the conversation, task log or delivery report into a Home card.

- Lead with the current understanding or outcome. An ordinary overview should be easy to scan in one screen: a short conclusion, the few active outcomes that matter, and any real decision. This is a default, not a fixed template or word limit; preserve conditions and uncertainty that change the meaning of a research finding.
- Choose components for the information: `Metrics` for a few useful values, `Plan` for stages with distinct states, `Findings` for conclusions and caveats with sources, and `Table` for an actual comparison. Use `Markdown` for short explanations and reasoning. Putting long Markdown blocks in columns does not make their information structured; do not invent numbers, percentages or stages to fill components.
- Give each fact one place. A deployed release, its feature list and a recovery result do not need to appear in the summary, focus and attention areas again. Move completed work out of current focus; retain only a useful recent change or a route to its details.
- Keep execution evidence on the existing task or result: run IDs, commit hashes, logs, full test counts and incident chronology. Link the few items a reader may want to inspect. State an important limitation inline when it affects the user's decision. Long rows of references are also content, not free space: live references may display the full current task title instead of your short label.
- Keep project outcomes above delegated activity. A lead summarizes the work they manage; the Home overview need not enumerate every worker's status. With no pending user decision, omit an attention panel or use one quiet indication, rather than paragraphs explaining that there is nothing to do. Use an actual Ask when an answer is needed.
- Distinguish proposed, tested, merged and installed. Separate a research interpretation from a planned experiment and from a live Job state. Use references to system records for execution state; never make an Agent's report look like a fresh measurement.
- Make layout express those priorities: a brief summary first, then related parts side by side where useful. `Group` and `Columns` arrange content; they do not replace selecting and shortening it. Layout uses only components from the connected guide, not HTML or CSS, and narrow windows stack columns in order.

A development overview might show the running release and two active outcomes; a research overview might show current understanding, unresolved evidence and the next experiment. Choose for the project and the user's stated interests, rather than copying either shape everywhere.

### Maintain the section

- Before a block update, glance over the whole section for repetition and stale phases. Keep `status.asOf` aligned with the facts actually checked; changing the card's text does not refresh that observation time. Do not stamp unchecked facts as fresh. If nothing material changed, use `noChange` when permitted, instead of adding a progress paragraph merely because a Turn ended.
- Registering `attachments` saves or references files; it does not show them. Display screenshots/files in a reachable `Attachments` block whose `items` use their exact names. Charts consume data files through `data.attachment`; that alone does not show a file preview. Check the final body has the intended uses, even when only editing a block. `brief_guide attachments` has both examples and the connected Core's rejection/compatibility rules.
- Give each block an id that names what it holds (`progress`, `findings`) and keep it in every version. When only some blocks of a section you own changed, send `edit` with just those blocks by id: Core keeps the rest of the section (other blocks, their order, title, attachments, ask state), checks the whole section again, and a table the edit leaves alone keeps the filter and sort the user set. Use `put` to create a section or change its layout. If `brief_update` in your session does not offer `edit`, read the section and `put` it whole, under the same permission and owner rules. A `put` is not an edit: putting an ask again asks it again, even after a reply. If the tools and your instructions disagree, see below.
- The user may pin a status or report section to Home's widget column, and hide or reorder it there. That layout is theirs: keep the section current with `brief_update` as usual. There is no separate widget to publish, and nothing you send changes whether or where it shows. Asks are never pinned; an open Ask stays in Needs you until the user answers it.
- A rejection lists problems with the guide part to read. Fix them and call again with a new `requestId`; on `version_conflict`, merge with the `latest` it returns.
- Editor permission does not replace section ownership. Only a section's owner changes it; add your own sub-topic to another author's topic. An editor may claim an orphaned section in its own call, then change it in the next; Ask-only members cannot claim or convert old regular content into an Ask.
- The Brief does not replace your reply to the user.
- A reply from Home reaches you as an ordinary message quoting the section. The ask then shows as replied: it leaves Needs you, and `brief_get` lists it in `you.repliedAsks` until you resolve it. Nothing closes it for you.
  - Resolve a preference or an answer to a question once you have taken it in.
  - Resolve an action the reply authorizes only after that action is confirmed done, with its result on the existing task or a Brief section. A green CI or a finished task is not that action.
  - While the action runs, or after it fails, keep the ask replied and report progress on the task or Brief: `edit` keeps it replied, while `put` asks again. Ask again only when the user has something new to decide.
  - A reply executes nothing by itself. Act on what the user has authorized, an explicit reply included, without asking for it again; never infer a retry, merge or wider permission from an answer that does not grant it.
- On a Core that still holds a Turn for a Brief update (up to 2026.10.19-core.12), re-read your capabilities: permissions may change during a session. When still required, make the update and end without another message. If a stale reminder conflicts with current Ask-only permission, do not write unauthorized content; report the mismatch through the task or requester.

## When the tools disagree with your instructions

A dispatch or message may mention a parameter or tool your session does not have, or your schema may predate the Core you reach after an upgrade. Trust what the Core accepts: read the current task or operation state, and if a required field is missing from your session, report the mismatch in progress or to the requester instead of working around it. Native sessions load tool schemas and skills when they start or resume; see [references/maintenance.md](references/maintenance.md#when-changes-take-effect).
