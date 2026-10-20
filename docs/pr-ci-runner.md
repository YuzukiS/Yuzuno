# CI

Every pull request to `main` and every push to `main` runs [the CI workflow](../.github/workflows/ci.yml) on GitHub-hosted `ubuntu-24.04` runners. Each job's first step, before checkout, refuses any runner that is not GitHub-hosted. After checkout, `.github/scripts/hosted-guard.sh` checks again and records the runner image, CPUs, memory and disk in the job's summary.

| Job | What it checks |
| --- | --- |
| Core (build and test) | the launcher, CI-script and release-flow tests, the desktop health rule, `cargo build --all-targets` and a serial `cargo test` |
| Lint (report-only) | `cargo fmt --check` and `cargo clippy`, reported as warnings that do not fail the run |
| Web UI (typecheck, build, test) | typecheck, build, every `web/tools/*.test.mjs` and the desktop connection page |
| Claude bridge (unit tests) | the bridge's unit tests. The pinned Claude Agent SDK is installed from npm and loaded; no Claude process starts |

- **Permissions:** the token is read-only and the workflow uses no secrets. It runs on `pull_request`, never `pull_request_target`, so a fork's pull request also gets a read-only token and no secrets.
- **Forks:** a fork's pull request runs the same checks. A first-time contributor's run waits until a maintainer approves it; see [Pull requests from forks](../CONTRIBUTING.md#pull-requests-from-forks).
- **Caches:** only Cargo's. The Rust cache keeps compiled dependencies, not this repository's own crates; every run restores it and only a push to `main` saves it. npm caches nothing, so no `node_modules` or package archive is kept between runs.
- **No artifacts:** CI uploads no build output, package or `node_modules`, and builds no release packages.
- **Cancelling:** a newer push to a pull request cancels its older run. A run on `main` that has started finishes.

## Documentation-only PRs

A pull request whose changes are all to `README.md`, `CONTRIBUTING.md` or Markdown under `docs/` skips Core, Lint, Web UI and Claude bridge. They show as skipped, not passed, and the run's summary says so.

- **Change scope** decides first. It compares the checked-out merge commit with its first parent, after checking that the parents are the PR's fixed base and head. It uses the base's copy of `.github/scripts/pr_scope.py`, so a PR cannot change the rule that judges it. Renames count as both the old and the new path. Any other path, a symlink or mode change, a parent mismatch, an empty list or an error keeps the full checks.
- **Docs (local links)** then runs instead. It fails on any local Markdown link or anchor the PR breaks, in any tracked Markdown file. External URLs are not fetched.
- If Change scope itself fails, the product checks run.
- A push to `main` always runs the full product checks.
- GitHub counts a skipped job as passing a required check. If required checks are added, require Change scope and Docs as well.

## Check locally

- `actionlint .github/workflows/ci.yml` checks the workflow.
- `python3 -m unittest discover --start-directory .github/scripts --pattern 'test_*.py'` runs the CI-script tests. `test_public_ci.py` among them checks the rules above: the runner, the triggers, the read-only token, no secrets, no uploads, pinned actions and caches saved only from `main`.
- The [checks](../CONTRIBUTING.md#checks) in Contributing run each job's commands.
