# Core release workflow

This is the repository's developer release procedure. Project-specific skills
may link here; they should not copy version numbers, workstation paths or
release policy into general-purpose instructions. End-user installation lives
in [Workspace updates](workspace-updates.md).

## Current public-release boundary

The public repository is the only active development source. Its CI builds and tests source on GitHub-hosted runners; it uploads no production inputs or installation packages. The first public delivery is source only.

The artifact-based workflow below describes the retained tooling used for historical private releases. It is not yet an end-to-end public-package pipeline: it requires a matching production-input artifact that the public CI does not produce. A future package change must establish inputs from the exact public source and resolve the package scope described in [Publication status](public-readiness.md#the-claude-agent-sdk). Do not use a historical private artifact as a substitute for those inputs, turn private CI back into an active development path, or publish a package merely because source CI passed.

## What runs by default

1. Reuse the accepted PR review and successful **exact main SHA** CI. Record the
   review reference; this tool does not independently approve that review.
2. Obtain the production artifact from that CI, package it with release identity
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

**Started main runs finish:**
- On `main`, a later push does not cancel a run that has started, so its inputs artifact is completed. A newer push to a PR still cancels that PR's older run.
- GitHub keeps one pending run per branch. While a main run executes, the next push's run waits; a further push cancels that waiting run and takes its place.
- So only a run that has started is sure to finish. Choose a candidate from a started or finished run.
- Nothing reruns or releases automatically.

Historical release inputs were built by the former private repository's self-hosted WSL Rust lane; public CI produces none. The retained build tooling uses Rust 1.97.1, Node
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
  declared license and the texts it ships, including the Claude Agent SDK's
  own terms as its package declares them.

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
CI runs in the public repository on GitHub-hosted runners and builds no release inputs.

First inspect the successful CI run/artifact metadata using `gh run view` and
`gh api repos/OWNER/REPO/actions/runs/RUN_ID/artifacts`. Freeze explicit inputs:

```sh
python3 tools/core-release.py init \
  --work-dir "$release_work" --repository OWNER/REPO \
  --sha "$reviewed_sha" --ci-run "$run_id" --artifact-id "$artifact_id" \
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
compares server digests, then publishes. Download verification uses the official
authenticated `gh` client and the original frozen public key. It does not start
another Core when the downloader itself is unchanged. Installed health is
read-only and runs fresh each time; it never triggers install/reload/restart.

## Development checks

`python3 -m unittest discover -s tools -p 'test_release_*.py' -v` covers fixed CI
identity, corrupted input, archive traversal, interrupted packaging, stage
continuation and authorization boundaries without network, build or keys.
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
[GitHub artifact API and digests](https://docs.github.com/en/rest/actions/artifacts).
