"""The Windows Jobs helper as a release input (T-108); no Windows, build or Core.

What tools/build-windows-helper.py records, what packaging accepts, and that
the committed helper belongs to this tree's source and to Core's protocol.
The real compile and its run on Windows are evidence of their own.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import unittest
from release_common import digest, write

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packager = load('package_release', 'package-release.py')
builder = load('build_windows_helper', 'build-windows-helper.py')


def program(machine=0x8664):
    """The headers of a Windows program for this machine type, and padding."""
    data = bytearray(b'MZ' + bytes(0x3A) + struct.pack('<I', 0x40))
    return bytes(data + b'PE\0\0' + struct.pack('<H', machine) + bytes(64))


class CommittedHelperTests(unittest.TestCase):
    def test_the_committed_helper_was_built_from_this_trees_source_for_cores_protocol(self):
        folder = ROOT / 'runtimes/windows-jobs'
        record = packager.check_windows_helper(folder, ROOT / 'core/src/jobs/windows_job.cs')
        core = re.findall(r'const WINDOWS_PROTOCOL: i64 = (\d+);', (ROOT / 'core/src/jobs/remote.rs').read_text())
        self.assertEqual(core, [str(record['protocol'])])
        self.assertTrue(builder.x64_program(folder / record['file']))
        self.assertTrue(re.fullmatch('[0-9a-f]{40}', record['source']['commit']))
        self.assertEqual(record['compiler']['flags'], builder.FLAGS)


class CheckTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.folder = self.root / 'windows-jobs'
        self.folder.mkdir()
        self.source = self.root / 'windows_job.cs'
        self.source.write_text('class Helper\n{\n    const int Protocol = 1;\n}\n')
        self.helper = self.folder / 'yuzuno-jobs-helper.exe'
        self.helper.write_bytes(program())
        self.helper.chmod(0o755)
        self.record = {'format': 1, 'file': self.helper.name, 'sha256': digest(self.helper),
                       'bytes': self.helper.stat().st_size, 'protocol': 1,
                       'source': {'commit': 'a' * 40, 'sha256': digest(self.source)}}
        write(self.folder / 'windows-helper.json', self.record)

    def test_a_helper_that_matches_its_record_and_source_is_accepted(self):
        self.assertEqual(packager.check_windows_helper(self.folder, self.source), self.record)

    def test_other_bytes_than_recorded_are_refused(self):
        self.helper.write_bytes(program() + b'changed')
        with self.assertRaisesRegex(ValueError, 'does not match its windows-helper.json'):
            packager.check_windows_helper(self.folder)

    def test_a_helper_without_its_execute_bit_is_refused(self):
        self.helper.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'not executable'):
            packager.check_windows_helper(self.folder)

    def test_a_missing_or_linked_file_is_refused(self):
        (self.folder / 'windows-helper.json').unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            packager.check_windows_helper(self.folder)
        (self.folder / 'windows-helper.json').symlink_to(self.root / 'elsewhere.json')
        write(self.root / 'elsewhere.json', self.record)
        with self.assertRaisesRegex(ValueError, 'missing'):
            packager.check_windows_helper(self.folder)

    def test_a_helper_built_from_other_source_or_protocol_is_refused(self):
        self.source.write_text('class Helper\n{\n    const int Protocol = 1;\n    // changed\n}\n')
        with self.assertRaisesRegex(ValueError, 'built from another windows_job.cs'):
            packager.check_windows_helper(self.folder, self.source)
        self.source.write_text('class Helper\n{\n    const int Protocol = 2;\n}\n')
        write(self.folder / 'windows-helper.json', {**self.record, 'source': {'sha256': digest(self.source)}})
        with self.assertRaisesRegex(ValueError, 'built from another windows_job.cs'):
            packager.check_windows_helper(self.folder, self.source)

    def test_a_record_of_another_format_or_without_a_protocol_is_refused(self):
        for change in ({'format': 2}, {'protocol': '1'}, {'file': 'other.exe'}, {'bytes': 1}):
            with self.subTest(change=change):
                write(self.folder / 'windows-helper.json', {**self.record, **change})
                with self.assertRaises(ValueError):
                    packager.check_windows_helper(self.folder)


class BuilderTests(unittest.TestCase):
    def test_the_protocol_is_read_from_exactly_one_declaration(self):
        self.assertEqual(builder.protocol('    const int Protocol = 7;\n'), 7)
        for text in ('', '    const int Protocol = 1;\n    const int Protocol = 2;\n', '// const int Protocol = x;\n'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                builder.protocol(text)

    def test_only_a_windows_x64_program_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'helper.exe'
            for data, expected in ((program(), True), (program(0x014C), False), (b'MZ', False), (b'#!/bin/sh\n', False)):
                with self.subTest(data=data[:4]):
                    path.write_bytes(data)
                    self.assertEqual(builder.x64_program(path), expected)

    def test_it_builds_only_a_full_commit_into_a_new_folder_under_target(self):
        with self.assertRaisesRegex(ValueError, 'new output folder'):
            builder.build('a' * 40, Path(tempfile.gettempdir()) / 'windows-helper')
        with self.assertRaisesRegex(ValueError, 'full source commit'):
            builder.build('HEAD', ROOT / 'target/windows-helper-test-never-created')
        self.assertFalse((ROOT / 'target/windows-helper-test-never-created').exists())


if __name__ == '__main__':
    unittest.main()
