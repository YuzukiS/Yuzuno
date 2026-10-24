#!/usr/bin/env python3
"""A stand-in for Windows' tailscale.exe (T-185), run as `tailscale.exe` from a
copy: its state is `<copy>.json`, each call is appended to `<copy>.log`.
Answers `status --json`, `serve status --json`, `serve --bg --https=P target`
and `serve --https=P off`. Faults the state names: failAdd, failOff (refused),
failAddTarget (refuses adding that target), lostAdd (added, then no answer),
hangAdd (no answer, nothing added), slow (seconds before any answer).
Used by core/src/remote_access/tests.rs and smoke.py; nothing reaches Tailscale."""
import json, sys, time
STATE, LOG = sys.argv[0] + ".json", sys.argv[0] + ".log"
args = sys.argv[1:]
s = json.load(open(STATE))
open(LOG, "a").write(" ".join(args) + "\n")
time.sleep(s.get("slow", 0))
def save(): json.dump(s, open(STATE, "w"))
serve = s.setdefault("serve", {})
if args == ["status", "--json"]:
    print("﻿" + json.dumps(s["status"])); sys.exit(0)
if args == ["serve", "status", "--json"]:
    print(json.dumps(serve) if serve.get("TCP") else ""); sys.exit(0)
if args[:2] == ["serve", "--bg"] and args[2].startswith("--https="):
    port, target = args[2].split("=")[1], args[3]
    if s.get("failAdd") or s.get("failAddTarget") == target:
        print(s.get("failAdd") or "refused " + target, file=sys.stderr); sys.exit(1)
    if s.get("hangAdd"):
        time.sleep(30); sys.exit(0)
    serve.setdefault("TCP", {})[port] = {"HTTPS": True}
    serve.setdefault("Web", {})[s["status"]["Self"]["DNSName"].rstrip(".") + ":" + port] = {"Handlers": {"/": {"Proxy": target}}}
    save()
    if s.get("lostAdd"):
        s.pop("lostAdd"); save(); time.sleep(30)
    sys.exit(0)
if len(args) == 3 and args[0] == "serve" and args[1].startswith("--https=") and args[2] == "off":
    if s.get("failOff"):
        print(s["failOff"], file=sys.stderr); sys.exit(1)
    port = args[1].split("=")[1]
    serve.get("TCP", {}).pop(port, None)
    for key in [k for k in serve.get("Web", {}) if k.endswith(":" + port)]:
        serve["Web"].pop(key)
    save(); sys.exit(0)
print("unsupported: " + " ".join(args), file=sys.stderr); sys.exit(2)
