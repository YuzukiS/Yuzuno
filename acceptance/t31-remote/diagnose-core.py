#!/usr/bin/env python3
"""Instrument an isolated runtime copy for one prompt-free Core start.

Stage markers contain no protocol payloads, account information or tokens.
Product sources, existing installed runtimes and global settings are untouched.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "target/t31-remote/diagnostic-runtime"
RUNTIME.mkdir(mode=0o700)
for source in (ROOT / "runtimes/claude").iterdir():
    if source.is_file() and (source.suffix == ".mjs" or source.name in ("package.json", "package-lock.json")):
        shutil.copy2(source, RUNTIME / source.name)
(RUNTIME / "node_modules").symlink_to(ROOT / "runtimes/claude/node_modules")
bridge = (RUNTIME / "bridge.mjs").read_text()
def marker(stage):
    return "process.stderr.write('T31_STAGE " + stage + "\\n');"
for before, after in [
    ("async function main() {", "async function main() { " + marker("main")),
    ("  const bridge = new ClaudeBridge({", "  " + marker("sdk-imported") + "\n  const bridge = new ClaudeBridge({"),
    ("  async start(command) {", "  async start(command) { " + marker("start-command")),
    ("    const thinkingDisplay = supportsThinkingDisplay(probed);", "    " + marker("cli-version") + "\n    const thinkingDisplay = supportsThinkingDisplay(probed);"),
    ("    this.query = this.queryFactory({ prompt: this.queue, options });", "    " + marker("query-create") + "\n    this.query = this.queryFactory({ prompt: this.queue, options });\n    " + marker("query-created")),
    ("          const initialized = await this.query.initializationResult();", "          " + marker("initialization-wait") + "\n          const initialized = await this.query.initializationResult();\n          " + marker("initialized")),
    ("            const result = await this.query.setMcpServers({", "            " + marker("mcp-wait") + "\n            const result = await this.query.setMcpServers({"),
    ("            if (Object.keys(result.errors ?? {}).length", "            " + marker("mcp-returned") + "\n            if (Object.keys(result.errors ?? {}).length"),
]:
    assert bridge.count(before) == 1, before
    bridge = bridge.replace(before, after)
(RUNTIME / "bridge.mjs").write_text(bridge)
host = (RUNTIME / "remote-host.mjs").read_text()
before = "      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);"
assert host.count(before) == 1
host = host.replace(before, before + "\n      for (const line of chunk.toString('utf8').split('\\n')) if (/^T31_STAGE [a-z-]+$/.test(line)) this.log('diagnosticStage', { stage: line.slice(10) });")
(RUNTIME / "remote-host.mjs").write_text(host)
run = Path(os.environ["T31_RUN_DIR"])
env = dict(os.environ, T31_DIAGNOSTIC_BRIDGE=str(RUNTIME / "bridge.mjs"), T31_START_ONLY="1", T31_HARNESSES="claude")
result = subprocess.run(["python3", str(ROOT / "acceptance/t31-remote/native.py")], env=env)
report = json.loads((run / "report.json").read_text())
for agent in report["agents"]:
    key = hashlib.sha256(json.dumps([report["workspaceId"], agent["id"]]).encode()).hexdigest()[:24]
    code = "from pathlib import Path; p=Path.home()/'.yuzuno-next/claude'/" + repr(key) + "/'host.log'; print(p.read_text()[-10000:] if p.exists() else 'no host log')"
    remote = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", env["T31_REMOTE_TARGET"],
        "python3 -c " + shlex.quote(code)], capture_output=True, text=True, timeout=20)
    (run / "remote-stages.log").write_text(remote.stdout)
    print(remote.stdout, end="")
raise SystemExit(result.returncode)
