<p align="center">
  <img src="web/src/assets/yuzu-character.png" width="88" height="88" alt="Yuzu, the Yuzuno character" />
</p>

<h1 align="center">Yuzuno</h1>

<p align="center"><strong>A home for your coding agents.</strong><br />
Claude Code, Codex, OpenCode and DeepSeek Harness, your projects, and the work that carries on between conversations.</p>

<p align="center">
  <a href="https://github.com/YuzukiS/Yuzuno/actions/workflows/ci.yml"><img src="https://github.com/YuzukiS/Yuzuno/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="#status-and-limits"><img src="https://img.shields.io/badge/status-pre--alpha-e6bb50?labelColor=44403c" alt="Status: pre-alpha" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0" /></a>
  <a href="docs/independent-core.md#supported-platforms"><img src="https://img.shields.io/badge/Core-Linux%20%7C%20WSL2-64748b?logo=linux&logoColor=white" alt="Core: Linux and WSL2" /></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#status-and-limits">Status</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yuzuno is a personal workspace for work that spans many agents and many turns. One **Core** keeps your Agents, Projects, tasks, background Jobs and reviews, and the decisions waiting for you. Open it in a browser, the desktop app or on your phone; close the window and the work goes on. The Claude Code, Codex, OpenCode and DeepSeek Harness you already use keep doing the model work, with their own sign-ins or keys.

![Yuzuno Home: a question with a reply and a marked-up sketch attached, a permission waiting for you, and each Project at a glance](docs/images/home.png)

<p align="center"><em>Screenshots on this page show fictional sample data.</em></p>

## What it does

| | |
| --- | --- |
| **Your agents, side by side** | Conversations with Claude Code, Codex, OpenCode (experimental) and [DeepSeek Harness](docs/dsh.md): tool calls, approvals, follow-ups and native sub-agents. Send images, marked up first if you like, and files of any type. Run an Agent on the Core's computer, or a Claude Code or Codex Agent on a Linux or macOS machine over SSH. |
| **A Home that says what needs you** | Questions waiting for your answer, and a page per Project whose cards its Agents keep current: reports, statuses, tables and metrics, in up to four columns, some refreshing on a schedule. Tell a Project what you need, or answer a card, with images and files attached; its lead turns requests into cards and hands each one to an Agent. |
| **Tasks that outlive a turn** | Projects have leads. A task gets an executor Agent of its own, started from a template you keep, with fixed working materials. Agents write to each other through a durable mailbox, and results go back to whoever dispatched the work. Routing picks the harness, model and account or API key for each executor, and can share a pool of Claude accounts among them. |
| **Background work with a budget** | Builds, tests and research commands queue within a CPU and memory budget, with logs and checked output files. Chain stages, declare NVIDIA GPU needs, and pause local work when you need the machine. Jobs run on the Core's computer, on SSH machines, or on Windows beside a WSL Core. |
| **Delivery you can check** | Pull requests linked to tasks, GitHub CI watches, independent review rounds on a fixed revision, and a merge queue that lands a reviewed pull request only once CI has tested exactly what lands. Completion, acceptance and merge stay separate facts. |
| **Previews of what you build** | Register a Project's web service, such as a Vite dev server, Jupyter or TensorBoard, and open it from the Projects dialog. A Job can serve it, and the dialog shows whether it answers. |
| **Signed updates** | A managed installation updates from signed releases when its Agents are idle and checks its health afterwards, with or without a GitHub sign-in. Agents that paused for the update are told to carry on once it ends. Back up, verify and restore a Workspace with one command each. |
| **Wherever you are** | A browser; the Windows desktop app, which can install and start Core in WSL2 for you; the Mac app; and your phone, through a private Tailscale address, with push notifications from the Home Screen. The desktop apps' taskbar or dock icon counts what needs you. |

### Each Project on one page

A Project's page sets its Agents' cards side by side, in two, three or four columns as the window allows; a card can refresh itself on a schedule its lead set. Above them, tell the Project what you need, with images and files attached. Its lead answers, or turns the request into a card and hands it to an Agent.

![A Project's page in Yuzuno: its cards in three columns, and a request with a sketch and a log file attached](docs/images/project.png)

### Follow the work, then get back to yours

See what an Agent is doing, inspect a tool call, answer an approval or send a follow-up without opening another terminal. Native sub-agents stay attached to their parent conversation, and account usage shows when the runtime reports it. A Codex or OpenCode conversation can be [rewound](docs/rewind.md) to before a turn.

![An Agent conversation in Yuzuno with tool activity and its work context](docs/images/conversation.png)

Attach a file from the **+** menu, by dragging it in or by pasting it. A local Codex, Claude Code or OpenCode Agent gets its own read-only copy; up to 8 files and 40 MiB go with one message. *Next release:* Codex and Claude Code Agents on SSH machines receive files too.

### Give long-running work its own place

Jobs keep commands, resource requests, status, logs and outputs together. Dependent stages start after their prerequisites succeed, and CPU work can proceed while a GPU stage waits for a device. A finished Job sends its result back to the Agent that started it.

![The Yuzuno Jobs view showing sample queued, running and completed work](docs/images/jobs.png)

On a Linux Core, local CPU and memory limits are enforced through cgroups. GPU admission reserves declared capacity; it does **not** cap GPU memory. [Research pipelines and GPU Jobs](docs/research-jobs-gpu.md) and [Jobs on remote machines](docs/research-jobs-remote.md) describe what each kind of machine enforces.

### Share accounts among executors

A routing candidate can use a pool of [claude-swap](docs/executor-routing.md#claude-swap-accounts) accounts instead of one sign-in. The pool starts each executor on the account with the most of its week left, or on the one whose week resets soonest. When you take an account out of the pool, a queued executor picks another before it starts, and a running Claude executor moves to another account once it is idle and continues its session.

## Get started

Choose where Core runs: a Linux x86_64 computer, or WSL2 on Windows. Install and sign in to Claude Code, Codex or both there first; Yuzuno uses those sign-ins and never copies them.

### Windows: the desktop app installs Core in WSL2

1. Have WSL2 with a Linux distribution (x86_64, glibc 2.35 or newer) whose default user is not root. The app doesn't install WSL; `wsl --install` does.
2. Install the desktop app from the [Releases page](https://github.com/YuzukiS/Yuzuno/releases) (`desktop-…`).
3. On its connection page, choose **Install Core on this computer** and pick a distribution. The app checks it without changing anything and says how to fix each missing item. It then downloads the latest signed Core release, verifies its signature and checksum, installs it under your own account in that distribution, starts it and opens your Workspace.
4. Next time, opening the app starts that Core again. You can turn this off on the same page.

It needs no administrator rights and adds no service or scheduled task. [Install Core from the app](desktop/README.md#install-core-from-the-app-windows-wsl) has the details.

### Linux: install a signed release

Signed Core releases for Linux x86_64 are on the [Releases page](https://github.com/YuzukiS/Yuzuno/releases). The [install guide](docs/independent-core.md) downloads one, verifies it with `minisign`, installs it as a managed installation and starts it, without a source checkout. Then open **http://127.0.0.1:4317** in a browser. The same guide connects a browser or the desktop app on another computer.

### macOS

For now a Mac connects through an SSH tunnel to a Core on Linux; the [desktop guide](desktop/README.md#macos-desktop-core-on-another-computer) covers the Mac app, which is built from source. *Next release:* a Core package for Macs with Apple silicon, and a Mac app that installs and starts it on your Mac ([Install and start Core on this Mac](desktop/README.md#install-and-start-core-on-this-mac-macos)).

### Run from source

On Linux or WSL, install Git, Rust, a C compiler and linker, Node.js and npm, Python 3, and the agent CLI you want to use. CI uses Rust **1.97.1** and Node **22.23.2**; Core also needs Node at runtime for result validation and Claude Agents.

```sh
git clone https://github.com/YuzukiS/Yuzuno.git
cd Yuzuno
npm --prefix web ci
npm --prefix web run build
cargo build --locked

# Optional: enable Claude Agents. This installs the Claude Agent SDK from npm.
npm --prefix runtimes/claude ci --ignore-scripts --omit=optional

python3 scripts/launch.py core
```

Open **http://127.0.0.1:4317**, create an Agent, choose its runtime and project folder, and send a request. `--cwd`, `--port` and `--data-dir` choose the default project folder, the port and a separate Workspace; `python3 scripts/launch.py core --help` lists the rest.

### What you need

| Part | Supported |
| --- | --- |
| **Core** | Linux x86_64 with glibc 2.35 or newer, including WSL2 on Windows. *Next release:* macOS 11 or newer on Apple silicon. |
| **Clients** | Chromium-based browsers; the Windows desktop app; the Mac app, built from source; a phone's browser through the [phone entry](docs/independent-core.md#connect-from-a-phone-tailscale-serve). An iPhone app builds from source; there is no Linux desktop app. |
| **Agent runtimes** | Claude Code (with Node.js 20 or newer), Codex, or [OpenCode](docs/opencode.md) (experimental), installed and signed in where the Agent runs. [DeepSeek Harness](docs/dsh.md) (`dsh`, with Node.js 24.9 or newer) runs on the Core's computer only, with a DeepSeek key added in Settings. |
| **Agent machines** | The Core's computer, or Linux and macOS machines reached over SSH with Python 3. |
| **Jobs** | Linux: a systemd user manager with cgroup v2 `cpu`, `memory` and `pids`, which enforce each Job's limits. Macs over SSH run Jobs in limited mode, where limits are recorded, not enforced. |

The [support matrix](docs/independent-core.md#supported-platforms) separates what was tested from what is planned.

## How it works

**Core owns the Workspace; a client is a window into it.** Core keeps Projects, tasks, conversations and Jobs in SQLite, serves the UI, and talks to the native runtimes. Closing a browser or desktop window leaves Core and its Agents running.

- **Local Agents** use the Core computer's files and CLI sign-ins. **SSH Agents** use the remote machine's; add and check machines in Settings.
- **Core listens on loopback only and has no user accounts.** Another computer reaches it through an [SSH tunnel](docs/independent-core.md#connect-from-another-computer); a phone through [Tailscale Serve](docs/independent-core.md#connect-from-a-phone-tailscale-serve), which admits one Tailscale login. Never expose Core's port to a network.
- **GitHub** pull requests, CI watches and the merge queue use a signed-in `gh` on the Core computer. CI watches observe workflows; they never start or cancel them. The merge queue writes to a repository only after you turn it on for that repository.
- **Projects** group Agents and tasks without making them share a working tree. You choose each Project's leads; see [Agent kinds, Project leads and executor templates](docs/executor-model.md).

### Data and updates

A Workspace is one folder: the one Core starts with (`--data-dir`), or else `yuzuno/workspace` in the system's data folder (`~/.local/share` on Linux, `~/Library/Application Support` on macOS). Back it up with `yuzuno-workspace --backup-to <folder>`, check a backup with `--verify-backup` and restore it into a new folder with `--restore-backup`. A backup leaves out the native CLIs' sign-ins and session histories, and your project folders. [Workspace data](docs/workspace-data.md) covers backups, moving an older Workspace and opening it with older Cores.

A managed installation updates itself from signed releases in **Settings → Updates**, waiting until Agents are idle and checking Core's health after the switch ([Workspace updates](docs/workspace-updates.md)). An Agent that yielded its turn because the update asked it to pause gets one message to continue once the update ends. Core releases carry Core, the web UI and the Claude bridge; the desktop app updates separately, and the native CLIs update on their own ([Updates and platform support](docs/updates-and-platforms.md)).

## Status and limits

Yuzuno is an early alpha in active development, published as source and as signed Core releases. This README describes Core release core.35 and Windows desktop app 0.5.0; items marked *Next release* are on `main` but not in a release yet.

- **No user accounts.** Anyone who can reach Core's port can use the Workspace; keep it on loopback.
- **Jobs are resource control, not a sandbox.** They run as the Core's user, outside the Agents' sandboxes.
- **Windows runs Core only in WSL2.** **macOS Core (Apple silicon only) is [being built](docs/macos-core.md)**; a Mac connects to a Core on Linux for now. There is no Linux aarch64 package yet.
- **The apps are not signed by a recognised publisher.** Windows may warn about the installer; the Mac app is signed ad hoc and not notarized; the iPhone app is built from source and lapses after about a week.
- **OpenCode Agents are experimental, and DeepSeek Harness is a developer preview.** Some features differ by runtime: for example [rewind](docs/rewind.md), files (not yet for DeepSeek Harness or Agents on SSH machines) and streaming output (DeepSeek Harness shows each step when it ends; see [its limits](docs/dsh.md#known-limits)).

The [install guide](docs/independent-core.md#what-was-tested) records what was tested and what remains. Commits, pull requests and releases cited in older docs (for example `f5626f7`, `#164` or core.12) come from the former private repository `YuzukiS/Yuzuno-dev` and are not in this repository's history.

Bug reports and focused contributions are welcome; start with [Contributing](CONTRIBUTING.md). Report a security problem privately through [GitHub's private vulnerability reporting](https://github.com/YuzukiS/Yuzuno/security/advisories/new), as [Security](docs/SECURITY.md) describes.

## Development

| Path | Responsibility |
| --- | --- |
| `core/` | Rust, SQLite, native runtimes, tasks, Jobs, reviews and CI |
| `web/` | React UI and Vite build |
| `runtimes/claude/` | Bridge to the official Claude Agent SDK |
| `desktop/` | Tauri v2 client window for Windows and macOS |
| `ios/` | iPhone client window |
| `scripts/` | Launch, isolation and build helpers |
| `.agents/skills/yuzuno/` | Workspace tool guide for Agents |

For frontend work, keep Core running and use `npm --prefix web run dev`. For Core changes, use a separate port and data folder to protect your everyday Workspace. [Contributing](CONTRIBUTING.md) lists focused checks and the full suite. Agents developing inside Yuzuno follow the [Workspace skill](.agents/skills/yuzuno/SKILL.md) and put resource-heavy checks in managed Jobs.

More: [Claude bridge](runtimes/claude/README.md) · [Release workflow](docs/core-release.md) · [When the window can't show the app](docs/diagnostics.md) · [Screenshot sources](docs/images/README.md)

## License

Yuzuno is licensed under the **[Apache License 2.0](LICENSE)**, including the character images in `web/src/assets/` ([asset notes](web/src/assets/README.md)). The following keep their own terms:

- The bundled Noto Sans SC subset, under the [SIL Open Font License 1.1](web/src/assets/fonts/LICENSE-NotoSansSC.txt).
- Third-party dependencies, which the build installs from their registries. Among them is the Claude Agent SDK, which the optional Claude bridge installs from npm under Anthropic's terms. See [Claude reuse](docs/claude-reuse.md) and [the SDK notes](docs/public-readiness.md#the-claude-agent-sdk).

Release bundles include notices alongside Core and the Claude runtime (`licenses/`), the built UI (`web/licenses/`), and the result validator (`runtimes/result-validator/THIRD_PARTY_NOTICES.txt`). They are generated from the build inputs; see [license packaging](docs/core-release.md#ci-artifact-and-compatibility).
