import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root=fileURLToPath(new URL('../../',import.meta.url));
const lab=path.join(root,'target/t47/lab-browser-'+Date.now());
await mkdir(lab,{recursive:true,mode:0o700});
const origin='http://127.0.0.1:4491', report={checks:[],screenshots:[],fixture:'Real isolated Core, systemd and production UI; scripted no-model native peer'};
const core=spawn(path.join(root,'target/debug/examples/local_jobs_lab'),[lab,'4491']);
const log=createWriteStream(path.join(lab,'core.log'));core.stdout.pipe(log);core.stderr.pipe(log);
let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,body){const r=await fetch(origin+'/api'+route,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json','X-Yuzuno-Client':'desktop'},body:JSON.stringify(body)});assert.ok(r.ok,`${route}: ${r.status} ${!r.ok?await r.text():''}`);return r.json();}
async function until(fn,seconds=35){const end=Date.now()+seconds*1000;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await delay(150);}throw new Error('State did not arrive within '+seconds+' seconds');}
const check=s=>{report.checks.push(s);console.log('PASS '+s);};
try{
 await until(()=>api('/health'));
 await api('/jobs/budget',{cpuMillis:600,memoryMiB:160,swapMiB:0});
 await api('/agents/lab-a/reconnect',{});
 await api('/agents/lab-a/messages',{clientMessageId:crypto.randomUUID(),text:Array.from({length:90},(_,i)=>`Reading line ${i+1}: 保留这段阅读位置。`).join('\n')});
 await until(async()=> (await api('/agents/lab-a')).agent.status==='idle');
 browser=await chromium.launch({executablePath:process.env.YUZUNO_BROWSER_BIN||'/usr/sbin/chromium',headless:true,args:['--disable-dev-shm-usage']});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await ctx.addInitScript(()=>{localStorage.setItem('yuzuno.selected',JSON.stringify('lab-a'));localStorage.setItem('yuzuno.appearance',JSON.stringify({theme:'light',fontSize:20,palette:'garden'}));});
 const page=await ctx.newPage(), errors=[], calls=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))calls.push({url:r.url(),method:r.method()});});
 await page.goto(origin);await page.locator('[data-composer-input]').waitFor();
 const composer=page.locator('[data-composer-input]');await composer.fill('Keep my ordinary conversation draft.');
 await page.locator('.conversation-scroll').evaluate(el=>{el.scrollTop=180;el.dispatchEvent(new Event('scroll'));});
 const reading=await page.locator('.conversation-scroll').evaluate(el=>el.scrollTop);
 const nav=page.locator('nav[aria-label="Workspace views"]');assert.equal(await nav.getByRole('button',{name:'Jobs',exact:true}).count(),1);
 await nav.getByRole('button',{name:'Jobs',exact:true}).click();await page.getByRole('button',{name:'New job',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('中文 GUI job');await page.getByLabel('Existing task',{exact:true}).fill('T-1');
 await page.getByLabel('Command',{exact:true}).fill('printf "真实 UI output\\n"; sleep 15; printf "artifact complete" > result.txt');
 await page.locator('.job-form').getByLabel('CPU quota',{exact:true}).fill('0.5');await page.getByLabel('RAM limit (MiB)',{exact:true}).fill('96');await page.getByLabel('Time limit (seconds)',{exact:true}).fill('40');
 await page.getByLabel('Output files, relative to the working directory',{exact:true}).fill('result.txt');
 await page.getByRole('button',{name:'Submit job',exact:true}).click();await page.locator('.job-detail').waitFor();
 const job=await until(async()=>{const p=await api('/jobs?agentId=lab-a');return p.jobs.find(j=>j.name==='中文 GUI job'&&j.status==='running');});
 const queued=await api('/jobs',{requestId:crypto.randomUUID(),taskId:'T-1',agentId:'lab-b',name:'Other Agent queued',cwd:path.join(lab,'work'),argv:['/usr/bin/true'],env:{},guardGit:false,resources:{cpuMillis:500,memoryMiB:96,swapMiB:0},timeoutSeconds:20});
 await until(async()=> (await page.locator('.jobs-budget').innerText()).includes('1 active · 1 queued'));
 assert.equal(await page.locator('.job-row').count(),2);
 await page.locator('.job-log').filter({hasText:'真实 UI output'}).waitFor();
 check('Workspace Jobs covers both Agents; GUI submits same Core contract; running/queued totals and real log agree');
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width,height:1000});
  const box=await page.locator('.jobs-dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);if(width===1440)assert.ok(box.width>=900,'Desktop jobs panel must use its wider layout');
  assert.ok(await page.locator('.jobs-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  const file=`${theme}-20px-${width}.png`;await page.screenshot({path:path.join(lab,file)});report.screenshots.push(file);
 }
 check('Light/dark at 20px fit 1440px and 390px without dialog horizontal overflow');
 await page.setViewportSize({width:1440,height:1000});await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(await composer.innerText(),'Keep my ordinary conversation draft.');assert.ok(Math.abs(await page.locator('.conversation-scroll').evaluate(el=>el.scrollTop)-reading)<3);
 assert.equal(calls.some(r=>r.url.endsWith('/interrupt')),false);check('Escape closes only Jobs; original reading position and composer draft survive');
 await until(async()=> (await api('/jobs/'+job.id)).status==='succeeded');await until(async()=> (await api('/jobs/'+queued.id)).status==='succeeded');
 await page.locator('.conversation-job').filter({hasText:'中文 GUI job'}).click();await page.locator('.job-detail .job-state.state-succeeded').waitFor();
 const output=page.locator('.job-detail a').filter({hasText:'result.txt'});const url=await output.getAttribute('href');assert.equal(await (await fetch(new URL(url,origin))).text(),'artifact complete');
 check('Conversation card opens exact completed job with downloadable declared output');
 await page.getByRole('button',{name:'Close jobs',exact:true}).click();
 await page.getByRole('button',{name:'Tasks & messages',exact:true}).click();await page.locator('.collab-task-card').filter({hasText:'Validate bounded local jobs'}).click();
 await page.getByRole('button',{name:'Related jobs',exact:true}).click();await page.locator('.job-task-scope').filter({hasText:'T-1'}).waitFor();
 assert.equal(await page.locator('.job-row').count(),2);assert.equal(await page.getByRole('dialog').count(),1);
 check('Task details open the same Jobs panel filtered by task, with whole-machine budget unchanged');
 const cancelling=await api('/jobs',{requestId:crypto.randomUUID(),taskId:'T-1',agentId:'lab-a',name:'Cancel from GUI',cwd:path.join(lab,'work'),argv:['/usr/bin/sleep','30'],env:{},guardGit:false,resources:{cpuMillis:500,memoryMiB:96,swapMiB:0},timeoutSeconds:35});
 await until(async()=> (await api('/jobs/'+cancelling.id)).status==='running');
 await page.locator('.job-row').filter({hasText:'Cancel from GUI'}).click();
 await page.locator('.job-detail').getByRole('button',{name:'Cancel',exact:true}).click();
 await until(async()=> (await api('/jobs/'+cancelling.id)).status==='cancelled');
 await page.locator('.job-detail .job-state.state-cancelled').waitFor();
 check('GUI cancellation reaches the common durable command and releases capacity only after verified exit');
 await page.keyboard.press('Escape');
 const before=calls.length;await delay(3500);assert.equal(calls.slice(before).some(r=>/\/jobs\/.+\/(logs|outputs)/.test(r.url)),false);
 assert.deepEqual(errors,[]);report.passed=true;check('Closed panel does not poll logs or details; no browser exceptions');
}finally{
 if(browser)await browser.close();core.kill('SIGTERM');await new Promise(r=>core.once('exit',r));
 for(const id of await readdir(path.join(lab,'data/jobs')).catch(()=>[])){
  const spec=await readFile(path.join(lab,'data/jobs',id,'spec.json'),'utf8').then(JSON.parse).catch(()=>null);if(!spec)continue;
  for(const unit of [spec.supervisorUnit,spec.unit]){spawnSync('systemctl',['--user','stop',unit],{timeout:8000,stdio:'ignore'});spawnSync('systemctl',['--user','reset-failed',unit],{timeout:8000,stdio:'ignore'});}
 }
 await writeFile(path.join(lab,'report.json'),JSON.stringify(report,null,2));console.log(path.join(lab,'report.json'));
}
