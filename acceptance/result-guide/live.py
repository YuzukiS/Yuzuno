#!/usr/bin/env python3
"""T-86 acceptance: a real Claude reads result_publish's short entry whole and
the full guide through result_guide; publishing, rejection and correction
still follow the validator; a restart and a stricter client degrade clearly.

  python3 acceptance/result-guide/live.py <empty lab folder>

Environment:
  YUZUNO_LAB_CORE      this checkout's Core build (the candidate)
  YUZUNO_LAB_OLD_CORE  a Core whose result_publish description is the old,
                       3250-character one (with YUZUNO_LAB_OLD_BRIDGE, its bridge)

Three lab Cores, one after another, each with its own data and working folder
under the lab folder and its own port; the daily Core is never used:

  old     the old description: what Claude Code itself holds for it
          (cli_view.mjs: mcpServerStatus, no model turn) and what the model
          reports seeing of it
  new     the candidate: Claude Code's view of every Yuzuno tool, the MCP
          server instructions, then real turns that read the guide and answer
          from it, publish a Table/BarChart/Sources/Continue result, get a
          rejection and fix it, and, after a Core restart, read part of the
          guide and publish again in the same session
  strict  the candidate with CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH=400, a
          stricter client: the entry is cut, still names result_guide, and the
          model finds the guide from it

Real Claude (Sonnet) with the normal CLI login and manual permissions, working
in an empty folder outside any checkout (~/.t86-lab/<lab name>). The lab
denies every permission request: the Yuzuno tools are pre-approved and nothing
else is needed. The MCP token is read from the lab Core's own data folder only
to let cli_view.mjs connect; it is never printed or stored in the evidence.
Every check goes to <lab>/evidence.json.
"""
import hashlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NEW_CORE = Path(os.environ["YUZUNO_LAB_CORE"])
OLD_CORE = Path(os.environ["YUZUNO_LAB_OLD_CORE"])
OLD_BRIDGE = Path(os.environ["YUZUNO_LAB_OLD_BRIDGE"])
BRIDGE = ROOT / "runtimes/claude/bridge.mjs"
NODE_BIN = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin"
CLAUDE = Path(os.path.realpath(NODE_BIN / "claude"))
DAILY_DIST = (Path.home() / 'yuzuno-next/web/dist')
CLAUDE_SETTINGS = Path.home() / ".claude/settings.json"
CONTRACT = json.loads((ROOT / "runtimes/result-validator/contract.json").read_text())
LAB = Path(sys.argv[1]).resolve()
LAB.mkdir(parents=True)
# The Agents work in an empty folder outside any checkout, so the only way to
# learn the components is the guide, not the repository's source.
AGENT_CWD = Path.home() / ".t86-lab" / LAB.name
AGENT_CWD.mkdir(parents=True)
evidence = {"lab": str(LAB), "checks": [], "turns": {}, "cores": [], "observations": {}}
started = time.monotonic()
BASE = None


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def call(method, path, body=None, timeout=180):
    request = urllib.request.Request(
        BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Yuzuno-Client": "desktop"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


def ok(method, path, body=None, timeout=180):
    status, result = call(method, path, body, timeout)
    if status != 200:
        raise SystemExit(f"{method} {path}: {status} {result}")
    return result


def check(condition, text, **facts):
    evidence["checks"].append({"ok": bool(condition), "check": text, **facts,
                               "t": round(time.monotonic() - started, 1)})
    print(("PASS " if condition else "FAIL ") + text, json.dumps(facts, ensure_ascii=False)[:600], flush=True)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else None


def daily():
    listener = subprocess.run(["ss", "-ltnp", "sport = :4317"], text=True, capture_output=True).stdout
    tree = hashlib.sha256()
    for path in sorted(DAILY_DIST.rglob("*")):
        if path.is_file():
            tree.update(str(path.relative_to(DAILY_DIST)).encode() + path.read_bytes())
    return {"listener": listener.split("users:")[-1].strip() if "users:" in listener else None,
            "webDist": tree.hexdigest(), "claudeSettings": digest(CLAUDE_SETTINGS)}


def starttime(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split()[19]
    except OSError:
        return None


def bridges_left(bridge):
    marker = str(bridge).encode()
    left = []
    for proc in Path("/proc").iterdir():
        try:
            if proc.name.isdigit() and marker in (proc / "cmdline").read_bytes():
                left.append(int(proc.name))
        except OSError:
            pass
    return left


class Core:
    def __init__(self, name, binary, bridge, port, data, extra_env=None):
        self.name, self.binary, self.bridge, self.port, self.data = name, binary, bridge, port, data
        self.extra_env = extra_env or {}
        self.work = data.parent / f"{name}-work"
        self.work.mkdir(exist_ok=True)

    def start(self):
        global BASE
        BASE = f"http://127.0.0.1:{self.port}"
        log = (LAB / f"{self.name}-core.log").open("ab")
        env = {**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin",
               "YUZUNO_CLAUDE_BRIDGE": str(self.bridge), **self.extra_env}
        self.child = subprocess.Popen(
            [str(self.binary), "--port", str(self.port), "--data-dir", str(self.data), "--cwd", str(self.work),
             "--codex", str(NODE_BIN / "codex")],
            cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(300):
            try:
                if call("GET", "/api/health", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            if self.child.poll() is not None:
                raise SystemExit(f"{self.name} Core exited; see its log")
            time.sleep(0.2)
        self.receipt = {"core": self.name, "port": self.port, "binary": str(self.binary), "binarySha256": digest(self.binary),
                        "bridgeSha256": digest(self.bridge), "env": self.extra_env, "pid": self.child.pid,
                        "starttime": starttime(self.child.pid), "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        evidence["cores"].append(self.receipt)

    def stop(self):
        stamp = starttime(self.child.pid)
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
            self.child.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=10)
        time.sleep(3)
        self.receipt["stopped"] = {"coreExited": starttime(self.child.pid) != stamp,
                                   "bridgesLeft": bridges_left(self.bridge)}

    def token(self, agent):
        db = sqlite3.connect(f"file:{self.data / 'workspace.sqlite'}?mode=ro", uri=True)
        row = db.execute("SELECT value FROM workspace_meta WHERE key=?", [f"collaboration.mcp.agent.{agent}"]).fetchone()
        db.close()
        return row[0] if row else None

    def db_rows(self, sql, args=()):
        db = sqlite3.connect(f"file:{self.data / 'workspace.sqlite'}?mode=ro", uri=True)
        rows = db.execute(sql, args).fetchall()
        db.close()
        return rows


def cli_view(core, agent, label, extra_env=None):
    """Claude Code's own record of the Yuzuno tools it took in (no model turn)."""
    token = core.token(agent)
    if not token:
        raise SystemExit(f"{label}: the lab Core has no MCP credential for the Agent yet")
    env = {**os.environ, "HOME": str(Path.home()), "PATH": f"{NODE_BIN}:/usr/local/bin:/usr/bin:/bin",
           "YUZUNO_LAB_MCP_TOKEN": token, "YUZUNO_LAB_DEBUG_FILE": str(LAB / f"{label}-claude-debug.log"),
           **(extra_env or {})}
    out = subprocess.run([str(NODE_BIN / "node"), str(HERE / "cli_view.mjs"), f"http://127.0.0.1:{core.port}/mcp/{agent}", str(CLAUDE)],
                         env=env, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise SystemExit(f"cli_view failed: {out.stderr[-2000:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def mcp_instructions(core, agent):
    """The server instructions the lab Core sends in MCP initialize."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t86-lab", "version": "1"}}}
    request = urllib.request.Request(
        f"http://127.0.0.1:{core.port}/mcp/{agent}", method="POST", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                 "Authorization": f"Bearer {core.token(agent)}"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read())["result"].get("instructions", "")


def detail(agent):
    return ok("GET", f"/api/agents/{agent}")


def turn(d, turn_id):
    return next((t for t in d["turns"] if t["id"] == turn_id), None)


def deny_everything(d):
    for request in d["pending"]:
        if request["method"] == "claude/canUseTool" and not request.get("stale") and not request["params"].get("_responseSent"):
            evidence.setdefault("denied", []).append(request["params"].get("toolName"))
            call("POST", f"/api/requests/{request['id']}/respond", {"response": {"decision": "deny", "message": "Not needed for this lab."}})


def ended(turn_id):
    return lambda d: d["agent"]["status"] == "idle" and (turn(d, turn_id) or {}).get("status") in ("completed", "failed", "interrupted")


def wait(agent, ready, what, seconds=420):
    deadline = time.time() + seconds
    while time.time() < deadline:
        d = detail(agent)
        if ready(d):
            return d
        deny_everything(d)
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def text_of(item):
    return item.get("text") or "".join(c.get("text", "") for c in item.get("content", []) if isinstance(c, dict))


def run_turn(agent, name, text):
    turn_id = ok("POST", f"/api/agents/{agent}/turns", {"text": text})["turnId"]
    d = wait(agent, ended(turn_id), f"turn {name}")
    time.sleep(1)
    d = detail(agent)
    t = turn(d, turn_id)
    tools = [{"name": i.get("name"), "input": i.get("input")} for i in t["items"] if i.get("type") == "claudeToolUse"]
    reply = "\n".join(text_of(i) for i in t["items"] if i.get("type") == "agentMessage")
    evidence["turns"][name] = {"turnId": turn_id, "status": t["status"], "tools": tools, "reply": reply[-4000:],
                               "session": d["agent"].get("claudeSessionId")}
    return turn_id, d, tools, reply


def answer_json(reply):
    """The last JSON object in a reply, in a code block or not."""
    decoder, found, after = json.JSONDecoder(), None, 0
    for at in [match.start() for match in re.finditer(r"\{", reply)]:
        if at < after:
            continue  # inside an object already read
        try:
            value, length = decoder.raw_decode(reply[at:])
        except ValueError:
            continue
        if isinstance(value, dict):
            found, after = value, at + length
    return found


def results_for(core, agent, turn_id):
    rows = core.db_rows("SELECT request_id, input_json, response_json FROM collaboration_requests WHERE actor=? AND operation='result_publish'",
                        [f"agent:{agent}"])
    out = []
    for request_id, raw_input, raw_response in rows:
        given, response = json.loads(raw_input), json.loads(raw_response)
        if given.get("expectedTurnId") == turn_id:
            out.append({"requestId": request_id, "spec": given.get("spec"), "response": response})
    return out


def types(spec):
    return sorted({e.get("type") for e in (spec or {}).get("elements", {}).values()})


def new_agent(name):
    agent = ok("POST", "/api/agents", {"name": name, "harness": "claude", "cwd": str(AGENT_CWD), "model": "sonnet"})["id"]
    ok("POST", f"/api/agents/{agent}/settings", {"model": "sonnet", "permissionMode": "default"})
    return agent


def truncated(view, tool):
    """Claude Code's record of cutting this tool's description, or None."""
    return next((line for line in view["truncations"] if line.startswith(f'Tool "{tool}" description')), None)


GUIDE_NAME = "mcp__yuzuno__result_guide"
PUBLISH_NAME = "mcp__yuzuno__result_publish"


def old_phase():
    core = Core("old", OLD_CORE, OLD_BRIDGE, 4541, LAB / "old-data")
    core.start()
    try:
        agent = new_agent("T-86 old")
        _, _, tools, reply = run_turn(agent, "old-see", (
            "T-86 acceptance. Do not publish anything and do not call any yuzuno tool. Use tool search to load the "
            "yuzuno result_publish tool's definition if it is not loaded. Then reply with only JSON: "
            '{"lastSentence": the final sentence of its description copied exactly, "truncated": true if the '
            'description ends with a truncation mark such as "[truncated]", else false}.'))
        seen = answer_json(reply) or {}
        evidence["observations"]["old-model"] = seen
        check(seen.get("truncated") is True, "old: the model sees result_publish's description end in a truncation mark",
              seen=seen)
        view = cli_view(core, agent, "old")
        evidence["observations"]["old-cli"] = view
        instructions = mcp_instructions(core, agent)
        evidence["observations"]["old-instructions"] = {"length": utf16(instructions)}
        check(truncated(view, "result_publish") == 'Tool "result_publish" description truncated from 3250 to 2048 chars'
              and "result_guide" not in view["tools"],
              "old: Claude Code itself records cutting result_publish from 3250 to 2048, and there is no guide tool",
              truncations=view["truncations"], tools=view["tools"])
    finally:
        core.stop()


def new_phase():
    core = Core("new", NEW_CORE, BRIDGE, 4542, LAB / "new-data")
    core.start()
    try:
        agent = new_agent("T-86 new")
        # 1. The entry is whole, and the guide answers what the entry does not say.
        t1, d, tools, reply = run_turn(agent, "read-guide", (
            "T-86 acceptance. Do not publish anything. Use tool search to load the yuzuno result_publish and "
            "result_guide tools if needed. Call result_guide once, with no arguments. Then reply with only JSON, "
            "taking every number from the guide rather than from memory: "
            '{"lastSentence": the final sentence of result_publish\'s own description copied exactly, '
            '"truncated": true if that description ends with a truncation mark such as "[truncated]", else false, '
            '"tableMaxColumns": n, "tableMaxRows": n, "barChartMaxPoints": n, "sourcesMaxItems": n, '
            '"continueProps": [prop names], "clarificationFields": "min-max", "actionsPerResult": n '
            '(how many Continue or Clarification one result may have), "formAuthorizesPermissions": true/false}.'))
        seen = answer_json(reply) or {}
        evidence["observations"]["new-model"] = seen
        guide_calls = [tool for tool in tools if tool["name"] == GUIDE_NAME]
        check(guide_calls and not [tool for tool in tools if tool["name"] == PUBLISH_NAME],
              "new: the model called result_guide and published nothing", tools=[tool["name"] for tool in tools])
        last_paragraph = CONTRACT["description"].split("\n")[-1]
        quoted = (seen.get("lastSentence") or "").strip()
        check(seen.get("truncated") is False and len(quoted) > 20 and quoted in last_paragraph,
              "new: the model sees result_publish's entry whole: no truncation mark, and it quotes the final paragraph",
              seen={"lastSentence": quoted, "truncated": seen.get("truncated")}, finalParagraph=last_paragraph)
        expected = {"tableMaxColumns": 8, "tableMaxRows": 100, "barChartMaxPoints": 24, "sourcesMaxItems": 30,
                    "actionsPerResult": 1, "formAuthorizesPermissions": False}
        check(all(seen.get(key) == value for key, value in expected.items())
              and {"label", "instruction", "requiresSelection"} <= set(seen.get("continueProps") or [])
              and str(seen.get("clarificationFields", "")).replace(" ", "") in ("1-8", "1–8"),
              "new: from the guide the model reports Table, BarChart, Sources, Continue, Clarification and action limits",
              seen={k: seen.get(k) for k in [*expected, "continueProps", "clarificationFields"]})
        # Claude Code's own view and the server instructions.
        view = cli_view(core, agent, "new")
        evidence["observations"]["new-cli"] = view
        entry = CONTRACT["description"]
        check(view["status"] == "connected" and {"result_publish", "result_guide"} <= set(view["tools"])
              and view["yuzunoInLog"] and view["truncations"] == [],
              "new: Claude Code took in every Yuzuno tool, result_guide included, and cut no description or instructions",
              entryLength=utf16(entry), guideAt=entry.find("result_guide"), tools=view["tools"],
              toolCount=view["toolCount"], truncations=view["truncations"])
        instructions = mcp_instructions(core, agent)
        check(utf16(instructions) <= 2048 and "result_guide" in instructions,
              "new: the MCP server instructions fit and name the guide", length=utf16(instructions))
        # 2. A result with Table, BarChart, Sources and Continue.
        t2, d, tools, reply = run_turn(agent, "publish", (
            "T-86 acceptance. Using result_publish (and the guide you read), show the user a comparison of three "
            "fictional laptops: a Table with a sourceIds citation on each row, a BarChart of their prices, a Sources "
            "list with the cited http(s) links, and a Continue button that requires a selection. If it is rejected, "
            "fix the problems and publish again. Then reply with one short sentence."))
        published = results_for(core, agent, t2)
        accepted = [r for r in published if r["response"].get("accepted") is True]
        check(accepted and {"Table", "BarChart", "Sources", "Continue"} <= set(types(accepted[-1]["spec"])),
              "new: a Table/BarChart/Sources/Continue result was accepted",
              attempts=[{"accepted": r["response"].get("accepted"), "types": types(r["spec"]),
                         "problems": r["response"].get("problems")} for r in published])
        # 3. A rejection names the guide; the fix is accepted.
        t3, d, tools, reply = run_turn(agent, "reject-fix", (
            "T-86 acceptance, testing the validator on purpose. First call result_publish with a small Table whose "
            "first row has no cell for one of its columns, so it is rejected. Read the rejection, including its "
            "guide field, then fix the Table and publish again. Reply with only JSON: "
            '{"firstCode": the first problem\'s code, "guide": the rejection\'s guide field}.'))
        published = results_for(core, agent, t3)
        rejected = [r for r in published if r["response"].get("accepted") is False]
        fixed = [r for r in published if r["response"].get("accepted") is True]
        first = rejected[0]["response"] if rejected else {}
        check(rejected and fixed and first.get("problems", [{}])[0].get("code") == "row_mismatch"
              and first.get("guide") == {"tool": "result_guide", "components": ["Table"]},
              "new: the rejection named row_mismatch and the guide for Table, and the fix was accepted",
              rejection={"problems": first.get("problems"), "guide": first.get("guide"), "error": first.get("error")},
              accepted=len(fixed), seen=answer_json(reply))
        session = d["agent"].get("claudeSessionId")
        # 4. After a Core restart: part of the guide, then publish, same session.
        core.stop()
        core.start()
        t4, d, tools, reply = run_turn(agent, "after-restart", (
            "T-86 acceptance. Call result_guide with components [\"BarChart\"] only. Then publish with result_publish "
            "a small BarChart of three fictional values. Reply with only JSON: "
            '{"unitMaxLength": the longest unit the guide allows, as a number}.'))
        published = results_for(core, agent, t4)
        calls = [tool for tool in tools if tool["name"] == GUIDE_NAME]
        check(calls and (calls[0]["input"] or {}).get("components") == ["BarChart"]
              and any(r["response"].get("accepted") is True and "BarChart" in types(r["spec"]) for r in published)
              and (answer_json(reply) or {}).get("unitMaxLength") == 30 and d["agent"].get("claudeSessionId") == session,
              "new: after a Core restart the same session read part of the guide and published",
              guideInput=calls and calls[0]["input"], seen=answer_json(reply), session=session,
              sessionAfter=d["agent"].get("claudeSessionId"))
    finally:
        core.stop()


def strict_phase():
    strict = {"CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH": "400"}
    core = Core("new", NEW_CORE, BRIDGE, 4542, LAB / "new-data", strict)
    core.name = "strict"
    core.start()
    try:
        # A fresh Agent: a session that already read the entry would answer
        # from memory. Its session mints its MCP credential when it starts.
        agent = new_agent("T-86 strict")
        t5, d, tools, reply = run_turn(agent, "strict-find-guide", (
            "T-86 acceptance. Without guessing or relying on memory, find out the maximum number of rows a Table "
            "may have in result_publish, and the exact name of the Table prop that lets rows be selected. Do not "
            'publish anything. Reply with only JSON: {"tableMaxRows": n, "selectionProp": "name", '
            '"truncated": true if result_publish\'s own description, as you see it, ends in a truncation mark, else false, '
            '"guideNamed": the tool its visible description names for full details, or null, '
            '"source": where you read the answers}.'))
        seen = answer_json(reply) or {}
        evidence["observations"]["strict-model"] = seen
        check([tool for tool in tools if tool["name"] == GUIDE_NAME] and seen.get("tableMaxRows") == 100
              and seen.get("selectionProp") == "selectable" and seen.get("truncated") is True
              and seen.get("guideNamed") in ("result_guide", GUIDE_NAME),
              "strict: the model sees the entry cut, finds result_guide named in it and answers from it",
              tools=[tool["name"] for tool in tools], seen=seen)
        view = cli_view(core, agent, "strict", strict)
        evidence["observations"]["strict-cli"] = view
        entry = CONTRACT["description"]
        check(truncated(view, "result_publish") == f'Tool "result_publish" description truncated from {utf16(entry)} to 400 chars'
              and 0 <= entry.find("result_guide") < 400,
              "strict: a client keeping 400 code units cuts the entry after the guide's name",
              cut=truncated(view, "result_publish"), guideAt=entry.find("result_guide"))
    finally:
        core.stop()


def lab():
    evidence["dailyBefore"] = daily()
    evidence["cli"] = subprocess.run([str(CLAUDE), "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    try:
        old_phase()
        new_phase()
        strict_phase()
    finally:
        evidence["dailyAfter"] = daily()
        check(evidence["dailyBefore"] == evidence["dailyAfter"],
              "daily Core listener, its web/dist and ~/.claude/settings.json unchanged")
        check(all(c.get("stopped", {}).get("coreExited") and not c["stopped"]["bridgesLeft"] for c in evidence["cores"]),
              "every lab Core exited and left no bridge")
        (LAB / "evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    failed = [c["check"] for c in evidence["checks"] if not c["ok"]]
    print(json.dumps({"checks": len(evidence["checks"]), "failed": failed}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(lab())
