#!/usr/bin/env python3
"""Session-import acceptance on 4383, with independent data, assets and binary.

Never signals the daily Core. Process identity is checked before every stop.
Native authentication stays in the official CLI's existing environment.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
MAIN = (Path.home() / 'yuzuno-next')
TARGET = ROOT / 'target'
PORT = 4383
BASE = f'http://127.0.0.1:{PORT}'
STATE = LAB / 'core-process.json'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def api(path, body=None):
    request = urllib.request.Request(BASE + '/api' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code} {path}: {error.read().decode()}') from None


def process(pid):
    proc = Path('/proc') / str(pid)
    try:
        stat = (proc / 'stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': fields[19],
                'argv': (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0'),
                'cwd': str((proc / 'cwd').resolve())}
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned():
    if not STATE.exists():
        return None
    expected = json.loads(STATE.read_text())
    current = process(expected['pid'])
    if not current:
        return None
    if current != expected or current['cwd'] != str(ROOT):
        raise RuntimeError('Lab process identity changed; refusing to control it')
    args = current['argv']
    if args[args.index('--port') + 1] != str(PORT) or args[args.index('--data-dir') + 1] != str(LAB / 'core-data'):
        raise RuntimeError('This process is not the session-import lab')
    return current


def daily():
    spec = importlib.util.spec_from_file_location('slice_lab', MAIN / 'scripts/slice-lab.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.daily_state()


def baseline():
    record = LAB / 'daily-baseline.json'
    if not record.exists():
        save(record, daily())


def verify_daily():
    before, after = json.loads((LAB / 'daily-baseline.json').read_text()), daily()
    identity = lambda state: [{k: v for k, v in p.items() if k != 'state'} for p in state['processes'] if p]
    report = {'sameDailyProcess': identity(before) == identity(after),
              'dailyAssetsUnchanged': before['webDist'] == after['webDist'],
              'health': after['health']}
    save(LAB / 'daily-verification.json', report)
    print(json.dumps(report, ensure_ascii=False))
    assert report['sameDailyProcess'] and report['dailyAssetsUnchanged']


def start():
    if owned():
        print(BASE)
        return
    baseline()
    binary = LAB / 'core-bin' / 'yuzuno-workspace'
    binary.parent.mkdir(exist_ok=True)
    # Keep a stable owned executable while Cargo can build the next candidate.
    import shutil
    shutil.copy2(TARGET / 'debug/yuzuno-workspace', binary)
    (LAB / 'task').mkdir(exist_ok=True)
    command = [str(binary), '--port', str(PORT), '--data-dir', str(LAB / 'core-data'),
               '--cwd', str(LAB / 'task'), '--web-dir', str(ROOT / 'web/dist')]
    with (LAB / 'core.log').open('ab') as log:
        child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    current = process(child.pid)
    if current is None:
        raise RuntimeError('Lab Core exited before startup')
    save(STATE, current)
    for _ in range(100):
        if not process(child.pid):
            raise RuntimeError('Lab Core exited; inspect core.log')
        try:
            assert api('/health')['application'] == 'yuzuno-next'
            print(BASE)
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError('Lab Core did not become ready')


def stop():
    current = owned()
    if not current:
        print('Owned lab is stopped')
        return
    # Lab prompts must be settled/closed explicitly before process teardown.
    active = [a for a in api('/workspace')['agents'] if not a.get('closedAt')
              and (a['status'] in ('working', 'waiting', 'uncertain') or a.get('pendingCount'))]
    if active:
        raise RuntimeError('Lab still has active/uncertain work; inspect before stopping')
    os.kill(current['pid'], signal.SIGINT)
    for _ in range(100):
        if process(current['pid']) is None:
            print('Stopped only owned session-import lab')
            return
        time.sleep(0.1)
    raise RuntimeError('Lab has not stopped; not escalating automatically')


def status():
    current = owned()
    print(json.dumps({'base': BASE, 'process': current,
                      'health': api('/health') if current else None}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('baseline', 'start', 'stop', 'status', 'verify-daily'))
    action = parser.parse_args().action
    {'baseline': baseline, 'start': start, 'stop': stop, 'status': status,
     'verify-daily': verify_daily}[action]()
