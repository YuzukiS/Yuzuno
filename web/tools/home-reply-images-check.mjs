// YN-134 S4 in Chromium, against the production bundle with an explicit API
// fixture (no Core, no Agent; nothing sent but what these checks send), on
// Home at 1440 and a 390px phone, in English and Chinese:
//  - a report card's reply has "+" inside its box at the bottom left (44px on
//    a phone); images chosen show under the text, inside the card;
//  - choosing an Agent that can't take images says so under them and holds
//    Send; the one that can takes the reply with the images' IDs, and the
//    sent line counts them;
//  - an Ask's pick goes with the words and images beside it, as one reply,
//    with the one button that names the pick (YN-213);
//  - an answered Ask's card shows the images its reply took;
//  - nothing is wider than the window.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/home-reply-images-check.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const HOST = "yuzuno-home-reply-images.test";
const report = { task: "YN-134", slice: "S4", checks: [], failures: [], writes: [], shots: [], errors: [], console: [] };

const now = Date.now();
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage", projectId: "p1",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
// Lab's harness takes no images (Core's input_images::takes_images).
const agents = [{ ...base, id: "mori", name: "Mori" }, { ...base, id: "lab", name: "Lab", harness: "dsh" }];
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

const browser = await launchBrowser();
// Real PNGs, each its own colour and so its own content-addressed image: drawn by this browser.
const pngs = [];
{
  const painter = await browser.newPage({ viewport: { width: 160, height: 100 } });
  for (let i = 0; i < 4; i++) {
    await painter.setContent(`<body style="margin:0"><div style="width:160px;height:100px;background:linear-gradient(135deg,hsl(${i * 70 + 20} 45% 55%),hsl(${i * 70 + 50} 60% 85%))"></div></body>`);
    pngs.push(await painter.screenshot({ type: "png" }));
  }
  await painter.close();
}
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
const ANSWERED = [`${sha(pngs[2])}.png`, `${sha(pngs[3])}.png`];
const template = () => [
  section("pick", "ask", "Which layout ships?", 3, { ask: { question: "Which layout ships?", state: "open",
    reply: { options: [{ id: "a", label: "Layout A" }, { id: "b", label: "Layout B" }], freeText: true } } }),
  section("done", "ask", "Is the export clear?", 2, { ask: { question: "Is the export clear?", state: "replied", reply: { freeText: true },
    repliedAt: new Date(now - 5 * 60_000).toISOString(), replyText: "Mostly; the header overlaps on a phone, see the screenshots.", replyImages: ANSWERED } }),
  section("notes", "report", "Notes", 2),
];
const home = (sections) => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["mori"] },
    errors: [], pending: [], jobs: [],
    brief: { version: 9, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const words = {
  en: { choose: "Choose images", plus: "Add", refusal: "Lab can't receive images; Codex, Claude and OpenCode Agents can. Remove the images or choose someone else.",
    sent: /2 images went with it\./ },
  zh: { choose: "选择图片", plus: "添加", refusal: "Lab 不能接收图片（Codex、Claude 和 OpenCode Agent 可以）。移除图片，或换一个收件人。", sent: /带了 2 张图片。/ },
};

async function open({ width, height, touch, lang }) {
  const sections = template();
  const writes = [];
  const stored = new Map(ANSWERED.map((id, i) => [id, pngs[i + 2]]));
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  }, { lang });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/projects/p1/images" && method === "POST") {
      const bytes = request.postDataBuffer();
      const id = `${sha(bytes)}.png`;
      stored.set(id, bytes);
      return route.fulfill({ json: { id, ...pngSize(bytes), bytes: bytes.length } });
    }
    const image = path.match(/^\/api\/projects\/p1\/images\/([0-9a-f]{64}\.png)$/);
    if (image && stored.has(image[1])) return route.fulfill({ body: stored.get(image[1]), contentType: "image/png" });
    // The Project's page reads its front desk and requests (none here), and its linked repositories (a POST read).
    if (path === "/api/projects/p1/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "mori" } });
    if (path === "/api/projects/p1/requests" && method === "GET") return route.fulfill({ json: { requests: [], hasMore: false } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      const sent = JSON.parse(request.postData() || "{}");
      writes.push({ path, body: sent });
      if (path === "/api/projects/p1/brief/reply")
        return route.fulfill({ json: { input: { text: sent.text, clientMessageId: sent.clientMessageId, images: sent.images ?? [] }, status: "accepted", turnId: "mori-t2", error: null } });
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
  page.on("pageerror", (error) => report.errors.push(`${lang}-${width}: ${error.message}`));
  // A screen the app could not show logs why (its error boundary): kept, so a failure names it.
  page.on("console", (message) => {
    if (message.type() === "error") report.console.push(`${lang}-${width}: ${message.text().slice(0, 500)}`);
  });
  // The Project's page, where its cards are (YN-86).
  await page.goto(`https://${HOST}/#/home?w=ws&p=p1`);
  try {
    await page.locator('[data-project-home="p1"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-section-key="notes"]').first().waitFor({ timeout: 10_000 });
  } catch (error) {
    await page.screenshot({ path: `${output}/open-failed-${lang}-${width}.png`, fullPage: true });
    throw error;
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page, writes };
}

const card = (page, key) => page.locator(`[data-section-key="${key}"]`).first();
const replies = (writes) => writes.filter((w) => w.path.endsWith("/brief/reply")).map((w) => w.body);
async function sent(page, writes, count) {
  const deadline = Date.now() + 10_000;
  while (replies(writes).length < count && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(replies(writes).length, count, "replies sent");
  await page.waitForTimeout(200);
}
async function shoot(locator, name) {
  const shot = `${output}/${name}.png`;
  await locator.screenshot({ path: shot });
  report.shots.push(`${name}.png`);
}
async function check(name, fn) {
  try {
    const extra = await fn();
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: error.message });
    console.log(`FAIL ${name}\n  ${error.message.split("\n").join("\n  ")}`);
  }
}
const choose = (page, box, label, files) =>
  box.locator(`input[aria-label="${label}"]`).setInputFiles(files.map((i) => ({ name: `shot-${i + 1}.png`, mimeType: "image/png", buffer: pngs[i] })));
const pickAgent = (box, agentId) => box.locator(".home-reply-target select").selectOption(agentId);
/** Inside its box: "+" at the bottom left, the thumbnails within, and nothing wider than the window. */
const layout = (box) => box.evaluate((el) => {
  const frame = el.querySelector(".home-composer").getBoundingClientRect();
  const plus = el.querySelector(".home-composer .composer-plus").getBoundingClientRect();
  const outside = [...el.querySelectorAll(".home-composer .input-image")].filter((t) => {
    const r = t.getBoundingClientRect();
    return r.left < frame.left - 0.5 || r.right > frame.right + 0.5;
  }).length;
  return { plusLeft: plus.left - frame.left, plusBottom: frame.bottom - plus.bottom, plusHeight: plus.height, plusWidth: plus.width,
    thumbs: el.querySelectorAll(".home-composer .input-image").length, outside,
    page: document.scrollingElement.scrollWidth, window: innerWidth };
});

try {
  for (const view of [
    { name: "en-1440", width: 1440, height: 1000, touch: false, lang: "en" },
    { name: "zh-1440", width: 1440, height: 1000, touch: false, lang: "zh" },
    { name: "en-390", width: 390, height: 844, touch: true, lang: "en" },
    { name: "zh-390", width: 390, height: 844, touch: true, lang: "zh" },
  ]) {
    const w = words[view.lang];
    const { context, page, writes } = await open(view);
    try {
      await check(`${view.name}: a card's reply takes images, says when the Agent chosen can't, and sends their IDs`, async () => {
        const notes = card(page, "notes");
        await notes.locator(".home-reply-open").click();
        const box = notes.locator(".home-card-reply");
        await box.locator(".home-text-reply [data-composer-input]").fill(view.lang === "en" ? "Check the third number against the screenshots." : "第三项的数字和截图对一下。");
        await choose(page, box, w.choose, [0, 1]);
        await box.locator(".home-composer .input-image").nth(1).waitFor();
        let fit = await layout(box);
        assert.ok(fit.plusLeft <= 12 && fit.plusBottom <= 8, `"+" at the box's bottom left: ${JSON.stringify(fit)}`);
        if (view.touch) assert.ok(fit.plusHeight >= 44 && fit.plusWidth >= 44, `"+" at least 44px on a phone: ${JSON.stringify(fit)}`);
        assert.equal(fit.outside, 0, `thumbnails inside the box: ${JSON.stringify(fit)}`);
        assert.ok(fit.page <= fit.window + 1, `nothing wider than the window: ${JSON.stringify(fit)}`);
        await pickAgent(box, "lab");
        const note = box.locator('.home-composer-note[role="status"]');
        assert.equal((await note.innerText()).trim(), w.refusal);
        assert.equal(await box.locator("button[type=submit]").isDisabled(), true, "Send is held");
        await shoot(notes, `${view.name}-card-refusal`);
        await pickAgent(box, "mori");
        await note.waitFor({ state: "detached" });
        await box.locator("button[type=submit]").click();
        await sent(page, writes, 1);
        const reply = replies(writes)[0];
        assert.equal(reply.key, "notes");
        assert.equal(reply.images.length, 2);
        await box.locator(".home-note[role=status]").filter({ hasText: w.sent }).waitFor();
        await shoot(notes, `${view.name}-card-sent`);
        return { fit, images: reply.images.length };
      });

      await check(`${view.name}: an Ask's pick goes with the words and images beside it, as one reply (YN-213)`, async () => {
        const pick = card(page, "pick");
        const box = pick.locator(".home-ask-reply");
        await box.locator(".home-text-reply [data-composer-input]").fill(view.lang === "en" ? "A, but with B's menu" : "A，菜单用 B 的");
        await choose(page, box, w.choose, [1]);
        await box.locator(".home-composer .input-image").first().waitFor();
        const fit = await layout(box);
        assert.equal(fit.outside, 0, JSON.stringify(fit));
        assert.ok(fit.page <= fit.window + 1, `nothing wider than the window: ${JSON.stringify(fit)}`);
        await shoot(pick, `${view.name}-ask-draft`);
        // Picked, then sent with the one button that names it.
        await box.locator(".home-ask-options label").filter({ hasText: "Layout A" }).locator("input").check();
        const submit = box.locator(".home-ask-decision .home-ask-actions .primary-button");
        assert.match(await submit.textContent(), /Layout A/);
        await submit.click();
        await sent(page, writes, 2);
        const reply = replies(writes)[1];
        assert.equal(reply.choice, "a");
        assert.equal(reply.text, view.lang === "en" ? "A, but with B's menu" : "A，菜单用 B 的");
        assert.equal(reply.images?.length, 1, "the images go with the pick");
        return { choice: reply.choice, images: reply.images.length };
      });

      await check(`${view.name}: an answered Ask's card shows the images its reply took`, async () => {
        const done = card(page, "done");
        const images = done.locator(".home-answer .input-image img");
        await images.nth(1).waitFor();
        // Thumbnails load lazily: in view first, then loaded.
        await done.scrollIntoViewIfNeeded();
        await done.evaluate((el) => Promise.all([...el.querySelectorAll(".home-answer .input-image img")].map((img) =>
          img.complete && img.naturalWidth ? null : new Promise((ok) => { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", ok, { once: true }); }))));
        const shown = await done.evaluate((el) => {
          const frame = el.getBoundingClientRect();
          return [...el.querySelectorAll(".home-answer .input-image img")].map((img) => {
            const r = img.getBoundingClientRect();
            return { loaded: img.naturalWidth > 0, inside: r.left >= frame.left && r.right <= frame.right, src: img.getAttribute("src") };
          });
        });
        assert.equal(shown.length, 2);
        assert.ok(shown.every((s) => s.loaded && s.inside), JSON.stringify(shown));
        assert.deepEqual(shown.map((s) => s.src), ANSWERED.map((id) => `/api/projects/p1/images/${id}?thumb=true`));
        await shoot(done, `${view.name}-answered`);
        return { shown: shown.length };
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/home-reply-images-check.json`, `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.failures, [], "every check passed");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`home-reply-images-check: ${report.checks.length} checks, ${report.shots.length} screenshots`);
