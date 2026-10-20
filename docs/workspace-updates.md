# Managed Workspace updates

Settings → Updates updates the Linux/WSL Workspace service: Core, Web UI and
the Claude bridge with its locked SDK dependencies. It does not update the
Windows desktop executable, native Codex/Claude CLIs, or account configuration.

## User flow

Opening Settings checks for a newer release (at most every five minutes;
"Check for updates" asks again). A check never starts an update. The user then
chooses a version once with "Update to <version>", and the page carries that
release through the steps below, skipping those already done. The choice —
release, request ID and the last step Core accepted — is kept in browser
storage, so closing Settings, reloading or reconnecting continues the same
release; it never switches to another release. Any window may download and
prepare it, but Apply is sent only from the window where it was chosen, after
saving that window's drafts and uploads; another window takes over only when
the user clicks "Continue in this window" there. Each step is
judged from a status read after Core accepted the request, never from the
HTTP answer alone. A refusal or failure ends the chain with its reason; an
unanswered request is asked again from the next status, at most three times,
Apply always with the same request ID. "Cancel update" stops a download or the
wait for agents; during preparation it only stops the steps after it.

1. Download and verify a signed release when it is not a local package yet
   (see `acceptance/core-release/README.md`).
2. Prepare it. Preparation verifies and stages the complete package while the
   current Workspace continues accepting work.
3. Apply when idle. The browser saves drafts first. Core closes admission to new
   work, lists active Agents/approvals/requests and known running background
   shells, and waits up to 30 minutes. Background shells have their own reason;
   they do not make an idle Turn appear working. Unknown counts do not block.
   Existing approvals can still be answered. Cancel waiting reopens admission.
4. The separate helper drains accepted events and storage jobs, flushes and
   checkpoints SQLite, creates a backup, and stops the old Core through its
   private control socket. It starts the candidate against the same data and
   restores only the native sessions attached at the handoff.
5. After release, Workspace and full record health checks pass, the page offers
   to load the matching UI. The existing draft remains available.

Closing a browser does not cancel an accepted operation. Reopening reads its
durable progress. A timed-out POST is an uncertain response: inspect saved
status before retrying; a retry uses the same request ID. Waiting and helper
startup have bounded recovery paths. If the helper disappears during Stop, a
restarted Core acquires the helper lease, restores the recorded sessions and
records the actual running release before reopening admission. A Core still
finishing its own acknowledged Stop cannot take over.

Public `/api/health` and repeated Inspect probes read only identity/schema and
critical tables. They remain usable with a Damaged Agent so recovery UI stays
reachable. Full persisted history and payload validation runs in a separate
read-only process, once after seal, once before native restoration, and once
after restoration. Each invocation opens a new SQLite snapshot with a 120-second
hard budget; no earlier phase's result is reused. Failure before Stop keeps the
old service available. Failure after boot follows the existing compatible
fallback rules. The operation's `recordsProof` records the release, phase,
Workspace, snapshot-local data version and check time; it is an update receipt,
not a cached claim about future writes. Public health does not claim records-ready.

Automatic fallback requires the candidate to have exited and the previous
release to read the **current** database schema and record layout. A database
backup is never restored over newer records. Once native restoration has begun,
the helper does not forcibly kill an uncertain session to attempt fallback.
Interrupted tools are not advertised as resumable.

## Preparing reviewed packages

For the normal developer release path, use the
[resumable Core release workflow](core-release.md): reuse exact main CI and its
production artifact, sign once, run a short upgrade smoke, then explicitly
publish and verify download. The low-level packaging commands below remain
available for focused development and recovery.

Build in an isolated checkout and output directory. `tools/package-release.py`
assembles existing artifacts; it does not build, install or restart anything:

```sh
python3 tools/package-release.py \
  --core "$artifacts/yuzuno-workspace" \
  --helper "$artifacts/yuzuno-update-helper" \
  --web "$artifacts/web" \
  --claude "$artifacts/claude" \
  --result-validator "$reviewed_checkout/runtimes/result-validator" \
  --release-id "$release_id" --version "$version" --git-sha "$reviewed_commit" \
  --notes-file "$artifacts/notes.txt" --out "$bundle"
```

The Claude directory includes `bridge.mjs`, package manifests and installed
production dependencies. Inputs cannot contain symlinks except generated npm
`.bin` links, which are omitted. The package contains per-file hashes and sizes,
platform, protocol, schema and record-layout capabilities. Its printed manifest
hash must be approved through the release review process; a directory alone is
not a trusted candidate. Node and authenticated official CLIs remain host
prerequisites.

`runtimes/result-validator` is generated from the interactive-result contract
and committed; packaging checks the bundle against the hash in its
`contract.json`, and Core runs only the bundle its own build names. Core does
not require it to verify a release, so an older package without it remains a
valid previous or rollback release; that release just has no `result_publish`
validator.

Register a reviewed candidate with the running installation's packaged helper:

```sh
"$helper" register --install-dir "$install_root" --bundle "$bundle" \
  --manifest-sha256 "$reviewed_manifest_sha256" \
  --reviewed-source "$review_reference"
```

There is no arbitrary download URL or shell-script installation endpoint.
Registration does not apply the update. Packages, staging, backups and operation
logs live under the managed root on disk; normal retention keeps three release
packages and three backups, preserving the running/active-operation releases.

## First enablement plan

An existing development-checkout Core displays that managed updates are
unavailable. It needs one planned service transition before this UI can manage
later updates. This is a deployment step, separate from feature validation.

1. Review the exact commit and complete package; finish CI and the required
   independent review. Record the existing port, absolute data directory, cwd,
   Codex executable, Workspace ID and attached native session IDs.
2. Initialize a **new** installation root with the reviewed first package:
   use the register command above with `--initialize`. Existing data stays in
   its original directory, outside releases/incoming. Initialization refuses to
   overwrite an existing installation.
3. At the agreed idle point, close the old service gracefully using the existing
   service handoff process. Do not run two Cores against the same Workspace.
4. Start `releases/<release-id>/bin/yuzuno-workspace` with `--install-dir`, the
   original `--data-dir`, `--port`, `--cwd`, and `--codex` arguments. Verify
   `/api/health` reports the expected release and Workspace, `storageReady`,
   `apiReady`; the completed operation must also have an `afterRestore`
   `recordsProof` for that release with `recordsReady=true`. Confirm original
   native session references.
5. Reconnect the desktop and load the matching UI. Register the next reviewed
   candidate; further updates use Settings → Updates.

These instructions do not authorize switching the daily service. Feature
acceptance uses disposable data, dedicated ports and fresh browser contexts.

## Repeatable validation

`tools/updates-acceptance.py` uses complete A/B packages and optionally a
controlled startup-failure C package. It refuses reused test directories,
ports 4317/4391 and an occupied port. Run it under `target/heavy-slot.sh`:

```sh
python3 tools/updates-acceptance.py --a "$bundle_a" --b "$bundle_b" \
  --failure-bundle "$bundle_c" --run-dir "$new_test_directory" \
  --port 4472 --scripted --codex "$checkout/acceptance/turn-cost/fake_codex.py"
```

The scripted mode verifies busy/Pending preservation, rejection of fresh work,
duplicate apply, cancellation/retry, full payload persistence, real process
replacement and compatible fallback. `--native --codex /path/to/codex` instead
creates disposable authenticated Codex and Claude sessions and checks their
original IDs, messages, settings and read cursors across both switches. It
does not attach to the developer's sessions.

The script writes `receipt.json` and isolated logs. Its cleanup only signals
exact owned process identities when no native work is active; uncertainty is
reported without force killing. Browser tests use `YUZUNO_UI_DIST` pointing at
an isolated build and explicit API fixtures, with fresh Chromium contexts.
Actual package/SQLite/native checks and mocked UI fault checks are reported
separately in acceptance evidence.

## R1 failure verification

`tools/updates-acceptance.py --failure-sentinel` accepts a complete failure
bundle whose Core is `tools/fixtures/update-failing-core.c`. After the helper's
backup, that fixture writes a sentinel to the isolated live database and exits.
Acceptance asserts the compatible fallback still sees it and the prior backup
does not contain it. The marker and Workspace identity checks prevent the
fixture from targeting an ordinary installation. Full payloads are compared
using SHA-256 of canonical UTF-8 JSON fields across both handoffs, including
payloads newly accepted while waiting.

Local native behavior probes used Codex 0.162.1 `command/exec` with both PTY and
pipe sleep processes, and Claude Code 2.1.280 / SDK 0.3.296 with a localhost
fixed-response API returning one background Bash command. Neither used a remote
model. Both Codex commands ended on app-server termination; Claude reported a
`local_bash` task and its process ended after SDK `query.close()`. This establishes
that detach can end native work; it is not a claim about every manually detached
OS daemon. Known live Harness counts therefore prevent automatic detach.
