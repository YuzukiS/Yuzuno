// R-28 (YN-219) in Chromium, every API answered here (no Core, no daily
// configuration), through the production build:
//  - a Project page whose right column holds a running Job with a long name,
//    a long repository name, a long PR title and a long branch name without
//    spaces: nothing inside "Team & running" may run past the card's border,
//    and the page may not scroll sideways for it;
//  - the Job line's state stays readable and its button clickable; the PR's
//    link stays on GitHub and its whole line is still reachable from the row
//    (the tip), as before;
//  - the same on a desktop narrow enough that the sidebar takes its room, and
//    on a phone with the Team area expanded.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-team-overflow-check.mjs
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
const report = { task: "YN-219", runs: [], unexpected: [], errors: [] };
const HOST = "localhost:47395";
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/yuzuno", projectId: "p-dev",
};
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "t", name: "YN-219 · 红测先行修复", kind: "executor", executor: { state: "running", task: { id: "YN-219", title: "Right column overflow", shortName: "右栏溢出" } } },
  { ...base, id: "i", name: "idle-1", kind: "lead" },
];
const projects = [{ id: "p-dev", name: "Yuzuno dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
let id = 200;
const section = (key, kind, title, body, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: owner("l", "lead-1"), updatedAt: at(30),
  updatedTurnId: "t1", body, attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const sections = [
  section("status", "status", "This week", spec(["s"], { s: md("Two cards run; one waits for your choice.") }), {
    status: { asOf: at(20), validFor: 86_400, stale: false },
  }),
  section("design", "report", "Settings groups", spec(["a"], { a: md("Two groups were compared.") })),
];

// The two widgets the user's screenshot shows past the card's right border.
const longJob = "[YN-216] R-25 项目页标签固定：base 与 head 的浏览器回归（重跑三次后的完整标题）";
const longWordJob = "r28-home-team-overflow-check-with-a-job-name-that-has-no-spaces-at-all-0123456789";
const repoName = "example-org/yuzuno-a-very-long-repository-name-for-the-right-column-check";
const github = "https://github.com/example-org/yuzuno-a-very-long-repository-name-for-the-right-column-check";
const longTitle = "[YN-216] fix(web): 项目页的「请求／对话」切换栏与固定标签（用于右栏溢出的长标题复现）";
const longBranch = "fix/r25-project-tabs-with-a-branch-name-that-has-no-spaces-0123456789";
const commitTitle = "Merge pull request #1099 from YuzukiS/fix/yn215-release-ci-run, then the rest of a long commit title";

const home = () => ({
  generatedAt: at(0),
  order: ["p-dev"],
  needsYou: [],
  projects: [
    {
      project: { id: "p-dev", name: "Yuzuno dev" },
      agents: { working: 1, idle: 2, waiting: 0, error: 0, offline: 0, total: 3 },
      contentEditors: { version: 1, editorAgentIds: ["l"] },
      errors: [],
      pending: [],
      jobs: [
        { id: "job-1", name: longJob, status: "running", agentId: "t", agentName: "YN-219 · 红测先行修复" },
        { id: "job-2", name: longWordJob, status: "succeeded", agentId: "t", agentName: "YN-219 · 红测先行修复" },
      ],
      unseen: 0, missing: [], brief: { version: 9, history: [], sections },
    },
  ],
});
const repoActivity = () => ({
  observedAt: at(2),
  repositories: [
    {
      id: 1,
      fullName: repoName,
      url: github,
      defaultBranch: "main",
      observedAt: at(2),
      stale: false,
      commits: [
        { sha: "52dde936234c41e12c817bbe05d66b9fea966f23", title: commitTitle, author: "example", at: at(90), url: `${github}/commit/52dde936234c41e12c817bbe05d66b9fea966f23` },
      ],
      pulls: [
        { number: 1100, title: longTitle, author: "example", url: `${github}/pull/1100`, draft: true, ci: { state: "pending" }, branch: longBranch, updatedAt: at(2) },
      ],
      pullsTotal: 1,
      runs: [
        { id: 900, name: "dsh contract", branch: "main", status: "completed", conclusion: "success", at: at(30), url: `${github}/actions/runs/900` },
      ],
    },
  ],
});

const state = { home: home() };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
// 1920: the Team area stands beside the cards; 1440: it folds under them, with the sidebar taking its room;
// 390: a phone, where the user expands it by hand.
const runs = [
  { name: "1920", viewport: { width: 1920, height: 1100 }, phone: false },
  { name: "1440", viewport: { width: 1440, height: 1000 }, phone: false },
  { name: "phone-390", viewport: { width: 390, height: 844 }, phone: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-team-overflow-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`home-team-overflow-check: ${report.runs.length} runs`);

async function check(run) {
  state.home = home();
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: "zh-CN",
    timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
  });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") {
      return route.fulfill({ json: { workspace: { id: "ws-project" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    }
    if (path === "/api/home") return route.fulfill({ json: state.home });
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [{ id: 1, fullName: repoName, url: github, syncedAt: at(3), error: null }], links: [] } });
    if (path === "/api/projects/p-dev/repo-activity") return route.fulfill({ json: repoActivity() });
    if (path === "/api/projects/p-dev/requests") return route.fulfill({ json: { requests: [], hasMore: false } });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 0, agentId: null, effectiveAgentId: null } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": {
        at: at(0),
        cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null },
        gpus: null, jobs: [],
      },
      "/api/machine-live": { machines: [] },
      "/api/collaboration/github_repositories": { repositories: [{ id: 1, fullName: repoName, url: github }], links: [] },
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
  const projectPage = () => page.locator('[data-project-home="p-dev"]');
  try {
    if (run.phone) await page.goto(`http://${HOST}/#/home?w=ws-project`);
    else {
      await page.goto(`http://${HOST}/`);
      await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    }
    await page.locator('[data-glance-project="p-dev"]').waitFor({ timeout: 15_000 });
    if (run.phone) await page.locator('[data-glance-project="p-dev"] .project-glance-open').tap();
    else await page.locator('[data-glance-project="p-dev"] .project-glance-open').click();
    await projectPage().waitFor({ timeout: 15_000 });
    // The Team area stands beside the cards only on a wide page; otherwise it arrives folded, and the user opens it.
    if (await page.locator("details.project-team > summary").count()) {
      await page.locator("details.project-team > summary").click();
      await page.waitForFunction(() => document.querySelector("details.project-team")?.open === true);
    }
    const panel = page.locator(".project-team");
    assert.equal(await panel.count(), 1);
    // The repository's activity is read only while it is on screen: the fold can sit below the cards.
    await panel.scrollIntoViewIfNeeded();
    // The two widgets: the Job line, then the repository's line and its PR.
    await page.locator(".project-team .home-job").first().waitFor({ timeout: 15_000 });
    try {
      await page.locator(".project-team a.repo-row").first().waitFor({ timeout: 15_000 });
    } catch (error) {
      console.log(`[${run.name}] no repository row; the card says:`, (await panel.innerText()).slice(0, 600));
      await shot("no-repo-row");
      throw error;
    }
    await shot("team");

    // 1. Nothing inside the card runs past its right border (the screenshot's bug).
    const boxes = await page.evaluate(() => {
      const panel = document.querySelector(".project-team");
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const right = rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      const seen = (el) => {
        const box = el.getBoundingClientRect();
        const own = getComputedStyle(el);
        return { box, own };
      };
      const offenders = [];
      for (const el of panel.querySelectorAll("*")) {
        const { box, own } = seen(el);
        if (!box.width && !box.height) continue;
        if (own.display === "none" || own.visibility === "hidden") continue;
        if (box.right > right + 1 || box.left < left - 1)
          offenders.push({
            tag: el.tagName.toLowerCase(),
            className: String(el.className?.baseVal ?? el.className ?? "").slice(0, 90),
            left: Math.round(box.left - left),
            right: Math.round(box.right - left),
            width: Math.round(box.width),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
      }
      const wide = getComputedStyle(panel).display === "grid" && panel.tagName === "ASIDE";
      return { left: Math.round(left), right: Math.round(right), panel: Math.round(rect.width), content: Math.round(right - left), wide, offenders };
    });
    assert.deepEqual(boxes.offenders, [], `${run.name}: nothing inside the Team card runs past its border: ${JSON.stringify(boxes)}`);
    const widths = await page.evaluate(() => ({
      page: document.scrollingElement.scrollWidth,
      window: innerWidth,
      view: document.querySelector(".home-view").scrollWidth,
      viewBox: document.querySelector(".home-view").clientWidth,
    }));
    assert.ok(widths.page <= widths.window + 1, `${run.name}: the page does not scroll sideways: ${JSON.stringify(widths)}`);
    assert.ok(widths.view <= widths.viewBox + 1, `${run.name}: Home does not scroll sideways: ${JSON.stringify(widths)}`);
    pass(`nothing inside "团队与运行" runs past the card (${boxes.wide ? "beside the cards" : "folded under them"})`, { boxes, widths });

    // 2. The Job line: its state readable, its button whole and clickable, its name cut with an ellipsis.
    const jobs = await page.evaluate(() => {
      const list = document.querySelector(".project-team .home-jobs");
      const buttons = [...list.querySelectorAll(".home-job")];
      const listBox = list.getBoundingClientRect();
      return buttons.map((button) => {
        const strong = button.querySelector("strong");
        const status = button.querySelector(".home-job-status");
        const box = button.getBoundingClientRect();
        return {
          name: strong?.textContent ?? "",
          status: status?.textContent ?? "",
          statusShown: !!status && status.getBoundingClientRect().width > 0,
          cut: !!strong && strong.scrollWidth > strong.clientWidth + 1,
          textOverflow: strong ? getComputedStyle(strong).textOverflow : "",
          inside: box.right <= listBox.right + 1 && box.left >= listBox.left - 1,
          visible: !!(box.width && box.height),
          disabled: button.disabled,
        };
      });
    });
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assert.ok(job.visible, `${run.name}: a Job line is drawn: ${JSON.stringify(job)}`);
      assert.ok(job.inside, `${run.name}: a Job line stays inside its list: ${JSON.stringify(job)}`);
      assert.ok(job.statusShown && job.status.length > 0, `${run.name}: a Job line keeps its state readable: ${JSON.stringify(job)}`);
      assert.ok(!job.disabled, `${run.name}: a Job line is still clickable: ${JSON.stringify(job)}`);
      assert.equal(job.textOverflow, "ellipsis", `${run.name}: a long Job name is cut with an ellipsis: ${JSON.stringify(job)}`);
    }
    assert.ok(jobs.some((job) => job.cut && job.name.includes("R-25")) || !boxes.wide, `${run.name}: the long Job name is cut rather than widening the card: ${JSON.stringify(jobs)}`);
    assert.ok(jobs.every((job, i) => jobs.findIndex((other) => other.name === job.name) === i), "each Job once");
    pass("each Job line keeps its state, stays whole and clickable, its long name cut with an ellipsis", { jobs });

    // 3. The repository: the row's link stays on GitHub, and its whole line is reachable from the row (the tip),
    //    with the title and branch still cut rather than widening the card.
    const pull = await page.evaluate(() => {
      const row = document.querySelector(".project-team .repo-group .repo-row");
      const list = row?.closest("ul");
      const title = row?.querySelector(".repo-row-title");
      const branch = row?.querySelector(".repo-pull-branch");
      const box = row?.getBoundingClientRect();
      const listBox = list?.getBoundingClientRect();
      return row && {
        tag: row.tagName.toLowerCase(),
        href: row.getAttribute("href"),
        // The row's hover halo sits 4 px each side of its list by design (margin: 0 -4px).
        inside: box.right <= listBox.right + 5 && box.left >= listBox.left - 5,
        left: Math.round(box.left - listBox.left),
        right: Math.round(box.right - listBox.right),
        titleCut: !!title && title.scrollWidth > title.clientWidth + 1,
        branchCut: !!branch && branch.scrollWidth > branch.clientWidth + 1,
        branchText: branch?.textContent ?? "",
      };
    });
    assert.ok(pull, "the PR row is drawn");
    assert.equal(pull.tag, "a", "the PR row is still a link");
    assert.equal(pull.href, `${github}/pull/1100`, "the link still opens the PR on GitHub");
    assert.ok(pull.inside, `the PR row stays inside its list: ${JSON.stringify(pull)}`);
    assert.ok(pull.titleCut || !boxes.wide, `the long PR title is cut rather than widening the card: ${JSON.stringify(pull)}`);
    if (!run.phone) {
      assert.ok(pull.branchCut, `the long branch name is cut rather than widening the card: ${JSON.stringify(pull)}`);
      // Hovering the row still tells the whole line, title and branch included (the way to read what is cut).
      await page.locator(".project-team .repo-group .repo-row").first().hover();
      const tip = page.locator(".tip");
      await tip.waitFor({ timeout: 5_000 });
      const text = await tip.innerText();
      assert.ok(text.includes("项目页的「请求／对话」切换栏"), `the row's tip still holds the whole title: ${text}`);
      assert.ok(text.includes(longBranch), `the row's tip still holds the whole branch: ${text}`);
      await page.mouse.move(0, 0);
      pass("the PR row stays a GitHub link, its title and branch cut, its whole line in the row's tip", { pull, tip: text.slice(0, 160) });
    } else {
      pass("the PR row stays a GitHub link, its long title cut rather than widening the card", { pull });
    }
    await shot("team-widgets");
  } finally {
    await context.close();
  }
}
