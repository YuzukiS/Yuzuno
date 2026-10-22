// T-170: the phone web app in a phone-sized browser context (390×844, touch),
// meant for Playwright's Linux WebKit (YUZUNO_WEBKIT_WS; see browser-engine.mjs).
// Linux WebKit is not iOS Safari: no real soft keyboard, visual viewport or
// background lifecycle. A lab Core on its own port and data folder runs the
// scripted Codex stand-in (no model).
//  1. Offline, the message draft stays and the page says Core cannot be
//     reached; back online it reconnects and shows a reply sent meanwhile.
//  2. A native question's typed answer survives a reload, is sent once when
//     the user sends it, and Core closes the question.
//  3. A message whose send answer is lost on the way back is not sent again
//     by the page; Core holds it once and the page shows it once.
// The page may reach only the lab Core; anything else is refused and listed.
//   YUZUNO_CORE_BIN=<lab Core> YUZUNO_UI_DIST=<isolated build> YUZUNO_LAB=<new short folder> \
//     YUZUNO_BROWSER_OUTPUT=<evidence folder> [YUZUNO_LAB_PORT=4426] [YUZUNO_WEBKIT_WS=<server>] \
//     node tools/webkit-phone-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { engine, launchBrowser } from "./browser-engine.mjs";
import { composerDraft } from "./browser-fixtures.mjs";

const need = (name) => {
  assert.ok(process.env[name], `Set ${name}`);
  return resolve(process.env[name]);
};
const coreBin = need("YUZUNO_CORE_BIN");
const dist = need("YUZUNO_UI_DIST");
assert.notEqual(dist, resolve("dist"), "Use an isolated build");
const lab = need("YUZUNO_LAB");
const output = need("YUZUNO_BROWSER_OUTPUT");
const port = Number(process.env.YUZUNO_LAB_PORT || 4426);
assert.notEqual(port, 4317, "4317 is the daily Core's port");
const fakeCodex = resolve(import.meta.dirname, "../../acceptance/turn-cost/fake_codex.py");

const report = { engine, startedAt: new Date().toISOString(), checks: [], facts: {}, requests: [], refused: [], pageErrors: [] };
const check = (name, fact) => {
  report.checks.push({ name, ...(fact === undefined ? {} : { fact }) });
  console.log(`PASS ${name}`);
};

async function free(port) {
  return new Promise((done) => {
    const server = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
async function treeSha256(root) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  };
  await walk(root);
  files.sort();
  const lines = await Promise.all(files.map(async (f) => `${f.slice(root.length + 1)} ${await sha256(f)}`));
  return { treeSha256: createHash("sha256").update(lines.join("\n")).digest("hex"), files: files.length };
}

const base = `http://127.0.0.1:${port}`;
async function core(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "X-Yuzuno-Client": "desktop", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function until(test, what, seconds = 60) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = await test().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

if (!(await free(port))) throw new Error(`Port ${port} is in use; nothing was started`);
if ((await readdir(lab).catch(() => [])).length) throw new Error(`${lab} is not empty: use a new lab folder; nothing was started`);
for (const sub of ["data", "task", "timeline"]) await mkdir(join(lab, sub), { recursive: true });
await mkdir(output, { recursive: true });
report.facts.sources = {
  core: { path: coreBin, sha256: await sha256(coreBin), bytes: (await stat(coreBin)).size },
  web: { path: dist, ...(await treeSha256(dist)) },
  fakeCodex: { path: fakeCodex, sha256: await sha256(fakeCodex) },
  sourceCommit: process.env.YUZUNO_SOURCE_COMMIT || null,
};
// The caller's YUZUNO_* settings name the daily Core's helpers: never passed on.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("YUZUNO_")));
env.T9_TIMELINE = join(lab, "timeline");
const log = openSync(join(lab, "core.log"), "a");
const coreProcess = spawn(coreBin, ["--port", String(port), "--data-dir", join(lab, "data"), "--web-dir", dist,
  "--cwd", join(lab, "task"), "--codex", fakeCodex], { env, stdio: ["ignore", log, log], detached: true });

let browser;
try {
  await until(async () => coreProcess.exitCode === null && (await core("GET", "/api/health")), "the lab Core to answer");
  check("the lab Core runs on its own port and data folder, without the caller's YUZUNO_* settings", { port });

  const projectId = (await core("POST", "/api/projects", { name: "Phone check" })).id;
  const id = (await core("POST", "/api/agents", { name: "Kiri", cwd: join(lab, "task"), harness: "codex", model: "bench-model", projectId })).id;
  await until(async () => (await core("GET", `/api/agents/${id}`)).agent.connectionState === "connected", "Kiri to connect");
  const detail = () => core("GET", `/api/agents/${id}`);
  const completed = async () => (await detail()).turns.filter((t) => t.status === "completed").length;
  /** Sends from outside the page, as another client would, and waits for the Turn. */
  async function sendElsewhere(text, { wait = true } = {}) {
    const before = await completed();
    await core("POST", `/api/agents/${id}/messages`, { clientMessageId: randomUUID(), text });
    if (wait) await until(async () => (await completed()) > before && (await detail()).agent.status === "idle", "the Turn to complete");
  }
  await sendElsewhere("run:6:0:0:0");
  report.facts.seed = { projectId, id };
  check("a synthetic Workspace: Kiri with one finished Turn");

  browser = await launchBrowser();
  report.facts.browser = { engine, version: browser.version() };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  // A procedure, not network isolation: only the lab Core is let through.
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    report.refused.push(route.request().url());
    return route.abort();
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) report.requests.push({ method: request.method(), path: url.pathname, at: Date.now() });
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) });
  const composer = page.locator('[data-composer-input][aria-label="Message Kiri"]');
  const turnsShown = () => page.locator(".main-panel .conversation-scroll [data-turn-id]").count();
  const status = async () => ({
    label: await page.locator("[data-core-status]").getAttribute("data-core-status").catch(() => null),
    title: await page.locator("[data-core-status]").getAttribute("title").catch(() => null),
    banner: await page.locator(".core-connection-banner").isVisible().catch(() => false),
  });
  const posts = (since, part) => report.requests.filter((r) => r.at >= since && r.method === "POST" && r.path.includes(part));
  async function openKiri() {
    await page.locator(".agent-row").first().waitFor();
    if (await composer.isVisible()) return;
    if (await page.locator(".phone-back").isVisible()) await page.locator(".phone-back").click();
    await page.locator('.agent-row .agent-select[aria-label="Open Kiri"]').click();
    await composer.waitFor();
  }
  await page.goto(base + "/");
  await openKiri();
  report.facts.userAgent = await page.evaluate(() => navigator.userAgent);
  report.facts.viewport = await page.evaluate(() => ({ inner: [innerWidth, innerHeight], touch: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches }));
  await shot("0-opened");

  // ---- 1. Offline and back ------------------------------------------------------
  const draft = "Written while the network goes away.";
  await composer.click();
  await page.keyboard.type(draft);
  assert.equal(await composerDraft(composer), draft, "the composer holds what was typed");
  const shownBefore = await turnsShown();
  const offAt = Date.now();
  await context.setOffline(true);
  const noticed = await until(async () => {
    const s = await status();
    return (s.banner || /unreachable|reconnecting/i.test(`${s.label} ${s.title}`)) && s;
  }, "the page to say Core cannot be reached", 45);
  const noticedAfter = (Date.now() - offAt) / 1000;
  await shot("1-offline");
  assert.equal(await composerDraft(composer), draft, "draft kept while offline");
  await sendElsewhere("run:3:0:0:0");
  await context.setOffline(false);
  const onAt = Date.now();
  await until(async () => (await turnsShown()) > shownBefore && !(await status()).banner, "the reply sent meanwhile to appear", 60);
  const recoveredAfter = (Date.now() - onAt) / 1000;
  const back = await status();
  assert.equal(await composerDraft(composer), draft, "draft kept after reconnecting");
  await shot("1-back-online");
  check("offline, the draft stays and the page says Core cannot be reached; back online it reconnects and shows a reply sent meanwhile, draft intact",
    { noticed, noticedAfterSeconds: noticedAfter, back, recoveredAfterSeconds: recoveredAfter, nonGetWhileOffline: report.requests.filter((r) => r.at >= offAt && r.at < onAt && r.method !== "GET").length });

  // ---- 2. A native question's answer --------------------------------------------
  const asked = Date.now();
  await sendElsewhere("question", { wait: false });
  const card = page.locator("section.pending-card", { hasText: "A quick question for you" });
  const field = page.getByLabel("Your answer: Which colour should the label be?");
  await card.waitFor({ timeout: 30_000 });
  await field.click();
  await page.keyboard.type("Teal, like the leaf");
  await page.waitForTimeout(800);
  await page.reload();
  await openKiri();
  await card.waitFor({ timeout: 30_000 });
  assert.equal(await field.inputValue(), "Teal, like the leaf", "the typed answer is back after a reload");
  assert.equal(await composerDraft(composer), draft, "the message draft is back after a reload");
  assert.deepEqual(posts(asked, "/respond"), [], "nothing answered before Send answer");
  await shot("2-question-after-reload");
  check("a native question's typed answer, and the message draft, survive a reload; nothing is sent");
  const answeredAt = Date.now();
  await card.getByRole("button", { name: "Send answer" }).click();
  await until(async () => !(await card.isVisible()), "the question to close in the page", 30);
  await until(async () => {
    const d = await detail();
    return d.agent.status === "idle" && !(d.pending ?? []).length && d;
  }, "Core to close the question and finish the Turn", 30);
  await page.waitForTimeout(1500);
  assert.equal(posts(answeredAt, "/respond").length, 1, "one answer request");
  check("the answer is sent once; Core closes the question and the Turn ends", { answerPosts: posts(answeredAt, "/respond").length });

  // ---- 3. A send whose answer is lost -------------------------------------------
  const lost = [];
  await page.route(`**/api/agents/${id}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const reached = await route.fetch();
    lost.push({ status: reached.status() });
    await route.abort("failed");
  });
  const turnsBefore = (await detail()).turns.length;
  const sentAt = Date.now();
  await page.locator(".send-button").click();
  await until(async () => lost.length === 1, "the send to reach Core", 20);
  await page.waitForTimeout(1200);
  const noteSoon = await page.locator(".main-panel").innerText();
  await shot("3-answer-lost");
  await until(async () => {
    const d = await detail();
    return d.agent.status === "idle" && d.turns.length > turnsBefore && d;
  }, "the Turn of the lost-answer message to finish", 60);
  await page.waitForTimeout(12_000);
  const held = (await detail()).turns.flatMap((t) => t.items).filter((i) => i.type === "userMessage" && JSON.stringify(i.content ?? i.text ?? "").includes(draft)).length;
  const shown = await page.locator(".main-panel .conversation-scroll").getByText(draft).count();
  await shot("3-settled");
  assert.equal(posts(sentAt, "/messages").length, 1, "the page sent it once");
  assert.equal(lost.length, 1, "one request reached Core");
  assert.equal(held, 1, "Core holds the message once");
  assert.equal(shown, 1, "the page shows it once");
  check("a message whose send answer is lost is not sent again by the page; Core holds it once and the page shows it once",
    { coreAnswered: lost, pagePosts: posts(sentAt, "/messages").length, held, shown, noteSoon: noteSoon.match(/(Delivery unconfirmed[^\n]*|Not confirmed[^\n]*|Sending…|Received by[^\n]*|Sent ·[^\n]*)/g) ?? [] });
  await page.unroute(`**/api/agents/${id}/messages`);

  assert.deepEqual(report.refused, [], "the page asked for nothing outside the lab Core");
  assert.deepEqual(report.pageErrors, [], "no page errors");
  await context.close();
  report.passed = true;
} finally {
  await browser?.close().catch(() => {});
  if (coreProcess.exitCode === null) {
    try { process.kill(-coreProcess.pid, "SIGTERM"); } catch {}
    await until(async () => coreProcess.exitCode !== null || coreProcess.signalCode !== null, "Core to stop", 20).catch(() => {
      try { process.kill(-coreProcess.pid, "SIGKILL"); } catch {}
    });
  }
  report.facts.coreStopped = coreProcess.exitCode !== null || coreProcess.signalCode !== null;
  report.passed ??= false;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 1));
}
