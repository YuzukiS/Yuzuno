// YN-208 in Chromium, every API answered here (no Core, no daily data),
// through the production build, on a Project's page: what each card of a
// request delivered, opened from the request (YN-212: from its block on the
// page read by request, under the block's fact).
//  - R-9 is shaped like R-18: its review's report is out while the release
//    it asked for goes on; one click opens the report at the version named,
//    and the page's Back returns to the project, the request and the button;
//  - from the Done fold, a replaced report opens its same report's version
//    Home keeps, and Back finds the fold still open and the button focused;
//  - an older request, read from the requests side, opens its report kept in
//    History, and Back returns to it;
//  - a short answer reads whole on a phone; PRs say when GitHub was read;
//    a release says Core did not check it;
//  - at 1440 and 390, English and Chinese, nothing is wider than its column;
//  - nothing is written but the report page's own opened mark: opening a
//    deliverable never confirms its request.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-deliverables-check.mjs
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
const report = { task: "YN-208", runs: [], unexpected: [], errors: [], writes: [] };
const HOST = "localhost:47399";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "r", name: "YN-97 · 发布", kind: "executor", status: "working",
    executor: { state: "running", agentId: "r", task: { id: "YN-97", title: "Release the next Core", shortName: "发布下一版" }, dispatchedAt: at(50) } },
];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "lead-1", state: "active" };
const desk = { agentId: "l", name: "lead-1" };
const releaser = { agentId: "r", name: agents[1].name, kind: "executor", state: "running" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (text) => ({ root: "body", elements: { body: node("BriefBody", { summary: { lead: "a" } }, ["a"]), a: node("Markdown", { text }) } });
const section = (id, key, title, version, extra = {}) => ({ id, key, kind: "report", title, version, owner: lead, updatedAt: at(70), updatedTurnId: "t1",
  body: spec(`${title}：正文。`), attachments: [], refs: {}, seen: null, history: false, ...extra });
const ANSWER = "默认是 JSON；设置 → 导出里可以改成 CSV 或 Markdown，每个项目各记各的选择，换设备也一样。";
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 2, missing: [],
    brief: {
      version: 30,
      sections: [section(518, "audit-review", "Atlas 深度审查", 2), section(505, "export-formats", "导出格式比较（修订）", 3)],
      history: [section(400, "older-review", "更早的审查", 4, { history: true, historyReason: "seen" })],
    },
  }],
});
const route = (n, index, task, cardKey, sectionId, title) =>
  ({ kind: "card", index, request: n, at: at(400 - n), state: "done", why: "有明确终点", by: desk, to: desk, task, cardKey, sectionId, title });
const card = (sectionId, key, title, task, responsible, extra) =>
  ({ sectionId, key, title, live: task.status === "doing", task: { ...task, archived: false }, responsible, ...extra });
const result = (id, minutes, status = "done") => ({ id, status, reportedAt: at(minutes) });
const delivered = (resultId, minutes, items) => ({ resultId, reportedAt: at(minutes), items });
const request = (n, title, minutes, state, cards, extra = {}) => ({
  id: `r${n}`, n, text: `（第 ${n} 条需求的原话）`, textBlocks: null, images: [], files: [], title, createdAt: at(minutes), frontAgentId: "l",
  messageId: `m${n}`, delivery: "accepted", replies: [], notes: [{ note: "好，开卡。", by: desk, at: at(minutes - 1) }],
  routes: cards.map((c, i) => route(n, i, c.task.id, c.key, c.sectionId, c.title)), cards, state,
  progress: { cards: cards.length, ended: cards.filter((c) => c.task.status !== "doing").length }, lines: [], ...extra,
});
const newest = () => [
  request(9, "审查架构、性能与界面可读性，之后发布下一版", 240, "doing", [
    card(516, "yn-96", "架构、性能与界面可读性审查", { id: "YN-96", status: "done" }, null, {
      result: result("res-96", 70),
      deliverables: delivered("res-96", 70, [{ kind: "report", title: "Atlas 深度审查", note: "六项改进，按证据与验收排好顺序",
        key: "audit-review", version: 2, sectionId: 518, state: "live", currentVersion: 2 }]),
    }),
    card(530, "yn-97", "合入后发布下一版 Core", { id: "YN-97", status: "doing" }, releaser, { result: null, deliverables: null }),
  ]),
  request(8, "导出 Markdown，顺便把导出按钮挪到工具栏", 300, "ended", [
    card(512, "yn-94", "导出 Markdown", { id: "YN-94", status: "done" }, null, {
      result: result("res-94", 120, "review"),
      deliverables: delivered("res-94", 120, [
        { kind: "pr", title: "[YN-94] feat(web): 导出 Markdown", note: "表格、标题层级和代码块都保留", url: "https://github.com/example/atlas/pull/1081",
          repository: "example/atlas", number: 1081, state: "merged", observedAt: at(90) },
        { kind: "release", title: "Atlas 0.9.0", note: null, url: "https://github.com/example/atlas/releases/tag/v0.9.0", repository: "example/atlas", tag: "v0.9.0" },
      ]),
    }),
    card(513, "yn-95", "导出按钮挪到工具栏", { id: "YN-95", status: "cancelled" }, null, { result: null, deliverables: null }),
    card(514, "yn-93", "导出设置的默认值", { id: "YN-93", status: "done" }, null, { result: result("res-93", 130), deliverables: null }),
  ]),
  request(7, "比较三种导出格式", 2_000, "done", [
    card(605, "yn-90", "导出格式调研", { id: "YN-90", status: "done" }, null, {
      result: result("res-90", 1_900),
      deliverables: delivered("res-90", 1_900, [{ kind: "report", title: "导出格式比较", note: "CSV 与 Markdown 都要", key: "export-formats", version: 2,
        sectionId: 505, state: "replaced", currentVersion: 3 }]),
    }),
  ], { confirmedAt: at(1_800) }),
  request(6, "备份为什么慢", 60_000, "done", [
    card(580, "yn-81", "备份耗时调查", { id: "YN-81", status: "done" }, null, {
      result: result("res-81", 59_000),
      deliverables: delivered("res-81", 59_000, [{ kind: "report", title: "备份耗时调查", note: "瓶颈在逐个文件做 fsync", key: "backup-time", version: 1,
        sectionId: 480, state: "gone", currentVersion: null }]),
    }),
  ], { confirmedAt: at(58_000) }),
  request(5, "现在默认的导出格式是什么", 70_000, "done", [
    card(570, "yn-80", "确认默认导出格式", { id: "YN-80", status: "done" }, null, {
      result: result("res-80", 69_000), deliverables: delivered("res-80", 69_000, [{ kind: "answer", title: null, text: ANSWER }]),
    }),
  ], { confirmedAt: at(68_000) }),
];
const older = () => [
  request(3, "更早的一次审查", 90_000, "done", [
    card(600, "yn-70", "更早的审查", { id: "YN-70", status: "done" }, null, {
      result: result("res-70", 89_000),
      deliverables: delivered("res-70", 89_000, [{ kind: "report", title: "更早的审查", note: null, key: "older-review", version: 4,
        sectionId: 400, state: "history", currentVersion: 4 }]),
    }),
  ], { confirmedAt: at(88_000) }),
];
const words = {
  en: { older: "Read older requests", done: /^Done \d+$/ },
  "zh-Hans": { older: "读更早的请求", done: /^已完成 \d+$/ },
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "zh-1440", viewport: { width: 1440, height: 1000 }, language: "zh-Hans" },
  { name: "en-1440", viewport: { width: 1440, height: 1000 }, language: "en" },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", phone: true },
  { name: "en-390", viewport: { width: 390, height: 844 }, language: "en", phone: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "request-deliverables-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.ok(report.writes.every((write) => write.path === "/api/projects/p-dev/brief/opened"), `only the report page's opened mark: ${JSON.stringify(report.writes)}`);
console.log(`request-deliverables-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

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
    // The requests side alone, so a phone shows the requests without a tab to choose.
    localStorage.setItem("yuzuno.projectTalkView.ws-talk.p-dev", JSON.stringify("requests"));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-talk" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests" && method === "GET")
      return route.fulfill({ json: url.searchParams.get("before") ? { requests: older(), hasMore: false } : { requests: newest(), hasMore: true } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      report.writes.push({ run: run.name, method, path });
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      if (path === "/api/projects/p-dev/brief/opened") return route.fulfill({ json: { recorded: true } });
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
  const requestCard = (n) => page.locator(`[data-request-block="${n}"]`);
  const shot = async (name, locator) => {
    const file = `${run.name}-${name}.png`;
    await page.mouse.move(1, 1);
    await locator.screenshot({ path: join(output, file), animations: "disabled" });
    result.shots.push(file);
  };
  const focused = (selector) => page.evaluate((selector) => !!document.activeElement?.matches(selector), selector);
  // Opens the deliverable, checks the report page's address, and goes Back with the page's own Back.
  const openAndBack = async (button, hash) => {
    await button.click();
    await page.waitForFunction((hash) => location.hash === hash, hash, { timeout: 10_000 });
    await page.locator(".report-back").waitFor({ timeout: 10_000 });
    await page.locator(".report-back").click();
    await page.waitForFunction(() => location.hash.startsWith("#/home"), null, { timeout: 10_000 });
    await page.waitForTimeout(300);
  };
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-talk&p=p-dev`);
    await requestCard(9).waitFor({ timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);

    // Nothing wider than its column; an answer whole, wrapped.
    const fold = page.locator(".request-done > summary");
    await fold.click();
    await requestCard(5).waitFor();
    const fit = await page.evaluate(() => {
      const out = { over: [], cut: [] };
      const side = document.querySelector(".request-blocks");
      const frame = document.querySelector(".home-view").getBoundingClientRect();
      for (const el of side.querySelectorAll(".request-block, .request-deliverable, .request-deliverables-none")) {
        const box = el.getBoundingClientRect();
        if (box.width && (box.right > frame.right + 1 || box.left < frame.left - 1)) out.over.push({ el: el.className, right: box.right, frame: frame.right });
      }
      const answer = side.querySelector('.request-deliverable[data-kind="answer"] .request-deliverable-title');
      out.answer = { text: answer.textContent, cut: answer.scrollWidth > answer.clientWidth + 1, height: answer.getBoundingClientRect().height };
      return out;
    });
    assert.deepEqual(fit.over, [], "everything inside its column");
    assert.equal(fit.answer.text, ANSWER, "the answer whole");
    assert.ok(!fit.answer.cut, "the answer wraps, never cut");
    for (const n of [9, 8, 7, 6, 5]) await shot(`r${n}`, requestCard(n));
    pass("every deliverable fits its column; the answer reads whole", { answer: fit.answer });

    // R-9, as R-18: the review's report opens at version 2 while the release goes on; Back returns to its button.
    const review = requestCard(9).locator('.request-deliverable[data-kind="report"]');
    assert.equal(await requestCard(9).locator(".request-deliverable").count(), 1, "the release names nothing yet");
    await openAndBack(review, "#/report?w=ws-talk&p=p-dev&k=audit-review&v=2&s=518");
    assert.ok(await focused('[data-request-block="9"] .request-deliverable[data-kind="report"]'), "Back focuses the button that opened it");
    pass("R-9's report opens at the version named, and Back returns to its button");

    // R-7 in the Done fold: replaced, so its same report's version Home keeps opens; the fold stays open.
    const replaced = requestCard(7).locator('.request-deliverable[data-kind="report"]');
    await openAndBack(replaced, "#/report?w=ws-talk&p=p-dev&k=export-formats&v=3&s=505");
    assert.equal(await page.locator(".request-done").getAttribute("open"), "", "the Done fold is still open");
    assert.ok(await focused('[data-request-block="7"] .request-deliverable'), "Back focuses the button in the fold");
    pass("a replaced report opens its kept version from the Done fold, and Back returns there");

    // An older request, read from the requests side: its report in History opens, and Back returns to it.
    await page.locator(".project-talk-earlier", { hasText: w.older }).click();
    await requestCard(3).waitFor({ timeout: 10_000 });
    const old = requestCard(3).locator('.request-deliverable[data-kind="report"]');
    await old.scrollIntoViewIfNeeded();
    await openAndBack(old, "#/report?w=ws-talk&p=p-dev&k=older-review&v=4&s=400");
    assert.ok(await focused('[data-request-block="3"] .request-deliverable'), "Back focuses the older request's button");
    await shot("r3", requestCard(3));
    pass("an older request's report, in History, opens from it and Back returns to it");

    // PR and release lines say what Core knows, and no more.
    const pr = await requestCard(8).locator('.request-deliverable[data-kind="pr"]').innerText();
    const release = await requestCard(8).locator('.request-deliverable[data-kind="release"]').innerText();
    assert.match(pr, run.language === "en" ? /merged · as of 2 h ago/ : /已合并 · 截至2 小时前/);
    assert.match(release, run.language === "en" ? /not checked by Core/ : /Core 未核对/);
    pass("a PR says when GitHub was read; a release says Core did not check it", { pr, release });
  } finally {
    await context.close();
  }
}
