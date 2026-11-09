# Core release checklist

The order a release executor follows to publish one Core release, `core.N`, with the commands of `tools/core-release-run.py` around [the release tool](core-release.md). The tool's own rules (what `init`, `resume`, `publish`, `verify-download` and `health` check) stay in that guide; this page adds the steps between them: the gate, the Job, the notes, the one Ask, the milestones and the health check after the install.

Read this page at the candidate commit (`git show <SHA>:docs/core-release-checklist.md`), not from a checkout left at an older one: the tools change between releases.

## Who does what

- **The Lead** chooses the candidate and names, in the dispatch: SHA, its main push CI run, RELEASE_ID, VERSION, the previous release and the items the notes must include. From the cut until the inputs run has started, the Lead releases nothing from the merge queue. The Lead reads the notes before the Ask.
- **The release executor** does every step below on the release host, from the tools of a checkout frozen at SHA.
- **The user** answers one Ask, and installs the release from their own window. Nobody else installs.

## Values and directories

One file holds a release's values: `release-run.env`, as [the example](../tools/release-run.env.example) shows. Python parses it (`NAME=value`, nothing is sourced by a shell), and each command refuses to start, exit 2, when a value it needs is missing, blank or malformed. A wrong check stops it with exit 1.

| Where | What |
| --- | --- |
| `W` | `git worktree add --detach .worktrees/coreN-release <SHA>`: the tools every step runs; it stays clean |
| `W/target/core.N-run/` | the run directory: `release-run.env`, the notes, the review string and every receipt (`target/` is ignored) |
| `T/release` | the work directory `core-release.py` freezes and signs into |
| `BASE` | the previous release's `bundle/` |
| outside the repository | evidence for the task, copied out of `target/` at the end; the signing key, passed only by its path |

Every command below runs from `W` as `python3 -I tools/core-release-run.py <command> --env target/core.N-run/release-run.env`.

## Steps

### 1. Gate (read-only)

1. Create `W` at SHA and the run directory, and fill the values the dispatch names.
2. Set `WORKSPACE_ID` to the `yuzuno.workspaceId` of your own `peers_list` reply, now. This is the pre-install record that the health check compares against; never take it from the release being checked.
3. Run `gate`. Every problem is listed in `gate.json`, not only the first. It checks:
   - `minisign` is the pinned binary (`MINISIGN_SHA256`);
   - `W` is these tools, at SHA, and clean;
   - main's head is SHA;
   - `CI_RUN` is `ci.yml` on the push of SHA to main, completed with success;
   - SHA has no release-inputs run yet;
   - neither the tag RELEASE_ID nor any release with that tag, with VERSION as its name, or with a name ending in `-core.N` exists;
   - no draft release exists;
   - the latest release is `PREV_TAG`, named `…-core.N-1`;
   - `core.N` is the newest open milestone.

### 2. Inputs

1. Right after the gate passes, run the dispatch as its own command: `gh workflow run release-inputs.yml --repo <REPO> --ref main`. The workflow builds main's head at the moment it starts, so nothing may merge in between.
2. Run `inputs`. It finds the one run for SHA and checks it is the release-inputs workflow on main. While the run builds, it says the hold can lift. Once the run passes, it prints `INPUTS_RUN` and `ARTIFACT_ID` (the one `core-inputs-<SHA>-<attempt>` artifact); write them into the env file.
3. Run `milestone --open core.N+1`. Merge-queue grouping tags a merge with the highest-numbered open milestone, and `core.N` stays open until publication. Without `core.N+1`, merges after the cut would be tagged `core.N`.
4. Mail the Lead that the hold can lift. Include the cut's CI run, the gate's time, the inputs run, main's head and the new milestone.

### 3. Baseline

Run `baseline`. It downloads the previous release's signed descriptor and checks it with `PUB`. `BASE/manifest.json` must be the manifest it names, and every file of `BASE` the manifest's. It prints `BASE_SHA256`. If the previous bundle is gone, `baseline --fetch` fills a new `BASE` from the release's signed archive, after checking it against the descriptor.

### 4. Notes and review string

1. **Facts.** Run `facts`. It writes:
   - `facts/merges.tsv`: the first-parent merges from `PREV_TAG` to SHA;
   - `facts/milestone.tsv`: the milestone's PRs with their `task:*` labels;
   - `facts/main-ci.tsv`: each merge commit's own main push CI runs;
   - `review-string-draft.txt`.
   
   It stops when the merges and the milestone do not list the same PRs.
2. **Read by task.** Write the notes from what each task delivered: its `task_get` and `task_result_get`, and the PR bodies. Check each line of the Lead's feature list against them; earlier lists held errors. Take the words the user sees from the UI's string tables in `web/src`, verbatim.
3. **Check the code for:**
   - new tables, columns and `workspace_meta` keys, and version constants;
   - serialized fields the smoke compares: a new field must be absent while unset;
   - what the first start does;
   - what happens on a fallback to the previous release;
   - changed MCP tools;
   - changes to the release tools themselves.
4. **Write the text.** Chinese first, then the same text in English, each with these sections:
   - a summary with the main changes;
   - updating from `core.N-1` (read first);
   - compatibility and fallback;
   - changes by feature, one line per task;
   - known limits.
   
   Keep to the Lead's must-include items. `init` refuses notes over 32,768 bytes; Chinese takes 3 bytes a character.
5. **Review string.** Complete `review-string-draft.txt`:
   - fill `{{QUEUE: …}}` from each PR's merge-queue entry (`merge_list`: policy, gate, review merges, binaries);
   - give each `{{WHY #n}}` its reason.
   
   It goes into `release.json`, not the bundle.
6. **Final files.** Save them as `notes-final.md` and `review-string.txt` in the run directory, and set `NOTES_SHA256` and `REVIEW_SHA256`. Commands refuse either file while it holds `{{`, `}}` or `TODO`. The notes are frozen into the signed package at `init`: after that, changing a word needs a new work directory and a new signature.

### 5. The Lead reads the notes

Submit the two files' paths and SHA-256 as a result with status `doing`. That result is the Lead's gate: wait for the Lead's reply before asking the user.

### 6. The one Ask

One Home Ask, `delivery/coreN-release`, owned by the release executor and naming its gate step: `ask.gate: {taskId, step}`.

- **Question:** approve `core.N`: build, sign and publish it with the attached notes, stopping and telling you if any check fails?
- **Options:** `approve`, and `change` (with the change written below); free text on.
- **Body:**
  - `text`: one or two sentences: the version, the source, the number of merges, and that the card changes after publication and the health check runs after the install;
  - `metrics`: version, source, merges, notes bytes;
  - `plan`: the five steps after approval: init, resume, publish (with its one documented recovery), verify (with the anonymous download), and the health check after the install;
  - `files`: the notes and the review string, each caption with its SHA-256.

The user's reply on this Ask authorizes the steps after it; a reply relayed by another Agent does not. A reply asking for a change: make it, then put the same key once more.

### 7. Package, sign and smoke (a Job)

1. Run `init`. It checks the final texts, `BASE_SHA256`, `PUB_SHA256`, a new work directory and a frozen `W`, then calls `core-release.py init`. It prints `release.json`'s SHA-256.
2. Submit `resume` as a Job:
   - **cwd:** `W`.
   - **argv:** `python3 -I tools/core-release-run.py resume --env target/core.N-run/release-run.env --release-json-sha <sha>`.
   - **env:** `HOME` (gh finds no login without it), `LANG=C.UTF-8`, `PATH=/usr/local/bin:/usr/bin:/bin`.
   - **resources:** 2000 mCPU, 2048 MiB, no swap; core.24 to core.28 peaked at about 1 GiB.
   - **checks:** `guardGit`; inputs: the env file, the notes and the review string; timeout 7200 s.
   - **artifact:** `target/core.N-run/resume.json` (json).
   
   Never put the signing key in the Job's inputs, its env or the run directory; `resume` refuses a key inside `W` or the run directory.
3. `resume.json` is the summary publication takes. `asExpected` holds only when all of these are true:
   - `core-release.py resume` exited 0;
   - `release.json` is unchanged;
   - fetch, package, sign and smoke passed;
   - there are three signed files;
   - the in-place smoke passed;
   - the report resumes at publish.
   
   `addedFields` lists the fields the smoke saw the release add to projects, tasks and budgets.

### 8. Publish, verify, milestone

1. Run `publish --resume-sha <the Job's resume.json SHA-256>`. It checks minisign, `W`, `release.json` against the env file and the summary. It prints the three signed SHA-256s and calls `core-release.py publish`. It then writes `tag-ref.txt` and `remote-release.json`.
2. Run `verify`. It calls `core-release.py verify-download` through gh, then downloads the three files anonymously into `T/anonymous-download`: `env -i`, no token, no netrc. Each must equal the signed file, and the descriptor must verify with the frozen `publisher.pub`.
3. Edit the Ask's `text` and `plan` blocks with `edit`, not `put`, so it stays replied. Run `milestone --close core.N`.
4. Submit a `doing` result naming:
   - the release ID and tag;
   - the three SHA-256s;
   - that the milestone is closed.

### 9. Health after the install

1. Wait for the install signal: the Core's `session_changed` mail saying `This Core (<RELEASE_ID>) attached this conversation again`. The install reattaches your session, and CI subscriptions are refused (`workspace_updating`) until it finishes.
2. Run `health --origin http://127.0.0.1:<port>`, with the Workspace from `WORKSPACE_ID`. It reads only `/api/health` and `/api/updates` (through `core-release.py health`) and the served Web UI. The served `/` and every file under `bundle/web/assets` must equal the bundle byte for byte, with the release's meta tag. This is the only step that touches the installed Core.

### 10. Result

1. Resolve the Ask.
2. Copy the run directory's receipts out of `target/` into the task's evidence.
3. Submit the final result: `review`, with the task's `expectedVersion`.

## When to stop

- **Any red check:** stop. Edit the Ask to say where it stopped and what has not happened, and mail the Lead, urgent.
  - Do not rerun, change a value or start a new work directory.
  - One exception: `publish` after the draft-lookup miss described in [the release guide](core-release.md), in the same work directory with the same command. Before it, check read-only (the tag ref, `releases?per_page=100`) that there is exactly one empty draft for the tag.
- **A command refused by your own permission check:** do not split it or reword it. Mail the Lead, urgent. With the Lead's agreement, post your own allow-once Ask naming the exact command and SHA. It is the one exception to the single Ask.
- **A bug in these tools:** stop and tell the Lead, who chooses a re-cut or a tools checkout at the fix's head.
- **Release scratch directories:** never delete them. Ask the user first.

## Known pitfalls

- The inputs build takes main's head when it starts; dispatch it right after the gate, while the Lead holds the queue.
- `core-release.py init` freezes the notes into the package. Settle them before `init`.
- `publish` can stop right after creating its draft with "Remote release not found". Recover as above.
- A Job without `HOME` fails at its first `gh` call.
- A field a migration adds to projects, tasks or budgets appears in `addedFields`; one added to a conversation fails the smoke. Before a release, check that new serialized fields are absent while unset.
- When usage runs out, an Agent can look Working while it does nothing. When you resume after such a stop, or a subagent returns nothing, stop. Read `T/release/report.json` and the Ask's state again, and mail the Lead, urgent, before any further step.
- Evidence under `target/` goes when its worktree is removed: copy it out.

## Must-include items: core.29

The dispatch lists what the notes must say. For core.29 these items go into the notes, each checked against the code at SHA first:

- **Templates follow routing now.** A template that named its harness now follows routing, and while routing is off the default harness for new Agents. A dispatch is refused when that harness doesn't keep the template's permission level; Settings shows this beforehand.
- **One step for the user:** set the new-Agent default harness of the yuzuno-next Project to Claude Code.
- **Routing's 5-hour condition is removed.** This is true only once YN-60 has merged; check it at SHA.

## Dry run, without GitHub writes

Commands that only read (`gate`, `inputs`, `baseline`, `facts`) can be tried against a published release. Put `tools/fixtures/fake-gh-read.py` first on `PATH` as `gh`, with:

- `FAKE_GH_PASSTHROUGH` set to the real gh, so reads reach GitHub;
- `FAKE_GH_LOG` set to a new file.

Every call is logged with its verdict, and every write is refused before anything is sent. The log is the evidence that the run wrote nothing.
