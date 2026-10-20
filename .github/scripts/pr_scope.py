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

Usage: pr_scope.py <base-sha> <head-sha> [repository-dir]
"""
import os
import re
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


class Unknown(Exception):
    """The change list could not be established; run the full checks."""


def git(repo, *args):
    done = subprocess.run(["git", "-C", repo, *args], capture_output=True)
    if done.returncode != 0:
        detail = done.stderr.decode(errors="replace").strip().splitlines()
        raise Unknown(f"git {args[0]} failed: {detail[-1] if detail else f'exit {done.returncode}'}")
    return done.stdout


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


def outside(entries):
    """The entries that are not a plain change to a listed docs file."""
    return [
        e for e in entries
        if e[2] not in STATUSES or e[0] not in MODES or e[1] not in MODES or not DOCS.match(e[3])
    ]


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
        names = ", ".join(e[3] for e in others[:5]) + (f" and {len(others) - 5} more" if len(others) > 5 else "")
        return False, f"full checks: {len(others)} of {len(entries)} changes are not documentation-only ({names})", entries
    return True, f"documentation only: all {len(entries)} changes are to README.md, CONTRIBUTING.md or Markdown under docs/", entries


def summary(docs_only, reason, entries, base, head):
    lines = [
        "### Change scope",
        "",
        f"**{'Documentation only' if docs_only else 'Full checks'}.** {reason[0].upper() + reason[1:]}.",
        "",
        f"Base `{base}`, head `{head}`.",
    ]
    if docs_only:
        lines += ["", "Core, Lint, Web UI and Claude bridge are skipped and did not run; the Docs job checks the Markdown links instead."]
    if entries:
        lines += ["", "| Status | Path |", "| --- | --- |"]
        lines += [f"| {e[2]} | `{e[3]}` |" for e in entries[:SHOWN]]
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
    print(f"docs_only={'true' if docs_only else 'false'}: {reason}")
    for entry in entries:
        print(f"  {entry[2]} {entry[3]}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(f"docs_only={'true' if docs_only else 'false'}\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write(summary(docs_only, reason, entries, base, head))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
