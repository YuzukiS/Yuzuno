#!/usr/bin/env python3
"""Stop at a checkpoint (T-109): the wrapper's forwarding and the checks that
decide whether a stopped attempt is resumable. Real child processes, no
systemd: the unit's part is Core's and is tested there."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

MODULE = importlib.util.spec_from_file_location('job_host', Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)

# A command that saves on SIGTERM: it records each signal it got, writes a
# checkpoint file and then its manifest last, and exits with code 75.
SAVER = r'''
import json, os, signal, sys, time
seen = []
def stop(n, _):
    seen.append(n)
    directory = os.environ['YUZUNO_CHECKPOINT_DIR']
    request = json.load(open(os.environ['YUZUNO_CHECKPOINT_REQUEST']))
    with open(os.path.join(directory, 'model.ckpt'), 'wb') as f: f.write(b'weights' * 1000)
    manifest = {'attempt': os.environ['YUZUNO_JOB_ATTEMPT'], 'nonce': request['nonce'],
                'files': [{'path': 'model.ckpt'}], 'progress': {'globalStep': 7}}
    with open(os.path.join(directory, 'manifest.json.new'), 'w') as f: json.dump(manifest, f)
    os.replace(os.path.join(directory, 'manifest.json.new'), os.path.join(directory, 'manifest.json'))
    with open(os.environ['SEEN'], 'w') as f: json.dump(seen, f)
    os._exit(75)
signal.signal(signal.SIGTERM, stop)
open(os.environ['READY'], 'w').write(str(os.getpid()))
while True: time.sleep(0.05)
'''

def wait_for(path, seconds=10):
    deadline = time.monotonic() + seconds
    while not Path(path).exists():
        if time.monotonic() > deadline:
            raise AssertionError(f'{path} never appeared')
        time.sleep(0.01)


class Lab(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.folder = root / 'attempt'
        self.cwd = root / 'work'
        self.folder.mkdir()
        self.cwd.mkdir()
        self.spec = {'id': 'job', 'attempt': 'attempt-1', 'cwd': str(self.cwd), 'env': {},
                     'checkpoint': {'signal': 'SIGTERM', 'graceSeconds': 30, 'stoppedExitCode': 75}}
        self.dir = host.checkpoint_dir(self.spec)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, nonce='n-1'):
        host.atomic(self.folder / 'checkpoint-stop.json', {'attempt': self.spec['attempt'], 'nonce': nonce, 'requestedAt': time.time()})

    def save(self, files=None, **manifest):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / 'model.ckpt').write_bytes(b'weights')
        value = {'attempt': self.spec['attempt'], 'nonce': 'n-1', 'files': [{'path': 'model.ckpt'}] if files is None else files}
        value.update(manifest)
        (self.dir / 'manifest.json').write_text(json.dumps(value))

    def env(self):
        return {**os.environ, **host.attempt_env(self.spec, self.folder), 'SEEN': str(self.folder / 'seen.json'),
                'READY': str(self.folder / 'ready')}


class Verify(Lab):
    def test_no_request_means_no_checkpoint_claim(self):
        self.save()
        self.assertIsNone(host.verify_checkpoint(self.spec, self.folder, 75))

    def test_a_checkpoint_for_this_attempt_and_stop_is_resumable_with_cores_own_digest(self):
        self.request()
        self.save(progress={'globalStep': 3})
        checked = host.verify_checkpoint(self.spec, self.folder, 75)
        self.assertTrue(checked['ok'], checked)
        self.assertEqual(checked['files'], [{'path': 'model.ckpt', 'bytes': 7, 'sha256': hashlib.sha256(b'weights').hexdigest()}])
        self.assertEqual(checked['manifestSha256'], hashlib.sha256((self.dir / 'manifest.json').read_bytes()).hexdigest())
        self.assertEqual(checked['progress'], {'globalStep': 3})

    def test_everything_else_is_not_resumable_and_says_why(self):
        self.request()
        cases = {
            'the command exited 0, not the declared stopped code 75': lambda: (self.save(), 0),
            'no manifest.json was written': lambda: (self.dir.mkdir(parents=True, exist_ok=True), 75),
            'manifest.json is not readable JSON': lambda: (self.save(), (self.dir / 'manifest.json').write_text('{'), 75),
            'manifest.json is not a JSON object': lambda: (self.save(), (self.dir / 'manifest.json').write_text('[]'), 75),
            'the manifest names another attempt': lambda: (self.save(attempt='attempt-0'), 75),
            'the manifest does not name this stop request': lambda: (self.save(nonce='old'), 75),
            'the manifest lists no files': lambda: (self.save(files=[]), 75),
            'the manifest lists more than 1000 files': lambda: (self.save(files=[{'path': 'model.ckpt'}] * 1001), 75),
            'model.ckpt is missing': lambda: (self.save(), (self.dir / 'model.ckpt').unlink(), 75),
            'the manifest lists an invalid path: ../escape': lambda: (self.save(files=[{'path': '../escape'}]), 75),
            'the manifest lists an invalid path: /etc/passwd': lambda: (self.save(files=[{'path': '/etc/passwd'}]), 75),
            'the manifest lists an invalid path: manifest.json': lambda: (self.save(files=[{'path': 'manifest.json'}]), 75),
            'model.ckpt does not match the digest the manifest records': lambda: (self.save(files=[{'path': 'model.ckpt', 'sha256': '0' * 64}]), 75),
            'link.ckpt is not a regular file': lambda: (self.save(files=[{'path': 'link.ckpt'}]), (self.dir / 'link.ckpt').symlink_to(self.dir / 'model.ckpt'), 75),
            'via/model.ckpt is reached through a link': lambda: (self.save(files=[{'path': 'via/model.ckpt'}]), (self.dir / 'via').symlink_to(self.dir), 75),
            'manifest.json is larger than 1 MiB': lambda: (self.save(), (self.dir / 'manifest.json').write_text(' ' * (host.MANIFEST_LIMIT + 1)), 75),
        }
        for reason, arrange in cases.items():
            with self.subTest(reason=reason):
                shutil.rmtree(self.dir, ignore_errors=True)
                code = arrange()[-1]
                checked = host.verify_checkpoint(self.spec, self.folder, code)
                self.assertFalse(checked['ok'], checked)
                self.assertTrue(checked['reason'].startswith(reason), checked['reason'])


class Source(Lab):
    def verified(self):
        self.request()
        self.save()
        checked = host.verify_checkpoint(self.spec, self.folder, 75)
        self.assertTrue(checked['ok'], checked)
        return {'dir': checked['dir'], 'manifestSha256': checked['manifestSha256'], 'files': checked['files']}

    def test_a_resume_starts_only_from_the_checkpoint_exactly_as_verified(self):
        source = self.verified()
        self.assertIsNone(host.checkpoint_source_problem(source))
        (self.dir / 'model.ckpt').write_bytes(b'Weights')
        self.assertEqual(host.checkpoint_source_problem(source), 'a checkpoint file it resumes from has changed since it was verified')
        (self.dir / 'model.ckpt').unlink()
        self.assertEqual(host.checkpoint_source_problem(source), 'the checkpoint it resumes from: model.ckpt is missing')
        (self.dir / 'manifest.json').write_text('{}')
        self.assertEqual(host.checkpoint_source_problem(source), 'the checkpoint manifest it resumes from has changed since it was verified')
        (self.dir / 'manifest.json').unlink()
        self.assertIn('has no manifest', host.checkpoint_source_problem(source))

    def test_the_resumed_attempt_is_told_where_it_resumes_from(self):
        source = self.verified()
        resumed = {**self.spec, 'attempt': 'attempt-2', 'checkpointFrom': source}
        env = host.attempt_env(resumed, self.folder)
        self.assertEqual(env['YUZUNO_RESUME_FROM'], str(self.dir / 'manifest.json'))
        self.assertEqual(env['YUZUNO_CHECKPOINT_DIR'], str(Path(self.spec['cwd']) / '.yuzuno-checkpoints' / 'attempt-2'))


class Forwarding(Lab):
    def start(self, argv=None):
        self.dir.mkdir(parents=True)
        child = subprocess.Popen(argv or [sys.executable, '-c', SAVER], cwd=self.cwd, env=self.env())
        wait_for(self.folder / 'ready')
        return child

    def test_a_request_made_before_the_command_started_is_sent_when_it_starts(self):
        self.request()
        forward = host.Forwarder(self.spec, self.folder)
        child = self.start()
        forward.started(child)
        self.assertEqual(forward.wait(child), 75)
        sent = json.loads((self.folder / 'checkpoint-forward.json').read_text())
        self.assertEqual((sent['signal'], sent['pid']), ('SIGTERM', child.pid))
        self.assertTrue(host.verify_checkpoint(self.spec, self.folder, 75)['ok'])

    def test_one_signal_however_often_the_stop_is_asked(self):
        forward = host.Forwarder(self.spec, self.folder)
        child = self.start()
        forward.started(child)
        forward()  # no request yet: nothing is sent
        self.assertFalse((self.folder / 'checkpoint-forward.json').exists())
        self.request()
        forward()
        forward()
        self.assertEqual(forward.wait(child), 75)
        self.assertEqual(json.loads((self.folder / 'seen.json').read_text()), [signal.SIGTERM])

    def test_nothing_is_sent_once_the_command_has_exited(self):
        forward = host.Forwarder(self.spec, self.folder)
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        forward.started(child)
        self.assertEqual(forward.wait(child), 0)
        self.request()
        forward()
        self.assertFalse((self.folder / 'checkpoint-forward.json').exists(), 'a reaped PID may belong to someone else')

    def test_the_wrapper_forwards_a_real_signal_while_it_waits(self):
        # The wrapper as the unit runs it: SIGUSR1 arrives while it waits.
        driver = r'''
import importlib.util, json, signal, subprocess, sys
from pathlib import Path
spec_ = importlib.util.spec_from_file_location('job_host', sys.argv[1]); host = importlib.util.module_from_spec(spec_); spec_.loader.exec_module(host)
spec, folder = json.loads(sys.argv[2]), Path(sys.argv[3])
forward = host.Forwarder(spec, folder)
signal.signal(signal.SIGUSR1, forward)
child = subprocess.Popen([sys.executable, '-c', sys.argv[4]], cwd=spec['cwd'])
forward.started(child)
sys.exit(forward.wait(child))
'''
        self.dir.mkdir(parents=True)
        wrapper = subprocess.Popen([sys.executable, '-c', driver, str(Path(host.__file__)), json.dumps(self.spec),
                                    str(self.folder), SAVER], env=self.env())
        wait_for(self.folder / 'ready')
        self.request()
        wrapper.send_signal(signal.SIGUSR1)
        self.assertEqual(wrapper.wait(timeout=20), 75)
        self.assertTrue(host.verify_checkpoint(self.spec, self.folder, 75)['ok'])

    def test_a_runner_that_does_not_forward_leaves_no_resumable_checkpoint(self):
        # The signal reaches the shell, not the program it runs.
        self.request()
        forward = host.Forwarder(self.spec, self.folder)
        child = self.start(['/bin/sh', '-c', f'{sys.executable} -c "$SAVER_CODE" & wait'])
        forward.started(child)
        code = forward.wait(child)
        self.assertEqual(code, -signal.SIGTERM)
        checked = host.verify_checkpoint(self.spec, self.folder, code)
        self.assertFalse(checked['ok'])
        self.assertTrue(checked['reason'].startswith('the command exited -15'), checked['reason'])
        # The program it ran never got the signal; it is still running.
        os.kill(int((self.folder / 'ready').read_text()), signal.SIGKILL)

    def env(self):
        return {**super().env(), 'SAVER_CODE': SAVER}


class Classify(Lab):
    def test_only_a_verified_checkpoint_turns_the_end_into_a_checkpointed_stop(self):
        self.spec.update({'bootId': host.boot_id()})
        proof = {'attempt': self.spec['attempt'], 'bootId': host.boot_id(), 'invocationId': 'i', 'controlGroup': ''}
        host.atomic(self.folder / 'started.json', proof)
        state = {'InvocationID': 'i', 'MainPID': '0', 'SubState': 'failed', 'Result': 'exit-code', 'ExecMainCode': '1', 'ExecMainStatus': '75'}
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed')
        host.atomic(self.folder / 'checkpoint.json', {'ok': False, 'reason': 'no manifest.json was written'})
        self.assertEqual(host.classify(self.spec, self.folder, state), 'failed')
        host.atomic(self.folder / 'checkpoint.json', {'ok': True})
        self.assertEqual(host.classify(self.spec, self.folder, state), 'cancelled')
        self.assertTrue(host.terminal_reason(self.spec, self.folder, 'cancelled', state, None).startswith("Stopped at the user's request at a verified checkpoint"))


if __name__ == '__main__':
    unittest.main()
