#!/usr/bin/env python3
"""Run Cargo on a shared target directory and know which source it built.

  scripts/source_build.py run [--target-dir DIR] [--input PATH]... [--record FILE]
                              [--artifact NAME]... [--copy-to DIR] -- cargo ARGS...
  scripts/source_build.py verify --record FILE

Why: Cargo names a workspace member's artifacts and fingerprints by the
member's path relative to the workspace root, and it stores that member's
dep-info paths relative too. For a local package, "fresh" means that no
listed source file is newer than the last build. So two source trees with
the same layout (worktrees, an extracted old commit) that share one target
directory also share those artifacts. A tree whose files are older than the
other tree's last build gets the other tree's binaries, and Cargo exits 0.
This is how Cargo's mtime fingerprints work, not a Cargo bug. It only
matters when target directories are shared. See test_source_build.py for a
reproduction with plain Cargo.

`run` makes that sharing safe, for runs that all go through it:
- It holds an exclusive lock on the target directory for the whole run
  (build and, for `cargo test`/`cargo run`, the run itself). Runs from other
  trees wait instead of replacing artifacts mid-run.
- It digests the source inputs (each file's path and content) before the run.
  If the target was last built from another tree, or has no record of what
  built it, it first runs `cargo clean -p` for the workspace's own packages in
  that profile, so they are compiled from this tree. Edits within the same
  tree are left to Cargo's own fingerprints (and incremental builds), which
  are right as long as one tree uses the target. Dependencies from
  registries are keyed by their version, so they are shared and kept.
- It digests the inputs again after the run. If they changed meanwhile, the
  run is rejected (exit 3) and nothing is recorded as built from this source.
- On success it records the tree, its digest and Git state, and, with
  --record, the command, exit code and the sha256 of each --artifact.
  --copy-to copies those artifacts out, for a lab that must run them while
  other builds use the target.

`verify` checks a record against the tree and artifacts as they are now: the
same digest, and the same artifact sha256s.

Frozen and checked: the content of the input files at the start and at the
end of a run, and the artifacts named with --artifact. Not covered:
- a change that is reverted again before the run ends;
- files outside the inputs (by default the workspace members' directories,
  Cargo.toml and Cargo.lock; add others with --input);
- environment variables a build script reads;
- runs that use the same target directory without this script.

Refused: builds for a target triple (--target, --config, CARGO_BUILD_TARGET
or build.target in a Cargo config file), whose artifacts go elsewhere. A
requested --artifact that this run did not produce fails the run (exit 5),
and its record never verifies.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tomllib

STATE = ".source-build"
SKIP = {".git", "target", "node_modules"}
SOURCE_CHANGED = 3
USAGE = 4
NOT_PRODUCED = 5


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def workspace(root: Path) -> tuple[list[str], list[Path]]:
    """The workspace's own packages and their directories."""
    out = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1", "--offline"],
        cwd=root, check=True, capture_output=True, text=True,
    ).stdout
    meta = json.loads(out)
    members = set(meta["workspace_members"])
    packages = [p for p in meta["packages"] if p["id"] in members]
    return [p["name"] for p in packages], [Path(p["manifest_path"]).parent for p in packages]


def inputs(root: Path, member_dirs: list[Path], extra: list[str]) -> list[Path]:
    paths = [root / "Cargo.toml", root / "Cargo.lock", *member_dirs, *(root / e for e in extra)]
    return sorted({p.resolve() for p in paths if p.exists()})


def digest(root: Path, paths: list[Path]) -> str:
    """sha256 over each input file's path (relative to root) and content."""
    files: list[Path] = []
    for path in paths:
        if path.is_file():
            files.append(path)
            continue
        for directory, dirs, names in os.walk(path):
            dirs[:] = sorted(d for d in dirs if d not in SKIP)
            files.extend(Path(directory) / n for n in names)
    total = hashlib.sha256()
    for file in sorted(set(files)):
        relative = file.relative_to(root).as_posix() if file.is_relative_to(root) else file.as_posix()
        total.update(relative.encode() + b"\0")
        total.update(hashlib.sha256(file.read_bytes()).digest())
    return total.hexdigest()


def git(root: Path, *args: str) -> str | None:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def output_dir(args: list[str]) -> tuple[str, list[str]]:
    """Cargo's profile output directory for these arguments, and the
    profile flags `cargo clean` needs for the same directory."""
    if "--release" in args or "-r" in args:
        return "release", ["--release"]
    for i, arg in enumerate(args):
        value = arg.split("=", 1)[1] if arg.startswith("--profile=") else (
            args[i + 1] if arg == "--profile" and i + 1 < len(args) else None)
        if value:
            name = {"dev": "debug", "test": "debug", "bench": "release"}.get(value, value)
            return name, ["--profile", "dev" if name == "debug" else value]
    if args and args[0] == "bench":
        return "release", ["--release"]
    return "debug", []


def target_triple_setting(root: Path, command: list[str]) -> str | None:
    """What would make Cargo build for a target triple, if anything. Such
    builds write to <target>/<triple>/<profile>, which this does not clean
    or check, while an older <target>/<profile> build may still be there."""
    if any(a == "--target" or a.startswith("--target=") for a in command):
        return "--target"
    if any(a == "--config" or a.startswith("--config=") for a in command):
        return "--config, which can set build.target"
    if os.environ.get("CARGO_BUILD_TARGET"):
        return "CARGO_BUILD_TARGET"
    home = Path(os.environ.get("CARGO_HOME") or Path.home() / ".cargo")
    configs = [d / ".cargo" / n for d in (root, *root.parents) for n in ("config.toml", "config")]
    configs += [home / n for n in ("config.toml", "config")]
    for config in configs:
        if not config.is_file():
            continue
        try:
            build = tomllib.loads(config.read_text()).get("build", {})
        except (tomllib.TOMLDecodeError, UnicodeDecodeError):
            return f"{config}, which cannot be read to rule out build.target"
        if isinstance(build, dict) and "target" in build:
            return f"build.target in {config}"
    return None


def refuse(options, root: Path, command: list[str], reason: str) -> int:
    """A run refused before Cargo starts; a --record says so, so it never verifies."""
    print(f"source_build: refused: {reason}", file=sys.stderr)
    if options.record:
        Path(options.record).parent.mkdir(parents=True, exist_ok=True)
        Path(options.record).write_text(json.dumps({"root": str(root), "command": command, "rejected": reason,
                                                    "requestedArtifacts": options.artifact, "artifacts": {},
                                                    "at": now()}, indent=2) + "\n")
    return USAGE


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(options) -> int:
    command = options.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or command[0] != "cargo":
        print("source_build: the command after -- must start with cargo", file=sys.stderr)
        return USAGE
    if any(a == "--target-dir" or a.startswith("--target-dir=") for a in command):
        print("source_build: give the target directory to source_build (--target-dir), not to cargo", file=sys.stderr)
        return USAGE
    root = Path.cwd().resolve()
    triple = target_triple_setting(root, command)
    if triple:
        return refuse(options, root, command, f"builds for a target triple are not supported ({triple} sets one); "
                      "their artifacts go to <target>/<triple>/, which this does not clean or check")
    target = Path(options.target_dir or os.environ.get("CARGO_TARGET_DIR") or root / "target").resolve()
    profile, profile_flags = output_dir(command[1:])
    state = target / STATE
    state.mkdir(parents=True, exist_ok=True)
    packages, member_dirs = workspace(root)
    sources = inputs(root, member_dirs, options.input)
    # Both spellings, so a configured build.target-dir cannot move the build elsewhere.
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "CARGO_BUILD_TARGET_DIR": str(target)}
    with open(state / "lock", "a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            holder = (state / "holder.json").read_text() if (state / "holder.json").exists() else "unknown"
            print(f"source_build: waiting for {target}, in use by {holder}", file=sys.stderr, flush=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
        (state / "holder.json").write_text(json.dumps({"root": str(root), "pid": os.getpid(), "since": now()}))
        try:
            return locked_run(options, command, root, target, profile, profile_flags, state, packages, sources, env)
        finally:
            (state / "holder.json").unlink(missing_ok=True)


def locked_run(options, command, root, target, profile, profile_flags, state, packages, sources, env) -> int:
    """The run itself, while the target's lock is held."""
    started, began = now(), time.time()
    before = digest(root, sources)
    stamp_file = state / f"built-{profile}.json"
    stamp = json.loads(stamp_file.read_text()) if stamp_file.exists() else None
    built_here = bool(stamp) and stamp.get("root") == str(root)
    cleaned = None
    if not built_here:
        cleaned = "no record of what this target last built" if not stamp else "last built from another tree"
        # Until this run succeeds, nothing is recorded as built here.
        stamp_file.unlink(missing_ok=True)
        clean = ["cargo", "clean", "--offline", *profile_flags]
        for package in packages:
            clean += ["-p", package]
        subprocess.run(clean, cwd=root, env=env, check=True, capture_output=True)
        print(f"source_build: {cleaned}; cleaned {', '.join(packages)} ({profile}) so they build from {root}",
              file=sys.stderr, flush=True)
    code = subprocess.run(command, cwd=root, env=env).returncode
    after = digest(root, sources)
    record = {
        "root": str(root), "head": git(root, "rev-parse", "HEAD"),
        "dirty": (git(root, "status", "--porcelain") or "").splitlines(),
        "inputs": [p.relative_to(root).as_posix() if p.is_relative_to(root) else str(p) for p in sources],
        "digest": before, "targetDir": str(target), "outputDir": str(target / profile),
        "command": command, "exitCode": code, "cleaned": cleaned,
        "startedAt": started, "finishedAt": now(), "requestedArtifacts": options.artifact, "artifacts": {},
    }
    if after != before:
        stamp_file.unlink(missing_ok=True)
        record["rejected"] = "the source inputs changed during the run; what it built is not trusted"
        print(f"source_build: rejected: {record['rejected']}", file=sys.stderr)
        code = SOURCE_CHANGED
    else:
        # Whatever the exit code, the workspace's artifacts in the target
        # are now this tree's: compiled here, or left from its own builds.
        stamp_file.write_text(json.dumps({"root": str(root), "digest": before, "exitCode": code, "at": now()}))
        # Every requested artifact must be there, and after a clean it must
        # have been written by this run: otherwise fail closed.
        absent = []
        for name in options.artifact:
            path = target / profile / name
            if not path.is_file() or (cleaned and path.stat().st_mtime < began):
                absent.append(name)
            else:
                record["artifacts"][name] = sha256(path)
        if absent:
            record["artifacts"] = {}
            record["rejected"] = f"requested artifacts not produced by this run in {target / profile}: {', '.join(absent)}"
            print(f"source_build: rejected: {record['rejected']}", file=sys.stderr)
            code = code or NOT_PRODUCED
        if options.copy_to and code == 0:
            copies = Path(options.copy_to)
            copies.mkdir(parents=True, exist_ok=True)
            for name in record["artifacts"]:
                # Replaced, never written in place: a lab may be running
                # the previous copy (Linux refuses that write, ETXTBSY).
                final = copies / Path(name).name
                temporary = final.with_name(f".{final.name}.{os.getpid()}.tmp")
                shutil.copy2(target / profile / name, temporary)
                os.replace(temporary, final)
            record["copiedTo"] = str(copies.resolve())
    if options.record:
        Path(options.record).parent.mkdir(parents=True, exist_ok=True)
        Path(options.record).write_text(json.dumps(record, indent=2) + "\n")
    return code


def verify(options) -> int:
    record = json.loads(Path(options.record).read_text())
    if record.get("rejected") or record.get("exitCode") != 0:
        print(f"source_build: not a successful build: {record.get('rejected') or 'exit ' + str(record.get('exitCode'))}", file=sys.stderr)
        return SOURCE_CHANGED
    root = Path(record["root"])
    sources = [root / p if not Path(p).is_absolute() else Path(p) for p in record["inputs"]]
    now_digest = digest(root, sources)
    if now_digest != record["digest"]:
        print(f"source_build: the source changed since this build ({record['digest'][:12]} -> {now_digest[:12]})", file=sys.stderr)
        return SOURCE_CHANGED
    requested = record.get("requestedArtifacts", list(record["artifacts"]))
    missing = [name for name in requested if name not in record["artifacts"]]
    if missing:
        print(f"source_build: requested artifacts missing from this build: {', '.join(missing)}", file=sys.stderr)
        return NOT_PRODUCED
    place = Path(record.get("copiedTo") or record["outputDir"])
    for name, expected in record["artifacts"].items():
        path = place / (Path(name).name if record.get("copiedTo") else name)
        if not path.is_file() or sha256(path) != expected:
            print(f"source_build: {path} is not the artifact this build produced", file=sys.stderr)
            return SOURCE_CHANGED
    checked = f"{len(requested)} requested artifacts checked" if requested else "no artifacts were requested"
    print(f"source_build: {record['digest'][:12]} from {root} matches; {checked}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="mode", required=True)
    r = commands.add_parser("run", help="run cargo on a target directory, from this tree's source")
    r.add_argument("--target-dir", help="default: $CARGO_TARGET_DIR, else ./target")
    r.add_argument("--input", action="append", default=[], help="another file or directory the build reads")
    r.add_argument("--record", help="write what was built, from which source, to this JSON file")
    r.add_argument("--artifact", action="append", default=[], help="a file in the profile directory to hash")
    r.add_argument("--copy-to", help="copy the --artifact files here after a successful run")
    r.add_argument("command", nargs=argparse.REMAINDER, help="-- cargo ARGS...")
    v = commands.add_parser("verify", help="check a record against the source and artifacts now")
    v.add_argument("--record", required=True)
    options = parser.parse_args(argv)
    return run(options) if options.mode == "run" else verify(options)


if __name__ == "__main__":
    sys.exit(main())
