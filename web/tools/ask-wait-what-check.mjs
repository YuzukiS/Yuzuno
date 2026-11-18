// YN-213: an Ask with a decision has one button that sends the decision, the
// user's words and what they attach together, and "Wait, what?" beside it,
// whose note goes to the Agent alone and leaves the Ask open, its decision as
// it was. In a real browser against the production bundle, with an explicit
// API fixture standing in for Core (it answers as core/src/project_brief/home.rs
// does): no Core, no Agent, nothing sent but what these checks send.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/ask-wait-what-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/ask-wait-what");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-ask-wait-what.test";
const report = { task: "YN-213", checks: [], writes: [], shots: [], errors: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }];
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
const ship = { options: [
  { id: "full", label: "Implement it all (recommended)" }, { id: "wait-what", label: "Only Wait, what?" }, { id: "defer", label: "Not now" }] };
const plan = { form: { id: "review", title: "Review the design", fields: [{ id: "verdict", type: "single", label: "Verdict", required: true,
  options: [{ id: "go", label: "Approve" }, { id: "fix", label: "Needs changes" }], default: { value: "go", source: "The design note" } }] } };
const template = () => [
  ask("ship", "Implement it?", "Implement the approved design?", ship),
  ask("plan", "Review the design", "Is the design note ready?", plan),
  ask("retry", "Ship today?", "Ship the release today?", { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }] }),
  // An Ask answered before this change: it reads as it always has.
  ask("deploy", "Deploy?", "Deploy the hotfix?", { options: [{ id: "yes", label: "Yes, deploy" }, { id: "no", label: "No" }] },
    { state: "replied", repliedAt: iso(-5 * MIN), replyText: "Yes, deploy" }),
];
const needsYou = (sections) => sections.filter((s) => s.ask.state === "open")
  .map((s) => ({ kind: "ask", projectId: "p1", agentId: owner.agentId, agentName: owner.name, sectionKey: s.key, title: s.title, since: s.updatedAt }));
const home = (sections) => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: needsYou(sections),
  projects: [{ project: { id: "p1", name: "Yuzuno app" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], brief: { version: 9, sections, history: [] }, unseen: sections.length, missing: [] }],
});
const formIds = (text) => text.replace(/\n\n\{"formId":.*\}(?=\n\n|$)/, "");

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

/** One page with its own Core fixture. `older`: a Core from before notes. `drop`: keys whose first reply is lost.
 * `moveOnNote`: a note to version 2 of `ship` finds it at version 3, as when its owner asked again meanwhile. */
async function open({ width, height, touch, older = false, drop = [], moveOnNote = false }) {
  const sections = template();
  const writes = [];
  const lost = new Set(drop);
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance")) localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method === "POST" && path === "/api/projects/p1/files") {
      const name = url.searchParams.get("name") || "file";
      const bytes = route.request().postDataBuffer()?.length ?? 0;
      writes.push({ path, name });
      return route.fulfill({ json: { id: "a".repeat(64), name, bytes } });
    }
    if (method !== "GET") {
      const sent = JSON.parse(route.request().postData() || "{}");
      writes.push({ path, body: sent });
      if (path !== "/api/projects/p1/brief/reply") return route.fulfill({ json: { ok: true } });
      const section = sections.find((s) => s.key === sent.key);
      const accepted = { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "mori-t2", error: null };
      if (lost.delete(sent.key)) return route.abort("failed");
      // A Core from before notes: serde refuses the field, nothing is sent.
      if (older && (sent.intent || sent.note))
        return route.fulfill({ status: 422, contentType: "text/plain",
          body: `Failed to deserialize the JSON body into the target type: unknown field \`${sent.intent ? "intent" : "note"}\`, expected one of \`key\`, \`agentId\`` });
      if (moveOnNote && sent.intent === "note" && sent.key === "ship" && section.version === 2) {
        section.version = 3;
        section.updatedAt = new Date().toISOString();
      }
      if (sent.askVersion !== section.version)
        return route.fulfill({ status: 409, json: { code: "message_not_submitted",
          error: `ask_changed: version ${sent.askVersion} of the ask \`${sent.key}\` can't be answered now: it changed after you began this reply. Nothing was sent, and your reply is kept.` } });
      if (sent.intent === "note") {
        // Kept apart; the Ask stays as it was (ask_notes.rs).
        section.ask.notes = [{ version: section.version, at: new Date().toISOString(), text: sent.text.trim(), agentId: sent.agentId,
          ...(sent.images ? { images: sent.images } : {}), ...(sent.files ? { files: sent.files } : {}) }, ...(section.ask.notes ?? [])].slice(0, 5);
        return route.fulfill({ json: accepted });
      }
      const label = [...(section.ask.reply.options ?? [])].find((o) => o.id === sent.choice)?.label;
      const replyText = sent.form ? `${sent.text}${sent.note ? `\n\n${sent.note}` : ""}` : label ? (sent.text ? `${label}: ${sent.text}` : label) : sent.text;
      section.ask = { ...section.ask, state: "replied", repliedAt: new Date().toISOString(), replyText,
        ...(sent.files ? { replyFiles: sent.files } : {}) };
      return route.fulfill({ json: accepted });
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
  const goHome = async () => {
    await page.goto(`https://${HOST}/`);
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator('[data-section-key="ship"]').first().waitFor({ timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
  };
  await goHome();
  return { context, page, writes, sections, goHome };
}

const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();
/** What one Ask's reply shows, as the reader finds it. */
const state = (page, key) => card(page, key).evaluate((el) => {
  // A composer's words, its lines without the placeholder an empty one shows.
  const words = (field) => field && [...field.querySelectorAll(".cm-line")].map((line) => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll(".cm-placeholder").forEach((p) => p.remove());
    return copy.textContent;
  }).join("\n");
  const decision = el.querySelector(".home-ask-decision");
  const primary = decision?.querySelector(".clarification footer .primary-button, .home-ask-actions .primary-button");
  return {
    // As the reader sees it: drawn, not only marked hidden.
    decisionShown: !!decision && getComputedStyle(decision).display !== "none" && decision.getClientRects().length > 0,
    // How many primary buttons the reader sees: the design has one at a time.
    primaries: [...el.querySelectorAll(".primary-button")].filter((b) => b.getClientRects().length > 0).length,
    picked: [...(decision?.querySelectorAll("input[type=radio]") ?? [])].filter((r) => r.checked).map((r) => r.closest("label").textContent.trim()),
    primary: primary ? { text: primary.textContent.trim(), disabled: primary.disabled } : null,
    waitWhat: [...el.querySelectorAll("button")].some((b) => b.textContent.trim() === "Wait, what?"),
    noteOpen: !!el.querySelector(".home-ask-note"),
    noteFocused: !!document.activeElement?.closest(".home-ask-note"),
    words: words(decision?.querySelector(".home-ask-words [data-composer-input]")) ?? null,
    note: words(el.querySelector(".home-ask-note [data-composer-input]")) ?? null,
    notes: el.querySelector(".home-ask-notes")?.textContent ?? null,
    replied: el.querySelector(".home-ask-replied, .home-answer-reply")?.textContent ?? null,
    alerts: [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
    suggested: [...el.querySelectorAll(".clarification-note p")].map((p) => p.textContent),
    inNeedsYou: !!el.closest(".home-needs-you"),
    overflow: el.scrollWidth - el.clientWidth,
  };
});
const replies = (writes) => writes.filter((w) => w.path === "/api/projects/p1/brief/reply").map((w) => w.body);
const shot = async (page, key, name) => {
  const path = `${output}/${name}.png`;
  await card(page, key).screenshot({ path });
  report.shots.push(path);
};
const radio = (page, key, label) => card(page, key).locator(".home-ask-decision fieldset label, .clarification label").filter({ hasText: label }).locator("input");
const button = (page, key, text) => card(page, key).getByRole("button", { name: text, exact: true });
const typeInto = async (locator, text) => {
  await locator.click();
  await locator.page().keyboard.insertText(text);
};

try {
  for (const view of [
    { name: "desktop", width: 1280, height: 1000, touch: false },
    { name: "phone", width: 393, height: 852, touch: true },
  ]) {
    const { context, page, writes, goHome } = await open({ ...view, drop: ["retry"], moveOnNote: !view.touch });
    try {
      // 1. Nothing picked for the user; one button, named once a decision is picked; Wait, what? from the start.
      let s = await state(page, "ship");
      assert.deepEqual([s.picked, s.primary, s.waitWhat, s.primaries], [[], { text: "Submit decision", disabled: true }, true, 1], JSON.stringify(s));
      await shot(page, "ship", `1-decision-${view.name}`);
      await radio(page, "ship", "Implement it all").check();
      await typeInto(card(page, "ship").locator(".home-ask-words [data-composer-input]"), "With the docs updated.");
      s = await state(page, "ship");
      assert.deepEqual(s.primary, { text: "Submit: Implement it all (recommended)", disabled: false }, JSON.stringify(s));
      record(`${view.name}: nothing is picked for the user; the one button names the decision once it is picked`, { primary: s.primary });

      // 2. Wait, what?: its own field, focused, empty; the decision set aside as it was.
      await button(page, "ship", "Wait, what?").click();
      s = await state(page, "ship");
      assert.deepEqual([s.noteOpen, s.noteFocused, s.decisionShown, s.note, s.primaries], [true, true, false, "", 1], JSON.stringify(s));
      await page.keyboard.insertText("The preview won't open. Can you send a screenshot first?");
      await shot(page, "ship", `2-wait-what-${view.name}`);
      const before = replies(writes).length;
      await button(page, "ship", "Send to Agent").click();
      await card(page, "ship").locator(".home-ask-notes").waitFor({ timeout: 10_000 });
      const notes = replies(writes).slice(before);
      // Desktop: Core had version 3 meanwhile, so the note went there, as a note (YN-38).
      assert.deepEqual(notes.map((b) => [b.askVersion, b.intent, b.choice ?? null, b.form ?? null, b.text]),
        (view.touch ? [2] : [2, 3]).map((v) => [v, "note", null, null, "The preview won't open. Can you send a screenshot first?"]), JSON.stringify(notes));
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Wait, what?");
      s = await state(page, "ship");
      assert.equal(s.decisionShown, true);
      assert.deepEqual(s.picked, ["Implement it all (recommended)"], "the pick stays");
      assert.equal(s.words, "With the docs updated.", "its words too");
      assert.match(s.notes, /^Note sent · still waiting for your decision.*The preview won't open/);
      assert.equal(s.replied, null, "not answered");
      assert.equal(s.inNeedsYou, true, "still in Needs you");
      await shot(page, "ship", `3-noted-${view.name}`);
      record(`${view.name}: a note goes alone${view.touch ? "" : ", to the ask's newest version"}; the Ask stays in Needs you with its pick and words`,
        { notes: notes.map((b) => ({ askVersion: b.askVersion, intent: b.intent })) });

      // 3. A note being written, and the decision, both kept across a reload.
      await button(page, "ship", "Wait, what?").click();
      await page.keyboard.insertText("Draft of a second note");
      await page.waitForTimeout(300);
      await page.reload();
      await page.locator(".toolbar-nav .catchup-nav").first().click();
      await card(page, "ship").locator(".home-ask-note").waitFor({ timeout: 10_000 });
      s = await state(page, "ship");
      assert.equal(s.note, "Draft of a second note", JSON.stringify(s));
      await button(page, "ship", "Back to the question").click();
      s = await state(page, "ship");
      assert.deepEqual([s.picked, s.words], [["Implement it all (recommended)"], "With the docs updated."], JSON.stringify(s));
      record(`${view.name}: after a reload the note being written and the decision begun are both as they were`);

      // 4. Then the decision, with its words, as one reply.
      const decided = replies(writes).length;
      await button(page, "ship", "Submit: Implement it all (recommended)").click();
      await card(page, "ship").locator(".home-ask-replied, .home-answer-reply").first().waitFor({ timeout: 10_000 });
      const [answer] = replies(writes).slice(decided);
      assert.deepEqual([answer.choice, answer.text, answer.intent ?? null], ["full", "With the docs updated.", null], JSON.stringify(answer));
      await shot(page, "ship", `4-decided-${view.name}`);
      record(`${view.name}: the decision and its words go as one reply, shown on the card`, { choice: answer.choice, text: answer.text });

      // 5. A form: its default suggested, not chosen; the answers, the words and a file go together.
      s = await state(page, "plan");
      assert.deepEqual(s.suggested, ["Suggested: “Approve” (The design note). Choose it yourself to send it."], JSON.stringify(s));
      assert.equal(await radio(page, "plan", "Approve").isChecked(), false);
      await radio(page, "plan", "Needs changes").check();
      await typeInto(card(page, "plan").locator(".home-ask-words [data-composer-input]"), "See the screenshot: the preview is blank.");
      if (!view.touch) {
        await card(page, "plan").locator('input[aria-label="Choose files"]').setInputFiles({ name: "preview.txt", mimeType: "text/plain", buffer: Buffer.from("blank") });
        await card(page, "plan").locator(".home-ask-words .input-file").waitFor({ timeout: 10_000 });
      }
      await shot(page, "plan", `5-form-${view.name}`);
      const formed = replies(writes).length;
      await button(page, "plan", "Submit answers").click();
      await card(page, "plan").locator(".home-ask-replied, .home-answer-reply").first().waitFor({ timeout: 10_000 });
      const [form] = replies(writes).slice(formed);
      assert.deepEqual(form.form, { formId: "review", answers: { verdict: "fix" } });
      assert.equal(form.note, "See the screenshot: the preview is blank.");
      if (!view.touch) assert.deepEqual(form.files?.map((f) => f.name), ["preview.txt"]);
      s = await state(page, "plan");
      assert.ok(s.replied.includes(formIds(`${form.text}\n\n${form.note}`).split("\n").at(-1)) && !/formId/.test(s.replied), JSON.stringify(s));
      await shot(page, "plan", `6-form-replied-${view.name}`);
      record(`${view.name}: a form's answers, the words${view.touch ? "" : " and a file"} go as one reply, shown without its IDs`, { note: form.note });

      // 6. A reply whose delivery was lost goes again as it was.
      await radio(page, "retry", "Ship today").check();
      const tried = replies(writes).length;
      await button(page, "retry", "Submit: Ship today").click();
      await card(page, "retry").locator(".home-ask-unconfirmed").waitFor({ timeout: 10_000 });
      await button(page, "retry", "Retry previous reply").click();
      await card(page, "retry").locator(".home-ask-replied, .home-answer-reply").first().waitFor({ timeout: 10_000 });
      const [first, again] = replies(writes).slice(tried);
      assert.deepEqual(again, first, "the same message, client ID and all");
      record(`${view.name}: a lost reply goes again as it was, once`);

      // 7. An Ask answered before: as it always read, on its project's page (an answered Ask is not in Needs you);
      // Reply again brings back the decision and Wait, what?.
      await page.locator('[data-glance-project="p1"] .project-glance-open').first().click();
      await page.locator('[data-project-home="p1"] [data-section-key="deploy"]').first().waitFor({ timeout: 10_000 });
      s = await state(page, "deploy");
      assert.match(s.replied ?? "", /Yes, deploy/);
      if (!view.touch) {
        await card(page, "deploy").getByRole("button", { name: "Reply again" }).click();
        await card(page, "deploy").locator(".home-ask-decision").waitFor({ timeout: 10_000 });
        s = await state(page, "deploy");
        assert.deepEqual([s.decisionShown, s.waitWhat, s.picked], [true, true, []], JSON.stringify(s));
      }
      record(`${view.name}: an Ask answered before reads as before`);
      if (view.touch) {
        for (const key of ["ship", "plan", "retry"]) {
          const { overflow } = await state(page, key);
          assert.ok(overflow <= 1, `${key} fits a phone: ${overflow}`);
        }
        record(`${view.name}: every Ask fits the width`);
      }
      void goHome;
    } finally {
      report.writes.push(...writes.map((write) => ({ view: view.name, ...write })));
      await context.close();
    }
  }

  // A Core from before notes: said, nothing sent as an answer instead, nothing kept to go again.
  {
    const { context, page, writes } = await open({ width: 1280, height: 1000, touch: false, older: true });
    try {
      await radio(page, "ship", "Implement it all").check();
      await button(page, "ship", "Wait, what?").click();
      await page.keyboard.insertText("What does this ship?");
      await button(page, "ship", "Send to Agent").click();
      await card(page, "ship").locator('[role="alert"]').waitFor({ timeout: 10_000 });
      const s = await state(page, "ship");
      assert.match(s.alerts.join(" "), /can't take a note on its own.*Nothing was sent; what you wrote is kept/);
      assert.equal(replies(writes).length, 1, "one try, never again as an answer");
      assert.equal(s.note, "What does this ship?");
      assert.equal(await page.evaluate(() => localStorage.getItem("yuzuno.home-outbox.v1")), null, "no retry record");
      await shot(page, "ship", "7-older-core-desktop");
      record("desktop: a Core older than notes refuses the note; nothing goes as an answer, the words stay");
    } finally {
      report.writes.push(...writes.map((write) => ({ view: "desktop older Core", ...write })));
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
