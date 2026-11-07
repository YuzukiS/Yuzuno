// YN-7 S3 in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, at 1440 px and a phone
// (390 px), in English and in Simplified Chinese:
//  - a research desk named as a wide or large card's visual draws its lead
//    claim with the author's status and the interval of the row it leads
//    with, its numbers read as the report page reads them, inside its frame;
//  - a card's Checklist conditions are named by the Checklist's title, its
//    open items come first, and when some are folded the fold says how many
//    of them are open; Show all opens them in place;
//  - the desk's list of sources on its report page says once that locations
//    and revisions are the Agent's, and its lines do not say it again;
//  - nothing is wider than the window, and nothing is sent but reads.
// Pattern: YN-3's home-cards-check.mjs.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-desk-cards-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-7", runs: [], posts: [], unexpected: [], errors: [], researchReads: [] };
const HOST = "yuzuno-desk.test";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const agents = [{ id: "l", name: "lead-1", harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/trial", projectId: "p-desk" }];
const projects = [{ id: "p-desk", name: "trial-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "lead-1", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
let id = 200;
const section = (key, title, body, extra = {}) => ({ id: id++, key, kind: "report", title, version: 3, owner, updatedAt: at(30), updatedTurnId: "t1",
  body, attachments: [], refs: {}, seen: null, history: false, ...extra });

// The synthetic dose study's desk with a second claim, named as the card's visual at a size.
const deskBody = (size) => {
  const desk = doseStudy.body.elements.desk;
  const second = { id: "c2", title: "The low dose's effect is unclear", statement: "Its interval crosses zero under the v2 outcome.", status: "open", primary: "low-v2" };
  return { root: "body", elements: { ...doseStudy.body.elements,
    body: node("BriefBody", { summary: { lead: "lead", visual: "desk", size } }, ["lead", "desk"]),
    lead: md("Against placebo, the high dose shortens recovery under the v2 outcome."),
    desk: { ...desk, props: { ...desk.props, claims: [...desk.props.claims, second] } } } };
};
/** Core's research read of the desk, from the fixture files, as research.rs answers it. */
function deskRead(key, version) {
  const values = {};
  for (const plot of doseStudy.body.elements.desk.props.plots)
    for (const row of plot.rows)
      for (const [rowId, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (!number || typeof number !== "object") continue;
          const found = number.pointer.split("/").slice(1).reduce((value, part) => value?.[part], fixtureFiles[number.from]);
          values[`${rowId}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
        }
  return { key, version, elementId: "desk", values, sources: {} };
}
// Conditions: five open items, long enough that two lines cannot hold them all, and four done.
const gate = node("Checklist", { title: "Before the test run", items: [
  { id: "proto", text: "Protocol written down in docs/test_protocol.md", done: true },
  { id: "cache", text: "Unlabelled inputs cached for all 46/86/43 clips", done: true },
  { id: "freeze", text: "Freeze the new method before reading any test label", done: false },
  { id: "seeds", text: "Seeds fixed at 0 and 1 for every arm", done: true },
  { id: "register", text: "Register the run and its budget on the task", done: false },
  { id: "budget", text: "Agree the compute budget per sport with the reviewer", done: false },
  { id: "split", text: "Confirm the val/test split is the one from the protocol", done: true },
  { id: "metric", text: "Name the primary metric and its interval method", done: false },
  { id: "stop", text: "Write down the stopping rule before the first result", done: false },
] });
const sections = [
  section("dose", doseStudy.title, deskBody("wide")),
  section("dose-large", "Dose study, large card", deskBody("large")),
  section("gate", "Test gate", { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", conditions: "gate", size: "small" } }, ["lead", "gate"]),
    lead: md("The test stays paused until the new method is frozen and registered."), gate } }),
];
const home = () => ({
  generatedAt: at(0), order: ["p-desk"], needsYou: [],
  projects: [{ project: { id: "p-desk", name: "trial-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { status: "Holds under conditions (the author's reading)", more: "+1 claim · interactive on the report page",
    fold: /^\+(\d+) more conditions(?: \((\d+) open\))?$/, fewer: "Show fewer conditions",
    note: "Locations and revisions below are as described by the Agent; they were not read.", prefix: "As described by the Agent",
    line: "study/results.json · Revision 0f3a9c1", sources: "Sources" },
  "zh-Hans": { status: "有条件成立 (作者的判断)", more: "另有 1 个主张 · 在报告页中可交互",
    fold: /^还有 (\d+) 项条件(?:（(\d+) 项未完成）)?$/, fewer: "收起条件",
    note: "下面的位置和版本是 Agent 的描述，未经读取。", prefix: "Agent 的描述",
    line: "study/results.json · 版本 0f3a9c1", sources: "来源" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const [name, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["phone-390", { width: 390, height: 844 }, true]])
    runs.push({ name: `${language}-${name}`, language, phone, viewport });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-desk-cards-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`home-desk-cards-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript((language) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    if (!localStorage.getItem("yuzuno.selected.ws-desk")) localStorage.setItem("yuzuno.selected.ws-desk", JSON.stringify("l"));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    // The Project's linked repositories: a list read sent as a POST, which starts no sync (home-api.ts).
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const research = path.match(/^\/api\/projects\/p-desk\/brief\/research\/([^/]+)\/desk$/);
    if (research) {
      report.researchReads.push({ run: run.name, key: research[1], version: url.searchParams.get("version") });
      return route.fulfill({ json: deskRead(research[1], Number(url.searchParams.get("version"))) });
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-desk" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": home(),
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  const card = (key) => page.locator(`#home-section-p-desk-${key}`);
  const shot = async (locator, name) => {
    const file = `${run.name}-${name}.png`;
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  try {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await card("dose").waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language, "Home in the chosen language");

    // ---- Conditions: the Checklist's title, open items first, the fold counts the open ones it hides.
    const box = card("gate").locator(".home-card-conditions");
    const conditions = async () => box.evaluate((el) => {
      const chips = [...el.querySelectorAll(".home-card-condition-chips li")];
      return { label: el.querySelector(".home-card-conditions-label").textContent, aria: el.getAttribute("aria-label"),
        order: chips.map((li) => (li.hasAttribute("data-done") ? "done" : "open")),
        hidden: chips.map((li) => li.hidden), toggle: el.querySelector(".home-card-conditions-toggle")?.textContent ?? null };
    });
    const folded = await conditions();
    await shot(card("gate"), "conditions-folded");
    assert.deepEqual([folded.label, folded.aria], ["Before the test run", "Before the test run"]);
    assert.deepEqual(folded.order, ["open", "open", "open", "open", "open", "done", "done", "done", "done"], "open items first");
    const hidden = folded.hidden.filter(Boolean).length;
    const hiddenOpen = folded.order.filter((kind, i) => kind === "open" && folded.hidden[i]).length;
    assert.ok(hidden > 1, `two lines cannot hold all nine: ${JSON.stringify(folded)}`);
    assert.ok(hiddenOpen > 0, `five long open items do not fit two lines: ${JSON.stringify(folded)}`);
    // What is folded is the end of the list: no open item folded while a done one shows.
    assert.ok(folded.hidden.every((h, i) => !h || folded.hidden.slice(i).every(Boolean)), JSON.stringify(folded));
    const said = folded.toggle.match(w.fold);
    assert.ok(said, `the fold says it: ${folded.toggle}`);
    assert.deepEqual([Number(said[1]), Number(said[2] ?? 0)], [hidden, hiddenOpen], `${folded.toggle} for ${JSON.stringify(folded)}`);
    await box.locator(".home-card-conditions-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#home-section-p-desk-gate .home-card-condition-chips li[hidden]").length === 0, null, { timeout: 5000 });
    const opened = await conditions();
    assert.equal(opened.toggle, w.fewer);
    await shot(card("gate"), "conditions-open");
    pass("the Checklist's title names the box; open items first; the fold names how many it hides and how many are open; Show all opens them",
      { hidden, hiddenOpen, toggle: folded.toggle });

    // ---- The desk on a wide and a large card: its lead claim, status, the read interval, inside its frame.
    const desks = {};
    for (const key of ["dose", "dose-large"]) {
      const desk = card(key).locator(".home-card-frame.kind-desk .research-card");
      await desk.locator('.research-origin[data-origin="read"]').waitFor({ timeout: 10_000 });
      desks[key] = await card(key).evaluate((el) => {
        const frame = el.querySelector(".home-card-frame-body");
        const desk = el.querySelector(".research-card");
        const box = (node) => node.getBoundingClientRect();
        const inside = [...desk.querySelectorAll("*")].every((child) => {
          const r = box(child), f = box(frame);
          return r.width === 0 || (r.left >= f.left - 1 && r.right <= f.right + 1);
        });
        return { size: el.dataset.cardSize, status: desk.querySelector(".research-status")?.textContent,
          claim: desk.querySelector(".research-card-claim")?.textContent, value: desk.querySelector(".research-row-value b")?.textContent,
          interval: desk.querySelector(".research-row-interval")?.textContent, more: desk.querySelector(".research-card-more")?.textContent,
          rows: desk.querySelectorAll(".research-row").length, inside, sideways: frame.scrollWidth > frame.clientWidth + 1,
          cut: desk.scrollHeight > frame.clientHeight + 1 };
      });
    }
    await shot(card("dose"), "desk-wide");
    await shot(card("dose-large"), "desk-large");
    for (const [key, size] of [["dose", "wide"], ["dose-large", "large"]]) {
      const d = desks[key];
      assert.equal(d.size, size, key);
      assert.deepEqual([d.status, d.claim, d.value, d.interval, d.more, d.rows], [w.status, "High dose shortens recovery", "−2.04", " [−3.12, −0.96]", w.more, 1], `${key}: ${JSON.stringify(d)}`);
      assert.ok(d.inside && !d.sideways && !d.cut, `${key}: inside its frame, nothing cut: ${JSON.stringify(d)}`);
    }
    pass("a wide and a large card draw the desk's lead claim, its status and the read interval inside the frame, nothing cut", desks);

    // ---- Nothing wider than the window; the whole Home.
    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    await page.screenshot({ path: join(output, `${run.name}-home.png`), fullPage: true });
    result.shots.push(`${run.name}-home.png`);
    pass("nothing wider than the window", widths);

    // ---- The desk's report page: its list of sources says once whose locations and revisions they are.
    await card("dose").locator(".home-report-open").click();
    const aside = page.locator(".home-report .research-aside");
    await aside.waitFor({ timeout: 10_000 });
    const listed = await aside.evaluate((el, [prefix, heading]) => {
      const panel = [...el.querySelectorAll(".research-panel")].find((p) => p.querySelector("h5")?.textContent === heading);
      return { notes: [...panel.querySelectorAll(".research-described-note")].map((n) => n.textContent),
        lines: [...panel.querySelectorAll(".research-sources .research-described")].map((n) => n.textContent),
        prefixed: [...panel.querySelectorAll(".research-sources .research-described")].filter((n) => n.textContent.includes(prefix)).length };
    }, [w.prefix, w.sources]);
    await shot(aside, "report-sources");
    assert.deepEqual(listed, { notes: [w.note], lines: [w.line], prefixed: 0 }, JSON.stringify(listed));
    pass("the report page's list of sources says once that locations and revisions are the Agent's; its lines do not repeat it", listed);
  } finally {
    await context.close();
  }
}
