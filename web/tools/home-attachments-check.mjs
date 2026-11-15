// YN-134 S3 in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, on a Project's page, at 1440
// and a phone (390), in English and Chinese:
//  - "Talk to the project"'s field has "+" inside its box at the bottom left;
//    its menu (Add images, Mark up an image) opens over the conversation,
//    whole: nothing clips or covers an item; on a phone "+" and each item are
//    at least 44px high;
//  - images chosen are saved to the project's images and shown under the
//    text; eight wrap inside the box, and nothing is wider than the window;
//  - Point & Fix on a thumbnail opens with no Agent to choose, says where it
//    adds, and adds the annotated copy and the notes to the field;
//  - the request sends its eight images' IDs; images a request took show in
//    its bubble, inside the conversation.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-attachments-check.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-134", slice: "S3", runs: [], sent: [], unexpected: [], errors: [] };
const HOST = "localhost:47397";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev", kind: "lead",
};
const agents = [{ ...base, id: "l", name: "lead-1" }];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { chat: "Conversation", plus: "Add", items: ["Add images", "Mark up an image"], choose: "Choose images", markUp: (n) => `Mark up image ${n}`,
    addsTo: "Adds to: Talk to Atlas dev", add: "Add" },
  "zh-Hans": { chat: "对话", plus: "添加", items: ["添加图片", "标注图片"], choose: "选择图片", markUp: (n) => `标注图片 ${n}`,
    addsTo: "加到：对 Atlas dev 说", add: "加入" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
// Real PNGs, each its own colour, so each is its own content-addressed image: drawn by this browser.
const pngs = [];
{
  const painter = await browser.newPage({ viewport: { width: 160, height: 100 } });
  for (let i = 0; i < 9; i++) {
    await painter.setContent(`<body style="margin:0"><div style="width:160px;height:100px;background:linear-gradient(135deg,hsl(${i * 40} 45% 55%),hsl(${i * 40 + 30} 60% 85%))"></div></body>`);
    pngs.push(await painter.screenshot({ type: "png" }));
  }
  await painter.close();
}
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
// What the project's images hold: two from requests sent before, and what each run saves.
const SENT = [`${sha(pngs[8])}.png`];
const requests = () => [
  { id: "r5", n: 5, text: "首页的项目卡在手机上溢出了，见图。", textBlocks: null, images: SENT, title: "手机上项目卡溢出", createdAt: at(30),
    frontAgentId: "l", messageId: "m5", delivery: "accepted", replies: [], notes: [{ note: "好，开一张卡。", by: { agentId: "l", name: "lead-1" }, at: at(29) }],
    routes: [], cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] },
];

const runs = [
  { name: "en-1440", viewport: { width: 1440, height: 1000 }, language: "en" },
  { name: "zh-1440", viewport: { width: 1440, height: 1000 }, language: "zh-Hans" },
  { name: "en-390", viewport: { width: 390, height: 844 }, language: "en", phone: true },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", phone: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-attachments-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`home-attachments-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const stored = new Map([[SENT[0], pngs[8]]]);
  const posts = [];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-img" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests" && method === "GET") return route.fulfill({ json: { requests: requests(), hasMore: false } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    // The project's images (S1): content-addressed, read back by ID, the thumbnail as the image itself here.
    if (path === "/api/projects/p-dev/images" && method === "POST") {
      const body = request.postDataBuffer();
      const id = `${sha(body)}.png`;
      stored.set(id, body);
      return route.fulfill({ json: { id, ...pngSize(body), bytes: body.length } });
    }
    const image = path.match(/^\/api\/projects\/p-dev\/images\/([0-9a-f]{64}\.png)$/);
    if (image && stored.has(image[1])) return route.fulfill({ body: stored.get(image[1]), contentType: "image/png" });
    if (path === "/api/projects/p-dev/requests" && method === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      return route.fulfill({ json: { request: { n: 6 }, receipt: { input: { text: body.text, clientMessageId: body.clientMessageId }, status: "accepted", turnId: "t1", error: null } } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.unexpected.push(`${method} ${path}`);
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
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const compose = page.locator(".project-talk-compose");
  const box = page.locator(".project-talk-field .home-composer");
  const thumbs = box.locator(".input-image");
  const shot = async (name, locator) => {
    const file = `${run.name}-${name}.png`;
    await (locator ?? page).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const choose = (files) =>
    page.setInputFiles(`.project-talk-field input[aria-label="${w.choose}"]`, files.map((i) => ({ name: `shot-${i + 1}.png`, mimeType: "image/png", buffer: pngs[i] })));
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-img&p=p-dev`);
    await page.locator('[data-project-home="p-dev"]').waitFor({ timeout: 15_000 });
    await page.locator('.request-card[data-request="5"]').waitFor({ timeout: 15_000 });
    if (run.phone) await page.locator(".project-talk-tabs [role=tab]").filter({ hasText: w.chat }).first().click();
    await compose.scrollIntoViewIfNeeded();

    // "+" inside the box, at its bottom left.
    const plus = box.locator(".composer-plus");
    const place = await page.evaluate(() => {
      const frame = document.querySelector(".project-talk-field .home-composer").getBoundingClientRect();
      const plus = document.querySelector(".project-talk-field .composer-plus").getBoundingClientRect();
      return { left: plus.left - frame.left, bottom: frame.bottom - plus.bottom, inside: plus.left >= frame.left && plus.right <= frame.right && plus.top >= frame.top && plus.bottom <= frame.bottom + 0.5,
        width: plus.width, height: plus.height };
    });
    assert.ok(place.inside && place.left <= 12 && place.bottom <= 8, `"+" at the box's bottom left: ${JSON.stringify(place)}`);
    if (run.phone) assert.ok(place.height >= 44 && place.width >= 44, `"+" at least 44px on a phone: ${JSON.stringify(place)}`);
    pass(`"+" sits inside the box at its bottom left`, place);

    // Its menu, whole: every item is what the page shows at its centre, inside the window.
    await plus.click();
    const menu = page.locator(".composer-add-menu");
    await menu.waitFor();
    const items = await page.evaluate(() => [...document.querySelectorAll(".composer-add-menu [role=menuitem]")].map((item) => {
      const r = item.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { label: item.getAttribute("aria-label"), height: r.height, shown: item.contains(top), inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    }));
    assert.deepEqual(items.map((i) => i.label), w.items);
    assert.ok(items.every((i) => i.shown && i.inWindow), `the menu is whole, nothing clips or covers it: ${JSON.stringify(items)}`);
    if (run.phone) assert.ok(items.every((i) => i.height >= 44), `items at least 44px on a phone: ${JSON.stringify(items)}`);
    await shot("menu", run.phone ? page : page.locator(".project-talk"));
    pass("the menu opens whole over the conversation", { items });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    // Three images chosen, then Point & Fix on the first: no Agent, where it adds, the annotated copy and notes added.
    await page.locator(".project-talk-field [data-composer-input]").fill(run.language === "en" ? "The project card overflows on a phone:" : "手机上项目卡溢出了：");
    await choose([0, 1, 2]);
    await thumbs.nth(2).waitFor();
    await box.locator(`button[aria-label="${w.markUp(1)}"]`).click();
    const dialog = page.locator(".point-fix-dialog");
    await dialog.locator(".point-fix-image svg").waitFor({ timeout: 10_000 });
    assert.equal(await dialog.locator("select").count(), 0, "no Agent to choose");
    assert.equal((await dialog.locator(".point-fix-target").innerText()).trim(), w.addsTo);
    await dialog.getByRole("button", { name: "Add area" }).click();
    await dialog.locator('[aria-label="Area 1 comment"]').fill(run.language === "en" ? "The card runs past the edge" : "卡片超出了屏幕边缘");
    await shot("pointfix", dialog);
    await dialog.getByRole("button", { name: w.add, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await thumbs.nth(3).waitFor();
    const text = await page.locator(".project-talk-field [data-composer-input]").innerText();
    assert.match(text, /Point & Fix feedback on “shot-1\.png”/);
    assert.match(text, /the original is attached image 1/);
    pass("Point & Fix adds the annotated copy and its notes to the field, with no Agent to choose", { thumbs: await thumbs.count() });

    // Eight in all: they wrap inside the box, and nothing is wider than the window.
    await choose([3, 4, 5, 6]);
    await thumbs.nth(7).waitFor();
    const fit = await page.evaluate(() => {
      const frame = document.querySelector(".project-talk-field .home-composer").getBoundingClientRect();
      const tops = new Set();
      const outside = [];
      for (const thumb of document.querySelectorAll(".project-talk-field .input-image")) {
        const r = thumb.getBoundingClientRect();
        tops.add(Math.round(r.top));
        if (r.left < frame.left - 0.5 || r.right > frame.right + 0.5) outside.push(Math.round(r.right));
      }
      return { page: document.scrollingElement.scrollWidth, window: innerWidth, view: document.querySelector(".home-view")?.scrollWidth ?? 0, rows: tops.size, outside,
        chat: (() => { const s = document.querySelector(".project-talk-chat .project-talk-scroll"); return { scroll: s.scrollWidth, client: s.clientWidth }; })() };
    });
    assert.ok(fit.page <= fit.window + 1 && fit.view <= fit.window + 1, `nothing wider than the window: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.outside, [], `thumbnails inside the box: ${JSON.stringify(fit)}`);
    if (run.phone) assert.ok(fit.rows >= 2, `eight wrap on a phone: ${JSON.stringify(fit)}`);
    await compose.scrollIntoViewIfNeeded();
    await shot("eight", compose);
    pass("eight images wrap inside the box, nothing wider than the window", fit);

    // Sent: their IDs with the words; the request sent before shows its image in its bubble.
    await page.locator(".project-talk-send").click();
    await page.waitForFunction(() => !document.querySelector(".project-talk-field .input-image"), null, { timeout: 10_000 });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].images.length, 8);
    assert.ok(posts[0].images.every((id) => stored.has(id)), "the IDs the project's images gave");
    report.sent.push({ run: run.name, images: posts[0].images.length, text: posts[0].text.slice(0, 40) });
    const bubble = page.locator('.project-talk-mine[data-words="5"] .project-talk-bubble');
    await bubble.locator(".input-image img").first().waitFor();
    const inside = await bubble.evaluate((el) => {
      const frame = el.getBoundingClientRect();
      const img = el.querySelector(".input-image").getBoundingClientRect();
      return { inside: img.left >= frame.left && img.right <= frame.right && img.bottom <= frame.bottom + 0.5, loaded: el.querySelector(".input-image img").naturalWidth > 0 };
    });
    assert.ok(inside.inside && inside.loaded, `a sent image inside its bubble: ${JSON.stringify(inside)}`);
    await shot("thread", page.locator(".project-talk-chat"));
    pass("the request sends its eight images' IDs; a sent image shows in its bubble", { sent: posts[0].images.length, inside });
  } finally {
    await context.close();
  }
}
