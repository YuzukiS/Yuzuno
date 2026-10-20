#!/usr/bin/env python3
"""Native submit and after-Turn mailbox acceptance; polling is observer-only."""
import json
import time
from setup_lab import api, ROOT, LAB

state_path = LAB / "state.json"
state = json.loads(state_path.read_text())
if "createRequestId" in state:
    raise SystemExit("An acceptance request exists; inspect it before any retry")
request_id = "t45-native-delivery-v1"
payload = {"requestId": request_id, "taskId": state["taskId"], "repositoryId": state["repositoryId"], "action": "create", "base": "main", "head": "feat/t45-pr-operations", "title": "feat: durable PR creation and updates from tasks", "body": (LAB / "pr-body.md").read_text(), "draft": False}
state["createRequestId"] = request_id
state_path.write_text(json.dumps(state, indent=2))
(LAB / "gate-next-post").touch()
prompt = "Use only built-in Yuzuno MCP. Call github_pr_submit exactly once with this explicitly authorized delivery PR payload: " + json.dumps(payload) + ". Then immediately end your Turn with its operationId. Do not poll, sleep, execute commands, inspect files, create tasks, spawn agents, request reviews or merge. Core continues independently. On a later normal mailbox doorbell, read peer_read with the given priority/cursor and call github_pr_get for the notified operation, then report its saved status, URL and association. Do not repeat the write or send receipt-only messages."
api("/agents/" + state["agentId"] + "/turns", {"text": prompt})
observations = []
last = None
deadline = time.time() + 300
while time.time() < deadline:
    detail = api("/agents/" + state["agentId"])
    operations = api("/pr-operations?taskId=" + state["taskId"])["operations"]
    operation = next((r for r in operations if r["requestId"] == request_id), None)
    snapshot = {"at": time.time(), "agentStatus": detail["agent"]["status"], "operationId": operation["id"] if operation else None, "status": operation["status"] if operation else None}
    observations.append(snapshot)
    if (snapshot["agentStatus"], snapshot["status"]) != last:
        print(json.dumps(snapshot), flush=True)
        last = (snapshot["agentStatus"], snapshot["status"])
    if detail["pending"]:
        raise RuntimeError("Native approval needs inspection; no automatic response")
    if operation and operation["status"] in ["accepted", "running"] and detail["agent"]["status"] == "idle":
        (LAB / "release-write").touch()
    if operation and operation["status"] not in ["accepted", "running"]:
        messages = api("/collaboration/peer_read", {"agentId": state["agentId"], "priority": "normal", "limit": 100})["messages"]
        notice = next((m for m in messages if m.get("operationId") == operation["id"]), None)
        if notice and notice.get("firstReadAt") and detail["agent"]["status"] == "idle":
            result = api("/pr-operations/" + operation["id"] + "?taskId=" + state["taskId"])
            state["createOperationId"] = result["id"]
            state["number"] = result["remote"]["number"] if result["remote"] else None
            state_path.write_text(json.dumps(state, indent=2))
            artifact = {"observations": observations, "result": result, "notification": notice, "authorDetail": detail, "authorEndedWhileActive": any(o["agentStatus"] == "idle" and o["status"] in ["accepted", "running"] for o in observations)}
            (ROOT / "target/t45/native-flow.json").write_text(json.dumps(artifact, indent=2))
            assert result["status"] == "completed" and result["linked"]
            assert artifact["authorEndedWhileActive"]
            assert result["outcome"] == "checked" and result["writeError"]
            print(json.dumps({"operationId": result["id"], "url": result["remote"]["url"], "status": result["status"], "linked": result["linked"], "authorEndedWhileActive": True}), flush=True)
            break
    time.sleep(0.25)
else:
    raise RuntimeError("Acceptance deadline: inspect state before another write")
