// YN-106: a task's long fields take a long paste as the conversation's
// composer does. In a real browser against the production bundle, pasted
// from the clipboard as a person pastes, with an explicit API fixture: no
// Core, no Agent, nothing written but the comments these checks send.
//   - The new task's description, the result's summary and its itemized
//     report, a dispatch's note, the edited task's fields and a comment each
//     fold a long paste into one block that fits the panel: neither the
//     block nor the field widens it, and the page does not scroll sideways.
//   - A comment sent carries the paste whole.
//   - A comment longer than Core takes (16,384 bytes) says how far over and
//     holds Add note.
//   - A PR's body, the Codex goal's objective and /review's instructions
//     fold a paste into one block that fits their form; in the goal's
//     dialog the block opens its own dialog over it, to read and edit the
//     whole text, and closes back to the goal (PR 2).
// On a 1440px desktop window in English and a 390px phone in Chinese.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/long-text-fields-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_CHECK_OUTPUT, "Say where the report and screenshots go");
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT);
await mkdir(output, { recursive: true });
// https, so the page is a secure context: the clipboard and crypto.randomUUID.
const HOST = "yuzuno-long-text-fields.test";
const report = { task: "YN-106", checks: [], failures: [], writes: [], shots: [], errors: [] };

/** A pasted log: `lines` lines, CRLF endings, tabs, quotes and Chinese. */
const log = (lines) => Array.from({ length: lines }, (_, n) => `${n + 1}\t"评审" 第 ${n + 1} 行 ok`).join("\r\n");
/** 481 lines, about 12,000 bytes: within each long field's limit but the report's. */
const LONG = log(481);
/** For an itemized report's fields (4,000 and 8,000 bytes). */
const SHORTER = log(120);
/** 16,500 bytes: more than a comment takes. */
const OVER = "长".repeat(5_500);
const utf8 = (text) => new TextEncoder().encode(text).length;
assert.ok(utf8(LONG) < 16_384 && utf8(SHORTER) < 4_000 && utf8(OVER) > 16_384);

const words = {
  en: { newTask: "New task", description: "Description", result: "Result summary", addResult: "Add result", addReport: "Add itemized author report",
    addItem: "Add item", report: "What the author reports", remaining: "What remains", give: "Give to agent", note: "A note", edit: "Edit task",
    progress: "Latest progress", comment: "Add a note", addNote: "Add note", over: /^[\d,]+ bytes too long: this field takes at most 16,384 bytes/,
    linkPr: "Link a PR or Issue", prBody: "PR body", saveBlock: "Save changes" },
  zh: { newTask: "新建任务", description: "描述", result: "结果摘要", addResult: "添加结果", addReport: "添加逐项作者报告", addItem: "添加项目",
    report: "作者报告的情况", remaining: "还缺什么", give: "交给 Agent", note: "备注", edit: "编辑任务", progress: "最新进展", comment: "添加备注",
    addNote: "添加备注", over: /^超出 [\d,]+ 字节：这一栏最多 16,384 字节/, linkPr: "链接 PR 或 Issue", prBody: "PR 正文", saveBlock: "保存更改" },
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const user = { kind: "user", id: "user", name: "You" };
const task = { id: "T-1", title: "Synthetic task", description: "What the task is for.", status: "doing", assigneeAgentId: "a",
  assignee: { kind: "agent", id: "a", name: "Mori" }, progress: "", blocker: "", result: null, version: 1, projectId: "p",
  createdBy: user, updatedBy: user, createdAt: "2026-11-13T10:00:00Z", updatedAt: "2026-11-13T11:00:00Z" };
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs, "/api/ci": noCiRuns,
  "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
  // PR 2: the task's PR form, and this Codex Agent's own goal (none yet).
  "/api/pr-operations": { operations: [], repositories: [{ id: 7, fullName: "owner/repo" }], hasMore: false, nextBefore: null },
  "/api/agents/a/codex/goal": { state: "ready", reason: "", goal: null },
  "/api/agents/a/codex/skills": { skills: [] },
};
// The board's reads, as it asks Core (CollaborationBoard.tsx `call`).
const reads = {
  task_list: () => ({ tasks: [task], hasMore: false, counts: { doing: 1 } }),
  task_get: () => ({ task, activities: [], executions: [], hasMore: false }),
  peer_read: () => ({ messages: [], hasMore: false }),
  workspaces: (body) => ({ taskId: body.taskId, repositories: [], workspaces: [] }),
  github_links: () => ({ links: [], repositories: [] }),
  delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "m" } }),
  peers_list: () => ({ peers: [] }),
  task_research_list: () => ({ records: [] }),
  github_refresh: () => ({ refreshing: false }),
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
report.browser = browser.version();

async function open({ width, height, touch, lang }) {
  const writes = [];
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.addInitScript(({ lang }) => {
    window.EventSource = class { addEventListener() {} close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    // The conversation open: chosen per Workspace (T-195), this fixture's is "fixture".
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    localStorage.setItem("yuzuno.selected.fixture", JSON.stringify("a"));
  }, { lang });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      const operation = url.pathname.startsWith("/api/collaboration/") ? url.pathname.slice("/api/collaboration/".length) : null;
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      if (operation === "task_comment") {
        writes.push({ operation, body });
        return route.fulfill({ json: { activity: { seq: 2 } } });
      }
      if (operation && request.method() === "POST" && reads[operation]) return route.fulfill({ json: reads[operation](body) });
      if (request.method() === "GET") {
        const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
        return route.fulfill({ json: hit ? gets[hit] : operation?.startsWith("pr-") ? { reviews: [], operations: [], repositories: [], hasMore: false, nextBefore: null } : {} });
      }
      writes.push({ operation: `${request.method()} ${url.pathname}`, body });
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = resolve(dist, file);
    assert.ok(path.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
    } catch {
      return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`https://${HOST}/`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".collab-nav").first().click();
  await page.locator(".collab-task-card").first().waitFor({ timeout: 10_000 });
  return { context, page, writes };
}

const field = (page, label) => page.locator(`.long-text-field [data-composer-input][aria-label="${label}"]`).first();
/** The whole field around an editor: its label, the editor and its note. */
const fieldBox = (target) => target.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' long-text-field ')][1]");
const button = (page, name) => page.getByRole("button", { name, exact: true }).first();
/** Pasted from the clipboard into a field, as a person pastes. */
async function paste(page, target, text) {
  await target.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(250);
}
/** How far the block and the field reach past their form, and the page past the window, in px. */
const overflow = (target) =>
  target.evaluate((input) => {
    const right = (node) => node.getBoundingClientRect().right;
    const box = input.closest(".long-text-field");
    const form = input.closest("form") ?? box;
    const chip = box.querySelector(".pasted-text-chip");
    return {
      chip: chip ? right(chip) - right(box) : null,
      field: right(box) - right(form),
      form: form.scrollWidth - form.clientWidth,
      page: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  });
/** What the page had when a paste did not arrive: where focus was, what the field and the clipboard held. */
async function diagnose(page, target, name) {
  await page.screenshot({ path: `${output}/failed-${name}.png` }).catch(() => {});
  return target.evaluate(async (input) => ({
    active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
    editable: input.getAttribute("contenteditable"),
    text: input.textContent.slice(0, 80),
    focused: input === document.activeElement || input.contains(document.activeElement),
    clipboard: await navigator.clipboard.readText().then((t) => t.length, (e) => String(e)),
  }));
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
/** Pastes `text` into the field labelled `label`: one block that fits. */
async function foldsAndFits(page, label, text, view, shot) {
  const target = field(page, label);
  await target.waitFor({ timeout: 5_000 });
  await paste(page, target, text);
  const chips = target.locator(".pasted-text-chip");
  try {
    await chips.first().waitFor({ timeout: 5_000 });
  } catch (error) {
    throw new Error(`${label}: no block after the paste ${JSON.stringify(await diagnose(page, target, `${shot}-${view.name}`))}`, { cause: error });
  }
  assert.equal(await chips.count(), 1, `${label}: one block`);
  const reach = await overflow(target);
  assert.ok(reach.chip <= 1 && reach.field <= 1 && reach.form <= 1 && reach.page <= 1, `${label}: nothing reaches past the form: ${JSON.stringify(reach)}`);
  await shoot(target.locator("xpath=ancestor::form[1]"), `${shot}-${view.name}`);
  return { [label]: reach };
}
/** Sends `/goal` or `/review` from the conversation's composer: Yuzuno opens its dialog, nothing is sent. */
async function command(page, text) {
  await page.goto(`https://${HOST}/`);
  const composer = page.locator(".composer [data-composer-input]").first();
  try {
    await composer.waitFor({ timeout: 4_000 });
  } catch {
    // A phone shows one pane: the Agent's row opens its conversation.
    await page.locator(".agent-row .agent-select").first().click();
    await composer.waitFor({ timeout: 10_000 });
  }
  await composer.fill(text);
  await page.locator(".send-button").first().click();
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}
async function openTask(page) {
  await page.locator(".collab-task-card, [data-task-id='T-1']").first().click();
  await page.locator(".collab-task-actions").first().waitFor({ timeout: 10_000 });
}

try {
  for (const view of [
    { name: "desktop-1440-en", width: 1440, height: 1000, touch: false, lang: "en" },
    { name: "phone-390-zh", width: 390, height: 844, touch: true, lang: "zh" },
  ]) {
    const w = words[view.lang];
    const { context, page, writes } = await open(view);
    try {
      await check(`${view.name}: a new task's description folds a 481-line paste into one block that fits`, async () => {
        await button(page, w.newTask).click();
        return foldsAndFits(page, w.description, LONG, view, "new-task");
      });
      await page.goto(`https://${HOST}/`);
      await page.locator(".collab-nav").first().click();
      await openTask(page);
      await check(`${view.name}: a result's summary and itemized report fold a paste into one block each, and fit`, async () => {
        await button(page, w.addResult).click();
        const summary = await foldsAndFits(page, w.result, LONG, view, "result-summary");
        await button(page, w.addReport).click();
        await button(page, w.addItem).click();
        const item = await foldsAndFits(page, w.report, SHORTER, view, "result-report");
        const remaining = await foldsAndFits(page, w.remaining, SHORTER, view, "result-remaining");
        return { ...summary, ...item, ...remaining };
      });
      await check(`${view.name}: a dispatch's note folds a 481-line paste into one block that fits`, async () => {
        await button(page, w.give).click();
        return foldsAndFits(page, w.note, LONG, view, "dispatch-note");
      });
      await check(`${view.name}: the edited task's description and progress fold a paste into one block each, and fit`, async () => {
        await button(page, w.edit).click();
        const description = field(page, w.description);
        await description.waitFor({ timeout: 5_000 });
        await description.click();
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        return { ...(await foldsAndFits(page, w.description, LONG, view, "edit-description")),
          ...(await foldsAndFits(page, w.progress, LONG, view, "edit-progress")) };
      });
      await check(`${view.name}: a comment folds a 481-line paste into one block that fits, and sends it whole`, async () => {
        const shown = await foldsAndFits(page, w.comment, LONG, view, "comment");
        await button(page, w.addNote).click();
        const deadline = Date.now() + 10_000;
        while (!writes.some((write) => write.operation === "task_comment") && Date.now() < deadline) await page.waitForTimeout(50);
        const sent = writes.find((write) => write.operation === "task_comment");
        assert.ok(sent?.body.body === LONG, "the comment is the paste, whole");
        return { ...shown, sentBytes: utf8(sent.body.body) };
      });
      await check(`${view.name}: a comment longer than Core takes says how far over and holds Add note`, async () => {
        const count = writes.length;
        const target = field(page, w.comment);
        await paste(page, target, OVER);
        const note = fieldBox(target).locator(".home-reply-length[data-over]");
        await note.waitFor({ timeout: 5_000 });
        assert.match(await note.textContent(), w.over);
        assert.ok(await button(page, w.addNote).isDisabled(), "Add note is held");
        const reach = await overflow(target);
        assert.ok(reach.form <= 1 && reach.page <= 1, `nothing reaches past the form: ${JSON.stringify(reach)}`);
        await shoot(target.locator("xpath=ancestor::form[1]"), `comment-over-limit-${view.name}`);
        await page.waitForTimeout(300);
        assert.equal(writes.length, count, "nothing sent");
        return { note: await note.textContent() };
      });
      await check(`${view.name}: a PR's body folds a 481-line paste into one block that fits`, async () => {
        await button(page, w.linkPr).click();
        return foldsAndFits(page, w.prBody, LONG, view, "pr-body");
      });
      await check(`${view.name}: the Codex goal's objective folds a paste into one block that opens over the goal and closes back to it`, async () => {
        const dialog = await command(page, "/goal");
        const shown = await foldsAndFits(page, "Objective", SHORTER, view, "goal");
        const objective = field(page, "Objective");
        await objective.locator(".pasted-text-chip").first().click();
        const source = page.locator("textarea.pasted-text-source");
        await source.waitFor({ timeout: 5_000 });
        assert.equal((await source.inputValue()).replaceAll("\r\n", "\n"), SHORTER.replaceAll("\r\n", "\n"), "the block opens with its whole text");
        assert.equal(await page.locator('[role="dialog"]').count(), 2, "the block's dialog is over the goal's");
        await shoot(page.locator('[role="dialog"]').last(), `goal-block-open-${view.name}`);
        await source.press("End");
        await source.type(" edited");
        await button(page, w.saveBlock).click();
        await source.waitFor({ state: "detached", timeout: 5_000 });
        assert.equal(await page.locator('[role="dialog"]').count(), 1, "back to the goal's dialog");
        assert.ok(await dialog.isVisible(), "the goal's dialog stays open");
        assert.equal(await objective.locator(".pasted-text-chip").count(), 1, "still one block");
        return shown;
      });
      await check(`${view.name}: /review's instructions fold a 481-line paste into one block that fits`, async () => {
        const dialog = await command(page, "/review");
        await dialog.locator('input[type="radio"][value="custom"]').check({ force: true });
        return foldsAndFits(page, "Instructions", LONG, view, "review");
      });
    } finally {
      report.writes.push(...writes.map((write) => ({ view: view.name, operation: write.operation, bytes: utf8(write.body.body ?? "") })));
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
assert.ok(report.writes.every((write) => write.operation === "task_comment"), "only the comments this check sends");
