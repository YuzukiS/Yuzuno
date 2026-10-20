#!/usr/bin/env python3
"""Explicit native Dev MCP -> isolated Core review on port 4475.
Run setup once separately, then pass codex or claude. Does not merge or publish.
"""
import json,sys,time,uuid,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'target/t42/lab/state.json'
BASE='http://127.0.0.1:4475/api'
def api(path,body=None):
    request=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Yuzuno-Client':'desktop'})
    with urllib.request.urlopen(request,timeout=60) as r:return json.load(r)
def main():
    state=json.loads(STATE.read_text());harness=sys.argv[1]
    model='gpt-6.1-sol' if harness=='codex' else json.loads((ROOT/'target/t42/claude-catalog.json').read_text())['models'][0]['model']
    api('/pr-reviews/settings',{'harness':harness,'model':model})
    request_id='native-'+harness+'-'+str(uuid.uuid4())
    state[harness]={'requestId':request_id};STATE.write_text(json.dumps(state,indent=2))
    payload={'taskId':state['taskId'],'linkId':state['link']['id'],'requestId':request_id}
    prompt='Use only the built-in Yuzuno MCP. Explicitly call review_start exactly once with this payload: '+json.dumps(payload)+'. You are authorized to request this independent review. Then immediately finish your turn, stating its review ID. Do not poll for completion, sleep, spawn an agent, inspect files, run commands, or request another review. Core will finish the work independently. When a later normal mailbox doorbell arrives, use peer_read with its cursor, then review_get for the notified review ID and briefly report the saved result. Do not send receipt-only messages or start another review.'
    response=api('/agents/'+state['agentId']+'/turns',{'text':prompt})
    records=[];deadline=time.time()+600;review=None;last=None
    while time.time()<deadline:
        detail=api('/agents/'+state['agentId']);runs=api('/pr-reviews?taskId='+state['taskId'])['reviews']
        review=next((r for r in runs if r.get('requestId')==request_id),None)
        snapshot={'at':time.time(),'agentStatus':detail['agent']['status'],'reviewId':review['id'] if review else None,'reviewStatus':review['status'] if review else None}
        records.append(snapshot)
        if snapshot!=last and (not last or (last['agentStatus'],last['reviewStatus'])!=(snapshot['agentStatus'],snapshot['reviewStatus'])):print(json.dumps(snapshot),flush=True)
        last=snapshot
        if detail['pending']:raise RuntimeError('Native approval requires inspection')
        mail = api('/collaboration/peer_read', {'agentId':state['agentId'],'limit':100})['messages'] if review and review['status'] not in ['preparing','running'] else []
        notice = next((m for m in mail if m.get('reviewId') == review['id']), None) if review else None
        if review and review['status'] not in ['preparing','running'] and notice and notice.get('firstReadAt') and detail['agent']['status']=='idle':
            report=api('/pr-reviews/'+review['id']+'?taskId='+state['taskId'])
            activity=api('/collaboration/task_get',{'taskId':state['taskId'],'limit':100})
            artifact={'polls':records,'report':report,'authorDetail':detail,'task':activity,'notification':notice}
            (ROOT/f'target/t42/native-flow-{harness}.json').write_text(json.dumps(artifact,indent=2))
            state=json.loads(STATE.read_text());state[harness]['reviewId']=review['id'];STATE.write_text(json.dumps(state,indent=2))
            print(json.dumps({'status':review['status'],'actualModel':review['actualModel'],'conclusion':review['conclusion'],'error':review['error'],'contextReads':review.get('contextReads',[]),'authorFinishedWhileReviewActive':any(p['agentStatus']=='idle' and p['reviewStatus'] in ['preparing','running'] for p in records)}),flush=True)
            return
        time.sleep(1)
    raise RuntimeError('Acceptance deadline; inspect saved Core state before any retry')
if __name__=='__main__':main()
