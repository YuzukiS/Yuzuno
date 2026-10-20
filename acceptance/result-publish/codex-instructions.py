#!/usr/bin/env python3
"""T-37: how the installed Codex app-server treats thread developerInstructions.

  python3 acceptance/result-publish/codex-instructions.py

Runs its own `codex app-server` (no Yuzuno Core) in a lab folder. A user's
configured developer_instructions is simulated with `-c` (the sessionFlags
layer) and project rules with an AGENTS.md in that folder; nothing in
~/.codex is written. Each case asks the model which code words its
instructions contain, and resumed threads' rollout files are read to count
the developer messages actually recorded.
"""
import json
import os
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE / "lab/instructions-work"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
USER = "Developer code word: KIWI."
NOTICE = "Developer code word: MANGO."
QUESTION = ("Without using any tool: list every code word stated anywhere in your instructions (system, developer, "
            "project or user), each with the number of separate times it is stated. Answer as JSON "
            '{"WORD": count}, nothing else.')


class Server:
    def __init__(self):
        env = {**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}"}
        self.child = subprocess.Popen(
            [str(NODE_BIN / "codex"), "app-server", "-c", f'developer_instructions="{USER}"'],
            cwd=WORK, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.next = 0
        self.request("initialize", {"clientInfo": {"name": "yuzuno_t37_probe", "title": "T-37 probe", "version": "0"},
                                    "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def send(self, message):
        self.child.stdin.write(json.dumps(message) + "\n")
        self.child.stdin.flush()

    def read(self):
        line = self.child.stdout.readline()
        if not line:
            raise RuntimeError("app-server exited")
        return json.loads(line)

    def request(self, method, params):
        self.next += 1
        self.send({"id": self.next, "method": method, "params": params})
        while True:
            message = self.read()
            if message.get("id") == self.next and "method" not in message:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message["result"]
            if "method" in message and "id" in message:
                # Approvals are never expected (read-only, never ask); decline.
                self.send({"id": message["id"], "result": {"decision": "decline"}})

    def ask(self, thread):
        self.request("turn/start", {"threadId": thread, "input": [{"type": "text", "text": QUESTION}],
                                    "effort": "low"})
        text = []
        deadline = time.time() + 240
        while time.time() < deadline:
            message = self.read()
            if message.get("method") == "item/completed" and message["params"]["item"].get("type") == "agentMessage":
                text.append(message["params"]["item"].get("text", ""))
            if message.get("method") == "turn/completed":
                return "\n".join(text).strip()
        raise RuntimeError("turn timed out")

    def close(self):
        self.child.stdin.close()
        self.child.terminate()
        self.child.wait(10)


def start(server, developer=None, ephemeral=True):
    params = {"cwd": str(WORK), "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": ephemeral,
              "config": {"model_reasoning_effort": "low"}}
    if developer is not None:
        params["developerInstructions"] = developer
    return server.request("thread/start", params)["thread"]


def developer_messages(path):
    """Developer-role messages recorded in a thread's rollout, by code word."""
    counts = {}
    for line in Path(path).read_text().splitlines():
        record = json.loads(line)
        payload = record.get("payload") or {}
        if payload.get("type") == "message" and payload.get("role") == "developer":
            text = json.dumps(payload.get("content"))
            for word in ("KIWI", "MANGO", "PAPAYA"):
                counts[word] = counts.get(word, 0) + text.count(word)
    return counts


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "AGENTS.md").write_text("Project code word: PAPAYA.\n")
    results = {}
    server = Server()
    effective = server.request("config/read", {"cwd": str(WORK), "includeLayers": False})
    results["configRead"] = {"developer_instructions": effective["config"].get("developer_instructions"),
                             "origin": effective["origins"].get("developer_instructions")}
    results["none"] = server.ask(start(server)["id"])
    results["noticeOnly"] = server.ask(start(server, NOTICE)["id"])
    composed = f"{USER}\n\n{NOTICE}"
    thread = start(server, composed, ephemeral=False)
    results["composed"] = server.ask(thread["id"])
    path = thread.get("path")
    results["rolloutAfterStart"] = developer_messages(path) if path else "no path"
    server.close()
    # A later Core: resume without, then with, developerInstructions.
    for label, developer in (("resumeWithout", None), ("resumeWithComposed", composed)):
        server = Server()
        params = {"threadId": thread["id"], "cwd": str(WORK), "approvalPolicy": "never", "sandbox": "read-only"}
        if developer is not None:
            params["developerInstructions"] = developer
        server.request("thread/resume", params)
        results[label] = server.ask(thread["id"])
        results[f"rolloutAfter{label[0].upper()}{label[1:]}"] = developer_messages(path) if path else "no path"
        server.close()
    results["thread"] = {"id": thread["id"], "path": path}
    out = HERE / "evidence/codex-instructions.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
