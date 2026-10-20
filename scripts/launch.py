#!/usr/bin/env python3
"""Start Core or a client independently; no client starts or stops Core."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import webbrowser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "http://127.0.0.1:4317"


def core_url(value):
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError as error:
        raise argparse.ArgumentTypeError("Invalid Core URL") from error
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username
            or url.password or url.query or url.fragment or url.path not in {"", "/"}
            or port == 0):
        raise argparse.ArgumentTypeError("Use a Core origin URL without credentials, path, query or fragment")
    if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise argparse.ArgumentTypeError("HTTP Core connections must use loopback; other hosts require HTTPS")
    return value.rstrip("/")


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    modes = result.add_subparsers(dest="mode", required=True)
    core = modes.add_parser("core", help="Run only Core, on the machine that owns the workspace and Harness")
    core.add_argument("--port", type=int)
    core.add_argument("--data-dir", type=Path)
    core.add_argument("--web-dir", type=Path, default=ROOT / "web/dist")
    core.add_argument("--cwd", type=Path)
    core.add_argument("--codex")
    desktop = modes.add_parser("desktop", help="Connect a native window or browser to an already running Core")
    desktop.add_argument("--core-url", type=core_url,
                         default=os.environ.get("YUZUNO_CORE_URL", DEFAULT_URL))
    desktop.add_argument("--web", action="store_true", help="Open a browser instead of Tauri")
    desktop.add_argument("--desktop-bin", type=Path, help="Use a previously built native client instead of cargo run")
    return result


def core_command(args):
    binary = ROOT / "target/debug" / ("yuzuno-workspace.exe" if os.name == "nt" else "yuzuno-workspace")
    if not binary.is_file():
        raise RuntimeError("Build Core first on this machine: cargo build --locked")
    if not (args.web_dir / "index.html").is_file():
        raise RuntimeError("Core's web assets are missing: cd web && npm ci && npm run build")
    command = [str(binary)]
    for key in ["port", "data_dir", "web_dir", "cwd", "codex"]:
        value = getattr(args, key)
        if value is not None:
            command.extend(["--" + key.replace("_", "-"), str(value)])
    return command


def desktop_command(args):
    if args.desktop_bin:
        return [str(args.desktop_bin.resolve()), "--core-url", args.core_url]
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin" / ("cargo.exe" if os.name == "nt" else "cargo"))
    return [cargo, "run", "--manifest-path", str(ROOT / "desktop/Cargo.toml"), "--", "--core-url", args.core_url]


def main():
    args = parser().parse_args()
    if args.mode == "core":
        # Foreground by design. Use the host's normal terminal/service manager
        # to keep Core running; there is no client-owned daemon or PID registry.
        raise SystemExit(subprocess.call(core_command(args), cwd=ROOT))
    if args.web:
        if not webbrowser.open(args.core_url):
            print(f"Open {args.core_url}")
    else:
        # This path does not inspect Core assets, local Codex, or workspace DB.
        raise SystemExit(subprocess.call(desktop_command(args), cwd=ROOT))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(str(error))
