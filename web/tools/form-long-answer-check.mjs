// YN-103: a form's text answer takes a long paste as the conversation's
// composer does. In a real browser against the production bundle, pasted
// from the clipboard as a person pastes, with an explicit API fixture: no
// Core, no Agent, nothing sent but the answers these checks send on purpose.
//   - In a conversation's form and in a Home ask's form, a 481-line paste
//     folds into one block that fits the form: neither the block nor the
//     field widens it, and the page does not scroll sideways.
//   - The answers sent carry the paste whole.
//   - Answers too long for one message (100,000 bytes, Core's) say how far
//     over and hold Submit answers.
// On a 1440px desktop window and a 390px phone.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/form-long-answer-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_CHECK_OUTPUT, "Say where the report and screenshots go");
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT);
await mkdir(output, { recursive: true });
// https, so the page is a secure context: a reply needs crypto.randomUUID.
const HOST = "yuzuno-form-long-answer.test";
const report = { task: "YN-103", checks: [], failures: [], writes: [], shots: [], errors: [] };

/** A pasted review: 481 lines, CRLF endings, tabs, quotes, a backslash and Chinese. */
const LONG = Array.from({ length: 481 }, (_, n) => `${n + 1}\t"评审" 第 ${n + 1} 行：C:\\work\\round-28 looks fine to me`).join("\r\n");
/** 100,200 bytes: more than one message takes, before the answers' own words. */
const OVER = "长".repeat(33_400);

const form = {
  id: "round",
  title: "After round 28",
  description: "I won't start the next round on my own.",
  fields: [
    { id: "next", type: "single", label: "Next step", required: true, options: [
      { id: "plan", label: "Write the plan" }, { id: "wait", label: "Wait for me" }, { id: "stop", label: "Stop here" }] },
    { id: "review", type: "text", label: "Codex review", required: false, placeholder: "Paste Codex's review of round 28" },
    { id: "note", type: "text", label: "Note", required: false },
  ],
};
const spec = { root: "result", elements: {
  result: { type: "Result", props: { title: "Round 28", summary: "Choose what happens next." }, children: ["form"] },
  form: { type: "Clarification", props: form },
} };
const agent = { id: "a", name: "Mori", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage", projectId: "p1",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const projects = [{ id: "p1", name: "Research", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Round 28 is done. What next?" }] },
  { id: "m1", type: "agentMessage", text: "Here is what I need from you before round 29." },
], _yuzunoResults: [{ id: "r1", chainId: "c1", version: 1, createdAt: "2026-11-13T09:00:00Z" }] }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const section = { key: "after", kind: "ask", title: "After round 28", version: 1, owner, updatedAt: new Date().toISOString(), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: [] } } },
  ask: { question: "What next after round 28?", state: "open", reply: { form } } };
const home = () => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Research" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], brief: { version: 3, sections: [section], history: [] }, unseen: 1, missing: [],
  }],
});

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, lang }) {
  const writes = [];
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.addInitScript(({ lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    // The conversation open: chosen per Workspace (T-195), this fixture's is "ws".
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    localStorage.setItem("yuzuno.selected.ws", JSON.stringify("a"));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  }, { lang });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() !== "GET") {
      const sent = JSON.parse(route.request().postData() || "{}");
      writes.push({ path, body: sent });
      if (path === "/api/agents/a/messages" || path === "/api/projects/p1/brief/reply")
        return route.fulfill({ json: { input: { ...sent, text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "t2", error: null } });
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/agents/a") return route.fulfill({ json: { agent, pending: [], artifacts: [], turns, messageReceipts: [] } });
    if (path === "/api/agents/a/results/r1") return route.fulfill({ json: { id: "r1", spec } });
    if (path === "/api/agents/a/reading") return route.fulfill({ json: { handoff: null } });
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
      return route.fulfill({ body: await readFile(resolve(dist, "index.html")), contentType: "text/html" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`https://${HOST}/`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, writes };
}

/** The conversation's form, opened from the Agent's row when the layout needs it. */
async function conversationForm(page) {
  const form = page.locator(".turn-results .clarification, .clarification").first();
  try {
    await form.waitFor({ timeout: 4_000 });
  } catch {
    // A phone shows one pane: back to the list first, unless it is the list.
    if ((await page.locator(".phone-back").count()) && !(await page.locator(".app.phone-list").count()))
      await page.locator(".phone-back").first().click();
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    await form.waitFor({ timeout: 10_000 });
  }
  return form;
}
/** Home's ask form, on its project's page (YN-86: the whole of Home shows each project at a glance). */
async function homeForm(page) {
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  const open = page.locator('[data-glance-project="p1"] .project-glance-open').first();
  await open.waitFor({ timeout: 10_000 });
  await open.click();
  const card = page.locator('[data-project-home="p1"] [data-section-key="after"]').first();
  await card.waitFor({ timeout: 10_000 });
  const form = card.locator(".clarification");
  await form.waitFor({ timeout: 10_000 });
  return form;
}
const field = (form, label) => form.locator(`[data-composer-input][aria-label="${label}"]`);
/** Pasted from the clipboard into a field, as a person pastes. */
async function paste(page, target, text) {
  await target.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(250);
}
/** How far the block, the field, the form and the page reach past what holds them, in px. */
const overflow = (form) =>
  form.evaluate((el) => {
    const right = (node) => node.getBoundingClientRect().right;
    const chip = el.querySelector(".pasted-text-chip");
    const box = el.querySelector(".home-composer");
    return {
      chip: chip ? right(chip) - right(box) : null,
      field: right(box) - right(el),
      form: el.scrollWidth - el.clientWidth,
      page: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  });
async function sentWrite(page, writes, path, count) {
  const deadline = Date.now() + 10_000;
  while (writes.filter((w) => w.path === path).length < count && Date.now() < deadline) await page.waitForTimeout(50);
  const all = writes.filter((w) => w.path === path);
  assert.equal(all.length, count, `${path}: writes`);
  return all.at(-1).body;
}
async function shoot(locator, name) {
  const shot = `${output}/${name}.png`;
  await locator.screenshot({ path: shot });
  report.shots.push(shot);
}
/** A check that fails is reported and the next one still runs. */
async function check(name, fn) {
  try {
    report.checks.push({ name, ...(await fn()) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: error.message });
    console.log(`FAIL ${name}\n  ${error.message.split("\n").join("\n  ")}`);
  }
}
async function foldsAndFits(page, form, view, where) {
  const review = field(form, "Codex review");
  await paste(page, review, LONG);
  const chip = form.locator(".pasted-text-chip");
  await chip.waitFor({ timeout: 5_000 });
  assert.equal(await chip.count(), 1, "one block");
  const label = await chip.getAttribute("aria-label");
  assert.match(label, view.lang === "zh" ? /481 行。查看并编辑$/ : /481 lines\. View and edit$/);
  const reach = await overflow(form);
  assert.ok(reach.chip <= 1 && reach.field <= 1 && reach.form <= 1 && reach.page <= 1, `nothing reaches past the form: ${JSON.stringify(reach)}`);
  await shoot(form, `${where}-block-${view.name}`);
  return { label, reach };
}

try {
  for (const view of [
    { name: "desktop-1440-en", width: 1440, height: 1000, touch: false, lang: "en" },
    { name: "phone-390-zh", width: 390, height: 844, touch: true, lang: "zh" },
  ]) {
    const { context, page, writes } = await open(view);
    try {
      await check(`${view.name}: the conversation's form folds a 481-line paste into one block that fits, and sends it whole`, async () => {
        const form = await conversationForm(page);
        const shown = await foldsAndFits(page, form, view, "conversation");
        await form.locator('input[value="plan"]').check();
        await form.locator("footer .primary-button").click();
        const sent = await sentWrite(page, writes, "/api/agents/a/messages", 1);
        assert.ok(sent.clarification?.answers?.review === LONG, "the answer is the paste, whole");
        return { ...shown, sentBytes: new TextEncoder().encode(sent.text).length };
      });
      await check(`${view.name}: Home's ask form folds a 481-line paste into one block that fits, and sends it whole`, async () => {
        const form = await homeForm(page);
        const shown = await foldsAndFits(page, form, view, "home-ask");
        await form.locator('input[value="plan"]').check();
        await form.locator("footer .primary-button").click();
        const sent = await sentWrite(page, writes, "/api/projects/p1/brief/reply", 1);
        assert.ok(sent.form?.answers?.review === LONG, "the answer is the paste, whole");
        return { ...shown, sentBytes: new TextEncoder().encode(sent.text).length };
      });
      await check(`${view.name}: answers too long for one message say how far over and hold Submit answers`, async () => {
        // Read afresh: the form unsent, its earlier answers kept as its draft.
        await page.goto(`https://${HOST}/`);
        const form = await conversationForm(page);
        const count = writes.filter((w) => w.path === "/api/agents/a/messages").length;
        await paste(page, field(form, "Note"), OVER);
        const note = form.locator(".home-reply-length[data-over]");
        await note.waitFor({ timeout: 5_000 });
        assert.match(await note.textContent(), view.lang === "zh" ? /^超出 [\d,]+ 字节，发不出去：这些答案作为一条消息发送，最多 100,000 字节/ : /^[\d,]+ bytes too long to send: these answers go as one message of at most 100,000 bytes/);
        assert.ok(await form.locator("footer .primary-button").isDisabled(), "Submit answers is held");
        const reach = await overflow(form);
        assert.ok(reach.form <= 1 && reach.page <= 1, `nothing reaches past the form: ${JSON.stringify(reach)}`);
        await shoot(form, `conversation-over-limit-${view.name}`);
        await page.waitForTimeout(300);
        assert.equal(writes.filter((w) => w.path === "/api/agents/a/messages").length, count, "nothing sent");
        return { note: await note.textContent() };
      });
    } finally {
      report.writes.push(...writes.map((write) => ({ view: view.name, path: write.path, characters: write.body.text?.length })));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} passed, ${report.failures.length} failed, ${report.shots.length} screenshots in ${output}`);
assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
assert.equal(report.failures.length, 0, `${report.failures.length} checks failed`);
