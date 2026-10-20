#!/usr/bin/env python3
"""Conversation/settings acceptance: port 4347, isolated data, UI and Rust builds.

Reuses the lab's PID/start-time ownership checks. No action targets daily port
4317, its Core, web/dist, or the separate remote/Claude acceptance instances.
"""
import importlib.util
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("slice_lab", root / "scripts/slice-lab.py")
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
lab.LAB = root / "acceptance/interaction-settings"
lab.WEB = lab.LAB / "web-build-src"
lab.DATA = lab.LAB / "core-data"
lab.TASKS = lab.LAB / "tasks"
lab.TARGET = Path("/tmp/yuzuno-interaction-target")
lab.PORT = 4347
lab.BASE = "http://127.0.0.1:4347"
lab.PROCESS = lab.LAB / "core-process.json"
lab.DAILY = lab.LAB / "daily-baseline.json"

if __name__ == "__main__":
    # A restricted sandbox cannot see host PIDs or open a health socket. Keep
    # the original asset hashes, and recover the already recorded daily PID
    # identity instead of treating two empty process lists as verification.
    if lab.DAILY.exists():
        baseline = lab.load(lab.DAILY)
        if not baseline.get("processes"):
            original = lab.load(root / "acceptance/multi-agent/daily-baseline.json")
            baseline["processes"] = original["processes"]
            baseline["processIdentitySource"] = "acceptance/multi-agent/daily-baseline.json; asset hashes remain from this slice"
            lab.save(lab.DAILY, baseline)
    lab.main()
