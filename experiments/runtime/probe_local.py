#!/usr/bin/env python3
"""Credential-free probes against real, installed Harness processes.

All writes stay in a freshly created temporary directory. This never reads,
copies, logs in, logs out, starts, or stops an existing user Harness instance.
Only explicit environment allowlists are passed to subprocesses.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import tempfile
import threading
import time


def clean_environment() -> dict[str, str]:
    # Preserve executable discovery and OS identity, never provider credentials.
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM"}
    return {key: value for key, value in os.environ.items() if key in allowed}


def run(argv: list[str], env: dict[str, str], timeout: float = 15) -> dict:
    try:
        result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=timeout)
        return {"exitCode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except (subprocess.TimeoutExpired, FileNotFoundError) as error:
        return {"error": type(error).__name__, "detail": str(error)}


class Rpc:
    def __init__(self, profile: Path, marker: str):
        self.env = clean_environment()
        self.env.update(CODEX_HOME=str(profile), YUZUNO_RUNTIME_PROBE=marker)
        self.process = subprocess.Popen(
            ["codex", "app-server", "--stdio"], env=self.env, cwd=profile.parent,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, start_new_session=True,
        )
        self.messages: queue.Queue = queue.Queue()
        self.events: list[dict] = []
        self.errors: list[str] = []
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_errors, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                self.messages.put({"invalidJson": True})

    def _read_errors(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip())

    def send(self, value: dict):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def call(self, method: str, params: dict, timeout: float = 10) -> dict:
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                response = self.messages.get(timeout=min(0.2, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                if self.process.poll() is not None:
                    return {"processExited": self.process.returncode}
                continue
            if response.get("id") == request_id:
                return response
            self.events.append(response)
        return {"timeout": method}

    def initialize(self):
        response = self.call("initialize", {
            "clientInfo": {"name": "yuzuno_runtime_probe", "title": "Yuzuno runtime probe", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True},
        })
        self.send({"method": "initialized"})
        return response

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)


def socket_probe(root: Path) -> dict:
    report = {}
    for name, family, address in [
        ("unix", socket.AF_UNIX, str(root / "test.sock")),
        ("tcp", socket.AF_INET, ("127.0.0.1", 0)),
    ]:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as connection:
                connection.bind(address)
            report[name] = {"available": True}
        except OSError as error:
            report[name] = {"available": False, "errno": error.errno, "error": str(error)}
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="Optional sanitized JSON result path")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="yuzuno-runtime-"))
    report = {"root": str(root), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sockets": socket_probe(root)}
    report["codexVersion"] = run(["codex", "--version"], clean_environment())
    profiles = [root / "a", root / "b"]
    clients = []
    try:
        for profile in profiles:
            profile.mkdir(mode=0o700)
            (profile / "config.toml").write_text('cli_auth_credentials_store = "file"\n')
            client = Rpc(profile, f"profile-{profile.name}")
            clients.append(client)
            profile_report = {"initialize": client.initialize()}
            # False is deliberate: do not refresh authentication, even in empty profiles.
            profile_report["accountRead"] = client.call("account/read", {"refreshToken": False})
            account_result = profile_report["accountRead"].get("result", {})
            if account_result.get("account") is not None:
                account_result["account"] = {"redacted": True}
                raise RuntimeError("Refusing test: expected fresh unauthenticated profile")
            profile_report["daemonVersion"] = run(["codex", "app-server", "daemon", "version"], client.env)
            # externalSandbox means keep the outer execution sandbox, with no nested helper.
            # The sole command prints this test's harmless environment marker.
            profile_report["environmentMarker"] = client.call("command/exec", {
                "command": ["/usr/bin/printenv", "YUZUNO_RUNTIME_PROBE"], "cwd": str(root),
                "sandboxPolicy": {"type": "externalSandbox", "networkAccess": "restricted"}, "timeoutMs": 2000,
            }, timeout=5)
            profile_report["threadStart"] = client.call("thread/start", {
                "cwd": str(root), "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": False,
            }, timeout=10)
            report[profile.name] = profile_report
            print(f"Completed Codex profile {profile.name}", flush=True)

        # Read another profile's fresh thread. No model turn is sent, and no account is used.
        thread_a = report["a"]["threadStart"].get("result", {}).get("thread", {}).get("id")
        if thread_a:
            report["crossProfileRead"] = clients[1].call("thread/read", {"threadId": thread_a, "includeTurns": True})
            report["sameProfileRead"] = clients[0].call("thread/read", {"threadId": thread_a, "includeTurns": True})
        report["claudeVersion"] = run(["claude", "--version"], clean_environment())
        for name in ("claude-a", "claude-b"):
            profile = root / name
            profile.mkdir(mode=0o700)
            env = clean_environment()
            env.update(CLAUDE_CONFIG_DIR=str(profile), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
            result = run(["claude", "auth", "status", "--json"], env)
            try:
                raw = json.loads(result.get("stdout", ""))
                # Intentionally discard any personal account metadata.
                result["stdout"] = {k: raw[k] for k in ("loggedIn", "authMethod", "apiProvider") if k in raw}
            except json.JSONDecodeError:
                result["stdout"] = "[non-JSON output omitted]"
            report[name] = result
    finally:
        for client in clients:
            client.close()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
