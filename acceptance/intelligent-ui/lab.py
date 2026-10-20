#!/usr/bin/env python3
"""Own only the T-8 lab on 4387. Never signal the daily Core or reuse its data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
MAIN = (Path.home() / 'yuzuno-next')
PORT = 4387
BASE = f'http://127.0.0.1:{PORT}'
STATE = LAB / 'core-process.json'

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def api(path, body=None):
    request = urllib.request.Request(BASE + '/api' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=90) as response:
        return json.load(response)

def process(pid):
    proc = Path('/proc') / str(pid)
    try:
        stat = (proc / 'stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        if fields[0] == 'Z': return None
        return {'pid': pid, 'startTicks': fields[19], 'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0'), 'cwd': str((proc / 'cwd').resolve())}
    except (FileNotFoundError, ProcessLookupError): return None

def owned():
    if not STATE.exists(): return None
    expected = json.loads(STATE.read_text())
    current = process(expected['pid'])
    if not current: return None
    assert current == expected, 'Lab process identity changed; refusing to signal'
    args = current['argv']
    assert args[args.index('--port') + 1] == str(PORT)
    assert args[args.index('--data-dir') + 1] == str(LAB / 'core-data')
    assert current['cwd'] == str(ROOT)
    return current

def daily():
    # Files and listener identities only; no daily requests, prompts or window.
    import re
    sockets = subprocess.run(['ss', '-ltnp', 'sport = :4317'], capture_output=True, text=True, check=True).stdout
    pids = sorted({int(pid) for pid in re.findall(r'pid=(\d+)', sockets)})
    return {'processes': [process(pid) for pid in pids], 'assets': {str(path.relative_to(MAIN / 'web/dist')): hashlib.sha256(path.read_bytes()).hexdigest() for path in (MAIN / 'web/dist').rglob('*') if path.is_file()}}

def start():
    if owned(): print(BASE); return
    baseline = LAB / 'daily-baseline.json'
    if not baseline.exists(): save(baseline, daily())
    binary = LAB / 'core-bin' / 'yuzuno-workspace'
    binary.parent.mkdir(exist_ok=True)
    if not binary.exists(): shutil.copy2(MAIN / 'acceptance/four-slice-merge/candidate-core', binary)
    task = LAB / 'task'
    task.mkdir(exist_ok=True)
    (task / 'notes.md').write_text('# Navigation comparison acceptance\n\nThese are supplied design constraints, not measured performance.\n\nTurn dock: narrow rail, tracks reading position, hover previews.\nOutline: readable titles, requires a wider column.\nChapter markers: very quiet, fewer visible details.\n')
    command = [str(binary), '--port', str(PORT), '--data-dir', str(LAB / 'core-data'), '--cwd', str(task), '--web-dir', str(ROOT / 'target/intelligent-ui-dist')]
    with (LAB / 'core.log').open('ab') as log:
        child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    current = process(child.pid)
    assert current is not None, 'Lab exited before startup'
    save(STATE, current)
    for _ in range(100):
        assert process(child.pid), 'Lab exited; inspect core.log'
        try:
            assert api('/health')['application'] == 'yuzuno-next'
            print(BASE)
            return
        except OSError: time.sleep(.1)
    raise RuntimeError('Lab did not start')

def stop():
    current = owned()
    if not current: return
    assert not any(a['status'] in ('working', 'waiting', 'uncertain') or a.get('pendingCount') for a in api('/workspace')['agents'] if not a.get('closedAt')), 'Lab work is active or unconfirmed'
    os.kill(current['pid'], signal.SIGINT)
    for _ in range(100):
        if process(current['pid']) is None: return
        time.sleep(.1)
    raise RuntimeError('Owned lab did not stop; do not escalate')

def verify():
    same = daily() == json.loads((LAB / 'daily-baseline.json').read_text())
    save(LAB / 'daily-verification.json', {'unchanged': same})
    assert same, 'Daily assets or listener identity changed'
    print('Daily Core identity and UI assets unchanged')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'verify-daily'])
    action = parser.parse_args().action
    if action == 'start': start()
    elif action == 'stop': stop()
    elif action == 'verify-daily': verify()
    else: print(json.dumps({'process': owned(), 'base': BASE}, indent=2))
