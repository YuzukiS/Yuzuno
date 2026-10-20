"""Leaves the Claude Agent SDK out of a release's Claude runtime (T-159).

tools/build-core-artifact.py installs the runtime with `npm ci` from the lock
file, checks that it loads and writes its notices; then this replaces the
installed SDK package with:
- claude-agent-sdk.json: the locked name, version, registry URL and integrity,
  and every file of the installed package with its size and SHA-256, which
  Core checks the copy it obtains on the user's machine against;
- the placeholder package.json at the package's path (release_common), so
  that installed Cores, which require a file there, still accept the release.
"""
import json
from pathlib import Path
import shutil
from release_common import (CLAUDE_SDK_MANIFEST, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_PLACEHOLDER, inventory, write)

NAME = '@anthropic-ai/claude-agent-sdk'


def leave_out_sdk(runtime):
    """Replace the installed SDK in `runtime` with its manifest and the
    placeholder. Returns the manifest."""
    runtime = Path(runtime)
    lock = json.loads((runtime / 'package-lock.json').read_text())
    locked = lock['packages'].get(CLAUDE_SDK_PACKAGE)
    if not locked or locked.get('name', NAME) != NAME:
        raise ValueError(f'The lock file has no {NAME}')
    package = runtime / CLAUDE_SDK_PACKAGE
    installed = json.loads((package / 'package.json').read_text())
    if installed.get('name') != NAME or installed.get('version') != locked['version']:
        raise ValueError(f"The installed {NAME} is not the locked {locked['version']}")
    if not str(locked.get('integrity', '')).startswith('sha512-') or not str(locked.get('resolved', '')).startswith('https://'):
        raise ValueError(f'The lock file names no HTTPS source and sha512 integrity for {NAME}')
    files = {path: {'sha256': entry['sha256'], 'bytes': entry['bytes']} for path, entry in inventory(package).items()}
    manifest = {'format': 1, 'name': NAME, 'version': locked['version'], 'resolved': locked['resolved'],
                'integrity': locked['integrity'], 'files': files}
    write(runtime / CLAUDE_SDK_MANIFEST, manifest)
    shutil.rmtree(package)
    package.mkdir()
    (package / 'package.json').write_bytes(CLAUDE_SDK_PLACEHOLDER)
    return manifest


def sdk_left_out(runtime):
    """Whether `runtime` has the manifest and, at the SDK's path, only the
    placeholder."""
    runtime = Path(runtime)
    package = runtime / CLAUDE_SDK_PACKAGE
    return ((runtime / CLAUDE_SDK_MANIFEST).is_file() and package.is_dir()
            and sorted(p.name for p in package.iterdir()) == ['package.json']
            and (package / 'package.json').read_bytes() == CLAUDE_SDK_PLACEHOLDER)
