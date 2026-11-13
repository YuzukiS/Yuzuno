// YN-91: a long paste into a Home reply goes to the Agent whole. In a real
// browser against the production bundle, pasted from the clipboard as a
// person pastes, with an explicit API fixture: no Core, no Agent, nothing
// sent but the replies these checks make on purpose.
//   - A report card's reply takes a 25,000-character paste whole: a field
//     that stopped at 20,000 characters cut it short and said nothing.
//   - A long paste folds into a block, as in the conversation's composer: it
//     opens with its whole text, to read and edit, and is removed.
//   - A paste over the limit (92,000 bytes, Core's) says how far over and
//     why, holds Send, and keeps every character.
//   - An Ask's free text takes 8,000 Chinese characters (24,000 bytes) whole.
// On a desktop window and a 390px phone.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/home-long-reply-check.mjs
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
const HOST = "yuzuno-home-long-reply.test";
const report = { task: "YN-91", checks: [], failures: [], writes: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

/** Longer than the 20,000 characters a reply field stopped at. */
const LONG = `${"Pasted log line 0123456789 abcdefghij\n".repeat(650)}end`;
/** 8,000 Chinese characters: 24,000 bytes. */
const CHINESE = "长".repeat(8_000);

const now = Date.now();
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] },
  text: { type: "Markdown", props: { text } },
} });
const section = (key, kind, title, version, extra = {}) => ({
  key, kind, title, version, owner, updatedAt: new Date(now - 20 * 60_000).toISOString(), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false, body: body(`${title}: what the author wrote.`), ...extra,
});
const template = () => [
  section("words", "ask", "Anything before we ship?", 1, { ask: { question: "Anything before we ship?", state: "open", reply: { freeText: true } } }),
  section("notes", "report", "Notes", 2),
];
const home = (sections) => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: 9, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, lang }) {
  const sections = template();
  const writes = [];
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.addInitScript(({ lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  }, { lang });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== "GET") {
      const sent = JSON.parse(route.request().postData() || "{}");
      writes.push({ path, body: sent });
      if (path === "/api/projects/p1/brief/reply") {
        const shown = sections.find((s) => s.key === sent.key);
        if (shown?.ask) shown.ask = { ...shown.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: sent.text.slice(0, 2000) };
        return route.fulfill({ json: { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "mori-t2", error: null } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/home") return route.fulfill({ json: home(sections) });
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
  await page.locator('[data-section-key="notes"]').first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, writes, sections };
}

const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();
const replies = (writes) => writes.filter((w) => w.path.endsWith("/brief/reply")).map((w) => w.body);
const FIELD = ".home-text-reply textarea, .home-text-reply [data-composer-input]";
/** Pasted from the clipboard into the reply's field, as a person pastes. */
async function paste(page, box, text) {
  await box.locator(FIELD).first().click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);
}
/** What a plain field holds after the paste; null for the composer, whose blocks hold it. */
const plainValue = (box) =>
  box.locator(FIELD).first().evaluate((el) => (el instanceof HTMLTextAreaElement ? el.value : null));
async function sent(page, writes, count) {
  const deadline = Date.now() + 10_000;
  while (replies(writes).length < count && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(replies(writes).length, count, "replies sent");
  await page.waitForTimeout(300);
}
async function shoot(locator, name) {
  const shot = `${output}/${name}.png`;
  await locator.screenshot({ path: shot });
  report.shots.push(shot);
}
/** A check that fails is reported and the next one still runs. */
async function check(name, fn) {
  try {
    record(name, await fn());
  } catch (error) {
    report.failures.push({ name, error: error.message });
    console.log(`FAIL ${name}\n  ${error.message.split("\n").join("\n  ")}`);
  }
}

try {
  for (const view of [
    { name: "desktop-en", width: 1280, height: 1000, touch: false, lang: "en" },
    { name: "phone-390-zh", width: 390, height: 844, touch: true, lang: "zh" },
  ]) {
    const { context, page, writes } = await open(view);
    try {
      await check(`${view.name}: a report card's reply takes a ${LONG.length}-character paste whole`, async () => {
        const notes = card(page, "notes");
        await notes.locator(".home-reply-open").click();
        const box = notes.locator(".home-card-reply");
        await paste(page, box, LONG);
        const value = await plainValue(box);
        if (value !== null) assert.equal(value.length, LONG.length, `the field holds the whole paste, not ${value.length} characters of it`);
        await shoot(notes, `card-long-paste-${view.name}`);
        await box.locator("button[type=submit]").click();
        await sent(page, writes, 1);
        const [reply] = replies(writes);
        assert.equal(reply.text.length, LONG.trim().length, "the reply sent whole");
        assert.ok(reply.text === LONG.trim(), "the same text");
        return { sentCharacters: reply.text.length };
      });
      await check(`${view.name}: a long paste folds into a block that opens with its whole text and is removed`, async () => {
        const notes = card(page, "notes");
        const box = notes.locator(".home-card-reply");
        await paste(page, box, LONG);
        const chip = box.locator(".pasted-text-chip");
        await chip.waitFor({ timeout: 5_000 });
        assert.equal(await chip.count(), 1, "one block");
        const label = await chip.getAttribute("aria-label");
        assert.match(label, view.lang === "zh" ? /651 行。查看并编辑$/ : /651 lines\. View and edit$/);
        const fits = await chip.evaluate((el) => el.getBoundingClientRect().right <= el.closest(".home-card-reply").getBoundingClientRect().right + 1);
        assert.ok(fits, "the block fits its reply");
        await shoot(notes, `card-block-${view.name}`);
        await chip.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 5_000 });
        assert.equal(await dialog.locator("h2").textContent(), view.lang === "zh" ? "粘贴的文本 #1" : "Pasted text #1");
        const full = await dialog.locator("textarea").inputValue();
        assert.equal(full.length, LONG.length, "the whole paste, to read and edit");
        await dialog.screenshot({ path: `${output}/block-dialog-${view.name}.png` });
        report.shots.push(`${output}/block-dialog-${view.name}.png`);
        await dialog.getByRole("button", { name: view.lang === "zh" ? "移除此块" : "Remove block" }).click();
        await dialog.waitFor({ state: "hidden", timeout: 5_000 });
        assert.equal(await chip.count(), 0, "removed");
        return { label, characters: full.length };
      });
      await check(`${view.name}: a paste over the limit says how far over, holds Send and keeps every character`, async () => {
        const notes = card(page, "notes");
        const box = notes.locator(".home-card-reply");
        const count = replies(writes).length;
        // 92,100 bytes: 100 more than a reply from Home can be.
        const over = "长".repeat(30_700);
        await paste(page, box, over);
        const note = box.locator(".home-reply-length[data-over]");
        await note.waitFor({ timeout: 5_000 });
        assert.match(await note.textContent(), view.lang === "zh" ? /^超出 100 字节，发不出去/ : /^100 bytes too long to send/);
        assert.ok(await box.locator("button[type=submit]").isDisabled(), "Send is held");
        const value = await plainValue(box);
        if (value !== null) assert.equal(value.length, over.length, "the field keeps it all");
        await box.locator(FIELD).first().press(view.touch ? "Enter" : "Control+Enter");
        await page.waitForTimeout(300);
        assert.equal(replies(writes).length, count, "nothing sent");
        await shoot(notes, `card-over-limit-${view.name}`);
        return { bytes: new TextEncoder().encode(over).length };
      });
      await check(`${view.name}: an Ask's free text takes 8,000 Chinese characters whole`, async () => {
        const words = card(page, "words");
        const count = replies(writes).length;
        await paste(page, words, CHINESE);
        const value = await plainValue(words);
        if (value !== null) assert.equal(value.length, CHINESE.length);
        await shoot(words, `ask-chinese-paste-${view.name}`);
        await words.locator(".home-text-reply button[type=submit]").click();
        await sent(page, writes, count + 1);
        const reply = replies(writes).at(-1);
        assert.ok(reply.text === CHINESE, `the reply sent whole (${reply.text.length} characters)`);
        return { sentBytes: new TextEncoder().encode(reply.text).length };
      });
      if (view.touch) {
        await check(`${view.name}: the reply fits the phone`, async () => {
          const overflow = await card(page, "notes").evaluate((el) => el.scrollWidth - el.clientWidth);
          assert.ok(overflow <= 1, `overflow ${overflow}px`);
        });
      }
    } finally {
      report.writes.push(...writes.map((write) => ({ view: view.name, path: write.path, key: write.body.key, characters: write.body.text?.length })));
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
