#!/usr/bin/env python3
"""Check that a pull request breaks no local Markdown link (T-97).

This is the check a documentation-only pull request gets instead of the
product builds. In every tracked Markdown file, a relative link or image
must name a file or directory tracked in Git, and a #fragment pointing into
Markdown must match one of its headings (GitHub's anchor rules) or an
explicit <a name/id>. External URLs are not fetched.

Both trees are read from Git: the head (HEAD by default) and, with --base,
the base. Only links broken at the head and not at the base fail, so links
that already point at untracked local evidence do not block a docs change,
while a new bad link, a deleted or renamed target, or a changed heading
does. Every tracked Markdown file is read, not only the changed ones.

Usage: docs_links.py [--base REV] [--head REV] [repository-dir]
Prints one GitHub error annotation per newly broken link and exits 1 if any.
"""
import os
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from urllib.parse import unquote

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")
# [text](target "title") and ![alt](target); <target> may hold spaces.
INLINE = re.compile(r"!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
# A link reference definition; a label starting with ^ is a footnote, not a link.
REFERENCE = re.compile(r"^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)")
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
HTML_ANCHOR = re.compile(r"<a\s[^>]*\b(?:name|id)\s*=\s*[\"']([^\"']+)[\"']", re.I)
SCHEME = re.compile(r"\A[a-zA-Z][a-zA-Z0-9+.-]*:")


class Tree:
    """The tracked files of one revision, read from Git rather than the work tree."""

    def __init__(self, repo, rev):
        self.repo, self.rev = repo, rev
        out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "-z", "--name-only", rev],
                             capture_output=True, check=True).stdout
        self.files = [p for p in out.decode().split("\0") if p]
        self.present = set(self.files)
        self.directories = {"/".join(p.split("/")[:i]) for p in self.files for i in range(1, p.count("/") + 1)}
        self.texts = {}

    def text(self, path):
        if path not in self.texts:
            out = subprocess.run(["git", "-C", self.repo, "show", f"{self.rev}:{path}"], capture_output=True, check=True).stdout
            self.texts[path] = out.decode(errors="replace")
        return self.texts[path]


def lines_outside_code(text):
    """(line number, line, line without inline code) for lines outside fenced code."""
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        opened = FENCE.match(line)
        if fence:
            if opened and opened.group(1)[0] == fence[0] and len(opened.group(1)) >= len(fence):
                fence = None
            continue
        if opened:
            fence = opened.group(1)
            continue
        yield number, line, INLINE_CODE.sub("", line)


def slug(heading):
    """GitHub's anchor for a heading: rendered text, lowercased, punctuation dropped, spaces to hyphens."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)  # links and images keep their text
    text = re.sub(r"<[^>]+>", "", text)  # inline HTML
    text = text.replace("`", "")
    text = re.sub(r"(\*\*|__|\*|~~)", "", text)
    kept = "".join(c for c in text.lower() if c in " -_" or unicodedata.category(c)[0] in "LNM")
    return kept.replace(" ", "-")


def anchors(text):
    seen, found = {}, set()
    # Headings keep their inline code: GitHub's anchor includes its text.
    for _, line, _ in lines_outside_code(text):
        heading = HEADING.match(line)
        if heading:
            base = slug(heading.group(2))
            count = seen.get(base, 0)
            seen[base] = count + 1
            found.add(base if count == 0 else f"{base}-{count}")
        found.update(HTML_ANCHOR.findall(line))
    return found


def broken(tree):
    """(source, line, target, message) for every broken local link in the tree."""
    problems = []
    markdown = sorted(p for p in tree.files if p.lower().endswith(".md"))
    for source in markdown:
        for number, _, line in lines_outside_code(tree.text(source)):
            targets = [m.group(1) for m in INLINE.finditer(line)]
            reference = REFERENCE.match(line)
            if reference:
                targets.append(reference.group(1))
            for raw in targets:
                target = raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw
                if not target or SCHEME.match(target) or target.startswith("//"):
                    continue
                path, _, fragment = target.partition("#")
                path = unquote(path.split("?", 1)[0])
                if path:
                    joined = path.lstrip("/") if path.startswith("/") else os.path.join(os.path.dirname(source), path)
                    resolved = os.path.normpath(joined).replace(os.sep, "/")
                    if resolved.startswith("../") or resolved == "..":
                        problems.append((source, number, target, f"{target} points outside the repository"))
                        continue
                    if resolved not in tree.present and resolved.rstrip("/") not in tree.directories:
                        problems.append((source, number, target, f"{target}: {resolved} is not a tracked file or directory"))
                        continue
                else:
                    resolved = source
                if fragment and resolved.lower().endswith(".md") and resolved in tree.present:
                    if unquote(fragment).lower() not in {a.lower() for a in anchors(tree.text(resolved))}:
                        problems.append((source, number, target, f"{target}: no heading or anchor #{fragment} in {resolved}"))
    return markdown, problems


def renames(repo, base, head):
    """Head path to base path, for the files Git sees as renamed between the two."""
    out = subprocess.run(["git", "-C", repo, "diff", "-M", "-z", "--name-status", "--diff-filter=R", base, head],
                         capture_output=True, check=True).stdout
    fields = out.decode().split("\0")
    return {fields[i + 2]: fields[i + 1] for i in range(0, len(fields) - 2, 3) if fields[i].startswith("R")}


def introduced(head_problems, base_problems, renamed=None):
    """Head problems beyond those the base already had, per source file and target.

    A source file renamed by the PR is matched under its base path, so moving
    a document does not turn its existing broken links into new ones."""
    renamed = renamed or {}
    left = Counter((p[0], p[2]) for p in base_problems)
    new = []
    for problem in head_problems:
        key = (renamed.get(problem[0], problem[0]), problem[2])
        if left[key]:
            left[key] -= 1
        else:
            new.append(problem)
    return new


def main(argv):
    args, base, head = argv[1:], None, "HEAD"
    while args and args[0] in ("--base", "--head"):
        if len(args) < 2:
            print("--base and --head need a revision", file=sys.stderr)
            return 2
        if args[0] == "--base":
            base = args[1]
        else:
            head = args[1]
        args = args[2:]
    repo = args[0] if args else "."
    markdown, problems = broken(Tree(repo, head))
    existing = len(problems)
    if base:
        problems = introduced(problems, broken(Tree(repo, base))[1], renames(repo, base, head))
    for source, number, _, message in problems:
        print(f"::error file={source},line={number},title=Broken link::{message}")
    already = existing - len(problems)
    print(f"Checked local links in {len(markdown)} tracked Markdown files at {head}: "
          f"{len(problems)} newly broken" + (f", {already} already broken at {base} (not counted)" if base else "") + ".")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write(f"### Docs\n\nLocal links and anchors in {len(markdown)} tracked Markdown files: "
                      f"{'none newly broken' if not problems else f'{len(problems)} newly broken'}"
                      + (f"; {already} were already broken at the base and are not counted" if base else "")
                      + ". External URLs were not fetched.\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
