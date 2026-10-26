#!/usr/bin/env python3
"""Assemble already-built, reviewed artifacts; never build, install or restart Core.

Run from a review checkout. The resulting manifest hash is the trust input to
the host's local catalog; placing arbitrary directories next to it is not enough.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import tempfile


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def copy_tree(source, target):
    root = source.resolve(strict=True)
    for path in sorted(root.rglob("*")):
        if "node_modules" in path.parts and ".bin" in path.parts:
            continue  # SDK imports don't use npm's generated executable links.
        if path.is_symlink():
            raise ValueError(f"Release inputs must not contain symlinks: {path}")
        output = target / path.relative_to(root)
        if path.is_dir():
            output.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, output)
        else:
            raise ValueError(f"Unsupported input file: {path}")


WINDOWS_HELPER = ("yuzuno-jobs-helper.exe", "windows-helper.json")


def check_windows_helper(folder, source=None):
    """The committed Windows Jobs helper (tools/build-windows-helper.py) is
    exactly the file its record names; with the tree's windows_job.cs, also
    built from that source and speaking its protocol."""
    for name in WINDOWS_HELPER:
        if (folder / name).is_symlink() or not (folder / name).is_file():
            raise ValueError(f"Release inputs are missing {folder / name}; build it with tools/build-windows-helper.py")
    record = json.loads((folder / "windows-helper.json").read_text())
    helper = folder / "yuzuno-jobs-helper.exe"
    if (record.get("format") != 1 or record.get("file") != helper.name or type(record.get("protocol")) is not int
            or record.get("sha256") != digest(helper) or record.get("bytes") != helper.stat().st_size):
        raise ValueError("The Windows Jobs helper does not match its windows-helper.json; rebuild it")
    if not os.access(helper, os.X_OK):
        raise ValueError("The Windows Jobs helper is not executable; WSL interop would not run it")
    if source is not None:
        text = source.read_bytes()
        declared = re.findall(rb"^\s*const int Protocol = (\d+);", text, re.M)
        if (record.get("source") or {}).get("sha256") != hashlib.sha256(text).hexdigest() or declared != [str(record["protocol"]).encode()]:
            raise ValueError(f"The Windows Jobs helper was built from another {source.name}; rebuild it with tools/build-windows-helper.py")
    return record


def assemble(args):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args.release_id):
        raise ValueError("Invalid release ID")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.git_sha):
        raise ValueError("Use the exact reviewed source commit")
    if platform.system() != "Linux":
        raise ValueError("This first release format targets Linux / WSL Core")
    if not args.version.strip():
        raise ValueError("A human-readable release version is required")
    notes = args.notes_file.read_text()
    if len(notes.encode()) > 32768:
        raise ValueError("Release notes are too large")
    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError("Immutable release destination already exists")
    staging = Path(tempfile.mkdtemp(prefix=".release-", dir=output.parent))
    try:
        (staging / "bin").mkdir()
        for source, name in [(args.core, "yuzuno-workspace"), (args.helper, "yuzuno-update-helper")]:
            if not source.is_file() or not os.access(source, os.X_OK):
                raise ValueError(f"Not an executable build artifact: {source}")
            shutil.copy2(source, staging / "bin" / name)
        # The project license, the notices of the crates in bin/ and of the
        # Claude runtime's packages; the web UI and the result validator carry
        # their own (T-90).
        copy_tree(args.licenses, staging / "licenses")
        for name in ["licenses/LICENSE", "licenses/THIRD_PARTY_NOTICES-core.txt",
                     "licenses/rust-std-COPYRIGHT-library.html", "licenses/THIRD_PARTY_NOTICES-claude-runtime.txt"]:
            if not (staging / name).is_file():
                raise ValueError(f"Release inputs are missing {name}; build them with tools/build-core-artifact.py")
        copy_tree(args.web, staging / "web")
        if not (staging / "web/licenses/THIRD_PARTY_NOTICES.txt").is_file():
            raise ValueError("The web build has no licenses/THIRD_PARTY_NOTICES.txt; package a fresh Vite output")
        html_path = staging / "web/index.html"
        html = html_path.read_text()
        if 'name="yuzuno-release"' in html or "</head>" not in html:
            raise ValueError("Expected a fresh Vite output with a closing head")
        html_path.write_text(html.replace("</head>", f'<meta name="yuzuno-release" content="{args.release_id}">\n</head>', 1))
        # All runtime dependencies but the Claude Agent SDK, which Core
        # obtains on the user's machine (T-159): the runtime carries its
        # manifest and, where installed Cores require its package.json, a
        # placeholder. Node and the authenticated official CLI remain host
        # prerequisites.
        copy_tree(args.claude, staging / "runtimes/claude")
        required = staging / "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json"
        if not required.is_file():
            raise ValueError("Claude runtime dependencies are missing; package the prepared runtime")
        # Generated and committed (runtimes/result-validator); Core runs only
        # the bundle whose hash it was built with. Core treats it as optional,
        # so older releases without it stay valid previous/rollback targets.
        validator = args.result_validator
        contract = json.loads((validator / "contract.json").read_text())
        if digest(validator / "validator.mjs") != contract["validator"]["sha256"]:
            raise ValueError("Result validator does not match its contract; regenerate it")
        (staging / "runtimes/result-validator").mkdir()
        for name in ["validator.mjs", "contract.json", "THIRD_PARTY_NOTICES.txt"]:
            if (validator / name).is_symlink():
                raise ValueError(f"Release inputs must not contain symlinks: {validator / name}")
            shutil.copy2(validator / name, staging / "runtimes/result-validator" / name)
        # Built on Windows from a fixed commit and committed (runtimes/windows-jobs);
        # Core runs it only if its bytes match this manifest. Optional to Core,
        # so older releases without it stay valid previous/rollback targets.
        (staging / "runtimes/windows-jobs").mkdir()
        for name in WINDOWS_HELPER:
            if (args.windows_helper / name).is_symlink():
                raise ValueError(f"Release inputs must not contain symlinks: {args.windows_helper / name}")
            if (args.windows_helper / name).is_file():
                shutil.copy2(args.windows_helper / name, staging / "runtimes/windows-jobs" / name)
        check_windows_helper(staging / "runtimes/windows-jobs")
        files = {}
        for path in sorted(staging.rglob("*")):
            if path.is_file():
                executable = bool(path.stat().st_mode & 0o111)
                path.chmod(0o555 if executable else 0o444)
                files[path.relative_to(staging).as_posix()] = {
                    "sha256": digest(path), "bytes": path.stat().st_size, "executable": executable,
                }
        manifest = {
            "format": 1, "releaseId": args.release_id, "version": args.version,
            "gitSha": args.git_sha, "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "notes": notes, "platform": "linux-" + {"x86_64": "x86_64", "aarch64": "aarch64"}[platform.machine()],
            "protocol": 1, "schema": {"writes": 2, "readsMin": 2, "readsMax": 2},
            "records": {"writes": 2, "readsMin": 2, "readsMax": 2}, "files": files,
        }
        manifest_path = staging / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        manifest_path.chmod(0o444)
        staging.rename(output)
        print(json.dumps({"releaseId": args.release_id, "manifestSha256": digest(output / "manifest.json"),
                          "bytes": sum(item["bytes"] for item in files.values()), "path": str(output)}))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["core", "helper", "licenses", "web", "claude", "result-validator", "windows-helper", "out", "notes-file"]:
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ["release-id", "version", "git-sha"]:
        parser.add_argument("--" + name, required=True)
    assemble(parser.parse_args())
