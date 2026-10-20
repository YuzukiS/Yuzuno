#!/usr/bin/env python3
"""T-87 live acceptance: which Claude Code and Agent SDK a session runs, as
an isolated lab Core built from this worktree reports them (port 4471, its
own data dir), with the real installed Claude Code and Haiku. Never touches
the daily Core (4317), its data or processes; the lab Core and its own
children are the only processes it starts or signals. Claude Code runs with
the user's own login and configuration, unchanged; no CLI is installed.

1. Default PATH: a new Agent reports the CLI's real path, the PATH entry that
   matched, version 2.1.280 from `--version` (the first turn's system/init
   reports the same), SDK 0.3.296 shipping 2.1.296, and "verified". One turn
   calls a Workspace MCP tool; another writes a file after an approval, which
   the lab grants.
2. A custom executable first on PATH (a symlink in a lab directory), after a
   restart: reconnecting reports that entry; the session resumes and answers.
3. A fake old CLI and a fake one whose version cannot be read, first on
   PATH: reconnecting fails, and the error names the CLI, its version (or
   that it is unknown) and the SDK.
4. Back on the default PATH: reconnecting reports what step 1 did.
5. The packaged runtime layout (runtimes/claude installed as
   tools/build-core-artifact.py does): the same facts, read from that copy.
6. A review with Claude Haiku of the given PR records the same provenance.

Usage: lab.py <binary> <out dir> <packaged bridge.mjs> <PR url> <head sha>.
Writes report.json and snapshots/ there; exits 1 if a check failed.
"""
import json, os, signal, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BIN, LAB, PACKAGED = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
PR_URL, HEAD_SHA = sys.argv[4], sys.argv[5]
PORT = 4471
BASE = f'http://127.0.0.1:{PORT}'
NODE_BIN = (str(Path.home() / '.local/share/fnm/node-versions/v22.23.2/installation/bin'))
DEFAULT_PATH = f'{NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/usr/sbin'
REAL_CLI = os.path.realpath(f'{NODE_BIN}/claude')
SDK = {'version': '0.3.296', 'builtInCli': '2.1.296'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'realCli': REAL_CLI, 'checks': []}
answered = set()


def check(name, ok, **data):
    report['checks'].append({'name': name, 'ok': bool(ok), **data})
    print('PASS' if ok else 'FAIL', name, json.dumps(data, ensure_ascii=False)[:600], flush=True)


def snapshot(name, value):
    (LAB / 'snapshots').mkdir(exist_ok=True)
    (LAB / 'snapshots' / f'{name}.json').write_text(json.dumps(value, indent=2, ensure_ascii=False))


def api(method, path, body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + '/api' + path, data=data, method=method,
                                     headers={'content-type': 'application/json', 'x-yuzuno-client': 'desktop'})
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return {'httpError': error.code, 'body': error.read().decode()[:2000]}


def op(name, body, timeout=120):
    return api('POST', f'/collaboration/{name}', body, timeout)


def start_core(log, path, bridge):
    listeners = subprocess.run(['ss', '-ltn', f'sport = :{PORT}'], capture_output=True, text=True).stdout
    if len(listeners.strip().splitlines()) > 1:
        raise SystemExit(f'Port {PORT} is in use; nothing was started')
    env = {'HOME': str(Path.home()), 'LANG': 'C.UTF-8', 'PATH': path, 'YUZUNO_CLAUDE_BRIDGE': str(bridge),
           'CODEX_HOME': str(LAB / 'codex-home'), 'TMPDIR': str(LAB / 'tmp')}
    argv = [str(BIN), '--port', str(PORT), '--data-dir', str(LAB / 'data'), '--web-dir', str(LAB / 'web'),
            '--cwd', str(LAB / 'repo'), '--codex', '/bin/false']
    child = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True)
    for _ in range(300):
        try:
            with opener.open(BASE + '/api/health', timeout=1):
                return child
        except OSError:
            if child.poll() is not None:
                raise SystemExit('The lab Core exited; see core.log')
            time.sleep(.2)
    raise SystemExit('The lab Core did not become ready')


def stop_core(child):
    if child.poll() is None:
        child.send_signal(signal.SIGINT)
        try:
            child.wait(30)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def detail(aid):
    return api('GET', f'/agents/{aid}')


def approve(d):
    for request in d.get('pending', []):
        params = request.get('params', {})
        if request['id'] in answered or request.get('stale') or params.get('_responseSent'):
            continue
        answered.add(request['id'])
        api('POST', f"/requests/{request['id']}/respond", {'response': {'decision': 'allow'}})


def wait(aid, predicate, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        d = detail(aid)
        approve(d)
        if predicate(d):
            return d
        time.sleep(1)
    d = detail(aid)
    snapshot(f'timeout-{label}', d)
    raise SystemExit(f'Timed out waiting for {label}')


def provenance(d):
    return (d.get('claudeRuntime') or {}).get('provenance')


def expected(found):
    # CLI 2.1.280 leaves its version out of the SDK's initialization result
    # (lab r1, dd9f7f5f), so the bridge reports what `--version` printed.
    return {'cli': {'path': REAL_CLI, 'found': found, 'source': 'path', 'version': '2.1.280', 'versionSource': '--version'},
            'sdk': SDK, 'compatibility': 'verified'}


def turn(aid, text, label, timeout=240):
    tid = api('POST', f'/agents/{aid}/turns', {'text': text})['turnId']
    d = wait(aid, lambda d: any(t['id'] == tid and t['status'] not in ('inProgress', 'pending') for t in d['turns']),
             timeout, label)
    return next(t for t in d['turns'] if t['id'] == tid), d


def reconnect(aid):
    result = api('POST', f'/agents/{aid}/reconnect', {}, timeout=180)
    return result, detail(aid)


def fake_cli(name, version_line):
    directory = LAB / name
    directory.mkdir(exist_ok=True)
    script = directory / 'claude'
    script.write_text('#!/bin/sh\n'
                      f'if [ "$1" = --version ]; then echo "{version_line}"; exit 0; fi\n'
                      'echo "fake Claude Code for T-87: this build cannot start a session" >&2\n'
                      'exit 1\n')
    script.chmod(0o755)
    return directory


def main():
    for name in ['data', 'repo', 'tmp', 'web', 'codex-home']:
        (LAB / name).mkdir(parents=True, exist_ok=True)
    log = open(LAB / 'core.log', 'ab')
    worktree_bridge = ROOT / 'runtimes/claude/bridge.mjs'
    core = start_core(log, DEFAULT_PATH, worktree_bridge)
    try:
        # 1. Default PATH.
        agent = api('POST', '/agents', {'name': 'T-87 lab', 'harness': 'claude', 'cwd': str(LAB / 'repo'), 'model': 'haiku'})
        aid = agent['id']
        d = wait(aid, lambda d: d['agent']['connectionState'] == 'connected', 120, 'first start')
        snapshot('1-start', {'claudeRuntime': d.get('claudeRuntime'), 'agent': d['agent']})
        check('default PATH: path, entry, probed version, SDK and "verified"', provenance(d) == expected(f'{NODE_BIN}/claude'),
              provenance=provenance(d))
        mcp, d = turn(aid, 'Call the mcp__yuzuno__peers_list tool exactly once, then reply with only the number of peers it listed.', 'mcp turn')
        calls = [i for i in mcp.get('items', []) if i.get('type') != 'userMessage' and 'peers_list' in json.dumps(i)]
        check('a Workspace MCP tool call completes on this CLI', mcp['status'] == 'completed' and calls,
              status=mcp['status'], call=calls[:1])
        check('the turn\'s system/init reports the same version', d['claudeRuntime'].get('version') == '2.1.280',
              version=d['claudeRuntime'].get('version'))
        # A file write needs approval in default mode; read-only commands such
        # as `echo` were approved by Claude Code itself (lab r1).
        write, d = turn(aid, 'Use the Write tool to create a file named t87.txt containing the word ok, then reply with the single word done.',
                        'approval turn')
        written = (LAB / 'repo' / 't87.txt')
        check('an approval is asked through Yuzuno and the approved write completes',
              write['status'] == 'completed' and len(answered) >= 1 and written.is_file() and written.read_text().strip() == 'ok',
              status=write['status'], approvals=len(answered), written=written.is_file())
        session = d['agent'].get('claudeSessionId')

        # 2. A custom executable first on PATH; restart and reconnect.
        stop_core(core)
        custom = LAB / 'custom-bin'
        custom.mkdir(exist_ok=True)
        if not (custom / 'claude').exists():
            (custom / 'claude').symlink_to(REAL_CLI)
        core = start_core(log, f'{custom}:{DEFAULT_PATH}', worktree_bridge)
        result, d = reconnect(aid)
        snapshot('2-custom', {'reconnect': result, 'claudeRuntime': d.get('claudeRuntime')})
        check('custom executable on PATH: the new entry is reported, same real file', provenance(d) == expected(f'{custom}/claude'),
              provenance=provenance(d))
        pear, d = turn(aid, 'Reply with the single word pear.', 'resumed turn')
        check('the same session resumes and answers', d['agent'].get('claudeSessionId') == session and pear['status'] == 'completed',
              session=d['agent'].get('claudeSessionId'))

        # 3. A fake old CLI, then one whose version cannot be read.
        for name, line, version_text in [('old-bin', '2.0.5 (Claude Code)', 'Claude Code 2.0.5'),
                                         ('unknown-bin', 'nightly build', 'Claude Code (version unknown)')]:
            stop_core(core)
            directory = fake_cli(name, line)
            core = start_core(log, f'{directory}:{DEFAULT_PATH}', worktree_bridge)
            result, d = reconnect(aid)
            error = json.dumps(result) + ' ' + str(d['agent'].get('error'))
            snapshot(f'3-{name}', {'reconnect': result, 'agent': d['agent']})
            check(f'{name}: reconnecting fails and names the CLI, its version and the SDK',
                  d['agent']['connectionState'] != 'connected'
                  and f'{version_text} at {directory}/claude (found on PATH as {directory}/claude)' in error
                  and 'Agent SDK 0.3.296, built with Claude Code 2.1.296' in error,
                  error=error[-700:])

        # 4. Back on the default PATH.
        stop_core(core)
        core = start_core(log, DEFAULT_PATH, worktree_bridge)
        result, d = reconnect(aid)
        snapshot('4-default-again', {'reconnect': result, 'claudeRuntime': d.get('claudeRuntime')})
        check('default PATH again: the same facts as the first start', provenance(d) == expected(f'{NODE_BIN}/claude')
              and d['agent'].get('claudeSessionId') == session, provenance=provenance(d))

        # 5. The packaged runtime layout.
        stop_core(core)
        core = start_core(log, DEFAULT_PATH, PACKAGED)
        result, d = reconnect(aid)
        # The bridge process that serves the Agent is the packaged copy.
        running = [line for line in subprocess.run(['ps', '-eo', 'pid,args'], capture_output=True, text=True).stdout.splitlines()
                   if f'node {PACKAGED}' in line or f'node {PACKAGED} --review' in line]
        snapshot('5-packaged', {'reconnect': result, 'claudeRuntime': d.get('claudeRuntime'), 'bridge': str(PACKAGED),
                                'processes': running})
        check('packaged runtime layout: the same facts, from its own SDK copy',
              provenance(d) == expected(f'{NODE_BIN}/claude') and running, provenance=provenance(d), processes=running)

        # 6. A Haiku review of the PR records the same provenance.
        settings = api('POST', '/pr-reviews/settings', {'harness': 'claude', 'model': 'haiku'}, timeout=180)
        check('Claude review settings accept haiku from the native catalog', settings == {'harness': 'claude', 'model': 'haiku'},
              settings=settings)
        task = op('task_create', {'requestId': 't87-lab-task', 'title': 'T-87 lab review'})['task']
        links = op('github_links', {'taskId': task['id'], 'action': 'link', 'input': PR_URL}, timeout=180)
        link = next(l for l in links['links'] if l['kind'] == 'pull')
        started = op('review_start', {'requestId': 't87-lab-review', 'taskId': task['id'], 'linkId': link['id'],
                                      'baseSha': link['snapshot']['baseSha'], 'headSha': HEAD_SHA}, timeout=180)
        rid = started['id']
        end = time.time() + 900
        while True:
            record = op('review_get', {'taskId': task['id'], 'reviewId': rid})
            if record.get('status') not in ('preparing', 'running') or time.time() > end:
                break
            time.sleep(5)
        facts = {k: record.get(k) for k in ['id', 'status', 'conclusion', 'error', 'requestedModel', 'resolvedModel',
                                            'actualModel', 'cliVersion', 'provenance', 'headSha']}
        snapshot('6-review', facts)
        want = {'cli': {'path': REAL_CLI, 'found': f'{NODE_BIN}/claude', 'source': 'path', 'version': '2.1.280',
                        'versionSource': '--version'}, 'sdk': SDK, 'compatibility': 'verified'}
        check('the review completed on this CLI and records where it came from',
              record.get('status') == 'completed' and record.get('cliVersion') == '2.1.280' and record.get('provenance') == want,
              review=facts)
    finally:
        stop_core(core)
        report['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (LAB / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if all(c['ok'] for c in report['checks']) else 1)


main()
