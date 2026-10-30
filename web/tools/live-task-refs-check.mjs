// A live task list on Home (T-9) in a real browser: the Agent names the
// tasks, their order and a note; Core's facts (title, state, who is
// responsible, when the task last changed) fill each row, the assignee at
// either density. A task change Core announces reads Home again once for a
// burst; the changed row carries a quiet mark and the rest stay as they
// were, and a draft being typed keeps its text and focus. A read that fails
// keeps the last facts and says they are out of date. Desktop at both densities and a 393 px phone, in
// Chinese. Production bundle with an explicit API fixture and a stand-in
// event stream: no Core, synthetic data, nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/live-task-refs-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/live-task-refs");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-live-tasks.test";
const report = { task: "T-9", checks: [], shots: [], errors: [], requests: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shoot = async (target, name) => {
  await target.screenshot({ path: `${output}/${name}.png` });
  report.shots.push(name);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "claude", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [["dev7", "Dev 7"], ["dev3", "Dev 3"], ["dev5", "Dev 5"], ["dev2", "Dev 2"]]
  .map(([id, name]) => ({ ...base, id, name, projectId: "p1" }));
const projects = [{ id: "p1", name: "yuzuno-next", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "dev7", name: "Dev 7", state: "active" };
const who = (id, name) => ({ kind: "agent", id, name });
const task = (id, title, state, tone, assignee, updatedAt) =>
  ({ kind: "task", id, found: true, title, state, tone, assignee, updatedAt });

// What the Agent wrote: which tasks, in which order, and a note for each.
const listBody = {
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["intro", "tasks"] },
    intro: { type: "Markdown", props: { text: "这一轮谁在做什么。任务的标题、状态、负责人和更新时间来自 Core，说明是我写的。" } },
    tasks: { type: "LiveRefs", props: { layout: "list", items: [
      { kind: "task", id: "T-9", note: "整卡负责人：实时任务卡试点" },
      { kind: "task", id: "T-12", note: "Ask 版本绑定：Core 回复路径" },
      { kind: "task", id: "T-13", note: "Ask 版本绑定：网页回复与草稿" },
      { kind: "task", id: "T-10", note: "OpenCode Usage，Dev 2 继续" },
      { kind: "task", id: "T-14", note: "section 级并发写入，Ask 完成后接" },
      { kind: "task", id: "T-999", note: "（演示）一个不存在的任务" },
      { kind: "task", id: "T-15", note: "（演示）这一行 Core 读取失败" },
    ] } },
  },
};
const chipsBody = {
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["text", "refs"] },
    text: { type: "Markdown", props: { text: "同样的引用，现有芯片样式。" } },
    refs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-9" }, { kind: "task", id: "T-12" }, { kind: "task", id: "T-999" }] } },
  },
};
// Core's facts: once the check moves on to phase 2, T-12 is in review. Home
// reads more than once as it starts, so the phase is the check's, not a count.
const facts = (round) => ({
  "task:T-9": task("T-9", "优先推进｜Generative UI：交互设计、信息分层与回答卡片", "doing", "active", who("dev7", "Dev 7"), iso(-12 * MIN)),
  "task:T-12": round >= 2
    ? task("T-12", "Ask 服务端版本绑定（Core）", "review", "active", who("dev3", "Dev 3"), iso(-1 * MIN))
    : task("T-12", "Ask 服务端版本绑定（Core）", "doing", "active", who("dev3", "Dev 3"), iso(-40 * MIN)),
  "task:T-13": task("T-13", "Ask 版本绑定（网页）", "todo", "neutral", who("dev5", "Dev 5"), iso(-120 * MIN)),
  "task:T-10": task("T-10", "OpenCode Usage 与上下文用量", "review", "active", who("dev2", "Dev 2"), iso(-26 * 60 * MIN)),
  "task:T-14": task("T-14", "section 级并发写入", "blocked", "attention", null, iso(-180 * MIN)),
  "task:T-999": { kind: "task", id: "T-999", found: false },
  "task:T-15": { kind: "task", id: "T-15", found: false, unavailable: true },
});
const section = (key, title, body, refs, extra = {}) => ({
  key, kind: "report", title, version: 4, owner, updatedAt: iso(-15 * MIN), updatedTurnId: null,
  attachments: [], refs, seen: null, history: false, body, ...extra,
});
const ask = {
  key: "naming", kind: "ask", title: "这张卡叫什么？", version: 1, owner, updatedAt: iso(-5 * MIN), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text: "写一个你喜欢的名字。" } } } },
  ask: { question: "这张实时任务卡叫什么？", state: "open", reply: { freeText: true } },
};
const home = (round) => {
  const all = facts(round);
  return {
    generatedAt: new Date().toISOString(),
    order: ["p1"],
    needsYou: [{ kind: "ask", projectId: "p1", agentId: "dev7", agentName: "Dev 7", sectionKey: "naming", title: ask.title, since: ask.updatedAt }],
    projects: [{
      project: { id: "p1", name: "yuzuno-next" },
      agents: { working: 3, idle: 1, waiting: 0, error: 0, offline: 0, total: 4 },
      errors: [], pending: [], jobs: [],
      brief: { version: 12, history: [], sections: [
        section("work", "这一轮谁在做什么", listBody, all),
        section("chips", "相关任务（芯片）", chipsBody, { "task:T-9": all["task:T-9"], "task:T-12": all["task:T-12"], "task:T-999": all["task:T-999"] }),
        structuredClone(ask),
      ] },
      unseen: 0, missing: [],
    }],
  };
};

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme, density }) {
  const state = { reads: 0, failFrom: Infinity, phase: 1 };
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([theme, density]) => {
    // A stand-in for Core's event stream, which the check speaks through.
    window.EventSource = class {
      constructor() { window.__events = this; this.readyState = 0; }
      close() {}
      addEventListener() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    localStorage.setItem("yuzuno.homeDensity.ws", JSON.stringify(density));
  }, [theme, density]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.startsWith("/api/")) report.requests.push(path);
    // Home reads its linked repositories with a POST that changes nothing;
    // anything else sent is a write, and none is expected.
    if (route.request().method() !== "GET") {
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      report.writes = [...(report.writes ?? []), path];
      return route.fulfill({ status: 405, json: { error: "no writes here" } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 4, tasks: 6 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/home") {
      state.reads += 1;
      if (state.reads >= state.failFrom) return route.fulfill({ status: 503, json: { error: "Core is busy" } });
      return route.fulfill({ json: home(state.phase) });
    }
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
  page.on("pageerror", (error) => report.errors.push(`${width} ${density}: ${error.message}`));
  await page.goto(`https://${HOST}/`);
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  await page.locator('[data-section-key="work"] .brief-ref-list').first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  // The stream opens, as Core's does: the app then stops polling, and its
  // one reset after opening is read before anything here is counted.
  await page.evaluate(() => window.__events.onopen?.());
  await page.waitForTimeout(1_500);
  return { context, page, state };
}

/** A Core event, as the stream would deliver it. */
const announce = (page, event) => page.evaluate((event) => window.__events.onmessage?.({ data: JSON.stringify(event), lastEventId: "" }), event);
const rows = (page) => page.locator('[data-section-key="work"] .brief-ref-row').evaluateAll((all) => all.map((row) => ({
  id: row.querySelector(".brief-ref-row-open small")?.textContent,
  title: row.querySelector(".brief-ref-row-title")?.textContent,
  state: row.querySelector(".brief-ref-state")?.textContent ?? null,
  who: row.querySelector(".brief-ref-row-who")?.textContent ?? null,
  meta: row.querySelector(".brief-ref-row-meta")?.textContent ?? null,
  tone: row.dataset.tone ?? null,
  changed: row.hasAttribute("data-changed"),
  stale: row.hasAttribute("data-stale"),
  height: Math.round(row.getBoundingClientRect().height),
})));
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();

try {
  for (const view of [
    { name: "desktop-high", width: 1440, height: 1000, touch: false, theme: "light", density: "high" },
    { name: "desktop-low", width: 1440, height: 1000, touch: false, theme: "light", density: "low" },
    { name: "desktop-high-dark", width: 1440, height: 1000, touch: false, theme: "dark", density: "high" },
    { name: "phone-high", width: 393, height: 852, touch: true, theme: "light", density: "high" },
    // Home's default density, on a phone.
    { name: "phone-low", width: 393, height: 852, touch: true, theme: "light", density: "low" },
  ].filter((view) => !process.env.YUZUNO_CHECK_VIEWS || process.env.YUZUNO_CHECK_VIEWS.split(",").includes(view.name))) {
    const { context, page, state } = await open(view);
    try {
      const first = await rows(page);
      assert.deepEqual(first.map((r) => [r.id, r.title, r.state, r.who]), [
        ["T-9", "优先推进｜Generative UI：交互设计、信息分层与回答卡片", "进行中", "负责人 Dev 7"],
        ["T-12", "Ask 服务端版本绑定（Core）", "进行中", "负责人 Dev 3"],
        ["T-13", "Ask 版本绑定（网页）", "待办", "负责人 Dev 5"],
        ["T-10", "OpenCode Usage 与上下文用量", "待审阅", "负责人 Dev 2"],
        ["T-14", "section 级并发写入", "受阻", "无负责人"],
        ["T-999", "T-999", "未找到", null],
        ["T-15", "T-15", "读取失败", null],
      ], `${view.name}: ${JSON.stringify(first)}`);
      assert.match(await card(page, "work").locator(".brief-ref-list-read").textContent(), /^状态为 Core 在 .+ 读取的记录$/);
      if (view.density === "high") {
        assert.match(first[0].meta, /^任务更新于 .+Dev 7 的说明：整卡负责人：实时任务卡试点$/);
        assert.equal(first[5].meta, "Dev 7 的说明：（演示）一个不存在的任务");
        assert.deepEqual(first.map((r) => r.tone), ["active", "active", "neutral", "active", "attention", "missing", "missing"]);
      } else {
        assert.ok(first.every((r) => r.meta === null), "low density: no meta line, but who is responsible");
        if (!view.touch) assert.ok(first.every((r) => r.height < 44), `low density rows are one line: ${first.map((r) => r.height)}`);
      }
      assert.ok((await sideways(page)) <= 0, `${view.name}: nothing sideways`);
      record(`${view.name}: the Agent's order and notes, Core's title, state, assignee and update; not found and couldn't read`, { rows: first });
      await shoot(card(page, "work"), `${view.name}-list`);
      if (view.name === "desktop-high") await shoot(card(page, "chips"), `${view.name}-chips-existing`);
      await shoot(page, `${view.name}-home`);
      if (view.touch) {
        // On a phone an ID and a state word stay whole, in the list and in
        // the chips; a long title wraps instead.
        const words = await page.evaluate(() => [...document.querySelectorAll(
          '[data-section-key="work"] :is(.brief-ref-row-open small, .brief-ref-state), [data-section-key="chips"] .brief-ref :is(small, .brief-ref-state)')]
          .map((el) => ({ text: el.textContent, lines: el.getClientRects().length,
            tall: el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight || "0") * 1.5 + 2 })));
        const broken = words.filter((word) => word.lines > 1 || word.tall);
        assert.deepEqual(broken, [], `${view.name}: an ID or state broken inside: ${JSON.stringify(broken)}`);
        const chipTitle = await page.evaluate(() => {
          const chip = document.querySelector('[data-section-key="chips"] .brief-ref');
          const title = chip.querySelector("span");
          return { titleHeight: Math.round(title.getBoundingClientRect().height), chipWidth: Math.round(chip.getBoundingClientRect().width), page: innerWidth };
        });
        assert.ok(chipTitle.chipWidth <= chipTitle.page, `the chip stays inside the screen: ${JSON.stringify(chipTitle)}`);
        record(`${view.name}: IDs and state words stay whole on a phone; a long chip title wraps`, { checked: words.length, chipTitle });
        await shoot(card(page, "chips"), `${view.name}-chips`);
        // Scrolled to the list's end: its last row and the read time are
        // reached, and nothing fixed at the bottom of the screen covers them.
        const end = card(page, "work").locator(".brief-ref-list-read");
        await end.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const reach = await page.evaluate(() => {
          const last = [...document.querySelectorAll('[data-section-key="work"] .brief-ref-row')].at(-1);
          const read = document.querySelector('[data-section-key="work"] .brief-ref-list-read');
          const covered = (el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.bottom - 2);
            return !(top && el.contains(top));
          };
          const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
          return { last: box(last), read: box(read), height: innerHeight,
            lastCovered: covered(last), readCovered: covered(read), lastText: last.textContent };
        });
        assert.ok(reach.read.bottom <= reach.height && reach.last.top >= 0, `the end is in view: ${JSON.stringify(reach)}`);
        assert.ok(!reach.lastCovered && !reach.readCovered, `nothing covers the end: ${JSON.stringify(reach)}`);
        record(`${view.name}: scrolled to the end, the last row and the read time are in view and uncovered`, { reach });
        await shoot(page, `${view.name}-list-end`);
      }

      if (view.name === "desktop-high" || view.name === "phone-high") {
        // A draft being typed elsewhere on Home.
        const field = card(page, "naming").locator("textarea").first();
        await field.click();
        await field.fill("先叫它实时任务卡");
        // Mail and other collaboration changes don't read Home again.
        const before = state.reads;
        await announce(page, { type: "workspace.changed", scope: "collaboration", collaboration: true });
        await page.waitForTimeout(2_500);
        assert.equal(state.reads, before, "a collaboration notice without tasks reads nothing");
        // A task change does: once, and Home's read is all it reads for the
        // list (no task is read on its own).
        const asked = report.requests.length;
        state.phase = 2;
        await announce(page, { type: "workspace.changed", scope: "collaboration", collaboration: true, tasks: true });
        await page.waitForFunction(() => document.querySelector('[data-section-key="work"] .brief-ref-row[data-changed]'), null, { timeout: 5_000 });
        const second = await rows(page);
        assert.equal(state.reads, before + 1);
        const delta = report.requests.slice(asked);
        assert.equal(delta.filter((path) => path === "/api/home").length, 1, JSON.stringify(delta));
        assert.deepEqual(delta.filter((path) => /task_get|\/tasks\//.test(path)), [], `no task read on its own: ${JSON.stringify(delta)}`);
        assert.deepEqual(second.filter((r) => r.changed).map((r) => [r.id, r.state]), [["T-12", "待审阅"]], JSON.stringify(second));
        const kept = await page.evaluate(() => ({ value: document.activeElement?.value, tag: document.activeElement?.tagName,
          inAsk: !!document.activeElement?.closest('[data-section-key="naming"]') }));
        assert.deepEqual(kept, { value: "先叫它实时任务卡", tag: "TEXTAREA", inAsk: true }, "the draft keeps its text and focus");
        // The section's version did not change, so no "updated" mark on the card.
        assert.equal(await card(page, "work").locator(".brief-change").count(), 0);
        record(`${view.name}: a task change reads Home once; only T-12 carries the quiet "changed" mark; the draft keeps its text and focus`, { kept, second: second.map((r) => [r.id, r.state, r.changed]) });
        await shoot(card(page, "work"), `${view.name}-partial-update`);

        // A burst of changes, and the read fails: one read, then "not current".
        state.failFrom = state.reads + 1;
        const burst = state.reads;
        for (let i = 0; i < 5; i++) await announce(page, { type: "workspace.changed", scope: "collaboration", collaboration: true, tasks: true });
        await page.locator('[data-section-key="work"] .brief-ref-list-stale').waitFor({ timeout: 6_000 });
        await page.waitForTimeout(2_500);
        assert.equal(state.reads, burst + 1, `a burst reads Home once: ${state.reads - burst}`);
        const third = await rows(page);
        assert.ok(third.every((r) => r.stale), "every row says it is not current");
        assert.deepEqual(third.map((r) => r.state), second.map((r) => r.state), "the last facts stay, marked");
        const banner = await card(page, "work").locator(".brief-ref-list-stale").textContent();
        assert.match(banner, /^已过期：Home 刚才没能读取 Core，以下是 .+ 读取的状态。$/);
        assert.equal(await field.inputValue(), "先叫它实时任务卡");
        record(`${view.name}: a burst of five reads Home once; a failed read keeps the last facts, says they are out of date, and keeps the draft`, { banner });
        await shoot(card(page, "work"), `${view.name}-not-current`);
      }
    } catch (error) {
      await page.screenshot({ path: `${output}/failed-${view.name}.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.deepEqual(report.writes ?? [], [], "nothing is written");
  record("no page errors, and nothing written");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
