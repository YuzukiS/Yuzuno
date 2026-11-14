#!/usr/bin/env python3
"""Build version-neutral production inputs once, in an isolated checkout, for
one platform: linux-x86_64 on Linux x86_64, macos-aarch64 on an Apple silicon
Mac (YN-108). Every check of the binaries fails the build."""
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
from release_common import archive_tree, command, digest, macho_minimum, write
import claude_sdk_release

ROOT = Path(__file__).resolve().parents[1]
# Per platform: the host it is built on, as Python's platform module names
# it, and the Rust target.
PLATFORMS = {
    'linux-x86_64': (('Linux', 'x86_64'), 'x86_64-unknown-linux-gnu'),
    'macos-aarch64': (('Darwin', 'arm64'), 'aarch64-apple-darwin'),
}
GLIBC_TARGET = 'x86_64-unknown-linux-gnu.2.35'
# The oldest macOS the binaries run on: Rust's minimum for
# aarch64-apple-darwin (its platform support page), and the desktop app's
# (desktop/README.md). Set as MACOSX_DEPLOYMENT_TARGET for the build.
MACOS_MINIMUM = '11.0'
# All the Mac binaries may link: what a release build of both links on
# Apple silicon (measured, YN-108 design, Job 192218a7). Any other library
# fails the build; add one only after review.
MACOS_LIBRARIES = frozenset({
    '/usr/lib/libSystem.B.dylib',
    '/usr/lib/libiconv.2.dylib',
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
})
# The linker's own ad hoc signature: Apple silicon runs only signed code,
# and ad hoc is enough. Signing again (codesign) drops linker-signed, and
# any other change to the bytes breaks the signature. Apple's strip signs
# again as the linker did, which no flag shows: that the shipped bytes are
# cargo's own output is checked by their SHA-256 (YN-118, Job 54fcf4a8).
MACOS_SIGNATURE = frozenset({'adhoc', 'linker-signed'})


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


def tool_output(argv):
    """What a tool that must succeed printed, stdout then stderr: codesign -dv
    and ld -v print to stderr."""
    done = subprocess.run(list(map(str, argv)), capture_output=True, text=True)
    if done.returncode:
        raise ValueError(f'{" ".join(map(str, argv))} failed ({done.returncode}): {(done.stdout + done.stderr).strip()[-2000:]}')
    return (done.stdout + done.stderr).strip()


def check_linux_binary(binary):
    """glibc 2.35 at most, and only the C runtime's libraries."""
    name = Path(binary).name
    versions = command(['objdump', '-T', binary])
    required = sorted(set(re.findall(r'GLIBC_(\d+\.\d+)', versions)), key=lambda x: tuple(map(int, x.split('.'))))
    if not required or tuple(map(int, required[-1].split('.'))) > (2, 35):
        raise ValueError(f'{name} requires a newer glibc than 2.35: {required}')
    dynamic = command(['objdump', '-p', binary])
    needed = re.findall(r'NEEDED\s+(\S+)', dynamic)
    if set(needed) - {'libgcc_s.so.1', 'libm.so.6', 'libc.so.6', 'ld-linux-x86-64.so.2', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1'}:
        raise ValueError(f'Unexpected host library dependency: {needed}')
    return {'glibcMax': required[-1], 'needed': needed}


def check_macos_binary(binary, output=tool_output):
    """The four checks of a Mac binary (YN-108 design 3.1), each of which
    fails the build: arm64 alone (lipo); built for macOS MACOS_MINIMUM
    (vtool, and the file's own load command); links nothing but
    MACOS_LIBRARIES (otool -L); and carries a valid ad hoc signature of the
    linker's own (codesign)."""
    name = Path(binary).name
    archs = output(['lipo', '-archs', binary]).split()
    if archs != ['arm64']:
        raise ValueError(f'{name} is for {archs}, not arm64 alone')
    shown = output(['vtool', '-show-build', binary])
    platforms = re.findall(r'^\s*platform\s+(\S+)\s*$', shown, re.M)
    minos = re.findall(r'^\s*minos\s+(\S+)\s*$', shown, re.M)
    if platforms != ['MACOS'] or minos != [MACOS_MINIMUM]:
        raise ValueError(f'{name} is built for {platforms} minos {minos}, not MACOS minos {MACOS_MINIMUM}')
    header = macho_minimum(binary)
    if header != MACOS_MINIMUM + '.0':
        raise ValueError(f'{name}: its load command says macOS {header}, not {MACOS_MINIMUM}')
    # The first line names the file; each other one a library it links.
    libraries = []
    for line in output(['otool', '-L', binary]).splitlines()[1:]:
        match = re.fullmatch(r'\s+(/\S+) \(compatibility version [^()]*\)', line)
        if not match:
            raise ValueError(f'{name}: otool -L printed a line this check does not read: {line!r}')
        libraries.append(match[1])
    if '/usr/lib/libSystem.B.dylib' not in libraries or set(libraries) - MACOS_LIBRARIES:
        raise ValueError(f'{name} links {sorted(set(libraries) - MACOS_LIBRARIES) or libraries}, outside the reviewed list')
    output(['codesign', '--verify', '--strict', binary])
    flags = re.findall(r'\bflags=0x[0-9a-f]+\(([^()]*)\)', output(['codesign', '-dv', binary]))
    if len(flags) != 1 or set(flags[0].split(',')) != MACOS_SIGNATURE:
        raise ValueError(f'{name} is signed with flags {flags}, not {",".join(sorted(MACOS_SIGNATURE))}')
    return {'minos': MACOS_MINIMUM, 'archs': archs, 'libraries': sorted(libraries), 'signature': sorted(MACOS_SIGNATURE)}


def build(out, target_platform='linux-x86_64'):
    out = out.resolve()
    if out.exists() or not out.is_relative_to(ROOT / 'target'):
        raise ValueError('Use a new output under this isolated checkout/target')
    host, target = PLATFORMS[target_platform]
    macos = target_platform == 'macos-aarch64'
    if (platform.system(), platform.machine()) != host:
        raise ValueError(f'{target_platform} release inputs are built on {" ".join(host)}, not {platform.system()} {platform.machine()}')
    sha = command(['git', 'rev-parse', 'HEAD'], cwd=ROOT)
    if command(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT):
        raise ValueError('Tracked source differs from the fixed commit')
    if os.environ.get('GITHUB_SHA', sha) != sha:
        raise ValueError('CI SHA differs from checkout')
    toolchains = {tool: command([tool, '--version']) for tool in ('rustc', 'cargo', 'node', 'npm')}
    if macos:
        # The macosx SDK of the selected Xcode or command line tools, which
        # the whole build uses (SDKROOT below), and Apple's linker.
        sdk_root = command(['xcrun', '--sdk', 'macosx', '--show-sdk-path'])
        toolchains.update({'sdk': command(['xcrun', '--sdk', 'macosx', '--show-sdk-version']), 'sdkRoot': sdk_root,
                           'ld': tool_output(['ld', '-v']), 'macos': tool_output(['sw_vers'])})
    else:
        # Detect missing/wrong linker setup before doing a production build.
        linker = {'cargoZigbuild': command(['cargo-zigbuild', '--version']),
                  'zig': command([sys.executable, '-m', 'ziglang', 'version'])}
    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.build-inputs-', dir=out.parent))
    release_target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'target')) / 'release-artifact-cargo'
    env = public_build_environment(dict(os.environ,
        CARGO_TARGET_DIR=str(release_target), NODE_OPTIONS='--max-old-space-size=2048'),
        ROOT, release_target)
    if macos:
        env['MACOSX_DEPLOYMENT_TARGET'] = MACOS_MINIMUM
        # rustc, the cc crate and clang all read SDKROOT. Without it a link
        # can take xcrun's default SDK instead, which on a Mac with both
        # Xcode and the command line tools can be another one, even one
        # this linker cannot read (YN-118, Jobs 194d8deb and 01c0641e).
        env['SDKROOT'] = sdk_root
    private_roots = [ROOT, release_target, Path.home(),
                     Path(env.get('CARGO_HOME', str(Path.home() / '.cargo')))]
    def run(argv, cwd=ROOT):
        subprocess.run(list(map(str, argv)), cwd=cwd, env=env, check=True)
    try:
        spec = importlib.util.spec_from_file_location('packager', ROOT / 'tools/package-release.py')
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        # The result validator first (YN-22): it is generated, not committed,
        # and the release Core compiles in its SHA-256 and runs no other
        # bundle. A bundled-release build without the value does not compile.
        # --check first: the committed contract.json must already match.
        validator = ROOT / 'runtimes/result-validator'
        run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ROOT / 'web')
        run(['node', '--experimental-strip-types', 'tools/result-validator.mjs', '--check'], ROOT / 'web')
        run(['node', '--experimental-strip-types', 'tools/result-validator.mjs'], ROOT / 'web')
        env['YUZUNO_RESULT_VALIDATOR_SHA256'] = digest(validator / 'validator.mjs')
        build_target = target if macos else GLIBC_TARGET
        run(['cargo', 'build' if macos else 'zigbuild', '--target', build_target, '--locked', '--release', '--features', 'bundled-release', '-j', '1', '-p', 'yuzuno-workspace',
             '--bin', 'yuzuno-workspace', '--bin', 'yuzuno-update-helper'])
        inputs = stage / 'inputs'
        (inputs / 'bin').mkdir(parents=True)
        compatibility = {}
        for name in ('yuzuno-workspace', 'yuzuno-update-helper'):
            binary = Path(env['CARGO_TARGET_DIR']) / target / 'release' / name
            shipped = inputs / 'bin' / name
            shutil.copy2(binary, shipped)
            if digest(shipped) != digest(binary):
                raise ValueError(f'{name} changed when copied into the inputs')
            # Checked as shipped: these very bytes go into the release.
            compatibility[name] = check_macos_binary(shipped) if macos else check_linux_binary(shipped)
            run([binary, '--help'])
        # The binaries' notices, from the crates this build linked and the
        # toolchain that built them, and the project license (T-90).
        run([sys.executable, ROOT / 'tools/third_party_notices.py', '--target', target, '--out', inputs / 'licenses'])
        shutil.copy2(ROOT / 'LICENSE', inputs / 'licenses/LICENSE')
        run(['node', 'node_modules/typescript/bin/tsc', '--noEmit'], ROOT / 'web')
        run(['node', 'node_modules/vite/bin/vite.js', 'build', '--outDir', inputs / 'web'], ROOT / 'web')
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
        # The bundle the Core above was built for, and only it.
        packager.check_result_validator(validator, inputs / 'bin/yuzuno-workspace')
        packager.copy_tree(validator, inputs / 'result-validator')
        # Built on Windows from a fixed commit and committed (T-108): only if
        # it was built from this tree's windows_job.cs and speaks its protocol.
        # Only Linux inputs carry it: WSL runs it on the Windows side, and a
        # Mac has no use for it.
        if not macos:
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
        # Per platform: Linux records its zig linker, glibc and the Windows
        # Jobs helper; macOS its SDK, linker and system in toolchains, and
        # what check_macos_binary found as compatibility.
        write(product / 'build.json', {'format': 1, 'source': sha,
            'tree': command(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT),
            'repository': os.environ.get('GITHUB_REPOSITORY'), 'runId': os.environ.get('GITHUB_RUN_ID'),
            'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'platform': target_platform,
            'host': platform.platform(), 'buildTarget': build_target,
            **({} if macos else {'linker': linker}),
            'toolchains': toolchains,
            'compatibility': compatibility, **({} if macos else {'windowsHelper': windows_helper}),
            'archiveSha256': digest(archive), 'files': files})
        product.rename(out)
    finally:
        shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--platform', choices=sorted(PLATFORMS), default='linux-x86_64')
    args = parser.parse_args()
    build(args.out, args.platform)
