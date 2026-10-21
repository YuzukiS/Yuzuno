"""mac-desktop-host.py's refusal and cleanup rules (T-165), on a fake home
folder: no Mac, SSH or real app. A Yuzuno app installed or running, its data
folders or defaults file, or anything on 127.0.0.1:4317 stops it before it
writes anything; cleanup removes only what this run made and nothing changed
since, and says what it kept or failed to remove and why."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import signal
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HOST = Path(__file__).with_name('mac-desktop-host.py')
EXE = 'Contents/MacOS/yuzuno-desktop'


def tree(root):
    """Every path under root with its kind, mode and content hash."""
    found = []
    for path in sorted(root.rglob('*')):
        st = path.lstat()
        digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        found.append((str(path.relative_to(root)), path.is_dir(), oct(st.st_mode), digest))
    return found


class Host(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        env = mock.patch.dict(os.environ, {'HOME': str(self.home), 'YUZUNO_MAC_RECHECK': '0'})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location('mac_desktop_host_under_test', HOST)
        h = self.h = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(h)
        # /Applications stands in here too; nothing may signal real processes.
        h.APPS = [self.home / 'System Applications' / 'Yuzuno.app', self.home / 'Applications' / 'Yuzuno.app']
        self.procs, self.ours, self.core = [], [], False
        h.processes = lambda: list(self.procs)
        h.app_pids = lambda app: list(self.ours)
        h.port_answers = lambda port: self.core
        h.stop_all = lambda app: None
        h.signal = types.SimpleNamespace(**{k: getattr(signal, k) for k in dir(signal) if k.startswith('SIG')},
                                         signal=lambda *a: None, alarm=lambda seconds: None)

    def app_writes(self):
        """What the app writes at its first launch: its data and defaults."""
        h = self.h
        for path in h.APP_DATA:
            path.mkdir(parents=True)
            (path / 'data').write_text('made by the app')
        (h.APP_DATA[0] / 'core.json').write_text('{"coreUrl": "http://127.0.0.1:5317/"}')
        h.PREFS.parent.mkdir(parents=True, exist_ok=True)
        h.PREFS.write_text('defaults made by the app')

    def this_run_launches_and_quits(self):
        self.h.app_launched = True
        self.app_writes()
        self.h.mark_created()

    def main(self, *argv, stdin=''):
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', ['mac-desktop-host.py', *argv]), \
                mock.patch.object(sys, 'stdin', io.StringIO(stdin)), contextlib.redirect_stdout(out):
            self.h.main()
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_anything_of_yuzuno_on_the_mac_refuses_before_anything_is_written(self):
        h = self.h

        def data():
            h.APP_DATA[1].mkdir(parents=True)
            (h.APP_DATA[1] / 'old').write_text("the user's")

        def prefs():
            h.PREFS.parent.mkdir(parents=True)
            h.PREFS.write_text("the user's defaults")

        def installed():
            (h.APPS[1] / 'Contents').mkdir(parents=True)

        def running():
            self.procs = [(41, '/Applications/Yuzuno.app/' + EXE)]

        def core():
            self.core = True

        for name, make, said in [('data folder', data, 'WebKit/dev.yuzuno.workspace exists'),
                                 ('defaults file', prefs, 'dev.yuzuno.workspace.plist exists'),
                                 ('installed app', installed, 'is installed'),
                                 ('running app', running, 'a Yuzuno app runs (process 41'),
                                 ('a Core on 4317', core, '127.0.0.1:4317')]:
            with self.subTest(name):
                for child in self.home.iterdir():
                    shutil.rmtree(child)
                self.procs, self.core = [], False
                make()
                before = tree(self.home)
                replies = self.main(stdin='{"op": "init"}\n{"op": "cleanup"}\n')
                self.assertEqual(len(replies), 2)
                for reply in replies:
                    self.assertFalse(reply['ok'])
                    self.assertIn('refused before writing anything on this Mac', reply['error'])
                    self.assertIn(said, reply['error'])
                self.assertEqual(tree(self.home), before, 'nothing on the Mac may change')
                self.assertFalse(h.ROOTS[0].exists())

    def test_processes_are_read_from_ps_with_full_paths(self):
        listing = f'  1 /sbin/launchd\n 812 /Users/a b/Yuzuno.app/{EXE}\n\n'
        done = types.SimpleNamespace(stdout=listing)
        spec = importlib.util.spec_from_file_location('mac_desktop_host_ps', HOST)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        with mock.patch.object(fresh.subprocess, 'run', return_value=done) as ps:
            self.assertEqual(fresh.yuzuno_processes(), [{'pid': 812, 'path': f'/Users/a b/Yuzuno.app/{EXE}'}])
        self.assertEqual(ps.call_args.args[0], ['/bin/ps', '-axo', 'pid=,comm='])

    def test_inspect_reads_only(self):
        self.app_writes()
        before = tree(self.home)
        found, = self.main('--inspect')
        self.assertEqual(len(found['problems']), 6)
        self.assertEqual(tree(self.home), before)

    def test_cleanup_removes_what_this_run_made_and_the_folders_it_made(self):
        h = self.h
        _, refused = h.prepare()
        self.assertEqual(refused, [])
        (h.lab / 'Applications').mkdir()
        self.this_run_launches_and_quits()
        result = h.remove_owned(str(h.lab / 'Applications' / 'Yuzuno.app'))
        self.assertEqual((result['kept'], result['failed']), ([], []))
        self.assertEqual(sorted(result['removed']), sorted([str(p) for p in h.APP_DATA]
                                                           + [str(h.PREFS), str(h.lab)] + [str(r) for r in h.ROOTS]))
        self.assertEqual(h.problems(result['after']), [])
        self.assertEqual(result['after']['roots'], {str(r): False for r in h.ROOTS})
        self.assertEqual([p for p in self.home.rglob('*') if p.is_file()], [])

    def test_lab_folders_that_existed_stay(self):
        h = self.h
        (h.ROOTS[1] / 'run-earlier').mkdir(parents=True)
        (h.ROOTS[1] / 'run-earlier' / 'report').write_text('an earlier run')
        h.prepare()
        result = h.remove_owned(None)
        self.assertEqual(result['removed'], [str(h.lab)])
        self.assertEqual((h.ROOTS[1] / 'run-earlier' / 'report').read_text(), 'an earlier run')

    def test_a_lab_parent_someone_else_wrote_into_stays(self):
        h = self.h
        h.prepare()
        (h.ROOTS[0] / 'notes.txt').write_text("someone else's")
        result = h.remove_owned(None)
        self.assertIn(str(h.ROOTS[1]), result['removed'])
        self.assertEqual(result['kept'], [{'path': str(h.ROOTS[0]), 'reason': 'something else is in it'}])
        self.assertEqual((h.ROOTS[0] / 'notes.txt').read_text(), "someone else's")

    def test_what_changed_after_it_was_recorded_stays(self):
        h = self.h
        h.prepare()
        self.this_run_launches_and_quits()
        # Another folder in its place (the old one kept until then, so the
        # new one cannot reuse its inode), and the defaults rewritten.
        replaced = h.APP_DATA[2]
        replaced.rename(self.home / 'moved-away')
        replaced.mkdir()
        (replaced / 'new').write_text('not made by this run')
        h.PREFS.write_text('changed by something else')
        result = h.remove_owned(None)
        kept = {k['path']: k['reason'] for k in result['kept']}
        self.assertEqual(kept, {str(replaced): "it is no longer the folder this run's app made",
                                str(h.PREFS): 'it changed after this run last recorded it'})
        self.assertEqual((replaced / 'new').read_text(), 'not made by this run')
        self.assertEqual(h.PREFS.read_text(), 'changed by something else')
        self.assertFalse(h.APP_DATA[0].exists())

    def test_another_yuzuno_app_or_its_own_still_running_keeps_the_shared_data(self):
        for name, setup, reason in [
                ('another app', lambda: setattr(self, 'procs', [(77, '/Users/x/Yuzuno.app/' + EXE)]),
                 'another Yuzuno app ran during this run'),
                ('its own app still runs', lambda: setattr(self, 'ours', [1234]),
                 "this run's app still runs (processes [1234])")]:
            with self.subTest(name):
                self.setUp()
                h = self.h
                h.prepare()
                self.this_run_launches_and_quits()
                setup()
                result = h.remove_owned(str(h.lab / 'Applications' / 'Yuzuno.app'))
                self.assertEqual({k['reason'] for k in result['kept'] if k['path'] != str(h.ROOTS[0])
                                  and k['path'] != str(h.ROOTS[1])}, {reason})
                self.assertEqual(len([k for k in result['kept'] if k['reason'] == reason]), 6)
                self.assertTrue(h.PREFS.exists())
                self.assertFalse(h.lab.exists())

    def test_data_this_run_never_recorded_stays(self):
        h = self.h
        h.prepare()
        self.app_writes()  # the app never launched in this run
        result = h.remove_owned(None)
        self.assertEqual({k['reason'] for k in result['kept'] if k['path'] in {str(p) for p in h.APP_DATA}},
                         {"it appeared, but never as this run's app's"})
        self.assertIn({'path': str(h.PREFS), 'reason': "this run never recorded it as its app's"}, result['kept'])

    @unittest.skipIf(os.geteuid() == 0, 'root removes read-only folders anyway')
    def test_a_removal_that_fails_is_reported(self):
        h = self.h
        h.prepare()
        self.this_run_launches_and_quits()
        stuck = h.APP_DATA[3] / 'locked'
        stuck.mkdir()
        (stuck / 'file').write_text('x')
        stuck.chmod(0o500)
        self.addCleanup(stuck.chmod, 0o700)
        result = h.remove_owned(None)
        self.assertEqual([f['path'] for f in result['failed']], [str(h.APP_DATA[3])])
        self.assertIn('PermissionError', result['failed'][0]['error'])
        self.assertTrue(h.APP_DATA[3].exists())

    def test_an_end_without_cleanup_applies_the_same_rules_and_says_so(self):
        h = self.h
        replies = self.main(stdin='')
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]['error'], 'ended without a cleanup request')
        self.assertIn(str(h.ROOTS[0]), replies[0]['cleanup']['removed'])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_remove_new_after_a_person_opened_a_copy(self):
        h = self.h
        found, = self.main('--inspect')
        self.assertEqual(found['problems'], [])
        self.app_writes()
        self.procs = [(5, '/Users/x/Downloads/Yuzuno.app/' + EXE)]
        with self.assertRaisesRegex(ValueError, 'still runs'):
            h.remove_new(found)
        self.procs = []
        result = h.remove_new(found)
        self.assertEqual(sorted(result['removed']), sorted([str(p) for p in h.APP_DATA] + [str(h.PREFS)]))
        self.assertEqual(h.problems(result['after']), [])
        self.core = True
        with self.assertRaisesRegex(ValueError, 'not of a clean Mac'):
            h.remove_new(h.state())


if __name__ == '__main__':
    unittest.main()
