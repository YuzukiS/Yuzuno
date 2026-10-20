#!/usr/bin/env python3
"""Read-only SSH capability probe; never bootstraps or changes a remote daemon."""

import argparse
import json
from pathlib import Path
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("target", help="Confirmed Mac mini SSH target, not a guessed address")
    parser.add_argument("--ssh-config", type=Path, help="Explicit OpenSSH config, if required")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.target.startswith("-") or any(c.isspace() for c in args.target):
        parser.error("Expected one SSH destination")
    command = ["ssh"]
    if args.ssh_config:
        command += ["-F", str(args.ssh_config)]
    command += [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
        "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", args.target,
    ]
    # The remote login shell is used to find installed tools. No credentials,
    # settings, running threads, or process environments are requested.
    script = (
        'uname -s; '
        'if command -v codex >/dev/null 2>&1; then codex --version; codex app-server daemon version; '
        'else printf "codex not on remote PATH\\n"; fi; '
        'if command -v claude >/dev/null 2>&1; then claude --version; fi'
    )
    command += ["/bin/zsh -lc " + shlex.quote(script)]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=25)
        report = {"target": args.target, "readOnly": True, "exitCode": result.returncode,
                  "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except subprocess.TimeoutExpired:
        report = {"target": args.target, "readOnly": True, "timeoutSeconds": 25}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
