// T-65: the Jobs panel's merge queue in Chromium, through the real app, with
// every API answered here (no Core, no GitHub). It checks:
//  - in English at 1280 px: the Merge queue source, a paused repository's
//    banner with who can unpause, an unpaused one with its last pause, the
//    entries in two groups, and the chosen entry's record and actions;
//  - unpause: a reason typed and sent once to the unpause route, and Core's
//    refusal shown as it came;
//  - the language changed in another window: the panel is Chinese, with
//    names, SHAs and Core's text as they came;
//  - YN-67: an entry whose release acknowledged a P2 the user accepted
//    shows the finding, its round and the user's reply, in Chinese and in
//    English;
//  - at 420 px nothing in the panel is wider than the panel.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/merge-queue-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-65", checks: [], reads: [], posts: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-merge-queue.test";

const now = new Date().toISOString();
const sha = (c) => c.repeat(40);
const base = { status: "idle", harness: "codex", threadId: "native", cwd: "/fixture", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const agents = [
  { ...base, id: "lead-1", name: "Lead Sora", kind: "lead", projectId: "p1" },
  { ...base, id: "dev-1", name: "Dev Kai", projectId: "p1" },
];
const project = { id: "p1", name: "Synthetic project", defaultDirs: {}, createdAt: now, updatedAt: now };
const home = { generatedAt: now, order: [], needsYou: [], projects: [] };
const entry = (id, number, state, extra = {}) => ({
  id, entryId: id, taskId: `task-${id}`, taskReference: "T-41", repositoryId: 7, repository: "owner/repo", number,
  url: `https://github.com/owner/repo/pull/${number}`, headSha: sha("a"), baseBranch: "main", mainAtRelease: sha("b"), mainAnchoredAt: now,
  release: { by: { kind: "agent", id: "dev-1", name: "Dev Kai" }, at: now, reviewId: "review-1" },
  state, reason: null, detail: null, batch: null, merge: null, evidence: null, queueVersion: 2, createdAt: now, updatedAt: now, ...extra,
});
const entries = [
  entry("e-queued", 13, "queued", { detail: "Released; Core checks it before anything else happens." }),
  entry("e-waiting", 14, "waiting", { detail: "Synthetic CI run 610 is still in progress", acknowledgedFindings: { by: { kind: "agent", id: "lead-1", name: "Lead Sora" }, at: now, items: [
    { reviewId: "e38ff3c7-0000-4000-8000-000000000001", round: 2, index: 0, priority: 2, path: "core/src/example.rs", startLine: 430, endLine: 454,
      title: "Synthetic finding: old templates follow routing after upgrade", note: "Synthetic note: chosen in Q1",
      userReply: { key: "design/yn-example-q1", version: 3, question: "Synthetic question naming PR #14 and the finding", reply: "Synthetic reply: intended, release it", repliedAt: now } },
  ] } }),
  entry("e-stopped", 12, "stopped", { reason: "ci_red", detail: "Synthetic CI run 501 ended failure on the head" }),
  entry("e-done", 16, "done", {
    taskReference: "T-43",
    batch: { branch: "queue/merge-e-done", main: sha("b"), commit: sha("d"), tree: sha("e"), pr: 90, closed: true, deleted: true, cleanup: "done" },
    evidence: { gate: { kind: "batch", tree: sha("e"), runs: [{ workflow: "CI", run: 700, attempt: 1, conclusion: "success" }] } },
    merge: { expectedMain: sha("b"), tree: sha("e"), gate: "batch", head: sha("a"), attempts: 1, sha: sha("f"), mergedAt: now,
      post: { ok: true, commit: { sha: sha("f"), parents: [sha("b"), sha("a")], tree: sha("e") }, at: now }, mainCi: { run: 800, attempt: 1, conclusion: "success", url: "https://github.com/owner/repo/actions/runs/800" } },
  }),
];
const history = [
  { at: now, state: "queued", reason: null, detail: "released" },
  { at: now, state: "stopped", reason: "ci_red", detail: "Synthetic CI run 501 ended failure on the head" },
];
const CORE_DETAIL = "Synthetic main CI run 9001 failed on the main branch";
const REFUSAL = "merge_unpause_not_allowed: only a lead of a Project this repository is linked to, or the user, can unpause its merge queue";
const repositories = {
  7: { repositoryId: 7, enabled: true, landing: "core-merge", paused: { reason: "main_red", at: now, entryId: "e-stopped", number: 12, main: sha("c"), run: 9001, base: "main", detail: CORE_DETAIL }, pauses: [], switches: [] },
  8: { repositoryId: 8, enabled: false, paused: null, switches: [],
    pauses: [{ reason: "post_check_failed", at: now, number: 3, main: sha("c"), clearedAt: now, clearedBy: { by: "Lead Sora", actor: { kind: "agent", id: "lead-1", name: "Lead Sora" } }, acceptedRun: null }] },
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}${url.search}`);
  if (path === "/api/collaboration/github_repositories" && method === "POST")
    return route.fulfill({ json: { repositories: [{ id: 7, fullName: "owner/repo" }, { id: 8, fullName: "owner/other" }], links: [] } });
  if (path.startsWith("/api/agents/") && path.endsWith("/reading")) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.posts.push({ method, path, body: request.postDataJSON?.() ?? null });
    if (path === "/api/merge-queue/repositories/7/unpause") return route.fulfill({ status: 403, json: { error: REFUSAL } });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const one = /^\/api\/merge-queue\/(e-[a-z]+)$/.exec(path)?.[1];
  const repo = /^\/api\/merge-queue\/repositories\/(\d+)$/.exec(path)?.[1];
  const json = one ? { ...entries.find((e) => e.id === one), history }
    : repo ? repositories[repo]
    : {
      "/api/workspace": { workspace: { id: "ws-merge-queue" }, agents, projects: [project], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates,
      "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null }, "/api/jobs/live": { agents: {} },
      "/api/merge-queue": { entries },
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
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();
const setLanguage = (language) => other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
const queue = () => page.locator(".jobs-dialog .merge-queue");
const shot = (name) => page.screenshot({ path: join(output, name) });
const overflow = () => queue().evaluate((root) => {
  const edge = root.getBoundingClientRect().right + 1;
  return [...root.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > edge && el.getClientRects().length)
    .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`).slice(0, 10);
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator(".jobs-nav").waitFor({ timeout: 10_000 });
  await page.locator(".jobs-nav").click();
  await page.locator("#jobs-tab-merge_queue").click();
  await queue().locator(".job-row").first().waitFor({ timeout: 10_000 });
  await queue().locator(".merge-pause").waitFor({ timeout: 10_000 });

  // ---- In English.
  const tabs = await page.locator('.jobs-dialog [role="tab"]').allTextContents();
  assert.deepEqual(tabs.map((s) => s.replace(/\d+$/, "")), ["Local", "GitHub Actions", "Reviews", "Merge queue"]);
  const banner = await queue().locator(".merge-pause").textContent();
  assert.match(banner, /Paused: Main CI red/);
  assert.match(banner, /the entry for #12 · PR #12 · on main ccccccc/);
  assert.match(banner, /run 9001/);
  assert.match(banner, new RegExp(CORE_DETAIL));
  assert.match(banner, /Who can unpause: a lead of Synthetic project \(Lead Sora\), or you\./);
  assert.equal(await queue().locator('.merge-repository[aria-label="owner/repo"] .merge-landing').textContent(), "Core merges");
  assert.equal(await queue().locator('.merge-repository[aria-label="owner/other"] .merge-landing').count(), 0);
  const other8 = await queue().locator('.merge-repository[aria-label="owner/other"]').textContent();
  assert.match(other8, /Off: Core writes nothing to GitHub here/);
  assert.match(other8, /Last pause: Post-check failed, ended .* by Lead Sora/);
  const groups = await queue().locator(".job-group-title").allTextContents();
  assert.deepEqual(groups, ["Running and queued2", "Finished2"]);
  await queue().locator(".merge-pause .merge-link-button").click();
  await queue().locator(".job-detail h3", { hasText: "owner/repo #12" }).waitFor({ timeout: 10_000 });
  await queue().locator(".merge-history li").first().waitFor({ timeout: 10_000 });
  const detail = await queue().locator(".job-detail").textContent();
  assert.match(detail, /A check decided against\./);
  assert.match(detail, /Who can: the Agent that released it \(Dev Kai\), or you\./);
  assert.match(detail, /Retry/);
  assert.doesNotMatch(detail, /Cancel entry/);
  await shot("merge-queue-en-1280.png");
  check("in English: the source, the pause banner with who can unpause, the last pause, two groups, and the stopped entry with retry", { tabs, groups });

  // ---- Unpause: refused, Core's text shown.
  const unpause = queue().locator(".merge-pause .merge-action");
  await unpause.getByRole("button", { name: "Unpause" }).click();
  await unpause.locator("textarea").fill("Synthetic red run looked at");
  await unpause.getByRole("button", { name: "Unpause" }).click();
  await unpause.locator(".merge-refusal").waitFor({ timeout: 10_000 });
  assert.equal(await unpause.locator(".merge-refusal").textContent(), `Refused: ${REFUSAL}`);
  const posted = report.posts.filter((p) => p.path.includes("merge-queue"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, "/api/merge-queue/repositories/7/unpause");
  assert.equal(posted[0].body.reason, "Synthetic red run looked at");
  assert.match(posted[0].body.requestId, /^[0-9a-f-]{36}$/);
  await shot("merge-queue-refused-en-1280.png");
  check("unpause: the reason sent once to the unpause route with a request id; the refusal shown as Core wrote it", { posted });

  // ---- Changed to Chinese in another window.
  await setLanguage("zh-Hans");
  await page.locator("#jobs-tab-merge_queue", { hasText: "合并队列" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  assert.equal(await queue().getAttribute("lang"), "zh-Hans");
  const zhBanner = await queue().locator(".merge-pause").textContent();
  assert.match(zhBanner, /已暂停：主分支 CI 失败/);
  assert.equal(await queue().locator('.merge-repository[aria-label="owner/repo"] .merge-landing').textContent(), "由 Core 合并");
  assert.match(zhBanner, /可恢复者：Synthetic project 的负责人（Lead Sora），或你。/);
  assert.match(zhBanner, new RegExp(CORE_DETAIL), "Core's detail as it came");
  assert.equal(await unpause.locator(".merge-refusal span").textContent(), "已拒绝：只有关联此仓库的项目的负责人或用户，才能恢复它的合并队列。");
  assert.equal(await unpause.locator(".merge-refusal small").textContent(), REFUSAL, "Core's text as it came");
  const zhDetail = await queue().locator(".job-detail").textContent();
  assert.match(zhDetail, /某项检查判定不通过。/);
  assert.match(zhDetail, /可操作者：放行合并的 Agent（Dev Kai），或你。/);
  assert.match(zhDetail, /Synthetic CI run 501 ended failure on the head/, "Core's detail as it came");
  assert.deepEqual(await queue().locator(".job-group-title").allTextContents(), ["运行中与排队2", "已结束2"]);
  await shot("merge-queue-zh-1280.png");
  check("changed to Chinese in another window: the panel is Chinese; names, SHAs and Core's text as they came; the refusal said in Chinese beside Core's text");

  // ---- YN-67: a P2 the user accepted, on the entry that acknowledged it.
  const accepted = (label) => queue().locator(".job-detail dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await queue().locator(".job-row", { has: page.locator("strong", { hasText: "owner/repo #14" }) }).click();
  await queue().locator(".job-detail h3", { hasText: "owner/repo #14" }).waitFor({ timeout: 10_000 });
  await accepted("确认的发现").waitFor({ timeout: 10_000 });
  const zhAccepted = await accepted("确认的发现").textContent();
  assert.match(zhAccepted, /^Lead Sora 引用你的回复，确认 1 个 P2 是有意为之；审查轮的结论不变/);
  assert.match(zhAccepted, /P2 · core\/src\/example\.rs:430 · Synthetic finding: old templates follow routing after upgrade/);
  assert.match(zhAccepted, /第 2 轮 e38ff3c7 · 你在 design\/yn-example-q1 的回复.*：\s?“Synthetic reply: intended, release it”/);
  await accepted("确认的发现").screenshot({ path: join(output, "merge-queue-findings-zh-row.png") });
  await shot("merge-queue-findings-zh-1280.png");
  check("in Chinese: the entry's accepted P2 with its finding, round and the user's reply", { text: zhAccepted });

  // ---- Narrow: nothing wider than the panel.
  await setLanguage("en");
  await page.locator("#jobs-tab-merge_queue", { hasText: "Merge queue" }).waitFor({ timeout: 10_000 });
  await accepted("Findings accepted").waitFor({ timeout: 10_000 });
  const enAccepted = await accepted("Findings accepted").textContent();
  assert.match(enAccepted, /^1 P2 accepted as intended by Lead Sora, citing your reply; the review round's conclusion stays/);
  assert.match(enAccepted, /Round 2 e38ff3c7 · your reply to design\/yn-example-q1.*: “Synthetic reply: intended, release it”/);
  assert.match(enAccepted, /Synthetic note: chosen in Q1$/);
  await accepted("Findings accepted").screenshot({ path: join(output, "merge-queue-findings-en-row.png") });
  await shot("merge-queue-findings-en-1280.png");
  check("in English: the same row, and the panel with it open", { text: enAccepted });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  const wide = await overflow();
  assert.deepEqual(wide, [], "nothing in the panel is wider than it");
  await shot("merge-queue-en-420.png");
  check("at 420 px nothing in the panel is wider than the panel", { wide });

  assert.equal(report.posts.filter((p) => p.path.includes("merge-queue")).length, 1, "only the one unpause was sent");
  assert.deepEqual(report.posts.filter((p) => !p.path.includes("merge-queue") && !p.path.endsWith("/reading")), [], "nothing else sent");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(output, "check-report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
