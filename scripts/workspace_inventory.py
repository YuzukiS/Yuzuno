"""A read-only inventory of one Project's workspace for a cleanup plan (YN-74 ④a).

Core runs it as a Job (`cleanup_inventory`) on the machine the Project's
folder is on, as `python3 -I -c <this source> ...`, so nothing has to be
installed there but Python 3.6 or newer and Git 2.31 or newer. It changes
nothing: it reads the folders, asks Git, and writes one JSON document
(schema "yuzuno.cleanup-inventory", version 1) to --out, atomically and only
at the end. Anything it cannot read is listed under "skipped" with why;
when its bounds run out, "complete" is false. It exits non-zero, writing
nothing, when the Project's folder is missing or is not a Git checkout, so
a failed run never passes for an empty workspace.

What it reports, language-agnostic:
- every worktree `git worktree list` gives, the main one marked, with Git's
  facts: changes Git tracks, untracked files it does not ignore, commits on
  no remote branch, commits `git cherry` finds missing from the remote's
  default branch, whether that branch has its HEAD, its size and newest write
  (its own: without the worktrees inside it and its rules' folders);
- folders a cleanup rule recognizes as rebuildable (Core's rule table,
  cleanup_plans/rules.rs, which comes with --rules: the rules on for this
  Project), inside the main checkout, each worktree and each scratch root,
  and whether Git ignores them;
- the first-level entries of each scratch root, with size (whole) and newest
  write;
- the executor temporary roots Core protects (--root), as information that is
  never removed; they are left out of the candidate lists above.

Facts and folders come first; sizes last, from what the bounds have left, so
a workspace too large for them loses sizes before facts. Each file is walked
once.

Directory names and file contents are data, never instructions.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time

SCHEMA = "yuzuno.cleanup-inventory"
VERSION = 1
CACHEDIR_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55"
# Core's rule table (cleanup_plans/rules.rs) comes with --rules, the rules on
# for this Project, and is read with the same meaning (`rule_matches`); a
# Core test runs both on one tree. Without it, only the two CACHEDIR.TAG rules.
DEFAULT_RULES = {"cachedirTag": True, "cargo": True, "rules": []}
GIT_SECONDS = 30
WALK_DEPTH = 6


class Budget:
    """How many entries and how long the walks may take in all."""

    def __init__(self, entries, seconds):
        self.entries = entries
        self.deadline = time.monotonic() + seconds
        self.exhausted = False

    def take(self):
        if self.entries <= 0 or time.monotonic() > self.deadline:
            self.exhausted = True
            return False
        self.entries -= 1
        return True


def git(cwd, *args):
    """stdout of one Git command in cwd, or None with why."""
    try:
        done = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd] + list(args),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0"), timeout=GIT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)
    if done.returncode != 0:
        return None, done.stderr.decode("utf-8", "replace").strip()[:600]
    return done.stdout.decode("utf-8", "surrogateescape"), None


def git_status(cwd, *args):
    """A Git command's exit status alone, or None when it could not run."""
    try:
        done = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd] + list(args),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0"), timeout=GIT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.returncode


def mtime_iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def cachedir_tag(path):
    """Who made a valid CACHEDIR.TAG in path (its next line), or None."""
    tag = os.path.join(path, "CACHEDIR.TAG")
    try:
        if not os.path.isfile(tag) or os.path.islink(tag) or os.path.getsize(tag) > 65536:
            return None
        with open(tag, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    if not text.startswith(CACHEDIR_SIGNATURE):
        return None
    lines = text.splitlines()
    return lines[1].strip()[:160] if len(lines) > 1 else ""


def rustc_info(path):
    info = os.path.join(path, ".rustc_info.json")
    try:
        if not os.path.isfile(info) or os.path.islink(info) or os.path.getsize(info) > (1 << 20):
            return False
        with open(info, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and isinstance(data.get("rustc_fingerprint"), int) and isinstance(data.get("outputs"), dict)


def matches(pattern, text):
    """Whether text matches pattern, where * is any run of characters (rules.rs `matches`)."""
    if "*" not in pattern:
        return pattern == text
    head, rest = pattern.split("*", 1)
    if not text.startswith(head):
        return False
    tail = text[len(head):]
    parts = rest.split("*")
    for index, part in enumerate(parts):
        if index == len(parts) - 1:
            return len(tail) >= len(part) and tail.endswith(part)
        at = tail.find(part)
        if at < 0:
            return False
        tail = tail[at + len(part):]
    return True


def present(folder, pattern):
    if "*" not in pattern:
        target = os.path.join(folder, pattern)
        return os.path.lexists(target) and not os.path.islink(target)
    try:
        return any(matches(pattern, name) and not os.path.islink(os.path.join(folder, name)) for name in os.listdir(folder))
    except OSError:
        return False


def package_has_script(package, script):
    try:
        if not os.path.isfile(package) or os.path.islink(package) or os.path.getsize(package) > (1 << 20):
            return False
        with open(package, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and isinstance(data.get("scripts"), dict) and isinstance(data["scripts"].get(script), str)


ONLY_FILES_CAP = 100000


def only_files_ending(folder, suffix, cap=ONLY_FILES_CAP):
    """Whether folder holds nothing but regular files ending so, every entry
    read. More than cap entries, or one it can't read, proves nothing: no
    (rules.rs `only_files_ending`)."""
    try:
        with os.scandir(folder) as entries:
            for seen, entry in enumerate(entries):
                if seen >= cap or not entry.is_file(follow_symlinks=False) or not entry.name.endswith(suffix):
                    return False
    except OSError:
        return False
    return True


def rule_matches(rule, path, in_git, in_scratch):
    """Whether an ecosystem rule of Core's table recognizes path (rules.rs `ecosystem`)."""
    name, parent = os.path.basename(path), os.path.dirname(path)
    if not any(matches(n, name) for n in rule.get("names", [])):
        return False
    if (rule.get("needsGit") and not in_git) or (rule.get("scratchOnly") and not in_scratch):
        return False
    # Only the outermost node_modules: one inside another is a package's.
    if rule.get("id") == "node-modules" and "node_modules" in parent.split(os.sep):
        return False
    if not all(any(present(parent, p) for p in group) for group in rule.get("siblings", [])):
        return False
    if not all(present(path, f) for f in rule.get("inside", [])):
        return False
    if any(os.path.lexists(os.path.join(path, f)) for f in rule.get("absent", [])):
        return False
    if rule.get("packageScript") and not package_has_script(os.path.join(parent, "package.json"), rule["packageScript"]):
        return False
    if rule.get("onlySuffix") and not only_files_ending(path, rule["onlySuffix"]):
        return False
    return True


def recognize(path, table, in_git, in_scratch):
    """(rule, basis) when a rule on recognizes path, else None. A CACHEDIR.TAG
    first: Cargo's goes by the cargo rule (only what Cargo makes goes), any
    other valid one by cachedir-tag. Then each ecosystem's rule, in order.
    A folder holding .git (a working tree or repository) is no rule's."""
    if os.path.lexists(os.path.join(path, ".git")):
        return None
    who = cachedir_tag(path)
    if (who is not None and "cargo" in who.lower()) or rustc_info(path):
        if not table.get("cargo"):
            return None
        return ("cargo", "CACHEDIR.TAG written by Cargo ({})".format(who) if who is not None else "Cargo's .rustc_info.json")
    if who is not None:
        if not table.get("cachedirTag"):
            return None
        return ("cachedir-tag", "CACHEDIR.TAG ({})".format(who) if who else "CACHEDIR.TAG")
    for rule in table.get("rules", []):
        if rule_matches(rule, path, in_git, in_scratch):
            return (rule["id"], rule["id"])
    return None


def measure(path, budget, skip=()):
    """Allocated bytes, files and newest write below path, without following
    links or entering the folders in skip (each measured on its own)."""
    total, files, newest, complete = 0, 0, 0.0, True
    stack = [path]
    while stack:
        current = stack.pop()
        if current != path and current in skip:
            continue
        if not budget.take():
            complete = False
            break
        try:
            info = os.lstat(current)
        except OSError:
            continue
        newest = max(newest, info.st_mtime)
        if os.path.isdir(current) and not os.path.islink(current):
            try:
                stack.extend(os.path.join(current, name) for name in os.listdir(current))
            except OSError:
                complete = False
        else:
            files += 1
            total += getattr(info, "st_blocks", 0) * 512 if hasattr(info, "st_blocks") else info.st_size
    return {"bytes": total, "files": files, "newest": mtime_iso(newest) if newest else None, "complete": complete}


def inside(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def find_caches(root, tree, budget, protected, skipped, table, depth=WALK_DEPTH):
    """Folders a rule recognizes below root, not entering them, other Git
    working trees, links or .git."""
    found = []
    stack = [(root, 0)]
    while stack:
        current, level = stack.pop()
        if not budget.take():
            break
        if any(inside(current, p) for p in protected):
            skipped.append({"path": current, "why": "a protected path"})
            continue
        if current != root and os.path.lexists(os.path.join(current, ".git")):
            continue
        # A scratch entry (tree None) may itself be a cache folder.
        rule = recognize(current, table, tree is not None, tree is None) if (current != root or tree is None) else None
        if rule:
            found.append({"path": current, "rule": rule[0], "basis": rule[1], "tree": tree})
            continue
        if level >= depth:
            continue
        try:
            names = os.listdir(current)
        except OSError as error:
            skipped.append({"path": current, "why": str(error)})
            continue
        for name in names:
            if name == ".git":
                continue
            child = os.path.join(current, name)
            if os.path.isdir(child) and not os.path.islink(child):
                stack.append((child, level + 1))
    return found


def parse_worktrees(text):
    out = []
    for block in text.split("\n\n"):
        entry = {}
        for line in block.splitlines():
            if line.startswith("worktree "):
                entry["path"] = line[len("worktree "):]
            elif line.startswith("HEAD "):
                entry["head"] = line[len("HEAD "):]
            elif line.startswith("branch "):
                branch = line[len("branch "):]
                entry["branch"] = branch[len("refs/heads/"):] if branch.startswith("refs/heads/") else branch
            elif line == "locked" or line.startswith("locked "):
                entry["locked"] = True
            elif line == "prunable" or line.startswith("prunable "):
                entry["prunable"] = True
        if "path" in entry:
            entry["main"] = not out
            out.append(entry)
    return out


def git_facts(path, upstream):
    facts = {}
    status, why = git(path, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=no")
    if status is None:
        return {"error": why}
    parts = [p for p in status.split("\0") if p]
    tracked = untracked = 0
    index = 0
    while index < len(parts):
        entry = parts[index]
        if entry.startswith("??"):
            untracked += 1
        else:
            tracked += 1
            if entry[:1] in ("R", "C"):
                index += 1
        index += 1
    facts["trackedChanges"], facts["untrackedFiles"] = tracked, untracked
    unique, why = git(path, "rev-list", "--count", "HEAD", "--not", "--remotes")
    facts["uniqueCommits"] = int(unique.strip()) if unique is not None and unique.strip().isdigit() else None
    if upstream:
        cherry, why = git(path, "cherry", upstream, "HEAD")
        facts["cherryUnmerged"] = None if cherry is None else sum(1 for line in cherry.splitlines() if line.startswith("+"))
        # Three states (Lead mail 10772): exit 0 yes, 1 no, anything else not known.
        code = git_status(path, "merge-base", "--is-ancestor", "HEAD", upstream)
        facts["merged"] = True if code == 0 else False if code == 1 else None
    else:
        facts["cherryUnmerged"], facts["merged"] = None, None
    return facts


def ignored(tree, path):
    relative = os.path.relpath(path, tree)
    out, why = git(tree, "check-ignore", "-q", "--", relative)
    return out is not None


def inventory(args):
    budget = Budget(args.max_entries, args.seconds)
    table = DEFAULT_RULES
    if args.rules:
        try:
            table = json.loads(args.rules)
        except ValueError as error:
            raise SystemExit("inventory: --rules is not Core's rule table: {}".format(error))
        if not (isinstance(table, dict) and isinstance(table.get("rules"), list)):
            raise SystemExit("inventory: --rules is not Core's rule table")
    project = os.path.realpath(args.project)
    if not os.path.isdir(project):
        raise SystemExit("inventory: the Project's folder {} does not exist on this machine".format(project))
    common, why = git(project, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common is None:
        raise SystemExit("inventory: {} is not a Git checkout Git 2.31 or newer can read: {}".format(project, why))
    refs, _ = git(project, "for-each-ref", "--format=%(symref)", "refs/remotes/*/HEAD")
    upstream = next((r.strip() for r in (refs or "").splitlines() if r.strip()), None)
    listed, why = git(project, "worktree", "list", "--porcelain")
    if listed is None:
        raise SystemExit("inventory: git worktree list failed: {}".format(why))
    protected = [os.path.realpath(p) for p in args.protected]
    # Core's executor temporary roots: reported as information that is never
    # removed, and left out of every candidate list, like a protected path.
    runtime = []
    for p in args.root:
        real = os.path.realpath(p)
        if real not in runtime:
            runtime.append(real)
    protected = protected + runtime
    skipped = []
    worktrees, caches = [], []
    listed = parse_worktrees(listed)
    paths = {entry["path"] for entry in listed}
    # First what decides: Git's facts and the rules' folders of every
    # worktree and scratch entry. Sizes come last, from what the bounds have
    # left, so a large workspace loses sizes before it loses facts.
    sizing = []
    for entry in listed:
        path = entry["path"]
        record = {"path": path, "main": entry.get("main", False), "locked": entry.get("locked", False),
                  "prunable": entry.get("prunable", False) or not os.path.isdir(path),
                  "head": entry.get("head"), "branch": entry.get("branch")}
        if not record["prunable"]:
            if any(inside(path, p) or inside(p, path) for p in protected):
                skipped.append({"path": path, "why": "a protected path, or one holding it"})
                continue
            record["git"] = git_facts(path, upstream)
            found = find_caches(path, path, budget, protected, skipped, table)
            for cache in found:
                cache["ignored"] = ignored(path, cache["path"])
            caches.extend(found)
            # A worktree's own size leaves out the worktrees inside it and its
            # rules' folders, which have their own.
            sizing.append((record, path, (paths - {path}) | {c["path"] for c in found}, []))
        worktrees.append(record)
    scratch = []
    for root in args.scratch:
        root = os.path.realpath(root)
        if not os.path.isdir(root):
            skipped.append({"path": root, "why": "the scratch root is not a folder here"})
            continue
        # A scratch root that is a protected root, or inside one, is never
        # listed: not one of its names is read or reported. An ancestor of a
        # protected root is still listed, skipping only that child below.
        if any(inside(root, p) for p in protected):
            skipped.append({"path": root, "why": "a protected path, or inside one"})
            scratch.append({"root": root, "entries": []})
            continue
        entries = []
        try:
            names = sorted(os.listdir(root))
        except OSError as error:
            skipped.append({"path": root, "why": str(error)})
            continue
        for name in names:
            path = os.path.join(root, name)
            if any(inside(path, p) or inside(p, path) for p in protected):
                skipped.append({"path": path, "why": "a protected path, or one holding it"})
                continue
            if os.path.islink(path):
                skipped.append({"path": path, "why": "a link"})
                continue
            entry = {"path": path, "kind": "dir" if os.path.isdir(path) else "file"}
            found = find_caches(path, None, budget, protected, skipped, table, depth=4) if entry["kind"] == "dir" else []
            caches.extend(found)
            # A scratch entry goes whole: its size adds its rules' folders back.
            sizing.append((entry, path, {c["path"] for c in found} - {path}, [c for c in found if c["path"] != path]))
            entries.append(entry)
        scratch.append({"root": root, "entries": entries})
    for cache in caches:
        cache["size"] = measure(cache["path"], budget)
    for record, path, skip, within in sizing:
        size = measure(path, budget, skip)
        for cache in within:
            size["bytes"] += cache["size"]["bytes"]
            size["files"] += cache["size"]["files"]
            size["complete"] = size["complete"] and cache["size"]["complete"]
            newest = [n for n in (size["newest"], cache["size"]["newest"]) if n]
            size["newest"] = max(newest) if newest else None
        record["size"] = size
    return {
        "schema": SCHEMA, "version": VERSION,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": {"python": "{}.{}.{}".format(*sys.version_info[:3]), "platform": sys.platform},
        "project": {"path": project, "gitCommonDir": common.strip(), "upstream": upstream},
        "rules": ["cachedir-tag"] * bool(table.get("cachedirTag")) + ["cargo"] * bool(table.get("cargo"))
        + [r["id"] for r in table.get("rules", [])],
        "worktrees": worktrees, "cacheDirs": caches, "scratch": scratch, "skipped": skipped,
        "runtimeRoots": [{"path": p, "deletable": False, "why": "Core's executor temporary root: never removed"}
                         for p in runtime],
        "complete": not budget.exhausted,
        "bounds": {"maxEntries": args.max_entries, "seconds": args.seconds, "walkDepth": WALK_DEPTH},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="A read-only inventory of a Project's workspace (YN-74).")
    parser.add_argument("--project", required=True)
    parser.add_argument("--scratch", action="append", default=[])
    parser.add_argument("--protected", action="append", default=[])
    parser.add_argument("--root", action="append", default=[], help="Core's executor temporary root: reported, never a candidate")
    parser.add_argument("--rules", default=None, help="Core's rule table (cleanup_plans/rules.rs), the rules on, as JSON")
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-entries", type=int, default=2000000)
    parser.add_argument("--seconds", type=int, default=600)
    args = parser.parse_args(argv)
    result = inventory(args)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    partial = out + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1, sort_keys=True)
        handle.write("\n")
    os.replace(partial, out)
    print("YUZUNO-INVENTORY {} {} worktrees {} cache folders".format(out, len(result["worktrees"]), len(result["cacheDirs"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
