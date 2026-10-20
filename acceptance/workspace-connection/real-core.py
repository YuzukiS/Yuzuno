#!/usr/bin/env python3
"""Run the existing --live browser acceptance against a fresh, owned Core only.

Reuse the existing T-5 lab binary; no Cargo, Harness, native window or daily writes.
The deliberately absent Codex path exercises real catalog failure while Core's
actual HTTP/SSE endpoints and the isolated production UI remain available.
"""
import hashlib
import json
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import os

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
BINARY = (Path.home() / 'yuzuno-next/.claude/worktrees/machine-checks/target/debug/yuzuno-workspace')
DIST = ROOT / 'target/workspace-connection-dist'
PORT = 4392
BASE = f'http://127.0.0.1:{PORT}'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def read(path):
    with opener.open(BASE + '/api' + path, timeout=3) as response:
        return json.load(response)

def run():
    assert BINARY.is_file() and (DIST/'index.html').is_file()
    # Core also binds before touching SQLite, protecting a concurrently occupied port.
    with socket.socket() as check:
        check.bind(('127.0.0.1', PORT))
    folder = Path(tempfile.mkdtemp(prefix='real-core-', dir=LAB))
    tasks = folder/'tasks'; tasks.mkdir()
    unavailable = folder/'codex-not-installed-for-this-check'
    assert not unavailable.exists()
    argv = [str(BINARY), '--port', str(PORT), '--data-dir', str(folder/'core-data'),
            '--web-dir', str(DIST), '--cwd', str(tasks), '--codex', str(unavailable)]
    report = {'base': BASE, 'folder': str(folder), 'binary': str(BINARY),
              'binarySha256': hashlib.sha256(BINARY.read_bytes()).hexdigest(),
              'argv': argv, 'mode': 'real Core HTTP/SSE, read-only browser, no Harness'}
    with (folder/'core.log').open('wb') as log:
        core = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    report['pid'] = core.pid
    try:
        deadline = time.monotonic() + 10
        while True:
            assert core.poll() is None, 'Owned Core exited; inspect core.log'
            try:
                health, workspace = read('/health'), read('/workspace')
                if workspace['runtime'].get('error'): break
            except OSError:
                pass
            if time.monotonic() > deadline: raise TimeoutError('Isolated Core did not become ready')
            time.sleep(.1)
        assert health['application'] == 'yuzuno-next'
        assert workspace['agents'] == []
        assert workspace['runtime']['connected'] is False
        report['health'] = health
        report['catalogFailure'] = workspace['runtime']
        env = {**os.environ, 'YUZUNO_CORE_URL': BASE,
               'YUZUNO_BROWSER_BIN': '/usr/sbin/chromium',
               'YUZUNO_BROWSER_OUTPUT': str(folder/'browser')}
        with (folder/'browser.log').open('wb') as output:
            result = subprocess.run(['npm', 'run', 'test:browser', '--', '--live'],
                                    cwd=ROOT/'web', env=env, stdout=output, stderr=subprocess.STDOUT, timeout=90)
        report['browserExitCode'] = result.returncode
        report['browser'] = json.loads((folder/'browser/real-core-report.json').read_text())
        assert result.returncode == 0 and report['browser']['status'] == 'passed'
        assert read('/workspace')['agents'] == [], 'Read-only test must not create Agents'
        report['passed'] = True
    finally:
        # Signal only the child created above, never a discovered/shared PID.
        if core.poll() is None: core.send_signal(signal.SIGINT)
        report['coreExitCode'] = core.wait(timeout=10)
        report['ownedCoreStopped'] = True
        (LAB/'real-core-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__': run()
