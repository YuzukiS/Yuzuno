#!/usr/bin/env python3
"""A service command ended by a signal its wrapper cannot raise again, or by
one systemd counts as a clean end, is still a crash (T-14, review R7): on an
isolated Core with real systemd Jobs, as check.py.

The command is really ended by the signal. The kernel sends SIGPIPE on a
write to a closed pipe and SIGXFSZ past the file size limit; the command
sends itself SIGTERM, and SIGSEGV as the control. Python, and so the host's
wrapper, ignores SIGPIPE and SIGXFSZ, so the wrapper exits with the code
instead of raising them; systemd counts a wrapper ended by SIGTERM as a clean
end. Each scenario expects one retry after 30 s with the run's end time,
counted as started only once its command runs, and nothing after a Stop.

Build core/examples/local_jobs_lab first (T14_LAB_BINARY, as for check.py).
Every scenario runs and is reported (T14_SIGNALS_REPORT); the exit status is
non-zero if any failed.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

import check as lab

MODES = '''if mode[0] == 'pipe':
    time.sleep(float(mode[1])); signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    r, w = os.pipe(); os.close(r); os.write(w, b'x')
if mode[0] == 'xfsz':
    import resource
    time.sleep(float(mode[1])); signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
    resource.setrlimit(resource.RLIMIT_FSIZE, (4096, resource.getrlimit(resource.RLIMIT_FSIZE)[1]))
    big = open(os.path.join(here, 'big.bin'), 'wb', buffering=0)
    while True:
        big.write(b'x' * 65536)
if mode[0] == 'term':
    time.sleep(float(mode[1])); os.kill(os.getpid(), signal.SIGTERM)
'''
lab.APP = lab.APP.replace('while True:\n    time.sleep(60)', MODES + 'while True:\n    time.sleep(60)')
assert MODES in lab.APP
# mode, signal number, the wrapper's end systemd should show (None: not asserted).
SCENARIOS = [('pipe', 13, 'SIGPIPE', ('exit-code', '1', '243')),
             ('xfsz', 25, 'SIGXFSZ', ('exit-code', '1', '231')),
             ('term', 15, 'SIGTERM', None),
             ('segv', 11, 'SIGSEGV', None)]
REPORT = {'passed': False, 'scenarios': {}, 'fixture': lab.REPORT['fixture'], 'binary': str(lab.BINARY)}
REPORT_PATH = Path(os.environ.get('T14_SIGNALS_REPORT', lab.LAB / 'signals-report.json'))


def manager(evidence):
    systemd = evidence.get('systemd') or {}
    return (systemd.get('Result'), systemd.get('ExecMainCode'), systemd.get('ExecMainStatus'))


def crashed(entry, name, number, expected):
    """The run ended by its command's signal: one retry, waiting."""
    root = entry['root']
    view = entry['lab'].until(lambda v: lab.recovery(v)['state'] in ('waiting', 'halted', 'ended'), 60)
    ended = lab.terminal(root, 30)
    evidence = ended['result']['evidence']
    command = evidence.get('command') or {}
    entry['report'].update({'rootStatus': ended['status'], 'command': command, 'manager': manager(evidence),
                            'recovery': {k: lab.recovery(view).get(k) for k in ('state', 'haltedReason', 'retry', 'lastFailure')}})
    assert (command.get('attempt'), command.get('exitCode')) == (ended['attempt'], -number), command
    if expected:
        assert manager(evidence) == expected, manager(evidence)
    recovery = lab.recovery(view)
    assert recovery['state'] == 'waiting', recovery
    assert recovery['retry'] == {'scheduled': 1, 'started': 0, 'max': 3}, recovery['retry']
    failure = recovery['lastFailure']
    assert failure['kind'] == 'signal' and failure['signal'] == name or (name == 'SIGSEGV' and failure['kind'] == 'core_dump'), failure
    retry = view['job']['jobId']
    queued = lab.job(retry)
    assert ended['retriedBy'] == retry and queued['retryOf'] == root and queued['recoveryOf']['retry'] == 1, queued
    assert queued['status'] == 'queued' and abs(queued['deadlineAtUnix'] - entry['deadline']) < 0.01, \
        (queued['status'], queued['deadlineAtUnix'], entry['deadline'])
    delay = lab.epoch(recovery['notBefore']) - lab.epoch(ended['finishedAt'])
    assert 25 <= delay <= 35, delay
    entry.update({'retry': retry, 'view': view})


def ran(entry):
    """The retry starts after its delay and counts as started once its command does."""
    retry = entry['retry']
    view = entry['lab'].until(lambda v: v['job']['jobId'] == retry and lab.recovery(v)['launch'] == 'running'
                              and lab.recovery(v)['retry']['started'] == 1, 60)
    recovery = lab.recovery(view)
    assert recovery['state'] == 'retry' and recovery['retry'] == {'scheduled': 1, 'started': 1, 'max': 3}, recovery
    assert abs(lab.epoch(recovery['deadlineAt']) - entry['deadline']) < 0.01, (recovery['deadlineAt'], entry['deadline'])
    entry['running'] = view


def stopped(entry):
    """Stop ends it; nothing follows."""
    receipt = entry['lab'].stop(entry['running'])
    assert receipt['jobId'] == entry['retry'], receipt
    ended = lab.terminal(entry['retry'], 30)
    time.sleep(2)
    view = entry['lab'].view()
    assert lab.recovery(view)['haltedReason'] == 'user_stop' and view['job']['jobId'] == entry['retry'], lab.recovery(view)
    assert ended.get('retriedBy') is None
    entry['report']['retryStatus'] = ended['status']


def step(entry, name, run):
    if entry['report'].get('failed'):
        return
    try:
        run(entry)
        entry['report'].setdefault('passedSteps', []).append(name)
    except Exception as error:
        entry['report']['failed'] = {'step': name, 'error': repr(error)[:1500], 'trace': traceback.format_exc()[-1500:]}


def cleanup():
    """Every lab unit stopped and verified exited, as check.py does."""
    failures, units = [], []
    for spec in (lab.LAB / 'data/jobs').glob('*/spec.json'):
        saved = json.loads(spec.read_text())
        for key in ('supervisorUnit', 'unit'):
            unit = saved.get(key)
            if not unit:
                continue
            try:
                subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=8, check=False)
                shown = subprocess.run(['systemctl', '--user', 'show', unit, '--property=LoadState', '--property=ActiveState',
                                        '--property=MainPID', '--property=ControlGroup'],
                                       capture_output=True, text=True, timeout=8, check=False)
                properties = dict(line.split('=', 1) for line in shown.stdout.splitlines() if '=' in line)
                processes = []
                if properties.get('ControlGroup'):
                    for members in (Path('/sys/fs/cgroup') / properties['ControlGroup'].lstrip('/')).rglob('cgroup.procs'):
                        try:
                            processes.extend(members.read_text().split())
                        except FileNotFoundError:
                            pass
                gone = properties.get('LoadState') == 'not-found'
                inactive = properties.get('ActiveState') in ('inactive', 'failed') and properties.get('MainPID') == '0'
                verified = (gone or (shown.returncode == 0 and inactive)) and not processes
                units.append({'unit': unit, 'verifiedExited': verified})
                if not verified:
                    failures.append(unit)
                subprocess.run(['systemctl', '--user', 'reset-failed', unit], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=8, check=False)
            except subprocess.TimeoutExpired:
                failures.append(unit)
    return units, failures


def main():
    assert lab.BINARY.is_file(), 'Build local_jobs_lab or set T14_LAB_BINARY to its copied binary'
    lab.LAB.mkdir(parents=True, mode=0o700)
    lab.PORT = lab.available_port(4600, 4700)
    print(str(lab.LAB), flush=True)
    entries = []
    try:
        lab.start_core()
        lab.request('/jobs/budget', {'cpuMillis': 2400, 'memoryMiB': 1280, 'swapMiB': 0})
        for mode, number, name, expected in SCENARIOS:
            entry = {'name': name, 'report': REPORT['scenarios'].setdefault(name, {})}
            try:
                service = lab.Lab('Signal ' + name)
                service.mode(mode + ' 2')
                entry['lab'] = service
                entry['root'] = service.start(service.view(), 900, bounded=True)['jobId']
                entry['deadline'] = lab.epoch(service.until(lambda v: lab.recovery(v)['deadlineAt'] is not None, 30)
                                              ['lifecycle']['recovery']['deadlineAt'])
            except Exception as error:
                entry['report']['failed'] = {'step': 'start', 'error': repr(error)[:1500]}
            entries.append(entry)
            # Its crash, then the server for the retry that follows 30 s later.
            step(entry, 'crash', lambda e: crashed(e, name, number, expected))
            if not entry['report'].get('failed'):
                service.mode('serve')
        for entry in entries:
            step(entry, 'retry runs', ran)
        for entry in entries:
            step(entry, 'stop', stopped)
        for entry in entries:
            entry['report']['passed'] = not entry['report'].get('failed')
            print(('PASS ' if entry['report']['passed'] else 'FAIL ') + entry['name'], flush=True)
        REPORT['passed'] = all(e['report']['passed'] for e in entries) and len(entries) == len(SCENARIOS)
    finally:
        lab.stop_core()
        units, failures = cleanup()
        REPORT.update({'cleanup': units, 'cleanupFailures': failures, 'lab': str(lab.LAB), 'jobs': lab.REPORT['jobs']})
        if failures:
            REPORT['passed'] = False
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(str(REPORT_PATH), flush=True)
    raise SystemExit(0 if REPORT['passed'] else 1)


if __name__ == '__main__':
    main()
