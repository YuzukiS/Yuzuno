#!/usr/bin/env python3
"""Reproduce the native unmaterialized-thread error without any model turn."""

import argparse
import json
from pathlib import Path
import tempfile

from probe_local import Rpc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="yuzuno-empty-native-"))
    profile = root / "profile"
    profile.mkdir(mode=0o700)
    (profile / "config.toml").write_text('cli_auth_credentials_store = "file"\n')
    first = Rpc(profile, "empty-first")
    try:
        initialized = first.initialize()
        account = first.call("account/read", {"refreshToken": False})
        if account.get("result", {}).get("account") is not None:
            raise RuntimeError("Expected a fresh unauthenticated profile")
        started = first.call("thread/start", {
            "cwd": str(root), "approvalPolicy": "never", "sandbox": "read-only",
        })
        thread = started["result"]["thread"]["id"]
    finally:
        first.close()
    second = Rpc(profile, "empty-second")
    try:
        reinitialized = second.initialize()
        resumed = second.call("thread/resume", {
            "threadId": thread, "cwd": str(root), "approvalPolicy": "on-request",
            "approvalsReviewer": "user", "sandbox": "workspace-write",
        })
        read = second.call("thread/read", {"threadId": thread, "includeTurns": True})
    finally:
        second.close()
    report = {"root": str(root), "initialize": initialized, "start": started,
              "reinitialize": reinitialized, "resume": resumed, "read": read,
              "authenticated": False, "turnStarted": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"threadId": thread, "resumeError": resumed.get("error"),
                      "readError": read.get("error"), "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
