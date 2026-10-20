"""Converts a fresh copy of a Workspace database by starting an isolated Core
on it, then checks through the API that every Agent's detail, payloads and
(for imported Codex sessions) history load, and that the detail plus its
payloads give back each record as it was stored before the conversion.

    python3 acceptance/record-rows/check_core.py --core target/debug/yuzuno-workspace \
        --source acceptance/record-rows/data/daily.sqlite --work acceptance/record-rows/data/core-check

The source is only read (SQLite backup API, read-only). Core runs with its
own HOME and CODEX_HOME under --work (the imported sessions' rollouts are
copied there), so nothing it starts can touch the user's native sessions.
Prints sizes, timings and counts only, never record contents.
"""
import argparse, json, os, shutil, signal, sqlite3, subprocess, sys, time, urllib.request, urllib.parse
from pathlib import Path

CODEX = Path.home() / ".local/share/fnm/node-versions/v22.23.2/installation/bin/codex"


def get(port, path):
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=120) as r:
            body = r.read()
            return r.status, json.loads(body), len(body), time.perf_counter() - started
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, json.loads(body or b"null"), len(body), time.perf_counter() - started


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--port", type=int, default=4470)
    a = ap.parse_args()
    assert 4470 <= a.port <= 4479, "use the record-rows port range"
    work = Path(a.work).resolve()
    if work.exists():
        shutil.rmtree(work)
    data, home, codex_home = work / "data", work / "home", work / "codex-home"
    for d in (data, home, codex_home):
        d.mkdir(parents=True)
    src = sqlite3.connect(f"file:{Path(a.source).resolve()}?mode=ro", uri=True)
    dst = sqlite3.connect(data / "workspace.sqlite")
    src.backup(dst)
    dst.close()
    # What each record was before the conversion.
    before = {aid: json.loads(raw) for aid, raw in src.execute("SELECT id, data FROM agents")}
    imports = {aid: tid for aid, tid in src.execute("SELECT agent_id, thread_id FROM codex_imports")}
    src.close()
    native = Path.home() / ".codex"
    for tid in imports.values():
        for f in (native / "sessions").rglob(f"*{tid}*.jsonl"):
            target = codex_home / f.relative_to(native)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
    # How Codex finds those sessions, and its settings; never its credentials.
    if (native / "config.toml").exists():
        shutil.copy2(native / "config.toml", codex_home / "config.toml")
    if (native / "session_index.jsonl").exists():
        with open(native / "session_index.jsonl") as index, open(codex_home / "session_index.jsonl", "w") as out:
            out.writelines(line for line in index if any(tid in line for tid in imports.values()))
    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(codex_home),
               PATH=f"{CODEX.parent}:{os.environ['PATH']}")
    log = open(work / "core.log", "w")
    started = time.perf_counter()
    core = subprocess.Popen([a.core, "--port", str(a.port), "--data-dir", str(data), "--codex", str(CODEX),
                             "--web-dir", str(work / "no-web"), "--cwd", str(work)], env=env, stdout=log, stderr=log)
    try:
        for _ in range(600):
            try:
                status, workspace, _, _ = get(a.port, "/api/workspace")
                if status == 200:
                    agents = workspace["agents"]
                    break
            except OSError:
                pass
            time.sleep(0.1)
        else:
            raise SystemExit("Core did not answer")
        ready = time.perf_counter() - started
        report = {"readyS": round(ready, 2), "agents": []}
        db = sqlite3.connect(f"file:{data / 'workspace.sqlite'}?mode=ro", uri=True)
        layouts = dict(db.execute("SELECT id, layout FROM agents"))
        originals = db.execute("SELECT COUNT(*) FROM agent_originals").fetchone()[0]
        db.close()
        assert {x["id"] for x in agents} == set(before), "every Agent is listed"
        failures = []
        for aid, old in before.items():
            entry = {"agent": aid[:8], "layout": layouts[aid]}
            status, detail, size, took = get(a.port, f"/api/agents/{aid}")
            entry.update(detailStatus=status, detailBytes=size, detailS=round(took, 3))
            if status != 200:
                failures.append(f"{aid[:8]} detail {status}")
                report["agents"].append(entry)
                continue
            old_turns, new_turns = old["turns"], detail["turns"]
            if [t["id"] for t in old_turns] != [t["id"] for t in new_turns]:
                failures.append(f"{aid[:8]} Turns differ")
            items = payloads = turn_payloads = 0
            payload_s = []
            for told, tnew in zip(old_turns, new_turns):
                status, tp, _, took = get(a.port, f"/api/agents/{aid}/turns/{urllib.parse.quote(tnew['id'])}/payload")
                turn_payloads += 1
                if status != 200:
                    failures.append(f"{aid[:8]} turn payload {status}")
                    continue
                for iold, inew in zip(told["items"], tnew["items"]):
                    items += 1
                    trimmed = inew.get("_yuzunoTruncated") or {}
                    for key, value in iold.items():
                        if key in trimmed:
                            continue
                        if inew.get(key) != value:
                            failures.append(f"{aid[:8]} {iold.get('id')} {key} differs in the detail")
                    for key in trimmed:
                        payloads += 1
                        if tp["items"].get(iold["id"], {}).get("fields", {}).get(key) != iold[key]:
                            failures.append(f"{aid[:8]} {iold.get('id')} {key} differs in the Turn payload")
                        q = urllib.parse.urlencode({"turnId": told["id"], "field": key})
                        status, ip, _, took = get(a.port, f"/api/agents/{aid}/items/{urllib.parse.quote(iold['id'])}/payload?{q}")
                        payload_s.append(took)
                        if status != 200 or ip["fields"][key] != iold[key]:
                            failures.append(f"{aid[:8]} {iold.get('id')} {key} item payload {status}")
                if len(told["items"]) != len(tnew["items"]):
                    failures.append(f"{aid[:8]} {told['id']} Item count differs")
            entry.update(turns=len(new_turns), items=items, trimmedFields=payloads, turnPayloads=turn_payloads,
                         itemPayloadMedianS=round(sorted(payload_s)[len(payload_s) // 2], 4) if payload_s else None)
            if aid in imports:
                # The newest page, then the page before the Turns the record holds.
                cursor = (old.get("history") or {}).get("nextCursor")
                for name, query in (("history", ""), ("olderHistory", "?" + urllib.parse.urlencode({"cursor": cursor}) if cursor else None)):
                    if query is None:
                        continue
                    status, page, size, took = get(a.port, f"/api/agents/{aid}/history{query}")
                    entry[name] = {"status": status, "bytes": size, "s": round(took, 2),
                                   "turns": len(page.get("turns", [])) if isinstance(page, dict) else None}
                    if status != 200:
                        failures.append(f"{aid[:8]} {name} {status}: {page}")
            report["agents"].append(entry)
        missing = get(a.port, "/api/agents/nobody/items/x/payload")
        report["unknownAgentPayload"] = [missing[0], missing[1].get("code")]
        report["originalsKept"] = originals
        report["failures"] = failures
    finally:
        core.send_signal(signal.SIGINT)
        try:
            core.wait(timeout=30)
        except subprocess.TimeoutExpired:
            core.terminate()
            core.wait(timeout=10)
        log.close()
    report["backups"] = [p.name for p in data.iterdir() if ".before-record-rows-" in p.name]
    report["coreLog"] = [line.strip() for line in open(work / "core.log") if "Workspace" in line][:20]
    print(json.dumps(report, indent=1, ensure_ascii=False))
    sys.exit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
