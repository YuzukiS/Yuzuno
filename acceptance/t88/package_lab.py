#!/usr/bin/env python3
"""Offline signed-package install/restart/reinstall checks; no runtime login."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import socket
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request


class LabInterrupted(Exception):
    """Cancellation must escape retries that catch network/OS failures."""


def interrupt(signum, _frame):
    raise LabInterrupted(f'signal {signum}')


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def extract_bundle(archive, destination):
    """No links or special files: the release format contains regular files."""
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError(f'Unsafe bundle member: {member.name}')
        destination.mkdir()
        # Validate all names/types before writing anything; compatible with 3.10.
        bundle.extractall(destination, members=members)


def owns_listener(pid, port):
    """Never send writes to a process which won a race for the chosen port."""
    try:
        sockets = set()
        for fd in Path(f'/proc/{pid}/fd').iterdir():
            try:
                sockets.add(os.readlink(fd))
            except FileNotFoundError:
                pass  # A short-lived descriptor may close during enumeration.
        for line in Path(f'/proc/{pid}/net/tcp').read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == f'0100007F:{port:04X}' and fields[3] == '0A':
                if f'socket:[{fields[9]}]' in sockets:
                    return True
    except (OSError, IndexError):
        pass
    return False


def check_port_available(port):
    with socket.socket() as probe:
        # Match Core's listener: TIME_WAIT from our previous start is reusable,
        # but a live listening socket still prevents the bind.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))


class Lab:
    def __init__(self, args):
        self.args = args
        self.lab = args.lab.resolve()
        self.root, self.data = self.lab / 'install', self.lab / 'data'
        self.project = self.lab / 'project'
        self.package = args.package_dir.resolve(strict=True)
        self.base = f'http://127.0.0.1:{args.port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.process = None
        # Core's environment; None inherits this process's (a stage may set its own).
        self.core_env = None
        self.report = {
            'startedAt': time.time(), 'lab': str(self.lab), 'port': args.port,
            'workflow': 'offline signed package', 'checks': [], 'commands': [],
            'environment': {'osRelease': Path('/etc/os-release').read_text(),
                            'libc': platform.libc_ver(), 'kernel': platform.release(),
                            'uid': os.getuid(), 'python': platform.python_version(),
                            'environmentKeys': sorted(os.environ),
                            'uidMap': Path('/proc/self/uid_map').read_text(),
                            'mountInfo': Path('/proc/self/mountinfo').read_text(),
                            'namespaces': {p.name: os.readlink(p) for p in Path('/proc/self/ns').iterdir()}},
            'notTested': ['real runtime login/conversation/approval', 'browser rendering and draft storage',
                          'online update', 'systemd Jobs', 'new OS account', 'second physical machine'],
        }

    def check(self, name, ok, **details):
        self.report['checks'].append({'name': name, 'ok': bool(ok), **details})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
        if not ok:
            raise RuntimeError(name)

    def command(self, name, argv, timeout=120):
        with (self.lab / f'{name}.log').open('wb') as log:
            result = subprocess.run([str(x) for x in argv], cwd=self.lab, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        self.report['commands'].append({'name': name, 'argv': [str(x) for x in argv], 'exitCode': result.returncode})
        self.check(name, result.returncode == 0)

    def verify(self):
        descriptor = self.package / 'yuzuno-core-linux-x86_64.json'
        archive = self.package / 'yuzuno-core-linux-x86_64.tar.gz'
        self.command('verify-signature', [self.args.minisign, '-Vm', descriptor, '-P', self.args.public_key])
        signed = json.loads(descriptor.read_text())
        manifest = signed['manifest']
        self.release = manifest['releaseId']
        self.check('signed release matches explicit tag', signed['tag'] == self.args.tag == self.release
                   and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]+', self.release)))
        self.check('archive matches signed digest', sha256(archive) == signed['archiveSha256'])
        self.report['release'] = {'tag': signed['tag'], 'version': manifest['version'], 'gitSha': manifest['gitSha'],
                                  'archiveSha256': signed['archiveSha256'], 'descriptorSha256': sha256(descriptor),
                                  'signatureSha256': sha256(Path(str(descriptor) + '.minisig')),
                                  'manifestSha256': signed['manifestSha256']}
        self.signed = signed
        self.bundle = self.lab / 'bundle'
        extract_bundle(archive, self.bundle)
        self.check('extracted manifest matches signed digest', sha256(self.bundle/'manifest.json') == signed['manifestSha256'])

    def install(self, label):
        self.command(label + '-register', [self.bundle/'bin/yuzuno-update-helper', 'register',
                     '--install-dir', self.root, '--bundle', self.bundle,
                     '--manifest-sha256', self.signed['manifestSha256'], '--reviewed-source', self.args.tag, '--initialize'])
        current = json.loads((self.root/'current.json').read_text())
        self.check(label + ': registered signed manifest', current['releaseId'] == self.release
                   and current['manifestSha256'] == self.signed['manifestSha256'])
        source = self.root/'release-source.json'
        source.write_text(json.dumps({'repository': self.signed['repository'], 'publicKey': self.args.public_key}) + '\n')
        source.chmod(0o600)
        self.check(label + ': private installation permissions', source.stat().st_mode & 0o777 == 0o600
                   and all(not (p.stat().st_mode & 0o022) for p in [self.root, *self.root.rglob('*')]))

    def request(self, path, data=None, timeout=5):
        if not self.process or self.process.poll() is not None or not owns_listener(self.process.pid, self.args.port):
            raise RuntimeError('Lab Core does not own the loopback listener')
        request = urllib.request.Request(self.base + path, data=None if data is None else json.dumps(data).encode(),
                                         headers={'Content-Type': 'application/json', 'x-yuzuno-client': 'desktop'})
        with self.opener.open(request, timeout=timeout) as response:
            return response.read()

    def start(self, label):
        check_port_available(self.args.port)
        exe = self.root/'releases'/self.release/'bin/yuzuno-workspace'
        with (self.lab/f'{label}-core.log').open('wb') as log:
            self.process = subprocess.Popen([str(exe), '--install-dir', str(self.root), '--data-dir', str(self.data),
                              '--cwd', str(self.project), '--port', str(self.args.port), '--codex', '/bin/false'],
                              cwd=self.project, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                              env=self.core_env, start_new_session=True)
        end = time.monotonic() + 30
        while time.monotonic() < end:
            if self.process.poll() is not None:
                raise RuntimeError(f'{label}: Core exited {self.process.returncode}; see its log')
            if owns_listener(self.process.pid, self.args.port):
                try:
                    health = json.loads(self.request('/api/health'))
                    break
                except (OSError, ValueError):
                    pass
            time.sleep(.1)
        else:
            raise RuntimeError(f'{label}: Core did not become healthy')
        self.check(label + ': running managed executable', os.readlink(f'/proc/{self.process.pid}/exe') == str(exe))
        self.check(label + ': signed Core health', health.get('releaseId') == self.release
                   and health.get('version') == self.signed['manifest']['version'] and bool(health.get('workspaceId'))
                   and health.get('apiReady') is True and health.get('storageReady') is True)
        self.report.setdefault('starts', []).append({'label': label, 'pid': self.process.pid, 'health': health})
        self.report.setdefault('libraryMaps', {})[label] = sorted({line.split()[-1] for line in Path(f'/proc/{self.process.pid}/maps').read_text().splitlines() if '/' in line})
        return health['workspaceId']

    def check_ui(self):
        web = self.root/'releases'/self.release/'web'
        html = self.request('/')
        self.check('served UI index matches release', html == (web/'index.html').read_bytes())
        assets = re.findall(r'(?:src|href)="(/assets/[^"?#]+)"', html.decode())
        self.check('UI references bundled assets', bool(assets))
        for asset in assets:
            relative = PurePosixPath(urllib.parse.unquote(asset)).relative_to('/')
            self.check('safe UI asset path', '..' not in relative.parts)
            self.check('served UI asset matches release: ' + asset, self.request(asset) == (web/relative).read_bytes())

    def stop(self, label, cleanup=False):
        if not self.process:
            return
        process = self.process
        graceful = True
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                graceful = False
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        self.process = None
        if not cleanup:
            self.check(label + ': graceful stop', graceful and process.returncode == 0)

    def run(self):
        self.verify()
        self.install('initial')
        workspace = self.start('initial')
        self.check_ui()
        project = json.loads(self.request('/api/projects', {'name': 'T88 persistence marker'}))
        self.check('persistent project created without runtime login', bool(project.get('id')))
        self.stop('initial')
        self.check('restart keeps Workspace', self.start('restart') == workspace)
        self.check('restart keeps project data', project in json.loads(self.request('/api/projects'))['projects'])
        self.stop('restart')
        shutil.rmtree(self.root)  # Only this new lab's installation, never its data.
        self.check('uninstall keeps data', self.data.is_dir() and not self.root.exists())
        self.install('reinstall')
        self.check('reinstall keeps Workspace', self.start('reinstall') == workspace)
        self.check('reinstall keeps project data', project in json.loads(self.request('/api/projects'))['projects'])
        self.check_ui()
        self.stop('reinstall')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-dir', type=Path, required=True, help='Directory containing archive, descriptor and minisig')
    parser.add_argument('--public-key', required=True, help='Trusted publisher key, supplied independently of the package')
    parser.add_argument('--tag', required=True, help='Expected signed release ID/tag')
    parser.add_argument('--lab', type=Path, required=True, help='New directory; all installation, data and reports stay below it')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--minisign', default='minisign', help='Verifier executable in this environment')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if args.lab.exists() or args.lab.is_symlink():
        parser.error('--lab must be a new directory')
    if not args.package_dir.is_dir():
        parser.error('--package-dir must exist')
    if not shutil.which(args.minisign):
        parser.error('--minisign must name an available verifier')
    args.lab.mkdir(parents=True, mode=0o700)
    lab = Lab(args)
    lab.project.mkdir()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        lab.run()
        lab.report['passed'] = True
    except Exception as error:
        lab.report.update(passed=False, error=f'{type(error).__name__}: {error}')
        print(lab.report['error'], flush=True)
    finally:
        lab.stop('cleanup', cleanup=True)
        lab.report['finishedAt'] = time.time()
        (lab.lab/'report.json').write_text(json.dumps(lab.report, indent=2) + '\n')
    return 0 if lab.report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
