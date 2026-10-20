"""Black-box scheduler checks using tiny processes, not product tests."""
from pathlib import Path
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('web_tests.py')

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.scripts = self.root / '.github/scripts'
        self.web = self.root / 'web'
        (self.web / 'tools').mkdir(parents=True)
        self.scripts.mkdir(parents=True)
        self.runner = self.scripts / 'web_tests.py'
        shutil.copyfile(SOURCE, self.runner)
        bindir = self.root / 'bin'
        bindir.mkdir()
        node = bindir / 'node'
        node.write_text(f'#!{sys.executable}\nimport os, sys\nos.execv(sys.executable, [sys.executable, sys.argv[-1]])\n')
        node.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{bindir}:' + os.environ['PATH'], WEB_TEST_JOBS='1', WEB_TEST_TIMEOUT='3', GITHUB_ACTIONS='true', GITHUB_STEP_SUMMARY=str(self.root / 'summary'))
        self.env.pop('NODE_OPTIONS', None)

    def file(self, name, source):
        (self.web / 'tools' / name).write_text(source)
        return 'tools/' + name

    def invoke(self, *files):
        return subprocess.run([sys.executable, str(self.runner), *files], env=self.env, capture_output=True, text=True, timeout=15)

    def test_discovery_logs_and_once_only_failures(self):
        self.file('a.test.mjs', "print('stdout a');import sys;print('stderr a',file=sys.stderr)\n")
        self.file('projects-ui.test.mjs', "from pathlib import Path\np=Path('attempts');n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n));raise SystemExit(n==1)\n")
        self.file('z.test.mjs', "print('last test still ran',end='')\n")
        for name in ('excluded-check.mjs', 'excluded-browser.mjs', '.hidden.test.mjs'):
            self.file(name, "raise RuntimeError('should not be discovered')\n")
        r=self.invoke()
        self.assertEqual(r.returncode, 1, r.stdout+r.stderr)
        self.assertIn('3 run, 1 failed', r.stdout)
        self.assertEqual((self.web/'attempts').read_text(), '1')
        self.assertIn('last test still ran\n::endgroup::', r.stdout)
        self.assertIn('stdout a\nstderr a', r.stdout.replace('stderr a\nstdout a', 'stdout a\nstderr a'))
        self.assertEqual(r.stdout.count('::group::'),3)
        self.assertEqual(r.stdout.count('::endgroup::'),3)
        self.assertIn('projects-ui', (self.root/'summary').read_text())

    def test_signal_and_timeout_fail_and_next_file_runs(self):
        signalled=self.file('signal.test.mjs','import os,signal\nos.kill(os.getpid(),signal.SIGKILL)\n')
        hangs=self.file('timeout.test.mjs',"import subprocess,sys,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)']);Path('timeout-child').write_text(str(p.pid));time.sleep(10)\n")
        last=self.file('last.test.mjs',"print('ran after failure')\n")
        self.env['WEB_TEST_TIMEOUT']='.5'
        r=self.invoke(signalled,hangs,last)
        self.assertEqual(r.returncode,1,r.stdout+r.stderr)
        self.assertIn('3 run, 2 failed',r.stdout)
        self.assertIn('timed out after .5s',r.stdout)
        self.assertIn('ran after failure',r.stdout)
        stat=Path('/proc')/(self.web/'timeout-child').read_text()/'stat'
        if stat.exists(): self.assertEqual(stat.read_text().rsplit(')',1)[1].split()[0],'Z')

    def test_cancellation_kills_descendants_and_does_not_start_next(self):
        hangs=self.file('hang.test.mjs', '''import os,signal,subprocess,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child=subprocess.Popen([sys.executable,'-c',"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"])
Path('pids').write_text(str(os.getpid())+' '+str(child.pid))
while True: time.sleep(1)
''')
        nextfile=self.file('next.test.mjs', "from pathlib import Path\nPath('unexpected').touch()\n")
        p=subprocess.Popen([sys.executable,str(self.runner),hangs,nextfile],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.addCleanup(lambda: p.kill() if p.poll() is None else None)
        deadline=time.monotonic()+3
        while not (self.web/'pids').exists() and time.monotonic()<deadline: time.sleep(.01)
        self.assertTrue((self.web/'pids').exists())
        p.send_signal(signal.SIGTERM)
        out,err=p.communicate(timeout=3)
        self.assertEqual(p.returncode,143,out+err)
        self.assertFalse((self.web/'unexpected').exists())
        for pid in (self.web/'pids').read_text().split():
            stat=Path('/proc')/pid/'stat'
            if stat.exists(): self.assertEqual(stat.read_text().rsplit(')',1)[1].split()[0],'Z',out+err)
        self.assertIn('1 not started (cancelled)',out)
        self.assertEqual(out.count('::group::'),out.count('::endgroup::'))

    def test_successful_parent_cannot_leave_background_child(self):
        file=self.file('background.test.mjs', "import subprocess,sys\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);Path('child-pid').write_text(str(p.pid))\n")
        r=self.invoke(file)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        stat=Path('/proc')/(self.web/'child-pid').read_text()/'stat'
        if stat.exists(): self.assertEqual(stat.read_text().rsplit(')',1)[1].split()[0],'Z')

    def test_explicit_filename_with_spaces_is_one_file(self):
        file=self.file('with space.test.mjs', "print('space file ran')\n")
        r=self.invoke(file)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('1 run, 0 failed',r.stdout)
        self.assertIn('space file ran',r.stdout)

    def test_invalid_configuration_and_empty_discovery_fail(self):
        self.assertNotEqual(self.invoke().returncode,0)
        self.file('valid.test.mjs', "print('valid configuration')\n")
        self.assertEqual(self.invoke().returncode,0)
        for key,value in [('WEB_TEST_JOBS','2'),('WEB_TEST_JOBS','3'),('WEB_TEST_TIMEOUT','0'),('WEB_TEST_TIMEOUT','NaN')]:
            self.env[key]=value
            self.assertNotEqual(self.invoke().returncode,0)
            self.env[key]='1'

if __name__=='__main__': unittest.main()
