#!/usr/bin/env python3
"""Approximate projected record sizes for candidate preview sizes (sizes only)."""
import json
import sqlite3
import sys


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def line_stats(db):
    lines = 0
    total = 0
    for (raw,) in db.execute("SELECT data FROM agents"):
        for turn in json.loads(raw).get("turns", []):
            for item in turn.get("items") or []:
                out = item.get("aggregatedOutput")
                if isinstance(out, str) and len(out) > 8192:
                    tail = out.encode()[-8192:].decode(errors="ignore")
                    lines += tail.count("\n")
                    total += 1
    print(f"lines in an 8 KB tail of outputs >8K: avg {lines / max(total, 1):.0f} over {total} outputs")


def projected(detail, preview, trigger):
    total = 0
    trimmed = 0
    for turn in detail.get("turns", []):
        for key, value in turn.items():
            if key != "items" and not key.startswith("_claude"):
                total += size(value)
        for item in turn.get("items") or []:
            typ = item.get("type")
            item_size = size(item)
            if typ in ("userMessage", "agentMessage", "reasoning", "plan"):
                total += item_size
                continue
            for key, value in item.items():
                s = size(value)
                if s > trigger and key not in ("id", "type"):
                    total += preview + 120  # preview + metadata
                    trimmed += 1
                else:
                    total += s
    for key in ("agent", "pending", "artifacts", "messageReceipts", "contextUsage", "claudeRuntime"):
        total += size(detail.get(key))
    return total, trimmed


def main():
    db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    line_stats(db)
    rows = db.execute("SELECT id, data FROM agents ORDER BY length(data) DESC LIMIT 4").fetchall()
    print(f"{'agent':10} {'full':>10}  " + "  ".join(f"{f'P{p//1024}K/T{t//1024}K':>16}" for p, t in CANDIDATES))
    for agent_id, raw in rows:
        detail = json.loads(raw)
        cells = []
        for p, t in CANDIDATES:
            total, trimmed = projected(detail, p, t)
            cells.append(f"{total/1e6:7.2f}MB/{trimmed:5}")
        print(f"{agent_id[:8]:10} {len(raw.encode())/1e6:8.2f}MB  " + "  ".join(f"{c:>16}" for c in cells))


CANDIDATES = [(4096, 4096), (4096, 8192), (8192, 8192), (8192, 16384), (16384, 16384)]

if __name__ == "__main__":
    main()
