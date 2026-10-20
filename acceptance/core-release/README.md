# T-13: signed Core releases

Core/UI first slice; Windows desktop updater remains a separate T-13 phase.
Check -> download/verify -> existing T-12 Prepare -> explicit Apply when idle.
The service never installs from a browser-supplied URL or changes the daily build.

The host owner configures `<managed-root>/release-source.json` before starting
that managed Core (regular file, owner-controlled, not group/world writable):

```json
{"repository":"YuzukiS/Yuzuno","publicKey":"<trusted Minisign public key base64 line>"}
```

The source/key must arrive through a trusted installation/bootstrap step, never
from the feed itself. No production signing identity is established by tests.
Official `gh` supplies the Core host's existing authentication; tokens are never
extracted. Manual Check reads published stable `core-*` GitHub Releases (latest
publication among the first 100), independently of Desktop releases. No automatic
network checks. An unconfigured host still supports its existing local catalog.

Each release has three assets named `yuzuno-core-<linux-architecture>`:
`.json`, `.json.minisig`, `.tar.gz`. The signed descriptor binds repository/tag,
full T-12 manifest, archive size/hash and manifest hash. Verification uses
`minisign-verify` 0.3, also used by the official Tauri updater. Downloads stream
through the existing gh client, with size/time limits; extraction rejects links,
unlisted paths and duplicates. T-12 verifies the complete bundle and rollback
compatibility again before adding it to the local candidate catalog. Remote IO
holds no database locks. No schema or native session lifecycle changes.

Generate from a reviewed, already-built T-12 bundle with
`tools/sign-core-release.py --bundle ... --out <new-directory> --repository ...
--tag core-... --signing-key <operator-key> --public-key <trusted-public-key>`.
It uses official Minisign and creates local assets only; publishing is a separate
explicit action. Signing keys are never committed or printed. Test private keys
live only under the isolated target directory; committed fixtures contain only a
public key, signed metadata and tiny inert files that must never be executed.

Download jobs survive dialog closure. Progress is polled locally; cancelling
stops the owned gh reader and removes its scratch files. A Core restart reports
an interrupted download and requires a new check; the next download removes its
abandoned scratch. A successfully registered candidate survives restart via T-12.
Failed discovery keeps the last verified description, not an empty success.

Verification is isolated under `target/core-release`; use heavy-slot plus
systemd-run user scopes, zero swap, 4 GiB Core / 3 GiB UI+browser limits and timeouts.
Targeted coverage: genuine Minisign verification, tampering, unsafe archives,
remote failure, cancellation, official gh argv reuse, manual prepare/application
separation, draft preservation and dialog reopen. Production UI output is
`target/core-release/ui`; never default `web/dist`. Live acceptance and external
publishing results are recorded separately; this document is not a deployment receipt.

`tools/release-download-acceptance.py` starts a new managed installation from
bundle A, serves real signed assets through a local gh transport fixture, and
drives an independent Chromium through Check, Download, Prepare, Apply and
explicit Reload. It checks the actual old process exited, the new Core/UI match,
and the same workspace/project survived. It stops only its own recorded process
identities. Pass a new `--run-dir` under the project `target`, an unused port
4400–4999, `--a`, `--feed` and `--public-key`; set `YUZUNO_BROWSER_BIN` to an
installed Chromium. `--github` removes the transport fixture and reads an
already-authorized, already-published GitHub Release; it never publishes one.
Browser checks include light/dark at 20 px and a 760 px viewport. These checks
do not operate a daily window or establish Windows/native-session acceptance.

For an authorized private **Draft** Release, production discovery continues to
exclude it. The ignored Rust test
`private_draft_uses_real_gh_download_and_signature_verification` directly uses
the production gh reader, signature verifier and unpacker without installing.
Set `YUZUNO_RELEASE_ACCEPTANCE` to a local JSON file with `repository`, `draftId`,
`tag`, `publicKey`, `initialBundle`, `initialManifestSha256`, and a new `output`
directory under project `target`. Run the test with `--ignored --test-threads=1`
inside the same resource limits. This proves actual private GitHub asset IO and
verification, not production stable discovery. `latest=false` is insufficient
isolation: any published stable `core-*` release is eligible for discovery.

Acceptance, 2026-10-14: reviewed product source
`d385918028b9a5882415bc3b9e938a67af1e9747`, integrated base `7059435`, PASS.
The 25,656,576-byte signed archive contains a 133,969,438-byte complete bundle,
including the required result-validator runtime. Exact-source CI run
38648422692 (private repository) passed
all four jobs (408 Rust tests passed, five opt-in/native tests ignored).
Targeted Updates 42 and UI 8 passed; the Draft-only ignored test then passed
separately against real GitHub. Core/helper and isolated UI builds passed.

`live-2` used production UI/independent Chromium and real packaged Core/helper
on port 4493: Check -> signed download -> Prepare -> explicit Apply -> explicit
Reload passed. Workspace ID/project preservation, old Core exit, matching
replacement Core/UI, one Apply request, and retained browser storage have actual
assertions. Receipts/screenshots: `target/core-release/live-2/{receipt.json,browser/}`;
consolidated evidence: `target/core-release/validation-d385918.json`.
Its gh transport was local. A/B use the **same source and identical Core/helper
binaries**, with different release IDs; this verifies complete installation
replacement, not cross-version compatibility. No native sessions or draft-body
migration were exercised by this run. The receipt confirms its recorded process
identities stopped, not an audit of every descendant or exclusively graceful exits.

The separate real GitHub transport test downloaded all three assets from retained
private Draft 413246872 (private repository),
tag `core-t13-acceptance-20261014-d385918`, targeting the reviewed source above.
It used the production gh reader, signature verifier and unpacker; one test
passed. Server asset digests matched the prepared candidate, and `draft=true`
was confirmed after testing. Asset IDs/hashes and verification receipt are in
[draft-receipt.json](draft-receipt.json). Raw evidence remains under
`target/core-release/{private-draft-acceptance.log,draft-transport-d385918/}`.
This proves private asset transfer and verification, not real stable discovery
or application from that remote feed. Production discovery still excludes Drafts.

Independent GPT-6.1 Sol R1 passed at the source above. Its nonblocking follow-up
is to bound tar extension metadata/decompressed input before the tar iterator
allocates GNU/PAX metadata. No product code changed after that review for this
receipt. Historical `9d50e95`/`live-1` evidence remains on disk and is superseded
by the integrated `d385918`/`live-2` run for delivery.

No daily Core, data, web/dist or user window was changed. No stable release was
published. Production rollout still needs a chosen publisher signing identity,
secure key custody and trusted public-key/bootstrap configuration, followed by
a reviewed stable Core release and its real discovery check. The disposable
acceptance key is not a production identity. Windows updater remains outstanding.

References: [gh api](https://cli.github.com/manual/gh_api),
[Tauri's verifier dependencies](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/Cargo.toml),
[Minisign](https://jedisct1.github.io/minisign/),
[axoupdater](https://github.com/axodotdev/axoupdater).
Cargo-dist/axoupdater's installation receipt and self-install path do not manage
T-12's Core/UI/runtime version directories or quiesce/rollback protocol, so this
slice uses its existing installer with official gh and maintained verification libraries.
