#!/usr/bin/env python3
"""One bounded, prompt-free bridge initialization on the authorized Mac.

Uses the runtime already installed by native-v2, with the machine's own CLI
and login. It neither resumes nor retries the unknown Core start request.
Only stage names, errors and runtime provenance are emitted, never account
details. The remote process group contains only this diagnostic's children.
"""
import os
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
REMOTE = r'''
import json,os,signal,subprocess
from pathlib import Path
meta=json.loads((Path.home()/'.yuzuno-next/claude/9a001232a24f005fb80f3e3a/host.json').read_text())
runtime=Path(meta['runtime'])
assert runtime.parent==Path.home()/'.yuzuno-next/claude-runtime'
cwd=Path.home()/'.yuzuno-next/labs/t31-images-385ef5d207e146feaeeaccaf580d0450'
script=r"""
import { pathToFileURL } from 'node:url';
const stage = (stage, data = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...data }));
stage('node-start');
const { ClaudeBridge } = await import(pathToFileURL(process.argv[1] + '/bridge.mjs'));
stage('bridge-module-imported');
const sdk = await import(pathToFileURL(process.argv[1] + '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
stage('sdk-imported');
const bridge = new ClaudeBridge({ query: args => {
  stage('query-create');
  const q = sdk.query(args);
  stage('query-created');
  const original = q.initializationResult.bind(q);
  q.initializationResult = async () => {
    stage('initialization-wait');
    const result = await original();
    stage('initialization-received');
    return result;
  };
  return q;
}, emit: event => stage('bridge-event', { type: event.type, error: event.error }),
stderr: text => process.stderr.write(text + '\n') });
try {
  stage('start');
  const result = await bridge.start({ cwd: process.argv[2], catalogOnly: true });
  stage('ready', { started: result.started, provenance: result.provenance });
} catch (error) { stage('error', { message: error.message }); process.exitCode = 1; }
finally { bridge.close(); setTimeout(() => process.exit(process.exitCode || 0), 3000).unref(); }
"""
env=dict(os.environ,PATH='/opt/homebrew/bin:/usr/local/bin:'+os.environ.get('PATH',''))
p=subprocess.Popen([meta['node'],'--input-type=module','-e',script,str(runtime),str(cwd)],env=env,cwd=cwd,start_new_session=True)
try:
 code=p.wait(timeout=50)
except subprocess.TimeoutExpired:
 print(json.dumps({'stage':'diagnostic-timeout'}),flush=True); code=1
finally:
 try: os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: p.wait(timeout=5)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGKILL);p.wait()
raise SystemExit(code)
'''

out = ROOT / "target/t31-remote/diagnose-v2.log"
with out.open("xb") as log:
    result = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=10", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
        os.environ["T31_REMOTE_TARGET"], "python3 -c " + shlex.quote(REMOTE)],
        stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=75)
print(out.read_text(), end="")
raise SystemExit(result.returncode)
