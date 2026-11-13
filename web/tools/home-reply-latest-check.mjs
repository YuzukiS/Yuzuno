// YN-38: every Home reply goes to the latest version, with no step to move
// it there. In a real browser against the production bundle, with an
// explicit API fixture that refuses a version that is not the latest, as
// Core does (project_brief/home.rs): no Core, no Agent, nothing sent but the
// replies these checks make on purpose.
//   - An Ask's form asked again while the user answers: what still fits
//     stays, each changed field says so, nothing is picked for the user;
//     then answered and sent to the latest version.
//   - A report card's reply follows the card to its latest version, and when
//     Core has a newer one than the page, goes there.
//   - An Ask's words, refused because Core has a newer version, go there.
//   YUZUNO_UI_DIST=<isolated build> node tools/home-reply-latest-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/home-reply-latest");
await mkdir(output, { recursive: true });
// https, so the page is a secure context: a reply needs crypto.randomUUID.
const HOST = "yuzuno-home-reply-latest.test";
const report = { task: "YN-38", checks: [], writes: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }, { ...base, id: "hana", name: "Hana", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] },
  text: { type: "Markdown", props: { text } },
} });
const section = (key, kind, title, version, extra = {}) => ({
  key, kind, title, version, owner, updatedAt: iso(-20 * MIN), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false, body: body(`${title}: what the author wrote.`), ...extra,
});
const day = (options) => ({ id: "day", type: "single", label: "Release day", required: true, options });
const mon = { id: "mon", label: "Monday" }, tue = { id: "tue", label: "Tuesday" }, fri = { id: "fri", label: "Friday" };
const extra = { id: "notes", type: "text", label: "Anything else", required: false };
const who = { id: "who", type: "single", label: "Who ships it", required: true, options: [{ id: "mori", label: "Mori" }, { id: "hana", label: "Hana" }] };
const plan = (version, fields) => section("plan", "ask", "Release plan", version, {
  ask: { question: "How should the release go?", state: "open", reply: { form: { id: "release-plan", title: "Release plan", fields } } },
});
const template = () => [
  plan(1, [day([mon, tue]), extra]),
  section("words", "ask", "Anything before we ship?", 1, { ask: { question: "Anything before we ship?", state: "open", reply: { freeText: true } } }),
  section("notes", "report", "Notes", 2),
];
const home = (sections) => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [],
    brief: { version: 9, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});
const words = {
  en: {
    dropped: "No longer offered: “Tuesday”. Choose again.",
    added: "New since you began answering.",
    carried: /This ask is now version 2\. Your answers are kept where they still fit/,
    cardHead: /Reply to “Notes, revised” · version 3/,
    sent4: /Sent to Mori, referring to version 4/,
  },
  zh: {
    dropped: "已不再提供：“Tuesday”。请重新选择。",
    added: "你开始回答之后新加的问题。",
    carried: /这个提问现在是版本 2。仍然适用的答案已保留/,
    cardHead: /“Notes, revised”.*3/,
    sent4: /Mori.*4/,
  },
};

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme, lang }) {
  const sections = template();
  const writes = [];
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  }, { theme, lang });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== "GET") {
      const sent = JSON.parse(route.request().postData() || "{}");
      writes.push({ path, body: sent });
      if (path === "/api/projects/p1/brief/reply") {
        const shown = sections.find((s) => s.key === sent.key);
        // Core sends a reply only to the version it has now; nothing else is sent.
        const refuse = (error) => route.fulfill({ status: 409, json: { error, code: "message_not_submitted" } });
        if (sent.askVersion !== undefined && sent.askVersion !== shown.version)
          return refuse(`ask_changed: version ${sent.askVersion} of the ask \`${sent.key}\` can't be answered now: it changed after you began this reply. Nothing was sent, and your reply is kept.`);
        if (sent.version !== undefined && (sent.version !== shown.version || sent.title !== shown.title))
          return refuse(`section_changed: version ${sent.version} of “${sent.title}” is no longer on Home; it changed after you began this reply. Nothing was sent, and your reply is kept.`);
        if (shown.ask) shown.ask = { ...shown.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: sent.text };
        return route.fulfill({ json: { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "mori-t2", error: null } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 2, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
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
  await page.locator('[data-section-key="plan"]').first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, writes, sections };
}

const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();
const replies = (writes) => writes.filter((w) => w.path.endsWith("/brief/reply")).map((w) => w.body);
/** Until `count` replies to `key` were sent, and the page has settled on them. An Ask answered on its card
 * becomes its answer card (YN-21), so the reply sent, not a block on the card, says it went. */
async function sent(page, writes, key, count) {
  const deadline = Date.now() + 10_000;
  while (replies(writes).filter((r) => r.key === key).length < count && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(replies(writes).filter((r) => r.key === key).length, count, `${key}: ${JSON.stringify(replies(writes))}`);
  await page.waitForTimeout(300);
}
/** Home reads itself again, as Core's event would make it. */
async function refresh(page, key, version) {
  await page.locator(".home-refresh").first().click();
  await page.locator(`[data-section-key="${key}"][data-section-version="${version}"]`).first().waitFor({ timeout: 10_000 });
}
async function shoot(page, key, name) {
  const shot = `${output}/${name}.png`;
  await card(page, key).screenshot({ path: shot });
  report.shots.push(shot);
}
const fieldNotes = (page, label) =>
  card(page, "plan").evaluate((el, label) => {
    const field = [...el.querySelectorAll(".clarification-field")].find((f) => f.querySelector("legend").textContent.startsWith(label));
    return [...(field?.querySelectorAll(".clarification-carried p") ?? [])].map((n) => n.textContent);
  }, label);

try {
  for (const view of [
    { name: "desktop-light-en", width: 1280, height: 1100, touch: false, theme: "light", lang: "en" },
    { name: "desktop-dark-en", width: 1280, height: 1100, touch: false, theme: "dark", lang: "en" },
    { name: "desktop-light-zh", width: 1280, height: 1100, touch: false, theme: "light", lang: "zh" },
    { name: "phone-light-zh", width: 393, height: 852, touch: true, theme: "light", lang: "zh" },
  ]) {
    const t = words[view.lang];
    const { context, page, writes, sections } = await open(view);
    try {
      // 1. A form asked again while the user answers.
      const form = card(page, "plan");
      await form.locator(".clarification label", { hasText: "Tuesday" }).click();
      await form.locator(".clarification textarea").fill("After the docs land.");
      sections[0] = plan(2, [day([mon, fri]), extra, who]);
      await refresh(page, "plan", 2);
      await form.locator(".clarification-carried").first().waitFor({ timeout: 10_000 });
      assert.deepEqual(await fieldNotes(page, "Release day"), [t.dropped]);
      assert.deepEqual(await fieldNotes(page, "Who ships it"), [t.added]);
      assert.deepEqual(await fieldNotes(page, "Anything else"), []);
      assert.equal(await form.locator(".clarification textarea").inputValue(), "After the docs land.");
      const checked = await form.locator('.clarification input:checked').count();
      assert.equal(checked, 0, "nothing picked for the user");
      assert.match(await form.textContent(), t.carried);
      assert.equal(await form.locator("text=/Refer it to|改为指向/").count(), 0, "no step to move the answers");
      if (view.touch) {
        const overflow = await form.evaluate((el) => el.scrollWidth - el.clientWidth);
        assert.ok(overflow <= 1, `fits a phone: ${overflow}`);
      }
      await shoot(page, "plan", `form-carried-${view.name}`);
      record(`${view.name}: a form asked again keeps what fits and says on each field what changed`);
      await form.locator(".clarification label", { hasText: "Friday" }).click();
      await form.locator(".clarification label", { hasText: "Hana" }).click();
      await form.locator(".clarification footer .primary-button").click();
      await sent(page, writes, "plan", 1);
      const [answers] = replies(writes);
      assert.equal(answers.askVersion, 2);
      assert.deepEqual(answers.form, { formId: "release-plan", answers: { day: "fri", notes: "After the docs land.", who: "hana" } });
      record(`${view.name}: the answers go to version 2`, answers.form);

      // 2. A report card's reply follows the card, and goes to the version Core has.
      const notes = card(page, "notes");
      await notes.locator(".home-reply-open").click();
      await notes.locator(".home-card-reply [data-composer-input]").fill("Please add the numbers.");
      sections[2] = { ...sections[2], version: 3, title: "Notes, revised" };
      await refresh(page, "notes", 3);
      const box = notes.locator(".home-card-reply");
      assert.match(await box.textContent(), t.cardHead);
      assert.equal(await box.locator("text=/Refer it to|改为指向/").count(), 0);
      await shoot(page, "notes", `card-follows-${view.name}`);
      // Core writes version 4 before this page reads it.
      sections[2] = { ...sections[2], version: 4, title: "Notes, third pass" };
      await box.locator("button[type=submit]").click();
      await box.locator("text=" + (view.lang === "zh" ? "版本 4" : "version 4")).first().waitFor({ timeout: 10_000 });
      const card4 = replies(writes).filter((r) => r.key === "notes");
      assert.deepEqual(card4.map((r) => [r.version, r.title]), [[3, "Notes, revised"], [4, "Notes, third pass"]]);
      assert.match(await box.textContent(), t.sent4);
      assert.equal(await box.locator('[role="alert"]').count(), 0, "no refusal shown");
      await shoot(page, "notes", `card-sent-latest-${view.name}`);
      record(`${view.name}: a card reply refused at version 3 goes to version 4`, card4);

      // 3. An Ask's words, refused because Core has a newer version.
      const ask = card(page, "words");
      await ask.locator(".home-text-reply [data-composer-input]").fill("Ship after QA.");
      sections[1] = { ...sections[1], version: 2, ask: { ...sections[1].ask, question: "Anything before we ship on Monday?" } };
      await ask.locator(".home-text-reply button[type=submit]").click();
      await sent(page, writes, "words", 2);
      const said = replies(writes).filter((r) => r.key === "words");
      assert.deepEqual(said.map((r) => [r.askVersion, r.text]), [[1, "Ship after QA."], [2, "Ship after QA."]]);
      assert.equal(await card(page, "words").locator('[role="alert"]').count(), 0, "no refusal shown");
      await shoot(page, "words", `words-sent-latest-${view.name}`);
      record(`${view.name}: words refused at version 1 go to version 2`, said);
    } finally {
      report.writes.push(...writes.map((write) => ({ view: view.name, ...write })));
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
