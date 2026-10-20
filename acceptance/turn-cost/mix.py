#!/usr/bin/env python3
"""T-9: extract real native event sequences from a Core journal, for the fake
runtimes to replay (bench.py --mix). Read-only; run it on a snapshot copy of
the daily database, never on the live file:

  sqlite3 -readonly acceptance/live/core-data/workspace.sqlite ".backup acceptance/turn-cost/data/snapshot.sqlite"
  mix.py --db acceptance/turn-cost/data/snapshot.sqlite

For one Codex and one Claude Agent (by default the ones with the most
journaled native events) it writes the last --count native events, in order,
to data/mix-codex.jsonl and data/mix-claude.jsonl (ignored by git). Codex rows
are app-server notifications (journal kind = method, data = params); Claude
rows are bridge "event" messages (data = the whole message). Left out: what
Core records itself, requests and their resolution (the replay asks its own
approvals), and Turn starts and ends (the replay runs inside one Turn of its
own). The journal's own times are Core's, which fell behind natively in this
data, so replays run as a burst or at a fixed rate instead.
"""
import argparse
import collections
import json
import pathlib
import sqlite3

HERE = pathlib.Path(__file__).resolve().parent

# Kinds Core journals for its own actions, or that the replay produces itself.
SKIP_CODEX = {"turn/started", "turn/completed", "turn/requested", "turn/accepted", "turn/reconfirmed",
              "request", "request/replayed", "request/replied", "request/notSent", "serverRequest/resolved",
              "thread/started", "thread/attached", "thread/reconciled", "thread/imported", "thread/forked",
              "thread/replacementRequested", "thread/settings/updated"}
SKIP_CODEX_PREFIX = ("workspace/", "peer/", "message/", "runtime/", "agent/", "yuzuno/")


def codex_native(kind):
    return kind not in SKIP_CODEX and not kind.startswith(SKIP_CODEX_PREFIX) and not kind.startswith("claude/")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--count", type=int, default=3000)
    p.add_argument("--codex-agent")
    p.add_argument("--claude-agent")
    p.add_argument("--out", default=str(HERE / "data"))
    args = p.parse_args()
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    harness = {}
    for agent_id, data in db.execute("SELECT id, json_extract(data,'$.agent.harness') FROM agents"):
        harness[agent_id] = data or "codex"
    counts = collections.Counter()
    for agent_id, kind, n in db.execute("SELECT agent_id, kind, COUNT(*) FROM journal GROUP BY agent_id, kind"):
        if harness.get(agent_id) == "codex" and codex_native(kind):
            counts[agent_id] += n
        elif harness.get(agent_id) == "claude" and kind.startswith("claude/"):
            counts[agent_id] += n
    pick = {
        "codex": args.codex_agent or max((a for a in counts if harness[a] == "codex"), key=counts.get),
        "claude": args.claude_agent or max((a for a in counts if harness[a] == "claude"), key=counts.get),
    }
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {}
    for name, agent_id in pick.items():
        rows = []
        for seq, kind, data, at in db.execute("SELECT seq, kind, data, at FROM journal WHERE agent_id=? ORDER BY seq DESC", [agent_id]):
            data = json.loads(data)
            if name == "codex":
                if not codex_native(kind):
                    continue
                row = {"seq": seq, "at": at, "method": kind, "params": data}
            else:
                if data.get("type") != "event" or kind == "claude/result":
                    continue
                row = {"seq": seq, "at": at, "event": data["event"]}
            rows.append(row)
            if len(rows) == args.count:
                break
        rows.reverse()
        path = out / f"mix-{name}.jsonl"
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        kinds = collections.Counter(r["method"] if name == "codex" else
                                    "claude/" + r["event"].get("type", "?") + ("/" + r["event"]["subtype"] if r["event"].get("subtype") else "")
                                    for r in rows)
        report[name] = {"agent": agent_id, "events": len(rows), "fromSeq": rows[0]["seq"], "toSeq": rows[-1]["seq"],
                        "bytes": path.stat().st_size, "kinds": dict(kinds.most_common())}
    (out / "mix.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
