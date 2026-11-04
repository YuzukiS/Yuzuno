#!/usr/bin/env python3
"""T-5: previews on the phone, end to end in Chromium, against a lab Core.

    lab.py --core BIN --web DIST --validator VALIDATOR --out NEW_DIR [--serve-ports 18444,18445]

The first Serve port is the phone entry's; the second is where an older
Core's phone previews had a Serve entry of their own, which this Core never
serves and removes.

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
0. Before Core starts, leaves what an older Core's phone previews left: their
   record (on, with their own Serve entry on the second Serve port to a
   loopback port nothing listens on) and that entry in the stand-in Serve.
1. Applies phone access from Core's own port (the T-185 API), on the first
   Serve port, with no previews choice (as an older page would): the older
   choice holds, and that Save and apply removes their entry alone.
2. Has the lab Agent write a Home section with one HTML attachment (PAGE)
   through its own MCP brief_update. The page tries to reach Core and the
   user's session in every way its policy should refuse, and says what
   happened; its own meta policy and base try to widen what it may do.
3. Starts serve_proxy.py, which plays Serve's HTTPS side for both Serve ports
   with the stand-in's owner login and a self-signed certificate for the
   node's name, and logs who sent each request.
4. Runs browser.mjs: Settings takes previews out and back in; a phone through
   the stand-in Serve opens the preview on the phone entry's own address;
   then the rest of the checks.
5. Makes raw requests through the stand-in Serve and on the local ports, and
   reads the stand-in Serve's log for the browser's own proof request.

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
<!-- A page's own policy can only narrow the one it is served with: this one tries to widen it, and to move its base. -->
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src *; worker-src * blob:">
<base href="__CORE__/api/">
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
  await trial("sessionStorage", () => sessionStorage.length);
  await trial("indexedDB", () => within(3000, new Promise((ok, no) => {
    const opening = indexedDB.open("t5");
    opening.onsuccess = () => ok("open");
    opening.onerror = () => no(opening.error);
  })));
  await trial("cookie", () => document.cookie);
  await trial("parent", () => parent.document.title);
  await trial("top", () => top.location.href);
  await trial("fetchCore", () => within(3000, fetch(core + "/api/workspace?probe=t5").then((r) => r.status)));
  await trial("fetchHere", () => within(3000, fetch("/api/workspace?probe=t5").then((r) => r.status)));
  await trial("fetchRelative", () => within(3000, fetch("../../../api/workspace?probe=t5").then((r) => r.status)));
  await trial("fetchFromBase", () => within(3000, fetch("workspace?probe=t5").then((r) => r.status)));
  await trial("baseApplied", () => {
    if (document.baseURI.includes("/api/")) return document.baseURI;
    throw new Error("ignored");
  });
  await trial("worker", () => within(3000, new Promise((ok, no) => {
    const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" })));
    worker.onmessage = () => ok("ran");
    worker.onerror = () => no(new Error("error"));
  })));
  await trial("serviceWorker", () => within(3000, navigator.serviceWorker.register("/sw.js?probe=t5").then(() => "registered")));
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
  // A form to Core: the sandbox drops it (no allow-forms); had it gone, this page would have left, and the stand-in Serve's log would show it.
  const form = document.createElement("form");
  form.method = "post";
  form.action = core + "/api/remote-access/apply?probe=t5";
  document.body.append(form);
  try {
    form.submit();
    results.form = "submitted";
  } catch (error) {
    results.form = "blocked: " + error.name;
  }
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

    def raw(self, port, path, headers, tls=False, method="GET"):
        """One request as given, on 127.0.0.1:port (through the stand-in Serve with tls): status, body, headers."""
        if tls:
            context = ssl.create_default_context()
            context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
            conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=10, context=context)
        else:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for name, value in headers:
            conn.putheader(name, value)
        conn.endheaders()
        answer = conn.getresponse()
        body = answer.read().decode(errors="replace")
        heads = {k.lower(): v for k, v in answer.getheaders()}
        conn.close()
        return answer.status, body, heads

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
        # What an older Core's phone previews left: on, with their own Serve
        # entry, to a loopback port nothing listens on now.
        self.legacy_local = free_port()
        self.legacy_record = {"format": 1,
            "desired": {"enabled": True, "servePort": self.serve_ports[1], "localPort": self.legacy_local, "savedAt": "2026-10-31T00:00:00Z"},
            "effective": {"listen": {"servePort": self.serve_ports[1], "localPort": self.legacy_local}, "appliedAt": "2026-10-31T00:00:00Z"},
            "owned": {"servePort": self.serve_ports[1], "host": DNS, "target": f"http://127.0.0.1:{self.legacy_local}"}, "operations": []}
        (self.out / "data/remote-preview.json").write_text(json.dumps(self.legacy_record))
        state = json.loads(self.state.read_text())
        state["serve"]["TCP"][str(self.serve_ports[1])] = {"HTTPS": True}
        state["serve"]["Web"][f"{DNS}:{self.serve_ports[1]}"] = {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{self.legacy_local}"}}}
        self.state.write_text(json.dumps(state))

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
        calls = (self.out / "bin/tailscale.exe.log")
        self.check("starting asked nothing of Serve", not calls.exists() or not any(l.startswith("serve --") for l in calls.read_text().splitlines()))
        self.check("the older phone previews' listener never starts again", is_free(self.legacy_local), self.legacy_local)
        view = self.local("GET", "/remote-access")
        self.check("their choice holds, and their entry is shown as left to remove",
                   view.get("previews", {}).get("included") is True and view["previews"].get("legacy", {}).get("servePort") == self.serve_ports[1],
                   view.get("previews"))

    def apply_phone(self):
        self.phone_local = free_port()
        # As an older page sends it: no previews choice.
        op = self.local("POST", "/remote-access/apply", {"requestId": "lab-phone", "enabled": True,
                                                         "servePort": self.serve_ports[0], "localPort": self.phone_local})["operation"]
        op = self.wait(lambda: (o := self.local("GET", f"/remote-access/operations/{op['id']}"))["state"] != "running" and o, "phone access")
        self.check("phone access applied from Core's port (stand-in Serve)", op["state"] == "succeeded", op)
        self.check("that Save and apply removed the older previews' own Serve entry, said apart", (op.get("legacy") or {}).get("state") == "removed", op)
        web = json.loads(self.state.read_text())["serve"]["Web"]
        self.check("Serve keeps the phone entry and someone else's, and nothing on the older previews' port",
                   sorted(web) == sorted([f"{DNS}:443", f"{DNS}:{self.serve_ports[0]}"]), sorted(web))
        record = json.loads((self.out / "data/remote-preview.json").read_text())
        moved = ("owned", "formerOwned", "disposition")
        self.check("their record is kept: their entry no longer held, kept as theirs before, with what became of it",
                   record["owned"] is None and record.get("formerOwned") == self.legacy_record["owned"]
                   and (record.get("disposition") or {}).get("state") == "removed"
                   and {k: v for k, v in record.items() if k not in moved} == {k: v for k, v in self.legacy_record.items() if k not in moved}, record)
        calls = (self.out / "bin/tailscale.exe.log").read_text().splitlines()
        self.check("Serve was never reset", not any("reset" in c for c in calls), calls)

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
        self.started = time.time()
        self.requests = self.out / "serve-requests.jsonl"
        self.proxy = subprocess.Popen([sys.executable, str(HERE / "serve_proxy.py"), "--state", str(self.state),
                                       "--cert", str(self.out / "bin/cert.pem"), "--key", str(self.out / "bin/key.pem"),
                                       "--ports", ",".join(map(str, self.serve_ports)), "--log", str(self.requests)],
                                      stdout=(self.out / "serve-proxy.log").open("ab"), stderr=subprocess.STDOUT, start_new_session=True)
        self.wait(lambda: self.requests.exists() and f'"listening": {self.serve_ports[0]}' in self.requests.read_text(), "the stand-in Serve")

    # ---- checks ---------------------------------------------------------------
    def browser(self):
        lab = {"page": f"http://127.0.0.1:{self.port}/", "corePort": self.port, "dns": DNS, "owner": OWNER,
               "phoneServePort": self.serve_ports[0], "legacyServePort": self.serve_ports[1],
               "projectId": self.project_id, "section": "prototype", "state": str(self.state), "requests": str(self.requests)}
        (self.out / "lab.json").write_text(json.dumps(lab, indent=1))
        env = {k: v for k, v in os.environ.items() if not k.startswith("YUZUNO_")}
        rc = subprocess.run(["node", str(HERE / "browser.mjs"), str(self.out / "lab.json"), str(self.out / "browser")], env=env).returncode
        result = json.loads((self.out / "browser/report.json").read_text()) if (self.out / "browser/report.json").exists() else {}
        self.report["browser"] = {"exit": rc, "checks": len(result.get("checks", [])), "failed": result.get("failed")}
        self.check("browser.mjs passed every step", rc == 0 and result.get("passed") is True, result.get("failed"))

    def raw_checks(self):
        phone = self.serve_ports[0]
        host = ("Host", f"{DNS}:{phone}")
        shell = '<div id="root">'
        # Yuzuno's own page and API through the phone entry: never framed.
        for path in ("/api/health", "/"):
            status, body, heads = self.raw(phone, path, [host], tls=True)
            self.check(f"through the stand-in Serve, {path} is Yuzuno's and refuses framing", status == 200 and heads.get("x-frame-options") == "DENY", (status, heads))
        # The reserved path: a refusal of its own for anything but a live snapshot, however it is written, never Yuzuno's page.
        token = "0" * 64
        for method, path in [("GET", f"/__yuzuno/preview/v/{token}"), ("HEAD", f"/__yuzuno/preview/v/{token}"), ("GET", "/__yuzuno/preview/v/"),
                             ("GET", f"/%5F%5Fyuzuno/preview/v/{token}"), ("GET", f"/x/../__yuzuno/preview/v/{token}"),
                             ("GET", f"/__YUZUNO/preview/v/{token}"), ("GET", "/__yuzuno/api/health"), ("GET", f"/__yuzuno/preview/proof/{token}")]:
            status, body, heads = self.raw(phone, path, [host], tls=True, method=method)
            ok = status in (404, 405) and shell not in body and heads.get("x-frame-options") == "DENY" and (method == "HEAD" or "Yuzuno preview" in body)
            self.check(f"{method} {path}: refused under the reserved path, never Yuzuno's page", ok, (status, body[:120]))
        status, body, _ = self.raw(self.phone_local, f"/__yuzuno/preview/v/{token}", [host, ("Tailscale-User-Login", "someone@else")])
        self.check("the phone entry refuses another login there", status == 403, (status, body[:120]))
        status, body, _ = self.raw(self.phone_local, f"/__yuzuno/preview/v/{token}", [host, ("Tailscale-User-Login", OWNER), ("Tailscale-Funnel-Request", "?1")])
        self.check("the phone entry refuses Funnel there", status == 403, (status, body[:120]))
        status, body, _ = self.raw(self.port, "/api/health", [("Host", f"127.0.0.1:{self.port}"), ("Tailscale-User-Login", OWNER)])
        self.check("Core's own port still refuses a proxied request", status == 403, (status, body[:120]))
        log = [json.loads(line) for line in self.requests.read_text().splitlines()]
        probes = [e for e in log if "probe=t5" in e.get("path", "")]
        self.check("no request of the previewed page's probes reached the stand-in Serve", probes == [], probes[:5])
        # The proof, as Chromium itself sent it from the phone page: never typed here. A browser's
        # request carries Sec-Fetch-*; browser.mjs's own asking again, with headers it set, does not.
        proofs = [e for e in log if e.get("method") == "POST" and e.get("path", "").startswith("/__yuzuno/preview/proof/")]
        sent = [{k: e.get(k) for k in ("status", "origin", "client", "fetchMode", "fetchSite", "referer")} for e in proofs]
        self.report["facts"]["proofRequests"] = sent
        browser, again = [e for e in sent if e["fetchMode"] is not None], [e for e in sent if e["fetchMode"] is None]
        self.check("the browser's own proof requests: POST from the phone page's origin, same-origin CORS, with the client header",
                   bool(browser) and all(e["origin"] == f"https://{DNS}:{phone}" and e["client"] == "desktop" and e["fetchMode"] == "cors"
                                         and e["fetchSite"] == "same-origin" for e in browser) and any(e["status"] == 200 for e in browser), browser)
        self.check("asked again with the same proof, by hand, it was refused", bool(again) and all(e["status"] == 404 for e in again), again)
        pages = [e for e in log if e.get("method") == "GET" and e.get("path", "").startswith("/__yuzuno/preview/v/")]
        self.report["facts"]["pageRequests"] = [{k: e.get(k) for k in ("status", "fetchDest", "fetchSite", "referer")} for e in pages]
        self.check("the older previews' port was never served again", not any(e.get("listening") == self.serve_ports[1] and e["at"] > self.started for e in log), self.serve_ports[1])

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
