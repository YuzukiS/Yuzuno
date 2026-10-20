#!/usr/bin/env python3
"""A resumed Job left queued for an older Core is rejected, not run from scratch (T-109).

A Core from before checkpoints does not know `checkpointFrom`: its wrapper
would start the command without $YUZUNO_RESUME_FROM, so a training would
begin again from step 0. The resumed Job's snapshot carries `resumeFrom`,
which only a wrapper that knows checkpoints computes; an older wrapper finds
its own snapshot different and rejects the attempt before the command starts.

This runs both wrappers on the same synthetic queue, each attempt in real
systemd user units named t109-older-<run>-*, as host.rs launches them. No
Core, no training; the command only records what it was given.

  resumed  a resumed Job: the older wrapper rejects it and never starts the
           command; this one starts it with $YUZUNO_RESUME_FROM
  plain    a Job without checkpointFrom, queued by either Core: both
           wrappers run it, so moving between the two Cores is not blocked

Usage: older_core_check.py OLDER_HOST_PY OUT_DIR
  OLDER_HOST_PY  core/src/jobs/host.py of the older release (for example the
                 one 2026.10.19-core.12 was built from)
"""
import hashlib
import importlib.util
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW = (HERE.parents[1] / 'core' / 'src' / 'jobs' / 'host.py').resolve()
RUN = uuid.uuid4().hex[:8]
UNITS = []
CHECKS = []
# Records what the command was given, then exits 0.
COMMAND = ("import json, os, sys; json.dump({'resumeFrom': os.environ.get('YUZUNO_RESUME_FROM')}, "
           "open(sys.argv[1], 'w'))")


def check(name, ok, detail=None):
    CHECKS.append({'check': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  {json.dumps(detail, default=str)[:800]}'), flush=True)


def module(path):
    spec = importlib.util.spec_from_file_location('job_host_' + uuid.uuid4().hex[:6], path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def job(out, name, source=None):
    """A queued Job as Core records it, before any wrapper sees it."""
    work = out / 'work'
    work.mkdir(parents=True, exist_ok=True)
    spec = {'id': str(uuid.uuid4()), 'attempt': str(uuid.uuid4()), 'bootId': boot_id(),
            'timeoutSeconds': 120, 'cwd': str(work), 'guardGit': False, 'inputs': [],
            'resources': {'memoryMiB': 128, 'swapMiB': 0, 'cpuMillis': 200},
            'argv': ['/usr/bin/python3', '-c', COMMAND, str(out / f'{name}.seen.json')],
            'env': {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}}
    if source:
        spec['checkpoint'] = {'signal': 'SIGTERM', 'graceSeconds': 60, 'stoppedExitCode': 75}
        spec['checkpointFrom'] = source
    return spec


def launch(out, host, name, spec):
    """The attempt folder and its collector, as host.rs launch() makes them."""
    spec = {**spec, 'unit': f't109-older-{RUN}-{name}.service', 'supervisorUnit': f't109-older-{RUN}-{name}-collector.service'}
    folder = out / 'jobs' / spec['id'] / name
    folder.mkdir(parents=True)
    path = folder / 'spec.json'
    path.write_text(json.dumps(spec))
    (folder / 'dispatched.json').write_text(json.dumps({'jobId': spec['id'], 'attempt': spec['attempt'], 'bootId': spec['bootId']}))
    UNITS.extend([spec['unit'], spec['supervisorUnit']])
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--service-type=exec', '--expand-environment=no',
                    '--unit=' + spec['supervisorUnit'], '-p', 'Description=Yuzuno job ' + spec['attempt'],
                    '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=10%', '-p', 'TasksMax=16',
                    '-p', 'Restart=no', '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s',
                    '-p', 'StandardOutput=null', '-p', 'StandardError=null', '-p', 'RuntimeMaxSec=180s',
                    '--', '/usr/bin/python3', str(host), 'supervise', str(path)], check=True)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if (folder / 'result.json').exists():
            return json.loads((folder / 'result.json').read_text()), folder
        time.sleep(0.2)
    return None, folder


def checkpoint(out, new):
    """A checkpoint as the new wrapper verified it when its attempt stopped."""
    base = out / 'checkpoint'
    base.mkdir(parents=True)
    (base / 'model.ckpt').write_bytes(b'weights')
    raw = json.dumps({'attempt': 'attempt-0', 'nonce': 'n', 'files': [{'path': 'model.ckpt'}]}).encode()
    (base / 'manifest.json').write_bytes(raw)
    files, problem = new.checkpoint_files(base, json.loads(raw))
    assert not problem, problem
    return {'jobId': str(uuid.uuid4()), 'attempt': 'attempt-0', 'dir': str(base),
            'manifestSha256': hashlib.sha256(raw).hexdigest(), 'files': files}


def resumed(out, older, new, older_path):
    spec = job(out, 'resumed', checkpoint(out, new))
    # Core records the snapshot at the resume, through the wrapper of its own release.
    spec['snapshot'] = new.snapshot(spec)
    check('the resumed Job records which checkpoint it resumes from', 'resumeFrom' in spec['snapshot'], spec['snapshot'])
    result, folder = launch(out, older_path, 'resumed-by-older', spec)
    check('the older wrapper rejects it', result and result['status'] == 'rejected', result)
    check('saying its guarded inputs changed and that the command was not started',
          result and 'command was not started' in (result.get('reason') or ''), (result or {}).get('reason'))
    check('the command never ran', not (out / 'resumed.seen.json').exists())
    again = {**spec, 'attempt': str(uuid.uuid4())}
    result, folder = launch(out, NEW, 'resumed-by-new', again)
    seen = json.loads((out / 'resumed.seen.json').read_text()) if (out / 'resumed.seen.json').exists() else None
    check('this wrapper starts the same Job and tells it where it resumes from',
          result and result['status'] == 'succeeded' and seen
          and seen['resumeFrom'] == str(Path(spec['checkpointFrom']['dir']) / 'manifest.json'), {'result': result, 'seen': seen})


def plain(out, older, new, older_path):
    for queued_by, by in (('older', older), ('new', new)):
        for run_by, path in (('older', older_path), ('new', NEW)):
            name = f'plain-{queued_by}-{run_by}'
            spec = job(out, name)
            spec['snapshot'] = by.snapshot(spec)
            result, _ = launch(out, path, name, spec)
            check(f'a Job without a checkpoint, queued by the {queued_by} Core, runs under the {run_by} one',
                  result and result['status'] == 'succeeded' and (out / f'{name}.seen.json').exists(), result)


def cleanup():
    for unit in UNITS:
        subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True)
        subprocess.run(['systemctl', '--user', 'reset-failed', unit], capture_output=True)


def main():
    older_path = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve() / RUN
    out.mkdir(parents=True)
    older, new = module(older_path), module(NEW)
    try:
        for scenario in (resumed, plain):
            try:
                scenario(out, older, new, older_path)
            except Exception as error:
                check(f'{scenario.__name__} ran to completion', False, repr(error))
    finally:
        cleanup()
    report = {'run': RUN, 'older': str(older_path), 'olderSha256': hashlib.sha256(older_path.read_bytes()).hexdigest(),
              'new': str(NEW), 'checks': CHECKS, 'passed': sum(c['ok'] for c in CHECKS), 'total': len(CHECKS)}
    (out / 'report.json').write_text(json.dumps(report, indent=1, default=str))
    print(f"{report['passed']}/{report['total']} passed; {out / 'report.json'}")
    sys.exit(0 if report['passed'] == report['total'] else 1)


if __name__ == '__main__':
    main()
