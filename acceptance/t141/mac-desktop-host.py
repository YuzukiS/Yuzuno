#!/usr/bin/env python3
"""The Mac side of acceptance/t141/mac-desktop-lab.py, controlled by JSON lines
over SSH (one request per line, one reply per line).

It owns a fresh lab folder under ~/yuzuno-t141-lab/net/, a disposable SSH key
made here (its private half never leaves the Mac), the tunnels it starts and
the Yuzuno app copies it installs into the lab folder. It changes no global
SSH, launchd or privacy setting and installs nothing outside the lab folder.

Before it writes anything it refuses a Mac that has a Yuzuno app installed or
running, any of the app's data folders or its defaults file (a lab copy would
share them: they are keyed by the bundle identifier), or anything answering on
127.0.0.1:4317 (where an app with no saved Core goes). At cleanup it removes
only what this run made and nothing else changed since: the data folders and
defaults file its own app created, its lab folder, and the lab's parent
folders if it made them and they are empty. Anything else is kept and named
with the reason, and a removal that fails is reported. EOF, signals and a
fixed lifetime apply the same cleanup.

  --inspect             prints the state those checks read and writes nothing
  --remove-new BEFORE   after a person opened a downloaded copy themselves:
                        removes the data folders and defaults file that BEFORE
                        (an --inspect record with no problems; - reads it from
                        stdin) shows absent, only while no Yuzuno app runs
"""
import errno
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BUNDLE = 'dev.yuzuno.workspace'
LIBRARY = Path.home() / 'Library'
APP_DATA = [LIBRARY / 'Application Support' / BUNDLE, LIBRARY / 'WebKit' / BUNDLE, LIBRARY / 'Caches' / BUNDLE,
            LIBRARY / 'HTTPStorages' / BUNDLE, LIBRARY / 'Saved Application State' / (BUNDLE + '.savedState')]
# The app's user defaults, written at its first launch. The preferences service
# saves it by replacing the file, so it is this run's only if it was absent at
# the start and was recorded while only this run's app had run.
PREFS = LIBRARY / 'Preferences' / (BUNDLE + '.plist')
APPS = [Path('/Applications/Yuzuno.app'), Path.home() / 'Applications' / 'Yuzuno.app']
EXECUTABLE = 'Contents/MacOS/yuzuno-desktop'
# The Core an app with none saved and none given opens.
DEFAULT_CORE_PORT = 4317
ROOTS = [Path.home() / 'yuzuno-t141-lab', Path.home() / 'yuzuno-t141-lab' / 'net']
# How long after removing the defaults file it is looked at again. Absent then
# is all that is claimed: the preferences service may still hold the values.
RECHECK_SECONDS = float(os.environ.get('YUZUNO_MAC_RECHECK', '2'))
lab = None
children = {}
config = {}
existed = {}
roots_existed = {}
# What this run's own app made: data folders by identity (device, inode, birth
# time) and the defaults file as last seen after the app quit.
created = {}
prefs_record = None
app_launched = False
installed_app = None
foreign_seen = []
cleaned = None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def stop(name):
    child = children.pop(name, None)
    if child and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)


def start(name, argv):
    if name in children:
        raise ValueError('Process already owned: ' + name)
    with (lab / (name + '.log')).open('ab') as log:
        children[name] = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                          start_new_session=True)
    return children[name]


def free(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))


def health(port, seconds=25, name=None):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if name and children[name].poll() is not None:
            raise RuntimeError(name + ' exited: ' + (lab / (name + '.log')).read_text()[-1500:])
        try:
            with opener.open(f'http://127.0.0.1:{port}/api/health', timeout=3) as response:
                return json.loads(response.read())
        except (OSError, ValueError):
            time.sleep(.2)
    raise TimeoutError(f'no Core health on 127.0.0.1:{port}')


def ssh(key='client', known='known_hosts', *extra, port=None):
    return ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(lab / key), '-o', 'IdentityAgent=none',
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'UserKnownHostsFile=' + str(lab / known), '-o', 'ServerAliveInterval=5',
            '-o', 'ServerAliveCountMax=2', '-p', str(port or config['sshPort']), *extra]


def target():
    return config['user'] + '@' + config['host']


def run(argv, timeout=20, **kw):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, **kw)
    except subprocess.TimeoutExpired as expired:
        # Still running when it should have been refused: never a pass.
        return {'exitCode': None, 'timedOut': True, 'stderr': str(expired.stderr or '')[-900:]}
    return {'exitCode': done.returncode, 'stdout': done.stdout[-600:], 'stderr': done.stderr[-900:]}


def connect_probe(port, socks_port=None):
    """A TCP connection to 127.0.0.1:<port> on the Mac (through a forward):
    how many bytes came back. With socks_port, a SOCKS5 CONNECT to it."""
    result = {}
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=4) as conn:
            conn.settimeout(4)
            if socks_port:
                conn.sendall(b'\x05\x01\x00')
                conn.recv(2)
                conn.sendall(b'\x05\x01\x00\x01\x7f\x00\x00\x01' + socks_port.to_bytes(2, 'big'))
                reply = conn.recv(10)
                result['socksReply'] = reply[1] if len(reply) > 1 else None
            conn.sendall(b'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t141-probe\r\n'
                         b'Connection: close\r\n\r\n')
            try:
                result['bytesBack'] = len(conn.recv(4096))
            except (socket.timeout, ConnectionResetError):
                result['bytesBack'] = 0
    except OSError as error:
        result['connectError'] = error.errno
    return result


def tunnel_env(message):
    env = {'HOME': str(Path.home()), 'USER': config['user'], 'PATH': '/usr/bin:/bin', 'TMPDIR': str(lab),
           'YUZUNO_TUNNEL_HOST': config['host'], 'YUZUNO_TUNNEL_SSH_PORT': str(message['port']),
           'YUZUNO_TUNNEL_KEY': str(lab / message['key']), 'YUZUNO_TUNNEL_KNOWN_HOSTS': str(lab / 'known_hosts'),
           'YUZUNO_TUNNEL_LOCAL_PORT': str(message['localPort']),
           'YUZUNO_TUNNEL_CORE_PORT': str(message['remotePort'])}
    if message.get('stateDir'):
        env['YUZUNO_TUNNEL_STATE_DIR'] = message['stateDir']
    return env


OCCUPY = '''
import http.server, json, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'workspaceId': 'not-the-lab-core'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
'''


def app_pids(app):
    exe = str(app / 'Contents' / 'MacOS')
    done = subprocess.run(['/usr/bin/pgrep', '-f', exe], capture_output=True, text=True)
    return [int(p) for p in done.stdout.split()]


def processes():
    """(pid, executable) of every process; macOS's ps names the full path."""
    out = subprocess.run(['/bin/ps', '-axo', 'pid=,comm='], capture_output=True, text=True).stdout
    found = []
    for line in out.splitlines():
        pid, _, path = line.strip().partition(' ')
        if pid.isdigit():
            found.append((int(pid), path.strip()))
    return found


def yuzuno_processes():
    return [{'pid': pid, 'path': path} for pid, path in processes() if path.endswith('/' + EXECUTABLE)]


def other_apps():
    """Running Yuzuno apps that are not this run's copy: they share its data."""
    found = [p for p in yuzuno_processes() if not (lab and p['path'].startswith(str(lab) + '/'))]
    foreign_seen.extend(found)
    return found


def identity(path):
    st = os.stat(path)
    return [st.st_dev, st.st_ino, getattr(st, 'st_birthtime', None)]


def prefs_now():
    """The defaults file: None if absent, else its content's SHA-256 and identity."""
    if not (PREFS.exists() or PREFS.is_symlink()):
        return None
    if PREFS.is_symlink() or not PREFS.is_file():
        return {'notAFile': True}
    return {'sha256': sha256(PREFS), 'identity': identity(PREFS)}


def port_answers(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            return True
    except OSError:
        return False


def state():
    """What a run must not find, touch or leave behind. Reads only."""
    return {'apps': {str(p): p.exists() for p in APPS},
            'running': yuzuno_processes(),
            'appData': {str(p): identity(p) if p.exists() else None for p in APP_DATA},
            'prefs': prefs_now(),
            'roots': {str(p): p.exists() for p in ROOTS},
            'defaultCoreAnswers': port_answers(DEFAULT_CORE_PORT)}


def problems(found):
    said = [f'{p} is installed' for p, there in found['apps'].items() if there]
    said += [f"a Yuzuno app runs (process {p['pid']}, {p['path']})" for p in found['running']]
    said += [f'{p} exists' for p, ident in found['appData'].items() if ident]
    if found['prefs']:
        said.append(f'{PREFS} exists')
    if found['defaultCoreAnswers']:
        said.append(f'something answers on 127.0.0.1:{DEFAULT_CORE_PORT}, which an app with no saved Core opens')
    return said


def prepare():
    """Checks this Mac before anything is written. With no problem, makes this
    run's lab folder and records which of its parents existed."""
    global lab
    before = state()
    refused = problems(before)
    if refused:
        return before, refused
    existed.update({p: bool(ident) for p, ident in before['appData'].items()})
    roots_existed.update(before['roots'])
    ROOTS[-1].mkdir(parents=True, exist_ok=True)
    lab = ROOTS[-1] / time.strftime('run-%Y%m%dT%H%M%S')
    lab.mkdir(mode=0o700)
    return before, []


def mark_created(after_quit=True):
    """Records what this run's app made: data folders absent at the start, by
    identity, and the defaults file after the app quit. Nothing is recorded
    before this run launched its app or once another Yuzuno app was seen, and
    cleanup never replaces an earlier record, so a later change stays visible."""
    global prefs_record
    if foreign_seen or not app_launched:
        return
    for path in APP_DATA:
        if not existed.get(str(path), True) and path.exists() and str(path) not in created:
            created[str(path)] = identity(path)
    now = prefs_now()
    if now and not now.get('notAFile') and (after_quit or prefs_record is None):
        prefs_record = now


def remove(path, how, result):
    try:
        how(path)
        result['removed'].append(str(path))
    except OSError as error:
        result['failed'].append({'path': str(path), 'error': f'{type(error).__name__}: {error}'})


def remove_owned(app):
    """Removes only what this run made and nothing changed since. Anything
    else is kept with the reason; a failed removal is reported, not raised."""
    ours = app_pids(Path(app)) if app else []
    other_apps()
    mark_created(after_quit=False)
    blocked = (f"this run's app still runs (processes {ours})" if ours
               else 'another Yuzuno app ran during this run' if foreign_seen else None)
    result = {'removed': [], 'kept': [], 'failed': []}
    for path in APP_DATA:
        if not path.exists() or existed.get(str(path), True):
            continue
        if str(path) not in created:
            result['kept'].append({'path': str(path), 'reason': "it appeared, but never as this run's app's"})
        elif blocked or identity(path) != created[str(path)]:
            result['kept'].append({'path': str(path),
                                   'reason': blocked or "it is no longer the folder this run's app made"})
        else:
            remove(path, shutil.rmtree, result)
    now = prefs_now()
    if now:
        if blocked or prefs_record is None:
            result['kept'].append({'path': str(PREFS), 'reason': blocked or "this run never recorded it as its app's"})
        elif now != prefs_record:
            result['kept'].append({'path': str(PREFS), 'reason': 'it changed after this run last recorded it'})
        else:
            remove(PREFS, Path.unlink, result)
    if lab and lab.exists():
        remove(lab, shutil.rmtree, result)
    for root in reversed(ROOTS):
        if not roots_existed.get(str(root), True) and root.exists():
            try:
                root.rmdir()
                result['removed'].append(str(root))
            except OSError as error:
                result['kept'].append({'path': str(root), 'reason': 'something else is in it' if error.errno in (
                    errno.ENOTEMPTY, errno.EEXIST) else f'{type(error).__name__}: {error}'})
    time.sleep(RECHECK_SECONDS)
    result['recheckSeconds'] = RECHECK_SECONDS
    result['after'] = state()
    return result


def remove_new(before):
    """For a copy a person opened: the data folders and defaults file BEFORE
    shows absent, removed only while no Yuzuno app runs. Without a record made
    while the app ran, it cannot tell whether something else wrote to them."""
    result = {'removed': [], 'kept': [], 'failed': []}
    if before.get('problems') or problems(before):
        raise ValueError('the before record is not of a clean Mac: ' + '; '.join(problems(before)))
    running = yuzuno_processes()
    if running:
        raise ValueError(f'a Yuzuno app still runs ({running}); quit it, then run this again')
    for path in APP_DATA:
        if before['appData'].get(str(path)) is None and path.exists():
            remove(path, shutil.rmtree, result)
    if before['prefs'] is None and prefs_now():
        remove(PREFS, Path.unlink, result)
    time.sleep(RECHECK_SECONDS)
    result['recheckSeconds'] = RECHECK_SECONDS
    result['after'] = state()
    return result


def action(message):
    op = message['op']
    if op == 'init':
        if platform.system() != 'Darwin':
            raise ValueError('This runner requires the authorized Mac')
        # client: the key line; tunnel: the dedicated port; command: supplied
        # only by the server's AuthorizedKeysCommand; elsewhere: its line names
        # another source address; wrong: authorized nowhere.
        for key in ('client', 'tunnel', 'command', 'elsewhere', 'wrong'):
            subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 't141-disposable',
                            '-f', str(lab / key)], check=True)
        return {'lab': str(lab), 'prefsBefore': None,
                'keys': {k: (lab / (k + '.pub')).read_text().strip() for k in ('client', 'tunnel', 'command', 'elsewhere')},
                # This Mac's address on the network the Linux host reached it by.
                'address': os.environ['SSH_CONNECTION'].split()[2],
                'system': platform.system(), 'architecture': platform.machine(),
                'osVersion': subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'], text=True).strip(),
                'osBuild': subprocess.check_output(['/usr/bin/sw_vers', '-buildVersion'], text=True).strip(),
                'ssh': subprocess.run(['/usr/bin/ssh', '-V'], capture_output=True, text=True).stderr.strip(),
                'appDataBefore': existed}
    if op == 'configure':
        config.update(message['config'])
        (lab / 'known_hosts').write_text(''.join(f"[{config['host']}]:{port} {config['hostKey']}\n"
                                                  for port in (config['sshPort'], config['tunnelPort'])))
        (lab / 'wrong_hosts').write_text(f"[{config['host']}]:{config['sshPort']} {(lab / 'wrong.pub').read_text()}")
        return {'configured': True}
    if op == 'negative_auth':
        result = {}
        for label, key, known, port, marker in [
                ('wrongHost', 'client', 'wrong_hosts', config['sshPort'], 'Host key verification failed'),
                ('wrongIdentity', 'wrong', 'known_hosts', config['sshPort'], 'Permission denied'),
                ('fromAnotherAddress', 'elsewhere', 'known_hosts', config['sshPort'], 'Permission denied'),
                # AuthorizedKeysCommand none on the dedicated port.
                ('commandKeyOnTunnelPort', 'command', 'known_hosts', config['tunnelPort'], 'Permission denied'),
                # The dedicated port's key is not authorized on the other port.
                ('tunnelKeyOnOtherPort', 'tunnel', 'known_hosts', config['sshPort'], 'Permission denied'),
                ('otherKeyOnTunnelPort', 'client', 'known_hosts', config['tunnelPort'], 'Permission denied')]:
            done = run(ssh(key, known, port=port) + [target(), 'true'])
            result[label] = {'exitCode': done['exitCode'], 'expectedError': marker in done['stderr']}
        return result
    if op == 'session':
        # A command, a shell or the sftp subsystem: what the server ran instead.
        key, port, marker = message['key'], message['port'], message['marker']
        base = ssh(key, 'known_hosts', port=port)
        if message['kind'] == 'exec':
            return run(base + [target(), 'touch ' + marker])
        if message['kind'] == 'shell':
            # A shell request (no PTY, so input is piped to whatever runs).
            return run(base + [target()], input='touch ' + marker + '\nexit\n')
        return run(['/usr/bin/sftp', '-b', '-', '-F', '/dev/null', '-i', str(lab / key), '-o', 'IdentityAgent=none',
                    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UserKnownHostsFile=' + str(lab / 'known_hosts'),
                    '-P', str(port), target()], input='ls\n')
    if op == 'forward_start':
        # ssh -N with one -L/-R/-D; whether it is still up a moment later.
        name = 'forward-' + message['name']
        if message['flag'] in ('-L', '-D') and message.get('localPort'):
            free(message['localPort'])
        child = start(name, ssh(message['key'], 'known_hosts', '-v', '-N', '-o', 'ExitOnForwardFailure=yes',
                                message['flag'], message['spec'], port=message['port']) + [target()])
        time.sleep(3)
        return {'alive': child.poll() is None, 'exitCode': child.poll()}
    if op == 'forward_probe':
        return connect_probe(message['localPort'], message.get('socksPort'))
    if op == 'forward_stop':
        name = 'forward-' + message['name']
        stop(name)
        log = (lab / (name + '.log')).read_text(errors='replace')
        return {'prohibited': 'administratively prohibited' in log or 'open failed' in log,
                'remoteRefused': 'remote port forwarding failed' in log, 'logTail': log[-700:]}
    if op == 'put_script':
        (lab / 'mac-tunnel.sh').write_text(message['text'])
        return {'sha256': sha256(lab / 'mac-tunnel.sh')}
    if op in ('script_tunnel', 'script_tunnel_pair'):
        # scripts/mac-tunnel.sh as a person would run it, with this run's key,
        # pinned host key and ports. Its state folder defaults to this run's.
        env = tunnel_env(message)
        argv = ['/bin/sh', str(lab / 'mac-tunnel.sh'), message['action']]
        if op == 'script_tunnel_pair':
            # Two at once, as two Terminal windows would.
            both = [subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True) for _ in range(2)]
            return [dict(zip(('stdout', 'stderr'), p.communicate(timeout=40)), exitCode=p.returncode) for p in both]
        done = run(argv, timeout=40, env=env)
        if done['exitCode'] == 0 and message['action'] in ('start', 'status'):
            try:
                done['health'] = health(message['localPort'], seconds=5)
            except TimeoutError as error:
                done['health'] = {'error': str(error)}
        return done
    if op == 'forwards':
        # ssh processes forwarding this local port, whichever started them.
        done = subprocess.run(['/usr/bin/pgrep', '-f', f"127.0.0.1:{message['localPort']}:127.0.0.1:"],
                              capture_output=True, text=True)
        return {'pids': [int(p) for p in done.stdout.split()]}
    if op == 'unrelated':
        # A process of this run that no tunnel owns, named in the earlier
        # script's process ID file ($TMPDIR/yuzuno-tunnel-<port>.pid).
        name = 'unrelated-' + str(message['localPort'])
        child = start(name, ['/bin/sleep', '600'])
        (lab / f"yuzuno-tunnel-{message['localPort']}.pid").write_text(f'{child.pid}\n')
        return {'name': name, 'pid': child.pid}
    if op == 'alive':
        child = children.get(message['name'])
        return {'alive': bool(child and child.poll() is None)}
    if op == 'release':
        stop(message['name'])
        return {'stopped': message['name']}
    if op == 'occupy':
        # Another service on the local port that answers like a Core.
        name = 'occupy-' + str(message['port'])
        start(name, [sys.executable, '-c', OCCUPY, str(message['port'])])
        health(message['port'], seconds=10, name=name)
        return {'name': name}
    if op == 'stale':
        # What a tunnel that ended without stop leaves: a control socket path
        # that is no socket, and a record for another Core.
        state = lab / 'yuzuno-tunnel'
        state.mkdir(mode=0o700, exist_ok=True)
        (state / f"{message['localPort']}.ssh").write_text('')
        (state / f"{message['localPort']}.target").write_text('someone@elsewhere port 22 to Core port 1\n')
        return {'state': sorted(os.listdir(state))}
    if op == 'state_files':
        state = Path(message.get('stateDir') or lab / 'yuzuno-tunnel')
        return {'exists': state.exists(), 'files': sorted(os.listdir(state)) if state.is_dir() else None}
    if op == 'open_folder':
        path = lab / message['name']
        path.mkdir()
        os.chmod(path, 0o755)
        return {'path': str(path)}
    if op == 'tunnel_start':
        local, remote = message['localPort'], message['remotePort']
        free(local)
        argv = ssh(message.get('key', 'client'), 'known_hosts', '-N', '-o', 'ExitOnForwardFailure=yes', '-L',
                   f'127.0.0.1:{local}:127.0.0.1:{remote}', port=message.get('port')) + [target()]
        name = 'tunnel-' + str(local)
        child = start(name, argv)
        return {'pid': child.pid, 'health': health(local, name=name), 'argv': argv}
    if op == 'tunnel_stop':
        stop('tunnel-' + str(message['localPort']))
        free(message['localPort'])
        return {'stopped': True}
    if op == 'install':
        dmg = Path(message['dmg']).expanduser()
        into = lab / 'Applications'
        mount = lab / 'mnt'
        into.mkdir(exist_ok=True)
        mount.mkdir(exist_ok=True)
        attach = run(['/usr/bin/hdiutil', 'attach', '-nobrowse', '-readonly', '-noautoopen',
                      '-mountpoint', str(mount), str(dmg)], timeout=60)
        if attach['exitCode'] != 0:
            raise RuntimeError('hdiutil attach: ' + attach['stderr'])
        try:
            listing = sorted(os.listdir(mount))
            copied = run(['/usr/bin/ditto', str(mount / 'Yuzuno.app'), str(into / 'Yuzuno.app')], timeout=60)
        finally:
            detach = run(['/usr/bin/hdiutil', 'detach', str(mount)], timeout=60)
        app = into / 'Yuzuno.app'
        global installed_app
        installed_app = str(app)
        info = json.loads(subprocess.check_output(['/usr/bin/plutil', '-convert', 'json', '-o', '-',
                                                   str(app / 'Contents' / 'Info.plist')]))
        return {'dmgSha256': sha256(dmg), 'dmgListing': listing, 'copy': copied['exitCode'],
                'detach': detach['exitCode'], 'app': str(app),
                'executableSha256': sha256(app / 'Contents' / 'MacOS' / info['CFBundleExecutable']),
                'bundleIdentifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString'],
                'quarantine': run(['/usr/bin/xattr', '-p', 'com.apple.quarantine', str(app)])['exitCode'] == 0,
                'verify': run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])}
    if op == 'launch':
        global app_launched
        app = Path(message['app'])
        other_apps()
        app_launched = True
        before = app_pids(app)
        argv = ['/usr/bin/open', '-n', '-a', str(app)]
        if message.get('args'):
            argv += ['--args', *message['args']]
        opened = run(argv, timeout=30)
        end = time.monotonic() + 20
        pids = []
        while time.monotonic() < end:
            pids = [p for p in app_pids(app) if p not in before]
            if pids:
                break
            time.sleep(.3)
        return {'open': opened, 'pids': pids}
    if op == 'running':
        return {'pids': app_pids(Path(message['app']))}
    if op == 'quit':
        app = Path(message['app'])
        pids = app_pids(app)
        for pid in pids:
            os.kill(pid, signal.SIGTERM)
        end = time.monotonic() + 15
        while time.monotonic() < end and app_pids(app):
            time.sleep(.3)
        other_apps()
        mark_created()
        return {'signalled': pids, 'left': app_pids(app)}
    if op == 'saved_core':
        path = APP_DATA[0] / 'core.json'
        return {'path': str(path), 'exists': path.exists(),
                'record': json.loads(path.read_text()) if path.exists() else None}
    if op == 'snapshot':
        # Reads only: what is there before cleanup removes anything, so the
        # Linux side keeps it first.
        return {'state': state(), 'created': created, 'prefsRecord': prefs_record, 'otherAppsSeen': foreign_seen,
                'labFiles': sorted(str(p.relative_to(lab)) for p in lab.rglob('*')),
                'logs': {name: (lab / name).read_text(errors='replace')[-4000:] for name in sorted(os.listdir(lab))
                         if name.endswith('.log')}}
    if op == 'cleanup':
        global cleaned
        app = message.get('app') or installed_app
        stop_all(app)
        cleaned = remove_owned(app)
        return {**cleaned, 'labRemoved': not lab.exists(), 'ownedProcessesStopped': not children}
    raise ValueError('Unknown operation: ' + op)


def stop_all(app):
    if app:
        for pid in app_pids(Path(app)):
            os.kill(pid, signal.SIGTERM)
        time.sleep(2)
        for pid in app_pids(Path(app)):
            os.kill(pid, signal.SIGKILL)
    for name in list(children):
        stop(name)
    # Tunnels scripts/mac-tunnel.sh started in the background, and anything
    # else run from this folder.
    subprocess.run(['/usr/bin/pkill', '-f', str(lab)], capture_output=True)
    time.sleep(1)


def interrupted(signum, frame):
    raise KeyboardInterrupt('signal ' + str(signum))


def main():
    if sys.argv[1:] == ['--inspect']:
        found = state()
        print(json.dumps({**found, 'problems': problems(found)}))
        return
    if sys.argv[1:2] == ['--remove-new'] and len(sys.argv) == 3:
        record = sys.stdin.read() if sys.argv[2] == '-' else Path(sys.argv[2]).read_text()
        print(json.dumps(remove_new(json.loads(record))))
        return
    before, refused = prepare()
    if refused:
        # Nothing was written on this Mac. Every request gets the refusal.
        for _ in sys.stdin:
            print(json.dumps({'ok': False, 'error': 'refused before writing anything on this Mac: '
                              + '; '.join(refused), 'state': before}), flush=True)
        return
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(1500)
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                print(json.dumps({'ok': True, 'result': action(message)}), flush=True)
                if message['op'] == 'cleanup':
                    break
            except Exception as error:
                print(json.dumps({'ok': False, 'error': f'{type(error).__name__}: {error}'}), flush=True)
    finally:
        if cleaned is None:
            # Ended without a cleanup request (EOF, a signal, the lifetime): the
            # same rules, and the result for whoever still reads.
            stop_all(installed_app)
            result = remove_owned(installed_app)
            try:
                print(json.dumps({'ok': False, 'error': 'ended without a cleanup request', 'cleanup': result}),
                      flush=True)
            except (OSError, ValueError):
                pass


if __name__ == '__main__':
    main()
