#!/usr/bin/env python3
"""Create three signed GitHub assets from an existing T-12 bundle. Never publish.

Signing uses the official minisign executable and an operator-supplied key file.
This tool does not create a publisher identity or read/export the secret key.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def assemble(args):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        raise ValueError('Use an explicit GitHub owner/repo')
    if not re.fullmatch(r'core-[A-Za-z0-9_.-]+', args.tag):
        raise ValueError('Core release tags must begin with core-')
    root = args.bundle.resolve(strict=True)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest['platform'] not in ('linux-x86_64', 'linux-aarch64'):
        raise ValueError('Unsupported Core release platform')
    files = manifest['files']
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != set(files) | {'manifest.json'} or any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Bundle contains missing/unlisted files or symlinks')
    for name, metadata in files.items():
        path = root / name
        if path.stat().st_size != metadata['bytes'] or digest(path) != metadata['sha256']:
            raise ValueError(f'Bundle checksum differs: {name}')
    out = args.out.resolve()
    if out.exists():
        raise ValueError('Release output is immutable; choose a new directory')
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.signed-release-', dir=out.parent))
    try:
        prefix = f"yuzuno-core-{manifest['platform']}"
        archive = staging / (prefix + '.tar.gz')
        with tarfile.open(archive, 'w:gz', format=tarfile.GNU_FORMAT) as tar:
            for name in sorted(actual):
                path = root / name
                info = tar.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                with path.open('rb') as f:
                    tar.addfile(info, f)
        descriptor = staging / (prefix + '.json')
        descriptor.write_text(json.dumps({
            'format': 1, 'repository': args.repository, 'tag': args.tag,
            'manifest': manifest, 'manifestSha256': digest(root / 'manifest.json'),
            'archiveSha256': digest(archive), 'archiveBytes': archive.stat().st_size,
        }, ensure_ascii=False, indent=2) + '\n')
        subprocess.run([args.minisign, '-S', '-s', str(args.signing_key.resolve()), '-m', str(descriptor),
                        '-x', str(descriptor) + '.minisig', '-t', f'Yuzuno Core {args.tag}'], check=True)
        subprocess.run([args.minisign, '-V', '-p', str(args.public_key.resolve()), '-m', str(descriptor),
                        '-x', str(descriptor) + '.minisig'], check=True)
        staging.rename(out)
        print(json.dumps({'directory': str(out), 'tag': args.tag, 'repository': args.repository,
                          'assets': sorted(p.name for p in out.iterdir())}))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('bundle', 'out', 'signing-key', 'public-key'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('repository', 'tag'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--minisign', default='minisign')
    assemble(parser.parse_args())
