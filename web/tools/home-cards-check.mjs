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
//  - the deck in its order (open Asks, current status, reports, Asks put off;
//    the answered Asks under their heading; status out of date last, closed),
//    and with no hole: every cell of its grid, and of Out of date's once
//    opened, is a card's (PR B; 1920 px too, where the deck has four columns);
//  - in Chinese, Enter sends a reply from Home as from the composer: Shift+Enter
//    makes a new line, Enter while an input method composes sends nothing (PR B);
//  - a card's HTML page and Home talk through the bridge (YN-16 S6): the page
//    gets Home's theme on its first load and again when it changes, sets its
//    frame's height, and its message, from a click in the real sandboxed
//    frame, is offered under it and sent to the section's author only on
//    Send; a message from another window (Home's own) is not offered;
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
const report = { task: "YN-3", runs: [], posts: [], replies: [], pageSends: [], previews: [], unexpected: [], errors: [] };
// A secure origin, as Core's own (localhost, or https on a tailnet): a reply needs crypto.randomUUID, which a
// browser gives only there. Every request is answered here; none leaves the browser.
const HOST = "localhost:47391";
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
// A single-file HTML page Core keeps (YN-3 C2): Core names its kind text.
const pageFile = (name) => ({ name, kind: "text", mime: "text/plain; charset=utf-8", size: 1536, snapshot: true, mayChange: false, takenAt: at(90) });
// The preview port Core gives cards (YN-10's card previews, as #679 builds them), here only this check's.
const PREVIEWS = "127.0.0.1:47390";
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
  section("ring", "report", "Ring design", spec({ summary: { lead: "lead" } }, ["lead", "files"], {
    lead: md("The ring design, working: drag a ring to see its clearance."),
    files: node("Attachments", { items: [{ name: "ring.html" }] }),
  }), { attachments: [pageFile("ring.html")] }),
  section("tokenizer", "ask", "Keep the old tokenizer?", spec({}, ["q"], { q: md("Old or new tokenizer for the rebuild?") }), {
    updatedAt: at(80),
    ask: { question: "Keep the old tokenizer until the rebuild?", state: "replied", repliedAt: at(60), replyText: "Keep it until the shard rebuild, then switch.", reply: { freeText: true } },
  }),
  section("progress", "status", "Current progress", spec({}, ["a"], { a: md("Week 44: the old plan.") }), {
    status: { asOf: at(3 * 24 * 60), validFor: 86400, stale: true },
  }),
  section("plan", "ask", "Which tokenizer plan?", spec({}, ["q"], { q: md("Plan A or B.") }), {
    ask: { question: "Plan A or B?", state: "open", deferredUntil: new Date(Date.now() + 86_400_000).toISOString(), reply: { freeText: true } },
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
  en: { viewImage: "View image", replied: "Replied · waiting for lead-1", updated: "Updated", replyAgain: "Reply again", openImage: "Open image loss.png", next: "Next: lead-1 acts on your reply",
    repliedGroup: "Replied, waiting · 2", outOfDate: /^Out of date · 1 status · newest data as of /,
    pageAsk: "ring.html asks to send this to lead-1, as your reply:", pageSend: "Send", pageDontSend: "Don't send", pageSent: "Sent to lead-1." },
  "zh-Hans": { viewImage: "查看图片", replied: "已回复 · 等 lead-1 处理", updated: "已更新", replyAgain: "再次回复", openImage: "打开图片 loss.png", next: "下一步：lead-1 按你的回复处理",
    repliedGroup: "已回复，等处理 · 2", outOfDate: /^已过期 · 1 个状态 · 最新数据 /,
    pageAsk: "ring.html 请求以你的回复发给 lead-1：", pageSend: "发送", pageDontSend: "不发", pageSent: "已发给 lead-1。" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const [name, viewport, phone] of [["1920", { width: 1920, height: 1100 }, false], ["1440", { width: 1440, height: 1000 }, false], ["820", { width: 820, height: 1100 }, false], ["phone-390", { width: 390, height: 844 }, true]])
    runs.push({ name: `${language}-${name}`, language, phone, viewport });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-cards-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads, and the replies sent by Enter");
assert.deepEqual(report.replies.map((r) => r.run), runs.filter((r) => r.language === "zh-Hans").map((r) => r.name), "one reply by Enter in each Chinese run");
assert.deepEqual(report.pageSends.map((r) => r.run), runs.map((r) => r.name), "one page message sent by Send in each run");
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
    // Yuzuno's page only: a card's sandboxed preview frame has no storage of its own to set (YN-3 C2).
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    // The window opens on trainer-2, whose request waits: no Turn end is shown first.
    if (!localStorage.getItem("yuzuno.selected.ws-cards")) localStorage.setItem("yuzuno.selected.ws-cards", JSON.stringify("t"));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host === PREVIEWS) {
      const token = url.pathname.match(/^\/v\/tok-(\w+)$/);
      if (token) return route.fulfill({
        status: 200, contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors http://${HOST}` },
        body: `<!doctype html><meta charset="utf-8"><title>Ring</title><style>body{font:15px system-ui,sans-serif;margin:12px;background:#f3efe3}</style>` +
          `<h1 id="ring">Ring design</h1><p id="ran">scripts did not run</p><p id="theme">no theme</p>` +
          `<button id="send" type="button">Send my ring size</button>` +
          `<script>document.getElementById("ran").textContent = "scripts ran in origin " + String(window.origin);` +
          // The bridge as brief_guide attachments shows it (YN-16 S6): the theme in, a height and a message out.
          `addEventListener("message", (e) => { if (e.data?.type !== "yuzuno:theme") return;` +
          ` for (const [name, value] of Object.entries(e.data.vars)) document.documentElement.style.setProperty(name, value);` +
          ` document.getElementById("theme").textContent = e.data.scheme + " " + e.data.vars["--paper"];` +
          ` document.body.dataset.themes = String(Number(document.body.dataset.themes || 0) + 1); });` +
          `addEventListener("load", () => parent.postMessage({ type: "yuzuno:height", px: 360 }, "*"));` +
          `document.getElementById("send").addEventListener("click", () => parent.postMessage({ type: "yuzuno:send", text: "Ring size 7, gold" }, "*"));</script>`,
      });
      const proof = url.pathname.match(/^\/\.well-known\/yuzuno-preview\/c-(\w+)$/);
      if (proof) return route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": `http://${HOST}` }, body: `a-${proof[1]}` });
    }
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    // The Project's linked repositories: a list read sent as a POST, which starts no sync (home-api.ts),
    // as home-ui.test.mjs counts it too.
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    // A reply sent from Home, which the check sends by Enter: answered as Core receives one.
    if (method === "POST" && path === "/api/projects/p-orch/brief/reply") {
      const body = JSON.parse(request.postData() || "{}");
      // A card page's message, sent by Send under its frame (YN-16 S6), apart from the replies sent by Enter.
      (String(body.text).startsWith("From the page ") ? report.pageSends : report.replies).push({ run: run.name, body });
      return route.fulfill({ json: { input: { ...body, expectedTurnId: null, question: null }, status: "accepted", turnId: "t-enter", error: null } });
    }
    if (method === "POST" && path === "/api/previews") {
      const body = JSON.parse(request.postData() || "{}");
      report.previews.push({ run: run.name, body });
      return route.fulfill({ json: {
        name: body.name, size: 1536, sha256: "a".repeat(64), takenAt: at(0), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        version: body.version, port: 47390, url: `http://${PREVIEWS}/v/tok-${body.section}`, place: "card", reused: false,
        proof: { challenge: `c-${body.section}`, answer: `a-${body.section}`, url: `http://${PREVIEWS}/.well-known/yuzuno-preview/c-${body.section}` },
      } });
    }
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
  const cardShot = async (key, name = key) => {
    const file = `${run.name}-${name}.png`;
    await card(key).scrollIntoViewIfNeeded();
    await card(key).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  // Where focus is, in words, for a check that it came back.
  const focusIs = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}` : null;
  });
  const focusBackOn = async (locator, what) => {
    const handle = await locator.elementHandle();
    await page.waitForFunction((el) => el === document.activeElement, handle, { timeout: 3000 }).catch(() => {});
    assert.ok(await locator.evaluate((el) => el === document.activeElement), `${what}: focus is on ${await focusIs()}`);
  };
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
    await page.locator(".home-needs-you").screenshot({ path: join(output, `${run.name}-needs-you.png`) });
    result.shots.push(`${run.name}-needs-you.png`);
    for (const key of ["loss", "eval", "notes"]) await cardShot(key);
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
    await focusBackOn(picture, "back on the picture after a click");
    await page.keyboard.press("Enter");
    await dialog.locator(".input-image-dialog img").waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    await focusBackOn(picture, "back on the picture after Enter");
    pass("the large card's image opens the viewer in place by a click and by Enter; Escape closes it, focus back");

    // ---- A small card's View image.
    const view = card("eval").locator("button.home-card-image-view");
    assert.equal((await view.innerText()).trim(), w.viewImage);
    await view.click();
    await dialog.locator(".input-image-dialog img").waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    await focusBackOn(view, "back on View image");
    pass("a small card's View image opens the same viewer; Escape, focus back");

    // ---- A card with no named summary: its first paragraph, and no more.
    assert.equal((await card("notes").locator(".home-summary-lead").innerText()).trim(),
      "The tokenizer drops one character in 0.02 % of lines; the fix lands with the next shard rebuild.");
    assert.doesNotMatch(await card("notes").innerText(), /No summary named|未指定摘要|Details follow|second paragraph/);
    pass("the card with no summary shows its first paragraph only");

    // ---- The deck: its order, the heading, Out of date closed at the end, and no hole (PR B).
    const deck = page.locator('[data-home-project="p-orch"] .home-brief').first();
    assert.deepEqual(await deck.locator("[data-section-key]").evaluateAll((els) => els.map((el) => el.dataset.sectionKey)),
      ["overnight", "release", "loss", "eval", "notes", "ring", "plan", "tokenizer", "draft", "progress"]);
    assert.equal(await deck.locator(":scope > .home-deck-heading").innerText(), w.repliedGroup);
    const closed = deck.locator(":scope > details.home-out-of-date");
    assert.equal(await closed.evaluate((el) => el.open), false, "out of date, closed");
    assert.match(await closed.locator("summary").innerText(), w.outOfDate);
    // Every cell of the grid, as laid out, is a card's, a heading's or Out of date's.
    const holes = (grid) => grid.evaluate((el) => {
      const style = getComputedStyle(el);
      const columns = style.gridTemplateColumns.split(" ").map(parseFloat), rows = style.gridTemplateRows.split(" ").map(parseFloat);
      const gapX = parseFloat(style.columnGap) || 0, gapY = parseFloat(style.rowGap) || 0;
      const box = el.getBoundingClientRect();
      const items = [];
      const walk = (parent) => {
        for (const child of parent.children)
          if (child.classList.contains("home-topic") || child.classList.contains("home-subs")) walk(child);
          else items.push(child.getBoundingClientRect());
      };
      walk(el);
      const missing = [];
      let y = box.top + (parseFloat(style.paddingTop) || 0);
      rows.forEach((height, row) => {
        let x = box.left + (parseFloat(style.paddingLeft) || 0);
        columns.forEach((width, column) => {
          const cx = x + width / 2, cy = y + height / 2;
          if (!items.some((r) => cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom)) missing.push([row + 1, column + 1]);
          x += width + gapX;
        });
        y += height + gapY;
      });
      return { columns: columns.length, rows: rows.length, missing };
    });
    const main = await holes(deck);
    assert.deepEqual(main.missing, [], `no hole in the deck: ${JSON.stringify(main)}`);
    await closed.locator("summary").click();
    await deck.locator(".home-brief-sub [data-section-key=\"progress\"]").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(150);
    const sub = await holes(deck.locator(".home-brief-sub"));
    assert.deepEqual(sub.missing, [], `no hole in Out of date: ${JSON.stringify(sub)}`);
    await deck.scrollIntoViewIfNeeded();
    await deck.screenshot({ path: join(output, `${run.name}-deck.png`) });
    result.shots.push(`${run.name}-deck.png`);
    await closed.locator("summary").click();
    pass("the deck in its order, the answered Asks under their heading, Out of date closed at the end; no hole in either", { columns: main.columns, rows: main.rows });

    // ---- A report whose substance is its HTML page (YN-3 C2): the page works on its card, asked for only
    // once the card is in view, in the Portal's sandbox (its script runs, in an opaque origin); the card is the whole report.
    {
      const ring = card("ring");
      const inView = await ring.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
      const asked = () => report.previews.filter((entry) => entry.run === run.name && entry.body.section === "ring");
      if (!inView) assert.equal(asked().length, 0, "not asked for before the card is in view");
      await ring.scrollIntoViewIfNeeded();
      const frame = ring.locator("iframe.home-card-page-frame");
      await frame.waitFor({ timeout: 15_000 });
      assert.deepEqual(asked().map((entry) => entry.body), [{ kind: "briefAttachment", projectId: "p-orch", section: "ring", name: "ring.html", version: 2, place: "card" }]);
      assert.deepEqual(await frame.evaluate((el) => [el.getAttribute("sandbox"), el.getAttribute("referrerpolicy"), el.getAttribute("allow")]), ["allow-scripts", "no-referrer", ""]);
      const inside = await (await frame.elementHandle()).contentFrame();
      await inside.waitForFunction(() => /scripts ran in origin/.test(document.getElementById("ran")?.textContent ?? ""), null, { timeout: 10_000 });
      assert.equal(await inside.locator("#ran").innerText(), "scripts ran in origin null", "its script runs, sandboxed");
      assert.equal(await ring.getAttribute("data-card-size"), "large");
      assert.equal(await ring.locator(".home-report-open").count(), 0, "the whole report: no Open report");
      assert.ok(await ring.locator(".home-card-page-large").isVisible(), "Open large");
      await page.waitForTimeout(200);
      await cardShot("ring", "page-card");
      pass("a report's HTML page works on its card once in view, sandboxed; the card is the whole report", { inView });
    }

    // ---- The page's bridge (YN-16 S6), in the real sandboxed frame: Home's theme on its first load and on a
    // change, the height it gives, and its message offered under it, sent to the section's author only on Send.
    {
      const ring = card("ring");
      const frame = ring.locator("iframe.home-card-page-frame");
      const inside = await (await frame.elementHandle()).contentFrame();
      const home = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
        paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() }));
      const before = await home();
      await inside.waitForFunction(() => document.body.dataset.themes === "1", null, { timeout: 10_000 });
      assert.equal(await inside.locator("#theme").innerText(), `${before.theme} ${before.paper}`, "Home's theme, as Home has it");
      assert.ok(before.paper, "a colour, not nothing");
      assert.equal(await inside.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()), before.paper, "the page uses it");
      await page.waitForFunction((el) => Math.round(el.getBoundingClientRect().height) === 360, await frame.elementHandle(), { timeout: 5_000 });
      // The theme changes: given again, at once; then back.
      const other = before.theme === "dark" ? "light" : "dark";
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, other);
      await inside.waitForFunction(() => document.body.dataset.themes === "2", null, { timeout: 5_000 });
      const changed = await home();
      assert.notEqual(changed.paper, before.paper);
      assert.equal(await inside.locator("#theme").innerText(), `${other} ${changed.paper}`);
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, before.theme);
      await inside.waitForFunction(() => document.body.dataset.themes === "3", null, { timeout: 5_000 });
      // A message from another window (Home's own) is not this page's: nothing offered.
      const bar = ring.locator(".home-page-send");
      await page.evaluate(() => window.postMessage({ type: "yuzuno:send", text: "from Home's own window" }, "*"));
      await page.waitForTimeout(200);
      assert.equal(await bar.count(), 0, "another window's message is not offered");
      const sends = () => report.pageSends.filter((entry) => entry.run === run.name);
      // The page's own message: offered, Don't send sends nothing; offered again, Send sends it.
      await inside.locator("#send").click();
      await bar.waitFor({ timeout: 5_000 });
      assert.equal(await bar.locator(".home-page-send-head").innerText(), w.pageAsk);
      assert.equal(await bar.locator(".home-page-send-text").innerText(), "Ring size 7, gold");
      await bar.getByRole("button", { name: w.pageDontSend }).click();
      await bar.waitFor({ state: "detached", timeout: 5_000 });
      assert.equal(sends().length, 0, "nothing sent without Send");
      await inside.locator("#send").click();
      await bar.waitFor({ timeout: 5_000 });
      // Send waits until the message has been shown a second (S6 R1 P2); the click below waits for it.
      const armed = await bar.getByRole("button", { name: w.pageSend, exact: true }).isDisabled();
      const buttons = await bar.locator("button").evaluateAll((list) => list.map((b) => Math.round(b.getBoundingClientRect().height)));
      if (run.phone) assert.ok(buttons.every((h) => h >= 40), `buttons 40 px tall on a phone: ${buttons}`);
      await ring.scrollIntoViewIfNeeded();
      await cardShot("ring", "page-message");
      await bar.getByRole("button", { name: w.pageSend, exact: true }).click();
      await bar.getByText(w.pageSent).waitFor({ timeout: 5_000 });
      assert.deepEqual(sends().map(({ body: { key, agentId, text, version, title } }) => ({ key, agentId, text, version, title })),
        [{ key: "ring", agentId: "l", text: "From the page “ring.html”:\n\nRing size 7, gold", version: 2, title: "Ring design" }]);
      assert.equal(await page.locator(".home-report").count(), 0, "the report page is not opened");
      assert.ok(armed, "Send was disabled as the message was first shown");
      pass("a card's page gets Home's theme and gives its height; its message goes to the section's author only on Send; another window's is not offered",
        { theme: before.theme, paper: before.paper, other: changed.paper, buttons, sendDisabledWhenShown: armed });
    }

    // ---- Answered Asks are answer cards (YN-3, the user's D3): small cards the deck packs, two sharing a row;
    // whom each waits for, its title, the reply quoted (three lines at most), who acts next or its owner's update.
    const answers = {};
    for (const key of ["tokenizer", "draft"]) {
      answers[key] = await card(key).evaluate((el) => {
        const quote = el.querySelector(".home-answer-reply");
        const line = quote ? parseFloat(getComputedStyle(quote).lineHeight) || 20 : 0;
        const box = el.getBoundingClientRect();
        return { answer: el.classList.contains("is-answer"), size: el.dataset.cardSize ?? null, cols: el.dataset.deckCols ?? null,
          kind: el.querySelector(".home-kind")?.textContent.trim(), changed: el.querySelector(".home-changed")?.textContent.trim() ?? null,
          title: el.querySelector(".home-answer-title h3")?.textContent ?? null, reply: quote?.textContent ?? null,
          quoteLines: quote ? Math.round(quote.clientHeight / line) : null,
          next: el.querySelector(".home-answer-next")?.textContent ?? null, update: el.querySelector(".home-answer-update")?.textContent ?? null,
          top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
      });
    }
    // Pictured before the rules below, so a failure still shows the cards.
    await cardShot("tokenizer", "answer-card");
    await cardShot("draft", "answer-card-updated");
    const sharing = main.columns >= 2 ? String(main.columns / 2) : "1";
    for (const key of ["tokenizer", "draft"]) {
      const a = answers[key];
      assert.ok(a.answer && a.size === "small", `${key}: an answer card, small: ${JSON.stringify(a)}`);
      assert.equal(a.kind, w.replied);
      assert.equal(a.cols, sharing, `${key}: ${main.columns} columns, two answer cards share the row: ${JSON.stringify(a)}`);
      assert.ok(a.quoteLines <= 3, `${key}: the reply in three lines at most: ${JSON.stringify(a)}`);
    }
    if (main.columns >= 2) assert.equal(answers.tokenizer.top, answers.draft.top, "side by side");
    assert.equal(answers.tokenizer.changed, null, "answered, not New");
    assert.equal(answers.draft.changed, w.updated, "changed by its owner after the reply: Updated");
    assert.match(answers.tokenizer.reply, /Keep it until the shard rebuild, then switch\.$/);
    assert.equal(answers.tokenizer.next, w.next);
    assert.ok(answers.draft.update && answers.draft.next === null, "its owner's update in place of who acts next");
    // Opened: the question and details, its row its own; the other takes the row it is left alone on; still no hole.
    const tokenizer = card("tokenizer");
    await tokenizer.locator(".home-answer-details").click();
    await tokenizer.locator(".home-card-body .home-question").waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => {
      const grid = document.querySelector('[data-home-project="p-orch"] .home-brief');
      const draft = document.querySelector("#home-section-p-orch-draft");
      return grid && draft && Math.abs(draft.getBoundingClientRect().width - (grid.clientWidth - parseFloat(getComputedStyle(grid).paddingLeft || 0) - parseFloat(getComputedStyle(grid).paddingRight || 0))) < 4;
    }, null, { timeout: 5000 }).catch(() => {});
    const opened = await holes(deck);
    assert.deepEqual(opened.missing, [], `no hole with an answer card open: ${JSON.stringify(opened)}`);
    await cardShot("tokenizer", "answer-open");
    // Reply again, on the card: the reply field, in the card.
    await tokenizer.locator(".home-answer-again").click();
    await tokenizer.locator(".home-card-body textarea").waitFor({ timeout: 10_000 });
    await cardShot("tokenizer", "answer-again");
    await tokenizer.locator(".home-answer-details").click();
    await tokenizer.locator(":scope > .home-card-body").waitFor({ state: "hidden", timeout: 10_000 });
    pass("answered Asks are small answer cards sharing a row: the reply quoted, who acts next or the owner's update, Updated only after the owner's change; opened, its own row with no hole; Reply again on the card", answers);

    // ---- Enter sends a reply from Home, in Chinese (the user's item): Shift+Enter a new line, nothing while composing.
    if (run.language === "zh-Hans") {
      const field = card("overnight").locator("textarea").first();
      await field.scrollIntoViewIfNeeded();
      await field.fill("好的，今晚跑");
      await field.press("Shift+Enter");
      assert.match(await field.inputValue(), /\n$/, "Shift+Enter makes a new line");
      await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
      await page.waitForTimeout(250);
      const mine = () => report.replies.filter((r) => r.run === run.name);
      assert.equal(mine().length, 0, "neither Shift+Enter nor Enter while composing sends");
      await field.press("Enter");
      for (let tries = 0; tries < 40 && mine().length === 0; tries++) await page.waitForTimeout(125);
      assert.equal(mine().length, 1, "Enter sends");
      assert.equal(mine()[0].body.text, "好的，今晚跑");
      await cardShot("overnight", "enter-sent");
      pass("Enter sends a reply from Home; Shift+Enter makes a new line; Enter while composing sends nothing");
    }
  } finally {
    await context.close();
  }
}
