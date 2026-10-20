#!/usr/bin/env python3
"""Small systemd probe on the stopped, installed first-use lab; no model call.

Run directly after the browser Job finishes, never inside another managed Job.
It uses only that lab's Core/data and leaves the native Agent disconnected.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_lab import Lab, check_port_available, interrupt, sha256

TERMINAL = {'succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--first-use-report', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if 'YUZUNO_JOB_ID' in os.environ or 'yuzuno-job-' in Path('/proc/self/cgroup').read_text():
        parser.error('Run outside managed Jobs; nested systemd managers are not allowed')
    if not 1 <= args.port <= 65535 or args.report.exists() or args.report.is_symlink():
        parser.error('Choose a valid port and a new report path')
    prior = json.loads(args.first_use_report.read_text())
    if not prior.get('passed') or prior.get('workflow') != 'published release first use with existing login':
        parser.error('A successful first-use report is required')
    directory = Path(prior['lab']).resolve(strict=True)
    state = json.loads((directory / 'first-use-state.json').read_text())
    if state['workspaceId'] != prior['workspaceId']:
        parser.error('First-use state does not match the report')
    check_port_available(args.port)
    # Keep the real user's systemd bus location. Do not import CLI credentials,
    # Node paths or Core overrides, and never redirect HOME to a fake account.
    env = {k: os.environ[k] for k in ('HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if k in os.environ}
    env.update(PATH='/usr/local/bin:/usr/bin:/bin', LANG='C.UTF-8')
    os.environ.clear()
    os.environ.update(env)
    lab = Lab(SimpleNamespace(lab=directory, package_dir=directory / 'download', port=args.port))
    lab.release = prior['release']['tag']
    lab.signed = json.loads((directory / 'download/yuzuno-core-linux-x86_64.json').read_text())
    lab.report.update(workflow='installed Core local systemd smoke; native Agent stays disconnected',
                      firstUseReportSha256=sha256(args.first_use_report), release=prior['release'],
                      notTested=['Core as a service', 'fresh OS/account', 'remote Jobs', 'resource exhaustion'])
    lab.report['environment'].pop('mountInfo', None)
    job = None

    def api(path, body=None):
        return json.loads(lab.request('/api' + path, body))

    def terminal(job_id, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            value = api('/jobs/' + job_id)
            if value['status'] in TERMINAL:
                return value
            if value['status'] == 'unknown':
                raise RuntimeError('Job outcome unknown; no retry was submitted')
            time.sleep(.2)
        raise RuntimeError('Local Job did not finish; no retry was submitted')

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        release = lab.root / 'releases' / lab.release
        lab.check('downloaded descriptor retains verified digest',
                   sha256(directory / 'download/yuzuno-core-linux-x86_64.json') == prior['release']['descriptorSha256'])
        lab.check('installed manifest retains verified digest', sha256(release / 'manifest.json') == prior['release']['manifestSha256'])
        manifest = json.loads((release / 'manifest.json').read_text())
        lab.check('installed Core retains verified digest', sha256(release / 'bin/yuzuno-workspace') == manifest['files']['bin/yuzuno-workspace']['sha256'])
        lab.check('same isolated Workspace', lab.start('jobs-smoke') == state['workspaceId'])
        agent = api('/agents/' + state['agentId'])
        lab.check('native Agent stays disconnected before probe', agent['agent']['connectionState'] != 'connected')
        before = len(agent['turns'])
        api('/jobs/budget', {'cpuMillis': 600, 'memoryMiB': 192, 'swapMiB': 0})
        task = api('/collaboration/task_create', {'requestId': 't88-local-smoke-task',
                   'title': 'Isolated T88 smoke fixture', 'assigneeAgentId': state['agentId']})['task']
        job = api('/jobs', {'requestId': 't88-local-smoke-once', 'taskId': task['id'], 'agentId': state['agentId'],
                  'name': 'Published Core local Jobs probe', 'cwd': str(lab.project),
                  'argv': ['/usr/bin/python3', '-I', '-c', 'print("T88_LOCAL_JOB_OK")'],
                  'resources': {'cpuMillis': 500, 'memoryMiB': 128, 'swapMiB': 0},
                  'env': {}, 'guardGit': False, 'timeoutSeconds': 20})
        lab.report['jobId'] = job['id']
        job = terminal(job['id'])
        lab.report['job'] = job
        lab.check('local systemd Job succeeded', job['status'] == 'succeeded' and not job['reserved'])
        evidence = job['result']
        limits = evidence['started']['limits']
        quota, period = map(int, limits['cpu.max'].split())
        lab.check('effective cgroup limits match request', quota / period == .5
                   and limits['memory.max'] == str(128 * 1024 * 1024)
                   and limits['memory.swap.max'] == '0' and limits['pids.max'] == '512')
        log = api('/jobs/' + job['id'] + '/logs')
        lab.report['jobLog'] = log
        lab.check('command output is available through installed Core', 'T88_LOCAL_JOB_OK' in log['text'])
        agent = api('/agents/' + state['agentId'])
        lab.check('no extra native turn or reconnect', len(agent['turns']) == before
                   and agent['agent']['connectionState'] != 'connected')
        lab.stop('jobs-smoke')
        lab.report['passed'] = True
    except Exception as error:
        lab.report.update(passed=False, error=f'{type(error).__name__}: {error}')
        print(lab.report['error'], flush=True)
    finally:
        if job and job['status'] not in TERMINAL and lab.process:
            try:
                api('/jobs/' + job['id'] + '/cancel', {})
                lab.report['cleanupJob'] = terminal(job['id'])
            except Exception as error:
                lab.report['cleanupError'] = str(error)
        lab.stop('cleanup', cleanup=True)
        lab.report['finishedAt'] = time.time()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(lab.report, indent=2) + '\n')
    return 0 if lab.report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
