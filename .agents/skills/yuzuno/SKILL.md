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

- To find work among many tasks, call `task_list` with `compact: true`: short rows without description, result or GitHub snapshots, with the same filters, counts and paging. Read the one you need with `task_get`.
- A task's ID is `T-<n>`, or, for a task in a Project, the Project's key and the task's number there, such as `YN-3`. Every key a task or its Project had still names it, and `task_get` lists them in `keys`. Use the IDs Core gives; the user sets a Project's key in the Projects window.
- A task is an outcome, not a turn. Read it with `task_get`: it answers with the task as it is now and its current delivery; page its history with `view: "activity"` and ask for `view: "full"` only when you need the whole record. When you were dispatched, read the fixed materials with `task_get` and the message's `dispatchId`, and keep that `dispatchId` for the result; never substitute a newer one.
- A Project's handover document is what an executor that starts cold is given: read it with `handover_get`. A lead that learns something lasting writes the whole document with `handover_update`, against the version it read, with an optional note of what changed; it is saved at once, and the Project's settings show the user who changed it last. Executors and other members only read it.
- Executor templates are the Workspace's. A lead reads them whole with `executor_templates_list` and `full: true`, and changes them with `executor_templates_change`, against the list's version it read and with a reason: it is saved at once, every dispatch from them uses it from then on, and the history keeps who changed each template and why. Executors and other members can't.
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
- Some of Core's notices are quiet (`wake: "quiet"`): they ask nothing of you, such as a PR merged while its executor still works. Where the connected Core has them, they never wake you; they come with your next wake-up, whose text counts them and gives a line a task of what they say, and `peer_read` with `wake: "quiet"` lists them. Failures, refusals, pauses, results and questions always wake you. To be woken by them after all, set `mail_preferences`: `mode: "all"` for every one, or `wakeForTasks` for a few open tasks (for example a merge a release waits for).
- After a lost reply, timeout or unknown result, repeat the identical call with the same `requestId`, or read the operation's state. A new `requestId` starts a new operation — for a review, a new paid round.
- Do not send receipt-only acknowledgements. Write to others with a question, a decision or a useful result.

## Delivering

Report what is true, in separate terms: result submitted, review passed, merged, deployed. Merged to the main branch does not mean running on the user's Core.

- Fix the candidate (commit, push, PR linked to the task with `github_links`) and get independent review plus CI for that exact head. If this task has an explicitly authorized `delivery_*` flow, submit its matching candidate and let it reuse the registered operations; otherwise start `review_start` yourself when the project authorizes it. Details: [references/delivery.md](references/delivery.md).
- `ci_subscribe` notifies you per completed run. `ci_get` returns the run as Core last observed it plus a jobs/steps page read through a short shared cache, each with its own observation time; only `ci_refresh` asks GitHub about the run now. Report CI state with those times rather than as "just checked".
- Submit with `task_submit_result`: exact commit, CI run, review identifier and conclusion, tests, known limits. Use status `review` unless you are told to report `done`. For a step of work that goes on (a plan awaiting approval, one slice of several), use `doing` where your schema offers it: the task stays in progress.
- If your result notifies the dispatcher automatically (a dispatched task and a `task_submit_result` that takes `dispatchId`), do not also `peer_send` the same news.
- A lead dispatches a task of its Project to a new executor with `task_dispatch` and `executor` instead of `toAgentId`: `executor: {}` makes a general executor from the defaults for new Agents, whose only instructions are the Project's handover and the task's materials; `executor: {templateId}` makes it from that executor template; `executor_templates_list` lists the Workspace's templates, each with when to choose it, its delivery mode and its steps. `executor.machineId` chooses where it runs, from `machines_list`; on another machine it works in the Project's folder there, which must exist. It starts when its machine has a free executor slot. Give the task a `shortName` first (`task_create` or `task_update`): what it is about in plain words, at most 16 characters, such as "Export settings", not a key or a number; the sidebar names its executor by it. Details: [Dispatching an executor](references/delivery.md#dispatching-an-executor).
- An executor at a gate step of its template asks for the approval with its own Home Ask that names it, `ask.gate: {taskId, step}`, or by mail to its dispatcher when the step's approver is the lead. Do not go past the gate before the answer; work that doesn't depend on it may go on. Details: [Gates](references/delivery.md#gates).
- Where the user has turned on the merge queue for the repository, the task's dispatching lead or the user releases the reviewed head with `merge_enqueue`; the executor doesn't. A head that adds, after its passing round, only clean merges of main or of other reviewed heads, changing nothing else, is admitted without a round of its own; a resolved conflict or any other commit needs a new round. Details: [Merge queue](references/delivery.md#merge-queue).
- Once the work is accepted, the lead that dispatched a task to a new executor, or any lead of the task's Project, releases its executor with `executor_release`; setting the task done releases it too. Releasing closes it for good and frees its slot, once its running Jobs, delivery flow and pull request operations have ended (until then it is archiving and starts nothing new). It does not accept the work, so record that on the task.

## Showing a result

- To show a table, chart, metrics, sections or sources in a conversation, put one `yuzuno-ui` fenced block in your reply. Write one sentence of plain text first, then the block: a JSON spec `{root, elements}` with `"root"` first and the elements in the order they are shown, the Result first. Yuzuno draws each element as it arrives and checks the whole block when it closes; a block that fails the check shows as text.
- At most one block per reply. It only displays. A form, a choice or a status change for the user goes to a Home Ask instead (see Keeping the Project Brief). Reply in plain text when a sentence will do.
- This topic's component list, below, has each display component's props, generated from the contract Yuzuno checks blocks with.

## Keeping the Project Brief

- Nothing requires a Brief update each Turn: update it when something changed. Read `brief_get` for your Project's `you.capabilities`; `keys: []` lists the sections without their bodies and `keys: ["plan"]` reads just those. Pass its `version` as `expectedVersion`. A report the user marks seen at its latest version leaves `brief_get`'s sections and your `ownsKeys` at once: `you.recentlyLeft` lists your sections that left lately, with why (`seen`, `removed`, `resolved`) and when, and putting a seen report again under its key continues it on Home. On Cores up to 2026.10.19-core.12, `requiresTurnUpdate:true` still asks for an accepted `brief_update` (or `noChange:true`) every Turn; follow what your connected Core reports.
- Where an outcome goes: a lasting finding, decision or stage result in a short report linked to its task and sources; the current state in a status; a choice for the user in an Ask. A `yuzuno-ui` block in your reply shows only in the conversation and never reaches Home. A content editor sees this as `homeHint` in `brief_get` and in task results it submits or receives: advice, not a request to write. A status past its `validFor` (`you.staleStatus`) is refreshed when there are new facts, not to look current. While a research conclusion still moves, keep it in a status; once a claim settles, write it as a report under its own key linked to its task (the user marks it seen and history keeps it), and let the status point to it. A status keeps only its current wording.
- A Project's leads edit its Home; the user chooses them (an Agent the user makes in a Project leads it). `editContent:false` with `writeOwnAsk:true` means Ask-only: submit valid Asks when you need an answer, maintain or resolve your own Asks, and you may remove your own older sections; reports and status are not yours to write. `writeOwnAsk:false` means read-only. Do not invent questions to satisfy a reminder. Internal progress and delivery belong in tasks and mail. Never grant yourself access.
- The tool descriptions and Core's rules are a summary. Before your first section in a session, read `brief_guide`: pass a `part`, or nothing for the whole guide. It has the section kinds, components, limits and errors, from the same contract Core checks sections with. It is the format; what to write is below.

### Write for Home

For regular content you own, select what helps the user understand the project or decide what to do. Do not turn the conversation, task log or delivery report into a Home card.

- Lead with the current understanding or outcome. Keep the first paragraph short: what changed, whether it can be used now and what needs the user, since it is what a reader sees first. An ordinary overview should be easy to scan in one screen: a short conclusion, the few active outcomes that matter, and any real decision. This is a default, not a fixed template or word limit; preserve conditions and uncertainty that change the meaning of a research finding.
- Choose components for the information: `Metrics` for a few useful values, `Plan` for stages with distinct states, `Findings` for conclusions and caveats with sources, and `Table` for an actual comparison. Use `Markdown` for short explanations and reasoning. Putting long Markdown blocks in columns does not make their information structured; do not invent numbers, percentages or stages to fill components.
- Choose the form for the information, unless the user or the Project has stated a preference: a real screenshot or a labelled sketch (say which) for a UI or layout change, a chart of measured values for quantities and how they relate, a short sentence for a single state. No fixed order of image, chart and text suits every card. A chart shows measured values with their sample beside it; an observation too small to support a conclusion is a limit to state, not a result to draw.
- Draw an interactive part only when the reader would do something with it: inputs with a `Calc` for a quantity they will scale or split, `Diagram` for a process that branches or loops, `Figure` for the parts of a thing in a picture, `Steps` for a procedure to follow, `Timeline` for three or more dated events. A single fact, a yes or no, a number or a task's state Core already shows is a sentence or a `LiveRefs` item, never a component. What the reader sets never reaches you; ask with an Ask when you need an answer. `brief_guide interactive` has the format.
- Give each fact one place. A deployed release, its feature list and a recovery result do not need to appear in the summary, focus and attention areas again. Move completed work out of current focus; retain only a useful recent change or a route to its details.
- Keep execution evidence on the existing task or result: run IDs, commit hashes, logs, full test counts and incident chronology. Link the few items a reader may want to inspect. State an important limitation inline when it affects the user's decision. Long rows of references are also content, not free space; give each a short label. Attach only what the user should look at (screenshots, sketches, the data a chart reads); logs, raw data and full test output stay on the task, linked with `LiveRefs`. To fit a limit, keep less in the section rather than splitting it into more cards.
- Keep project outcomes above delegated activity. A lead summarizes the work they manage; the Home overview need not enumerate every worker's status. With no pending user decision, omit an attention panel or use one quiet indication, rather than paragraphs explaining that there is nothing to do. Use an actual Ask when an answer is needed.
- Distinguish proposed, tested, merged and installed. Work waiting in a queue is stated neutrally, with what it waits for (behind an earlier merge, for main's CI), not as a blocker or a failure; in a `Plan`, a queued step is `todo` with what it waits for, not `blocked`. Separate a research interpretation from a planned experiment and from a live Job state. Use references to system records for execution state; never make an Agent's report look like a fresh measurement.
- Make layout express those priorities: a brief summary first, then related parts side by side where useful. `Group` and `Columns` arrange content; they do not replace selecting and shortening it. Layout uses only components from the connected guide, not HTML or CSS, and narrow windows stack columns in order.

A development overview might show the running release and two active outcomes; a research overview might show current understanding, unresolved evidence and the next experiment. Choose for the project and the user's stated interests, rather than copying either shape everywhere.

Three small shapes cover most other cards; `brief_guide examples` has each, as `result`, `compare` and `decision`:

- **Result**: what changed and whether it can be used now, in a sentence or two with its stage (tested, merged, installed) and the limit that matters, and a `LiveRefs` link to the task that holds the evidence.
- **Compare**: the answer in one sentence, then one chart or a short `Table` of measured values, with the sample and what it cannot show beside them.
- **Decision**: an Ask with the question, the options and what each costs, in a few lines; the background stays on the task. Several related answers go in one form, as in the `form` example.

### Ask for a review

To have the user review a document, a report or a design, ask with an Ask; `brief_guide examples` has this shape as `review`. A report holds only what is settled: the user's Seen mark takes it off Home at once, and Seen means read, not reviewed, so nothing still to decide (a name to choose, a draft to approve) belongs in a report.

- Attach what is to be reviewed (a PDF, a report file, a screenshot) to the Ask itself and show it in an `Attachments` block, so the user opens it from the Ask they answer.
- Offer the verdict, approve or needs changes, as `options` or a `choice`. A button sends its reply at once, and a reply is either a button or a form's answers, never both: when comments should come with the verdict, make the verdict a required `single` field of a form, with the same two options, instead of buttons.
- For comments on one place, give the form a text field for each section ("Section 1", "Section 2"; at most 8 fields in all). Home has no comments anchored inside a file or a block.
- `time.due` may say by when. Home shows it on the card as it is; nothing reminds the user, and nothing happens when it passes.
- When changes are needed, make them, then put the Ask again with the new version: that is the next round, and it returns to Needs you. Once the review is done, resolve the Ask yourself, as its author.
- A task in review waits for its dispatcher: Needs you lists a result only for an executor the user dispatched, and a lead's executors are the lead's to follow. When the user must accept a task themselves, its lead asks for that with an Ask.

### Maintain the section

- Before a block update, glance over the whole section for repetition and stale phases. Keep `status.asOf` aligned with the facts actually checked; changing the card's text does not refresh that observation time. Do not stamp unchecked facts as fresh. If nothing material changed, use `noChange` when permitted, instead of adding a progress paragraph merely because a Turn ended.
- Registering `attachments` saves or references files; it does not show them. Display a screenshot, sketch or other file the user should see in a reachable `Attachments` block whose `items` use their exact names. Charts consume data files through `data.attachment`; that alone does not show a file preview. Check the final body has the intended uses, even when only editing a block. `brief_guide attachments` has both examples and the connected Core's rejection/compatibility rules.
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
- A reply to a report or status card also arrives as an ordinary message. It names the Workspace, the Project, the section's key, the version the user saw and its title; the section may have changed since. It changes no ask, task or Seen mark, and there is nothing to resolve: answer it as you would any message, and change the section only if the reply calls for it.
- On a Core that still holds a Turn for a Brief update (up to 2026.10.19-core.12), re-read your capabilities: permissions may change during a session. When still required, make the update and end without another message. If a stale reminder conflicts with current Ask-only permission, do not write unauthorized content; report the mismatch through the task or requester.

## When the tools disagree with your instructions

A dispatch or message may mention a parameter or tool your session does not have, or your schema may predate the Core you reach after an upgrade. Trust what the Core accepts: read the current task or operation state, and if a required field is missing from your session, report the mismatch in progress or to the requester instead of working around it. A session can keep tool definitions it loaded earlier: Claude Code keeps them for the whole conversation, through a resume or reconnect. A Core that has the changes notice mails you what changed; see [references/maintenance.md](references/maintenance.md#when-changes-take-effect).
