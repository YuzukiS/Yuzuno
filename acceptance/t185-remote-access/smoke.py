#!/usr/bin/env python3
"""T-185 smoke: phone access from Settings with the real Core binary.

    smoke.py --core <yuzuno-workspace> --out <new dir>

Copies fake_tailscale.py and fake_curl.py into <out>/bin as tailscale.exe and
curl.exe and starts Core with YUZUNO_TAILSCALE_CLI / YUZUNO_REMOTE_ACCESS_CURL
pointing at them, a fresh data folder and free loopback ports (never 4317, the
daily Core or a real Serve). Needs a WSL host, as the feature does.

Steps: apply from Core's port; the entry admits the owner and refuses others;
Core stops and a new Core serves the applied entry; disable removes only its
Serve entry; a Core started with YUZUNO_REMOTE_* afterwards keeps it off.
Writes <out>/report.json; exits 0 only when every step passed.
"""
import argparse, json, os, shutil, signal, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DNS, OWNER = "pc.tail0.ts.net", "owner@github"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(port, path, method="GET", body=None, headers=None):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(), headers=headers or {})
    if body is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def refused(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return False
    except OSError:
        return True


class Lab:
    def __init__(self, core, out):
        self.core, self.out = core, out
        self.bin, self.data, self.web = out / "bin", out / "data", out / "web"
        for d in (self.bin, self.data, self.web):
            d.mkdir(parents=True)
        for src, name in (("fake_tailscale.py", "tailscale.exe"), ("fake_curl.py", "curl.exe")):
            shutil.copy(HERE / src, self.bin / name)
            (self.bin / name).chmod(0o755)
        self.state = self.bin / "tailscale.exe.json"
        self.state.write_text(json.dumps({"owner": OWNER,
            "status": {"BackendState": "Running", "Self": {"DNSName": DNS + ".", "UserID": 7},
                       "User": {"7": {"LoginName": OWNER}}, "CertDomains": [DNS]},
            "serve": {"TCP": {"443": {"HTTPS": True}}, "Web": {f"{DNS}:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8790"}}}}}}))
        self.port = free_port()
        self.process, self.runs, self.steps = None, 0, []

    def start(self, extra=None):
        env = {"HOME": os.environ.get("HOME", "/tmp"), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
               "YUZUNO_TAILSCALE_CLI": str(self.bin / "tailscale.exe"), "YUZUNO_REMOTE_ACCESS_CURL": str(self.bin / "curl.exe")}
        env.update(extra or {})
        self.runs += 1
        log = open(self.out / f"core-{self.runs}.log", "w")
        self.process = subprocess.Popen([self.core, "--port", str(self.port), "--data-dir", str(self.data), "--web-dir", str(self.web)],
                                        env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(200):
            if self.process.poll() is not None:
                raise SystemExit(f"Core exited ({self.process.returncode}); see core-{self.runs}.log")
            try:
                if http(self.port, "/api/health", headers={"host": f"127.0.0.1:{self.port}"})[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise SystemExit("Core did not answer on its port")

    def stop(self):
        # Only the Core this smoke started, by its own process handle.
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process = None

    def local(self, path, method="GET", body=None):
        headers = {"host": f"127.0.0.1:{self.port}", "x-yuzuno-client": "desktop"}
        code, text = http(self.port, path, method, body, headers)
        return code, (json.loads(text) if text.startswith(("{", "[")) else text)

    def apply(self, body):
        code, answer = self.local("/api/remote-access/apply", "POST", body)
        assert code == 200, (code, answer)
        op = answer["operation"]
        for _ in range(600):
            code, op = self.local(f"/api/remote-access/operations/{op['id']}")
            if op["state"] != "running":
                return op
            time.sleep(0.1)
        raise AssertionError("operation did not finish")

    def fake(self):
        return json.loads(self.state.read_text())

    def step(self, name, ok, detail):
        self.steps.append({"step": name, "ok": bool(ok), "detail": detail})
        print(("ok  " if ok else "FAIL") + f" {name}: {detail}", flush=True)
        if not ok:
            raise AssertionError(name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    lab = Lab(args.core, out)
    remote, other = free_port(), free_port()
    origin, host = f"https://{DNS}:8444", f"{DNS}:8444"
    try:
        lab.start()
        code, view = lab.local("/api/remote-access")
        lab.step("1 supported host", code == 200 and view["support"]["state"] == "supported" and view["listening"] is None,
                 json.dumps(view["support"]))
        op = lab.apply({"requestId": "smoke-on", "enabled": True, "localPort": remote})
        lab.step("2 apply", op["state"] == "succeeded" and op.get("url") == origin, json.dumps(op))
        allowed = http(remote, "/api/health", headers={"host": host, "tailscale-user-login": OWNER})[0]
        anonymous = http(remote, "/api/health", headers={"host": host})[0]
        stranger = http(remote, "/api/health", headers={"host": host, "tailscale-user-login": "someone@else"})[0]
        lab.step("3 entry admits only the owner", (allowed, anonymous, stranger) == (200, 403, 403), f"{allowed}/{anonymous}/{stranger}")
        serve = lab.fake()["serve"]
        lab.step("4 Serve entry added, others kept",
                 serve["Web"].get(host) == {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{remote}"}}} and f"{DNS}:443" in serve["Web"],
                 json.dumps(serve))
        lab.stop()
        lab.start()
        code, view = lab.local("/api/remote-access")
        listening = view["listening"] or {}
        allowed = http(remote, "/api/health", headers={"host": host, "tailscale-user-login": OWNER})[0]
        lab.step("5 a new Core serves the applied entry",
                 listening.get("source") == "settings" and listening.get("port") == remote and allowed == 200 and view["url"] == origin,
                 json.dumps({"listening": listening, "url": view["url"], "health": allowed}))
        op = lab.apply({"requestId": "smoke-off", "enabled": False})
        serve = lab.fake()["serve"]
        lab.step("6 disable removes only its entry", op["state"] == "succeeded" and refused(remote) and host not in serve["Web"]
                 and f"{DNS}:443" in serve["Web"], json.dumps({"op": op["state"], "serve": serve}))
        lab.stop()
        lab.start({"YUZUNO_REMOTE_PORT": str(other), "YUZUNO_REMOTE_ORIGIN": origin, "YUZUNO_REMOTE_LOGIN": OWNER})
        code, view = lab.local("/api/remote-access")
        lab.step("7 off from Settings stays off over YUZUNO_REMOTE_*", view["listening"] is None and refused(other)
                 and (view["environment"] or {}).get("ignored") is True, json.dumps({"listening": view["listening"], "environment": view["environment"]}))
    except (AssertionError, SystemExit, OSError) as error:
        lab.steps.append({"step": "stopped", "ok": False, "detail": str(error)})
    finally:
        lab.stop()
        calls = (lab.bin / "tailscale.exe.log").read_text().splitlines() if (lab.bin / "tailscale.exe.log").exists() else []
        report = {"steps": lab.steps, "tailscaleCalls": calls, "passed": all(s["ok"] for s in lab.steps) and len(lab.steps) == 7}
        (out / "report.json").write_text(json.dumps(report, indent=1))
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
