#!/usr/bin/env python3
"""Isolated T-117 checks, run as a managed Job. Never writes web/dist."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "target/t117-checks" / os.environ.get("T117_ATTEMPT", "initial")
OUT.mkdir(parents=True, exist_ok=True)
NODE = shutil.which(os.environ.get("YUZUNO_NODE", "node"))
if NODE is None:
    raise RuntimeError("Node was not found: set YUZUNO_NODE or PATH")
phase = sys.argv[1]
env = dict(os.environ, YUZUNO_UI_DIST=str(ROOT / "target/t117-web-dist"))
env["PATH"] = str(Path(NODE).parent) + os.pathsep + env.get("PATH", "")
checks = []


def run(label, argv, cwd=ROOT):
    started = time.monotonic()
    print(f"START {label}", flush=True)
    with (OUT / f"{label}.log").open("w") as log:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    checks.append({"name": label, "exitCode": result.returncode, "seconds": round(time.monotonic() - started, 2)})
    (OUT / f"{phase}.json").write_text(json.dumps({"phase": phase, "checks": checks}, indent=2) + "\n")
    print(f"{'PASS' if result.returncode == 0 else 'FAIL'} {label}", flush=True)
    if result.returncode:
        print((OUT / f"{label}.log").read_text()[-12000:], flush=True)
        sys.exit(result.returncode)


def dependencies(directory, label):
    if not (directory / "node_modules/.package-lock.json").is_file():
        npm = shutil.which("npm", path=env["PATH"])
        if npm is None:
            raise RuntimeError("npm was not found beside Node or on PATH")
        run(label, [npm, "ci", "--no-audit", "--no-fund"], directory)


if phase in ("web", "bridge"):
    runtime = ROOT / "runtimes/claude"
    dependencies(runtime, "bridge-dependencies")
if phase == "web":
    web = ROOT / "web"
    dependencies(web, "dependencies")
    run("typecheck", [NODE, "node_modules/typescript/bin/tsc", "-b", "--noEmit"], web)
    run("validator", [NODE, "--experimental-strip-types", "tools/result-validator.mjs"], web)
    run("bundle", [NODE, "node_modules/vite/bin/vite.js", "build", "--outDir", str(ROOT / "target/t117-web-dist")], web)
    for name in ["brief-contract", "home-ui", "projects-ui"]:
        run(name, [NODE, "--experimental-strip-types", f"tools/{name}.test.mjs"], web)
    run("claude-bridge", [NODE, "--test", "bridge.test.mjs"], ROOT / "runtimes/claude")
elif phase == "bridge":
    run("claude-bridge", [NODE, "--test", "bridge.test.mjs"], runtime)
elif phase in ("core", "browser", "integration"):
    env.setdefault("CARGO_BUILD_JOBS", "4")
    env.setdefault("CARGO_TARGET_DIR", str(ROOT / "target/t117-cargo"))
    if phase == "core":
        for name in ["project_brief", "brief_turns", "claude::tests", "collaboration_mcp::tests"]:
            run(name.replace("::", "-"), ["cargo", "test", "-p", "yuzuno-workspace", "--lib", name, "--", "--test-threads=4"])
    elif phase == "browser":
        run("browser", ["cargo", "test", "-p", "yuzuno-workspace", "--test", "home_editors_ui", "--", "--ignored", "--nocapture"])
    else:
        run("bridge-integration", ["cargo", "test", "-p", "yuzuno-workspace", "--test", "home_editors_bridge", "--", "--nocapture"])
else:
    raise ValueError(f"unknown phase {phase}")
