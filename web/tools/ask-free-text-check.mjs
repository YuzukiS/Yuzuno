// Every open Ask takes a reply in the user's own words (T-9), whatever the
// Agent declared: options, a choice or a form never take the writing field
// away, and `freeText.prompt` only names it. In a real browser against the
// production bundle, with an explicit API fixture: no Core, no Agent, and
// nothing is sent but the replies these checks make on purpose.
//   YUZUNO_UI_DIST=<isolated build> node tools/ask-free-text-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/ask-free-text");
await mkdir(output, { recursive: true });
// https, so the page is a secure context: a reply needs crypto.randomUUID.
const HOST = "yuzuno-ask-free-text.test";
const report = { task: "T-9", checks: [], writes: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }, { ...base, id: "kumo", name: "Kumo", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] },
  text: { type: "Markdown", props: { text } },
} });
const ask = (key, title, question, reply, extra = {}) => ({
  key, kind: "ask", title, version: 2, owner, updatedAt: iso(-20 * MIN), updatedTurnId: null,
  attachments: [], refs: {}, seen: null, history: false,
  body: body(question), ask: { question, state: "open", reply, ...extra },
});
// One ask of every shape an Agent can declare. Only `prompt` names the field;
// none of them decides whether it is there.
const form = {
  id: "plan", title: "Which parts ship first?",
  fields: [{ id: "part", type: "single", label: "First part", required: false,
    options: [{ id: "ui", label: "The UI" }, { id: "core", label: "Core" }] }],
};
// Each page gets its own copy: a reply one of them sends must not reach the
// next viewport's cards.
const template = [
  ask("options", "Ship today?", "Ship the release today?", { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }] }),
  ask("choice", "Plan A or B?", "Which plan should we take?", { choice: {
    a: { id: "plan-a", label: "Plan A" }, b: { id: "plan-b", label: "Plan B", detail: "Slower, safer" } } }),
  ask("form", "What ships first?", "Answer the form, or write instead.", { form }),
  ask("prompt", "Name the release", "What should this release be called?", { freeText: { prompt: "Write the name you want" } }),
  ask("plain", "Anything to add?", "Anything else before we ship?", { freeText: true }),
];
const needsYou = (sections) => sections
  .filter((s) => s.ask.state === "open")
  .map((s) => ({ kind: "ask", projectId: "p1", agentId: owner.agentId, agentName: owner.name, sectionKey: s.key, title: s.title, since: s.updatedAt }));
const home = (sections) => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: needsYou(sections),
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [],
    brief: { version: 9, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme }) {
  const sections = structuredClone(template);
  const writes = [];
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((theme) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
  }, theme);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== "GET") {
      const sent = JSON.parse(route.request().postData() || "{}");
      writes.push({ path, body: sent });
      if (path === "/api/projects/p1/brief/reply") {
        const section = sections.find((s) => s.key === sent.key);
        if (section) section.ask = { ...section.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: sent.text };
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
  await page.locator('[data-section-key="options"]').first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, writes };
}

/** The reply controls of one ask card, as the reader finds them. */
const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();
const reply = (page, key) =>
  card(page, key).evaluate((el) => {
    const box = el.querySelector(".home-ask-reply");
    const field = box?.querySelector(".home-text-reply textarea");
    const send = box?.querySelector(".home-text-reply button[type=submit]");
    return {
      writable: !!field,
      placeholder: field?.placeholder ?? null,
      sendDisabled: send?.disabled ?? null,
      options: [...(box?.querySelectorAll(".home-ask-options button") || [])].map((b) => b.textContent),
      choices: [...(box?.querySelectorAll(".home-choice") || [])].map((c) => c.querySelector("strong").textContent),
      form: !!box?.querySelector("form.clarification, .clarification"),
      replied: !!el.querySelector(".home-ask-replied"),
    };
  });

try {
  for (const view of [
    { name: "desktop", width: 1280, height: 1000, touch: false },
    { name: "phone", width: 393, height: 852, touch: true },
  ]) {
    for (const theme of ["light", "dark"]) {
      const { context, page, writes } = await open({ ...view, theme });
      try {
        const shown = {};
        for (const key of ["options", "choice", "form", "prompt", "plain"]) shown[key] = await reply(page, key);
        // The field is there whatever the ask declares.
        for (const [key, state] of Object.entries(shown))
          assert.equal(state.writable, true, `${key} takes free text: ${JSON.stringify(state)}`);
        // What the Agent declared is still there, with its own submit.
        assert.deepEqual(shown.options.options, ["Ship today", "Wait"], JSON.stringify(shown.options));
        assert.deepEqual(shown.choice.choices, ["Plan A", "Plan B"], JSON.stringify(shown.choice));
        assert.equal(shown.form.form, true, JSON.stringify(shown.form));
        // `prompt` only names the field; the others keep the default wording.
        assert.equal(shown.prompt.placeholder, "Write the name you want");
        assert.equal(shown.options.placeholder, shown.plain.placeholder);
        assert.match(shown.plain.placeholder, /\S/);
        // Empty: nothing can be sent.
        for (const [key, state] of Object.entries(shown))
          assert.equal(state.sendDisabled, true, `${key} sends nothing while empty: ${JSON.stringify(state)}`);
        assert.deepEqual(writes.filter((w) => w.path.endsWith("/brief/reply")), [], "nothing sent by drawing the cards");
        record(`${view.name} ${theme}: every open ask takes free text beside what it declares`, shown);

        for (const key of ["options", "choice", "form"]) {
          const shot = `${output}/ask-${key}-${view.name}-${theme}.png`;
          await card(page, key).screenshot({ path: shot });
          report.shots.push(shot);
        }
        if (view.touch) {
          // Nothing of the card runs off a phone's width.
          const overflow = await card(page, "form").evaluate((el) => el.scrollWidth - el.clientWidth);
          assert.ok(overflow <= 1, `fits a phone: ${overflow}`);
          record(`${view.name} ${theme}: the reply controls fit the width`, { overflow });
        }

        // Writing and sending on a choice-only ask: the one the old condition
        // left with no way to answer in words.
        if (!view.touch && theme === "light") {
          const field = card(page, "choice").locator(".home-text-reply textarea");
          await field.fill("Plan B, but keep the old import for a week.");
          const before = writes.length;
          await card(page, "choice").locator(".home-text-reply button[type=submit]").click();
          await card(page, "choice").locator(".home-ask-replied").waitFor({ timeout: 10_000 });
          const sent = writes.slice(before).filter((w) => w.path.endsWith("/brief/reply"));
          assert.equal(sent.length, 1, JSON.stringify(sent));
          assert.equal(sent[0].body.key, "choice");
          assert.equal(sent[0].body.text, "Plan B, but keep the old import for a week.");
          assert.equal(sent[0].body.choice, undefined, "written words are not a choice id");
          const after = await reply(page, "choice");
          assert.equal(after.replied, true, JSON.stringify(after));
          const shot = `${output}/ask-choice-replied-${view.name}-${theme}.png`;
          await card(page, "choice").screenshot({ path: shot });
          report.shots.push(shot);
          record("a choice-only ask answered in words: one reply sent, with no choice id, then shown as replied", sent[0].body);
        }
      } finally {
        report.writes.push(...writes.map((write) => ({ view: `${view.name} ${theme}`, ...write })));
        await context.close();
      }
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
