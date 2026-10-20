#!/usr/bin/env python3
"""Read-only prerequisites for the next real-machine acceptance run.

Only official login-status commands are run. This does not read credentials,
send model requests, connect to SSH, or touch an existing daemon/session. Socket
checks bind ephemeral local endpoints and close them immediately.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def command(argv: list[str], env: dict[str, str] | None = None) -> dict:
    try:
        completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=20)
        return {"exitCode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
    except (OSError, subprocess.TimeoutExpired) as error:
        # Do not serialize exception argv or arbitrary CLI diagnostics.
        return {"errorType": type(error).__name__}


def socket_checks() -> dict:
    checks = {}
    with tempfile.TemporaryDirectory(prefix="yuzuno-preflight-") as directory:
        for label, family, address in (
            ("unix", socket.AF_UNIX, str(Path(directory) / "check.sock")),
            ("tcp", socket.AF_INET, ("127.0.0.1", 0)),
        ):
            try:
                with socket.socket(family, socket.SOCK_STREAM) as connection:
                    connection.bind(address)
                    connection.listen(1)
                checks[label] = {"available": True}
            except OSError as error:
                checks[label] = {"available": False, "errno": error.errno, "reason": error.strerror}
    return checks


def claude_status(config_dir: Path | None, labels: dict[str, str]) -> dict:
    environment = dict(os.environ, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
    environment.pop("CLAUDE_CONFIG_DIR", None)
    if config_dir is not None:
        environment["CLAUDE_CONFIG_DIR"] = str(config_dir)
    result = command(["claude", "auth", "status", "--json"], environment)
    output = {"requestedConfigDir": str(config_dir) if config_dir else None,
              "exitCode": result.get("exitCode")}
    try:
        status = json.loads(result.get("stdout", ""))
    except json.JSONDecodeError:
        return dict(output, errorType=result.get("errorType", "InvalidStatusJson"))
    for key in ("loggedIn", "authMethod", "apiProvider", "subscriptionType", "configDirectory", "projectsDirectory"):
        output[key] = status.get(key)
    email = status.get("email")
    # Report equality only. No email, organization identifier, token, or stable
    # hash of personal information is written to the result artifact.
    if email:
        labels.setdefault(email, f"account-{len(labels) + 1}")
        output["reportedAccount"] = labels[email]
    else:
        output["reportedAccount"] = None
    if output.get("configDirectory"):
        output["canonicalConfigDirectory"] = str(Path(output["configDirectory"]).resolve())
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude-config-dir", type=Path, action="append", default=[])
    parser.add_argument("--ssh-target", help="An already-established target; ssh -G does not connect")
    parser.add_argument("--ssh-config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "kind": "read-only-live-acceptance-preflight", "socket": socket_checks()}
    for harness in ("codex", "claude"):
        result = command([harness, "--version"])
        report[harness + "Version"] = result.get("stdout", "").strip()[:120] or result.get("errorType")
    login = command(["codex", "login", "status"])
    # The official status command writes its result to stderr in current Codex.
    login_text = login.get("stdout", "") + login.get("stderr", "")
    report["codexLogin"] = {"exitCode": login.get("exitCode"),
                            "loggedIn": "Logged in" in login_text,
                            "authMethod": "chatgpt" if "Logged in using ChatGPT" in login_text else "other-or-unavailable"}
    labels: dict[str, str] = {}
    profiles = [claude_status(None, labels)]
    profiles += [claude_status(path, labels) for path in args.claude_config_dir]
    report["claudeProfiles"] = profiles
    aliases = []
    for left in range(len(profiles)):
        for right in range(left + 1, len(profiles)):
            a, b = profiles[left], profiles[right]
            if a.get("canonicalConfigDirectory") and a.get("canonicalConfigDirectory") == b.get("canonicalConfigDirectory"):
                aliases.append({"profileIndexes": [left, right], "samePhysicalDirectory": True,
                                "reportedAccountMismatch": a.get("reportedAccount") != b.get("reportedAccount")})
    report["claudeDirectoryAliases"] = aliases
    report["accountLimit"] = "Login-status identity is local metadata; this run does not verify token ownership or two-account model execution."
    if args.ssh_target:
        if args.ssh_target.startswith("-") or any(character.isspace() for character in args.ssh_target):
            parser.error("Expected one established SSH destination")
        argv = ["ssh"]
        if args.ssh_config:
            argv += ["-F", str(args.ssh_config)]
        result = command(argv + ["-G", args.ssh_target])
        wanted = {"user", "hostname", "port", "proxyjump"}
        config = {}
        for line in result.get("stdout", "").splitlines():
            key, separator, value = line.partition(" ")
            if separator and key in wanted:
                config[key] = value
        report["sshConfiguration"] = {"target": args.ssh_target, "connected": False,
                                      "exitCode": result.get("exitCode"), "effective": config}
    report["liveChecks"] = {name: {"status": "not-run"} for name in (
        "successfulCodexModelTurn", "realToolApprovalRoundtrip", "macMiniDisconnectReconnect",
        "remotePendingRequestRecovery", "claudeTwoAccountSessionIsolation")}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"report": str(args.output), "socket": report["socket"],
                      "claudeDirectoryAliases": aliases, "liveChecks": report["liveChecks"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
