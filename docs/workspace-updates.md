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
   to load the matching UI. The existing draft remains available. Once an
   update ends (installed, rolled back, cancelled, timed out or failed) and
   admission reopens, each Agent that yielded its Turn because the update asked
   it to pause gets one message to continue that work; the rules are in
   `core/src/updates/resume.rs`.

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

## Where releases come from

A check or download reads the GitHub repository named in the managed root's
`release-source.json`; the desktop app's updates (relayed by Core) read the
fixed `YuzukiS/Yuzuno`. Core asks the host's `gh` first, with its sign-in. Only
when `gh` answers that it is not installed or not signed in does that one check
or download read GitHub's public releases itself, without a sign-in:

- It reads two things from `https://api.github.com`, an address no setting or
  environment variable changes: the release list
  (`repos/<owner>/<repo>/releases?per_page=100`) and one release asset
  (`repos/<owner>/<repo>/releases/assets/<id>`). It sends no token, cookie or
  other credential.
- It follows GitHub's redirect to an asset's file only to an `https://`
  address, at most five times.
- TLS trusts the roots built into Core (webpki-roots), not the host's
  certificate store.
- Behind a proxy it uses `HTTPS_PROXY` (or `https_proxy`), except for hosts
  that `NO_PROXY` (or `no_proxy`) names, as `gh` does. Only an `http://` proxy
  works, through CONNECT, so TLS still runs to GitHub; a sign-in in its address
  goes to the proxy alone. A proxy that is set but cannot be used stops the
  read: Core does not go around it. No other proxy variable or system setting
  is read.
- Nothing is trusted for coming this way. A Core release still needs the
  publisher's minisign signature on its descriptor, the archive's signed
  SHA-256 and every file's signed hash; a desktop installer still needs the
  desktop app's own signature.
- Any other answer from `gh` (not found, forbidden, rate limited, unreachable,
  timed out) is reported as it is, without trying the public way.
- GitHub allows 60 requests an hour per address without a sign-in. A check
  makes three (the list, the descriptor and its signature) and a download one
  more; past the limit the check says so. A repository that is not public
  answers "not found" this way: sign in with `gh` on the Core host.
- A release found this way shows "· public download" after its source in
  Settings → Updates. `releaseSource.via` in the updates status says which way
  (`gh` or `public`) the last check or download went.

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
  --result-validator "$artifacts/result-validator" \
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

`runtimes/result-validator` is generated from the interactive-result contract.
Its `contract.json` and notices are committed; `validator.mjs` is not
(`npm --prefix web run build:result-validator` makes it). A release Core is
built for one `validator.mjs`: `tools/build-core-artifact.py` generates it
first and compiles its SHA-256 into Core, which then runs no other bundle.
Pass the folder that Core was built with, such as the build's
`result-validator` input: packaging refuses a bundle whose SHA-256 the Core
does not carry, so a release is never packaged unpinned. Core does not require
the validator to verify a release, so an older package without it remains a
valid previous or rollback release; that release just has no result or
Brief validator.

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
