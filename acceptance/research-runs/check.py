#!/usr/bin/env python3
"""T-105 runs of stages on an isolated Core with real systemd user services.

Small fixture stages (fixture.py) stand in for a CPU training stage and an API
evaluation; nothing calls a model, trains or uses the network. Each check is
an old failure from the read-only WF audit, now caught:
- a failed upstream that still started its analysis and wrote DONE;
- `train; echo done` exiting 0 without its checkpoint;
- a truncated final.json taken as complete;
- an upstream artifact changed between two stages;
- an API disconnect retried from scratch with the failed attempt's spend lost;
- a stale result reused although its config or file changed;
- Core restarting mid-run, rerunning or mailing twice.

Uses the local_jobs_lab example (its lab folders live under target/t47/lab-*),
on its own port and data. Each lab job is a systemd user unit with its own
MemoryMax/CPUQuota, bounded by the lab budget below; the cleanup stops only
units whose specs are in this lab's folder.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / 'target' / 't47' / ('lab-r105-' + uuid.uuid4().hex[:8])
WORK = LAB / 'work'
PORT = int(os.environ.get('T105_PORT', '4605'))
BASE = 'http://127.0.0.1:' + str(PORT)
CORE = None
REPORT = {'checks': [], 'runs': {}, 'fixture': 'Isolated Core + real systemd user units; fixture.py stages; no model, training or network'}


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/api' + path, data=data,
                                 headers={'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def wait_for(read, accept=lambda v: bool(v), seconds=60):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = read()
        if accept(last):
            return last
        time.sleep(.25)
    raise AssertionError('Expected state did not arrive: ' + json.dumps(last)[:2000])


def start_core():
    global CORE
    log = (LAB / 'core.log').open('ab')
    CORE = subprocess.Popen([os.environ.get('T105_LAB_BIN') or str(ROOT / 'target/debug/examples/local_jobs_lab'),
                             str(LAB), str(PORT)],
                            stdout=log, stderr=log)
    log.close()
    for _ in range(100):
        if CORE.poll() is not None:
            raise AssertionError('Isolated Core exited: ' + (LAB / 'core.log').read_text()[-2000:])
        try:
            request('/health')
            return
        except OSError:
            time.sleep(.1)
    raise AssertionError('Isolated Core did not listen')


def stop_core():
    global CORE
    if CORE:
        CORE.terminate()
        CORE.wait(timeout=15)
        CORE = None


class MCP:
    def __init__(self):
        config = json.loads((LAB / 'connection.json').read_text())
        self.url = config['url']
        self.headers = {**config['headers'], 'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'}
        self.seq = 0
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                'clientInfo': {'name': 'research-runs-acceptance', 'version': '1'}})
        self.rpc('notifications/initialized', None, notice=True)

    def rpc(self, method, params, notice=False):
        body = {'jsonrpc': '2.0', 'method': method}
        if not notice:
            self.seq += 1
            body['id'] = self.seq
        if params is not None:
            body['params'] = params
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=self.headers)
        with urllib.request.urlopen(req, timeout=60) as response:
            session = response.headers.get('Mcp-Session-Id')
            if session:
                self.headers['Mcp-Session-Id'] = session
            if notice:
                return None
            if response.headers.get('Content-Type', '').startswith('text/event-stream'):
                while True:
                    line = response.readline().decode()
                    if line.startswith('data: '):
                        value = json.loads(line[6:])
                        if value.get('id') == self.seq:
                            break
                    if not line:
                        raise AssertionError('MCP stream ended before response')
            else:
                value = json.load(response)
        assert 'error' not in value, value
        return value['result']

    def call(self, tool, args, error=False):
        value = self.rpc('tools/call', {'name': tool, 'arguments': args})
        if error:
            assert value.get('isError'), value
            return value['content'][0]['text']
        assert not value.get('isError'), value
        return value['structuredContent']


def fixture(*args):
    return ['/usr/bin/python3', '-u', str(WORK / 'fixture.py'), *args]


def stage(key, argv, needs=(), **extra):
    return {'key': key, 'needs': list(needs), 'cwd': str(WORK), 'argv': argv, 'env': {},
            'guardGit': False, 'inputs': ['fixture.py', 'config.json'],
            'resources': {'cpuMillis': 500, 'memoryMiB': 96, 'swapMiB': 0}, 'timeoutSeconds': 90, **extra}


def submit(mcp, name, stages, **extra):
    run = mcp.call('job_run_submit', {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'name': name,
                                       'stages': stages, **extra})
    REPORT['runs'][name] = run['id']
    return run


def run_get(run_id):
    return request('/jobs/runs/' + run_id)


def settled(run_id, statuses, seconds=90):
    def done(run):
        live = [a for s in run['stages'] for a in s['attempts']
                if a['status'] in ('queued', 'starting', 'running', 'cancelling')]
        return run['status'] in statuses and not live
    return wait_for(lambda: run_get(run_id), done, seconds)


def stage_of(run, key):
    return next(s for s in run['stages'] if s['key'] == key)


def job(job_id):
    return request('/jobs/' + job_id)


def starts(log):
    path = WORK / log
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def mails(run_id):
    messages = request('/collaboration/peer_read', {'agentId': 'lab-a', 'priority': 'normal', 'limit': 200})['messages']
    return [m for m in messages if (m.get('metadata') or {}).get('runId') == run_id]


def sha(path):
    return hashlib.sha256((WORK / path).read_bytes()).hexdigest()


def git_repo(name, files):
    """A small Git repository under the lab's work folder, its files committed."""
    repo = WORK / name
    repo.mkdir()
    shutil.copy(WORK / 'fixture.py', repo / 'fixture.py')
    (repo / 'config.json').write_text(json.dumps({'seed': 24}))
    for path, text in files.items():
        (repo / path).write_text(text)

    def git(*args):
        subprocess.run(['git', '-C', str(repo), *args], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qm', 'fixture')
    return repo


def repo_stage(repo, key, argv, needs=(), **extra):
    return {**stage(key, argv, needs, **extra), 'cwd': str(repo), 'guardGit': True}


def guard_transitive(mcp):
    """a -> b -> c with the guard on: b rewrites a's tracked artifact but
    declares only its own. c leaves a's file out of its guard, so it must
    check it against a's attempt and is rejected unstarted."""
    repo = git_repo('repo-transitive', {'stage-a.json': '{}'})
    fixture_in = lambda *args: ['/usr/bin/python3', '-u', str(repo / 'fixture.py'), *args]
    run = submit(mcp, 'git-guard-transitive', [
        repo_stage(repo, 'a', fixture_in('--log', 'tr-a.log', '--out', 'stage-a.json'),
                   artifacts=[{'path': 'stage-a.json', 'format': 'json'}]),
        repo_stage(repo, 'b', ['/bin/sh', '-c', f'/usr/bin/python3 {repo}/fixture.py --log tr-b.log --read stage-a.json --out b-out.json && echo \'{{"rewritten": true}}\' > stage-a.json'],
                   needs=['a'], artifacts=[{'path': 'b-out.json', 'format': 'json'}]),
        repo_stage(repo, 'c', fixture_in('--log', 'tr-c.log', '--read', 'stage-a.json', '--out', 'c-out.json'),
                   needs=['b'], artifacts=[{'path': 'c-out.json'}]),
    ])
    run = settled(run['id'], {'failed', 'succeeded'})
    c = job(stage_of(run, 'c')['attempts'][0]['id'])
    assert c['status'] == 'rejected', f"c is {c['status']}: {c['reason']}"
    assert 'Upstream stage a artifact stage-a.json is no longer the one it succeeded with' in c['reason'], c['reason']
    assert starts('repo-transitive/tr-c.log') == []
    return c['reason']


def guard_rename(mcp):
    """An earlier stage renames undeclared, tracked code onto the path it
    declares as its artifact: the next stage's guard still sees the source
    disappear and rejects it, rather than leaving the rename out."""
    repo = git_repo('repo-rename', {'code2.py': 'print(1)\n'})
    run = submit(mcp, 'git-guard-rename', [
        repo_stage(repo, 'w', ['/bin/sh', '-c', f'git mv code2.py renamed.json && /usr/bin/python3 {repo}/fixture.py --log rn-w.log --out w-out.json'],
                   artifacts=[{'path': 'renamed.json'}, {'path': 'w-out.json'}]),
        repo_stage(repo, 'r', ['/usr/bin/python3', '-u', str(repo / 'fixture.py'), '--log', 'rn-r.log', '--out', 'r-out.json'],
                   needs=['w']),
    ])
    run = settled(run['id'], {'failed', 'succeeded'})
    r = job(stage_of(run, 'r')['attempts'][0]['id'])
    assert stage_of(run, 'w')['attempts'][0]['status'] == 'succeeded', stage_of(run, 'w')
    assert r['status'] == 'rejected', f"r is {r['status']}: {r['reason']}"
    assert 'Guarded inputs changed while queued' in r['reason'], r['reason']
    assert starts('repo-rename/rn-r.log') == []
    return r['reason']


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def main():
    LAB.mkdir(parents=True, mode=0o700)
    WORK.mkdir()
    shutil.copy(Path(__file__).with_name('fixture.py'), WORK / 'fixture.py')
    (WORK / 'config.json').write_text(json.dumps({'seed': 24}))
    print(str(LAB), flush=True)
    try:
        start_core()
        # Two 96 MiB jobs at once, at most: the lab's own units stay this small.
        request('/jobs/budget', {'cpuMillis': 1200, 'memoryMiB': 400, 'swapMiB': 0})
        mcp = MCP()
        names = {t['name'] for t in mcp.rpc('tools/list', {})['tools']}
        assert {'job_run_submit', 'job_run_get', 'job_run_list', 'job_run_retry', 'job_run_cancel', 'job_submit'} <= names
        if os.environ.get('T105_ONLY') == 'guard':
            # Only the two guard boundaries, each recorded on its own (also
            # against an earlier build, where they are expected to fail).
            REPORT['guard'] = {}
            for scenario in (guard_transitive, guard_rename):
                try:
                    REPORT['guard'][scenario.__name__] = {'passed': True, 'reason': scenario(mcp)}
                except AssertionError as error:
                    REPORT['guard'][scenario.__name__] = {'passed': False, 'error': str(error)[:600]}
                print(scenario.__name__, json.dumps(REPORT['guard'][scenario.__name__]), flush=True)
            REPORT['passed'] = all(v['passed'] for v in REPORT['guard'].values())
            return

        # 1. A failed upstream: its analysis never starts, the reason is visible, one mail.
        run = submit(mcp, 'upstream-fails', [
            stage('run', fixture('--log', 'fail-run.log', '--mode', 'fail'), artifacts=[{'path': 'fail-run.json'}]),
            stage('analysis', fixture('--log', 'fail-analysis.log', '--read', 'fail-run.json', '--out', 'fail-analysis.json'),
                  needs=['run'], artifacts=[{'path': 'fail-analysis.json', 'format': 'json'}]),
        ])
        run = settled(run['id'], {'failed'})
        failed = job(stage_of(run, 'run')['attempts'][0]['id'])
        assert failed['status'] == 'failed' and failed['result']['evidence']['systemd']['ExecMainStatus'] == '3', failed
        analysis = job(stage_of(run, 'analysis')['attempts'][0]['id'])
        assert analysis['status'] == 'waiting' and analysis['startedAt'] is None, analysis
        assert 'Upstream stage run attempt 1 failed' in analysis['reason'], analysis['reason']
        assert starts('fail-analysis.log') == [] and not (WORK / 'fail-analysis.json').exists()
        assert not (LAB / 'data/jobs' / analysis['id'] / 'dispatched.json').exists()
        told = mails(run['id'])
        assert len(told) == 1 and told[0]['metadata']['status'] == 'failed', told
        assert 'Not started and waiting: analysis' in told[0]['body'], told[0]['body']
        mcp.call('job_run_cancel', {'runId': run['id']})
        run = settled(run['id'], {'cancelled'})
        assert stage_of(run, 'analysis')['attempts'][0]['status'] == 'cancelled'
        check('A failed upstream leaves its analysis waiting and never started, with the reason and one mail; cancelling the run settles it')

        # 2. `train; echo done` exits 0 without its checkpoint; 3. a truncated final.json.
        run = submit(mcp, 'masked-and-partial', [
            stage('masked', ['/bin/sh', '-c', f'/usr/bin/python3 {WORK}/fixture.py --log mask.log --mode no-output; echo done'],
                  artifacts=[{'path': 'mask-ckpt.json', 'format': 'json'}]),
            stage('partial', fixture('--log', 'partial.log', '--mode', 'partial', '--out', 'partial-final.json'),
                  artifacts=[{'path': 'partial-final.json', 'format': 'json'}]),
            stage('eval', fixture('--log', 'masked-eval.log', '--out', 'masked-eval.json'), needs=['masked', 'partial'],
                  artifacts=[{'path': 'masked-eval.json'}]),
        ])
        run = settled(run['id'], {'failed'})
        masked = job(stage_of(run, 'masked')['attempts'][0]['id'])
        assert masked['result']['evidence']['systemd']['ExecMainStatus'] == '0', masked['result']
        assert masked['status'] == 'failed', masked
        assert masked['reason'] == 'Exit 0, but declared artifacts failed verification: mask-ckpt.json: missing', masked['reason']
        partial = job(stage_of(run, 'partial')['attempts'][0]['id'])
        assert partial['status'] == 'failed' and 'partial-final.json: not complete JSON' in partial['reason'], partial['reason']
        assert partial['result']['artifacts'][0]['ok'] is False
        assert starts('masked-eval.log') == [] and len(starts('mask.log')) == 1
        assert 'done' in request('/jobs/' + masked['id'] + '/logs')['text']
        mcp.call('job_run_cancel', {'runId': run['id']})
        settled(run['id'], {'cancelled'})
        check('Exit 0 from "train; echo done" without its checkpoint, and a truncated final.json, are failures that start nothing downstream')

        # 4. A full chain: the next stage reads exactly the digests its upstream succeeded with.
        run = submit(mcp, 'chain', [
            stage('train', fixture('--log', 'chain-train.log', '--out', 'chain-final.json', '--sleep', '3'),
                  artifacts=[{'path': 'chain-final.json', 'format': 'json'}]),
            stage('eval', fixture('--log', 'chain-eval.log', '--read', 'chain-final.json', '--out', 'chain-eval.json'),
                  needs=['train'], artifacts=[{'path': 'chain-eval.json', 'format': 'json'}]),
        ], experiment='t105-acceptance')
        train_id = stage_of(run, 'train')['attempts'][0]['id']
        live = wait_for(lambda: job(train_id), lambda j: j['status'] == 'running' and (j.get('reports') or {}).get('progress'))
        assert live['reports']['progress']['value']['of'] == 6, live['reports']
        run = settled(run['id'], {'succeeded'})
        train = job(train_id)
        eval_job = job(stage_of(run, 'eval')['attempts'][0]['id'])
        assert train['result']['artifacts'][0]['sha256'] == sha('chain-final.json')
        assert eval_job['upstream'][0]['artifacts'][0]['sha256'] == sha('chain-final.json')
        assert eval_job['identity']['sha256'] and train['identity']['sha256']
        assert train['result']['progress']['value'] == {'step': 6, 'of': 6}
        assert json.loads((WORK / 'chain-eval.json').read_text())['inputs'][0]['return'] == 48
        told = mails(run['id'])
        assert len(told) == 1 and told[0]['metadata']['status'] == 'succeeded', told
        assert 'train attempt 1 succeeded; eval attempt 1 succeeded' in told[0]['body']
        assert any(r['id'] == run['id'] for r in mcp.call('job_run_list', {'experiment': 't105-acceptance'})['runs'])
        REPORT['chainTrainJob'] = train_id
        check('A succeeded chain: progress while running, verified SHA-256 handed downstream, one run mail')

        # 5. An upstream artifact changed after its stage succeeded: the next stage is rejected unstarted.
        run = submit(mcp, 'changed-upstream', [
            stage('train', fixture('--log', 'chg-train.log', '--out', 'chg-final.json'),
                  artifacts=[{'path': 'chg-final.json', 'format': 'json'}]),
            stage('slow', fixture('--log', 'chg-slow.log', '--out', 'chg-slow.json', '--sleep', '8'),
                  artifacts=[{'path': 'chg-slow.json'}]),
            stage('eval', fixture('--log', 'chg-eval.log', '--read', 'chg-final.json', '--out', 'chg-eval.json'),
                  needs=['train', 'slow'], artifacts=[{'path': 'chg-eval.json'}]),
        ])
        wait_for(lambda: job(stage_of(run_get(run['id']), 'train')['attempts'][0]['id']), lambda j: j['status'] == 'succeeded')
        (WORK / 'chg-final.json').write_text('{"return": 999}')
        run = settled(run['id'], {'failed'})
        rejected = job(stage_of(run, 'eval')['attempts'][0]['id'])
        assert rejected['status'] == 'rejected', rejected
        assert 'Upstream stage train artifact chg-final.json is no longer the one it succeeded with' in rejected['reason'], rejected['reason']
        assert starts('chg-eval.log') == []
        check('An upstream artifact changed between stages rejects the next stage before its command starts')

        # 6. A declared retryable exit is retried once more, the failed attempt's cost kept; unknown stays unknown.
        run = submit(mcp, 'api-retry', [
            stage('api', fixture('--log', 'api.log', '--out', 'answers.jsonl.json', '--usd', '0.092326', '--fail-attempts', '1'),
                  retry={'attempts': 3, 'exitCodes': [75]}, artifacts=[{'path': 'answers.jsonl.json', 'format': 'json'}]),
            stage('judge', fixture('--log', 'judge.log', '--read', 'answers.jsonl.json', '--out', 'judge.json',
                                   '--usd', '0.63', '--unknown-usage', '1'),
                  needs=['api'], artifacts=[{'path': 'judge.json', 'format': 'json'}]),
        ])
        run = settled(run['id'], {'succeeded'})
        api = stage_of(run, 'api')['attempts']
        assert [a['status'] for a in api] == ['failed', 'succeeded'], api
        first = job(api[0]['id'])
        assert 'Declared retryable: attempt 2 of 3' in first['reason'], first['reason']
        assert first['result']['cost']['knownUsd'] == 0.092326 and first['notifications']['failed'] == 'retried'
        assert job(api[1]['id'])['retryOf'] == api[0]['id']
        assert (LAB / 'data/jobs' / api[0]['id'] / 'usage.jsonl').read_text() != ''
        assert (LAB / 'data/jobs' / api[1]['id'] / 'usage.jsonl').exists()
        # Both api attempts recorded their call (0.092326 each), the judge 0.63 and one unknown.
        assert run['cost']['knownUsd'] == 0.814652 and run['cost']['unknownEntries'] == 1 and run['cost']['complete'] is False, run['cost']
        assert [s['attempt'] for s in starts('api.log')] == [1, 2]
        told = mails(run['id'])
        assert len(told) == 1 and told[0]['metadata']['status'] == 'succeeded' and 'plus 1 entries of unknown cost' in told[0]['body'], told
        check('A declared retryable exit becomes attempt 2 automatically; both attempts keep their own usage, unknown cost stays unknown')

        # 7. An exit not declared retryable (a budget stop, a code error) is told, not rerun.
        run = submit(mcp, 'stop-rule', [
            stage('api', fixture('--log', 'stop.log', '--mode', 'fail', '--usd', '0.6'), retry={'attempts': 3, 'exitCodes': [75]}),
        ])
        run = settled(run['id'], {'failed'})
        assert len(stage_of(run, 'api')['attempts']) == 1 and len(starts('stop.log')) == 1
        assert len(mails(run['id'])) == 1
        check('An exit not declared retryable is not retried and is told once')

        # 8. An explicit retry: idempotent, same frozen inputs; a changed input is rejected, not rerun.
        (WORK / 'flag-manual.log').write_text('fail')
        run = submit(mcp, 'manual-retry', [
            stage('prep', fixture('--log', 'manual.log', '--mode', 'fail-if-flag', '--out', 'manual.json'),
                  artifacts=[{'path': 'manual.json'}]),
            stage('train', fixture('--log', 'manual-train.log', '--read', 'manual.json', '--out', 'manual-train.json'),
                  needs=['prep'], artifacts=[{'path': 'manual-train.json'}]),
        ])
        run = settled(run['id'], {'failed'})
        (WORK / 'flag-manual.log').unlink()
        retry = {'requestId': str(uuid.uuid4()), 'runId': run['id'], 'stage': 'prep'}
        mcp.call('job_run_retry', retry)
        assert len(stage_of(mcp.call('job_run_retry', retry), 'prep')['attempts']) == 2
        run = settled(run['id'], {'succeeded'})
        assert [s['attempt'] for s in starts('manual.log')] == [1, 2] and len(starts('manual-train.log')) == 1
        conflict = mcp.call('job_run_retry', {**retry, 'stage': 'train'}, error=True)
        assert 'idempotency_conflict' in conflict, conflict
        run = submit(mcp, 'manual-changed', [
            stage('prep', fixture('--log', 'changed.log', '--mode', 'fail'), artifacts=[{'path': 'never.json'}]),
        ])
        run = settled(run['id'], {'failed'})
        (WORK / 'fixture.py').write_text((WORK / 'fixture.py').read_text() + '\n# edited after the failure\n')
        mcp.call('job_run_retry', {'requestId': str(uuid.uuid4()), 'runId': run['id'], 'stage': 'prep'})
        run = settled(run['id'], {'failed'})
        second = job(stage_of(run, 'prep')['attempts'][1]['id'])
        assert second['status'] == 'rejected' and 'Guarded inputs changed' in second['reason'], second
        assert len(starts('changed.log')) == 1
        shutil.copy(Path(__file__).with_name('fixture.py'), WORK / 'fixture.py')
        check('An explicit retry is idempotent and resumes the stages waiting on it; after a code change it is rejected, not rerun')

        # 9. Explicit reuse: accepted only for an identical, intact, succeeded attempt.
        chain = REPORT['chainTrainJob']
        eval_stage = stage('eval', fixture('--log', 'reuse-eval.log', '--read', 'chain-final.json', '--out', 'reuse-eval.json'),
                           needs=['train'], artifacts=[{'path': 'reuse-eval.json', 'format': 'json'}])
        train_stage = stage('train', fixture('--log', 'chain-train.log', '--out', 'chain-final.json', '--sleep', '3'),
                            artifacts=[{'path': 'chain-final.json', 'format': 'json'}])
        run = submit(mcp, 'reuse', [{**train_stage, 'reuse': chain}, eval_stage])
        assert stage_of(run, 'train')['status'] == 'reused' and stage_of(run, 'train')['attempts'] == []
        run = settled(run['id'], {'succeeded'})
        assert len(starts('chain-train.log')) == 1, 'the reused stage did not run again'
        reader = job(stage_of(run, 'eval')['attempts'][0]['id'])
        assert reader['upstream'][0]['jobId'] == chain and reader['upstream'][0]['reused'] is True

        def refused(stages, text):
            message = mcp.call('job_run_submit', {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'name': 'refused', 'stages': stages}, error=True)
            assert text in message, message
            return message
        (WORK / 'config.json').write_text(json.dumps({'seed': 25}))
        REPORT['refusedConfig'] = refused([{**train_stage, 'reuse': chain}], 'its code differs')
        (WORK / 'config.json').write_text(json.dumps({'seed': 24}))
        REPORT['refusedCommand'] = refused([{**train_stage, 'argv': train_stage['argv'] + ['--usd', '0'], 'reuse': chain}], 'its command differs')
        REPORT['refusedFresh'] = refused([train_stage, {**eval_stage, 'reuse': reader['id']}], 'runs fresh in this run')
        original = (WORK / 'chain-final.json').read_text()
        with urllib.request.urlopen(BASE + '/api/jobs/' + chain + '/artifacts/0', timeout=30) as response:
            assert response.read().decode() == original
        (WORK / 'chain-final.json').write_text(original.replace('48', '49'))
        REPORT['refusedChanged'] = refused([{**train_stage, 'reuse': chain}], 'is no longer the verified one')
        try:
            urllib.request.urlopen(BASE + '/api/jobs/' + chain + '/artifacts/0', timeout=30)
            raise AssertionError('an overwritten artifact was served as the attempt\'s file')
        except urllib.error.HTTPError as error:
            REPORT['overwrittenDownload'] = [error.code, error.read().decode()[:300]]
            assert 'no longer the file this attempt produced' in REPORT['overwrittenDownload'][1], REPORT['overwrittenDownload']
        (WORK / 'chain-final.json').unlink()
        REPORT['refusedMissing'] = refused([{**train_stage, 'reuse': chain}], 'missing')
        (WORK / 'chain-final.json').write_text(original)
        REPORT['refusedFailed'] = refused([{**train_stage, 'reuse': failed['id']}], 'only a succeeded attempt')
        check('Explicit reuse runs nothing again for an identical intact attempt; its artifact downloads only while unchanged; changed config, command, artifact, a missing file, a fresh upstream or a failed attempt are refused')

        # 10. Core stops mid-run: the running stage finishes on its own, the next starts once, one mail.
        run = submit(mcp, 'restart', [
            stage('first', fixture('--log', 'restart-first.log', '--out', 'restart-first.json', '--sleep', '6'),
                  artifacts=[{'path': 'restart-first.json'}]),
            stage('second', fixture('--log', 'restart-second.log', '--read', 'restart-first.json', '--out', 'restart-second.json'),
                  needs=['first'], artifacts=[{'path': 'restart-second.json'}]),
        ])
        first_id = stage_of(run, 'first')['attempts'][0]['id']
        wait_for(lambda: job(first_id), lambda j: j['status'] == 'running')
        stop_core()
        result_file = LAB / 'data/jobs' / first_id / 'result.json'
        wait_for(lambda: result_file.exists(), seconds=30)
        assert json.loads(result_file.read_text())['status'] == 'succeeded'
        assert starts('restart-second.log') == []
        start_core()
        run = settled(run['id'], {'succeeded'})
        stop_core()
        start_core()
        time.sleep(3)
        assert len(starts('restart-first.log')) == 1 and len(starts('restart-second.log')) == 1
        assert len(mails(run['id'])) == 1
        assert request('/collaboration/task_get', {'taskId': 'T-1'})['task']['status'] == 'doing'
        check('Core stopped mid-run: the stage finished on its own, the next started once after restart, one mail across two restarts')
        # A restarted Core issues new MCP credentials; an Agent reconnects, as here.
        mcp = MCP()

        # 11. Cancelling a run stops the running stage's process group; what waits never starts.
        run = submit(mcp, 'cancel', [
            stage('long', ['/usr/bin/python3', '-c', 'import subprocess,pathlib,time; p=subprocess.Popen(["/usr/bin/sleep","60"]); pathlib.Path("cancel-child.pid").write_text(str(p.pid)); time.sleep(60)']),
            stage('after', fixture('--log', 'cancel-after.log'), needs=['long']),
        ])
        wait_for(lambda: (WORK / 'cancel-child.pid').exists())
        child = int((WORK / 'cancel-child.pid').read_text())
        mcp.call('job_run_cancel', {'runId': run['id']})
        run = settled(run['id'], {'cancelled'})
        assert not Path('/proc', str(child)).exists()
        assert starts('cancel-after.log') == []
        told = mails(run['id'])
        assert len(told) == 1 and told[0]['metadata']['status'] == 'cancelled' and 'after attempt 1 cancelled before it started' in told[0]['body'], told
        check('Cancelling a run confirms the running stage and its child stopped; the waiting stage never starts; one mail')

        # 12. In a Git repository with the guard on (the default): an earlier stage
        #     writing its declared, tracked artifact does not reject the next one;
        #     an undeclared tracked change between stages does, by name.
        repo = WORK / 'repo'
        repo.mkdir()
        shutil.copy(WORK / 'fixture.py', repo / 'fixture.py')
        (repo / 'config.json').write_text(json.dumps({'seed': 24}))
        (repo / 'tracked-results.json').write_text('{}')
        (repo / 'notes.txt').write_text('first\n')

        def git(*args):
            subprocess.run(['git', '-C', str(repo), *args], check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        git('init', '-q')
        git('add', '.')
        git('-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qm', 'fixture')

        def repo_stage(key, argv, needs=(), **extra):
            return {**stage(key, argv, needs, **extra), 'cwd': str(repo), 'guardGit': True}

        def in_repo(*args):
            return ['/usr/bin/python3', '-u', str(repo / 'fixture.py'), *args]
        run = submit(mcp, 'git-guard', [
            repo_stage('write', in_repo('--log', 'git-write.log', '--out', 'tracked-results.json'),
                       artifacts=[{'path': 'tracked-results.json', 'format': 'json'}]),
            repo_stage('read', in_repo('--log', 'git-read.log', '--read', 'tracked-results.json', '--out', 'git-read.json'),
                       needs=['write'], artifacts=[{'path': 'git-read.json', 'format': 'json'}]),
        ])
        run = settled(run['id'], {'succeeded'})
        assert len(starts('repo/git-write.log')) == 1 and len(starts('repo/git-read.log')) == 1
        run = submit(mcp, 'git-guard-undeclared', [
            repo_stage('write', ['/bin/sh', '-c', f'echo changed >> notes.txt && /usr/bin/python3 {repo}/fixture.py --log git-write2.log --out other.json'],
                       artifacts=[{'path': 'other.json'}]),
            repo_stage('read', in_repo('--log', 'git-read2.log', '--out', 'git-read2.json'), needs=['write']),
        ])
        run = settled(run['id'], {'failed'})
        rejected = job(stage_of(run, 'read')['attempts'][0]['id'])
        assert rejected['status'] == 'rejected', rejected
        assert str(repo / 'notes.txt') in rejected['reason'] and "declare it as that stage's artifact" in rejected['reason'], rejected['reason']
        assert starts('repo/git-read2.log') == []
        REPORT['undeclaredTrackedChange'] = rejected['reason']
        check('In a Git repository with the guard on, an earlier stage writing its declared tracked artifact does not reject the next; an undeclared tracked change does, naming the file')

        # 13, 14. The guard's two boundaries: a file left out for an indirect
        # upstream is still checked; a rename onto a declared artifact is not
        # left out.
        REPORT['guardTransitive'] = guard_transitive(mcp)
        check('a -> b -> c with the guard on: b rewriting a\'s tracked artifact rejects c unstarted, checked against a\'s attempt')
        REPORT['guardRename'] = guard_rename(mcp)
        check('A rename of undeclared tracked code onto a declared artifact still rejects the next stage')

        # A duplicate submission is the same run.
        body = {'requestId': str(uuid.uuid4()), 'taskId': 'T-1', 'name': 'duplicate', 'stages': [stage('only', fixture('--log', 'dup.log', '--out', 'dup.json'))]}
        one, two = mcp.call('job_run_submit', body), mcp.call('job_run_submit', body)
        assert one['id'] == two['id']
        settled(one['id'], {'succeeded'})
        assert len(starts('dup.log')) == 1
        check('A repeated submission (lost reply) is the same run and starts once')
        REPORT['passed'] = True
    finally:
        stop_core()
        for spec in (LAB / 'data/jobs').glob('*/spec.json'):
            saved = json.loads(spec.read_text())
            for key in ('supervisorUnit', 'unit'):
                subprocess.run(['systemctl', '--user', 'stop', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
                subprocess.run(['systemctl', '--user', 'reset-failed', saved[key]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        (LAB / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        print(str(LAB / 'report.json'), flush=True)


if __name__ == '__main__':
    main()
    sys.exit(0 if REPORT.get("passed") else 1)
