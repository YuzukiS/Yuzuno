#!/usr/bin/env python3
"""YN-10: a 6.6 MB single-file page attached on Home opens, and runs to its
end, in the Portal: in Chromium, against a lab Core.

    lab.py --core BIN --web DIST --validator VALIDATOR --out NEW_DIR

It never touches the daily Core, its data or its port. It starts a Core on
a free loopback port (never 4317) with a new data folder, the scripted Codex
stand-in (acceptance/turn-cost/fake_codex.py) instead of a model, and none of
the caller's YUZUNO_* settings. VALIDATOR is
runtimes/result-validator/validator.mjs from the same commit as BIN.

The lab Agent writes a Home section whose one attachment is a synthetic
page of PAGE_BYTES bytes, the size of the page that would not open, through
its own MCP brief_update. browser.mjs then opens it from Home in English and
in Chinese (zh-Hans), 1440 and 390 px wide: each time the page's last script,
at the very end of the file, must have run, and a screenshot is taken.

Writes OUT/report.json and exits 0 only when every step passed. Covered:
Chromium on the Core host, through Core's own port. Not covered: the phone
entry (Core's Rust tests cover that route), Safari or an iPhone.
"""
import argparse, hashlib, json, os, signal, socket, sqlite3, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FAKE_CODEX = ROOT / "acceptance/turn-cost/fake_codex.py"
DAILY = 4317
PAGE_BYTES = 6_606_144


def synthetic_page(size):
    """A single-file page of exactly `size` bytes: text with characters of
    every UTF-8 length, and a script at its very end that says the whole page
    ran (as previews::synthetic_page in Core's tests)."""
    head = ('<!doctype html><meta charset="utf-8"><title>Large page</title>'
            '<style>#end{font:600 28px system-ui;color:#0a6}</style><p id="end">not run</p>\n').encode()
    tail = '\n<script>document.getElementById("end").textContent="ran to the end"</script>\n'.encode()
    line = "<p>Plain ASCII, é ü ß, 中文字, 🙂 and more filler.</p>\n".encode()
    lines = (size - len(head) - len(tail) - len(b"<!---->")) // len(line)
    page = head + line * lines
    page += b"<!--" + b"a" * (size - len(page) - len(b"<!---->") - len(tail)) + b"-->" + tail
    assert len(page) == size
    page.decode("utf-8")
    return page


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Lab:
    def __init__(self, args):
        self.a, self.out = args, Path(args.out).resolve()
        self.report = {"task": "YN-10", "checks": [], "facts": {}, "passed": False,
                       "scope": "Chromium on the Core host, Core's own port; no phone entry, Safari or iPhone"}
        self.core = None

    def check(self, name, ok, detail=None):
        self.report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok or detail is None else f": {detail}"), flush=True)
        if not ok:
            raise SystemExit(f"failed: {name}")

    def local(self, method, path, body=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/api{path}", method=method,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={"X-Yuzuno-Client": "desktop", "Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as r:
            text = r.read().decode()
            return json.loads(text) if text else {}

    def wait(self, test, what, seconds=60):
        end = time.time() + seconds
        while time.time() < end:
            value = test()
            if value:
                return value
            time.sleep(0.3)
        raise SystemExit(f"Timed out waiting for {what}")

    def preflight(self):
        if self.out.exists():
            raise SystemExit(f"{self.out} exists: use a new folder. Nothing was started")
        for name in ("core", "web", "validator"):
            if not Path(getattr(self.a, name)).exists():
                raise SystemExit(f"--{name} does not exist. Nothing was started")

    def setup(self):
        self.out.mkdir(parents=True)
        for sub in ("data", "task", "files", "browser"):
            (self.out / sub).mkdir()
        page = synthetic_page(PAGE_BYTES)
        (self.out / "files/large.html").write_bytes(page)
        self.report["facts"]["page"] = {"bytes": len(page), "sha256": hashlib.sha256(page).hexdigest()}

    def start_core(self):
        self.port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith("YUZUNO_")}
        env.update(YUZUNO_RESULT_VALIDATOR=str(Path(self.a.validator).resolve()), T9_TIMELINE=str(self.out / "task/timeline"))
        log = (self.out / "core.log").open("ab")
        self.core = subprocess.Popen([self.a.core, "--port", str(self.port), "--data-dir", str(self.out / "data"), "--web-dir", self.a.web,
                                      "--cwd", str(self.out / "task"), "--codex", str(FAKE_CODEX)],
                                     env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        def up():
            if self.core.poll() is not None:
                raise SystemExit("Core exited: " + (self.out / "core.log").read_text()[-1500:])
            try:
                return self.local("GET", "/health")
            except OSError:
                return None
        self.report["facts"]["health"] = self.wait(up, "Core to answer")
        self.check("the lab Core started on a port of its own", self.port != DAILY, self.port)

    def mcp(self, method, params):
        with sqlite3.connect(f"file:{self.out / 'data/workspace.sqlite'}?mode=ro", uri=True) as db:
            token = db.execute("SELECT value FROM workspace_meta WHERE key = ?", (f"collaboration.mcp.agent.{self.agent_id}",)).fetchone()[0]
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/mcp/{self.agent_id}", method="POST",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                     "Authorization": f"Bearer {token}", "MCP-Protocol-Version": "2025-03-26"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as r:
            text = r.read().decode()
        if text.startswith(("data:", "event:")):
            text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
        value = json.loads(text)
        if value.get("error") or value["result"].get("isError"):
            raise SystemExit(f"MCP {method}: {text[:600]}")
        return value["result"].get("structuredContent", value["result"])

    def seed(self):
        self.project_id = self.local("POST", "/projects", {"name": "Large previews"})["id"]
        self.agent_id = self.local("POST", "/agents", {"name": "Lab", "cwd": str(self.out / "task"), "harness": "codex",
                                                        "model": "bench-model", "projectId": self.project_id})["id"]
        self.wait(lambda: self.local("GET", f"/agents/{self.agent_id}")["agent"].get("connectionState") == "connected", "the Agent")
        # A Brief update belongs to a running Turn: one that waits on an approval, as the T-5 lab writes its own.
        self.local("POST", f"/agents/{self.agent_id}/messages", {"clientMessageId": str(uuid.uuid4()), "text": "run:2:0:1:0"})
        self.wait(lambda: self.local("GET", f"/agents/{self.agent_id}")["pending"], "the lab Turn's approval")
        brief = self.mcp("tools/call", {"name": "brief_get", "arguments": {}})
        body = {"root": "body", "elements": {
            "body": {"type": "BriefBody", "props": {}, "children": ["text", "files"]},
            "text": {"type": "Markdown", "props": {"text": "A synthetic 6.6 MB design preview, written by the lab Agent."}},
            "files": {"type": "Attachments", "props": {"items": [{"name": "large.html"}]}}}}
        update = self.mcp("tools/call", {"name": "brief_update", "arguments": {
            "requestId": "lab-seed", "expectedVersion": brief["version"], "changes": [
                {"op": "put", "key": "designs", "kind": "report", "title": "Design preview", "body": body,
                 "attachments": [{"name": "large.html", "path": str(self.out / "files/large.html")}]}]}})
        self.check("the lab Agent wrote a Home section with the 6.6 MB page attached", update.get("accepted") is True, update)
        section = next(s for s in self.mcp("tools/call", {"name": "brief_get", "arguments": {}})["sections"] if s["key"] == "designs")
        kept = section["attachments"][0]
        page = self.report["facts"]["page"]
        # brief_get shows a kept file's size, not its SHA-256: the preview's reply
        # (browser.mjs) is checked against the page's SHA-256 instead.
        self.check("Core kept it as a snapshot, all of it", kept.get("snapshot") is True and kept.get("size") == page["bytes"], kept)

    def browser(self):
        page = self.report["facts"]["page"]
        lab = {"page": f"http://127.0.0.1:{self.port}/", "projectId": self.project_id, "section": "designs",
               "pageBytes": page["bytes"], "pageSha256": page["sha256"]}
        (self.out / "lab.json").write_text(json.dumps(lab, indent=1))
        env = {k: v for k, v in os.environ.items() if not k.startswith("YUZUNO_")}
        if os.environ.get("YUZUNO_BROWSER_BIN"):
            env["YUZUNO_BROWSER_BIN"] = os.environ["YUZUNO_BROWSER_BIN"]
        rc = subprocess.run(["node", str(HERE / "browser.mjs"), str(self.out / "lab.json"), str(self.out / "browser")], env=env).returncode
        result = json.loads((self.out / "browser/report.json").read_text()) if (self.out / "browser/report.json").exists() else {}
        self.report["browser"] = {"exit": rc, "checks": len(result.get("checks", [])), "failed": result.get("failed")}
        self.check("browser.mjs passed every step", rc == 0 and result.get("passed") is True, result.get("failed"))

    def stop(self):
        if self.core and self.core.poll() is None:
            os.killpg(self.core.pid, signal.SIGTERM)
            try:
                self.core.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(self.core.pid, signal.SIGKILL)
                self.core.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    for name in ("core", "web", "validator", "out"):
        parser.add_argument(f"--{name}", required=True)
    lab = Lab(parser.parse_args())
    lab.preflight()
    lab.setup()
    code = 1
    try:
        lab.start_core()
        lab.seed()
        lab.browser()
        lab.report["passed"] = True
        code = 0
    except SystemExit as stop:
        lab.report["stopped"] = str(stop)
    finally:
        lab.stop()
        (lab.out / "report.json").write_text(json.dumps(lab.report, indent=1))
    sys.exit(code)


if __name__ == "__main__":
    main()
