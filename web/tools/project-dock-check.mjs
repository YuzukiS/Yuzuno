// YN-212 W2 in a browser, every API answered here (no Core, no daily
// configuration), through the production build, on a Project's page: "Talk
// to the project" keeps its composer in Home's dock, the stage's second row
// (design §4), at 1440, 900 and a phone (390), English and Chinese:
//  - the composer is in the dock, none under the conversation;
//  - the dock and Home's scroller overlap by 0 px; scrolled to its end, the
//    page's last part is wholly above the dock; the dock ends at the shell's
//    bottom; nothing is wider than the window;
//  - a phone: "+", the line and Send are 44 px, the text centred in the line;
//  - a follow-up's tag, its words, an image and a file stay after a reload;
//  - a keyboard (simulated as keyboard-viewport.ts marks one: --visual-height
//    and data-keyboard on the root): the dock's bottom is the visible
//    height's, and the request followed up stays in view above it;
//  - the conversation opens at its newest;
//  - nothing is sent but the reads.
// With YUZUNO_WEBKIT_WS it runs in Playwright's Linux WebKit instead (browser-engine.mjs), which is not iOS Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-dock-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { engine, launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-212", slice: "W2", engine, runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47397";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
// Synthetic names and words.
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "t", name: "YN-91 · 设置页排版", kind: "executor", status: "working",
    executor: { state: "running", agentId: "t", task: { id: "YN-91", title: "Settings layout", shortName: "设置页排版" }, dispatchedAt: at(50) } },
];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "lead-1", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (text) => ({ root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: node("Markdown", { text }) } });
const settings = { id: "YN-91", title: "Settings layout", shortName: "设置页排版", status: "doing", archived: false };
const designer = { agentId: "t", name: agents[1].name, kind: "executor", state: "running" };
let id = 400;
const section = (key, kind, title, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: lead, updatedAt: at(30), updatedTurnId: "t1", body: spec(`${title}: what it says.`),
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
// Enough cards that the page scrolls on every window.
const sections = [
  section("yn-91", "status", "设置页重新排版", { status: { asOf: at(20), validFor: 86_400, stale: false }, card: { task: settings, responsible: designer } }),
  ...Array.from({ length: 7 }, (_, i) => section(`note-${i}`, "report", `第 ${i + 1} 份报告：项目里的一项长期观察`)),
];
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 9, history: [], sections },
  }],
});
const desk = { agentId: "l", name: "lead-1" };
const R5 = "设置页重新排版、文案改口语";
const requests = () => [
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `r${9 - i}`, n: 9 - i, text: `第 ${9 - i} 个需求`, textBlocks: null, title: `需求 ${9 - i}`, createdAt: at(4 + i), frontAgentId: "l",
    messageId: `m${9 - i}`, delivery: "accepted", replies: [], notes: [{ note: "收到。", by: desk, at: at(3 + i) }], routes: [], cards: [],
    state: "waiting", progress: { cards: 0, ended: 0 }, lines: [],
  })),
  { id: "r5", n: 5, text: "设置页重新排版，文案改口语", textBlocks: null, title: R5, createdAt: at(40), frontAgentId: "l", messageId: "m5",
    delivery: "accepted", replies: [], notes: [{ note: "交给设计。", by: desk, at: at(39) }],
    routes: [{ kind: "card", index: 0, request: 5, at: at(39), state: "done", why: "有明确终点的设计", by: desk, to: { agentId: "t", name: agents[1].name },
      task: "YN-91", cardKey: "yn-91", sectionId: sections[0].id, title: sections[0].title }],
    cards: [{ sectionId: sections[0].id, key: "yn-91", title: sections[0].title, live: true, task: { id: "YN-91", status: "doing", archived: false }, responsible: designer }],
    state: "doing", progress: { cards: 1, ended: 0 }, lines: [] },
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const THUMB = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4cX0HVsQwtCQAhy6Vwe97qKgAAAAASUVORK5CYII=", "base64");
const DRAFTS = "yuzuno.project-talk-drafts.v1";
const SLOT = JSON.stringify(["ws-dock", "p-dev", "request"]);
const words = {
  en: { requests: "Requests", chat: "Conversation", followUp: "Follow up" },
  "zh-Hans": { requests: "需求单", chat: "对话", followUp: "补充" },
};
// A phone's keyboard, as the design's prototype measured it (§4.4): 336 px of an 844 px screen.
const KEYBOARD = 336;

const browser = await launchBrowser();
const runs = [
  { name: "en-1440", viewport: { width: 1440, height: 900 }, language: "en" },
  { name: "zh-1440", viewport: { width: 1440, height: 900 }, language: "zh-Hans" },
  { name: "en-900", viewport: { width: 900, height: 900 }, language: "en" },
  { name: "zh-900", viewport: { width: 900, height: 900 }, language: "zh-Hans" },
  { name: "en-390", viewport: { width: 390, height: 844 }, language: "en", phone: true },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", phone: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "project-dock-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`project-dock-check (${engine}): ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${engine} ${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    ...(run.phone ? { isMobile: engine === "chromium", hasTouch: true } : {}),
  });
  await context.addInitScript((language) => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-dock" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests" && method === "GET") return route.fulfill({ json: { requests: requests(), hasMore: false } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] },
    }[path];
    if (json) return route.fulfill({ json });
    if (/^\/api\/projects\/p-dev\/images\/[a-f0-9]{64}\.png$/.test(path)) return route.fulfill({ body: THUMB, contentType: "image/png" });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  // The project's page, opened (`again`: reloaded where it is); on a failure its screenshot, address and text.
  const open = async (page, again = false) => {
    if (!again) {
      page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
      await page.goto(`http://${HOST}/#/home?w=ws-dock&p=p-dev`);
    } else await page.reload();
    try {
      await page.locator('[data-project-home="p-dev"]').waitFor({ timeout: 15_000 });
      await page.locator('.request-card[data-request="5"]').waitFor({ state: "attached", timeout: 15_000 });
      await page.locator(".home-dock .project-dock-form").waitFor({ timeout: 15_000 });
    } catch (error) {
      await page.screenshot({ path: join(output, `${engine}-${run.name}-failed-open.png`) }).catch(() => {});
      const where = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 400) })).catch(() => null);
      throw new Error(`the project's page did not open (${again ? "reload" : "first"}): ${JSON.stringify(where)}\n${error.message}`);
    }
  };
  const shot = async (page, name, locator) => {
    const file = `${engine}-${run.name}-${name}.png`;
    await (locator ?? page).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  // Where the dock and the scroller stand, and how the page fits.
  const measure = (page) => page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const view = document.querySelector(".home-view");
    const dock = document.querySelector(".home-dock");
    const main = document.querySelector(".main-panel");
    const below = document.elementFromPoint(innerWidth - 4, innerHeight - 2);
    return {
      view: box(view), dock: box(dock), main: box(main), innerHeight, innerWidth,
      below: below ? `${below.tagName.toLowerCase()}.${[...below.classList].join(".")}` : null,
      pageWidth: document.scrollingElement.scrollWidth, viewWidth: view.scrollWidth, viewClient: view.clientWidth,
      inDock: !!dock.querySelector(".project-talk-compose"),
      underChat: !!document.querySelector(".project-talk-chat .project-talk-compose"),
    };
  });
  const page = await context.newPage();
  try {
    await open(page);
    const narrow = run.viewport.width <= 900;
    // The composer is in the dock, and the dock is the stage's second row: nothing between, nothing under.
    let m = await measure(page);
    assert.ok(m.inDock && !m.underChat, `the composer is in the dock: ${JSON.stringify(m)}`);
    const overlap = Math.max(0, m.view.bottom - m.dock.top);
    assert.ok(overlap <= 0.5 && Math.abs(m.view.bottom - m.dock.top) <= 0.5, `the scroller ends where the dock begins: ${JSON.stringify(m)}`);
    // Home's pane is the main panel; whatever the shell puts under it (m.below) is outside Home.
    assert.ok(Math.abs(m.dock.bottom - m.main.bottom) <= 1, `the dock ends at the bottom of Home's pane: ${JSON.stringify(m)}`);
    assert.ok(m.pageWidth <= m.innerWidth + 1 && m.viewWidth <= m.viewClient + 1, `nothing wider than the window: ${JSON.stringify(m)}`);
    await shot(page, "page");
    pass("the composer is in the dock, under Home's scroller with no overlap", { overlap, dock: m.dock, view: m.view, main: m.main, below: m.below });

    // Scrolled to its end, the page's last part is wholly above the dock.
    const end = await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      view.scrollTop = view.scrollHeight;
      const parts = [...document.querySelectorAll(".project-home > *, .project-home-body > *, .project-home-main > *")].filter((el) => el.getBoundingClientRect().height > 0);
      const last = parts.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a));
      return { last: last.className, bottom: last.getBoundingClientRect().bottom, viewBottom: view.getBoundingClientRect().bottom,
        dockTop: document.querySelector(".home-dock").getBoundingClientRect().top, scrolled: view.scrollTop > 0 };
    });
    assert.ok(end.scrolled, `the page scrolls: ${JSON.stringify(end)}`);
    assert.ok(end.bottom <= end.viewBottom + 0.5 && end.bottom <= end.dockTop + 0.5, `the last part is above the dock: ${JSON.stringify(end)}`);
    await shot(page, "end");
    pass("scrolled to its end, the last part is wholly visible above the dock", end);

    // The field: one line while empty; on a phone "+", the line and Send a finger high, the text centred in the line.
    const field = await page.evaluate(() => {
      const form = document.querySelector(".home-dock .project-dock-form");
      const composer = form.querySelector(".home-composer");
      const r = (el) => el?.getBoundingClientRect();
      const line = form.querySelector(".cm-line") ?? form.querySelector(".cm-content");
      const plus = form.querySelector(".composer-plus");
      const send = form.querySelector(".project-talk-send");
      const content = form.querySelector(".cm-content");
      const placeholder = form.querySelector(".cm-placeholder");
      const text = r(placeholder) ?? r(line);
      return { shape: composer.dataset.shape, composer: r(composer).height, plus: r(plus)?.height ?? null, send: r(send).height,
        content: r(content).height, textMid: text.top + text.height / 2, lineMid: r(content).top + r(content).height / 2,
        hint: [...form.querySelectorAll(".project-talk-hint")].filter((el) => el.getBoundingClientRect().height > 0).length };
    });
    assert.equal(field.shape, "line", `empty, the field is one line: ${JSON.stringify(field)}`);
    if (run.phone) {
      for (const part of ["plus", "send", "content"]) assert.ok(Math.abs(field[part] - 44) <= 1, `${part} is 44 px: ${JSON.stringify(field)}`);
      assert.ok(Math.abs(field.textMid - field.lineMid) <= 2, `the text is centred in its line: ${JSON.stringify(field)}`);
      assert.equal(field.hint, 0, "a phone hides the hint");
    } else assert.equal(field.hint, 1, "the hint under the field where there is room");
    await shot(page, "dock", page.locator(".home-dock"));
    pass("the field's line, its controls and its hint", field);

    // A follow-up from a request: its tag above the field; what is written and the tag stay after a reload.
    await page.evaluate(() => (document.querySelector(".home-view").scrollTop = 0));
    if (narrow) await page.locator('.project-talk-tabs [data-tab="requests"]').click();
    await page.locator('.request-card[data-request="5"]').getByRole("button", { name: new RegExp(w.followUp) }).first().click();
    const quoting = page.locator(".home-dock .project-talk-quoting");
    await quoting.waitFor({ timeout: 5000 });
    assert.match(await quoting.innerText(), new RegExp(R5));
    await page.locator(".home-dock [data-composer-input]").first().click();
    await page.keyboard.type("补充一句");
    await page.waitForFunction(([key, slot]) => JSON.parse(localStorage.getItem(key) ?? "{}")[slot]?.text === "补充一句", [DRAFTS, SLOT], { timeout: 5000 });
    await open(page, true);
    await page.locator(".home-dock .project-talk-quoting").waitFor({ timeout: 5000 });
    const kept = await page.evaluate(() => ({
      quote: document.querySelector(".home-dock .project-talk-quoting")?.textContent ?? "",
      text: document.querySelector(".home-dock .cm-content")?.textContent ?? "",
      tone: getComputedStyle(document.querySelector(".home-dock .project-talk-quoting")).backgroundColor,
    }));
    assert.ok(kept.quote.includes(R5) && kept.text.includes("补充一句"), `kept after a reload: ${JSON.stringify(kept)}`);
    assert.notEqual(kept.tone, "rgba(0, 0, 0, 0)", "the tag has its amber ground");
    pass("a follow-up's tag and words stay after a reload", kept);

    // A keyboard: the shell is the visible height, the dock rides on it, and the request followed up stays in view.
    if (run.phone) {
      await page.locator(".home-dock [data-composer-input]").first().click();
      await page.evaluate((keyboard) => {
        // keyboard-viewport.ts clears its marks on focus where no keyboard is up: set them as it would with one.
        const root = document.documentElement;
        root.style.setProperty("--visual-height", `${innerHeight - keyboard}px`);
        root.setAttribute("data-keyboard", "");
      }, KEYBOARD);
      await page.waitForTimeout(700);
      const up = await page.evaluate((n) => {
        const view = document.querySelector(".home-view").getBoundingClientRect();
        const dock = document.querySelector(".home-dock").getBoundingClientRect();
        const main = document.querySelector(".main-panel").getBoundingClientRect();
        const target = [...document.querySelectorAll(`.request-card[data-request="${n}"], .project-talk-mine[data-words="${n}"]`)]
          .find((el) => el.getBoundingClientRect().height > 0) ?? document.querySelector(".project-talk");
        const box = target.getBoundingClientRect();
        return { dockBottom: dock.bottom, dockTop: dock.top, mainBottom: main.bottom, viewTop: view.top, viewBottom: view.bottom, target: target.className,
          targetTop: box.top, targetBottom: box.bottom, visible: innerHeight };
      }, 5);
      assert.ok(Math.abs(up.dockBottom - (run.viewport.height - KEYBOARD)) <= 1, `the dock rides on the keyboard: ${JSON.stringify(up)}`);
      assert.ok(up.targetBottom > up.viewTop && up.targetTop < up.viewBottom && up.viewBottom <= up.dockTop + 0.5,
        `the request followed up is in view above the dock: ${JSON.stringify(up)}`);
      await shot(page, "keyboard");
      pass("with a keyboard the dock is above it and the request followed up in view", up);
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("--visual-height");
        document.documentElement.removeAttribute("data-keyboard");
      });
    }

    // The conversation opens at its newest.
    if (narrow) await page.locator('.project-talk-tabs [data-tab="chat"]').click();
    await page.waitForTimeout(300);
    const chat = await page.evaluate(() => {
      const scroller = document.querySelector(".project-talk-chat .project-talk-scroll");
      return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
    });
    assert.ok(chat.height - chat.top - chat.client <= 2, `the conversation is at its newest: ${JSON.stringify(chat)}`);
    pass("the conversation opens at its newest", chat);
  } finally {
    await page.close();
  }

  // An image and a file attached to a follow-up: under its words in the dock, and still there after a reload.
  const attached = await context.newPage();
  await attached.addInitScript(([key, slot, image, file]) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(key, JSON.stringify({ [slot]: { text: "见截图和日志", quote: 5, at: new Date().toISOString(),
      images: [{ id: image, agentId: "", name: "plan.png", bytes: 1024, width: 8, height: 8 }], files: [{ id: file, name: "check.log", bytes: 2048 }] } }));
  }, [DRAFTS, SLOT, `${"a".repeat(64)}.png`, "b".repeat(64)]);
  try {
    for (const pass_ of ["first", "reload"]) {
      await open(attached, pass_ === "reload");
      await attached.locator(".home-dock .input-image").first().waitFor({ timeout: 5000 });
      const shown = await attached.evaluate(() => ({
        images: document.querySelectorAll(".home-dock .input-image").length,
        files: document.querySelectorAll(".home-dock .input-file").length,
        quote: !!document.querySelector(".home-dock .project-talk-quoting"),
        shape: document.querySelector(".home-dock .home-composer")?.dataset.shape,
        overlap: Math.max(0, document.querySelector(".home-view").getBoundingClientRect().bottom - document.querySelector(".home-dock").getBoundingClientRect().top),
      }));
      assert.deepEqual([shown.images, shown.files, shown.quote, shown.overlap], [1, 1, true, 0], `${pass_}: ${JSON.stringify(shown)}`);
      if (pass_ === "first") await shot(attached, "attached", attached.locator(".home-dock"));
      pass(`an image and a file in the dock (${pass_})`, shown);
    }
  } finally {
    await attached.close();
    await context.close();
  }
}
