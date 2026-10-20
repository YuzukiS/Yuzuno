#!/usr/bin/env python3
"""Real packaged Core + signed assets + browser -> T-12 apply, isolated only.

Run inside heavy-slot and a memory-limited scope. By default only gh's transport
is a local fixture; verification, extraction, storage and process replacement
are real. --github uses the host's official gh against already-published assets.
Never creates a remote release, uses native sessions, or changes a daily install.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess

spec = importlib.util.spec_from_file_location('updates_acceptance', Path(__file__).with_name('updates-acceptance.py'))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def main(args):
    root = args.run_dir.resolve()
    assert root.is_relative_to(common.PROJECT / 'target') and not root.exists()
    assert 4400 <= args.port <= 4999
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    root.mkdir(mode=0o700)
    managed, data, cwd = (root / name for name in ('managed', 'data', 'work'))
    cwd.mkdir()
    assert len(str(managed / 'updates/control.sock').encode()) < 104
    bundle, initial, digest = common.manifest(args.a)
    feed = args.feed.resolve(strict=True)
    descriptor_path = next(feed.glob('yuzuno-core-*.json'))
    descriptor = json.loads(descriptor_path.read_text())
    target = descriptor['manifest']['releaseId']
    receipt = {'mode': 'official-gh' if args.github else 'local-gh-transport-real-signed-package',
               'root': str(root), 'port': args.port, 'source': descriptor['manifest']['gitSha'],
               'from': initial['releaseId'], 'to': target, 'checks': []}
    owned = []
    opener = common.urllib.request.build_opener(common.urllib.request.ProxyHandler({}))

    def request(path, body=None):
        req = common.urllib.request.Request(f'http://127.0.0.1:{args.port}{path}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
        with opener.open(req, timeout=10) as response:
            return json.load(response)

    def capture():
        state = managed / 'updates/state.json'
        if state.exists():
            op = json.loads(state.read_text()).get('operation') or {}
            for key in ('oldProcess', 'newProcess', 'helperProcess'):
                process = op.get(key)
                if process and process not in owned:
                    assert Path(process['executable']).is_relative_to(managed / 'releases')
                    owned.append(process)

    try:
        subprocess.run([str(bundle / 'bin/yuzuno-update-helper'), 'register', '--initialize',
            '--install-dir', str(managed), '--bundle', str(bundle), '--manifest-sha256', digest,
            '--reviewed-source', 'isolated T-13 acceptance'], check=True, timeout=90)
        public_key = args.public_key.read_text().splitlines()[-1]
        config = managed / 'release-source.json'
        config.write_text(json.dumps({'repository': descriptor['repository'], 'publicKey': public_key}))
        config.chmod(0o600)
        env = dict(os.environ)
        if not args.github:
            transport = root / 'transport'
            transport.mkdir()
            assets = sorted(feed.iterdir())
            metadata = {'draft': False, 'prerelease': False, 'tag_name': descriptor['tag'],
                'published_at': descriptor['manifest']['builtAt'], 'assets': [
                    {'id': n, 'name': p.name, 'size': p.stat().st_size, 'state': 'uploaded'}
                    for n, p in enumerate(assets, 1)]}
            fixture = transport / 'gh'
            fixture.write_text('#!/usr/bin/env python3\nimport json, pathlib, shutil, sys\n'
                + f'assets = {dict(enumerate(map(str, assets), 1))!r}\n'
                + f'repository = {descriptor["repository"]!r}\n'
                + 'endpoint = sys.argv[-1]\n'
                + f'with open({str(root / "transport-requests.jsonl")!r}, "a") as log: log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                + 'if endpoint == f"repos/{repository}/releases?per_page=100":\n'
                + f'    print({json.dumps([metadata])!r})\n'
                + 'elif endpoint.startswith(f"repos/{repository}/releases/assets/"):\n'
                + '    with open(assets[int(endpoint.rsplit("/", 1)[1])], "rb") as f: shutil.copyfileobj(f, sys.stdout.buffer)\n'
                + 'else: sys.exit(2)\n')
            fixture.chmod(0o700)
            env['PATH'] = str(transport) + os.pathsep + env['PATH']
        executable = managed / 'releases' / initial['releaseId'] / 'bin/yuzuno-workspace'
        with (root / 'core.log').open('wb') as log:
            child = subprocess.Popen([str(executable), '--install-dir', str(managed), '--data-dir', str(data),
                '--cwd', str(cwd), '--port', str(args.port), '--codex', str(root / 'no-native')],
                cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env)
        original = common.until(lambda: common.identity(child.pid), 5)
        owned.append(original)
        health = common.until(lambda: (h if (h := request('/api/health')).get('releaseId') == initial['releaseId'] else None))
        project = request('/api/projects', {'name': 'T13 signed update sentinel'})
        env.update(YUZUNO_RELEASE_URL=f'http://127.0.0.1:{args.port}', YUZUNO_RELEASE_FROM=initial['releaseId'],
            YUZUNO_RELEASE_TO=target, YUZUNO_BROWSER_OUTPUT=str(root / 'browser'))
        subprocess.run(['node', '--max-old-space-size=2048', 'tools/release-download-browser.mjs'],
            cwd=Path(__file__).resolve().parent.parent / 'web', env=env, check=True, timeout=360)
        capture()
        final = request('/api/health')
        status = request('/api/updates')
        assert final['releaseId'] == target and final['workspaceId'] == health['workspaceId']
        assert final['apiReady'] and final['storageReady']
        assert status['operation']['phase'] == 'complete' and status['acceptingWork']
        assert project in request('/api/projects')['projects']
        assert common.identity(original['pid']) != original, 'Old Core did not exit'
        receipt.update(workspaceId=final['workspaceId'], operation=status['operation']['id'], processes=owned)
        receipt['checks'] += ['real browser check/download/prepare/manual apply', 'old packaged Core exited',
            'replacement Core and UI serve the signed release', 'workspace ID and project persisted']
        receipt['passed'] = True
    except BaseException as error:
        receipt.update(passed=False, error=str(error))
        raise
    finally:
        capture()
        for process in reversed(owned):
            if common.identity(process['pid']) == process:
                os.kill(process['pid'], signal.SIGINT)
                try:
                    common.until(lambda: common.identity(process['pid']) != process, 20)
                except AssertionError:
                    if common.identity(process['pid']) == process:
                        os.kill(process['pid'], signal.SIGKILL)
                        common.until(lambda: common.identity(process['pid']) != process, 5)
        receipt['ownedProcessesStopped'] = all(common.identity(p['pid']) != p for p in owned)
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('a', 'feed', 'public-key', 'run-dir'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--github', action='store_true')
    main(parser.parse_args())
