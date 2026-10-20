"""Shared pieces of the remote Jobs acceptance labs (check.py, independent.py):
an isolated Core (the local_jobs_lab example) with its own data folder and
port, its HTTP and MCP clients, and the remote job helper as a module."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "core/src/jobs/remote_job.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("remote_job", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_for(read, accept, seconds=90):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(0.25)
    raise AssertionError("Expected state did not arrive: " + json.dumps(last)[:2000])


class Core:
    """An isolated acceptance Core: its own folder, port and PATH (whose
    `ssh` is the lab's wrapper), never the daily Core or its machines."""

    def __init__(self, lab, port, path_prefix):
        self.lab, self.port, self.path_prefix = Path(lab), int(port), Path(path_prefix)
        self.base = "http://127.0.0.1:" + str(self.port)
        self.process = None

    def start(self):
        log = (self.lab / "core.log").open("ab")
        env = dict(os.environ, PATH=f"{self.path_prefix}:/usr/bin:/bin")
        binary = os.environ.get("T108_LAB_BIN") or str(ROOT / "target/debug/examples/local_jobs_lab")
        self.process = subprocess.Popen([binary, str(self.lab), str(self.port)], stdout=log, stderr=log, env=env)
        log.close()
        for _ in range(100):
            if self.process.poll() is not None:
                raise AssertionError("Isolated Core exited: " + (self.lab / "core.log").read_text()[-2000:])
            try:
                self.request("/health")
                return
            except OSError:
                time.sleep(0.1)
        raise AssertionError("Isolated Core did not listen")

    def stop(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=15)
            self.process = None

    def request(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + "/api" + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)

    def refused(self, path, body):
        try:
            self.request(path, body)
        except urllib.error.HTTPError as error:
            return error.read().decode()
        raise AssertionError(f"{path} was accepted")

    def job(self, job_id):
        return self.request("/jobs/" + job_id)

    def status(self, job_id, *statuses, seconds=90):
        return wait_for(lambda: self.job(job_id), lambda j: j["status"] in statuses, seconds)

    def mails(self, job_id):
        messages = self.request("/collaboration/peer_read",
                                {"agentId": "lab-a", "priority": "normal", "limit": 200})["messages"]
        return [m for m in messages if (m.get("metadata") or {}).get("jobId") == job_id]

    def mcp(self):
        return MCP(self.lab)


class MCP:
    def __init__(self, lab):
        config = json.loads((Path(lab) / "connection.json").read_text())
        self.url = config["url"]
        self.headers = {**config["headers"], "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream"}
        self.seq = 0
        self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                "clientInfo": {"name": "remote-jobs-acceptance", "version": "1"}})
        self.rpc("notifications/initialized", None, notice=True)

    def rpc(self, method, params, notice=False):
        body = {"jsonrpc": "2.0", "method": method}
        if not notice:
            self.seq += 1
            body["id"] = self.seq
        if params is not None:
            body["params"] = params
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=self.headers)
        with urllib.request.urlopen(req, timeout=60) as response:
            session = response.headers.get("Mcp-Session-Id")
            if session:
                self.headers["Mcp-Session-Id"] = session
            if notice:
                return None
            if response.headers.get("Content-Type", "").startswith("text/event-stream"):
                while True:
                    line = response.readline().decode()
                    if line.startswith("data: "):
                        value = json.loads(line[6:])
                        if value.get("id") == self.seq:
                            break
                    if not line:
                        raise AssertionError("MCP stream ended before response")
            else:
                value = json.load(response)
        assert "error" not in value, value
        return value["result"]

    def call(self, tool, args, error=False):
        value = self.rpc("tools/call", {"name": tool, "arguments": args})
        if error:
            assert value.get("isError"), value
            return value["content"][0]["text"]
        assert not value.get("isError"), value
        return value["structuredContent"]
