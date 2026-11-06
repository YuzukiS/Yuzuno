# Agent kinds, Project leads and executor templates

Yuzuno is moving towards an executor model. A Project has one or more lasting
**leads**. For each task, Core will start an **executor**, an Agent made for
that one task from a template. A limited number of executors run at once.
Each executor's result goes back to the lead through the existing dispatch
and result flow. Review stays with Core, and the lead releases the executor
when the work is accepted.

The model arrives in phases. Phase 0 is in place: it marks what kind each
Agent is and lets you choose a Project's leads. Phase 1 is arriving: you
can keep executor templates and dispatch a task from one, Core creates its
executor, and once its work is accepted its dispatcher or you release it.

## Kinds

Every Agent has one kind:

| Kind | Who makes it | What it is |
| --- | --- | --- |
| **standing** | You | An Agent you created, as every Agent was before. This is every Agent with no other kind. |
| **lead** | You mark it | A standing Agent you chose as a lead of its Project. |
| **executor** | Core | An Agent made for one task by a [dispatch from an executor template](#dispatching-from-a-template). |

- **Where it shows.** The sidebar shows a **Lead** or **Executor** label under
  the Agent's name. Agents see each Agent's kind in `peers_list` (`lead`,
  `executor` or `standing`), and can list only one kind with its `kind`
  filter.
- **How it is stored.** Core keeps the kind in a table of its own,
  `agent_roles`, not in the Agent's record. Older Core builds rewrite an
  Agent's record with only the fields they know. Kept apart, a kind survives
  an older Core opening and changing the Agent, as an Agent's Project
  membership does. Deleting an Agent removes its kind with it.

## Leads

You choose a Project's leads in its settings, under **Leads**. Only open
Agents in that Project can be chosen, and an executor cannot lead.

- **Who can set them.** Only you, through `PUT /api/projects/{id}/leads`. The
  request is `{expectedVersion, leadAgentIds}` and the answer is
  `{version, leadAgentIds}`. No Agent tool sets leads, so an Agent cannot
  make itself or another a lead.
- **Saving.** A save replaces the whole list. An Agent left out stops being a
  lead. A save against a list someone else changed meanwhile is refused.
- **A lead belongs to its Project.** Core keeps which Project an Agent was
  chosen to lead. It leads that Project only while it is a member there, and
  never leads a Project it is moved to.
- **Moving a lead.** When Core moves a lead to another Project, or out of every
  Project, its mark ends. The list it left changes version, so a settings page
  still showing the old list reloads before saving.
- **An older Core's move.** Such a move leaves the mark in place, but it
  applies only if the Agent returns to the Project it was chosen for.

A lead can dispatch a task of its own Project from an executor template.
You can always dispatch from a template. A task in no Project is dispatched
from a template by you only.

## Executor templates

A template says what an executor is made of. You keep the Workspace's
templates in Settings, under **Executor templates**, and a Project's own in
its settings.

| Field | What it is |
| --- | --- |
| **Label** and **Id** | How the template is shown, and how a dispatch names it: lowercase letters, digits and hyphens. A new template's id follows its label, or is `template-1`, `template-2` and so on for a label without Latin letters or digits. |
| **Harness** | Codex, Claude Code, or OpenCode where this Core creates OpenCode Agents. If OpenCode is turned off later, its templates are kept and can still be edited, but no new one can be added, and a dispatch from one is refused. |
| **Model**, **Reasoning effort**, **Permissions** | As for a new Agent. Left unset, the template inherits the defaults for new Agents, the Project's and then the Workspace's. A model it names is checked against this Core host's catalog when you save. Codex takes a reasoning effort; Claude Code keeps each Agent's own. OpenCode uses its own configuration's model and permissions. |
| **Name** | The executor's name. `{task}` is the task's ID and `{label}` the template's label; empty is `{task} · {label}`. |
| **Instructions** | Up to 8 KiB, given to the executor with its task: in its dispatch's materials (`task_get` with the dispatchId, under `template`), and in its mail when they are at most 2,000 bytes; longer, the mail says where to read them. |
| **At most at once** | At most this many of the template's executors run at once, a whole number from 1 to 64; empty, it has no limit of its own. See [Executors at once](#executors-at-once). |

- **Which template a dispatch gets.** A dispatch of a task in a Project uses
  that Project's template of the named id, else the Workspace's. A task in no
  Project uses the Workspace's.
- **Where executors run.** On the machine the dispatch names, else the one
  its template names, else this Core host. A machine is one from the
  Machines list, or `auto`, for Core to choose one at each dispatch (see
  [Which machine](#dispatching-from-a-template)). OpenCode executors run on
  this Core host only, and a Codex executor can't run on a machine that
  keeps its Agents contained.
- **Who changes them.** Only you. Saving replaces the whole list, and a save
  against a list changed meanwhile is refused, so the page reloads first.
  Removing a template, or a Project, changes no executor already made.
- **After a newer Core.** Templates and fields that a newer Core saved and
  this one can't read or use, such as another harness or machine, are not
  shown or offered to a dispatch, and a save here keeps them as they were.
  The page says how many such templates the list holds.

## Dispatching from a template

To dispatch a task from a template, give `executor: {templateId}` instead of
`toAgentId` in `task_dispatch`, or choose **From a template** in the task's
**Dispatch** form. Core then:

1. **Checks** the task's version, that it is not archived, who is
   dispatching, and the template. Nothing is written before these pass.
2. **Creates the executor**, as **New Agent** creates an Agent. It is made
   from the template, in the task's Project, and named by the template's
   pattern. On this Core host it works in the dispatch's worktree when that is
   a folder here, else in the Project's folder here. On another machine it
   works in the Project's folder on that machine; a dispatch there that
   carries a worktree is refused, since a worktree is a path on this Core
   host. Core makes no folder: with none, the dispatch is refused. When an Agent dispatches, that folder
   must be the worktree you registered on the task or lie inside the
   Project's folder; any other is refused, since a path an Agent gives, in a
   dispatch's or a task's materials, is information, not permission. Your own
   dispatch may name any folder. An Agent's task_update that re-sends
   materials becomes the latest registrant, so a worktree you registered
   outside the Project's folder is refused for that Agent's template dispatch
   until you register it again or dispatch it yourself.
3. **Dispatches the task to it**, as a dispatch to an existing Agent does. The
   result goes back to whoever dispatched.
4. **Queues it.** It starts when a slot is free; see
   [Executors at once](#executors-at-once). The dispatch's mail is delivered
   once it is connected.

- **Who may.** You, or a lead of the task's Project. A task in no Project,
  only you.
- **The answer** is a dispatch's, with `agentId`: the executor.
- **A retry** with the same `requestId` gets the same executor and answer, and
  never makes a second executor. The same `requestId` with another payload is
  refused. If Core stopped after dispatching, the executor waits in the
  queue and starts in turn.
- **When it fails.** If a dispatch fails after its executor exists, Core
  closes the executor and keeps it, so you can see what happened. A retry gets
  the same failure; dispatch again with a new `requestId`. If Core stops
  during a dispatch, it fails the dispatch and closes its executor when it
  next starts, before any Agent's runtime starts.
- **During an update.** While Core prepares an update, a dispatch from a
  template is refused, because creating an Agent waits for the update. A
  dispatch to an existing Agent is not refused. Retry the same request once
  the update is done: one that had not been made goes ahead then, and nothing
  was written for it before. A retry of one already made is refused during
  the update too, and gets its recorded answer after it.
- **Which machine.** A dispatch's `machineId` names a machine from the
  Machines list, `local` for this Core host, or `auto`. Left out, the
  template's machine holds, else this Core host. A machine that isn't
  registered, or can't run the template's harness, is refused before
  anything is written.
- **`auto`.** Core chooses the machine when it dispatches, from this Core
  host and every registered machine that can run the template's harness and
  where the task has a folder: its Project's there, or on this Core host a
  worktree. A dispatch that carries a worktree, a path on this Core host,
  runs on this Core host. Of those, in order:
  1. one with a free executor slot (its own limit not reached);
  2. the most spare memory of its Jobs budget (the budget less what Jobs
     reserve now); one with no budget comes after every one with one;
  3. the most spare CPU;
  4. this Core host;
  5. the name.

  The dispatch keeps the choice: which machine, and every candidate's
  numbers or why it was left out. The task's card has it, as `task_get`'s
  `executorSlot.choice`, so the order can be read again from those numbers
  alone. The template, and the dispatch's own request, keep `auto`. With no
  machine to choose, the dispatch is refused, naming each machine and why.

## Executors at once

At most this many executors run at the same time in the Workspace: 3 unless
you change it, a whole number from 1 to 64, in Settings under **Executor
templates**. A Project can have a limit of its own, on its page, and so can
a template (its **At most at once**) and a machine (this Core host included,
`PUT /api/machines/{id}/executor-slots`); left empty, only the Workspace's
applies. Only you change them. Lowering a limit under the executors running
there stops none of them: no more start there until fewer hold a slot.

- **The queue.** An executor dispatched while every slot is taken waits.
  Core starts the next one as soon as a slot is free, in the Jobs queue's
  order: any waiting more than 30 minutes first, then Projects in turn, each
  Project's in the order they were dispatched. Executors in no Project take
  their turn together. One whose Project or template is at its own limit is
  passed by the next that has room. A Project's own template of an id has
  its own limit; a task in a Project without one uses the Workspace's
  template, and counts with it.
- **What the task shows.** Its card, and `task_get` as `executorSlot`, say
  whether its executor is queued, with its place (`position`, 1 first),
  starting (with `reason` when its start did not finish), or running.
- **Holding a slot.** An executor holds its slot from when it starts until
  it is closed, by anyone and in any way. A disconnect keeps it, so
  reconnecting never passes the limit. Closing one frees its slot for the
  next.
- **Connect on a queued executor** is refused, with its place in the queue,
  and changes nothing about it. To run more at once, raise the limit: the next
  ones start right away.
- **A start that fails.** A start fails when the runtime refuses it, or
  when it doesn't finish within the **start time limit**: 300 seconds unless
  you change it, 30 to 3600, set beside Executors at once. Core then closes
  the executor, keeps it, and rebuilds it once. The rebuild is a new dispatch
  of the same request by the same dispatcher. Its executor keeps the first
  one's place in the queue and works in the same folder. If that one fails
  too, or Core can't make the rebuild, Core blocks the task with every
  reason, and a dispatching Agent gets one mail. A start cut off by the time
  limit counts as failed only when closing the executor confirmed its
  runtime stopped.
- **On another machine.** Neither a cut-off nor the runtime's refusal
  stops anything there, so a failed start counts as failed only when nothing
  was launched there, or a stop confirmed it ended. Before Core asks the
  machine to launch the runtime, it records that it is asking. A start that
  failed before that (the tunnel or the queue refused it) launched nothing.
  Once it asked, for Codex the stop must confirm the runtime instance the
  start recorded, and a start with none recorded has nothing to confirm. For
  Claude Code, the host instance the start recorded must confirm, through
  this start's own connection to it, that it stopped the bridge; one with no
  instance recorded, or no such connection, has nothing to confirm. Anything
  less holds the executor, as when Core can't tell. A rebuild is made on the
  first executor's machine, also one `auto` chose; that machine gone, the
  rebuild is refused, and the task is blocked.
- **Its record goes with its close.** Closing a failed executor records, in
  the same write, why it failed and that it is being settled. The close and
  the record are saved together or not at all: if the record can't be saved,
  the executor stays open and keeps its slot, as when Core can't tell, with
  one mail. Once saved, a pass, or the next start after a restart, makes the
  rebuild or blocks the task. A rebuild that meets an update draining waits for it,
  with no block and no mail: the first pass after the update makes it. So
  does one whose task changed while Core dispatched it: the next pass makes
  it. A change Core meets later, once the rebuilt executor exists, fails that
  dispatch and blocks the task.
- **When Core can't tell.** If Core can't tell whether a start happened
  (its runtime may be running), the executor stays open and keeps its slot.
  Its card says its start did not finish, and why, and a dispatching Agent
  gets one mail. Core neither closes nor rebuilds it, so two executors never
  work in one folder: connect it to check, or close it to free its slot. A
  reopened executor whose start fails stays open the same way. So does one
  the time limit cut off: it keeps its slot, with the reason, until you close
  it.
- **The first dispatch** reads as superseded once its executor is rebuilt:
  `task_get` with its `dispatchId` says by which dispatch, and why. A retry
  of its `requestId` still gets its recorded answer.
- **After a restart.** An executor that was starting waits again, at its
  place; one that may have started keeps its slot, and so do running ones.
  Executors open from before this version each hold a slot, as running. A
  failed start Core was settling when it stopped is finished: its close
  carried its record, so the first pass makes the rebuild. A record left
  without a close by an earlier Core goes, and that start waits again. A rebuild whose dispatch was under way blocks its
  task, "Core restarted while it rebuilt" it, unless that dispatch was made.
- **Executors only.** Standing Agents don't count, and Jobs keep their own
  machine slots.

## Releasing an executor

Once an executor's work is accepted, it is released: Core closes it for good.

- **Who.** The Agent that dispatched it from a template, or any lead of its
  task's Project, with `executor_release`, or you, with **Release executor**
  in its actions (**Manage…**). A lead of another Project is refused with
  `not_project_lead`, naming both Projects; anyone else with
  `not_dispatcher`, and a standing Agent or a lead with `not_executor`.
- **Setting its task done releases it too,** when its dispatcher, a lead of
  its Project or you set it. An executor can't set its own task done.
- **While its work is still going, it is archiving.** A Job of its still
  running, its delivery flow under way, or a pull request operation of its
  in flight: the release waits for it, and its answer's `archiving.reason`
  says what it waits for. Meanwhile Core stops the executor's CI watches
  (what they saw stays), holds its queued Jobs (they are refused once it
  closes, saying it was released), and it starts nothing new: `job_submit`,
  `job_run_submit`, `ci_subscribe`, `github_pr_submit`, `review_start` and
  `delivery_enable` are refused with `executor_archiving`. It can still
  report with `peer_send`, `task_comment` and `task_submit_result`. Core
  closes it within seconds of the last of that ending, and after Core
  restarts too. A close that can't be confirmed (a remote one) is tried
  again, after a wait that doubles up to five minutes, with the error as the
  reason.
- **What it does.** Its runtime stops as on Close, and its slot goes to the
  next executor waiting. Its live Home sections and Asks become its
  dispatcher's, as a claim would make them, so your replies and their
  resolve go to the dispatcher. One you dispatched keeps them, and so does
  one whose dispatcher is closed: they stay orphaned, for an editor to
  claim, and a reply to one is refused, sending nothing, until someone
  does. Each task status proposal it left undecided is mailed to its
  dispatcher if that dispatcher is open; otherwise you decide it. Its history's close says it was a release, and who
  made it. The close, the release and the slot are one change: all of it
  happens, or none of it. An executor that was already closed is only marked
  released. Who released is on the executor (`releasedBy`); an executor
  closed before its release keeps its earlier close in its history.
- **It stays closed.** A released executor is not reopened: Reopen is
  refused with `executor_released` and isn't offered. For new work, dispatch
  the task again. You can still delete it.
- **What stays.** Its task, its dispatch and its result are as they were.
  Releasing is not accepting the work; the dispatcher records that on the
  task.
- **Again.** Releasing a released executor answers with the same
  `releasedAt`.
- **During an update.** A release is refused while Core prepares an update,
  as Close is. Release it once the update is done.

## What an executor starts with

An executor starts cold, with no memory of the Project. Besides its task's
materials and its template's instructions, a dispatch from a template gives it
two more things. Both are in its dispatch's materials (`task_get` with the
dispatchId). The mail says where to read them; it doesn't hold them.

- **The Project's handover document** (`handover`): what the Project already
  knows, in Markdown, up to 32 KiB of text: line breaks (LF or CRLF) and
  tabs, but no other control characters; a save with one is refused at its
  line and column. You keep it in the Project's settings,
  under **Handover**, and a lead can propose a version for you to approve
  (below). Each save is a new version, kept with who wrote it and
  why, and a save against a document that changed meanwhile is refused. The
  settings page lists the versions and shows any past one. A Project's
  document goes with it when the Project is deleted. An archived Project's
  document can't change.
- **Core's summary of the task so far** (`contextSummary`): at most 4 KiB,
  written by Core from what it holds, in this order:
  - the latest result;
  - the newest comments' first lines;
  - each linked pull request, as last observed, with the P0–P2 findings
    of its latest completed review.

  Nothing in it is read again from GitHub or a model.

A dispatch to an existing Agent gets neither; that Agent already has its own
context.

### A lead proposes, you decide

A lead of the Project can propose a new handover document; nothing changes
until you approve it on Home.

- **Reading and proposing.** Agents of the Project read the document with
  `handover_get`. A lead proposes a whole new document with
  `handover_propose`, against the version it read. The same rules apply as
  for a save: 32 KiB of text, and a proposal on an older version is refused
  with the current one named. An executor never proposes, and no Agent tool
  approves.
- **One at a time.** A Project has at most one proposal waiting. A lead's new
  proposal replaces its own waiting one, which is kept as superseded; another
  lead's is refused until you decide, naming whose waits and since when.
- **Waiting on you.** A waiting proposal shows in Home's **Needs you**, named
  by its lead. That lead counts as waiting on you in the attention order,
  Ctrl/⌘+J goes to the proposal, and it is in the title's count, the system
  notification and push. On Home its card shows the reason and the changed
  lines.
- **Your decision.** Approve, and it becomes a normal version, written by the
  lead and approved by you, with the lead's reason; the history shows both.
  Reject, and nothing changes. Either way, one mail tells the lead, with your
  note (up to 1,000 bytes). Both are checked against the document you read
  and the proposal: a proposal made on a version you have since replaced
  can't be approved, and its rejection tells the lead to propose again on
  the current version. A decided or replaced proposal leaves Needs you at
  once.

A dispatch's materials are at most 128 KiB, counting only what the dispatcher
can shorten: the task's own materials and the dispatch's. The template, the
handover and the summary are not counted, since each has its own limit
(instructions 8 KiB, handover 32 KiB, summary 4 KiB). So a template dispatch's
materials are at most 128 KiB plus those three. Over the limit, the dispatch
is refused with `materials_too_large` and nothing is dispatched.

## What an executor doesn't do

An executor does its task and reports to the Agent that dispatched it. Two
things are not its to do:

- **Setting its own task done.** `task_update` to done, and a
  `task_submit_result` with status done, are refused with
  `executor_done_refused`, and nothing is written. It submits its result
  with status review, and its dispatcher, or you, sets the task done. Any
  other status is its to set.
- **Writing Home's content.** An executor is never a Home content editor.
  With no list chosen, every member but an executor edits; a list can't name
  one (`invalid_editor`), and one saved before doesn't make it an editor. It
  can still ask you its own questions, and what it wrote before shows with
  the team's sections.

## After an executor is released

A released executor takes no more mail or work:

- **Core's mail goes to its dispatcher.** A Job's, CI's, a review's or a
  pull request operation's result for it goes to the Agent that dispatched
  it. The mail names the executor it was for (`originalRecipient`) in its
  first line. An executor you dispatched has no Agent to pass it to: that
  mail is kept in the executor's mailbox, never dropped, where you can still
  read it. Either way the task's own records of the Job, the CI run or the
  review are written as always.
- **Other mail is refused.** Mail to it, and a dispatch naming it, is refused
  with `executor_archived`, naming its task and its dispatcher. Write to the
  dispatcher instead, or dispatch the task again for new work.
- **Its proposals are its dispatcher's.** A task status change it proposed
  with `result_publish` is decided by the Agent that dispatched it: the
  proposal shows who, and can't be decided there. You decide it if you
  dispatched the executor, or if its dispatcher is closed or no longer
  exists.

## Phases

| Phase | What it adds |
| --- | --- |
| 0 | Kinds and leads, as above. |
| 1 | Executor templates. A dispatch from a template makes the executor Agent, once per request, and its dispatcher releases it. |
| 2 | A limit on how many executors run at once, with a queue and one retry of a failed start. |
| 3 | Routing a released executor's late mail to the lead, and grouping executors in the sidebar. |
| 4 | Core merges an accepted pull request itself, with the same evidence as a manual merge. Its first release checks a released PR as a dry run ([merge queue](merge-queue.md)). |

Standing Agents keep working throughout. Tasks already in progress finish on
the Agents that hold them.
