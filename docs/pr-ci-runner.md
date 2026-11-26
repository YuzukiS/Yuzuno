# CI

Every pull request to `main` and every push to `main` runs [the CI workflow](../.github/workflows/ci.yml) on GitHub-hosted `ubuntu-24.04` runners. Each job's first step, before checkout, refuses any runner that is not GitHub-hosted. After checkout, `.github/scripts/hosted-guard.sh` checks again and records the runner image, CPUs, memory and disk in the job's summary.

| Job | What it checks |
| --- | --- |
| Core (build and test) | the launcher, CI-script and release-flow tests, the desktop health rule, `cargo build --all-targets`, every Core test and the doc tests. Each test process runs one test at a time; up to one process per CPU runs at once, and `.github/scripts/core_tests.py` checks that every listed test ran |
| Lint (report-only) | `cargo fmt --check` and `cargo clippy`, reported as warnings that do not fail the run |
| Web UI (typecheck, build, test 1/2 and 2/2) | typecheck, build, and half of the `web/tools/*.test.mjs` files each, one at a time on its own VM; shard 1 also runs the desktop connection page |
| Claude bridge (unit tests) | the bridge's unit tests. The pinned Claude Agent SDK is installed from npm and loaded; no Claude process starts |

- **Permissions:** the token is read-only and the workflow uses no secrets. It runs on `pull_request`, never `pull_request_target`, so a fork's pull request also gets a read-only token and no secrets.
- **Forks:** a fork's pull request runs the same checks. A first-time contributor's run waits until a maintainer approves it; see [Pull requests from forks](../CONTRIBUTING.md#pull-requests-from-forks).
- **Caches:** only Cargo's. The Rust cache keeps compiled dependencies, not this repository's own crates; every run restores it and only a push to `main` saves it. Its key depends on the pinned toolchain alone, since the jobs install it in a `RUSTUP_HOME` of their own. npm caches nothing, so no `node_modules` or package archive is kept between runs.
- **Disk:** Core and Lint remove preinstalled SDKs they do not use only when `/` has less free space than they need (`.github/scripts/free-disk.sh`).
- **No artifacts:** CI uploads no build output, package or `node_modules`, and builds no release packages.
- **Cancelling:** a newer push to a pull request cancels its older run. On `main` nothing is cancelled: each push has a concurrency group of its own commit, so every `main` commit gets its own run, even when several merges land within one run's time.

## Documentation-only PRs

A pull request whose changes are all to `README.md`, `CONTRIBUTING.md` or Markdown under `docs/` skips Core, Lint, Web UI and Claude bridge. They show as skipped, not passed, and the run's summary says so.

- **Change scope** decides first. It compares the checked-out merge commit with its first parent, after checking that the parents are the PR's fixed base and head. It uses the base's copy of `.github/scripts/pr_scope.py`, so a PR cannot change the rule that judges it. Renames count as both the old and the new path. Any other path, a symlink or mode change, a parent mismatch, an empty list or an error keeps the full checks.
- **Docs (local links)** then runs instead. It fails on any local Markdown link or anchor the PR breaks, in any tracked Markdown file. External URLs are not fetched.
- If Change scope itself fails, the product checks run.
- A push to `main` always runs the full product checks.
- GitHub counts a skipped job as passing a required check. If required checks are added, require Change scope and Docs as well.

## Jobs a PR might not need (record only)

For every other pull request, Change scope also writes which jobs the PR might not need, under **Might not be needed (record only)** in its summary and as a `record_only: might_skip=…` line in its log (YN-235, for the R-47 trial). **Nothing reads it: every job runs as before.** Whether any job is ever skipped this way is a separate decision.

- It names Core (build and test), Lint and Claude bridge only when every change is an added, modified or deleted regular file under `web/` that Core's CI does not read. Anything else, a mix with any other path, a doubt or an error records **None** and why.
- Core's CI reads, under `web/`: every file at `web/`'s top level (`npm ci` reads `package.json` and `package-lock.json` there); every `web/` path a Rust source outside `web/` names, in `include_str!`, `include_bytes!`, `concat!(env!("CARGO_MANIFEST_DIR"), …)`, a joined path or a comment; and every file the result validator's build loads, followed from the `build:result-validator` script through static and dynamic imports, re-exports, `require` and `new URL(…, import.meta.url)`. Type-only imports load nothing and are not followed. A load named by anything but one string literal makes the answer unknown.
- It looks at both the base and the merge commit, so a file the base reads or the PR makes read counts. As for the decision above, the base's copy of the script answers.
- Not followed: a path that code builds from pieces (`join("web").join(…)`, a folder and a name), and the Core job's Python and shell steps, which today read no `web/` file but their own temporary fixtures.
- `test_pr_scope.py` checks each of these forms in small repositories, and in this repository that every `web/` file the Rust macros name and, where `web/node_modules` is installed (as in the Core job), every module rolldown loads for the validator is counted as read.

## Check locally

- `actionlint .github/workflows/ci.yml` checks the workflow.
- `python3 -m unittest discover --start-directory .github/scripts --pattern 'test_*.py'` runs the CI-script tests. `test_public_ci.py` among them checks the rules above: the runner, the triggers, the read-only token, no secrets, no uploads, pinned actions and caches saved only from `main`.
- The [checks](../CONTRIBUTING.md#checks) in Contributing run each job's commands.
