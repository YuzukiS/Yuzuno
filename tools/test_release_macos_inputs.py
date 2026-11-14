"""macOS release inputs (YN-108 M3a) without a Mac: the four checks of the
binaries against the Apple tools' real output, the Mach-O reader, the pinned
downloads per platform, and the smoke's unsigned package. No build, keys or
network."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from release_common import digest, inventory, macho_minimum


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('build_core_artifact', 'build-core-artifact.py')
ci = load('release_inputs_ci', 'build-release-inputs-ci.py')
smoke = load('release_inputs_smoke', 'release-inputs-smoke.py')

LC_BUILD_VERSION, LC_VERSION_MIN_MACOSX, LC_UUID = 0x32, 0x24, 0x1B


def version(text):
    major, minor = map(int, text.split('.'))
    return major << 16 | minor << 8


def macho(*commands):
    """A thin arm64 Mach-O header with these load commands."""
    body = b''.join(commands)
    return struct.pack('<IiiIIIII', 0xFEEDFACF, 0x0100000C, 0, 2, len(commands), len(body), 0, 0) + body


def build_version(minos='11.0', platform=1):
    return struct.pack('<IIIIII', LC_BUILD_VERSION, 24, platform, version(minos), version('26.5'), 0)


def version_min(minos):
    return struct.pack('<IIII', LC_VERSION_MIN_MACOSX, 16, version(minos), version('26.5'))


UUID = struct.pack('<II', LC_UUID, 24) + bytes(16)

# What the Apple tools printed for a release build on the user's Mac mini
# (YN-108 design, Job 192218a7), with this test's own path.
LIPO = 'arm64'
VTOOL = '''{path}:
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos 11.0
      sdk 26.5
   ntools 1
     tool LD
  version 1221.4'''
OTOOL = '''{path}:
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 5026.5.4)
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)'''
CODESIGN = '''Executable={path}
Identifier=yuzuno_workspace-202f521e7664a57a
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=546248 flags=0x20002(adhoc,linker-signed) hashes=17066+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none'''


# Every script the Mac job runs or loads: it runs them with the command line
# tools' /usr/bin/python3, Python 3.9 (.github/workflows/release-inputs.yml).
MAC_SCRIPTS = ['build-release-inputs-ci.py', 'build-core-artifact.py', 'release_common.py',
               'claude_sdk_release.py', 'package-release.py', 'third_party_notices.py',
               'runtime_notices.py', 'release-inputs-check.py', 'release-inputs-smoke.py']
# What those scripts would most likely reach for that Python 3.9 lacks.
NEWER_THAN_39 = {'file_digest': 'hashlib.file_digest (3.11)', 'tomllib': 'tomllib (3.11)',
                 'pairwise': 'itertools.pairwise (3.10)', 'UTC': 'datetime.UTC (3.11)',
                 'batched': 'itertools.batched (3.12)'}


class MacPythonTests(unittest.TestCase):
    def test_the_scripts_the_mac_job_runs_keep_to_python_3_9(self):
        import ast
        for name in MAC_SCRIPTS:
            with self.subTest(name):
                tree = ast.parse((TOOLS / name).read_text(), name, feature_version=(3, 9))
                newer = [f'{NEWER_THAN_39[node.attr]} at line {node.lineno}' for node in ast.walk(tree)
                         if isinstance(node, ast.Attribute) and node.attr in NEWER_THAN_39]
                newer += [f'{NEWER_THAN_39[alias.name]} at line {node.lineno}' for node in ast.walk(tree)
                          if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names
                          if alias.name in NEWER_THAN_39]
                newer += [f'zip(strict=) at line {node.lineno}' for node in ast.walk(tree)
                          if isinstance(node, ast.Call) and getattr(node.func, 'id', None) == 'zip'
                          and any(keyword.arg == 'strict' for keyword in node.keywords)]
                self.assertEqual(newer, [])

    def test_the_mac_build_loads_no_other_tool(self):
        """A new import in the Mac build must be added to MAC_SCRIPTS."""
        import ast
        loaded = set()
        for name in MAC_SCRIPTS:
            tree = ast.parse((TOOLS / name).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module and (TOOLS / f'{node.module}.py').exists():
                    loaded.add(f'{node.module}.py')
                elif isinstance(node, ast.Import):
                    loaded.update(f'{alias.name}.py' for alias in node.names if (TOOLS / f'{alias.name}.py').exists())
                elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith('tools/') \
                        and node.value.endswith('.py'):
                    loaded.add(node.value.removeprefix('tools/'))
        self.assertLessEqual(loaded, set(MAC_SCRIPTS))


class MachOReaderTests(unittest.TestCase):
    def read(self, data):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'yuzuno-workspace'
            path.write_bytes(data)
            return macho_minimum(path)

    def test_the_one_macos_minimum_is_read_from_either_load_command(self):
        self.assertEqual(self.read(macho(UUID, build_version('11.0'))), '11.0.0')
        self.assertEqual(self.read(macho(build_version('13.4'), UUID)), '13.4.0')
        self.assertEqual(self.read(macho(version_min('10.15'))), '10.15.0')

    def test_anything_else_is_refused(self):
        for label, data in [
                ('ELF', b'\x7fELF' + bytes(60)),
                ('too short', macho()[:20]),
                ('none', macho(UUID)),
                ('only for iOS', macho(build_version('11.0', platform=2))),
                ('two', macho(build_version('11.0'), version_min('11.0'))),
                ('commands past the end', macho(build_version())[:-4]),
                ('an impossible command size', macho(struct.pack('<II', LC_UUID, 4) + bytes(20)))]:
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    self.read(data)

    def test_digest_reads_files_larger_than_one_chunk(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'large'
            data = os.urandom(3 * 1024 * 1024 + 7)
            path.write_bytes(data)
            self.assertEqual(digest(path), hashlib.sha256(data).hexdigest())


class MacBinaryChecksTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.binary = Path(temp.name) / 'yuzuno-workspace'
        self.binary.write_bytes(macho(UUID, build_version('11.0')))
        self.outputs = {'lipo': LIPO, 'vtool': VTOOL, 'otool': OTOOL, 'codesign -dv': CODESIGN}
        self.calls = []

    def output(self, argv):
        self.calls.append([str(part) for part in argv])
        key = 'codesign -dv' if argv[:2] == ['codesign', '-dv'] else 'codesign --verify' if argv[0] == 'codesign' else argv[0]
        value = self.outputs[key]
        if isinstance(value, Exception):
            raise value
        return value.format(path=self.binary)

    def check(self):
        return builder.check_macos_binary(self.binary, self.output)

    def test_the_binaries_of_a_release_build_pass_all_four(self):
        self.outputs['codesign --verify'] = ''
        self.assertEqual(self.check(), {
            'minos': '11.0', 'archs': ['arm64'], 'signature': ['adhoc', 'linker-signed'],
            'libraries': ['/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
                          '/usr/lib/libSystem.B.dylib', '/usr/lib/libiconv.2.dylib']})
        path = str(self.binary)
        self.assertEqual(self.calls, [['lipo', '-archs', path], ['vtool', '-show-build', path], ['otool', '-L', path],
                                      ['codesign', '--verify', '--strict', path], ['codesign', '-dv', path]])

    def test_each_failed_check_fails_the_build(self):
        library = '\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)'
        cases = {
            'universal': ({'lipo': 'x86_64 arm64'}, 'not arm64 alone'),
            'Intel': ({'lipo': 'x86_64'}, 'not arm64 alone'),
            'a newer minimum': ({'vtool': VTOOL.replace('minos 11.0', 'minos 12.0')}, 'not MACOS minos 11.0'),
            'Mac Catalyst': ({'vtool': VTOOL.replace('platform MACOS', 'platform MACCATALYST')}, 'not MACOS minos 11.0'),
            'no build version': ({'vtool': '{path}:'}, 'not MACOS minos 11.0'),
            'another library': ({'otool': OTOOL + '\n' + library}, '/usr/lib/libz.1.dylib'),
            'a library from Homebrew': ({'otool': OTOOL + '\n\t/opt/homebrew/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.0.0)'}, 'libssl'),
            'no libSystem': ({'otool': '\n'.join(OTOOL.splitlines()[:-1])}, 'outside the reviewed list'),
            'an unreadable otool line': ({'otool': OTOOL + '\n\tsomething else'}, 'does not read'),
            'a broken signature': ({'codesign --verify': ValueError('codesign --verify --strict failed (1): invalid signature')}, 'codesign --verify'),
            'signed again after the link': ({'codesign -dv': CODESIGN.replace('(adhoc,linker-signed)', '(adhoc)')}, 'not adhoc,linker-signed'),
            'a hardened runtime': ({'codesign -dv': CODESIGN.replace('(adhoc,linker-signed)', '(adhoc,linker-signed,runtime)')}, 'not adhoc,linker-signed'),
            'no code directory': ({'codesign -dv': 'Executable={path}\ncode object is not signed at all'}, 'not adhoc,linker-signed'),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                self.outputs = {'lipo': LIPO, 'vtool': VTOOL, 'otool': OTOOL, 'codesign -dv': CODESIGN, 'codesign --verify': ''}
                self.outputs.update(change)
                with self.assertRaisesRegex(ValueError, message):
                    self.check()

    def test_the_file_itself_must_say_the_same_minimum(self):
        self.outputs['codesign --verify'] = ''
        self.binary.write_bytes(macho(build_version('12.0')))
        with self.assertRaisesRegex(ValueError, 'load command says macOS 12.0.0'):
            self.check()
        self.binary.write_bytes(b'\x7fELF' + bytes(60))
        with self.assertRaisesRegex(ValueError, 'not a thin 64-bit Mach-O'):
            self.check()

    def test_a_tool_that_fails_or_prints_to_stderr_is_read_as_such(self):
        self.assertEqual(builder.tool_output(['/bin/sh', '-c', 'echo out; echo err >&2']), 'out\nerr')
        with self.assertRaisesRegex(ValueError, r'failed \(3\): no such thing'):
            builder.tool_output(['/bin/sh', '-c', 'echo no such thing >&2; exit 3'])

    def test_inputs_are_built_only_on_their_own_platform(self):
        out = builder.ROOT / 'target/yn118-never-written'
        for name, host in [('macos-aarch64', ('Linux', 'x86_64')), ('macos-aarch64', ('Darwin', 'x86_64')),
                           ('linux-x86_64', ('Darwin', 'arm64'))]:
            with self.subTest(f'{name} on {host}'):
                with patch.object(builder.platform, 'system', return_value=host[0]), \
                        patch.object(builder.platform, 'machine', return_value=host[1]):
                    with self.assertRaisesRegex(ValueError, 'release inputs are built on'):
                        builder.build(out, name)
        self.assertFalse(out.exists())


class PinnedDownloadsTests(unittest.TestCase):
    def test_every_platform_pins_both_downloads(self):
        self.assertEqual(sorted(ci.PLATFORMS), sorted(builder.PLATFORMS))
        for name, pins in ci.PLATFORMS.items():
            for what in ('rustup', 'node'):
                with self.subTest(f'{name} {what}'):
                    self.assertRegex(pins[what][1], r'^[0-9a-f]{64}$')
        self.assertEqual(ci.PLATFORMS['macos-aarch64']['rustup'][0], builder.PLATFORMS['macos-aarch64'][1])
        self.assertEqual(ci.PLATFORMS['linux-x86_64']['rustup'][0], builder.PLATFORMS['linux-x86_64'][1])

    def prepare(self, platform):
        downloads, commands = [], []
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(ci, 'download', lambda url, path, sha256: (downloads.append((url, sha256)), path.touch())), \
                patch.object(ci.subprocess, 'run', lambda argv, **kwargs: commands.append(argv)), \
                patch.dict(os.environ, {'RUST_TOOLCHAIN': ci.RUST, 'NODE_VERSION': ci.NODE}):
            ci.prepare(Path(temp), platform)
        return downloads, commands

    def test_a_mac_downloads_its_own_pinned_tools_and_no_zig(self):
        downloads, commands = self.prepare('macos-aarch64')
        self.assertEqual(downloads, [
            (f'https://static.rust-lang.org/rustup/archive/{ci.RUSTUP}/aarch64-apple-darwin/rustup-init',
             'ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a'),
            (f'https://nodejs.org/dist/v{ci.NODE}/node-v{ci.NODE}-darwin-arm64.tar.xz',
             '5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1')])
        self.assertFalse([argv for argv in commands if 'venv' in map(str, argv) or 'pip' in map(str, argv)])
        linux, commands = self.prepare('linux-x86_64')
        self.assertEqual([sha256 for _, sha256 in linux], [
            'dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71',
            'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307'])
        self.assertTrue([argv for argv in commands if '-r' in argv and str(argv[-1]).endswith('release-linker-requirements.txt')])

    def test_the_build_runs_for_the_platform_it_prepared(self):
        for name, python in [('macos-aarch64', '/usr/bin/python3'), ('linux-x86_64', 'venv/bin/python')]:
            with self.subTest(name), tempfile.TemporaryDirectory() as temp:
                commands = []
                with patch.object(ci, 'prepare', lambda work, platform: {'PLATFORM': platform}), \
                        patch.object(ci.subprocess, 'run', lambda argv, **kwargs: commands.append((argv, kwargs['env']))), \
                        patch.dict(os.environ, {'RUNNER_TEMP': temp}):
                    ci.build(Path('target/core-inputs'), name)
                (argv, env), = commands
                self.assertTrue(argv[0].endswith(python), argv)
                self.assertEqual(argv[2:], [str(ci.ROOT / 'tools/build-core-artifact.py'), '--platform', name,
                                            '--out', 'target/core-inputs'])
                self.assertEqual(env, {'PLATFORM': name})


class SmokePackageTests(unittest.TestCase):
    """The smoke's unsigned package has what Core requires of a release
    (core/src/updates/package.rs, Bundle::verify)."""

    def test_the_package_is_laid_out_as_a_release_of_the_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            inputs, bundle = Path(temp) / 'inputs', Path(temp) / 'bundle'
            sdk = 'claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json'
            for name in ('bin/yuzuno-workspace', 'bin/yuzuno-update-helper', 'licenses/LICENSE',
                         'web/index.html', 'claude/bridge.mjs', 'claude/package.json', sdk,
                         'result-validator/validator.mjs'):
                (inputs / name).parent.mkdir(parents=True, exist_ok=True)
                (inputs / name).write_text('<html><head></head></html>' if name.endswith('.html') else name)
            for name in ('bin/yuzuno-workspace', 'bin/yuzuno-update-helper'):
                (inputs / name).chmod(0o755)
            current = {'platform': 'macos-aarch64', 'protocol': 1,
                       'schema': {'writes': 2, 'readsMin': 2, 'readsMax': 2},
                       'records': {'writes': 2, 'readsMin': 2, 'readsMax': 2}}
            release_id, manifest_sha256 = smoke.package(inputs, bundle, {'source': 'a' * 40}, current)
            manifest = json.loads((bundle / 'manifest.json').read_text())
            self.assertEqual(release_id, 'smoke-' + 'a' * 12)
            self.assertEqual(manifest_sha256, digest(bundle / 'manifest.json'))
            self.assertEqual({key: manifest[key] for key in ('format', 'releaseId', 'gitSha', 'platform', 'protocol', 'schema', 'records')},
                             {'format': 1, 'releaseId': release_id, 'gitSha': 'a' * 40, **current})
            for required in ('bin/yuzuno-workspace', 'bin/yuzuno-update-helper', 'web/index.html',
                             'runtimes/claude/bridge.mjs', 'runtimes/claude/package.json',
                             'runtimes/' + sdk, 'runtimes/result-validator/validator.mjs'):
                self.assertIn(required, manifest['files'])
            self.assertFalse([name for name in manifest['files'] if 'windows-jobs' in name])
            self.assertTrue(manifest['files']['bin/yuzuno-workspace']['executable'])
            files = inventory(bundle)
            files.pop('manifest.json')
            self.assertEqual(files, manifest['files'])
            self.assertIn(f'<meta name="yuzuno-release" content="{release_id}">',
                          (bundle / 'web/index.html').read_text())


if __name__ == '__main__':
    unittest.main()
