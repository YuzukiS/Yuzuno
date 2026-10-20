"""Read only initialize/account/read/rateLimits/read; never starts a model turn.
Writes an allowlisted, redacted response, not raw account/credential material.
"""
import datetime, hashlib, json, os, pathlib, selectors, subprocess, sys, time

out = pathlib.Path(sys.argv[1])
p = subprocess.Popen(['codex', 'app-server', '--stdio'], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
calls = []
def call(method, params=None):
    ident = len(calls) + 1
    calls.append(method)
    p.stdin.write(json.dumps({'id': ident, 'method': method, 'params': params})+'\n'); p.stdin.flush()
    selector = selectors.DefaultSelector(); selector.register(p.stdout, selectors.EVENT_READ)
    end = time.monotonic()+30
    try:
        while time.monotonic() < end:
            if not selector.select(max(0, end-time.monotonic())): break
            line = p.stdout.readline()
            if not line: raise RuntimeError('native connection closed')
            response = json.loads(line)
            if response.get('id') == ident:
                if 'error' in response: return {'errorCode': response['error'].get('code')}
                return response['result']
        raise RuntimeError('bounded read timed out')
    finally: selector.close()

report = {'source':'Installed Codex app-server, isolated stdio reader, existing authentication',
          'modelCalls':0,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    report['version'] = subprocess.check_output(['codex','--version'],text=True,stderr=subprocess.DEVNULL).strip()
    call('initialize', {'clientInfo':{'name':'yuzuno_usage_acceptance','version':'0.1.0'},'capabilities':{'experimentalApi':True}})
    p.stdin.write('{"method":"initialized"}\n');p.stdin.flush()
    account = call('account/read', {'refreshToken':False})
    a = account.get('account') or {}
    report['account'] = {'type':a.get('type'),'planType':a.get('planType'),'emailPresent':bool(a.get('email'))}
    result = call('account/rateLimits/read') if a.get('type')=='chatgpt' else {}
    report['errorCode'] = result.get('errorCode')
    report['accountIdPresent'] = bool(result.get('accountId'))
    report['accountIdDigest'] = hashlib.sha256(result['accountId'].encode()).hexdigest()[:12] if result.get('accountId') else None
    report['ordinaryUsageAllowed'] = result.get('ordinaryUsageAllowed')
    buckets = result.get('rateLimitsByLimitId') or {'codex':result.get('rateLimits')}
    report['buckets'] = []
    for key, bucket in buckets.items():
        if not isinstance(bucket,dict):continue
        row = {k:bucket.get(k) for k in ['limitName','planType']};row['limitId']=key
        for field in ['primary','secondary']:
            v=bucket.get(field);row[field] = {k:v.get(k) for k in ['usedPercent','windowDurationMins','resetsAt']} if isinstance(v,dict) else None
        row['creditsPresent']=isinstance(bucket.get('credits'),dict)
        report['buckets'].append(row)
    report['success']=report['errorCode'] is None
finally:
    report['methods']=calls
    p.terminate()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.kill();p.wait()
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
