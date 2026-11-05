# Agent kinds, Project leads and executor templates

Yuzuno is moving towards an executor model. A Project has one or more lasting
**leads**. For each task, Core will start an **executor**, an Agent made for
that one task from a template. A limited number of executors run at once.
Each executor's result goes back to the lead through the existing dispatch
and result flow. Review stays with Core, and the lead releases the executor
when the work is accepted.

The model arrives in phases. Phase 0 is in place: it marks what kind each
Agent is and lets you choose a Project's leads. Phase 1 is arriving: you
can keep executor templates and dispatch a task from one, and Core creates
its executor. Releasing an executor comes next.

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
| **At most at once** | Kept for phase 2's limit on running executors; not applied yet. |

- **Which template a dispatch gets.** A dispatch of a task in a Project uses
  that Project's template of the named id, else the Workspace's. A task in no
  Project uses the Workspace's.
- **Where executors run.** On this Core host. Other machines, and choosing
  one automatically, come in phase 2.
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
   pattern. It works in the dispatch's worktree when that is a folder on this
   host, else in the Project's folder on this host. Core makes no folder: with
   neither, the dispatch is refused. When an Agent dispatches, that folder
   must be the worktree you registered on the task or lie inside the
   Project's folder; any other is refused, since a path an Agent gives, in a
   dispatch's or a task's materials, is information, not permission. Your own
   dispatch may name any folder.
3. **Dispatches the task to it**, as a dispatch to an existing Agent does. The
   result goes back to whoever dispatched.
4. **Starts it.** The dispatch's mail is delivered once it is connected.

- **Who may.** You, or a lead of the task's Project. A task in no Project,
  only you.
- **The answer** is a dispatch's, with `agentId`: the executor.
- **A retry** with the same `requestId` gets the same executor and answer, and
  never makes a second executor. The same `requestId` with another payload is
  refused. If Core stopped after dispatching but before starting the
  executor, a retry starts it.
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
- **No limit yet.** In phase 1 every executor starts at once.
- **This host only.** A dispatch's `machineId` may be empty or `local`.

## What an executor starts with

An executor starts cold, with no memory of the Project. Besides its task's
materials and its template's instructions, a dispatch from a template gives it
two more things. Both are in its dispatch's materials (`task_get` with the
dispatchId). The mail says where to read them; it doesn't hold them.

- **The Project's handover document** (`handover`): what the Project already
  knows, in Markdown, up to 32 KiB. You keep it in the Project's settings,
  under **Handover**. Each save is a new version, kept with who wrote it and
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

## Phases

| Phase | What it adds |
| --- | --- |
| 0 | Kinds and leads, as above. |
| 1 | Executor templates. A dispatch from a template makes the executor Agent, once per request. |
| 2 | A limit on how many executors run at once, with a queue and one retry of a failed start. |
| 3 | Releasing and archiving executors, routing their late mail to the lead, and grouping them in the sidebar. |
| 4 | Core merges an accepted pull request itself, with the same evidence as a manual merge. |

Standing Agents keep working throughout. Tasks already in progress finish on
the Agents that hold them.
