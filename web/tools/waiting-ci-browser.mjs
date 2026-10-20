// Production App bundle and real Chromium against isolated HTTP/SSE fixtures.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'target/t122');
await mkdir(out,{recursive:true});
const requests=[], errors=[], clients=new Set();
const base={cwd:'/fixture',harness:'codex',model:'fixture',color:'sage',createdAt:'now',updatedAt:'now',unreadCount:0,pendingCount:0,lastSeq:0,reviewedSeq:0};
let agents=[{...base,id:'a',name:'Idle fixture',status:'idle'},{...base,id:'b',name:'Working fixture',status:'working'}];
let ci={agents:{}},jobs={agents:{}};
const changed=(scope='jobs')=>{for(const res of clients)res.write(`data: ${JSON.stringify({type:'workspace.changed',scope})}\n\n`);};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');requests.push(url.pathname);
  if(url.pathname==='/api/events'){
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"resumed"}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
  }
  if(url.pathname.startsWith('/api/')){
    let value={};
    if(url.pathname==='/api/workspace')value={workspace:{id:'isolated-t122'},agents,projects:[],runtime:{connected:true},defaultCwd:'/fixture'};
    else if(url.pathname==='/api/ci/live')value=ci;
    else if(url.pathname==='/api/jobs/live')value=jobs;
    else if(/^\/api\/agents\/[ab]$/.test(url.pathname))value={agent:agents.find(a=>url.pathname.endsWith(a.id)),turns:[],pending:[],artifacts:[],messageReceipts:[]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));return;
  }
  try{
    const file=path.resolve(out,'web',url.pathname==='/'?'index.html':'.'+url.pathname);
    if(!file.startsWith(path.join(out,'web')+path.sep))throw Error('invalid path');
    const mime=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream';
    const body=await readFile(file);
    res.writeHead(200,{'content-type':mime});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1280,height:850}});page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const label=id=>page.locator(`[data-agent-id="${id}"] .agent-runtime`);
  await label('a').waitFor();
  const wait=async(text)=>page.waitForFunction(t=>document.querySelector('[data-agent-id="a"] .agent-runtime')?.textContent===t,text);
  ci={agents:{a:{running:1,discovering:0,check:0},b:{running:1,discovering:0,check:0}}};changed();
  await wait('Waiting · CI');assert.equal(await label('b').innerText(),'Working');
  await page.screenshot({path:path.join(out,'waiting-ci.png')});
  jobs={agents:{a:{active:2,unknown:0}}};changed();await wait('Waiting · Job / CI');
  const rowLayout=await page.locator('[data-agent-id="a"]').evaluate(row=>{
    const name=row.querySelector('.agent-name'), state=row.querySelector('.agent-runtime');
    const bounds=row.getBoundingClientRect(), status=state.getBoundingClientRect();
    // The card's ::after hit area extends one pixel beyond its border.
    // Check visible status geometry rather than that deliberate scroll overflow.
    return {nameFits:name.scrollWidth<=name.clientWidth,statusBelowName:status.top>=name.getBoundingClientRect().bottom,rowFits:status.left>=bounds.left&&status.right<=bounds.right};
  });
  assert.deepEqual(rowLayout,{nameFits:true,statusBelowName:true,rowFits:true});
  await page.screenshot({path:path.join(out,'waiting-both.png')});
  ci={agents:{a:{running:1,discovering:0,check:1}}};changed();await wait('Waiting · Job / CI · Check CI');
  assert.ok(await label('a').evaluate(el=>el.scrollWidth<=el.clientWidth),'mixed check status stays within its row');
  await page.screenshot({path:path.join(out,'waiting-mixed.png')});
  ci={agents:{a:{running:1,discovering:0,check:0}}};
  jobs={agents:{a:{active:1,unknown:1}}};changed();await wait('Waiting · CI · Check job');
  ci={agents:{a:{running:0,discovering:0,check:1}}};changed();await wait('Check job / CI');
  await page.screenshot({path:path.join(out,'check-both.png')});
  jobs={agents:{}};ci={agents:{}};changed();await wait('Ready');
  ci={agents:{a:{running:1,discovering:0,check:0}}};changed();await wait('Waiting · CI');
  ci={agents:{}};changed('collaboration');await wait('Ready');
  assert.ok(requests.filter(p=>p==='/api/ci/live').length>=5);
  assert.ok(!requests.some(p=>p==='/api/ci/refresh'||p.includes('/actions/')),'rail uses local aggregate only');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'browser-report.json'),JSON.stringify({verified:true,productionApp:true,ciReads:requests.filter(p=>p==='/api/ci/live').length,rowLayout,states:['Waiting · CI','Waiting · Job / CI','Waiting · Job / CI · Check CI','Waiting · CI · Check job','Check job / CI','Ready'],errors},null,2));
}finally{
  await browser?.close();for(const res of clients)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
