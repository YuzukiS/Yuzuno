#!/usr/bin/env python3
"""Host evidence and bounded input guard checks; no real service mutations."""
import importlib.util
import json
import os
from pathlib import Path
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
        """Core's own reading of an ended unit, before the collector records it."""
        with patch.object(host,'show',return_value=state), patch.object(host,'classify',return_value=status), \
                patch.object(host,'pids_evidence',return_value=None), patch.object(host,'settled',side_effect=lambda s,f,r:r):
            return host.reconcile(self.spec, self.folder)

    def test_reconciliation_recording_first_keeps_the_end_time_stop(self):
        marker = {'kind':'stop','at':1061.0,'deadlineAtUnix':1061}
        host.atomic(self.folder/'deadline.json', marker)
        signalled = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'signal','ExecMainStatus':'15'}
        first = self.reconcile_now('failed', signalled)
        self.assertEqual(first['evidence']['deadline'], marker)
        self.assertEqual(first['evidence']['systemd'], signalled)
        # The collector finishes later: the first outcome, its marker included, stays.
        late = host.result(self.spec, self.folder, 'failed', {'launch':{}, 'systemd':signalled, 'pids':None, 'deadline':marker}, 'signal')
        self.assertEqual(late, first)
        self.assertEqual(host.read(self.folder/'result.json')['evidence']['deadline'], marker)

    def test_collector_recording_first_keeps_it_when_reconciliation_follows(self):
        marker = {'kind':'stop','at':1061.0,'deadlineAtUnix':1061,'killedAt':1064.0}
        host.atomic(self.folder/'deadline.json', marker)
        state = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'signal','ExecMainStatus':'9'}
        first = host.result(self.spec, self.folder, 'failed', {'launch':{}, 'systemd':state, 'pids':None,
                                                                'deadline':host.read(self.folder/'deadline.json')}, 'signal')
        self.assertEqual(self.reconcile_now('failed', state), first)
        self.assertEqual(first['evidence']['deadline'], marker)

    def test_reconciled_refusal_near_the_end_keeps_not_started(self):
        marker = {'kind':'notStarted','at':1000.0,'deadlineAtUnix':1059.5}
        host.atomic(self.folder/'deadline.json', marker)
        host.atomic(self.folder/'input-changed.json', {'reason':host.NOT_STARTED_NEAR_END})
        exited = {'InvocationID':'invocation','MainPID':'0','SubState':'failed','Result':'exit-code','ExecMainStatus':'78'}
        outcome = self.reconcile_now('rejected', exited)
        self.assertEqual((outcome['status'], outcome['reason']), ('rejected', host.NOT_STARTED_NEAR_END))
        self.assertEqual(outcome['evidence']['deadline'], marker)

    def test_an_ending_without_a_marker_keeps_its_evidence_as_it_was(self):
        state = {'InvocationID':'invocation','MainPID':'0','SubState':'exited','Result':'success','ExecMainStatus':'0'}
        outcome = self.reconcile_now('succeeded', state)
        self.assertEqual(set(outcome['evidence']), {'systemd','pids'})
        (self.folder/'result.json').unlink()
        collected = host.result(self.spec, self.folder, 'succeeded', {'launch':{}, 'systemd':state, 'pids':None, 'deadline':None}, 'success')
        self.assertEqual(set(collected['evidence']), {'launch','systemd','pids','deadline'})
        self.assertIsNone(collected['evidence']['deadline'])

if __name__=='__main__':unittest.main()
