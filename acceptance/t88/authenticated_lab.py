#!/usr/bin/env python3
"""Historical signed-in browser/update lab using explicit releases and tools.

Runs the guide's installation/start/stop blocks with chosen paths and port,
then uses existing Claude/gh logins for real browser approval, draft/history,
update and reinstall checks. This workflow requires a source checkout for its
browser harness. For a credential-free package check use the package workflow.
"""
import argparse, json, os, re, shlex, shutil, signal, subprocess, sys, time, urllib.request
from pathlib import Path
from lab_environment import authenticated_environment

REPO = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description='Explicitly signed-in browser/update lab; uses existing CLI logins.')
parser.add_argument('--lab', type=Path, required=True)
parser.add_argument('--minisign', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
parser.add_argument('--browser', type=Path, required=True)
parser.add_argument('--from-tag', required=True)
parser.add_argument('--to-tag', required=True)
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--doc', type=Path, default=REPO / 'docs/independent-core.md')
args = parser.parse_args()
DOC = args.doc.resolve()
FROM_TAG, TO_TAG = args.from_tag, args.to_tag
DOC_TAG = re.search(r'^\s*TAG=(\S+)', DOC.read_text(), re.M).group(1)
PORT = args.port
if not 1 <= PORT <= 65535:
    parser.error('--port must be between 1 and 65535')
BASE = f'http://127.0.0.1:{PORT}'
NODE = args.node.resolve(strict=True)
NODE_BIN = NODE.parent
BROWSER = args.browser.resolve(strict=True)
SOURCE_PREFIX = str(REPO.parents[2]) if REPO.parent.name == 'worktrees' else str(REPO)
if args.lab.exists() or args.lab.is_symlink():
    parser.error('--lab must be a new directory')
LAB = args.lab.resolve()
if LAB.is_relative_to(Path(SOURCE_PREFIX)):
    parser.error('--lab must be outside the source checkout for the independence check')
if not re.fullmatch(r'[A-Za-z0-9_/-]+', str(LAB)):
    parser.error('--lab must use letters, digits, underscore, hyphen and slash (guide pkill pattern)')
for tag in (FROM_TAG, TO_TAG):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]+', tag):
        parser.error('release tags must be safe identifiers')
ROOT, DATA, PROJECT = LAB / 'root', LAB / 'data', LAB / 'project'
for d in (LAB, PROJECT, LAB / 'tools'):
    d.mkdir(parents=True)
shutil.copy(args.minisign.resolve(strict=True), LAB / 'tools/minisign')
# What a user's shell would have: their CLIs (Claude Code, Node), minisign, the system.
ENV = authenticated_environment(os.environ, LAB / 'tools', NODE_BIN)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'lab': str(LAB), 'port': PORT,
          'doc': {'path': str(DOC), 'sha256': __import__('hashlib').sha256(DOC.read_bytes()).hexdigest()},
          'checks': [], 'steps': []}


def check(name, ok, **data):
    report['checks'].append({'name': name, 'ok': bool(ok), **data})
    print('PASS' if ok else 'FAIL', name, json.dumps(data, ensure_ascii=False)[:500], flush=True)
    if not ok:
        raise SystemExit(f'check failed: {name}')


# --- The guide, as text -------------------------------------------------------
MD = DOC.read_text()


def section(title):
    start = MD.index(f'\n## {title}\n')
    end = MD.find('\n## ', start + 1)
    return MD[start:] if end < 0 else MD[start:end]


def sh_blocks(text):
    found = []
    for m in re.finditer(r'^( *)```sh\n(.*?)^ *```$', text, re.M | re.S):
        pad = m.group(1)
        found.append(''.join(line[len(pad):] if line.startswith(pad) else line for line in m.group(2).splitlines(True)))
    return found


def inline(title, label):
    return re.search(rf'\*\*{label}:\*\* `([^`]+)`', section(title)).group(1)


def adapt(script, tag=DOC_TAG):
    """Only the reader's documented choices change; nothing else may point at
    the user's real install, data or port afterwards."""
    choices = [(f'TAG={DOC_TAG}', f'TAG={shlex.quote(tag)}'), ('~/yuzuno-download', shlex.quote(str(LAB / f'download-{tag}'))),
               ('ROOT=~/.local/share/yuzuno-core', f'ROOT={shlex.quote(str(ROOT))}'), ('DATA=~/.local/share/yuzuno-core-data', f'DATA={shlex.quote(str(DATA))}'),
               ('--port 4317', f'--port {PORT}'), ('--cwd "$HOME"', f'--cwd {shlex.quote(str(PROJECT))} --codex /bin/false'),
               ('http://127.0.0.1:4317', BASE)]
    used = []
    for old, new in choices:
        if old in script:
            script, used = script.replace(old, new), used + [[old, new]]
    assert '~' not in script and '4317' not in script and '.local/share/yuzuno' not in script, script
    return script, used


def run_script(name, script, timeout=600):
    path = LAB / f'{name}.sh'
    path.write_text(script)
    with open(LAB / f'{name}.log', 'w') as log:
        result = subprocess.run(['bash', str(path)], cwd=LAB, env=ENV, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    report['steps'].append({'script': path.name, 'returncode': result.returncode})
    return result.returncode, (LAB / f'{name}.log').read_text()


def install(tag, label):
    blocks = sh_blocks(section('Install'))
    assert len(blocks) == 4, f'the guide has {len(blocks)} install blocks'
    script, used = adapt('set -e\n' + '\n'.join(blocks), tag)
    code, log = run_script(f'install-{label}', script, 900)
    report[f'install-{label}'] = {'tag': tag, 'choices': used}
    check(f'{label}: the guide\'s install commands succeed', code == 0, tail=log[-600:])
    check(f'{label}: minisign verified the descriptor', 'Signature and comment signature verified' in log
          and f'Trusted comment: Yuzuno Core {tag}' in log)
    current = json.loads((ROOT / 'current.json').read_text())
    descriptor = json.loads((LAB / f'download-{tag}/yuzuno-core-linux-x86_64.json').read_text())
    check(f'{label}: the registered release is the verified one', current['releaseId'] == descriptor['manifest']['releaseId']
          and current['manifestSha256'] == descriptor['manifestSha256'], current=current)
    source = ROOT / 'release-source.json'
    check(f'{label}: release-source.json is owner-only', source.stat().st_mode & 0o777 == 0o600, mode=oct(source.stat().st_mode & 0o777))
    loose = [str(p) for p in [ROOT, *ROOT.rglob('*')] if not p.is_symlink() and p.stat().st_mode & 0o022]
    check(f'{label}: nothing under the managed root is group- or world-writable', not loose, loose=loose[:5])
    return current['releaseId']


# --- Core, as the guide starts and stops it ------------------------------------
START = section('Start, stop and restart')


def health():
    with opener.open(BASE + '/api/health', timeout=3) as response:
        return json.load(response)


def get(path):
    with opener.open(BASE + '/api' + path, timeout=30) as response:
        return json.load(response)


def parent(pid):
    stat = Path(f'/proc/{pid}/stat').read_text()
    return int(stat[stat.rindex(')') + 2:].split()[1])


def lab_pids():
    """Processes naming the lab dir, except this script and whatever runs it."""
    mine, pid = set(), os.getpid()
    while pid > 1:
        mine.add(pid)
        pid = parent(pid)
    out = subprocess.run(['pgrep', '-f', re.escape(str(LAB))], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) not in mine]


def core_pid():
    for pid in lab_pids():
        try:
            if os.readlink(f'/proc/{pid}/exe').endswith('/bin/yuzuno-workspace'):
                return pid
        except OSError:
            pass
    return None


def start(label):
    if subprocess.run(['ss', '-ltnH', f'sport = :{PORT}'], capture_output=True, text=True).stdout.strip():
        raise SystemExit(f'Port {PORT} is in use; nothing was started')
    script, used = adapt(sh_blocks(START)[0])
    code, log = run_script(f'start-{label}', script, 60)
    check(f'{label}: the guide\'s start command returns', code == 0, tail=log[-300:])
    for _ in range(300):
        try:
            h = health()
            break
        except OSError:
            time.sleep(.2)
    else:
        raise SystemExit('Core did not answer; see root/core.log')
    curl, _ = adapt(inline('Start, stop and restart', 'Check it'))
    shown = subprocess.run(['sh', '-c', curl], capture_output=True, text=True, env=ENV, timeout=10).stdout
    check(f'{label}: the guide\'s health command shows the release and Workspace',
          json.loads(shown).get('workspaceId') == h['workspaceId'] and h.get('releaseId'), releaseId=h.get('releaseId'))
    return h


def stop(label):
    root_line = next(line for line in sh_blocks(START)[0].splitlines() if line.startswith('ROOT='))
    script, _ = adapt(root_line + '\n' + inline('Start, stop and restart', 'Stop') + '\n')
    run_script(f'stop-{label}', script, 30)
    end = time.time() + 60
    while time.time() < end and (core_pid() or listening()):
        time.sleep(.5)
    check(f'{label}: the guide\'s stop command ends Core', not core_pid() and not listening())


def listening():
    return bool(subprocess.run(['ss', '-ltnH', f'sport = :{PORT}'], capture_output=True, text=True).stdout.strip())


def children(pid):
    found = []
    for proc in Path('/proc').iterdir():
        if proc.name.isdigit():
            try:
                if parent(proc.name) == pid:
                    found.append(int(proc.name))
            except (OSError, ValueError):
                pass
    return found + [g for c in found for g in children(c)]


def independence(label, release):
    """Core and its bridge reach nothing in the source checkout. Values are
    never printed (an environment can hold secrets); only which field matched."""
    pid = core_pid()
    seen = []
    for p in [pid] + children(pid):
        try:
            exe = os.readlink(f'/proc/{p}/exe')
            fields = {'exe': exe, 'cwd': os.readlink(f'/proc/{p}/cwd'),
                      'cmdline': Path(f'/proc/{p}/cmdline').read_bytes().decode(errors='replace'),
                      'environ': Path(f'/proc/{p}/environ').read_bytes().decode(errors='replace')}
        except OSError:
            continue
        owned = p == pid or 'runtimes/claude' in fields['cmdline']
        seen.append({'pid': p, 'exe': exe, 'yuzuno': owned,
                     'referencesSource': [k for k, v in fields.items() if SOURCE_PREFIX in v]})
    core = seen[0]
    bridge = [s for s in seen if s['yuzuno'] and s['pid'] != pid]
    report.setdefault('processes', {})[label] = seen
    check(f'{label}: Core runs the managed release, not a build', core['exe'] == str(ROOT / 'releases' / release / 'bin/yuzuno-workspace'),
          exe=core['exe'])
    check(f'{label}: Core and its Claude bridge use no path in the source checkout',
          all(not s['referencesSource'] for s in seen if s['yuzuno']), checked=[(s['pid'], s['exe']) for s in seen if s['yuzuno']])
    return bridge


def client(mode):
    env = {**ENV, 'PATH': f'{NODE_BIN}:/usr/bin:/bin', 'T88_BASE': BASE, 'T88_LAB': str(LAB), 'T88_PROJECT': str(PROJECT), 'YUZUNO_BROWSER_BIN': str(BROWSER)}
    with open(LAB / f'client-{mode}.log', 'w') as log:
        code = subprocess.run([str(NODE), '--max-old-space-size=2048', str(REPO / 'acceptance/t88/client.mjs'), mode],
                              cwd=REPO, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode
    result = json.loads((LAB / f'client-{mode}.json').read_text())
    report.setdefault('client', {})[mode] = result
    check(f'browser {mode}: every check passed', code == 0 and result['passed'] and not result['pageErrors'],
          checks=[c['name'] for c in result['checks'] if c['ok']], pageErrors=result['pageErrors'][:3])
    return result


def main():
    # The target release's signed descriptor, read first so the update can be
    # checked against it (the harness only; Core finds it by itself).
    expect = LAB / 'expect'
    expect.mkdir()
    subprocess.run(['gh', 'release', 'download', TO_TAG, '-R', 'YuzukiS/Yuzuno', '-p', 'yuzuno-core-linux-x86_64.json*', '-D', str(expect)],
                   env=ENV, check=True, timeout=120)
    subprocess.run([str(LAB / 'tools/minisign'), '-Vm', str(expect / 'yuzuno-core-linux-x86_64.json'), '-P',
                    re.search(r'KEY=(\S+)', MD).group(1)], env=ENV, check=True, timeout=30, stdout=subprocess.DEVNULL)
    target = json.loads((expect / 'yuzuno-core-linux-x86_64.json').read_text())['manifest']['releaseId']

    first = install(FROM_TAG, 'initial')
    h = start('initial')
    workspace = h['workspaceId']
    check('initial: the first start serves the installed release with a new Workspace', h['releaseId'] == first, health=h)
    independence('initial idle', first)

    client('first')
    state = json.loads((LAB / 'client-state.json').read_text())
    bridge = independence('initial with a Claude Agent', first)
    check('initial: a Claude bridge from the release is running', bool(bridge), bridge=bridge)
    client('reopen')
    check('closing the client changed nothing in Core', core_pid() and health()['workspaceId'] == workspace)

    old = core_pid()
    env = {**ENV, 'PATH': f'{NODE_BIN}:/usr/bin:/bin', 'YUZUNO_RELEASE_URL': BASE, 'YUZUNO_RELEASE_FROM': first,
           'YUZUNO_RELEASE_TO': target, 'YUZUNO_BROWSER_OUTPUT': str(LAB / 'update-browser'), 'YUZUNO_BROWSER_BIN': str(BROWSER)}
    with open(LAB / 'update-browser.log', 'w') as log:
        code = subprocess.run([str(NODE), '--max-old-space-size=2048', 'tools/release-download-browser.mjs'], cwd=REPO / 'web',
                              env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, timeout=420).returncode
    receipt = json.loads((LAB / 'update-browser/receipt.json').read_text())
    report['update'] = receipt
    check('Settings -> Updates: check, download, verify, prepare and apply target in the browser', code == 0 and receipt.get('passed'),
          checks=receipt.get('checks'), stepsSeen=receipt.get('stepsSeen'))
    h = health()
    check('target: the replacement serves the update with the same Workspace', h['releaseId'] == target and h['workspaceId'] == workspace
          and json.loads((ROOT / 'current.json').read_text())['releaseId'] == target, health=h)
    check('target: the old Core process exited', not Path(f'/proc/{old}').exists() or core_pid() != old)
    independence('target after update', target)

    client('send-draft')
    stop('target')
    h = start('target restart')
    turns = get(f"/agents/{state['agentId']}")['turns']
    check('target restart: same release, Workspace and saved history', h['releaseId'] == target and h['workspaceId'] == workspace
          and len(turns) == 2 and all(t['status'] == 'completed' for t in turns), turns=len(turns))
    stop('target restart')

    # Uninstall keeping the Workspace, then install again into the same place.
    shutil.rmtree(ROOT)
    check('uninstall: the program is gone and the Workspace data stays', not ROOT.exists() and DATA.is_dir())
    again = install(TO_TAG, 'reinstall')
    h = start('reinstall')
    turns = get(f"/agents/{state['agentId']}")['turns']
    check('reinstall over kept data: same Workspace and saved history', again == target and h['releaseId'] == target
          and h['workspaceId'] == workspace and len(turns) == 2, turns=len(turns))
    stop('reinstall')


try:
    main()
    report['passed'] = True
except BaseException as error:
    report.update(passed=False, error=f'{type(error).__name__}: {error}'[:2000])
    print('ERROR', report['error'], flush=True)
finally:
    left = lab_pids()
    for pid in left:
        try:
            os.kill(pid, signal.SIGINT if pid == core_pid() else signal.SIGTERM)
        except OSError:
            pass
    time.sleep(3)
    for pid in lab_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    report['leftoverProcessesAtEnd'] = left
    report['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    (LAB / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
sys.exit(0 if report.get('passed') else 1)
