# T-88 acceptance: install a Linux Core and connect to it

Installation checks for [docs/independent-core.md](../../docs/independent-core.md). Run full labs as Jobs in new, explicit directories. None should use the daily Core, its data or windows. The package workflow needs no runtime login; the historical browser and SSH labs below use existing signed-in CLIs.

## Final public candidate: `install-lab.py candidate`

One spec file fixes the candidate: its repository, release tag, publisher key, source commit, and the SHA-256 of the manifest and of the three release files. Take the digests from where the release was signed or published, not from the files being checked:

```json
{"repository": "OWNER/REPO", "tag": "core-YYYYMMDD-abcdef0", "publicKey": "RW…",
 "sourceSha": "<40 hex>", "manifestSha256": "<64 hex>",
 "assets": {"yuzuno-core-linux-x86_64.tar.gz": "<64 hex>", "yuzuno-core-linux-x86_64.json": "<64 hex>",
            "yuzuno-core-linux-x86_64.json.minisig": "<64 hex>"},
 "note": "optional free text"}
```

Every stage first checks that [the install guide](../../docs/independent-core.md#install) downloads from that repository, writes that key and that update source, and (if its `gh` prerequisite names a repository) names that one. It also checks that the files given are exactly the spec's, and after the signature verifies, that the signed descriptor names the same tag, repository, source commit and manifest. Each stage writes `--report` (a new file) and stops at the first failed check.

| Stage | Adds | Needs |
|---|---|---|
| `check` | Nothing is started. With `--package-dir`: the files, the signature and the descriptor. | `--minisign` with `--package-dir` |
| `package` | The offline workflow below: install, restart, remove and reinstall over kept data. No sign-in. | `--package-dir --minisign --lab --port` |
| `sign-in` | The installed Core's own host check (what Machines and New agent run), with Claude Code given a **new empty profile** (`CLAUDE_CONFIG_DIR` in the lab). It must report signed out, name that folder, and suggest the sign-in command for this host. Then the profile must hold no credentials. No Agent is made and no model is called. Claude key and token variables are not passed to Core. | `--package-dir --minisign --lab --port --node --claude` |
| `first-use` | [The guide's download and one real turn](#published-release-first-use-install-labpy-first_use) from the spec's repository, then the downloaded files against the spec. **A paid model call:** run it once the candidate is published, and again only when the distribution changes. | `--minisign --lab --port --node --browser`, the operator's own `gh` and Claude sign-ins |

```sh
python3 acceptance/t88/install-lab.py candidate sign-in --spec /absolute/candidate.json \
  --package-dir /absolute/release-files --minisign /absolute/minisign \
  --node /absolute/node --claude /absolute/claude \
  --lab /absolute/new-lab --port 4597 --report target/t88-candidate/sign-in.json
```

The lab must be new and outside the checkout. Every report also records the lab host's user-manager cgroup controllers (`jobsHost`). Local Jobs need `cpu`, `memory` and `pids`; see the guide's [prerequisites](../../docs/independent-core.md#prerequisites-on-the-core-host). After `first-use`, check local Jobs with `jobs-smoke.py` on that lab, as below.

**Settled by the first public release,** core.13 ([results](#public-core13-results-2026-10-21-utc)). A change to any of these changes the candidate, so its stages run again afterwards:

- **The repository.** `YuzukiS/Yuzuno` is the public repository, built from a cleaned source snapshot; the earlier private one is `YuzukiS/Yuzuno-dev`. The guide's download, update source and `gh` prerequisite, the signed descriptor's repository and Core's relay for desktop updates (`REPOSITORY` in `core/src/updates/desktop_releases.rs`) name `YuzukiS/Yuzuno`.
- **The publisher keys.** core.13 is signed with the key the guide names (`KEY`). The Windows app's built-in update key (`plugins.updater.pubkey`, set when the installer is built) applies to desktop installers, and none is published here. Changed bytes always need new signatures, whichever key signs them.
- **The Claude Agent SDK.** The Core package carries `claude-agent-sdk.json` instead of the SDK, and the first Claude start downloads the locked version unless another installed release has it ([The Claude Agent SDK](../../docs/public-readiness.md#the-claude-agent-sdk)).
- **`gh`.** The release files are public. The guide's download and Core's updates use `gh`, which needs a sign-in to some GitHub account but no access to the repository; an account without access has not been tried. Whether the guide adds a download without an account is open ([Other open decisions](../../docs/public-readiness.md#other-open-decisions)).

## Published release first use: `install-lab.py first_use`

This narrow workflow downloads an explicit published release using the guide's four installation blocks (only the tag and two paths change). It verifies the publisher signature and package hashes, then uses a new data directory, loopback port and persistent Chromium profile. The browser creates a local Claude Agent with a Haiku model, saves **Ask before actions**, sends one real turn, and approves only the exact command `python3 -I -c 'print("T88_APPROVED")'`. A disposable project-local `permissions.ask: ["Bash"]` fixture makes this harmless probe require native approval. No host permission configuration or credential file is changed or copied.

The browser closes completely, reopens, and checks the same Workspace, turn, saved settings and unsent draft. It repeats those persistence checks after stopping/restarting only the lab Core. No update/reinstall matrix is repeated and no further model turn is sent. Unexpected approval commands fail the run instead of being accepted.

```sh
python3 acceptance/t88/install-lab.py first_use \
  --tag core-20261017-f8b9266 --public-key '<trusted publisher key>' \
  --lab /absolute/new-lab --port 4599 \
  --minisign /absolute/minisign --node /absolute/node --browser /absolute/chromium \
  --report target/t88-first-use/report.json
```

The lab directory must be new and outside the checkout. The harness requires this checkout's `web/node_modules/playwright-core`; the installed product does not. Put the already installed native `claude` executable on the chosen Node directory's `PATH` or the normal system `PATH`. Preserve the operator's original `HOME` and existing sign-in when submitting the Job; do not point `HOME` at a new folder. Other inherited Core/editor/proxy overrides are removed. The report states that this is an **existing-account** test, not first login on a fresh OS/account. Native session storage may be written to that account's normal Claude directory by Claude itself. The lab retains its private logs, screenshots and browser profile; the selected report path lets a Job collect the result.

Only the browser/Agent workflow belongs in this managed Job. It must not launch nested resource managers or submit systemd Jobs from the test Core. A local Jobs probe, when available, runs separately after this workflow has stopped its Core. New-account sign-in, a separate physical host and Core service installation remain separate acceptance boundaries.

After that Job has ended, the small `jobs-smoke.py` probe can reuse **only its stopped lab**:

```sh
python3 acceptance/t88/jobs-smoke.py \
  --first-use-report target/t88-first-use/report.json --port 4601 \
  --report target/t88-first-use/jobs-report.json
```

Run it directly in the same logged-in Linux user's shell with a working systemd user bus. It refuses a managed Job cgroup, checks the retained install digests and listener ownership, and uses only that lab's Workspace. Its fixture task belongs to the disposable Workspace; it does not create a task in the daily one. The native Agent stays disconnected, so the Job's completion mail cannot start a second model turn. Only the lab Core's budget is set (0.6 CPU, 192 MiB including the collector). One command prints a marker under 0.5 CPU / 128 MiB / zero swap / 512 tasks; its retained OS limits and Core logs must agree. Cleanup stops the lab Core, and cancels an unfinished probe on failure.

## core.9 first-use results (2026-10-18 UTC)

- Product: published signed `core-20261017-f8b9266` (private repository), `2026.10.17-core.9`, source `f8b9266b5e2db50ae1075b8771b6aa368d07d333`. Downloaded using the guide, not a local build. GitHub's three published asset digests matched the downloads, minisign verified the descriptor, and the manifest/helper verified installation.
- SHA-256: archive `4ea8a18212ec2d54175a18f76e013a1c754560e38c46a2ee4ac546aff7daecbf`; descriptor `42a575467ca934c5d9d0bf0c2658fb6f8e4d455c51c19702ba9b0576657e4315`; minisig `53798a841f69737c134d5d6ca01534ba0c328844a4941d2104da67e8ea6c4b6c`; manifest `be34799091a8e97c2bcf18d8d8c6b74d5a2e1c867420ecca6396f2e8b856e65d`.
- Environment: existing Linux UID 1000 on Arch/WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, glibc 2.44, Python 3.14.7, systemd 262, Node 22.23.2, Claude Code 2.1.280, Chromium 153.0.8010.52, gh 2.102.0. Existing native Claude and gh sign-ins were used normally. `HOME` was not redirected and no credential files were copied. The browser lab inherited only HOME/USER/LOGNAME/PATH/LANG; the later Jobs probe also retained the user's existing systemd bus variables.
- Browser Job `a80e27c7-a9f4-461c-bfcb-f53280643628`, frozen harness `a2de5bff50bccc1f541b3a1de6dd68c8ac7267e1`, succeeded 04:00:29–04:00:53Z with 2 CPU / 3072 MiB / zero swap; peak 1,539,706,880 bytes. **20 orchestration checks plus 16 browser assertions passed**, no browser page errors. One real Haiku turn, one exact Bash approval, no repeated model request. Independent browser processes kept the same request/reply, draft and settings, both before and after Core restart. Core and bridge executable/cwd/argv/environment referenced no source checkout.
- Browser report: `target/first-use-r1/report.json`, SHA-256 `27b92286e0fbe79167184c6aed573e418a5c9295b22a83e3d28a24b471ed5606`. The isolated run lives under `/tmp/t88-first-use-core9-a2de5bf`; port 4599. Workspace `da513089-5f1e-401c-baba-4694b7de79bd`, Agent `d982449d-c5fd-45ec-9c50-3f67d1807cfe`, turn `64e4237e-1c26-4a24-a34f-c329c47a2636`. Logs/profile/screenshots stay private in the lab, not in this repository (screenshots can show account details).
- Local systemd probe: separate direct short check, with that Core stopped before and after, port 4601; **11 checks passed**. Installed Core Job `27b74a9b-9596-4816-b8c6-8b4d8f27e568`, attempt `c6531ba6-f3e5-4fbe-85c0-5ed8b7d7eb87`, succeeded at 04:03:47Z. Native cgroup evidence: `cpu.max=50000 100000`, `memory.max=134217728`, `memory.swap.max=0`, `pids.max=512`; exit 0, output `T88_LOCAL_JOB_OK`, peak 14,880,768 bytes. Agent remained disconnected and its turn count stayed at one. No nested manager, global service, system account or daily Core was changed.
- These runs precede two extra retained-evidence assertions: the client now checks the sole native Bash result/output, and the Jobs probe also compares the descriptor digest to the original report. Those conditions were checked against the already retained records without sending another model turn or rerunning the full workflow. Targeted checks and report hashes below distinguish that validation from a new complete run.

Retained validation: `target/first-use-r1/retained-checks.json`, SHA-256 `db54257a3ee3de3ccc0185e763385394c2cc627a9fbb99d13a9250aa6168c5bb`, confirms the one completed native Bash action, its exact input and `T88_APPROVED` output, plus the original descriptor digest. Jobs report `target/jobs-smoke-r1/report.json` has SHA-256 `96f54c674d210ff7f3a21356d8e22e79c52ee9591ac80c5c08f6452f88337861`; the probe's source at execution (before the added descriptor assertion) has SHA-256 `35a8a895e12c3643c358e932cf06ebc80ccd0c03d276250550fcc7d1aae8db6b`. The unchanged package helpers came from the frozen browser harness. The two guide adaptation tests, CLI help and JS syntax checks passed after the assertions were added.

Still untested: a new user's actual native sign-in, a new OS account/full Linux installation or second physical machine, remote clients on core.9, and Core as a systemd service. The existing Ubuntu rootfs and earlier Lab A/B evidence below remain separate; this run did not repeat their update/reinstall or tunnel matrices. To close the fresh-user gap, a tester needs a separate supported Linux x86_64/glibc ≥2.35 account/host, an interactive login to their own Claude/Codex account, Node/CLI dependencies and a functioning systemd user manager for Jobs. They should perform the guide's first conversation steps themselves; credentials should never be sent to the maintainer.

## Offline signed package: `install-lab.py package`

Supply an existing release's three files (archive, JSON descriptor and `.minisig`), an independently trusted publisher key, expected tag, new lab directory and loopback port. The verifier must already be installed in the environment running the lab.

```sh
python3 acceptance/t88/install-lab.py package \
  --package-dir /absolute/release-files --public-key TRUSTED_PUBLISHER_KEY \
  --tag EXPECTED_RELEASE_TAG --lab /absolute/new-lab --port 4597 \
  --minisign /absolute/minisign
```

This verifies the signature **before** reading the descriptor, checks the archive and extracted manifest digests, then registers the package with its bundled helper (which verifies the manifest's files). It starts only the installed Core, checks its health and served UI bytes, creates a project marker, restarts, removes only the lab's program installation, and reinstalls over the retained data. Both restarts must retain the Workspace and project. Before any HTTP request, `/proc` must show that the lab's own process owns the listener. Occupied ports and existing lab directories fail without reuse.

`report.json`, command logs and Core logs stay under the new lab. Failures exit nonzero. The report records the release source/digests, OS/libc, mapped libraries and checks. It does **not** claim a real Agent conversation, approval, browser rendering/draft persistence, online update or systemd Job.

## Disposable Ubuntu rootfs: `rootfs-lab.py`

Prepare a dedicated Ubuntu rootfs, not a host installation. The tested input is the official [Ubuntu Base 22.04.5 amd64 image](https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release/). Before extraction, verify `SHA256SUMS.gpg` with the [Ubuntu CD Image signing key](https://ubuntu.com/tutorials/how-to-verify-ubuntu) fingerprint `843938DF228D22F7B3742BC0D94AA3F0EFE21092`, then compare the image against the signed `SHA256SUMS`. The image SHA256 is `242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a`.

Extract into a **new** directory using `tar --no-same-owner`. Install `python3`, `libgcc-s1` and `ca-certificates` from Ubuntu's signed apt repositories inside that rootfs, using a writable bubblewrap bind only during preparation; do not install on the host. Disable package service startup with a rootfs-local `policy-rc.d` returning 101. Preparation may use the network; the product run below has its own network namespace. Do not mount host libraries, source, login folders or user homes. Do not override `HOME`.

In this rootfs, `apt-get update` succeeded with Jammy main/restricted/universe/multiverse and updates/security/backports enabled, but `apt-get install minisign` returned “Unable to locate package”. This records the tested repository indexes, not a claim about all Ubuntu 22.04 installations. The tested verifier is the upstream [minisign 0.12 Linux archive](https://github.com/jedisct1/minisign/releases/tag/0.12), downloaded over HTTPS, SHA256 `9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73`. Put only `minisign-linux/x86_64/minisign` at rootfs `/usr/local/bin/minisign`, mode 755. It has no ELF interpreter and needs no host libraries. This tool download is pinned by digest, distinct from verifying the Yuzuno release's publisher signature.

Create empty `/lab` and `/package` mountpoints inside the rootfs. Keep the external package directory limited to the three regular release files. The runner refuses extra files or symlinks there. First test namespace access outside the native Agent sandbox:

```sh
unshare --user --map-root-user --mount --pid --net --fork /usr/bin/true
python3 acceptance/t88/rootfs-lab.py \
  --rootfs /absolute/disposable-ubuntu-rootfs --package-dir /absolute/release-files \
  --public-key TRUSTED_PUBLISHER_KEY --tag EXPECTED_RELEASE_TAG \
  --lab /absolute/new-rootfs-lab --port 4597
```

The runner does a second bubblewrap preflight, copies only the two standalone Python harness files into the lab, and mounts the prepared rootfs and package read-only. Only the new lab is writable; `/tmp`, `/proc` and `/dev` are private mounts. User, PID, mount, network, IPC and UTS namespaces are separate; the inherited environment is cleared and only `PATH` and `LANG` are explicitly set (`bubblewrap` also supplies `PWD`). `/lab/run/report.json` is the product report; the outer `isolation.json` retains arguments and harness hashes. Network isolation means the same numeric port cannot reach the daily Core.

This is a separate userspace distribution on the same host kernel, with namespace root mapped to the existing host user. It is **not** a new OS account or physical machine, and does not provide a systemd user manager. The wrapper is for an explicitly prepared disposable rootfs, not arbitrary untrusted filesystem images.

Quick harness checks (including a temporary loopback listener; no Core):

```sh
python3 -B -m unittest discover -s acceptance/t88 -p 'test_package_lab.py' -v
```

## Historical Lab A: `install-lab.py authenticated` (published releases)

Runs the guide's own shell blocks (Install, Start, Check it, Stop) unchanged except for the reader's documented choices: the release, the folders, the port, the working folder and `--codex /bin/false`. The window allowed real Claude only. The browser steps are in `client.mjs`.

1. Install core.6 with gh, minisign and the update helper. Check `release-source.json` is owner-only and that nothing in the managed root is group- or world-writable.
2. Start core.6. Check that Core and its Claude bridge run from the managed release and reference no path in the source checkout.
3. In the browser: create a Claude Agent, run one approved file write, leave a draft, close. Reopen: the history and draft are there.
4. Update to core.7 through **Settings → Updates** (`web/tools/release-download-browser.mjs`, real `gh` against GitHub). Check the same Workspace. Send the draft.
5. Stop and start core.7. Delete `$ROOT` and keep the data. Reinstall core.7. Check the same Workspace and history.

The old fixed release/tool choices are now explicit. This workflow still requires a source checkout for the browser harness, an external lab directory, and existing Claude/gh logins. It preserves only the existing login locations/identity and gh tokens (without changing HOME), then sets a PATH containing the chosen tools/Node and standard system directories. Shell/editor variables and Core overrides are excluded. It is not a clean-account test. Choose a target release that the Updates UI will offer; do not rerun it without authorization for real model calls.

```sh
python3 acceptance/t88/install-lab.py authenticated \
  --lab /absolute/new_lab --minisign /absolute/minisign \
  --node /absolute/node --browser /absolute/chromium --port 4598 \
  --from-tag INITIAL_RELEASE_TAG --to-tag TARGET_RELEASE_TAG
```

`--doc` may select a guide snapshot (default: this checkout's `docs/independent-core.md`). This historical workflow runs the guide's `pkill` command, so its lab path accepts letters, digits, slash, underscore and hyphen only; use a distinct prefix. No personal fnm path or core.6/core.7 choice is assumed by the installation entry point.

## Lab B: `tunnel-lab.mjs` (the candidate build)

One Core on port 4489, reached only through SSH tunnels with different local ports. It sits behind a user-level `sshd` on 4490; the lab key may forward only to `127.0.0.1:4489`.

1. Linux: Chromium through OpenSSH on 5489. Check that a foreign Origin, the other loopback name, a mutation without the client header, and a domain Host are each refused through the tunnel.
2. Windows: Edge (headless, its own profile) through Windows' `ssh.exe` on 5490. Check that `curl.exe` sees the same Workspace. The tunnel and Edge are proven before any model turn.
3. Each client runs a Claude turn with **Allow once** in its page. Each tunnel is dropped with an unsent draft, then restored. On Linux, a reload while the tunnel is down is also tried.
4. Both clients show one Workspace with four completed turns.

Windows processes are stopped only if their command line names the run's directory. The copied key is made owner-only with `icacls`, and is deleted at the end.

Usage: `tunnel-lab.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>`.

## Results (2026-10-17)

- Lab A r1, Job `44da2561`, on 238909d: 37/37 checks passed (core.6 → core.7, Workspace `8d5fd9fa…`).
- Lab B r1, Job `36a6b105`, on 836d280: failed before any model turn. Windows OpenSSH ignored the copied key because the temp folder's inherited ACL allowed another group. This was fixed in af3d838.
- Lab B r2, Job `424facd4`, on af3d838: 21/21 checks passed (Edge 155 on Windows 11, Chromium 153 on Linux).

Reports and screenshots stay local in `target/t88/lab-*`. Screenshots show the account panel, so they are not committed.


## Ubuntu rootfs results (2026-10-18 UTC)

- Harness base: `f4ffdeb4b2d926d62ced63b6350e3c697702e32a`; successful run source: `0ffd702ad1f535e858f196c1a13d7f22845d550d`. Later changes document evidence, clarify the environment receipt, reject overlapping package/lab paths, narrow the historical login environment and let stop signals escape health retries. Eight targeted harness tests cover these guards; the successful installation sequence was not repeated.
- Product: published core-20261017-a5adb60 (private repository), version `2026.10.17-core.8`, source `a5adb60e7205164cc686de6e15c96bcfc3a43d65`. This is the signed release, **not** a build of the harness's newer base.
- Inputs: the three release files matched the published GitHub asset SHA256 values, then the rootfs verifier checked the descriptor's publisher signature and signed archive/manifest digests.

| Input | SHA256 |
|---|---|
| Archive | `309560b713be7d361c8e4983cca412ce97bf75ce65de0b10aaab39e1d85d87ef` |
| Descriptor | `46235ac00135528cd48b780127f5cbc24a2b15933cdbfd45b6672ddf33bbda44` |
| Signature | `fb3270749338ce3475eab6d2bdfe3a8925002bf6b9d25fd5b70ca0c6364c83f7` |
| Manifest | `e0c6c4f0b1fc984ed61065d7d94fd98d983c9f10f53efdafc643947e5501495f` |

Environment: Ubuntu 22.04.5, libc6 `2.35-0ubuntu3.8`, libgcc-s1 `12.3.0-1ubuntu1~22.04.3`, Python 3.10.12, static minisign 0.12; shared WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`. UID map `0 → host 1000`, not a separate account. Actual environment keys were `LANG`, `PATH`, `PWD`; `HOME` was absent. `/proc` maps showed the installed Core and Ubuntu's loader, libc, libm and libgcc only (plus the lab database mapping). No runtime CLI, Node, login or source checkout was present in the rootfs.

| Job | Actual result |
|---|---|
| `f975fec5-3aad-434d-914c-fd647e31da8b` | Preparation failed at apt's missing minisign; Ubuntu image signature/digest had passed. No product run. |
| `4bf8cc26-903e-403d-8e6c-f9bbce78826b` | Preparation succeeded using the upstream static verifier and Ubuntu's own packages. |
| `5e626a79-5cd7-4e4a-9a9b-5eb966dd8bea` | 17 checks passed through the first Core stop. Harness bind probe mistook TCP TIME_WAIT for a live listener; stopped before restart. Fixed with SO_REUSEADDR and a real-socket regression test. |
| `df1f8545-4ccf-4612-9e67-b59e131cc2e3` | **37/37 passed**, fresh lab directory: signature, registration, Core health, served UI bytes, restart, remove program/retain data/reinstall, same Workspace and project, all three graceful stops. Job exit 0. |

The successful Job used 2 CPU / 2048 MiB / 0 swap, peaked at 323084288 bytes and completed in about 31 seconds. Reports remain local under the worktree's `target/t88-ubuntu-r2`:

- `run/report.json`: SHA256 `fd892564d34fc680a723bbe0ca39f7dbdfbe22932f0f64bf720a971bd30604b2`.
- `isolation.json`: SHA256 `a18e32acf608a115ed80d554b85a6ee288b5e46586c0df8a078253419f9522f8` (the original receipt's environment description omits bubblewrap's PWD; the actual report records all three keys).

The changed historical authenticated workflow was checked for argument parsing and syntax only, not rerun with paid model calls. Lab A/B evidence above is historical. This rootfs result does not cover browser rendering/drafts, native runtime login/conversation/approval, online update, systemd Jobs/service, a new OS account or a second physical machine. No release was built, signed, published or deployed by this slice, and the daily Core and web build were unchanged.

## Public core.13 results (2026-10-21 UTC)

The product: the first public release, `core-20261021-827bd32` (`2026.10.21-core.13`, source `827bd32cc373259ece3a3d25cbbf8e14713faa97`). Both runs downloaded its three files from `https://github.com/YuzukiS/Yuzuno/releases/download/core-20261021-827bd32/` with `curl`, in a cleared environment with no GitHub account or credentials (`--netrc-file /dev/null`). They compared the files with the digests recorded when the release was signed, not with digests read from the files:

| Input | SHA-256 |
|---|---|
| Archive | `29d8e625d738ce7573258ac9247b3242db1db4b606752eb366701d0b04b9d0b1` |
| Descriptor | `3e1e5ae0b44f00b9dbf17e4771b4ae789d25b9aa93730bd77ea688d3b77f8f90` |
| Signature | `97126f68537f04bb9dd8de287fc1b727083d3282cd70af35e32531731352f87c` |
| Manifest | `4a18f3b4129dcbf87ed373df836f58d7088ba9197f27737c50cebf81344701f4` |

Both ran on the same computer and WSL2 kernel (`6.18.33.2-microsoft-standard-WSL2`) as the results above, as the existing Linux user. Neither had a native CLI, a sign-in, a model call, a browser or the daily Core; the data was made up.

**Candidate check and Ubuntu rootfs: Job `f030798d-ed22-4d7a-8504-0f5e4bf6c2f5`, passed.** The harness was this folder at `827bd32`, from a clean checkout of that commit.
- `install-lab.py candidate check` with the downloaded files: 4 of 4. The guide names the spec's repository, key and update source; the files are exactly the spec's; that key verifies the descriptor; the descriptor names the tag, source and manifest.
- `rootfs-lab.py`, on the rootfs prepared for core.8 above, reused read-only. Checked again first: Ubuntu's `SHA256SUMS` signature (gpgv, key `843938DF228D22F7B3742BC0D94AA3F0EFE21092`), the image digest and the minisign binary's digest. Packages: libc6 `2.35-0ubuntu3.8`, libgcc-s1 `12.3.0-1ubuntu1~22.04.3`, python3 `3.10.6-1~22.04.1`, ca-certificates `20260601~22.04.1`.
- **37 of 37 checks passed:** the signature, registration, Core health, the served UI's index and assets, restart, removing the program and reinstalling over the kept data (same Workspace and project), and three graceful stops. `/proc` maps showed only the installed Core, Ubuntu's loader, libc and libm, and the lab database. 2 CPU / 2048 MiB / zero swap; about 35 seconds.
- Reports, kept outside the repository: `candidate-check.json` `ae001c61571c4a6dcb93adf302cc995799070673940b421feadeb95eecca5408`, `download.json` `2e65813106ac70e0ff5fe3151b3813d6a085e427ae40e4f5a59ed188b68c421a`, `run/report.json` `5ceb7b18b665e0a79a4658ec348e015e4c369a385a8fe9dbc338e4e237b4b027`, `isolation.json` `76529e88473729a0d10bcd4f5e663a136da035f51ee0187f98604b5ead04e26e`.

**First Claude start on Arch Linux: Job `9805ef17-cfa6-49ca-8300-c8a09f2765c0`, passed.** Arch Linux, glibc 2.44, Node 22.23.2; not the Ubuntu rootfs, which has no Node. The script was a one-off, not in this repository, adapted from `package_lab.py`'s verify and register steps; the reports record its SHA-256, `e0c8582e1f0d6a6ced58d1c04746cdcfc529af30188a6f024510326efc913aea`.
- **Online, 18 of 18.** A new installation registered with `yuzuno-update-helper register --initialize`, with core.13 as its only release, so no other release could supply the SDK, and no data folder yet. Core's environment held only `HOME` (a made-up folder with one made-up Claude session), `PATH` (Node, `/usr/bin`, `/bin`), `TMPDIR` and `LANG`: no proxy variables and no `claude`. The first `GET /api/claude/sessions` for the session's folder took 0.74 s including the preparation, and the bridge listed the session. Afterwards there was exactly one prepared runtime and no temporary file. Its receipt names the source `registry https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.296.tgz` and the locked name, version and integrity. The prepared SDK's 19 files match the locked manifest by SHA-256 and size.
- **Offline, 13 of 13.** The same installation and data in a new network namespace with only loopback up (`unshare -rn`, then the ordinary user in a nested user namespace); an outside address gave `ENETUNREACH`. Core started again and the bridge listed the session. The prepared runtime was the same one, and all 6,906 of its files kept their SHA-256, size and modification time.
- Reports, kept outside the repository: `online.json` `62171e69a65025a76444f47a02ff6591618b872c7bc85e922e12bf53c0af0f42`, `offline.json` `f1061eee427d395d988b0b40634f9b6a4e7ad96d37b8b21541895dd2afbd8fd3`, `prepared-tree.json` `fcc4774a4188d10b8324b5b5e32e3982f0ae9a4a6e8e4ad404914ab9da86707d`.
- **The first attempt failed because of its setup** (Job `9f598ce3-9a52-480a-a9f4-716e7930cd26`, kept as recorded). Its installation folder was deep inside a checkout. Core refused to start, saying it could not bind its private update socket because the path was too long: a Unix socket path must be shorter than 108 bytes. The checks before the start had passed. The second run used a short folder. The guide's paths are far below that limit.

Not covered by either: a sign-in, a conversation or approval, a browser, an update, systemd Jobs, the first Claude start on glibc 2.35, a new OS account or another computer.

## Real Mac browser to Linux Core: `cross-machine-lab.py`

Run this lab only for an explicitly authorized Mac SSH target. It needs an existing Chrome installation and Python 3 on the Mac, existing Linux CLI/GitHub logins, Linux OpenSSH server/client tools, and this checkout's normal `web/node_modules/playwright-core` dependency. It installs no software on the Mac and copies no private key or native login. The product comes from an explicit signed release; the source checkout supplies only the controller.

The Linux host needs a private IPv4 interface reachable **from the Mac**. The lab starts its own SSH server on an unused port of that interface, with password authentication and shell sessions disabled. Only a new key generated on the Mac is authorized, and it may forward only to the lab Core's loopback port. This server's `StrictModes no` is confined to the disposable configuration under a private lab directory in `/tmp`; do not apply it to a real SSH service. The host key is transferred over the already authenticated control connection and pinned in a temporary known-hosts file. Core never binds that network interface.

Use four distinct unused ports. The Mac's browser port must differ from Core's. `--cdp-port` must be free on both machines and is forwarded only on loopback for browser control. Replace the target and private interface with the authorized machines, and the tool paths with existing local installations:

```sh
python3 acceptance/t88/cross-machine-lab.py \
  --lab /tmp/t88-cross-machine-new-run \
  --report target/cross-machine-new-run/report.json \
  --tag core-20261018-e635e5e \
  --public-key RWSX8DdJd8/UQ/CyT737AvEnpKM3vpI4npuO1aMf6h1Tx+e40VVWG03r \
  --minisign /absolute/minisign --node /absolute/node --sshd /usr/sbin/sshd \
  --mac you@authorized-mac --linux-host 192.168.1.10 \
  --port 4611 --ssh-port 4612 --mac-port 5611 --cdp-port 9611
```

Submit the whole command as one managed Job (2 CPU, 2048 MiB RAM, zero swap, 720-second timeout for the recorded run). There is no nested Job manager. Linux's cgroup limits constrain the local Core/controller only; they do **not** constrain the Mac Chrome/SSH children. The Mac helper is a foreground process with a 900-second lifetime, EOF/signal cleanup, and one temporary profile; it closes only its own process groups. The controller requests cleanup explicitly, stops its own Core/SSH processes and retains the Linux reports/data. If SSH itself is lost, local completion cannot prove remote cleanup: inspect the recorded cleanup error and verify the helper's bounded cleanup before claiming it succeeded.

For a transport-only recheck, append `--connection-only` with new lab/report paths. This installs a fresh signed Core and checks SSH authentication, forwarded HTTP and direct TCP reachability, then cleans up without starting Chrome or sending a model request. The recorded recheck used 1 CPU, 1024 MiB RAM and a 360-second timeout. It does not repeat the browser/draft/restart checks.

The install script is extracted from the guide's four installation blocks, changing only the tag/download/install choices. The controller verifies signed/published digests again, then checks:

- Rejection of the wrong SSH host key and an unauthorized client key, followed by successful authentication with the Mac-only disposable private key.
- A real Mac-originated `ssh -N -L` connection to Linux with different local/Core ports; direct Core HTTP is unreachable, and foreign Host/Origin and missing-client-header requests receive 403.
- Chrome on the Mac creates a **Local** Claude Agent (local to Linux Core), chooses Haiku, requests one harmless print command and approves only that exact command once. A temporary project-local permission rule forces this approval; global rules stay unchanged.
- Tunnel loss pauses sending and preserves the unsent draft. Restoring the tunnel reconnects the already-open page. A second loss/reload produces a browser connection error; restoring/reopening recovers the draft.
- Closing/restarting Chrome with the same profile and stopping/restarting the isolated Core preserve the same Workspace, completed turn, model, permission choices and draft, without another model call.
- Remote temporary profile/keys and owned processes are cleaned up. Screenshots and raw receipts stay in the private Linux lab; they can include account labels and machine paths and are not committed.

### Separate Mac client results (2026-10-18 UTC)

- Executed harness: `67887faac511e6d57c006ceb48e8ced26201890a`, based on `e635e5e8e7cc9f67737a76b6662a689aed2b4d85`.
- Product: published signed core-20261018-e635e5e (private repository), `2026.10.18-core.10`, source `e635e5e8e7cc9f67737a76b6662a689aed2b4d85`; no candidate product build.
- Managed Job: `2f14afd1-b202-43ba-b0f9-170f6e56b759`, attempt `d2d4e7b1-47f7-4a61-9ed0-e1c1db36029a`, 19:14:40–19:15:18 UTC, exit 0. Linux memory peak 830046208 bytes. The report recorded **30 orchestration checks + 40 browser checks passing**, including retained-history checks across two reopen steps; no browser page errors were recorded. The original direct-reachability assertion could misclassify HTTP errors and is superseded by the TCP recheck below; the original report is retained unchanged.
- Linux: Arch/WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, existing user/native CLI login, new install/data/project directories. The installed Core and Claude bridge referenced no source checkout.
- Separate physical Mac: Darwin arm64, macOS `27.0.1`, Chrome `154.0.8037.98` (headless), OpenSSH `10.3p1`. Mac and Linux used their existing private network. A Linux Playwright controller drove the real Mac browser over a separate loopback CDP tunnel; browser requests and UI mutations used the Mac's Core tunnel, while the controller used read-only Linux API checks for assertions.
- Exactly one Haiku turn completed after one exact `python3 -I -c 'print("T88_APPROVED")'` approval and returned `FIRST_USE_OK`. No repeat paid turn was sent for reconnect tests.
- Mac cleanup receipt confirmed the profile/key directory removed and owned processes stopped; a follow-up SSH read confirmed the directory absent and no listeners on either Mac test port. Both isolated Core instances stopped gracefully. No daily Core, global SSH service, browser profile or account configuration was changed.

| Artifact | SHA256 |
|---|---|
| Published archive | `40f649bdfcae9f1f70d874a95909a125944191553d0a8d63a9b2e30c44da80aa` |
| Descriptor | `ece7dd5945359ec7d717b924b8760372071e6fd0666d1235e9b5db1f01bd8421` |
| Signature | `34c365fbc8488fd3ad5953571b9237eba61b127d92c25fcdba2a7bd44dd8b612` |
| Manifest | `e7bb34bd9a6ead9103fb15b543cec391366acb416b680a697419e69841d68057` |
| Retained `target/cross-machine-r1/report.json` | `9c1bbbb1d6ca053c01d56674dd2dbb20ff4be2f08532992692233d8f43094ab9` |

After the full run, the harness tightened target/tag argument checks, preserved the guard receipt, made cleanup inspect returned flags and the helper exit status, and handled already-closed cleanup pipes/processes. A CLI check found that `PYTHONSAFEPATH=1` hid adjacent helper imports; the entry point now explicitly imports from its own checked-in directory. Two existing guide tests and two new preflight tests cover those paths, including safe imports and four invalid-input cases. These changes are later than the full browser run's executed harness; no final-head full browser/model rerun is claimed.

**Transport evidence correction:** independent review `0f99c52d-ce77-4eb2-8009-c64d4e6e78d0` found that catching `OSError` in the original HTTP probe also caught HTTP 403. A responding HTTP server could therefore be reported as unreachable. The probe now checks the TCP handshake directly: any accepted connection is reachable, explicit connection refusal/timeout/unreachable routes are recorded with their cause, and unexpected local errors fail the probe. Four regression tests cover an actual HTTP 403 listener, a refused TCP connection, timeout and an unexpected local error. They passed along with the four guide/preflight tests above.

- Corrected executable harness `e1223e6b98337a1b4306bdf05022504f63f58a9f`, managed Job `dc97c4c9-bcc8-4ccd-b150-50974a53bf5f`, attempt `44bd50de-b46a-4734-8b5a-6d1ac7988d65`, 19:31:16–19:31:27 UTC, exit 0. **17 transport/install/cleanup checks passed**, Linux memory peak 417538048 bytes. Same signed core.10 bytes, new isolated installation/data and new Mac temporary keys.
- Mac direct TCP result: `reachable: false`, `reason: ConnectionRefusedError`, `errno: 61`. The SSH-forwarded health check succeeded, all four HTTP boundary cases returned 403, and wrong host/client keys were rejected. The remote cleanup receipt confirmed its temporary directory removed and owned processes stopped. This result establishes the direct-connection boundary that the original probe could not.
- No browser or model turn ran in this recheck. Its inventory observed Chrome `155.0.8059.84`, whereas the full UI run used `154.0.8037.98`; the later installed browser version is **not** an additional browser acceptance result. The recheck's final graceful-stop label says `restart` because it reused the full-run label; it performed only one Core start/stop. The final source corrects that label and adds these notes without changing the tested transport probe.
- Retained `target/cross-machine-transport-r2/report.json`: SHA256 `9045a37aa439ccb7a42a4ea1d167645746927d890cb95fec26632358ed91df21`.

This fills the **second physical machine / Mac Chrome client** gap. It does not establish fresh OS/account/native CLI login, Safari, a Mac Core package, native desktop support, network provisioning, another Windows simultaneous client, online updating, Core as a service, Windows Jobs or GPU support. T-88's remaining platform/account work stays separate.

## Separate Linux host over SSH: `remote_host_lab.py`

Three stages on a separate Linux host reached with SSH (`BatchMode`, a known host key), using a published signed release and the guide's own blocks. Every file this lab puts on the host is under `--remote-base/<run>`, which must be inside `--remote-allowed`; the host's `HOME`, global configuration, services, account and linger are never changed, and no credential is read, copied or sent.

- `install` (no sign-in): downloads the release's three files here with `gh` (the host needs no GitHub login), copies them and a pinned minisign binary to a new run folder, runs the guide's verify/register/release-source blocks there, starts Core on the host's loopback port as the guide does, checks health and the served UI through `ssh -L`, stops Core with the guide's interrupt, and checks that nothing changed where Core, Claude, Node or Codex would write by default.
- `pre-login`: the installed run's Core with a new empty Claude profile and data folder (`<run>/prelogin`); the published UI creates a Claude Agent and sends one harmless message; a Core restart and a new browser process follow. It refuses to start if a Claude key or token variable is set in the host's shell (it records the variable's name, never its value). What the UI and Core say before any sign-in is recorded as observed, not assumed. The run's own profile, kept for the owner's sign-in, is not touched.
- `first-use`: after the account owner has signed the run's own, still empty profile in with `claude-login.sh` (copied to the host and run there by the owner, in their own SSH session), `first-use-client.mjs` runs the first real conversation with exactly one approval, a reopen and a Core restart. It refuses to start unless that profile holds a sign-in (the file is checked for presence only).

```sh
python3 acceptance/t88/remote_host_lab.py install --target <ssh-alias> \
  --tag <release tag> --public-key '<trusted publisher key>' --minisign /absolute/minisign \
  --remote-allowed '$HOME/<allowed folder>' --remote-base '$HOME/<allowed folder>/<runs>' --run r1 \
  --remote-port 4617 --local-port 5617 --node-bin '$HOME/<allowed folder>/<node>/bin' \
  --lab /absolute/new-lab --report /absolute/report.json
# then, on the host, as the account owner: sh claude-login.sh <run folder>
python3 acceptance/t88/remote_host_lab.py first-use <the same host options> \
  --node /absolute/node --browser /absolute/chromium --lab /absolute/another-new-lab --report ...
```

Host paths go into the host's shell unquoted so that `$HOME` or `~` expand there; they must be absolute or start with `$HOME`/`~`, use plain characters and no `..` (refused before anything starts). `--host-path` (default `$HOME/.local/bin`, where Claude's installer puts `claude`) and `--node-bin` are put first on Core's `PATH` on the host; `--host-python`, `--repository` and `--asset` default to the guide's values. The browser clients run here from this checkout (they need `web/node_modules/playwright-core`). Each report records this file's and the clients' SHA-256. The run folder is checked to be inside the allowed folder before anything is made, through the deepest folder that already exists, so a wrong `--remote-base` or a link out of the allowed folder creates nothing. If a stage fails once it has started Core, its start included, Core is stopped (best effort) before the failure is reported, also when the tunnel will not close; after a stage that went well the stop is a checked step, and a tunnel that will not close then fails the stage. Each cleanup failure is recorded with the original one. The boundary check tolerates exactly one change in the account's home: a Claude Code skill-sync round under `~/.claude/skills/synced`, and only while a `claude` process the account ran before the stage is still running. In `install` it also requires that Core ran no child and the run's profile stayed empty, so nothing of the run could have made it. In `pre-login` and `first-use` Core runs the run's own Claude, so such a change cannot be told apart from one that Claude made in the account's home; it is tolerated, but listed raw in the report for that reason. Everything else it finds is reported and fails the run.

`test_remote_host_lab.py` runs the guards locally, without SSH: host path and name checks, the run folder made or found only inside the allowed folder (nothing is made outside it, and a link out of it is refused), the boundary listing and its one tolerated change, the pre-login key probe, the first-use fixture, the cleanup after a failed check or Core start or a tunnel that will not close, and `claude-login.sh` with a stand-in `claude`.

### core.11 results on an independent host (2026-10-19 UTC)

The host: an independent Ubuntu 22.04.5 server (glibc 2.35, systemd 249 user manager, linger off, Python 3.10) reached over SSH, with the account's existing Claude Code 2.1.295 and a verified Node 22.23.2 placed inside the allowed folder. Its name, account and paths are kept out of this repository; the original reports, which name them, stay private. The release: published signed `core-20261018-6f29d20` (private repository, core.11); descriptor `e328b6dcc751cee483025713fec26cb281cb77546695a748f45f31d45fe781d4`, signature `a4402bee56437dc5c4642b6463ad10555af875d3f8272d1bd22c759d7e5012bd`, archive `464922b097790d40458be01dd92adec0ad241be5fbb7b33b3cd611379247e941`, minisign binary `2c74dffcc1c9a5ee55957c60971998ace2b89f22585631594ec2152c588af8db`.

**These runs used earlier, untracked versions of the harness, not the files in this folder.** The files here are those versions tidied for reuse (below); they have not run these experiments, and no run was repeated for this change (no model turn).

| Run | Job | Harness that ran | Result (from the report) | Report SHA-256 |
|---|---|---|---|---|
| install r1 | `d90ab5d1-c462-4066-a06d-f244046de6d3` | not frozen by the Job; author's record `6a5b5f8b…` | **failed**: 8 of 9 checks; the boundary found a `~/.claude/skills/synced` change (kept as recorded) | `1ffbd503d7e8141b…` |
| install r2 | `d514747b-f49e-4f6f-b99e-5b51915a1bff` | not frozen; author's record `5b70f1de…` (adds the attribution above) | 10 of 10; one such change again, counted as the account's own by that version's rule (its Claude session ran before and throughout, Core ran no child, the run's profile stayed empty), not proven per file | `38fb46dbb50ff367…` |
| pre-login p1 | `5972546e-2dbe-4d8e-8932-0b5305549180` | not frozen; author's record `a5a3c286…` with client `5641d633…` | 13 of 13 | `842a218d14dab3bb…` |
| first-use f1 | `ef76a0f2-507b-4930-a29e-3142976d87c5` | frozen: `a5a3c286…`, client `f6252ab2…`, `ui.mjs` `93f71083…` | **failed**: 6 of 7; core.11 lists two Haiku models and the client's strict locator refused to choose, before any turn (kept as recorded) | `0d6f1e9f2a960348…` |
| first-use f2 | `c90102b4-dad5-421e-b125-4555c0330326` | frozen: `a5a3c286…`, client `54f0e532…` (the `.first()` fix in this branch), `ui.mjs` `93f71083…` | 13 of 13, and every browser assertion in first, reopen and restart | `2a4cbeb0a6ef62d5…` |

- **Before sign-in (p1, core.11):** the Core host check said only "Claude Code found · 2.1.295"; the create dialog said "Uses the Claude Code login on your Core host"; the first message failed at once with "Not logged in · Please run /login", with no hint where to sign in; an English UI showed a Chinese Codex error. The draft, the failed turn and the Workspace were kept across a Core restart and a new browser; no sign-in appeared, the owner's profile stayed empty, and nothing changed in the account's default folders (nothing needed the tolerance). The sign-in hint and the English error were fixed in #145 (not in core.11).
- **First use (f2):** the run's profile was signed in by the account owner with `claude-login.sh` before the run. A Claude Agent with a Haiku model completed one real turn after exactly one approval of the harmless command, and its marker came back. A full browser reopen and then a Core restart kept the Workspace, the turn and answer, the unsent draft, and the model and approval choices. Claude's state was written only in the run's profile; nothing changed in the account's default folders (nothing needed the tolerance). The report's fixed `notCovered` text still lists the sign-in and first conversation; that text predates the run and is out of date for that item.
- The browser was headless Chromium on the computer that ran the lab, through the tunnel; not a desktop browser opened by a person.

**How the files here differ from what ran (`a5a3c286…`, `5641d633…`, the login script):** host paths and names are checked before anything starts; the repository, asset name, host `PATH` folder and host Python, which were fixed, are options with the same defaults; the run folder's containment is checked before anything is made (the version that ran made `--remote-base` first and checked after); a failed step stops Core in every stage, a failed start included (the version that ran left it running after a failed `install` check, and after a failed start in `pre-login` and `first-use`); the boundary leaves out the allowed folder's own top-level entry by computing it from `--remote-allowed` instead of naming it, also lists home's new top-level entries in `pre-login` and `first-use`, and fails if its listing script fails; its tolerance is narrower: `install` tolerated any `~/.claude` change under its rule and `pre-login`/`first-use` accepted any earlier `claude`, `node` or `codex` process that still ran, while these files accept only the skill-sync round and only with an earlier `claude` process; the install stage makes the run's profile, temporary and XDG folders with the run folder, and starts and stops Core with the same steps as the other stages; the clients are found next to this file (`--repo` is gone) and the pre-login client imports `./ui.mjs`; the report records the harness's SHA-256; `claude-login.sh` takes the run folder as an argument instead of a fixed path and checks it is an installed run.

Still not covered on a separate host: a brand-new OS account, an online update on the host, Core as a systemd service, linger, and a browser on a third machine.
