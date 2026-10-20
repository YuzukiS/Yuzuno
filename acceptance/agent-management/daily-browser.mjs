// Read-only daily smoke in a disposable Chromium. No user window or read cursor changes.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';
const report={checks:[],mutations:[],errors:[]};
const browser=await chromium.launch({headless:true,executablePath:'/usr/sbin/chromium'});
try {
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addInitScript(()=>Object.defineProperty(document,'hasFocus',{value:()=>false,configurable:true}));
  await context.route('**/api/**',async route=>{
    if(route.request().method()!=='GET'){
      report.mutations.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto('http://127.0.0.1:4317/?shell=desktop');
  await page.getByRole('button',{name:'Open Dev 2',exact:true}).click();
  await page.getByRole('button',{name:'Close agent',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close agent',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(),/Project files and the original Claude Code session/);
  await page.getByRole('button',{name:'Keep agent',exact:true}).click();
  report.checks.push('Daily Claude agent has visible Close action and cancel keeps it intact');
  await page.getByRole('button',{name:'Conversation actions',exact:true}).click();
  await page.getByRole('button',{name:'Delete agent…'}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  report.checks.push('Daily Delete action is available in conversation menu');
  await page.getByRole('button',{name:'Agent settings',exact:true}).click();
  const model=page.getByRole('combobox',{name:'Model',exact:true});
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] select option')].some(o=>o.value==='haiku'));
  assert.equal(await model.locator('option[value="haiku"]').count(),1);
  assert.equal(await page.getByRole('combobox',{name:'Reasoning effort',exact:true}).count(),0);
  report.checks.push('Daily existing Claude agent gets real native model options, no Codex-only settings');
  await page.screenshot({path:new URL('daily-claude-models.png',import.meta.url).pathname});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:/^New agent/}).click();
  await page.getByRole('combobox',{name:'Harness',exact:true}).selectOption('claude');
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] select option')].some(o=>o.value==='haiku'));
  assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).locator('option[value="haiku"]').count(),1);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  report.checks.push('Daily creation uses real Claude model dropdown');
  assert.deepEqual(report.mutations,[]);assert.deepEqual(report.errors,[]);
  report.status='passed';
} catch(error) {report.status='failed';report.error=String(error);throw error;}
finally {await browser.close();await writeFile(new URL('daily-browser-report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
