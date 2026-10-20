#!/usr/bin/env python3
"""Dedicated T-4 source session, held by another Codex client.

Creates a new, throwaway Codex session in the user's existing profile (never an
existing one), completes two tiny read-only turns, then keeps this app-server
alive so it owns the session's native writer, exactly like an idle shared
daemon. The lab Core then sees `already has an active writer`.

  holder.py start STATE_DIR TASK_DIR   # foreground; exits when STATE_DIR/stop exists
  holder.py hold STATE_DIR TASK_DIR    # hold the session `start` created, again
No credentials are read or copied; no other session is resumed.
"""
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path


class AppServer:
    def __init__(self, cwd: Path):
        self.process = subprocess.Popen(["codex", "app-server"], cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.messages: queue.Queue = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def send(self, value: dict):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def call(self, method: str, params: dict, timeout: float = 60) -> dict:
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        return self.wait(lambda m: m.get("id") == request_id and "method" not in m, timeout)

    def wait(self, match, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=0.2)
            except queue.Empty:
                continue
            if "id" in message and "method" in message:
                # This read-only source never authorizes anything.
                self.send({"id": message["id"], "error": {"code": -32601, "message": "holder declines requests"}})
                continue
            if match(message):
                return message
        raise TimeoutError("app-server did not answer in time")


def main():
    state_dir, task_dir = Path(sys.argv[2]), Path(sys.argv[3])
    state_dir.mkdir(parents=True, exist_ok=True)
    task_dir.mkdir(parents=True, exist_ok=True)
    server = AppServer(task_dir)
    server.call("initialize", {"clientInfo": {"name": "yuzuno_t4_holder", "title": "T-4 fork acceptance holder", "version": "0.1.0"}})
    server.send({"method": "initialized"})
    started = server.call("thread/start", {"cwd": str(task_dir), "approvalPolicy": "never", "sandbox": "read-only",
                                           "config": {"model_reasoning_effort": "low"}})
    if "error" in started:
        raise RuntimeError(started["error"])
    thread = started["result"]["thread"]["id"]
    turns = []
    for word in ("alpha", "beta"):
        response = server.call("turn/start", {"threadId": thread, "input": [{"type": "text", "text": f"Reply with exactly the word {word} and nothing else."}]})
        if "error" in response:
            raise RuntimeError(response["error"])
        turn = response["result"]["turn"]["id"]
        server.wait(lambda m: m.get("method") == "turn/completed" and m["params"]["turn"]["id"] == turn, 240)
        turns.append(turn)
    state = {"threadId": thread, "turns": turns, "model": started["result"].get("model"),
             "reasoningEffort": started["result"].get("reasoningEffort"), "holderPid": server.process.pid}
    (state_dir / "source.json").write_text(json.dumps(state, indent=2))
    print(json.dumps(state), flush=True)
    hold(server, state_dir)


def hold(server: AppServer, state_dir: Path):
    """Keep the writer, like an idle shared daemon, until asked to stop."""
    while not (state_dir / "stop").exists() and server.process.poll() is None:
        time.sleep(1)
    server.process.terminate()
    server.process.wait(timeout=10)


def hold_again():
    """Resume only the dedicated session `start` created; no Turn is sent."""
    state_dir, task_dir = Path(sys.argv[2]), Path(sys.argv[3])
    (state_dir / "stop").unlink(missing_ok=True)
    state = json.loads((state_dir / "source.json").read_text())
    server = AppServer(task_dir)
    server.call("initialize", {"clientInfo": {"name": "yuzuno_t4_holder", "title": "T-4 fork acceptance holder", "version": "0.1.0"}})
    server.send({"method": "initialized"})
    resumed = server.call("thread/resume", {"threadId": state["threadId"], "cwd": str(task_dir),
                                            "approvalPolicy": "never", "sandbox": "read-only"})
    if "error" in resumed:
        raise RuntimeError(resumed["error"])
    print(json.dumps({"holding": state["threadId"], "holderPid": server.process.pid}), flush=True)
    hold(server, state_dir)


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "start":
    main()
elif __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "hold":
    hold_again()
