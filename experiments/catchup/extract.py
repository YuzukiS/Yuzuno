#!/usr/bin/env python3
"""Rebuild the deliberately small replay fixture from an immutable, read-only DB.

Only the selected engineering excerpts are exported. No credential, transcript,
or whole-database copy is made. The time windows are analyst-selected replay
windows, not measured periods of user absence.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=HERE / "fixtures.json")
    args = parser.parse_args()
    db = sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    scenarios = json.loads((HERE / "scenarios.json").read_text())
    sources = []
    for scenario in scenarios:
        for selection in scenario.pop("selections"):
            rows = db.execute(
                "SELECT agent_id,root,epoch,seq,at,phase,body FROM trail_touches "
                "WHERE agent_id=? AND at=? AND kind='said'",
                (selection["agentId"], selection["at"]),
            ).fetchall()
            if len(rows) != 1:
                raise ValueError(f"{selection['id']}: expected one source, got {len(rows)}")
            row = rows[0]
            body = row["body"]
            excerpts = []
            for segment in selection["segments"]:
                start = body.index(segment["start"])
                end = body.index(segment["end"], start) + len(segment["end"])
                text = body[start:end]
                excerpts.append({"start": start, "end": end, "text": text})
            sources.append({
                "id": selection["id"],
                "agentId": row["agent_id"],
                "agentLabel": selection["agentLabel"],
                "at": row["at"],
                "phase": row["phase"],
                "evidenceLevel": "agent_report",
                "origin": {
                    "kind": "legacy_trail",
                    "database": "yuzuno.db",
                    "table": "trail_touches",
                    "key": {name: row[name] for name in ("agent_id", "root", "epoch", "seq")},
                    "bodySha256": hashlib.sha256(body.encode()).hexdigest(),
                    "bodyCharacters": len(body),
                },
                "excerpts": excerpts,
            })
        start, end = scenario["window"]["start"], scenario["window"]["end"]
        agent_ids = sorted({s["agentId"] for s in sources if s["id"] in scenario["sourceIds"]})
        placeholders = ",".join("?" for _ in agent_ids)
        rows = db.execute(
            "SELECT phase,count(*) AS n FROM trail_touches WHERE kind='said' "
            f"AND agent_id IN ({placeholders}) AND at>? AND at<=? GROUP BY phase",
            (*agent_ids, start, end),
        ).fetchall()
        scenario["coverage"] = {
            "scope": "selected_excerpts",
            "windowKind": "retrospective_replay",
            "historicalUserReadState": "unknown",
            "structuredRequests": "not_in_this_extract",
            "runtimeState": "not_in_this_extract",
            "allSaidRowsInWindowForSelectedAgents": {row["phase"] or "unknown": row["n"] for row in rows},
            "selectedSourceCount": len(scenario["sourceIds"]),
        }
    result = {
        "schemaVersion": 1,
        "provenance": {
            "source": "local legacy Yuzuno engineering trail",
            "access": "sqlite mode=ro&immutable=1; WAL is deliberately not replayed",
            "capturedOn": "2026-10-12",
            "notACompleteWorkspaceSnapshot": True,
        },
        "sources": sources,
        "scenarios": scenarios,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Exported {len(sources)} excerpts into {len(scenarios)} replay scenarios: {args.output}")


if __name__ == "__main__":
    main()
