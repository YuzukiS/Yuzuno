#!/usr/bin/env python3
"""Host evidence and bounded input guard checks; no real service mutations."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
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

if __name__=='__main__':unittest.main()
