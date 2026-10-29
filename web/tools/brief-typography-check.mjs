// A Home card's writing has levels again (T-9): an Agent's h1, h2 and h3 are
// three visible steps, a block's title stands above the body it introduces,
// and emphasis reads in Chinese. Measured in a real browser on the production
// bundle, desktop and 320 px, light and dark, in both densities. No Core, no
// Agent; nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> node tools/brief-typography-check.mjs
//   YUZUNO_BASELINE=1 ... records what a build draws today without asserting,
//   for the before picture of a build that does not have the fix.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = !!process.env.YUZUNO_BASELINE;
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || `../acceptance/brief-typography${baseline ? "/before" : "/after"}`);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-brief-typography.test";
const report = { task: "T-9", mode: baseline ? "before" : "after", checks: [], measured: [], writes: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "森", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno 应用", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "森", state: "active" };
const node = (type, props, children = []) => ({ type, props, children });
/** `children` are the body's own blocks; `extra` holds blocks a group of
 *  them refers to, which the body must not list again. */
const spec = (children, extra = {}) => ({
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: children.map(([key]) => key) },
    ...Object.fromEntries(children),
    ...extra,
  },
});
const section = (key, title, body, extra = {}) => ({
  key, kind: "report", title, version: 3, owner, updatedAt: iso(-20 * MIN), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false, body, ...extra,
});

// The card the user was looking at: a group title, written paragraphs, and
// figures beside them.
const progress = section("development", "当前进展", spec([
  ["lead", node("Markdown", { text: "本轮把工具活动改成胶囊行，并让每张问题卡都能用自己的话回答。两项都已合并，**尚未部署到你的 Core**。" })],
  ["round", node("Group", { title: "本轮进展" }, ["round-text", "round-metrics"])],
], {
  "round-text": node("Markdown", { text: [
    "# 交付概览",
    "",
    "两条线同时推进，合并顺序由 Dev 9 的队列决定。",
    "",
    "## 已合并",
    "",
    "工具活动胶囊（#402）与问题卡文字入口（#408）都通过了独立审查与 CI。**合并不等于已经在你的 Core 上运行。**",
    "",
    "### 仍在队列里",
    "",
    "Home 两档密度（#405）已验收，等待组合核验；*我的组件* 仍是草稿。",
  ].join("\n") }),
  "round-metrics": node("Metrics", { items: [
    { label: "已合并", value: 3, previous: 1 },
    { label: "待审查", value: 2, previous: 3 },
    { label: "CI 通过率", value: 0.98, previous: 0.95 },
  ] }),
}));
// Every level at once, so one picture shows whether they differ.
const sample = section("typography", "字体层级小样", spec([
  ["sample", node("Markdown", { text: [
    "# 一级标题 · Heading 1",
    "",
    "正文：这一段是普通段落，用来和标题比较。英文 body text for comparison。",
    "",
    "## 二级标题 · Heading 2",
    "",
    "正文里有**加粗的中文**与 **bold English**，还有*强调的中文*与 *emphasised English*。",
    "",
    "### 三级标题 · Heading 3",
    "",
    "- 列表项：短行文字",
    "- 列表项：`行内代码` 与普通文字",
    "",
    "最后一段正文，收尾。",
  ].join("\n") })],
]));
const sections = [progress, sample];
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno 应用" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: 12, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme, density }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([theme, density]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
    localStorage.setItem("yuzuno.homeDensity.ws", JSON.stringify(density));
  }, [theme, density]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    // Home marks what the reader saw; nothing else may be sent from here.
    if (route.request().method() !== "GET") {
      report.writes.push({ path, body: JSON.parse(route.request().postData() || "{}") });
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci/runs") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`https://${HOST}/`);
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  await page.locator('[data-section-key="typography"]').first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const px = (value) => Math.round(parseFloat(value) * 100) / 100;
/** What each level is actually drawn at, in the sample card. */
const levels = (page) =>
  page.locator('[data-section-key="typography"]').first().evaluate((card) => {
    const of = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight), color: style.color };
    };
    const markdown = card.querySelector(".brief-markdown");
    return {
      h1: of(markdown.querySelector("h1")),
      h2: of(markdown.querySelector("h2")),
      h3: of(markdown.querySelector("h3")),
      body: of(markdown.querySelector("p")),
      strong: of(markdown.querySelector("strong")),
      em: of(markdown.querySelector("em")),
      code: of(markdown.querySelector("code")),
    };
  });
/** The group title of the progress card, beside the body under it. */
const groupTitle = (page) =>
  page.locator('[data-section-key="development"]').first().evaluate((card) => {
    const of = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight), text: el.textContent };
    };
    return {
      card: of(card.querySelector(".home-section-head h3")),
      group: of(card.querySelector(".brief-group > h4")),
      body: of(card.querySelector(".brief-group .brief-markdown p")),
    };
  });

try {
  for (const view of [
    { name: "desktop", width: 1280, height: 1100, touch: false },
    { name: "narrow-320", width: 320, height: 780, touch: true },
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const density of ["low", "high"]) {
        const { context, page } = await open({ ...view, theme, density });
        const where = `${view.name} ${theme} ${density}`;
        try {
          const shown = await levels(page);
          const heads = await groupTitle(page);
          report.measured.push({ where, ...shown, groupTitle: heads });
          assert.equal(
            await page.locator(".home-view").first().getAttribute("data-density"),
            density,
            `${where}: the density under test`,
          );
          if (!baseline) {
            // Three heading levels, each a visible step, all above body text.
            assert.ok(shown.h1.size > shown.h2.size + 0.5, `${where}: h1 over h2 ${JSON.stringify(shown)}`);
            assert.ok(shown.h2.size > shown.h3.size + 0.5, `${where}: h2 over h3 ${JSON.stringify(shown)}`);
            assert.ok(shown.h3.size > shown.body.size, `${where}: h3 over body ${JSON.stringify(shown)}`);
            assert.ok(shown.h1.weight >= 700 && shown.h2.weight >= 700, `${where}: headings carry weight ${JSON.stringify(shown)}`);
            assert.ok(shown.h3.weight > shown.body.weight, `${where}: h3 heavier than body ${JSON.stringify(shown)}`);
            // A block's title stands above the body it introduces, and above
            // the headings written inside it; only an explicit h1 outranks it.
            assert.ok(heads.group.size > heads.body.size, `${where}: group title over body ${JSON.stringify(heads)}`);
            assert.ok(heads.group.size >= shown.h2.size, `${where}: group title over h2 ${JSON.stringify({ heads, h2: shown.h2 })}`);
            assert.ok(heads.group.size < shown.h1.size, `${where}: an explicit h1 still leads ${JSON.stringify({ heads, h1: shown.h1 })}`);
            // Emphasis: a full step of weight, not a tint alone.
            assert.ok(shown.strong.weight >= 700, `${where}: strong is heavier ${JSON.stringify(shown)}`);
            assert.ok(shown.strong.weight - shown.body.weight >= 200, `${where}: a visible step ${JSON.stringify(shown)}`);
            record(`${where}: three heading levels, a title above the body, emphasis a step heavier`, { ...shown, groupTitle: heads });
          }
          if (view.touch) {
            const overflow = await page.locator('[data-section-key="typography"]').first()
              .evaluate((el) => el.scrollWidth - el.clientWidth);
            assert.ok(overflow <= 1, `${where}: nothing runs off 320 px (${overflow})`);
            if (!baseline) record(`${where}: the card fits 320 px`, { overflow });
          }
          for (const [key, label] of [["typography", "levels"], ["development", "card"]]) {
            const shot = `${output}/${label}-${view.name}-${theme}-${density}.png`;
            await page.locator(`[data-section-key="${key}"]`).first().screenshot({ path: shot });
            report.shots.push(shot);
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  // Home marks what the reader saw, and lists a Project's repositories with a
  // POST that reads (home-api.ts). Nothing else may leave this page.
  const allowed = /\/brief\/seen$|\/collaboration\/github_repositories$/;
  const unexpected = report.writes.filter((write) => !allowed.test(write.path));
  assert.deepEqual(unexpected, [], `nothing else is sent: ${JSON.stringify(unexpected)}`);
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${baseline ? "recorded" : `${report.checks.length} checks`}, ${report.shots.length} screenshots in ${output}`);
