// YN-3 PR A in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, at 1440 px, 820 px and a
// phone (390 px), in English and in Simplified Chinese:
//  - Needs you lists only what waits for the user's decision (a request, an
//    open Ask, an executor's result): no Turn that ended unseen, which the
//    Agent list marks instead; the tab title counts the same rows;
//  - a large card's kept image opens the image viewer on Home by a click and
//    by Enter, Escape closes it and focus goes back to the picture; a small
//    card's View image opens it too;
//  - a card whose author named no summary shows its first paragraph;
//  - a replied Ask is one line with its reply in short, never New; unfolded,
//    its reply and Reply again;
//  - nothing is wider than the window, and nothing is sent but reads.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-cards-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-3", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "yuzuno-cards.test";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// A synthetic plot (a falling line on a light ground), as a kept snapshot.
const PNG = (() => {
  const [width, height] = [640, 400];
  const crc = (bytes) => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 0xf4);
    for (let x = 0; x < width; x++) {
      const curve = Math.round(60 + 280 * Math.exp(-x / 160));
      if (Math.abs(y - curve) < 3) row.set([0xd0, 0x7a, 0x1e], 1 + x * 3);
      else if (x % 80 === 0 || y % 80 === 0) row.set([0xdd, 0xd6, 0xca], 1 + x * 3);
    }
    row[0] = 0;
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
})();

const base = { harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/orchard", projectId: "p-orch" };
const ended = (seq, outcome) => ({ lastTurnEnd: { seq, outcome, at: at(4) }, reviewedSeq: seq - 5 });
const agents = [
  // Their last Turns ended after they were read: finished (a CI run's mail, say) and failed.
  { ...base, id: "l", name: "lead-1", ...ended(30, "finished") },
  { ...base, id: "r", name: "runner-3", status: "error", ...ended(24, "failed") },
  { ...base, id: "t", name: "trainer-2", status: "waiting", pendingCount: 1 },
  { ...base, id: "x", name: "YN-7 executor" },
];
const projects = [{ id: "p-orch", name: "orchard-sim", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (props, top, elements) => ({ root: "body", elements: { body: node("BriefBody", props, top), ...elements } });
const shot = (name, caption) => ({ name, kind: "image", mime: "image/png", size: PNG.length, snapshot: true, mayChange: false, takenAt: at(90), caption, width: 640, height: 400 });
let id = 100;
const section = (key, kind, title, body, extra = {}) => ({ id: id++, key, kind, title, version: 2, owner: owner("l", "lead-1"), updatedAt: at(30),
  updatedTurnId: "t1", body, attachments: [], refs: {}, seen: null, history: false, ...extra });
const sections = [
  section("overnight", "ask", "Run the 7B baseline overnight?", spec({}, ["q"], { q: md("The queue is free after 22:00.") }), {
    ask: { question: "Run the 7B baseline overnight?", state: "open", reply: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "Not tonight" }], freeText: true } },
  }),
  section("release", "status", "Release train", spec({ summary: { lead: "lead", visual: "m", size: "wide" } }, ["lead", "m"], {
    lead: md("Two changes wait for main; main CI is green."),
    m: node("Metrics", { items: [{ label: "Waiting", value: 2, unit: "PRs" }, { label: "main CI", value: "green" }, { label: "Queue", value: 1 }] }),
  }), { status: { asOf: at(20), validFor: 86400, stale: false } }),
  section("loss", "report", "Loss curve v3", spec({ summary: { lead: "lead", visual: "files", size: "large" } }, ["lead", "files"], {
    lead: md("Converges by step 40k; the seed spread is ±0.8 %."),
    files: node("Attachments", { items: [{ name: "loss.png", caption: "Loss by step, three seeds" }] }),
  }), { attachments: [shot("loss.png", "Loss by step, three seeds")] }),
  section("eval", "report", "Eval screenshot", spec({ summary: { lead: "lead", visual: "files", size: "small" } }, ["lead", "files"], {
    lead: md("The eval page after the fix."),
    files: node("Attachments", { items: [{ name: "eval.png" }] }),
  }), { attachments: [shot("eval.png")] }),
  section("notes", "report", "Field notes", spec({}, ["a", "b"], {
    a: md("The tokenizer drops one character in 0.02 % of lines; the fix lands with the next shard rebuild.\n\nDetails follow."),
    b: md("A second paragraph the card never shows."),
  })),
  section("tokenizer", "ask", "Keep the old tokenizer?", spec({}, ["q"], { q: md("Old or new tokenizer for the rebuild?") }), {
    updatedAt: at(80),
    ask: { question: "Keep the old tokenizer until the rebuild?", state: "replied", repliedAt: at(60), replyText: "Keep it until the shard rebuild, then switch.", reply: { freeText: true } },
  }),
  section("draft", "ask", "Publish the 0.4 draft?", spec({}, ["q"], { q: md("Draft notes are written; CI pending.") }), {
    updatedAt: at(5),
    ask: { question: "Publish the 0.4 draft once CI is green?", state: "replied", repliedAt: at(40), replyText: "Yes, once main CI is green.", reply: { freeText: true } },
  }),
];
const home = () => ({
  generatedAt: at(0),
  order: ["p-orch"],
  needsYou: [
    { kind: "ask", projectId: "p-orch", agentId: "l", agentName: "lead-1", sectionKey: "overnight", title: "Run the 7B baseline overnight?", since: at(30) },
    { kind: "approval", projectId: "p-orch", agentId: "t", agentName: "trainer-2", requestId: "r-1", title: "Run the eval script", since: at(10) },
    { kind: "executor", projectId: "p-orch", agentId: "x", agentName: "YN-7 executor", state: "delivering", taskId: "YN-7", title: "Shard rebuild", since: at(6) },
  ],
  projects: [{
    project: { id: "p-orch", name: "orchard-sim" }, agents: { working: 0, idle: 3, waiting: 1, error: 0, offline: 0, total: 4 },
    errors: [], pending: [{ id: "r-1", agentId: "t", agentName: "trainer-2", method: "item/commandExecution/requestApproval", params: { command: "python eval.py", reason: "Run the eval script" }, createdAt: at(10) }],
    jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { viewImage: "View image", replied: "Replied · waiting for lead-1", updated: "Updated", replyAgain: "Reply again", openImage: "Open image loss.png" },
  "zh-Hans": { viewImage: "查看图片", replied: "已回复 · 等 lead-1 处理", updated: "已更新", replyAgain: "再次回复", openImage: "打开图片 loss.png" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const [name, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["820", { width: 820, height: 1100 }, false], ["phone-390", { width: 390, height: 844 }, true]])
    runs.push({ name: `${language}-${name}`, language, phone, viewport });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-cards-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`home-cards-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

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
    // The window opens on trainer-2, whose request waits: no Turn end is shown first.
    if (!localStorage.getItem("yuzuno.selected.ws-cards")) localStorage.setItem("yuzuno.selected.ws-cards", JSON.stringify("t"));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method !== "GET") {
      // Marking a conversation read is a read receipt, not a change to Home.
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    if (/^\/api\/projects\/p-orch\/brief\/attachments\/[^/]+\/[^/]+\.png$/.test(path)) return route.fulfill({ body: PNG, contentType: "image/png" });
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-cards" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
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
  const shotAs = async (name) => {
    const file = `${run.name}-${name}.png`;
    await page.screenshot({ path: join(output, file), fullPage: name === "home" });
    result.shots.push(file);
  };
  const card = (key) => page.locator(`#home-section-p-orch-${key}`);
  try {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await card("loss").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".home-card-frame img")].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15_000 });
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language, "Home in the chosen language");

    // ---- Needs you: decisions only; the Agent list marks the Turns that ended unseen.
    const needs = page.locator(".home-needs-you");
    assert.deepEqual(await needs.locator("[data-needs-you]").evaluateAll((items) => items.map((i) => i.dataset.needsYou)),
      ["ask:p-orch:overnight", "approval:r-1", "executor:x:delivering"]);
    assert.equal(await needs.locator("[data-unseen]").count(), 0, "no Turn end in Needs you");
    assert.equal(await needs.locator("h2 .nav-count").innerText(), "3");
    assert.match(await page.title(), /^\(3\) /, "the tab title counts the same rows");
    const marks = await page.locator(".agent-row").evaluateAll((rows) => Object.fromEntries(rows.map((row) => [row.dataset.agentId, row.querySelector(".agent-runtime")?.className.match(/unseen-(\w+)/)?.[1] ?? null])));
    if (!run.phone) assert.deepEqual([marks.l, marks.r], ["finished", "failed"], "the Agent list marks them");
    pass("Needs you lists the Ask, the request and the executor's result, no Turn end; the title counts 3; the Agent list marks the ends", { marks });

    // ---- No horizontal overflow; the whole Home.
    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    await shotAs("home");
    pass("nothing wider than the window", widths);

    // ---- A large card's image: a click and Enter open the viewer on Home; Escape closes it; focus goes back.
    const picture = card("loss").locator("button.home-card-image-open");
    assert.equal(await picture.getAttribute("aria-label"), w.openImage);
    const dialog = page.locator('[role="dialog"]');
    await picture.scrollIntoViewIfNeeded();
    await picture.click();
    await dialog.locator(".input-image-dialog img").waitFor({ timeout: 10_000 });
    assert.match(await dialog.locator(".input-image-dialog img").getAttribute("src"), /\/attachments\/loss\/loss\.png\?version=2$/);
    assert.equal(await page.locator(".home-report").count(), 0, "not the report page");
    await page.waitForTimeout(300);
    await shotAs("viewer");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    assert.ok(await picture.evaluate((el) => el === document.activeElement), "focus back on the picture");
    await page.keyboard.press("Enter");
    await dialog.locator(".input-image-dialog img").waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    assert.ok(await picture.evaluate((el) => el === document.activeElement), "focus back after Enter too");
    pass("the large card's image opens the viewer in place by a click and by Enter; Escape closes it, focus back");

    // ---- A small card's View image.
    const view = card("eval").locator("button.home-card-image-view");
    assert.equal((await view.innerText()).trim(), w.viewImage);
    await view.click();
    await dialog.locator(".input-image-dialog img").waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    pass("a small card's View image opens the same viewer");

    // ---- A card with no named summary: its first paragraph, and no more.
    assert.equal((await card("notes").locator(".home-summary-lead").innerText()).trim(),
      "The tokenizer drops one character in 0.02 % of lines; the fix lands with the next shard rebuild.");
    assert.doesNotMatch(await card("notes").innerText(), /No summary named|未指定摘要|Details follow|second paragraph/);
    pass("the card with no summary shows its first paragraph only");

    // ---- Replied Asks: one line each, the reply in short, never New; unfolded, the reply and Reply again.
    const rows = {};
    for (const key of ["tokenizer", "draft"]) {
      const row = card(key);
      rows[key] = await row.evaluate((el) => ({ short: el.classList.contains("is-short"), height: Math.round(el.getBoundingClientRect().height),
        kind: el.querySelector(".home-kind")?.textContent.trim(), changed: el.querySelector(".home-changed")?.textContent.trim() ?? null,
        reply: el.querySelector(".home-replied-short")?.textContent ?? null,
        cut: (() => { const r = el.querySelector(".home-replied-short"); return r ? r.scrollWidth > r.clientWidth : null; })() }));
      assert.ok(rows[key].short, `${key}: one line`);
      assert.equal(rows[key].kind, w.replied);
      assert.ok(rows[key].height <= (run.phone ? 96 : 56), `${key}: ${rows[key].height} px`);
    }
    assert.equal(rows.tokenizer.changed, null, "answered, not New");
    assert.equal(rows.draft.changed, w.updated, "changed by its owner after the reply: Updated");
    assert.equal(rows.tokenizer.reply, "Keep it until the shard rebuild, then switch.");
    const tokenizer = card("tokenizer");
    await tokenizer.locator(".home-fold").click();
    await tokenizer.locator(".home-ask-replied").waitFor({ timeout: 10_000 });
    assert.ok(await tokenizer.getByRole("button", { name: w.replyAgain }).isVisible());
    await tokenizer.scrollIntoViewIfNeeded();
    await shotAs("replied");
    await tokenizer.locator(".home-fold").click();
    pass("replied Asks are one line, the reply in short, Updated only after the owner's change; unfolded, Reply again", rows);
  } finally {
    await context.close();
  }
}
