"""The public repository's CI (T-147), checked as text without running it.

Before the public snapshot it is ci/public/ci.yml, inactive here; after it,
.github/workflows/ci.yml. These rules must hold for that file:
- every job runs on GitHub-hosted ubuntu-24.04, and its first step, before
  checkout, refuses any other runner;
- only push and pull_request trigger it, never pull_request_target;
- the token is read-only, no secret is used, no artifact is uploaded;
- only the Cargo cache exists, saved only from main; npm caches nothing;
- every action is pinned to a full commit.

.github/workflows/release-inputs.yml (T-159) builds release inputs on request:
only workflow_dispatch triggers it; its token reads contents and actions
only; no secret, cache or other runner; it builds only main whose push CI
passed, checks the inputs (never the Claude Agent SDK) before uploading the
one core-inputs artifact.

.github/workflows/desktop-macos.yml (T-165) builds the macOS app on the
standard GitHub-hosted macOS 26 runners, one per architecture: arm64 on
macos-26 and x86_64 on macos-26-intel. Only pull_request and
workflow_dispatch trigger it; its token reads contents and actions only; no
secret, cache or other runner. Only a run on request uploads, one macOS
artifact per architecture, and such a run builds only main whose push CI
passed.

.github/workflows/ios.yml (T-170) builds the iOS app for the Simulator,
unsigned, on the standard GitHub-hosted macos-26 runner. Only pull_request
triggers it; its token reads contents only; no secret, cache or other
runner. Its one upload is the Simulator smoke's two screenshots of the
connection page, exactly as IOS_UPLOAD names them and kept for 3 days, after
a step that checks there are only those two PNG files.
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
DISK_PRECHECK = ROOT / '.github/scripts/disk-precheck.sh'
RELEASE_INPUTS = ROOT / '.github/workflows/release-inputs.yml'
DESKTOP_MACOS = ROOT / '.github/workflows/desktop-macos.yml'
IOS = ROOT / '.github/workflows/ios.yml'
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


def section(top, key):
    """The keys directly under a top-level key, such as on: or permissions:."""
    found = []
    if key + ':' in top:
        for line in top[top.index(key + ':') + 1:]:
            if line and not line.startswith(' '):
                break
            match = re.match(r'^  ([a-z_-]+):\s*(.*)$', line)
            if match:
                found.append((match.group(1), match.group(2)))
    return found


def unpinned(lines):
    found = []
    for line in lines:
        match = re.match(r'^\s*-?\s*uses:\s*(\S+)', line)
        if match and not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', match.group(1)):
            found.append(f'{match.group(1)} is not pinned to a full commit')
    return found


def steps_of(job):
    """The job's steps, each as its lines joined."""
    starts = [i for i, line in enumerate(job) if re.match(r'^      - ', line)]
    return ['\n'.join(job[start:end]) for start, end in zip(starts, starts[1:] + [None])]


def runner_problems(name, job, image='ubuntu-24.04'):
    found = []
    runs_on = [line.split(':', 1)[1].strip() for line in job if re.match(r'^    runs-on:', line)]
    if runs_on != [image]:
        found.append(f'job {name} runs on {runs_on}, not {image}')
    first = (steps_of(job) or [''])[0]
    if '[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||' not in first or 'uses:' in first:
        found.append(f'job {name} does not refuse a non-hosted runner in its first step')
    return found


def problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
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
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if not all_jobs:
        found.append('no jobs')
    for name, job in all_jobs.items():
        found += runner_problems(name, job)
        steps = '\n'.join(job)
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


UPLOAD_NAME = 'name: core-inputs-${{ github.sha }}-${{ github.run_attempt }}'


def release_inputs_problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
    if triggers != ['workflow_dispatch']:
        found.append(f'triggers are {triggers}, not workflow_dispatch only')
    if sorted(section(top, 'permissions')) != [('actions', 'read'), ('contents', 'read')]:
        found.append('the top-level permissions are not contents: read and actions: read')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-pages-artifact|actions/cache|rust-cache@', 'a cache or pages upload')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if len(all_jobs) != 1:
        found.append(f'{len(all_jobs)} jobs, not one')
    for name, job in all_jobs.items():
        found += runner_problems(name, job)
        steps = steps_of(job)
        def first(predicate):
            return next((i for i, step in enumerate(steps) if predicate(step)), None)
        gate = first(lambda step: '[ "$GITHUB_REF" = refs/heads/main ]' in step
                     and 'actions/workflows/ci.yml/runs' in step and 'status=success' in step)
        checkout = first(lambda step: 'actions/checkout@' in step)
        check = first(lambda step: 'tools/release-inputs-check.py' in step)
        uploads = [i for i, step in enumerate(steps) if 'actions/upload-artifact@' in step]
        if gate is None or checkout is None or gate > checkout:
            found.append(f'job {name} does not require main with passed CI before checkout')
        if checkout is not None and 'persist-credentials: false' not in steps[checkout]:
            found.append(f'job {name} keeps the checkout credentials')
        if len(uploads) != 1 or UPLOAD_NAME not in steps[uploads[0]]:
            found.append(f'job {name} does not upload exactly the one core-inputs artifact')
        elif check is None or check > uploads[0]:
            found.append(f'job {name} does not check the inputs before uploading')
    return found


MACOS_UPLOAD_NAME = 'name: yuzuno-macos-${{ matrix.arch }}-${{ github.sha }}-${{ github.run_attempt }}'
# Each architecture on its own standard runner, and nothing else.
MACOS_RUNNERS = [('arm64', 'macos-26'), ('x86_64', 'macos-26-intel')]
ON_REQUEST = "if: github.event_name == 'workflow_dispatch'"


def desktop_macos_problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
    if triggers != ['pull_request', 'workflow_dispatch']:
        found.append(f'triggers are {triggers}, not pull_request and workflow_dispatch')
    if sorted(section(top, 'permissions')) != [('actions', 'read'), ('contents', 'read')]:
        found.append('the top-level permissions are not contents: read and actions: read')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-pages-artifact|actions/cache|rust-cache@', 'a cache or pages upload')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if len(all_jobs) != 1:
        found.append(f'{len(all_jobs)} jobs, not one')
    for name, job in all_jobs.items():
        found += runner_problems(name, job, '${{ matrix.runner }}')
        matrix = re.findall(r'^          - arch: (\S+)\n            runner: (\S+)$', '\n'.join(job), re.M)
        if matrix != MACOS_RUNNERS:
            found.append(f'job {name} builds {matrix}, not arm64 on macos-26 and x86_64 on macos-26-intel')
        steps = steps_of(job)
        def first(predicate):
            return next((i for i, step in enumerate(steps) if predicate(step)), None)
        gate = first(lambda step: ON_REQUEST in step and '[ "$GITHUB_REF" = refs/heads/main ]' in step
                     and 'actions/workflows/ci.yml/runs' in step and 'status=success' in step)
        checkout = first(lambda step: 'actions/checkout@' in step)
        uploads = [i for i, step in enumerate(steps) if 'actions/upload-artifact@' in step]
        if gate is None or checkout is None or gate > checkout:
            found.append(f'job {name} does not require main with passed CI before checkout, on request')
        if checkout is not None and 'persist-credentials: false' not in steps[checkout]:
            found.append(f'job {name} keeps the checkout credentials')
        if len(uploads) != 1 or MACOS_UPLOAD_NAME not in steps[uploads[0]]:
            found.append(f'job {name} does not upload exactly the one macOS artifact')
        elif ON_REQUEST not in steps[uploads[0]]:
            found.append(f'job {name} uploads from a pull request')
    return found


# The iOS workflow's only upload, as its step reads without comments: the
# connection page's screenshots, never the app, logs or a Core's pages.
IOS_UPLOAD = """      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: ios-simulator-screenshots-${{ github.sha }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/checks/screenshots/*.png
          if-no-files-found: error
          retention-days: 3"""
IOS_SCREENSHOTS = 'expected="app-portrait.png app-refused.png"'


def ios_problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
    if triggers != ['pull_request']:
        found.append(f'triggers are {triggers}, not pull_request only')
    if sorted(section(top, 'permissions')) != [('contents', 'read')]:
        found.append('the top-level permissions are not contents: read only')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-pages-artifact', 'a pages upload'),
                          (r'actions/cache|rust-cache@', 'a cache')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if len(all_jobs) != 1:
        found.append(f'{len(all_jobs)} jobs, not one')
    for name, job in all_jobs.items():
        found += runner_problems(name, job, 'macos-26')
        steps = steps_of(job)
        checkout = next((step for step in steps if 'actions/checkout@' in step), None)
        if checkout is None or 'persist-credentials: false' not in checkout:
            found.append(f'job {name} keeps the checkout credentials')
        uploads = [i for i, step in enumerate(steps) if 'upload-artifact' in step]
        check = next((i for i, step in enumerate(steps)
                      if IOS_SCREENSHOTS in step and '= 89504e470d0a1a0a ]' in step), None)
        if len(uploads) != 1 or steps[uploads[0]].rstrip() != IOS_UPLOAD:
            found.append(f'job {name} does not upload exactly the Simulator screenshots')
        elif check is None or check > uploads[0]:
            found.append(f'job {name} does not check the screenshots before uploading them')
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

    def test_the_release_inputs_workflow_keeps_its_rules(self):
        self.assertEqual(release_inputs_problems(RELEASE_INPUTS.read_text()), [])

    def test_each_broken_release_inputs_rule_is_reported(self):
        good = RELEASE_INPUTS.read_text()
        upload = '      - uses: actions/upload-artifact@'
        cases = {
            'a push trigger': (good.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n', 1), 'triggers'),
            'a write permission': (good.replace('  actions: read', '  actions: write', 1), 'permissions'),
            'a wider token': (good.replace('  actions: read\n', '  actions: read\n  pull-requests: read\n', 1), 'permissions'),
            'a secret': (good.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.X }}', 1), 'a secret'),
            'a self-hosted runner': (good.replace('runs-on: ubuntu-24.04', 'runs-on: [self-hosted, linux]', 1), 'self-hosted'),
            'a Rust cache': (good.replace('      - name: Runner details', '      - uses: Swatinem/rust-cache@9d47c6ad4b02e050fd481d890b2ea34778fd09d6\n      - name: Runner details', 1), 'cache'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'any branch': (good.replace('[ "$GITHUB_REF" = refs/heads/main ] ||', 'true ||', 1), 'passed CI before checkout'),
            'no CI lookup': (good.replace('-f status=success', '-f status=completed', 1), 'passed CI before checkout'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
            'another artifact name': (good.replace('name: core-inputs-${{ github.sha }}', 'name: inputs-${{ github.sha }}', 1), 'one core-inputs artifact'),
            'a second upload': (good.replace(upload, upload + 'ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: target\n' + upload, 1), 'one core-inputs artifact'),
            'no check before upload': (good.replace('-I tools/release-inputs-check.py', '-I tools/other.py', 1), 'check the inputs'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in release_inputs_problems(text)), release_inputs_problems(text))

    def test_the_desktop_macos_workflow_keeps_its_rules(self):
        self.assertEqual(desktop_macos_problems(DESKTOP_MACOS.read_text()), [])

    def test_each_broken_desktop_macos_rule_is_reported(self):
        good = DESKTOP_MACOS.read_text()
        upload = '      - uses: actions/upload-artifact@'
        cases = {
            'a push trigger': (good.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n', 1), 'triggers'),
            'pull_request_target': (good.replace('  pull_request:\n', '  pull_request_target:\n', 1), 'triggers'),
            'a write permission': (good.replace('  actions: read', '  actions: write', 1), 'permissions'),
            'a secret': (good.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.X }}', 1), 'a secret'),
            'a larger runner': (good.replace('runner: macos-26-intel\n', 'runner: macos-26-large\n', 1), 'not arm64 on macos-26'),
            'a third runner': (good.replace('            runner: macos-26-intel\n', '            runner: macos-26-intel\n'
                                            '          - arch: x86_64\n            runner: macos-15-intel\n', 1), 'not arm64 on macos-26'),
            'a runner outside the matrix': (good.replace('runs-on: ${{ matrix.runner }}', 'runs-on: macos-26', 1), 'not ${{ matrix.runner }}'),
            'a self-hosted runner': (good.replace('runs-on: ${{ matrix.runner }}', 'runs-on: [self-hosted, macOS, ARM64]', 1), 'self-hosted'),
            'a Rust cache': (good.replace('      - name: Runner details', '      - uses: Swatinem/rust-cache@9d47c6ad4b02e050fd481d890b2ea34778fd09d6\n      - name: Runner details', 1), 'cache'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'any branch': (good.replace('[ "$GITHUB_REF" = refs/heads/main ] ||', 'true ||', 1), 'passed CI before checkout'),
            'no CI lookup': (good.replace('-f status=success', '-f status=completed', 1), 'passed CI before checkout'),
            'a gate that never runs': (good.replace(ON_REQUEST, 'if: false', 1), 'passed CI before checkout'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
            'an upload from PRs': (good.replace(f'{upload}ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        {ON_REQUEST}\n',
                                                f'{upload}ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n', 1), 'from a pull request'),
            'another artifact name': (good.replace('name: yuzuno-macos-${{ matrix.arch }}-${{ github.sha }}', 'name: macos-${{ github.sha }}', 1), 'one macOS artifact'),
            'a second upload': (good.replace(upload, upload + 'ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: target\n' + upload, 1), 'one macOS artifact'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in desktop_macos_problems(text)), desktop_macos_problems(text))

    def test_the_ios_workflow_keeps_its_rules(self):
        self.assertEqual(ios_problems(IOS.read_text()), [])

    def test_each_broken_ios_rule_is_reported(self):
        good = IOS.read_text()
        cases = {
            'a request trigger': (good.replace('  pull_request:\n', '  workflow_dispatch:\n  pull_request:\n', 1), 'triggers'),
            'pull_request_target': (good.replace('  pull_request:\n', '  pull_request_target:\n', 1), 'triggers'),
            'a write permission': (good.replace('  contents: read', '  contents: write', 1), 'permissions'),
            'a wider token': (good.replace('  contents: read\n', '  contents: read\n  actions: read\n', 1), 'permissions'),
            'a secret': (good.replace('          persist-credentials: false\n', '          persist-credentials: false\n          token: ${{ secrets.X }}\n', 1), 'a secret'),
            'a larger runner': (good.replace('runs-on: macos-26\n', 'runs-on: macos-26-xlarge\n', 1), 'not macos-26'),
            'a self-hosted runner': (good.replace('runs-on: macos-26\n', 'runs-on: [self-hosted, macOS, ARM64]\n', 1), 'self-hosted'),
            'a Rust cache': (good.replace('      - name: Runner details', '      - uses: Swatinem/rust-cache@9d47c6ad4b02e050fd481d890b2ea34778fd09d6\n      - name: Runner details', 1), 'cache'),
            'a pages upload': (good.replace('      - name: Runner details', '      - uses: actions/upload-pages-artifact@0000000000000000000000000000000000000000\n      - name: Runner details', 1), 'a pages upload'),
            'a second upload': (good.replace('      - name: Runner details', '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n      - name: Runner details', 1), 'exactly the Simulator screenshots'),
            'the app uploaded': (good.replace('path: ${{ runner.temp }}/checks/screenshots/*.png', 'path: ${{ runner.temp }}/out/Yuzuno-iOS-Simulator.zip', 1), 'exactly the Simulator screenshots'),
            'the whole directory': (good.replace('path: ${{ runner.temp }}/checks/screenshots/*.png', 'path: ${{ runner.temp }}/checks/screenshots', 1), 'exactly the Simulator screenshots'),
            'a second path': (good.replace('path: ${{ runner.temp }}/checks/screenshots/*.png', 'path: |\n            ${{ runner.temp }}/checks/screenshots/*.png\n            gen/apple', 1), 'exactly the Simulator screenshots'),
            'kept longer': (good.replace('retention-days: 3', 'retention-days: 30', 1), 'exactly the Simulator screenshots'),
            'kept by default': (good.replace('          retention-days: 3\n', '', 1), 'exactly the Simulator screenshots'),
            'missing files allowed': (good.replace('if-no-files-found: error', 'if-no-files-found: warn', 1), 'exactly the Simulator screenshots'),
            'an upload after a failure': (good.replace('      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n',
                                                      '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        if: always()\n', 1), 'exactly the Simulator screenshots'),
            'no screenshot check': (good.replace('= 89504e470d0a1a0a ]', '!= x ]', 1), 'check the screenshots'),
            'other screenshots allowed': (good.replace(IOS_SCREENSHOTS, 'expected="$(ls -A "$dir")"', 1), 'check the screenshots'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in ios_problems(text)), ios_problems(text))

    def test_the_guard_refuses_any_runner_but_a_github_hosted_one(self):
        for environment, code in [('self-hosted', 1), ('', 1), ('github-hosted', 0)]:
            with self.subTest(environment or 'unset'):
                env = {k: v for k, v in os.environ.items() if k not in ('RUNNER_ENVIRONMENT', 'GITHUB_STEP_SUMMARY')}
                if environment:
                    env['RUNNER_ENVIRONMENT'] = environment
                run = subprocess.run([str(GUARD)], env=env, capture_output=True, text=True)
                self.assertEqual(run.returncode, code, run.stdout + run.stderr)

    def test_the_guard_describes_a_mac_runner(self):
        with tempfile.TemporaryDirectory() as temp:
            bindir = Path(temp)
            (bindir / 'uname').write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n')
            (bindir / 'sysctl').write_text('#!/bin/sh\ncase "$2" in hw.ncpu) echo 3;; hw.memsize) echo 7516192768;; esac\n')
            for tool in ('uname', 'sysctl'):
                (bindir / tool).chmod(0o755)
            env = {k: v for k, v in os.environ.items() if k != 'GITHUB_STEP_SUMMARY'}
            env.update(RUNNER_ENVIRONMENT='github-hosted', PATH=f'{bindir}:' + os.environ['PATH'])
            run = subprocess.run([str(GUARD)], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn('arm64, 3 CPUs, 7 GiB memory', run.stdout)

    def test_the_disk_precheck_reads_macos_df(self):
        with tempfile.TemporaryDirectory() as temp:
            bindir = Path(temp)
            # BSD df: no --output; -P gives 1024-byte blocks.
            (bindir / 'df').write_text('#!/bin/sh\ncase "$*" in *--output*) echo "df: illegal option" >&2; exit 1;; '
                                       '*-Pk*) printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
                                       '/dev/disk3s1s1 100000000 1 %s 1%% /\\n" "$FAKE_KIB";; esac\n')
            (bindir / 'df').chmod(0o755)
            env = dict(os.environ, PATH=f'{bindir}:' + os.environ['PATH'])
            for kib, code, says in [(7 * 1048576, 0, '7 GiB free'), (5 * 1048576, 1, 'Not enough disk space'), ('', 1, 'Disk space unknown')]:
                with self.subTest(kib=kib):
                    run = subprocess.run([str(DISK_PRECHECK), '6', temp], env=dict(env, FAKE_KIB=str(kib)), capture_output=True, text=True)
                    self.assertEqual(run.returncode, code, run.stdout + run.stderr)
                    self.assertIn(says, run.stdout)

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
