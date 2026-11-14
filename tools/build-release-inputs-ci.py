#!/usr/bin/env python3
"""Prepare fresh release tools/caches on a GitHub-hosted runner, then build
one platform's release inputs with tools/build-core-artifact.py."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import digest

ROOT = Path(__file__).resolve().parents[1]
RUST = '1.97.1'
NODE = '22.23.2'
RUSTUP = '1.29.1'
# Per platform: rustup-init's host triple and Node's archive name, each with
# the SHA-256 its publisher lists (static.rust-lang.org/rustup/archive/
# <version>/<triple>/rustup-init.sha256; nodejs.org/dist/v<version>/
# SHASUMS256.txt). `zig`: cross-link for an older glibc with cargo-zigbuild
# (release-linker-requirements.txt); macOS links with Apple's own linker.
PLATFORMS = {
    'linux-x86_64': {
        'rustup': ('x86_64-unknown-linux-gnu', 'dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71'),
        'node': ('linux-x64', 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307'),
        'zig': True,
    },
    'macos-aarch64': {
        'rustup': ('aarch64-apple-darwin', 'ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a'),
        'node': ('darwin-arm64', '5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1'),
        'zig': False,
    },
}


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
    actual = digest(destination)
    if actual != expected:
        raise ValueError(f'Checksum mismatch for {url}: {actual}')


def prepare(work, platform):
    # Fail before downloading if the workflow and pinned downloads disagree.
    if os.environ.get('RUST_TOOLCHAIN', RUST) != RUST or os.environ.get('NODE_VERSION', NODE) != NODE:
        raise ValueError('Update the pinned release downloads with the workflow toolchains')
    pins = PLATFORMS[platform]
    (work / 'tmp').mkdir()
    (work / 'node').mkdir()
    (work / 'npmrc-user').touch()
    (work / 'npmrc-global').touch()
    env = release_environment(work, os.environ)
    def run(argv):
        subprocess.run(list(map(str, argv)), cwd=ROOT, env=env, check=True)
    rustup = work / 'rustup-init'
    triple, rustup_sha256 = pins['rustup']
    download(f'https://static.rust-lang.org/rustup/archive/{RUSTUP}/{triple}/rustup-init', rustup, rustup_sha256)
    rustup.chmod(0o700)
    run([rustup, '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', RUST])
    node = work / 'node.tar.xz'
    name, node_sha256 = pins['node']
    download(f'https://nodejs.org/dist/v{NODE}/node-v{NODE}-{name}.tar.xz', node, node_sha256)
    run(['/usr/bin/tar', '-xJf', node, '--strip-components=1', '-C', work / 'node'])
    if pins['zig']:
        run(['/usr/bin/python3', '-I', '-m', 'venv', work / 'venv'])
        run([work / 'venv/bin/python', '-I', '-m', 'pip', '--isolated', 'install',
             '--no-cache-dir', '--only-binary=:all:', '--require-hashes',
             '-r', ROOT / 'tools/release-linker-requirements.txt'])
    return env


def build(out, platform):
    with tempfile.TemporaryDirectory(prefix='yuzuno-release-', dir=os.environ['RUNNER_TEMP']) as temporary:
        work = Path(temporary)
        env = prepare(work, platform)
        # The venv's Python finds cargo-zigbuild's zig; without zig, the
        # system's own Python (on a Mac, the command line tools' 3.9).
        python = work / 'venv/bin/python' if PLATFORMS[platform]['zig'] else Path('/usr/bin/python3')
        subprocess.run([str(python), '-I', str(ROOT / 'tools/build-core-artifact.py'),
                        '--platform', platform, '--out', str(out)], cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--platform', choices=sorted(PLATFORMS), default='linux-x86_64')
    args = parser.parse_args()
    build(args.out, args.platform)
