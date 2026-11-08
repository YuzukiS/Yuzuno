// YN-48, in Chromium: a running OpenCode Turn as the conversation shows it, with the app's CSS and no Core. Three
// moments of the reported "hello" that sat on a silent Working: calling OpenCode's default model; OpenCode retrying a
// provider it can't reach; and, after 1m 06s with nothing shown, the no-reply note with Stop and Change model.
// Desktop 1100×720 and phone 390×844; a screenshot of each in YUZUNO_BROWSER_OUTPUT.
//   YUZUNO_BROWSER_OUTPUT=<dir> node tools/opencode-waiting-check.mjs
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/opencode-waiting"));
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], shots: [] };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 600)}`}`);
};

let http, browser;
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/opencode-waiting-check-"));
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {OpenCodeRevertHost} from ${JSON.stringify(path.join(root, "src/Rewind.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurn=(props)=>root.render(<main className="conversation" style={{padding:'24px 32px',maxWidth:820}}>
  <OpenCodeRevertHost workspaceId="ws" agent={props.agent} onDraft={()=>true}><Turn {...props}/></OpenCodeRevertHost></main>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "OpenCodeWaitingCheck", formats: ["iife"] } } });
  const out = (Array.isArray(built) ? built[0] : built).output;
  const bundle = out.find((item) => item.type === "chunk").code;
  const css = [...(await Promise.all(["styles.css", "appearance.css", "palettes.css"].map((f) => readFile(path.join(root, "src", f), "utf8")))),
    ...out.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => String(item.source))].join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="garden"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><style>${css}
html,body{margin:0;background:var(--paper,#fdfdf9)}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  http = createServer(async (request, response) => {
    for await (const _ of request);
    if (request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); return response.end(html); }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${http.address().port}/`;
  browser = await launchBrowser();
  const agent = { id: "a", name: "OC Lab", status: "working", color: "sage", harness: "opencode", connectionState: "connected" };
  const hello = { id: "msg_t1:input", type: "userMessage", content: [{ type: "text", text: "hello" }] };
  const flint = { id: "opencode/flint-40b-free", name: "OpenCode · Flint 40B Free", default: true };
  const moments = [
    { name: "calling", ago: 8_000, extra: { _opencodeModel: flint }, expect: ".activity-model" },
    { name: "retrying", ago: 21_000, extra: { _opencodeModel: { id: "lmstudio/qwen3-coder-30b", name: "LM Studio · Qwen3 Coder 30B" },
      _opencodeRetry: { attempt: 3, nextIn: 8_000, message: "ECONNREFUSED: Unable to connect. Is the computer able to access the url?" } },
      expect: ".opencode-retry" },
    { name: "no-reply", ago: 66_000, extra: { _opencodeModel: flint }, expect: ".opencode-quiet" },
  ];
  for (const run of [{ name: "desktop", viewport: { width: 1100, height: 720 } }, { name: "phone", viewport: { width: 390, height: 844 }, phone: true }]) {
    const context = await browser.newContext({ viewport: run.viewport, locale: "en-US", hasTouch: !!run.phone, isMobile: !!run.phone,
      deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${run.name}: ${String(e).slice(0, 300)}`));
    await page.goto(base);
    for (const moment of moments) {
      await page.evaluate(({ agent, hello, moment }) => {
        const extra = { ...moment.extra };
        if (extra._opencodeRetry) extra._opencodeRetry = { ...extra._opencodeRetry, next: Date.now() + extra._opencodeRetry.nextIn };
        window.renderTurn({ index: 0, agent, onFile() {}, onStop() {}, onChangeModel() {},
          turn: { id: "msg_t1", status: "inProgress", _yuzunoStartedAt: Date.now() - moment.ago, items: [hello], ...extra } });
      }, { agent, hello, moment });
      await page.locator(moment.expect).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1200);
      const text = await page.locator(".turn-activity").textContent();
      const waiting = await page.locator(".opencode-waiting").count() ? await page.locator(".opencode-waiting").textContent() : "";
      ok(`${run.name} ${moment.name}: shown`, true, { text, waiting });
      if (moment.name === "no-reply") {
        ok(`${run.name} no-reply: Stop and Change model`, await page.getByRole("button", { name: "Stop" }).count() === 1
          && await page.getByRole("button", { name: "Change model" }).count() === 1);
        const overflow = await page.evaluate(() => [...document.querySelectorAll(".opencode-waiting, .turn-activity")]
          .some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== "hidden"));
        ok(`${run.name} no-reply: nothing overflows`, !overflow);
      }
      const file = path.join(output, `${run.name}-${moment.name}.png`);
      await page.locator("main").screenshot({ path: file });
      report.shots.push(file);
    }
    await context.close();
  }
} catch (error) {
  report.errors.push(String(error?.stack || error).slice(0, 2000));
} finally {
  await browser?.close();
  http?.close();
  await rm(fixture, { recursive: true, force: true });
}
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`checks ${report.checks.length}, failures ${report.failures.length}, errors ${report.errors.length}`);
process.exit(report.failures.length || report.errors.length ? 1 : 0);
