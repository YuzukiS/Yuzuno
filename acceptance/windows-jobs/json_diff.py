#!/usr/bin/env python3
"""Differential check of the Windows helper's json/jsonl artifact check
(windows_job.cs JsonSyntax and Files.CheckArtifact) against host.py's
check_artifact, the rule local jobs use, on the same bytes.

Each fixture is written here (a folder under --work, on this Linux host) for
host.py, and sent to the test driver json-fixtures.exe (built from
windows_job.cs and json_fixtures.cs), which writes it into its own run folder
on Windows and checks it there. Verdicts are compared by class, not wording:
ok, invalid ("not complete ..."), incomplete (Windows: a stated bound ended
the check), or the exact problem for the shared non-JSON rules (sizes, the
16 MiB bounds, an unterminated last line).

Expected differences are declared per fixture, never inferred: past
JsonSyntax.MaxDepth nesting or MaxIntegerDigits integer digits, Windows says
the check did not complete, whatever this Python does (its own limits depend
on its version). Python's verdict for those is reported as measured.

Usage: json_diff.py --driver <json-fixtures.exe> --windows-root %TEMP%\\<run>
       --work <new folder here> --report <file>
Exit 0 only when every fixture matches or differs exactly as declared.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HOST_PY = Path(__file__).resolve().parents[2] / "core" / "src" / "jobs" / "host.py"
MIB = 1024 * 1024


def fixtures():
    """(name, format, minBytes, bytes, expected difference or None)."""
    out = []

    def add(name, data, fmt="json", minimum=1, differs=None):
        out.append((name, fmt, minimum, data if isinstance(data, bytes) else data.encode("utf-8"), differs))

    # Top-level scalars and whitespace.
    for i, text in enumerate(["1", '"s"', "true", "false", "null", "-0", "1.5e3", " \t\n\r{} \r\n", "[]", "{}"]):
        add(f"scalar-{i}.json", text)
    for i, data in enumerate([b"\x0b{}", b"\x0c{}", b"{}\x00", "\u00a0{}".encode(), b"   ", b"\n", "{}\u2028".encode()]):
        add(f"space-{i}.json", data)
    # Escapes and Unicode.
    for i, text in enumerate(['"\\u00e9"', '"\\ud83d\\ude00"', '"\\ud800"', '"\\udc00x"', '"\\ud800\\u0041"', '"\\/"',
                              '"\\b\\f\\n\\r\\t\\"\\\\"', '"\x7f"', '"é😀"']):
        add(f"escape-ok-{i}.json", text)
    for i, text in enumerate(['"\\x"', '"\\u12"', '"\\uZZZZ"', '"\\ud800\\uZZZZ"', '"a\x01b"', '"a\tb"', '"a\nb"',
                              '"\\U0001F600"', '"\\\'"', '"unterminated']):
        add(f"escape-bad-{i}.json", text)
    # Raw bytes: an encoded surrogate passes (surrogatepass); the rest must decode.
    for i, data in enumerate([b'"\xed\xa0\x80"', b'"\xed\xb0\x80\xed\xa0\x80"', b'"\xc3\xa9"', b'"\xf0\x9f\x98\x80"',
                              b'"\xf4\x8f\xbf\xbf"']):
        add(f"utf8-ok-{i}.json", data)
    for i, data in enumerate([b'"\xff"', b'"\xc3\x28"', b'"\xc0\xaf"', b'"\xe0\x80\xaf"', b'"\xf5\x80\x80\x80"',
                              b'"\xf4\x90\x80\x80"', b'"\xe2\x82', b'"\x80"', b'{}\xc3']):
        add(f"utf8-bad-{i}.json", data)
    # Numbers.
    for i, text in enumerate(["0", "-1", "1E5", "1e-5", "-0.0e-0", "1e400", "-1e400", "123.456", "[1,-2,3.5e+2]",
                              "1" * 4300, "-" + "1" * 4300, "1" * 5000 + ".5", "0." + "1" * 5000]):
        add(f"number-ok-{i}.json", text)
    for i, text in enumerate(["01", "1.", ".5", "+1", "-", "1e", "1e+", "0x10", "1_000", "--1", "1.e5", "\u0661",
                              "[01]", "[1.]", "-.5", "1 2"]):
        add(f"number-bad-{i}.json", text)
    # NaN, Infinity, -Infinity as Python accepts them; nothing like them.
    for i, text in enumerate(["NaN", "Infinity", "-Infinity", "[NaN,-Infinity,Infinity]", '{"a":NaN}']):
        add(f"constant-ok-{i}.json", text)
    for i, text in enumerate(["nan", "-NaN", "+Infinity", "infinity", "Inf", "-Inf", "NaNx", "[-I]"]):
        add(f"constant-bad-{i}.json", text)
    # Byte order marks and the encodings json.detect_encoding picks.
    add("bom-utf8.json", b"\xef\xbb\xbf{}")
    add("bom-utf8-twice.json", b"\xef\xbb\xbf\xef\xbb\xbf{}")
    add("bom-utf16le.json", "\ufeff{\"a\":[1,\"é\"]}".encode("utf-16-le"))
    add("bom-utf16be.json", "\ufeff{\"a\":1}".encode("utf-16-be"))
    add("utf16le-nobom.json", '{"a":1}'.encode("utf-16-le"))
    add("utf16be-nobom.json", '{"a":1}'.encode("utf-16-be"))
    add("bom-utf32le.json", "\ufeff[1]".encode("utf-32-le"))
    add("utf32be-nobom.json", "[1]".encode("utf-32-be"))
    add("utf16le-odd.json", '{"a":1}'.encode("utf-16-le") + b"\x00")
    add("utf16le-lone-surrogate.json", b'"\x00\x00\xd8"\x00')
    add("utf32le-too-high.json", b"\xff\xfe\x00\x00" + b'"\x00\x00\x00' + b"\x00\x00\x11\x00" + b'"\x00\x00\x00')
    add("utf16-two-bytes.json", b"1\x00")
    # Not JSON as Python reads it.
    for i, text in enumerate(["{'a':1}", "[1,]", '{"a":1,}', "{} x", "{}{}", "[1]]", "// c\n{}", '{"a" 1}', '{"a":}',
                              "[1 2]", "{1:2}", "[", '{"a":1', "tru", "nul", "True", "None", "{,}", "[,1]", '{"a":1}garbage']):
        add(f"structure-bad-{i}.json", text)
    add("duplicate-keys.json", '{"a":1,"a":2}')
    add("empty.json", b"")
    add("empty-min0.json", b"", minimum=0)
    # Depth and big integers: Windows states its bounds.
    add("depth-1000.json", "[" * 1000 + "]" * 1000)
    add("depth-1001.json", "[" * 1001 + "]" * 1001, differs="incomplete")
    add("depth-5000.json", "[" * 5000 + "]" * 5000, differs="incomplete")
    add("depth-100000.json", "[" * 100000 + "]" * 100000, differs="incomplete")
    add("depth-1001-then-bad.json", "[" * 1001 + "]" * 1000 + "x")
    add("int-4301.json", "1" * 4301, differs="incomplete")
    add("int-4301-then-bad.json", "[" + "1" * 4301 + ",]")
    # The 16 MiB bound for JSON, shared text.
    add("json-over-16mib.json", b"[" + b"0," * (8 * MIB) + b"0]")
    # JSON lines.
    for i, data in enumerate([b"{}\n[]\n", b"\n\n{}\n", b"\x0b\n{}\n", b"{}\r\n", b"{}\n\xef\xbb\xbf{}\n", b"NaN\n",
                              b"\n", b"1\n\"s\"\n", b"  \t\n{}\n", b"{}\n\x0c\n"]):
        add(f"jsonl-ok-{i}.jsonl", data, fmt="jsonl")
    for i, data in enumerate([b"{}\n[", b"{}", b"{}\n{\n}\n", b"{}\nx\n", b"{} \x0b\n", b"\xff\n", b"[1,]\n"]):
        add(f"jsonl-bad-{i}.jsonl", data, fmt="jsonl")
    add("jsonl-empty.jsonl", b"", fmt="jsonl")
    add("jsonl-int-4301.jsonl", b"1" * 4301 + b"\n{}\n", fmt="jsonl", differs="incomplete")
    add("jsonl-long-line.jsonl", b"[" + b"0," * (8 * MIB + 1) + b"0]", fmt="jsonl")
    add("bytes.bin", bytes(range(256)), fmt="bytes")
    add("bytes-min.bin", b"abc", fmt="bytes", minimum=4)
    return out


def load_host():
    spec = importlib.util.spec_from_file_location("yuzuno_host_check", HOST_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verdict(entry, windows):
    if entry.get("ok") is True:
        return "ok"
    problem = entry.get("problem") or "not verified"
    if windows and entry.get("incomplete") is True:
        return "incomplete"
    if problem.startswith("not complete "):
        return "invalid"
    return "problem: " + problem


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver", required=True)
    parser.add_argument("--windows-root", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    work = Path(args.work)
    work.mkdir(parents=True)
    host = load_host()
    cases = fixtures()
    python = []
    for name, fmt, minimum, data, _ in cases:
        (work / name).write_bytes(data)
        python.append(host.check_artifact(str(work), {"path": name, "format": fmt, "minBytes": minimum}))
    manifest = [{"name": name, "format": fmt, "minBytes": minimum, "base64": base64.b64encode(data).decode()}
                for name, fmt, minimum, data, _ in cases]
    run = subprocess.run([args.driver, args.windows_root], input=json.dumps(manifest).encode(), capture_output=True,
                         timeout=600)
    lines = run.stdout.decode("utf-8", "replace").splitlines()
    digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    sources = {name: digest(HOST_PY.parent / name) for name in ("host.py", "windows_job.cs")}
    sources["json_fixtures.cs"] = digest(Path(__file__).with_name("json_fixtures.cs"))
    report = {"python": sys.version.split()[0], "sources": sources, "driverSha256": digest(args.driver), "driverExit": run.returncode,
              "driverStderr": run.stderr.decode("utf-8", "replace")[-2000:], "fixtures": [], "mismatches": 0}
    if run.returncode != 0 or len(lines) != len(cases) + 1:
        report["error"] = f"driver exit {run.returncode}, {len(lines)} lines for {len(cases)} fixtures"
        Path(args.report).write_text(json.dumps(report, indent=1))
        print(report["error"], file=sys.stderr)
        return 1
    report["windowsRoot"] = json.loads(lines[0])["root"]
    for (name, fmt, minimum, data, differs), mine, line in zip(cases, python, lines[1:]):
        theirs = json.loads(line)
        p, w = verdict(mine, False), verdict(theirs, True)
        expected = differs if differs else p
        same_digest = mine.get("sha256") == theirs.get("sha256")
        # Where Python stops at an error Windows reads past (a declared bound),
        # its entry has no digest or line count to compare.
        match = w == expected and (bool(differs) or (same_digest and mine.get("lines") == theirs.get("lines")))
        report["fixtures"].append({"name": name, "format": fmt, "bytes": len(data), "python": p, "windows": w,
                                   "declaredDifference": differs, "match": match,
                                   "pythonProblem": mine.get("problem"), "windowsProblem": theirs.get("problem"),
                                   "sha256Equal": same_digest, "lines": [mine.get("lines"), theirs.get("lines")]})
        if not match:
            report["mismatches"] += 1
    Path(args.report).write_text(json.dumps(report, indent=1, ensure_ascii=False))
    for f in report["fixtures"]:
        mark = "ok  " if f["match"] else "DIFF"
        print(f"{mark} {f['name']}: python={f['python']} windows={f['windows']}"
              + (f" (declared: {f['declaredDifference']})" if f["declaredDifference"] else ""))
    print(f"{len(cases)} fixtures, {report['mismatches']} mismatches; python {report['python']}")
    return 0 if report["mismatches"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
