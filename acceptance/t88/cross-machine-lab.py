#!/usr/bin/env python3
"""Real Mac Chrome -> SSH local forward -> separately installed Linux Core.

Run as one managed Job on Linux. The remote children are owned by a bounded
foreground SSH helper; Linux cgroup limits do not apply to those Mac processes.
Only disposable keys are generated; private keys never cross machines.
"""
import argparse
from contextlib import suppress
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time

# Import only this harness's checked-in helpers, also with PYTHONSAFEPATH=1.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from first_use_lab import FirstUseLab, REPO, install_script
from lab_environment import authenticated_environment
from package_lab import check_port_available, interrupt, sha256


class CrossMachineLab(FirstUseLab):
    remote = None
    sshd = None
    cdp = None

    def remote_call(self, op, **data):
        self.remote.stdin.write(json.dumps({'op': op, **data}) + '\n')
        self.remote.stdin.flush()
        readable, _, _ = select.select([self.remote.stdout], [], [], 55)
        if not readable:
            raise TimeoutError('Mac helper did not reply to ' + op)
        line = self.remote.stdout.readline()
        if not line:
            raise RuntimeError('Mac helper exited during ' + op)
        result = json.loads(line)
        if not result['ok']:
            raise RuntimeError('Mac ' + op + ': ' + result['error'])
        self.report.setdefault('macOperations', []).append({'op': op, 'result': result['result']})
        return result['result']

    def start_remote(self):
        source = (REPO/'acceptance/t88/mac-client-host.py').read_text()
        command = 'python3 -u -c ' + shlex.quote(source)
        with (self.lab/'mac-helper.log').open('wb') as log:
            self.remote = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                           self.args.mac, command], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=log, text=True)
        info = self.remote_call('init')
        self.report['mac'] = info
        ssh = self.lab/'ssh'
        ssh.mkdir()
        self.command('ssh-host-key', ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', ssh/'host'])
        public = info['publicKey']
        if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+ [^\r\n]+', public):
            raise ValueError('Unexpected temporary public key')
        (ssh/'authorized_keys').write_text(f'restrict,port-forwarding,permitopen="127.0.0.1:{self.args.port}" {public}\n')
        lines = [f'Port {self.args.ssh_port}', 'ListenAddress '+self.args.linux_host,
                 'HostKey '+str(ssh/'host'), 'PidFile '+str(ssh/'pid'),
                 'AuthorizedKeysFile '+str(ssh/'authorized_keys'), 'AuthenticationMethods publickey',
                 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
                 # /tmp is shared; this fresh 0700 directory and its keys are
                 # owned by us. Do not relax a real SSH server's StrictModes.
                 'StrictModes no', 'AllowTcpForwarding local', 'GatewayPorts no', 'MaxSessions 0',
                 'PermitTTY no', 'X11Forwarding no', 'AllowAgentForwarding no', 'PermitTunnel no',
                 'AllowUsers '+os.environ['USER'], 'LogLevel VERBOSE']
        (ssh/'config').write_text('\n'.join(lines)+'\n')
        self.command('sshd-config-check', [self.args.sshd, '-t', '-f', ssh/'config'])
        with (self.lab/'sshd.log').open('wb') as log:
            self.sshd = subprocess.Popen([str(self.args.sshd), '-D', '-e', '-f', str(ssh/'config')],
                                        stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        self.remote_call('configure', config={'host': self.args.linux_host, 'user': os.environ['USER'],
                         'hostKey': (ssh/'host.pub').read_text().strip(), 'sshPort': self.args.ssh_port,
                         'corePort': self.args.port, 'localPort': self.args.mac_port, 'cdpPort': self.args.cdp_port})
        rejected = self.remote_call('negative_auth')
        self.check('Mac SSH rejects wrong host key and unapproved identity',
                   all(x['exitCode'] == 255 and x['expectedError'] for x in rejected.values()))
        with (self.lab/'cdp-transport.log').open('wb') as log:
            self.cdp = subprocess.Popen(['ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                         '-o', 'ExitOnForwardFailure=yes', '-L',
                         f'127.0.0.1:{self.args.cdp_port}:127.0.0.1:{self.args.cdp_port}', self.args.mac],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log)

    def browser_mode(self, mode):
        env = dict(os.environ, T88_BASE=f'http://127.0.0.1:{self.args.mac_port}', T88_API_BASE=self.base,
                   T88_CDP=f'http://127.0.0.1:{self.args.cdp_port}', T88_LAB=str(self.lab), T88_PROJECT=str(self.project))
        with (self.lab/f'browser-{mode}.log').open('wb') as log:
            run = subprocess.run([str(self.args.node), str(REPO/'acceptance/t88/first-use-client.mjs'), mode],
                                  cwd=self.lab, env=env, stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=subprocess.STDOUT, timeout=300)
        report = self.lab/f'browser-{mode}.json'
        if report.exists():
            self.report.setdefault('browser', {}).setdefault(mode, []).append(json.loads(report.read_text()))
        self.check('Mac browser '+mode, run.returncode == 0)

    def run(self):
        script = self.lab/'install-from-guide.sh'
        script.write_text(install_script(self.args.doc.read_text(), self.lab, self.args.tag))
        self.report['guide'] = {'sha256': sha256(self.args.doc), 'scriptSha256': sha256(script)}
        self.command('guide-install', ['bash', script], timeout=180)
        self.verify()
        self.command('published-release', ['gh', 'release', 'view', self.args.tag, '-R', 'YuzukiS/Yuzuno',
                     '--json', 'tagName,isDraft,assets', '--jq', '{tagName,isDraft,assets:[.assets[]|{name,digest}]}'])
        published = json.loads((self.lab/'published-release.log').read_text())
        self.check('download matches published release assets', published['tagName'] == self.release
                   and not published['isDraft'] and len(published['assets']) == 3
                   and all(a['digest'] == 'sha256:'+sha256(self.package/a['name']) for a in published['assets']))
        self.report['published'] = published
        current = json.loads((self.root/'current.json').read_text())
        self.check('guide registered signed release', current['releaseId'] == self.release
                   and current['manifestSha256'] == self.signed['manifestSha256'])
        (self.project/'.claude').mkdir()
        (self.project/'.claude/settings.local.json').write_text(json.dumps({'permissions': {'ask': ['Bash']}}))
        workspace = self.start('initial')
        self.report['workspaceId'] = workspace
        self.start_remote()
        tunnel = self.remote_call('tunnel_start')
        self.check('Mac local forward reaches Linux Workspace on a different local port',
                   tunnel['health']['workspaceId'] == workspace and self.args.mac_port != self.args.port)
        guards = self.remote_call('guards')
        self.check('Mac cannot reach Core directly and cross-origin requests are rejected',
                   guards['directCore']['reachable'] is False
                   and len(guards['httpStatuses']) == 4
                   and all(value == 403 for value in guards['httpStatuses'].values()))
        if not self.args.connection_only:
            self.remote_call('browser_start')
            self.browser_mode('first')
            self.independence()
            self.remote_call('tunnel_stop')
            self.browser_mode('offline')
            self.check('Linux Core remains the same while Mac tunnel is down',
                       json.loads(self.request('/api/health'))['workspaceId'] == workspace)
            self.remote_call('tunnel_start')
            self.browser_mode('restored')
            self.remote_call('tunnel_stop')
            self.browser_mode('offline-reload')
            self.remote_call('tunnel_start')
            self.browser_mode('reopen')
            self.remote_call('browser_stop')
            self.remote_call('browser_start')
            self.browser_mode('reopen')
            self.stop('initial')
            self.check('Core restart retains Workspace identity', self.start('restart') == workspace)
            self.browser_mode('restart')
        cleanup = self.remote_call('cleanup')
        code = self.remote.wait(timeout=15)
        self.remote = None
        self.check('Mac cleanup removed temporary profile/keys and stopped owned processes',
                   code == 0 and cleanup['removedTemporaryDirectory'] and cleanup['ownedProcessesStopped'])
        self.stop('initial' if self.args.connection_only else 'restart')

    def cleanup(self):
        if self.remote:
            try:
                self.remote_call('cleanup')
                self.remote.wait(timeout=15)
            except Exception as error:
                self.report['remoteCleanupError'] = str(error)
                self.report['passed'] = False
                # EOF triggers the remote finally block; a lost SSH process
                # may already have closed its side of this pipe.
                with suppress(BrokenPipeError, OSError):
                    self.remote.stdin.close()
                try:
                    self.remote.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    self.remote.terminate()
                    self.remote.wait(timeout=10)
        for child in (self.cdp, self.sshd):
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        self.stop('cleanup', cleanup=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('lab', 'minisign', 'node', 'sshd', 'report'):
        parser.add_argument('--'+name, type=Path, required=True)
    for name in ('mac', 'linux-host', 'tag', 'public-key'):
        parser.add_argument('--'+name, required=True)
    for name in ('port', 'ssh-port', 'mac-port', 'cdp-port'):
        parser.add_argument('--'+name, type=int, required=True)
    parser.add_argument('--doc', type=Path, default=REPO/'docs/independent-core.md')
    parser.add_argument('--connection-only', action='store_true',
                        help='Recheck SSH/transport/Host/Origin only; no browser or model call')
    args = parser.parse_args()
    source = REPO.parents[2] if REPO.parent.name == 'worktrees' else REPO
    if args.lab.exists() or args.lab.is_symlink() or args.lab.resolve().is_relative_to(source):
        parser.error('--lab must be a new directory outside the source checkout')
    if args.report.exists() or args.report.is_symlink():
        parser.error('--report must be new')
    if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9_.-]*', args.mac):
        parser.error('--mac must be an explicitly authorized user@host')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]+', args.tag):
        parser.error('--tag must be an explicit release tag')
    address = ipaddress.ip_address(args.linux_host)
    if address.version != 4 or address.is_global or address.is_loopback or address.is_unspecified or address.is_multicast:
        parser.error('--linux-host must be an explicit private/CGNAT IPv4 interface')
    ports = [args.port, args.ssh_port, args.mac_port, args.cdp_port]
    if len(set(ports)) != 4 or any(not 1024 <= p <= 65535 for p in ports):
        parser.error('Choose four distinct unprivileged ports')
    for port in (args.port, args.cdp_port):
        check_port_available(port)
    with socket.socket() as probe:
        probe.bind((args.linux_host, args.ssh_port))
    for name in ('node', 'minisign', 'sshd', 'doc'):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    os.umask(0o077)
    args.lab = args.lab.resolve()
    args.lab.mkdir(mode=0o700)
    args.package_dir = args.lab/'download'
    args.package_dir.mkdir()
    tool_dir = args.lab/'tools'
    tool_dir.mkdir()
    shutil.copy2(args.minisign, tool_dir/'minisign')
    env = authenticated_environment(os.environ, tool_dir, args.node.parent)
    os.environ.clear()
    os.environ.update(env)
    lab = CrossMachineLab(args)
    lab.project.mkdir()
    lab.report.update(workflow='Mac Chrome through a real client-originated SSH tunnel to Linux Core',
                      accountBoundary='Existing Linux CLI login and authorized Mac SSH access; fresh app data/browser profile and test-only SSH keys.',
                      remoteResourceBoundary='Mac Chrome and SSH are foreground children of a bounded remote helper; Linux cgroup quotas do not constrain the Mac.',
                      harnessSha=subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
                      notTested=['new OS account or native CLI login', 'macOS Core', 'native desktop clients',
                                 'online update', 'Windows Jobs', 'GPU', 'Core as a service'])
    if args.connection_only:
        lab.report['workflow'] = 'Mac SSH/transport/Host/Origin only; no browser or model call'
        lab.report['notTested'] += ['browser/Agent/approval/drafts/restart (separate recorded full run)']
    for key in ('mountInfo', 'uidMap', 'namespaces'):
        lab.report['environment'].pop(key, None)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        lab.run()
        lab.report['passed'] = True
    except Exception as error:
        lab.report.update(passed=False, error=f'{type(error).__name__}: {error}')
        print(lab.report['error'], flush=True)
    finally:
        lab.cleanup()
        lab.report['finishedAt'] = time.time()
        content = json.dumps(lab.report, indent=2)+'\n'
        (lab.lab/'report.json').write_text(content)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(content)
    return 0 if lab.report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
