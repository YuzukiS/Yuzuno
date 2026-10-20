#!/usr/bin/env python3
"""Check the repository's Agent skills: one source per skill in .agents/skills,
loadable by Codex and Claude Code.

- SKILL.md frontmatter uses only keys both Harnesses accept, and its name
  matches its folder.
- Relative links in a skill's Markdown files resolve, including #anchors.
- .claude/skills/<name> is a link to the same folder, not a second copy.

With --codex, also ask the installed Codex app-server which skills it finds
from the repository (no model call).
"""
import json
import os
import pathlib
import re
import subprocess
import sys

KEYS = {"name", "description", "license", "allowed-tools", "metadata"}
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")


def frontmatter(text):
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return None, "missing frontmatter"
    try:
        import yaml  # Optional: the same parser Codex's validator uses.
    except ImportError:
        yaml = None
    if yaml:
        try:
            data = yaml.safe_load(match.group(1))
        except yaml.YAMLError as error:
            return None, f"invalid YAML: {error}"
        return (data, None) if isinstance(data, dict) else (None, "frontmatter is not a mapping")
    data = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.startswith((" ", "\t")):
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        # A plain YAML scalar cannot contain ": " or " #".
        if value and value[0] not in "'\"|>" and (": " in value or " #" in value):
            return None, f"{key}: quote this value"
        data[key.strip()] = value.strip("'\"")
    return data, None


def anchors(text):
    slugs = set()
    for heading in re.findall(r"^#+\s+(.+)$", text, re.MULTILINE):
        slug = re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")
        slugs.add(slug)
    return slugs


def check(root):
    root = pathlib.Path(root)
    problems = []
    sources = root / ".agents" / "skills"
    skills = sorted(p for p in sources.iterdir() if p.is_dir()) if sources.is_dir() else []
    for skill in skills:
        entry = skill / "SKILL.md"
        if not entry.is_file():
            problems.append(f"{skill.name}: no SKILL.md")
            continue
        data, error = frontmatter(entry.read_text(encoding="utf-8"))
        if error:
            problems.append(f"{skill.name}: {error}")
            continue
        if set(data) - KEYS:
            problems.append(f"{skill.name}: frontmatter keys {sorted(set(data) - KEYS)} are not accepted by Codex")
        name, description = str(data.get("name", "")), str(data.get("description", "")).strip()
        if name != skill.name or not NAME.match(name) or len(name) > 64:
            problems.append(f"{skill.name}: name must be the folder name in hyphen-case")
        if not description or len(description) > 1024 or "<" in description or ">" in description:
            problems.append(f"{skill.name}: description must be 1–1024 characters without angle brackets")
        for page in sorted(skill.rglob("*.md")):
            for target in LINK.findall(page.read_text(encoding="utf-8")):
                if re.match(r"^[a-z]+:", target):
                    continue
                path, _, anchor = target.partition("#")
                linked = (page.parent / path).resolve() if path else page
                if not linked.is_file():
                    problems.append(f"{page.relative_to(root)}: broken link {target}")
                elif anchor and anchor not in anchors(linked.read_text(encoding="utf-8")):
                    problems.append(f"{page.relative_to(root)}: missing anchor {target}")
        link = root / ".claude" / "skills" / skill.name
        if not link.is_symlink() or os.readlink(link) != f"../../.agents/skills/{skill.name}":
            problems.append(f".claude/skills/{skill.name}: must be a link to ../../.agents/skills/{skill.name}")
    claude = root / ".claude" / "skills"
    for extra in sorted(claude.iterdir()) if claude.is_dir() else []:
        if not (sources / extra.name).is_dir():
            problems.append(f".claude/skills/{extra.name}: has no source in .agents/skills")
    return [p.name for p in skills], problems


def codex_skills(root, codex="codex"):
    """Skills the installed Codex app-server discovers for `root` (scope repo)."""
    proc = subprocess.Popen([codex, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
        def call(id, method, params):
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
            for line in proc.stdout:
                message = json.loads(line)
                if message.get("id") == id:
                    return message
            raise RuntimeError("Codex app-server closed")
        call(1, "initialize", {"clientInfo": {"name": "skill_check", "title": "Skill check", "version": "0"},
                               "capabilities": {"experimentalApi": True}})
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized"}) + "\n")
        proc.stdin.flush()
        reply = call(2, "skills/list", {"cwds": [str(root)], "forceReload": True})
        entry = reply["result"]["data"][0]
        return {s["name"]: s["path"] for s in entry["skills"] if s["scope"] == "repo"}, entry["errors"]
    finally:
        proc.kill()


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    names, problems = check(root)
    if "--codex" in sys.argv:
        found, errors = codex_skills(root)
        problems += [f"Codex: {json.dumps(e)}" for e in errors]
        for name in names:
            if pathlib.Path(found.get(name, "")).resolve() != (root / ".agents/skills" / name / "SKILL.md").resolve():
                problems.append(f"Codex does not discover {name} from {root}")
        print(f"Codex repo skills: {sorted(found)}")
    print(f"Skills: {names}")
    for problem in problems:
        print(f"problem: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
