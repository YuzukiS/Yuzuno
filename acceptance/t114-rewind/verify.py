#!/usr/bin/env python3
"""Managed Job runner; outputs are isolated in target/t114, never live assets."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
root=Path(__file__).resolve().parents[2]
out=root/'target/t114';out.mkdir(parents=True,exist_ok=True)
phase=sys.argv[1]
env=dict(os.environ,CARGO_BUILD_JOBS='4')
env.setdefault('CARGO_TARGET_DIR',str(out/'cargo'))
checks=[]
def run(name,argv,cwd=root):
    start=time.monotonic()
    with (out/(name+'.log')).open('w') as log:
        r=subprocess.run(argv,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT)
    checks.append({'name':name,'exitCode':r.returncode,'seconds':round(time.monotonic()-start,2)})
    (out/(phase+'.json')).write_text(json.dumps(checks,indent=2)+'\n')
    print(name,r.returncode,flush=True)
    if r.returncode:
        print((out/(name+'.log')).read_text()[-14000:]);sys.exit(r.returncode)
if phase=='core':
    for name in ['rewind::tests','claude_checkpoints::tests']:
        run(name.replace('::','-'),['cargo','test','-p','yuzuno-workspace','--lib',name,'--','--test-threads=4'])
    run('core-build',['cargo','build','-p','yuzuno-workspace','--bin','yuzuno-workspace'])
elif phase=='web':
    if not (root/'web/node_modules/.package-lock.json').exists():run('web-deps',['npm','ci','--no-audit','--no-fund'],root/'web')
    run('typecheck',['node','node_modules/typescript/bin/tsc','-b','--noEmit'],root/'web')
    run('bundle',['node','node_modules/vite/bin/vite.js','build','--outDir',str(out/'web')],root/'web')
else:raise ValueError(phase)
