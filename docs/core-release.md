# Core release workflow

This is the repository's developer release procedure. Project-specific skills
may link here; they should not copy version numbers, workstation paths or
release policy into general-purpose instructions. End-user installation lives
in [Workspace updates](workspace-updates.md).

## Current public-release boundary

The public repository is the only active development source. Its CI builds and tests source on GitHub-hosted runners and uploads nothing. Production inputs come only from the separate [release-inputs workflow](#ci-artifact-and-compatibility), run on request for the head of `main`.

Those inputs are public, so they must not carry the Claude Agent SDK ([Publication status](public-readiness.md#the-claude-agent-sdk)); the workflow refuses inputs that do. The build leaves the SDK out of the Claude runtime: it writes `claude-agent-sdk.json`, from which Core obtains the SDK on the user's machine, and at the SDK's `package.json` a placeholder written by Yuzuno, because installed Cores refuse a release without a file there. That placeholder, with exactly its bytes, is the only file the check accepts in the SDK's directory. Do not use a historical private artifact as a substitute for those inputs, turn private CI back into an active development path, or publish a package merely because source CI passed.

## What runs by default

1. Reuse the accepted PR review and successful **exact main SHA** CI. Record the
   review reference; this tool does not independently approve that review.
2. Obtain the production artifact built on request for that SHA, package it with release identity
   and notes, and sign once using the existing local publisher key.
3. Run one short isolated baseline → candidate upgrade: start, Core/UI identity,
   Workspace identity, persisted conversation/project/task/settings/read cursor,
   saved budget and the helper's after-restore records proof.
4. When the specific release is authorized, publish the same three signed files,
   then download them through official `gh` and verify bytes and signature.
5. After the user installs from their existing window, read installed identity,
   public health and the completed restoration proof. This step starts no work.

There is no default browser matrix, new model review, paid native conversation,
failure injection, concurrency test or full feature regression at release time.
PR review and CI own feature regression. If the diff changes update admission,
replacement, downloader/trust, schema migration, records verification or fallback,
add that mechanism's existing focused acceptance test and reference its result.
Run the full matrix for an explicit periodic regression or relevant risk, not
because a new version number exists. An ambiguous browser locator does not erase
an already successful process replacement: preserve the failure and supplement
only the affected assertion, as done for T-76.

## CI artifact and compatibility

The historical private `CI` kept its PR tests. Only a push to its `main`, after those four jobs
passed, built `core-inputs-<40-character SHA>-<run attempt>` with
`tools/build-core-artifact.py`. The artifact has `build.json` and `inputs.tar.gz`:
release-mode Core/helper, raw Vite UI, locked production Claude SDK/runtime and
the committed result validator. No release version or signing key is needed.
The release version marker is added once by the existing packager.

**Public inputs on request.** `.github/workflows/release-inputs.yml` runs only when someone starts it (`workflow_dispatch`), on GitHub-hosted ubuntu-24.04, with a token that reads contents and actions and no secret:
- It builds `github.sha`, the head of `main` when it was started, and only after the `CI` workflow has passed on that commit's push to `main`. It cannot build an older commit: start it right after choosing a candidate, before anything else is merged.
- It runs `tools/build-release-inputs-ci.py`, then `tools/release-inputs-check.py`. The check refuses inputs from another commit, repository, run or attempt, an archive that differs from `build.json`, and any file of the Claude Agent SDK (anything in its directory but the placeholder with exactly its bytes), before `core-inputs-<SHA>-<run attempt>` is uploaded for 14 days.
- `core-release.py init` then names both runs: `--ci-run` is the CI run that tested the commit, `--inputs-run` this one. The artifact, its name and `build.json` must belong to the inputs run, and its files must not include the SDK, by the same rule.

**Started main runs finish:**
- On `main`, a later push does not cancel a run that has started, so its inputs artifact is completed. A newer push to a PR still cancels that PR's older run.
- GitHub keeps one pending run per branch. While a main run executes, the next push's run waits; a further push cancels that waiting run and takes its place.
- So only a run that has started is sure to finish. Choose a candidate from a started or finished run.
- Nothing reruns or releases automatically.

Historical release inputs were built by the former private repository's self-hosted WSL Rust lane; the public repository builds them only on request, as above. The retained build tooling uses Rust 1.97.1, Node
22.23.2 and Python >= 3.11. Pinned cargo-zigbuild 0.23.4 and Zig 0.15.2
cross-link for `x86_64-unknown-linux-gnu.2.35`, independent of the host's newer
glibc. Both linker versions and the target are recorded in `build.json`.
`tools/build-release-inputs-ci.py` prepares fresh toolchains and caches with
checksum-locked bootstrap downloads; it never adopts PR build caches. The
persistent host remains trusted.
ELF checks reject glibc requirements newer than 2.35 and unexpected shared
libraries; the required library list and tool versions are recorded. Target
hosts are Linux/WSL x86_64 with glibc >= 2.35, Node 22 and installed authenticated
official CLIs. Alpine/musl, older glibc, ARM and the Windows desktop binary are
not covered by this artifact. SQLite is bundled; no secret is sent to CI.
The isolated smoke additionally exercises the production binary on the release
host; it is not a claim of a complete Linux distribution matrix.

Licenses travel with the bundle. Every file below is generated from what the
build actually contains, so a dependency change updates it without a manual step:
- `licenses/LICENSE` is the project's Apache License 2.0.
- `licenses/THIRD_PARTY_NOTICES-core.txt` lists the crates linked into `bin/`,
  as cargo resolves the release build (`x86_64-unknown-linux-gnu`, default
  features), with each crate's declared license and the license texts it ships.
  `tools/build-core-artifact.py` writes it with `tools/third_party_notices.py`,
  offline from the build's own crate sources. Crates used only while compiling
  are named but not reproduced.
- `licenses/rust-std-COPYRIGHT-library.html` is the building toolchain's own
  notice for the Rust standard library.
- `web/licenses/` carries the project license, the font's SIL OFL 1.1 and
  `THIRD_PARTY_NOTICES.txt`, which the Vite build writes from the modules and
  assets it bundled.
- `runtimes/result-validator/THIRD_PARTY_NOTICES.txt` is committed with the
  validator and checked with it.
- `licenses/THIRD_PARTY_NOTICES-claude-runtime.txt` lists the packages under
  `runtimes/claude/node_modules/`: the production set of
  `runtimes/claude/package-lock.json`, as the build installs it with
  `npm ci --omit=dev --omit=optional`. `tools/runtime_notices.py` first checks
  the installed packages against the lock file; a missing, extra or
  differently versioned package stops the build. It then writes each package's
  declared license and the texts it ships. The Claude Agent SDK, which the
  build then leaves out, is listed as not in the release, with the source and
  integrity Core obtains it from.

Nothing is chosen for a package that offers several licenses. A package that
ships no license text is listed as such. A new web package without one fails
`web/tools/third-party-notices.test.mjs` until it is reviewed. For a runtime
package that ships none, `tools/runtime-license-sources/` may record the
license text of its exact source, with the evidence that ties them. The notices
then reproduce that text, marked as not shipped in the package, but only for
the recorded name, version and lock integrity, and only if the text's SHA-256
matches. Nothing is fetched while building.

The immutable GitHub artifact ID, run/attempt, exact source, archive SHA-256 and
per-file inventory are checked on download. The ZIP digest is checked against
the GitHub API, not merely an adjacent checksum file. Artifact retention is 14
days (subject to repository limits). Expired/missing/mismatched input stops the
flow. Explicitly obtain another successful artifact for the same reviewed SHA;
there is no silent local rebuild fallback. Older releases without this artifact
retain their existing signed evidence; do not rebuild them to populate CI.

## One entry point

Use Python >= 3.11, `gh`, `minisign` and the existing publisher key on the
controlled Linux release host. Use an isolated checkout. Heavy local commands
run through the project's Jobs and shared heavy slots with bounded resources;
two heavy jobs maximum, no polling/watcher jobs. A 1.5 CPU / 3 GiB / zero-swap
Job is sufficient for prepare/smoke; account for collector reservation too.
The old private CI and runner budget belong to the historical workflow. Active
CI runs in the public repository on GitHub-hosted runners; release inputs come from the on-request workflow.

Start the inputs build for the candidate with `gh workflow run release-inputs.yml --ref main`, then inspect both runs and the artifact using `gh run view` and
`gh api repos/OWNER/REPO/actions/runs/RUN_ID/artifacts`. Freeze explicit inputs:

```sh
python3 tools/core-release.py init \
  --work-dir "$release_work" --repository OWNER/REPO \
  --sha "$reviewed_sha" --ci-run "$ci_run_id" --inputs-run "$inputs_run_id" \
  --artifact-id "$artifact_id" \
  --release-id "$release_id" --version "$version" --review "$accepted_review" \
  --notes "$release_notes" --baseline "$previous_bundle" \
  --public-key "$existing_publisher_public_key"

python3 tools/core-release.py resume --work-dir "$release_work" \
  --signing-key "$existing_publisher_secret_key" --minisign "$minisign"
```

`init` only writes a new release work directory. `resume` obtains the fixed CI
artifact and runs fetch → package → sign → smoke. It stops before publication.
It reuses `tools/package-release.py` and `tools/sign-core-release.py`, never
generates a key, changes `web/dist`, installs into a daily root or stops daily
Core. The key path is passed to minisign; secret key contents are not read into
the report or uploaded. `publisher.pub`, release notes and input identity are
frozen. A file lock prevents concurrent commands for the same release.

`report.json` is the one summary: frozen inputs, stage status, original failed
attempts, logs, output hashes and continuation point. The signed files remain in
`signed/`. A summary receipt is evidence, not an independent review or permission.

**A release the baseline cannot take as an update.** Some releases install only into a new data directory, such as the session store's first release ([ADR 0002](adr/0002-session-store-new-data-directory.md)). For these, the baseline's update admission refuses the release, because of its schema or records span.
- **Freezing:** freeze such a release with `init … --new-data-directory`. The baseline is still the previous published release.
- **What the smoke checks instead of an upgrade:**
  1. The baseline, with a seeded Workspace, refuses the release when its own helper is asked to register it, naming the storage. `prepare` and `apply` are refused, and no update operation starts.
  2. After that, the baseline still runs its own release on the same Workspace, with that Workspace's records layout.
  3. The release then installs into a new installation and data directory: `register --initialize`, as in [the install guide](independent-core.md#install). It opens a new Workspace, serves its own UI, and keeps a seeded conversation, project, task and budget across a restart.
  4. The baseline's data directory is unchanged, file for file.
- **Which smoke runs:** the smoke refuses a release frozen this way if the baseline would take it as an update, and refuses the in-place smoke for one it would not. Publication still requires a passed smoke.
- **`health`:** after a new installation, `health` reads the installed identity and requires that no update operation exists, since there is no restoration proof to read.
- **Existing installations:** once such a release is published, their update check reports it as one they cannot read, and downloads nothing. The release notes must give the new-directory way on.

```sh
python3 tools/core-release.py status --work-dir "$release_work"
# After fixing only the reported problem, use the same workspace:
python3 tools/core-release.py resume --work-dir "$release_work" --minisign "$minisign"
```

Completed stages are checked and reused. Completed packaging/signing whose
receipt was interrupted can be adopted only after checking the fixed inputs,
bundle contents, signature and exact archive. Changed bytes fail closed.
An interrupted download retries the download; it never signs different bytes.
An uncertain publish is reconciled against remote tag and asset digests; there
is no overwrite/clobber operation. Failed logs are retained separately.

The short smoke uses `core-release-smoke.py`, the existing scripted Codex fixture
and update helpers. It creates an owned `/tmp/yzrel-*` directory, selects a free
loopback port and keeps Unix socket paths short. It preserves data and phase
receipts for inspection. Before upgrading, it explicitly saves and reads back
a small job budget different from the host's suggested default, then checks
that saved value after replacement. A retry uses the same apply request ID and durable
operation, skips a completed upgrade, and can finish cleanup alone. If apply was
accepted before the runner stopped, resumption and exception cleanup first check
the fixed operation and owned process identities, then wait up to 180 seconds
for its terminal record and helper exit. An unresolved operation or missing
helper leaves the processes and evidence intact and reports the uncertainty;
it never authorizes another apply. A product
upgrade failure or rollback requires investigation; it is not automatically
attempted again. Cleanup checks exact PID/start time/executable identities, and
uses `SO_REUSEADDR` so TCP TIME_WAIT is not mistaken for a running service.
When evidence is no longer needed, remove only that receipt's disposable root
after confirming its owned processes have stopped. It contains no user data.

## Publication and installed health are separate actions

The commands below require authorization for the specific release. Existing
authorization is sufficient; this document does not add a new approval loop,
grant permanent release permission or authorize daily installation.

```sh
python3 tools/core-release.py publish --work-dir "$release_work" --minisign "$minisign"
python3 tools/core-release.py verify-download --work-dir "$release_work" --minisign "$minisign"
# Only after the user has installed this release:
python3 tools/core-release.py health --work-dir "$release_work" \
  --origin "$installed_local_core_url" --workspace-id "$expected_workspace_id"
```

Publication pins the tag to the fixed SHA, uses a draft for partial uploads,
compares server digests, then publishes. It creates the draft with the request
`gh release create --draft` makes, and records the release ID from GitHub's
reply in `remote-release.json` before reading anything. Later reads, uploads
and publication address that ID, not whichever release the tag resolves to,
so nothing after creation depends on finding the draft by its tag. If the
reply is lost, the receipt keeps `"id": null` and `publish` adopts the one
release GitHub lists for the frozen tag and source. Until it is listed,
`publish` stops rather than creating another: the tool cannot tell a release
that was never created from one that is not listed, so check the repository's
releases, and keep the receipt while a release for the tag may exist. Two
listed releases, another tag or source, an unexpected asset or a different
digest also stop for inspection. Each failed attempt keeps its error and log
in the report.

Running `publish` again recovers the same authorized release: the same work
directory, release ID, tag, source and signed files. Assets whose name, size
and digest match are kept, and only missing ones are uploaded. It never
creates a second release, moves the tag, signs again or replaces an asset.
A new release, or different bytes for any reason, needs its own
authorization, a new release ID and a new work directory; never edit
`remote-release.json` or `signed/` to make a work directory accept it.

Download verification uses the official
authenticated `gh` client and the original frozen public key. It does not start
another Core when the downloader itself is unchanged. Installed health is
read-only and runs fresh each time; it never triggers install/reload/restart.

## Development checks

`python3 -m unittest discover -s tools -p 'test_release_*.py' -v` covers fixed CI
identity, corrupted input, archive traversal, interrupted packaging, stage
continuation and authorization boundaries without network, build or keys.
Publication runs against `tools/fixtures/fake-gh.py` as `gh`, with lost
replies and new drafts missing from the list or from reads by ID.
For actual smoke development, run the generic smoke tool against two existing
immutable packages in a bounded Job; do not publish a test version. Retain the
first failed attempt if a fixture needs correction.

When changing interruption recovery, `acceptance/core-release/recovery.py`
accepts `--baseline`, `--candidate`, `--old-revision` and a new `--out` directory.
It holds only the disposable helper's lock after apply acceptance, demonstrates
the old runner's premature stop, and checks both exception cleanup and hard-kill
resumption with the fixed runner. The same operation must finish without another
apply or any process signal before its terminal state. Run this focused check
under the normal bounded Job wrapper; it is not an extra per-release gate.

Design references: [DORA deployment automation](https://dora.dev/capabilities/deployment-automation/),
[DORA test automation](https://dora.dev/capabilities/test-automation/),
[GitHub artifact API and digests](https://docs.github.com/en/rest/actions/artifacts),
[GitHub releases API](https://docs.github.com/en/rest/releases/releases).
