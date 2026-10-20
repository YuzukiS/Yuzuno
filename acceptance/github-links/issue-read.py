"""Read one existing public Issue; only the isolated Yuzuno associations change."""
import json, os, subprocess, urllib.request
from pathlib import Path
base=os.environ['YUZUNO_GITHUB_TEST_URL']
out=Path(os.environ['YUZUNO_GITHUB_TEST_OUTPUT'])
assert base.startswith('http://127.0.0.1:') and ':4317' not in base
assert '/target/github-links/' in str(out)
def call(path,body=None):
 req=urllib.request.Request(base+'/api'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','X-Yuzuno-Client':'desktop'})
 with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
def github(op,body):return call('/collaboration/'+op,body)
issues=json.loads(subprocess.check_output(['gh','api','--hostname','github.com','--method','GET','repos/cli/cli/issues?state=open&per_page=20'],timeout=20))
issue=next(i for i in issues if 'pull_request' not in i)
project=call('/projects')['projects'][0]['id']
task=github('task_list',{'projectId':project})['tasks'][0]['id']
github('github_repositories',{'projectId':project,'action':'link','input':'cli/cli'})
page=github('github_links',{'taskId':task,'action':'link','input':issue['html_url']})
linked=next(i for i in page['links'] if i['kind']=='issue')
assert linked['snapshot']['title']==issue['title']
assert linked['number']==issue['number']
assert 'ci' not in linked['snapshot']
assert github('task_get',{'taskId':task})['task']['status']=='doing'
receipt={'passed':True,'source':'existing public GitHub Issue; no remote mutation','repository':linked['repository'],'number':linked['number'],'state':linked['snapshot']['state'],'syncedAt':linked['syncedAt'],'taskStatus':'doing','ghVersion':subprocess.check_output(['gh','--version'],text=True).splitlines()[0]}
out.mkdir(parents=True,exist_ok=True)
(out/'issue-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
