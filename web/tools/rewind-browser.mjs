// Production Turn/Rewind components, isolated HTTP fixture; never daily Core.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.resolve(root,'../target/t114/browser');await mkdir(out,{recursive:true});
await mkdir(path.join(root,'node_modules/.cache'),{recursive:true});
const fixture=await mkdtemp(path.join(root,'node_modules/.cache/rewind-'));
const entry=path.join(fixture,'entry.tsx');
const calls=[];const errors=[];let mode='codex';let outcome='completed';let rewound=false;
await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root,'src/components.tsx'))};
import {useAgentDetail} from ${JSON.stringify(path.join(root,'src/useAgentDetail.ts'))};
import ${JSON.stringify(path.join(root,'src/styles.css'))};
import ${JSON.stringify(path.join(root,'src/appearance.css'))};
const harness=new URLSearchParams(location.search).get('harness')||'codex';
const a={id:'fixture',harness,name:'Fixture',status:'idle',color:'sage',model:'fixture',cwd:'/fixture',connectionState:'connected'};
const t={id:'turn-2',status:'completed',startedAt:1000,completedAt:1150,durationMs:150000,items:[{id:'u',type:'userMessage',nativeUuid:'11111111-1111-4111-8111-111111111111',content:[{type:'text',text:'Original fixture input'}]},{id:'a',type:'agentMessage',phase:'final_answer',text:'Completed fixture reply.'}]};
function WindowFixture(){const h=useAgentDetail('ws-rewind','fixture');return <><button onClick={()=>h.navigate({turnId:'removed'})}>Pin removed turn</button><button onClick={()=>h.sync.refetch({now:true})}>Refetch</button><output>{h.detail?.turns.map(t=>t.id).join(',')}</output><aside>{String(h.error||'')}</aside></>;}
window.drafts=[];createRoot(document.getElementById('root')).render(harness==='window'?<WindowFixture/>:<div style={{padding:24,maxWidth:900}}><Turn turn={t} index={1} agent={a} onFile={()=>{}} onRewindDraft={(id,text)=>window.drafts.push({id,text})}/></div>);`);
let server,browser,page;
try{
 const built=await build({root,configFile:false,define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[react()],build:{write:false,lib:{entry,name:'RewindFixture',formats:['iife']}}});
 const output=(Array.isArray(built)?built[0]:built).output;
 const script=output.find(x=>x.type==='chunk').code;
 const css=output.filter(x=>x.type==='asset'&&x.fileName.endsWith('.css')).map(x=>x.source).join('\n');
 server=createServer(async(req,res)=>{
   if(!req.url.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`);return;}
   let text='';for await(const b of req)text+=b;const body=text?JSON.parse(text):{};calls.push({path:req.url,body});
   if(req.method==='GET'&&req.url.startsWith('/api/agents/fixture')){
     if(rewound&&req.url.includes('turnId=removed')){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({code:'turn_not_found',error:'Removed by rewind'}));return;}
     res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({agent:{id:'fixture',rev:rewound?2:1,lastSeq:rewound?2:1},turns:[{id:rewound?'kept':'removed',items:[]}],pending:[],artifacts:[]}));return;
   }
   let value={};
   if(req.url.endsWith('/rewind/preview'))value=mode==='claude'?{available:false,reason:'Claude does not persist conversation rewind without another prompt.'}:{available:true,previewId:'preview-1',removedTurns:3,keptTurns:1,draft:'Original fixture input'};
   if(req.url.endsWith('/rewind/confirm'))value={attemptId:'preview-1',status:outcome,message:outcome==='unknown'?'Outcome unknown; not repeated.':null,draft:'Original fixture input'};
   if(req.url.endsWith('/rewind/resolve'))value={attemptId:'preview-1',status:'resolved',message:'Current history accepted; original outcome remains unconfirmed.',draft:'Original fixture input'};
   if(req.url.endsWith('/rewind/check'))value={attemptId:'preview-1',status:'completed',draft:'Original fixture input'};
   if(req.url.endsWith('/checkpoints/preview'))value={userMessageId:body.userMessageId,previewId:'files-1',canRewind:true,files:[{path:'/fixture/note.txt',shown:'note.txt',exists:true}],insertions:1,deletions:1,expiresInSeconds:600};
   if(req.url.endsWith('/checkpoints/restore'))value={status:'stale',reason:'files',changed:['note.txt']};
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 page=await browser.newPage({viewport:{width:1000,height:800}});page.on('pageerror',e=>errors.push(String(e)));
 const base=`http://127.0.0.1:${server.address().port}`;
 await page.goto(base);await page.getByRole('button',{name:'Rewind',exact:true}).waitFor();
 assert.equal(calls.length,0,'no native scan at render');
 assert.equal(await page.locator('.reply-actions button').last().innerText(),'Rewind');
 await page.screenshot({path:path.join(out,'footer.png')});
 await page.getByRole('button',{name:'Rewind',exact:true}).click();
 await page.getByText('Remove this turn and 2 later turns',{exact:false}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,0);
 await page.screenshot({path:path.join(out,'conversation-preview.png')});
 await page.getByRole('button',{name:'Rewind conversation',exact:true}).dblclick();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,1);
 assert.deepEqual(await page.evaluate(()=>window.drafts),[{id:'fixture',text:'Original fixture input'}]);
 outcome='unknown';await page.reload();await page.getByRole('button',{name:'Rewind',exact:true}).click();await page.getByRole('button',{name:'Rewind conversation',exact:true}).click();
 await page.getByRole('button',{name:'Check outcome',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,2,'check does not repeat mutation');
 outcome='failed';await page.reload();await page.getByRole('button',{name:'Rewind',exact:true}).click();await page.getByRole('button',{name:'Rewind conversation',exact:true}).click();
 await page.getByText('Rewind did not complete.',{exact:false}).waitFor();assert.deepEqual(await page.evaluate(()=>window.drafts),[],'definite refusal must not append draft');
 outcome='unknown';await page.reload();await page.getByRole('button',{name:'Rewind',exact:true}).click();await page.getByRole('button',{name:'Rewind conversation',exact:true}).click();
 const beforeResolve=calls.filter(c=>c.path.endsWith('/confirm')).length;
 await page.getByRole('button',{name:'Keep current history',exact:true}).click();await page.getByText('Current history kept.',{exact:false}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/confirm')).length,beforeResolve,'resolution must not repeat revert');
 assert.equal(calls.filter(c=>c.path.endsWith('/resolve')).length,1);
 assert.equal(await page.getByRole('button',{name:'Check outcome',exact:true}).count(),0);
 mode='claude';await page.goto(base+'?harness=claude');await page.getByRole('button',{name:'Rewind',exact:true}).click();
 await page.getByText('Claude does not persist',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Rewind conversation',exact:true}).count(),0);
 await page.getByRole('button',{name:'Preview file restore…',exact:true}).click();await page.getByText('note.txt',{exact:true}).waitFor();
 const preview=calls.findLast(c=>c.path.endsWith('/checkpoints/preview'));assert.equal(preview.body.userMessageId,'11111111-1111-4111-8111-111111111111');
 await page.setViewportSize({width:390,height:800});await page.screenshot({path:path.join(out,'file-preview-mobile.png')});
 await page.getByRole('button',{name:'Restore 1 file',exact:true}).click();await page.getByText('These files changed after the preview',{exact:false}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/checkpoints/restore')).length,1);
 assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,0,'no automatic message');
 await page.goto(base+'?harness=window');await page.locator('output').filter({hasText:'removed'}).waitFor();
 await page.getByRole('button',{name:'Pin removed turn'}).click();
 await page.waitForFunction(()=>document.querySelector('output')?.textContent==='removed');
 rewound=true;await page.getByRole('button',{name:'Refetch',exact:true}).click();
 await page.locator('output').filter({hasText:'kept'}).waitFor();assert.equal(await page.locator('aside').innerText(),'');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'report.json'),JSON.stringify({passed:true,calls,errors},null,2));
 console.log('PASS rewind browser: footer, preview, one mutation, draft, unknown check, native file UUID, mobile');
}catch(error){if(page){console.log('DOM',await page.locator('body').innerText());await page.screenshot({path:path.join(out,'failure.png')});}throw error;}finally{await browser?.close();server?.close();await rm(fixture,{recursive:true,force:true});}
