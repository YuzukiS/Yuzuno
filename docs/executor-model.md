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
- **A card's executor** (YN-86 S2a, docs/home-v1.md): a lead may bind a
  section to a task (`task`). That task's current executor (its newest one
  not yet released) may also put, edit and patch report and status
  sub-topics under that card's topic, which are its own. The same write
  anywhere else, or once it is no longer the current executor, is refused
  with `not_card_responsible`. An executor never binds a section itself.
- **What a former editor wrote.** A member that edited Home before and isn't
  a lead now becomes Ask-only. Its report and status leave Home's main view
  for the team sections, unread marks as they were; it can remove them.
- **The separate setting is gone.** `PUT /api/projects/{id}/home-editors`, a
  save from an older page, is refused with `setting_removed`; `GET` answers
  the leads. `brief_get`'s `contentEditors` keeps its shape for older readers:
  `{version, editorAgentIds, rule: "leads"}`, the leads and their version.
  The list an older Core kept (`project_brief_editors`) stays as it is and is
  no longer read or written.
- **Opening the Workspace with core.25 afterwards.** core.25 reads its own
  Home editor list again: where none was saved, every member but an executor
  edits. The leads this Core made stay leads there, so they can still
  dispatch from templates. An Agent made on core.25 is not a lead when this
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
A template needs only a **Label**; left unset, each other field inherits
as described below. A Project's page has no templates of its own. How many executors run
at once is each machine's number ([Executors at once](#executors-at-once)),
not a template's or a Project's.

| Field | What it is |
| --- | --- |
| **Label** and **Id** | How the template is shown, and how a dispatch names it: lowercase letters, digits and hyphens. A new template's id follows its label, or is `template-1`, `template-2` and so on for a label without Latin letters or digits. |
| **Routing** (`routing`) | Unset: the template follows routing. Its executors get their harness, model, effort and account from the Workspace's [routing](executor-routing.md#routing-at-dispatch-s3b2). While routing is off, or none of its candidates keeps the template's permission level, they get the default harness and model for new Agents: the task's Project's, then the Workspace's, then Codex. Such a template names no harness, model or effort. `"fixed"`: its executors start with this template's own harness, model and machine on the host's login, whatever the [routing policy](executor-routing.md#the-policy-get-and-put-apiroutingpolicy-s3a) says. In Settings it is the template's **Runs with**: **Follows routing**, or the tool it is fixed to. Executor routing's **Templates** section sets it too: one switch per template. On, the template is routed by the rules. Off, it is fixed to a tool you choose beside the switch, which starts as the Workspace's default tool for new Agents. A tool that doesn't keep the template's permission level isn't saved: choose another tool, or change the level. |
| **Harness** | A fixed template's only: Codex, Claude Code, or OpenCode where this Core creates OpenCode Agents. If OpenCode is turned off later, its templates are kept and can still be edited, but no new one can be added, and a dispatch from one is refused. |
| **Permissions** (`permissionLevel`) | **Ask you first** (`ask`), **Auto-approve** (`auto`) or **Full access** (`full`): one permission for every harness, which Core maps to each harness's own. The page shows what the chosen level is on each tool, and which tools routing passes over for it. See [Permission levels](executor-routing.md#permission-levels-yn-56). Left unset, each harness's default for new Agents. A fixed template's level must be one its harness keeps: Claude Code doesn't keep Full access, and OpenCode keeps each, as rules of its own. A fixed Codex template may instead follow its machine's own Codex configuration (`permissionPreset: "config"`). A dispatch whose harness doesn't keep the level is refused (`level_not_kept`). Its executor's materials name the level. |
| **Model**, **Reasoning effort** | A fixed template's only, shown once it runs with a tool, as for a new Agent. Left unset, the template inherits the defaults for new Agents, the Project's and then the Workspace's. A model it names is checked against this Core host's catalog when you save. Codex takes a reasoning effort; Claude Code keeps each Agent's own. An OpenCode model is named as OpenCode names it, `<provider>/<model>` (such as `deepseek/deepseek-flash`): its form is checked when you save, and whether that OpenCode offers it when the executor first sends, which is refused with the reason if not. Left unset, OpenCode uses its own configuration's model. The template form's Model field takes it, as does `executor_templates_change`. |
| **Runs on** | Where its executors run: this Core host, a machine from the Machines list, or **Choose automatically** (`auto`). OpenCode offers this Core host only; Codex, no machine that keeps its Agents contained. A machine the list no longer has is shown as not in it, and kept until you change it. |
| **Name** | The executor's name. `{task}` is the task's ID and `{label}` the template's label; empty is `{task} · {label}`. |
| **Instructions** | Up to 8 KiB, given to the executor with its task: in its dispatch's materials (`task_get` with the dispatchId, under `template`), and in its mail when they are at most 2,000 bytes; longer, the mail says where to read them. |
| **When to choose** (`whenToChoose`) | One line, up to 200 characters: what work the template is for. A lead reads it with `executor_templates_list` to choose a template; it is in the dispatch's materials, not in the executor's mail. |
| **Delivery** (`deliveryMode`) | How the work is delivered: `pr`, as a pull request; `direct-commit`, committed without one (for a results repository, say); or `none`, no repository change, the result itself being the deliverable (an investigation, a memo, a check). Unset is `pr`, so every template saved before keeps today's flow. See [Delivery and steps](#delivery-and-steps). |
| **Steps** (`steps`) | 1 to 12 steps its executors follow, in order. Unset is its delivery's default steps. See [Delivery and steps](#delivery-and-steps). |
| **Tier** (`tier`) | The kind of model its work wants (YN-70): `strong`, for designing, investigating, deciding and checking, or `fast`, for building what was decided. Unset is no preference. Its executors' materials say it under `template`, as `tier` with `tierSource: "template"`, and their mail says it, such as `Tier: fast · 快 (the template's default)`. `executor_templates_list` lists it. Routing chooses only a candidate that serves it (see [Tiers](executor-routing.md#tiers-yn-70)), and a dispatch may name another: `task_dispatch` with `executor.tier`, which the materials then say with `tierSource: "lead"` (or `"user"`). In Settings it is the template's **Kind of work** (哪种活), under How it runs: Any, Strong or Fast; a preset's tier comes with it, and Add presets shows each preset's. |

- **Which template a dispatch gets.** The Workspace's template of the named
  id, whatever the task's Project. A dispatch naming an id the Workspace
  doesn't have is refused with `template_not_found`, naming the ids it has.
- **Templates saved before core.29 (YN-56).** They are read in this shape,
  and the list is rewritten only by the next save:
  - a Codex preset or Claude Code mode becomes its level: `ask` and
    `default` are `ask`, `auto` is `auto`, `full` is `full`;
  - one that followed routing loses its harness, model and effort, and a
    Codex `config` on it becomes no level;
  - a fixed one keeps its harness, model and `config`.

  This is the user's choice (YN-56): templates name no tool, and while
  routing is off they use the default for new Agents. So a template that
  named a tool other than that default runs on the default with routing off.
  A level the default doesn't keep is refused, for example Full access when
  the default is Claude Code. Two things keep this from surprising you:
  - **The way back is kept.** The tool it named is kept as `formerHarness`
    until the template is fixed to a tool. A refused dispatch's reason names
    it: "It named Codex before core.29: fix it to Codex…".
  - **Settings warns first.** The template's page says it would be refused,
    with that way back. While routing is off, its row in the list is marked
    "Refused with routing off". The warning follows the default tool for new
    Agents and whether routing is on.

  A fixed template is stored with its harness's own permission beside its
  level, so a Core before core.29 starts it as before. That Core can't read
  a template that follows routing, since it names no harness: it counts it
  among templates a newer Core saved, doesn't offer it, and keeps it as it
  is when it saves.
- **Presets.** Core ships eleven presets, in English and Chinese, each
  with the tier its work wants:

  | Id | Preset | Delivery | Tier | For |
  | --- | --- | --- | --- | --- |
  | `design` | Design · 设计 | `none` | strong | A design note, whole in the result, up to its approval; the build is a second dispatch |
  | `build-from-design` | Build from an approved design · 按批准的设计实现 | `pr` | fast | The approved note of an earlier dispatch, read whole with `task_result_get`, built a PR per slice |
  | `red-test-fix` | Red test first · 红测先行修复 | `pr` | fast | A reproducible bug: a failing test first, then the fix |
  | `batch-change` | Mechanical batch · 机械批量改动 | `pr` | fast | One mechanical change in many places, no behaviour change |
  | `investigation` | Read-only investigation · 只读调查 | `none` | strong | A question answered in a memo, each claim with its source |
  | `decision-memo` | Decision memo · 决策备忘 | `none` | strong | Options with cost and risk, and a gate for your choice |
  | `verification` | Independent check · 独立核查 | `none` | strong | Named checks run in Jobs, a verdict each |
  | `sliced-feature` | Sliced long task · 切片长任务 | `pr` | strong | A large feature in slices, with a progress file across sessions |
  | `runbook` | Gated runbook · 人工把关的运行手册 | `none` | strong | Irreversible steps, each approved; asks before each action |
  | `small-fix` | Small fix · 小修快路径 | `pr` | fast | A small fix whose cause is clear |
  | `test-hygiene` | Test hygiene · 测试卫生修复 | `pr` | fast | A flaky or wrong test, fixed in the test alone |

  Design first (`design-first`) was one preset before core.30: the same
  executor wrote the note and, once it was approved, built it. It is two
  now, so that the design and the build can each have their own kind of
  model: dispatch the task with **Design**, approve its note, then dispatch
  the same task again with **Build from an approved design**, naming the
  note's result in the materials. The design's executor puts the whole note
  in its result, not a path: a builder on another machine can't read that
  path, and a new executor's summary holds only a result's first 800 bytes.
  A template saved from the earlier preset is kept as it was.

  In Settings, **Add presets** shows them in the page's language, each
  with when to choose it, its delivery and its steps. You pick which to
  add. Each becomes an unsaved template, under a free id if its id is
  taken, for the harness of the defaults for new Agents (Codex unless you
  set another). Each has its instructions, delivery, steps, tier and when
  to choose it. The gated runbook also has its permission: Codex **ask**,
  Claude Code **default**. A preset names no model, only its tier; the
  template shows the preset's suggestion beside **Model**, which isn't
  saved. Saving (the page's save bar, or **Save templates** where the
  editor stands alone) saves the new templates like any other edit. A
  preset is never stored as one. No Agent saves presets; a lead changes
  templates as below. "Read-only" in the investigation, decision memo and
  design is an instruction only: no permission enforces it.
- **The editor.** Each template is a card: its label, harness and when to
  choose it; its delivery, chosen from three cards; its steps, shown as its
  delivery's default until you choose **Change the steps**, then one row
  each (kind, label, a review's rounds or a gate's approver, moved up or
  down, removed). A step the delivery can't have is marked at its row, and
  nothing is saved until it's fixed. **Use the default steps** sets them
  back to unset. The other settings stay under **More settings**. A saved
  template's card shows who last changed it, from `lastModified` (see
  **History** below), as one line under its name: "Last changed: who ·
  when · why", "You" for your own save.
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
- **Who changes them.** You, in Settings, and a lead of a Project, with
  `executor_templates_change` (YN-24). Your save replaces the whole list, and
  a save against a list changed meanwhile is refused, so the page reloads
  first; when a lead changed it, the refusal says who changed which
  templates. Removing a template, or a Project, changes no executor already
  made.
- **A lead's change.** A lead sends changes to one or more templates (a
  whole template that adds one or replaces the one with its id, or the id of
  one to remove) against the list's version it read, with a reason. It is
  checked as your save checks a template and saved at once; no one approves
  it, and that includes a change to an executor's permissions, model or
  machine. It applies while each template it changes is as it was at the
  version the lead read, so your save of another template meanwhile doesn't
  stop it; a change to one of its templates does, and the refusal names who
  made it. Executors and other members can't. The Project's other leads get
  one short mail with the reason.
- **History.** Each save, yours too, is kept: the version it made, who, when,
  the lead's reason, and each template it changed as it was and as it is. The
  templates' answer (`GET /api/executor-templates`) carries `lastModified`:
  who changed each template last, when and why. A save an older Core made is
  not in it, and a lead's change made on a version before such a save is
  refused until the lead reads the list again.
- **What a lead reads.** `executor_templates_list` lists the Workspace's
  templates for an Agent choosing one for `task_dispatch`. For each it gives
  the id, label, when to choose it, delivery, steps (resolved: its delivery's
  default when it sets none), harness, model, reasoning effort,
  permissions, machine, and the size of its instructions in bytes, not
  their text. It also gives the list's version, how many templates a newer
  Core saved that this one can't offer, and `general`, what `executor: {}`
  makes for the caller's Project. With `full: true`, for leads of a Project
  only, each also carries `template`, the template as saved with all its
  fields, for a lead to change and send back whole with
  `executor_templates_change`; an executor or another member is refused
  (`not_lead`). Reading changes nothing.
- **After a newer Core.** Templates and fields that a newer Core saved and
  this one can't read or use, such as another harness or machine, are not
  shown or offered to a dispatch, and a save here keeps them as they were.
  The page says how many such templates the list holds.

### Delivery and steps

A template's delivery and steps say how its executors work. They are
descriptive: Core passes them to the executor and to whoever chooses the
template, but doesn't hold an executor to a step, and doesn't refuse a pull
request, review or merge to a template whose delivery is `direct-commit` or
`none`. An executor's Overview reads how far each step is from Core's
records (see [An executor's session](#an-executors-session)).

- **Steps.** Each step is `{kind, label?, rounds?, approver?}`:

  | Kind | The step |
  | --- | --- |
  | `materials` | Read the dispatch's materials. |
  | `work` | Do the work the label names. |
  | `result` | Submit a result: the label says which (a design note, a memo). |
  | `gate` | Wait for an answer before going on. `approver` says who answers: `user` (also when unset), `lead` or `either`. |
  | `job` | Run a Job (a build, a test suite, a check). |
  | `pr` | Open or update the pull request. |
  | `review` | A review round at the frozen head; `rounds` is 1 (also when unset) or 2. |
  | `ci` | CI at the pull request's head. |
  | `merge` | The pull request is merged. |

  A label is one line of up to 60 characters; without one a step is its
  kind alone. Only a `pr` template has `pr`, `review`, `ci` and `merge`
  steps, only a review has `rounds`, and only a gate has an `approver`. A
  save that breaks one of these is refused, naming the step by its place
  ("Step 3: …").
- **Default steps.** A template that sets no steps has its delivery's:
  - `pr`: materials → work → job → pr → review → ci → merge;
  - `direct-commit`: materials → work → job → result;
  - `none`: materials → work → result.
- **What the executor gets.** A template dispatch's materials say, under
  `template`, its `deliveryMode` and its `steps` as resolved (its own, else
  the default), `whenToChoose` when it has one, and its `tier` with
  `tierSource` when it has one (YN-70). Its mail says the
  delivery and the steps on one line each, such as `Delivery: none: no
  repository change to deliver; your result is the deliverable` and `Steps
  (descriptive: Core does not track them): materials → work: Write the memo
  → gate (user): Your choice`. A general
  executor's materials and mail have neither, as before.
- **After a newer Core.** A template whose delivery, step kind or step field
  this Core doesn't know is one this Core can't use: it isn't offered or
  listed, and a save here keeps it as it is. An older Core reading a
  template with these fields offers it as before, without them, and a save
  there keeps them.

## Dispatching to a new executor

To dispatch a task to a new executor, give `executor` instead of `toAgentId`
in `task_dispatch`: `executor: {}` for a [general executor](#the-general-executor),
or `executor: {templateId}` for one made from that template. Either may also
name `machineId` (below) and `tier`, `strong` or `fast` (YN-70): the kind of
model this executor's work wants, over its template's
([Tiers](executor-routing.md#tiers-yn-70)). In the task's
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
- **Which machine.** A dispatch's `machineId` names a machine by its id:
  `local` for this Core host, a registered machine's id, or `auto`. The
  machine is the dispatch's choice; a template's machine is only its default.
  Left out, the template's machine holds, else this Core host (a general
  executor has no machine of its own). A machine that isn't registered, or
  can't run the executor's harness, is refused before anything is written.
  An id no machine has is refused naming the machines this executor could run
  on, each by id and name (`local (this Core host), <id> (<name>)`).
- **Finding a machine's id.** In Settings → Machines, each machine's page
  shows its id with a copy button, and says it is the id a dispatch names.
  The Core host's is `local`. (YN-37)
- **What a lead reads of the machines.** `machines_list` lists the machines a
  dispatch can name, for a lead choosing one. For each it gives the id, the
  name, the kind (`local`, this Core host, or `ssh`), the harnesses an
  executor there can use (OpenCode on this Core host only, no Codex on a
  machine that keeps its Agents contained), its executor slots (`limit`;
  `running`, those starting or running there; `waiting`, those queued for a
  slot there), `connected` (whether Core holds a live connection to an Agent
  there now; always true for this Core host, and false says only that none
  is connected, not that the machine is down), `lastCheck` (when the user's
  newest manual check ran and whether it reached the machine, or null) and
  `projectFolder` (whether the caller's Project has a folder there, which an
  executor on another machine works in). A machine is named only by its id
  and name: no SSH destination, user, port, key, executable, folder, data
  root or check error is given. Windows on this PC runs Jobs only, never an
  executor, so it is not listed. Only leads of a Project, and you, read it;
  an executor or another member is refused (`not_lead`). Reading changes
  nothing.
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
  review are written as always. While the task is open such mail wakes the
  dispatcher, as it would have woken the executor. Once the task is done,
  cancelled or archived, a passed-on success (a Job that succeeded, CI that
  passed, a review that passed, a pull request made, a merge) is quiet: it
  is kept and read as usual, and comes with the dispatcher's next wake-up
  instead of starting a Turn (YN-68). A failure always wakes it.
  Before its release, a review round it started itself is mailed to it, and
  you get a copy when the round ends: quiet once it completed, ringing when
  it failed, was cancelled or is unknown (YN-12). After it, the review's
  mail comes to you once, not twice. A round its delivery flow registered
  sends no copy: the flow's own mail tells you.
- **Other mail is refused.** Mail to it, and a dispatch naming it, is refused
  with `executor_archived`, naming its task and its dispatcher. Write to the
  dispatcher instead, or dispatch the task again for new work.
- **Its proposals are its dispatcher's.** A task status change it proposed
  with `result_publish` (before YN-14 removed that tool) is decided by the Agent that dispatched it: the
  proposal shows who, and can't be decided there. You decide it if you
  dispatched the executor, or if its dispatcher is closed or no longer
  exists.
- **Its build output can go, by the user's policy.** The build output cleanup
  (Settings → Data & storage → *Build output in task work folders*;
  `/api/build-cleanup`) is off unless the user turns it on, and only the user
  changes it. Turning it on first counts what earlier releases left, and the
  user chooses whether that goes too. Once on, the chosen number of days (0–30, 1 unless changed)
  after the executor's close, Core removes the Cargo `debug` build output of
  the folders its records show were the executor's: the folder it worked in,
  the folders its Jobs ran in and the target directories they named in
  `CARGO_TARGET_DIR`, worktrees registered on its task, and worktrees on the
  head branch of its task's pull requests. Each must be a worktree of the
  Project's repository inside the Project's folder on the Core host, and not
  that folder itself or its own `target/`. A profile is removed only if
  nothing keeps it at that moment: Git tracking or seeing files there, files
  Cargo does not make, a Job record naming it, a build or a process using it,
  a Job or an Agent in that folder, or another open executor of the task.
  What is in use is tried again every hour for a week. Worktrees, branches,
  sources, other profiles and everything beside a profile stay. The task's
  activity says once what was removed and kept, and `executor_release`'s
  answer gives the policy and `dueAt` in `buildCleanup`. Executors on other
  machines are not handled.

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
`YN-3`, or `T-<n>` while it has none; `task.title`; and `task.shortName`,
below), who dispatched it
(`dispatcher`: `user`, or an Agent with its ID and name), the template it
was made from (`template`: its `id`, and its `label` as its dispatch's
materials give it), when it was dispatched (`dispatchedAt`), and since when
it is in its state (`since`). An executor at work whose task is blocked also
has the blocker (`blocked`); its state stays what it is. One at work
(`running`) whose task's newest result came in on its own dispatch (handed
in as doing, or its task no longer in review) also says when (`resultAt`,
YN-92); a handed-in one says it by `since`.

An executor with a dispatch record also says what executor routing gave it
(`route`, YN-57). It is one of three kinds:
- **`chosen`:** the candidate (`candidate`, with its `label` when it has one),
  the harness, model and effort the executor runs with, and its account or key
  (`credential`). The credential is one of:
  - `login`;
  - `apiKey` with `keyId`;
  - `pool` with `account`: its `fingerprint` and, as the record gives it, `number`;
  - `codexHome` with `id`.
- **`waiting`:** it waits for a candidate, with `earliest`, the soonest time a
  candidate's reason gives, when there is one.
- **`unrouted`:** with `why`, one of:
  - `none`: its dispatch recorded no route. Either routing was off then, or
    it could not route this one (for example, no candidate could run there);
  - `fixed`: its template is fixed;
  - `routingOff` or `noCandidate`: released after waiting
    ([executor routing](executor-routing.md)).

Each kind with a route record also has the executor's `tier` and
`tierSource` when its dispatch had one ([Tiers](executor-routing.md#tiers-yn-70)).
The executor's card says it after the route, such as `Route: OpenCode ·
deepseek-flash · API key deepseek-main · fast work (template)`.

It never holds a key's value or an account's email.

- **A task's short name.** What the task is about in plain words, at most
  16 characters ("导出设备偏好", "Export settings"), not a key, a number or a
  PR: the sidebar names an executor by it. A lead or the user gives it with
  `task_create` or `task_update` (`shortName`; kept trimmed, one line; null
  or empty clears it), typically when dispatching. In the app it is the
  Short name (短名) field of the task board's new-task and edit forms, and
  of the Dispatch form when a new executor does the task, which saves a
  changed one before it sends the task. Without one the task's
  title stands in, and the lifecycle's `task` has no `shortName`. `task_get`'s current view and `task_list`'s compact rows
  carry it. A Core from before it (core.26 and earlier) reads such a task
  as before and leaves the short name out of its next save of that task.
- **The sidebar.** In each Project's list, leads come first, then the
  other Agents, then a 任务执行者 · Executors group and, folded by default,
  已归档 · Archived. With attention order, executors are ordered by: waiting
  on you, or failed; handed in; running; archiving;
  queued or starting. A failed executor shows there only while its task is
  blocked on it; a released one, under Archived and in Closed. While some
  wait for a slot, the group's heading says how many are queued and how
  many run.
- **Every Agent's row** has no avatar (rail v11, the user's answers to
  design/ask-rail-readability). Line one is a standing Agent's or a lead's
  name, and an executor's task in plain words: its short name, else its
  title, with no key or PR number. Line two, small and grey, is what a
  standing Agent last said, or what an executor is doing now (its task's
  blocker, its work summary, what its state is at) and then its clock. The
  task's key and title are in the row link's title; the executor's name,
  template and PR in its ring's title. A row is never more than three
  lines, and its height follows what it says. The open Agent's row looks as
  a row under the pointer does: its background only, no border or fill of
  its own. No row has a "…": a right-click, a long-press, or the
  context-menu key or Shift+F10 on its link opens its actions.
- **The ring says one of five states** (22 px, strokes only, at the row's
  top right; `AgentIsland.tsx` over `agent-island.ts`): working, an arc
  that turns, only while a Turn runs; needs you, a bold orange ring that
  breathes; done, ✓; failed, ✕; idle, a thin grey ring. Under reduced
  motion nothing turns or breathes. Once its Turn ends, an Agent's ring
  rests at the grey idle ring, and a pill says what holds it (YN-92: a
  turning ring reads as at work). Only a lead shows updates unread, as a
  small dot at the ring's top left with no count; other Agents show none.
  - An executor's: working while a Turn runs on its task (compacting too;
    handed in too, while a Turn runs on its next slice); needs you while a
    request or question waits; ✕ when its start or its Turn failed; ✓ once
    released or archiving (what an archiving one waits for is line two);
    otherwise grey. At work on its task with no Turn running, it is grey
    with a pill, the first that holds: what it left running (在等 Job
    Awaits a Job, below; its line two then says only what it said and its
    clock, not the wait again); its PR's (审查中 In review, 等负责人 Lead's turn and
    the others below); 受阻 Blocked, its task blocked; 已交结果 Result in, a
    result in on its own dispatch (`resultAt`); else 等下一轮 Between turns.
  - A standing Agent's: working while a Turn runs (compacting too); needs
    you; ✕ for an error or a failed Turn not yet shown; ✓ for a Turn it
    ended that this device hasn't shown; otherwise grey (offline and closed
    too). An idle one whose last end has been seen is grey with a pill
    while what it started runs: its reviews under way that are mailed to
    it, CI it watches, Jobs, background shells and sub-agents (在等审查
    Awaits review, below); or, with only a Job or CI to check, the list's
    own words for it (核对 Job Check job, 核对 CI Check CI).
- **A ring shows what it waits on** (YN-51, the user's choices on Home):
  one icon inside the ring, 11 px, still, in the ring's colour; the ring
  itself still says the state. Only two rings hold one: a turning ring, for
  the call its running Turn is stopped on, and a grey ring at rest whose
  Agent waits only on what it left running (YN-92); no other ring does. The icons are the work dock's: a review (GitPullRequest), CI
  (Github), a Job (BriefcaseBusiness), a sub-agent (Bot) and a shell
  (SquareTerminal). When it waits on several, one shows, in this order:
  review, CI, Job, sub-agent, shell.
  - While a Turn runs, only the call it is stopped on counts: a shell
    command or a sub-agent, from the listed Agent's `turnWait`, which Core
    reads from the harness's own record of the call (Claude's `Bash` and
    `Agent` calls, Codex's commands and sub-agent activity, OpenCode's
    `bash`, `task` and `subagent` tools and shell parts). It shows once the
    row has seen the call hold the Turn for a second, so quick calls never
    flash, and goes when it ends. Thinking, writing or any other call shows
    none, whatever runs in the background.
  - While no Turn runs (and its last end has been seen), what it started
    and left running counts: review rounds preparing or running whose result
    is mailed to it, and the background shells (Claude, Codex) and Claude
    sub-agents its live connection reports (`GET /api/waits/live`); CI it
    watches that runs, is being found or awaits its first run
    (`/api/ci/live`); Jobs queued or holding a reservation
    (`/api/jobs/live`). A Job whose outcome is unknown and CI to check are
    things to check, not waits. A count the harness hasn't reported, such
    as OpenCode's background shells, shows nothing.
  - The row's card says which one ("在等 CI：PR #214", an executor's PR from
    its live read; "Waiting on a Job: web-tests"), and under it, smaller,
    the others it waits on ("另有：CI、1 个 Job"). At rest, the card's state
    line is that wait in full, then the others and a line that says its
    Turn has ended ("这一轮已经结束：没在干活，只在等它启动的事跑完"). The row's
    screen-reader text and the ring's label add what it waits on ("在等审查");
    at rest the row's text starts with the wait, or with its pill's words,
    and never says it works.
  - The web reads `/api/waits/live` again when Core says an Agent changed
    (a background count, a Turn ending) or the board did (a review starting
    or ending).
- **Every other state is a pill** left of the ring, with a short phrase that
  stays while the state holds: 排队 · 第 2 位 Queued · 2 in line, 启动中
  Starting, 等负责人 Lead's turn (handed in, its review not under way), 审查中
  In review, 要改 Changes asked, CI 红了 CI failed, 等合并 Ready to merge, 已合入
  Merged, and 离线 Offline; and once its Turn has ended (YN-92), 在等审查
  Awaits review, 在等 CI Awaits CI, 在等 Job Awaits a Job, 在等子代理 Awaits
  sub-agent, 在等 shell Awaits a shell, 核对 Job Check job (and 核对 CI, 核对
  Job / CI), 受阻 Blocked, 已交结果 Result in and 等下一轮 Between turns. None
  is wider than 排队 · 第 3 位 Queued · 3 in line, which leaves line one its
  width in a 240 px rail. A passing event takes the pill's place for about
  three seconds (five for bad news), then the state's pill comes back: its
  PR merged, its checks failed or turned green, it started after queuing.
  Review news is the staying pill's own, and new messages are no event.
  Nothing on the row's first showing or its PR's first reading. The pill
  takes its width from line one, whose words wrap rather than being covered
  (two lines at most while a state's pill stays). Needs you and failed are
  the row as the island (its outline round the whole row) until handled,
  with no pill.
- **Its clock** runs while it works (an executor's time on its task since
  its dispatch, its Turn running or not), needs you (since its oldest wait in Home's Needs you), is
  handed in (since it handed in) and is queued. For idle, offline, done and
  failed it says how long ago, and for an archived executor its whole time,
  which no longer runs. A standing Agent's runtime gives no start for its
  Turn, so its Working shows no clock.
- **A click on the row** opens the Agent's conversation, the text of a row
  island included, and changes no island. **A click on the ring** goes
  straight to its state's place: needs you, to its item in Home's Needs you,
  scrolled to and highlighted; an executor's, to its task (why its start
  failed, its result, its place in the queue, or the task); a Turn that
  failed, or one that ended unseen, to the conversation. Its label says
  where ("Answer its question on Home"). A ring with nowhere of its own
  (idle, offline, a standing Agent at work) is no button: the row's click
  is its. The ring's button takes presses 28 px wide with a mouse and 40 px
  on touch, with nothing drawn; on hover or focus the ring grows a little
  (its strokes thicken under reduced motion), and hover on the rest of the
  row only darkens its background, with no border. There are no cards.
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
  Its row opens the executor, where its result and Release are, and says
  why under its task: why its start failed, or what blocks its task (T-43
  S4a). Each counts in the tab's title, the app badge and the Home tab's
  count, and a new one notifies once, as a new Ask does: in the browser
  and by web push, opening Home. A failed start is a failure notice; the
  others need you. A notification uses words of its own ("Its result is
  in, waiting for your release."); with previews on, the browser's says the
  reason instead. Web push never carries it.
- **Release** says, while the executor is archiving, what it waits for.
  Asking again tries at once.

Clients read a state again when it changes: an executor's Agent is
announced as changed (`agent.changed`), and the task board is told with
`workspace.changed` scope `executors`. An archiving executor's reason is
announced only when it changes, not on every check. A write to its task
announces it only when it can change the state: a result, a dispatch, a
claim, or a new status or blocker. A progress-only update doesn't.

## An executor's account or key

An executor on this Core host may be started with a routing account or key
(its runtime profile; see [Executor routing](executor-routing.md)), which
routing sets at its dispatch while the routing policy is on. Without one an
executor starts on the host's own login, as before.

- **Where it lives.** In its own table, never in the Agent's record, so an
  older Core's rewrite of the record cannot drop it.
- **Each start reads it again**, a reconnect too, and hands what it gives to
  that executor's harness process only: never to Core's own environment, so
  never to another Agent, a Job, a review run or a catalog read.
- **A claude-swap account is resolved at each start** from a fresh
  `cswap list`:
  - the account that is the host's current default login starts on the
    plain host login: `cswap run --require-session` refuses that account,
    and the host login is that same account;
  - any other listed account starts through `cswap run <slot> --require-session`;
  - an account no longer listed does not start.
- **Once started, an executor is not moved to another account.** Before
  its first start, one whose candidate, account or key left the routing
  policy is routed again ([Routing at dispatch](executor-routing.md#routing-at-dispatch-s3b2), YN-138). A
  refusal, an account that is gone, or a key that cannot be read fails that
  start with its reason. The start is then a failed start like any other
  (see [Executors at once](#executors-at-once)). Its session lives in that
  account's profile, so another account could not resume it anyway.
- **On another machine** an executor with a profile does not start: keys and
  accounts stay on this Core host.
- **It is not forked.** A fork is a new Agent, without the profile, so it
  would run on another account; a fork of an executor with a profile is
  refused with that reason.
- **With an older Core**, the profile is not read: such an executor is
  reconnected on the host's own login. A Claude session started in a
  claude-swap profile is then not found. Close such executors before going
  back to an older Core.

## An executor's session

An executor's session has two tabs, 概览 · Overview and 会话 · Conversation:
two readings of the same records. It opens on its Overview; each executor
keeps the tab you chose last. A standing Agent or a lead has no tabs.

- **The Overview** (`ExecutorOverview.tsx`) reads
  `GET /api/agents/{id}/executor` (`executor_overview.rs`; another Agent is
  `not_executor`, 404). It shows:
  - its task's key and title, its template, who dispatched it, its state
    and its time on the task, and a way to open the task;
  - its starting materials as its dispatch kept them (acceptance, the
    repository at its base, the worktree, what to return, the handover
    version, the context summary), read-only;
  - its template's steps (its delivery's default when it sets none, `pr`
    for an executor made from no template), numbered from 1, five shown and
    the rest on request, each with a state read from its record: `result` is done once
    that result is in (the n-th result step is the n-th result handed in on
    this dispatch); `job` is the newest of its Jobs; `pr` is done once its
    task links a PR; `review` is the newest round on the PR's head
    (`changes_requested` fails it; a round of an earlier head doesn't count);
    `ci` is the head's checks; `merge` its merge entry's, or done once the PR
    is merged. A gate its executor asked you about (below) is waiting for
    you while that Ask is open and done once you answered it or it was
    resolved; the steps after it stay as they are meanwhile. Materials, work
    and a gate it asked nothing about have no record of their own: each
    is done once a step after it has begun (materials also once the dispatch
    mail was read). A gate ends a stage: the stage after it begins only once
    each result asked for before the gate is in, and only its own Jobs, made
    after the newest of those results, count for it, so one stage's records
    never pass a gate. The first step not begun is where the executor is:
    under way while it runs (materials, work or a result), waiting for you
    while it waits (those, or a gate);
  - what it is doing now (its work summary);
  - the approvals it asked for on Home (its gates' Asks, below), each with
    its question, what it says and Home's own reply, answered there: the
    same Ask, so an answer there is the answer on Home and in its
    Conversation, which shows the same card while the Overview doesn't;
  - while it needs you, its requests' own cards, answered there (and not
    also in its Conversation while the Overview shows);
  - its PR's changes as GitHub counts them (`+additions −deletions · files`,
    read with the PR), with a link to it;
  - its evidence, each with its own conclusion: its own Jobs on the task
    (newest twelve), the review of the PR's head, the PR's CI and its merge
    entry. A red Job and the green one after it (the first job step whose
    Job failed and the next job step whose Job succeeded, as a red-first
    template records them) share one row, red → green (T-43 S5);
  - its result, when it has handed one in.

  The read uses Core's records only and never asks GitHub; the web reads it
  again on every collaboration, Jobs, merge queue or Home Ask change.
- **Gates (T-43 S4).** An executor at a gate step of its template asks for
  the approval with its own Home Ask, which names it:
  `ask: {question, reply, gate: {taskId, step}}`, the step counted from 0
  as the template lists its steps. This is the user's choice of 2026-11-08
  (design/t43-gates, option D): one record, the Ask, rather than a gate
  record of its own. Core takes such an Ask only from the executor of that
  task's dispatch and only for a step of its template whose kind is `gate`
  (`gate_not_yours`, `gate_step_unknown`); an Ask without `gate` is as
  before. Home lists it in Needs you with its `gate`; the sidebar shows its
  executor waiting for you (the needs-you ring, its time from the Ask's)
  and among those waiting; its Overview shows the step waiting and the
  Ask's card, answered in place. A gate whose approver is `either` is also
  mailed to its dispatcher, whose mailed approval counts too: the executor
  then resolves its own Ask. A `lead` gate goes to its dispatcher by mail
  instead. Core does not stop an executor that goes on without the answer:
  that rests on its instructions.
- **The Conversation** is the conversation as for any Agent, with the
  composer. Behind the Overview it stays open, hidden: choosing it again
  puts it back where it was read. A jump into it (a source from Home or the
  sidebar, a message link, a Turn from the index) shows it; a reading
  position kept from earlier is taken when you choose it.

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
