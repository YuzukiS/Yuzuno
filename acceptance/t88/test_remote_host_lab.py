"""The remote-host lab's guards, run locally: host paths it puts in a shell,
the run folder it makes or finds only inside the allowed folder, the boundary
listing, and the owner's sign-in script. Nothing here reaches another host."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import remote_host_lab as lab  # noqa: E402

SCRIPT = HERE / 'remote_host_lab.py'


def sh(script, home):
    return subprocess.run(['sh', '-s'], input=script, capture_output=True, text=True,
                          env={'HOME': str(home), 'PATH': '/usr/bin:/bin'}, timeout=30)


class HostPathTest(unittest.TestCase):
    def test_plain_paths_under_home_or_absolute_pass(self):
        for value in ('$HOME', '$HOME/allowed/runs', '~/allowed', '/opt/node/bin', '$HOME/a/bin:/usr/local/bin'):
            self.assertEqual(lab.host_path(value), value)

    def test_anything_a_shell_would_read_otherwise_is_refused(self):
        for value in ('', 'relative/path', '~/a b', '$HOME/../other', '$HOME/a;id', '$(id)', '`id`',
                      '$HOMEX/a', '$HOME/a:relative', '~user/a', '/a/$PATH', '$HOME/a/'):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                lab.host_path(value)

    def test_names_are_plain(self):
        self.assertEqual(lab.run_name('r2'), 'r2')
        for value in ('', '../x', 'a/b', '-r', 'a b'):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                lab.run_name(value)


class CommandLineTest(unittest.TestCase):
    def test_help_with_safe_path(self):
        done = subprocess.run([sys.executable, '-B', str(SCRIPT), '--help'], capture_output=True, text=True,
                              env=dict(os.environ, PYTHONSAFEPATH='1'))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('--remote-allowed', done.stdout)

    def test_invalid_inputs_stop_before_any_lab_report_or_ssh(self):
        with tempfile.TemporaryDirectory() as directory:
            new_lab, report = Path(directory) / 'lab', Path(directory) / 'report.json'
            good = {'--target': 'host.invalid', '--remote-allowed': '$HOME/allowed', '--remote-base': '$HOME/allowed/runs',
                    '--run': 'r1', '--node-bin': '$HOME/allowed/node/bin', '--remote-port': '4617',
                    '--local-port': '5617', '--lab': str(new_lab), '--report': str(report)}
            for option, value in (('--remote-allowed', '$HOME/a;id'), ('--run', '../r1'),
                                  ('--node-bin', '$(id)'), ('--asset', 'a b')):
                argv = ['install'] + [part for key, item in {**good, option: value}.items() for part in (key, item)]
                done = subprocess.run([sys.executable, '-B', str(SCRIPT), *argv], capture_output=True, text=True)
                self.assertEqual(done.returncode, 2, (option, done.stderr))
                self.assertIn('not a plain', done.stderr)
                self.assertFalse(new_lab.exists() or report.exists(), option)


class HostScriptTest(unittest.TestCase):
    def test_a_new_run_is_made_only_inside_the_allowed_folder_and_only_once(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            (home / 'allowed').mkdir()
            made = sh(lab.prepare_script('$HOME/allowed', '$HOME/allowed/runs', 'r1'), home)
            self.assertEqual(made.returncode, 0, made.stderr)
            base = Path(made.stdout.split()[-1])
            self.assertEqual(base, (home / 'allowed/runs/r1').resolve())
            for folder in ('download', 'tools', 'work', 'claude-config', 'tmp', 'xdg/state', '.started', '.foreign'):
                self.assertTrue((base / folder).exists(), folder)
            again = sh(lab.prepare_script('$HOME/allowed', '$HOME/allowed/runs', 'r1'), home)
            self.assertEqual(again.returncode, 8, again.stderr)
            # Outside the allowed folder nothing is made, not even the runs folder.
            outside = sh(lab.prepare_script('$HOME/allowed', '$HOME/elsewhere/runs', 'r1'), home)
            self.assertEqual(outside.returncode, 9, outside.stderr)
            self.assertFalse((home / 'elsewhere').exists())
            # Nor through a link inside it that leads out.
            (home / 'out').mkdir()
            (home / 'allowed/link').symlink_to(home / 'out')
            linked = sh(lab.prepare_script('$HOME/allowed', '$HOME/allowed/link/runs', 'r1'), home)
            self.assertEqual(linked.returncode, 9, linked.stderr)
            self.assertEqual(list((home / 'out').iterdir()), [])
            # The allowed folder itself may hold the runs.
            inside = sh(lab.prepare_script('$HOME/allowed', '$HOME/allowed', 'r2'), home)
            self.assertEqual(inside.returncode, 0, inside.stderr)
            self.assertTrue((home / 'allowed/r2/.started').exists())

    def test_an_installed_run_reached_through_a_link_out_of_the_allowed_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            (home / 'allowed/runs').mkdir(parents=True)
            (home / 'outside/core').mkdir(parents=True)
            (home / 'outside/core/current.json').write_text('{}')
            (home / 'allowed/runs/r1').symlink_to(home / 'outside')
            found = sh('set -eu\n' + lab.existing_run('$HOME/allowed', '$HOME/allowed/runs', 'r1') + 'echo found\n', home)
            self.assertEqual(found.returncode, 9, found.stderr)
            self.assertNotIn('found', found.stdout)

    def test_the_boundary_lists_home_changes_except_the_allowed_folders_own(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            (home / 'allowed').mkdir()
            marker = home / 'allowed/.started'
            marker.write_text('')
            os.utime(marker, (1, 1))
            (home / 'allowed/new').write_text('')
            (home / 'other').write_text('')
            (home / '.claude').mkdir()
            (home / '.claude/settings.json').write_text('')
            listed = sh('set -eu\n' + lab.boundary_lines(f'"{marker}"', '$HOME/allowed'), home)
            self.assertEqual(listed.returncode, 0, listed.stderr)
            candidates, _, rest = listed.stdout.split('candidates:')[-1].partition('toplevel:')
            toplevel = rest.partition('tmp:')[0].split()
            self.assertIn('.claude/settings.json', candidates.split())
            self.assertIn('./other', toplevel)
            self.assertNotIn('./allowed', toplevel)


class ToleranceTest(unittest.TestCase):
    before = ['123 Mon Oct 19 05:26:25 2026 claude --continue',
              '124 Mon Oct 19 05:26:25 2026 node server.js',
              '125 Mon Oct 19 05:26:25 2026 /opt/tools/bin/codex exec',
              '126 Mon Oct 19 05:26:25 2026 /opt/claude/bin/claude -p hi']
    changed = ['.claude/skills/synced', '.claude/skills/synced/round-1', '.claude/settings.json', '.claude/skills/synced-other']

    def test_only_a_claude_process_from_before_that_still_runs_counts(self):
        self.assertEqual(lab.account_claude(self.before, ['124', '125']), [])
        self.assertEqual(lab.account_claude(self.before, ['123']), [self.before[0]])
        self.assertEqual(lab.account_claude(self.before, ['126', '999']), [self.before[3]])

    def test_only_the_skill_sync_round_is_tolerated_and_only_with_such_a_process(self):
        self.assertEqual(lab.tolerated(self.changed, [self.before[0]]),
                         ['.claude/skills/synced', '.claude/skills/synced/round-1'])
        self.assertEqual(lab.tolerated(self.changed, []), [])


class Stopped(Exception):
    pass


class HostStage:
    """Runs a stage's host scripts here, in a temporary home, until Core would
    start; a stop of Core is only recorded, never run here."""

    def stage(self, home, env, until='core-start'):
        seen = []

        def local(name, target, script, timeout=600):
            if name.startswith(until):
                raise Stopped(name)
            if name.startswith('core-stop'):
                return subprocess.CompletedProcess([], 0, 'stopped\n', '')
            done = subprocess.run(['sh', '-s'], input=script, capture_output=True, text=True, timeout=30,
                                  env={'HOME': str(home), 'PATH': '/usr/bin:/bin', **env})
            seen.append((name, done))
            return done

        args = argparse.Namespace(target='host.invalid', remote_allowed='$HOME/allowed', remote_base='$HOME/allowed/runs',
                                  run='r1', lab=str(home / 'lab'), remote_port=4617, local_port=5617,
                                  node_bin='$HOME/allowed/node/bin', host_path='$HOME/.local/bin',
                                  host_python='/usr/bin/python3')
        return args, seen, local

    def installed(self, home):
        run = home / 'allowed/runs/r1'
        (run / 'core').mkdir(parents=True)
        (run / 'core/current.json').write_text('{}')
        (run / 'claude-config').mkdir()
        return run


class StageScriptTest(HostStage, unittest.TestCase):
    def test_pre_login_names_a_set_key_variable_never_its_value_and_stops(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            self.installed(home)
            args, seen, local = self.stage(home, {'ANTHROPIC_API_KEY': 'value-that-must-not-show'})
            original, lab.remote = lab.remote, local
            try:
                with self.assertRaisesRegex(SystemExit, 'No Claude key or token variable'):
                    lab.pre_login(args)
            finally:
                lab.remote = original
            name, done = seen[0]
            self.assertEqual((name, done.returncode), ('host-run', 0), done.stderr)
            self.assertIn('set:ANTHROPIC_API_KEY', done.stdout.split())
            self.assertNotIn('value-that-must-not-show', done.stdout + done.stderr)
            self.assertFalse((home / 'allowed/runs/r1/prelogin').exists())

    def test_first_use_needs_the_owners_sign_in_then_writes_its_ask_fixture(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            run = self.installed(home)
            args, seen, local = self.stage(home, {})
            original, lab.remote = lab.remote, local
            try:
                with self.assertRaisesRegex(SystemExit, 'profile is signed in'):
                    lab.first_use(args)
                self.assertIn('not-signed-in', seen[0][1].stdout.split())
                (run / 'claude-config/.credentials.json').write_text('{"not": "read"}')
                args.lab = str(home / 'lab2')
                seen.clear()
                with self.assertRaises(Stopped):
                    lab.first_use(args)
            finally:
                lab.remote = original
            self.assertEqual([(name, done.returncode) for name, done in seen], [('host-run', 0), ('project-fixture', 0)])
            fixture = run / 'work/project/.claude/settings.local.json'
            self.assertEqual(json.loads(fixture.read_text()), {'permissions': {'ask': ['Bash']}})


class StartFailureTest(HostStage, unittest.TestCase):
    """A Core start that fails or is slow still ends in a stop there."""

    def failing_start(self, home, stage):
        args, seen, local = self.stage(home, {}, until='never')
        calls = []

        def remote(name, target, script, timeout=600):
            calls.append(name)
            if name.startswith('core-start'):
                return subprocess.CompletedProcess([], 7, '', 'not up')
            if name.startswith('core-stop'):
                return subprocess.CompletedProcess([], 0, 'stopped\n', '')
            return local(name, target, script, timeout)

        saved = lab.remote, lab.open_tunnel
        lab.remote, lab.open_tunnel = remote, lambda a: self.fail('no tunnel after a failed start')
        try:
            with self.assertRaisesRegex(SystemExit, 'Core starts on the host'):
                stage(args)
        finally:
            lab.remote, lab.open_tunnel = saved
        return calls

    def test_first_use(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            run = self.installed(home)
            (run / 'claude-config/.credentials.json').write_text('{"not": "read"}')
            calls = self.failing_start(home, lab.first_use)
            self.assertEqual(calls[-2:], ['core-start-first', 'core-stop-end-cleanup'])

    def test_pre_login(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            self.installed(home)
            calls = self.failing_start(home, lab.pre_login)
            self.assertEqual(calls[-2:], ['core-start-prelogin', 'core-stop-prelogin-end-cleanup'])


class CloseTest(unittest.TestCase):
    """A tunnel that will not close never keeps Core running on the host."""

    class Tunnel:
        def __init__(self, failing):
            self.failing, self.killed = failing, False

        def terminate(self):
            if self.failing == 'terminate':
                raise OSError('terminate failed')

        def wait(self, timeout=None):
            if self.failing == 'wait' and not self.killed:
                raise subprocess.TimeoutExpired('ssh', timeout)
            return 0

        def kill(self):
            self.killed = True

    def close(self, failing, ready, stop_raises=False):
        calls = []

        def remote(name, target, script, timeout=600):
            calls.append(name)
            if stop_raises:
                raise subprocess.TimeoutExpired('ssh', timeout)
            return subprocess.CompletedProcess([], 0, 'stopped\n', '')

        args = argparse.Namespace(target='host.invalid')
        tunnel = self.Tunnel(failing)
        steps, checks = len(lab.report['steps']), len(lab.report['checks'])
        saved, lab.remote = lab.remote, remote
        try:
            if ready:
                with self.assertRaisesRegex(SystemExit, 'The tunnel to the host closes'):
                    lab.close(args, '/host/runs/r1', tunnel, ready, 'end')
            else:
                lab.close(args, '/host/runs/r1', tunnel, ready, 'end')
        finally:
            lab.remote = saved
        return calls, tunnel, lab.report['steps'][steps:], lab.report['checks'][checks:]

    def test_after_a_failure_core_is_still_stopped_and_the_failure_stays_the_reported_one(self):
        for failing in ('terminate', 'wait'):
            calls, tunnel, steps, checks = self.close(failing, ready=False)
            self.assertEqual(calls, ['core-stop-end-cleanup'], failing)
            self.assertEqual(steps[0]['name'], 'tunnel-close-end', failing)
            self.assertTrue(tunnel.killed, failing)
            self.assertEqual(checks, [], failing)

    def test_a_stage_that_went_well_still_stops_core_but_fails_on_the_tunnel(self):
        for failing in ('terminate', 'wait'):
            calls, tunnel, steps, checks = self.close(failing, ready=True)
            self.assertEqual(calls, ['core-stop-end'], failing)
            self.assertEqual([(c['check'], c['passed']) for c in checks],
                             [("Core stops on the guide's interrupt (end)", True),
                              ('The tunnel to the host closes (end)', False)], failing)
            self.assertIn('tunnel-close-end', [s['name'] for s in steps], failing)

    def test_a_cleanup_stop_that_fails_too_is_recorded_without_hiding_the_first_failure(self):
        calls, tunnel, steps, checks = self.close('wait', ready=False, stop_raises=True)
        self.assertEqual(calls, ['core-stop-end-cleanup'])
        self.assertEqual([s['name'] for s in steps], ['tunnel-close-end', 'core-stop-end-cleanup'])
        self.assertIn('TimeoutExpired', steps[1]['error'])
        self.assertEqual(checks, [])


class InstallCleanupTest(unittest.TestCase):
    def test_a_check_failing_after_core_started_stops_it_and_reports_the_failure(self):
        calls = []

        def fake_run(name, argv, stdin=None, timeout=600):
            calls.append(name)
            if name == 'gh-download':
                target = Path(argv[argv.index('-D') + 1])
                for suffix in ('.json', '.json.minisig', '.tar.gz'):
                    (target / f'asset{suffix}').write_text(suffix)
            return subprocess.CompletedProcess(argv, 0, '', '')

        answers = {'host-prepare': '/host/runs/r1\n', 'guide-install': 'verified rel-1\ncurrent rel-1\n',
                   'core-start-install': 'up\n'}

        def fake_remote(name, target, script, timeout=600):
            calls.append(name)
            return subprocess.CompletedProcess([], 0, answers.get(name, ''), '')

        class Tunnel:
            def terminate(self):
                calls.append('tunnel-closed')

            def wait(self, timeout=None):
                return 0

        with tempfile.TemporaryDirectory() as directory:
            minisign = Path(directory) / 'minisign'
            minisign.write_text('stand-in')
            args = argparse.Namespace(lab=str(Path(directory) / 'lab'), local_port=0, asset='asset', host_python='/usr/bin/python3',
                                      tag='rel-1', repository='owner/repo', minisign=str(minisign), public_key='KEY',
                                      remote_allowed='$HOME/allowed', remote_base='$HOME/allowed/runs', run='r1',
                                      target='host.invalid', node_bin='$HOME/node/bin', host_path='$HOME/.local/bin',
                                      remote_port=4617)
            saved = lab.run, lab.remote, lab.open_tunnel, lab.wait_health
            lab.run, lab.remote, lab.open_tunnel, lab.wait_health = fake_run, fake_remote, lambda a: Tunnel(), lambda a: None
            try:
                with self.assertRaisesRegex(SystemExit, 'Health answers through the tunnel'):
                    lab.install(args)
            finally:
                lab.run, lab.remote, lab.open_tunnel, lab.wait_health = saved
        self.assertEqual(calls[calls.index('core-start-install'):],
                         ['core-start-install', 'tunnel-closed', 'core-stop-install-cleanup'])


class SignInScriptTest(unittest.TestCase):
    def test_it_signs_in_only_the_runs_own_profile(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            run = home / 'allowed/runs/r1'
            (run / 'core').mkdir(parents=True)
            (run / 'core/current.json').write_text('{}')
            (run / 'claude-config').mkdir()
            fake = home / 'claude'
            fake.write_text('#!/bin/sh\nenv | grep -E "^(CLAUDE_CONFIG_DIR|TMPDIR|XDG_[A-Z]+_HOME|DISABLE_AUTOUPDATER|HOME)=" | sort\necho "args $*"\n')
            fake.chmod(0o755)
            done = subprocess.run(['sh', str(HERE / 'claude-login.sh'), str(run)], capture_output=True, text=True,
                                  env={'HOME': str(home), 'PATH': '/usr/bin:/bin', 'CLAUDE_BIN': str(fake)}, timeout=30)
            self.assertEqual(done.returncode, 0, done.stderr)
            lines = done.stdout.splitlines()
            real = str(run.resolve())
            self.assertIn('args auth login', lines)
            self.assertIn(f'HOME={home}', lines)
            self.assertIn(f'CLAUDE_CONFIG_DIR={real}/claude-config', lines)
            self.assertIn(f'TMPDIR={real}/tmp', lines)
            self.assertIn(f'XDG_STATE_HOME={real}/xdg/state', lines)
            self.assertIn('DISABLE_AUTOUPDATER=1', lines)

    def test_a_folder_that_is_not_an_installed_run_is_refused(self):
        with tempfile.TemporaryDirectory() as home:
            done = subprocess.run(['sh', str(HERE / 'claude-login.sh'), home], capture_output=True, text=True,
                                  env={'HOME': home, 'PATH': '/usr/bin:/bin', 'CLAUDE_BIN': '/bin/false'}, timeout=30)
            self.assertEqual(done.returncode, 2)
            self.assertIn('not an installed run', done.stderr)


class NoRealHostTest(unittest.TestCase):
    def test_no_home_of_a_real_account_is_written_in(self):
        for name in ('remote_host_lab.py', 'pre-login-client.mjs', 'claude-login.sh'):
            text = (HERE / name).read_text()
            for word in ('/home/', '/Users/', '/root/'):
                self.assertNotIn(word, text, f'{name}: {word}')

    def test_the_host_and_its_folders_are_always_given(self):
        options = {action.dest: action for action in lab.parser()._actions}
        for dest in ('target', 'remote_allowed', 'remote_base', 'run', 'node_bin'):
            self.assertTrue(options[dest].required, dest)
            self.assertIsNone(options[dest].default, dest)


if __name__ == '__main__':
    unittest.main()
