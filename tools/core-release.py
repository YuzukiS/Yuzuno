#!/usr/bin/env python3
"""Repository release entry point. Prepare locally; publish only when explicitly invoked."""
import argparse
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import claude_sdk_files, command, digest, extract, inventory, read, verify_tree, write

TOOLS = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def gh_json(endpoint):
    return json.loads(command(['gh', 'api', endpoint]))


def optional_gh_json(endpoint):
    result = subprocess.run(['gh', 'api', endpoint], text=True, capture_output=True, timeout=30)
    if result.returncode:
        if '(HTTP 404)' in result.stderr:
            return None
        raise RuntimeError(f'GitHub read failed: {result.stderr.strip()}')
    return json.loads(result.stdout)


def download(endpoint, target, *, accept=None):
    argv = ['gh', 'api']
    if accept is not None:
        argv.extend(['-H', f'Accept: {accept}'])
    argv.append(endpoint)
    temporary = target.with_suffix(target.suffix + '.part')
    try:
        with temporary.open('wb') as stream:
            subprocess.run(argv, stdout=stream, check=True, timeout=300)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


INPUTS_WORKFLOW = '.github/workflows/release-inputs.yml'


def ci_identity(run, artifact, config, inputs_run=None):
    """`run` is the main CI run that tested the source. The artifact is its
    own or, for a release that names an inputs run, that run's: the
    release-inputs workflow, run on request on main for the same commit.
    Returns the run that built the artifact."""
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Fixed CI has not passed')
    require(run['head_sha'] == config['source'] and run['head_repository']['full_name'].lower() == config['repository'].lower(), 'CI source/repository mismatch')
    require(run['event'] == 'push' and run['head_branch'] == 'main' and
            run['path'] == '.github/workflows/ci.yml', 'Use the reviewed main CI workflow')
    producer = run
    if 'inputsRunId' in config:
        require(inputs_run is not None and inputs_run['id'] == config['inputsRunId'], 'The fixed release inputs run was not read')
        require(inputs_run['status'] == 'completed' and inputs_run['conclusion'] == 'success', 'Fixed release inputs run has not passed')
        require(inputs_run['head_sha'] == config['source'] and
                inputs_run['head_repository']['full_name'].lower() == config['repository'].lower(), 'Release inputs source/repository mismatch')
        require(inputs_run['event'] == 'workflow_dispatch' and inputs_run['head_branch'] == 'main' and
                inputs_run['path'] == INPUTS_WORKFLOW, 'Use the release-inputs workflow run on main')
        producer = inputs_run
    require(not artifact['expired'], 'Artifact expired; explicitly choose a new CI artifact, never silently rebuild')
    require(artifact['workflow_run']['id'] == producer['id'] and artifact['workflow_run']['head_sha'] == config['source'], 'Artifact is from another run/source')
    require(artifact['name'] == f"core-inputs-{config['source']}-{producer['run_attempt']}", 'Artifact is from a different CI attempt')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('digest', '')), 'Artifact SHA-256 digest is missing')
    return producer


def bundle_identity(path, config):
    manifest = read(path / 'manifest.json')
    require(manifest['gitSha'] == config['source'] and manifest['releaseId'] == config['releaseId'] and
            manifest['version'] == config['version'], 'Bundle identity differs from frozen release')
    actual = inventory(path)
    actual.pop('manifest.json')
    require(actual == manifest['files'], 'Bundle contents differ from its manifest')
    return manifest


class Flow:
    def __init__(self, root, signing_key=None, minisign='minisign'):
        self.root = root.resolve()
        self.config = read(self.root / 'release.json')
        self.report_path = self.root / 'report.json'
        self.report = read(self.report_path) if self.report_path.exists() else {
            'format': 1, 'release': self.config, 'stages': {}, 'attempts': []}
        require(self.report['release'] == self.config, 'Frozen inputs changed')
        self.signing_key, self.minisign = signing_key, minisign

    def run(self, name, action, fresh=False):
        for stage, result in self.report['stages'].items():
            for relative, value in result.get('outputs', {}).items():
                path = self.root / relative
                require(path.is_file() and digest(path) == value, f'{stage} output changed: {relative}')
        if not fresh and self.report['stages'].get(name, {}).get('status') == 'passed':
            print(f'Reuse {name}', flush=True)
            return
        number = len(self.report['attempts']) + 1
        attempt = {'stage': name, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'log': f'logs/{number:02d}-{name}.log', 'status': 'running'}
        self.report['attempts'].append(attempt)
        log = self.root / attempt['log']
        log.parent.mkdir(exist_ok=True)
        log.write_text(f'{name} started at {attempt["startedAt"]}\n')
        write(self.report_path, self.report)
        try:
            value = action() or {}
            self.report['stages'][name] = {'status': 'passed', **value}
            attempt['status'] = 'passed'
            self.report['resumeAt'] = {'fetch': 'package', 'package': 'sign', 'sign': 'smoke',
                'smoke': 'publish (only with release authorization)', 'publish': 'verify-download',
                'verify_download': 'health (after the user installs)', 'health': 'complete'}[name]
        except BaseException as error:
            attempt.update(status='failed', error=f'{type(error).__name__}: {error}')
            if fresh and name in self.report['stages']:
                self.report['stages'][name] = {'status': 'failed', 'previous': self.report['stages'][name]}
            with log.open('a') as stream:
                stream.write(attempt['error'] + '\n')
            self.report['resumeAt'] = name
            raise
        finally:
            attempt['finishedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
            write(self.report_path, self.report)

    def execute(self, argv):
        path = self.root / self.report['attempts'][-1]['log']
        path.parent.mkdir(exist_ok=True)
        with path.open('ab') as log:
            subprocess.run(list(map(str, argv)), stdout=log, stderr=log, check=True)

    def outputs(self, paths):
        return {str(p.relative_to(self.root)): digest(p) for p in paths}

    def fetch(self):
        c = self.config
        run = gh_json(f"repos/{c['repository']}/actions/runs/{c['ciRunId']}")
        inputs_run = gh_json(f"repos/{c['repository']}/actions/runs/{c['inputsRunId']}") if 'inputsRunId' in c else None
        artifact = gh_json(f"repos/{c['repository']}/actions/artifacts/{c['artifactId']}")
        producer = ci_identity(run, artifact, c, inputs_run)
        fetched = self.root / 'artifact'
        # A completed rename is adopted after a process/receipt interruption.
        if not fetched.exists():
            with tempfile.TemporaryDirectory(prefix='.fetch-', dir=self.root) as temporary:
                stage = Path(temporary)
                archive = stage / 'artifact.zip'
                download(f"repos/{c['repository']}/actions/artifacts/{c['artifactId']}/zip", archive)
                require('sha256:' + digest(archive) == artifact['digest'], 'GitHub artifact digest mismatch')
                with zipfile.ZipFile(archive) as zip_file:
                    require(sorted(zip_file.namelist()) == ['build.json', 'inputs.tar.gz'], 'Unexpected artifact members')
                    require(sum(i.file_size for i in zip_file.infolist()) <= 2 * 1024**3, 'Artifact is too large')
                    zip_file.extractall(stage / 'product')
                archive.rename(stage / 'product/artifact.zip')
                (stage / 'product').rename(fetched)
        require('sha256:' + digest(fetched / 'artifact.zip') == artifact['digest'], 'Saved artifact digest mismatch')
        build = read(fetched / 'build.json')
        require(build['source'] == c['source'] and str(build['runId']) == str(producer['id']) and
                str(build['runAttempt']) == str(producer['run_attempt']) and
                build['repository'].lower() == c['repository'].lower(), 'Build metadata differs from CI')
        require(build['platform'] == 'linux-x86_64' and re.fullmatch('[a-f0-9]{40}', build['tree']), 'Unsupported artifact identity')
        # Inputs built on request are public: they must not carry the Claude
        # Agent SDK (docs/public-readiness.md).
        require(inputs_run is None or not claude_sdk_files(build['files']), 'Release inputs carry the Claude Agent SDK')
        require(digest(fetched / 'inputs.tar.gz') == build['archiveSha256'], 'Build input archive changed')
        # The downloaded zip is the trust boundary, including recovered files.
        with zipfile.ZipFile(fetched / 'artifact.zip') as archive:
            for name in ('build.json', 'inputs.tar.gz'):
                import hashlib
                with archive.open(name) as stream:
                    require(hashlib.file_digest(stream, 'sha256').hexdigest() == digest(fetched / name), 'Extracted artifact changed')
        inputs = self.root / 'inputs'
        if not inputs.exists():
            with tempfile.TemporaryDirectory(prefix='.extract-', dir=self.root) as temp:
                extracted = Path(temp) / 'inputs'
                extract(fetched / 'inputs.tar.gz', extracted)
                verify_tree(extracted, build['files'])
                extracted.rename(inputs)
        verify_tree(inputs, build['files'])
        write(self.root / 'ci.json', {'run': run, 'artifact': artifact, **({'inputsRun': inputs_run} if inputs_run else {})})
        return {'tree': build['tree'], 'ciUrl': run['html_url'], 'artifactDigest': artifact['digest'],
                **({'inputsUrl': inputs_run['html_url']} if inputs_run else {}),
                'outputs': self.outputs([fetched / n for n in ('build.json', 'inputs.tar.gz', 'artifact.zip')] + [self.root / 'ci.json'])}

    def package(self):
        c, inputs = self.config, self.root / 'inputs'
        verify_tree(inputs, read(self.root / 'artifact/build.json')['files'])
        target = self.root / 'bundle'
        if not target.exists():
            self.execute([sys.executable, TOOLS / 'package-release.py', '--core', inputs / 'bin/yuzuno-workspace',
                '--helper', inputs / 'bin/yuzuno-update-helper', '--licenses', inputs / 'licenses',
                '--web', inputs / 'web', '--claude', inputs / 'claude',
                '--result-validator', inputs / 'result-validator', '--windows-helper', inputs / 'windows-jobs',
                '--out', target, '--notes-file', self.root / 'notes.txt',
                '--release-id', c['releaseId'], '--version', c['version'], '--git-sha', c['source']])
        manifest = bundle_identity(target, c)
        require(manifest['notes'] == (self.root / 'notes.txt').read_text(), 'Release notes changed')
        expected = {}
        for name, info in inventory(inputs).items():
            if name.startswith('claude/'):
                name = 'runtimes/' + name
            elif name.startswith('result-validator/'):
                if name not in ('result-validator/validator.mjs', 'result-validator/contract.json',
                                'result-validator/THIRD_PARTY_NOTICES.txt'):
                    continue
                name = 'runtimes/' + name
            elif name.startswith('windows-jobs/'):
                name = 'runtimes/' + name
            expected[name] = info
        # package-release adds only this version marker to the raw Vite index.
        expected_html = (inputs / 'web/index.html').read_text().replace('</head>', f'<meta name="yuzuno-release" content="{c["releaseId"]}">\n</head>', 1)
        require((target / 'web/index.html').read_text() == expected_html, 'Packaged UI differs from built UI')
        expected['web/index.html'] = manifest['files']['web/index.html']
        require(manifest['files'] == expected, 'Packaged files differ from fixed build inputs')
        return {'manifestSha256': digest(target / 'manifest.json'), 'outputs': self.outputs([target / 'manifest.json'])}

    def signed(self, directory):
        c = self.config
        manifest = bundle_identity(self.root / 'bundle', c)
        prefix = 'yuzuno-core-' + manifest['platform']
        paths = [directory / (prefix + suffix) for suffix in ('.json', '.json.minisig', '.tar.gz')]
        require(sorted(p.name for p in directory.iterdir()) == sorted(p.name for p in paths), 'Expected exactly three signed assets')
        descriptor = read(paths[0])
        require(descriptor['manifest'] == manifest and descriptor['repository'] == c['repository'] and
                descriptor['tag'] == c['releaseId'] and descriptor['manifestSha256'] == digest(self.root / 'bundle/manifest.json'), 'Signed identity mismatch')
        require(descriptor['archiveSha256'] == digest(paths[2]) and descriptor['archiveBytes'] == paths[2].stat().st_size, 'Signed archive mismatch')
        require(digest(self.root / 'publisher.pub') == c['publicKeySha256'], 'Publisher key changed')
        self.execute([self.minisign, '-V', '-p', self.root / 'publisher.pub', '-m', paths[0], '-x', paths[1]])
        with tempfile.TemporaryDirectory(prefix='.verify-', dir=self.root) as temp:
            extracted = Path(temp) / 'bundle'
            extract(paths[2], extracted)
            verify_tree(extracted, inventory(self.root / 'bundle'))
        return paths

    def sign(self):
        directory = self.root / 'signed'
        if not directory.exists():
            require(self.signing_key is not None, 'Supply --signing-key to the existing publisher key; never generate a new identity')
            self.execute([sys.executable, TOOLS / 'sign-core-release.py', '--bundle', self.root / 'bundle',
                '--out', directory, '--signing-key', self.signing_key, '--public-key', self.root / 'publisher.pub',
                '--repository', self.config['repository'], '--tag', self.config['releaseId'], '--minisign', self.minisign])
        paths = self.signed(directory)
        return {'assets': [{'name': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)} for p in paths],
                'outputs': self.outputs(paths)}

    def smoke(self):
        self.signed(self.root / 'signed')
        require(digest(Path(self.config['baseline']) / 'manifest.json') == self.config['baselineManifestSha256'], 'Baseline manifest changed')
        self.execute([sys.executable, TOOLS / 'core-release-smoke.py', '--baseline', self.config['baseline'],
                      '--candidate', self.root / 'bundle', '--state', self.root / 'smoke.json'])
        receipt = read(self.root / 'smoke.json')
        require(receipt['passed'], 'Short upgrade smoke did not pass; inspect its preserved phases')
        return {'receipt': receipt, 'outputs': self.outputs([self.root / 'smoke.json'])}

    def prepare(self):
        for name in ('fetch', 'package', 'sign', 'smoke'):
            self.run(name, getattr(self, name))
        self.report['resumeAt'] = 'publish (only with release authorization)'
        write(self.report_path, self.report)

    def remote_release(self, missing_ok=False):
        c = self.config
        endpoint = f"repos/{c['repository']}/releases"
        receipt = self.root / 'remote-release.json'
        identity = {'repository': c['repository'], 'tag': c['releaseId'], 'source': c['source']}
        saved = read(receipt) if receipt.exists() else None
        if saved is not None:
            require({k: saved.get(k) for k in identity} == identity, 'Saved remote release identity changed')
        release_id = saved.get('id') if saved is not None else None

        def validate(value):
            require(type(value.get('id')) is int and value['id'] > 0, 'Invalid remote release ID')
            require(value.get('tag_name') == c['releaseId'] and value.get('target_commitish') == c['source'],
                    'Remote release tag/source differs from frozen release')
            return value

        if release_id is None:
            # The tag endpoint excludes drafts. Only its explicit 404 permits discovery.
            value = optional_gh_json(f"{endpoint}/tags/{c['releaseId']}")
            if value is None:
                matches = []
                for page in range(1, 11):
                    releases = gh_json(f'{endpoint}?per_page=100&page={page}')
                    matches.extend(r for r in releases if r.get('tag_name') == c['releaseId'])
                    require(len(matches) <= 1, 'Multiple releases match the frozen tag; reconcile before continuing')
                    if len(releases) < 100:
                        break
                else:
                    raise ValueError('Release discovery limit reached; absence is unconfirmed')
                value = matches[0] if matches else None
            if value is None:
                require(missing_ok, 'Remote release not found; preserve any prior creation attempt and reconcile')
                return None
            release_id = validate(value)['id']
            write(receipt, {**identity, 'id': release_id})
        require(type(release_id) is int and release_id > 0, 'Invalid saved remote release ID')
        value = validate(gh_json(f'{endpoint}/{release_id}'))
        require(value['id'] == release_id, 'Remote release ID changed')
        return value

    def tag(self):
        c = self.config
        value = gh_json(f"repos/{c['repository']}/git/ref/tags/{c['releaseId']}")['object']
        for _ in range(4):
            if value['type'] == 'commit':
                require(value['sha'] == c['source'], 'Release tag points at another commit')
                return
            require(value['type'] == 'tag', 'Unsupported tag object')
            value = gh_json(f"repos/{c['repository']}/git/tags/{value['sha']}")['object']
        raise ValueError('Too many nested annotated tags')

    def publish(self):
        require(self.report['stages'].get('smoke', {}).get('status') == 'passed', 'Prepare and smoke must pass before publishing')
        c = self.config
        paths = self.signed(self.root / 'signed')
        tag = optional_gh_json(f"repos/{c['repository']}/git/ref/tags/{c['releaseId']}")
        if tag is None:
            self.execute(['gh', 'api', '--method', 'POST', f"repos/{c['repository']}/git/refs",
                          '-f', f"ref=refs/tags/{c['releaseId']}", '-f', f"sha={c['source']}"])
        self.tag()
        release = self.remote_release(missing_ok=True)
        if release is None:
            receipt = self.root / 'remote-release.json'
            require(not receipt.exists(), 'Draft creation was already attempted; reconcile before creating another release')
            write(receipt, {'repository': c['repository'], 'tag': c['releaseId'], 'source': c['source'], 'id': None})
            self.execute(['gh', 'release', 'create', c['releaseId'], '--repo', c['repository'], '--draft',
                          '--target', c['source'], '--title', c['version'], '--notes-file', self.root / 'notes.txt'])
            release = self.remote_release()
        self.tag()
        expected = {p.name: p for p in paths}
        require(set(a['name'] for a in release['assets']) <= set(expected), 'Unexpected remote release assets; do not overwrite')
        for asset in release['assets']:
            path = expected.pop(asset['name'])
            require(asset.get('digest') == 'sha256:' + digest(path) and asset['size'] == path.stat().st_size,
                    'Remote asset differs; do not clobber or sign again')
        require(release['draft'] or not expected, 'Published release is incomplete; inspect instead of modifying it')
        for path in expected.values():
            self.execute(['gh', 'release', 'upload', c['releaseId'], path, '--repo', c['repository']])
        release = self.remote_release()
        require(len(release['assets']) == 3, 'Remote upload is incomplete')
        for asset in release['assets']:
            path = self.root / 'signed' / asset['name']
            require(asset.get('digest') == 'sha256:' + digest(path), 'Uploaded asset digest differs')
        if release['draft']:
            self.execute(['gh', 'release', 'edit', c['releaseId'], '--repo', c['repository'], '--draft=false'])
        release = self.remote_release()
        require(not release['draft'], 'Publication remains unconfirmed; resume to reconcile')
        write(self.root / 'publication.json', release)
        return {'url': release['html_url'], 'releaseId': release['id'], 'outputs': self.outputs([self.root / 'publication.json'])}

    def verify_download(self):
        release = self.remote_release()
        require(not release['draft'] and not release['prerelease'], 'Release is not published')
        self.tag()
        c = self.config
        expected = {a['name']: a for a in self.report['stages']['sign']['assets']}
        require({a['name'] for a in release['assets']} == set(expected), 'Published assets differ')
        with tempfile.TemporaryDirectory(prefix='.download-', dir=self.root) as temporary:
            directory = Path(temporary)
            for asset in release['assets']:
                path = directory / asset['name']
                download(f"repos/{c['repository']}/releases/assets/{asset['id']}", path,
                         accept='application/octet-stream')
                require(digest(path) == expected[path.name]['sha256'] and path.stat().st_size == expected[path.name]['bytes'], 'Real downloaded asset differs from signed artifact')
            self.signed(directory)
        receipt = {'passed': True, 'releaseId': release['id'], 'url': release['html_url'], 'assets': list(expected.values()),
                   'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
        write(self.root / 'download.json', receipt)
        return {'receipt': receipt, 'outputs': self.outputs([self.root / 'download.json'])}

    def health(self, origin, workspace):
        require(origin is not None and workspace is not None, 'Supply the installed Core URL and expected Workspace ID')
        url = urllib.parse.urlsplit(origin)
        require(url.scheme in ('http', 'https') and url.hostname in ('localhost', '127.0.0.1', '::1') and
                not url.username and not url.password and not url.query and not url.fragment and url.path in ('', '/'), 'Use an explicit localhost Core origin')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        values = {}
        for name in ('health', 'updates'):
            with opener.open(origin.rstrip('/') + '/api/' + name, timeout=15) as response:
                values[name] = json.load(response)
        h = values['health']
        require(h['releaseId'] == self.config['releaseId'] and h['workspaceId'] == workspace and h['apiReady'] and h['storageReady'], 'Installed identity/health mismatch')
        operation = values['updates'].get('operation') or {}
        proof = operation.get('recordsProof') or {}
        require(operation.get('phase') == 'complete' and values['updates']['acceptingWork'] and
                proof.get('recordsReady') and proof.get('phase') == 'afterRestore' and
                proof.get('releaseId') == h['releaseId'] and proof.get('workspaceId') == workspace,
                'Update recovery proof is not complete for this Workspace/release')
        write(self.root / 'health.json', values)
        return {'receipt': values, 'outputs': self.outputs([self.root / 'health.json'])}


def initialize(args):
    require(re.fullmatch('[a-f0-9]{40}', args.sha), 'Use an exact commit SHA')
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository), 'Use owner/repository')
    require(re.fullmatch(r'core-[A-Za-z0-9_-]{1,90}', args.release_id), 'Use a safe core-* release ID')
    require(args.version.strip() and args.review.strip(), 'Version and accepted review reference are required')
    root = args.work_dir.resolve()
    require(not root.exists(), 'Release workspace exists; use resume instead of replacing frozen inputs')
    baseline = args.baseline.resolve(strict=True)
    public = args.public_key.read_bytes()
    notes = args.notes.read_bytes()
    require(len(notes) <= 32768, 'Release notes are too long')
    import hashlib
    config = {'format': 1, 'repository': args.repository, 'source': args.sha,
              'ciRunId': args.ci_run, 'artifactId': args.artifact_id, 'releaseId': args.release_id,
              'version': args.version, 'acceptedReview': args.review,
              'baseline': str(baseline), 'baselineManifestSha256': digest(baseline / 'manifest.json'),
              'publicKeySha256': hashlib.sha256(public).hexdigest(), 'notesSha256': hashlib.sha256(notes).hexdigest()}
    if getattr(args, 'inputs_run', None) is not None:
        config['inputsRunId'] = args.inputs_run
    root.mkdir(parents=True, mode=0o700)
    (root / 'notes.txt').write_bytes(notes)
    (root / 'publisher.pub').write_bytes(public)
    write(root / 'release.json', config)
    write(root / 'report.json', {'format': 1, 'release': config, 'stages': {}, 'attempts': [], 'resumeAt': 'fetch'})


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='Freeze reviewed source, exact CI/artifact and release identity; no side effects outside work-dir')
    init.add_argument('--work-dir', type=Path, required=True)
    for name in ('repository', 'sha', 'release-id', 'version', 'review'):
        init.add_argument('--' + name, required=True)
    for name in ('ci-run', 'artifact-id'):
        init.add_argument('--' + name, type=int, required=True)
    init.add_argument('--inputs-run', type=int,
                      help='The release-inputs workflow run that built the artifact; --ci-run is then the main CI run that tested the source')
    for name in ('baseline', 'public-key', 'notes'):
        init.add_argument('--' + name, type=Path, required=True)
    for name in ('resume', 'publish', 'verify-download', 'health', 'status'):
        command_parser = sub.add_parser(name)
        command_parser.add_argument('--work-dir', type=Path, required=True)
        command_parser.add_argument('--minisign', default='minisign')
        if name == 'resume':
            command_parser.add_argument('--signing-key', type=Path)
        if name == 'health':
            command_parser.add_argument('--origin', required=True)
            command_parser.add_argument('--workspace-id', required=True)
    return p


def main():
    args = parser().parse_args()
    if args.action == 'init':
        initialize(args)
        return
    with (args.work_dir / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        flow = Flow(args.work_dir, getattr(args, 'signing_key', None), args.minisign)
        require(digest(flow.root / 'notes.txt') == flow.config['notesSha256'], 'Frozen notes changed')
        if args.action == 'status':
            print(json.dumps(flow.report, indent=2))
        elif args.action == 'resume':
            flow.prepare()
        else:
            action = args.action.replace('-', '_')
            flow.run(action, (lambda: flow.health(args.origin, args.workspace_id)) if action == 'health' else getattr(flow, action), fresh=action == 'health')
        print(f'Report: {flow.report_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
