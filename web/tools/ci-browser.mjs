// Explicit CI fixtures only. This does not claim live GitHub/notification acceptance.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
const root=fileURLToPath(new URL('../',import.meta.url)),output=process.env.CI_BROWSER_OUT||path.join(root,'../target/t49/browser');
await mkdir(output,{recursive:true});
const fixture=await mkdtemp(path.join(root,'node_modules/.cache/ci-browser-'));
const report={provenance:'Explicit GitHub Actions contract fixtures rendered through production Jobs components; no real CI observation claimed.',checks:[],errors:[],screenshots:[]};
let server,browser;
try{
 const entry=path.join(fixture,'entry.tsx');
 await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {Jobs} from ${JSON.stringify(path.join(root,'src/Jobs.tsx'))};const agent={id:'fixture',name:'Dev 4',cwd:'/fixture'};createRoot(document.getElementById('root')).render(<Jobs workspaceId="fixture" agent={agent} agents={[agent]} revision="1" disabled={false}/>);`);
 const built=await build({root,configFile:false,logLevel:'silent',plugins:[react()],define:{'process.env.NODE_ENV':'"production"'},build:{write:false,lib:{entry,name:'CiAcceptance',formats:['iife']}}});
 const bundle=(Array.isArray(built)?built[0]:built).output.find(x=>x.type==='chunk').code;
 const css=(await Promise.all(['styles.css','appearance.css','palettes.css','collaboration.css','updates.css','work-dock.css','jobs.css'].map(f=>readFile(path.join(root,'src',f),'utf8')))).join('\n');
 const run={id:'github:123:42:2',name:'中文 integration suite with a deliberately long workflow name',repository:'owner/repository',runId:'42',attempt:'2',headSha:'a'.repeat(40),status:'failed',rawStatus:'completed',conclusion:'failure',url:'https://github.com/owner/repository/actions/runs/42/attempts/2',observedAt:'2026-10-15T01:00:00Z',startedAt:'2026-10-15T00:55:00Z',cursor:1};
 const page={runs:[run,{...run,id:'github:123:43:1',runId:'43',name:'Documentation',attempt:'1',status:'skipped',conclusion:'skipped'}],subscriptions:[{id:'sub',agentId:'fixture',agent:{name:'Dev 4'},taskRef:'T-49',active:true,expiresAt:'2026-10-22T01:00:00Z',watch:{kind:'pull',number:31,url:'https://github.com/owner/repository/pull/31',expectedSha:'a'.repeat(40),currentHeadSha:'b'.repeat(40),state:'older_commit',observedAt:'2026-10-15T01:00:00Z',error:null}}],hasMore:false,nextBefore:null};
 const detail={run,error:null,details:{observedAt:run.observedAt,jobs:[{id:1,name:'Build on Linux',status:'failed',url:'https://github.com/owner/repository/actions/runs/42/job/1',steps:[{number:1,name:'Checkout',status:'completed',conclusion:'success'},{number:2,name:'Compile and test',status:'completed',conclusion:'failure'}]},{id:2,name:'Optional Windows check',status:'skipped',url:'https://github.com/owner/repository/actions/runs/42/job/2',steps:[]}],hasMore:false,nextPage:null}};
 // Manual checks with GitHub, answered in order after a visible pause.
 const rechecked={...detail.details,observedAt:'2026-10-15T01:05:00Z',jobs:[{...detail.details.jobs[0],steps:[...detail.details.jobs[0].steps,{number:3,name:'Upload test report',status:'completed',conclusion:'success'}]},detail.details.jobs[1]]};
 const checks=[{status:'checked',checkedAt:'2026-10-15T01:05:00Z',retryAt:null,error:null,paused:0,more:0,runWatched:true,run:{...run,observedAt:'2026-10-15T01:05:00Z'},details:[rechecked]},{status:'cooldown',checkedAt:null,retryAt:'2026-10-15T01:15:00Z',error:'rate_limited: GitHub rate limit reached; retry later',paused:1,more:2,runWatched:true,run:null,details:null}];
 const boot=`window.fixtureChecks=${JSON.stringify(checks)};window.fetch=async(url,init={})=>{window.fixtureCalls.push({url,method:init.method||'GET'});if(url==='/api/ci/refresh'){await new Promise(r=>setTimeout(r,400));const v=window.fixtureChecks.shift();return{ok:true,json:async()=>v};}const p=${JSON.stringify(page)},d=${JSON.stringify(detail)};let v=url.startsWith('/api/ci/')?d:url.startsWith('/api/ci?')?p:url==='/api/jobs/budget'?{machine:{name:'Fixture host'},budget:{cpuMillis:1000,memoryMiB:1024,swapMiB:0},reserved:{cpuMillis:0,memoryMiB:0,swapMiB:0},activeCount:0,queuedCount:0}:{jobs:[],hasMore:false};return{ok:true,json:async()=>v};};window.fixtureCalls=[];`;
 const html=`<!doctype html><html data-theme="light" data-palette="yuzu"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}\n:root{--reading-size:20px}body{background:var(--paper);color:var(--ink)}</style><div id="root"></div><script>${boot}${bundle.replaceAll('</script','<\\/script')}</script></html>`;
 await writeFile(path.join(output,'ci.html'),html);
 server=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({executablePath:process.env.YUZUNO_BROWSER_BIN||'/usr/sbin/chromium',headless:true});
 const p=await browser.newPage();p.on('pageerror',e=>report.errors.push(e.message));
 await p.goto('http://127.0.0.1:'+server.address().port);
 await p.getByRole('button',{name:'Jobs',exact:true}).click();
 await p.getByRole('tab',{name:'GitHub Actions',exact:true}).click();
 await p.locator('.ci-jobs .job-row').first().click();
 await p.locator('.ci-child-job').first().waitFor();
 // A failed job opens on its steps; the keyboard folds and opens it.
 assert.equal(await p.locator('.ci-child-job').first().getAttribute('open'),'');
 await p.locator('.ci-child-job summary').first().focus();await p.keyboard.press('Enter');
 assert.equal(await p.locator('.ci-child-job').first().getAttribute('open'),null);
 await p.keyboard.press('Enter');
 assert.equal(await p.locator('.ci-child-job').first().getAttribute('open'),'');
 assert.equal(await p.locator('.jobs-budget').count(),0);assert.equal(await p.getByRole('button',{name:'Run again…',exact:true}).count(),0);
 assert.match(await p.locator('.ci-jobs .job-detail').innerText(),/Older PR commit/);
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);await p.setViewportSize({width,height:1000});
  const b=await p.locator('.jobs-dialog').boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);
  assert.ok(await p.locator('.jobs-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog overflow');
  assert.ok(await p.locator('.ci-jobs').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'CI overflow');
  const name=`${theme}-${width}-20px.png`;await p.screenshot({path:path.join(output,name)});report.screenshots.push(name);report.checks.push(`${theme}/${width}/20px: no horizontal overflow, shared Jobs shell`);
 }
 // Manual check: busy while GitHub is asked, then its time and the new step;
 // then a rate-limited check that keeps the old steps and says until when.
 const recheck=p.getByRole('button',{name:'Check CI with GitHub now',exact:true});
 await p.evaluate(()=>document.documentElement.dataset.theme='light');await p.setViewportSize({width:390,height:1000});
 await recheck.click();
 await p.locator('.ci-check',{hasText:'Checking with GitHub…'}).waitFor();
 assert.equal(await recheck.isDisabled(),true);assert.equal(await recheck.getAttribute('aria-busy'),'true');
 await p.screenshot({path:path.join(output,'refresh-busy-light-390.png')});report.screenshots.push('refresh-busy-light-390.png');
 await p.locator('.ci-check',{hasText:'Checked with GitHub at'}).waitFor();
 await p.locator('.ci-child-job li',{hasText:'Upload test report'}).first().waitFor({state:'attached'});
 assert.equal(await recheck.isDisabled(),false);
 for(const theme of ['light','dark']){
  await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  assert.ok(await p.locator('.ci-jobs').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'CI overflow after a check');
  const name=`refresh-checked-${theme}-390.png`;await p.screenshot({path:path.join(output,name)});report.screenshots.push(name);
 }
 await recheck.click();
 await p.locator('.ci-check.inline-error',{hasText:'GitHub is limiting reads until'}).waitFor();
 assert.match(await p.locator('.ci-check').innerText(),/1 watch paused after repeated failures was not checked.*2 more watched targets follow on schedule/s);
 assert.equal(await p.locator('.ci-child-job li',{hasText:'Upload test report'}).count(),1,'the last observation stays');
 for(const width of [390,1440]){
  await p.setViewportSize({width,height:1000});
  assert.ok(await p.locator('.ci-jobs').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'CI overflow on a cooldown');
  const name=`refresh-cooldown-dark-${width}.png`;await p.screenshot({path:path.join(output,name)});report.screenshots.push(name);
 }
 report.checks.push('Check with GitHub: busy and disabled while asked; then its time and the new step; a rate-limited check keeps the last steps and says until when, at 390 and 1440 px, light and dark');
 await p.keyboard.press('Escape');await p.getByRole('dialog').waitFor({state:'hidden'});
 const calls=await p.evaluate(()=>window.fixtureCalls);
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>c.url),['/api/ci/refresh','/api/ci/refresh'],'the checks are the only POSTs');report.checks.push('Keyboard job expansion; Escape dismisses only dialog; all viewing requests read-only');assert.deepEqual(report.errors,[]);report.passed=true;
}finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await rm(fixture,{recursive:true,force:true});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
console.log(path.join(output,'report.json'));
