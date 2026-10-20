#!/usr/bin/env python3
"""Integration check: changes only the owned lab database; no resume or prompt."""
import json
from pathlib import Path
from lab import api, LAB, owned, save, verify_daily

assert owned()
state_path = LAB / 'lab-check.json'
assert not state_path.exists(), 'Preserve the existing one-shot acceptance evidence'
probe=json.loads((Path.home() / 'yuzuno-next-session-import/acceptance/session-import/native-probe.json').read_text())
thread=probe['fork']['metadata']['id']
assert thread != probe['sourceId']
state={'forkId':thread,'sourceId':probe['sourceId'],'checks':[]}
save(state_path,state)
def check(label):
 state['checks'].append(label);save(state_path,state);print(label,flush=True)
preview=api('/codex/sessions/preview',{'threadId':thread})
a=api('/codex/sessions/import',{'threadId':thread,'name':'Integration · saved conversation','permissionPreset':'ask'})
state['agentId']=a['id'];state['model']=preview['model'];save(state_path,state)
assert a['status']=='offline' and a.get('projectId') is None
check('native fork imported offline without a project or native resume')
p=api('/projects',{'name':'Yuzuno integration','defaultDirs':{'local':(str(Path.home() / 'yuzuno-next-integration'))}})
state['projectId']=p['id'];save(state_path,state)
a=api('/agents/'+a['id']+'/project',{'projectId':p['id']})
assert a['projectId']==p['id']
again=api('/codex/sessions/import',{'threadId':thread,'name':'No duplicate','permissionPreset':'ask'})
assert again['id']==a['id'] and again['projectId']==p['id']
check('assigning Project and duplicate import preserve the same Agent and membership')
d=api('/agents/'+a['id'])
assert d['agent']['unreadCount']==0 and d['history']['hasMore'] and len(d['turns'])==3
from urllib.parse import urlencode
page=api('/agents/'+a['id']+'/history?'+urlencode({'cursor':d['history']['nextCursor']}))
assert len(page['turns'])<=3 and len({t['id'] for t in page['turns']+d['turns']})==len(page['turns'])+len(d['turns'])
assert api('/agents/'+a['id'])['agent']['status']=='offline'
check('native history pages remain bounded and reading does not resume')
w=api('/workspace')
assert len(w['agents'])==1 and w['agents'][0]['projectId']==p['id']
check('Workspace projects and imported membership are projected together')
verify_daily()
