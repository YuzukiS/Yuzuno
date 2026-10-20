#!/usr/bin/env python3
"""Build version-neutral production inputs once, in an isolated Linux checkout."""
import argparse
import importlib.util
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import archive_tree, command, digest, write
import claude_sdk_release

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'x86_64-unknown-linux-gnu'
GLIBC_TARGET = TARGET + '.2.35'


def public_build_environment(inherited, root, target):
    """Keep compiler options, but replace host source paths in shipped binaries."""
    env = dict(inherited)
    encoded = env.pop('CARGO_ENCODED_RUSTFLAGS', None)
    flags = encoded.split('\x1f') if encoded else shlex.split(env.get('RUSTFLAGS', ''))
    env.pop('RUSTFLAGS', None)
    # rustc applies the last matching mapping. Specific directories follow HOME.
    mappings = [(Path(env.get('HOME', str(Path.home()))), '/home/builder'),
                (Path(env.get('CARGO_HOME', str(Path.home() / '.cargo'))), '/opt/cargo'),
                (Path(root), '/workspace/yuzuno'), (Path(target), '/build/target')]
    for source, public in mappings:
        flags.append(f'--remap-path-prefix={source.resolve()}={public}')
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
    return env


def check_public_paths(path, private_roots):
    """Check actual output bytes too: remapping cannot rewrite arbitrary env!."""
    data = Path(path).read_bytes()
    if any(str(Path(root).resolve()).encode() in data for root in private_roots):
        raise ValueError(f'Build-machine path remains in release input: {Path(path).name}')


def build(out):
    out = out.resolve()
    if out.exists() or not out.is_relative_to(ROOT / 'target'):
        raise ValueError('Use a new output under this isolated checkout/target')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('First CI artifact targets Linux/WSL x86_64')
    sha = command(['git', 'rev-parse', 'HEAD'], cwd=ROOT)
    if command(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT):
        raise ValueError('Tracked source differs from the fixed commit')
    if os.environ.get('GITHUB_SHA', sha) != sha:
        raise ValueError('CI SHA differs from checkout')
    # Detect missing/wrong linker setup before doing a production build.
    linker = {'cargoZigbuild': command(['cargo-zigbuild', '--version']),
              'zig': command([sys.executable, '-m', 'ziglang', 'version'])}
    toolchains = {tool: command([tool, '--version']) for tool in ('rustc', 'cargo', 'node', 'npm')}
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.build-inputs-', dir=out.parent))
    release_target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'target')) / 'release-artifact-cargo'
    env = public_build_environment(dict(os.environ,
        CARGO_TARGET_DIR=str(release_target), NODE_OPTIONS='--max-old-space-size=2048'),
        ROOT, release_target)
    private_roots = [ROOT, release_target, Path.home(),
                     Path(env.get('CARGO_HOME', str(Path.home() / '.cargo')))]
    def run(argv, cwd=ROOT):
        subprocess.run(list(map(str, argv)), cwd=cwd, env=env, check=True)
    try:
        run(['cargo', 'zigbuild', '--target', GLIBC_TARGET, '--locked', '--release', '--features', 'bundled-release', '-j', '1', '-p', 'yuzuno-workspace',
             '--bin', 'yuzuno-workspace', '--bin', 'yuzuno-update-helper'])
        inputs = stage / 'inputs'
        (inputs / 'bin').mkdir(parents=True)
        compatibility = {}
        for name in ('yuzuno-workspace', 'yuzuno-update-helper'):
            binary = Path(env['CARGO_TARGET_DIR']) / TARGET / 'release' / name
            versions = command(['objdump', '-T', binary])
            required = sorted(set(re.findall(r'GLIBC_(\d+\.\d+)', versions)), key=lambda x: tuple(map(int, x.split('.'))))
            if not required or tuple(map(int, required[-1].split('.'))) > (2, 35):
                raise ValueError(f'{name} requires a newer glibc than 2.35: {required}')
            dynamic = command(['objdump', '-p', binary])
            needed = re.findall(r'NEEDED\s+(\S+)', dynamic)
            if set(needed) - {'libgcc_s.so.1', 'libm.so.6', 'libc.so.6', 'ld-linux-x86-64.so.2', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1'}:
                raise ValueError(f'Unexpected host library dependency: {needed}')
            compatibility[name] = {'glibcMax': required[-1], 'needed': needed}
            shutil.copy2(binary, inputs / 'bin' / name)
            run([binary, '--help'])
        # The binaries' notices, from the crates this build linked and the
        # toolchain that built them, and the project license (T-90).
        run([sys.executable, ROOT / 'tools/third_party_notices.py', '--target', TARGET, '--out', inputs / 'licenses'])
        shutil.copy2(ROOT / 'LICENSE', inputs / 'licenses/LICENSE')
        run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ROOT / 'web')
        run(['node', 'node_modules/typescript/bin/tsc', '--noEmit'], ROOT / 'web')
        run(['node', 'node_modules/vite/bin/vite.js', 'build', '--outDir', inputs / 'web'], ROOT / 'web')
        run(['node', '--experimental-strip-types', 'tools/result-validator.mjs', '--check'], ROOT / 'web')
        spec = importlib.util.spec_from_file_location('packager', ROOT / 'tools/package-release.py')
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        runtime = stage / 'runtime'
        shutil.copytree(ROOT / 'runtimes/claude', runtime, ignore=shutil.ignore_patterns('node_modules'))
        run(['npm', 'ci', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], runtime)
        run(['node', '--input-type=module', '-e', 'await Promise.all([import("@anthropic-ai/claude-agent-sdk"),import("zod"),import("./review.mjs")])'], runtime)
        # The runtime's notices, after checking the installed packages against
        # its lock file's production set (T-90).
        run([sys.executable, ROOT / 'tools/runtime_notices.py', '--runtime', runtime,
             '--out', inputs / 'licenses/THIRD_PARTY_NOTICES-claude-runtime.txt'])
        # The SDK is not shipped: Core obtains it on the user's machine, as
        # claude-agent-sdk.json names it (T-159; docs/public-readiness.md).
        claude_sdk_release.leave_out_sdk(runtime)
        packager.copy_tree(runtime, inputs / 'claude')
        packager.copy_tree(ROOT / 'runtimes/result-validator', inputs / 'result-validator')
        # Built on Windows from a fixed commit and committed (T-108): only if
        # it was built from this tree's windows_job.cs and speaks its protocol.
        windows_helper = packager.check_windows_helper(ROOT / 'runtimes/windows-jobs', ROOT / 'core/src/jobs/windows_job.cs')
        (inputs / 'windows-jobs').mkdir()
        for name in packager.WINDOWS_HELPER:
            shutil.copy2(ROOT / 'runtimes/windows-jobs' / name, inputs / 'windows-jobs' / name)
        for path in inputs.rglob('*'):
            if path.is_file():
                check_public_paths(path, private_roots)
        product = stage / 'product'
        product.mkdir()
        archive = product / 'inputs.tar.gz'
        files = archive_tree(inputs, archive)
        write(product / 'build.json', {'format': 1, 'source': sha,
            'tree': command(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT),
            'repository': os.environ.get('GITHUB_REPOSITORY'), 'runId': os.environ.get('GITHUB_RUN_ID'),
            'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'platform': 'linux-x86_64',
            'host': platform.platform(), 'buildTarget': GLIBC_TARGET,
            'linker': linker,
            'toolchains': toolchains,
            'compatibility': compatibility, 'windowsHelper': windows_helper,
            'archiveSha256': digest(archive), 'files': files})
        product.rename(out)
    finally:
        shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    build(parser.parse_args().out)
