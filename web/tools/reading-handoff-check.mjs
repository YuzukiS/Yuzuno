// T-170: a reading place shared between the user's browsers, in Chromium,
// against a lab Core on its own port and data folder, with a synthetic
// conversation from the scripted Codex stand-in (no model). Two isolated
// browser contexts, a wide desktop window and a phone-sized one, are two
// browsers; a second tab in one of them is the same browser. An offer only
// reads; Continue opens the place as far into the message on the other
// screen; Not now and a handled version are not offered again; nothing is
// sent, marked read or saved by either. A Core without the endpoint (404)
// leaves local reading as it was. Chromium's emulated phone is not a real
// one: no Safari, no Tailnet.
//   YUZUNO_CORE_BIN=<lab Core> YUZUNO_UI_DIST=<isolated build> YUZUNO_LAB=<new short folder> \
//     YUZUNO_BROWSER_OUTPUT=<evidence folder> [YUZUNO_LAB_PORT=4425] node tools/reading-handoff-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
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
const port = Number(process.env.YUZUNO_LAB_PORT || 4425);
assert.notEqual(port, 4317, "4317 is the daily Core's port");
const fakeCodex = resolve(import.meta.dirname, "../../acceptance/turn-cost/fake_codex.py");

const report = { startedAt: new Date().toISOString(), checks: [], facts: {}, requests: {} };
const check = (name, fact) => {
  report.checks.push({ name, ...(fact === undefined ? {} : { fact }) });
  console.log(`PASS ${name}`);
};

// ---- Lab Core ----------------------------------------------------------------
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
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

if (!(await free(port))) throw new Error(`Port ${port} is in use; nothing was started`);
const existing = await readdir(lab).catch(() => []);
if (existing.length) throw new Error(`${lab} is not empty: use a new lab folder; nothing was started`);
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
const logFile = join(lab, "core.log");
const { openSync } = await import("node:fs");
const log = openSync(logFile, "a");
const coreProcess = spawn(coreBin, ["--port", String(port), "--data-dir", join(lab, "data"), "--web-dir", dist,
  "--cwd", join(lab, "task"), "--codex", fakeCodex], { env, stdio: ["ignore", log, log], detached: true });

let browser;
try {
  await until(async () => coreProcess.exitCode === null && (await core("GET", "/api/health")), "the lab Core to answer");
  check("the lab Core runs on its own port and data folder, without the caller's YUZUNO_* settings", { port });

  // ---- A synthetic conversation: short and long replies, no model ----------
  const projectId = (await core("POST", "/api/projects", { name: "Reading check" })).id;
  const create = async (name) => {
    const id = (await core("POST", "/api/agents", { name, cwd: join(lab, "task"), harness: "codex", model: "bench-model", projectId })).id;
    await until(async () => (await core("GET", `/api/agents/${id}`)).agent.connectionState === "connected", `${name} to connect`);
    return id;
  };
  const mori = await create("Mori");
  const hana = await create("Hana");
  const detail = () => core("GET", `/api/agents/${mori}`);
  for (const text of ["run:12:0:0:0", "run:400:0:0:0", "run:12:0:0:0", "run:400:0:0:0", "run:12:0:0:0"]) {
    const before = (await detail()).turns.filter((t) => t.status === "completed").length;
    await core("POST", `/api/agents/${mori}/messages`, { clientMessageId: randomUUID(), text });
    await until(async () => {
      const d = await detail();
      return d.turns.filter((t) => t.status === "completed").length > before && d.agent.status === "idle";
    }, "the Turn to complete");
  }
  const long = (await detail()).turns
    .map((turn) => ({ turn: turn.id, item: turn.items.find((i) => i.type === "agentMessage" && (i.text || "").length > 10_000)?.id }))
    .filter((m) => m.item);
  assert.equal(long.length, 2, "two long replies");
  report.facts.seed = { projectId, mori, hana, long };
  check("a synthetic Workspace: Mori with five finished Turns, two of them long replies, and Hana", { long: long.length });

  // ---- Browsers ------------------------------------------------------------
  browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
  const contexts = [];
  async function open(name, viewport, { mobile = false, oldCore = false } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
    contexts.push(context);
    const sent = (report.requests[name] = []);
    if (oldCore)
      await context.route("**/api/agents/*/reading**", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) sent.push({ method: request.method(), path: url.pathname + url.search, at: Date.now() });
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("yuzuno.appearance"))
        localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    return { context, sent, page: await tab(context) };
  }
  async function tab(context) {
    const page = await context.newPage();
    page.on("pageerror", (error) => (report.pageErrors ??= []).push(String(error)));
    // Every answer about Mori's place this page received, in order.
    page.readings = [];
    page.on("response", (response) => {
      if (response.request().method() !== "GET" || !response.url().includes(`/api/agents/${mori}/reading`)) return;
      const slot = page.readings.push(undefined) - 1;
      response.json().then((value) => (page.readings[slot] = value), () => (page.readings[slot] = null));
    });
    await page.goto(base + "/");
    await page.locator(".agent-row").first().waitFor();
    await page.waitForTimeout(300);
    return page;
  }
  const pane = (page) => page.locator(".main-panel .conversation-scroll");
  const composer = (page, name) => page.locator(`[data-composer-input][aria-label="Message ${name}"]`);
  const offer = (page) => page.locator(".source-navigation.reading-offer");
  const shot = (page, name) => page.screenshot({ path: join(output, `${name}.png`) });
  const reading = (page, method) => page.waitForResponse((r) => r.url().includes(`/api/agents/${mori}/reading`) && r.request().method() === method);
  /** Opens an Agent (from the list on a phone; `reopen` goes back to the
   * list first) and returns Core's answer about Mori's reading place. A page
   * that opened Mori by itself has asked already. */
  async function openAgent(page, name, { awaitReading = true, reopen = false } = {}) {
    const asked = page.readings.length;
    const already = !reopen && (await composer(page, name).isVisible());
    if (!already) {
      if (await page.locator(".phone-back").isVisible()) await page.locator(".phone-back").click();
      await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).click();
      await composer(page, name).waitFor();
    }
    let answer = null;
    if (awaitReading && name === "Mori") {
      await until(async () => page.readings.length > (already ? 0 : asked) && page.readings.at(-1) !== undefined, "the place to be read", 15);
      answer = page.readings.at(-1);
    }
    await page.waitForTimeout(400);
    return answer;
  }
  /** Where the pane's top is in a message: px from the message's top, its height, and the pane's. */
  const where = (page, { turn, item }) => pane(page).evaluate((el, [turn, item]) => {
    const message = el.querySelector(`[data-turn-id="${CSS.escape(turn)}"] [data-item-id="${CSS.escape(item)}"]`);
    if (!message) return null;
    const box = message.getBoundingClientRect(), top = el.getBoundingClientRect().top;
    return { into: top - box.top, screen: box.top, height: box.height, pane: el.clientHeight, visible: Math.min(box.bottom, top + el.clientHeight) - Math.max(box.top, top),
      atLatest: el.scrollHeight - el.clientHeight - el.scrollTop < 4 };
  }, [turn, item]);
  const scrollInto = async (page, message, progress) => {
    await pane(page).evaluate((el, [turn, item, progress]) => {
      const box = el.querySelector(`[data-turn-id="${CSS.escape(turn)}"] [data-item-id="${CSS.escape(item)}"]`).getBoundingClientRect();
      el.scrollTop += Math.round(box.top - el.getBoundingClientRect().top + progress * box.height);
      el.dispatchEvent(new Event("scroll"));
    }, [message.turn, message.item, progress]);
    await page.waitForTimeout(500);
  };
  const localPlaces = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("yuzuno.reading."))));
  const changes = (sent, since) => sent.filter((r) => r.at >= since && r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  const handoff = (source = "check") => core("GET", `/api/agents/${mori}/reading?source=${source}`);

  // 1. The desktop window reads 40% into the first long reply, then leaves.
  const desk = await open("desktop", { width: 1280, height: 800 });
  await openAgent(desk.page, "Mori");
  await scrollInto(desk.page, long[0], 0.4);
  const deskPlace = await where(desk.page, long[0]);
  let put = reading(desk.page, "PUT");
  await openAgent(desk.page, "Hana");
  const first = { sent: JSON.parse((await put).request().postData()), answer: await (await put).json() };
  assert.equal(first.answer.accepted, true);
  assert.equal(first.answer.sourceSeq, first.sent.clientSeq);
  assert.ok(!("offset" in first.sent.position) && !("savedAt" in first.sent.position), "no pixels or local times are shared");
  const shared = (await handoff()).handoff;
  assert.equal(shared.turnId, long[0].turn);
  assert.equal(shared.itemId, long[0].item);
  assert.ok(Math.abs(shared.progress - deskPlace.into / deskPlace.height) < 1e-3, `${shared.progress} vs ${deskPlace.into / deskPlace.height}`);
  assert.equal(shared.version, 1);
  await shot(desk.page, "1-desktop-left-for-hana");
  check("leaving a conversation shares the message and how far into it (0..1), once, with a write number Core accepts",
    { progress: shared.progress, desktopHeight: deskPlace.height, clientSeq: first.sent.clientSeq, label: shared.label });

  // 2. The phone opens Mori: an offer, and nothing moves.
  const phone = await open("phone", { width: 390, height: 844 }, { mobile: true });
  const seen = await openAgent(phone.page, "Mori");
  assert.equal(seen.handoff.version, 1);
  await offer(phone.page).waitFor();
  assert.match(await offer(phone.page).innerText(), /Continue where you were reading in another browser · just now/);
  const phoneBefore = await where(phone.page, long[0]);
  assert.ok(phoneBefore.atLatest, "the offer did not move the conversation");
  assert.deepEqual(changes(phone.sent, 0).filter((r) => r.includes("/reading")), [], "the phone only read the place");
  await shot(phone.page, "2-phone-offer");
  check("another browser is offered the place when it opens the conversation; reading it moves and writes nothing");

  // 3. Continue: the same message, as far into it on the taller phone message.
  await composer(phone.page, "Mori").click();
  await phone.page.keyboard.type("Draft on the phone before Continue.");
  await phone.page.waitForTimeout(300);
  const placesBefore = await localPlaces(phone.page);
  const review = (await detail()).agent;
  const clicked = Date.now();
  await offer(phone.page).locator(".secondary-button").click();
  await phone.page.locator(".source-navigation [role=status]", { hasText: /^Where you were reading in another browser$/ }).waitFor();
  await phone.page.waitForTimeout(800);
  const landed = await where(phone.page, long[0]);
  const expected = shared.progress * landed.height;
  assert.ok(Math.abs(landed.into - expected) <= 3, `into ${landed.into}, expected ${expected}`);
  assert.ok(landed.visible >= 48, "the message is in view");
  assert.ok(landed.height > deskPlace.height * 1.3, "the phone's message is taller: a pixel offset would land elsewhere");
  assert.equal(await composerDraft(composer(phone.page, "Mori")), "Draft on the phone before Continue.");
  assert.deepEqual(await localPlaces(phone.page), placesBefore, "Continue does not save this browser's place");
  const after = (await detail()).agent;
  assert.deepEqual([after.reviewedSeq, after.unreadCount], [review.reviewedSeq, review.unreadCount]);
  assert.deepEqual(changes(phone.sent, clicked), [], "Continue sends nothing: no PUT /reading, POST /review, /messages or /turns");
  await shot(phone.page, "3-phone-continued");
  check("Continue opens the same message as far into it on the phone, in view, keeping the draft; nothing is sent, saved or marked read", {
    progress: shared.progress, phone: { into: Math.round(landed.into), height: Math.round(landed.height) },
    desktop: { into: Math.round(deskPlace.into), height: Math.round(deskPlace.height) }, reviewedSeq: after.reviewedSeq });
  await phone.page.locator(".source-navigation:not(.reading-offer) button").first().click();
  await phone.page.waitForTimeout(400);

  // 4. The desktop's own place is not offered back to it, in this tab or a second one.
  const own = await openAgent(desk.page, "Mori");
  assert.equal(own.handoff.source, first.sent.source);
  assert.equal(await offer(desk.page).count(), 0);
  const second = await tab(desk.context);
  assert.equal((await openAgent(second, "Mori")).handoff.source, first.sent.source);
  assert.equal(await offer(second).count(), 0, "a second tab of the same browser");
  check("the browser that left the place, and its other tabs (one source per browser), are not offered it");

  // 5. The desktop moves on with its clock set back an hour: still accepted.
  await scrollInto(desk.page, long[1], 0.7);
  await desk.page.evaluate(() => { const back = Date.now() - 3_600_000; Date.now = () => back; });
  put = reading(desk.page, "PUT");
  await openAgent(desk.page, "Hana");
  const later = { sent: JSON.parse((await put).request().postData()), answer: await (await put).json() };
  assert.ok(later.sent.clientSeq > first.sent.clientSeq);
  assert.equal(later.answer.accepted, true);
  assert.equal((await handoff()).handoff.version, 2);
  check("a clock set back does not stop the next write: its number still goes up", { before: first.sent.clientSeq, after: later.sent.clientSeq });

  // 6. Not now: nothing moves, and that version is not offered again.
  const offered = await openAgent(phone.page, "Mori", { reopen: true });
  assert.equal(offered.handoff.version, 2);
  await offer(phone.page).waitFor();
  // Reading elsewhere while it is offered: Not now leaves what is on screen
  // where it is (the pane grows by the bar and shows a little more above).
  await scrollInto(phone.page, long[1], 0.3);
  const reading6 = await where(phone.page, long[1]);
  const dismissed = Date.now();
  await offer(phone.page).locator(".quiet-button").click();
  await phone.page.waitForTimeout(400);
  assert.equal(await offer(phone.page).count(), 0);
  const kept = await where(phone.page, long[1]);
  assert.ok(Math.abs(kept.screen - reading6.screen) <= 1, `${kept.screen} vs ${reading6.screen}`);
  assert.deepEqual(changes(phone.sent, dismissed), []);
  const again = await openAgent(phone.page, "Mori", { reopen: true });
  assert.equal(again.handoff.version, 2);
  assert.equal(await offer(phone.page).count(), 0, "a handled version is not offered again");
  check("Not now leaves the conversation where it is and that version is not offered again", { screen: Math.round(kept.screen), into: [Math.round(reading6.into), Math.round(kept.into)] });

  // 7. The phone reads elsewhere and leaves; the desktop, back in Mori where it
  //    left it itself, is offered the phone's place and continues there.
  await scrollInto(phone.page, long[0], 0.1);
  put = reading(phone.page, "PUT");
  await openAgent(phone.page, "Hana", { awaitReading: false });
  const fromPhone = { sent: JSON.parse((await put).request().postData()), answer: await (await put).json() };
  assert.equal(fromPhone.answer.accepted, true);
  assert.equal(fromPhone.sent.label, "browser");
  const phoneShared = (await handoff()).handoff;
  assert.equal(phoneShared.version, 3);
  const toDesk = await openAgent(desk.page, "Mori");
  assert.equal(toDesk.handoff.source, fromPhone.sent.source);
  const ownPlace = await where(desk.page, long[1]);
  assert.ok(ownPlace && Math.abs(ownPlace.into / ownPlace.height - 0.7) < 0.01, `the desktop reopens its own place first: ${JSON.stringify(ownPlace)}`);
  await offer(desk.page).waitFor();
  await shot(desk.page, "7-desktop-offer-over-own-place");
  await offer(desk.page).locator(".secondary-button").click();
  await desk.page.locator(".source-navigation [role=status]", { hasText: /^Where you were reading in another browser$/ }).waitFor();
  await desk.page.waitForTimeout(800);
  const onDesk = await where(desk.page, long[0]);
  assert.ok(Math.abs(onDesk.into - phoneShared.progress * onDesk.height) <= 3, `into ${onDesk.into}, expected ${phoneShared.progress * onDesk.height}`);
  check("a browser that reopens its own place is still offered another's, and Continue takes it there on the wider screen",
    { own: Math.round(ownPlace.into), progress: phoneShared.progress, landed: Math.round(onDesk.into), height: Math.round(onDesk.height) });

  // 8. Two tabs of one browser leave at once: one write is kept, neither is stuck.
  const tabs = [desk.page, second];
  await scrollInto(desk.page, long[0], 0.2);
  await scrollInto(second, long[1], 0.5);
  const versionBefore = (await handoff()).handoff.version;
  const puts = tabs.map((page) => reading(page, "PUT"));
  await Promise.all(tabs.map((page) => page.evaluate(() => window.dispatchEvent(new Event("pagehide")))));
  const answers = await Promise.all(puts.map(async (p) => ({ sent: JSON.parse((await p).request().postData()), answer: await (await p).json() })));
  const accepted = answers.filter((a) => a.answer.accepted).length;
  assert.ok(accepted >= 1);
  const now = (await handoff()).handoff;
  assert.equal(now.version, versionBefore + accepted);
  assert.ok(answers.some((a) => a.answer.accepted && a.sent.position.turnId === now.turnId), "Core keeps a write it accepted");
  for (const a of answers.filter((a) => !a.answer.accepted)) assert.ok(a.answer.sourceSeq >= a.sent.clientSeq);
  await scrollInto(second, long[0], 0.6);
  put = reading(second, "PUT");
  await second.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal((await (await put).json()).accepted, true, "the next write after a collision is accepted");
  check("two tabs leaving at once keep one write and the next is accepted", { seqs: answers.map((a) => [a.sent.clientSeq, a.answer.accepted]) });

  // 9. A Core without the endpoint: local reading as before, one attempt, draft kept.
  const old = await open("old-core", { width: 1280, height: 800 }, { oldCore: true });
  await openAgent(old.page, "Mori");
  assert.equal(await offer(old.page).count(), 0);
  await composer(old.page, "Mori").click();
  await old.page.keyboard.type("Draft kept without the endpoint.");
  await scrollInto(old.page, long[1], 0.3);
  const oldPlace = await where(old.page, long[1]);
  const left = Date.now();
  await openAgent(old.page, "Hana", { awaitReading: false });
  await old.page.waitForTimeout(2000);
  assert.deepEqual(changes(old.sent, left).filter((r) => r.includes("/reading")), [`PUT /api/agents/${mori}/reading`], "one attempt, no retry");
  await openAgent(old.page, "Mori");
  const back = await where(old.page, long[1]);
  assert.ok(Math.abs(back.into - oldPlace.into) <= 2, `local place restored: ${back.into} vs ${oldPlace.into}`);
  assert.equal(await composerDraft(composer(old.page, "Mori")), "Draft kept without the endpoint.");
  await shot(old.page, "9-old-core");
  check("against a Core without the endpoint (404) the page reads as before: local place and draft kept, one write attempt, no offer");

  assert.deepEqual(report.pageErrors ?? [], []);
  for (const context of contexts) await context.close();
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
