#!/usr/bin/env python3
"""T-141: the packaged macOS desktop app on a real Mac, reaching a Core on
this Linux/WSL host through an SSH tunnel over a private network.

    python3 acceptance/t141/mac-desktop-lab.py --lab <new folder> --report <file>
        --core-release <signed release folder> --mac you@mac --linux-host <private IPv4>
        --dmg <disk image path on the Mac> --expect-executable-sha256 <hex> [ports]

Everything here is disposable and owned by this run:
- **A lab Core**: the release's own binary and UI with a new data folder, on
  a loopback port. No Agent and no model call are started by this script.
- **A lab SSH server** on the private interface, with its own host key, made
  from this host's own sshd settings (/etc/ssh/sshd_config and
  sshd_config.d) plus scripts/sshd-yuzuno-tunnel.conf, with only the
  substitutions a server run by an ordinary user needs (each recorded). Its
  two ports each have their own key made on the Mac for this run (only their
  public halves come here):
  - --ssh-port stands for this host's own SSH port: the key's own options are
    all that restrict it, as they would be there. This shows what a key line
    alone allows and what it cannot prevent;
  - --tunnel-port stands for the drop-in's port of its own, where the server
    allows only local TCP forwarding to the Core ports and nothing else.
  The account's AuthorizedKeysCommand is replaced by a marked one that
  supplies a third key, so the drop-in's `AuthorizedKeysCommand none` is
  tested against a real command. Before that, `sshd -T` on unchanged copies
  of this host's files shows what the drop-in changes for its existing port.
- **Request relays** in front of the lab Core and, read-only, of the Core on
  --daily-port: they record each HTTP request line, and the read-only one
  answers any request but GET/HEAD/OPTIONS with 403 itself, so that Core
  receives no write from this run.
- **On the Mac**: acceptance/t141/mac-desktop-host.py in a fresh folder under
  ~/yuzuno-t141-lab/net/. It copies the app out of --dmg into that folder,
  starts and quits it with open(1) and a signal, and removes at the end any of
  the app's own data folders this run created.

What it checks without a person at the Mac: the key's restrictions, the
installed bytes, that the app connects to the Core it is given and keeps it
for the next launch, that it comes back after the tunnel drops, and that it
only reads the daily Core. What the window shows (identity, lists, a sent
message, drafts) needs a person or GUI access and is not checked here.
Writes report.json; exits 1 if a check fails.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DROP_IN = HERE.parent.parent / 'scripts' / 'sshd-yuzuno-tunnel.conf'
ETC_SSH = Path('/etc/ssh')
# Where the drop-in's key line names a source that is not the Mac.
ELSEWHERE = '192.0.2.1'
READ_ONLY = {'GET', 'HEAD', 'OPTIONS'}
# User agents of this lab's own requests, never the app's.
PROBES = ('curl/', 'Python-urllib/', 't141-probe')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def health(port, seconds=40):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            with opener.open(f'http://127.0.0.1:{port}/api/health', timeout=3) as response:
                return json.loads(response.read())
        except (OSError, ValueError):
            time.sleep(.2)
    raise TimeoutError(f'no Core on 127.0.0.1:{port}')


class Relay:
    """127.0.0.1:<port> to 127.0.0.1:<upstream>, recording request lines."""

    def __init__(self, port, upstream, read_only=False):
        self.port, self.upstream, self.read_only = port, upstream, read_only
        self.requests, self.lock, self.connections = [], threading.Lock(), 0
        self.server = socket.create_server(('127.0.0.1', port))
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                self.connections += 1
                number = self.connections
            threading.Thread(target=self.handle, args=(client, number), daemon=True).start()

    def record(self, **entry):
        with self.lock:
            self.requests.append({'at': round(time.time(), 3), **entry})

    def handle(self, client, number):
        try:
            upstream = socket.create_connection(('127.0.0.1', self.upstream))
        except OSError as error:
            self.record(connection=number, error=str(error))
            client.close()
            return
        threading.Thread(target=self.pump, args=(upstream, client), daemon=True).start()
        buffer, raw = b'', False
        try:
            while True:
                data = client.recv(65536)
                if not data:
                    break
                if raw:
                    upstream.sendall(data)
                    continue
                buffer += data
                while not raw:
                    end = buffer.find(b'\r\n\r\n')
                    if end < 0:
                        break
                    head = buffer[:end].decode('latin-1')
                    line, _, rest = head.partition('\r\n')
                    headers = {k.strip().lower(): v.strip() for k, v in
                               (h.split(':', 1) for h in rest.split('\r\n') if ':' in h)}
                    method, path = (line.split(' ') + ['', ''])[:2]
                    length = int(headers.get('content-length', '0') or 0)
                    if len(buffer) < end + 4 + length:
                        break
                    message, buffer = buffer[:end + 4 + length], buffer[end + 4 + length:]
                    upgrade = headers.get('upgrade')
                    if self.read_only and method not in READ_ONLY:
                        self.record(connection=number, method=method, path=path, blocked=True,
                                    agent=headers.get('user-agent'))
                        client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        raise ConnectionAbortedError
                    self.record(connection=number, method=method, path=path, upgrade=upgrade,
                                agent=headers.get('user-agent'),
                                chunked='chunked' in headers.get('transfer-encoding', ''))
                    upstream.sendall(message)
                    if upgrade or 'chunked' in headers.get('transfer-encoding', ''):
                        upstream.sendall(buffer)
                        buffer, raw = b'', True
        except (OSError, ConnectionAbortedError):
            pass
        finally:
            for s in (client, upstream):
                try:
                    s.close()
                except OSError:
                    pass

    @staticmethod
    def pump(source, sink):
        try:
            while data := source.recv(65536):
                sink.sendall(data)
        except OSError:
            pass
        finally:
            for s in (source, sink):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def since(self, at):
        """Requests from the app since `at`: not this lab's own probes or
        scripts/mac-tunnel.sh's health check (curl)."""
        with self.lock:
            return [r for r in self.requests if r['at'] >= at and not (r.get('agent') or '').startswith(PROBES)]

    def wait_for(self, at, test, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            seen = self.since(at)
            if test(seen):
                return seen
            time.sleep(.5)
        return self.since(at)


class Decoy:
    """A listener that nothing in this run should ever reach."""

    def __init__(self, port):
        self.port, self.connections = port, 0
        self.server = socket.create_server(('127.0.0.1', port))
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            conn.close()


class SocketDecoy:
    """A Unix socket that nothing in this run should ever reach."""

    def __init__(self, path):
        self.path, self.connections = path, 0
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(path))
        self.server.listen()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            conn.close()


class Lab:
    def __init__(self, args):
        self.args = args
        # Absolute: sshd takes a relative AuthorizedKeysFile from the home folder.
        self.lab = Path(args.lab).resolve()
        self.lab.mkdir(parents=True)
        os.chmod(self.lab, 0o700)
        self.report = {'startedAt': time.time(), 'checks': [], 'facts': {}, 'notCovered': [
            'what the window shows: Workspace identity, Agent list, Home and Jobs pages, a sent message and its reply, '
            'an approval, drafts (needs a person at the Mac or GUI access)',
            'a downloaded copy with the quarantine attribute (the Gatekeeper dialog needs a person)',
            'installing into /Applications', 'a Developer ID signature or notarization (none exists)',
            'Intel Macs', 'this host\'s own SSH server and the account\'s real authorized_keys']}
        self.procs, self.remote, self.app = {}, None, None

    def check(self, name, ok, fact=None):
        self.report['checks'].append({'name': name, 'ok': bool(ok)})
        if fact is not None:
            self.report['facts'][name] = fact
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
        return ok

    def spawn(self, name, argv, **kw):
        log = (self.lab / (name + '.log')).open('wb')
        self.procs[name] = subprocess.Popen([str(a) for a in argv], stdin=subprocess.DEVNULL, stdout=log,
                                            stderr=subprocess.STDOUT, **kw)
        return self.procs[name]

    def call(self, op, **data):
        self.remote.stdin.write(json.dumps({'op': op, **data}) + '\n')
        self.remote.stdin.flush()
        line = self.remote.stdout.readline()
        if not line:
            raise RuntimeError('Mac helper exited during ' + op)
        reply = json.loads(line)
        self.report.setdefault('macOperations', []).append({'op': op, 'reply': reply})
        if not reply['ok']:
            raise RuntimeError('Mac ' + op + ': ' + reply['error'])
        return reply['result']

    def start_core(self):
        a, release = self.args, Path(self.args.core_release)
        (self.lab / 'cwd').mkdir()
        env = {'PATH': '/usr/bin:/bin', 'HOME': os.environ['HOME'], 'LANG': 'C.UTF-8'}
        self.spawn('core', [release / 'bin' / 'yuzuno-workspace', '--port', a.core_port, '--data-dir', self.lab / 'data',
                            '--web-dir', release / 'web', '--cwd', self.lab / 'cwd', '--codex', '/bin/false'], env=env)
        self.workspace = health(a.core_port)['workspaceId']
        self.report['facts']['labWorkspace'] = self.workspace

    def substitute(self, text, old, new, where):
        if text.count(old) != 1:
            raise ValueError(f'{where}: expected {old!r} once')
        self.report['facts'].setdefault('labSubstitutions', []).append({'file': where, 'from': old, 'to': new})
        return text.replace(old, new)

    def host_files(self, into, drop_in):
        """This host's sshd_config and sshd_config.d, copied into `into` with
        only the Include pointed there, and the drop-in added if given."""
        (into / 'd').mkdir(parents=True)
        main = (ETC_SSH / 'sshd_config').read_text()
        main = main.replace('Include /etc/ssh/sshd_config.d/*.conf', f'Include {into / "d"}/*.conf')
        (into / 'sshd_config').write_text(main)
        for f in sorted((ETC_SSH / 'sshd_config.d').glob('*.conf')):
            (into / 'd' / f.name).write_text(f.read_text())
        if drop_in:
            (into / 'd' / '30-yuzuno-tunnel.conf').write_text(drop_in)
        return into / 'sshd_config'

    def effective(self, config, lport, host_key):
        spec = f'user={os.environ["USER"]},host=mac,addr=192.0.2.10,laddr=192.0.2.20,lport={lport}'
        done = subprocess.run([self.args.sshd, '-T', '-f', str(config), '-o', f'HostKey={host_key}', '-C', spec],
                              capture_output=True, text=True)
        if done.returncode:
            raise RuntimeError('sshd -T: ' + done.stderr[-500:])
        return done.stdout.splitlines()

    def check_drop_in(self, ssh, drop_in):
        """What the drop-in changes in this host's own settings, read with
        `sshd -T` from copies; nothing here touches /etc/ssh."""
        a = self.args
        files = {str(f): hashlib.sha256(f.read_bytes()).hexdigest()
                 for f in [ETC_SSH / 'sshd_config', *sorted((ETC_SSH / 'sshd_config.d').glob('*.conf'))]}
        self.report['facts']['hostSshdFiles'] = files
        without = self.host_files(ssh / 'host-without', None)
        with_ = self.host_files(ssh / 'host-with', drop_in)
        valid = subprocess.run([a.sshd, '-t', '-f', str(with_), '-o', f'HostKey={ssh / "host"}'],
                               capture_output=True, text=True)
        before = Counter(self.effective(without, self.host_port, ssh / 'host'))
        after = Counter(self.effective(with_, self.host_port, ssh / 'host'))
        listener = {f'Port {self.dedicated_port}', f'ListenAddress 0.0.0.0:{self.dedicated_port}',
                    f'ListenAddress [::]:{self.dedicated_port}'}
        added, removed = list((after - before).elements()), list((before - after).elements())
        self.check(f'with the drop-in, this host\'s settings pass sshd -t and port {self.host_port} is unchanged '
                   'but for the new listener', valid.returncode == 0 and not removed and set(added) <= listener
                   and f'Port {self.dedicated_port}' in added, {'added': added, 'removed': removed})
        expected = [line.strip() for line in drop_in.split(f'Match LocalPort {self.dedicated_port}', 1)[1].splitlines()
                    if line.strip() and not line.strip().startswith('#')]
        dedicated = self.effective(with_, self.dedicated_port, ssh / 'host')
        self.check(f'with the drop-in, port {self.dedicated_port} has each of its settings',
                   expected and all(line in dedicated for line in expected),
                   {'missing': [line for line in expected if line not in dedicated]})

    def start_sshd(self, keys, mac_address):
        a, ssh = self.args, self.lab / 'ssh'
        ssh.mkdir(mode=0o700)
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ssh / 'host')], check=True)
        for key in keys.values():
            if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+ t141-disposable', key):
                raise ValueError('Unexpected public key from the Mac')
        if not re.fullmatch(r'[0-9.]+|[0-9a-f:]+', mac_address):
            raise ValueError('Unexpected Mac address')
        drop_in = DROP_IN.read_text()
        self.dedicated_port = int(re.search(r'^Port (\d+)$', drop_in, re.M).group(1))
        host_ports = [int(p) for f in [ETC_SSH / 'sshd_config', *(ETC_SSH / 'sshd_config.d').glob('*.conf')]
                      for p in re.findall(r'^Port (\d+)$', f.read_text(), re.M)]
        if len(host_ports) != 1:
            raise ValueError(f'Expected one Port in this host\'s sshd settings, found {host_ports}')
        self.host_port = host_ports[0]
        self.check_drop_in(ssh, drop_in)

        targets = [f'127.0.0.1:{a.relay_port}', f'127.0.0.1:{a.daily_relay_port}']
        # A key line alone, on a server that leaves forwarding at its defaults.
        options = 'restrict,port-forwarding,' + ','.join(f'permitopen="{t}"' for t in targets) + \
            ',command="/usr/bin/false"'
        self.key_options = f'from="{mac_address}",{options}'
        (ssh / 'authorized_keys').write_text(f'{self.key_options} {keys["client"]}\n'
                                             f'from="{ELSEWHERE}",{options} {keys["elsewhere"]}\n')
        # The port of its own: only this file, and the server restricts the rest.
        (ssh / 'authorized_keys_tunnel').write_text(f'from="{mac_address}" {keys["tunnel"]}\n')
        lab = self.host_files(ssh / 'lab', None)
        d = ssh / 'lab' / 'd'
        found = False
        for f in [lab, *sorted(d.glob('*.conf'))]:
            text = f.read_text()
            if f'Port {self.host_port}\n' in text:
                text = self.substitute(text, f'Port {self.host_port}\n', f'Port {a.ssh_port}\n', f.name)
            command = re.search(r'^AuthorizedKeysCommand .*$', text, re.M)
            if command:
                # Marked: the key it supplies exists nowhere else.
                text = self.substitute(text, command.group(0), "AuthorizedKeysCommand /usr/bin/echo "
                                       f"'restrict,command=\"/usr/bin/false\" {keys['command']}'", f.name)
                found = True
            f.write_text(text)
        if not found:
            raise ValueError('This host\'s sshd settings have no AuthorizedKeysCommand to stand in for')
        tunnel = drop_in
        # The Match line first: it ends with the Port line's text.
        for old, new in [(f'Match LocalPort {self.dedicated_port}\n', f'Match LocalPort {a.tunnel_port}\n'),
                         (f'Port {self.dedicated_port}\n', f'Port {a.tunnel_port}\n'),
                         ('PermitOpen 127.0.0.1:4317\n', 'PermitOpen ' + ' '.join(targets) + '\n'),
                         ('AuthorizedKeysFile .ssh/authorized_keys_yuzuno_tunnel\n',
                          f'AuthorizedKeysFile {ssh / "authorized_keys_tunnel"}\n')]:
            tunnel = self.substitute(tunnel, old, new, '30-yuzuno-tunnel.conf')
        (d / '30-yuzuno-tunnel.conf').write_text(tunnel)
        self.tunnel_block = tunnel.split('Match LocalPort', 1)[1].splitlines()[1:]
        # First value wins in sshd_config: these come before everything else.
        # Its own address, keys and files, and what a server run by an
        # ordinary user from this 0700 lab folder needs: the command run as
        # that user, no PAM, StrictModes off. The Mac is exempt from the
        # penalties for failed logins, which would otherwise drop it before
        # the last refusal checks are asked.
        first = [f'ListenAddress {a.linux_host}:{a.ssh_port}', f'ListenAddress {a.linux_host}:{a.tunnel_port}',
                 f'HostKey {ssh / "host"}', f'PidFile {ssh / "pid"}', f'AuthorizedKeysFile {ssh / "authorized_keys"}',
                 f'AuthorizedKeysCommandUser {os.environ["USER"]}', 'UsePAM no', 'StrictModes no', 'LogLevel VERBOSE',
                 f'PerSourcePenaltyExemptList {mac_address}']
        self.report['facts']['labFirstLines'] = first
        lab.write_text('\n'.join(first) + '\n' + lab.read_text())
        subprocess.run([a.sshd, '-t', '-f', str(lab)], check=True)
        effective = {}
        for port in (a.ssh_port, a.tunnel_port):
            spec = f'user={os.environ["USER"]},host=mac,addr={mac_address},laddr={a.linux_host},lport={port}'
            out = subprocess.run([a.sshd, '-T', '-C', spec, '-f', str(lab)], capture_output=True, text=True).stdout
            effective[str(port)] = {k.lower(): v for k, v in (l.split(' ', 1) for l in out.splitlines() if ' ' in l)
                                    if k.lower() in ('allowtcpforwarding', 'allowstreamlocalforwarding', 'permitopen',
                                             'permitlisten', 'permittty', 'forcecommand', 'gatewayports',
                                             'authorizedkeysfile', 'authorizedkeyscommand', 'usepam',
                                             'maxsessions', 'disableforwarding', 'allowusers')}
        self.report['facts']['labSshdEffective'] = effective
        self.spawn('sshd', [a.sshd, '-D', '-e', '-f', lab])
        time.sleep(1)
        return (ssh / 'host.pub').read_text().strip()

    def probe(self, label, key, port, key_line_only):
        """Sessions and forwards with one key on one port, each against what
        that configuration is expected to do. With the key line alone
        (key_line_only), OpenSSH's key options cannot refuse remote forwarding
        (TCP or Unix socket): those are recorded as working, a boundary. A
        local forward to a Unix socket is refused there too, but only because
        sshd checks it against the same permitted list permitopen fills
        (measured on this version, not documented for permitopen). The
        dedicated port must refuse everything but local TCP to Core."""
        a = self.args
        for kind in ('exec', 'shell', 'sftp'):
            marker = self.lab / f'marker-{label}-{kind}'
            r = self.call('session', key=key, port=port, kind=kind, marker=str(marker))
            ran = marker.exists()
            if kind == 'sftp':
                self.check(f'{label}: sftp is refused', r['exitCode'] not in (0, None) and not ran, r)
            else:
                # 1 is /usr/bin/false's; ssh's own failures are 255.
                self.check(f'{label}: {kind} runs the forced command, not the one asked for',
                           r['exitCode'] == 1 and not ran, r)
        local = a.mac_probe_port
        before = self.decoy.connections
        self.call('forward_start', name=label + '-L-decoy', key=key, port=port, flag='-L', localPort=local,
                  spec=f'127.0.0.1:{local}:127.0.0.1:{a.decoy_port}')
        reached = self.call('forward_probe', localPort=local)
        stopped = self.call('forward_stop', name=label + '-L-decoy')
        self.check(f'{label}: -L to another TCP port is prohibited',
                   stopped['prohibited'] and not reached.get('bytesBack') and self.decoy.connections == before,
                   {'probe': reached, 'decoyConnections': self.decoy.connections - before})
        self.call('forward_start', name=label + '-L-core', key=key, port=port, flag='-L', localPort=local + 1,
                  spec=f'127.0.0.1:{local + 1}:127.0.0.1:{a.relay_port}')
        reached = self.call('forward_probe', localPort=local + 1)
        self.call('forward_stop', name=label + '-L-core')
        self.check(f'{label}: -L to the Core port works', (reached.get('bytesBack') or 0) > 0, reached)
        # -R on TCP: does anything listen on this host afterwards?
        started = self.call('forward_start', name=label + '-R', key=key, port=port, flag='-R',
                            spec=f'127.0.0.1:{a.remote_probe_port}:127.0.0.1:22')
        listening = bool(subprocess.run(['ss', '-ltnH', 'sport', '=', f':{a.remote_probe_port}'],
                                        capture_output=True, text=True).stdout.strip())
        stopped = self.call('forward_stop', name=label + '-R')
        fact = {'sshStayedUp': started['alive'], 'listenerOnThisHost': listening, 'refused': stopped['remoteRefused']}
        if key_line_only:
            self.check(f'{label}: -R (TCP) is NOT prevented by the key line (boundary)', listening, fact)
        else:
            self.check(f'{label}: -R (TCP) is refused and nothing listens', not listening and stopped['remoteRefused'], fact)
        # -R to a Unix socket: does the socket appear on this host?
        remote_socket = self.lab / f'remote-{port}.sock'
        started = self.call('forward_start', name=label + '-RS', key=key, port=port, flag='-R',
                            spec=f'{remote_socket}:127.0.0.1:22')
        appeared = remote_socket.exists()
        stopped = self.call('forward_stop', name=label + '-RS')
        fact = {'sshStayedUp': started['alive'], 'socketAppeared': appeared, 'logTail': stopped['logTail'][-300:]}
        if remote_socket.exists():
            remote_socket.unlink()
        if key_line_only:
            self.check(f'{label}: -R to a Unix socket is NOT prevented by the key line (boundary)', appeared, fact)
        else:
            self.check(f'{label}: -R to a Unix socket is refused', not appeared and not started['alive'], fact)
        # -L to a Unix socket on this host.
        before = self.socket_decoy.connections
        self.call('forward_start', name=label + '-S', key=key, port=port, flag='-L', localPort=local + 2,
                  spec=f'127.0.0.1:{local + 2}:{self.socket_decoy.path}')
        reached = self.call('forward_probe', localPort=local + 2)
        stopped = self.call('forward_stop', name=label + '-S')
        reached_socket = self.socket_decoy.connections > before
        self.check(f'{label}: -L to a Unix socket is refused', stopped['prohibited'] and not reached_socket,
                   {'probe': reached, 'socketConnections': self.socket_decoy.connections - before})

    def tunnel_script_checks(self, t):
        """scripts/mac-tunnel.sh against what goes wrong around it: a stale
        process ID file, another service on its port, a second Core for the
        same port, two runs at once, leftover state, and a state folder that is
        too long or open to others. The first three fail on the earlier script
        (5756b64), which kept a process ID file: its stop killed the unrelated
        process, and it reported the other service and the other Core as its
        tunnel. On macOS its ssh even bound the port beside that service."""
        a, port = self.args, t['localPort']

        def script(action, **kw):
            return self.call('script_tunnel', action=action, **{**t, **kw})

        def forwards():
            return self.call('forwards', localPort=port)['pids']

        other = self.call('unrelated', localPort=port)
        stopped, status = script('stop'), script('status')
        alive = self.call('alive', name=other['name'])['alive']
        self.call('release', name=other['name'])
        self.check('a leftover process ID file naming an unrelated process: stop leaves it running and status '
                   'claims no tunnel', alive and status['exitCode'] == 3, {'stop': stopped, 'status': status,
                                                                         'unrelatedStillRunning': alive})

        occupied = self.call('occupy', port=port)
        started, status, pids = script('start'), script('status'), forwards()
        self.call('release', name=occupied['name'])
        self.check('another service already answering on the local port: start refuses and no ssh forwards it',
                   started['exitCode'] not in (0, None) and status['exitCode'] == 3 and not pids,
                   {'start': started, 'status': status, 'forwards': pids})

        first = script('start')
        second = script('start', remotePort=a.daily_relay_port)
        status = script('status')
        self.check('the same local port for another Core: start refuses it and the first tunnel keeps running',
                   first['exitCode'] == 0 and second['exitCode'] not in (0, None) and status['exitCode'] == 0
                   and status['health'].get('workspaceId') == self.workspace and len(forwards()) == 1,
                   {'first': first, 'second': second, 'status': status})
        script('stop')

        both = self.call('script_tunnel_pair', action='start', **t)
        up = [r for r in both if r['exitCode'] == 0 and 'Tunnel up' in r['stdout']]
        rest = [r for r in both if r not in up]
        pids = forwards()
        self.check('two starts at once: one starts the tunnel, the other stops at once (75) or finds it running, '
                   'and one ssh forwards the port',
                   len(up) == 1 and len(rest) == 1 and (rest[0]['exitCode'] == 75 or (
                       rest[0]['exitCode'] == 0 and 'Already running' in rest[0]['stdout'])) and len(pids) == 1,
                   {'runs': both, 'forwards': pids})
        stopped = script('stop')
        self.check('stop ends that ssh and leaves no tunnel state but the lock file',
                   stopped['exitCode'] == 0 and not forwards()
                   and self.call('state_files')['files'] == [f'{port}.lock'], stopped)

        self.call('stale', localPort=port)
        status, started, stopped = script('status'), script('start'), script('stop')
        self.check('leftover tunnel state: status claims no tunnel, start clears it and works',
                   status['exitCode'] == 3 and started['exitCode'] == 0
                   and started['health'].get('workspaceId') == self.workspace and stopped['exitCode'] == 0
                   and self.call('state_files')['files'] == [f'{port}.lock'],
                   {'status': status, 'start': started, 'stop': stopped})

        too_long = self.mac_lab + '/' + 'd' * 40
        started = script('start', stateDir=too_long)
        made = self.call('state_files', stateDir=too_long)['exists']
        open_ = script('start', stateDir=self.call('open_folder', name='open')['path'])
        self.check('a state folder too long for a control socket, or one others can open: start refuses and '
                   'starts nothing', started['exitCode'] == 64 and not made and open_['exitCode'] == 73
                   and not forwards(), {'tooLong': started, 'open': open_})

    def run(self):
        a = self.args
        self.start_core()
        self.relay = Relay(a.relay_port, a.core_port)
        self.daily = Relay(a.daily_relay_port, a.daily_port, read_only=True)
        self.daily_workspace = health(a.daily_port)['workspaceId']
        self.decoy = Decoy(a.decoy_port)
        self.socket_decoy = SocketDecoy(self.lab / 'decoy.sock')
        source = (HERE / 'mac-desktop-host.py').read_text()
        self.remote = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', a.mac,
                                        'python3 -u -c ' + shlex.quote(source)], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=(self.lab / 'mac-helper.log').open('wb'), text=True)
        mac = self.call('init')
        self.report['mac'] = {k: mac[k] for k in ('system', 'architecture', 'osVersion', 'osBuild', 'ssh', 'appDataBefore')}
        self.report['facts']['macAddressSeen'] = mac['address']
        self.mac_lab = mac['lab']
        host_key = self.start_sshd(mac['keys'], mac['address'])
        self.report['facts']['keyOptions'] = self.key_options
        self.report['facts']['tunnelPortBlock'] = self.tunnel_block
        self.call('configure', config={'host': a.linux_host, 'user': os.environ['USER'], 'hostKey': host_key,
                                       'sshPort': a.ssh_port, 'tunnelPort': a.tunnel_port})
        self.probe('key line alone', 'client', a.ssh_port, key_line_only=True)
        self.probe('dedicated port', 'tunnel', a.tunnel_port, key_line_only=False)
        # The account's AuthorizedKeysCommand (the marked stand-in) is
        # consulted on the key-line port, as on this host's own port.
        marker = self.lab / 'marker-command-key'
        r = self.call('session', key='command', port=a.ssh_port, kind='exec', marker=str(marker))
        self.check('a key only the AuthorizedKeysCommand supplies signs in on the key-line port (to its forced command)',
                   r['exitCode'] == 1 and not marker.exists(), r)

        script = Path(a.tunnel_script) if a.tunnel_script else HERE.parent.parent / 'scripts' / 'mac-tunnel.sh'
        self.report['facts']['tunnelScriptSha256'] = self.call('put_script', text=script.read_text())['sha256']
        lab_tunnel = dict(key='tunnel', port=a.tunnel_port, localPort=a.mac_port, remotePort=a.relay_port)
        self.tunnel_script_checks(lab_tunnel)
        if a.tunnel_checks_only:
            return
        tunnel = self.call('script_tunnel', action='start', **lab_tunnel)
        self.check('scripts/mac-tunnel.sh start reaches the lab Workspace',
                   tunnel['exitCode'] == 0 and tunnel['health']['workspaceId'] == self.workspace
                   and len(self.call('forwards', localPort=a.mac_port)['pids']) == 1, tunnel)
        installed = self.call('install', dmg=a.dmg)
        self.check('the app copied out of the disk image is the built executable',
                   installed['executableSha256'] == a.expect_executable_sha256 and installed['copy'] == 0
                   and installed['detach'] == 0 and installed['verify']['exitCode'] == 0, installed)
        app = self.app = installed['app']
        core_url = f'http://127.0.0.1:{a.mac_port}'

        def opened(at):
            seen = self.relay.wait_for(at, lambda s: any(x.get('path', '').startswith('/?shell=desktop') for x in s)
                                       and any(x.get('path', '').startswith('/api/') and x['path'] != '/api/health'
                                               for x in s))
            return seen, {'health': any(x.get('path') == '/api/health' for x in seen),
                          'workspacePage': any(x.get('path', '').startswith('/?shell=desktop') for x in seen),
                          'api': sorted({x['path'].split('?')[0] for x in seen if x.get('path', '').startswith('/api/')})}

        at = time.time()
        launched = self.call('launch', app=app, args=['--core-url', core_url])
        seen, summary = opened(at)
        self.check('launched with --core-url, it checks Core and opens its Workspace',
                   launched['pids'] and summary['health'] and summary['workspacePage'] and summary['api'], summary)
        saved = self.call('saved_core')
        self.check('it saves that Core for the next launch',
                   saved['exists'] and saved['record'] == {'coreUrl': core_url + '/'}, saved)

        stopped = self.call('script_tunnel', action='stop', **lab_tunnel)
        status = self.call('script_tunnel', action='status', **lab_tunnel)
        self.check('scripts/mac-tunnel.sh stop ends it and status says so',
                   stopped['exitCode'] == 0 and status['exitCode'] == 3, {'stop': stopped, 'status': status})
        time.sleep(8)
        down = time.time()
        self.call('script_tunnel', action='start', **lab_tunnel)
        back = self.relay.wait_for(down, lambda s: any(x.get('path', '').startswith('/api/') for x in s), 60)
        alive = self.call('running', app=app)
        self.check('after the tunnel drops and returns, the open window reaches Core again',
                   alive['pids'] and any(x.get('path', '').startswith('/api/') for x in back),
                   {'pids': alive['pids'], 'requestsAfterRestore': [x.get('path') for x in back][:20]})

        quit_ = self.call('quit', app=app)
        self.check('it quits', quit_['signalled'] and not quit_['left'], quit_)
        at = time.time()
        relaunched = self.call('launch', app=app)
        seen, summary = opened(at)
        self.check('opened again without arguments, it returns to the saved Core',
                   relaunched['pids'] and summary['health'] and summary['workspacePage'], summary)
        self.call('quit', app=app)

        self.call('script_tunnel', action='stop', **lab_tunnel)
        daily = dict(key='tunnel', port=a.tunnel_port, localPort=a.mac_daily_port, remotePort=a.daily_relay_port)
        daily_tunnel = self.call('script_tunnel', action='start', **daily)
        self.check('the read-only tunnel reaches the daily Workspace',
                   daily_tunnel['exitCode'] == 0 and daily_tunnel['health']['workspaceId'] == self.daily_workspace,
                   daily_tunnel.get('health'))
        at = time.time()
        self.call('launch', app=app, args=['--core-url', f'http://127.0.0.1:{a.mac_daily_port}'])
        seen = self.daily.wait_for(at, lambda s: any(x.get('path', '').startswith('/?shell=desktop') for x in s)
                                   and sum(1 for x in s if x.get('path', '').startswith('/api/')) > 3, 40)
        time.sleep(5)
        seen = self.daily.since(at)
        blocked = [x for x in seen if x.get('blocked')]
        self.check('it opens the daily Workspace, and nothing but reads reached that Core',
                   any(x.get('path', '').startswith('/?shell=desktop') for x in seen)
                   and all(x.get('method') in READ_ONLY for x in seen if not x.get('blocked')),
                   {'reads': sorted({x['path'].split('?')[0] for x in seen if x.get('path')}),
                    'blockedWrites': [f"{x['method']} {x['path']}" for x in blocked]})
        self.call('quit', app=app)
        self.call('script_tunnel', action='stop', **daily)
        # Last: failed logins make sshd hold off this client for a while
        # (PerSourcePenalties), which would refuse the checks after them.
        rejected = self.call('negative_auth')
        log = (self.lab / 'sshd.log').read_text(errors='replace')
        self.check('a wrong host key, an unknown key, a key from another address, each key on the other port, and '
                   'on the dedicated port the key only the AuthorizedKeysCommand supplies, are refused',
                   all(r['exitCode'] == 255 and r['expectedError'] for r in rejected.values()),
                   {**rejected, 'sshdLog': {
                       'notFromPermittedHost': log.count('but not from a permitted host'),
                       # How sshd 10.6 handles `AuthorizedKeysCommand none` in a Match block.
                       'commandPathNotAbsolute': log.count('AuthorizedKeysCommand path is not absolute'),
                       'acceptedFromCommand': log.count('found at /usr/bin/echo')}})

    def cleanup(self):
        if self.remote and self.remote.poll() is None:
            try:
                done = self.call('cleanup', app=self.app)
                self.check('the Mac run folder and any app data it created are removed',
                           done['labRemoved'] and done['ownedProcessesStopped'],
                           {'removedAppData': done['removedAppData']})
                (self.lab / 'mac-logs.json').write_text(json.dumps(done['logs'], indent=1))
            except Exception as error:
                self.check('Mac cleanup', False, str(error))
            self.remote.stdin.close()
            self.remote.wait(timeout=30)
        for name, proc in self.procs.items():
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        for relay in (getattr(self, 'relay', None), getattr(self, 'daily', None)):
            if relay:
                self.report.setdefault('relays', {})[str(relay.port)] = relay.requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--lab', required=True)
    p.add_argument('--report', required=True)
    p.add_argument('--core-release', required=True)
    p.add_argument('--mac', required=True)
    p.add_argument('--linux-host', required=True)
    p.add_argument('--dmg', required=True)
    p.add_argument('--expect-executable-sha256', required=True)
    p.add_argument('--sshd', default='/usr/bin/sshd')
    p.add_argument('--tunnel-script', help='another mac-tunnel.sh to check (default: this checkout\'s)')
    p.add_argument('--tunnel-checks-only', action='store_true',
                   help='stop after the SSH and tunnel script checks (no app, no daily Workspace)')
    for name, default in [('core-port', 4751), ('relay-port', 4752), ('ssh-port', 4753), ('decoy-port', 4754),
                          ('remote-probe-port', 4755), ('daily-relay-port', 4756), ('tunnel-port', 4758), ('daily-port', 4317),
                          ('mac-port', 5317), ('mac-daily-port', 5318), ('mac-probe-port', 5320)]:
        p.add_argument('--' + name, type=int, default=default)
    lab = Lab(p.parse_args())
    try:
        lab.run()
    except Exception as error:
        lab.check('the run completed', False, f'{type(error).__name__}: {error}')
    finally:
        lab.cleanup()
        lab.report['finishedAt'] = time.time()
        lab.report['passed'] = all(c['ok'] for c in lab.report['checks'])
        Path(lab.args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(lab.args.report).write_text(json.dumps(lab.report, indent=1))
        print('passed', lab.report['passed'])
    sys.exit(0 if lab.report['passed'] else 1)


if __name__ == '__main__':
    main()
