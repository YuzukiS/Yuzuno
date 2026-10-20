// Isolated contract fixture; never connects to the daily Core or browser.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.CI_BROWSER_OUT || path.join(root, '../target/t71-followup/browser'));
await mkdir(output, { recursive:true });
const temp = await mkdtemp(path.join(root, 'node_modules/.cache/ci-stopped-'));
const report = { provenance:'Production Jobs UI with controlled CI responses, isolated browser and ephemeral local port; no live GitHub or daily Core.', checks:[], errors:[], screenshots:[] };
let server, browser;
try {
  const entry = path.join(temp,'entry.tsx');
  await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root,'src/Jobs.tsx'))};const agent={id:'fixture',name:'Dev',cwd:'/fixture'};createRoot(document.getElementById('root')).render(<Jobs workspaceId="fixture" agent={agent} agents={[agent]} revision="1" disabled={false}/>);`);
  const built = await build({root,configFile:false,logLevel:'silent',plugins:[react()],define:{'process.env.NODE_ENV':'"production"'},build:{write:false,lib:{entry,name:'StoppedCi',formats:['iife']}}});
  const bundle = (Array.isArray(built)?built[0]:built).output.find(x=>x.type==='chunk').code;
  const css = (await Promise.all(['styles.css','appearance.css','palettes.css','collaboration.css','updates.css','work-dock.css','jobs.css'].map(f=>readFile(path.join(root,'src',f),'utf8')))).join('\n');
  const run = {id:'github:123:42:1',name:'旧提交 · integration checks',repository:'owner/repository',runId:'42',attempt:'1',headSha:'a'.repeat(40),status:'running',rawStatus:'in_progress',conclusion:null,runWatched:false,url:'https://github.com/owner/repository/actions/runs/42/attempts/1',observedAt:'2026-10-17T01:00:00Z',startedAt:'2026-10-17T00:59:00Z',cursor:1};
  const boot = `window.calls=[];window.run=${JSON.stringify(run)};window.fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET'});const detail=()=>({jobs:[{id:1,name:'Build',status:'cancelled',url:'https://github.com/owner/repository/actions/runs/42/job/1',steps:[]}],page:1,hasMore:false,nextPage:null,observedAt:run.observedAt});let v;if(url==='/api/ci/refresh'){await new Promise(r=>setTimeout(r,250));run={...run,status:'cancelled',rawStatus:'completed',conclusion:'cancelled',observedAt:'2026-10-17T01:05:00Z'};v={status:'checked',checkedAt:run.observedAt,runWatched:false,run,details:[detail()]};}else if(url.startsWith('/api/ci/'))v={run,details:detail(),error:null};else if(url.startsWith('/api/ci'))v={runs:[run],subscriptions:[],hasMore:false,nextBefore:null};else if(url==='/api/jobs/budget')v={machine:{name:'Fixture'},budget:{cpuMillis:1000,memoryMiB:1024,swapMiB:0},reserved:{cpuMillis:0,memoryMiB:0,swapMiB:0},activeCount:0,queuedCount:0};else v={jobs:[],hasMore:false};return{ok:true,json:async()=>v};};`;
  const html = `<!doctype html><html data-theme="light" data-palette="yuzu"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}\n:root{--reading-size:20px}body{background:var(--paper);color:var(--ink)}</style><div id="root"></div><script>${boot}${bundle.replaceAll('</script','<\\/script')}</script></html>`;
  server=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(html);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({executablePath:process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium',headless:true});
  const p=await browser.newPage();p.on('pageerror',e=>report.errors.push(e.message));
  await p.goto('http://127.0.0.1:'+server.address().port);
  await p.getByRole('button',{name:'Jobs',exact:true}).click();
  await p.getByRole('tab',{name:'GitHub Actions',exact:true}).click();
  await p.locator('.ci-jobs .job-row').click();
  await p.locator('.ci-child-job').waitFor();
  assert.match(await p.locator('.job-detail-heading').innerText(),/Last seen running/);
  assert.equal(await p.locator('.ci-jobs .job-group-active').count(),0);
  assert.match(await p.locator('.job-detail').innerText(),/Not being watched.*last observation/s);
  for(const theme of ['light','dark'])for(const width of [1440,390]) {
    await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);await p.setViewportSize({width,height:1000});
    assert.ok(await p.locator('.jobs-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    assert.ok(await p.locator('.ci-jobs').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    const name=`historical-${theme}-${width}-20px.png`;await p.screenshot({path:path.join(output,name)});report.screenshots.push(name);
    report.checks.push(`${theme}/${width}/20px: historical Running is labelled, not in active group, no overflow`);
  }
  await p.getByRole('button',{name:'Check CI with GitHub now'}).click();
  await p.locator('.ci-check',{hasText:'Checking with GitHub'}).waitFor();
  await p.locator('.job-detail-heading',{hasText:'Cancelled'}).waitFor();
  assert.match(await p.locator('.ci-check').innerText(),/does not restart monitoring/);
  assert.equal(await p.locator('.ci-jobs .job-group-active').count(),0);
  await p.screenshot({path:path.join(output,'refreshed-dark-390-20px.png')});report.screenshots.push('refreshed-dark-390-20px.png');
  const writes=(await p.evaluate(()=>window.calls)).filter(c=>c.method!=='GET');
  assert.deepEqual(writes,[{url:'/api/ci/refresh',method:'POST'}]);
  report.checks.push('One refresh shows actual Cancelled; no subscription, resume or rerun request');
  assert.deepEqual(report.errors,[]);report.passed=true;
} finally {
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
  await rm(temp,{recursive:true,force:true});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
}
console.log(path.join(output,'report.json'));
