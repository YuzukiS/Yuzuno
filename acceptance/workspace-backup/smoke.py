#!/usr/bin/env python3
"""T-192 smoke: back up, check and restore a Workspace with the real Core binary.

    smoke.py --core <yuzuno-workspace> --fixture <Workspace folder> --out <new dir>

The fixture is a synthetic Workspace no Core is using, as the Core test
`workspace_backup::tests::write_fixture_workspace` writes it (two Agents, an
MCP credential, image, attachment, review and Job files). Core runs with a
private HOME, a clean environment, `--codex /bin/false` and free loopback
ports (never 4317), so no real account, model or daily Core is involved.

Steps: --backup-to; --verify-backup; a copy with one changed byte is refused;
--restore-backup into a new folder; restoring over that Workspace is refused;
a Core started on the restored Workspace serves its identity and both Agents;
--backup-to is refused while a Core runs on the Workspace.
Writes <out>/report.json; exits 0 only when every step passed.
"""
import argparse, json, os, shutil, signal, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(port, path):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     headers={"host": f"127.0.0.1:{port}", "x-yuzuno-client": "desktop"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class Smoke:
    def __init__(self, core, fixture, out):
        self.core, self.fixture, self.out = core, fixture, out
        self.home = out / "home"
        self.home.mkdir(parents=True)
        self.env = {"HOME": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                    "XDG_CONFIG_HOME": str(self.home / ".config"), "XDG_DATA_HOME": str(self.home / ".local/share"),
                    "XDG_CACHE_HOME": str(self.home / ".cache")}
        self.steps, self.runs = [], 0

    def run(self, *args):
        result = subprocess.run([str(self.core), *map(str, args)], env=self.env, capture_output=True, text=True, timeout=600)
        return result.returncode, result.stdout, result.stderr

    def step(self, name, check):
        try:
            detail = check()
            self.steps.append({"step": name, "ok": True, "detail": detail})
            print(f"ok {name}: {detail}")
        except Exception as error:  # every step is reported, then the run fails
            self.steps.append({"step": name, "ok": False, "error": str(error)})
            print(f"FAIL {name}: {error}")

    def start(self, data):
        self.runs += 1
        port = free_port()
        log = open(self.out / f"core-{self.runs}.log", "w")
        process = subprocess.Popen([str(self.core), "--port", str(port), "--data-dir", str(data), "--web-dir",
                                    str(self.out / "no-web"), "--cwd", str(self.out), "--codex", "/bin/false"],
                                   env=self.env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(300):
            if process.poll() is not None:
                raise AssertionError(f"Core exited ({process.returncode}); see core-{self.runs}.log")
            try:
                if http(port, "/api/health")[0] == 200:
                    return process, port
            except OSError:
                pass
            time.sleep(0.1)
        self.stop(process)
        raise AssertionError("Core did not answer on its port")

    @staticmethod
    def stop(process):
        # Only the Core this smoke started, by its own process handle.
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True)
    s = Smoke(args.core.resolve(), args.fixture.resolve(), args.out.resolve())
    backup, restored = s.out / "backup", s.out / "restored"
    manifest = {}

    def make_backup():
        code, out, err = s.run("--data-dir", s.fixture, "--backup-to", backup)
        assert code == 0, err
        manifest.update(json.loads(out))
        (s.out / "backup-manifest.json").write_text(out)
        excluded = {e["path"] for e in manifest["excluded"]}
        assert manifest["database"]["agents"] == 2 and len(manifest["files"]) == 6, manifest
        assert "workspace.sqlite: workspace_meta collaboration.mcp.agent.*" in excluded, excluded
        assert b"synthetic-credential-" not in (backup / "workspace.sqlite").read_bytes()
        return f"{len(manifest['files'])} files, {manifest['database']['agents']} Agents, {len(excluded)} names left out"
    s.step("backup", make_backup)

    def verify():
        code, out, err = s.run("--verify-backup", backup)
        assert code == 0, err
        assert json.loads(out)["workspaceId"] == manifest["workspaceId"]
        return "every file and the database match the manifest"
    s.step("verify", verify)

    def damaged():
        broken = s.out / "broken"
        shutil.copytree(backup, broken)
        image = next((broken / "files" / "input-images").rglob("*.png"))
        data = bytearray(image.read_bytes())
        data[0] ^= 1
        image.write_bytes(bytes(data))
        code, _, err = s.run("--verify-backup", broken)
        assert code != 0 and "differs from its manifest entry" in err, (code, err)
        code, _, err = s.run("--restore-backup", broken, "--restore-to", s.out / "from-broken")
        assert code != 0 and not (s.out / "from-broken").exists(), (code, err)
        return "a changed byte is refused by verify and restore; nothing was restored"
    s.step("damaged copy refused", damaged)

    def restore():
        code, out, err = s.run("--restore-backup", backup, "--restore-to", restored)
        assert code == 0, err
        report = json.loads(out)
        (s.out / "restore-report.json").write_text(out)
        assert report["agents"] == 2 and report["workspaceId"] == manifest["workspaceId"], report
        assert not any(p.name.startswith(".restored.restoring-") for p in s.out.iterdir())
        return f"restored to {restored.name}: {report['agents']} Agents, {report['files']} files"
    s.step("restore", restore)

    def over_workspace():
        code, _, err = s.run("--restore-backup", backup, "--restore-to", restored)
        assert code != 0 and "holds a Workspace" in err, (code, err)
        return "refused; the restored Workspace was not touched"
    s.step("restore over a Workspace refused", over_workspace)

    def served():
        process, port = s.start(restored)
        try:
            code, text = http(port, "/api/workspace")
            assert code == 200, (code, text)
            workspace = json.loads(text)
            assert workspace["workspace"]["id"] == manifest["workspaceId"], workspace["workspace"]
            ids = sorted(a["id"] for a in workspace["agents"])
            assert ids == ["agent-a", "agent-b"], ids
            code, text = http(port, "/api/agents/agent-a")
            assert code == 200 and json.loads(text)["agent"]["id"] == "agent-a", (code, text[:200])
        finally:
            s.stop(process)
        return f"Core on the restored Workspace serves its identity and Agents {ids}"
    s.step("Core reads the restored Workspace", served)

    def while_running():
        process, _ = s.start(s.fixture)
        try:
            code, _, err = s.run("--data-dir", s.fixture, "--backup-to", s.out / "while-running")
            assert code != 0 and "Stop the Core using this Workspace" in err, (code, err)
            assert not (s.out / "while-running").exists()
        finally:
            s.stop(process)
        return "refused while a Core holds the Workspace; nothing was written"
    s.step("backup while Core runs refused", while_running)

    passed = sum(step["ok"] for step in s.steps)
    (s.out / "report.json").write_text(json.dumps({"steps": s.steps, "passed": passed, "failed": len(s.steps) - passed}, indent=2))
    sys.exit(0 if passed == len(s.steps) else 1)


if __name__ == "__main__":
    main()
