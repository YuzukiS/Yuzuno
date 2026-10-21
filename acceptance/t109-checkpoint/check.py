#!/usr/bin/env python3
"""Stop at a checkpoint and resume, through the real Jobs host helper (T-109).

Builds attempt folders the way Core does and launches host.py's collector as
host.rs does (as acceptance/job-pause/host_pause_check.py does for pause), so
the worker unit, its wrapper's signal forwarding and its checkpoint check are
the real ones. Unit names are t109-check-<run>-*, so no Core job is touched.
The command is train.py: Lightning 2.5.0 on CPU, in the environment
setup.sh made. No Core, no GPU.

  stop-resume  train, stop at a checkpoint (asked twice), verify it, check
               the attempt's processes and memory are gone, then resume it
               as a new attempt: model, optimizer, scheduler and global step
               continue from the checkpoint, and the final weights equal an
               uninterrupted run's
  tampered     a checkpoint file changed after it was verified: the resumed
               attempt is rejected before training, not started from scratch
  wrong-code   the command saves but exits another code than the declared
               one: not resumable, and says why

Usage: check.py PYTHON OUT_DIR [scenario...]
  PYTHON   the environment's interpreter (setup.sh ENV_DIR → ENV_DIR/bin/python)
"""
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST = (HERE.parents[1] / 'core' / 'src' / 'jobs' / 'host.py').resolve()
TRAIN = HERE / 'train.py'
RUN = uuid.uuid4().hex[:8]
UNITS = []
CHECKS = []
STEPS = 600
DECLARED = {'signal': 'SIGTERM', 'graceSeconds': 60, 'stoppedExitCode': 75}


def check(name, ok, detail=None):
    CHECKS.append({'check': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  {json.dumps(detail, default=str)[:800]}'), flush=True)


def helper(mode, spec_path, timeout=60):
    done = subprocess.run(['/usr/bin/python3', str(HOST), mode, str(spec_path)],
                          capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise RuntimeError(f'{mode} failed: {done.stderr[-1500:]}')
    return json.loads(done.stdout) if done.stdout.strip() else None


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def show(unit, props='ActiveState,SubState,Result,MainPID,ControlGroup,MemoryCurrent'):
    out = subprocess.run(['systemctl', '--user', 'show', unit, '--property=' + props],
                         capture_output=True, text=True).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def launch(out, python, name, work, argv_tail, checkpoint=DECLARED, source=None):
    """An attempt folder and its collector, as host.rs launch() makes them."""
    job, attempt = str(uuid.uuid4()), str(uuid.uuid4())
    folder = out / 'jobs' / job
    folder.mkdir(parents=True)
    work.mkdir(parents=True, exist_ok=True)
    spec = {'id': job, 'attempt': attempt, 'bootId': boot_id(), 'unit': f't109-check-{RUN}-{name}.service',
            'supervisorUnit': f't109-check-{RUN}-{name}-collector.service',
            'timeoutSeconds': 900, 'cwd': str(work), 'guardGit': False, 'inputs': [],
            'resources': {'memoryMiB': 2048, 'swapMiB': 0, 'cpuMillis': 1000},
            'argv': [python, str(TRAIN)] + argv_tail, 'env': {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}}
    if checkpoint:
        spec['checkpoint'] = checkpoint
    if source:
        spec['checkpointFrom'] = source
    snap = subprocess.run(['/usr/bin/python3', str(HOST), 'snapshot'], input=json.dumps(spec),
                          capture_output=True, text=True, check=True)
    spec['snapshot'] = json.loads(snap.stdout)
    path = folder / 'spec.json'
    path.write_text(json.dumps(spec))
    (folder / 'dispatched.json').write_text(json.dumps({'jobId': job, 'attempt': attempt, 'bootId': spec['bootId']}))
    UNITS.extend([spec['unit'], spec['supervisorUnit']])
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--service-type=exec', '--expand-environment=no',
                    '--unit=' + spec['supervisorUnit'], '-p', 'Description=Yuzuno job ' + attempt,
                    '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=10%', '-p', 'TasksMax=16',
                    '-p', 'Restart=no', '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s',
                    '-p', 'StandardOutput=null', '-p', 'StandardError=null',
                    '-p', f'RuntimeMaxSec={spec["timeoutSeconds"] + 60}s',
                    '--', '/usr/bin/python3', str(HOST), 'supervise', str(path)], check=True)
    return spec, path, folder


def steps_done(folder):
    try:
        return json.loads((folder / 'progress.json').read_text())['done']
    except (OSError, ValueError, KeyError):
        return -1


def wait_for(fn, seconds, every=0.2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    return None


def settled(path):
    """The outcome once host.py says every group of the attempt is empty."""
    return wait_for(lambda: (lambda r: r if r.get('status') not in ('settling', 'unresolved') else None)(helper('reconcile', path)), 60, 0.5)


def log_text(folder):
    return b''.join((folder / f'log-{i}.bin').read_bytes()[8:] for i in range(2)
                    if (folder / f'log-{i}.bin').exists()).decode(errors='replace')


def inspect(python, ckpt):
    """What the checkpoint file holds, read with the environment's torch."""
    code = """
import hashlib, json, sys, torch
c = torch.load(sys.argv[1], map_location='cpu', weights_only=False)
def digest(ts):
    h = hashlib.sha256()
    for t in ts: h.update(t.contiguous().numpy().tobytes())
    return h.hexdigest()
params = ['net.0.weight', 'net.0.bias', 'net.2.weight', 'net.2.bias']
state = c['optimizer_states'][0]['state']
print(json.dumps({'globalStep': c['global_step'], 'weights': digest([c['state_dict'][k] for k in params]),
  'optimizer': digest([state[k][n] for k in sorted(state) for n in sorted(state[k]) if torch.is_tensor(state[k][n])]),
  'momentumBuffers': sum('momentum_buffer' in s for s in state.values()),
  'schedulerLastEpoch': c['lr_schedulers'][0]['last_epoch'], 'lightning': c.get('pytorch-lightning_version')}))
"""
    done = subprocess.run([python, '-c', code, str(ckpt)], capture_output=True, text=True, timeout=120)
    if done.returncode:
        raise RuntimeError(done.stderr[-1500:])
    return json.loads(done.stdout)


def read(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


STATE = {}


def stop_resume(out, python):
    work = out / 'project'
    spec, path, folder = launch(out, python, 'a', work, [str(out / 'a'), '--max-steps', str(STEPS), '--step-sleep', '0.02'])
    check('the first attempt trains past step 100', wait_for(lambda: steps_done(folder) >= 100, 180), steps_done(folder))
    first = helper('checkpoint', path)
    again = helper('checkpoint', path)
    check('the stop reaches the wrapper', first['delivered'] is True, first)
    check('a repeated stop keeps the first request and its nonce', again['request'] == first['request'], again)
    result = wait_for(lambda: read(folder / 'result.json'), 120)
    checked = (result or {}).get('checkpoint') or {}
    check('the attempt ends cancelled at a verified checkpoint', result and result['status'] == 'cancelled'
          and checked.get('ok') is True and result['reason'].startswith("Stopped at the user's request"), result)
    exited = read(folder / 'checkpoint-exit.json')
    check("the wrapper recorded the command's exit before checking its files",
          exited and exited['exitCode'] == 75 and exited['at'] <= checked.get('checkedAt', 0), {'exit': exited, 'checkedAt': checked.get('checkedAt')})
    forwarded = read(folder / 'checkpoint-forward.json')
    check('the wrapper forwarded SIGTERM to the command once', forwarded and forwarded.get('signal') == 'SIGTERM', forwarded)
    final = settled(path)
    unit = show(spec['unit'])
    check('nothing of the attempt is left: its groups are empty, so its memory is freed',
          final and final['status'] == 'cancelled' and unit.get('MainPID') in ('0', None)
          and unit.get('MemoryCurrent') in ('[not set]', None, ''), {'final': (final or {}).get('status'), 'unit': unit})
    files = checked.get('files') or []
    check('the checkpoint is the one file the manifest names, with its SHA-256',
          [f['path'] for f in files] == ['on_exception.ckpt'] and len(files[0].get('sha256', '')) == 64, files)
    held = inspect(python, Path(checked['dir']) / 'on_exception.ckpt')
    stopped = read(Path(checked['dir']) / 'manifest.json')['progress']['globalStep']
    check('the checkpoint holds the model, the optimizer momentum and the scheduler at the stopped step',
          held['globalStep'] == stopped and 100 <= stopped < STEPS and held['momentumBuffers'] == 4
          and held['schedulerLastEpoch'] == stopped and held['lightning'] == '2.5.0', {'held': held, 'stopped': stopped})
    source = {'jobId': spec['id'], 'attempt': spec['attempt'], 'dir': checked['dir'],
              'manifestSha256': checked['manifestSha256'], 'files': files}
    spec_b, path_b, folder_b = launch(out, python, 'b', work, [str(out / 'b'), '--max-steps', str(STEPS)], source=source)
    result_b = wait_for(lambda: read(folder_b / 'result.json'), 300)
    check('the resumed attempt is a new attempt and finishes', result_b and result_b['status'] == 'succeeded'
          and spec_b['attempt'] != spec['attempt'], result_b)
    start, end = read(out / 'b' / 'start.json'), read(out / 'b' / 'final.json')
    check('it starts from the checkpoint: same weights, optimizer state, scheduler and global step',
          start and all(start[k] == held[k] for k in ('globalStep', 'weights', 'optimizer', 'schedulerLastEpoch')),
          {'start': start, 'held': held})
    check('it continues to the last step', end and end['globalStep'] == STEPS, end)
    check('its log says it resumed, not that it started from scratch', 'start: resume from' in log_text(folder_b), log_text(folder_b)[-400:])
    check("the first attempt's folder and checkpoint are kept", (folder / 'result.json').exists()
          and (Path(checked['dir']) / 'on_exception.ckpt').exists())
    spec_c, path_c, folder_c = launch(out, python, 'c', out / 'reference', [str(out / 'c'), '--max-steps', str(STEPS)], checkpoint=None)
    result_c = wait_for(lambda: read(folder_c / 'result.json'), 300)
    reference = read(out / 'c' / 'final.json')
    check('the final weights equal an uninterrupted run of the same steps (this example: CPU, one thread, step-seeded data)',
          result_c and result_c['status'] == 'succeeded' and reference and end
          and reference['weights'] == end['weights'] and reference['optimizer'] == end['optimizer'],
          {'resumed': end, 'uninterrupted': reference})
    STATE['source'], STATE['work'] = source, work


def tampered(out, python):
    source = STATE.get('source')
    if not source:
        check('tampered: needs stop-resume first', False)
        return
    ckpt = Path(source['dir']) / 'on_exception.ckpt'
    with ckpt.open('ab') as f:
        f.write(b'\0')
    spec, path, folder = launch(out, python, 'd', STATE['work'], [str(out / 'd'), '--max-steps', str(STEPS)], source=source)
    result = wait_for(lambda: read(folder / 'result.json'), 120)
    check('a resume from a changed checkpoint is rejected before the command starts',
          result and result['status'] == 'rejected' and 'changed' in (result['reason'] or ''), result)
    check('nothing trained from scratch', not (out / 'd' / 'start.json').exists() and 'start:' not in log_text(folder))


def wrong_code(out, python):
    declared = dict(DECLARED, stoppedExitCode=76)
    spec, path, folder = launch(out, python, 'e', out / 'project-e', [str(out / 'e'), '--max-steps', str(STEPS), '--step-sleep', '0.02'],
                                checkpoint=declared)
    check('wrong-code: trains past step 50', wait_for(lambda: steps_done(folder) >= 50, 180), steps_done(folder))
    helper('checkpoint', path)
    result = wait_for(lambda: read(folder / 'result.json'), 120)
    checked = (result or {}).get('checkpoint') or {}
    check('a stop that exits another code than declared is not resumable and says why',
          result and checked.get('ok') is False and 'not the declared stopped code 76' in (checked.get('reason') or ''), result)


def cleanup():
    for unit in UNITS:
        if show(unit, 'LoadState').get('LoadState') == 'not-found':
            continue
        subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True)
        subprocess.run(['systemctl', '--user', 'reset-failed', unit], capture_output=True)


def main():
    python = str(Path(sys.argv[1]).absolute())
    out = Path(sys.argv[2]).resolve() / RUN
    out.mkdir(parents=True)
    scenarios = {'stop-resume': stop_resume, 'tampered': tampered, 'wrong-code': wrong_code}
    chosen = sys.argv[3:] or list(scenarios)
    try:
        for name in chosen:
            try:
                scenarios[name](out, python)
            except Exception as error:
                check(f'{name} ran to completion', False, repr(error))
    finally:
        cleanup()
    report = {'run': RUN, 'host': str(HOST), 'checks': CHECKS,
              'passed': sum(c['ok'] for c in CHECKS), 'total': len(CHECKS)}
    (out / 'report.json').write_text(json.dumps(report, indent=1, default=str))
    print(f"{report['passed']}/{report['total']} passed; {out / 'report.json'}")
    sys.exit(0 if report['passed'] == report['total'] else 1)


if __name__ == '__main__':
    main()
