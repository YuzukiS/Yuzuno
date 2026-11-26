#!/usr/bin/env python3
"""Summarize a `cargo build --timings` report in the job's summary (YN-235).

Core macOS builds with `cargo build --locked --all-targets --timings`, and
Cargo writes target/cargo-timings/cargo-timing.html. This reads the unit data
that page embeds and writes a summary to $GITHUB_STEP_SUMMARY, and the same
figures as one `cargo-timings-json:` line to the log, for reading runs later.
The report itself is not uploaded: the workflow uploads nothing.

A unit is one compilation of one target (a library, its tests, a binary, an
integration test, an example, a build script) or one build script run. The
data says, for each unit, when it started and how long it took; for a
library, rustc's own split of that time into frontend (parsing, macro
expansion, type and borrow checking, up to its metadata) and codegen (LLVM
and the object files); and over the build, how many units compiled at once
and the CPU use Cargo sampled. It does not split off linking: for a binary,
an integration test or a library's tests, compiling and linking are one
duration. Workspace packages are the ones with test, binary or example units,
which --all-targets builds only for them; the rest are dependencies.

It never fails the step: a missing or unrecognized report is written as such,
with a warning on the run.

Usage: cargo_timings.py <cargo-timing.html>
"""
import json
import os
import re
import sys

DATA = re.compile(r"^\s*const (UNIT_DATA|CONCURRENCY_DATA|CPU_USAGE) = (.*?);\s*$", re.M | re.S)
FIELD = re.compile(r"<td>([A-Za-z ]+):</td>\s*<td>(.*?)</td>", re.S)
# The target part of a unit: ` name "kind"`, with ` (test)` for a test build.
TARGET = re.compile(r'\A (?:\S+ )?"([\w-]+)"( \(test\))?\Z')
SLOWEST = 15
KINDS = {  # kind: what the summary calls it, in this order
    "lib": "library",
    "lib test": "library's tests",
    "integration test": "integration tests",
    "bin": "binaries",
    "bin test": "binaries' tests",
    "example": "examples",
    "bench": "benchmarks",
    "build script": "build script (compiled)",
    "build script run": "build script (run)",
    "other": "other units",
}
BUILT_ONLY_FOR_WORKSPACE = {"lib test", "integration test", "bin", "bin test", "example", "bench"}


class Unrecognized(Exception):
    """The report is not the format this reads."""


def text(value):
    """Cargo's names as Markdown text: one line, no markup."""
    value = re.sub(r"[\x00-\x1f\x7f]", "?", str(value))
    return re.sub(r"([\\`*_{}\[\]<>()#+!|~])", r"\\\1", value)


def seconds(value):
    return f"{value:,.1f} s"


def kind_of(unit):
    target = unit.get("target", "")
    if unit.get("mode") == "run-custom-build" or target.strip() == "build-script (run)":
        return "build script run"
    if target.strip() == "build-script":
        return "build script"
    if target == "":
        return "lib"
    match = TARGET.match(target)
    if not match:
        return "other"
    kind, test = match.group(1), bool(match.group(2))
    if kind in ("lib", "rlib", "proc-macro"):
        return "lib test" if test else "lib"
    if kind == "bin":
        return "bin test" if test else "bin"
    if kind == "test":
        return "integration test"
    if kind in ("example", "bench"):
        return kind
    return "other"


def parse(html):
    data = {name: body for name, body in DATA.findall(html)}
    if "UNIT_DATA" not in data:
        raise Unrecognized("no UNIT_DATA in the report")
    try:
        units = json.loads(data["UNIT_DATA"])
        concurrency = json.loads(data.get("CONCURRENCY_DATA", "[]"))
        cpu = json.loads(data.get("CPU_USAGE", "[]"))
    except ValueError as error:
        raise Unrecognized(f"the report's data is not JSON ({error})")
    if not isinstance(units, list) or not all(isinstance(u, dict) and "start" in u and "duration" in u for u in units):
        raise Unrecognized("UNIT_DATA is not a list of units with a start and a duration")
    # Every field but Targets, which lists each target and is long for Core.
    fields = {name.strip(): re.sub(r"<br>", "; ", value).strip() for name, value in FIELD.findall(html) if name.strip() != "Targets"}
    return units, concurrency, cpu, fields


def sections_of(unit):
    """{section: seconds} from rustc's section timings, or {}."""
    found = {}
    for item in unit.get("sections") or []:
        try:
            name, span = item
            found[str(name)] = found.get(str(name), 0.0) + max(0.0, float(span["end"]) - float(span["start"]))
        except (TypeError, ValueError, KeyError):
            continue
    return found


def busy(concurrency, end):
    """{units compiling at once: [seconds, seconds with a unit waiting for a job slot]}."""
    spans = {}
    samples = sorted((s for s in concurrency if isinstance(s, dict) and "t" in s), key=lambda s: s["t"])
    for this, after in zip(samples, samples[1:] + [{"t": end}]):
        length = max(0.0, float(after["t"]) - float(this["t"]))
        span = spans.setdefault(int(this.get("active", 0)), [0.0, 0.0])
        span[0] += length
        if int(this.get("waiting", 0)) > 0:
            span[1] += length
    return spans


def summarize(units, concurrency, cpu, fields):
    workspace = {(u.get("name"), u.get("version")) for u in units if kind_of(u) in BUILT_ONLY_FOR_WORKSPACE}
    end = max((float(u["start"]) + float(u["duration"]) for u in units), default=0.0)
    groups = {}
    for unit in units:
        kind = kind_of(unit)
        owner = unit.get("name") if (unit.get("name"), unit.get("version")) in workspace else None
        group = groups.setdefault((owner, kind), {"units": 0, "built": 0, "seconds": 0.0, "sections": {}, "longest": None})
        group["units"] += 1
        duration = float(unit["duration"])
        if duration > 0:
            group["built"] += 1
        group["seconds"] += duration
        for name, length in sections_of(unit).items():
            group["sections"][name] = group["sections"].get(name, 0.0) + length
        if group["longest"] is None or duration > group["longest"][1]:
            group["longest"] = (label(unit), duration)
    order = list(KINDS)
    rows = sorted(groups.items(), key=lambda item: (item[0][0] is None, item[0][0] or "", order.index(item[0][1])))
    spans = busy(concurrency, end)
    samples = [(float(t), float(p)) for t, p in (s for s in cpu if isinstance(s, (list, tuple)) and len(s) == 2)]
    libs = [u for u in units if kind_of(u) == "lib" and (u.get("name"), u.get("version")) in workspace]
    return {
        "wall": round(end, 1),
        "fields": fields,
        "groups": [{"package": owner, "kind": kind, "units": g["units"], "built": g["built"], "seconds": round(g["seconds"], 1),
                    "sections": {k: round(v, 1) for k, v in g["sections"].items()},
                    "longest": g["longest"] and {"unit": g["longest"][0], "seconds": round(g["longest"][1], 1)}}
                   for (owner, kind), g in rows],
        "concurrency": {str(k): {"seconds": round(v[0], 1), "waiting": round(v[1], 1)} for k, v in sorted(spans.items())},
        "cpuMean": round(sum(p for _, p in samples) / len(samples), 1) if samples else None,
        "workspaceLibraries": [{"unit": label(u), "start": round(float(u["start"]), 1), "seconds": round(float(u["duration"]), 1),
                                "end": round(float(u["start"]) + float(u["duration"]), 1),
                                "sections": {k: round(v, 1) for k, v in sections_of(u).items()}} for u in libs],
        "slowest": [{"unit": label(u), "kind": kind_of(u), "start": round(float(u["start"]), 1), "seconds": round(float(u["duration"]), 1),
                     "sections": {k: round(v, 1) for k, v in sections_of(u).items()}}
                    for u in sorted(units, key=lambda u: -float(u["duration"]))[:SLOWEST] if float(u["duration"]) > 0],
        "linkSplit": any(sections_of(u) and kind_of(u) in BUILT_ONLY_FOR_WORKSPACE for u in units),
    }


def label(unit):
    return f"{unit.get('name')} {unit.get('version')}{unit.get('target', '')}"


def markdown(result):
    fields = result["fields"]
    lines = ["### Cargo build timings", "",
             f"**{seconds(result['wall'])}** from the first unit's start to the last one's end. "
             f"Units: {text(fields.get('Dirty units', '?'))} built, {text(fields.get('Fresh units', '?'))} fresh "
             f"(the Rust cache restored them); concurrency at most {text(fields.get('Max concurrency', '?'))}.", ""]
    lines += ["| Package | Units | Built | Unit time | Of which | Longest |", "| --- | --- | ---: | ---: | --- | --- |"]
    for g in result["groups"]:
        owner = f"{text(g['package'])}: {KINDS[g['kind']]}" if g["package"] else f"dependencies: {KINDS[g['kind']]}"
        split = ", ".join(f"{text(k)} {seconds(v)}" for k, v in g["sections"].items())
        longest = f"{text(g['longest']['unit'])} ({seconds(g['longest']['seconds'])})" if g["longest"] and g["longest"]["seconds"] else ""
        lines.append(f"| {owner} | {g['units']} | {g['built']} | {seconds(g['seconds'])} | {split} | {longest} |")
    lines += ["", "Unit times overlap, so they add up to more than the build took."]
    if result["workspaceLibraries"]:
        lines += [""]
        for lib in result["workspaceLibraries"]:
            split = ", ".join(f"{text(k)} {seconds(v)}" for k, v in lib["sections"].items())
            lines.append(f"- **{text(lib['unit'])}** ran from {seconds(lib['start'])} to {seconds(lib['end'])}"
                         + (f" ({split})" if split else "") + f"; the build went on for {seconds(max(0.0, result['wall'] - lib['end']))} after it.")
    if result["concurrency"]:
        lines += ["", "| Units compiling at once | Time | Share | With a unit waiting for a job slot |", "| ---: | ---: | ---: | ---: |"]
        total = sum(v["seconds"] for v in result["concurrency"].values()) or 1.0
        for active, v in result["concurrency"].items():
            lines.append(f"| {active} | {seconds(v['seconds'])} | {100 * v['seconds'] / total:.0f}% | {seconds(v['waiting'])} |")
    if result["cpuMean"] is not None:
        lines += ["", f"Mean CPU use over the build, as Cargo sampled it: {result['cpuMean']:.0f}%."]
    lines += ["", f"<details><summary>The {len(result['slowest'])} slowest units</summary>", "",
              "| Unit | Kind | Start | Time | Of which |", "| --- | --- | ---: | ---: | --- |"]
    for u in result["slowest"]:
        split = ", ".join(f"{text(k)} {seconds(v)}" for k, v in u["sections"].items())
        lines.append(f"| {text(u['unit'])} | {KINDS[u['kind']]} | {seconds(u['start'])} | {seconds(u['seconds'])} | {split} |")
    lines += ["", "</details>", ""]
    if not result["linkSplit"]:
        lines.append("A library's time is split into rustc's frontend and codegen. For binaries, integration tests and a "
                     "library's tests the report has one time that includes compiling and linking; it cannot tell the two apart.")
    rustc = fields.get("rustc", "").split(";")[0] or "rustc unknown"
    lines.append(f"Read from Cargo's timing report ({text(rustc)}); the report itself is not uploaded.")
    return "\n".join(lines) + "\n"


def write_summary(body):
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write(body)


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8", errors="replace") as f:
            result = summarize(*parse(f.read()))
    # Report-only: whatever goes wrong here is said, and the job goes on.
    except Exception as error:  # noqa: BLE001
        reason = re.sub(r"[\x00-\x1f\x7f]", " ", f"{type(error).__name__}: {error}")
        print(f"::warning title=Cargo timings::no summary: {reason}")
        write_summary(f"### Cargo build timings\n\nNo summary: {text(reason)}.\n")
        return 0
    print("cargo-timings-json: " + json.dumps(result, separators=(",", ":")))
    write_summary(markdown(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
