from pathlib import Path
import hashlib, json, os, urllib.request

ROOT = (Path.home() / 'yuzuno-next')
OUT = ROOT / 'acceptance/turn-flow-switch'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('http://127.0.0.1:4317/api/workspace', timeout=5) as response:
    workspace = json.load(response)
processes = []
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        argv = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
        if not argv or Path(argv[0]).name != 'yuzuno-workspace': continue
        if '--port' not in argv or argv[argv.index('--port') + 1] != '4317': continue
        stat = (proc / 'stat').read_text().split(') ', 1)[1].split()
        processes.append({'pid': int(proc.name), 'startTicks': stat[19], 'argv': argv,
                          'cwd': str((proc / 'cwd').resolve()),
                          'sha256': hashlib.sha256((proc / 'exe').read_bytes()).hexdigest()})
    except (OSError, UnicodeError): pass
assert len(processes) == 1, processes
thread = os.environ.get('CODEX_THREAD_ID') or os.environ.get('CODEX_SESSION_ID')
record = {'process': processes[0], 'currentThread': thread, 'agents': []}
for agent in workspace['agents']:
    summary = {key: agent.get(key) for key in ('id','name','harness','threadId','claudeSessionId','status','closedAt','pendingCount','connectionState')}
    if agent.get('threadId') == thread:
        with opener.open('http://127.0.0.1:4317/api/agents/' + agent['id'], timeout=5) as response:
            detail = json.load(response)
        summary['latestTurn'] = [{key: t.get(key) for key in ('id','status')} for t in detail['turns'][-1:]]
    record['agents'].append(summary)
(OUT / 'inspection.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(record, ensure_ascii=False, indent=2))
