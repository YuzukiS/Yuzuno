#!/usr/bin/env python3
"""Field-size distribution of Agent records (names and sizes only, no content).

Usage: field_sizes.py <workspace.sqlite> [agent-id]
"""
import json
import sqlite3
import sys
from collections import defaultdict


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def pct(values, p):
    if not values:
        return 0
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * p))]


def main():
    db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    only = sys.argv[2] if len(sys.argv) > 2 else None
    rows = db.execute("SELECT id, data FROM agents").fetchall()
    # (item type, field) -> list of sizes
    fields = defaultdict(list)
    # nested sizes of interest
    nested = defaultdict(list)
    per_agent = []
    for agent_id, raw in rows:
        if only and agent_id != only:
            continue
        detail = json.loads(raw)
        total = len(raw.encode())
        turns = detail.get("turns", [])
        items = [i for t in turns for i in (t.get("items") or [])]
        per_agent.append((agent_id[:8], detail["agent"].get("harness"), total, len(turns), len(items)))
        for turn in turns:
            for key, value in turn.items():
                if key != "items":
                    fields[("<turn>", key)].append(size(value))
        for item in items:
            typ = item.get("type", "?")
            for key, value in item.items():
                fields[(typ, key)].append(size(value))
            if typ == "fileChange":
                for change in item.get("changes") or []:
                    for key, value in change.items():
                        nested[("fileChange.changes[]", key)].append(size(value))
                    nested[("fileChange.changes[]", "<one change>")].append(size(change))
            if typ == "mcpToolCall" and isinstance(item.get("result"), dict):
                for key, value in item["result"].items():
                    nested[("mcpToolCall.result", key)].append(size(value))
            if typ in ("dynamicToolCall", "toolCall", "claudeTool") or "output" in item:
                pass
        for key in ("pending", "artifacts", "messageReceipts", "agent"):
            fields[("<detail>", key)].append(size(detail.get(key)))
    print("agent  harness  bytes  turns  items")
    for row in sorted(per_agent, key=lambda r: -r[2]):
        print(*row)
    print()
    print(f"{'type':24} {'field':28} {'count':>6} {'total':>10} {'p50':>8} {'p90':>8} {'p99':>8} {'max':>9} {'>4K':>5} {'>8K':>5} {'>16K':>5}")
    for (typ, key), sizes in sorted({**fields, **nested}.items(), key=lambda kv: -sum(kv[1])):
        if sum(sizes) < 10_000:
            continue
        print(f"{typ:24} {key:28} {len(sizes):6} {sum(sizes):10} {pct(sizes,.5):8} {pct(sizes,.9):8} {pct(sizes,.99):8} {max(sizes):9} "
              f"{sum(s>4096 for s in sizes):5} {sum(s>8192 for s in sizes):5} {sum(s>16384 for s in sizes):5}")


if __name__ == "__main__":
    main()
