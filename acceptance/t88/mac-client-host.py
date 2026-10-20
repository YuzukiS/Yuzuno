#!/usr/bin/env python3
"""Disposable Mac browser/tunnel owner, controlled by JSON lines over SSH.

No daemon, global configuration, copied credential, or package installation.
EOF, signals and a fixed lifetime all clean up only this process's children.
"""
import json
import errno
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

lab = None  # Created only by main; imports are safe for transport-probe tests.
children = {}
config = {}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)


def start(name, argv):
    if name in children:
        raise ValueError('Process already owned: ' + name)
    with (lab / (name + '.log')).open('ab') as log:
        children[name] = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                                          stderr=log, start_new_session=True)
    return children[name]


def fetch(path, headers=None, data=None):
    request = urllib.request.Request(path, headers=headers or {}, data=data)
    with opener.open(request, timeout=3) as response:
        return response.read()


def ready(name, url):
    end = time.monotonic() + 25
    while time.monotonic() < end:
        if children[name].poll() is not None:
            raise RuntimeError(name + ' exited: ' + (lab / (name + '.log')).read_text()[-1500:])
        try:
            return json.loads(fetch(url))
        except (OSError, ValueError):
            time.sleep(.2)
    raise TimeoutError(name + ' did not become ready')


def free(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))


def tcp_reachability(host, port, timeout=3):
    """An HTTP rejection is still a reachable port; test TCP itself.

    Unexpected local errors remain errors, never successful isolation evidence.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {'transport': 'tcp', 'reachable': True}
    except (socket.timeout, TimeoutError) as error:
        return {'transport': 'tcp', 'reachable': False, 'reason': 'timeout', 'errno': error.errno}
    except OSError as error:
        if error.errno not in (errno.ECONNREFUSED, errno.ETIMEDOUT, errno.EHOSTUNREACH, errno.ENETUNREACH):
            raise
        return {'transport': 'tcp', 'reachable': False, 'reason': type(error).__name__, 'errno': error.errno}


def ssh(key='client', known='known_hosts'):
    return ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(lab/key), '-o', 'IdentityAgent=none',
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'UserKnownHostsFile=' + str(lab/known), '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
            '-p', str(config['sshPort'])]


def action(message):
    op = message['op']
    if op == 'init':
        if platform.system() != 'Darwin':
            raise ValueError('This runner requires the explicitly authorized Mac')
        for key in ('client', 'wrong'):
            subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
                            '-C', 't88-disposable', '-f', str(lab/key)], check=True)
        return {'lab': str(lab), 'publicKey': (lab/'client.pub').read_text().strip(),
                'system': platform.system(), 'architecture': platform.machine(),
                'osVersion': subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'], text=True).strip(),
                'chrome': subprocess.check_output(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--version'], text=True).strip(),
                'ssh': subprocess.run(['/usr/bin/ssh', '-V'], capture_output=True, text=True).stderr.strip()}
    if op == 'configure':
        config.update(message['config'])
        for port in (config['localPort'], config['cdpPort']):
            free(port)
        (lab/'known_hosts').write_text(f"[{config['host']}]:{config['sshPort']} {config['hostKey']}\n")
        # A wrong public host key, distinct from the real server's key.
        (lab/'wrong_hosts').write_text(f"[{config['host']}]:{config['sshPort']} {(lab/'wrong.pub').read_text()}")
        return {'configured': True}
    if op == 'negative_auth':
        result = {}
        for label, key, known, marker in [('wrongHost', 'client', 'wrong_hosts', 'Host key verification failed'),
                                        ('wrongIdentity', 'wrong', 'known_hosts', 'Permission denied')]:
            run = subprocess.run(ssh(key, known) + [config['user']+'@'+config['host'], 'true'],
                                 capture_output=True, text=True, timeout=15)
            result[label] = {'exitCode': run.returncode, 'expectedError': marker in run.stderr}
        return result
    if op == 'tunnel_start':
        free(config['localPort'])
        argv = ssh() + ['-N', '-L', f"127.0.0.1:{config['localPort']}:127.0.0.1:{config['corePort']}",
                        config['user']+'@'+config['host']]
        child = start('tunnel', argv)
        health = ready('tunnel', f"http://127.0.0.1:{config['localPort']}/api/health")
        return {'pid': child.pid, 'health': health, 'argv': argv}
    if op == 'tunnel_stop':
        stop('tunnel')
        free(config['localPort'])
        return {'stopped': True}
    if op == 'browser_start':
        free(config['cdpPort'])
        argv = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new',
                '--user-data-dir='+str(lab/'profile'), '--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port='+str(config['cdpPort']), '--no-first-run',
                '--no-default-browser-check', '--disable-sync', 'about:blank']
        child = start('browser', argv)
        version = ready('browser', f"http://127.0.0.1:{config['cdpPort']}/json/version")
        return {'pid': child.pid, 'version': version, 'argv': argv}
    if op == 'browser_stop':
        stop('browser')
        free(config['cdpPort'])
        return {'stopped': True}
    if op == 'guards':
        base = f"http://127.0.0.1:{config['localPort']}"
        statuses = {}
        for label, path, headers, data in [
            ('foreignOrigin', '/api/projects', {'Origin':'https://example.invalid','x-yuzuno-client':'desktop','Content-Type':'application/json'}, b'{}'),
            ('wrongLocalOrigin', '/api/projects', {'Origin':f"http://127.0.0.1:{config['corePort']}",'x-yuzuno-client':'desktop','Content-Type':'application/json'}, b'{}'),
            ('missingHeader', '/api/projects', {'Origin':base,'Content-Type':'application/json'}, b'{}'),
            ('foreignHost', '/api/health', {'Host':'example.invalid'}, None),
        ]:
            try:
                fetch(base+path, headers, data)
                statuses[label] = 200
            except urllib.error.HTTPError as error:
                statuses[label] = error.code
                error.close()
        return {'httpStatuses': statuses,
                'directCore': tcp_reachability(config['host'], config['corePort'])}
    if op == 'cleanup':
        stop('browser')
        stop('tunnel')
        for port in (config.get('localPort'), config.get('cdpPort')):
            if port:
                free(port)
        shutil.rmtree(lab)
        return {'removedTemporaryDirectory': not lab.exists(), 'ownedProcessesStopped': not children}
    raise ValueError('Unknown operation: ' + op)


def interrupted(signum, frame):
    raise KeyboardInterrupt('signal ' + str(signum))


def main():
    global lab
    lab = Path(tempfile.mkdtemp(prefix='yuzuno-t88-mac-'))
    os.chmod(lab, 0o700)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(900)
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                result = action(message)
                print(json.dumps({'ok': True, 'result': result}), flush=True)
                if message['op'] == 'cleanup':
                    break
            except Exception as error:
                print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
    finally:
        stop('browser')
        stop('tunnel')
        if lab.exists():
            shutil.rmtree(lab)


if __name__ == '__main__':
    main()
