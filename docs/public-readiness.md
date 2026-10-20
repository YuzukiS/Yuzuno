# Publication status and remaining release work

[YuzukiS/Yuzuno](https://github.com/YuzukiS/Yuzuno) became public on 2026-10-20, starting from a cleaned source snapshot with no private Git history. The former repository is now `YuzukiS/Yuzuno-dev` and remains private, with its original commits, CI records and release packages.

All new development targets public `main`. Unfinished work moves as selected changes with its existing evidence, not by merging the private history or maintaining two active main branches. See [Contributing](../CONTRIBUTING.md#development-repository).

The first public delivery is source only. The Apache License 2.0 includes the character images; third-party materials retain their own terms. There are no public installation packages yet. The notes below retain provenance and remaining package questions; they are not a claim that binary distribution has been completed.

## Settings

Configured and checked on the public repository on 2026-10-20:

| Setting | Public repository | API path below `repos/YuzukiS/Yuzuno` |
| --- | --- | --- |
| Visibility | public | repository metadata |
| Private vulnerability reporting | enabled | `/private-vulnerability-reporting` |
| Fork workflow approval | first-time contributors need approval | `/actions/permissions/fork-pr-contributor-approval` |
| Default workflow token | read-only; cannot approve pull requests | `/actions/permissions/workflow` |
| Action references | full commit SHA required | `/actions/permissions` |
| Self-hosted runners | none; jobs use GitHub-hosted runners | `/actions/runners` |

## Security reports

**Enabled:** the public repository takes reports through GitHub's private vulnerability reporting, at [https://github.com/YuzukiS/Yuzuno/security/advisories/new](https://github.com/YuzukiS/Yuzuno/security/advisories/new). [SECURITY.md](SECURITY.md), the README, [Contributing](../CONTRIBUTING.md#security-problems) and both issue forms name it. The private repository has no such channel; GitHub offers it only for public repositories. There is no security contact address.

**How it was enabled, and how to check it** (repository owner or administrator):
1. Settings → Advanced Security → Private vulnerability reporting → Enable; or `gh api -X PUT repos/YuzukiS/Yuzuno/private-vulnerability-reporting`.
2. `gh api repos/YuzukiS/Yuzuno/private-vulnerability-reporting` answers `{"enabled":true}`, and an account without write access sees **Report a vulnerability** on the repository's Security tab.

## Pull requests from forks and CI

Public CI runs on GitHub-hosted `ubuntu-24.04` for main pushes and pull requests, including forks, with a read-only token and no secrets ([CI](pr-ci-runner.md)). The configured policy requires approval for first-time contributors before their fork workflows run.

The first public main run exposed a shell-dependent test assumption. [PR #1](https://github.com/YuzukiS/Yuzuno/pull/1) fixed the fixture while preserving the exact process-count and cleanup assertions; its PR and merged-main hosted checks passed. CI uploads no release inputs, installation packages or SDK bundles. The historical private CI is not the development workflow.

## Assets and their rights

The repository records only what is listed here. The Apache License does not cover anything whose rights are unknown, and this list grants no rights.

| Files | What they are | What the repository records | Recorded status or remaining follow-up |
| --- | --- | --- | --- |
| `web/src/assets/yuzu-character.png`, `yuzu-character-outline.png` | The character in the UI | [Asset notes](../web/src/assets/README.md): generated with Codex (the owner confirmed this) and copied unchanged from an earlier project. The owner put them under the Apache License 2.0 on 2026-10-20. | Covered. |
| `docs/images/home.png`, `conversation.png`, `jobs.png` | README screenshots with fictional sample data ([how they are made](images/README.md)) | They show the character images (Apache-2.0) and the bundled font (OFL). | Covered. |
| `desktop/icons/icon.svg`, `icon.png`, `icon.ico` | The app icon | `icon.svg` says it matches the yuzu mark drawn in `web/src/components.tsx`. It arrived with the project's first commit, with no other record. | **Owner:** confirm it is the project's own work under the Apache License, or record its source. |
| `web/src/assets/fonts/yuzuno-han.woff2` | A Noto Sans SC subset | [SIL Open Font License 1.1](../web/src/assets/fonts/LICENSE-NotoSansSC.txt), shipped with every build in `web/licenses/` | Covered. |
| `acceptance/image-input/card-a.png`, `card-b.png` | Synthetic test cards, each a label and a coloured square, used by an image-input acceptance run | Nothing records how they were made. | Confirm they were made for the test, or remove them. |
| KaTeX fonts in the web build | Fonts from the `katex` npm package | Listed under `katex` in the web build's notices. The package ships only its MIT license, with no terms specific to the fonts. | Nothing further is claimed. Check the KaTeX project if the fonts need separate attribution. |

## What the third-party notices do not cover

Release bundles carry notices for the Core binaries, the web UI, the result validator and the Claude runtime ([Core release workflow](core-release.md#ci-artifact-and-compatibility)). These are not covered:

- **The Windows installer of desktop 0.2.0,** a release of the private repository. It was made before the desktop notices, and `tools/desktop_installer_check.py` finds none of them in it. Installers made with `scripts/desktop.ps1 -Bundle` now install them ([how](../desktop/README.md#building-and-publishing-a-desktop-release)). For the `nsis_tauri_utils` plug-in, the versions of its crates are inferred (its release was built without a lock file), and its Rust `core` library's notices come from the app's toolchain. The app has no npm dependencies; its connection page is plain HTML, CSS and JavaScript.
- **Other targets and optional features:** the notices describe an `x86_64-unknown-linux-gnu` build with default features only.
- **Whether the Claude Agent SDK may be redistributed** in a public release. The runtime notices reproduce its terms as its package declares them; see [The Claude Agent SDK](#the-claude-agent-sdk).
- **Anything the Zig linker adds** to the Core binaries.
- **Packages that ship no license text.**
  - They are listed with only their declared license: `rmcp` in the Core notices, `react-remove-scroll-bar` and `victory-vendor` in the web notices.
  - `standardwebhooks` 1.1.1 in the Claude runtime ships none either. Its notices reproduce the MIT text of its exact source and mark it as not shipped in the package; the record is in `tools/runtime-license-sources/`.
    - Its npm provenance names commit `b4d2c14` of `standard-webhooks/standard-webhooks`. There, `libraries/LICENSE` (MIT, Svix) covers the `libraries/javascript` folder the package is published from.
    - That repository's root `LICENSE` is Apache-2.0; it does not match the package's declared MIT and is not used.
    - Any other version of the package is listed without a text until it is traced the same way.
  - The notices are regenerated with every build, so check them again for the release you publish.

## The Claude Agent SDK

**Where its files are:**
- **The source, and so the public snapshot: none.** `runtimes/claude/package.json` and its lock file only name the version, 0.3.296. Nothing under `node_modules/` is in Git.
- **Core release bundles: all 19 of its files,** under `runtimes/claude/node_modules/`. Every release so far carries them. That is 11 published (core.2 to core.12) and 2 drafts, read from each release's manifest on 2026-10-20. All are releases of the private repository and stay there; none becomes a release of the public one.
- **SSH machines:** when a Claude Agent runs on one, Core uploads these files to it.
- **Not carried anywhere: the native `claude` program.** Users install and sign in to Claude Code themselves. The build leaves out the per-platform packages that hold it (`--omit=optional`).

The bundle's other runtime packages declare open-source licenses (`@anthropic-ai/sdk`, for example, is MIT). The question below therefore concerns only public binary packages that would carry the SDK's files, not the source.

**What the package and Anthropic's pages say** (read 2026-10-20):
- **Package:**
  - `package.json`: `"license": "SEE LICENSE IN README.md"`.
  - `LICENSE.md`: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."
  - The README points to the Commercial Terms of Service and the Privacy Policy. It installs the package with `npm install @anthropic-ai/claude-agent-sdk`.
- **[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms):** "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users, except to the extent a specific component or dependency is covered by a different license as indicated in that component's LICENSE file."
- **[Commercial Terms](https://www.anthropic.com/legal/commercial-terms)** (effective June 17, 2025):
  - A.1 gives "permission to use the Services, including to power products and services Customer makes available to its own customers and end users".
  - D.4 forbids to "reverse engineer or duplicate the Services".
  - Under F, the Terms "do not grant either party any rights to the other's content or intellectual property, by implication or otherwise", except as they expressly state.
- **Redistribution:** none of these pages, nor the [legal page](https://code.claude.com/docs/en/legal-and-compliance), mentions redistributing or sublicensing the package.

**Not established, and not decided here:**
- **That a public package may carry the SDK's files.** No text read grants it, so the repository does not claim it.
- **Sign-in.** Yuzuno runs the Claude Code the user installed, with that program's own sign-in. Two sentences bear on this, and which one covers it is not established:
  - The SDK overview says Anthropic does not allow third-party developers "to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" unless previously approved.
  - The legal page says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- **Naming.** The legal page allows saying in plain text that a product "runs Claude Code". The SDK's branding guidelines list "Claude Code" among names not permitted when referencing Claude in a product. The UI calls the harness "Claude Code".

**Choices for public packages,** once there are any; the first public version has none (the owner decides; the Lead asks):
1. **Proposed: install it on the user's machine.**
   - Public bundles leave the SDK out. When a Claude Agent first starts, Core installs it from the npm registry into its data folder, at the version and sha512 the lock file pins. Users then get it from Anthropic's own publication.
   - This needs new Core and bridge code and a release.
   - The first Claude start needs npm and access to `registry.npmjs.org`. Node is already required.
   - An SSH machine installs its own copy the same way.
   - Codex is unaffected.
2. **The SDK only in private builds.** Public packages then have no Claude support.
3. **Public bundles keep it,** with written permission from Anthropic recorded in the repository.

None of this is a legal assessment.

## Where the repository is named

`YuzukiS/Yuzuno` now names the public repository:
- `REPOSITORY` in `core/src/updates/desktop_releases.rs` already names it. Core relays its signed `desktop-<version>` releases to the Windows app.
- Managed Core updates read the repository configured in `release-source.json`. Existing installations configured for `YuzukiS/Yuzuno` already point to the intended public source; do not redirect them to the historical private repository as part of this handoff.
- `tools/core-release.py` takes an explicit repository in its release configuration. Any future public package must be prepared from public source, for this public repository, with its matching evidence and signature.
- CI uses `github.repository`. New work starts in an independent public clone. Historical private checkouts keep their private remotes and are used only to read evidence or extract selected changes.

The public repository currently has no release packages, so update checks find no new public package. The source publication changed no installed version and required no Core restart. Old private packages remain private; do not relabel them as public releases. Package preparation is a separate step described in [the release guide](core-release.md).

## Other open decisions

- **Downloads without a GitHub account.** The public repository's release files are public. The install steps and Core's updates use `gh`, which needs a sign-in to some GitHub account but no access to the repository. The choices:
  - **As now:** users sign in to `gh` with their own account. Nothing to build.
  - **A first download without an account:** the install guide adds `curl` for the three files from `https://github.com/YuzukiS/Yuzuno/releases/download/<tag>/`. Updates inside Core still need `gh`.
  - **Updates without an account** would need Core to read releases without `gh`, which means a new HTTP client. Not proposed for the alpha.
- **Future source changes** retain the snapshot's privacy boundary: private history, CI logs and packages are not imported. Use runtime parameters or clearly labelled synthetic examples instead of real machine names, account paths, host addresses or unrelated research material ([public example conventions](public-content.md)).
- **Demo material** beyond the README screenshots.
