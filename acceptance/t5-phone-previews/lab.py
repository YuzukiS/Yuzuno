#!/usr/bin/env python3
"""T-5: previews on the phone, end to end in Chromium, against a lab Core.

    lab.py --core BIN --web DIST --validator VALIDATOR --out NEW_DIR [--serve-ports 18444,18445]

It never touches the daily Core, its data or a real Tailscale. It sets up:
- a Core on free loopback ports (never 4317) with a new data folder;
- Windows' tailscale.exe and curl.exe played by the T-185 stand-ins
  (acceptance/t185-remote-access);
- the scripted Codex stand-in (acceptance/turn-cost/fake_codex.py) instead of
  a model;
- Core started without the caller's YUZUNO_* settings, which name a daily
  release's helpers in a shell under it;
- VALIDATOR: runtimes/result-validator/validator.mjs from the same commit
  as BIN.

What it does:
1. Applies phone access from Core's own port (the T-185 API), on the first
   Serve port.
2. Has the lab Agent write a Home section with one HTML attachment (PAGE)
   through its own MCP brief_update. The page tries to reach Core and the
   user's session in every way its policy should refuse, and says what
   happened.
3. Starts serve_proxy.py, which plays Serve's HTTPS side for both Serve ports
   with the stand-in's owner login and a self-signed certificate for the
   node's name.
4. Runs browser.mjs: Settings turns previews on (second Serve port); a phone
   through the stand-in Serve opens the preview; then the rest of the checks.
5. Makes raw requests through the stand-in Serve and on the local ports.

It writes OUT/report.json and exits 0 only when every step passed. Covered:
Chromium on the Core host with a stand-in Serve. Not covered: a real Serve, a
real tailnet, Safari or an iPhone.
"""
import argparse, http.client, json, os, shutil, signal, socket, sqlite3, ssl, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
T185 = ROOT / "acceptance/t185-remote-access"
FAKE_CODEX = ROOT / "acceptance/turn-cost/fake_codex.py"
DNS, OWNER = "pc.tail0.ts.net", "owner@github"
DAILY = 4317
# The previewed page (synthetic): a working button, and every way it tries to
# reach Core or the user's session, with what happened. The phone entry's
# origin goes in place of __CORE__. Each probe's URL carries probe=t5, so the
# stand-in Serve's log shows any that got out.
PAGE = """<!doctype html>
<meta charset="utf-8">
<title>Lab prototype</title>
<button id="try" onclick="this.textContent='clicked'">Try</button>
<pre id="probes">running</pre>
<script>
const core = "__CORE__";
const results = { origin: self.origin };
async function trial(name, attempt) {
  try {
    results[name] = "allowed: " + String(await attempt()).slice(0, 80);
  } catch (error) {
    results[name] = "blocked: " + ((error && error.name) || String(error));
  }
}
const within = (ms, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
(async () => {
  await trial("localStorage", () => localStorage.length);
  await trial("cookie", () => document.cookie);
  await trial("parent", () => parent.document.title);
  await trial("top", () => top.location.href);
  await trial("fetchCore", () => within(3000, fetch(core + "/api/workspace?probe=t5").then((r) => r.status)));
  await trial("fetchHere", () => within(3000, fetch("/api/workspace?probe=t5").then((r) => r.status)));
  await trial("websocket", () => within(3000, new Promise((ok, no) => {
    const socket = new WebSocket(core.replace("https:", "wss:") + "/api/events?probe=t5");
    socket.onopen = () => ok("open");
    socket.onerror = () => no(new Error("error"));
  })));
  await trial("image", () => within(3000, new Promise((ok, no) => {
    const image = new Image();
    image.onload = () => ok("loaded");
    image.onerror = () => no(new Error("error"));
    image.src = core + "/api/health?probe=t5";
  })));
  await trial("popup", () => {
    const opened = window.open(core + "/?probe=t5");
    if (!opened) throw new Error("null");
    return "opened";
  });
  document.getElementById("probes").textContent = JSON.stringify(results);
  window.done = true;
})();
</script>
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def is_free(port):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


class Lab:
    def __init__(self, args):
        self.a, self.out = args, Path(args.out).resolve()
        self.report = {"task": "T-5", "checks": [], "facts": {}, "passed": False,
                       "scope": "Chromium on the Core host; Serve, Tailscale and Windows' curl are stand-ins; no real tailnet, Safari or iPhone"}
        self.core = self.proxy = None
        self.serve_ports = [int(p) for p in args.serve_ports.split(",")]

    def check(self, name, ok, detail=None):
        self.report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok or detail is None else f": {detail}"), flush=True)
        if not ok:
            raise SystemExit(f"failed: {name}")

    # ---- HTTP ---------------------------------------------------------------
    def local(self, method, path, body=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/api{path}", method=method,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={"X-Yuzuno-Client": "desktop", "Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as r:
            text = r.read().decode()
            return json.loads(text) if text else {}

    def raw(self, port, path, headers, tls=False):
        """One GET as given, on 127.0.0.1:port (through the stand-in Serve with tls)."""
        if tls:
            context = ssl.create_default_context()
            context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
            conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=10, context=context)
        else:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        for name, value in headers:
            conn.putheader(name, value)
        conn.endheaders()
        answer = conn.getresponse()
        body = answer.read().decode(errors="replace")
        conn.close()
        return answer.status, body

    def wait(self, test, what, seconds=60):
        end = time.time() + seconds
        while time.time() < end:
            value = test()
            if value:
                return value
            time.sleep(0.3)
        raise SystemExit(f"Timed out waiting for {what}")

    # ---- setup --------------------------------------------------------------
    def preflight(self):
        if self.out.exists():
            raise SystemExit(f"{self.out} exists: use a new folder. Nothing was started")
        for name in ("core", "web", "validator"):
            if not Path(getattr(self.a, name)).exists():
                raise SystemExit(f"--{name} does not exist. Nothing was started")
        for port in self.serve_ports:
            if port == DAILY or not is_free(port):
                raise SystemExit(f"Serve port {port} is not free on 127.0.0.1. Nothing was started")

    def setup(self):
        self.out.mkdir(parents=True)
        for sub in ("bin", "data", "task", "files", "browser"):
            (self.out / sub).mkdir()
        for src, name in (("fake_tailscale.py", "tailscale.exe"), ("fake_curl.py", "curl.exe")):
            shutil.copy(T185 / src, self.out / "bin" / name)
            (self.out / "bin" / name).chmod(0o755)
        self.state = self.out / "bin/tailscale.exe.json"
        self.state.write_text(json.dumps({"owner": OWNER,
            "status": {"BackendState": "Running", "Self": {"DNSName": DNS + ".", "UserID": 7},
                       "User": {"7": {"LoginName": OWNER}}, "CertDomains": [DNS]},
            # Someone else's service, never touched.
            "serve": {"TCP": {"443": {"HTTPS": True}}, "Web": {f"{DNS}:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8790"}}}}}}))
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", f"/CN={DNS}",
                        "-addext", f"subjectAltName=DNS:{DNS}", "-keyout", str(self.out / "bin/key.pem"),
                        "-out", str(self.out / "bin/cert.pem")], check=True, capture_output=True)
        phone = self.serve_ports[0]
        page = PAGE.replace("__CORE__", f"https://{DNS}:{phone}")
        (self.out / "files/proto.html").write_text(page)

    def start_core(self):
        self.port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith("YUZUNO_")}
        env.update(YUZUNO_TAILSCALE_CLI=str(self.out / "bin/tailscale.exe"), YUZUNO_REMOTE_ACCESS_CURL=str(self.out / "bin/curl.exe"),
                   YUZUNO_RESULT_VALIDATOR=str(Path(self.a.validator).resolve()), T9_TIMELINE=str(self.out / "task/timeline"))
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
        self.check("the lab Core started on its own port", self.port != DAILY)

    def apply_phone(self):
        self.phone_local = free_port()
        op = self.local("POST", "/remote-access/apply", {"requestId": "lab-phone", "enabled": True,
                                                         "servePort": self.serve_ports[0], "localPort": self.phone_local})["operation"]
        op = self.wait(lambda: (o := self.local("GET", f"/remote-access/operations/{op['id']}"))["state"] != "running" and o, "phone access")
        self.check("phone access applied from Core's port (stand-in Serve)", op["state"] == "succeeded", op)

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
        self.project_id = self.local("POST", "/projects", {"name": "Phone previews"})["id"]
        self.agent_id = self.local("POST", "/agents", {"name": "Lab", "cwd": str(self.out / "task"), "harness": "codex",
                                                        "model": "bench-model", "projectId": self.project_id})["id"]
        self.wait(lambda: self.local("GET", f"/agents/{self.agent_id}")["agent"].get("connectionState") == "connected", "the Agent")
        # A Brief update belongs to a running Turn: one that waits on an approval, as the T-170 lab writes its own.
        self.local("POST", f"/agents/{self.agent_id}/messages", {"clientMessageId": str(uuid.uuid4()), "text": "run:2:0:1:0"})
        self.wait(lambda: self.local("GET", f"/agents/{self.agent_id}")["pending"], "the lab Turn's approval")
        brief = self.mcp("tools/call", {"name": "brief_get", "arguments": {}})
        body = {"root": "body", "elements": {
            "body": {"type": "BriefBody", "props": {}, "children": ["text", "files"]},
            "text": {"type": "Markdown", "props": {"text": "A synthetic prototype, written by the lab Agent."}},
            "files": {"type": "Attachments", "props": {"items": [{"name": "proto.html"}]}}}}
        update = self.mcp("tools/call", {"name": "brief_update", "arguments": {
            "requestId": "lab-seed", "expectedVersion": brief["version"], "changes": [
                {"op": "put", "key": "prototype", "kind": "report", "title": "Prototype", "body": body,
                 "attachments": [{"name": "proto.html", "path": str(self.out / "files/proto.html")}]}]}})
        self.check("the lab Agent wrote a Home section with an HTML attachment", update.get("accepted") is True, update)

    def start_proxy(self):
        self.requests = self.out / "serve-requests.jsonl"
        self.proxy = subprocess.Popen([sys.executable, str(HERE / "serve_proxy.py"), "--state", str(self.state),
                                       "--cert", str(self.out / "bin/cert.pem"), "--key", str(self.out / "bin/key.pem"),
                                       "--ports", ",".join(map(str, self.serve_ports)), "--log", str(self.requests)],
                                      stdout=(self.out / "serve-proxy.log").open("ab"), stderr=subprocess.STDOUT, start_new_session=True)
        self.wait(lambda: self.requests.exists() and f'"listening": {self.serve_ports[0]}' in self.requests.read_text(), "the stand-in Serve")

    # ---- checks ---------------------------------------------------------------
    def browser(self):
        self.preview_local = free_port()
        lab = {"page": f"http://127.0.0.1:{self.port}/", "corePort": self.port, "dns": DNS, "owner": OWNER,
               "phoneServePort": self.serve_ports[0], "previewServePort": self.serve_ports[1], "previewLocalPort": self.preview_local,
               "projectId": self.project_id, "section": "prototype", "state": str(self.state), "requests": str(self.requests)}
        (self.out / "lab.json").write_text(json.dumps(lab, indent=1))
        env = {k: v for k, v in os.environ.items() if not k.startswith("YUZUNO_")}
        rc = subprocess.run(["node", str(HERE / "browser.mjs"), str(self.out / "lab.json"), str(self.out / "browser")], env=env).returncode
        result = json.loads((self.out / "browser/report.json").read_text()) if (self.out / "browser/report.json").exists() else {}
        self.report["browser"] = {"exit": rc, "checks": len(result.get("checks", [])), "failed": result.get("failed")}
        self.check("browser.mjs passed every step", rc == 0 and result.get("passed") is True, result.get("failed"))

    def raw_checks(self):
        previews, phone = self.serve_ports[1], self.serve_ports[0]
        # browser.mjs left previews on again for these.
        host = ("Host", f"{DNS}:{previews}")
        status, body = self.raw(previews, "/api/workspace", [host], tls=True)
        self.check("through the stand-in Serve, the previews' entry serves no Core API", status == 404 and "Yuzuno preview" in body, (status, body[:120]))
        status, body = self.raw(previews, "/", [("Host", f"{DNS}:{phone}")], tls=True)
        self.check("the previews' entry refuses the phone entry's name", status == 421, (status, body[:120]))
        status, body = self.raw(self.preview_local, "/", [host, ("Tailscale-User-Login", "someone@else")])
        self.check("the previews' listener refuses another login", status == 403, (status, body[:120]))
        status, body = self.raw(self.preview_local, "/", [host, ("Tailscale-User-Login", OWNER), ("Tailscale-Funnel-Request", "?1")])
        self.check("the previews' listener refuses Funnel", status == 403, (status, body[:120]))
        status, body = self.raw(self.port, "/api/health", [("Host", f"127.0.0.1:{self.port}"), ("Tailscale-User-Login", OWNER)])
        self.check("Core's own port still refuses a proxied request", status == 403, (status, body[:120]))
        log = [json.loads(line) for line in self.requests.read_text().splitlines()]
        probes = [e for e in log if "probe=t5" in e.get("path", "")]
        self.check("no request of the previewed page's probes reached the stand-in Serve", probes == [], probes[:5])
        on_previews = sorted({e["path"].split("?")[0].rsplit("/", 1)[0] for e in log if e.get("port") == previews and "path" in e})
        self.report["facts"]["previewPaths"] = on_previews

    def stop(self):
        for process in (self.proxy, self.core):
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    for name in ("core", "web", "validator", "out"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--serve-ports", default="18444,18445")
    lab = Lab(parser.parse_args())
    lab.preflight()
    lab.setup()
    code = 1
    try:
        lab.start_core()
        lab.apply_phone()
        lab.seed()
        lab.start_proxy()
        lab.browser()
        lab.raw_checks()
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
