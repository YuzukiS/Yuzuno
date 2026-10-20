#!/usr/bin/env python3
"""One published release, one real Claude turn, browser reconnect and persistence.

Uses the operator's existing login, never a copied credential or redirected HOME.
Run the browser workflow as a managed Job; it does not submit nested Jobs.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import time

from lab_environment import authenticated_environment
from package_lab import Lab, check_port_available, interrupt, sha256

REPO = Path(__file__).resolve().parents[2]


def guide_release_source(document):
    """Where the guide's install blocks download from and which key and update
    source they write; None for a line the guide no longer has."""
    install = document.split('\n## Install\n', 1)[1].split('\n## ', 1)[0]
    prerequisites = document.split('\n## Prerequisites on the Core host\n', 1)[1].split('\n## ', 1)[0]

    def one(pattern, text):
        found = re.findall(pattern, text, re.M)
        return found[0] if len(found) == 1 else None
    return {'downloadRepository': one(r'gh release download "\$TAG" -R (\S+) ', install),
            'publicKey': one(r'^ *KEY=(\S+)$', install),
            'updateRepository': one(r'''printf '\{"repository":"([^"]+)","publicKey"''', install),
            'readAccessRepository': one(r'(?:can|able to) read `([^`]+)`', prerequisites)}


def install_script(document, lab, tag):
    """Use the guide's four blocks, replacing only the reader's path/tag choices.

    Fail closed if its structure changes, instead of running a default install.
    """
    section = document.split('\n## Install\n', 1)[1].split('\n## ', 1)[0]
    blocks = []
    for match in re.finditer(r'^( *)```sh\n(.*?)^ *```$', section, re.M | re.S):
        pad = len(match[1])
        blocks.append(''.join(line[pad:] if line.startswith(' ' * pad) else line
                              for line in match[2].splitlines(True)))
    if len(blocks) != 4:
        raise ValueError('Expected four installation blocks in the guide')
    script = 'set -eu\numask 077\n' + '\n'.join(blocks)
    script, count = re.subn(r'^TAG=\S+', lambda _: 'TAG=' + shlex.quote(tag), script, count=1, flags=re.M)
    if count != 1:
        raise ValueError('Missing guide release choice')
    for source, target, expected in [
        ('~/yuzuno-download', shlex.quote(str(lab / 'download')), 2),
        ('ROOT=~/.local/share/yuzuno-core', 'ROOT=' + shlex.quote(str(lab / 'install')), 1),
    ]:
        if script.count(source) != expected:
            raise ValueError('Guide path choices changed: ' + source)
        script = script.replace(source, target)
    if '~' in script:
        raise ValueError('Unadapted home path in guide')
    return script


class FirstUseLab(Lab):
    def independence(self):
        children = {}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                stat = (path / 'stat').read_text()
                parent = int(stat[stat.rindex(')') + 2:].split()[1])
                children.setdefault(parent, []).append(int(path.name))
            except (OSError, ValueError):
                pass
        source = REPO.parents[2] if REPO.parent.name == 'worktrees' else REPO
        queue, seen = [self.process.pid], []
        while queue:
            pid = queue.pop()
            queue.extend(children.get(pid, []))
            try:
                proc = Path('/proc') / str(pid)
                fields = {'exe': os.readlink(proc / 'exe'), 'cwd': os.readlink(proc / 'cwd'),
                          'cmdline': (proc / 'cmdline').read_text(), 'environment': (proc / 'environ').read_text()}
                if pid == self.process.pid or 'runtimes/claude/bridge.mjs' in fields['cmdline']:
                    # Store only paths of executables and matching field names;
                    # an environment or argv can contain secrets.
                    seen.append({'pid': pid, 'exe': fields['exe'],
                                 'sourceReferences': [k for k, v in fields.items() if str(source) in v]})
            except OSError:
                pass
        self.report['productProcesses'] = seen
        self.check('installed Core and native bridge do not reference source checkout',
                   len(seen) >= 2 and all(not p['sourceReferences'] for p in seen))

    def browser(self, mode):
        env = dict(os.environ, T88_BASE=self.base, T88_LAB=str(self.lab), T88_PROJECT=str(self.project),
                   YUZUNO_BROWSER_BIN=str(self.args.browser))
        with (self.lab / f'browser-{mode}.log').open('wb') as log:
            result = subprocess.run([str(self.args.node), str(REPO / 'acceptance/t88/first-use-client.mjs'), mode],
                                    cwd=self.lab, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=300)
        path = self.lab / f'browser-{mode}.json'
        if path.exists():
            self.report.setdefault('browser', {})[mode] = json.loads(path.read_text())
        self.check('browser ' + mode, result.returncode == 0)

    def run(self):
        self.report['toolVersions'] = {}
        for name, argv in [('node', [str(self.args.node), '--version']), ('claude', ['claude', '--version']),
                           ('browser', [str(self.args.browser), '--version']), ('gh', ['gh', '--version'])]:
            version = subprocess.run(argv, capture_output=True, text=True, check=True, timeout=15)
            self.report['toolVersions'][name] = version.stdout.strip().splitlines()[0]
        document = self.args.doc.read_text()
        script = self.lab / 'install-from-guide.sh'
        script.write_text(install_script(document, self.lab, self.args.tag))
        self.report['guide'] = {'sha256': sha256(self.args.doc), 'scriptSha256': sha256(script),
                                'choices': ['release tag', 'download directory', 'installation directory']}
        self.command('guide-install', ['bash', script], timeout=180)
        self.verify()
        self.command('published-release', ['gh', 'release', 'view', self.args.tag, '--repo', self.args.repository,
                     '--json', 'tagName,publishedAt,isDraft,assets', '--jq',
                     '{tagName,publishedAt,isDraft,assets:[.assets[]|{name,size,digest}]}'])
        published = json.loads((self.lab / 'published-release.log').read_text())
        self.check('download matches the published release assets',
                   published['tagName'] == self.release and not published['isDraft']
                   and len(published['assets']) == 3
                   and all(a['digest'] == 'sha256:' + sha256(self.package / a['name']) for a in published['assets']))
        self.report['published'] = published
        current = json.loads((self.root / 'current.json').read_text())
        self.check('guide registered the signed release', current['releaseId'] == self.release
                   and current['manifestSha256'] == self.signed['manifestSha256'])
        self.check('guide saved private update configuration',
                   (self.root / 'release-source.json').stat().st_mode & 0o777 == 0o600)
        # Native Claude reads this disposable project's own rule. It makes the
        # harmless Bash probe ask even when the existing user has allow rules.
        # This is a fixture, not a change to the user's permissions or login.
        (self.project / '.claude').mkdir()
        (self.project / '.claude/settings.local.json').write_text(json.dumps({'permissions': {'ask': ['Bash']}}))
        workspace = self.start('initial')
        self.report['workspaceId'] = workspace
        self.browser('first')
        self.independence()
        self.browser('reopen')
        self.stop('initial')
        self.check('restart retains Workspace identity', self.start('restart') == workspace)
        self.browser('restart')
        self.stop('restart')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lab', type=Path, required=True, help='New directory outside the source checkout')
    parser.add_argument('--tag', required=True)
    parser.add_argument('--public-key', required=True)
    parser.add_argument('--minisign', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--doc', type=Path, default=REPO / 'docs/independent-core.md')
    parser.add_argument('--repository', help="The release's repository (default: the one the guide downloads from)")
    parser.add_argument('--report', type=Path, required=True, help='New report file, for Job artifact collection')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]+', args.tag):
        parser.error('Choose a valid port and release tag')
    guide = guide_release_source(args.doc.read_text())
    args.repository = args.repository or guide['downloadRepository']
    # The guide's download decides where the files come from; a different
    # repository here would compare them with another release.
    if not args.repository or args.repository != guide['downloadRepository']:
        parser.error('--repository must be the repository the guide downloads from')
    source = REPO.parents[2] if REPO.parent.name == 'worktrees' else REPO
    if args.lab.exists() or args.lab.is_symlink() or args.lab.resolve().is_relative_to(source):
        parser.error('--lab must be new and outside the source checkout')
    if args.report.exists() or args.report.is_symlink():
        parser.error('--report must be a new file')
    for name in ('minisign', 'node', 'browser', 'doc'):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    check_port_available(args.port)
    os.umask(0o077)
    args.lab = args.lab.resolve()
    args.lab.mkdir(parents=True, mode=0o700)
    args.package_dir = args.lab / 'download'
    args.package_dir.mkdir()
    tools = args.lab / 'tools'
    tools.mkdir()
    shutil.copy2(args.minisign, tools / 'minisign')
    env = authenticated_environment(os.environ, tools, args.node.parent)
    os.environ.clear()
    os.environ.update(env)
    lab = FirstUseLab(args)
    lab.project.mkdir()
    lab.report.update(workflow='published release first use with existing login',
                      accountBoundary='Existing OS user and native Claude login; HOME unchanged, no credential copy.',
                      permissionFixture='Only disposable project: permissions.ask=[Bash]',
                      notTested=['new account sign-in', 'fresh OS or physical host', 'remote clients',
                                 'online update (earlier Lab A)', 'systemd Jobs (separate probe)', 'Core service'])
    for key in ('mountInfo', 'uidMap', 'namespaces'):
        lab.report['environment'].pop(key, None)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    try:
        lab.run()
        lab.report['passed'] = True
    except Exception as error:
        lab.report.update(passed=False, error=f'{type(error).__name__}: {error}')
        print(lab.report['error'], flush=True)
    finally:
        lab.stop('cleanup', cleanup=True)
        lab.report['finishedAt'] = time.time()
        content = json.dumps(lab.report, indent=2) + '\n'
        (lab.lab / 'report.json').write_text(content)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(content)
    return 0 if lab.report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
