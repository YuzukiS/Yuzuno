# Workspace data

Where a Workspace lives, how to move, back up and restore it, and what older Cores do with it. The [README](../README.md#data-and-updates) has the short version.

## Where a Workspace lives

Unless you choose a location with `--data-dir` or `YUZUNO_DATA_DIR`, a Workspace lives in `yuzuno/workspace` in the system's data folder: `~/.local/share/yuzuno/workspace` on Linux, `~/Library/Application Support/yuzuno/workspace` on macOS. Back up that directory: it holds your Workspace records. An OS lock prevents two Cores from opening it simultaneously. CLI credentials remain managed by the native tools.

## Moving a Workspace from `yuzuno-next`

A Workspace that an earlier build kept in `~/.local/share/yuzuno-next` stays there and is used there; Core says so when it starts and never moves it on its own. To move it, stop Core and run `yuzuno-workspace --move-workspace` (Linux, for the default folder only). It moves the folder to `yuzuno/workspace` and leaves `yuzuno-next` as a link to it, because its records, Jobs, image copies and native histories name paths in it; an older Core started afterwards opens the same Workspace through the link. It refuses and changes nothing while a Core runs, a Job has not ended, a managed update is under way, the database fails its check, or anything else is at either path. If it is interrupted, every Core still opens the one Workspace, and running it again finishes the move. If both locations hold a Workspace, Core does not start until you name one with `--data-dir`. Core uses only its own `workspace` folder in `yuzuno/`; other files there, such as an older Yuzuno product's, are left alone. On SSH machines, Yuzuno keeps its files in `~/.yuzuno`, or in the folder set for that machine.

## Back up and restore

To back up a Workspace, stop Core and run `yuzuno-workspace --backup-to <new folder>` (with `--data-dir` if Core uses one). The folder holds a copy of the database, the image copies, Project Brief attachments, review records and Job folders, and a `manifest.json` that lists every file with its size and SHA-256, everything left out and why, and what a Workspace backup never covers: native CLI accounts and keys, native session histories, Agents' working directories, SSH keys, the managed install and each device's browser preferences. The Workspace's own MCP credentials are removed from the copy; Core makes new ones. It refuses while a Core runs on the Workspace or a Job has not ended, and on any error it leaves nothing behind. `yuzuno-workspace --verify-backup <folder>` checks every file and reads every Agent's history from the database. `yuzuno-workspace --restore-backup <folder> --restore-to <new or empty folder>` checks the backup, copies it beside the target, checks it again there and only then puts it in place; it never replaces a Workspace. The restored Workspace keeps the identity of the one backed up, so do not run a Core on both at once. The database copy a Core update makes is for recovering from that update only; it is not a Workspace backup.

## Tasks stay with their Workspace

Tasks belong to the Workspace they were made in. When work moves to another Workspace, it gets new tasks there: new task IDs and a history that starts anew. The old tasks' results, activity, dispatch materials and Job records stay in the old Workspace's folder and in its backups; nothing copies them over. To read them later, restore a backup of the old Workspace into a new or empty folder (`--restore-backup <folder> --restore-to <folder>`, above) and start a Core on it with `--data-dir` and another `--port`. It is a whole Workspace with the old one's identity, so never run it while a Core still runs on the old one. Moving a task to another Project in the same Workspace keeps all of that: its results, activity, Job records and GitHub links stay with the task. It takes the new Project's next key, and every key it had still names it.

## Older Cores

Core builds from before data roots (core.11 and earlier) look for those files only in `~/.yuzuno-next`, and ignore a machine's own folder, containment and Jobs limits. So while a Workspace holds something they would get wrong, they cannot open it: an unfinished remote or Windows Job, an open remote Agent outside `~/.yuzuno-next`, or a machine with such a setting. Any SSH machine added by a release with Jobs limits has one, since it is strict unless it chose record-only (`limitMode: null`); a machine saved before keeps record-only and does not. Such a build stops at start with "无法打开 Workspace 独占锁: Permission denied" (its lock file is read-only meanwhile) and changes nothing. Once those Jobs have ended, those Agents are closed and those settings are gone, the next start and stop of Core lets older builds open the Workspace again.

## Stopping Core

Stopping Core differs from closing the client: it ends local runtime connections. Saved native sessions can reconnect, but an interrupted tool is not guaranteed to continue losslessly. SSH Codex sessions can survive a Core/SSH disconnection and reconcile on reconnect.
