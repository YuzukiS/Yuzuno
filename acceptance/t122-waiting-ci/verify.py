#!/usr/bin/env python3
"""Isolated managed verification; never writes daily Core or web/dist."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
out = root / 'target/t122'
out.mkdir(parents=True, exist_ok=True)
phase = sys.argv[1]
checks = []

def run(name, argv, cwd=root):
    started = time.monotonic()
    env = dict(os.environ, YUZUNO_UI_DIST=str(out/'web'))
    with (out/(name+'.log')).open('w') as log:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    checks.append(dict(name=name, exitCode=result.returncode, seconds=round(time.monotonic()-started, 2)))
    (out/(phase+'.json')).write_text(json.dumps(checks, indent=2)+'\n')
    print(name, result.returncode, flush=True)
    if result.returncode:
        print((out/(name+'.log')).read_text()[-14000:])
        sys.exit(result.returncode)

if phase == 'core':
    run('ci-monitor-tests', ['cargo','test','-p','yuzuno-workspace','--lib','ci_monitor::','--','--test-threads=4'])
    run('delivery-stop', ['cargo','test','-p','yuzuno-workspace','--lib','stopping_delivery_immediately_clears_its_live_ci_wait'])
elif phase == 'web':
    run('typecheck', ['node','node_modules/typescript/bin/tsc','-b','--noEmit'], root/'web')
    run('bundle', ['node','node_modules/vite/bin/vite.js','build','--outDir',str(out/'web')], root/'web')
    run('live-labels', ['node','--test','tools/live-jobs-ui.test.mjs','tools/live-ci-ui.test.mjs'], root/'web')
    run('app-updates', ['node','--test','--test-name-pattern=CI rail|idle Agent with unfinished jobs','tools/ui.test.mjs'], root/'web')
elif phase == 'browser':
    run('browser', ['node','web/tools/waiting-ci-browser.mjs'])
else:
    raise ValueError(phase)
