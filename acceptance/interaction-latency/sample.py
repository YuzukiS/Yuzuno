#!/usr/bin/env python3
"""Bounded read-only daily sample; mask fixture text instead of saving raw bodies."""
import collections
import http.client
import json
import os
from pathlib import Path
import re
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "target/t46"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "127.0.0.1"
PORT = 4317
MAX_BYTES = 32 * 1024 * 1024

def request(path):
    conn = http.client.HTTPConnection(BASE, PORT, timeout=8)
    start = time.perf_counter()
    conn.request("GET", path)
    response = conn.getresponse()
    headers = time.perf_counter()
    body = response.read(MAX_BYTES + 1)
    done = time.perf_counter()
    conn.close()
    if len(body) > MAX_BYTES or response.status != 200:
        raise RuntimeError(f"bounded GET failed: {path} {response.status} {len(body)}")
    value = json.loads(body)
    parsed = time.perf_counter()
    return value, {"path": path, "bytes": len(body), "ttfbMs": (headers-start)*1000,
                   "bodyMs": (done-headers)*1000, "pythonParseMs": (parsed-done)*1000,
                   "totalMs": (done-start)*1000}

def host():
    mem = {k: int(v.split()[0]) for k,v in (line.split(":",1) for line in Path('/proc/meminfo').read_text().splitlines())}
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return {"at":time.time(),"cpuCount":os.cpu_count(),"load":Path('/proc/loadavg').read_text().split()[:3],
        "memoryKiB":{k:mem[k] for k in ['MemTotal','MemAvailable','SwapTotal','SwapFree']},
        "swapPages":{k:int(vm[k]) for k in ['pswpin','pswpout']},
        "pressure":{k:Path('/proc/pressure',k).read_text() for k in ['cpu','memory','io']}}

def core():
    for p in Path('/proc').glob('[0-9]*/comm'):
        try:
            if p.read_text().strip() != 'yuzuno-workspac': continue
            proc = p.parent
            exe = os.readlink(proc/'exe')
            if '/managed-core/releases/' not in exe: continue
            stat = (proc/'stat').read_text().split(') ')[1].split()
            status = (proc/'status').read_text()
            return {'pid':int(proc.name),'exe':exe,'cpuTicks':int(stat[11])+int(stat[12]),
                'rssKiB':int(re.search(r'VmRSS:\s+(\d+)',status)[1]),
                'swapKiB':int(re.search(r'VmSwap:\s+(\d+)',status)[1])}
        except (OSError, AttributeError): pass
    raise RuntimeError('daily Core not found')

stream = {"bytes":0,"events":collections.Counter(),"seconds":0}
def sse():
    conn = http.client.HTTPConnection(BASE, PORT, timeout=1)
    start = time.monotonic()
    try:
        conn.request('GET','/api/events')
        response = conn.getresponse()
        while time.monotonic()-start < 5 and stream['bytes'] < 512*1024:
            line = response.readline(128*1024)
            if not line: break
            stream['bytes'] += len(line)
            if line.startswith(b'data:'):
                try: stream['events'][json.loads(line[5:]).get('type','unknown')] += 1
                except (ValueError,AttributeError): pass
    except (TimeoutError,OSError): pass
    finally:
        stream['seconds'] = time.monotonic()-start
        conn.close()

def mask(text):
    # Keep length, Markdown punctuation and line layout without retaining prose.
    return ''.join('x' if c.isascii() and c.isalpha() else '文' if c.isalpha() else c for c in text)

TEXT_KEYS = {'text','aggregatedOutput','command','diff','summary','arguments','output','question','description','label','reason','goal','_yuzunoCompletedText','_yuzunoInputText','title','prompt','message','body','detail','path','url','file_path','cwd'}
def redact(value, key='', prose=False):
    if isinstance(value,str): return mask(value) if prose or key in TEXT_KEYS else value
    if isinstance(value,list): return [redact(v,key,prose) for v in value]
    if isinstance(value,dict): return {k:redact(v,k,prose or k in {'input','params','output','arguments'}) for k,v in value.items()}
    return value

health, h = request('/api/health')
workspace, w = request('/api/workspace')
report = {'health':health,'requests':[h,w],'before':host(),'coreBefore':core()}
worker = threading.Thread(target=sse)
worker.start()
details = {}
for name, fixture_id in [('Dev Lead','a'),('Dev 1','b')]:
    agent = next(a for a in workspace['agents'] if a['name']==name)
    detail, metrics = request('/api/agents/'+agent['id'])
    metrics.update(name=name,turns=len(detail['turns']),items=sum(len(t['items']) for t in detail['turns']))
    report['requests'].append(metrics)
    clean = redact(detail)
    clean['agent'].update(id=fixture_id,name='Long Agent' if fixture_id=='a' else 'Other Agent',cwd='/fixture',status='idle',unreadCount=0,pendingCount=0,reviewedSeq=agent['lastSeq'])
    for k in ['workSummary','contextUsage','collaboration','accountUsage']: clean['agent'].pop(k,None)
    clean['pending']=[]
    clean['artifacts']=[]
    clean['messageReceipts']=[]
    clean.pop('collaboration',None)
    clean.pop('backgroundShells',None)
    for turn in clean['turns']:
        if turn['status'] in ['inProgress','running']: turn['status']='completed'
    details[fixture_id]=clean
worker.join(timeout=7)
report.update(after=host(),coreAfter=core(),sse=stream)
elapsed=report['after']['at']-report['before']['at']
report['coreOneCpuPct']=(report['coreAfter']['cpuTicks']-report['coreBefore']['cpuTicks'])/os.sysconf('SC_CLK_TCK')/elapsed*100
release=Path(report['coreBefore']['exe']).parents[1]
manifest=json.loads((release/'manifest.json').read_text())
report['release']={k:manifest[k] for k in ['releaseId','version','gitSha','builtAt']}
report['assets']={k:v for k,v in manifest['files'].items() if k in ['web/index.html'] or k.startswith('web/assets/index-')}
(OUT/'daily-sample.json').write_text(json.dumps(report,indent=2))
(OUT/'fixture.json').write_text(json.dumps({'details':details},ensure_ascii=False))
print(json.dumps(report,indent=2))
