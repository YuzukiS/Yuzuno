#!/usr/bin/env python3
"""T-94: whether Claude Code's own automatic continue at a usage limit works
for Yuzuno, read from the installed CLI and SDK (no session, no model):

  python3 acceptance/t94-quota-resume/native.py <evidence.json>

Claude Code 2.1.280 is a Bun binary that embeds its JavaScript. The setting
`autoContinueAtUsageLimit` arms only through a gate that requires an
interactive launch, and a launch is non-interactive with -p/--print or when
stdout is not a terminal. The SDK starts the CLI with stream-json over pipes,
so the gate is closed for every SDK session, Yuzuno's included. Minified names
change between versions, so each fact is found by its code shape and recorded
with its byte offset. Prints a JSON summary; exit 1 if any fact is missing.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SDK = ROOT / "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk"
cli = Path(os.path.realpath(shutil.which("claude") or ""))
data = cli.read_bytes()
sdk = (SDK / "sdk.mjs").read_text()

FACTS = {
    "setting": (data, rb'autoContinueAtUsageLimit:\w+\(\)\.optional\(\)\.describe\("[^"]{0,240}"\)'),
    "interactive": (data, rb'function \w+\(\)\{return \w+\(\)\.host\.launchOptions\.isInteractive\(\)\}'),
    "gate": (data, rb'function (\w+)\(\)\{return (\w+)\(\)&&!\w+\(\)&&!\w+\(\)\}function \w+\(\)\{return \1\(\)&&\w+\(\)\}'),
    "armOnlyRejectedWithReset": (data, rb'function \w+\(e\)\{return e\.status==="rejected"&&e\.resetsAt!==void 0&&Number\.isFinite\(e\.resetsAt\)&&e\.isUsingOverage!==!0&&e\.overageInUse!==!0\}'),
    "nonInteractiveLaunch": (data, rb'function \w+\(t=process\.argv\.slice\(2\)\)\{let e=\w+\("-p",t\)\|\|\w+\("--print",t\)[^}]{0,200}!process\.stdout\.isTTY\}'),
    "sdkStreamJsonArgs": (sdk.encode(), rb'let \w+=\["--output-format","stream-json","--verbose","--input-format","stream-json"\]'),
}
found = {}
for name, (blob, pattern) in FACTS.items():
    m = re.search(pattern, blob, re.S)
    found[name] = {"offset": m.start(), "code": m.group(0).decode("utf-8", "replace")[:400]} if m else None
# The gate's first call is the interactive check named above.
gate, interactive = found["gate"], found["interactive"]
if gate and interactive:
    name = re.match(r"function (\w+)\(\)", interactive["code"]).group(1)
    found["gateRequiresInteractive"] = {"code": f"gate calls {name}()"} if re.search(rf"return {name}\(\)&&", gate["code"]) else None
version = subprocess.run([str(cli), "--version"], capture_output=True, text=True, timeout=60).stdout.strip()
evidence = {
    "cli": str(cli), "cliVersion": version, "cliSha256": hashlib.sha256(data).hexdigest(),
    "sdkVersion": json.loads((SDK / "package.json").read_text())["version"],
    "facts": found,
    "conclusion": "autoContinueAtUsageLimit cannot arm in an SDK (non-interactive) session" if all(found.values()) else "incomplete",
}
Path(sys.argv[1]).write_text(json.dumps(evidence, indent=2))
print(json.dumps({k: evidence[k] for k in ("cliVersion", "sdkVersion", "conclusion")} | {"missing": [k for k, v in found.items() if not v]}))
sys.exit(0 if all(found.values()) else 1)
