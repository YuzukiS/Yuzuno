#!/usr/bin/env python3
"""Prepare fresh release tools/caches on the trusted self-hosted CI machine."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUST = '1.97.1'
NODE = '22.23.2'
RUSTUP = '1.29.1'
RUSTUP_SHA256 = 'dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71'
NODE_SHA256 = 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307'


def release_environment(work, inherited):
    # Keep the real HOME; select fresh tool/config paths explicitly. No shell,
    # compiler, linker, Python, npm or credential overrides from a prior job.
    env = {key: inherited[key] for key in (
        'HOME', 'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT') if key in inherited}
    env.update({
        'PATH': f'{work}/venv/bin:{work}/cargo/bin:{work}/node/bin:/usr/bin:/bin',
        'LANG': 'C.UTF-8', 'CARGO_HOME': str(work / 'cargo'),
        'RUSTUP_HOME': str(work / 'rustup'), 'RUSTUP_TOOLCHAIN': RUST,
        'CARGO_TARGET_DIR': str(work / 'target'), 'CARGO_BUILD_JOBS': '1',
        'NPM_CONFIG_CACHE': str(work / 'npm'), 'NPM_CONFIG_USERCONFIG': str(work / 'npmrc-user'),
        'NPM_CONFIG_GLOBALCONFIG': str(work / 'npmrc-global'), 'XDG_CACHE_HOME': str(work / 'cache'),
        'ZIG_GLOBAL_CACHE_DIR': str(work / 'zig'),
        'CARGO_ZIGBUILD_CACHE_DIR': str(work / 'zigbuild'),
        'CARGO_ZIGBUILD_PYTHON_PATH': str(work / 'venv/bin/python'),
        'PIP_CONFIG_FILE': '/dev/null', 'PIP_NO_CACHE_DIR': '1',
        'PYTHONNOUSERSITE': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_CONFIG_NOSYSTEM': '1', 'TMPDIR': str(work / 'tmp'),
    })
    return env


def download(url, destination, expected):
    with urllib.request.urlopen(url, timeout=60) as source, destination.open('wb') as out:
        while chunk := source.read(1024 * 1024):
            out.write(chunk)
    with destination.open('rb') as source:
        actual = hashlib.file_digest(source, 'sha256').hexdigest()
    if actual != expected:
        raise ValueError(f'Checksum mismatch for {url}: {actual}')


def prepare(work):
    # Fail before downloading if the workflow and pinned downloads disagree.
    if os.environ.get('RUST_TOOLCHAIN', RUST) != RUST or os.environ.get('NODE_VERSION', NODE) != NODE:
        raise ValueError('Update the pinned release downloads with the workflow toolchains')
    (work / 'tmp').mkdir()
    (work / 'node').mkdir()
    (work / 'npmrc-user').touch()
    (work / 'npmrc-global').touch()
    env = release_environment(work, os.environ)
    def run(argv):
        subprocess.run(list(map(str, argv)), cwd=ROOT, env=env, check=True)
    rustup = work / 'rustup-init'
    download(f'https://static.rust-lang.org/rustup/archive/{RUSTUP}/x86_64-unknown-linux-gnu/rustup-init', rustup, RUSTUP_SHA256)
    rustup.chmod(0o700)
    run([rustup, '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', RUST])
    node = work / 'node.tar.xz'
    download(f'https://nodejs.org/dist/v{NODE}/node-v{NODE}-linux-x64.tar.xz', node, NODE_SHA256)
    run(['/usr/bin/tar', '-xJf', node, '--strip-components=1', '-C', work / 'node'])
    run(['/usr/bin/python3', '-I', '-m', 'venv', work / 'venv'])
    run([work / 'venv/bin/python', '-I', '-m', 'pip', '--isolated', 'install',
         '--no-cache-dir', '--only-binary=:all:', '--require-hashes',
         '-r', ROOT / 'tools/release-linker-requirements.txt'])
    return env


def build(out):
    with tempfile.TemporaryDirectory(prefix='yuzuno-release-', dir=os.environ['RUNNER_TEMP']) as temporary:
        work = Path(temporary)
        env = prepare(work)
        subprocess.run([str(work / 'venv/bin/python'), '-I', str(ROOT / 'tools/build-core-artifact.py'),
                        '--out', str(out)], cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    build(parser.parse_args().out)
