#!/usr/bin/env python3
"""The final public candidate, fixed by one spec file and checked in stages.

The spec names the repository, the release tag, the publisher key, the source
commit, and the SHA-256 of the manifest and of the three release files. Every
stage first checks that the install guide downloads from that repository and
writes that key and update source, and that the release files, when given, are
exactly the spec's.

  check      the spec against the guide; with --package-dir also the files, the
             signature and the signed descriptor. Starts nothing.
  package    then install, restart, remove and reinstall offline (package_lab).
             No sign-in.
  sign-in    then the installed Core's own host check, with Claude Code given a
             NEW empty profile: it must say signed out and name that folder and
             the sign-in command. No Agent, no model call, no credential.
  first-use  then the guide's own download and one real turn (first_use_lab),
             and the downloaded files against the spec. A paid model call: run
             it only when the distribution changed.

Local Jobs are checked afterwards with jobs-smoke.py on the first-use lab.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from first_use_lab import REPO, guide_release_source
from package_lab import Lab, interrupt, sha256

ASSETS = ('yuzuno-core-linux-x86_64.tar.gz', 'yuzuno-core-linux-x86_64.json',
          'yuzuno-core-linux-x86_64.json.minisig')
FIELDS = {'repository': r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+',
          'tag': r'[A-Za-z0-9][A-Za-z0-9._-]+',
          # A Minisign public key: "Ed" and 40 bytes, base64.
          'publicKey': r'RW[A-Za-z0-9+/]{54}',
          'sourceSha': r'[0-9a-f]{40}',
          'manifestSha256': r'[0-9a-f]{64}'}
# Ways Claude Code can be signed in without its profile; never passed on.
SIGN_IN_VARIABLES = ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')


def load_spec(text):
    spec = json.loads(text)
    if not isinstance(spec, dict):
        raise ValueError('The spec must be a JSON object')
    problems = [f'{key} is missing or malformed' for key, pattern in FIELDS.items()
                if not isinstance(spec.get(key), str) or not re.fullmatch(pattern, spec[key])]
    assets = spec.get('assets')
    if (not isinstance(assets, dict) or sorted(assets) != sorted(ASSETS)
            or not all(isinstance(v, str) and re.fullmatch(FIELDS['manifestSha256'], v) for v in assets.values())):
        problems.append('assets must map exactly ' + ', '.join(ASSETS) + ' to their SHA-256')
    unknown = sorted(set(spec) - set(FIELDS) - {'assets', 'note'})
    if unknown:
        problems.append('unknown fields: ' + ', '.join(unknown))
    if problems:
        raise ValueError('; '.join(problems))
    return spec


def guide_mismatches(spec, guide):
    """Each place the guide's install path disagrees with the candidate. A
    prerequisite that no longer names a repository (any account can read a
    public one) is not a disagreement."""
    wanted = {'downloadRepository': spec['repository'], 'publicKey': spec['publicKey'],
              'updateRepository': spec['repository'], 'readAccessRepository': spec['repository']}
    return [f"the guide's {name} is {guide[name]!r}, the candidate's {value!r}"
            for name, value in wanted.items()
            if guide[name] != value and not (name == 'readAccessRepository' and guide[name] is None)]


def file_mismatches(spec, package_dir):
    problems = []
    for name in ASSETS:
        path = package_dir / name
        if path.is_symlink() or not path.is_file():
            problems.append(f'{name} is missing')
        elif (actual := sha256(path)) != spec['assets'][name]:
            problems.append(f"{name} has SHA-256 {actual}, the candidate's {spec['assets'][name]}")
    return problems


def descriptor_mismatches(spec, signed):
    """Read only after the signature verified."""
    actual = {'tag': signed.get('tag'), 'repository': signed.get('repository'),
              'sourceSha': (signed.get('manifest') or {}).get('gitSha'),
              'manifestSha256': signed.get('manifestSha256')}
    return [f"the signed {key} is {value!r}, the candidate's {spec[key]!r}"
            for key, value in actual.items() if value != spec[key]]


def manager_group(cgroup):
    """The user manager's group in a /proc/<pid>/cgroup text: a process it
    started, such as a Yuzuno Job, runs below user@<uid>.service."""
    found = re.search(r'^0::(/user\.slice/user-(\d+)\.slice/user@\2\.service)(?:/|$)', cgroup, re.M)
    return found[1] if found else None


def jobs_host():
    """The user manager's cgroup controllers, read as Core's Jobs helper reads
    them (core/src/jobs/host.py, capabilities): local Jobs need cpu, memory and
    pids. A fact about the host running this lab, not about the candidate.
    Without a user bus (inside a Job), the group comes from /proc/self/cgroup."""
    try:
        shown = subprocess.run(['systemctl', '--user', 'show', '--property=ControlGroup', '--value'],
                               capture_output=True, text=True, timeout=15)
        group, source = shown.stdout.strip(), 'systemctl --user'
        if shown.returncode != 0 or not group:
            group, source = manager_group(Path('/proc/self/cgroup').read_text()), '/proc/self/cgroup'
        if not group:
            return {'error': 'Neither systemctl --user nor /proc/self/cgroup names a user manager'}
        controllers = (Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.controllers').read_text().split()
    except (OSError, subprocess.SubprocessError) as error:
        return {'error': f'{type(error).__name__}: {error}'[:300]}
    return {'controlGroup': group, 'source': source, 'controllers': controllers,
            'missing': sorted({'cpu', 'memory', 'pids'} - set(controllers))}


def core_quote(value):
    """How Core quotes a word in the commands it suggests (remote::shell_quote)."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


def sign_in_findings(check, profile, chosen):
    """What Core's host check must say about the chosen Claude Code with an
    empty profile."""
    host = (check.get('host') or {}).get('hostname') or ''
    found = [h for h in check.get('harnesses') or [] if h.get('harness') == 'claude']
    claude = found[0] if len(found) == 1 else {}
    sign_in = claude.get('signIn') or {}
    error, executable = claude.get('error') or '', claude.get('executable') or ''
    command = f'CLAUDE_CONFIG_DIR={core_quote(str(profile))} {core_quote(executable)} auth login'
    return [
        ('Claude Code answered on the Core host, and Core asked it whether it is signed in',
         bool(claude.get('version')) and bool(executable) and bool(sign_in), {'claude': claude}),
        ('It is reported signed out, so Claude Code is shown unavailable',
         sign_in.get('state') == 'signedOut' and claude.get('found') is False, {'signIn': sign_in}),
        ('The folder it reports is the empty profile Core gave it', sign_in.get('folder') == str(profile),
         {'folder': sign_in.get('folder')}),
        ('The tip names this host, that folder and the command to sign in there',
         bool(host) and f'({host})' in error and str(profile) in error and command in error,
         {'host': host, 'command': command, 'error': error}),
        ('Core found the Claude Code chosen for this stage, not another one on its PATH',
         bool(executable) and os.path.realpath(executable) == os.path.realpath(chosen),
         {'executable': executable, 'chosen': str(chosen)}),
    ]


def sign_in_environment(inherited, lab, tools):
    """Core's environment for the sign-in stage: the real HOME and user, the
    lab's own tools folder first on PATH (the chosen node and claude), and a
    new empty Claude profile. Nothing that could sign Claude Code in, and no
    inherited Core or proxy overrides."""
    env = {key: inherited[key] for key in ('HOME', 'USER', 'LOGNAME') if key in inherited}
    env.update(LANG='C.UTF-8', PATH=f'{tools}:/usr/local/bin:/usr/bin:/bin',
               CLAUDE_CONFIG_DIR=str(lab / 'claude-profile'), TMPDIR=str(lab / 'tmp'), DISABLE_AUTOUPDATER='1',
               **{f'XDG_{name.upper()}_HOME': str(lab / 'xdg' / name) for name in ('config', 'cache', 'data', 'state')})
    return env


def link_tools(folder, node, claude):
    """A new folder holding exactly the chosen node and claude, by those names.
    Core looks Claude Code up by name on PATH, and an installed `claude` is
    often a link whose target has another name (npm's cli.js, the native
    installer's versions/<version>); its `#!/usr/bin/env node` finds node."""
    folder.mkdir()
    (folder / 'node').symlink_to(node)
    (folder / 'claude').symlink_to(claude)
    return folder


class Record:
    """Checks for the stages that start no Core, reported like a Lab's."""

    def __init__(self):
        self.report = {'startedAt': time.time(), 'checks': []}

    def check(self, name, ok, **details):
        self.report['checks'].append({'name': name, 'ok': bool(ok), **details})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
        if not ok:
            raise RuntimeError(name)


class CandidateLab(Lab):
    def __init__(self, args, spec):
        super().__init__(SimpleNamespace(lab=args.lab, package_dir=args.package_dir, port=args.port,
                                         public_key=spec['publicKey'], tag=spec['tag'], minisign=args.minisign))
        self.spec = spec

    def verify(self):
        super().verify()
        problems = descriptor_mismatches(self.spec, self.signed)
        self.check('The signed descriptor names the candidate', not problems, mismatches=problems)

    def sign_in(self, node, claude):
        self.verify()
        self.install('sign-in')
        profile = self.lab / 'claude-profile'
        for folder in (profile, self.lab / 'tmp', *(self.lab / 'xdg' / n for n in ('config', 'cache', 'data', 'state'))):
            folder.mkdir(parents=True)
        tools = link_tools(self.lab / 'bin', node, claude)
        self.core_env = sign_in_environment(os.environ, self.lab, tools)
        self.report['signInEnvironment'] = {
            'keys': sorted(self.core_env),
            'operatorVariablesNotPassed': [name for name in SIGN_IN_VARIABLES if name in os.environ]}
        self.start('sign-in')
        # The check the Machines page and New agent run; it waits up to 15 s
        # for `claude auth status`.
        check = json.loads(self.request('/api/machines/local/check', {}, timeout=60))
        self.report['coreHostCheck'] = check
        for name, ok, details in sign_in_findings(check, profile, claude):
            self.check(name, ok, **details)
        self.stop('sign-in')
        entries = sorted(path.name for path in profile.iterdir())
        self.report['profileEntries'] = entries
        self.check('No sign-in appeared in the empty profile', '.credentials.json' not in entries, entries=entries)


def first_use(args, spec, record):
    """The guide's download and one real turn, then the files against the spec."""
    inner = args.report.with_name(args.report.stem + '.first-use.json')
    command = [sys.executable, str(Path(__file__).with_name('install-lab.py')), 'first_use',
               '--lab', str(args.lab), '--tag', spec['tag'], '--public-key', spec['publicKey'],
               '--minisign', str(args.minisign), '--node', str(args.node), '--browser', str(args.browser),
               '--port', str(args.port), '--doc', str(args.doc), '--repository', spec['repository'],
               '--report', str(inner)]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, timeout=1800)
    record.report['firstUse'] = {'command': command, 'exitCode': result.returncode, 'report': str(inner),
                                 'reportSha256': sha256(inner) if inner.is_file() else None}
    record.check('The first-use workflow passed', result.returncode == 0 and inner.is_file()
                 and json.loads(inner.read_text()).get('passed') is True)
    problems = file_mismatches(spec, args.lab / 'download')
    record.check("The guide downloaded exactly the candidate's files", not problems, mismatches=problems)
    # The workflow verified this descriptor's signature; its tag was the only
    # field it compared.
    signed = json.loads((args.lab / 'download' / 'yuzuno-core-linux-x86_64.json').read_text())
    problems = descriptor_mismatches(spec, signed)
    record.check('The signed descriptor names the candidate', not problems, mismatches=problems)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('stage', choices=['check', 'package', 'sign-in', 'first-use'])
    parser.add_argument('--spec', type=Path, required=True, help='the candidate spec (JSON)')
    parser.add_argument('--report', type=Path, required=True, help='a new file, for Job artifact collection')
    parser.add_argument('--doc', type=Path, default=REPO / 'docs/independent-core.md', help='the install guide')
    parser.add_argument('--package-dir', type=Path, help='the three release files (check, package, sign-in)')
    parser.add_argument('--minisign', type=Path, help='the verifier')
    parser.add_argument('--lab', type=Path, help='a new absolute folder outside the checkout')
    parser.add_argument('--port', type=int, help="the lab Core's loopback port")
    parser.add_argument('--node', type=Path, help='Node.js for the Claude bridge (sign-in, first-use)')
    parser.add_argument('--claude', type=Path, help='the installed claude executable (sign-in)')
    parser.add_argument('--browser', type=Path, help='Chromium (first-use)')
    args = parser.parse_args(argv)
    needs = {'check': ['minisign'] if args.package_dir else [],
             'package': ['package_dir', 'minisign', 'lab', 'port'],
             'sign-in': ['package_dir', 'minisign', 'lab', 'port', 'node', 'claude'],
             'first-use': ['minisign', 'lab', 'port', 'node', 'browser']}[args.stage]
    missing = ['--' + name.replace('_', '-') for name in needs if getattr(args, name) is None]
    if missing:
        parser.error(f'{args.stage} needs ' + ', '.join(missing))
    if args.report.exists() or args.report.is_symlink():
        parser.error('--report must be a new file')
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if args.lab is not None:
        source = REPO.parents[2] if REPO.parent.name == 'worktrees' else REPO
        if (not args.lab.is_absolute() or args.lab.exists() or args.lab.is_symlink()
                or args.lab.resolve().is_relative_to(source)):
            parser.error('--lab must be a new absolute folder outside the checkout')
    for name in ('doc', 'package_dir', 'minisign', 'browser'):
        if getattr(args, name) is not None:
            setattr(args, name, getattr(args, name).resolve(strict=True))
    # As given, not resolved: an installed claude or node is often a link.
    for name in ('node', 'claude'):
        path = getattr(args, name)
        if path is not None:
            if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
                parser.error(f'--{name} must be the absolute path of an executable')
    try:
        spec = load_spec(args.spec.read_text())
    except ValueError as error:
        parser.error(f'--spec: {error}')

    if args.stage in ('package', 'sign-in'):
        args.lab.mkdir(parents=True, mode=0o700)
        record = CandidateLab(args, spec)
        record.project.mkdir()
    else:
        record = Record()
    record.report.update(workflow=f'final candidate: {args.stage}', spec=spec, specSha256=sha256(args.spec),
                         jobsHost=jobs_host())
    if args.stage == 'sign-in':
        record.report['notTested'] = ['a real sign-in and model turn (first-use)', 'local Jobs (jobs-smoke.py)',
                                      'browser rendering']
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        guide = guide_release_source(args.doc.read_text())
        record.report['guide'] = {'path': str(args.doc), 'sha256': sha256(args.doc), **guide}
        problems = guide_mismatches(spec, guide)
        record.check('The install guide downloads from, verifies with and updates from the candidate',
                     not problems, mismatches=problems)
        if args.package_dir:
            problems = file_mismatches(spec, args.package_dir)
            record.check("The release files are exactly the candidate's", not problems, mismatches=problems)
        if args.stage == 'check' and args.package_dir:
            descriptor = args.package_dir / 'yuzuno-core-linux-x86_64.json'
            verified = subprocess.run([str(args.minisign), '-Vm', str(descriptor), '-P', spec['publicKey']],
                                      capture_output=True, text=True, timeout=60)
            record.check("The candidate's key verifies the descriptor", verified.returncode == 0,
                         output=(verified.stdout + verified.stderr)[-400:])
            problems = descriptor_mismatches(spec, json.loads(descriptor.read_text()))
            record.check('The signed descriptor names the candidate', not problems, mismatches=problems)
        elif args.stage == 'package':
            record.run()
        elif args.stage == 'sign-in':
            record.sign_in(args.node, args.claude)
        elif args.stage == 'first-use':
            first_use(args, spec, record)
        record.report['passed'] = True
    except Exception as error:
        record.report.update(passed=False, error=f'{type(error).__name__}: {error}')
        print(record.report['error'], flush=True)
    finally:
        if isinstance(record, Lab):
            record.stop('cleanup', cleanup=True)
        record.report['finishedAt'] = time.time()
        content = json.dumps(record.report, indent=2) + '\n'
        if isinstance(record, Lab):
            (record.lab / 'report.json').write_text(content)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(content)
    return 0 if record.report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
