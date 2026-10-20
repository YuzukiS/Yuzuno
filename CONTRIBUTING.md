# Contributing to Yuzuno

Yuzuno is in active development, preparing for a public alpha. This guide covers where things are in the source, which checks to run, and how to report a problem or open a pull request. The [README](README.md) explains what Yuzuno does and how to run it from source.

Yuzuno is licensed under the [Apache License 2.0](LICENSE), with the exceptions listed under [License](README.md#license). As section 5 of that license says, a contribution you submit for inclusion is under the same license unless you state otherwise.

## Find your way around

The [Development](README.md#development) table in the README lists what each top-level directory owns. Within them:

- `core/src/` has one module per area, for example `jobs/` for managed Jobs, `pr_review/` for reviews and `updates/` for Core updates. Integration tests are in `core/tests/`.
- `web/src/` is the UI. Its tests are the `web/tools/*.test.mjs` files.
- `runtimes/claude/` is the Claude bridge, with its own tests.
- `docs/` holds design notes and guides, such as the [install guide](docs/independent-core.md) and [CI](docs/pr-ci-runner.md).
- `.agents/skills/yuzuno/` is what Agents are told about Yuzuno's tools.

To try a change, run a separate Core with its own port and data folder, so it cannot open the Workspace you use every day:

```sh
python3 scripts/launch.py core --port 4400 --data-dir /absolute/path/to/test-workspace
```

## Checks

Start with the checks for the part you changed:

| Changed | Check |
| --- | --- |
| A Core module | `cargo test --locked --lib jobs::`, with that module's path in place of `jobs::`; or `cargo test --locked --test <name>` for one file in `core/tests/` |
| The UI | `npm --prefix web run typecheck`, then `bash .github/scripts/web-tests.sh tools/<name>.test.mjs`, with paths relative to `web/`. Some tests load the built UI, so run `npm --prefix web run build` first. |
| The Claude bridge | `npm --prefix runtimes/claude test` |
| `scripts/` | `python3 -m unittest discover --start-directory scripts --pattern 'test_*.py'` |

The full set in [Development](README.md#development) is what CI runs, and it is heavy. It builds all of Core and runs every test serially; CI gives it up to 6 GiB of memory for Rust and 3 GiB for the UI, and Core's build output takes several GiB of disk. Run one heavy check at a time, and limit parallel builds if memory is tight (for example `cargo test --locked -j2 -- --test-threads=1`). An Agent working inside Yuzuno should submit heavy checks as managed Jobs; see [Jobs](.agents/skills/yuzuno/references/jobs.md).

### Several worktrees, one target directory

Worktrees can share one Cargo target directory (`CARGO_TARGET_DIR`) to save disk, but Cargo cannot tell them apart. It names Core's artifacts by their path inside the workspace and treats them as current when no source file is newer than the last build. So a worktree whose files are older than another worktree's last build silently runs that worktree's code, and Cargo still exits 0.

When a target is shared, run Cargo through `scripts/source_build.py`:

```sh
python3 scripts/source_build.py run --target-dir "$CARGO_TARGET_DIR" --record build.json -- cargo test --locked --lib jobs::
```

It holds a lock on the target for the whole run, rebuilds Core from this worktree if the target was last built from another one (edits in the same worktree stay incremental), and rejects the run if the source changes while it runs. Cross builds (`--target`) are not supported. `--artifact`/`--copy-to` record and copy built binaries, and `verify --record` checks them against the source later. The protection only covers runs that go through it. Otherwise give each worktree its own target.

Automated checks do not cover real Codex or Claude CLIs, models, or the desktop window. If your change touches one of them, try it against a separate test Workspace and say in the pull request how you did.

## Report a problem

Open a new issue and choose **Bug report** or **Feature request**. A useful bug report has:

- **What you ran.** The Core version, which is `version` and `releaseId` from `curl -s http://127.0.0.1:4317/api/health` (use your port). For a source checkout, `releaseId` is `development`; add the commit from `git rev-parse HEAD`. Also the Core host (Linux or WSL), the client (which browser, or the Windows desktop), and whether the Agent runs Codex or Claude, locally or over SSH, with the output of `codex --version` or `claude --version` on that machine.
- **The smallest steps that reproduce it,** with what you expected and what happened instead.
- **Evidence by identifier** rather than screenshots of whole conversations: a Job ID with its status and reason, a CI run link, a review ID, and only the log lines around the failure.

Never include tokens, API keys, the Codex or Claude CLI login files, SSH keys, full private conversations, or your Workspace data folder. Replace private paths, hostnames or repository names if they matter to you.

### Security problems

Report a security problem privately through GitHub's [private vulnerability reporting](https://github.com/YuzukiS/Yuzuno/security/advisories/new); [Security](docs/SECURITY.md) explains it. Do not describe a vulnerability or exploit steps, or include secrets, in an issue, a pull request or a CI log.

## Pull requests

- Base the change on the current `main`, and keep a pull request to one change. The template asks what changes and why, and which checks you ran.
- If the change alters what an Agent should do with Yuzuno's tools, update `.agents/skills/yuzuno` in the same pull request.
- CI runs on GitHub-hosted runners, for pull requests from forks too ([below](#pull-requests-from-forks), [CI](docs/pr-ci-runner.md)). List the checks you ran locally.
- A pull request that changes only `README.md`, `CONTRIBUTING.md` or Markdown under `docs/` gets a link check instead of the product checks; see [Documentation-only PRs](docs/pr-ci-runner.md#documentation-only-prs).
- A passing check or review does not merge a pull request; a maintainer does.

### Pull requests from forks

A pull request from a fork gets the same checks, on a fresh GitHub-hosted runner, with a read-only token and no secrets. The run uses the pull request's own copy of the workflow, so a first-time contributor's run starts only once a maintainer approves it.

- **A maintainer reads the whole change before approving that run,** including anything under `.github/`, `scripts/`, and build or test files.
- **Run the [checks](#checks) for the parts you changed** and list them in the pull request.

There is no guaranteed response time for issues or pull requests.
