# Install a Linux Core and connect to it

This guide installs a signed Yuzuno Core release on a Linux host and connects to it from a browser or the Windows desktop app, on the same computer or another one. It does not need a source checkout.

**Releases are published on the [Releases page](https://github.com/YuzukiS/Yuzuno/releases) of `YuzukiS/Yuzuno`,** starting with core.13 and core.14 on 2026-10-21. Each has the three Linux x86_64 files used below. You can also [run from source](../README.md#run-from-source); the connection sections apply to a source build as well.

## What runs where

| Part | Where | Holds |
|---|---|---|
| **Core** | One Linux host (x86_64) | The Workspace database, Agent sessions, Jobs, release packages. It serves the web UI and API on a loopback port only. |
| **Native runtimes** | The Core host | Claude Code and/or Codex, installed and signed in by you. Yuzuno uses their logins; it never copies or reads credentials. |
| **Client** | Any computer with a browser, or the Windows desktop app (its installer is on the [Releases page](https://github.com/YuzukiS/Yuzuno/releases) from `desktop-0.3.0`). A phone's browser through [the phone entry](#connect-from-a-phone-tailscale-serve). The Mac app and the iPhone app are built from source only and have no release. | Its own connection details and unsent drafts: the browser's storage, and the saved Workspaces of the desktop and iPhone apps. The Windows app can start an already installed WSL Core it has connected to before ([Start Core from the app](../desktop/README.md#start-core-from-the-app-windows-wsl)); no client ever creates a Workspace. |
| **Agent machine** | The Core host, or an SSH machine for remote Agents | Separate from connecting a client to Core; see the README's SSH Agents. |

Core has no user accounts. Anyone who can reach its port can use the Workspace, so the port stays on loopback. Other computers reach it through an SSH tunnel, or through a separately configured HTTPS entry: [a second loopback port behind Tailscale Serve](#connect-from-a-phone-tailscale-serve), which lets in only one Tailscale login from devices on that tailnet. It is made for a phone, which has no SSH tunnel, but it is not limited to one. Core is never reached through a public or LAN port.

## Supported platforms

**Tested** means checked as described in [What was tested](#what-was-tested). **Planned** means intended but not checked. **Unavailable** means not offered.

| Item | Status | Notes |
|---|---|---|
| Core on Linux x86_64 (glibc 2.35 or newer) | Tested within the scopes below | Arch Linux on WSL2: browser/Agent/update checks, and the public core.13's first Claude start, which downloads the Agent SDK (no sign-in). Ubuntu 22.04.5 disposable rootfs, glibc 2.35: signed core.8 and the public core.13, each with registration, Core and UI file serving, restart and data-preserving reinstall; no real login, Claude start, browser rendering or systemd Jobs in that rootfs. |
| Core on Linux aarch64 | Planned | No package yet. |
| Core on macOS | Planned | Not supported. A source build compiles and starts on Apple silicon, but Jobs and managed updates are refused there and no package exists. See [macOS Core: current gaps](#macos-core-current-gaps). |
| Core on Windows | Unavailable | On Windows, run Core in WSL2. |
| Core as a systemd service | Planned | Start it as shown below; see the note there. |
| Browser on the Core host | Tested | Chromium. |
| Browser on another computer, through an SSH tunnel | Tested | Chrome on a separate Apple silicon Mac connected to signed core.10 on Linux/WSL2 over a private network. Earlier Chromium/Linux and Edge/Windows checks used tunnels on the Core's physical computer. A tunnel's local port may differ from Core's only on releases after core.7. |
| Browser on macOS | Tested within the scope below | Chrome 154, macOS 27.0.1, Apple silicon; SSH authentication, first conversation/approval, tunnel loss/recovery and browser/Core restart. Safari and other Mac browsers are untested. |
| Windows desktop app, Core on the same computer (including WSL) | Tested | Daily use with a WSL Core; not repeated for this guide. On 2026-10-25 the app's own update installed the public `desktop-0.3.0` over 0.2.0 on the same Workspace; a first install from the downloaded installer was not checked for this guide. |
| Windows desktop app, through an SSH tunnel | Planned | Expected to work, because the app accepts any loopback address. Untested. |
| Phone browser, through the phone entry | Tested within the scope below | On 2026-10-25 an iPhone opened the entry of a WSL Core set up from Settings and showed Home and the current conversation (the user's report). Sending, the on-screen keyboard, photos and background/foreground in the phone's browser were checked only synthetically, not on the iPhone. On 2026-10-26, with core.19, it was added to the Home Screen and turned on push notifications there; a notice that an Agent had finished arrived with the phone locked and opened that Agent, and a notice for an Ask arrived and opened Home (the user's report). |
| iPhone app | Tested within the scope below | Built from source and signed with the owner's own Apple Account on a free personal team, so the installed app lapses after about seven days until it is rebuilt and reinstalled. On 2026-10-25 it was installed on one iPhone, connected through the phone entry's Tailscale Serve HTTPS address (no SSH) and sent a message. No release, App Store or TestFlight build; see [the iPhone app](../ios/README.md). |
| macOS desktop app (Apple silicon) | Tested within the scope below | Built from source and signed ad hoc; not notarized and not published. Its installation from the disk image, connection through an SSH tunnel to a Linux/WSL Core, the saved Core and reconnection were checked on macOS 27.0.1. A person then used it at the Mac; what the window showed is that person's report. Intel Macs: an x86_64 build is made and tested in CI, but none has been opened on an Intel Mac. See [Mac desktop app](#mac-desktop-app). |
| Linux desktop app | Unavailable | No published build; use a browser. |
| HTTPS through the Tailscale Serve entry | Tested within the scope below | One tailnet login only. Set up from Settings for a Core in WSL with Tailscale for Windows, by hand on other hosts. Used from an iPhone, in its browser and the iPhone app, on 2026-10-25; other devices on the tailnet are untested. |
| Reaching Core over a LAN or a public address | Unavailable | Core has no login. Use an SSH tunnel or the Tailscale Serve entry. |

The Claude Code and Agent SDK versions checked with a release are listed in [the Claude bridge README](../runtimes/claude/README.md) ("Claude Code versions").

## Prerequisites on the Core host

- Linux x86_64 with glibc 2.35 or newer (`ldd --version`).
- **Node.js 20 or newer** on `PATH`, for Claude Agents.
  - A public release does not include the Claude Agent SDK. Unless another installed release has the same version, the first Claude start downloads it from `registry.npmjs.org` (about 1.6 MB, checked against the locked integrity); see [The Claude Agent SDK](public-readiness.md#the-claude-agent-sdk).
  - Behind a proxy, that download honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` with Node 22.21 or later, or 24 or later. An older Node with a proxy set stops with a message instead of connecting around the proxy.
- **`/usr/bin/python3`**, for Jobs and remote Agents.
- **A systemd user manager with cgroup v2**, for Jobs (`systemctl --user status` works). On a server you log in to only over SSH, run `loginctl enable-linger "$USER"` once, so the user manager keeps running.
  - **Jobs also need its `cpu`, `memory` and `pids` controllers.** `cat "/sys/fs/cgroup$(systemctl --user show --property=ControlGroup --value)/cgroup.controllers"` must list all three. Without them Core refuses every local Job ("User manager requires cgroup v2 cpu, memory and pids controllers"); Agents and the rest still work.
  - On an Ubuntu 22.04.5 host (systemd 249) the user manager had only `memory pids`. Delegating `cpu` to it is a system setting that an administrator makes; see [systemd's cgroup delegation](https://systemd.io/CGROUP_DELEGATION/). Yuzuno has not been checked on a host where that setting was changed.
- **Claude Code** (`claude`) and/or **Codex** (`codex`), installed and signed in as the same user that runs Core.
- **`gh`**, signed in (`gh auth login`), for the download, updates and GitHub features. `YuzukiS/Yuzuno` is public, so `gh` needs a sign-in to a GitHub account but no access to the repository. Installing with an account that has no access to it has not been tried yet ([where the repository is named](public-readiness.md#where-the-repository-is-named)).
- **`minisign`**, to verify the download. Use your distribution's package if available, or the [official release](https://github.com/jedisct1/minisign/releases). The tested Ubuntu Base 22.04.5 apt indexes did not provide it; that lab used the upstream static Linux binary, as recorded in [the acceptance notes](../acceptance/t88/README.md#disposable-ubuntu-rootfs-rootfs-labpy).

## Install

The commands below install into `~/.local/share/yuzuno-core` and keep the Workspace in `~/.local/share/yuzuno-core-data`. Choose other absolute paths if you like. The managed directory must be owned by you and not writable by others.

1. **Download** the three files of a release (`core-…` on the Releases page):

   ```sh
   TAG=core-20261021-a31eb29        # the release you chose (core.14 here)
   mkdir -p ~/yuzuno-download && cd ~/yuzuno-download
   gh release download "$TAG" -R YuzukiS/Yuzuno -p 'yuzuno-core-linux-x86_64.*'
   ```

   These are the public repository's releases. core.12 and earlier stay releases of the private `YuzukiS/Yuzuno-dev` and are not available here.

2. **Verify** the signed descriptor with the Yuzuno publisher key, then check the archive against it:

   ```sh
   KEY=RWSX8DdJd8/UQ/CyT737AvEnpKM3vpI4npuO1aMf6h1Tx+e40VVWG03r
   minisign -Vm yuzuno-core-linux-x86_64.json -P "$KEY"
   python3 - <<'EOF'
   import hashlib, json
   d = json.load(open('yuzuno-core-linux-x86_64.json'))
   h = hashlib.sha256(open('yuzuno-core-linux-x86_64.tar.gz', 'rb').read()).hexdigest()
   assert h == d['archiveSha256'], 'archive does not match the signed descriptor'
   open('manifest.sha256', 'w').write(d['manifestSha256'])
   print('verified', d['manifest']['releaseId'])
   EOF
   ```

   Stop if either step fails.

3. **Unpack and register** it as a new managed installation. Registration checks every file against the signed manifest; it does not start anything.

   ```sh
   ROOT=~/.local/share/yuzuno-core
   mkdir bundle && tar -xzf yuzuno-core-linux-x86_64.tar.gz -C bundle
   bundle/bin/yuzuno-update-helper register --install-dir "$ROOT" --bundle "$PWD/bundle" \
     --manifest-sha256 "$(cat manifest.sha256)" --reviewed-source "$TAG" --initialize
   ```

4. **Allow later updates** from the same publisher. This file is how Core knows where releases come from and which key signs them:

   ```sh
   printf '{"repository":"YuzukiS/Yuzuno","publicKey":"%s"}\n' "$KEY" > "$ROOT/release-source.json"
   chmod 600 "$ROOT/release-source.json"
   ```

   You can delete `~/yuzuno-download` afterwards.

## Start, stop and restart

Core runs the release recorded in `current.json`, which an update changes. Start it detached from your terminal:

```sh
ROOT=~/.local/share/yuzuno-core
DATA=~/.local/share/yuzuno-core-data
RELEASE=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['releaseId'])" "$ROOT/current.json")
setsid nohup "$ROOT/releases/$RELEASE/bin/yuzuno-workspace" --install-dir "$ROOT" \
  --data-dir "$DATA" --port 4317 --cwd "$HOME" >>"$ROOT/core.log" 2>&1 </dev/null &
```

- **Port:** `--port` is Core's loopback port. It listens on `127.0.0.1` only.
- **Working directory:** `--cwd` is the default folder new Agents start in.
- **Codex location:** add `--codex /path/to/codex` if Codex is not on `PATH`.
- **Check it:** `curl -s http://127.0.0.1:4317/api/health` shows the release and Workspace.
- **Stop:** `"$ROOT/updates/start" stop --install-dir "$ROOT" --port 4317 --workspace-id <Workspace>` (the Workspace ID is in `curl -s http://127.0.0.1:4317/api/health`). It interrupts this installation's Core, on which Core shuts down cleanly, and waits up to a minute for it to exit. It does so only when that Core is the one process of this installation, runs the release it says it runs and holds the port; otherwise it says why and signals nothing. It never kills: a Core still running after the wait is reported as `stopping`. Releases whose `updates/start --help` lists no `stop` don't have it: there, `pkill -INT -f "$ROOT/releases/"`.
- **After a reboot:** run the start command again; it picks up the release an update left in `current.json`.
- **From the Windows desktop app:** each Core records how it started (`$ROOT/updates/launch.json`). After a reboot, the desktop app's connection page can then start it again with the same settings; see [Start Core from the app](../desktop/README.md#start-core-from-the-app-windows-wsl). Releases up to core.15 do not record this.

Starting Core as a systemd service is not supported yet. An update replaces the Core process, and a default service would treat the old process's exit as the service stopping. That has not been tested.

## Connect on the Core host

Open http://127.0.0.1:4317 in a browser on the Core host. With WSL2, a Windows browser or the Windows desktop app also reaches it at that address.

## First conversation, approvals and reconnecting

1. On the **Core host**, sign in to the native CLI as the same OS user who starts Core. Complete that CLI's login yourself; a Yuzuno browser on another computer uses this host's login, not the client's. Do not copy another user's authentication files. If Core runs with `CLAUDE_CONFIG_DIR` set, sign Claude Code in with the same `CLAUDE_CONFIG_DIR`. **Test connection** for the Core host (Machines, or in New agent) runs `claude auth status` as Core runs it: signed out, it shows Claude Code as unavailable and names the host, the folder and the command to sign in; if it cannot tell, Claude Code stays usable and the tip on its result says why. Codex's sign-in is not checked there. If the model catalog cannot load, check the CLI installation, `PATH` and sign-in on the Core host before retrying.
2. Create an empty working folder on the Core host. In Yuzuno, choose **New agent**, enter a name and that absolute folder path, choose **Claude Code** or **Codex**, and pick an available model. **Local** in the machine picker means the Core host, including when your browser is on a Mac and Core is on Linux. Its working folder and CLI login belong to Linux. Choosing an SSH machine here instead changes where the Agent executes; it does not change the browser's Core connection. For a short Claude test, Haiku is sufficient. You can leave **Project** at **No project** for the first conversation.
3. Open **Agent settings** in the conversation. Select your model and, for Claude, **Ask before actions**, then **Save**. The model applies from the next turn. Claude's existing native permission rules still apply; this option does not force every command to ask.
4. Send a short request such as: “Run `python3 -I -c 'print("hello from Yuzuno")'` once, then tell me its output. Do not read or write files.” If an approval appears, inspect the command and choose **Allow once** only if it matches your request. A command already allowed by your native rules may finish without an approval; that is not an error. Decline anything unexpected. The reply and tool activity should appear in the same conversation.
5. Type a draft without sending it, then close the browser. Reopen the **same address and port in the same browser profile**. Select your Agent if needed: the previous request/reply, saved model/approval choices and draft should still be present. Agent settings and history live in Core's data directory; drafts live in that browser's storage. Another browser profile or tunnel port does not share drafts.
6. To verify persistence across a Core restart, stop and start **this installation** using the commands above and keep the same `DATA`. Reopen the same URL. `/api/health` should show the same `workspaceId`, and the previous Agent and history should remain. Never create a new data directory as a reconnect workaround.

Closing the browser does not stop a running Agent or Core. If sending is disabled because Core is unreachable, restore Core or the SSH tunnel first. Keep the draft rather than repeatedly sending an operation whose outcome is unknown.

## Connect from another computer

The Core host needs an SSH server reachable from the client, with an account you are authorized to use. Test that SSH login first. On the first connection, verify the server's displayed host-key fingerprint with the host owner through a trusted channel before accepting it. An unexpected changed key must be investigated; do not disable host-key checking. Core itself has no separate browser login: SSH authenticates access to its port, while the native CLI login on the Core host authenticates model use.

On the client computer, forward a local port to Core's loopback port over SSH, and keep this running in a terminal:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:4317:127.0.0.1:4317 you@core-host
```

Then open http://127.0.0.1:4317 on the client.

- **A different local port:** if 4317 is taken on the client, use another one, e.g. `-L 127.0.0.1:5317:127.0.0.1:4317`, then open http://127.0.0.1:5317. Core accepts any local tunnel port on `127.0.0.1`, `localhost` or `[::1]`, and only pages served from that same address and port. Releases up to core.7 (2026.10.16-core.7) need the local port to equal Core's port.
- **Mac:** run the command in Terminal using its built-in OpenSSH client, then open the loopback URL in Chrome. The Mac needs no Linux Core package, Node or model CLI for this browser path. A bookmark can retain the URL, but cannot start the SSH tunnel for you. For a non-default SSH server port, add `-p <ssh port>` before `you@core-host`; that port is distinct from both HTTP ports in `-L`.
- **Windows:** the built-in OpenSSH client (`ssh.exe`) works. It ignores a private key that other accounts can read; a key made with `ssh-keygen` in `%USERPROFILE%\.ssh` is private already. A copied key may need `icacls <key> /inheritance:r /grant:r "%USERNAME%:F"` (in Command Prompt).
- **Keep the tunnel private:** forward to `127.0.0.1` only. Don't add `-g`, `GatewayPorts`, a reverse proxy or a public bind; Core has no login. The one proxy Core accepts is Tailscale Serve, on [a port of its own](#connect-from-a-phone-tailscale-serve); Core's own port refuses requests a proxy passed on.
- **If the tunnel drops:** the status shows **Core unreachable** and sending pauses. Your unsent text stays in the composer and in the browser's storage. Restart the tunnel, and the same page reconnects to the same Workspace within seconds. A reload while the tunnel is down fails in the browser; reload again once it is back, and the draft returns. Nothing starts another Workspace.
- **Browser storage:** this is separate for each address and port. A draft typed at `127.0.0.1:5317` is kept for that address.

If connecting fails, read the SSH terminal as well as the browser. **Permission denied (publickey)** concerns the SSH account/key, not a Yuzuno password or model login. **Address already in use** means choose a free client port; `ExitOnForwardFailure` makes the SSH command exit rather than leave a misleading connection running. A **connection refused** error for the forwarded destination means check Core's loopback port on the Linux host. A successful SSH login alone does not prove Core is running. Restore the same tunnel URL and data directory; reinstalling or creating another Workspace is not a reconnect step.

### Windows desktop app

Install it with `yuzuno-desktop-windows-x86_64-setup.exe` from the latest `desktop-<version>` release; it installs for your account only. A copy installed this way can update itself ([Desktop updates](../desktop/README.md#desktop-updates)). Any other copy is updated by running a newer installer. Releases after desktop 0.2.0 also offer `yuzuno-desktop-windows-x86_64-portable.zip`: unzip it and run `Yuzuno.exe`. That copy does not update itself and shares its saved Core and drafts with an installed copy ([Installer or portable ZIP](../desktop/README.md#installer-or-portable-zip-windows)).

Start it with `--core-url http://127.0.0.1:<local port>` (or set `YUZUNO_CORE_URL`). This has not been tested through a tunnel yet.

- **It cannot tell where Core is.** A loopback address looks the same whether Core runs on this computer or a tunnel leads to another one. The app treats both alike.
- **Desktop updates through a tunnel:** the app downloads its installer through the connected Core, which uses that Core host's `gh` sign-in. Through a tunnel, that Core host is the other computer. The app installs only an installer signed with its own built-in key, wherever it came from.
- **HTTPS URLs:** the app accepts these for another host, but Core does not serve HTTPS. That path is not a supported remote setup.

### Mac desktop app

The Mac app ([building and installing it](../desktop/README.md#macos-desktop-core-on-another-computer)) reaches Core through the same kind of tunnel as a browser. `scripts/mac-tunnel.sh start|stop|status` runs it with a key of its own and a pinned host key, so it starts without questions; the app is pointed at `http://127.0.0.1:5317` once and remembers it.

1. **A key for the tunnel**, on the Mac: `ssh-keygen -t ed25519 -f ~/.ssh/yuzuno_tunnel -C yuzuno-tunnel`. The private half is readable by you only (`0600`, in `~/.ssh`, `0700`) and never leaves the Mac. The script signs in without asking, so the key has no passphrase. **Treat it like a login to the Core host:** whoever can read that file (your Mac account, or an unencrypted backup of it) can open the tunnel, and since Core has no login, use the whole Workspace through it, including Agents that run commands on the Core host. Step 3 limits where the key works from and what else it can do; FileVault and encrypted backups protect the file itself.
2. **The Core host's host key**, pinned in its own file. Take the public key from the Core host itself through a channel you already trust (on the Core host: `cat /etc/ssh/ssh_host_ed25519_key.pub` and `ssh-keygen -lf` on it), compare the fingerprint, and write `[<core host>]:<ssh port> <that key>` to `~/.ssh/yuzuno_known_hosts`. Do not take it from `ssh-keyscan` alone, or from another SSH server at the same address: under WSL's mirrored networking, Windows' own SSH server (if any) shares the address on its own port.
3. **Authorize the key on the Core host**, in one of two ways. Both name the Mac's address on the private network in `from=` (on Tailscale, `tailscale ip -4` on the Mac), so the key is refused from anywhere else.
   - **A. A key line only** (no server change). In `~/.ssh/authorized_keys`:

     ```
     from="<the Mac's private address>",restrict,port-forwarding,permitopen="127.0.0.1:4317",command="/usr/bin/false" ssh-ed25519 AAAA… yuzuno-tunnel
     ```

     Checked with OpenSSH 10.6p1 on a server with a Linux host's own settings, where forwarding is at its defaults: a command, a shell or sftp runs the forced command instead; `-L` reaches Core's port only; from another address the key is refused. **It is not a Core-only key.** Key options cannot refuse remote forwards (`-R`), so with this key one can listen on the Core host: on a loopback TCP port (while `GatewayPorts` is off, the default) or on a Unix socket wherever the account can write. A `-L` to a Unix socket was refused as well, but only because this OpenSSH version checks it against the list `permitopen` fills, and the manual documents `permitopen` for TCP only; do not count on that.
   - **B. A port of its own** (an SSH server change, made by whoever administers the host). [`scripts/sshd-yuzuno-tunnel.conf`](../scripts/sshd-yuzuno-tunnel.conf) adds port 2223. There, only keys in `~/.ssh/authorized_keys_yuzuno_tunnel` are accepted (not `authorized_keys`, not an `AuthorizedKeysCommand`), and the server allows local forwarding to Core's port and nothing else. Put the key in that file only:

     ```
     from="<the Mac's private address>" ssh-ed25519 AAAA… yuzuno-tunnel
     ```

     To apply it on the Core host, save the server's current settings for its existing port first, then compare (`<port>` is that port):

     ```sh
     sudo sshd -T -C user=$USER,host=mac,addr=192.0.2.10,lport=<port> > before.txt
     sudo install -m 644 scripts/sshd-yuzuno-tunnel.conf /etc/ssh/sshd_config.d/30-yuzuno-tunnel.conf
     install -m 600 /dev/null ~/.ssh/authorized_keys_yuzuno_tunnel    # then add the key line above
     sudo sshd -t                                                       # prints nothing if valid
     sudo sshd -T -C user=$USER,host=mac,addr=192.0.2.10,lport=<port> | diff before.txt -
     sudo systemctl reload sshd                                         # the unit is "ssh" on Debian and Ubuntu
     ```

     The `diff` should show only `Port 2223` and the `ListenAddress` lines for it. If anything else differs, remove the file before reloading.

     Checked on copies of a Linux host's own settings (Arch Linux, OpenSSH 10.6p1, whose `sshd_config` includes `sshd_config.d` before its own lines) with `sshd -T` and a disposable server:
     - for the existing port, the drop-in changes nothing but adding `Port 2223` and its listen addresses;
     - on port 2223, commands, shells and sftp run `/usr/bin/false`; `-L` anywhere but Core's port, `-R` to TCP or a Unix socket, and `-L` to a Unix socket are refused; the key is refused on the other port and from another address;
     - that host also takes keys from an `AuthorizedKeysCommand` (systemd-userdb's). In the test a marked command stood in for it, supplying a key found nowhere else: that key signed in on the existing port and was refused on 2223, where sshd ran nothing and logged `AuthorizedKeysCommand path is not absolute` (how it treats `none` there).

     Not checked: a real server with the drop-in applied and reloaded, and PAM (the test server ran without it; PAM does not decide forwarding).

     **The Windows firewall (WSL).** Under mirrored networking, Windows' Hyper-V firewall filters connections into WSL. On the checked host, Tailscale's own Windows rule (any port to the host's Tailnet address, merged into WSL's rules) let the Mac reach the test server's ports, which had no rule of their own, so port 2223 needs none on the Tailnet. Do not add a rule that allows every address. If a rule is needed, limit it to the two private addresses and the port, in an administrator PowerShell (not run in these checks):

     ```powershell
     New-NetFirewallHyperVRule -Name Yuzuno-Tunnel-SSH -DisplayName "Yuzuno tunnel SSH" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalAddresses <the Core host's private address> -LocalPorts 2223 -RemoteAddresses <the Mac's private address> -Action Allow
     ```
4. **Start**: `YUZUNO_TUNNEL_HOST=<core host> YUZUNO_TUNNEL_SSH_PORT=<ssh port> scripts/mac-tunnel.sh start`, then connect the app to `http://127.0.0.1:5317`.

**To undo:**

- **A:** delete the key's line from `~/.ssh/authorized_keys`.
- **B:** `sudo rm /etc/ssh/sshd_config.d/30-yuzuno-tunnel.conf`, `sudo sshd -t`, reload the server, then `rm ~/.ssh/authorized_keys_yuzuno_tunnel`. If you added the firewall rule: `Remove-NetFirewallHyperVRule -Name Yuzuno-Tunnel-SSH`.
- **Either way,** a tunnel already open stays up until it ends: run `scripts/mac-tunnel.sh stop` on the Mac, or end its `sshd-session` process on the Core host. Then delete `~/.ssh/yuzuno_tunnel`, `~/.ssh/yuzuno_tunnel.pub` and `~/.ssh/yuzuno_known_hosts` on the Mac.

### Project services from a Mac

A [project service](project-services.md) opens on a port of Core's services range (`4380–4389` by default) on the Core host. To open one from the Mac, the tunnel forwards those ports too, each to the same number:

- **The key** (step 3) may forward them as well:
  - **A:** add `permitopen="127.0.0.1:4380"` through `permitopen="127.0.0.1:4389"` after `permitopen="127.0.0.1:4317"`. The other options stay as they are.
  - **B:** in `30-yuzuno-tunnel.conf`, change `PermitOpen 127.0.0.1:4317` to `PermitOpen 127.0.0.1:4317 127.0.0.1:4380 127.0.0.1:4381 … 127.0.0.1:4389`, then check and reload as in step 3.
- **The tunnel:** start it with `YUZUNO_TUNNEL_SERVICE_PORTS=4380-4389`. Once the tunnel to Core is up, the script adds each port with `ssh -O forward`. A port that something on the Mac already uses is named and skipped; the tunnel to Core stays up.

**To undo:** remove the added `permitopen` entries (A), or put back `PermitOpen 127.0.0.1:4317` and check and reload the server (B). Then `scripts/mac-tunnel.sh stop` and start it again without `YUZUNO_TUNNEL_SERVICE_PORTS`: the service ports close with the old tunnel, and nothing else changes.

The Projects dialog offers a service's address only after the page has proved that the port reaches this Core. Where a port on the Mac leads elsewhere, or nowhere, the dialog says so and offers no address. These checks ran with a Mac stand-in (another loopback address with its own restricted tunnel) and real OpenSSH. They have not been run on a real Mac.

## Connect from a phone (Tailscale Serve)

A phone's browser has no SSH tunnel. Instead, Core can open a **second loopback port** that only [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) is pointed at. Serve gives it an HTTPS address on your tailnet (not the internet: that would be Funnel, which Core refuses), and tells Core which tailnet login each request comes from. Core lets in exactly one login. This is off unless all three settings below are made. On 2026-10-25 it was set up from Settings on a WSL Core with Tailscale for Windows, and an iPhone opened it.

**What Core checks on that port**, for every page, API call, live update and artifact:
- `Tailscale-User-Login` appears once and is exactly the configured login. Serve removes any copy a client sent and sets it only for a tailnet user's request ([identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)), so a request from a tagged device or through Funnel has none and is refused, as is any request without it. A user from another tailnet the device was shared with has their own login and is refused too. Tailscale does not say that the machine running Serve gets no login: in one check (T-170, Tailscale 1.102.4 on Windows), a request that machine sent to its own Serve address carried its owner's login and was let in. Programs on that machine can reach Core's ports directly anyway.
- `Host` is the configured address, as Serve passes the browser's own.
- A change also needs the page's own `Origin` and Yuzuno's client header, so another site open on the phone cannot make one.
- Nothing falls back to the loopback rules, and `X-Forwarded-*` headers are not read. The Agents' MCP endpoints are not served there.

Core's own port is unchanged, except that it refuses a request carrying Tailscale's or a proxy's headers, in case Serve is pointed at it by mistake. A program on the Core host can still reach both ports directly, as it always could reach Core's.

**From Settings** (Core in WSL, Tailscale for Windows on the same PC). Settings → Phone & remote access does steps 2 to 4 below without restarting Core:
- **Check** reads, without changing anything: the host pair, Tailscale, HTTPS, Core's second port, whether Windows reaches it, the Serve entry, and a request through it from Windows.
- **Save and apply** opens the second port, adds or takes over the one Serve entry and checks it again. It records how the change ended: **succeeded**; **rolledBack** when it put the previous entry back; **failed**, which includes an entry that was set but whose check failed (not verified); **uncertain** when a step timed out; or **interrupted** if Core stopped during it. The page then reads Tailscale, Serve and Core's port again and shows what it finds. Which outcome you get depends on where it stopped, and the last step, saving, can fail after the port and Serve were already changed: go by the recorded result and the state shown, not by an assumption that the previous entry is back.
- **Turn off** removes only that Serve entry and closes the second port. Connections that came through the entry, live updates included, end when it changes.

Core keeps what it applied in `remote-access.json` in the Workspace data folder, and a Core started on that data folder tries it again at every start. If its port cannot be bound then, Core starts without phone access and the page says why; apply it again or choose another port. Once anything is applied there, the `YUZUNO_REMOTE_*` settings below are ignored, and the page says so; until then they apply as before, and applying the same values takes them over without touching Serve. Core changes only the Serve entry it created, or one it found already pointing exactly where it would; an entry changed outside Yuzuno is left as it is. Phone access is changed only from Core's own port, never through the phone entry. Any other host (a Tailscale inside WSL, Linux, macOS) uses the steps below. Settings were checked with stand-ins for `tailscale.exe` and Windows' `curl.exe` (`acceptance/t185-remote-access`). On 2026-10-25 **Save and apply** also ran once against a real Serve on Windows: it took over an existing entry that already pointed at Core's phone port, unchanged, its own check passed, and an iPhone then opened the address. Creating a new Serve entry from Settings has not been checked against a real Serve.

**Previews on the phone.** A single HTML file (a Home attachment or a conversation file) opens as an isolated preview from an origin of its own, never Core's, and the previews' usual port is loopback only. Through the phone entry, previews are served instead by an entry of their own, set in Settings → Phone & remote access → **Previews on the phone**: one more loopback port (default 4319) and one more Serve entry, on another HTTPS port of the same node name (default 8445). That entry serves snapshots and their one-time proofs only, never Core's API. Every request there needs the phone entry's login, once, and that entry's own `Host`; Funnel is refused. A preview asked for through the phone entry is taken for it, as its login and page: it opens only there, framed only by the phone's page, and not after the login changes. It is off until it is turned on; a phone setup from before it, also after an update, opens nothing new. **Turn on previews** reads Serve first and stops before changing anything if another entry holds the port. Like the phone entry, it records how it ended and changes only its own Serve entry, and it never changes the phone entry. Turning phone access off turns previews off too. Core keeps them in `remote-preview.json`; a Core that cannot start them leaves phone access as it is and says why. They are set from Settings only, on the supported pair above. Closing the Portal revokes nothing: a page opened outside it keeps opening, for at most the snapshot's hour. Core can drop a snapshot sooner, when newer ones take its place (16 at most, 8 MB in all) or when Core restarts. Checked with stand-ins only: Rust tests, and Chromium against a stand-in Serve. Not yet with a real Serve or on an iPhone.

**Set it up by hand** (the names here are examples; use your node's name from `tailscale status`):
1. **Tailnet:** MagicDNS and [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) must be on. Turning certificates on publishes your machine names and tailnet name in public Certificate Transparency logs, and turning them off later does not revoke issued certificates.
2. **Choose a free HTTPS port.** `tailscale serve status` lists what Serve already uses on this node; never reuse or reset another entry. Funnel's port limits do not apply to Serve.
3. **Core's settings.** For an installed Core, stop it and start it again with the entry, through its own start entry (`$ROOT` and `<Workspace>` as in [Start, stop and restart](#start-stop-and-restart)):
   ```sh
   "$ROOT/updates/start" stop --install-dir "$ROOT" --port 4317 --workspace-id <Workspace>
   "$ROOT/updates/start" start --install-dir "$ROOT" --port 4317 --workspace-id <Workspace> \
     --remote-port 4318 --remote-origin https://core.example-tailnet.ts.net:8444 --remote-login person@example.com
   ```
   The port is Core's second loopback port; the origin is exactly what the phone's browser shows, `https://<node>:<Serve port>` (no port for 443); the login is your tailnet login as Tailscale shows it. `start` checks them as Core does, and refuses to change a Core that is running. It prints one line, which says what the started Core recorded (`"remote":{"entry":"on",…,"recorded":true}`), and then stays while Core runs, so that WSL keeps running; Ctrl-C ends only it. Core records these settings with the rest of how it started, so the desktop app's starts and Core updates keep the entry. Core says `Remote entry: http://127.0.0.1:4318 …` in `$ROOT/core.log` when it starts.

   A Core run from a source build, or a release without `--remote-port` in `updates/start start --help`, reads them from its environment instead (not options, so that a Core update, which keeps the environment, keeps the entry), all three or none:
   ```sh
   YUZUNO_REMOTE_PORT=4318
   YUZUNO_REMOTE_ORIGIN=https://core.example-tailnet.ts.net:8444
   YUZUNO_REMOTE_LOGIN=person@example.com
   ```
4. **On the machine where Tailscale runs** (on Windows with WSL, Windows; it reaches WSL's loopback port as the Windows app reaches Core's): `tailscale serve --bg --https=8444 http://127.0.0.1:4318`.
5. On the phone, signed in to the same tailnet, open `https://core.example-tailnet.ts.net:8444`.

**On the Home Screen.** The page has a web app manifest and an apple-touch-icon (the Yuzuno character, 128 px), so a phone's browser can add it to the Home Screen; it then opens on its own, without the browser's bars, at the same address and through the same entry. It is the same page: it needs the connection as before (there is no offline copy), and drafts stay in the phone's browser storage; adding it to the Home Screen does not make them safe from loss. On 2026-10-26 an iPhone added it to the Home Screen and opened it from there (the user's report).

**Notifications on the Home Screen.** On an iPhone or iPad (iOS 16.4 or later), the page opened from the Home Screen can turn on background notifications for that device in **Settings → Notifications & attention → Push notifications on this device**. Core then sends a Web Push message through Apple's push service when an Agent finishes a Turn, its Turn fails, or it needs you (a request, or an Ask on Home), as each kind is chosen there; the system shows it with the app closed or the phone locked. A notification gives the Agent's name and what happened, never the conversation, and tapping it opens that Agent (Home for an Ask) in the same page. Core sends only to Apple's push service (`*.push.apple.com`, over HTTPS from the Core host), so a desktop browser cannot turn this on. Core makes its push key the first time a device tries to turn notifications on, after the system has allowed them and before the subscription is saved, so `push.json` can stay in the data folder even if subscribing then fails. It keeps the key there with each device's subscription; a Workspace backup leaves that file out, so after a restore each device turns notifications on again. When Apple says a subscription is gone or refuses it, or five sends in a row fail for a temporary reason (no answer in time, too many requests, or an error at Apple's end), Core stops sending to that device and Settings says so. Core does not retry a send by itself; turning notifications on again from that device starts sending again. On 2026-10-26, with core.19 on the maintainers' WSL Core, an iPhone turned this on from the Home Screen app: the notice that an Agent had finished arrived with the phone locked and opened that Agent, and a notice for an Ask arrived and opened Home (the user's report). Turning it off, a refused permission, and refused, expired or unanswered sends were checked only in tests, with synthetic keys, a stand-in push service and simulated browser states.

**To undo:** `tailscale serve --https=8444 off`, which removes only that entry. Then stop Core and start it again with `--no-remote` instead of the three `--remote-…` options (or, without the start entry, unset the three variables and restart Core): its second port closes, and Core records that it has none. Never use `tailscale serve reset`, which would also remove other services' entries. The certificate logs keep any name already published.

## Update

Settings → Updates checks the publisher's releases, downloads and verifies one, prepares it while you keep working, and applies it when Agents are idle. It needs `release-source.json` and a signed-in `gh`. See [Managed Workspace updates](workspace-updates.md). Updates do not change the native CLIs or the desktop app. The desktop app updates separately; [Updates and platform support](updates-and-platforms.md) says which part updates how, and what is released.

## Uninstall

1. Stop Core (above).
2. **Keep or delete the Workspace:** `$DATA` holds the database, uploads and backups made by updates. Delete it only if you no longer want the Workspace.
3. **Remove the program:** delete `$ROOT` (releases, staging, update logs and `release-source.json`).

Claude Code, Codex and `gh` keep their own configuration; uninstalling Yuzuno does not touch it.

## macOS Core: current gaps

A macOS Core is planned. Remote Codex Agents on a Mac (over SSH) already work, but that is not a macOS Core. Today:

- **Jobs:** need systemd user units and cgroup v2 limits, plus `/proc`, for resource-limited, reported runs (`core/src/jobs/host.rs`, `core/src/jobs/host.py`). macOS has neither. A plain process launcher would not give the same hard CPU, memory or process limits, so Jobs would be unavailable or explicitly weaker there.
- **Managed updates:** identify the running process through Linux-only process identity (`core/src/updates/state.rs`). They are refused on other systems.
- **Packages:** release packaging, signing and CI build Linux x86_64 only (`tools/build-core-artifact.py`, `tools/package-release.py`).

A macOS Core first needs these decisions; until then a source build on macOS is not supported. A source build of main was compiled and started on a Mac on 2026-10-17. [macOS Core: gaps and a first slice](macos-core.md) lists what it found, every gap with its code, and a proposed first slice (not implemented).

## What was tested

The browser and SSH checks ran on 2026-10-17 on one computer, using Windows 11 Pro (build 26200, x64) with WSL2 and the following software:
- **Linux:** Arch Linux, kernel 6.18, glibc 2.44, systemd 262, cgroup v2, mirrored networking.
- **Tools:** Claude Code 2.1.280 with Haiku, gh 2.102.0, minisign 0.12 and Node 22.23.2.

The scripts are in `acceptance/t88`.

- **Install, first use, update and reinstall (core.6 to core.7):** this guide's commands ran as written, with only the release, folders and port changed. Then, in Chromium 153:
  - It created a Claude Code Agent and granted a file write with **Allow once**.
  - It was closed and reopened; history and the draft were still there.
  - **Settings → Updates** installed core.7 on the same Workspace. The draft was then sent and answered.

  After that, Core was stopped and started. The program folder was deleted, and core.7 was installed again over the kept Workspace. Core and its Claude bridge used no file from a source checkout.
- **Through SSH tunnels:** this used a build of this change; core.7 still needs the local port to equal Core's. Core ran on port 4489 behind a user-level `sshd`. Two browsers used the same Workspace at the same time:
  - Chromium on Linux, through OpenSSH 10.6 on local port 5489.
  - Edge 155 on Windows, through the Windows OpenSSH client 9.5 on local port 5490.

  Each browser sent a Claude turn and granted an approval in the page. Dropping a tunnel showed **Core unreachable**, paused sending and kept the draft. Restoring it reconnected the same page to the same Workspace.
- **Without Codex:** Core ran with `--codex /bin/false`. The page showed that the Codex model list was unavailable, and Claude Agents worked.

**Additional userspace check (2026-10-18 UTC):** the published signed `core-20261017-a5adb60` (`2026.10.17-core.8`) passed 37 checks in a disposable Ubuntu Base 22.04.5 rootfs with glibc 2.35 on the same WSL2 kernel. The rootfs and release files were read-only mounts; only the lab and private temporary mounts were writable. No source checkout, host libraries or login directories were mounted, and the inherited environment was cleared without setting `HOME`. The bundled Core and update helper registered the package, served the release's HTML/JS/CSS, and preserved the Workspace and a project marker through restart and program removal/reinstall. This was not a browser or Agent test. [Inputs, digests, Jobs and report hashes](../acceptance/t88/README.md#ubuntu-rootfs-results-2026-10-18-utc) distinguish the published package from the newer harness source.

**Published core.9 first use (2026-10-18 UTC):** this guide's installation blocks downloaded and verified `core-20261017-f8b9266`. In a new installation/data directory and Chromium profile on the same Arch/WSL2 account, one real Haiku turn ran a harmless printing command after **Allow once**. The Agent settings, completed request/reply and unsent draft survived closing/reopening Chromium and a Core restart, with the same Workspace ID. A temporary project-local Claude permission rule forced this one command to ask; the user's global permissions were unchanged. A separate small Job through that installed Core succeeded with actual systemd/cgroup v2 limits of 0.5 CPU, 128 MiB RAM, zero swap and 512 tasks. It made no extra model call. This tests Jobs launched by Core, **not Core as a systemd service**, and uses an existing native login rather than a fresh account. [Exact inputs, reports and boundaries](../acceptance/t88/README.md#core9-first-use-results-2026-10-18-utc).

**Separate Mac client, signed core.10 (2026-10-18 UTC):** Chrome 154 on a separate Apple silicon Mac running macOS 27.0.1 used that Mac's OpenSSH 10.3 client to reach an isolated signed core.10 installation on Arch/WSL2. The browser's local port differed from Core's. Wrong SSH host keys and unauthorized client keys were rejected; the approved disposable key opened the tunnel. One real Haiku turn received one exact **Allow once** approval. Tunnel interruption paused sending and kept the draft; reconnecting without reloading, recovering after an offline reload, restarting Chrome with the same profile and restarting Core all retained the Workspace, history, settings and draft. Cross-origin/Host guards returned 403 through the tunnel. A separate corrected TCP probe confirmed that the Mac's direct connection to Core's port was refused; the original HTTP-based reachability assertion was unreliable and was replaced by that evidence. The Mac test profile and keys were removed afterwards. This used headless Chrome controlled from Linux, a temporary restricted SSH server on an already reachable private network, and existing Linux model credentials. It does not test setting up a network or a fresh CLI account. [Reproduction and evidence](../acceptance/t88/README.md#separate-mac-client-results-2026-10-18-utc).

**Mac desktop app (2026-10-19 UTC):** an ad hoc signed build of this source (`Yuzuno_0.1.0_aarch64.dmg`) was installed from its disk image on that Mac (macOS 27.0.1, Apple M6) and started with `open`. Through `scripts/mac-tunnel.sh` and a temporary SSH server on the Linux host's private address, it opened an isolated Workspace on the published core.11 binary, saved that Core and opened it again when started without arguments, and its open window reached Core again after the tunnel was stopped and started. Requests were recorded at the Core end by user agent, so the app's own requests were told apart from the checks'. It also opened the account's existing Workspace through a relay that let only reads through; it sent only reads. The same run checked what the two ways of authorizing the tunnel key above allow, on a temporary SSH server made from the Linux host's own settings plus the drop-in (and, with `sshd -T` on copies of those settings, that the drop-in changes nothing for the existing port but its new listener), and how `scripts/mac-tunnel.sh` handles a leftover process ID file, a local port another service already answers on, a second Core for the same port and two starts at once. In this run nobody looked at the window: what it shows, sending a message and drafts were not checked (a person did, in the sessions below). [Reproduction and evidence](../acceptance/t141/README.md).

**Mac desktop app with a person at the Mac (2026-10-19 UTC):** the same build, in two sessions. The records stay outside the repository, because they name the user's machines.
- **An isolated Workspace,** on the published core.11 binary. The person created a Claude Code Agent and sent a message with a picture.
  - **Recorded at the Core end:** the app's own requests (the Agent, the picture upload, the messages, an answered approval) and, after the person stopped and restarted the tunnel, the window reaching Core again.
  - **In the Workspace:** the Bash command ran, and the reply named the picture and the requested link.
  - **The check itself failed:** 2 of its 13 checks, both written for a single turn, because the message was sent twice. That failure is kept.
- **The daily Workspace, view only,** through a temporary tunnel; nothing was sent.
- **Afterwards** the app, its data, the tunnel key and script, and the temporary SSH listener were removed. Two metadata differences stayed on the Mac, which the user accepted: a Finder `.DS_Store` and a temporary folder's modification time.
- **The person's report only:** what the window showed, the drafts kept across the tunnel restart, copy and paste.

**Public core.13, without a sign-in (2026-10-21 UTC):** the first release of this repository, `core-20261021-827bd32` (`2026.10.21-core.13`). Its three files were downloaded from the Releases page with `curl`, without a GitHub account or any credentials. They matched the digests recorded when the release was signed, and the publisher key above verified the descriptor. Both runs were on the same computer and WSL2 kernel as the checks above, as the existing Linux user, with made-up data only:
- **Ubuntu 22.04.5 rootfs (glibc 2.35), no network:** the rootfs prepared for core.8 above, reused read-only after its signatures and digests were checked again. 37 of 37 checks passed: registration, Core health, the served UI's files, restart, and removing the program and reinstalling it over the kept Workspace and project. The rootfs has no Node or Claude Code, so Claude was not started there.
- **First Claude start, on Arch Linux (glibc 2.44, Node 22.23.2):** a new installation, with core.13 as its only release and a made-up home folder holding one made-up Claude session. The first request that needed Claude made Core download the locked Agent SDK 0.3.296 from `registry.npmjs.org` and check it against the locked integrity; the bridge then listed the session. With the network then cut to loopback only, Core started again from the same installation and listed the session with the SDK it had prepared: every prepared file kept its SHA-256, size and modification time. No Claude Code CLI, sign-in or model call was involved.

This does not test a sign-in, a conversation, an approval, a browser, an update, a new OS account or another computer. [Inputs, Jobs and report hashes](../acceptance/t88/README.md#public-core13-results-2026-10-21-utc).

**Public core.18 on an existing WSL installation (2026-10-25 UTC):** the maintainers' own installation, on Arch Linux in WSL2, updated from core.17 to `core-20261025-003cf00` (`2026.10.25-core.18`) with **Settings → Updates**. The update's record checks passed after restoration, and all 8 native sessions attached at the handoff came back. **Settings → Phone & remote access** then set up the phone entry with Tailscale for Windows: Core listened on its phone port, took over the existing Serve entry unchanged, and its check passed. An HTTPS request from Windows through Serve answered with that release and Workspace, and an iPhone opened the address (the user's report). An iPhone app built from the same source connected through it and sent a message. All of this used existing accounts and sign-ins: it is not a new user's first install.

**Public core.19 on the same installation (2026-10-26 UTC):** it updated from core.18 to `core-20261025-6bd7683` (`2026.10.25-core.19`) with **Settings → Updates**. The update's record checks passed after restoration, all 8 native sessions came back, and the phone entry answered through Serve with the new release and the same Workspace, without being set up again. An iPhone then turned on push notifications from the Home Screen app, as described in [Connect from a phone](#connect-from-a-phone-tailscale-serve). Again with existing accounts and sign-ins: not a new user's first install.

**Not tested yet:**
- a fresh full OS installation or a new OS account (the rootfs uses a mapped existing host user; browser tests used existing Claude Code and gh sign-ins);
- distributions beyond the Arch environment and limited Ubuntu rootfs check above; real login/Agent/approval, the first Claude start, browser rendering and systemd Jobs inside that Ubuntu environment;
- **Settings → Updates** from this public repository in a fresh installation (the maintainers' own WSL installation updates through it, most recently core.18 to core.19 on 2026-10-26), and downloading or updating with a `gh` account that has no access to the repository;
- local Jobs on a host whose user manager lacks the `cpu` controller, such as the Ubuntu 22.04.5 host above, before or after an administrator delegates it ([Prerequisites](#prerequisites-on-the-core-host));
- the Windows desktop app through a tunnel;
- Safari and other Mac browsers; for the Mac desktop app: sending to a daily Workspace, an automated check of what its window shows, a downloaded (quarantined) copy, and an Intel build on an Intel Mac;
- Core as a systemd service.
