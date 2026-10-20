"""Run only the disposable Agent-management Core on 4377."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

LAB = Path(__file__).resolve().parent
ROOT = LAB.parents[1]
PORT = 4377
BINARY = Path('/tmp/yuzuno-next-management-target/debug/yuzuno-workspace')
RECORD = LAB / 'core-process.json'
DATA = LAB / 'core-data'

def identity(pid):
    try:
        proc = Path('/proc') / str(pid)
        raw = (proc / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] == 'Z': return None
        return {'pid': pid, 'startTicks': fields[19],
                'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
    except FileNotFoundError:
        return None

def owned():
    if not RECORD.exists(): return None
    record = json.loads(RECORD.read_text())
    current = identity(record['pid'])
    if not current: return None
    assert current == {key: record[key] for key in ('pid','startTicks','argv')}, 'Process identity changed'
    assert current['argv'] == argv(), 'Not the management lab'
    return current

def argv():
    return [str(BINARY), '--port', str(PORT), '--data-dir', str(DATA),
            '--web-dir', str(LAB/'web-dist'), '--cwd', str(LAB/'task')]

def start():
    assert not owned(), 'Management lab already running'
    assert len(subprocess.check_output(['ss','-ltnp',f'sport = :{PORT}'],text=True).strip().splitlines()) == 1, 'Port in use'
    assert BINARY.is_file() and (LAB/'web-dist/index.html').is_file(), 'Build first'
    (LAB/'task').mkdir(exist_ok=True)
    sentinel=LAB/'task/KEEP.txt'
    if not sentinel.exists(): sentinel.write_text('Project files must survive Agent close and deletion.\n')
    env = dict(os.environ, YUZUNO_CLAUDE_BRIDGE=str(ROOT/'runtimes/claude/bridge.mjs'))
    with (LAB/'core.log').open('ab') as log:
        child=subprocess.Popen(argv(),cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    for _ in range(100):
        current=identity(child.pid)
        if current and current['argv']==argv(): break
        assert child.poll() is None, 'Lab failed to start'
        time.sleep(.01)
    assert current and current['argv']==argv()
    RECORD.write_text(json.dumps(current,indent=2)+'\n')
    for _ in range(100):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/health',timeout=1) as response:
                print(response.read().decode(), current['pid'])
                return
        except OSError:
            assert child.poll() is None, 'Lab exited'
            time.sleep(.1)
    raise RuntimeError('Lab not healthy')

def stop():
    current=owned()
    if not current: return
    os.kill(current['pid'],signal.SIGINT)
    for _ in range(100):
        if not identity(current['pid']): return
        time.sleep(.1)
    raise RuntimeError('Owned lab did not stop; no other process touched')

if __name__=='__main__':
    {'start':start, 'stop':stop, 'status':lambda:print(json.dumps(owned()))}[sys.argv[1]]()
