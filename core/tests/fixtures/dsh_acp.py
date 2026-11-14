#!/usr/bin/env python3
"""A stand-in `dsh` (the DeepSeek Harness), for core/src/dsh_tests.rs (YN-124,
slice S1 of the YN-119 design). It answers the four ways Core runs dsh as
dsh 0.2.2-rc.3 does (YN-124 capture of rc.1 and rc.3):

  dsh --version                                      the version, one line
  dsh --profile acp --patch OVERLAY --dump-config    the composed rows
  dsh --profile acp --dump-config-schema             the rows' JSON Schema
  dsh --profile acp --patch OVERLAY                  ACP v1 on stdin/stdout

The dump is printed as dsh prints it: groups headed `# == <layer>[, patched
by <patch>, ...]`, a row's `name:` quoted, long paths folded (`>-`), and a
patch row dsh does not have warned of on stderr only (`dsh: [OVERLAY] patch:
entry "<id>" not found`), with exit 0. The schema has dsh's shape
(`$defs.entryMetadata`, `$defs.entry.allOf[]` branches by package name whose
config refers to `$defs.configN`), cut down to the rows Core writes.

ACP is JSON-RPC 2.0, one object per line. `initialize`, `session/new` and
`session/close` answer as rc.3 does; an unknown method gets rc.3's -32601.
`session/resume` of a session ID it is given answers with its options, as
`session/new` does (resumed sessions are logged, kind `resumed`); after
either, with `commandsUpdate`, it sends an `available_commands_update`, as
ACP agents do; and
`session/set_config_option` sets an option's current value (logged, kind
`set`), refusing a value the option does not list. A `session/prompt` whose
text holds one of these words runs that scene:
  ASK     sends session/request_permission (as dsh does past its sandbox),
          then, once answered, an agent_message_chunk quoting the answer
  SLEEP   answers only after session/cancel, with stopReason `cancelled`
  EXIT    writes "fixture: exiting" on stderr and exits 3 without answering
  NOISE   writes a line that is not JSON
  LATER   answers end_turn, then 0.3 s later sends a message of its own, as
          dsh does once a background task ends (no prompt open)
  TOOL    three tool calls, each started then finished: `bash` (its output
          and exit code in rawOutput), `mcp__yuzuno__peers_list` (a text
          content block) and `read` (failed), then a message and end_turn
anything else: an agent_thought_chunk, an agent_message_chunk and a
usage_update, then stopReason `end_turn`. `fixture/hang` is never answered.
It exits when its stdin ends, as dsh does.

A test may leave $DSH_HOME/fixture.json before the start, an object of:
  version       what --version prints (default 0.2.2-rc.3)
  versionExit   --version exits with it, saying so on stderr
  dropRow       ids of rows this dsh does not have
  laterPatch    a patch printed after OVERLAY in every patched heading
  readBack      {row: {key: value}}: printed instead of what OVERLAY set
  dumpStderr    more stderr for --dump-config
  schemaDrop    {row: key}: a key its schema does not list
  schemaModes   the sandbox modes its schema lists
  schemaUnknown rows whose package has no config schema (unknownConfig)
  schemaNoDisabled  its entries take no `disabled`
  initialize    an object merged over its answer to initialize
  initializeExit    exits with 4 at initialize, saying this on stderr
  ignoreStdin   keeps running after its stdin ends
  ignoreTerm    ignores SIGTERM
  child         starts `sleep 300`, which stays in its process group
  commandsUpdate  sends available_commands_update as each session opens
It appends what it saw to $DSH_HOME/fixture-log.jsonl: per run its argv,
working directory, the DSH_*/DEEPSEEK_* variable names it was given, the
values of DSH_HOME, DSH_PERMISSION_MODE, DSH_TELEMETRY_DISABLED and
DEEPSEEK_BASE_URL, and the SHA-256 of DEEPSEEK_API_KEY (never the key);
per ACP message its method. It runs on Python 3.9 (macOS's /usr/bin/python3).
"""
import hashlib
import json
import os
import signal
import subprocess
import sys
import time

HOME = os.environ.get("DSH_HOME") or "."
ARGS = sys.argv[1:]


def control():
    try:
        with open(os.path.join(HOME, "fixture.json"), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


CONTROL = control()


def log(record):
    with open(os.path.join(HOME, "fixture-log.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def started():
    names = sorted(n for n in os.environ if n.startswith("DSH_") or n.startswith("DEEPSEEK_"))
    key = os.environ.get("DEEPSEEK_API_KEY")
    log({
        "kind": "start",
        "argv": ARGS,
        "cwd": os.getcwd(),
        "pid": os.getpid(),
        "names": names,
        "env": {n: os.environ.get(n) for n in
                ("DSH_HOME", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_DISABLED", "DEEPSEEK_BASE_URL")},
        "keySha256": hashlib.sha256(key.encode()).hexdigest() if key is not None else None,
    })


# ------------------------------------------------------------- configuration

BASE = "@deepseek-ai/dsh-base"
ACP_APP = "@deepseek-ai/dsh-acp-app"
# The rows Core's overlay patches, as rc.3 lists them: (id, package, layer,
# lines dsh itself has for the row, before and after its config).
ROWS = [
    ("session-log-deepseek", "@deepseek-ai/dsh-session-log-deepseek", BASE, [], {"enabled": "true"}),
    ("plugin-package-inventory-deepseek", "@deepseek-ai/dsh-plugin-package-inventory-deepseek", BASE, [],
     {"enabled": "true"}),
    ("session-telemetry-otel", "@deepseek-ai/dsh-session-telemetry-otel", BASE, [],
     {"mode": "!!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'", "shutdownTimeoutMillis": "3000"}),
    ("sandbox-policy", "@deepseek-ai/dsh-sandbox-policy", BASE, [], {"mode": "read-only"}),
    ("approval", "@deepseek-ai/dsh-user-approval", BASE, [], {"policy": "!!js process.env.DSH_APPROVAL_POLICY || 'ask'"}),
    ("acp", "@deepseek-ai/dsh-acp", ACP_APP, ["  inject:", "    - acpAppStartup"], {}),
]
# Rows the overlay leaves alone, printed between them as dsh does.
OTHERS = [
    ("timer", "@deepseek-ai/cordis-plugin-timer", ["  disabled: !!js '!ctx.get(''profileContext'')'"]),
    ("agent-default-model", "@deepseek-ai/dsh-agent-default-model",
     ["  config:", "    provider: deepseek-official", "    model: deepseek-flash"]),
    ("permission", "@deepseek-ai/dsh-permission-presets",
     ["  config:", "    presets:", "      workspace-write:", "        sandbox: workspace-write", "        approval: ask"]),
]


def read_overlay(path):
    """Core's overlay: block YAML of rows with an id, a `config` of scalars
    or lists of quoted paths, and `disabled: true`."""
    rows, row, key = [], None, None
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if line.startswith("- id: "):
                row = {"id": line[6:].strip(), "config": None, "disabled": False}
                rows.append(row)
            elif line == "  config:":
                row["config"] = {}
            elif line == "  disabled: true":
                row["disabled"] = True
            elif line.startswith("      - "):
                row["config"][key].append(json.loads(line[8:]))
            elif line.startswith("    "):
                key, _, value = line[4:].partition(":")
                value = value.strip()
                if value == "":
                    row["config"][key] = []
                elif value == "[]":
                    row["config"][key] = []
                elif value.startswith('"'):
                    row["config"][key] = json.loads(value)
                else:
                    row["config"][key] = value
            else:
                raise SystemExit("fixture: cannot read overlay line %r" % line)
    return rows


def scalar_lines(key, value, indent):
    pad = " " * indent
    if isinstance(value, list):
        if not value:
            return ["%s%s: []" % (pad, key)]
        out = ["%s%s:" % (pad, key)]
        for item in value:
            out += ["%s  - >-" % pad, "%s    %s" % (pad, item)]
        return out
    if isinstance(value, str) and value.startswith("/"):
        return ["%s%s: >-" % (pad, key), "%s  %s" % (pad, value)]
    return ["%s%s: %s" % (pad, key, value)]


def dump(overlay):
    patches = {row["id"]: row for row in read_overlay(overlay)}
    dropped = set(CONTROL.get("dropRow") or [])
    known = {row[0] for row in ROWS if row[0] not in dropped}
    out = []
    later = CONTROL.get("laterPatch")
    read_back = CONTROL.get("readBack") or {}

    def others(at):
        rid, name, lines = OTHERS[at]
        out.append("# == " + BASE)
        out.append("- id: " + rid)
        out.append("  name: '%s'" % name)
        out.extend(lines)

    for at, (rid, name, layer, before, own) in enumerate(ROWS):
        if at < len(OTHERS):
            others(at)
        if rid in dropped:
            continue
        patch = patches.get(rid)
        heading = "# == " + layer
        if patch is not None:
            heading += ", patched by " + overlay + (", " + later if later else "")
        out.append(heading)
        out.append("- id: " + rid)
        out.append("  name: '%s'" % name)
        out.extend(before)
        config = dict(own)
        if patch is not None and patch["config"] is not None:
            config = dict(patch["config"])
        config.update(read_back.get(rid) or {})
        if config:
            out.append("  config:")
            for key, value in config.items():
                out.extend(scalar_lines(key, value, 4))
        if patch is not None and patch["disabled"]:
            out.append("  disabled: true")
    sys.stdout.write("\n".join(out) + "\n")
    for rid in patches:
        if rid not in known:
            sys.stderr.write('dsh: [%s] patch: entry "%s" not found\n' % (overlay, rid))
    if CONTROL.get("dumpStderr"):
        sys.stderr.write(CONTROL["dumpStderr"] + "\n")


def loader():
    return {"$ref": "#/$defs/loaderExpression"}


def choice(values):
    """A property taking one of `values`, nested as dsh's schema nests it."""
    return {"x-cordis": {"branchSelection": "first-success"}, "anyOf": [
        {"anyOf": [{"anyOf": [{"const": v, "not": {"type": "null"}} for v in values]}, {"type": "null"}]},
        loader()]}


def typed(kind):
    return {"anyOf": [{"type": [kind, "null"]}, loader()]}


def schema():
    modes = CONTROL.get("schemaModes") or ["read-only", "workspace-write", "danger-full-access"]
    configs = {
        "session-log-deepseek": {"enabled": dict(typed("boolean"), default=True), "maxBytes": typed("integer")},
        "plugin-package-inventory-deepseek": {"enabled": typed("boolean")},
        "session-telemetry-otel": {"mode": choice(["FEEDBACK_ONLY", "DISABLED"]),
                                   "shutdownTimeoutMillis": typed("number")},
        "sandbox-policy": {"mode": choice(modes), "workspaceRoot": typed("string"),
                           "additionalWritableRoots": {"default": [], "anyOf": [
                               {"type": ["array", "null"], "items": {"type": "string"}}, loader()]}},
        "approval": {"policy": choice(["ask", "never"])},
        "acp": {"provider": typed("string"), "model": typed("string"), "sessionListPageSize": typed("integer")},
    }
    for rid, key in (CONTROL.get("schemaDrop") or {}).items():
        configs[rid].pop(key, None)
    unknown = set(CONTROL.get("schemaUnknown") or [])
    entry = ["id", "name", "config", "group", "disabled", "inject", "intercept", "isolate"]
    if CONTROL.get("schemaNoDisabled"):
        entry.remove("disabled")
    defs = {
        "loaderExpression": {"type": "object", "properties": {"__jsExpr": {"type": "string"}}},
        "entryMetadata": {"type": "object", "properties": {k: {} for k in entry}},
        "unknownConfig": {},
    }
    branches = []
    for n, (rid, name, _layer, _before, _own) in enumerate(ROWS):
        ref = "#/$defs/unknownConfig"
        if rid not in unknown:
            ref = "#/$defs/config%d" % n
            defs["config%d" % n] = {"default": {}, "anyOf": [
                {"type": ["object", "null"], "properties": configs[rid]}, loader()]}
        branches.append({"if": {"properties": {"name": {"const": name}}},
                         "then": {"properties": {"config": {"anyOf": [{"$ref": ref}]}}}})
    defs["entry"] = {"allOf": branches}
    sys.stdout.write(json.dumps({"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": defs}))


# ------------------------------------------------------------- ACP

def send(message):
    message["jsonrpc"] = "2.0"
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def update(session, body):
    send({"method": "session/update", "params": {"sessionId": session, "update": body}})


INITIALIZE = {
    "protocolVersion": 1,
    "agentInfo": {"name": "deepseek-harness-acp", "version": "0.0.1"},
    "agentCapabilities": {
        "mcpCapabilities": {"http": True},
        "promptCapabilities": {"image": True, "audio": False, "embeddedContext": False},
        "sessionCapabilities": {"close": {}, "list": {}, "resume": {}},
    },
    "authMethods": [],
}

CONFIG_OPTIONS = [
    {"id": "model", "name": "Model", "category": "model", "type": "select",
     "currentValue": '["deepseek-official","deepseek-flash"]',
     "options": [{"group": "deepseek-official", "name": "DeepSeek", "options": [
         {"value": '["deepseek-official","deepseek-flash"]', "name": "DeepSeek-V4.1-Flash"},
         {"value": '["deepseek-official","deepseek-v4-pro"]', "name": "DeepSeek-V4-Pro"}]}]},
    {"id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select",
     "currentValue": "high", "options": [{"value": v, "name": v} for v in ("off", "low", "high", "max")]},
]


def listed(options):
    """Every value of an option's choices, grouped or not."""
    out = []
    for choice in options:
        if "value" in choice:
            out.append(choice["value"])
        else:
            out.extend(listed(choice.get("options") or []))
    return out


def merged(base, over):
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merged(out[key], value)
        else:
            out[key] = value
    return out


def prompt_text(params):
    return " ".join(b.get("text", "") for b in params.get("prompt") or [] if isinstance(b, dict))


def serve():
    if CONTROL.get("ignoreTerm"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if CONTROL.get("child"):
        child = subprocess.Popen(["sleep", "300"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log({"kind": "child", "pid": child.pid})
    sessions = 0
    asked = {}        # our request ID -> (prompt ID, session)
    sleeping = {}     # session -> prompt ID
    next_request = 0
    for raw in sys.stdin:
        message = json.loads(raw)
        method = message.get("method")
        log({"kind": "message", "method": method, "id": message.get("id")})
        mid = message.get("id")
        params = message.get("params") or {}
        if method is None:
            # An answer to a request of ours.
            prompt, session = asked.pop(mid)
            update(session, {"sessionUpdate": "agent_message_chunk", "messageId": "m-ask",
                             "content": {"type": "text", "text": json.dumps(message.get("result"))}})
            send({"id": prompt, "result": {"stopReason": "end_turn"}})
        elif method == "initialize":
            if CONTROL.get("initializeExit"):
                sys.stderr.write("fixture: initialize failed\n")
                sys.stderr.flush()
                sys.exit(4)
            send({"id": mid, "result": merged(INITIALIZE, CONTROL.get("initialize") or {})})
        elif method == "session/new":
            sessions += 1
            send({"id": mid, "result": {"sessionId": "ses-%d" % sessions, "configOptions": CONFIG_OPTIONS}})
            if CONTROL.get("commandsUpdate"):
                update("ses-%d" % sessions, {"sessionUpdate": "available_commands_update", "availableCommands": []})
        elif method == "session/resume":
            log({"kind": "resumed", "sessionId": params.get("sessionId")})
            send({"id": mid, "result": {"configOptions": CONFIG_OPTIONS}})
            if CONTROL.get("commandsUpdate"):
                update(params.get("sessionId"), {"sessionUpdate": "available_commands_update", "availableCommands": []})
        elif method == "session/set_config_option":
            option = next((o for o in CONFIG_OPTIONS if o["id"] == params.get("configId")), None)
            values = [] if option is None else listed(option["options"])
            if params.get("value") not in values:
                send({"id": mid, "error": {"code": -32602, "message": "Invalid value for %s" % params.get("configId")}})
            else:
                option["currentValue"] = params["value"]
                log({"kind": "set", "configId": params["configId"], "value": params["value"]})
                send({"id": mid, "result": {"configOptions": CONFIG_OPTIONS}})
        elif method == "session/close":
            send({"id": mid, "result": {}})
        elif method == "session/cancel":
            session = params.get("sessionId")
            if session in sleeping:
                send({"id": sleeping.pop(session), "result": {"stopReason": "cancelled"}})
        elif method == "session/prompt":
            session, text = params.get("sessionId"), prompt_text(params)
            if "ASK" in text:
                rid = next_request
                next_request += 1
                asked[rid] = (mid, session)
                update(session, {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "bash",
                                 "kind": "execute", "status": "pending",
                                 "rawInput": {"command": "touch ../outside", "sandbox_permissions": "danger-full-access",
                                              "justification": "The test asks."}})
                send({"id": rid, "method": "session/request_permission", "params": {
                    "sessionId": session, "toolCall": {"toolCallId": "call-1"},
                    "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                                {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]}})
            elif "SLEEP" in text:
                sleeping[session] = mid
            elif "EXIT" in text:
                sys.stderr.write("fixture: exiting\n")
                sys.stderr.flush()
                sys.exit(3)
            elif "LATER" in text:
                send({"id": mid, "result": {"stopReason": "end_turn"}})
                time.sleep(0.3)
                update(session, {"sessionUpdate": "agent_message_chunk", "messageId": "m-later",
                                 "content": {"type": "text", "text": "on my own"}})
            elif "TOOL" in text:
                for call, title, kind, raw in (("call-b", "bash", "execute", {"command": "ls"}),
                                               ("call-m", "mcp__yuzuno__peers_list", "other", {}),
                                               ("call-r", "read", "read", {"path": "a.txt"})):
                    update(session, {"sessionUpdate": "tool_call", "toolCallId": call, "title": title, "kind": kind,
                                     "status": "pending", "rawInput": raw})
                update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "call-b", "status": "completed",
                                 "rawOutput": {"stdout": "a.txt\n", "exitCode": 0}})
                update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "call-m", "status": "completed",
                                 "content": [{"type": "content", "content": {"type": "text", "text": "{\"peers\":[]}"}}]})
                update(session, {"sessionUpdate": "tool_call_update", "toolCallId": "call-r", "status": "failed",
                                 "rawOutput": "no such file"})
                update(session, {"sessionUpdate": "agent_message_chunk", "messageId": "m-3",
                                 "content": {"type": "text", "text": "done"}})
                send({"id": mid, "result": {"stopReason": "end_turn"}})
            elif "NOISE" in text:
                sys.stdout.write("this is not JSON\n")
                sys.stdout.flush()
            else:
                update(session, {"sessionUpdate": "agent_thought_chunk", "messageId": "m-1",
                                 "content": {"type": "text", "text": "thinking"}})
                update(session, {"sessionUpdate": "agent_message_chunk", "messageId": "m-2",
                                 "content": {"type": "text", "text": "reply: " + text}})
                update(session, {"sessionUpdate": "usage_update", "used": 1234, "size": 1000000})
                send({"id": mid, "result": {"stopReason": "end_turn"}})
        elif method == "fixture/hang":
            pass
        elif mid is not None:
            send({"id": mid, "error": {"code": -32601, "message": '"Method not found": %s' % method,
                                       "data": {"method": method}}})
    log({"kind": "stdinEnded"})
    if CONTROL.get("ignoreStdin"):
        while True:
            time.sleep(60)


def main():
    started()
    if ARGS in (["--version"], ["-V"]):
        if CONTROL.get("versionExit"):
            sys.stderr.write("fixture: --version failed\n")
            sys.exit(CONTROL["versionExit"])
        sys.stdout.write(CONTROL.get("version", "0.2.2-rc.3") + "\n")
        return
    if ARGS[:2] != ["--profile", "acp"]:
        sys.stderr.write("error: --profile <name> is required\n")
        sys.exit(1)
    rest = ARGS[2:]
    if rest == ["--dump-config-schema"]:
        schema()
    elif len(rest) == 3 and rest[0] == "--patch" and rest[2] == "--dump-config":
        dump(rest[1])
    elif len(rest) == 2 and rest[0] == "--patch":
        read_overlay(rest[1])
        serve()
    else:
        sys.stderr.write("fixture: unexpected arguments %r\n" % (ARGS,))
        sys.exit(2)


main()
