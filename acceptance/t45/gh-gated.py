#!/usr/bin/python3
"""One-use isolated acceptance gate; all real requests use installed gh."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

lab = Path(os.environ["T45_LAB_DIR"])
args = sys.argv[1:]
method = args[args.index("--method") + 1] if "--method" in args else "GET"
gate = lab / "gate-next-post"
if method != "POST" or not gate.exists():
    os.execv("/usr/sbin/gh", ["gh", *args])
gate.unlink()
started = time.time()
(lab / "write-waiting.json").write_text(json.dumps({"at": started, "method": method}))
while not (lab / "release-write").exists():
    if time.time() - started > 9:
        raise SystemExit("Acceptance gate timed out before remote submission")
    time.sleep(0.05)
# Do not retain request content or authentication. gh reads the same stdin.
result = subprocess.run(["/usr/sbin/gh", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
(lab / "write-result.json").write_text(json.dumps({"at": time.time(), "exitCode": result.returncode, "discardedSuccessfulReply": result.returncode == 0}))
if result.returncode == 0:
    print("HTTP 503: acceptance discarded the successful write reply", file=sys.stderr)
    raise SystemExit(1)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
raise SystemExit(result.returncode)
