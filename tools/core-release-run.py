#!/usr/bin/env python3
"""The steps of docs/core-release-checklist.md around tools/core-release.py (YN-54).

Each command reads one release-run.env (tools/release-run.env.example) and
refuses to start when a value it needs is missing, blank or malformed. The
file is parsed here, never sourced by a shell. A command's receipts go into
the env file's own directory, the release's run directory.

Only three commands write to GitHub: publish (core-release.py's tag and
release), and milestone --open and --close. The release-inputs dispatch is not
a command here: the checklist runs it on its own, after gate.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_common import digest, extract, inventory, read, verify_tree, write

# The checkout these tools belong to; the release's tools must be W's (tools_frozen).
ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('core_release', ROOT / 'tools/core-release.py')
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)

HEX40, HEX64, NUM = r'[0-9a-f]{40}', r'[0-9a-f]{64}', r'[1-9][0-9]{0,15}'
ABS = r'/[^\s]*'
TAG = r'core-20[0-9]{6}-[0-9a-f]{7}'
FIELDS = {
    'SHA': HEX40, 'CI_RUN': NUM, 'INPUTS_RUN': NUM, 'ARTIFACT_ID': NUM,
    'RELEASE_ID': TAG, 'VERSION': r'20[0-9]{2}\.[0-9]{2}\.[0-9]{2}-core\.[1-9][0-9]*',
    'MILESTONE': r'core\.[1-9][0-9]*', 'PREV_TAG': TAG,
    'NOTES_SHA256': HEX64, 'REVIEW_SHA256': HEX64,
    'MINISIGN': ABS, 'MINISIGN_SHA256': HEX64, 'REPO': r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',
    'W': ABS, 'T': ABS, 'BASE': ABS, 'BASE_SHA256': HEX64, 'PUB': ABS, 'PUB_SHA256': HEX64, 'KEY': ABS,
    'WORKSPACE_ID': r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
}
LINE = re.compile(r'([A-Z][A-Z0-9_]*)=(\S*)(?:\s+#.*)?')
# A value has no whitespace, quote or shell metacharacter: copied into a shell
# by hand, it still means only itself.
SAFE = re.compile(r'''[^\s'"`$;|&<>(){}\\*?!~\[\]]*''')
TEXTS = ('notes-final.md', 'review-string.txt')
MAX_NOTES = 32768
# The anonymous download (verify): what a user's machine sees, with no gh, token or netrc.
ANON_BASE, ANON_PATH = 'https://github.com', '/usr/bin:/bin'


class Refused(Exception):
    """A value or file the command needs is missing or wrong: nothing was started."""


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Env:
    def __init__(self, path):
        self.path = Path(path).resolve()
        if not self.path.is_file():
            raise Refused(f'{path} is not a file')
        self.values, seen = {}, set()
        for number, raw in enumerate(self.path.read_text(encoding='utf-8').splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            match = LINE.fullmatch(line)
            if not match:
                raise Refused(f'line {number} is not NAME=value: {raw!r}')
            name, value = match.groups()
            if name not in FIELDS:
                raise Refused(f'line {number}: {name} is not a release value')
            if name in seen:
                raise Refused(f'line {number}: {name} is set twice')
            if not SAFE.fullmatch(value):
                raise Refused(f'line {number}: {name} holds a quote, space or shell character')
            seen.add(name)
            if value:
                self.values[name] = value
        v = self.values
        for name, value in v.items():
            if not re.fullmatch(FIELDS[name], value):
                raise Refused(f'{name} is malformed: {value}')
        if 'RELEASE_ID' in v and 'SHA' in v and v['RELEASE_ID'][-7:] != v['SHA'][:7]:
            raise Refused(f"RELEASE_ID {v['RELEASE_ID']} does not name SHA {v['SHA']}")
        if 'RELEASE_ID' in v and 'VERSION' in v and v['RELEASE_ID'][5:13] != v['VERSION'][:10].replace('.', ''):
            raise Refused(f"RELEASE_ID {v['RELEASE_ID']} and VERSION {v['VERSION']} name different days")
        if 'VERSION' in v and 'MILESTONE' in v and v['VERSION'].split('-')[1] != v['MILESTONE']:
            raise Refused(f"VERSION {v['VERSION']} is not milestone {v['MILESTONE']}")
        if 'PREV_TAG' in v and v.get('PREV_TAG') == v.get('RELEASE_ID'):
            raise Refused('PREV_TAG is this release')
        self.run = self.path.parent

    def need(self, *names):
        missing = [n for n in names if n not in self.values]
        if missing:
            raise Refused(f"{', '.join(missing)} not set in {self.path}")
        return [self.values[n] for n in names]

    def __getattr__(self, name):
        if name in FIELDS:
            return self.need(name)[0]
        raise AttributeError(name)

    @property
    def n(self):
        return int(self.MILESTONE.split('.')[1])

    @property
    def work(self):
        return Path(self.T) / 'release'


def gh(endpoint, *, missing_ok=False):
    """A GitHub API read: `gh api` with no method or field, so a GET."""
    result = subprocess.run(['gh', 'api', endpoint], text=True, capture_output=True, timeout=120)
    if result.returncode:
        if missing_ok and '(HTTP 404)' in result.stderr:
            return None
        raise RuntimeError(f'GitHub read {endpoint} failed: {result.stderr.strip()}')
    return json.loads(result.stdout)


def pages(endpoint):
    items = []
    for page in range(1, 11):
        sep = '&' if '?' in endpoint else '?'
        batch = gh(f'{endpoint}{sep}per_page=100&page={page}')
        items.extend(batch)
        if len(batch) < 100:
            return items
    raise ValueError(f'More than 1000 items at {endpoint}; absence is unconfirmed')


def gh_write(method, endpoint, fields):
    argv = ['gh', 'api', '--method', method, endpoint]
    for key, value in fields.items():
        argv += ['-f', f'{key}={value}']
    result = subprocess.run(argv, text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f'GitHub write {method} {endpoint} failed: {result.stderr.strip()}')
    return json.loads(result.stdout)


def commit_of_tag(repo, tag):
    value = gh(f'repos/{repo}/git/ref/tags/{tag}')['object']
    for _ in range(4):
        if value['type'] == 'commit':
            return value['sha']
        require(value['type'] == 'tag', f'Tag {tag} is not a commit or tag object')
        value = gh(f"repos/{repo}/git/tags/{value['sha']}")['object']
    raise ValueError(f'Too many nested annotated tags at {tag}')


def git(env, *argv):
    return subprocess.run(['git', '-C', env.W, *argv], text=True, capture_output=True, check=True).stdout


def say(text):
    print(text, flush=True)


# Checks several commands share (Dev 9's lib.sh for core.24-28, YN-54).

def minisign_pinned(env):
    path, want = env.need('MINISIGN', 'MINISIGN_SHA256')
    require(os.access(path, os.X_OK) and Path(path).is_file() and digest(path) == want,
            f'minisign {path} is missing or not the pinned binary')
    return path


def tools_frozen(env):
    sha, w = env.need('SHA', 'W')
    require(ROOT == Path(w).resolve(), f'Run the tools of the frozen checkout W ({w}), not {ROOT}')
    require(git(env, 'rev-parse', 'HEAD').strip() == sha, f'W is not at {sha}')
    require(not git(env, 'status', '--porcelain').strip(), 'W has changes')


def texts_final(env):
    notes_sha, review_sha = env.need('NOTES_SHA256', 'REVIEW_SHA256')
    for name, want in zip(TEXTS, (notes_sha, review_sha)):
        path = env.run / name
        require(path.is_file() and digest(path) == want, f'{path} is not the approved file')
        text = path.read_text(encoding='utf-8')
        for mark in ('{{', '}}', 'TODO'):
            require(mark not in text, f'{path} still holds {mark}')
    require((env.run / TEXTS[0]).stat().st_size <= MAX_NOTES, f'The notes are over {MAX_NOTES} bytes')


def review_text(env):
    # What init was given: core.24-28 passed the file through a shell, which
    # drops trailing newlines; release.json holds that string.
    return (env.run / TEXTS[1]).read_text(encoding='utf-8').rstrip('\n')


def release_config_matches(env):
    """The frozen release.json is this env file's release, field by field."""
    texts_final(env)
    path = env.work / 'release.json'
    require(path.is_file(), f'No {path}')
    c = read(path)
    want = {'repository': env.REPO, 'source': env.SHA, 'ciRunId': env.CI_RUN, 'inputsRunId': env.INPUTS_RUN,
            'artifactId': env.ARTIFACT_ID, 'releaseId': env.RELEASE_ID, 'version': env.VERSION,
            'notesSha256': env.NOTES_SHA256, 'baselineManifestSha256': env.BASE_SHA256, 'publicKeySha256': env.PUB_SHA256}
    bad = [k for k, v in want.items() if str(c.get(k)) != v]
    if c.get('upgrade', 'inPlace') != 'inPlace':
        bad.append('upgrade')
    if c.get('acceptedReview') != review_text(env):
        bad.append('acceptedReview')
    if not isinstance(c.get('baseline'), str) or os.path.realpath(c['baseline']) != os.path.realpath(env.BASE):
        bad.append('baseline')
    require(not bad, f"{path} is not this env file's release: {', '.join(bad)}")
    return digest(path)


def summary_matches(env, sha):
    path = env.run / 'resume.json'
    require(path.is_file() and digest(path) == sha, f'{path} is not the summary {sha}')
    s = read(path)
    require(s.get('asExpected') is True and s.get('resumeRc') == 0 and
            s.get('releaseJsonSha256') == digest(env.work / 'release.json'),
            'The resume summary is not a passing summary of this release.json')
    return s


def local_origin(origin):
    url = urllib.parse.urlsplit(origin)
    require(url.scheme in ('http', 'https') and url.hostname in ('localhost', '127.0.0.1', '::1') and
            not url.username and not url.password and not url.query and not url.fragment and url.path in ('', '/'),
            'Use an explicit localhost Core origin')
    return origin.rstrip('/')


def core_release(env, *argv):
    """tools/core-release.py of this checkout; returns its exit status."""
    return subprocess.run([sys.executable, '-I', ROOT / 'tools/core-release.py', *map(str, argv)], cwd=ROOT).returncode


# Commands.

def gate(env, args):
    """Read-only, before the release-inputs dispatch. Every problem is reported, not only the first."""
    sha, repo, ci_run, tag, version, prev, _ = env.need('SHA', 'REPO', 'CI_RUN', 'RELEASE_ID', 'VERSION', 'PREV_TAG', 'MILESTONE')
    problems, heads = [], {}

    def check(name, action):
        try:
            action()
        except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
            problems.append(f'{name}: {error}')

    check('minisign', lambda: minisign_pinned(env))
    check('W', lambda: tools_frozen(env))

    def main_head():
        heads['main'] = gh(f'repos/{repo}/git/ref/heads/main')['object']['sha']
        require(heads['main'] == sha, f"main is at {heads['main']}, not {sha}")
    check('main', main_head)

    def ci():
        run = gh(f'repos/{repo}/actions/runs/{ci_run}')
        require(run['path'] == '.github/workflows/ci.yml' and run['event'] == 'push' and run['head_branch'] == 'main'
                and run['head_sha'] == sha, f'run {ci_run} is not the main push CI of {sha}')
        require(run['status'] == 'completed' and run['conclusion'] == 'success',
                f"run {ci_run} is {run['status']}/{run['conclusion']}")
    check('CI', ci)

    def inputs():
        runs = gh(f'repos/{repo}/actions/workflows/release-inputs.yml/runs?head_sha={sha}&per_page=100')
        require(runs['total_count'] == 0, f"{runs['total_count']} release-inputs run(s) already exist for {sha}")
    check('inputs', inputs)
    check('tag', lambda: require(gh(f'repos/{repo}/git/ref/tags/{tag}', missing_ok=True) is None, f'tag {tag} exists'))

    def releases():
        listed = pages(f'repos/{repo}/releases')
        named = [r['tag_name'] for r in listed if r['tag_name'] == tag or r.get('name') == version
                 or str(r.get('name') or '').endswith(f'-{env.MILESTONE}')]
        require(not named, f"a release already uses {tag} or {env.MILESTONE}: {named}")
        drafts = [r['id'] for r in listed if r.get('draft')]
        require(not drafts, f'draft release(s) exist: {drafts}; reconcile them first')
    check('releases', releases)

    def latest():
        value = gh(f'repos/{repo}/releases/latest')
        require(value['tag_name'] == prev and str(value.get('name', '')).endswith(f'-core.{env.n - 1}'),
                f"the latest release is {value['tag_name']} {value.get('name')}, not PREV_TAG {prev} (core.{env.n - 1})")
    check('previous', latest)

    def milestone():
        open_ = sorted(pages(f'repos/{repo}/milestones?state=open'), key=lambda m: m['number'])
        require(open_ and open_[-1]['title'] == env.MILESTONE,
                f"the newest open milestone is {open_[-1]['title'] if open_ else 'none'}, not {env.MILESTONE}")
    check('milestone', milestone)

    receipt = {'passed': not problems, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
               'main': heads.get('main'), 'sha': sha, 'ciRun': ci_run, 'releaseId': tag, 'version': version, 'problems': problems}
    write(env.run / 'gate.json', receipt)
    if problems:
        say('gate refused:\n- ' + '\n- '.join(problems))
        return 1
    say(f"gate passed {receipt['checkedAt']}: main={sha} ci={ci_run}; {tag} / {version} unused")
    say(f'next, as its own command: gh workflow run release-inputs.yml --repo {repo} --ref main')
    return 0


def inputs(env, args):
    sha, repo = env.need('SHA', 'REPO')
    runs = gh(f'repos/{repo}/actions/workflows/release-inputs.yml/runs?head_sha={sha}&event=workflow_dispatch&per_page=100')['workflow_runs']
    require(runs, f'No release-inputs run for {sha} yet')
    require(len(runs) == 1, f"{len(runs)} release-inputs runs for {sha}: {[r['id'] for r in runs]}; stop and ask")
    run = runs[0]
    require(run['head_sha'] == sha and run['head_branch'] == 'main' and run['path'] == release.INPUTS_WORKFLOW
            and run['head_repository']['full_name'].lower() == repo.lower(), f"run {run['id']} is not {sha} on main")
    receipt = {'run': run['id'], 'attempt': run['run_attempt'], 'status': run['status'], 'conclusion': run['conclusion'],
               'headSha': run['head_sha'], 'createdAt': run['created_at'], 'url': run['html_url']}
    if run['status'] != 'completed':
        write(env.run / 'inputs.json', receipt)
        say(f"release-inputs run {run['id']} on {sha} is {run['status']}: it builds this SHA, so the hold can lift")
        return 0
    require(run['conclusion'] == 'success', f"release-inputs run {run['id']} {run['conclusion']}")
    name = f"core-inputs-{sha}-{run['run_attempt']}"
    artifacts = [a for a in gh(f"repos/{repo}/actions/runs/{run['id']}/artifacts")['artifacts'] if a['name'] == name]
    require(len(artifacts) == 1, f"Expected one artifact {name}, found {len(artifacts)}")
    artifact = artifacts[0]
    require(not artifact['expired'] and re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest') or ''),
            f"Artifact {artifact['id']} is expired or has no digest")
    for key, value in (('INPUTS_RUN', run['id']), ('ARTIFACT_ID', artifact['id'])):
        require(env.values.get(key) in (None, str(value)), f'{key} in the env file is not {value}')
    receipt['artifact'] = {k: artifact[k] for k in ('id', 'name', 'size_in_bytes', 'digest')}
    write(env.run / 'inputs.json', receipt)
    say(f"INPUTS_RUN={run['id']}\nARTIFACT_ID={artifact['id']}  # {name}, {artifact['size_in_bytes']} B, {artifact['digest']}")
    return 0


def baseline(env, args):
    """BASE is the previous release's bundle, as its signed descriptor names it."""
    repo, prev, base = env.need('REPO', 'PREV_TAG', 'BASE')
    pub = Path(env.PUB)
    require(digest(pub) == env.PUB_SHA256, 'The public key is not PUB_SHA256')
    minisign = minisign_pinned(env)
    value = gh(f'repos/{repo}/releases/tags/{prev}')
    require(not value['draft'] and value['tag_name'] == prev, f'{prev} is not a published release')
    assets = {a['name']: a for a in value['assets']}
    base = Path(base)
    with tempfile.TemporaryDirectory(prefix='.baseline-', dir=env.run) as temporary:
        directory = Path(temporary)
        want = ['yuzuno-core-linux-x86_64.json', 'yuzuno-core-linux-x86_64.json.minisig']
        if args.fetch:
            require(not base.exists(), f'{base} exists; --fetch only fills a new BASE')
            want.append('yuzuno-core-linux-x86_64.tar.gz')
        for name in want:
            require(name in assets, f'{prev} has no {name}')
            release.download(f"repos/{repo}/releases/assets/{assets[name]['id']}", directory / name, accept='application/octet-stream')
            require('sha256:' + digest(directory / name) == assets[name].get('digest'), f'{name} differs from its GitHub digest')
        checked = subprocess.run([minisign, '-V', '-p', pub, '-m', directory / want[0], '-x', directory / want[1]],
                                 text=True, capture_output=True)
        require(checked.returncode == 0 and f'Trusted comment: Yuzuno Core {prev}' in checked.stdout,
                f'{prev} descriptor signature: {checked.stdout.strip()} {checked.stderr.strip()}')
        descriptor = read(directory / want[0])
        require(descriptor['tag'] == prev and descriptor['repository'] == repo, f'The descriptor is not {repo} {prev}')
        if args.fetch:
            archive = directory / want[2]
            require(digest(archive) == descriptor['archiveSha256'] and archive.stat().st_size == descriptor['archiveBytes'],
                    'The archive is not the signed one')
            extract(archive, base)
    manifest = base / 'manifest.json'
    require(manifest.is_file() and digest(manifest) == descriptor['manifestSha256'],
            f"{manifest} is not {prev}'s signed manifest {descriptor['manifestSha256']}")
    files = inventory(base)
    files.pop('manifest.json')
    require(files == read(manifest)['files'], f'{base} differs from its manifest')
    require(env.values.get('BASE_SHA256') in (None, descriptor['manifestSha256']), 'BASE_SHA256 is not the signed manifest')
    write(env.run / 'baseline.json', {'tag': prev, 'base': str(base), 'manifestSha256': descriptor['manifestSha256'],
                                      'fetched': bool(args.fetch), 'files': len(files)})
    say(f"BASE_SHA256={descriptor['manifestSha256']}  # {prev}'s signed manifest; {len(files)} files match")
    return 0


def facts(env, args):
    """What the notes and the review string are written from; never their text."""
    sha, repo, prev, ci_run, _ = env.need('SHA', 'REPO', 'PREV_TAG', 'CI_RUN', 'MILESTONE')
    prev_sha = commit_of_tag(repo, prev)
    merges = []
    for line in git(env, 'log', '--merges', '--first-parent', '--reverse', '--format=%H%x09%s', f'{prev_sha}..{sha}').splitlines():
        commit, subject = line.split('\t', 1)
        number = re.match(r'Merge pull request #([0-9]+) from ', subject)
        merges.append({'commit': commit, 'pr': int(number.group(1)) if number else None, 'subject': subject})
    milestones = [m for m in pages(f'repos/{repo}/milestones?state=all') if m['title'] == env.MILESTONE]
    require(len(milestones) == 1, f'Expected one milestone {env.MILESTONE}, found {len(milestones)}')
    listed = {}
    for issue in pages(f"repos/{repo}/issues?milestone={milestones[0]['number']}&state=all"):
        if 'pull_request' in issue:
            labels = sorted(l['name'] for l in issue['labels'] if l['name'].startswith('task:'))
            listed[issue['number']] = {'labels': labels, 'title': issue['title']}
    merged = [m['pr'] for m in merges if m['pr'] is not None]
    differ = {'onlyMerged': sorted(set(merged) - set(listed)), 'onlyMilestone': sorted(set(listed) - set(merged)),
              'notPullRequests': [m['commit'] for m in merges if m['pr'] is None]}
    ci_rows, exceptions = [], []
    for m in merges:
        runs = gh(f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={m['commit']}&event=push&branch=main&per_page=100")['workflow_runs']
        m['ci'] = [{k: r[k] for k in ('id', 'status', 'conclusion', 'run_attempt')} for r in runs]
        first = any(r['conclusion'] == 'success' and r['run_attempt'] == 1 for r in runs)
        for r in runs or [{'id': '-', 'status': 'none', 'conclusion': None, 'run_attempt': 0}]:
            ci_rows.append(f"#{m['pr']}\t{m['commit']}\t{r['id']}:{r['status']}:{r['conclusion']}:a{r['run_attempt']}")
        if not first:
            what = '; '.join(f"run {r['id']} {r['status']}/{r['conclusion']} on attempt {r['run_attempt']}" for r in runs) or 'no run'
            exceptions.append(f"#{m['pr']}'s own run ({m['commit'][:8]}): {what} {{{{WHY #{m['pr']}}}}}")
    cut = gh(f'repos/{repo}/actions/runs/{ci_run}')
    count = len(merged)
    passed = count - len(exceptions)
    review = (f"Accepted source changes through {sha}; main CI {ci_run}/{cut['run_attempt']} passed. "
              f"{count} PRs merged since {prev_sha} (core.{env.n - 1}), milestone {env.MILESTONE}: "
              + ', '.join(f'#{n}' for n in merged) + '. '
              + '{{QUEUE: how they were merged, from each merge_list entry: policy, gate, reviewMerges, binaries}} '
              + f'{passed} of the {count} merge commits have a main push CI run of their own that passed on its first attempt'
              + (''.join(f'; {e}' for e in exceptions)) + '. '
              'Not re-audited per PR for this release. Release-time review: none; the release smoke is the only check added here.\n')
    out = env.run / 'facts'
    out.mkdir(exist_ok=True)
    (out / 'merges.tsv').write_text(''.join(f"{m['commit']}\t{m['pr'] or '-'}\t{m['subject']}\n" for m in merges))
    (out / 'milestone.tsv').write_text(''.join(f"{n}\t{','.join(v['labels']) or '-'}\t{v['title']}\n" for n, v in sorted(listed.items())))
    (out / 'main-ci.tsv').write_text(''.join(row + '\n' for row in ci_rows))
    (env.run / 'review-string-draft.txt').write_text(review)
    write(out / 'facts.json', {'previous': {'tag': prev, 'commit': prev_sha}, 'sha': sha, 'milestone': env.MILESTONE,
                               'merges': merges, 'milestonePullRequests': listed, 'differ': differ,
                               'mainCi': {'firstAttempt': passed, 'of': count, 'exceptions': exceptions}})
    say(f'{len(merges)} merges ({count} PRs) since {prev}; milestone {env.MILESTONE} lists {len(listed)}; '
        f'main CI first attempt {passed} of {count}')
    if any(differ.values()):
        say(f'the merges and the milestone differ: {json.dumps(differ)}')
        return 1
    return 0


def init(env, args):
    texts_final(env)
    repo, sha, ci_run, inputs_run, artifact, tag, version, base, pub = env.need(
        'REPO', 'SHA', 'CI_RUN', 'INPUTS_RUN', 'ARTIFACT_ID', 'RELEASE_ID', 'VERSION', 'BASE', 'PUB')
    require(digest(Path(base) / 'manifest.json') == env.BASE_SHA256, 'BASE is not BASE_SHA256 (run baseline)')
    require(digest(pub) == env.PUB_SHA256, 'The public key is not PUB_SHA256')
    require(not env.work.exists(), f'{env.work} exists: a new release needs a new work directory')
    tools_frozen(env)
    rc = core_release(env, 'init', '--work-dir', env.work, '--repository', repo, '--sha', sha, '--ci-run', ci_run,
                      '--inputs-run', inputs_run, '--artifact-id', artifact, '--release-id', tag, '--version', version,
                      '--review', review_text(env), '--notes', env.run / TEXTS[0], '--baseline', base, '--public-key', pub)
    require(rc == 0, f'core-release.py init exited {rc}')
    say(f"release.json {digest(env.work / 'release.json')}")
    return 0


def resume(env, args):
    """In a Job: package, sign and smoke, then resume.json, the summary publish takes."""
    minisign = minisign_pinned(env)
    tools_frozen(env)
    key = Path(env.KEY)
    require(key.is_file(), f'No signing key at {key}')
    for place in (Path(env.W), env.run):
        require(not key.resolve().is_relative_to(place.resolve()), f'The signing key is inside {place}; keep it where it is')
    require(release_config_matches(env) == args.release_json_sha, 'release.json is not the one init wrote')
    rc = core_release(env, 'resume', '--work-dir', env.work, '--signing-key', key, '--minisign', minisign)
    work = env.work
    report = read(work / 'report.json')
    stages = {name: report['stages'].get(name, {}).get('status') for name in ('fetch', 'package', 'sign', 'smoke')}
    signed = {p.name: digest(p) for p in sorted((work / 'signed').iterdir())} if (work / 'signed').is_dir() else {}
    smoke = read(work / 'smoke.json') if (work / 'smoke.json').is_file() else {}
    mode = smoke.get('inputs', {}).get('mode', 'inPlace')
    summary = {'resumeRc': rc, 'releaseJsonSha256': digest(work / 'release.json'), 'stages': stages,
               'resumeAt': report.get('resumeAt'), 'signed': signed, 'smokePassed': smoke.get('passed') is True,
               'smokeMode': mode, 'addedFields': smoke.get('addedFields', {}),
               'bundleManifestSha256': digest(work / 'bundle/manifest.json') if (work / 'bundle/manifest.json').is_file() else None}
    summary['asExpected'] = (rc == 0 and summary['releaseJsonSha256'] == args.release_json_sha
                             and all(s == 'passed' for s in stages.values()) and len(signed) == 3
                             and summary['smokePassed'] and mode == 'inPlace'
                             and str(summary['resumeAt']).startswith('publish'))
    write(env.run / 'resume.json', summary)
    say(json.dumps(summary, indent=1))
    return 0 if summary['asExpected'] else 1


def publish(env, args):
    minisign = minisign_pinned(env)
    tools_frozen(env)
    release_config_matches(env)
    for name, value in sorted(summary_matches(env, args.resume_sha)['signed'].items()):
        say(f'{value}  {name}')
    rc = core_release(env, 'publish', '--work-dir', env.work, '--minisign', minisign)
    core_release(env, 'status', '--work-dir', env.work)
    if rc == 0:
        # core-release.py has checked the tag and the release; these receipts only record them.
        try:
            tag = gh(f'repos/{env.REPO}/git/ref/tags/{env.RELEASE_ID}')
            (env.run / 'tag-ref.txt').write_text(f"{tag['object']['sha']}\t{tag['ref']}\n")
            write(env.run / 'remote-release.json', gh(f'repos/{env.REPO}/releases/tags/{env.RELEASE_ID}'))
        except RuntimeError as error:
            say(f'published; reading the tag and release back for the receipts failed ({error}): verify reads them again')
    return rc


def verify(env, args):
    minisign = minisign_pinned(env)
    tools_frozen(env)
    rc = core_release(env, 'verify-download', '--work-dir', env.work, '--minisign', minisign)
    require(rc == 0, f'core-release.py verify-download exited {rc}')
    signed = env.work / 'signed'
    names = sorted(p.name for p in signed.iterdir())
    require(len(names) == 3, 'Expected three signed files')
    # Each attempt downloads into a directory of its own; an earlier one is kept, never reused.
    attempts = [Path(env.T) / ('anonymous-download' + (f'-{n}' if n > 1 else '')) for n in range(1, 100)]
    target = next(p for p in attempts if not p.exists())
    target.mkdir()
    for name in names:
        subprocess.run(['/usr/bin/env', '-i', f'PATH={ANON_PATH}', 'HOME=/nonexistent', 'curl', '-fsSL', '--netrc-file', '/dev/null',
                        '-o', target / name, f'{ANON_BASE}/{env.REPO}/releases/download/{env.RELEASE_ID}/{name}'],
                       check=True, timeout=600)
        require(digest(target / name) == digest(signed / name), f'The anonymous download of {name} differs from the signed file')
    json_name = next(n for n in names if n.endswith('.json'))
    checked = subprocess.run([minisign, '-Vm', target / json_name, '-x', target / (json_name + '.minisig'),
                              '-p', env.work / 'publisher.pub'], text=True, capture_output=True)
    require(checked.returncode == 0 and f'Trusted comment: Yuzuno Core {env.RELEASE_ID}' in checked.stdout,
            f'The anonymous download does not verify: {checked.stdout.strip()} {checked.stderr.strip()}')
    write(env.run / 'anonymous-download.json', {'passed': True, 'directory': str(target), 'files': {n: digest(target / n) for n in names},
                                                'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')})
    say('anonymous download matches the signed files and verifies')
    return 0


def milestone(env, args):
    repo = env.REPO
    every = pages(f'repos/{repo}/milestones?state=all')
    if args.open:
        require(args.open == f'core.{env.n + 1}', f'The next milestone is core.{env.n + 1}, not {args.open}')
        require((env.run / 'inputs.json').is_file(), 'Open the next milestone once the inputs run has started (inputs)')
        require(not [m for m in every if m['title'] == args.open], f'{args.open} exists')
        made = gh_write('POST', f'repos/{repo}/milestones', {'title': args.open})
        say(f"milestone {made['title']} (#{made['number']}) open")
    else:
        require(args.close == env.MILESTONE, f'This release closes {env.MILESTONE}, not {args.close}')
        require((env.work / 'publication.json').is_file(), 'Close the milestone once the release is published')
        found = [m for m in every if m['title'] == args.close and m['state'] == 'open']
        require(len(found) == 1, f'{args.close} is not one open milestone')
        done = gh_write('PATCH', f"repos/{repo}/milestones/{found[0]['number']}", {'state': 'closed'})
        say(f"milestone {done['title']} (#{done['number']}) {done['state']}")
    return 0


def served_ui(origin, web):
    """The installed Core serves this bundle's Web UI: index.html and every asset, byte for byte."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path):
        with opener.open(origin + urllib.parse.quote(path), timeout=15) as response:
            return response.read()
    index = get('/')
    assets = sorted(p.relative_to(web).as_posix() for p in (web / 'assets').rglob('*') if p.is_file())
    different = [a for a in assets if get('/' + a) != (web / a).read_bytes()]
    meta = re.findall(rb'name="yuzuno-release" content="([^"]+)"', index)
    return {'index': index == (web / 'index.html').read_bytes(), 'releaseMeta': [m.decode() for m in meta],
            'assets': len(assets), 'different': different}


def health(env, args):
    """Read-only, after the user installed this release."""
    origin = local_origin(args.origin)
    workspace = env.WORKSPACE_ID
    tools_frozen(env)
    rc = core_release(env, 'health', '--work-dir', env.work, '--origin', origin, '--workspace-id', workspace)
    require(rc == 0, f'core-release.py health exited {rc}')
    ui = served_ui(origin, env.work / 'bundle/web')
    write(env.run / 'served-ui.json', ui)
    say(f"served UI: index {'identical' if ui['index'] else 'DIFFERENT'}, {ui['assets'] - len(ui['different'])} of "
        f"{ui['assets']} assets identical {ui['different']}, meta {ui['releaseMeta']}")
    return 0 if ui['index'] and not ui['different'] and ui['releaseMeta'] == [env.RELEASE_ID] else 1


def parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    for name, text in (('gate', 'read-only checks before the release-inputs dispatch'),
                       ('inputs', 'the release-inputs run of SHA and its artifact'),
                       ('baseline', "check BASE against the previous release's signed descriptor"),
                       ('facts', 'merges, milestone and main CI for the notes and the review string'),
                       ('init', 'freeze the release into a new work directory'),
                       ('resume', 'package, sign and smoke (in a Job), then resume.json'),
                       ('publish', 'publish the signed files (needs the user\'s approval)'),
                       ('verify', 'download through gh and anonymously, and verify'),
                       ('milestone', 'open the next milestone or close this one'),
                       ('health', 'read-only health of the installed release')):
        command = sub.add_parser(name, help=text)
        command.add_argument('--env', required=True, type=Path)
        if name == 'baseline':
            command.add_argument('--fetch', action='store_true', help='fill a missing BASE from the signed release')
        if name == 'resume':
            command.add_argument('--release-json-sha', required=True)
        if name == 'publish':
            command.add_argument('--resume-sha', required=True)
        if name == 'milestone':
            which = command.add_mutually_exclusive_group(required=True)
            which.add_argument('--open')
            which.add_argument('--close')
        if name == 'health':
            command.add_argument('--origin', required=True)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        env = Env(args.env)
        return globals()[args.command](env, args)
    except Refused as error:
        print(f'refusing to start: {error}', file=sys.stderr)
        return 2
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'stopped: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
