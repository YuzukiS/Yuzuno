"""The public repository's CI (T-147), checked as text without running it.

Before the public snapshot it is ci/public/ci.yml, inactive here; after it,
.github/workflows/ci.yml. These rules must hold for that file:
- every job runs on GitHub-hosted ubuntu-24.04, and its first step, before
  checkout, refuses any other runner;
- only push and pull_request trigger it, never pull_request_target;
- the token is read-only, no secret is used, no artifact is uploaded;
- only the Cargo cache exists, saved only from main; npm caches nothing;
- every action is pinned to a full commit.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / 'ci/public/ci.yml'
PATCH = ROOT / 'ci/public/public-docs.patch'
GUARD = ROOT / '.github/scripts/hosted-guard.sh'
FREE_DISK = ROOT / '.github/scripts/free-disk.sh'
JOB = re.compile(r'^  ([A-Za-z0-9_-]+):\s*$')


def workflow():
    """The public workflow: the candidate while it exists, else the active one."""
    return CANDIDATE if CANDIDATE.exists() else ROOT / '.github/workflows/ci.yml'


def code_lines(text):
    """Lines without comments; a full-line comment becomes empty."""
    return [re.sub(r'(^|\s)#.*$', '', line).rstrip() for line in text.splitlines()]


def jobs(lines):
    """{job: its lines}, for the jobs under the top-level jobs: key."""
    start = lines.index('jobs:')
    found, current = {}, None
    for line in lines[start + 1:]:
        if line and not line.startswith(' '):
            break
        match = JOB.match(line)
        if match:
            current = match.group(1)
            found[current] = []
        elif current:
            found[current].append(line)
    return found


def problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = []
    if 'on:' in top:
        for line in top[top.index('on:') + 1:]:
            if line and not line.startswith(' '):
                break
            match = re.match(r'^  ([a-z_]+):', line)
            if match:
                triggers.append(match.group(1))
    if triggers != ['push', 'pull_request']:
        found.append(f'triggers are {triggers}, not push and pull_request')
    if 'permissions:' not in top or top[top.index('permissions:') + 1].strip() != 'contents: read':
        found.append('the top-level permissions are not contents: read')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-artifact|upload-pages-artifact|actions/cache/save', 'an upload or cache save')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    for line in lines:
        match = re.match(r'^\s*-?\s*uses:\s*(\S+)', line)
        if match and not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', match.group(1)):
            found.append(f'{match.group(1)} is not pinned to a full commit')
    all_jobs = jobs(lines)
    if not all_jobs:
        found.append('no jobs')
    for name, job in all_jobs.items():
        runs_on = [line.split(':', 1)[1].strip() for line in job if re.match(r'^    runs-on:', line)]
        if runs_on != ['ubuntu-24.04']:
            found.append(f'job {name} runs on {runs_on}, not ubuntu-24.04')
        steps = '\n'.join(job)
        starts = [i for i, line in enumerate(job) if re.match(r'^      - ', line)]
        first = '\n'.join(job[starts[0]:starts[1] if len(starts) > 1 else None]) if starts else ''
        if '[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||' not in first or 'uses:' in first:
            found.append(f'job {name} does not refuse a non-hosted runner in its first step')
        node = steps.count('actions/setup-node@')
        if node and (steps.count('package-manager-cache: false') != node or re.search(r'^\s+cache(-dependency-path)?:', steps, re.M)):
            found.append(f'job {name} may cache npm packages')
        if re.search(r'actions/cache(/restore)?@', steps):
            found.append(f'job {name} uses a general cache')
        if 'rust-cache@' in steps:
            saves = re.findall(r'save-if:\s*(.+)', steps)
            if saves != ["${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"] * steps.count('rust-cache@'):
                found.append(f'job {name} may save the Rust cache outside a push to main')
    return found


class PublicCi(unittest.TestCase):
    def test_the_public_workflow_keeps_the_rules(self):
        self.assertEqual(problems(workflow().read_text()), [])

    def test_each_broken_rule_is_reported(self):
        good = workflow().read_text()
        cases = {
            'a self-hosted runner': (good.replace('runs-on: ubuntu-24.04', 'runs-on: [self-hosted, linux]', 1), 'self-hosted'),
            'another hosted image': (good.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest', 1), 'not ubuntu-24.04'),
            'pull_request_target': (good.replace('  pull_request:\n', '  pull_request_target:\n', 1), 'triggers'),
            'a secret': (good.replace('BASE_SHA: ${{', 'TOKEN: ${{ secrets.X }}\n          BASE_SHA: ${{', 1), 'a secret'),
            'a write permission': (good.replace('  contents: read', '  contents: write', 1), 'contents: read'),
            'an artifact upload': (good.replace('      - name: Unit tests', '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n      - name: Unit tests', 1), 'upload'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'a job without the first-step check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'checkout before the check': (good.replace(
                '    steps:\n      # Before anything else', '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      # Before anything else', 1), 'first step'),
            'a cache saved from PRs': (good.replace("save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", 'save-if: true', 1), 'Rust cache'),
            'an npm cache': (good.replace('package-manager-cache: false', 'cache: npm', 1), 'npm packages'),
            'npm caching left on': (good.replace('          package-manager-cache: false\n', '', 1), 'npm packages'),
            'a general cache': (good.replace('      - name: Unit tests', '      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830\n        with:\n          path: node_modules\n          key: x\n      - name: Unit tests', 1), 'general cache'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in problems(text)), problems(text))

    def test_the_guard_refuses_any_runner_but_a_github_hosted_one(self):
        for environment, code in [('self-hosted', 1), ('', 1), ('github-hosted', 0)]:
            with self.subTest(environment or 'unset'):
                env = {k: v for k, v in os.environ.items() if k not in ('RUNNER_ENVIRONMENT', 'GITHUB_STEP_SUMMARY')}
                if environment:
                    env['RUNNER_ENVIRONMENT'] = environment
                run = subprocess.run([str(GUARD)], env=env, capture_output=True, text=True)
                self.assertEqual(run.returncode, code, run.stdout + run.stderr)

    def test_the_sdks_are_removed_only_when_free_space_is_short_or_unknown(self):
        with tempfile.TemporaryDirectory() as temp:
            bindir = Path(temp)
            (bindir / 'df').write_text('#!/bin/sh\ncase "$*" in *--output=avail*) [ -n "$FAKE_AVAIL" ] || exit 1; printf "Avail\\n%s\\n" "$FAKE_AVAIL";; *) echo "df -h";; esac\n')
            (bindir / 'sudo').write_text(f'#!/bin/sh\necho "$*" >> {bindir}/sudo.log\n')
            for tool in ('df', 'sudo'):
                (bindir / tool).chmod(0o755)
            env = dict(os.environ, PATH=f'{bindir}:' + os.environ['PATH'])
            gib = 1073741824
            for avail, removed in [(50 * gib, False), (40 * gib, False), (40 * gib - 1, True), (10 * gib, True), ('', True)]:
                with self.subTest(avail=avail):
                    (bindir / 'sudo.log').unlink(missing_ok=True)
                    run = subprocess.run([str(FREE_DISK), '40'], env=dict(env, FAKE_AVAIL=str(avail)), capture_output=True, text=True)
                    self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                    log = bindir / 'sudo.log'
                    self.assertEqual(log.exists(), removed, run.stdout)
                    if removed:
                        self.assertIn('rm -rf /usr/local/lib/android /usr/share/dotnet', log.read_text())
            for argument in ([], ['many']):
                run = subprocess.run([str(FREE_DISK), *argument], env=env, capture_output=True, text=True)
                self.assertEqual(run.returncode, 2, run.stdout + run.stderr)

    @unittest.skipUnless(PATCH.exists(), 'the public docs patch is applied in the public snapshot')
    def test_the_public_docs_patch_still_applies(self):
        run = subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == '__main__':
    unittest.main()
