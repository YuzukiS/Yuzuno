#!/usr/bin/env python3
"""The functional smoke of one platform's release inputs, on the runner that
built them (YN-108 design 3.1): the release host is Linux and cannot run a
Mach-O. With the two binaries inputs.tar.gz carries, in a new folder of its
own, with its own HOME and ports, and no model, account or network service:
1. Core starts with new data and answers /api/health, and /api/updates says
   it runs on the inputs' platform.
2. The update helper installs an unsigned package of these inputs into a new
   managed root (`register --initialize`).
3. That root's Core starts and records how it started; then `updates/start
   start` starts it again, and `updates/start stop` stops it (on macOS since
   YN-108 M2b).
4. Each Core this smoke starts itself exits 0 after SIGTERM.
The package has a release ID of its own, is unsigned and never leaves the
machine. Prints one JSON line per step, and exits 1 if any step failed."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import digest, extract, inventory, read, verify_tree, write

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# macOS's limit for a Unix socket path; Core's control socket must fit.
SOCKET_PATH_MAX = 104


class Failed(Exception):
    pass


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def answer(port, path):
    """The JSON a Core answers on 127.0.0.1:port, or None for no answer."""
    try:
        with OPENER.open(f'http://127.0.0.1:{port}{path}', timeout=5) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def until(check, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.25)
    raise Failed(f'{what} within {timeout} s')


def healthy(port, check=lambda health: True):
    health = answer(port, '/api/health')
    if health and health.get('product') == 'yuzuno' and health.get('apiReady') and health.get('storageReady') and check(health):
        return health
    return None


class Core:
    """A Core this smoke starts itself, its output in a log."""

    def __init__(self, argv, log, env):
        self.log = Path(log)
        with self.log.open('wb') as out:
            self.process = subprocess.Popen(list(map(str, argv)), stdin=subprocess.DEVNULL, stdout=out,
                                            stderr=subprocess.STDOUT, env=env)

    def tail(self):
        return self.log.read_text(errors='replace')[-2000:]

    def ready(self, port, check=lambda health: True, timeout=60):
        def answered():
            if self.process.poll() is not None:
                raise Failed(f'Core exited ({self.process.returncode}) before it answered: {self.tail()}')
            return healthy(port, check)
        return until(answered, timeout, f'Core did not answer as expected on port {port}')

    def interrupt(self, timeout=30):
        """SIGTERM, as at logout or shutdown: Core shuts down and exits 0."""
        started = time.monotonic()
        self.process.send_signal(signal.SIGTERM)
        try:
            code = self.process.wait(timeout)
        except subprocess.TimeoutExpired:
            self.close()
            raise Failed(f'Core did not exit within {timeout} s of SIGTERM, so it was killed')
        if code != 0:
            raise Failed(f'Core exited {code} after SIGTERM: {self.tail()}')
        return {'exit': code, 'seconds': round(time.monotonic() - started, 1)}

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()


def helper_json(argv, env, timeout=180):
    """The one JSON line updates/start prints, whatever its exit status."""
    done = subprocess.run(list(map(str, argv)), capture_output=True, text=True, env=env, timeout=timeout)
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        outcome = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise Failed(f'{Path(argv[0]).name} {argv[1]} printed no result (exit {done.returncode}): {(done.stdout + done.stderr)[-2000:]}')
    return outcome, done.returncode


def package(inputs, bundle, build, current):
    """An unsigned local package of the inputs, laid out as
    tools/package-release.py lays out a release. Its platform, protocol,
    schema and record formats are the ones the Core under test reports."""
    release_id = 'smoke-' + build['source'][:12]
    parts = [('bin', 'bin'), ('licenses', 'licenses'), ('web', 'web'), ('claude', 'runtimes/claude'),
             ('result-validator', 'runtimes/result-validator'), ('windows-jobs', 'runtimes/windows-jobs')]
    for source, target in parts:
        if (inputs / source).is_dir():
            shutil.copytree(inputs / source, bundle / target)
    index = bundle / 'web/index.html'
    index.write_text(index.read_text().replace('</head>', f'<meta name="yuzuno-release" content="{release_id}">\n</head>', 1))
    for path in bundle.rglob('*'):
        if path.is_file():
            path.chmod(0o555 if path.stat().st_mode & 0o111 else 0o444)
    manifest = {
        'format': 1, 'releaseId': release_id, 'version': f'smoke {build["source"][:12]}',
        'gitSha': build['source'], 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'notes': 'An unsigned package of release inputs, for their smoke only; never published.',
        'platform': current['platform'], 'protocol': current['protocol'], 'schema': current['schema'],
        'records': current['records'], 'files': inventory(bundle)}
    path = bundle / 'manifest.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    path.chmod(0o444)
    return release_id, digest(path)


def stop_leftover(pid, executable):
    """A Core `updates/start start` started and its stop did not end: only
    if that process still runs this installation's Core."""
    shown = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
    if not shown.startswith(str(executable)):
        return
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.25)
    os.kill(pid, signal.SIGKILL)


def remove(root):
    """The smoke's folder, read-only release files and folders included."""
    for folder, _, _ in os.walk(root):
        os.chmod(folder, 0o700)
    shutil.rmtree(root, ignore_errors=True)


def smoke(product, base):
    build = read(product / 'build.json')
    root = Path(tempfile.mkdtemp(prefix='ys-', dir=base)).resolve()
    managed = root / 'm'
    if len(str(managed / 'updates/control.sock').encode()) >= SOCKET_PATH_MAX:
        raise Failed(f'{root} is too long a folder for Core\'s control socket; use a shorter RUNNER_TEMP')
    for name in ('home', 't', 'work'):
        (root / name).mkdir()
    # Nothing of the runner's own environment: a HOME and TMPDIR of its own,
    # so no Core here reads or writes the user's folders.
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(root / 'home'), 'TMPDIR': str(root / 't')}
    steps, interrupts, cores, leftover = [], [], [], []
    state = {}

    def step(number, name, action):
        try:
            steps.append({'step': number, 'name': name, 'ok': True, **(action() or {})})
        except Exception as error:
            steps.append({'step': number, 'name': name, 'ok': False, 'error': f'{type(error).__name__}: {error}'})
        print(json.dumps(steps[-1]), flush=True)
        return steps[-1]['ok']

    def interrupt(core, which):
        try:
            interrupts.append({'core': which, **core.interrupt()})
        except Failed as error:
            interrupts.append({'core': which, 'error': str(error)})

    def first():
        inputs = root / 'inputs'
        extract(product / 'inputs.tar.gz', inputs)
        verify_tree(inputs, build['files'])
        state['inputs'] = inputs
        port = free_port()
        core = Core([inputs / 'bin/yuzuno-workspace', '--port', port, '--data-dir', root / 'd1', '--cwd', root / 'work',
                     '--codex', root / 'no-codex', '--web-dir', inputs / 'web'], root / 'core-1.log', env)
        cores.append(core)
        try:
            health = core.ready(port)
            updates = answer(port, '/api/updates') or {}
            current = updates.get('current') or {}
            if current.get('platform') != build['platform']:
                raise Failed(f'/api/updates says platform {current.get("platform")!r}, not {build["platform"]!r}')
            state['current'] = current
            return {'platform': current['platform'], 'releaseId': health.get('releaseId')}
        finally:
            interrupt(core, 'inputs')

    def second():
        if 'current' not in state:
            raise Failed('not run: step 1 failed')
        bundle = root / 'bundle'
        release_id, manifest_sha256 = package(state['inputs'], bundle, build, state['current'])
        done = subprocess.run([str(bundle / 'bin/yuzuno-update-helper'), 'register', '--install-dir', str(managed),
                               '--bundle', str(bundle), '--manifest-sha256', manifest_sha256,
                               '--reviewed-source', f'release-inputs smoke: unsigned package of {build["source"]}',
                               '--initialize'], capture_output=True, text=True, env=env, timeout=120)
        if done.returncode:
            raise Failed(f'register --initialize exited {done.returncode}: {(done.stdout + done.stderr)[-2000:]}')
        current = read(managed / 'current.json')
        if current.get('releaseId') != release_id or current.get('manifestSha256') != manifest_sha256:
            raise Failed(f'current.json names {current}, not {release_id}')
        state['release'] = release_id
        return {'releaseId': release_id, 'manifestSha256': manifest_sha256}

    def third():
        if 'release' not in state:
            raise Failed('not run: step 2 failed')
        executable = managed / 'releases' / state['release'] / 'bin/yuzuno-workspace'
        port = free_port()
        core = Core([executable, '--install-dir', managed, '--data-dir', root / 'd2', '--port', port,
                     '--cwd', root / 'work', '--codex', root / 'no-codex'], root / 'core-2.log', env)
        cores.append(core)
        try:
            health = core.ready(port, lambda health: health.get('releaseId') == state['release'])
            workspace = health['workspaceId']
            entry = managed / 'updates/start'
            until(lambda: (managed / 'updates/launch.json').is_file() and entry.is_symlink(), 30,
                  'Core did not record how it started')
        finally:
            interrupt(core, 'managed')
        if 'error' in interrupts[-1]:
            raise Failed('not run: the managed Core did not stop')
        common = ['--install-dir', managed, '--port', port, '--workspace-id', workspace]
        started, code = helper_json([entry, 'start', *common], env)
        if code or started.get('state') not in ('started', 'starting'):
            raise Failed(f'updates/start start (exit {code}): {started}')
        if started.get('pid'):
            leftover.append((started['pid'], executable))
        until(lambda: healthy(port, lambda health: health.get('workspaceId') == workspace), 60,
              'the Core updates/start started did not answer')
        stopped, code = helper_json([entry, 'stop', *common], env)
        if code or stopped.get('state') != 'stopped':
            raise Failed(f'updates/start stop (exit {code}): {stopped}')
        until(lambda: answer(port, '/api/health') is None, 30, 'Core still answered after its stop')
        leftover.clear()
        return {'start': started.get('state'), 'stop': stopped.get('state')}

    def fourth():
        failed = [item for item in interrupts if 'error' in item]
        if not interrupts or failed:
            raise Failed(f'{failed or "no Core started"}')
        return {'cores': interrupts}

    try:
        step(1, 'health and platform', first)
        step(2, 'register --initialize', second)
        step(3, 'updates/start start and stop', third)
        step(4, 'exit 0 after SIGTERM', fourth)
    finally:
        for core in cores:
            core.close()
        for pid, executable in leftover:
            stop_leftover(pid, executable)
        remove(root)
    return {'platform': build['platform'], 'source': build['source'], 'steps': steps}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('product', type=Path, help='The directory with build.json and inputs.tar.gz')
    parser.add_argument('--report', type=Path, help='Also write the steps to this new JSON file')
    args = parser.parse_args()
    report = smoke(args.product.resolve(), os.environ.get('RUNNER_TEMP'))
    if args.report:
        write(args.report, report)
    sys.exit(0 if all(item['ok'] for item in report['steps']) else 1)
