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
only; no secret, cache or other runner. It has one job per platform, each on
its own standard runner (YN-108): Linux on ubuntu-24.04, macOS on macos-26.
Each builds only main whose push CI passed, checks the inputs (never the
Claude Agent SDK) before uploading its one core-inputs artifact; the Mac job
also smokes its binaries before that.

.github/workflows/desktop-macos.yml (T-165) builds the macOS app on the
standard GitHub-hosted macOS 26 runner, for Apple silicon (arm64) only: Intel
Macs are not supported (YN-161). Only pull_request and
workflow_dispatch trigger it; its token reads contents and actions only; no
secret, cache or other runner. Only a run on request uploads, and such a run
builds only main whose push CI passed: one macOS artifact, or with lab
(YN-191) the update lab's two instead. The lab key is made and deleted in one
step, in the runner's temporary folder, and no upload names it.

.github/workflows/ios.yml (T-170) builds the iOS app for the Simulator,
unsigned, on the standard GitHub-hosted macos-26 runner. Only pull_request
triggers it; its token reads contents only; no secret, cache or other
runner. Its one upload is the Simulator smoke's two screenshots of the
connection page, exactly as IOS_UPLOAD names them and kept for 3 days, after
a step that checks there are only those two PNG files.

.github/workflows/core-macos.yml (YN-108) builds and tests Core on the
standard GitHub-hosted macos-26 runner. Only push to main and pull_request
trigger it, for the same Core paths; its token reads contents only; no
secret, upload, general cache or other runner, and the Cargo cache is saved
only from main, as in CI.

.github/workflows/dsh-contract.yml (YN-126) runs the dsh contract probe once
a day on GitHub-hosted ubuntu-24.04. Only schedule, workflow_dispatch and
pull_request trigger it, the last only for the probe, the runner check and
the workflow itself, so it never runs for (or holds up) any other pull
request. Its token reads contents only; no secret, model key, upload, cache
or other runner. It installs npm's latest and next of @deepseek-ai/dsh into
$RUNNER_TEMP only, without install scripts, and no step's failure is
ignored.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import textwrap
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
CORE_MACOS = ROOT / '.github/workflows/core-macos.yml'
DSH_CONTRACT = ROOT / '.github/workflows/dsh-contract.yml'
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


UPLOAD_NAME = 'name: core-inputs-linux-x86_64-${{ github.sha }}-${{ github.run_attempt }}'
# Each platform's job: its runner and the name of its one artifact
# (tools/core-release.py reads exactly these two).
RELEASE_INPUT_JOBS = {
    'inputs': ('ubuntu-24.04', UPLOAD_NAME),
    'macos-aarch64': ('macos-26', 'name: core-inputs-macos-aarch64-${{ github.sha }}-${{ github.run_attempt }}'),
}


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
    if sorted(all_jobs) != sorted(RELEASE_INPUT_JOBS):
        found.append(f'the jobs are {sorted(all_jobs)}, not {sorted(RELEASE_INPUT_JOBS)}')
    for name, job in all_jobs.items():
        image, upload_name = RELEASE_INPUT_JOBS.get(name, ('ubuntu-24.04', UPLOAD_NAME))
        found += runner_problems(name, job, image)
        steps = steps_of(job)
        def first(predicate):
            return next((i for i, step in enumerate(steps) if predicate(step)), None)
        gate = first(lambda step: '[ "$GITHUB_REF" = refs/heads/main ]' in step
                     and 'CI_RUN_ID: ${{ inputs.ci_run_id }}' in step
                     and 'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$CI_RUN_ID"' in step
                     and '.conclusion == "success"' in step)
        checkout = first(lambda step: 'actions/checkout@' in step)
        check = first(lambda step: 'tools/release-inputs-check.py' in step)
        uploads = [i for i, step in enumerate(steps) if 'actions/upload-artifact@' in step]
        if gate is None or checkout is None or gate > checkout:
            found.append(f'job {name} does not require main with passed CI before checkout')
        if checkout is not None and 'persist-credentials: false' not in steps[checkout]:
            found.append(f'job {name} keeps the checkout credentials')
        if len(uploads) != 1 or upload_name not in steps[uploads[0]]:
            found.append(f'job {name} does not upload exactly its one core-inputs artifact')
        elif check is None or check > uploads[0]:
            found.append(f'job {name} does not check the inputs before uploading')
        if name == 'macos-aarch64':
            smoke = first(lambda step: 'tools/release-inputs-smoke.py' in step)
            if smoke is None or (len(uploads) == 1 and smoke > uploads[0]):
                found.append(f'job {name} does not smoke its binaries before uploading')
    return found


MACOS_UPLOAD_NAME = "name: yuzuno-macos-${{ matrix.arch }}-${{ inputs.version || 'source' }}-${{ github.sha }}-${{ github.run_attempt }}"
# Apple silicon on its standard runner, and nothing else (YN-161).
MACOS_RUNNERS = [('arm64', 'macos-26')]
ON_REQUEST = "if: github.event_name == 'workflow_dispatch'"
# The update lab's two uploads (YN-191 S5), only on request with lab; the
# regular one only without it.
MACOS_LAB_UPLOAD_NAMES = ['name: yuzuno-macos-${{ matrix.arch }}-lab-install-${{ github.sha }}-${{ github.run_attempt }}',
                          'name: yuzuno-macos-${{ matrix.arch }}-lab-feed-${{ github.sha }}-${{ github.run_attempt }}']
LAB_ONLY = ON_REQUEST + ' && inputs.lab'
NOT_LAB = ON_REQUEST + ' && !inputs.lab'
LAB_KEY_STEP = ['lab="$RUNNER_TEMP/lab"', 'trap \'rm -f "$lab/lab.key"\' EXIT', 'signer generate --ci -w "$lab/lab.key"',
                'rm -f "$lab/lab.key"\n          [ ! -e "$lab/lab.key" ]']


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
            found.append(f'job {name} builds {matrix}, not arm64 on macos-26')
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
        uploaded = [steps[i] for i in uploads]
        regular = [step for step in uploaded if MACOS_UPLOAD_NAME in step]
        lab = [next(n for n in MACOS_LAB_UPLOAD_NAMES if n in step) for step in uploaded
               if any(n in step for n in MACOS_LAB_UPLOAD_NAMES)]
        if len(regular) != 1 or sorted(lab) != sorted(MACOS_LAB_UPLOAD_NAMES) or len(uploaded) != 3:
            found.append(f'job {name} does not upload exactly the one macOS artifact and the two lab artifacts')
        elif any(ON_REQUEST not in step for step in uploaded):
            found.append(f'job {name} uploads from a pull request')
        elif NOT_LAB not in regular[0] or any(LAB_ONLY not in step for step in uploaded if step not in regular):
            found.append(f'job {name} mixes the lab and the regular uploads')
        if any(re.search(r'/lab/|lab\.key(?!\.pub)', step) for step in uploaded):
            found.append(f'job {name} uploads the lab key')
        generate = [step for step in steps if 'signer generate' in step]
        if len(generate) != 1 or any(part not in generate[0] for part in LAB_KEY_STEP) or LAB_ONLY not in generate[0]:
            found.append(f'job {name} does not keep the lab key to one lab step in the runner\'s temporary folder')
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


def trigger_paths(top, trigger):
    """The paths: filter listed under one trigger of on:."""
    start = top.index(f'  {trigger}:')
    found, inside = [], False
    for line in top[start + 1:]:
        if not line.startswith('    '):
            break
        if line.strip() == 'paths:':
            inside = True
        elif inside and line.strip().startswith('- '):
            found.append(line.strip()[2:])
        elif not line.startswith('      '):
            inside = False
    return found


def core_macos_problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
    if triggers != ['push', 'pull_request']:
        found.append(f'triggers are {triggers}, not push and pull_request')
    elif 'core/**' not in trigger_paths(top, 'push') or trigger_paths(top, 'push') != trigger_paths(top, 'pull_request'):
        found.append('push and pull_request do not watch the same Core paths')
    if sorted(section(top, 'permissions')) != [('contents', 'read')]:
        found.append('the top-level permissions are not contents: read only')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-artifact|upload-pages-artifact|actions/cache/save', 'an upload or cache save')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if len(all_jobs) != 1:
        found.append(f'{len(all_jobs)} jobs, not one')
    for name, job in all_jobs.items():
        found += runner_problems(name, job, 'macos-26')
        steps = '\n'.join(job)
        checkout = next((step for step in steps_of(job) if 'actions/checkout@' in step), None)
        if checkout is None or 'persist-credentials: false' not in checkout:
            found.append(f'job {name} keeps the checkout credentials')
        node = steps.count('actions/setup-node@')
        if node and (steps.count('package-manager-cache: false') != node or re.search(r'^\s+cache(-dependency-path)?:', steps, re.M)):
            found.append(f'job {name} may cache npm packages')
        if re.search(r'actions/cache(/restore)?@', steps):
            found.append(f'job {name} uses a general cache')
        saves = re.findall(r'save-if:\s*(.+)', steps)
        if saves != ["${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"] * steps.count('rust-cache@'):
            found.append(f'job {name} may save the Rust cache outside a push to main')
        if '.github/scripts/core_tests.py' not in steps or 'cargo build --locked --all-targets' not in steps:
            found.append(f'job {name} does not build and test Core as CI does')
    return found


# The only changes that run the dsh contract probe on a pull request.
DSH_CONTRACT_PATHS = ['tools/dsh_contract_probe.py', '.github/scripts/hosted-guard.sh',
                      '.github/workflows/dsh-contract.yml']
DSH_INSTALL = 'npm install --prefix "$RUNNER_TEMP/dsh" '


def dsh_contract_problems(text):
    lines = code_lines(text)
    found = []
    body = '\n'.join(lines)
    top = lines[:lines.index('jobs:')]
    triggers = [key for key, _ in section(top, 'on')]
    if triggers != ['schedule', 'workflow_dispatch', 'pull_request']:
        found.append(f'triggers are {triggers}, not schedule, workflow_dispatch and pull_request')
    elif sorted(trigger_paths(top, 'pull_request')) != sorted(DSH_CONTRACT_PATHS) or 'paths-ignore' in body:
        found.append('pull_request does not watch only the probe, the runner check and this workflow')
    if sorted(section(top, 'permissions')) != [('contents', 'read')]:
        found.append('the top-level permissions are not contents: read only')
    for pattern, what in [(r'pull_request_target|workflow_run', 'a privileged trigger'),
                          (r'secrets\.', 'a secret'),
                          (r'\b(DEEPSEEK|ANTHROPIC)_', 'a model key or endpoint'),
                          (r':\s*write\b', 'a write permission'),
                          (r'self-hosted', 'a self-hosted label'),
                          (r'upload-artifact|upload-pages-artifact|actions/cache|rust-cache@', 'an upload or cache'),
                          (r'continue-on-error', 'a step whose failure is ignored')]:
        if re.search(pattern, body):
            found.append(f'it uses {what}')
    found += unpinned(lines)
    all_jobs = jobs(lines)
    if len(all_jobs) != 1:
        found.append(f'{len(all_jobs)} jobs, not one')
    for name, job in all_jobs.items():
        found += runner_problems(name, job)
        joined = '\n'.join(job)
        tags = re.findall(r'^        tag: \[(.*)\]$', joined, re.M)
        if tags != ['latest, next']:
            found.append(f'job {name} probes {tags}, not latest and next')
        steps = steps_of(job)
        checkout = next((step for step in steps if 'actions/checkout@' in step), None)
        if checkout is None or 'persist-credentials: false' not in checkout:
            found.append(f'job {name} keeps the checkout credentials')
        if (joined.count('actions/setup-node@') != joined.count('package-manager-cache: false')
                or re.search(r'^\s+cache(-dependency-path)?:', joined, re.M)):
            found.append(f'job {name} may cache npm packages')
        installs = [i for i, step in enumerate(steps) if 'npm install' in step or 'npm i ' in step]
        if (len(installs) != 1 or DSH_INSTALL not in steps[installs[0]] or '--ignore-scripts' not in steps[installs[0]]
                or re.search(r'\s(-g|--global)\b', steps[installs[0]])):
            found.append(f'job {name} does not install dsh into $RUNNER_TEMP only, without install scripts')
        probe = [i for i, step in enumerate(steps) if 'python3 tools/dsh_contract_probe.py --dsh "$RUNNER_TEMP/dsh/' in step]
        if len(probe) != 1 or (installs and installs[0] > probe[0]):
            found.append(f'job {name} does not run the contract probe on the installed dsh')
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

    def test_release_gate_checks_the_dispatched_ci_run(self):
        repo, sha, run_id = 'owner/repo', 'a' * 40, '101'
        response = {
            'id': 101, 'path': '.github/workflows/ci.yml',
            'repository': {'full_name': repo}, 'head_repository': {'full_name': repo},
            'head_branch': 'main', 'head_sha': sha, 'event': 'push',
            'status': 'completed', 'conclusion': 'success',
        }
        # The check runs before checkout on both platforms. Exercise the shipped shell
        # against an exact-run API stand-in, including an unavailable response.
        steps = jobs(code_lines(RELEASE_INPUTS.read_text()))
        commands = []
        for name in RELEASE_INPUT_JOBS:
            gate = next(step for step in steps_of(steps[name]) if '- name: Main, with passed CI' in step)
            commands.append(textwrap.dedent(gate.split('        run: |\n', 1)[1]))
        self.assertEqual(commands[0], commands[1])
        with tempfile.TemporaryDirectory() as directory:
            gh = Path(directory) / 'gh'
            gh.write_text('#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = api ] && '
                          '[ "$2" = repos/owner/repo/actions/runs/101 ] || exit 1\n'
                          'printf "%s" "$RUN_JSON"\nexit "$API_EXIT"\n')
            gh.chmod(0o755)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                   'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': repo, 'GITHUB_SHA': sha,
                   'CI_RUN_ID': run_id, 'RUN_JSON': json.dumps(response), 'API_EXIT': '0'}

            def run(**overrides):
                return subprocess.run(['bash', '-e', '-c', commands[0]], env={**env, **overrides},
                                      capture_output=True, text=True)

            valid = run()
            self.assertEqual(valid.returncode, 0, valid.stderr)
            for key, value in [('id', 102), ('path', '.github/workflows/other.yml'), ('head_sha', 'b' * 40),
                               ('repository', {'full_name': 'other/repo'}), ('head_repository', None),
                               ('head_branch', 'work'), ('event', 'pull_request'),
                               ('status', 'in_progress'), ('conclusion', 'failure')]:
                with self.subTest(key=key):
                    self.assertNotEqual(run(RUN_JSON=json.dumps({**response, key: value})).returncode, 0)
            for overrides in [{'GITHUB_REF': 'refs/heads/work'}, {'CI_RUN_ID': ''}, {'CI_RUN_ID': '1/2'},
                              {'API_EXIT': '1'}, {'RUN_JSON': ''}, {'RUN_JSON': '{}'}]:
                with self.subTest(overrides=overrides):
                    self.assertNotEqual(run(**overrides).returncode, 0)

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
            'wrong run lookup': (good.replace('actions/runs/$CI_RUN_ID', 'actions/runs/100', 1), 'passed CI before checkout'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
            'another artifact name': (good.replace('name: core-inputs-linux-x86_64-${{ github.sha }}', 'name: inputs-${{ github.sha }}', 1), 'one core-inputs artifact'),
            'a second upload': (good.replace(upload, upload + 'ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: target\n' + upload, 1), 'one core-inputs artifact'),
            'no check before upload': (good.replace('-I tools/release-inputs-check.py', '-I tools/other.py', 1), 'check the inputs'),
            'the Mac job on a paid runner': (good.replace('runs-on: macos-26', 'runs-on: macos-26-xlarge', 1), 'not macos-26'),
            'the Mac job on Linux': (good.replace('runs-on: macos-26', 'runs-on: ubuntu-24.04', 1), 'not macos-26'),
            "the Mac artifact under Linux's name": (good.replace('name: core-inputs-macos-aarch64-', 'name: core-inputs-', 1), 'macos-aarch64 does not upload'),
            'no Mac check before upload': (good.replace('-I tools/release-inputs-check.py --platform macos-aarch64', '-I tools/other.py', 1), 'macos-aarch64 does not check'),
            'no Mac smoke': (good.replace('-I tools/release-inputs-smoke.py', '-I tools/other.py', 1), 'smoke its binaries'),
            'any branch on the Mac': (good.replace('[ "$GITHUB_REF" = refs/heads/main ] ||', 'true ||').replace('true ||', '[ "$GITHUB_REF" = refs/heads/main ] ||', 1), 'macos-aarch64 does not require main'),
            'a third job': (good.replace('\n  macos-aarch64:\n', '\n  windows:\n    runs-on: windows-2025\n    steps:\n      - run: true\n\n  macos-aarch64:\n', 1), 'the jobs are'),
            'one job only': (good[:good.index('\n  macos-aarch64:\n')] + '\n', 'the jobs are'),
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
            'a larger runner': (good.replace('runner: macos-26\n', 'runner: macos-26-large\n', 1), 'not arm64 on macos-26'),
            'an Intel runner': (good.replace('          - arch: arm64\n            runner: macos-26\n',
                                             '          - arch: arm64\n            runner: macos-26\n'
                                             '          - arch: x86_64\n            runner: macos-26-intel\n', 1), 'not arm64 on macos-26'),
            'a runner outside the matrix': (good.replace('runs-on: ${{ matrix.runner }}', 'runs-on: macos-26', 1), 'not ${{ matrix.runner }}'),
            'a self-hosted runner': (good.replace('runs-on: ${{ matrix.runner }}', 'runs-on: [self-hosted, macOS, ARM64]', 1), 'self-hosted'),
            'a Rust cache': (good.replace('      - name: Runner details', '      - uses: Swatinem/rust-cache@9d47c6ad4b02e050fd481d890b2ea34778fd09d6\n      - name: Runner details', 1), 'cache'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'any branch': (good.replace('[ "$GITHUB_REF" = refs/heads/main ] ||', 'true ||', 1), 'passed CI before checkout'),
            'no CI lookup': (good.replace('-f status=success', '-f status=completed', 1), 'passed CI before checkout'),
            'a gate that never runs': (good.replace(ON_REQUEST, 'if: false', 1), 'passed CI before checkout'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
            'an upload from PRs': (good.replace(f'{upload}ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        {NOT_LAB}\n',
                                                f'{upload}ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n', 1), 'from a pull request'),
            'another artifact name': (good.replace("name: yuzuno-macos-${{ matrix.arch }}-${{ inputs.version || 'source' }}-${{ github.sha }}", 'name: macos-${{ github.sha }}', 1), 'one macOS artifact'),
            'a second upload': (good.replace(upload, upload + 'ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: target\n' + upload, 1), 'one macOS artifact'),
            'no lab feed upload': (good.replace('-lab-feed-${{ github.sha }}', '-feed-${{ github.sha }}', 1), 'two lab artifacts'),
            'a lab upload from PRs': (good.replace(f"{LAB_ONLY}\n        with:\n          name: yuzuno-macos-${{{{ matrix.arch }}}}-lab-install",
                                                   "if: inputs.lab\n        with:\n          name: yuzuno-macos-${{ matrix.arch }}-lab-install", 1), 'from a pull request'),
            'the regular upload in a lab run': (good.replace(NOT_LAB, ON_REQUEST, 1), 'mixes the lab and the regular'),
            'a lab upload without lab': (good.replace(f"{LAB_ONLY}\n        with:\n          name: yuzuno-macos-${{{{ matrix.arch }}}}-lab-feed",
                                                      f"{ON_REQUEST}\n        with:\n          name: yuzuno-macos-${{{{ matrix.arch }}}}-lab-feed", 1), 'mixes the lab and the regular'),
            'the lab key uploaded': (good.replace('            ${{ runner.temp }}/lab-install/SHA256SUMS\n',
                                                  '            ${{ runner.temp }}/lab-install/SHA256SUMS\n            ${{ runner.temp }}/lab/lab.key\n', 1), 'uploads the lab key'),
            'the lab key folder uploaded': (good.replace('path: ${{ runner.temp }}/lab-feed/', 'path: ${{ runner.temp }}/lab/', 1), 'uploads the lab key'),
            'the lab key kept on failure': (good.replace('trap \'rm -f "$lab/lab.key"\' EXIT\n', '', 1), 'lab key to one lab step'),
            'the lab key kept': (good.replace('rm -f "$lab/lab.key"\n          [ ! -e "$lab/lab.key" ]\n', '', 1), 'lab key to one lab step'),
            'the lab key elsewhere': (good.replace('lab="$RUNNER_TEMP/lab" ', 'lab="$GITHUB_WORKSPACE/lab" ', 1), 'lab key to one lab step'),
            'a lab key in a pull request': (good.replace(f"{LAB_ONLY}\n        shell: bash\n        run: |\n          lab=", "if: true\n        shell: bash\n        run: |\n          lab=", 1), 'lab key to one lab step'),
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

    def test_the_core_macos_build_fails_only_when_cargo_does(self):
        # The Build step's own script, run as GitHub runs it (bash -e), with a
        # stand-in cargo: the timing reports are report-only (YN-235), so a
        # missing one must not stop the build or skip the tests after it, and
        # a failed cargo must still fail the step.
        lines = CORE_MACOS.read_text().splitlines()
        start = lines.index('      - name: Build')
        run = lines.index('        run: |', start)
        script = []
        for line in lines[run + 1:]:
            if line and not line.startswith('          '):
                break
            script.append(line[10:])
        cargo = textwrap.dedent('''\
            #!/bin/sh
            echo "$*" >> "$STUB_LOG"
            n=$(wc -l < "$STUB_LOG")
            [ "$n" = "$STUB_FAIL_AT" ] && exit 42
            case " $STUB_REPORTS " in *" $n "*)
              mkdir -p target/cargo-timings && echo "report $n" > target/cargo-timings/cargo-timing.html ;;
            esac
            exit 0
            ''')
        cases = {  # (reports written at calls, cargo fails at call): (exit, calls, copies)
            ('1 2', ''): (0, 2, {'1': 'report 1', '2': 'report 2'}),
            ('2', ''): (0, 2, {'2': 'report 2'}),
            ('1', ''): (0, 2, {'1': 'report 1'}),  # step 1's report is not taken for step 2's
            ('', ''): (0, 2, {}),
            ('1 2', '1'): (42, 1, {}),
            ('1 2', '2'): (42, 2, {'1': 'report 1'}),
        }
        for (reports, fail), (code, calls, copies) in cases.items():
            with self.subTest(reports=reports, fail=fail), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                (tmp / 'bin').mkdir()
                (tmp / 'bin/cargo').write_text(cargo)
                (tmp / 'bin/cargo').chmod(0o755)
                (tmp / 'work').mkdir()
                (tmp / 'runner').mkdir()
                (tmp / 'build.sh').write_text('\n'.join(script) + '\n')
                env = {**os.environ, 'PATH': f"{tmp / 'bin'}:{os.environ['PATH']}", 'STUB_LOG': str(tmp / 'calls'),
                       'STUB_REPORTS': reports, 'STUB_FAIL_AT': fail,
                       'GITHUB_WORKSPACE': str(tmp / 'work'), 'RUNNER_TEMP': str(tmp / 'runner')}
                done = subprocess.run(['bash', '-e', str(tmp / 'build.sh')], cwd=tmp / 'work', env=env,
                                      capture_output=True, text=True)
                self.assertEqual(done.returncode, code, done.stdout + done.stderr)
                self.assertEqual(len((tmp / 'calls').read_text().splitlines()), calls)
                found = {name[len('cargo-timing-'):-len('.html')]: (tmp / 'runner' / name).read_text().strip()
                         for name in os.listdir(tmp / 'runner') if name.startswith('cargo-timing-')}
                self.assertEqual(found, copies)
                if code == 0 and len(copies) < 2:
                    self.assertIn('::warning title=Cargo timings::', done.stdout)
        # The tests after the build still run only when it succeeded.
        test = next(step for step in steps_of(jobs(code_lines(CORE_MACOS.read_text()))['core']) if '- name: Test' in step)
        self.assertNotIn('if:', test)

    def test_the_core_macos_workflow_keeps_its_rules(self):
        self.assertEqual(core_macos_problems(CORE_MACOS.read_text()), [])

    def test_each_broken_core_macos_rule_is_reported(self):
        good = CORE_MACOS.read_text()
        cases = {
            'a request trigger': (good.replace('  pull_request:\n', '  workflow_dispatch:\n  pull_request:\n', 1), 'triggers'),
            'pull_request_target': (good.replace('  pull_request:\n', '  pull_request_target:\n', 1), 'triggers'),
            'other paths for PRs': (good.replace('      - core/**\n', '      - docs/**\n', 2).replace('      - docs/**\n', '      - core/**\n', 1), 'same Core paths'),
            'a write permission': (good.replace('  contents: read', '  contents: write', 1), 'permissions'),
            'a wider token': (good.replace('  contents: read\n', '  contents: read\n  actions: read\n', 1), 'permissions'),
            'a secret': (good.replace('          persist-credentials: false\n', '          persist-credentials: false\n          token: ${{ secrets.X }}\n', 1), 'a secret'),
            'a larger runner': (good.replace('runs-on: macos-26\n', 'runs-on: macos-26-xlarge\n', 1), 'not macos-26'),
            'a self-hosted runner': (good.replace('runs-on: macos-26\n', 'runs-on: [self-hosted, macOS, ARM64]\n', 1), 'self-hosted'),
            'an upload': (good.replace('      - name: Runner details', '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n      - name: Runner details', 1), 'upload'),
            'a general cache': (good.replace('      - name: Runner details', '      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830\n      - name: Runner details', 1), 'general cache'),
            'a cache saved from PRs': (good.replace("save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", 'save-if: true', 1), 'Rust cache'),
            'an npm cache': (good.replace('package-manager-cache: false', 'cache: npm', 1), 'npm packages'),
            'no test runner': (good.replace('          .github/scripts/core_tests.py\n', '          cargo test --locked\n', 1), 'as CI does'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in core_macos_problems(text)), core_macos_problems(text))

    def test_the_dsh_contract_workflow_keeps_its_rules(self):
        self.assertEqual(dsh_contract_problems(DSH_CONTRACT.read_text()), [])

    def test_each_broken_dsh_contract_rule_is_reported(self):
        good = DSH_CONTRACT.read_text()
        probe = '      - name: Contract probe\n'
        cases = {
            'a push trigger': (good.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n', 1), 'triggers'),
            'pull_request_target': (good.replace('  pull_request:\n', '  pull_request_target:\n', 1), 'triggers'),
            'every pull request': (good.replace('    paths:\n      - tools/dsh_contract_probe.py\n', '    paths:\n      - \'**\'\n', 1), 'watch only'),
            'paths ignored instead': (good.replace('    paths:\n', '    paths-ignore:\n', 1), 'watch only'),
            'a write permission': (good.replace('  contents: read', '  contents: write', 1), 'permissions'),
            'a wider token': (good.replace('  contents: read\n', '  contents: read\n  actions: read\n', 1), 'permissions'),
            'a secret': (good.replace('          TAG: ${{ matrix.tag }}\n', '          TAG: ${{ matrix.tag }}\n          X: ${{ secrets.X }}\n', 1), 'a secret'),
            'a model key': (good.replace('          TAG: ${{ matrix.tag }}\n', '          TAG: ${{ matrix.tag }}\n          DEEPSEEK_API_KEY: x\n', 1), 'a model key'),
            'another hosted image': (good.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest', 1), 'not ubuntu-24.04'),
            'a self-hosted runner': (good.replace('runs-on: ubuntu-24.04', 'runs-on: [self-hosted, linux]', 1), 'self-hosted'),
            'an upload': (good.replace(probe, '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n' + probe, 1), 'an upload or cache'),
            'a general cache': (good.replace(probe, '      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830\n' + probe, 1), 'an upload or cache'),
            'an npm cache': (good.replace('package-manager-cache: false', 'cache: npm', 1), 'npm packages'),
            'a failure ignored': (good.replace(probe, probe + '        continue-on-error: true\n', 1), 'failure is ignored'),
            'one tag only': (good.replace('tag: [latest, next]', 'tag: [latest]', 1), 'not latest and next'),
            'a global install': (good.replace('npm install --prefix "$RUNNER_TEMP/dsh"', 'npm install -g', 1), 'into $RUNNER_TEMP only'),
            'another folder': (good.replace('npm install --prefix "$RUNNER_TEMP/dsh"', 'npm install --prefix "$HOME/dsh"', 1), 'into $RUNNER_TEMP only'),
            'install scripts run': (good.replace(' --ignore-scripts', '', 1), 'without install scripts'),
            'a second install': (good.replace(probe, '      - run: npm install -g @deepseek-ai/dsh@latest\n' + probe, 1), 'into $RUNNER_TEMP only'),
            'no probe': (good.replace('python3 tools/dsh_contract_probe.py', 'python3 tools/other.py', 1), 'contract probe'),
            'an unpinned action': (good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7', 1), 'not pinned'),
            'no first-step runner check': (good.replace('[ "$RUNNER_ENVIRONMENT" = github-hosted ] ||', 'true ||', 1), 'first step'),
            'checkout credentials kept': (good.replace('          persist-credentials: false\n', '', 1), 'credentials'),
        }
        for label, (text, message) in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, good, 'the fixture edit did not apply')
                self.assertTrue(any(message in problem for problem in dsh_contract_problems(text)), dsh_contract_problems(text))

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
