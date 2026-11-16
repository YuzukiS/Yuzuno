// YN-195 in Chromium, every API answered here (no Core, no daily
// configuration), through the production build: a report whose body is one
// Markdown block over the advice length (BRIEF_LIMITS.advice.markdownChars),
// on its report page, at 1440 and on a phone (390), English and Chinese:
//  - it opens folded: its heading-less first paragraph shown, the rest behind
//    "Show all · N more characters" ("展开全文 · 还有 N 字"), the body short;
//  - Show all opens the whole text in place, nothing wider than the window,
//    and the control then says it closes again;
//  - window.find for a word in the folded part is recorded, not asserted:
//    the browser's own find bar opening a closed <details> is Chromium's,
//    which a script's find may not share;
//  - nothing is sent but the reads.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/brief-markdown-fold-check.mjs
import assert from "node:assert/strict";
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
const report = { task: "YN-195", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47399";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "claude", model: "synthetic", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
const agents = [{ ...base, id: "l", name: "lead-1", kind: "lead" }];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "lead-1", state: "active" };
// Synthetic content: a conclusion first, then the detail an Agent wrote around it.
const FIRST = "新电脑上的每日备份已经配好：每天 02:00 把工作区备份到外置硬盘，保留 30 天。还差一件事要你定：口令要不要存进系统钥匙串。";
const STEPS = 20;
const steps = Array.from({ length: STEPS }, (_, i) =>
  `${i + 1}. 第 ${i + 1} 步做了什么、为什么这样做，以及之后要注意的地方，写得和 Agent 平时一样长，好让这一块超过建议的长度。`).join("\n");
const TEXT = `${FIRST}\n\n## 做了什么\n\n${steps}\n\n## 恢复演练记录\n\n昨晚从三天前的备份里完整恢复了一次工作区，校验和全部一致。`;
// Over BRIEF_LIMITS.advice.markdownChars (1200 code points), where Home starts to fold and Core to advise.
assert.ok([...TEXT].length > 1200, `the text is long enough: ${[...TEXT].length}`);
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const section = {
  id: 501, key: "backup-setup", kind: "report", title: "新电脑的每日备份已配好（合成示例）", version: 2, owner: lead,
  updatedAt: at(30), updatedTurnId: "t1", attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: node("BriefBody", {}, ["note"]), note: node("Markdown", { text: TEXT }) } },
};
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 9, history: [], sections: [section] },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { more: /^Show all · \d+ more characters$/, less: "Show less" },
  "zh-Hans": { more: /^展开全文 · 还有 \d+ 字$/, less: "收起" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
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
  await writeFile(join(output, "brief-markdown-fold-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts.filter((post) => !post.path.endsWith("/brief/opened")), [], "nothing but reads, and the page's own opened mark");
console.log(`brief-markdown-fold-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-fold" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests" && method === "GET") return route.fulfill({ json: { requests: [], hasMore: false } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ json: { recorded: false } });
    }
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  const shot = async (name) => {
    const file = `${run.name}-${name}.png`;
    await page.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const read = () => page.evaluate(() => {
    const fold = document.querySelector(".brief-markdown-fold");
    const more = fold?.querySelector("details.brief-markdown-more");
    const body = document.querySelector(".brief-body")?.getBoundingClientRect();
    const items = [...document.querySelectorAll(".brief-markdown li")];
    return {
      folded: !!fold, open: more?.open ?? null, summary: more?.querySelector("summary")?.textContent ?? null,
      lead: fold?.querySelector(":scope > .brief-markdown")?.textContent.trim() ?? null,
      body: body ? Math.round(body.height) : null, items: items.length,
      // A closed <details> keeps its content laid out, so ask whether it is rendered, not whether it has boxes.
      shown: items.filter((li) => li.checkVisibility()).length,
      page: document.scrollingElement.scrollWidth, window: innerWidth,
    };
  });
  try {
    await page.goto(`http://${HOST}/#/report?w=ws-fold&p=p-dev&k=backup-setup&v=2&s=501`);
    await page.locator(".brief-markdown").first().waitFor({ timeout: 15_000 });
    const folded = await read();
    assert.ok(folded.folded && folded.open === false, `folded: ${JSON.stringify(folded)}`);
    assert.equal(folded.lead, FIRST, "its first paragraph, whole");
    assert.match(folded.summary, w.more);
    assert.ok(folded.items === STEPS && folded.shown === 0, `the rest behind Show all: ${JSON.stringify(folded)}`);
    assert.ok(folded.body < 260 && folded.page <= folded.window + 1, `short, and no wider than the window: ${JSON.stringify(folded)}`);
    await shot("folded");
    pass("opens folded after its first paragraph", folded);

    await page.locator(".brief-markdown-more > summary").click();
    await page.waitForFunction((less) => document.querySelector(".brief-markdown-more > summary")?.textContent === less, w.less, { timeout: 5000 });
    const open = await read();
    assert.ok(open.open && open.shown === STEPS && open.body > folded.body * 3 && open.page <= open.window + 1, `opened whole: ${JSON.stringify(open)}`);
    await shot("open");
    pass("Show all opens the whole text in place, and then says it closes", open);

    await page.locator(".brief-markdown-more > summary").click();
    await page.waitForFunction(() => document.querySelector(".brief-markdown-more")?.open === false, null, { timeout: 5000 });
    const found = await page.evaluate(() => {
      const hit = typeof window.find === "function" && window.find("恢复演练记录");
      return { found: !!hit, opened: document.querySelector(".brief-markdown-more")?.open ?? null };
    });
    result.find = found;
    pass("window.find on the folded text, recorded", found);
  } finally {
    await context.close();
  }
}
