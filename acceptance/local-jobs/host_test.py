#!/usr/bin/env python3
"""Host evidence and bounded input guard checks; no real service mutations."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
MODULE = importlib.util.spec_from_file_location('job_host', Path(__file__).resolve().parents[2] / 'core/src/jobs/host.py')
host = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(host)

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.spec = {'id':'one','attempt':'attempt','bootId':host.boot_id(),'unit':'worker','supervisorUnit':'collector'}
        self.proof = {'jobId':'one','attempt':'attempt','bootId':host.boot_id(),'invocationId':'invocation','controlGroup':'/fake'}
        host.atomic(self.folder / 'started.json', self.proof)

    def tearDown(self): self.tmp.cleanup()

    def test_pid_files_keep_real_values_and_missing_is_unknown(self):
        self.assertIsNone(host.pids_snapshot(self.folder))
        (self.folder/'pids.max').write_text('512\n')
        (self.folder/'pids.events').write_text('max 3\n')
        self.assertEqual(host.pids_snapshot(self.folder), {'max':512,'events':{'max':3}})
        (self.folder/'pids.peak').write_text('501\n')
        self.assertEqual(host.pids_snapshot(self.folder)['peak'], 501)
        (self.folder/'pids.events').write_text('unreadable value\n')
        self.assertNotIn('events', host.pids_snapshot(self.folder))

    def test_pid_diagnosis_requires_failed_command_and_new_kernel_events(self):
        state = {'Result':'exit-code'}
        before = {'max':512,'events':{'max':0}}
        after = {'max':512,'peak':512,'events':{'max':2}}
        pids = {'before':before,'after':after}
        reason = host.terminal_reason(self.spec,self.folder,'failed',state,pids)
        self.assertIn('Process/thread limit reached (512 tasks)', reason)
        self.assertIn('increased by 2', reason)
        for sample in [None, {'after':after},
                       {'before':before,'after':{'max':512,'peak':512}},
                       {'before':after,'after':after},
                       {'before':after,'after':before}]:
            with self.subTest(sample=sample):
                self.assertEqual(host.terminal_reason(self.spec,self.folder,'failed',state,sample), 'exit-code')
        self.assertEqual(host.terminal_reason(self.spec,self.folder,'succeeded',{'Result':'success'},pids),'success')
        for outcome in ('oom-kill','timeout','resources'):
            self.assertEqual(host.terminal_reason(self.spec,self.folder,'failed',{'Result':outcome},pids),outcome)
        host.atomic(self.folder/'cancel.json', {'attempt':self.spec['attempt']})
        self.assertEqual(host.terminal_reason(self.spec,self.folder,'failed',state,pids),'exit-code')

    def test_worker_exit_counters_survive_gc_and_reconciliation(self):
        self.proof['pids']={'max':512,'events':{'max':0}}
        host.atomic(self.folder/'started.json', self.proof)
        finished={**self.proof,'pids':{'max':512,'peak':512,'events':{'max':1}}}
        host.atomic(self.folder/'finished-pids.json', finished)
        state={'InvocationID':'invocation','ControlGroup':'/fake','Result':'exit-code'}
        with patch.object(host,'pids_snapshot',return_value=None):
            proof=host.pids_evidence(self.spec,self.folder,state)
            self.assertEqual(proof['source'],'worker-exit')
            self.assertEqual(proof['after']['events']['max'],1)
            with patch.object(host,'classify',return_value='failed'), patch.object(host,'show',return_value=state), patch.object(host,'settled',side_effect=lambda s,f,r:r):
                result=host.reconcile(self.spec,self.folder)
            self.assertEqual(result['evidence']['pids'],proof)
            self.assertIn('Process/thread limit reached',result['reason'])
            self.assertEqual(host.read(self.folder/'result.json'),result)
        self.assertIsNone(host.pids_evidence(self.spec,self.folder,{**state,'InvocationID':'different'}))
        host.atomic(self.folder/'finished-pids.json',{**finished,'attempt':'old-attempt'})
        with patch.object(host,'pids_snapshot',return_value=None):
            self.assertIsNone(host.pids_evidence(self.spec,self.folder,state))

    def test_collector_retains_sample_if_group_disappears_without_worker_exit(self):
        state={'InvocationID':'invocation','ControlGroup':'/fake'}
        with patch.object(host,'pids_snapshot',return_value={'max':512,'events':{'max':1}}):
            sample=host.pids_evidence(self.spec,self.folder,state)
        with patch.object(host,'pids_snapshot',return_value=None):
            self.assertEqual(host.pids_evidence(self.spec,self.folder,state,sample),sample)
        self.assertEqual(sample['source'],'collector-sample')

    @patch.object(host, 'group_empty', return_value=True)
    def test_empty_gc_success_is_not_a_terminal_proof(self, _):
        state = {'MainPID':'0','SubState':'exited','Result':'success','ExecMainCode':'1','ExecMainStatus':'0'}
        self.assertIsNone(host.classify(self.spec,self.folder,state))
        state['InvocationID']='other'
        self.assertIsNone(host.classify(self.spec,self.folder,state))
        state['InvocationID']='invocation'
        self.assertEqual(host.classify(self.spec,self.folder,state),'succeeded')
        with patch.object(host,'group_empty',return_value=False):
            self.assertIsNone(host.classify(self.spec,self.folder,state))

    @patch.object(host, 'group_empty', return_value=True)
    def test_unknown_can_cancel_but_reused_units_cannot_be_stopped(self, _):
        host.result(self.spec,self.folder,'unknown',{})
        absent={'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}
        with patch.object(host,'show',return_value=absent), patch.object(host,'command') as command:
            self.assertEqual(host.cancel(self.spec,self.folder)['status'],'cancelled')
            self.assertEqual(command.call_count,2)
        (self.folder / 'result.json').unlink()
        with patch.object(host,'show',return_value={**absent,'LoadState':'loaded','Description':'another job'}), patch.object(host,'command') as command:
            self.assertEqual(host.cancel(self.spec,self.folder)['status'],'unknown')
            command.assert_not_called()

    @patch.object(host, 'group_empty', return_value=True)
    def test_terminal_outcome_is_immutable_and_reservation_waits_for_collector(self, _):
        saved=host.result(self.spec,self.folder,'failed',{'why':'oom-kill'})
        self.assertEqual(host.result(self.spec,self.folder,'succeeded',{}),saved)
        with patch.object(host,'show',return_value={'ActiveState':'active','MainPID':'42'}):
            self.assertEqual(host.settled(self.spec,self.folder,saved)['status'],'settling')
        with patch.object(host,'show',return_value={'ActiveState':'inactive','MainPID':'0'}):
            self.assertEqual(host.settled(self.spec,self.folder,saved),saved)

    def test_git_guard_detects_head_and_changed_tracked_content_without_untracked_scan(self):
        def git(*args):
            return subprocess.run(['git','-C',str(self.folder),*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        git('init','-q'); (self.folder/'code.py').write_text('first')
        git('add','code.py');git('-c','user.name=Lab','-c','user.email=lab@example.invalid','commit','-qm','fixture')
        spec={'cwd':str(self.folder),'guardGit':True}
        initial=host.snapshot(spec)
        (self.folder/'untracked-large').write_bytes(b'x'*(3*1024*1024))
        self.assertEqual(host.snapshot(spec),initial)
        (self.folder/'code.py').write_text('second')
        changed=host.snapshot(spec);self.assertNotEqual(changed,initial)
        (self.folder/'code.py').write_text('third')
        self.assertNotEqual(host.snapshot(spec),changed)
        with self.assertRaisesRegex(RuntimeError,'2 MiB'):
            host.snapshot({**spec,'inputs':['untracked-large']})

class SharedEndTests(unittest.TestCase):
    """A service retry's absolute end (T-14): cut at launch, refused near it, stopped at it."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.clock = [1000.0]
        self.spec = {'id':'one','attempt':'attempt','bootId':host.boot_id(),'unit':'worker','supervisorUnit':'collector',
                     'timeoutSeconds':7200,'resources':{'cpuMillis':100,'memoryMiB':64,'swapMiB':0},
                     'cwd':str(self.folder),'argv':['/bin/true'],'env':{}}

    def tearDown(self): self.tmp.cleanup()

    def fake_time(self):
        def sleep(seconds): self.clock[0] += seconds
        return patch.object(host.time,'time',side_effect=lambda: self.clock[0]), patch.object(host.time,'sleep',side_effect=sleep)

    def test_run_time_is_the_timeout_cut_to_the_end_and_none_near_it(self):
        self.assertEqual(host.run_time(self.spec, 1000), 7200)
        self.assertFalse(host.past_end(self.spec, 10**10))
        cases = [(1000+3600, 3600), (1000+100.2, 101), (1000+60, 60), (1000+59.9, None), (999, None)]
        for end, expected in cases:
            with self.subTest(end=end):
                self.assertEqual(host.run_time({**self.spec,'deadlineAtUnix':end}, 1000), expected)
        self.assertEqual(host.run_time({**self.spec,'timeoutSeconds':30,'deadlineAtUnix':1000+3600}, 1000), 30)
        spec = {**self.spec,'deadlineAtUnix':1061}
        self.assertFalse(host.past_end(spec, 1060.9))
        self.assertTrue(host.past_end(spec, 1061))

    def test_supervise_creates_no_unit_with_less_than_a_minute_left(self):
        spec = {**self.spec,'deadlineAtUnix':1000+59.5}
        clock, sleep = self.fake_time()
        with clock, sleep, patch.object(host,'command') as command:
            outcome = host.supervise(spec, self.folder)
            command.assert_not_called()
        self.assertEqual(outcome['status'],'rejected')
        self.assertEqual(outcome['reason'],host.NOT_STARTED_NEAR_END)
        self.assertFalse(outcome['evidence']['workerStarted'])
        self.assertEqual(outcome['evidence']['deadline']['kind'],'notStarted')
        self.assertEqual(host.read(self.folder/'deadline.json')['kind'],'notStarted')

    @patch.object(host, 'snapshot', side_effect=lambda spec: spec['snapshot'])
    @patch.object(host, 'upstream_problem', return_value=None)
    def test_worker_checks_the_end_again_just_before_exec(self, *_):
        spec = {**self.spec,'snapshot':{'same':True},'deadlineAtUnix':1000+59.5}
        limits = {'memory.max':str(64*1024*1024),'memory.swap.max':'0','cpu.max':'10000 100000','pids.max':str(host.TASKS_MAX)}
        class Fake(type(Path())):
            def read_text(self, *args, **kwargs):
                if str(self) == '/proc/self/cgroup': return '0::/fake\n'
                if str(self.parent) == '/sys/fs/cgroup/fake' and self.name in limits: return limits[self.name] + '\n'
                return super().read_text(*args, **kwargs)
        clock, sleep = self.fake_time()
        with clock, sleep, patch.object(host,'Path',Fake), patch.object(host,'pids_snapshot',return_value=None), \
                patch.object(host.subprocess,'Popen') as popen:
            self.assertEqual(host.worker(spec, self.folder), 78)
            popen.assert_not_called()
        self.assertEqual(host.read(self.folder/'input-changed.json')['reason'],host.NOT_STARTED_NEAR_END)
        self.assertEqual(host.read(self.folder/'deadline.json')['kind'],'notStarted')
        self.assertIsNotNone(host.read(self.folder/'started.json'))

    def supervise_until_end(self, spec, ends):
        """Run supervise against a unit that stays active until `ends(calls)` says it has ended."""
        calls = []
        def command(args, timeout=8, check=True):
            calls.append((self.clock[0], list(args), host.read(self.folder/'deadline.json')))
            return MagicMock(returncode=0, stdout='', stderr='')
        state = {'ActiveState':'active','SubState':'running','MainPID':'42','Result':'success'}
        clock, sleep = self.fake_time()
        with clock, sleep, patch.object(host,'command',side_effect=command), patch.object(host,'show',return_value=state), \
                patch.object(host,'pids_evidence',return_value=None), \
                patch.object(host,'classify',side_effect=lambda *_: ends(calls)), patch.object(host,'terminal_reason',return_value='signal'):
            outcome = host.supervise(spec, self.folder)
        return outcome, calls

    def test_supervise_stops_the_unit_at_the_end_with_term_then_kill_and_records_it_first(self):
        spec = {**self.spec,'deadlineAtUnix':1000+61}
        killed = lambda calls: 'failed' if any('--signal=SIGKILL' in args for _, args, _ in calls) else None
        outcome, calls = self.supervise_until_end(spec, killed)
        launch = calls[0][1]
        self.assertEqual(launch[0],'systemd-run')
        self.assertIn('RuntimeMaxSec=61s', launch)
        kills = [(at, args, marker) for at, args, marker in calls if args[:3] == ['systemctl','--user','kill']]
        self.assertEqual([args[-2] for _, args, _ in kills], ['--signal=SIGTERM','--signal=SIGKILL'])
        (term_at, term, before_term), (kill_at, _, before_kill) = kills
        self.assertEqual(term[-1], 'worker')
        self.assertIn('--kill-whom=all', term)
        self.assertEqual(term_at, 1061.0)
        self.assertTrue(3 <= kill_at - term_at < 3.5)
        self.assertEqual(before_term['kind'],'stop')
        self.assertEqual(before_term['at'],1061.0)
        self.assertNotIn('killedAt', before_term)
        self.assertEqual(before_kill['killedAt'],kill_at)
        self.assertEqual(outcome['status'],'failed')
        self.assertEqual(outcome['evidence']['deadline']['kind'],'stop')
        self.assertEqual(outcome['evidence']['deadline']['killedAt'],kill_at)

    def test_without_an_end_or_before_it_supervise_never_signals(self):
        for extra in ({}, {'deadlineAtUnix':1000+3600}):
            with self.subTest(extra=extra):
                (self.folder/'launch.json').unlink(missing_ok=True)
                (self.folder/'result.json').unlink(missing_ok=True)
                self.clock[0] = 1000.0
                ended = lambda calls: 'succeeded' if self.clock[0] >= 1100 else None
                outcome, calls = self.supervise_until_end({**self.spec,**extra}, ended)
                self.assertIn('RuntimeMaxSec=' + ('7200' if not extra else '3600') + 's', calls[0][1])
                self.assertFalse([args for _, args, _ in calls if args[:3] == ['systemctl','--user','kill']])
                self.assertEqual(outcome['status'],'succeeded')
                self.assertIsNone(outcome['evidence']['deadline'])

    def reconcile_now(self, status, state):
        """Core's own reading of an ended unit, as it may come before or after the collector's."""
        with patch.object(host,'show',return_value=state), patch.object(host,'classify',return_value=status), \
                patch.object(host,'pids_evidence',return_value=None), patch.object(host,'settled',side_effect=lambda s,f,r:r):
            return host.reconcile(self.spec, self.folder)

    def clean(self, *names):
        for name in names:
            (self.folder/name).unlink(missing_ok=True)

    def record_in_order(self, first, status, state, reason):
        """The two writers of one ended attempt; returns what was kept, checking the second gets it too."""
        collect = lambda: host.result(self.spec, self.folder, status, {'launch':{}, 'systemd':state, 'pids':None,
                                                                       'deadline':host.read(self.folder/'deadline.json')}, reason)
        if first == 'reconcile':
            kept = self.reconcile_now(status, state)
            self.assertEqual(collect(), kept, 'the first outcome is kept')
        else:
            kept = collect()
            self.assertEqual(self.reconcile_now(status, state), kept, 'the first outcome is kept')
        self.assertEqual(host.read(self.folder/'result.json'), kept)
        return kept

    def test_an_end_time_stop_keeps_its_marker_in_either_order(self):
        # SIGTERM at the end, and the SIGKILL 3 s later, as the collector records them.
        for code, killed in (('15', None), ('9', 1064.0)):
            for first in ('reconcile', 'collector'):
                with self.subTest(signal=code, first=first):
                    self.clean('result.json', 'deadline.json')
                    marker = {'kind':'stop','attempt':self.spec['attempt'],'at':1061.0,'deadlineAtUnix':1061}
                    if killed:
                        marker['killedAt'] = killed
                    host.atomic(self.folder/'deadline.json', marker)
                    state = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'signal','ExecMainStatus':code}
                    kept = self.record_in_order(first, 'failed', state, 'signal')
                    self.assertEqual(kept['evidence']['deadline'], marker)
                    self.assertEqual(kept['evidence']['systemd'], state)

    def test_a_refusal_near_the_end_keeps_its_marker_in_either_order(self):
        for first in ('reconcile', 'collector'):
            with self.subTest(first=first):
                self.clean('result.json', 'deadline.json', 'input-changed.json')
                marker = {'kind':'notStarted','attempt':self.spec['attempt'],'at':1000.0,'deadlineAtUnix':1059.5}
                host.atomic(self.folder/'deadline.json', marker)
                host.atomic(self.folder/'input-changed.json', {'reason':host.NOT_STARTED_NEAR_END})
                exited = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'exit-code','ExecMainStatus':'78'}
                kept = self.record_in_order(first, 'rejected', exited, host.NOT_STARTED_NEAR_END)
                self.assertEqual((kept['status'], kept['reason']), ('rejected', host.NOT_STARTED_NEAR_END))
                self.assertEqual(kept['evidence']['deadline'], marker)

    def test_a_marker_never_turns_an_unknown_an_interruption_or_another_attempt_into_an_ending(self):
        host.atomic(self.folder/'deadline.json', {'kind':'stop','attempt':self.spec['attempt'],'at':1061.0,'deadlineAtUnix':1061})
        running = {'InvocationID':'invocation','MainPID':'42','SubState':'running','Result':'success'}
        unknown = host.result(self.spec, self.folder, 'unknown', {'launch':{}, 'systemd':running, 'pids':None},
                              'No conclusive terminal evidence before collector deadline')
        self.assertNotIn('deadline', unknown['evidence'])
        interrupted = host.result(self.spec, self.folder, 'interrupted', {'expectedBootId':'earlier','currentBootId':host.boot_id()},
                                  'OS boot changed; the previous process cannot continue')
        self.assertEqual(interrupted['status'], 'interrupted', 'an unknown outcome is not kept over a later one')
        self.assertNotIn('deadline', interrupted['evidence'])
        self.clean('result.json')
        host.atomic(self.folder/'deadline.json', {'kind':'stop','attempt':'an-earlier-attempt','at':1061.0,'deadlineAtUnix':1061})
        crashed = self.reconcile_now('failed', {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'signal','ExecMainStatus':'15'})
        self.assertNotIn('deadline', crashed['evidence'])

    def test_without_a_marker_a_crash_stays_a_crash_and_its_evidence_is_unchanged(self):
        crashed = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'signal','ExecMainStatus':'11'}
        outcome = self.reconcile_now('failed', crashed)
        self.assertEqual((outcome['status'], set(outcome['evidence'])), ('failed', {'systemd','pids'}))
        self.clean('result.json')
        collected = host.result(self.spec, self.folder, 'failed', {'launch':{}, 'systemd':crashed, 'pids':None, 'deadline':None}, 'signal')
        self.assertEqual(set(collected['evidence']), {'launch','systemd','pids','deadline'})
        self.assertIsNone(collected['evidence']['deadline'])

class WorkerLaunchTests(unittest.TestCase):
    """The unit's main process is the host's wrapper, not the command (T-14):
    what it records of the command it creates, with real snapshots and a real
    Popen. The command is a sentinel that leaves ran.txt whenever it starts."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.folder = root / 'job'
        self.work = root / 'work'
        self.folder.mkdir()
        self.work.mkdir()
        (self.work / 'config.txt').write_text('original\n')
        self.spec = {'id':'one','attempt':'attempt','bootId':host.boot_id(),'unit':'worker','supervisorUnit':'collector',
                     'timeoutSeconds':600,'resources':{'cpuMillis':100,'memoryMiB':64,'swapMiB':0},
                     'cwd':str(self.work),'env':{},'guardGit':False,'inputs':['config.txt'],
                     'argv':['/bin/sh','-c','echo ran >> ran.txt; exit 3']}
        self.spec['snapshot'] = host.snapshot(self.spec)

    def tearDown(self): self.tmp.cleanup()

    def run_worker(self):
        limits = {'memory.max':str(64*1024*1024),'memory.swap.max':'0','cpu.max':'10000 100000','pids.max':str(host.TASKS_MAX)}
        class Fake(type(Path())):
            def read_text(self, *args, **kwargs):
                if str(self) == '/proc/self/cgroup': return '0::/fake\n'
                if str(self.parent) == '/sys/fs/cgroup/fake' and self.name in limits: return limits[self.name] + '\n'
                return super().read_text(*args, **kwargs)
        with patch.object(host,'Path',Fake), patch.object(host,'pids_snapshot',return_value=None):
            return host.worker(self.spec, self.folder)

    def recorded(self):
        """The outcome the host records afterwards for the unit's exit-code."""
        return host.result(self.spec, self.folder, 'failed', {'systemd':{'Result':'exit-code','ExecMainStatus':'1'}}, 'exit-code')

    def assert_never_launched(self, stage, words):
        with self.assertRaises(Exception):
            self.run_worker()
        self.assertFalse((self.work/'ran.txt').exists(), 'the command never ran')
        record = host.read(self.folder/'not-launched.json')
        self.assertEqual((record['attempt'], record['stage']), (self.spec['attempt'], stage))
        self.assertIn(words, record['reason'])
        self.assertIsNone(host.read(self.folder/'command.json'))
        outcome = self.recorded()
        self.assertEqual(outcome['evidence']['notLaunched'], record)
        self.assertNotIn('command', outcome['evidence'])

    def test_an_input_that_became_a_directory_never_starts_the_command(self):
        (self.work/'config.txt').unlink()
        (self.work/'config.txt').mkdir()
        self.assert_never_launched('inputs', 'Guarded inputs must be files')

    def test_an_input_grown_past_the_guard_never_starts_the_command(self):
        (self.work/'config.txt').write_bytes(b'x' * (3 * 1024 * 1024))
        self.assert_never_launched('inputs', '2 MiB')

    def test_a_git_head_that_cannot_be_read_never_starts_the_command(self):
        def git(*args):
            subprocess.run(['git','-C',str(self.work),*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        git('init','-q'); git('add','config.txt')
        git('-c','user.name=Lab','-c','user.email=lab@example.invalid','commit','-qm','fixture')
        self.spec['guardGit'] = True
        self.spec['snapshot'] = host.snapshot(self.spec)
        (self.work/'.git'/'HEAD').write_text('ref: refs/heads/no-such-branch\n')
        self.assert_never_launched('inputs', 'RuntimeError')

    def test_a_command_that_cannot_be_created_is_recorded_as_never_started(self):
        self.spec['argv'] = [str(self.work/'no-such-command')]
        self.assert_never_launched('process', 'FileNotFoundError')

    def test_the_commands_own_exit_is_recorded_once_it_ran(self):
        self.assertEqual(self.run_worker(), 3)
        self.assertEqual((self.work/'ran.txt').read_text(), 'ran\n')
        command = host.read(self.folder/'command.json')
        self.assertEqual((command['attempt'], command['exitCode']), (self.spec['attempt'], 3))
        self.assertIsNone(host.read(self.folder/'not-launched.json'))
        self.assertEqual(self.recorded()['evidence']['command'], command)

    def test_the_commands_own_signal_is_recorded_once_it_ran(self):
        self.spec['argv'] = ['/bin/sh','-c','echo ran >> ran.txt; kill -SEGV $$']
        with patch.object(host.os,'kill') as kill:
            self.assertEqual(self.run_worker(), -signal.SIGSEGV)
            kill.assert_called_once_with(os.getpid(), signal.SIGSEGV)
        self.assertEqual(host.read(self.folder/'command.json')['exitCode'], -signal.SIGSEGV)

    def test_a_signal_the_wrapper_ignores_is_recorded_and_returned_as_the_commands(self):
        # The kernel ends the command: SIGPIPE on a write to a closed pipe,
        # SIGXFSZ past its file size limit. Python ignores both, so the
        # wrapper cannot raise them again (os.kill is real here); it records
        # the signal and returns it, and main exits with it (status 256 less
        # the signal), which Core reads as the command's signal (T-14, R7).
        commands = {
            signal.SIGPIPE: 'import os, signal\nsignal.signal(signal.SIGPIPE, signal.SIG_DFL)\n'
                            'r, w = os.pipe()\nos.close(r)\nos.write(w, b"x")\n',
            signal.SIGXFSZ: 'import resource, signal\nsignal.signal(signal.SIGXFSZ, signal.SIG_DFL)\n'
                            'resource.setrlimit(resource.RLIMIT_FSIZE, (4096, resource.getrlimit(resource.RLIMIT_FSIZE)[1]))\n'
                            'f = open("big.bin", "wb", buffering=0)\nwhile True:\n    f.write(b"x" * 65536)\n',
        }
        for sig, command in commands.items():
            with self.subTest(signal=sig.name):
                self.assertEqual(signal.getsignal(sig), signal.SIG_IGN, 'this process ignores it, as the wrapper does')
                self.folder = Path(self.tmp.name) / ('job-' + sig.name)
                self.folder.mkdir()
                self.spec['argv'] = ['/usr/bin/python3', '-c', command]
                self.assertEqual(self.run_worker(), -sig)
                record = host.read(self.folder/'command.json')
                self.assertEqual((record['attempt'], record['exitCode']), (self.spec['attempt'], -sig))

    def test_once_popen_returned_a_failed_receipt_never_claims_the_command_did_not_start(self):
        real = host.atomic
        def failing(path, data):
            if Path(path).name == 'command.json':
                raise OSError(28, 'No space left on device')
            return real(path, data)
        with patch.object(host,'atomic',side_effect=failing), self.assertRaises(OSError):
            self.run_worker()
        self.assertIsNone(host.read(self.folder/'not-launched.json'), 'the command may have started')
        evidence = self.recorded()['evidence']
        self.assertNotIn('notLaunched', evidence)
        self.assertNotIn('command', evidence)

    def test_a_live_reading_carries_only_this_attempts_command_record(self):
        state = {'InvocationID':'invocation','MainPID':'42','SubState':'running','ActiveState':'active','Result':'success'}
        def live():
            with patch.object(host,'show',return_value=state), patch.object(host,'classify',return_value=None):
                return host.reconcile(self.spec, self.folder)
        self.assertEqual(live()['status'], 'unresolved')
        self.assertIsNone(live()['command'], 'the worker alone has not created the command')
        host.atomic(self.folder/'command.json', {'attempt':'an-earlier-attempt','pid':42,'startedAt':1.0})
        self.assertIsNone(live()['command'])
        record = {'attempt':self.spec['attempt'],'pid':42,'startedAt':1.0}
        host.atomic(self.folder/'command.json', record)
        self.assertEqual(live()['command'], record)

    def test_proof_from_another_attempt_or_on_an_unknown_outcome_is_not_this_commands_exit(self):
        host.atomic(self.folder/'command.json', {'attempt':'an-earlier-attempt','pid':42,'exitCode':1})
        self.assertNotIn('command', self.recorded()['evidence'])
        (self.folder/'result.json').unlink()
        host.atomic(self.folder/'command.json', {'attempt':self.spec['attempt'],'pid':42,'exitCode':1})
        unknown = host.result(self.spec, self.folder, 'unknown', {'systemd':{}}, 'No conclusive terminal evidence')
        self.assertNotIn('command', unknown['evidence'])

if __name__=='__main__':unittest.main()
