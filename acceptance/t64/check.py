#!/usr/bin/env python3
"""Bounded, low-load acceptance of budget edits on an isolated Jobs Core.

Workers request normal development limits, but only wait on a release file.
No paid models, daily data, external Jobs, or memory/CPU pressure.
"""
import importlib.util
import json
from pathlib import Path
import sqlite3
import time
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("jobs_lab", ROOT / "acceptance/local-jobs/check.py")
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
lab.LAB = ROOT / "target/t47" / ("lab-t64-" + uuid.uuid4().hex[:10])
lab.PORT = 4496
lab.BASE = "http://127.0.0.1:4496"
OUT = ROOT / "target/t64/live-report.json"
report = {"lab": str(lab.LAB), "jobs": [], "checks": []}
jobs = []

def budget(cpu, ram):
    return {"cpuMillis": cpu, "memoryMiB": ram, "swapMiB": 0}

def current(job):
    return lab.request('/jobs/' + job['id'])

def check(name):
    report['checks'].append(name)
    print('PASS ' + name, flush=True)

def start():
    lab.start_core()
    with sqlite3.connect('file:' + str(lab.LAB / 'data/workspace.sqlite') + '?mode=ro', uri=True) as db:
        identity = db.execute("SELECT value FROM workspace_meta WHERE key='workspaceId'").fetchone()[0]
    assert lab.request('/health')['workspaceId'] == identity

try:
    lab.LAB.mkdir(parents=True)
    (lab.LAB / 'work').mkdir()
    start()
    initial = lab.request('/jobs/budget')
    report['initialBudget'] = initial
    assert initial['budget'] == budget(4000, 8192), initial
    maximum = initial['machine']['maximumBudget']
    assert maximum['cpuMillis'] >= 6000 and maximum['memoryMiB'] >= 10240
    try:
        lab.request('/jobs/budget', budget(maximum['cpuMillis'] + 1, 10240))
        raise AssertionError('Over-ceiling budget was accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 400
        report['validationError'] = error.read().decode()
        assert "host's ceiling" in report['validationError']
    worker = ('import pathlib,time; p=pathlib.Path("release"); deadline=time.monotonic()+90; '
              'print("waiting with negligible load",flush=True)\n'
              'while not p.exists() and time.monotonic()<deadline: time.sleep(.1)\n'
              'assert p.exists(), "bounded release deadline exceeded"')
    for index in range(3):
        jobs.append(lab.submit(lab.payload('budget-' + str(index), worker,
            resources=budget(2000, 4096), timeoutSeconds=100)))
    lab.wait_for(lambda: current(jobs[0]), lambda j: j['status'] == 'running')
    waiting = lab.wait_for(lambda: current(jobs[1]), lambda j: 'short 200 mCPU' in (j['reason'] or ''))
    report['beforeRaise'] = waiting
    assert current(jobs[2])['status'] == 'queued'
    frozen = {j['id']: {k: j[k] for k in ['attempt', 'resources', 'reservation', 'snapshot']} for j in jobs}
    lab.request('/jobs/budget', budget(6000, 10240))
    lab.wait_for(lambda: current(jobs[1]), lambda j: j['status'] == 'running')
    report['raisedBudget'] = lab.request('/jobs/budget')
    assert report['raisedBudget']['activeCount'] == 2
    assert report['raisedBudget']['reserved'] == budget(4200, 8320)
    assert current(jobs[2])['status'] == 'queued'
    check('raising budget admits the same second 2CPU/4GiB job; third stays queued')
    lab.request('/jobs/budget', budget(2000, 4096))
    report['loweredBudget'] = lab.request('/jobs/budget')
    assert report['loweredBudget']['activeCount'] == 2
    assert report['loweredBudget']['available'] == budget(0, 0)
    for j in jobs[:2]:
        value = current(j)
        assert value['status'] == 'running'
        assert {k: value[k] for k in frozen[j['id']]} == frozen[j['id']]
        assert value['result']['started']['limits']['memory.max'] == str(4096 * 1024 * 1024)
        assert value['result']['started']['limits']['cpu.max'] == '200000 100000'
    check('lowering budget preserves running attempts and original cgroup limits')
    (lab.LAB / 'work/release').write_text('release')
    for j in jobs[:2]:
        report['jobs'].append(lab.done(j, 'succeeded'))
    waiting = lab.wait_for(lambda: current(jobs[2]), lambda j: 'short 100 mCPU' in (j['reason'] or ''))
    assert waiting['reserved'] is False
    lab.request('/jobs/budget', budget(6000, 10240))
    report['jobs'].append(lab.done(jobs[2], 'succeeded'))
    assert len(lab.request('/jobs')['jobs']) == 3
    assert lab.request('/jobs/budget')['reserved'] == budget(0, 0)
    check('accepted queued job resumes after later increase without cancel or resubmit')
    lab.stop_core()
    start()
    assert lab.request('/jobs/budget')['budget'] == budget(6000, 10240)
    check('explicit saved budget survives restart')
    report['passed'] = True
finally:
    if lab.CORE:
        for j in jobs:
            try:
                v = current(j)
                if v['reserved'] or v['status'] == 'queued':
                    lab.request('/jobs/' + j['id'] + '/cancel', {})
                    lab.wait_for(lambda j=j: current(j), lambda v: not v['reserved'] and v['status'] != 'queued', seconds=20)
            except Exception as error:
                report.setdefault('cleanupErrors', []).append(str(error))
        lab.stop_core()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(str(OUT), flush=True)

assert not report.get('cleanupErrors'), report.get('cleanupErrors')
