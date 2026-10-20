// Real read-only GitHub acceptance on an explicitly isolated Core router.
// No model, remote writes or daily client window. Raw receipts stay under target/.
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.YUZUNO_GITHUB_TEST_URL;
const data=process.env.YUZUNO_GITHUB_TEST_DATA;
const out=process.env.YUZUNO_GITHUB_TEST_OUTPUT;
assert.ok(base?.startsWith('http://127.0.0.1:')&&!base.includes(':4317'),'Use isolated loopback port');
assert.ok(data?.includes('/target/github-links/')&&out?.includes('/target/github-links/'),'Use isolated target data/output');
await mkdir(out,{recursive:true});
const report={startedAt:new Date().toISOString(),mode:'real GitHub reads, production HTTP/MCP routes, seeded no-model agent',checks:[],screenshots:[],errors:[]};
async function api(path,body){const r=await fetch(`${base}/api${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Yuzuno-Client':'desktop'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.ok,true,JSON.stringify(v));return v;}
const call=(op,body)=>api(`/collaboration/${op}`,body);
const project=await api('/projects',{name:`GitHub acceptance ${Date.now()}`});
const task=(await call('task_create',{requestId:`github-live-task-${Date.now()}`,title:'GitHub delivery acceptance',projectId:project.id,status:'doing'})).task;
let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.YUZUNO_BROWSER_BIN});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('yuzuno.appearance',JSON.stringify({theme:'light',fontSize:20,palette:'garden'})));
 await page.goto(base);await page.locator('.workspace-scope').waitFor();
 await page.locator('.workspace-scope').click();await page.getByRole('menuitem',{name:'Manage projects…'}).click();
 await page.locator('.project-list-item').filter({hasText:project.name}).click();
 const repos=page.getByRole('region',{name:'GitHub repositories'});
 await repos.getByLabel('Repository',{exact:true}).fill('YuzukiS/Yuzuno');
 await repos.getByRole('button',{name:'Link',exact:true}).click();
 await repos.locator('.github-entry').waitFor({timeout:30000});
 assert.match(await repos.innerText(),/YuzukiS\/Yuzuno/);report.checks.push('Project repository linked through UI with actual gh read');
 await page.screenshot({path:`${out}/repositories-light-20.png`});report.screenshots.push('repositories-light-20.png');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Tasks & messages',exact:false}).click();
 await page.locator(`button[data-task-id="${task.id}"]`).click();
 const panel=page.getByRole('region',{name:'GitHub delivery'});
 await panel.getByLabel('Issue or pull request URL').fill('https://github.com/YuzukiS/Yuzuno/pull/8');
 await panel.getByRole('button',{name:'Link',exact:true}).click();await panel.locator('.github-entry').waitFor({timeout:30000});
 const http=await call('github_links',{taskId:task.id});
 assert.equal(http.links.length,1);assert.equal(http.links[0].snapshot.state,'merged');assert.equal(http.links[0].snapshot.ci.headSha,http.links[0].snapshot.headSha);
 const auth=(await readFile(`${data}/mcp-auth`,'utf8')).trim();
 const r=await fetch(`${base}/mcp/github-fixture`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':auth},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'github_links',arguments:{taskId:task.id}}})});
 const rpc=await r.json();assert.equal(r.ok,true);assert.equal(rpc.result.isError,false);assert.deepEqual(rpc.result.structuredContent.links,http.links);
 report.checks.push('Existing private PR read through UI and identical HTTP/MCP cached response');
 report.pr={repository:http.links[0].repository,number:8,state:http.links[0].snapshot.state,headSha:http.links[0].snapshot.headSha,ci:http.links[0].snapshot.ci.state,syncedAt:http.links[0].syncedAt};
 // A refresh must not clear an in-progress association draft.
 await panel.getByLabel('Issue or pull request URL').fill('unfinished 中文 draft');
 await panel.getByRole('button',{name:'Refresh GitHub',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="GitHub delivery"] [aria-label="Refresh GitHub"]').disabled,{},{timeout:40000});
 assert.equal(await panel.getByLabel('Issue or pull request URL').inputValue(),'unfinished 中文 draft');
 report.checks.push('Remote refresh preserved the typed URL');
 for(const theme of ['light','dark'])for(const width of [1440,760]){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--font-adjust','7px');},theme);
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/task-${theme}-${width}-20.png`});report.screenshots.push(`task-${theme}-${width}-20.png`);
  const layout=await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,root:document.documentElement.scrollWidth,viewport:innerWidth,font:getComputedStyle(document.documentElement).fontSize}));
  assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));assert.ok(layout.root<=layout.viewport+1,JSON.stringify(layout));assert.equal(layout.font,'20px');
 }
 report.checks.push('Light/dark, 20px, 1440/760 layout without GitHub panel overflow');
 const before=await call('task_get',{taskId:task.id});assert.equal(before.task.status,'doing');assert.equal(before.task.version,task.version);
 await call('github_links',{taskId:task.id,action:'link',input:'https://github.com/YuzukiS/Yuzuno/pull/8'});
 assert.equal((await call('github_links',{taskId:task.id})).links.length,1);
 await call('github_links',{taskId:task.id,action:'unlink',linkId:http.links[0].id});
 assert.equal((await call('github_links',{taskId:task.id})).links.length,0);
 report.checks.push('Duplicate link idempotent; unlink only local; merged PR never completed or versioned the task');
 assert.deepEqual(report.errors,[]);report.passed=true;
} finally {if(browser)await browser.close();report.finishedAt=new Date().toISOString();await writeFile(`${out}/receipt.json`,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
