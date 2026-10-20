#!/usr/bin/env python3
"""Own only the isolated Claude acceptance Core on port 4337."""
import importlib.util
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
PORT = 4337
RECORD = LAB / 'core-process.json'
BINARY = Path('/tmp/yuzuno-next-claude-target/debug/yuzuno-workspace')

def process(pid):
    proc = Path('/proc') / str(pid)
    try:
        stat = (proc / 'stat').read_text()
        return {'pid': pid, 'startTicks': stat[stat.rfind(')')+2:].split()[19],
                'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')}
    except FileNotFoundError:
        return None

def owned():
    record = json.loads(RECORD.read_text())
    current = process(record['pid'])
    if current != {k: record[k] for k in ['pid', 'startTicks', 'argv']}:
        raise RuntimeError('Lab process identity changed; refusing to signal it')
    if str(LAB / 'core-data') not in current['argv']:
        raise RuntimeError('Not the Claude lab Core')
    return record

def start():
    listeners = subprocess.check_output(['ss', '-ltnp', f'sport = :{PORT}'], text=True)
    if len(listeners.strip().splitlines()) > 1:
        raise RuntimeError('Port 4337 is already in use; no process was changed')
    (LAB / 'task/.claude').mkdir(parents=True, exist_ok=True)
    # Only this lab task changes permission rules; native login remains untouched.
    (LAB / 'task/.claude/settings.json').write_text(json.dumps({'permissions': {'ask': ['Write', 'Edit', 'Bash']}}))
    argv = [str(BINARY), '--port', str(PORT), '--data-dir', str(LAB / 'core-data'),
            '--web-dir', str(LAB / 'source/web/dist'), '--cwd', str(LAB / 'task')]
    env = dict(os.environ, YUZUNO_CLAUDE_BRIDGE=str(ROOT / 'runtimes/claude/bridge.mjs'))
    with (LAB / 'core.log').open('ab') as log:
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    identity = process(child.pid)
    RECORD.write_text(json.dumps({**identity, 'baseUrl': f'http://127.0.0.1:{PORT}', 'dataDir': str(LAB / 'core-data')}, indent=2))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(100):
        try:
            with opener.open(f'http://127.0.0.1:{PORT}/api/health', timeout=1) as response:
                print(response.read().decode(), f'PID {child.pid}'); return
        except OSError:
            if child.poll() is not None: raise RuntimeError('Lab Core exited; see core.log')
            time.sleep(.1)
    raise RuntimeError('Core not ready; inspect the owned process')

def stop():
    record = owned()
    os.kill(record['pid'], signal.SIGINT)
    for _ in range(100):
        if process(record['pid']) is None:
            print('Stopped owned Claude lab Core'); return
        time.sleep(.1)
    raise RuntimeError('Core did not stop; no other process was signalled')

def verify_daily():
    spec = importlib.util.spec_from_file_location('slice_lab', ROOT / 'scripts/slice-lab.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    old = json.loads((LAB / 'daily-baseline.json').read_text()); new = mod.daily_state()
    identity = lambda records: [{k: v for k, v in x.items() if k != 'state'} for x in records if x]
    result = {'sameDailyProcess': identity(old['processes']) == identity(new['processes']),
              'dailyWebDistUnchanged': old['webDist'] == new['webDist'], 'currentHealth': new['health'],
              'note': 'Read-only comparison; concurrent changes by other agents are reported, never reverted.'}
    (LAB / 'daily-verification.json').write_text(json.dumps(result, indent=2)); print(json.dumps(result, indent=2))

if __name__ == '__main__':
    {'start': start, 'stop': stop, 'status': lambda: print(json.dumps(owned())), 'verify-daily': verify_daily}[sys.argv[1]]()
