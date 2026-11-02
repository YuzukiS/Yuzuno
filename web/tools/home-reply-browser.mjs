// T-9: a reply from Home in the conversation, in a real browser (system
// Chromium; YUZUNO_WEBKIT_WS for Linux WebKit, which is not iOS Safari).
// Synthetic replies only, drawn by the real HomeReply and ReplyArrival with
// the app's own CSS; no Core, no request leaves the page. Checks what JSDOM
// can't: sizes, the six-line fold, 44 px phone targets, no sideways
// overflow, keyboard order and focus rings, the clipboard; and writes
// screenshots to compare with Dev 7's hr5.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { engine, launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/t9-reply/browser"));
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/home-reply-browser-"));
const report = { engine, checks: [], errors: [], apiCalls: [], screenshots: [],
  limits: ["Chromium (or Linux WebKit) only: not iOS Safari, not a real iPhone, not the native desktop window."] };
const check = (name, detail = {}) => report.checks.push({ name, ...detail });

const options = [{ id: "fifty", label: "每页 50 行（推荐）" }, { id: "hundred", label: "每页 100 行" }, { id: "scroll", label: "不分页，保持滚动" }];
const snapshot = (fields) => ({ format: 1, projectName: "atlas-notes", sectionKind: "ask", title: null, question: null, options: [],
  choice: null, text: null, form: null, ...fields });
const long = [
  "按下面的顺序处理，每一步都保留被丢弃行的计数，写进报告的附录：",
  "1. 先去掉完全重复的行，以导入时间最早的一条为准；",
  "2. 日期统一成 ISO 格式，无法解析的单独列一张表，不要直接删除；",
  "3. 金额字段保留两位小数，负数单独标出，不要取绝对值；",
  "4. 空的地区字段先按邮编补，补不上的标“未知”；",
  "5. 最后再做一次总数核对，和原始文件的行数差异要在报告里解释。",
  "如果某一步丢弃的行超过 5%，先停下来告诉我，不要继续下一步。",
].join("\n");
const raw = "Reply from the user on Home, to version 3 of the Project Brief section `export-paging` (\"导出页分页方案\") of atlas-notes (Workspace ws-1, Project p1):\n> 导出页表格改为分页后，每页显示多少行？\n\nChose: 每页 50 行（推荐） (fifty)\n\n先用 50 行。\n\nThe ask is now replied … brief_update {op:\"resolve\", key:\"export-paging\"}.";
const cases = [
  { name: "choice", origin: { projectId: "p1", key: "release-check", version: 2, workspaceId: "ws-1",
    snapshot: snapshot({ title: "发布前检查如何收尾？", question: "补一次完整审查，还是接受当前缺口进入合并队列？",
      options: [{ id: "full-review", label: "补一次完整审查（推荐）" }, { id: "accept", label: "接受当前缺口" }],
      choice: { id: "full-review", label: "补一次完整审查（推荐）" } }) } },
  { name: "both", origin: { projectId: "p1", key: "export-paging", version: 3, workspaceId: "ws-1",
    snapshot: snapshot({ title: "导出页分页方案", question: "导出页表格改为分页后，每页显示多少行？分页后排序和筛选保持不变；翻页按钮放在表格下方。",
      options, choice: options[0], text: "先用 50 行；手机上再看一下底部翻页按钮会不会挡住最后一行。" }) } },
  { name: "form", origin: { projectId: "p1", key: "weekly", version: 1, workspaceId: "ws-1",
    snapshot: snapshot({ title: "周报需要哪些部分？", question: "周报需要哪些部分？", form: { id: "weekly-form", title: "周报内容", fields: [
      { id: "parts", label: "包含的部分", type: "multi", answer: ["进展", "风险", "下周计划"] },
      { id: "due", label: "截止时间", type: "single", answer: "周五 18:00" },
      { id: "note", label: "补充说明", type: "text", answer: "风险部分请列出负责人和预计解决时间。" },
      { id: "files", label: "附件", type: "multi", answer: [] }] } }) } },
  { name: "long", origin: { projectId: "p1", key: "cleaning", version: 1, workspaceId: "ws-1",
    snapshot: snapshot({ title: "数据清洗规则怎么定？", question: "数据清洗规则怎么定？", text: long }) } },
  { name: "card", origin: { projectId: "p1", key: "progress", version: 4, workspaceId: "ws-1",
    snapshot: snapshot({ sectionKind: "report", title: "本周进展", options: null, text: "第三项的数字和附件里的不一致，请核对后更新这张卡片。" }) } },
  { name: "earlier", origin: { projectId: "p1", key: "weekly-plan", version: 2, workspaceId: "ws-1" } },
];

let server, browser;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {HomeReply, HomeReplyLinks} from ${JSON.stringify(path.join(root, "src/home-reply/HomeReply.tsx"))};
import {ReplyArrival} from ${JSON.stringify(path.join(root, "src/home-reply/ReplyArrival.tsx"))};
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
const links={open:(origin,from)=>window.opened.push([origin.key,from.itemId])};
window.opened=[];
const root=createRoot(document.getElementById('root'));
window.renderCases=(cases,raw)=>root.render(<HomeReplyLinks.Provider value={links}><main className="conversation-body"><button id="before">Before</button>{cases.map(c=><div key={c.name} className="user-message" data-case={c.name}><div className="message-label"><span className="you-avatar">Y</span>You</div><div className="user-text user-home-reply"><HomeReply origin={c.origin} agentId="a" turnId="t1" item={{id:'i-'+c.name,type:'userMessage',content:[{type:'text',text:raw}]}}/></div></div>)}<section className="home-section" data-case="arrival"><ReplyArrival arrival={{kind:'changed',current:4}} version={3} ask onBack={()=>window.opened.push(['back'])}/><h3>导出页分页方案</h3></section><section className="home-panel-content" data-case="removed"><ReplyArrival arrival={{kind:'removed'}} version={3} ask={false}/></section></main></HomeReplyLinks.Provider>);
window.renderHome=(arrival)=>root.render(<Home workspaceId="ws-1" revision={0} jobsRevision={0} agents={[]} projects={[]} readOnly={false} onNavigate={()=>{}} onChanged={()=>{}} arrival={arrival} onBackToReply={(link)=>window.opened.push(['back',link.itemId])}/>);`);
  const built = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "HomeReplyBrowser", formats: ["iife"] } },
  });
  const output_ = (Array.isArray(built) ? built[0] : built).output;
  const bundle = output_.find((item) => item.type === "chunk").code;
  // The app's own styles, then those its components import (Home's among them).
  const css = [...(await Promise.all(["styles.css", "appearance.css", "palettes.css", "home-reply/home-reply.css"]
    .map((file) => readFile(path.join(root, "src", file), "utf8")))),
    ...output_.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => String(item.source))].join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="yuzu"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><style>${css}
body{margin:0;padding:24px;background:var(--paper);color:var(--ink)}main{max-width:860px;margin:auto}main>.user-message{margin-bottom:24px}@media(max-width:600px){body{padding:14px}}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  await writeFile(path.join(output, "home-reply.html"), html);
  server = createServer((request, response) => {
    if (request.url !== "/") report.apiCalls.push(request.url);
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(request.url === "/" ? html : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await launchBrowser();
  const open = async ({ width, height, locale = "en-US" }) => {
    const context = await browser.newContext({ viewport: { width, height }, locale, ...(engine === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {}) });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${width}: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && report.errors.push(`${width}: ${message.text()}`));
    await page.goto(url);
    await page.evaluate(([cases, raw]) => window.renderCases(cases, raw), [cases, raw]);
    await page.waitForSelector('[data-case="earlier"] .home-reply');
    return { context, page };
  };
  const card = (name) => `[data-case="${name}"] .home-reply`;
  const shot = async (page, name, selector) => {
    const file = path.join(output, `${name}.png`);
    await (selector ? page.locator(selector).screenshot({ path: file }) : page.screenshot({ path: file, fullPage: true }));
    report.screenshots.push(file);
  };

  // Desktop.
  {
    const { context, page } = await open({ width: 860, height: 1400 });
    const sizes = await page.evaluate(() => {
      const card = document.querySelector('[data-case="both"] .home-reply');
      const px = (selector) => parseFloat(getComputedStyle(card.querySelector(selector)).fontSize);
      return { width: card.getBoundingClientRect().width, answer: px(".home-reply-choice"), words: px(".home-reply-words"), source: px(".home-reply-source"),
        layout: card.dataset.layout ?? null };
    });
    assert.equal(sizes.layout, null);
    assert.ok(sizes.width <= 704.5, `card ${sizes.width}px`);
    assert.ok(sizes.answer >= 15 && sizes.answer === sizes.words && sizes.source < sizes.answer - 2, JSON.stringify(sizes));
    check("desktop: the answer at the message's size, the source smaller, the card at most 44rem", sizes);
    // A form's title, field labels and "Not answered" are part of the answer: text contrast (WCAG AA,
    // 4.5:1) on the card, in every palette and theme (garden is the default).
    const contrast = await page.evaluate(() => {
      const probe = document.createElement("canvas").getContext("2d");
      const rgb = (color) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
      const html = document.documentElement;
      const kept = [html.dataset.palette, html.dataset.theme];
      const card = document.querySelector('[data-case="form"] .home-reply');
      const out = {};
      for (const palette of ["garden", "yuzu", "graphite", "pine", "sunroom"])
        for (const theme of ["light", "dark"]) {
          html.dataset.palette = palette;
          html.dataset.theme = theme;
          const paper = getComputedStyle(card).backgroundColor;
          const of = (selector) => ratio(getComputedStyle(card.querySelector(selector)).color, paper);
          out[`${palette} ${theme}`] = { title: of(".home-reply-form-title"), label: of("dt"), notAnswered: of("dd[data-empty]"), answer: of("dd:not([data-empty])") };
        }
      [html.dataset.palette, html.dataset.theme] = kept;
      return out;
    });
    const low = Object.entries(contrast).flatMap(([at, values]) => Object.entries(values).filter(([, v]) => v < 4.5).map(([what, v]) => `${at} ${what} ${v}`));
    assert.deepEqual(low, [], JSON.stringify(contrast));
    check("desktop: a form's title, labels, answers and Not answered read at 4.5:1 or more on the card, every palette and theme", contrast);
    // Six lines, then Show all; the whole text is there all along.
    const fold = await page.evaluate(() => {
      const words = document.querySelector('[data-case="long"] .home-reply-words');
      const line = parseFloat(getComputedStyle(words).lineHeight);
      return { lines: Math.round(words.clientHeight / line), clipped: words.scrollHeight > words.clientHeight + 1, text: words.textContent.length };
    });
    assert.equal(fold.lines, 6);
    assert.ok(fold.clipped);
    assert.equal(fold.text, long.length);
    await page.locator(card("long")).getByRole("button", { name: "Show all" }).click();
    const unfolded = await page.evaluate(() => {
      const words = document.querySelector('[data-case="long"] .home-reply-words');
      return { clipped: words.scrollHeight > words.clientHeight + 1, more: document.querySelector('[data-case="long"] .more').textContent };
    });
    assert.deepEqual(unfolded, { clipped: false, more: "Show less" });
    check("desktop: long words fold after six lines behind Show all, never cut", { ...fold, unfolded });
    // A card without a long answer has no Show all.
    assert.equal(await page.locator(`${card("both")} .more`).count(), 0);
    // Keyboard: the header, then the card in reading order, each with a ring.
    await page.focus("#before");
    const order = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => {
        const el = document.activeElement;
        const style = getComputedStyle(el);
        return { text: el.textContent.trim(), ring: style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 2 };
      }));
    }
    assert.deepEqual(order, ["Copy answer", "Question", "Original message", "Open on Home"].map((text) => ({ text, ring: true })));
    // Enter opens the question; Space the original message; their regions follow the footer.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    const opened = await page.evaluate(() => {
      const card = document.querySelector('[data-case="choice"] .home-reply');
      return { expanded: [...card.querySelectorAll("footer > button[aria-expanded]")].map((b) => b.getAttribute("aria-expanded")),
        regions: [...card.querySelectorAll('[role="region"]')].map((r) => r.getAttribute("aria-label")),
        original: card.querySelector(".home-reply-original pre").textContent };
    });
    assert.deepEqual(opened.expanded, ["true", "true"]);
    assert.deepEqual(opened.regions, ["Question", "Original message"]);
    assert.equal(opened.original, raw);
    check("desktop: keyboard order Copy answer, Question, Original message, Open on Home, each with a 2px ring; Enter and Space open", { order, opened: opened.expanded });
    // The clipboard, through the browser: the answer, and the original exactly.
    if (engine === "chromium") {
      await page.locator(card("both")).getByRole("button", { name: "Copy answer" }).click();
      await page.locator(card("both")).getByRole("button", { name: "Copied" }).waitFor();
      const answer = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(answer, "每页 50 行（推荐）\n\n先用 50 行；手机上再看一下底部翻页按钮会不会挡住最后一行。");
      await page.locator(card("form")).getByRole("button", { name: "Copy answer" }).click();
      await page.locator(card("form")).getByRole("button", { name: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
        "包含的部分: 进展, 风险, 下周计划\n截止时间: 周五 18:00\n补充说明: 风险部分请列出负责人和预计解决时间。\n附件: Not answered");
      await page.locator(card("choice")).getByRole("button", { name: "Copy original" }).click();
      await page.locator(card("choice")).getByRole("button", { name: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), raw);
      check("desktop: Copy answer copies the answer as shown; Copy original the message exactly");
    }
    await page.locator(card("both")).getByRole("button", { name: "Open on Home" }).click();
    assert.deepEqual(await page.evaluate(() => window.opened), [["export-paging", "i-both"]]);
    await shot(page, "desktop");
    await shot(page, "desktop-arrival", '[data-case="arrival"]');
    await context.close();
  }

  // Phone.
  {
    const { context, page } = await open({ width: 390, height: 844 });
    const phone = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".home-reply")];
      const rows = (card) => {
        const buttons = [...card.querySelectorAll(":scope > footer > button")];
        return buttons.map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), top: Math.round(r.top), height: r.height, left: Math.round(r.left) }; });
      };
      return { layouts: cards.map((c) => c.dataset.layout), both: rows(cards[1]), earlier: rows(cards[5]),
        minTarget: Math.min(...cards.flatMap((c) => [...c.querySelectorAll("button")].map((b) => b.getBoundingClientRect().height))),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        arrivalButton: document.querySelector(".home-reply-arrival-actions button").getBoundingClientRect().height };
    });
    assert.ok(phone.layouts.every((layout) => layout === "phone"), JSON.stringify(phone.layouts));
    assert.ok(phone.minTarget >= 44, `smallest target ${phone.minTarget}px`);
    assert.ok(phone.arrivalButton >= 44, `Back to your reply ${phone.arrivalButton}px`);
    assert.ok(phone.overflow <= 0, `${phone.overflow}px sideways`);
    assert.deepEqual(phone.both.map((b) => b.text), ["Copy answer", "Open on Home", "Question", "Original message"]);
    assert.equal(phone.both[0].top, phone.both[1].top);
    assert.equal(phone.both[2].top, phone.both[3].top);
    assert.ok(phone.both[2].top > phone.both[0].top);
    assert.equal(phone.earlier.length, 2);
    assert.equal(phone.earlier[0].top, phone.earlier[1].top, "an earlier reply takes one row");
    check("phone 390px: two rows of 44px targets, Copy answer and Open on Home first, Back to your reply 44px; no sideways scroll", phone);
    await page.locator(card("both")).getByRole("button", { name: "Question" }).click();
    const below = await page.evaluate(() => {
      const card = document.querySelector('[data-case="both"] .home-reply');
      return card.querySelector(".home-reply-question").getBoundingClientRect().top >= card.querySelector("footer").getBoundingClientRect().bottom - 1;
    });
    assert.ok(below, "the question opens under the actions");
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    await shot(page, "phone");
    await shot(page, "phone-question", card("both"));
    await context.close();
  }

  // Home (R1 839f91d1): Open on Home to a section kept out of view, in its
  // project's closed team details. The real Home; its reads answered in the
  // page, every request kept to show nothing is written (no seen, no reply).
  {
    const owner = { agentId: "a", name: "Mori", state: "active" };
    const body = { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["note"] }, note: { type: "Markdown", props: { text: "手机上翻页按钮会挡住最后一行。" } } } };
    const section = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: `About ${key}`, version, owner,
      updatedAt: "2026-11-01T14:05:00Z", updatedTurnId: null, body, attachments: [], refs: {}, seen: null, history: false, ...extra });
    const ask = (key, id, version) => section(key, id, version, { kind: "ask", title: "导出页分页方案",
      ask: { question: "改成每页 40 行？", reply: { options: [{ id: "forty", label: "每页 40 行" }, { id: "keep", label: "保持 50 行" }] }, state: "open" } });
    const panel = (id, name, sections, teamSections, history, unseen) => ({ project: { id, name },
      agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 }, errors: [], pending: [], jobs: [], unseen, missing: [],
      brief: { version: 3, sections, teamSections, history } });
    // p2 has changes to see, so it is open with its own team details, closed.
    const data = (team) => ({ generatedAt: "2026-11-01T14:30:00Z", order: ["p1", "p2"], needsYou: [], projects: [
      panel("p1", "atlas-notes", [section("other", 40, 1)], team, [section("old", 60, 2, { history: true, historyReason: "seen" })], 0),
      panel("p2", "beta-notes", [section("notes", 50, 1)], [section("kept", 51, 1)], [], 1)] });
    const machine = { at: "2026-11-01T14:30:00Z", cpu: { cores: 4, totalPct: 0, jobsPct: 0, agentsPct: 0, otherPct: 0 },
      memory: { totalMiB: 4096, usedMiB: 0, availableMiB: 4096, jobsMiB: 0, agentsMiB: 0 }, gpus: null, jobs: [] };
    const reply = (key, version, sectionId) => ({ origin: { projectId: "p1", key, version, workspaceId: "ws-1", sectionId,
      snapshot: { format: 1, projectName: "atlas-notes", sectionKind: "ask", title: "导出页分页方案", question: "每页多少行？", options: [],
        choice: null, text: "先用 50 行。", form: null } }, back: { workspaceId: "ws-1", agentId: "a", turnId: "t1", itemId: "i-both" }, n: 1 });
    const arrive = async (team, arrival) => {
      const context = await browser.newContext({ viewport: { width: 1100, height: 1300 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", (error) => report.errors.push(`home: ${error.message}`));
      page.on("console", (message) => message.type() === "error" && report.errors.push(`home: ${message.text()}`));
      await page.goto(url);
      await page.evaluate(([data, machine, arrival]) => {
        window.requests = [];
        window.fetch = async (input, init = {}) => {
          const at = String(input);
          window.requests.push(`${init.method || "GET"} ${at}`);
          const body = at.endsWith("/api/home") ? data : at.endsWith("/api/machine-load") ? machine : { repositories: [], links: [] };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        };
        window.renderHome(arrival);
      }, [data(team), machine, arrival]);
      await page.waitForSelector('[data-home-project="p1"] .home-reply-arrival', { state: "attached" });
      await page.waitForTimeout(400);
      return { context, page };
    };
    const state = (page, key) => page.evaluate((key) => {
      const p1 = document.querySelector('[data-home-project="p1"]');
      const card = p1.querySelector(`[data-section-key="${key}"]`);
      const rect = card.getBoundingClientRect();
      const note = document.querySelector(".home-reply-arrival");
      return {
        teamOpen: p1.querySelector(".home-team-details").open,
        historyOpen: p1.querySelector(".home-history").open,
        otherTeamOpen: document.querySelector('[data-home-project="p2"] .home-team-details').open,
        cardVisible: card.checkVisibility(), cardSize: [Math.round(rect.width), Math.round(rect.height)],
        inView: rect.top < innerHeight && rect.bottom > 0,
        noteVisible: note.checkVisibility(), noteInCard: card.contains(note),
        focused: document.activeElement === card,
        writes: window.requests.filter((r) => !r.startsWith("GET ")),
        requests: window.requests,
      };
    }, key);
    // The same section, changed, kept out of view: its details open, its card shown and focused, the note in it.
    {
      const { context, page } = await arrive([ask("export-paging", 10, 4)], reply("export-paging", 3, 10));
      const shown = await state(page, "export-paging");
      assert.deepEqual({ teamOpen: shown.teamOpen, historyOpen: shown.historyOpen, otherTeamOpen: shown.otherTeamOpen }, { teamOpen: true, historyOpen: false, otherTeamOpen: false });
      assert.ok(shown.cardVisible && shown.cardSize[0] > 0 && shown.cardSize[1] > 0 && shown.inView, JSON.stringify(shown));
      assert.ok(shown.noteVisible && shown.noteInCard, JSON.stringify(shown));
      assert.equal(shown.focused, true);
      assert.deepEqual(shown.writes, []);
      assert.ok(!shown.requests.some((r) => /\/brief\/(seen|reply)|\/seen\b/.test(r)), JSON.stringify(shown.requests));
      check("Home: a section answered in the closed team details opens them, shows and focuses its card with the note; nothing else opens, nothing is written", shown);
      await shot(page, "home-team-arrival");
      await context.close();
    }
    // Another section under the key, kept out of view: the details stay closed and its card is not focused.
    {
      const { context, page } = await arrive([ask("plan", 31, 2)], reply("plan", 1, 30));
      const other = await state(page, "plan");
      assert.deepEqual({ teamOpen: other.teamOpen, focused: other.focused, cardVisible: other.cardVisible, noteVisible: other.noteVisible, noteInCard: other.noteInCard },
        { teamOpen: false, focused: false, cardVisible: false, noteVisible: true, noteInCard: false });
      assert.deepEqual(other.writes, []);
      check("Home: another section under the key in the team details stays closed and unfocused; the neutral note shows", other);
      await context.close();
    }
  }

  // Chinese.
  {
    const { context, page } = await open({ width: 860, height: 1400, locale: "zh-CN" });
    const zh = await page.evaluate(() => {
      const card = document.querySelector('[data-case="both"] .home-reply');
      return { source: card.querySelector(".home-reply-source").textContent, actions: [...card.querySelectorAll(":scope > footer > button")].map((b) => b.textContent.trim()),
        arrival: document.querySelector('[data-case="arrival"] .home-reply-arrival').textContent };
    });
    assert.deepEqual(zh, {
      source: "来自 Home·导出页分页方案·atlas-notes",
      actions: ["复制回答", "问题原文", "原始消息", "回到 Home"],
      arrival: "你回复的是这个提问的第 3 版。它之后有了变化；这里是第 4 版，不是你回答的那一版。回到你的回复",
    });
    check("zh: the interface's words follow the language; the answer, title and question as written", zh);
    await shot(page, "zh", card("both"));
    await context.close();
  }

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.apiCalls, []);
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.close();
  await rm(fixture, { recursive: true, force: true });
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, checks: report.checks.map((c) => c.name), failure: report.failure ?? null }, null, 2));
}
