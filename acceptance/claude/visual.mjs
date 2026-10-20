import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '../../web/node_modules/playwright-core/index.mjs';
const base='http://127.0.0.1:4337',out=new URL('./',import.meta.url);
const state=JSON.parse(await readFile(new URL('gui-state.json',out),'utf8'));
const report={checks:[],errors:[],limitedTo:'Isolated headless Chromium; not a new native WebView2/DPI acceptance'};
const browser=await chromium.launch({headless:true,executablePath:'/usr/sbin/chromium'});
try {
 const context=await browser.newContext();
 await context.route('**/*',r=>new URL(r.request().url()).origin===base&&['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 for(const width of [1440,900]) for(const theme of ['light','dark']) {
  await page.setViewportSize({width,height:1000}); await page.goto(base+'/?shell=desktop');
  await page.evaluate(({theme,id})=>{localStorage.setItem('yuzuno.appearance',JSON.stringify({theme,fontSize:20}));localStorage.setItem('yuzuno.selected',id);},{theme,id:state.agentId});
  await page.reload();await page.getByRole('heading',{name:state.name,exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('.conversation-scroll').count().then(async n=>{if(n) await page.locator('.conversation-scroll').evaluate(e=>e.scrollTop=e.scrollHeight);});
  await page.screenshot({path:new URL(`claude-${width}-${theme}-20px.png`,out).pathname});
  const result=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,fontSize:document.documentElement.dataset.fontSize}));
  assert.ok(result.content<=result.width);report.checks.push(result);
 }
 assert.equal(report.errors.length,0);report.passed=true;
}finally{await browser.close();await writeFile(new URL('visual-report.json',out),JSON.stringify(report,null,2));}
