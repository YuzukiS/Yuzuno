"""Small shared helpers for the repository's release scripts (stdlib only)."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


# The Claude Agent SDK is not in a public release (T-159): its runtime carries
# claude-agent-sdk.json instead, and Core obtains the SDK on the user's
# machine. A release still has a file at the SDK's package.json, because
# installed Cores (core.12 and earlier) refuse a release without one; it is
# this placeholder, written by Yuzuno, not a file of the SDK.
CLAUDE_SDK_PACKAGE = 'node_modules/@anthropic-ai/claude-agent-sdk'
CLAUDE_SDK_MANIFEST = 'claude-agent-sdk.json'
CLAUDE_SDK_PLACEHOLDER = (json.dumps({
    'private': True,
    'yuzunoPlaceholder': True,
    'description': 'Written by Yuzuno. This is not the Claude Agent SDK and cannot be imported. '
                   'Yuzuno Core obtains the SDK on this machine, as ../../../claude-agent-sdk.json names it.',
}, indent=2) + '\n').encode()


# Where the Claude Agent SDK's packages would be in release inputs:
# tools/build-core-artifact.py copies the Claude runtime to claude/. The
# prefix also covers the SDK's per-platform packages.
CLAUDE_SDK = 'claude/node_modules/@anthropic-ai/claude-agent-sdk'


def claude_sdk_files(files):
    """The paths of `files` (an inventory) that belong to the Claude Agent
    SDK. Public release inputs must have none (docs/public-readiness.md)."""
    return sorted(path for path in files if path == CLAUDE_SDK or path.startswith(CLAUDE_SDK + '/')
                  or path.startswith(CLAUDE_SDK + '-'))


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def command(argv, **kwargs):
    return subprocess.check_output(list(map(str, argv)), text=True, **kwargs).strip()


def inventory(root):
    root = Path(root)
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlink in release: {path}')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = {
                'sha256': digest(path), 'bytes': path.stat().st_size,
                'executable': bool(path.stat().st_mode & 0o111)}
        elif not path.is_dir():
            raise ValueError(f'Non-regular release input: {path}')
    return result


def verify_tree(root, expected):
    if inventory(root) != expected:
        raise ValueError(f'Release contents changed: {root}')


def extract(archive, destination):
    """Accept only bounded, unique regular files/directories, never links."""
    destination = Path(destination)
    if destination.exists():
        raise ValueError('Extraction destination already exists')
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        seen, size = set(), 0
        for item in members:
            path = PurePosixPath(item.name)
            if (not item.name or path.is_absolute() or '..' in path.parts or
                    '\\' in item.name or item.name in seen or
                    not (item.isfile() or item.isdir())):
                raise ValueError(f'Unsafe archive member: {item.name}')
            seen.add(item.name)
            size += item.size
        if len(members) > 30000 or size > 2 * 1024**3:
            raise ValueError('Release archive exceeds the supported size')
        # Validate the whole namespace before creating any file.
        files = {PurePosixPath(m.name) for m in members if m.isfile()}
        if any(parent in files for item in files for parent in item.parents):
            raise ValueError('Archive file/directory collision')
        destination.mkdir(parents=True)
        for item in members:
            target = destination / item.name
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(item) as source, target.open('xb') as output:
                    import shutil
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if item.mode & 0o111 else 0o644)


def archive_tree(root, output):
    root = Path(root)
    files = inventory(root)
    with tarfile.open(output, 'w:gz', format=tarfile.GNU_FORMAT) as tar:
        for name in files:
            path = root / name
            info = tar.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            with path.open('rb') as stream:
                tar.addfile(info, stream)
    return files
