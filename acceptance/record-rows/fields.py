"""Size distribution of top-level Item fields and Turn fields: sizes only."""
import json, sqlite3, sys, collections
db = sqlite3.connect(sys.argv[1])
def size(v):
    return len(v.encode()) if isinstance(v, str) else len(json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode())
by_field = collections.defaultdict(list)
turn_field = collections.defaultdict(list)
item_sizes = []
total = 0
for aid, data in db.execute("SELECT id, data FROM agents"):
    total += len(data.encode())
    for t in json.loads(data)["turns"]:
        for k, v in t.items():
            if k != "items": turn_field[k].append(size(v))
        for i in t["items"]:
            item_sizes.append(size(i))
            for k, v in i.items():
                by_field[(i.get("type"), k)].append(size(v))
rows = sorted(by_field.items(), key=lambda kv: -sum(kv[1]))
print(f"total record bytes {total}")
print("type.field count sum max p50 >1K >4K >8K >16K >64K | bytes>8K bytes>4K bytes>1K")
for (typ, k), s in rows[:30]:
    s.sort(); n = len(s)
    def over(x): return sum(1 for v in s if v > x)
    def bytes_over(x): return sum(v for v in s if v > x)
    print(f"{typ}.{k} {n} {sum(s)} {s[-1]} {s[n//2]} {over(1024)} {over(4096)} {over(8192)} {over(16384)} {over(65536)} | {bytes_over(8192)} {bytes_over(4096)} {bytes_over(1024)}")
print("turn fields")
for k, s in sorted(turn_field.items(), key=lambda kv: -sum(kv[1]))[:10]:
    s.sort(); print(k, len(s), sum(s), s[-1])
item_sizes.sort(); n = len(item_sizes)
print("items", n, "sum", sum(item_sizes), "p50", item_sizes[n//2], "p90", item_sizes[int(n*.9)], "p99", item_sizes[int(n*.99)], "max", item_sizes[-1])
# all fields: share of bytes above thresholds, excluding conversation types
conv = {"userMessage", "agentMessage", "reasoning", "plan"}
for th in (1024, 2048, 4096, 8192, 16384, 32768):
    cnt = b = 0
    for (typ, k), s in by_field.items():
        if typ in conv or k in ("id", "type"): continue
        for v in s:
            if v > th: cnt += 1; b += v
    print(f"threshold {th}: payload rows {cnt}, payload bytes {b} ({100*b/total:.1f}% of records)")
