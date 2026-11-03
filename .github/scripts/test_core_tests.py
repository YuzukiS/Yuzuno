"""Black-box checks of core_tests.py with a fake cargo and fake libtest binaries."""
import json
from pathlib import Path
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('core_tests.py')

# A stand-in for a libtest binary. Its spec (next to it) maps each test name to
# what it does: ok, fail, ignored, skip (not run, yet exit 0), crash, hang.
FAKE_TEST = '''import json, os, signal, subprocess, sys, time
from pathlib import Path
spec = json.loads(Path(sys.argv[0] + '.json').read_text())
args = sys.argv[1:]
if args[:1] == ['--list']:
    print(''.join(name + ': test\\n' for name in spec['tests']), end='')
    sys.exit(spec.get('list_rc', 0))
assert args[0] == '--test-threads=1', args
# As libtest: no name given, --exact or not, runs every test.
names = (args[2:] if args[1:2] == ['--exact'] else []) or list(spec['tests'])
log = Path(spec['log'])
with log.open('a') as stream:
    stream.write(f'start {os.getpid()} {time.time()}\\n')
    stream.write(f'names {os.getpid()} {",".join(names)}\\n')
time.sleep(spec.get('sleep', 0))
passed = failed = ignored = 0
for name in names:
    what = spec['tests'][name]
    if what == 'skip':
        continue
    if what == 'ignored':
        ignored += 1
        continue
    with log.open('a') as stream:
        stream.write(f'ran {name}\\n')
    if what == 'crash':
        os.kill(os.getpid(), signal.SIGKILL)
    if what == 'hang':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])
        Path(spec['pids']).write_text(f'{os.getpid()} {child.pid}')
        time.sleep(60)
    print(f'test {name} ... ' + ('FAILED' if what == 'fail' else 'ok'))
    failed += what == 'fail'
    passed += what == 'ok'
with log.open('a') as stream:
    stream.write(f'end {os.getpid()} {time.time()}\\n')
if not spec.get('silent'):
    status = 'FAILED' if failed else 'ok'
    print(f'\\ntest result: {status}. {passed} passed; {failed} failed; {ignored} ignored; 0 measured; '
          f'{len(spec["tests"]) - len(names)} filtered out; finished in 0.00s')
sys.exit(101 if failed else 0)
'''

# Prints the artifact messages of cargo.json; its exit code comes from cargo.rc.
FAKE_CARGO = '''import sys
from pathlib import Path
assert sys.argv[1:] == ['test', '--locked', '--no-run', '--message-format=json'], sys.argv
here = Path(__file__).resolve().parents[1]
print('   Compiling (not JSON)')
print((here / 'cargo.json').read_text(), end='')
rc = here / 'cargo.rc'
sys.exit(int(rc.read_text()) if rc.exists() else 0)
'''


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '.github/scripts').mkdir(parents=True)
        self.runner = self.root / '.github/scripts/core_tests.py'
        shutil.copyfile(SOURCE, self.runner)
        (self.root / 'bin').mkdir()
        self.script('bin/cargo', FAKE_CARGO)
        self.log = self.root / 'runs.log'
        self.artifacts = []
        self.env = dict(os.environ, PATH=f'{self.root / "bin"}:' + os.environ['PATH'], CORE_TEST_JOBS='3',
                        GITHUB_ACTIONS='true', GITHUB_STEP_SUMMARY=str(self.root / 'summary'))

    def split_at(self, count):
        """The runner's SPLIT lowered, so that a few tests make shards."""
        source = self.runner.read_text()
        self.assertIn('\nSPLIT = 100\n', source)
        self.runner.write_text(source.replace('\nSPLIT = 100\n', f'\nSPLIT = {count}\n'))

    def script(self, name, body):
        path = self.root / name
        path.write_text(f'#!{sys.executable}\n' + body)
        path.chmod(0o755)
        return path

    def binary(self, kind, name, tests, test_profile=True, **spec):
        executable = self.script(f'{kind}-{name}', FAKE_TEST)
        Path(f'{executable}.json').write_text(json.dumps(dict(tests=tests, log=str(self.log), pids=str(self.root / 'pids'), **spec)))
        self.artifacts.append({'reason': 'compiler-artifact', 'target': {'kind': [kind], 'name': name},
                               'profile': {'test': test_profile}, 'executable': str(executable),
                               'manifest_path': str(self.root / 'Cargo.toml')})

    def invoke(self):
        (self.root / 'cargo.json').write_text(''.join(json.dumps(a) + '\n' for a in self.artifacts))
        return subprocess.run([sys.executable, str(self.runner)], cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def ran(self):
        return [line.split(' ', 1)[1] for line in self.log.read_text().splitlines() if line.startswith('ran ')]

    def test_every_test_runs_once_in_parallel_processes(self):
        lib = {f'module::t{i:03}': 'ok' for i in range(120)}
        lib['module::t007'] = 'ignored'
        self.binary('lib', 'yuzuno_workspace', lib)
        self.binary('test', 'api', {'a': 'ok', 'b': 'ok', 'c': 'ignored'})
        self.binary('bin', 'yuzuno-workspace', {})
        self.binary('example', 'bench', {'never': 'ok'}, test_profile=False)
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ran = self.ran()
        self.assertEqual(sorted(ran), sorted(name for name, what in [*lib.items(), ('a', 'ok'), ('b', 'ok')] if what == 'ok'))
        self.assertEqual(len(ran), len(set(ran)))
        self.assertNotIn('never', ran)
        self.assertIn('123 tests in 5 processes, 3 at a time', r.stdout)
        self.assertIn('Core test processes: 5 run, 0 failed', r.stdout)
        for shard in ('[1/3] (40 tests)', '[2/3] (40 tests)', '[3/3] (40 tests)'):
            self.assertIn(f'lib yuzuno_workspace {shard}', r.stdout)
        self.assertEqual(r.stdout.count('::group::'), 5)
        self.assertEqual(r.stdout.count('::endgroup::'), 5)
        self.assertIn('Core test processes: 5 run, 0 failed', (self.root / 'summary').read_text())

    def test_a_failure_fails_the_step_and_the_other_processes_still_run(self):
        self.binary('test', 'broken', {'x': 'ok', 'y': 'fail'})
        self.binary('test', 'fine', {'z': 'ok'})
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('z', self.ran())
        self.assertIn('test y ... FAILED', r.stdout)
        self.assertIn('::error title=Core tests failed::test broken (exit 101)', r.stdout)
        self.assertIn('2 run, 1 failed', r.stdout)

    def test_a_test_that_did_not_run_fails_the_step(self):
        self.binary('test', 'partial', {'p': 'ok', 'q': 'skip', 'r': 'ok'})
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('2 passed, 0 failed and 0 ignored of 3 tests given', r.stdout)

    def test_a_shard_missing_a_test_fails_the_step(self):
        lib = {f't{i:03}': 'ok' for i in range(100)}
        lib['t050'] = 'skip'
        self.binary('lib', 'core', lib)
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('32 passed, 0 failed and 0 ignored of 33 tests given', r.stdout)

    def test_a_crash_or_a_missing_summary_fails_the_step(self):
        self.binary('test', 'crashes', {'boom': 'crash'})
        self.binary('test', 'quiet', {'ok': 'ok'}, silent=True)
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('test crashes (killed by signal 9)', r.stdout)
        self.assertIn('test quiet (no libtest summary)', r.stdout)

    def test_cargo_or_listing_failures_stop_before_any_test_runs(self):
        self.binary('test', 'listing', {'a': 'ok'}, list_rc=1)
        self.binary('test', 'other', {'b': 'ok'})
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('--list exited 1', r.stderr)
        self.assertFalse(self.log.exists())
        self.artifacts.clear()
        self.binary('test', 'other', {'b': 'ok'})
        (self.root / 'cargo.rc').write_text('101')
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('cargo test --no-run exited 101', r.stderr)
        (self.root / 'cargo.rc').unlink()
        self.artifacts.clear()
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('named no test executables', r.stderr)
        self.assertFalse(self.log.exists())

    def test_at_most_the_configured_number_run_at_once(self):
        for name in 'abcd':
            self.binary('test', name, {name: 'ok'}, sleep=.4)
        self.env['CORE_TEST_JOBS'] = '2'
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        events = sorted((float(at), kind == 'start') for kind, _pid, at in
                        (line.split() for line in self.log.read_text().splitlines() if line.startswith(('start ', 'end '))))
        active = peak = 0
        for _at, starts in events:
            active += 1 if starts else -1
            peak = max(peak, active)
        self.assertEqual(peak, 2)

    def test_cancellation_kills_running_processes_and_starts_no_more(self):
        self.binary('test', 'hangs', {'h': 'hang'})
        self.binary('test', 'later', {'l': 'ok'})
        self.env['CORE_TEST_JOBS'] = '1'
        (self.root / 'cargo.json').write_text(''.join(json.dumps(a) + '\n' for a in self.artifacts))
        p = subprocess.Popen([sys.executable, str(self.runner)], cwd=self.root, env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: p.kill() if p.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (self.root / 'pids').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.root / 'pids').exists())
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=10)
        self.assertEqual(p.returncode, 143, out + err)
        self.assertNotIn('l', self.ran())
        self.assertIn('not started (cancelled)', out)
        self.assertIn('(cancelled)', out)
        for pid in (self.root / 'pids').read_text().split():
            stat = Path('/proc') / pid / 'stat'
            if stat.exists():
                self.assertEqual(stat.read_text().rsplit(')', 1)[1].split()[0], 'Z', out + err)

    def processes(self):
        """Each process's names and the times it started and ended, from the fakes' log."""
        by_pid = {}
        for line in self.log.read_text().splitlines():
            kind, pid, rest = (line.split(' ', 2) + [''])[:3]
            if kind in ('start', 'end'):
                by_pid.setdefault(pid, {})[kind] = float(rest)
            elif kind == 'names':
                by_pid.setdefault(pid, {})['names'] = rest.split(',') if rest else []
        return list(by_pid.values())

    def test_data_dir_tests_run_alone_before_every_other_process_and_each_test_once(self):
        lib = {f'module::t{i:03}': 'ok' for i in range(117)}
        lib.update({f'data_dir::tests::move_{i}': 'ok' for i in range(3)})
        self.binary('lib', 'yuzuno_workspace', lib, sleep=.2)
        self.binary('test', 'api', {'a': 'ok', 'b': 'ok'}, sleep=.2)
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ran = self.ran()
        self.assertEqual(sorted(ran), sorted([*lib, 'a', 'b']))
        self.assertEqual(len(ran), len(set(ran)), 'no test ran twice')
        self.assertIn('122 tests in 5 processes, 3 at a time; first, alone: lib yuzuno_workspace [alone] (3 tests)', r.stdout)
        for shard in ('[1/3] (39 tests)', '[2/3] (39 tests)', '[3/3] (39 tests)'):
            self.assertIn(f'lib yuzuno_workspace {shard}', r.stdout)
        processes = self.processes()
        alone = [p for p in processes if p['names'] and all(n.startswith('data_dir::tests::') for n in p['names'])]
        others = [p for p in processes if p not in alone]
        self.assertEqual(len(alone), 1)
        self.assertEqual(sorted(alone[0]['names']), sorted(n for n in lib if n.startswith('data_dir::tests::')))
        self.assertEqual(len(others), 4)
        for other in others:
            self.assertFalse(any(n.startswith('data_dir::tests::') for n in other['names']), other)
            self.assertGreaterEqual(other['start'], alone[0]['end'], 'nothing runs beside the data_dir tests')
        self.assertIn('Core test processes: 5 run, 0 failed', r.stdout)

    def test_a_binary_of_only_alone_tests_has_no_empty_process(self):
        self.binary('test', 'moves', {'data_dir::tests::a': 'ok', 'data_dir::tests::b': 'ignored'})
        self.binary('test', 'api', {'x': 'ok'})
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('3 tests in 2 processes, 3 at a time; first, alone: test moves [alone] (2 tests)', r.stdout)
        self.assertEqual(sorted(self.ran()), ['data_dir::tests::a', 'x'])

    def test_a_failure_alone_fails_the_step_and_the_others_still_run(self):
        self.binary('test', 'moves', {'data_dir::tests::a': 'fail', 'other': 'ok'})
        self.binary('test', 'api', {'x': 'ok'})
        r = self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(sorted(self.ran()), ['data_dir::tests::a', 'other', 'x'])
        self.assertIn('::error title=Core tests failed::test moves [alone] (exit 101)', r.stdout)
        self.assertIn('3 run, 1 failed', r.stdout)

    def test_cancellation_while_alone_starts_nothing_else(self):
        self.binary('test', 'moves', {'data_dir::tests::h': 'hang'})
        self.binary('test', 'later', {'l': 'ok'})
        (self.root / 'cargo.json').write_text(''.join(json.dumps(a) + '\n' for a in self.artifacts))
        p = subprocess.Popen([sys.executable, str(self.runner)], cwd=self.root, env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: p.kill() if p.poll() is None else None)
        deadline = time.monotonic() + 10
        while not (self.root / 'pids').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.root / 'pids').exists())
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=10)
        self.assertEqual(p.returncode, 143, out + err)
        self.assertNotIn('l', self.ran(), 'nothing starts beside, or after a cancelled, data_dir run')
        self.assertIn('not started (cancelled)', out)

    def assert_each_once_in_its_own_process(self, tests, processes):
        """Every test ran once, and no process ran a test another one did."""
        ran = self.ran()
        self.assertEqual(sorted(ran), sorted(name for name, what in tests.items() if what == 'ok'))
        self.assertEqual(len(ran), len(set(ran)), 'no test ran twice')
        names = [name for process in self.processes() for name in process['names']]
        self.assertEqual(sorted(names), sorted(tests), 'each test given to one process')
        self.assertEqual(len(self.processes()), processes)

    def test_more_workers_than_tests_make_no_empty_shard(self):
        self.split_at(4)
        tests = {f't{i}': 'ok' for i in range(5)}
        self.binary('lib', 'core', tests)
        self.env['CORE_TEST_JOBS'] = '8'
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('5 tests in 5 processes, 8 at a time', r.stdout)
        for shard in range(1, 6):
            self.assertIn(f'lib core [{shard}/5] (1 tests)', r.stdout)
        self.assert_each_once_in_its_own_process(tests, 5)

    def test_more_workers_than_tests_beside_alone_tests_make_no_empty_shard(self):
        self.split_at(4)
        tests = {f't{i}': 'ok' for i in range(5)}
        tests.update({'data_dir::tests::a': 'ok', 'data_dir::tests::b': 'ok'})
        self.binary('lib', 'core', tests, sleep=.2)
        self.env['CORE_TEST_JOBS'] = '8'
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('7 tests in 6 processes, 8 at a time; first, alone: lib core [alone] (2 tests)', r.stdout)
        self.assert_each_once_in_its_own_process(tests, 6)
        processes = self.processes()
        alone = [p for p in processes if p['names'] and all(n.startswith('data_dir::tests::') for n in p['names'])]
        self.assertEqual(len(alone), 1)
        for other in processes:
            if other is not alone[0]:
                self.assertGreaterEqual(other['start'], alone[0]['end'], 'nothing runs beside the data_dir tests')

    def test_one_worker_runs_a_large_binary_whole_or_beside_its_alone_tests(self):
        self.split_at(4)
        tests = {f't{i}': 'ok' for i in range(5)}
        self.binary('lib', 'core', tests)
        self.env['CORE_TEST_JOBS'] = '1'
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('5 tests in 1 processes, 1 at a time', r.stdout)
        self.assert_each_once_in_its_own_process(tests, 1)
        self.log.unlink()
        self.artifacts.clear()
        tests['data_dir::tests::a'] = 'ok'
        self.binary('lib', 'core', tests)
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('6 tests in 2 processes, 1 at a time; first, alone: lib core [alone] (1 tests)', r.stdout)
        self.assert_each_once_in_its_own_process(tests, 2)

    def test_an_invalid_worker_count_fails(self):
        self.binary('test', 'any', {'a': 'ok'})
        for value in ('0', 'two', '-1'):
            with self.subTest(value):
                self.env['CORE_TEST_JOBS'] = value
                r = self.invoke()
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn('CORE_TEST_JOBS must be a positive integer', r.stderr)


if __name__ == '__main__':
    unittest.main()
