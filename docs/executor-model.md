# Agent kinds, Project leads and executor templates

Yuzuno is moving towards an executor model. A Project has one or more lasting
**leads**. For each task, Core will start an **executor**, an Agent made for
that one task, from a template or as a general executor. A limited number of
executors run at once.
Each executor's result goes back to the lead through the existing dispatch
and result flow. Review stays with Core, and the lead releases the executor
when the work is accepted.

The model arrives in phases. Phase 0 is in place: it marks what kind each
Agent is and lets you choose a Project's leads. Phase 1 is arriving: you
can dispatch a task to a new executor, a general one or one from an executor
template you keep, Core creates it, and once its work is accepted its
dispatcher or you release it.

## Kinds

Every Agent has one kind:

| Kind | Who makes it | What it is |
| --- | --- | --- |
| **standing** | You | An Agent of yours that leads no Project: one in no Project, or one you removed as a lead. This is every Agent with no other kind. |
| **lead** | You, by making it there | An Agent you created, imported, forked or moved into a Project leads it ([below](#leads)), unless you removed it. |
| **executor** | Core | An Agent made for one task by a [dispatch to a new executor](#dispatching-to-a-new-executor). |

- **Where it shows.** The sidebar shows a **Lead** label beside a lead's
  name, and an executor's row its state, in its ring (see
  [An executor's lifecycle](#an-executors-lifecycle)). Agents see each Agent's kind in `peers_list` (`lead`,
  `executor` or `standing`), and can list only one kind with its `kind`
  filter.
- **How it is stored.** Core keeps the kind in a table of its own,
  `agent_roles`, not in the Agent's record. Older Core builds rewrite an
  Agent's record with only the fields they know. Kept apart, a kind survives
  an older Core opening and changing the Agent, as an Agent's Project
  membership does. Deleting an Agent removes its kind with it.

## Leads

An Agent you make in a Project leads it: you never have to set a lead. A
Project's leads dispatch its tasks to executors, edit its Home and write its
handover document; every other Agent there can only ask. In the Project's
settings, under **Leads**, you can remove a lead or choose again. Only open
Agents in that Project can be chosen, and an executor never leads.

- **Made a lead by you.** These make an Agent a lead of the Project it is in
  afterwards:
  - creating it in the Project (`POST /api/agents` with `projectId`, on this
    Core host or on an SSH machine);
  - importing a Claude Code session into it;
  - forking a Codex or OpenCode Agent: the fork leads the source's Project,
    even when the source is an executor, since the fork is an Agent of its own;
  - moving it into the Project (`POST /api/agents/{id}/project`).

  An imported Codex session is in no Project, so it leads none until you move
  it. A closed Agent isn't made a lead. No Agent tool creates or moves an
  Agent, and an executor a dispatch creates never leads.
- **A list you saved keeps your choice.** Agents you make there from then on
  join it. An Agent you removed stays removed while it stays in the Project.
- **At upgrade, once.** When this Core first opens a Workspace, a Project
  whose leads were never saved gets every open member that is not an executor
  as its lead, and its list's version moves on. A Home editor list saved on
  an older Core isn't consulted: a member it left out becomes a lead too. A
  Project whose leads you saved keeps them; its other members are Ask-only
  from then on.
- **Who can change them.** Only you, through `PUT /api/projects/{id}/leads`.
  The request is `{expectedVersion, leadAgentIds}` and the answer is
  `{version, leadAgentIds}`. No Agent tool sets leads, so an Agent cannot
  make itself or another a lead.
- **Saving.** A save replaces the whole list. An Agent left out stops being a
  lead. A save against a list someone else changed meanwhile is refused.
  Core's own changes to a list (an Agent you made joining it, a lead moved
  away) move its version on too.
- **A lead belongs to its Project.** Core keeps which Project an Agent leads.
  It leads that Project only while it is a member there.
- **Moving a lead.** When you move a lead to another Project, it leads that
  one instead; moved out of every Project, it leads none. The list it left
  changes version, so a settings page still showing the old list reloads
  before saving.
- **An older Core's move.** Such a move leaves the mark in place, but it
  applies only if the Agent returns to the Project it was chosen for.

### Leads edit Home

A Project's leads are its Home editors. Every other member, an executor too,
is Ask-only there.

- **A lead** writes reports and status, edits and removes its own sections,
  and claims a section whose author is gone, as content editors did before.
  `brief_get` answers `you.capabilities.editContent: true` exactly for an open
  lead of a Project that is not archived.
- **An Ask-only member** may put, edit and resolve its own Asks, remove its
  own older sections (a report or status it wrote while it edited Home), and
  send `noChange`. It can't write, edit or claim a report or status, or turn
  one into an Ask; such a change is refused with `ask_only`.
- **What a former editor wrote.** A member that edited Home before and isn't
  a lead now becomes Ask-only. Its report and status leave Home's main view
  for the team sections, unread marks as they were; it can remove them.
- **The separate setting is gone.** `PUT /api/projects/{id}/home-editors`, a
  save from an older page, is refused with `setting_removed`; `GET` answers
  the leads. `brief_get`'s `contentEditors` keeps its shape for older readers:
  `{version, editorAgentIds, rule: "leads"}`, the leads and their version.
  The list an older Core kept (`project_brief_editors`) stays as it is and is
  no longer read or written.
- **Opening the Workspace with core.24 afterwards.** core.24 reads its own
  Home editor list again: where none was saved, every member but an executor
  edits. The leads this Core made stay leads there, so they can still
  dispatch from templates. An Agent made on core.24 is not a lead when this
  Core opens the Workspace again, unless its Project's leads were never saved.
- **Known limit: the user's routes.** Leads, templates, the handover and these
  settings are changed through browser routes that Core guards by their
  headers: a loopback host, no proxy headers, and `x-yuzuno-client: desktop`
  for a write (`server.rs`, the browser guard). A process on the Core host
  that sends those headers is treated as you, here as everywhere else.

A lead can dispatch a task of its own Project to a new executor. You can
always dispatch to a new executor. A task in no Project is dispatched to a new
executor by you only.

## Executor templates

A template says what an executor is made of: a named kind of executor that
a dispatch can ask for. Without one, a dispatch makes a
[general executor](#the-general-executor). Templates are the Workspace's,
for every Project: you keep them in Settings, under **Executor templates**.
A new template needs only a **Label** and a **Harness**; the other fields
are under **More settings**, and left unset each inherits as described
below. A Project's page has no templates of its own. How many executors run
at once is each machine's number ([Executors at once](#executors-at-once)),
not a template's or a Project's.

| Field | What it is |
| --- | --- |
| **Label** and **Id** | How the template is shown, and how a dispatch names it: lowercase letters, digits and hyphens. A new template's id follows its label, or is `template-1`, `template-2` and so on for a label without Latin letters or digits. |
| **Harness** | Codex, Claude Code, or OpenCode where this Core creates OpenCode Agents. If OpenCode is turned off later, its templates are kept and can still be edited, but no new one can be added, and a dispatch from one is refused. |
| **Model**, **Reasoning effort**, **Permissions** | As for a new Agent. Left unset, the template inherits the defaults for new Agents, the Project's and then the Workspace's. A model it names is checked against this Core host's catalog when you save. Codex takes a reasoning effort; Claude Code keeps each Agent's own. OpenCode uses its own configuration's model and permissions. |
| **Runs on** | Where its executors run: this Core host, a machine from the Machines list, or **Choose automatically** (`auto`). OpenCode offers this Core host only; Codex, no machine that keeps its Agents contained. A machine the list no longer has is shown as not in it, and kept until you change it. |
| **Name** | The executor's name. `{task}` is the task's ID and `{label}` the template's label; empty is `{task} · {label}`. |
| **Instructions** | Up to 8 KiB, given to the executor with its task: in its dispatch's materials (`task_get` with the dispatchId, under `template`), and in its mail when they are at most 2,000 bytes; longer, the mail says where to read them. |

- **Which template a dispatch gets.** The Workspace's template of the named
  id, whatever the task's Project. A dispatch naming an id the Workspace
  doesn't have is refused with `template_not_found`, naming the ids it has.
- **Presets.** Where Core ships template presets, Settings offers them under
  **Add from a preset**. Choosing one adds an unsaved template filled from
  it, with a free id if its id is taken; **Save templates** saves it as any
  other edit. No Agent saves templates or presets.
- **Templates a Project had.** Before this version, a Project could keep
  templates of its own, used before the Workspace's of the same id. When this
  Core first opens a Workspace, it copies each Project's own templates into
  the Workspace's list, once, and leaves the Project's list as it was, so an
  older Core opened later still finds it:
  - a template the Workspace already has as it is is not copied;
  - one whose id the Workspace uses for another template gets the first free
    id (`reviewer-2`, `reviewer-3`, …) and its Project's name in its label,
    such as "Reviewer (Lab)". A dispatch naming `reviewer` in that Project
    then gets the Workspace's `reviewer`;
  - each copy says where it came from, shown under its label as "Copied from
    the project Lab, where its id was reviewer";
  - a template this Core can't read stays in its Project's list.

  If an older Core saves a Project's list again, the next open checks every
  template in it again, not only what changed. One the Workspace still holds
  as copied is skipped, but one whose copy you edited or deleted here is
  copied in again (under another id when its own is taken). Edit or delete
  those copies afterwards. The copies may take the list past 50 templates: a
  save then keeps what the list holds, but can't add more.
- **Where executors run.** On the machine the dispatch names, else the one
  its template names, else this Core host. A machine is one from the
  Machines list, or `auto`, for Core to choose one at each dispatch (see
  [Which machine](#dispatching-to-a-new-executor)). OpenCode executors run on
  this Core host only, and a Codex executor can't run on a machine that
  keeps its Agents contained.
- **Who changes them.** Only you. Saving replaces the whole list, and a save
  against a list changed meanwhile is refused, so the page reloads first.
  Removing a template, or a Project, changes no executor already made.
- **After a newer Core.** Templates and fields that a newer Core saved and
  this one can't read or use, such as another harness or machine, are not
  shown or offered to a dispatch, and a save here keeps them as they were.
  The page says how many such templates the list holds.

## Dispatching to a new executor

To dispatch a task to a new executor, give `executor` instead of `toAgentId`
in `task_dispatch`: `executor: {}` for a [general executor](#the-general-executor),
or `executor: {templateId}` for one made from that template. In the task's
**Dispatch** form, choose **A new executor**: the general executor comes first
and is chosen unless you pick a template. Core then:

1. **Checks** the task's version, that it is not archived, who is
   dispatching, and the template. Nothing is written before these pass. A
   template neither list has is refused with `template_not_found`, naming the
   ids it could use.
2. **Creates the executor**, as **New Agent** creates an Agent. It is made
   from the template, or as a general executor, in the task's Project, and
   named by the template's pattern (a general executor: `{task} · Executor`). On this Core host it works in the dispatch's worktree when that is
   a folder here, else in the Project's folder here. On another machine it
   works in the Project's folder on that machine; a dispatch there that
   carries a worktree is refused, since a worktree is a path on this Core
   host. Core makes no folder: with none, the dispatch is refused. When an Agent dispatches, that folder
   must be the worktree you registered on the task or lie inside the
   Project's folder; any other is refused, since a path an Agent gives, in a
   dispatch's or a task's materials, is information, not permission. Your own
   dispatch may name any folder. An Agent's task_update that re-sends
   materials becomes the latest registrant, so a worktree you registered
   outside the Project's folder is refused for that Agent's dispatch to a new
   executor until you register it again or dispatch it yourself.
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
- **During an update.** While Core prepares an update, a dispatch to a new
  executor is refused, because creating an Agent waits for the update. A
  dispatch to an existing Agent is not refused. Retry the same request once
  the update is done: one that had not been made goes ahead then, and nothing
  was written for it before. A retry of one already made is refused during
  the update too, and gets its recorded answer after it.
- **Which machine.** A dispatch's `machineId` names a machine from the
  Machines list, `local` for this Core host, or `auto`. Left out, the
  template's machine holds, else this Core host (a general executor has no
  machine of its own). A machine that isn't registered, or can't run the
  executor's harness, is refused before anything is written.
- **`auto`.** Core chooses the machine when it dispatches, from this Core
  host and every registered machine that can run the executor's harness and
  where the task has a folder: its Project's there, or on this Core host a
  worktree. A dispatch that carries a worktree, a path on this Core host,
  runs on this Core host. Of those, in order:
  1. one with a free executor slot (its number not reached: its own, else 3);
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

### The general executor

A dispatch whose `executor` names no `templateId` (or `templateId: null`)
makes a general executor: an executor with no template.

- **What it is made of.** Its harness is the default for new Agents of the
  task's Project, else the Workspace's, else Codex, chosen when the dispatch
  is checked, so the machine checks are for that harness. Its model,
  reasoning effort and permissions are left unset, so it inherits them as
  any new Agent there does; on this Core host a default model is checked
  against the host's catalog as for **New Agent**.
- **Its instructions** are the Project's handover document, the task's
  materials and Core's summary of the task so far (see
  [What an executor starts with](#what-an-executor-starts-with)): it has
  none of its own. Its materials say `template: {"id": null, "label":
  "Executor", "source": "builtin", "instructions": null}`, and its mail says
  it is a general executor.
- **Where and how many.** It runs on the dispatch's machine, else this Core
  host. It has no limit of its own: the Workspace's, its Project's and its
  machine's limits apply, as to any executor.
- **Otherwise as from a template.** Who may dispatch it, a retry, a failure,
  a rebuild of a failed start, release and archiving are as for an executor
  from a template. A rebuild reads the defaults for new Agents again, as a
  template's rebuild reads its template again.
- **After an older Core.** A Core from before general executors runs one it
  finds and can release it, but can't rebuild one whose start failed: it
  requires a template, so that task is blocked with the reason.

## Executors at once

Each machine has a number of executors that run on it at once: this Core
host, and each registered machine. It is 3 unless you change it, a whole
number from 1 to 64, in **Machines**: a registered machine's in its editor,
this Core host's on its card (`PUT /api/machines/{id}/executor-slots`, `local`
for this Core host; null for the default). There is no other limit: the
Workspace runs at most the machines' numbers added up, and a Project or a
template has none of its own. Settings, under **Executor templates**, lists
each machine's number and the total. Only you change them. Lowering a number
under the executors running on that machine stops none of them: no more start
there until fewer hold a slot.

- **From before (YN-2 S5).** The Workspace's number, a Project's and a
  template's **At most at once** applied too. When this Core first opens a
  Workspace, the Workspace's number, if you saved one, becomes this Core
  host's own if it had none; a machine's saved number stays as it is, also
  above the old total, and a registered machine with none runs the default.
  What it did is kept in `workspace_meta` (`executors.slots.machines`). The
  old numbers stay stored, unused, so an older Core opened again applies
  them. A save of the Workspace's or a Project's number is refused with
  `setting_removed`; a template's `maxConcurrent` from an older page is taken
  and dropped for one release.

- **The queue.** An executor dispatched while every slot is taken waits.
  Core starts the next one as soon as a slot is free, in the Jobs queue's
  order: any waiting more than 30 minutes first, then Projects in turn, each
  Project's in the order they were dispatched. Executors in no Project take
  their turn together. One whose machine is full is passed by the next that
  has room on its own machine, so a full machine holds back none bound for
  another.
- **What the task shows.** Its card, and `task_get` as `executorSlot`, say
  whether its executor is queued, with its place (`position`, 1 first) and
  the machine it waits for (`waitsFor`: `{machine, name, running, limit}`),
  starting (with `reason` when its start did not finish), or running. On a
  machine `auto` chose, the card's executor chip names it, with every
  candidate's numbers, or why it was left out, in its title: the lifecycle
  chip (see [An executor's lifecycle](#an-executors-lifecycle)), which the
  task's view shows too, or the slot chip for a task without one.
- **Holding a slot.** An executor holds its slot from when it starts until
  it is closed, by anyone and in any way. A disconnect keeps it, so
  reconnecting never passes the limit. Closing one frees its slot for the
  next.
- **Connect on a queued executor** is refused, naming the machine it waits
  for, how many of how many run there, and its place in the queue, and
  changes nothing about it. To run more at once, raise that machine's number:
  the next ones start right away.
- **A start that fails.** A start fails when the runtime refuses it, or
  when it doesn't finish within the **start time limit**: 300 seconds unless
  you change it, 30 to 3600, the Workspace's, in Settings under **Executor
  templates**. Core then closes
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

- **Who.** The Agent that dispatched it, or any lead of its
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
materials and its template's instructions, a dispatch to a new executor gives
it two more things; for a general executor, which has no template, these are
its instructions. Both are in its dispatch's materials (`task_get` with the
dispatchId). The mail says where to read them; it doesn't hold them.

- **The Project's handover document** (`handover`): what the Project already
  knows, in Markdown, up to 32 KiB of text: line breaks (LF or CRLF) and
  tabs, but no other control characters; a save with one is refused at its
  line and column. The Project's leads write it
  ([below](#a-lead-writes-it)); you read and change it in the Project's
  settings, under **Handover**, which shows who changed it last. A save
  against a document that changed meanwhile is refused. A Project's document
  goes with it when the Project is deleted. An archived Project's document
  can't change.
- **Core's summary of the task so far** (`contextSummary`): at most 4 KiB,
  written by Core from what it holds, in this order:
  - the latest result;
  - the newest comments' first lines;
  - each linked pull request, as last observed, with the P0–P2 findings
    of its latest completed review.

  Nothing in it is read again from GitHub or a model.

A dispatch to an existing Agent gets neither; that Agent already has its own
context.

### A lead writes it

A lead of the Project writes the handover document directly: no one
approves it, and nothing about it waits on Home.

- **Reading.** Every member of the Project, its executors too, reads the
  document with `handover_get`. Its answer has the document, its `version`
  (an internal revision, for the next write), who changed it last, when and
  with what note (`lastModified`), and `canWrite`: whether the caller may
  write it, as a lead of the Project while the Project is not archived.
- **Writing.** A lead writes a whole new document with `handover_update`,
  against the `version` it read, with an optional `note` of what changed (up
  to 200 characters; `reason`, its older name, is still accepted). It is
  saved at once, and every executor dispatched from then on gets it. The
  same rules apply as for your save: 32 KiB of text, and a write against an
  older revision is refused, naming the current one. A retry with the same
  `requestId` answers as the first write did; another payload under it is
  refused. An executor and any other member are refused with `not_lead`.
- **What you see.** In the Project's settings, under **Handover**: the
  document, and one line saying who changed it last (a lead's name, or
  you), when, and its note. You can change the document there too, with
  an optional note. A lead's next write is checked against your save, as
  yours is against its. No history of earlier versions is shown; Core keeps
  each save, but nothing lists or restores them.
- **Proposals from before.** A lead used to propose a version for you to
  approve on Home (`handover_propose`). That tool is gone: a call to it is
  refused, naming `handover_update`. When this Core first opens a Workspace,
  a proposal still waiting is marked superseded, its text kept, and its lead,
  if open, gets one mail with that text, to write it with `handover_update`
  if it is still needed.

A dispatch's materials are at most 128 KiB, counting only what the dispatcher
can shorten: the task's own materials and the dispatch's. The template, the
handover and the summary are not counted, since each has its own limit
(instructions 8 KiB, handover 32 KiB, summary 4 KiB). So a new executor's
materials are at most 128 KiB plus those three. Over the limit, the dispatch
is refused with `materials_too_large` and nothing is dispatched.

## What an executor doesn't do

An executor does its task and reports to the Agent that dispatched it. Three
things are not its to do:

- **Setting its own task done.** `task_update` to done, and a
  `task_submit_result` with status done, are refused with
  `executor_done_refused`, and nothing is written. It submits its last
  result with status review, and its dispatcher, or you, sets the task done.
  Any other status is its to set.
- **Showing a step as finished.** A result along the way, such as a plan for
  its dispatcher's approval or one slice of several, is submitted with status
  doing. Its task stays in progress and the executor running, not awaiting
  release, so nobody sets the task back by hand. Its dispatcher gets the
  result's mail as for any result, saying the dispatch continues, and the
  task's detail heads it 阶段结果 · Step result. A delivery candidate is
  still submitted with status review.
- **Writing Home's content.** An executor is never a Home editor: it can't
  lead (`invalid_lead`), and a list an older Core kept that names it doesn't
  make it one. It can still ask you its own questions, and what it wrote
  before shows with the team's sections.

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

## An executor's lifecycle

Each executor has one state, shown on its row in the sidebar, on its task's
card and, when it needs you, on Home. Core works it out from what it already
records (`executor_lifecycle.rs`); the Agent listing has it as `executor`, and
a task's views as `task.executor`. The rules are tried in this order, and the
first that holds names the state:

| # | State | Shown as | When |
| --- | --- | --- | --- |
| 1 | `archived` | 已归档 · Archived | It was released and closed for good. |
| 2 | `archiving` | 归档中 · Archiving | It was released and waits for its work to end, or for its close to be confirmed. `reason` says what it waits for. |
| 3 | `failed` | 失败 · Failed | Its start stopped short: it is held open with its slot and a reason (an uncertain start, or a reopened executor's start that failed), or it is closed while its task is blocked and the task's newest dispatch is still its own. |
| 4 | `closed` | 已关闭 · Closed | It is closed for another reason: closed by hand, or a failed start that Core rebuilt as a new executor. |
| 5 | `queued` | 排队中 · Queued | It waits for an executor slot; `position` is its place, 1 first. |
| 6 | `starting` | 启动中 · Starting | It holds a slot and its runtime is starting. |
| 7 | `delivering` | 已交 · Handed in | Its result is in, on its own dispatch, and its task is in review. |
| 8 | `running` | 运行中 · Running | Anything else: it is at work. |

Each also names its task (`task.id`, the key the task has now, such as
`YN-3`, or `T-<n>` while it has none; `task.title`), who dispatched it
(`dispatcher`: `user`, or an Agent with its ID and name), the template it
was made from (`template`: its `id`, and its `label` as its dispatch's
materials give it), when it was dispatched (`dispatchedAt`), and since when
it is in its state (`since`). An executor at work whose task is blocked also
has the blocker (`blocked`); its state stays what it is.

- **The sidebar.** In each Project's list, leads come first, then the
  other Agents, then a 任务执行者 · Executors group and, folded by default,
  已归档 · Archived. With attention order, executors are ordered by: waiting
  on you, or failed; handed in; running; archiving;
  queued or starting. A failed executor shows there only while its task is
  blocked on it; a released one, under Archived and in Closed. While some
  wait for a slot, the group's heading says how many are queued and how
  many run.
- **Every Agent's row** has no avatar. Line one is a standing Agent's or a
  lead's name, and an executor's activity: what it is doing, after its
  state's word ("Needs you: approve the design note", "Handed in #688 ·
  waiting for the lead"; Working has no word). Line two is what a standing
  Agent last said, or an executor's task key and its clock, small and grey.
  At the row's top right is its ring (灵动环, `AgentIsland.tsx` over
  `agent-island.ts`), then the "…" of its actions where you are (the row
  selected, or the keyboard on its link or on the "…"). The executor's name,
  template and PR are in its ring's title. A row is never more than three
  lines, and its height follows what it says.
  The states are 空闲 Idle, 在做 Working, 已交 · 等负责人 Handed in, 等你
  Needs you, 排队 Queued, 离线 Offline, 完成 Done, 出错 Failed and 已归档
  Archived.
  - An executor's comes from its one state, the first of these that holds:
    released or archiving (archived, with what an archiving one waits for);
    its start failed (failed, with why); closed (archived); queued or
    starting (queued, with its place); a request or question waiting for
    you (needs you: what it asks is its work summary); its Turn failed
    (failed); offline or disconnected (offline); delivering (handed in, or
    working while a Turn runs: it is on its next slice); otherwise working.
    Its activity is its task's blocker, else its work summary, else what
    its state is at (a result to check, its unfinished Jobs and CI), else
    its task's title.
  - A standing Agent's comes from its runtime: closed; offline; a request
    waiting; an error, or a Turn that failed and this device hasn't shown;
    working (compacting too, and an idle Agent's unfinished Jobs or CI); a
    Turn ended with updates unread (done); otherwise idle.
- **Its clock** runs while it works (an executor's time on its task since
  its dispatch), needs you (since its oldest wait in Home's Needs you), is
  handed in (since it handed in) and is queued. For idle, offline, done and
  failed it says how long ago, and for an archived executor its whole time,
  which no longer runs. A standing Agent's runtime gives no start for its
  Turn, so its Working shows no clock.
- **The ring is the state** (22 px, strokes only): Working is an arc that
  turns, its length the progress (a fixed quarter until templates carry
  their steps); Handed in, an outer arc of its review rounds (k of 2) round
  an inner ring; Needs you, a bold ring that breathes; Queued, dots that
  turn slowly; Offline, dashes; Idle, a thin ring; Done ✓, Failed ✕ and
  Archived (a box) carry a mark inside. Unread updates are a count beside
  its top left. Under reduced motion nothing turns or breathes.
- **Its forms.** One outline grows out of the ring and shrinks back into it.
  - At rest a ring, except needs you and failed, which are the row as the
    island (the outline round the whole row) until handled. A row is three
    lines at most.
  - A passing event grows a pill left out of the ring for about three
    seconds (five for bad news): its PR merged, a review asked for changes
    or passed, its checks failed or turned green, it handed in, it started
    after queuing, new messages came. The pill takes its width from line
    one, whose words wrap rather than being covered, so the row may grow
    while it shows; the ring keeps its place. Nothing on the row's first
    showing or its PR's first reading, and nothing while the row is the
    island. A Job's end grows none yet: the rail reads how many Jobs run,
    not how each ended.
  - Each change animates the outline from the ring's circle, or from where
    it was, in 320 ms, and back into the ring in 300 ms; nothing moves under
    reduced motion.
- **A click on the row** opens the Agent's conversation, the text of a row
  island included, and changes no island. **A click on the ring** goes
  straight to its state's place: needs you, to its item in Home's Needs you,
  scrolled to and highlighted; an executor's, to its task (why its start
  failed, its result, its place in the queue, or the task); a Turn that
  failed, or updates unread, to the conversation. Its label says where
  ("Answer its question on Home"). A ring with nowhere of its own (idle,
  offline, a standing Agent at work) is no button: the row's click is its.
  The ring's button takes presses 28 px wide with a mouse and 40 px on
  touch, with nothing drawn; on hover or focus the ring grows a little (its
  strokes thicken under reduced motion), and hover on the rest of the row
  only darkens its background, with no border. There are no cards.
- With the compact Agent list (Settings → Appearance), every row is line
  one and its ring; needs you and failed keep their word on line two.
- **Its PR** comes from `GET /api/executors/live`: for each open executor
  (not archived, its Agent not closed) whose task links a PR, the open or
  draft one with the highest number, else the highest-numbered; its state;
  the checks on its head as Core last read them (`unknown` when Core last
  saw them for another commit); and the review rounds on that head, the
  approvals since the newest that asked for changes, and whether one is
  under way. A review whose reviewer never started is no round. The read
  uses Core's records only and never asks GitHub; the web reads it again on
  every collaboration change, which a GitHub refresh, a link and a review
  each announce. Two rounds count as approved, the standard flow.
- **The task's card** shows its executor and its state, with its place
  while it is queued.
- **Home's Needs you** lists, for an executor you dispatched, a result
  waiting for your release, a failed start, and a task blocked while it
  runs. A lead's executors are that lead's to follow and never show there.
  Its row opens the executor, where its result and Release are.
- **Release** says, while the executor is archiving, what it waits for.
  Asking again tries at once.

Clients read a state again when it changes: an executor's Agent is
announced as changed (`agent.changed`), and the task board is told with
`workspace.changed` scope `executors`. An archiving executor's reason is
announced only when it changes, not on every check. A write to its task
announces it only when it can change the state: a result, a dispatch, a
claim, or a new status or blocker. A progress-only update doesn't.

## Phases

| Phase | What it adds |
| --- | --- |
| 0 | Kinds and leads, as above. |
| 1 | Executor templates and the general executor. A dispatch to a new executor makes the executor Agent, once per request, and its dispatcher releases it. |
| 2 | A limit on how many executors run at once, with a queue and one retry of a failed start. |
| 3 | Routing a released executor's late mail to the lead, and grouping executors in the sidebar. |
| 4 | Core merges an accepted pull request itself, with the same evidence as a manual merge. It merges a released PR once CI has tested exactly what lands on main, building a batch when CI tested an older main ([merge queue](merge-queue.md)). |

Standing Agents keep working throughout. Tasks already in progress finish on
the Agents that hold them.
