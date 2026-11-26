#!/usr/bin/env python3
"""Decide whether a pull request changes only documentation (T-97).

CI runs this first on a same-repository pull request. It prints, and writes
to $GITHUB_OUTPUT, `docs_only=true` only when every change between the PR's
fixed base and head is an added, modified or deleted regular file on the
docs list below. Anything else, and anything this script cannot establish,
gives `docs_only=false`, so the full checks run. It never fails the run for
an uncertain answer; it falls back to the full checks and says why.

The comparison is the merge commit that actions/checkout prepares for the
pull request (HEAD), against its first parent. HEAD's parents must be the
event's base and head SHAs, so the list belongs to that fixed pair. Renames
are split into a deletion and an addition, so both the old and the new path
must be on the list.

Record only (YN-235): for a pull request that is not documentation only, it
also says which jobs the PR might not need, in the summary and as one
`record_only:` line of its log. Nothing reads that answer; every job runs as
before. It names jobs only when every change is a plain change to a web/ file
that Core's CI does not read (see core_reads); any other change, a doubt or
an error records the full checks.

Usage: pr_scope.py <base-sha> <head-sha> [repository-dir]
"""
import json
import os
import posixpath
import re
import shlex
import subprocess
import sys

# Only these paths. Markdown elsewhere (.agents skills, runtime READMEs,
# templates) can change what Agents or contributors do, so it is not here.
DOCS = re.compile(r"\A(?:README\.md|CONTRIBUTING\.md|docs/(?:[^/]+/)*[^/]+\.md)\Z")
# Added, modified or deleted; never a type change, copy or unmerged entry.
STATUSES = {"A", "M", "D"}
# A regular, non-executable file on each side that exists ("000000" is the
# absent side of an addition or deletion). No symlinks or submodules.
MODES = {"100644", "000000"}
SHOWN = 50

# The CI jobs that read nothing under web/ but what core_reads finds: Core
# builds and tests Core (with the result validator built from web/ sources
# and the fixtures its tests name), Lint reads Rust, the bridge
# runtimes/claude. Web UI reads web/; Core macOS does not run for web/.
MIGHT_SKIP = ("Core (build and test)", "Lint (report-only)", "Claude bridge (unit tests)")
# A web/ path where a Rust source names it: in include_str!, include_bytes!,
# concat!(env!("CARGO_MANIFEST_DIR"), ...), a joined path, or a comment.
MENTION = re.compile(r"(?<![\w.-])web/[\w./@+-]*")
# What a JavaScript or TypeScript module of the result validator's build can
# load: static and type imports and re-exports, side-effect imports, dynamic
# import() and require() of one string literal, and new URL(..., import.meta.url).
SPECIFIERS = [
    re.compile(r"""\bfrom\s*(["'])([^"'\n]+)\1"""),
    re.compile(r"""\bimport\s*(["'])([^"'\n]+)\1"""),
    re.compile(r"""\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)"""),
]
# A URL relative to the module: "x.mjs" there is a file next to it.
MODULE_URL = re.compile(r"""\bnew\s+URL\s*\(\s*(["'])([^"'\n]+)\1\s*,\s*import\.meta\.url\s*\)""")
# A load whose target is not one string literal (a variable, a template, a
# resolve hook): what the build reads is then unknown. Written as code is
# (`import(`), so prose such as "an import (a new one)" is not one; an empty
# `import()` is prose too, since code cannot have it.
OPAQUE = re.compile(r"""\b(?:import\((?!\s*\))|require\()(?!\s*(["'])[^"'\n]+\1\s*\))|\bimport\.meta\.resolve\b""")
# Type-only imports and re-exports: TypeScript erases them, so nothing loads
# the module they name. Only these whole forms, so no other import is lost.
TYPE_ONLY = re.compile(r"""\b(?:import|export)\s+type\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s*from\s*(["'])[^"'\n]+\1""")
# The candidates a relative specifier can name: Node needs the exact file,
# the bundler also tries these extensions and index files.
EXTENSIONS = ("", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json",
              "/index.ts", "/index.tsx", "/index.js", "/index.mjs")
SCANNED = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx")
# The package script Core's CI runs to build the validator from web/.
VALIDATOR_SCRIPT = "build:result-validator"


class Unknown(Exception):
    """The change list could not be established; run the full checks."""


def git(repo, *args, ok=(0,)):
    done = subprocess.run(["git", "-C", repo, *args], capture_output=True)
    if done.returncode not in ok:
        detail = done.stderr.decode(errors="replace").strip().splitlines()
        raise Unknown(f"git {args[0]} failed: {detail[-1] if detail else f'exit {done.returncode}'}")
    return done.stdout


def shown(text):
    """A path or message for a log line or the summary, on one line: control
    characters as \\xNN, so a file name cannot start a line of its own (a
    workflow command)."""
    return re.sub(r"[\x00-\x1f\x7f]", lambda m: f"\\x{ord(m.group()):02x}", text)


def code(text):
    """A path as inline code in a Markdown table cell, whatever it contains."""
    escaped = shown(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "<code>" + escaped.replace("|", "&#124;").replace("`", "&#96;") + "</code>"


def parse_raw(data):
    """Entries of `git diff --raw -z --no-renames`: (old mode, new mode, status, path)."""
    if not data:
        return []
    if not data.endswith(b"\0"):
        raise Unknown("the change list is incomplete (no final separator)")
    fields = data[:-1].split(b"\0")
    if len(fields) % 2:
        raise Unknown("the change list is incomplete (a path is missing)")
    entries = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        parts = meta.decode(errors="replace").split(" ")
        if len(parts) != 5 or not parts[0].startswith(":") or not path:
            raise Unknown(f"unexpected change entry {meta!r}")
        old_mode, new_mode, status = parts[0][1:], parts[1], parts[4]
        try:
            name = path.decode()
        except UnicodeDecodeError:
            raise Unknown("a changed path is not valid UTF-8")
        entries.append((old_mode, new_mode, status, name))
    return entries


def plain(entry):
    """An added, modified or deleted regular file."""
    return entry[2] in STATUSES and entry[0] in MODES and entry[1] in MODES


def outside(entries):
    """The entries that are not a plain change to a listed docs file."""
    return [e for e in entries if not plain(e) or not DOCS.match(e[3])]


def listed(entries):
    names = ", ".join(shown(e[3]) for e in entries[:5])
    return names + (f" and {len(entries) - 5} more" if len(entries) > 5 else "")


def decide(repo, base, head):
    """(docs_only, reason, entries) for the checked-out merge commit."""
    try:
        parents = git(repo, "rev-parse", "HEAD^1", "HEAD^2").decode().split()
        if parents != [base, head]:
            raise Unknown(f"the checked-out merge commit's parents {parents} are not the PR's base {base} and head {head}")
        entries = parse_raw(git(repo, "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "HEAD^1", "HEAD"))
    except Unknown as error:
        return False, f"full checks: {error}", []
    if not entries:
        return False, "full checks: no changed files were found, and an empty list is never taken as documentation only", []
    others = outside(entries)
    if others:
        return False, f"full checks: {len(others)} of {len(entries)} changes are not documentation-only ({listed(others)})", entries
    return True, f"documentation only: all {len(entries)} changes are to README.md, CONTRIBUTING.md or Markdown under docs/", entries


def blob(repo, rev, path):
    return git(repo, "cat-file", "blob", f"{rev}:{path}").decode(errors="replace")


def rust_mentions(repo, rev, reads):
    """The web/ paths that Rust sources outside web/ name at rev."""
    found = git(repo, "grep", "-I", "-l", "-z", "-F", "web/", rev, "--", "*.rs", ":(exclude)web/", ok=(0, 1))
    for name in filter(None, found.decode(errors="replace").split("\0")):
        source = name[len(rev) + 1:] if name.startswith(rev + ":") else name
        for mention in MENTION.findall(blob(repo, rev, source)):
            prefix = mention.rstrip("./")
            reads.setdefault(prefix if prefix.startswith("web/") else "web", f"named in {source}")


def validator_inputs(repo, rev, reads):
    """The web/ files the result validator's build loads at rev, from the
    package script CI runs, through every relative import it can follow."""
    files = set(filter(None, git(repo, "ls-tree", "-r", "-z", "--name-only", rev, "--", "web/").decode(errors="replace").split("\0")))
    try:
        command = json.loads(blob(repo, rev, "web/package.json"))["scripts"][VALIDATOR_SCRIPT]
        roots = [posixpath.normpath(posixpath.join("web", word)) for word in shlex.split(command) if word.endswith(SCANNED)]
    except (Unknown, ValueError, KeyError, TypeError) as error:
        raise Unknown(f"web/package.json at {rev} has no readable {VALIDATOR_SCRIPT} script ({type(error).__name__})")
    if not roots or any(root not in files for root in roots):
        raise Unknown(f"the {VALIDATOR_SCRIPT} script at {rev} names no module under web/ that exists")
    queue, seen = [(root, f"the result validator's build runs it ({VALIDATOR_SCRIPT})") for root in roots], set()
    while queue:
        path, why = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        reads.setdefault(path, why)
        if not path.endswith(SCANNED):
            continue
        text = TYPE_ONLY.sub(" ", blob(repo, rev, path))
        if OPAQUE.search(text):
            raise Unknown(f"{path} at {rev} loads a module named by an expression, not a string")
        specs = [spec for pattern in SPECIFIERS for _, spec in pattern.findall(text)]
        for _, spec in MODULE_URL.findall(text):
            specs.append(spec if spec.startswith(("./", "../", "/")) or re.match(r"[a-z][a-z0-9+.-]*:", spec) else "./" + spec)
        for spec in specs:
            for target in resolve(files, path, spec):
                queue.append((target, f"the result validator's build loads it from {path}"))


def resolve(files, importer, spec):
    """The web/ files a specifier in importer can name; [] for a package or a
    Node module (package-lock.json pins those) or a folder (as a URL base)."""
    if spec.startswith(("./", "../")) or spec in (".", ".."):
        base = posixpath.normpath(posixpath.join(posixpath.dirname(importer), re.split(r"[?#]", spec)[0]))
        return [base + ext for ext in EXTENSIONS if base + ext in files]
    if spec.startswith(("/", "#", "~", "@/")) or re.match(r"[a-z][a-z0-9+.-]*:", spec) and not spec.startswith("node:"):
        raise Unknown(f"{importer} loads {shown(spec)!r}, which is neither relative nor a package")
    return []


def core_reads(repo, revs=("HEAD^1", "HEAD")):
    """{web/ path or folder: why} for what Core's CI reads under web/ at the
    base and at the merge commit. Besides these, every file at web/'s top
    level counts as read: npm installs from package.json and package-lock.json
    there, and the bundler may read its config."""
    reads = {}
    for rev in revs:
        rust_mentions(repo, rev, reads)
        validator_inputs(repo, rev, reads)
    return reads


TOP_LEVEL = "a file at web/'s top level"


def top_level(path):
    return path.startswith("web/") and "/" not in path[len("web/"):]


def read_by_core(reads, path):
    """Why Core's CI reads this web/ path, or None."""
    if top_level(path):
        return TOP_LEVEL
    for prefix, why in reads.items():
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + ".") or prefix == "web":
            return why
    return None


def might_skip(repo, entries):
    """(jobs, reason): the jobs this PR might not need. Record only."""
    if not entries:
        return (), "no change list could be established"
    others = [e for e in entries if not e[3].startswith("web/")]
    if others:
        return (), f"{len(others)} of {len(entries)} changes are outside web/ ({listed(others)})"
    odd = [e for e in entries if not plain(e)]
    if odd:
        return (), f"{len(odd)} of {len(entries)} changes are not a plain change to a regular file ({listed(odd)})"
    read = [(e[3], TOP_LEVEL) for e in entries if top_level(e[3])]
    if not read:
        try:
            reads = core_reads(repo)
        except Unknown as error:
            return (), f"what Core's CI reads under web/ could not be established: {error}"
        read = [(e[3], read_by_core(reads, e[3])) for e in entries]
        read = [(path, why) for path, why in read if why]
    if read:
        named = "; ".join(f"{shown(path)} ({why})" for path, why in read[:5])
        more = f"; and {len(read) - 5} more" if len(read) > 5 else ""
        return (), f"{len(read)} of {len(entries)} changes are to web/ files Core's CI reads: {named}{more}"
    return MIGHT_SKIP, f"all {len(entries)} changes are to web/ files that Core's CI does not read"


def summary(docs_only, reason, entries, base, head, record=None):
    lines = [
        "### Change scope",
        "",
        f"**{'Documentation only' if docs_only else 'Full checks'}.** {reason[0].upper() + reason[1:]}.",
        "",
        f"Base `{base}`, head `{head}`.",
    ]
    if docs_only:
        lines += ["", "Core, Lint, Web UI and Claude bridge are skipped and did not run; the Docs job checks the Markdown links instead."]
    if record is not None:
        jobs, why = record
        lines += ["", "#### Might not be needed (record only)", ""]
        if jobs:
            lines.append(f"**{', '.join(jobs)}.** {why[0].upper() + why[1:]}.")
        else:
            lines.append(f"**None.** {why[0].upper() + why[1:]}.")
        lines += ["", "Every job ran as before: this is recorded for the R-47 trial and decides nothing."]
    if entries:
        lines += ["", "| Status | Path |", "| --- | --- |"]
        lines += [f"| {e[2]} | {code(e[3])} |" for e in entries[:SHOWN]]
        if len(entries) > SHOWN:
            lines.append(f"| | and {len(entries) - SHOWN} more |")
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) not in (3, 4):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    base, head = argv[1], argv[2]
    repo = argv[3] if len(argv) == 4 else "."
    docs_only, reason, entries = decide(repo, base, head)
    record = None if docs_only else might_skip(repo, entries)
    print(f"docs_only={'true' if docs_only else 'false'}: {reason}")
    for entry in entries:
        print(f"  {entry[2]} {shown(entry[3])}")
    if record is not None:
        jobs, why = record
        print(f"record_only: might_skip={','.join(jobs) or 'none'}: {why}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(f"docs_only={'true' if docs_only else 'false'}\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write(summary(docs_only, reason, entries, base, head, record))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
