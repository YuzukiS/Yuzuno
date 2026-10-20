#!/usr/bin/env python3
"""T-13 desktop update lab: a lab Core relays lab-signed desktop releases.

Relay half (always): starts a new managed Core under the project target/
from a T-12 bundle. Its release source's `gh` is a local fixture that serves
`desktop-<version>` releases from --feed: one folder per release, as
`scripts/desktop.ps1 -Bundle -Lab` stages them. It then probes the
manifest and installer routes the way the desktop calls them.

Windows half (--windows, run only once the lab install has been approved):
- Installs Yuzuno Lab (the oldest feed release) with desktop/tests/update-lab.ps1.
- Opens it on the lab Core with a test-only DevTools port.
- First serves the newest release under a wrong signature, and checks the window
  refuses it.
- Then installs it for real from the window, and checks the restarted window.
- Checks a real unsent draft and the changed native frame, then keeps B and
  the same Lab Core available for inspection. No rollback or uninstall.

Never publishes a release, uses 4317 or a daily window, or starts a model.
A scripted Codex protocol fixture supplies a real editable Agent conversation.
Run inside heavy-slot and a memory-limited scope.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
spec = importlib.util.spec_from_file_location('updates_acceptance', REPO / 'tools/updates-acceptance.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)

TARGET = 'windows-x86_64'
INSTALLER = f'yuzuno-desktop-{TARGET}-setup.exe'
REPOSITORY = 'YuzukiS/Yuzuno'


def version_key(name):
    return tuple(int(part) for part in name.removeprefix('desktop-').split('.'))


def sha256(path):
    with open(path, 'rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def get(port, path, host=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
    connection.request('GET', path, headers={'Host': host or f'127.0.0.1:{port}'})
    response = connection.getresponse()
    return response.status, dict(response.getheaders()), response.read()


def write_fixture(root, feed):
    """gh stand-in: lists the feed's releases and streams their assets. With
    `<root>/feed-mode` = wrong-signature, the newest release carries the oldest
    release's signature: valid for the lab key, but not for these bytes."""
    releases = sorted((p for p in feed.iterdir() if p.is_dir()), key=lambda p: version_key(p.name))
    assets, listing = {}, []
    for day, release in enumerate(releases, 1):
        files = []
        for name in (INSTALLER, INSTALLER + '.sig'):
            asset_id = str(len(assets) + 1)
            assets[asset_id] = str(release / name)
            files.append({'id': int(asset_id), 'name': name, 'state': 'uploaded',
                          'size': (release / name).stat().st_size})
        listing.append({'tag_name': release.name, 'draft': False, 'prerelease': False,
                        'published_at': f'2026-10-{day:02d}T00:00:00Z',
                        'body': f'Yuzuno Lab {release.name.removeprefix("desktop-")}', 'assets': files})
    swap = {assets[str(len(assets))]: str(releases[0] / (INSTALLER + '.sig'))}
    fixture = root / 'transport/gh'
    fixture.parent.mkdir()
    fixture.write_text(f'''#!/usr/bin/env python3
import json, shutil, sys
from pathlib import Path
root = Path({str(root)!r})
assets = json.loads({json.dumps(assets)!r})
swap = json.loads({json.dumps(swap)!r})
listing = {json.dumps(listing)!r}
endpoint = sys.argv[-1]
with open(root / "transport-requests.jsonl", "a") as log: log.write(json.dumps(sys.argv[1:]) + "\\n")
if endpoint == "repos/{REPOSITORY}/releases?per_page=100":
    print(listing)
elif endpoint.startswith("repos/{REPOSITORY}/releases/assets/"):
    path = assets[endpoint.rsplit("/", 1)[1]]
    if (root / "feed-mode").read_text().strip() == "wrong-signature":
        path = swap.get(path, path)
    with open(path, "rb") as f: shutil.copyfileobj(f, sys.stdout.buffer)
else:
    sys.exit(2)
''')
    fixture.chmod(0o700)
    (root / 'feed-mode').write_text('good\n')
    return releases


def windows(root, script, action, **params):
    args = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', script, '-Action', action]
    for name, value in params.items():
        args += [f'-{name}', str(value)]
    out = subprocess.run(args, capture_output=True, timeout=300, cwd='/mnt/c/Windows')
    text = out.stdout.decode('utf-8', 'replace').replace('\r', '')
    with open(root / 'windows.log', 'a') as log:
        log.write(json.dumps({'action': action, 'params': params, 'exit': out.returncode,
                              'stdout': text, 'stderr': out.stderr.decode('utf-8', 'replace')}) + '\n')
    if out.returncode != 0:
        raise RuntimeError(f'update-lab.ps1 {action} failed: {out.stderr.decode("utf-8", "replace")[-2000:]}')
    return json.loads(text) if text.strip() else None


def until(check, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if (value := check()):
                return value
        except OSError:
            pass  # not listening yet
        time.sleep(1)
    raise AssertionError(f'Timed out waiting for {what}')


def cdp_ready(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def main(args):
    root = args.run_dir.resolve()
    assert root.is_relative_to(common.PROJECT / 'target') and not root.exists(), 'Use a new folder under target/'
    assert 4400 <= args.port <= 4999 and 9300 <= args.cdp_port <= 9399
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    assert not cdp_ready(args.cdp_port), f'DevTools port {args.cdp_port} is in use'
    root.mkdir(mode=0o700)
    managed, data, cwd, shots = (root / name for name in ('managed', 'data', 'work', 'windows'))
    cwd.mkdir()
    shots.mkdir()
    feed = root / 'feed'
    shutil.copytree(args.feed, feed)
    bundle, initial, digest = common.manifest(args.bundle)
    core_url = f'http://127.0.0.1:{args.port}'
    receipt = {'root': str(root), 'core': core_url, 'bundle': initial['releaseId'], 'source': initial['gitSha'],
               'checks': [], 'windows': args.windows}
    owned = []
    def request(path, body=None):
        encoded = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(core_url + path, data=encoded,
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=30) as response:
            return json.load(response)
    script = subprocess.run(['wslpath', '-w', str(HERE / 'update-lab.ps1')], capture_output=True, text=True,
                            check=True).stdout.strip()
    try:
        releases = write_fixture(root, feed)
        newest, oldest = releases[-1], releases[0]
        receipt['feed'] = {r.name: sha256(r / INSTALLER) for r in releases}
        subprocess.run([str(bundle / 'bin/yuzuno-update-helper'), 'register', '--initialize',
                        '--install-dir', str(managed), '--bundle', str(bundle), '--manifest-sha256', digest,
                        '--reviewed-source', 'isolated T-13 desktop update lab'], check=True, timeout=90)
        # No Core release-source/key: desktop relaying is independent.
        assert not (managed / 'release-source.json').exists()
        env = dict(os.environ, PATH=str(root / 'transport') + os.pathsep + os.environ['PATH'])
        executable = managed / 'releases' / initial['releaseId'] / 'bin/yuzuno-workspace'
        with (root / 'core.log').open('wb') as log:
            child = subprocess.Popen([str(executable), '--install-dir', str(managed), '--data-dir', str(data),
                                      '--cwd', str(cwd), '--port', str(args.port), '--codex', str(REPO / 'acceptance/typing/fake_codex.py')],
                                     cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env)
        owned.append(common.until(lambda: common.identity(child.pid), 5))
        until(lambda: get(args.port, '/api/health')[0] == 200, 60, 'lab Core')

        # Relay, as the desktop's updater calls it.
        status, _, body = get(args.port, f'/api/updates/desktop/{TARGET}/manifest')
        manifest = json.loads(body)
        version = newest.name.removeprefix('desktop-')
        assert status == 200 and manifest['version'] == version, manifest
        platform = manifest['platforms'][TARGET]
        assert platform['url'] == f'{core_url}/api/updates/desktop/{TARGET}/installer?tag={newest.name}', platform
        assert platform['signature'] == (newest / (INSTALLER + '.sig')).read_text().strip(), 'signature relayed as published'
        receipt['checks'].append(f'manifest offers {newest.name} at this Core, signature as published')
        status, headers, body = get(args.port, f'/api/updates/desktop/{TARGET}/installer?tag={newest.name}')
        assert status == 200 and hashlib.sha256(body).hexdigest() == receipt['feed'][newest.name]
        assert int(headers['content-length']) == len(body)
        receipt['checks'].append('installer bytes equal the staged release file')
        before = len((root / 'transport-requests.jsonl').read_text().splitlines())
        refusals = {
            'foreign Host': get(args.port, f'/api/updates/desktop/{TARGET}/manifest', host='lab.example:80')[0],
            'unknown target': get(args.port, '/api/updates/desktop/linux-x86_64/manifest')[0],
            'unknown tag': get(args.port, f'/api/updates/desktop/{TARGET}/installer?tag=desktop-9.9.9')[0],
            'URL parameter': get(args.port, f'/api/updates/desktop/{TARGET}/installer?tag={newest.name}'
                                            '&url=http://lab.example/x.exe')[0],
        }
        assert refusals['foreign Host'] == 403 and refusals['unknown target'] == 404, refusals
        assert refusals['unknown tag'] == 404 and refusals['URL parameter'] == 400, refusals
        after = len((root / 'transport-requests.jsonl').read_text().splitlines())
        receipt['refusals'] = refusals
        receipt['ghCallsForRefusals'] = after - before
        receipt['checks'].append('foreign Host, unknown target, unknown tag and URL parameters refused')

        if args.windows:
            agent = request('/api/agents', {'name': 'Desktop update Lab fixture', 'cwd': str(cwd), 'harness': 'codex'})
            agent_id = agent['id']
            until(lambda: request(f'/api/agents/{agent_id}')['agent']['connectionState'] == 'connected', 60, 'scripted Agent')
            receipt['agent'] = agent_id
            before_agent = request(f'/api/agents/{agent_id}')['agent']
            native_pids = {pid for path in Path(f'/proc/{child.pid}/task').glob('*/children') for pid in path.read_text().split()}
            native = [common.identity(int(pid)) for pid in native_pids]
            assert native and all(native), 'a real scripted protocol process must be present'
            receipt['coreProcess'] = common.identity(child.pid)
            receipt['scriptedAgentProcesses'] = native
            before_ui = hashlib.sha256(get(args.port, '/')[2]).hexdigest()
            run_windows(args, root, script, core_url, oldest, newest, shots, receipt)
            assert common.identity(child.pid) == receipt['coreProcess'], 'Lab Core did not restart'
            assert all(common.identity(p['pid']) == p for p in native), 'scripted Agent processes did not restart'
            after_agent = request(f'/api/agents/{agent_id}')['agent']
            for key in ('id', 'threadId', 'connectionState'):
                assert before_agent[key] == after_agent[key], f'Agent {key} changed'
            assert hashlib.sha256(get(args.port, '/')[2]).hexdigest() == before_ui, 'same Lab UI throughout'
            receipt['checks'].append('same Core PID, scripted Agent PID/session, and UI bytes throughout native update')
        receipt['passed'] = True
        receipt['keptRunning'] = args.serve
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        if args.serve:
            print(f'Lab Core serving at {core_url}; Ctrl+C stops it.', flush=True)
            signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            signal.sigwait({signal.SIGINT, signal.SIGTERM})
    except BaseException as error:
        receipt.update(passed=False, error=f'{type(error).__name__}: {error}')
        raise
    finally:
        for process in reversed(owned):
            if common.identity(process['pid']) == process:
                os.kill(process['pid'], signal.SIGINT)
                try:
                    common.until(lambda: common.identity(process['pid']) != process, 20)
                except AssertionError:
                    os.kill(process['pid'], signal.SIGKILL)
        receipt['ownedProcessesStopped'] = all(common.identity(p['pid']) != p for p in owned)
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt, indent=2))


def run_windows(args, root, script, core_url, oldest, newest, shots, receipt):
    cdp = f'http://127.0.0.1:{args.cdp_port}'
    shots_win = subprocess.run(['wslpath', '-w', str(shots)], capture_output=True, text=True, check=True).stdout.strip()
    old_version = oldest.name.removeprefix('desktop-')
    new_version = newest.name.removeprefix('desktop-')
    installer_a = str(args.windows_build_root).rstrip('\\') + '\\bundle\\desktop-release\\' + oldest.name + '\\' + INSTALLER
    startup_url = f'http://127.0.0.1:{args.startup_port}'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.startup_port))
    def win(action, **params):
        return windows(root, script, action, LabBuildRoot=args.windows_build_root, **params)

    def step(name):
        out = subprocess.run(['node', '--max-old-space-size=1024', str(HERE / 'update-lab.mjs'), name, cdp,
                              core_url, str(shots), old_version, new_version, receipt['agent']], capture_output=True, text=True, timeout=300)
        result = json.loads((shots / f'{name}.json').read_text())
        receipt.setdefault('steps', {})[name] = result
        assert out.returncode == 0 and result['passed'], result.get('error') or out.stderr[-2000:]
        return result

    def launch(url):
        pid = win('Launch', CoreUrl=url, CdpPort=args.cdp_port)['pid']
        until(lambda: cdp_ready(args.cdp_port), 60, 'the lab window DevTools port')
        return pid

    def close(pid):
        win('Close', DesktopProcessId=pid)
        until(lambda: not cdp_ready(args.cdp_port), 30, 'the lab window to close')

    start = win('State')
    assert not start['installed'] and not start['installDirExists'] and not start['labProcesses'], start
    receipt['otherYuzunoBefore'] = start['otherYuzunoProcesses']
    installer_path = subprocess.run(['wslpath', '-u', installer_a], capture_output=True, text=True, check=True).stdout.strip()
    assert sha256(installer_path) == receipt['feed'][oldest.name], 'baseline installer matches the recorded signed feed'
    state = win('Install', Installer=installer_a)
    assert state['displayVersion'] == old_version and state['mainBinaryName'] == 'yuzuno-lab.exe', state
    assert not state['startMenuShortcut'] and not state['desktopShortcut'] and not state['labProcesses'], state
    receipt['checks'].append(f'Lab A {old_version} installed per user without shortcuts')

    (root / 'feed-mode').write_text('wrong-signature\n')
    pid = launch(startup_url)
    step('refused')
    before = win('Capture', DesktopProcessId=pid, OutputPath=f'{shots_win}\\before-native.png')
    assert before['captionStyleBit'], 'A must have the previous native title bar'
    receipt['nativeBefore'] = before
    close(pid)
    assert win('State')['displayVersion'] == old_version
    receipt['checks'].append('wrong signature refused; A remains installed with its old native frame')

    (root / 'feed-mode').write_text('good\n')
    pid = launch(startup_url)
    step('install')
    until(lambda: pid not in [p['pid'] for p in win('State')['labProcesses']], 60, 'A to exit')
    restarted = until(lambda: (s := win('State'))['displayVersion'] == new_version
                      and s['labProcesses'] and s, 180, 'installer to reopen B')
    [process] = restarted['labProcesses']
    receipt['restart'] = {'oldPid': pid, 'newPid': process['pid'], 'commandLine': process['commandLine']}
    assert process['pid'] != pid and process['path'].lower().endswith('\\yuzuno lab\\yuzuno-lab.exe'), process
    # Official updater replays the original arguments. The consumed marker,
    # real TCP connection and WebView origin/draft prove the selected Core won.
    assert restarted['installedExeVersion'] == new_version and not restarted['resumeMarkerExists'], restarted
    connected = until(lambda: (c := win('Connections', CorePort=args.port))['establishedToCore'] and c,
                      60, 'B to reach the same selected Core')
    receipt['restart']['connections'] = connected
    time.sleep(3)
    after = win('Capture', DesktopProcessId=process['pid'], OutputPath=f'{shots_win}\\reopened-native.png')
    receipt['nativeAfter'] = after
    # Tao retains WS_CAPTION for the shadow, hiding the frame in WM_NCCALCSIZE.
    # The after step asserts isDecorated == false; keep the native screenshot too.
    receipt['restart']['devtoolsAfterRestart'] = cdp_ready(args.cdp_port)
    if not receipt['restart']['devtoolsAfterRestart']:
        # Record the real automatic restart above. Explorer can drop the test
        # DevTools environment; reopen only Lab B to inspect its preserved data.
        close(process['pid'])
        process['pid'] = launch(core_url)
    step('after')
    end = win('State')
    assert end['otherYuzunoProcesses'] == receipt['otherYuzunoBefore'], 'daily Windows processes unchanged'
    receipt['keptWindows'] = end
    receipt['checks'].append('B restored selectedCore and actual draft; native frame changed; B kept for inspection')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bundle', type=Path, required=True, help='T-12 bundle of this source')
    parser.add_argument('--feed', type=Path, required=True,
                        help='folder of desktop-<version> folders, each with the two staged release files')
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--cdp-port', type=int, default=9334)
    parser.add_argument('--windows-build-root', help='Windows path to the isolated *-lab/release build, containing both signed feed versions')
    parser.add_argument('--startup-port', type=int, default=4998, help='unused Lab address, replaced through the connection UI')
    parser.add_argument('--windows', action='store_true', help='also run the approved Windows half')
    parser.add_argument('--serve', action='store_true', help='keep the lab Core running until Ctrl+C')
    args = parser.parse_args()
    if args.windows:
        assert args.serve and args.windows_build_root, '--windows requires --serve and --windows-build-root so B stays usable'
        assert 4400 <= args.startup_port <= 4999 and args.startup_port != args.port
    main(args)
