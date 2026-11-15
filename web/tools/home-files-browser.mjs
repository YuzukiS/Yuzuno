// YN-145 F7: Home's field with files, in a real browser (system Chromium).
// Synthetic data only: the real ProjectTalk and HomeComposer with the app's
// own CSS, a stand-in fetch, no Core. Checks what JSDOM can't: eight file
// chips wrap with no sideways overflow at 1440 and 390, in Chinese and
// English, and on a phone each chip and its remove button are at least 44 px.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { engine, launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/yn145-f7/browser"));
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/home-files-browser-"));
const report = { engine, checks: [], errors: [], screenshots: [],
  limits: ["Chromium only: not iOS Safari, not a real iPhone, not the native desktop window.", "A stand-in fetch answers the page; no real Core or Agent takes part.",
    "This host's Chromium has no CJK font: the Chinese screenshots show boxes where Chinese text is. The text itself is checked as strings, in the browser's page and in jsdom."] };
const check = (name, detail = {}) => report.checks.push({ name, ...detail });

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const id = (n) => String(n).padStart(64, "0");
const files = Array.from({ length: 8 }, (_, i) => ({ id: id(i + 1), name: `quarterly-report-${i + 1}.pdf`, bytes: 1024 * (i + 1) }));
const request = {
  id: "r1", n: 1, text: "Please review the eight quarterly reports before Friday.", textBlocks: null, title: "Review the reports",
  createdAt: ago(30), frontAgentId: "d", messageId: "m1", delivery: "accepted", files, replies: [], notes: [], routes: [],
  cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [],
};
const draftSlot = JSON.stringify(["ws", "p1", "request"]);
const draft = { text: "Here are the eight reports for review.", files, at: new Date().toISOString() };
const base = { model: "m", color: "sage", cwd: "/w/atlas", goal: "", createdAt: ago(60), updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", status: "idle" };
const agents = [{ ...base, id: "d", name: "Dev Lead", kind: "lead", harness: "codex" }];

let server, browser;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectTalk} from ${JSON.stringify(path.join(root, "src/home/ProjectTalk.tsx"))};
import {CardAgents} from ${JSON.stringify(path.join(root, "src/home/card-responsible.ts"))};
const root=createRoot(document.getElementById('root'));
window.renderTalk=()=>root.render(<CardAgents.Provider value={new Map(window.agents.map((a)=>[a.id,a]))}><ProjectTalk projectId="p1" projectName="Atlas" workspaceId="ws" readOnly={false} revision={0} leadCount={1} onCard={()=>{}} onNavigate={()=>{}}/></CardAgents.Provider>);`);
  const built = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "HomeFilesBrowser", formats: ["iife"] } },
  });
  const output_ = (Array.isArray(built) ? built[0] : built).output;
  const bundle = output_.find((item) => item.type === "chunk").code;
  const css = [...(await Promise.all(["styles.css", "appearance.css", "palettes.css"]
    .map((file) => readFile(path.join(root, "src", file), "utf8")))),
    ...output_.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => String(item.source))].join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="yuzu"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><style>${css}
body{margin:0;padding:24px;background:var(--paper);color:var(--ink)}@media(max-width:600px){body{padding:10px}}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  await writeFile(path.join(output, "home-files.html"), html);
  server = createServer((request_, response) => {
    response.writeHead(request_.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request_.url === "/" ? html : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await launchBrowser();

  const open = async ({ width, height, language }) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: language === "zh" ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${width} ${language}: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && report.errors.push(`${width} ${language}: ${message.text()}`));
    await page.goto(url);
    await page.evaluate(({ language, request, draft, draftSlot, agents }) => {
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: language === "zh" ? "zh-Hans" : "en" }));
      localStorage.setItem("yuzuno.project-talk-drafts.v1", JSON.stringify({ [draftSlot]: draft }));
      window.agents = agents;
      const answer = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => "" });
      window.fetch = async (address, init = {}) => {
        const path = String(address).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (init.method === "POST") return answer({ receipt: { input: { text: "", clientMessageId: "c1" }, status: "accepted", turnId: "t1", error: null } });
        if (path.endsWith("/front-desk")) return answer({ version: 1, agentId: null, effectiveAgentId: "d" });
        if (path.endsWith("/requests")) return answer({ requests: [request], hasMore: false });
        return answer({});
      };
      window.renderTalk();
    }, { language, request, draft, draftSlot, agents });
    await page.waitForSelector(".project-talk-field .input-file");
    return { context, page };
  };

  const measure = (page, scope) =>
    page.evaluate((scope) => {
      const chips = [...document.querySelectorAll(`${scope} .input-file`)];
      const visible = chips.filter((chip) => chip.getBoundingClientRect().width > 0);
      const rects = visible.map((chip) => chip.getBoundingClientRect());
      const remove = [...document.querySelectorAll(`${scope} .input-file-remove`)].map((button) => button.getBoundingClientRect());
      const over = [...document.querySelectorAll(".project-talk-chat[data-open] .project-talk-scroll, .project-talk-field, .home-composer, .input-files, .input-file")]
        .map((element) => ({ cls: String(element.className), by: element.scrollWidth - element.clientWidth, width: element.clientWidth }))
        .filter((element) => element.by > 0);
      return {
        count: visible.length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        inner: Math.max(0, ...[...document.querySelectorAll(".project-talk-chat[data-open] .project-talk-scroll, .project-talk-field")]
          .map((element) => element.scrollWidth - element.clientWidth)),
        over,
        outside: rects.filter((rect) => rect.left < -0.5 || rect.right > window.innerWidth + 0.5).length,
        rows: new Set(rects.map((rect) => Math.round(rect.top / 4))).size,
        shortest: rects.length ? Math.min(...rects.map((rect) => rect.height)) : null,
        remove: remove.length ? Math.min(...remove.map((rect) => Math.min(rect.width, rect.height))) : null,
        links: visible.filter((chip) => chip.querySelector("a.input-file-body")).length,
        page: { width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth },
      };
    }, scope);

  const shot = async (page, name, selector) => {
    const file = path.join(output, `${name}.png`);
    await (selector ? page.locator(selector).screenshot({ path: file }) : page.screenshot({ path: file, fullPage: true }));
    return file;
  };

  for (const width of [1440, 390]) {
    for (const language of ["en", "zh"]) {
      const { context, page } = await open({ width, height: width === 390 ? 844 : 1000, language });
      // A narrow column shows one side: the conversation, where the field is.
      if (width === 390) {
        await page.locator('.project-talk-tabs [data-tab="chat"]').click();
        await page.waitForSelector('.project-talk-chat[data-open] .project-talk-field .input-file');
        await page.waitForTimeout(400);
      }
      // The page is in the language asked for, so the two screenshots differ.
      const chatTab = (await page.locator('.project-talk-tabs [data-tab="chat"]').textContent()).trim();
      assert.equal(chatTab, language === "zh" ? "对话" : "Conversation", `${width}: the page is in ${language}`);
      // The composer: eight chips in the draft, wrapping rather than widening the page.
      const composer = await measure(page, ".project-talk-field");
      assert.equal(composer.count, 8, `${width} ${language}: eight chips (${JSON.stringify(composer)})`);
      assert.equal(composer.overflow, 0, `${width} ${language}: no sideways scroll: ${JSON.stringify(composer.page)}`);
      assert.equal(composer.inner, 0, `${width} ${language}: nothing scrolls sideways inside (${JSON.stringify(composer.over)})`);
      assert.equal(composer.outside, 0, `${width} ${language}: every chip inside the viewport`);
      assert.ok(composer.rows >= 2, `${width} ${language}: the chips wrap (${composer.rows} rows)`);
      assert.equal(composer.links, 0, "a draft's chip is not a download link yet");
      if (width === 390) {
        assert.ok(composer.shortest >= 44, `phone: each chip at least 44 px (${composer.shortest})`);
        assert.ok(composer.remove >= 44, `phone: each remove button at least 44×44 (${composer.remove})`);
      }
      check(`${width} ${language}: the draft's eight file chips`, composer);

      // A sent request's eight files, as the requests side shows them.
      if (width === 1440) {
        const sent = await measure(page, '.project-talk-mine[data-words="1"]');
        assert.equal(sent.count, 8, "the request shows its eight files");
        assert.equal(sent.links, 8, "each one downloads from the Project");
        assert.equal(sent.overflow, 0);
        assert.equal(sent.inner, 0);
        assert.equal(sent.outside, 0);
        assert.ok(sent.rows >= 2, "they wrap too");
        check(`${width} ${language}: the request's eight files`, sent);
      }

      const full = await shot(page, `home-files-${width}-${language}`);
      const close = await shot(page, `home-files-${width}-${language}-composer`, ".project-talk-field");
      report.screenshots.push(full, close);
      await context.close();
    }
  }

  const sums = [];
  for (const name of await readdir(output)) {
    if (!name.endsWith(".png")) continue;
    const bytes = await readFile(path.join(output, name));
    sums.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  report.screenshots = sums;
  assert.deepEqual(report.errors, []);
  check("every case drawn with no page errors", report.errors.length);
} finally {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}

await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
