#!/usr/bin/env python3
"""scripts/sync_guard_rules.py: the copies match the source, and every way
they could stop matching is refused rather than written (YN-207).

Run by CI with the other script tests:
    python3 -m unittest discover --start-directory scripts --pattern 'test_*.py'
"""
import contextlib
import io
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import sync_guard_rules as sync

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    with io.open(str(path), encoding='utf-8', newline='') as stream:
        return stream.read()


def write(path, text):
    with io.open(str(path), 'w', encoding='utf-8', newline='') as stream:
        stream.write(text)


class Sync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for relative in (sync.SOURCE,) + sync.TARGETS:
            (self.root / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(ROOT / relative), str(self.root / relative))

    def tearDown(self):
        self.tmp.cleanup()

    def test_this_checkout_is_in_sync(self):
        self.assertEqual(sync.check(), [])

    def test_the_checked_in_region_is_python_3_6(self):
        import ast
        ast.parse(read(ROOT / sync.SOURCE), feature_version=(3, 6))

    def test_a_missing_marker_is_refused(self):
        target = self.root / sync.TARGETS[0]
        write(target, read(target).replace(sync.START + '\n', '', 1))
        problems = sync.check(self.root)
        self.assertEqual(problems, ['%s: the start marker is missing' % sync.TARGETS[0]])

    def test_a_repeated_marker_is_refused(self):
        target = self.root / sync.TARGETS[1]
        write(target, read(target).replace(sync.END, sync.END + '\n' + sync.END, 1))
        problems = sync.check(self.root)
        self.assertEqual(problems, ['%s: the end marker appears 2 times' % sync.TARGETS[1]])

    def test_the_end_before_the_start_is_refused(self):
        target = self.root / sync.TARGETS[0]
        text = read(target)
        body = sync.locate(text, str(target))[1]
        write(target, text.replace(sync.START + '\n' + body + sync.END,
                                   sync.END + '\n' + body + sync.START, 1))
        self.assertEqual(sync.check(self.root), ['%s: the end marker comes before the start marker' % sync.TARGETS[0]])

    def test_a_region_that_would_close_the_string_is_refused(self):
        source = self.root / sync.SOURCE
        write(source, read(source).replace('GIT_STATUS_LIMIT = 64 * 1024',
                                           "GIT_STATUS_LIMIT = 64 * 1024\nNOTE = '''", 1))
        with self.assertRaises(sync.Problem) as caught:
            sync.sync(self.root)
        self.assertIn("would close COMMON's string", str(caught.exception))
        # The target copies are untouched by a refused sync.
        for target in sync.TARGETS:
            self.assertEqual(read(self.root / target), read(ROOT / target))

    def test_a_region_that_does_not_compile_is_refused_and_not_written(self):
        source = self.root / sync.SOURCE
        before = read(self.root / sync.TARGETS[1])
        write(source, read(source).replace('def guarded(name, scope):', 'def guarded(name, scope) return None', 1))
        with self.assertRaises(sync.Problem) as caught:
            sync.sync(self.root)
        self.assertIn('does not parse', str(caught.exception))
        self.assertEqual(read(self.root / sync.TARGETS[1]), before)

    def test_a_drifted_copy_is_named_and_rewritten(self):
        target = self.root / sync.TARGETS[1]
        write(target, read(target).replace('GIT_STATUS_LIMIT = 64 * 1024', 'GIT_STATUS_LIMIT = 65536', 1))
        self.assertEqual(sync.check(self.root), [
            '%s: its region differs from %s; run scripts/sync_guard_rules.py' % (sync.TARGETS[1], sync.SOURCE)])
        changed, problems = sync.sync(self.root)
        self.assertEqual((changed, problems), ([str(sync.TARGETS[1])], []))
        self.assertEqual(sync.check(self.root), [])
        # The rest of the file is as it was: only the region is replaced.
        self.assertEqual(read(target).replace(sync.locate(read(target), str(target))[1], ''),
                         read(ROOT / sync.TARGETS[1]).replace(
                             sync.locate(read(ROOT / sync.TARGETS[1]), str(sync.TARGETS[1]))[1], ''))

    def test_check_writes_nothing_and_exits_one_on_drift(self):
        target = self.root / sync.TARGETS[1]
        write(target, read(target).replace('INPUT_COUNT_LIMIT = 128', 'INPUT_COUNT_LIMIT = 129', 1))
        before = {str(path): read(self.root / path) for path in sync.TARGETS}
        with contextlib.redirect_stderr(io.StringIO()) as said:
            self.assertEqual(sync.main(['--check', '--root', str(self.root)]), 1)
        self.assertIn('its region differs', said.getvalue())
        self.assertEqual({str(path): read(self.root / path) for path in sync.TARGETS}, before)

    def test_the_region_is_inside_the_string_the_helper_sends(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('remote_job', str(self.root / sync.TARGETS[1]))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIn(sync.region(self.root / sync.SOURCE), module.COMMON)
        compile(module.COMMON + module.SUPERVISOR, 'supervisor.py', 'exec')


if __name__ == '__main__':
    unittest.main()
