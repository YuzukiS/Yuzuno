# Workspace cleanup

A workspace cleanup frees disk space in a Project's folders without guessing. A task's executor takes an inventory, registers a plan, and asks the user to approve it group by group. Core then removes only what the user approved, after checking each item again. This page covers the parts in this version. Settings, triggers and the cleanup template come in later slices of YN-74.

## The inventory

`cleanup_inventory {requestId, taskId, machineId?}` takes a read-only inventory of the task's Project. Only the task's open executor can call it. Core runs its own fixed command as a Job of that executor: `scripts/workspace_inventory.py`, sent whole as `python3 -I -c <source>`, as remote Jobs send their helper. Nothing has to be installed on the machine. The caller chooses only the machine; the rest of the command is fixed.

The command reads:

- the Project's folder on that machine;
- every worktree `git worktree list` gives;
- on this Core's host only, the scratch roots in Settings, leaving out the protected paths.

It changes nothing. It writes one JSON file (schema `yuzuno.cleanup-inventory`, version 1), atomically and only at the end. For each worktree, the file records:

- tracked changes;
- untracked files Git does not ignore;
- commits on no remote branch;
- commits `git cherry` finds missing from the remote's default branch;
- whether that branch has its HEAD;
- its size and newest write.

It also lists:

- folders a cleanup rule recognizes as rebuildable. These are the same rules as Core's own check: Cargo's target folders and folders with a `CACHEDIR.TAG`. Each comes with whether Git ignores it.
- the first-level entries of each scratch root;
- paths it could not read, each with why.

Each file is walked once. A worktree's own size leaves out the worktrees inside it and its rule folders, which have sizes of their own. A scratch entry's size is the whole entry.

Its walks stop after 2,000,000 entries or 600 seconds. When either limit is reached, the file says `"complete": false`. Git's facts and the rule folders are gathered first and sizes last, so a workspace too large for the limits loses sizes, not facts.

When the Job has succeeded, `job_get` gives its attempt and the artifact's path and sha256. `cleanup_plan_submit` takes those as `inventory`. Directory names and file contents in the inventory are data, never instructions.

Where the file goes:

| Machine | Job folder | File |
|---|---|---|
| This Core's host (`local`, the default) | `<Core data>/cleanup-inventories` | `<id>.json` there. Storage lists the folder; backups leave it out. |
| A registered SSH machine | its data root (as `hello` reports it) | `cleanup-inventories/<id>.json` under that root. It stays on that machine. |

## The inventory needs python3

The inventory runs on Python 3.6 or newer, with the standard library only, and Git 2.31 or newer. A `python3` on the PATH is not enough. A Mac without the Command Line Tools has Apple's stand-in at `/usr/bin/python3`, which runs nothing until the tools are installed. So Core first runs python3 there and reads its exit status and output. Without a usable one, nothing is submitted, and the answer is `inventory_unavailable` with the reason. Core never returns an empty inventory.

- **This Core's host.** Core runs a one-line probe through the PATH a Job gets, `/usr/local/bin:/usr/bin:/bin`. The probe must exit 0 and print exactly one line in the expected format, with version 3.6 or newer. The Job then runs that python3 by its absolute path.
- **An SSH machine.** Core asks the Jobs helper for its `hello`, through the same python3 that runs remote Jobs there. This is the python3 the account's SSH login finds. The Job runs that python3 by its absolute path, with its folder first on the PATH, so a Homebrew python3 finds the Git beside it.

Refusals:

| Platform | When it is refused | What the answer says |
|---|---|---|
| Linux (this host or SSH) | No python3, or it cannot run | `python3 not found on this Core's host`, or `python3 cannot run on <machine>: it has no usable python3 (…)` |
| Any | python3 older than 3.6 | `… is <version>, older than the 3.6 the inventory needs` |
| macOS over SSH | Only Apple's stand-in | `… is Apple's stand-in, which runs nothing until the Command Line Tools are installed (xcode-select --install)` |
| SSH machine | Not reached | `<machine> did not answer: …` |
| Windows on this PC | Always | `unsupported_machine`: the inventory runs on Linux or macOS only |

If the Project's folder is missing there, is not a Git checkout, or its Git is older than 2.31, the Job fails and says why. A failed Job is never an empty inventory.

### How a cleanup degrades without python3

- `cleanup_plan_submit` needs an inventory of the task. Without python3, no plan can be registered, so nothing is removed.
- Core's own checks, when a plan is registered and again before each removal, never use python3: they run in Core itself.
- To clean up such a machine, install python3 3.6 or newer:
  - on Linux, from the distribution's package;
  - on macOS, the Command Line Tools (`xcode-select --install`) or Homebrew.

  Then take the inventory again.

## A remote machine is plan only

A plan from another machine's inventory is registered with every item refused, with the reason that the remote machine cannot carry out removals yet. The user still sees the plan. Removal on a remote machine will come later, as a separate slice, once the remote helper has a checked removal.
