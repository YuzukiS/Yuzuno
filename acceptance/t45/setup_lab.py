#!/usr/bin/env python3
"""Prepare T45's isolated 4477 workspace; never use a daily Core."""
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / "target/t45/lab"
BASE = "http://127.0.0.1:4477/api"

def api(path, body=None):
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

if __name__ == "__main__":
    state_path = LAB / "state.json"
    if state_path.exists():
        raise SystemExit("Lab state exists; inspect it instead of recreating identities")
    project = api("/projects", {"name": "T45 isolated delivery", "defaultDirs": {"local": str(ROOT)}})
    linked = api("/collaboration/github_repositories", {"projectId": project["id"], "action": "link", "input": "YuzukiS/Yuzuno"})
    agent = api("/agents", {"name": "T45 acceptance Dev", "harness": "codex", "cwd": str(ROOT), "model": "gpt-6.1-sol", "projectId": project["id"]})
    task = api("/collaboration/task_create", {"requestId": "t45-delivery-lab", "title": "Deliver T45 PR operations", "projectId": project["id"], "assigneeAgentId": agent["id"]})["task"]
    state = {"taskId": task["id"], "projectId": project["id"], "agentId": agent["id"], "repositoryId": linked["repositories"][0]["id"]}
    state_path.write_text(json.dumps(state, indent=2))
    print(json.dumps(state))
