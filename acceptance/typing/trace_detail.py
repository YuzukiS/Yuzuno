#!/usr/bin/env python3
"""Details of a T-18 trace: which invalidations reached the whole app, and
which mutations caused them.   trace_detail.py target/t18/traces/LABEL.json"""
import collections
import json
import sys

events = json.load(open(sys.argv[1]))["traceEvents"]
FIELDS = ("nodeName", "reason", "invalidationSet", "invalidatedSelectorId", "changedClass", "changedAttribute",
          "changedPseudo", "changedId", "invalidationList", "selectors")

print("== has / invalidation-set events")
seen = collections.Counter()
for e in events:
    if e.get("name") in ("ScheduleStyleInvalidationTracking", "StyleInvalidatorInvalidationTracking"):
        d = e.get("args", {}).get("data", {})
        seen[json.dumps({k: d[k] for k in FIELDS if d.get(k) is not None}, ensure_ascii=False)[:500]] += 1
for key, n in seen.most_common(10):
    print(n, key)

print("== style recalc reasons by node")
by = collections.Counter()
for e in events:
    if e.get("name") == "StyleRecalcInvalidationTracking":
        d = e["args"]["data"]
        by[(d.get("reason"), d.get("nodeName"))] += 1
for (reason, node), n in by.most_common(20):
    print(n, reason, "|", node)
