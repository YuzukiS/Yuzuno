#!/usr/bin/env python3
"""Validate provenance and produce an honest, offline catch-up comparison.

This checks source links and replay boundaries, not semantic correctness or
reading speed. It never calls a model or changes workspace read/pending state.
"""

import argparse
from datetime import datetime
import hashlib
import html
import json
from pathlib import Path
import sqlite3


HERE = Path(__file__).resolve().parent


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def validate(fixtures, candidate):
    errors = []
    sources = {s["id"]: s for s in fixtures["sources"]}
    if len(sources) != len(fixtures["sources"]):
        errors.append("duplicate source ids")
    cases = {s["id"]: s for s in fixtures["scenarios"]}
    if len(cases) != len(fixtures["scenarios"]):
        errors.append("duplicate scenario ids")
    for case in cases.values():
        start, end = timestamp(case["window"]["start"]), timestamp(case["window"]["end"])
        for source_id in case["sourceIds"]:
            source = sources.get(source_id)
            if source is None:
                errors.append(f"{case['id']}: unknown source {source_id}")
            elif not start < timestamp(source["at"]) <= end:
                errors.append(f"{case['id']}: source {source_id} is outside replay window")
    seen_cases = set()
    for result in candidate["scenarios"]:
        case_id = result.get("scenarioId")
        if case_id in seen_cases:
            errors.append(f"duplicate candidate scenario {case_id}")
        seen_cases.add(case_id)
        case = cases.get(case_id)
        if case is None:
            errors.append(f"unknown candidate scenario {case_id}")
            continue
        if set(result) != {"scenarioId", "items", "limitations"}:
            errors.append(f"{case_id}: summary only accepts items and limitations; no state mutations")
        allowed = set(case["sourceIds"])
        for number, item in enumerate(result.get("items", []), 1):
            label = f"{case_id} item {number}"
            if set(item) != {"kind", "text", "sourceIds", "nextSourceId"}:
                errors.append(f"{label}: unexpected or missing fields")
            if item.get("kind") not in {"review", "fyi", "uncertain"}:
                errors.append(f"{label}: summaries cannot create approvals or Pending")
            if not isinstance(item.get("text"), str) or not item["text"].strip():
                errors.append(f"{label}: empty text")
            refs = item.get("sourceIds", [])
            if not refs or not set(refs) <= allowed:
                errors.append(f"{label}: missing, unknown, or cross-window source")
            if item.get("nextSourceId") not in refs:
                errors.append(f"{label}: navigation must point to a cited source")
    if seen_cases != set(cases):
        errors.append("candidate must contain exactly the fixture scenarios")
    return errors


def verify_sources(fixtures, database):
    errors = []
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    for source in fixtures["sources"]:
        origin = source["origin"]
        key = origin["key"]
        row = db.execute(
            "SELECT body,at,phase FROM trail_touches WHERE agent_id=? AND root=? AND epoch=? AND seq=?",
            tuple(key[k] for k in ("agent_id", "root", "epoch", "seq")),
        ).fetchone()
        if not row:
            errors.append(f"{source['id']}: missing original row (retention may have removed it)")
            continue
        body, at, phase = row
        if hashlib.sha256(body.encode()).hexdigest() != origin["bodySha256"]:
            errors.append(f"{source['id']}: body checksum mismatch")
        if at != source["at"] or phase != source["phase"]:
            errors.append(f"{source['id']}: metadata mismatch")
        for excerpt in source["excerpts"]:
            if body[excerpt["start"]:excerpt["end"]] != excerpt["text"]:
                errors.append(f"{source['id']}: excerpt differs from original")
    return errors


def negative_checks(fixtures, reference):
    """Check real failure modes: invented refs, future evidence, state mutation."""
    copy = lambda obj: json.loads(json.dumps(obj))
    checks = []
    invented = copy(reference)
    invented["scenarios"][0]["items"][0]["sourceIds"] = ["invented-evidence"]
    checks.append(("invented source rejected", bool(validate(fixtures, invented))))
    future = copy(fixtures)
    future["sources"][0]["at"] = "2099-01-01T00:00:00Z"
    checks.append(("evidence beyond replay cutoff rejected", bool(validate(future, reference))))
    mutation = copy(reference)
    mutation["scenarios"][0]["markReadThrough"] = "2026-10-12T00:00:00Z"
    checks.append(("summary read-state mutation rejected", bool(validate(fixtures, mutation))))
    approval = copy(reference)
    approval["scenarios"][0]["items"][0]["kind"] = "approval"
    checks.append(("summary-created approval rejected", bool(validate(fixtures, approval))))
    navigation = copy(reference)
    navigation["scenarios"][0]["items"][0]["nextSourceId"] = "ownership-new"
    checks.append(("unrelated navigation rejected", bool(validate(fixtures, navigation))))
    return [{"check": name, "passed": ok} for name, ok in checks]


def build_report(fixtures, candidate, provenance_verified):
    sources = {s["id"]: s for s in fixtures["sources"]}
    results = {s["scenarioId"]: s for s in candidate["scenarios"]}
    lines = [
        "# Catch-up 离线对照", "",
        "这是实施 Agent 手工整理的参考稿，不是独立模型评测，也没有测量用户阅读速度。",
        "窗口为事后选择，原始内容是有明确来源的工程摘录，不是完整对话。",
        "所有未标 final 的内容保持原 phase，不冒充最终回复。Pending 与已读信息未提供，也未被修改。", "",
        f"来源核对：{str(len(fixtures['sources'])) + ' 条原始记录的正文 SHA-256、摘录位置与元数据匹配' if provenance_verified else '未打开旧数据库；仅检查离线 fixture 的结构和引用'}。", "",
    ]
    metrics = []
    for case in fixtures["scenarios"]:
        records = sorted((sources[s] for s in case["sourceIds"]), key=lambda s: (s["at"], s["id"]))
        result = results[case["id"]]
        selected_agents = {s["agentId"] for s in records}
        final_agents = {s["agentId"] for s in records if s["phase"] == "final"}
        raw_chars = sum(len(e["text"]) for s in records for e in s["excerpts"])
        summary_chars = sum(len(item["text"]) for item in result["items"])
        metrics.append({
            "scenarioId": case["id"],
            "selectedRecords": len(records),
            "distinctAgentIds": len(selected_agents),
            "agentsWithExplicitFinal": len(final_agents),
            "sourceExcerptCharacters": raw_chars,
            "referenceCharacters": summary_chars,
            "readingSeconds": None,
            "semanticAccuracy": None,
        })
        lines.extend([
            f"## {case['title']}", "",
            f"回放：{case['window']['start']} — {case['window']['end']}（UTC）", "",
            f"{len(records)} 条摘录、{len(selected_agents)} 个原 Agent ID；仅 {len(final_agents)} 个 ID 有显式 final。旧身份是否重复需另查。", "",
            "### A：原始回复与进展摘录", "",
            "原定的“只列最终回复”在本批导出中覆盖不足。这里保留未标 final 的进展，避免空白被误读为没有变化。", "",
        ])
        for source in records:
            lines.extend([
                f"<a id=\"source-{source['id']}\"></a>", "",
                f"**{source['agentLabel']}** · {source['at']} · phase={source['phase'] or '未知'} · `{source['id']}`", "",
            ])
            for i, excerpt in enumerate(source["excerpts"]):
                if i:
                    lines.extend(["> 〔省略；非连续摘录〕", ""])
                lines.extend("> " + line for line in excerpt["text"].splitlines())
                lines.append("")
        lines.extend(["### B：Catch-up 参考稿", ""])
        labels = {"review": "值得查看", "fyi": "进展", "uncertain": "尚不确定"}
        for item in result["items"]:
            links = " · ".join(f"[{number} · {sources[s]['agentLabel']} · {sources[s]['at'][11:16]}](#source-{s})" for number, s in enumerate(item["sourceIds"], 1))
            lines.extend([f"- **{labels[item['kind']]}：** [{item['text']}](#source-{item['nextSourceId']})", f"  原文来源：{links}", ""])
        lines.extend(["限制：" + "；".join(result["limitations"]), "", "### 计时问答评估（尚未执行）", ""])
        for q, a in zip(case["questions"], case["reviewerAnswers"]):
            lines.extend([f"- 问题：{q}", f"  参考答案：{a}", ""])
    return "\n".join(lines), metrics


def build_html(fixtures, candidate):
    """Portable review sheet: every summary opens its cited original excerpt."""
    esc = html.escape
    sources = {s["id"]: s for s in fixtures["sources"]}
    results = {s["scenarioId"]: s for s in candidate["scenarios"]}
    sections = []
    labels = {"review": "值得查看", "fyi": "进展", "uncertain": "尚不确定"}
    for case in fixtures["scenarios"]:
        case_id = case["id"]
        result = results[case_id]
        backlinks = {}
        items = []
        for number, item in enumerate(result["items"], 1):
            item_id = f"summary-{case_id}-{number}"
            related = esc(" ".join(item["sourceIds"]))
            attributes = f'data-summary="{esc(item_id)}" data-sources="{related}"'
            links = []
            for source_number, sid in enumerate(item["sourceIds"], 1):
                source = sources[sid]
                backlinks.setdefault(sid, []).append(item_id)
                time = source["at"][11:16]
                label = f'{source_number} · {source["agentLabel"]} · {time}'
                links.append(f'<a class="source-link" href="#source-{esc(sid)}" {attributes} aria-label="查看来源 {source_number}：{esc(source["agentLabel"])}，{esc(source["at"])}">{esc(label)} <span aria-hidden="true">↗</span></a>')
            items.append(f'''<article class="summary-card" id="{esc(item_id)}" tabindex="-1">
<span class="kind kind-{esc(item["kind"])}">{esc(labels[item["kind"]])}</span>
<a class="summary-link" href="#source-{esc(item["nextSourceId"])}" {attributes}><p>{esc(item["text"])}</p><span class="open-original">查看主要原文 <span aria-hidden="true">↗</span></span></a>
<nav class="source-links" aria-label="这条整理的全部来源"><span class="source-label">原文来源</span>{"".join(links)}</nav></article>''')
        originals = []
        for sid in case["sourceIds"]:
            source = sources[sid]
            excerpts = []
            for excerpt_number, excerpt in enumerate(source["excerpts"], 1):
                if excerpt_number > 1:
                    excerpts.append('<div class="excerpt-gap">中间内容已省略 · 以下为另一段原文</div>')
                excerpts.append(f'<pre>{esc(excerpt["text"])}</pre>')
            return_link = ""
            if sid in backlinks:
                return_link = f'<a class="return-link" href="#{esc(backlinks[sid][0])}"><span aria-hidden="true">↩</span> 返回整理内容</a>'
            originals.append(f'''<article class="source-card" id="source-{esc(sid)}" tabindex="-1" aria-labelledby="heading-{esc(sid)}">
<div class="source-heading"><b id="heading-{esc(sid)}">{esc(source["agentLabel"])}</b>{return_link}</div>
<small>{esc(source["at"])} · {esc(source["phase"] or "phase 未知")}</small>{"".join(excerpts)}</article>''')
        questions = "".join(f'<details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>' for q, a in zip(case["questions"], case["reviewerAnswers"]))
        limitations = "；".join(result["limitations"])
        sections.append(f'<section><h2>{esc(case["title"])}</h2><small>{esc(case["window"]["start"])} — {esc(case["window"]["end"])}</small><div class="columns"><div><h3>A · 原始摘录</h3>{"".join(originals)}</div><div><h3>B · 离线参考稿</h3>{"".join(items)}<p class="muted">{esc(limitations)}</p><h3>阅读后回答</h3>{questions}</div></div></section>')
    css = (HERE / "comparison.css").read_text()
    script = (HERE / "comparison.js").read_text()
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catch-up · 真实记录对照</title><style>{css}</style></head><body>
<header><span class="eyebrow">YUZUNO · CATCH-UP LAB</span><h1>整理之后，也能回到原文。</h1><p class="navigation-hint">点击整理文字，直接定位主要原文。每条下方保留全部来源，方便逐条核对；在原文里可以返回刚才的整理。</p><p class="muted">4 个事后选择的多 Agent 时间窗口。B 是实施 Agent 整理的参考稿，没有独立模型评测或计时阅读数据。A 是旧 Yuzuno 的原始摘录，并非完整对话；缺失的 final 标记保持未知。跳转只在本页定位，不会打开新 Workspace 会话，也不会改变未读或 Pending。</p></header>
<main>{"".join(sections)}</main><script>{script}</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=HERE / "fixtures.json")
    parser.add_argument("--candidate", type=Path, default=HERE / "reference.json")
    parser.add_argument("--verify-source", type=Path)
    parser.add_argument("--output-dir", type=Path, default=HERE / "output")
    args = parser.parse_args()
    fixtures = json.loads(args.fixtures.read_text())
    candidate = json.loads(args.candidate.read_text())
    errors = validate(fixtures, candidate)
    if args.verify_source:
        errors.extend(verify_sources(fixtures, args.verify_source))
    checks = negative_checks(fixtures, candidate)
    errors.extend(c["check"] for c in checks if not c["passed"])
    if errors:
        raise SystemExit("\n".join(errors))
    report, metrics = build_report(fixtures, candidate, bool(args.verify_source))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "comparison.md").write_text(report)
    (args.output_dir / "comparison.html").write_text(build_html(fixtures, candidate))
    result = {
        "sourceVerification": "passed" if args.verify_source else "not_run",
        "sourceCount": len(fixtures["sources"]),
        "structuralValidation": "passed",
        "negativeChecks": checks,
        "referenceMethod": candidate.get("method", "unspecified"),
        "independentModelEvaluation": "not_run",
        "humanReadingEvaluation": "timed_questionnaire_not_run",
        "readOrPendingMutations": "none; this evaluator only writes comparison artifacts",
        "metrics": metrics,
    }
    (args.output_dir / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
