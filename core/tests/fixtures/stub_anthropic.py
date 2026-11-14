#!/usr/bin/env python3
"""A stand-in model for a real dsh (YN-124, slice S1 of the YN-119 design):
a scripted Anthropic-Messages SSE endpoint in place of DeepSeek's
`/anthropic` API, so that a real dsh can run a Turn with no real model and a
placeholder key. dsh is pointed at it with DEEPSEEK_BASE_URL=
http://127.0.0.1:PORT/v1, as dsh's own mock server is
(packages/test-support/llm-mock-server/README.md). Taken from the design's
probe (results/design-YN-119/probe/fake_llm.py).

The newest user message decides the answer:
  YUZUNO-SLEEP   a bash tool call running `sleep 47` (for session/cancel)
  anything else  a thinking block, then the text `stub-reply`
A tool result is answered with a short text (end_turn).

Each request is logged as one JSON line: its path, its header names (never
their values), whether it carried an API key, its body's top-level keys,
whether those include dsh's `dsh_session_log` and `dsh_plugin_packages`, how
many messages it carries, and whether the system prompt or any message holds
the marker given.

Usage: stub_anthropic.py PORT_FILE LOG_FILE MARKER
It runs on Python 3.9 (macOS's /usr/bin/python3).
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FILE, LOG_FILE, MARKER = sys.argv[1:4]
LOCK = threading.Lock()


def log(record):
    with LOCK:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def tool_result(content):
    if isinstance(content, str):
        return None
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            return block.get("tool_use_id") or ""
    return None


def decide(messages):
    last = messages[-1] if messages else {}
    answered = tool_result(last.get("content"))
    if answered is not None:
        return ("text", "after " + answered)
    if "YUZUNO-SLEEP" in text_of(last.get("content")):
        return ("tool", "call-sleep", "bash", {"description": "Sleep", "command": "sleep 47 && echo slept"})
    return ("thinking-text", "stub-reply")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        log({"kind": "get", "path": self.path})
        body = json.dumps({"object": "list", "data": []}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def sse(self, payload):
        self.wfile.write(("event: %s\ndata: %s\n\n" % (payload["type"], json.dumps(payload))).encode())
        self.wfile.flush()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        messages = body.get("messages") or []
        decision = decide(messages)
        log({
            "kind": "post",
            "path": self.path,
            "headerNames": sorted(k.lower() for k in self.headers.keys()),
            "apiKeyPresent": bool(self.headers.get("x-api-key") or self.headers.get("authorization")),
            "bodyKeys": sorted(body.keys()),
            "hasSessionLog": "dsh_session_log" in body,
            "hasPluginPackages": "dsh_plugin_packages" in body,
            "messages": len(messages),
            "marker": MARKER in json.dumps(body.get("system")) or any(MARKER in json.dumps(m) for m in messages),
            "decision": decision[0],
        })
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        self.sse({"type": "message_start", "message": {
            "id": "stub-msg", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [], "usage": {"input_tokens": 1234, "output_tokens": 0}}})
        kind, index = decision[0], 0
        if kind == "thinking-text":
            self.sse({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
            self.sse({"type": "content_block_delta", "index": 0,
                      "delta": {"type": "thinking_delta", "thinking": "stub thinking"}})
            self.sse({"type": "content_block_stop", "index": 0})
            kind, index = "text", 1
        if kind == "text":
            self.sse({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})
            self.sse({"type": "content_block_delta", "index": index,
                      "delta": {"type": "text_delta", "text": decision[1]}})
            self.sse({"type": "content_block_stop", "index": index})
            stop = "end_turn"
        else:
            _, call, name, arguments = decision
            self.sse({"type": "content_block_start", "index": 0,
                      "content_block": {"type": "tool_use", "id": call, "name": name, "input": {}}})
            self.sse({"type": "content_block_delta", "index": 0,
                      "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}})
            self.sse({"type": "content_block_stop", "index": 0})
            stop = "tool_use"
        self.sse({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                  "usage": {"output_tokens": 42}})
        self.sse({"type": "message_stop"})
        self.close_connection = True


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE + ".part", "w") as f:
    f.write(str(server.server_address[1]))
# Renamed whole, so that a reader never sees half a port.
os.replace(PORT_FILE + ".part", PORT_FILE)
server.serve_forever()
