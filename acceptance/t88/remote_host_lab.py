#!/usr/bin/env python3
"""T-88: the guide's install on a separate Linux host over SSH, from a
published signed release, reached from this computer through an SSH tunnel;
then what a fresh user meets there before and after the first sign-in.

Stages:
- `install` (no sign-in): download the release's files here with `gh` (the
  host may have no GitHub login), copy them and a pinned minisign binary to a
  NEW run folder on the host, run the guide's verify/register/release-source
  blocks there, start Core on the host's loopback port as the guide does,
  check health and the served UI through `ssh -L`, stop Core with the guide's
  own command, and check that nothing changed outside the allowed folder.
- `pre-login`: the installed run's Core with a NEW empty Claude profile and
  data folder (<run>/prelogin); one harmless message from the published UI,
  a Core restart and a new browser process; what the UI and Core say is
  recorded as observed. The profile kept for the owner's sign-in is untouched.
- `first-use`: after the account owner signed the run's own profile in
  (`claude-login.sh`, run by the owner), the first real conversation with one
  exact approval, a reopen and a Core restart (first-use-client.mjs).

Everything on the host is written under --remote-base/<run>, which must be
inside --remote-allowed, and is kept as evidence. Native CLIs keep their
state under that run (CLAUDE_CONFIG_DIR, TMPDIR, XDG folders); HOME is never
changed and no credential is read or copied.

Usage (placeholders in <>; host paths may start with $HOME or ~ and are
expanded by the host's shell):
  remote_host_lab.py install --target <ssh-alias> --tag <release tag> \
    --public-key <publisher key> --minisign /abs/minisign \
    --remote-allowed '$HOME/<allowed>' --remote-base '$HOME/<allowed>/<runs>' \
    --run <new run name> --remote-port <port> --local-port <port> \
    --node-bin '$HOME/<allowed>/<node>/bin' --lab /abs/new-local-lab \
    --report /abs/report.json
  remote_host_lab.py pre-login|first-use <same host options> \
    --node /abs/node --browser /abs/chromium --lab ... --report ...
"""
import argparse
import hashlib
import json
import re
import shlex
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20"]
# Where Core, Claude, Node or Codex would write by default in the account's home.
DEFAULT_FOLDERS = ".claude .claude.json .config .local/share .local/state .cache .yuzuno .yuzuno-next .codex .npm .node_repl_history"
report = {"stage": None, "checks": [], "steps": []}


def host_path(value):
    """A path on the host, put unquoted into its shell so that $HOME or ~ expand
    there: only an absolute path or one under $HOME/~, of plain characters,
    without `..`. Several may be joined with `:`."""
    for part in value.split(":"):
        rest = re.sub(r"^(\$HOME|~)(?=/|$)", "", part)
        if (rest == part and not part.startswith("/")) or not re.fullmatch(r"[A-Za-z0-9._/-]*", rest) \
                or ".." in rest.split("/") or (part.endswith("/") and part != "/"):
            raise argparse.ArgumentTypeError(f"not a plain host path: {value!r}")
    return value


def run_name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value):
        raise argparse.ArgumentTypeError(f"not a plain name: {value!r}")
    return value


def check(name, passed, facts=None, kind="real host"):
    report["checks"].append({"check": name, "passed": bool(passed), "kind": kind, "facts": facts})
    print(("PASS " if passed else "FAIL ") + name, flush=True)
    if not passed:
        raise SystemExit(f"FAIL {name}: {json.dumps(facts)[:600]}")


def run(name, argv, stdin=None, timeout=600):
    done = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout)
    report["steps"].append({"name": name, "argv": argv[:6], "exitCode": done.returncode,
                            "stdoutTail": done.stdout[-1500:], "stderrTail": done.stderr[-1500:]})
    return done


def remote(name, target, script, timeout=600):
    """Runs a POSIX sh script on the host from stdin; returns the completed process."""
    return run(name, SSH + [target, "sh", "-s"], stdin=script, timeout=timeout)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def get(url, timeout=10):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as response:
        return response.status, response.read()


def prepare_script(allowed, runs, name):
    """Makes the NEW run folder on the host, inside the allowed folder only, with
    the folders its native CLIs keep their state in, and records the account's
    own Claude/Node/Codex processes that already run (they may write in its
    home meanwhile): pid, start time, command. Nothing is made before the runs
    folder, resolved through its deepest existing ancestor (the folders still to
    be made cannot be links), is known to be inside the allowed folder."""
    return f"""set -eu
allowed=$(cd {allowed} && pwd -P)
want={runs}
rest=
while [ ! -d "$want" ]; do rest="/${{want##*/}}$rest"; want=${{want%/*}}; [ -n "$want" ] || want=/; done
runs=$(cd "$want" && pwd -P)$rest
case "$runs/" in "$allowed"/*) ;; *) echo "outside allowed: $runs" >&2; exit 9;; esac
mkdir -p "$runs"
base=$(cd "$runs" && pwd -P)/{shlex.quote(name)}
case "$base/" in "$allowed"/*) ;; *) echo "outside allowed: $base" >&2; exit 9;; esac
test ! -e "$base" || {{ echo "exists: $base" >&2; exit 8; }}
mkdir -p "$base/download" "$base/tools" "$base/work" "$base/claude-config" "$base/tmp"
for d in cache config data state; do mkdir -p "$base/xdg/$d"; done
: > "$base/.started"
ps -u "$(id -u)" -o pid=,lstart=,args= | grep -E "(^|/| )(claude|node|codex)( |$)" | grep -v grep > "$base/.foreign" || true
echo "$base"
"""


def existing_run(allowed, runs, name):
    """Finds an installed run folder, inside the allowed folder only."""
    return f"""allowed=$(cd {allowed} && pwd -P)
base=$(cd {runs}/{shlex.quote(name)} && pwd -P)
case "$base/" in "$allowed"/*) ;; *) echo "outside allowed: $base" >&2; exit 9;; esac
test -f "$base/core/current.json"
"""


def boundary_lines(since, allowed):
    """Lists, raw, what changed since the marker file where Core, Claude, Node
    or Codex would write by default, then home's new top-level entries other
    than the allowed folder's own, then the account's new /tmp entries."""
    return f"""home=$(cd "$HOME" && pwd -P)
allowed=$(cd {allowed} && pwd -P)
case "$allowed" in "$home"/*) top=${{allowed#"$home"/}}; top=${{top%%/*}};; *) top=;; esac
cd "$HOME"
echo "candidates:"
for p in {DEFAULT_FOLDERS}; do
  test -e "$p" && find "$p" -maxdepth 3 -newer {since} -print 2>/dev/null | head -20
done
echo "toplevel:"
if [ -n "$top" ]; then find . -mindepth 1 -maxdepth 1 -newer {since} ! -name "$top" -print 2>/dev/null | head -40
else find . -mindepth 1 -maxdepth 1 -newer {since} -print 2>/dev/null | head -40; fi
echo "tmp:"
find /tmp -maxdepth 1 -mindepth 1 -user "$(id -u)" -newer {since} -print 2>/dev/null | head -40
"""


def account_claude(foreign, alive):
    """The account's own Claude processes from the snapshot taken before the
    stage (`ps` pid, five start-time fields, command) that still run."""
    found = []
    for line in foreign:
        parts = line.split(None, 6)
        if len(parts) == 7 and parts[0] in alive and any(Path(word).name == "claude" for word in parts[6].split()):
            found.append(line)
    return found


def tolerated(candidates, claude_before):
    """The only home change counted as the account's own: Claude Code's
    skill-sync round under ~/.claude/skills/synced, and only while a Claude
    process the account ran before the stage still runs."""
    synced = ".claude/skills/synced"
    return [c for c in candidates if c == synced or c.startswith(synced + "/")] if claude_before else []


def install(args):
    lab = Path(args.lab)
    assert lab.is_absolute() and not lab.exists(), "--lab must be a new absolute folder"
    lab.mkdir(parents=True, mode=0o700)
    download = lab / "download"
    download.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", args.local_port))  # the tunnel's local port must be free
    files_named = (f"{args.asset}.json", f"{args.asset}.json.minisig", f"{args.asset}.tar.gz")
    py = args.host_python

    # 1. The release's three files, here.
    got = run("gh-download", ["gh", "release", "download", args.tag, "-R", args.repository,
                              "-p", f"{args.asset}.*", "-D", str(download)])
    files = {name: sha256(download / name) for name in files_named if (download / name).exists()}
    check("The release's three files download here with gh", got.returncode == 0 and len(files) == 3,
          {"tag": args.tag, "sha256": files}, kind="this computer")
    report["release"] = {"repository": args.repository, "tag": args.tag, "files": files, "minisign": sha256(args.minisign)}

    # 2. A new run folder on the host, inside the allowed folder only.
    q = shlex.quote
    made = remote("host-prepare", args.target, prepare_script(args.remote_allowed, args.remote_base, args.run))
    base = made.stdout.strip().splitlines()[-1] if made.returncode == 0 else None
    check("A new run folder on the host, inside the allowed folder", made.returncode == 0 and base,
          {"base": base, "stderr": made.stderr[-300:]})
    report["remote"] = {"target": args.target, "base": base}
    copy = run("scp-release", ["scp", "-p", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                               *[str(download / name) for name in files_named], f"{args.target}:{base}/download/"])
    tool = run("scp-minisign", ["scp", "-p", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                                args.minisign, f"{args.target}:{base}/tools/minisign"])
    check("The three files and the pinned minisign binary are copied there", copy.returncode == 0 and tool.returncode == 0)

    # 3. The guide's verify, unpack/register and release-source blocks, on the host.
    blocks = f"""set -eu
base={q(base)}
TAG={q(args.tag)}
KEY={q(args.public_key)}
cd "$base/download"
"$base/tools/minisign" -Vm {q(files_named[0])} -P "$KEY"
{py} - <<'EOF'
import hashlib, json
d = json.load(open({files_named[0]!r}))
h = hashlib.sha256(open({files_named[2]!r}, 'rb').read()).hexdigest()
assert h == d['archiveSha256'], 'archive does not match the signed descriptor'
open('manifest.sha256', 'w').write(d['manifestSha256'])
print('verified', d['manifest']['releaseId'])
EOF
ROOT="$base/core"
mkdir bundle && tar -xzf {q(files_named[2])} -C bundle
bundle/bin/yuzuno-update-helper register --install-dir "$ROOT" --bundle "$PWD/bundle" \\
  --manifest-sha256 "$(cat manifest.sha256)" --reviewed-source "$TAG" --initialize
printf '{{"repository":"%s","publicKey":"%s"}}\\n' {q(args.repository)} "$KEY" > "$ROOT/release-source.json"
chmod 600 "$ROOT/release-source.json"
{py} -c "import json,sys; print('current', json.load(open(sys.argv[1]))['releaseId'])" "$ROOT/current.json"
"""
    done = remote("guide-install", args.target, blocks, timeout=900)
    lines = done.stdout.splitlines()
    verified = next((l.split()[1] for l in lines if l.startswith("verified ")), None)
    current = next((l.split()[1] for l in lines if l.startswith("current ")), None)
    check("The guide's blocks verify the signature and archive and register the release there",
          done.returncode == 0 and verified and verified == current,
          {"verified": verified, "current": current, "stderr": done.stderr[-400:]})
    report["release"]["releaseId"] = current

    # 4. Start Core as the guide does; native CLI state would stay under the run.
    # 5. Then through an SSH tunnel from this computer.
    tunnel, ready = None, False
    try:
        start_core(args, base, "install")
        tunnel = open_tunnel(args)
        health = wait_health(args)
        check("Health answers through the tunnel: the release, a Workspace, storage and API ready",
              health and health.get("releaseId") == current and health.get("workspaceId")
              and health.get("storageReady") is True and health.get("apiReady") is True,
              {k: (health or {}).get(k) for k in ("releaseId", "workspaceId", "storageReady", "apiReady", "product", "application")},
              kind="real host via ssh -L from this computer")
        report["workspaceId"] = health["workspaceId"]
        status, page = get(f"http://127.0.0.1:{args.local_port}/")
        served = hashlib.sha256(page).hexdigest()
        shipped = remote("bundle-index", args.target,
                         f"set -eu\nsha256sum {q(base)}/core/releases/{q(current)}/web/index.html | cut -d' ' -f1\n")
        check("The UI page served through the tunnel is the release's own index.html",
              status == 200 and shipped.returncode == 0 and shipped.stdout.strip() == served,
              {"served": served, "shipped": shipped.stdout.strip(), "bytes": len(page)},
              kind="real host via ssh -L from this computer")
        # With no Agent, Core starts no process of its own (no Claude, Node or Codex).
        children = remote("core-children", args.target, f"""set -eu
ROOT={q(base)}/core
core=$(pgrep -f "$ROOT/releases/" | head -1)
echo "core $core"
pgrep -P "$core" -a || true
""")
        lines = children.stdout.split("\n")
        spawned = [l for l in lines[1:] if l.strip()]
        check("Without an Agent, Core runs no child process (no Claude, Node or Codex)",
              children.returncode == 0 and lines[0].startswith("core ") and not spawned,
              {"core": lines[0], "children": spawned})
        ready = True
    finally:
        # 6. Stop with the guide's command, then the boundary check.
        close(args, base, tunnel, ready, "install")
    stopped = remote("boundary", args.target, f"""set -eu
base={q(base)}
{boundary_lines('"$base/.started"', args.remote_allowed)}echo "ourprofile:"
find "$base/claude-config" "$base/tmp" -mindepth 1 -print 2>/dev/null | head -5
echo "foreign:"
cat "$base/.foreign"
echo "foreignalive:"
while read -r pid rest; do kill -0 "$pid" 2>/dev/null && echo "$pid"; done < "$base/.foreign"
""", timeout=120)
    out = stopped.stdout.split("candidates:")[-1]
    candidates, _, rest = out.partition("toplevel:")
    toplevel, _, rest = rest.partition("tmp:")
    tmp, _, rest = rest.partition("ourprofile:")
    profile, _, rest = rest.partition("foreign:")
    foreign, _, alive = rest.partition("foreignalive:")
    candidates, toplevel, tmp, profile = candidates.split(), toplevel.split(), tmp.split(), profile.split()
    foreign = [l.strip() for l in foreign.strip().splitlines() if l.strip()]
    alive = alive.split()
    ours = [t for t in tmp if any(word in t.lower() for word in ("yuzuno", "claude", "codex", "node", "npm"))]
    # Other processes of the account (its own jobs, its own Claude session) may
    # write in its home meanwhile; every entry is recorded raw. Here Core ran
    # no child and this run's Claude profile stayed empty, so nothing of the
    # run could have made a skill-sync round.
    claude_before = account_claude(foreign, alive)
    accepted = tolerated(candidates, claude_before if not spawned and not profile else [])
    unexplained = [c for c in candidates if c not in accepted]
    report["boundary"] = {"defaultFoldersChanged": candidates, "homeTopLevelChanged": toplevel,
                          "tmpNewEntries": tmp, "tmpEntriesNamedLikeOurs": ours, "runProfileEntries": profile,
                          "accountProcessesBefore": foreign, "stillRunning": alive,
                          "accountClaudeBeforeStillRunning": claude_before,
                          "attributedToTheAccountsOwnClaude": accepted}
    check("Nothing changed where Core, Claude, Node or Codex would write by default that this run could have "
          "caused (home config/cache/data, ~/.claude*, ~/.yuzuno*, ~/.codex, ~/.npm), and no such /tmp entry",
          stopped.returncode == 0 and not unexplained and not ours, report["boundary"])


def core_env(args, base, state=""):
    """The guide's start, with native CLI state kept under the run (or under
    its `state` subfolder: its own data folder and Claude profile)."""
    return f"""base={shlex.quote(base)}
S="$base"{'/' + state if state else ''}
ROOT="$base/core"; DATA="$S/core-data"; WORK="$base/work"
export PATH={args.node_bin}:{args.host_path}:/usr/local/bin:/usr/bin:/bin
export CLAUDE_CONFIG_DIR="$S/claude-config" TMPDIR="$S/tmp"
export XDG_CACHE_HOME="$S/xdg/cache" XDG_CONFIG_HOME="$S/xdg/config" XDG_DATA_HOME="$S/xdg/data" XDG_STATE_HOME="$S/xdg/state"
export DISABLE_AUTOUPDATER=1
"""


def start_core(args, base, label, state=""):
    py = args.host_python
    script = "set -eu\n" + core_env(args, base, state) + f"""RELEASE=$({py} -c "import json,sys; print(json.load(open(sys.argv[1]))['releaseId'])" "$ROOT/current.json")
setsid nohup "$ROOT/releases/$RELEASE/bin/yuzuno-workspace" --install-dir "$ROOT" \\
  --data-dir "$DATA" --port {args.remote_port} --cwd "$WORK" >>"$ROOT/core.log" 2>&1 </dev/null &
for i in $(seq 1 60); do
  if {py} -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:{args.remote_port}/api/health', timeout=2)" 2>/dev/null; then echo up; exit 0; fi
  sleep 0.5
done
echo "not up" >&2; tail -20 "$ROOT/core.log" >&2; exit 7
"""
    up = remote(f"core-start-{label}", args.target, script, timeout=120)
    check(f"Core starts on the host's loopback port with the guide's command ({label})",
          up.returncode == 0 and "up" in up.stdout, {"stderr": up.stderr[-400:]})


def stop_core(args, base, label, quiet=False):
    """Stops the run's Core with the guide's interrupt; `quiet` only records
    the attempt (a cleanup after a failure, which is what is reported)."""
    script = f"""set -eu
ROOT={shlex.quote(base)}/core
pkill -INT -f "$ROOT/releases/" || true
for i in $(seq 1 40); do pgrep -f "$ROOT/releases/" >/dev/null || {{ echo stopped; exit 0; }}; sleep 0.5; done
echo "still running" >&2; exit 6
"""
    down = remote(f"core-stop-{label}", args.target, script, timeout=60)
    if not quiet:
        check(f"Core stops on the guide's interrupt ({label})", down.returncode == 0 and "stopped" in down.stdout,
              {"stderr": down.stderr[-300:]})


def close(args, base, tunnel, ready, label):
    """Closes the tunnel and stops the run's Core, whatever the tunnel does: a
    checked stop once the stage went well, a best-effort one after a failure
    (from Core's start on), which then stays what is reported. A tunnel that
    does not close is recorded, and fails a stage that had gone well."""
    tunnel_error = None
    if tunnel:
        try:
            tunnel.terminate()
            tunnel.wait(timeout=10)
        except Exception as error:
            tunnel_error = repr(error)[:300]
            report["steps"].append({"name": f"tunnel-close-{label}", "error": tunnel_error})
            try:
                tunnel.kill()
                tunnel.wait(timeout=5)
            except Exception as again:
                report["steps"].append({"name": f"tunnel-kill-{label}", "error": repr(again)[:300]})
    if not ready:
        try:
            stop_core(args, base, f"{label}-cleanup", quiet=True)
        except Exception as error:
            report["steps"].append({"name": f"core-stop-{label}-cleanup", "error": repr(error)[:300]})
        return
    try:
        stop_core(args, base, label)
    finally:
        if tunnel_error:
            check(f"The tunnel to the host closes ({label})", False, {"error": tunnel_error}, kind="this computer")


def open_tunnel(args):
    return subprocess.Popen(SSH + ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-L",
                                   f"127.0.0.1:{args.local_port}:127.0.0.1:{args.remote_port}", args.target],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def wait_health(args):
    for _ in range(60):
        try:
            return json.loads(get(f"http://127.0.0.1:{args.local_port}/api/health")[1])
        except OSError:
            time.sleep(0.5)
    return None


def browser(args, lab, project, client, mode, kind):
    """Runs a published-UI client (a file next to this one) through the tunnel."""
    env = dict(PATH="/usr/local/bin:/usr/bin:/bin", HOME=str(Path.home()), LANG="C.UTF-8",
               T88_BASE=f"http://127.0.0.1:{args.local_port}", T88_LAB=str(lab), T88_PROJECT=project,
               YUZUNO_BROWSER_BIN=args.browser)
    with (lab / f"browser-{mode}.log").open("wb") as log:
        done = subprocess.run([args.node, str(HERE / client), mode], cwd=HERE, env=env,
                              stdout=log, stderr=subprocess.STDOUT, timeout=900)
    result = lab / f"browser-{mode}.json"
    report.setdefault("browser", {})[mode] = json.loads(result.read_text()) if result.exists() else None
    check(f"Browser {mode} through the tunnel (published UI)", done.returncode == 0,
          {"log": (lab / f"browser-{mode}.log").read_text(errors="replace")[-600:]}, kind=kind)


def first_use(args):
    """The first real conversation through the tunnel, in the run's own,
    freshly signed-in Claude profile (first → reopen → Core restart → restart)."""
    lab = Path(args.lab)
    assert lab.is_absolute() and not lab.exists(), "--lab must be a new absolute folder"
    lab.mkdir(parents=True, mode=0o700)
    q = shlex.quote
    found = remote("host-run", args.target, "set -eu\n" + existing_run(args.remote_allowed, args.remote_base, args.run) + """echo "$base"
test -s "$base/claude-config/.credentials.json" && echo signed-in || echo not-signed-in
ls -A "$base/claude-config" | wc -l
""")
    lines = found.stdout.split()
    base = lines[0] if found.returncode == 0 else None
    report["remote"] = {"target": args.target, "base": base}
    check("The installed run is there, inside the allowed folder", found.returncode == 0 and base, {"stderr": found.stderr[-300:]})
    # Only whether the profile holds a sign-in; nothing of it is read or copied.
    check("The run's own Claude profile is signed in (credentials file present; not read)",
          "signed-in" in lines, {"profileEntries": lines[-1] if lines else None}, kind="real host; the account owner signed in")
    project = f"{base}/work/project"
    prepared = remote("project-fixture", args.target, f"""set -eu
base={q(base)}
mkdir -p "$base/work/project/.claude"
printf '%s\\n' '{{"permissions":{{"ask":["Bash"]}}}}' > "$base/work/project/.claude/settings.local.json"
: > "$base/.first-use-started"
ps -u "$(id -u)" -o pid=,lstart=,args= | grep -E "(^|/| )(claude|node|codex)( |$)" | grep -v grep > "$base/.foreign-first-use" || true
""")
    check("A disposable project with a project-local permissions.ask=[Bash] fixture", prepared.returncode == 0,
          kind="fixture, not the account's own permissions")
    tunnel, ready = None, False
    try:
        start_core(args, base, "first")
        tunnel = open_tunnel(args)
        first = wait_health(args)
        check("Health through the tunnel", first and first.get("storageReady") is True, first)
        workspace = first["workspaceId"]
        report["workspaceId"] = workspace
        browser(args, lab, project, "first-use-client.mjs", "first", "real host via ssh -L; real model turn")
        browser(args, lab, project, "first-use-client.mjs", "reopen", "real host via ssh -L")
        stop_core(args, base, "restart")
        start_core(args, base, "restart")
        again = wait_health(args)
        check("After a Core restart the Workspace is the same", again and again.get("workspaceId") == workspace,
              {"before": workspace, "after": (again or {}).get("workspaceId")})
        browser(args, lab, project, "first-use-client.mjs", "restart", "real host via ssh -L")
        ready = True
    finally:
        close(args, base, tunnel, ready, "end")
    found = remote("boundary", args.target, f"""set -eu
base={q(base)}
{boundary_lines('"$base/.first-use-started"', args.remote_allowed)}echo "profile:"
ls -A "$base/claude-config" | head -30
echo "foreign:"
cat "$base/.foreign-first-use"
echo "alive:"
while read -r pid rest; do kill -0 "$pid" 2>/dev/null && echo "$pid"; done < "$base/.foreign-first-use"
""")
    out = found.stdout.split("candidates:")[-1]
    candidates, _, rest = out.partition("toplevel:")
    toplevel, _, rest = rest.partition("tmp:")
    tmp, _, rest = rest.partition("profile:")
    profile, _, rest = rest.partition("foreign:")
    foreign, _, alive = rest.partition("alive:")
    candidates, toplevel, tmp, profile, alive = candidates.split(), toplevel.split(), tmp.split(), profile.split(), alive.split()
    foreign = [l.strip() for l in foreign.strip().splitlines() if l.strip()]
    ours = [t for t in tmp if any(w in t.lower() for w in ("yuzuno", "claude", "codex", "node", "npm"))]
    # Core runs the run's own Claude here, so a skill-sync round it made in the
    # account's ~/.claude could not be told apart from the account's own: the
    # tolerated entries are recorded raw for that reason.
    claude_before = account_claude(foreign, alive)
    accepted = tolerated(candidates, claude_before)
    unexplained = [c for c in candidates if c not in accepted]
    report["boundary"] = {"defaultFoldersChanged": candidates, "homeTopLevelChanged": toplevel, "tmpNewEntries": tmp,
                          "runProfileEntries": profile, "accountProcessesBefore": foreign,
                          "accountClaudeBeforeStillRunning": claude_before, "toleratedSkillSync": accepted}
    check("Claude kept its state in the run's own profile, and nothing else changed where Core, Claude, Node or "
          "Codex would write by default (the account's own skill sync aside, recorded raw)",
          found.returncode == 0 and profile and not unexplained and not ours, report["boundary"])


def pre_login(args):
    """Before any sign-in: the installed run's Core with its own NEW empty
    Claude profile and data folder (<run>/prelogin), one harmless message from
    the published UI through the tunnel, then a Core restart and a new browser
    process. The run's claude-config, kept for the account owner's sign-in, is
    never used or touched. What the UI and Core say is recorded as observed."""
    lab = Path(args.lab)
    assert lab.is_absolute() and not lab.exists(), "--lab must be a new absolute folder"
    lab.mkdir(parents=True, mode=0o700)
    q = shlex.quote
    found = remote("host-run", args.target, "set -eu\n" + existing_run(args.remote_allowed, args.remote_base, args.run) + """test ! -e "$base/prelogin" || { echo "prelogin exists" >&2; exit 8; }
echo "$base"
ls -A "$base/claude-config" | wc -l
# Only whether such a variable is set for this shell; never its value.
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do eval "test -n \\"\\${$v:-}\\"" && echo "set:$v"; done
true
""")
    lines = found.stdout.split()
    base = lines[0] if found.returncode == 0 else None
    report["remote"] = {"target": args.target, "base": base}
    check("The installed run is there, inside the allowed folder, with no earlier pre-login state",
          found.returncode == 0 and base, {"stderr": found.stderr[-300:]})
    keys = [l[4:] for l in lines if l.startswith("set:")]
    check("No Claude key or token variable is set in the host's shell, so the run cannot sign in by other means",
          not keys, {"setVariables": keys})
    login_profile_entries = lines[1]
    project = f"{base}/work/prelogin-project"
    prepared = remote("prelogin-fixture", args.target, f"""set -eu
base={q(base)}
mkdir -p "$base/prelogin/claude-config" "$base/prelogin/tmp" "$base/prelogin/core-data" "$base/work/prelogin-project"
for d in cache config data state; do mkdir -p "$base/prelogin/xdg/$d"; done
: > "$base/prelogin/.started"
ps -u "$(id -u)" -o pid=,lstart=,args= | grep -E "(^|/| )(claude|node|codex)( |$)" | grep -v grep > "$base/prelogin/.foreign" || true
""")
    check("A new empty profile, data folder and project for the run's pre-login state", prepared.returncode == 0)
    tunnel, ready = None, False
    try:
        start_core(args, base, "prelogin", "prelogin")
        tunnel = open_tunnel(args)
        first = wait_health(args)
        check("Health through the tunnel", first and first.get("storageReady") is True, first)
        workspace = first["workspaceId"]
        report["workspaceId"] = workspace
        # The Core host's own check, as the Machines page runs it.
        status, body = post_json(f"http://127.0.0.1:{args.local_port}/api/machines/local/check")
        report["coreHostCheck"] = json.loads(body) if status == 200 else {"status": status, "body": body[:400].decode(errors="replace")}
        check("The Core host check runs before any sign-in (what it says is recorded)", status == 200,
              {"harnesses": report["coreHostCheck"].get("harnesses")}, kind="real host via ssh -L; observed")
        browser(args, lab, project, "pre-login-client.mjs", "prelogin", "real host via ssh -L")
        stop_core(args, base, "prelogin-restart")
        start_core(args, base, "prelogin-restart", "prelogin")
        again = wait_health(args)
        check("After a Core restart the Workspace is the same", again and again.get("workspaceId") == workspace,
              {"before": workspace, "after": (again or {}).get("workspaceId")})
        browser(args, lab, project, "pre-login-client.mjs", "prelogin-reopen", "real host via ssh -L")
        ready = True
    finally:
        close(args, base, tunnel, ready, "prelogin-end")
    found = remote("boundary", args.target, f"""set -eu
base={q(base)}
{boundary_lines('"$base/prelogin/.started"', args.remote_allowed)}echo "profile:"
(cd "$base/prelogin/claude-config" && find . -maxdepth 2 | head -40)
echo "credentials:"
test -e "$base/prelogin/claude-config/.credentials.json" && echo present || echo absent
echo "loginprofile:"
ls -A "$base/claude-config" | wc -l
echo "foreign:"
cat "$base/prelogin/.foreign"
echo "alive:"
while read -r pid rest; do kill -0 "$pid" 2>/dev/null && echo "$pid"; done < "$base/prelogin/.foreign"
""")
    out = found.stdout.split("candidates:")[-1]
    candidates, _, rest = out.partition("toplevel:")
    toplevel, _, rest = rest.partition("tmp:")
    tmp, _, rest = rest.partition("profile:")
    profile, _, rest = rest.partition("credentials:")
    credentials, _, rest = rest.partition("loginprofile:")
    login_after, _, rest = rest.partition("foreign:")
    foreign, _, alive = rest.partition("alive:")
    candidates, toplevel, tmp, profile, alive = candidates.split(), toplevel.split(), tmp.split(), profile.split(), alive.split()
    foreign = [l.strip() for l in foreign.strip().splitlines() if l.strip()]
    ours = [t for t in tmp if any(w in t.lower() for w in ("yuzuno", "claude", "codex", "node", "npm"))]
    # As in first-use: the run's own Claude runs here too, so a tolerated entry
    # is recorded raw rather than proven to be the account's own.
    claude_before = account_claude(foreign, alive)
    accepted = tolerated(candidates, claude_before)
    unexplained = [c for c in candidates if c not in accepted]
    report["boundary"] = {"defaultFoldersChanged": candidates, "homeTopLevelChanged": toplevel, "tmpNewEntries": tmp,
                          "preloginProfile": profile, "credentials": credentials.strip(),
                          "loginProfileEntries": [login_profile_entries, login_after.strip()],
                          "accountProcessesBefore": foreign, "accountClaudeBeforeStillRunning": claude_before,
                          "toleratedSkillSync": accepted}
    check("No sign-in appeared, the profile kept for the owner's sign-in is untouched, and nothing changed where "
          "Core, Claude, Node or Codex would write by default (the account's own skill sync aside, recorded raw)",
          found.returncode == 0 and credentials.strip() == "absent" and login_after.strip() == login_profile_entries
          and not unexplained and not ours, report["boundary"])


def post_json(url, body=None, timeout=60):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, data=json.dumps(body or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def parser():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=["install", "first-use", "pre-login"])
    p.add_argument("--target", required=True, help="the host's SSH alias (BatchMode, known host key)")
    p.add_argument("--remote-allowed", required=True, type=host_path, help="the only folder on the host this lab may write in")
    p.add_argument("--remote-base", required=True, type=host_path, help="where run folders are made, inside --remote-allowed")
    p.add_argument("--run", required=True, type=run_name, help="the run folder's name (new for install)")
    p.add_argument("--node-bin", required=True, type=host_path, help="the host's Node bin folder (the Claude runtime needs it)")
    p.add_argument("--host-path", default="$HOME/.local/bin", type=host_path,
                   help="more host folders put first on PATH, where its claude is (default: $HOME/.local/bin)")
    p.add_argument("--host-python", default="/usr/bin/python3", type=host_path, help="the host's python3 (default: /usr/bin/python3)")
    p.add_argument("--remote-port", type=int, required=True, help="Core's loopback port on the host")
    p.add_argument("--local-port", type=int, required=True, help="the tunnel's local port here")
    p.add_argument("--lab", required=True, help="a new absolute folder here for downloads, browser profiles and screenshots")
    p.add_argument("--report", required=True)
    p.add_argument("--tag", help="install: the published release tag")
    p.add_argument("--repository", default="YuzukiS/Yuzuno", help="install: the release's GitHub repository (the guide's)")
    p.add_argument("--asset", default="yuzuno-core-linux-x86_64", type=run_name,
                   help="install: the release asset's name, without extension")
    p.add_argument("--public-key", help="install: the publisher's minisign key")
    p.add_argument("--minisign", help="install: a pinned minisign binary to copy to the host")
    p.add_argument("--node", help="pre-login/first-use: Node here for the browser client")
    p.add_argument("--browser", help="pre-login/first-use: Chromium here for the browser client")
    return p


def main():
    args = parser().parse_args()
    report["stage"] = args.stage
    # What ran: this file and the clients next to it, by SHA-256.
    report["harness"] = {name: sha256(HERE / name) for name in
                         ("remote_host_lab.py", "first-use-client.mjs", "pre-login-client.mjs", "ui.mjs")}
    report["notCovered"] = [
        "A real native sign-in in a new profile (stage first-use needs the account owner's own interactive login first)",
        "An online update on the host (it needs no GitHub login for this lab; the guide's updates use gh there)",
        "A brand-new OS account, Core as a systemd service, linger (none is made or enabled by this lab)",
    ]
    try:
        if args.stage in ("first-use", "pre-login"):
            assert args.node and args.browser, f"{args.stage} needs --node and --browser"
            (first_use if args.stage == "first-use" else pre_login)(args)
        else:
            assert args.tag and args.public_key and args.minisign, "install needs --tag, --public-key and --minisign"
            install(args)
        report["passed"] = True
    except BaseException as error:
        report["passed"] = False
        report["error"] = repr(error)[:600]
        raise
    finally:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, indent=2))
        print(f"report {args.report}: passed={report.get('passed')}")


if __name__ == "__main__":
    main()
