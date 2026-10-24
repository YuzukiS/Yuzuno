// T-189: this device's preferences in Chromium, with every API answered here
// (no Core, no daily configuration or data).
//  1. The production build's conversation composer sends with the key this
//     device's stored preference names. Unset and for each choice, from a
//     keyboard and on a touch screen, it checks Return, Shift+Return and
//     Ctrl+Return. It also checks Return while an input method composes, and
//     that the composer's key hint says the same.
//  2. Sending messages and Keyboard shortcuts on their own, in a harness of
//     the Settings dialog's pane: a 320 px phone and a desktop at 16 and 24
//     px text, the keyboard alone, and a save the browser refuses.
//  3. The path a user takes, in the production build's real Settings:
//     search, open the section, choose; the conversation's composer and its
//     hint follow it. Then a reload, a refused save (in effect in this
//     window, said again when Settings is reopened, gone after a reload),
//     Try again, Restore defaults, and the shortcuts help. From the keyboard
//     alone, and on a 320 px phone at 24 px text.
// Each composer case is checked, and each failure listed (FAIL <case>), before
// the check fails: on a build without the preference exactly the cases it
// changes fail. T189_PARTS=composer runs part 1 alone, as on such a build.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/device-preferences-check.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_CHECK_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT);
await mkdir(output, { recursive: true });
const parts = (process.env.T189_PARTS || "composer,settings,path").split(",");
const report = { task: "T-189", source: process.env.T189_HEAD || null, parts, checks: [], composer: [], composerFailures: [], layout: [], requests: [], unmodelledGets: {}, errors: [], consoleErrors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const TOUCH = "(hover: none) and (pointer: coarse)";
// Every request is answered here; nothing listens there. A loopback address
// is a secure context, as Core's own is, so the app can name a message
// (crypto.randomUUID) and send it.
const ORIGIN = "http://127.0.0.1:4399";
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

// ---- 1. The composer, in the app ----

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agents = [{ ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected", threadId: "thread-a" }];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = [{ id: "t0", status: "completed", items: [
  { id: "u0", type: "userMessage", content: [{ type: "text", text: "Check the composer." }] },
  { id: "r0", type: "agentMessage", text: "The composer is ready." },
] }];
// Codex's plan usage, read once the event stream is open: not known yet.
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const devices = {
  keyboard: { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" },
  touch: { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" },
  phone: { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" },
};

async function openApp(device, sendKey, label, fontSize = 16) {
  const context = await browser.newContext(devices[device]);
  const page = await context.newPage();
  const sends = [];
  await page.addInitScript(({ sendKey, fontSize }) => {
    // Core's event stream, open and quiet.
    window.EventSource = class {
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          this.onopen?.({});
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    };
    // Once: a reload keeps what the page itself stored since.
    if (sessionStorage.getItem("t189-seeded")) return;
    sessionStorage.setItem("t189-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize, palette: "garden" }));
    if (sendKey) localStorage.setItem("yuzuno.preferences", JSON.stringify({ sendKey }));
  }, { sendKey: sendKey ?? null, fontSize });
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message}`));
  // React reports an error its boundary caught here, not as a page error.
  page.on("console", (message) => {
    if (message.type() === "error" && report.consoleErrors.length < 50) report.consoleErrors.push(`${label}: ${message.text().slice(0, 300)}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:") return route.continue();
    assert.equal(url.origin, ORIGIN);
    const path = url.pathname;
    // A message sent: counted, and answered as refused, so nothing changes.
    if (method === "POST" && path === "/api/agents/a/messages") {
      sends.push(JSON.parse(request.postData() || "{}"));
      report.requests.push({ case: label, method, path, answered: 400 });
      return route.fulfill({ status: 400, json: { error: "This check sends nothing" } });
    }
    if (path === "/api/agents/a/reading") {
      report.requests.push({ case: label, method, path, answered: 200 });
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    }
    if (method === "POST" && path === "/api/agents/a/review") {
      report.requests.push({ case: label, method, path, answered: 200 });
      return route.fulfill({ json: {} });
    }
    if (method !== "GET") {
      report.requests.push({ case: label, method, path, answered: 400, unexpected: true });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-prefs" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns },
      "/api/home": { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] },
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/agents/a/codex/usage": usage,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unmodelledGets[path] = (report.unmodelledGets[path] || 0) + 1;
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  });
  const input = page.locator('[data-composer-input][aria-label="Message Mori"]');
  try {
    await page.goto(`${ORIGIN}/`);
    await page.locator(".agent-row").first().waitFor({ timeout: 10_000 });
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click({ timeout: 10_000 });
    await input.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(250);
    const touch = await page.evaluate((media) => matchMedia(media).matches, TOUCH);
    assert.equal(touch, device !== "keyboard", `${label}: the browser is ${device === "keyboard" ? "not " : ""}a touch screen`);
  } catch (error) {
    await setupFailed(page, context, label, error);
  }
  return { context, page, input, sends };
}

/** A page that didn't open as its case needs: its picture, what it said and
 * Playwright's call log are kept, its browser closed, and the part stopped
 * (not each case after it waiting out the same failure). */
async function setupFailed(page, context, label, error) {
  const screenshot = `setup-${label.replace(/[^a-z0-9]+/gi, "-")}.png`;
  await page.screenshot({ path: resolve(output, screenshot) }).catch(() => {});
  const shown = await page.locator('[role="alert"], [role="dialog"], h1, h2').allTextContents().catch(() => []);
  report.setupFailures = [...(report.setupFailures || []), { case: label, screenshot, shown, message: String(error?.message || error).slice(0, 4000) }];
  await context.close();
  error.setup = true;
  throw error;
}

const lines = (input) => input.evaluate((el) => [...el.querySelectorAll(".cm-line")].map((line) => line.textContent));
const returnSends = (sendKey, touch) => sendKey === "enter" || ((sendKey ?? "auto") === "auto" && !touch);

/** One composer case: its failure is listed, and the next case runs. */
async function attempt(label, run) {
  try {
    await run();
    return true;
  } catch (error) {
    if (error?.setup) throw error;
    const message = String(error?.message || error).split("\n")[0];
    report.composerFailures.push({ case: label, message, detail: String(error?.message || error).slice(0, 2000) });
    console.log(`FAIL ${label}: ${message}`);
    return false;
  }
}

/** "draft", then one press: sent or a new line, and the hint beside it. */
async function pressCase(device, sendKey, press, outcome, label) {
  const sends = returnSends(sendKey, device === "touch");
  const app = await openApp(device, sendKey, label);
  try {
    // The hint before anything is sent: a refused send may show a notice in its place.
    const hint = (await app.page.locator(".composer-keys").textContent()).replace(/\s+/g, " ").trim();
    await app.input.click({ timeout: 10_000 });
    await app.page.keyboard.type("draft");
    await app.page.keyboard.press(press);
    await app.page.waitForTimeout(400);
    const text = await lines(app.input);
    // Sent: one message and no new line (the draft may be kept or cleared).
    const newLine = text.join("\n") === "draft\n";
    const seen = app.sends.length === 1 && !newLine ? "send" : app.sends.length === 0 && newLine ? "new line" : `${app.sends.length} sent, ${JSON.stringify(text)}`;
    // What the app said after it (the refused send's error, for one), to read a failure by.
    const alerts = await app.page.locator('[role="alert"]').allTextContents();
    report.composer.push({ device, sendKey: sendKey ?? null, press, expected: outcome, seen, text, hint, alerts });
    assert.equal(seen, outcome, label);
    assert.deepEqual(app.sends.map((body) => body.text), outcome === "send" ? ["draft"] : [], `${label}: what was sent`);
    assert.equal(hint, sends ? "↵ Send ⇧ ↵ New line" : "↵ New line Ctrl ↵ Send", `${label}: the composer's hint`);
  } finally {
    await app.context.close();
  }
}

/** An input method composing: its Return commits, nothing is sent. */
async function imeCase(device, sendKey, label) {
  const app = await openApp(device, sendKey, label);
  try {
    await app.input.click({ timeout: 10_000 });
    const cdp = await app.context.newCDPSession(app.page);
    await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.imeSetComposition", { text: "你", selectionStart: 1, selectionEnd: 1 });
    const prevented = await app.input.evaluate((el) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    await cdp.send("Input.insertText", { text: "你好" });
    await app.page.waitForTimeout(400);
    const text = await lines(app.input);
    report.composer.push({ device, sendKey: sendKey ?? null, press: "Enter while composing", expected: "input method", seen: { sent: app.sends.length, text, prevented } });
    assert.equal(app.sends.length, 0, `${label}: nothing sent`);
    assert.deepEqual(text, ["你好"], `${label}: the input method's text, no new line`);
    assert.equal(prevented, false, `${label}: the input method keeps its Return`);
  } finally {
    await app.context.close();
  }
}

async function composerCases() {
  for (const device of ["keyboard", "touch"])
    for (const sendKey of [undefined, "auto", "enter", "modEnter"]) {
      const sends = returnSends(sendKey, device === "touch");
      const expected = { Enter: sends ? "send" : "new line", "Shift+Enter": "new line", "Control+Enter": "send" };
      const name = `${device}, ${sendKey ?? "unset"}`;
      let passed = true;
      for (const [press, outcome] of Object.entries(expected))
        passed = (await attempt(`${name}, ${press}`, () => pressCase(device, sendKey, press, outcome, `${name}, ${press}`))) && passed;
      passed = (await attempt(`${name}, input method`, () => imeCase(device, sendKey, `${name}, input method`))) && passed;
      if (passed) check(`composer: ${name}: Return ${sends ? "sends" : "makes a new line"}, Shift+Return a new line, Ctrl+Return sends, composing Return is the input method's`);
    }
  assert.deepEqual(report.composerFailures, [], "every composer case");
}

// ---- 2. The two sections, in a harness ----

const root = fileURLToPath(new URL("../", import.meta.url));
let harness;
async function buildHarness() {
  await mkdir(join(root, "node_modules/.cache"), { recursive: true });
  const temp = await mkdtemp(join(root, "node_modules/.cache/device-preferences-check-"));
  try {
    const entry = join(temp, "entry.tsx");
    const src = (file) => JSON.stringify(join(root, "src", file));
    await writeFile(entry, `import React from 'react';import {createRoot} from 'react-dom/client';
import ${src("assets/fonts/fonts.css")};import ${src("styles.css")};import ${src("appearance.css")};import ${src("palettes.css")};import ${src("updates.css")};
import {initializeAppearance} from ${src("appearance.ts")};
import {Modal} from ${src("components.tsx")};
import {InputPreferencesSection} from ${src("InputPreferences.tsx")};
import {ShortcutHelpSection} from ${src("ShortcutHelp.tsx")};
initializeAppearance();
createRoot(document.getElementById('root')).render(
  <Modal open onOpenChange={() => {}} title="Settings" description="This device’s preferences." wide className="settings-modal">
    <div className="workspace-updates settings-layout">
      <div className="settings-nav" role="tablist" aria-label="Settings">
        <button type="button" role="tab" id="settings-tab-device" aria-selected="true" aria-controls="settings-panel-device">This device</button>
      </div>
      <div className="settings-pane" role="tabpanel" id="settings-panel-device" aria-labelledby="settings-tab-device">
        <InputPreferencesSection />
        <ShortcutHelpSection />
      </div>
    </div>
  </Modal>);`);
    const result = await build({
      root, configFile: false, logLevel: "silent", plugins: [react()],
      define: { "process.env.NODE_ENV": '"production"' },
      build: { write: false, cssCodeSplit: false, lib: { entry, name: "DevicePreferencesCheck", formats: ["iife"] } },
    });
    const files = (Array.isArray(result) ? result[0] : result).output;
    harness = { js: files.find((v) => v.type === "chunk").code, css: files.filter((v) => v.type === "asset" && v.fileName.endsWith(".css")).map((v) => v.source).join("\n") };
    assert.ok(harness.css.includes(".input-send-choice"), "the harness has the sections' styles");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const screens = {
  phone: { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" },
  desktop: { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" },
};
async function openHarness(screen, fontSize, label, { refuse = false } = {}) {
  const context = await browser.newContext(screens[screen]);
  const page = await context.newPage();
  await page.addInitScript(({ fontSize, refuse }) => {
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize, palette: "garden" }));
    if (!refuse) return;
    // The browser refuses this device's preferences, as when its storage is full.
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "yuzuno.preferences") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return set.call(this, key, value);
    };
  }, { fontSize, refuse });
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.protocol !== "http:") return route.continue();
    assert.equal(url.origin, ORIGIN);
    const body = { "/": '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>',
      "/harness.js": harness.js, "/harness.css": harness.css }[url.pathname];
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404, body: "" });
    if (body === undefined) {
      report.requests.push({ case: label, method: request.method(), path: url.pathname, answered: 404, unexpected: true });
      return route.fulfill({ status: 404, body: "" });
    }
    // UTF-8 said: the sections have ’, ⌘, ↵, ↑ and ↓.
    await route.fulfill({ body, contentType: `${types[extname(url.pathname) || ".html"]}; charset=utf-8` });
  });
  try {
    await page.goto(`${ORIGIN}/`);
    await page.locator(".input-preferences").waitFor({ timeout: 10_000 });
    await page.locator(".shortcut-help").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fontSize), String(fontSize), `${label}: text size`);
  } catch (error) {
    await setupFailed(page, context, label, error);
  }
  return { context, page };
}

/** What sticks out of the pane sideways, what overlaps, and the choices' heights. */
const measure = (page) => page.evaluate(() => {
  const pane = document.querySelector(".settings-pane");
  const box = pane.getBoundingClientRect();
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;
  const outside = [];
  for (const el of pane.querySelectorAll(".input-preferences *, .shortcut-help *")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.left < box.left - 1 || r.right > box.right + 1) outside.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right), text: el.textContent.slice(0, 40) });
  }
  // A shortcut's keys and what it does, side by side or one above the other, never on top of each other.
  const overlaps = [];
  for (const dt of pane.querySelectorAll(".shortcut-group dt")) {
    const dd = dt.nextElementSibling, a = dt.getBoundingClientRect(), b = dd.getBoundingClientRect();
    if (a.right > b.left + 1 && a.bottom > b.top + 1 && b.right > a.left + 1 && b.bottom > a.top + 1) overlaps.push({ keys: dt.textContent, action: dd.textContent });
  }
  // Text cut off inside its own box.
  const clipped = [...pane.querySelectorAll(".input-preferences small, .input-preferences strong, .input-preferences p, .shortcut-group dd, .shortcut-group dt, .settings-current")]
    .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => ({ el: name(el), text: el.textContent.slice(0, 40), scroll: el.scrollWidth, client: el.clientWidth }));
  return {
    width: innerWidth,
    page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    pane: { scroll: pane.scrollWidth, client: pane.clientWidth, left: Math.round(box.left), right: Math.round(box.right) },
    choices: [...pane.querySelectorAll(".input-send-choice")].map((el) => Math.round(el.getBoundingClientRect().height)).filter((height) => height > 0),
    columns: [...pane.querySelectorAll(".shortcut-group dl")].map((dl) => getComputedStyle(dl).gridTemplateColumns).find((value) => value !== "none") ?? null,
    outside, overlaps, clipped,
  };
});
const shoot = async (page, selector, file) => {
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(output, file) });
};

async function layoutCases() {
  for (const screen of ["phone", "desktop"])
    for (const fontSize of [16, 24]) {
      const label = `${screen}, ${fontSize} px`;
      const { context, page } = await openHarness(screen, fontSize, label);
      try {
        const m = await measure(page);
        report.layout.push({ screen, fontSize, ...m });
        await shoot(page, ".input-preferences", `${screen}-${fontSize}-sending.png`);
        await shoot(page, ".shortcut-help", `${screen}-${fontSize}-shortcuts.png`);
        assert.ok(m.page.scroll <= m.page.client, `${label}: the page doesn't scroll sideways`);
        assert.ok(m.pane.scroll <= m.pane.client, `${label}: Settings' pane doesn't scroll sideways`);
        assert.deepEqual(m.outside, [], `${label}: nothing sticks out of the pane`);
        assert.deepEqual(m.overlaps, [], `${label}: no shortcut's keys on what it does`);
        assert.deepEqual(m.clipped, [], `${label}: no text cut off`);
        assert.equal(m.choices.length, 3);
        assert.ok(m.choices.every((height) => height >= 44), `${label}: each choice is a finger's height: ${m.choices}`);
        check(`layout: ${label}: fits, nothing cut off or overlapping, choices ≥ 44 px`, { columns: m.columns });
      } finally {
        await context.close();
      }
    }
}

/** The focused element, as a user would name it. */
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  const choice = el?.closest(".input-send-choice");
  return {
    tag: el?.tagName.toLowerCase(), value: el?.value ?? null, text: el?.textContent.trim().slice(0, 40) ?? "",
    visible: el?.matches(":focus-visible") ?? false,
    ring: choice ? getComputedStyle(choice).outlineStyle : el ? getComputedStyle(el).outlineStyle : "none",
  };
});
const stored = (page) => page.evaluate(() => localStorage.getItem("yuzuno.preferences"));
const said = (page) => page.evaluate(() => ({
  status: document.querySelector(".input-preferences .save-status [role=status]")?.textContent.trim() ?? null,
  alert: document.querySelector(".input-preferences .save-status [role=alert]")?.textContent.trim() ?? null,
  current: document.querySelector(".input-preferences .settings-current").textContent.trim(),
  checked: document.querySelector('input[name="input-send-key"]:checked')?.value ?? null,
}));

async function keyboardCases() {
  for (const [screen, fontSize] of [["desktop", 16], ["phone", 24]]) {
    const label = `keyboard alone, ${screen}, ${fontSize} px`;
    // The phone is a touch screen (with a keyboard attached, here): there
    // Automatic makes Return a new line.
    const automatic = screen === "phone" ? "Return: New line" : "Return: Send";
    const { context, page } = await openHarness(screen, fontSize, label);
    try {
      // Tab from where the dialog puts focus to the send key's choices.
      const path = [];
      for (let n = 0; n < 12; n++) {
        const f = await focused(page);
        if (f.tag === "input") break;
        path.push(f.tag === "button" ? f.text || "button" : f.tag);
        await page.keyboard.press("Tab");
      }
      let f = await focused(page);
      assert.equal(f.value, "auto", `${label}: Tab reaches the choice in effect, Automatic (${path.join(" → ")})`);
      assert.deepEqual(await said(page), { status: "Using the defaults; nothing is saved on this device yet", alert: null, current: automatic, checked: "auto" });
      assert.ok(f.visible && f.ring !== "none", `${label}: the focused choice shows a ring (${f.ring})`);
      await page.screenshot({ path: resolve(output, `${screen}-${fontSize}-focus.png`) });
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(100);
      f = await focused(page);
      assert.equal(f.value, "enter", `${label}: the arrow moves to Return sends`);
      assert.equal(await stored(page), '{"sendKey":"enter"}');
      assert.deepEqual(await said(page), { status: "Saved on this device", alert: null, current: "Return: Send", checked: "enter" });
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(100);
      assert.equal(await stored(page), '{"sendKey":"modEnter"}');
      assert.deepEqual(await said(page), { status: "Saved on this device", alert: null, current: "Return: New line", checked: "modEnter" });
      await page.keyboard.press("Tab");
      f = await focused(page);
      assert.equal(f.text, "Restore defaults", `${label}: Tab then reaches Restore defaults`);
      assert.ok(f.visible && f.ring !== "none", `${label}: Restore defaults shows a ring`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      assert.equal(await stored(page), null, `${label}: Restore defaults removes this device's choice`);
      assert.deepEqual(await said(page), { status: "Defaults restored on this device", alert: null, current: automatic, checked: "auto" });
      check(`keyboard: ${screen}, ${fontSize} px: Tab, arrows and Return choose, save and restore the defaults; focus shown`, { tabs: path });
    } finally {
      await context.close();
    }
  }
}

async function refusedCase() {
  const label = "refused save, phone, 24 px";
  const { context, page } = await openHarness("phone", 24, label, { refuse: true });
  try {
    await page.locator('input[name="input-send-key"][value="enter"]').check();
    await page.waitForTimeout(100);
    assert.deepEqual(await said(page), {
      status: null, current: "Return: Send", checked: "enter",
      alert: "Not saved on this device: this browser’s storage for Yuzuno is full. Your choice applies in this window until you close or reload it.",
    });
    assert.equal(await stored(page), null);
    await page.locator(".input-preferences .save-status").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(100);
    const buttons = await page.locator(".input-preferences .save-status button").evaluateAll((list) => list.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    }));
    const width = await page.evaluate(() => innerWidth), height = await page.evaluate(() => innerHeight);
    report.layout.push({ screen: "phone", fontSize: 24, refused: true, buttons, ...(await measure(page)) });
    await page.screenshot({ path: resolve(output, "phone-24-refused.png") });
    assert.deepEqual(buttons.map((b) => b.text), ["Try again", "Restore defaults"]);
    assert.ok(buttons.every((b) => b.left >= 0 && b.right <= width && b.top >= 0 && b.bottom <= height), `${label}: both buttons on screen ${JSON.stringify(buttons)}`);
    const m = await measure(page);
    assert.ok(m.pane.scroll <= m.pane.client && !m.outside.length && !m.clipped.length, `${label}: the alert fits`);
    check("refused save: phone, 24 px: said, never Saved; Try again and Restore defaults on screen; fits");
  } finally {
    await context.close();
  }
}

async function settingsCases() {
  await buildHarness();
  await layoutCases();
  await keyboardCases();
  await refusedCase();
}

// ---- 3. The path a user takes: Settings, then the conversation ----

// The two Settings entries, as the catalog names them and its search finds
// them (settings-catalog.ts).
const INPUT_ENTRY = { search: "发送键", title: "Sending messages", editor: "input" };
const SHORTCUTS_ENTRY = { search: "快捷键", title: "Keyboard shortcuts", editor: "shortcuts" };

/** Settings, opened from the bar, at an entry's editor as its search finds it. */
async function openEditor(page, entry) {
  if (!(await page.getByRole("searchbox", { name: "Search settings" }).isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    await page.getByRole("searchbox", { name: "Search settings" }).waitFor({ timeout: 10_000 });
  }
  await page.getByRole("searchbox", { name: "Search settings" }).fill(entry.search);
  await page.getByRole("button", { name: `Open ${entry.title}`, exact: true }).click({ timeout: 10_000 });
  const editor = page.locator(`#settings-editor-${entry.editor}`);
  await editor.waitFor({ timeout: 10_000 });
  return editor;
}
async function closeSettings(page) {
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
}
/** What the send key's editor says and shows. */
const editorState = (editor) => editor.evaluate((el) => ({
  status: el.querySelector(".save-status [role=status]")?.textContent.trim() ?? null,
  alert: el.querySelector(".save-status [role=alert]")?.textContent.trim() ?? null,
  checked: el.querySelector('input[name="input-send-key"]:checked')?.value ?? null,
}));
/** The browser refusing (or again keeping) this device's preferences, from now on in this page. */
const refuseWrites = (page, refuse) => page.evaluate((refuse) => {
  const storage = Storage.prototype;
  window.t189Storage ||= { setItem: storage.setItem, removeItem: storage.removeItem };
  if (!refuse) return Object.assign(storage, window.t189Storage);
  const full = function (key, ...rest) {
    if (key === "yuzuno.preferences") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return window.t189Storage.setItem.call(this, key, ...rest);
  };
  storage.setItem = full;
  storage.removeItem = function (key) {
    if (key === "yuzuno.preferences") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return window.t189Storage.removeItem.call(this, key);
  };
}, refuse);
const composerHint = async (page) => (await page.locator(".composer-keys").textContent()).replace(/\s+/g, " ").trim();
/** A fresh "draft" and one press in the conversation: what it did. */
async function pressInConversation(app, key) {
  const before = app.sends.length;
  await app.input.click({ timeout: 10_000 });
  await app.page.keyboard.press("Control+a");
  await app.page.keyboard.press("Backspace");
  await app.page.keyboard.type("draft");
  await app.page.keyboard.press(key);
  await app.page.waitForTimeout(400);
  const text = (await lines(app.input)).join("\n");
  return app.sends.length > before ? "send" : text === "draft\n" ? "new line" : `nothing sent, ${JSON.stringify(text)}`;
}
const SENDS_HINT = "↵ Send ⇧ ↵ New line", NEW_LINE_HINT = "↵ New line Ctrl ↵ Send";

async function desktopPath() {
  const label = "path, desktop";
  const app = await openApp("keyboard", undefined, label);
  const { page } = app;
  const step = (name, extra = {}) => report.path.push({ step: name, ...extra });
  report.path = [];
  try {
    assert.equal(await composerHint(page), SENDS_HINT, "unset: Return sends");
    // Chosen in Settings: the conversation follows it.
    let editor = await openEditor(page, INPUT_ENTRY);
    assert.deepEqual(await editorState(editor), { status: "Using the defaults; nothing is saved on this device yet", alert: null, checked: "auto" });
    await editor.locator('input[name="input-send-key"][value="modEnter"]').check();
    assert.deepEqual(await editorState(editor), { status: "Saved on this device", alert: null, checked: "modEnter" });
    await page.screenshot({ path: resolve(output, "path-saved.png") });
    await closeSettings(page);
    assert.equal(await composerHint(page), NEW_LINE_HINT);
    assert.equal(await pressInConversation(app, "Enter"), "new line");
    assert.equal(await pressInConversation(app, "Control+Enter"), "send");
    step("Ctrl+Return sends, chosen in Settings: the composer and its hint follow it");
    // Kept on this device: after a reload too.
    await page.reload();
    await app.input.waitFor({ timeout: 10_000 });
    assert.equal(await composerHint(page), NEW_LINE_HINT, "saved: after a reload");
    editor = await openEditor(page, INPUT_ENTRY);
    assert.deepEqual(await editorState(editor), { status: "Using the choice saved on this device", alert: null, checked: "modEnter" });
    step("reloaded: the saved choice applies and Settings says it is the saved one");
    // Refused: it applies in this window, Settings says so, also reopened.
    await refuseWrites(page, true);
    await editor.locator('input[name="input-send-key"][value="enter"]').check();
    const refused = "Not saved on this device: this browser’s storage for Yuzuno is full. Your choice applies in this window until you close or reload it.";
    assert.deepEqual(await editorState(editor), { status: null, alert: refused, checked: "enter" });
    await page.screenshot({ path: resolve(output, "path-refused.png") });
    await closeSettings(page);
    assert.equal(await composerHint(page), SENDS_HINT, "refused: the choice applies in this window");
    assert.equal(await pressInConversation(app, "Enter"), "send");
    editor = await openEditor(page, INPUT_ENTRY);
    assert.deepEqual(await editorState(editor), { status: null, alert: refused, checked: "enter" }, "reopened: still said");
    step("refused: the choice applies in this window; Settings still says it was not saved when reopened");
    // Reloaded: the refused choice is gone, the saved one applies.
    await page.reload();
    await app.input.waitFor({ timeout: 10_000 });
    assert.equal(await composerHint(page), NEW_LINE_HINT, "reloaded: the saved choice, not the refused one");
    assert.equal(await stored(page), '{"sendKey":"modEnter"}');
    step("reloaded after a refusal: the saved choice applies again");
    // Try again once the browser keeps it; then Restore defaults.
    editor = await openEditor(page, INPUT_ENTRY);
    await refuseWrites(page, true);
    await editor.locator('input[name="input-send-key"][value="enter"]').check();
    assert.equal((await editorState(editor)).alert, refused);
    await refuseWrites(page, false);
    await editor.getByRole("button", { name: "Try again" }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await editorState(editor), { status: "Saved on this device", alert: null, checked: "enter" });
    assert.equal(await stored(page), '{"sendKey":"enter"}');
    await editor.locator('input[name="input-send-key"][value="modEnter"]').check();
    await editor.getByRole("button", { name: "Restore defaults" }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await editorState(editor), { status: "Defaults restored on this device", alert: null, checked: "auto" });
    assert.equal(await stored(page), null);
    await closeSettings(page);
    assert.equal(await composerHint(page), SENDS_HINT, "defaults: Return sends from a keyboard");
    step("Try again saves once the browser keeps it; Restore defaults removes it, and the composer follows");
    // The shortcuts help, from Settings, as the choice in effect makes it.
    editor = await openEditor(page, SHORTCUTS_ENTRY);
    const first = await editor.locator(".shortcut-group").filter({ has: page.locator("h4", { hasText: "Writing a message" }) }).locator("dt, dd").allTextContents();
    assert.deepEqual(first.slice(0, 2).map((t) => t.replace(/\s+/g, "")), ["Return", "Send"]);
    await page.screenshot({ path: resolve(output, "path-shortcuts.png") });
    step("Keyboard shortcuts, opened from Settings, lists Return as the choice in effect makes it");
    check("path: Settings → the composer and its hint, saved, reloaded, refused, reopened, Try again, Restore defaults; the shortcuts help");
  } finally {
    await app.context.close();
  }
}

/** The keyboard alone: from Settings' search to a choice saved. */
async function keyboardPath() {
  const label = "path, keyboard alone";
  const app = await openApp("keyboard", undefined, label);
  const { page } = app;
  try {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.waitFor({ timeout: 10_000 });
    await search.focus();
    await page.keyboard.type(INPUT_ENTRY.search);
    const name = () => page.evaluate(() => document.activeElement?.textContent.trim() ?? "");
    const tabs = [];
    for (let n = 0; n < 15 && (await name()) !== `Open ${INPUT_ENTRY.title}`; n++) {
      await page.keyboard.press("Tab");
      tabs.push(await name());
    }
    assert.equal(await name(), `Open ${INPUT_ENTRY.title}`, `Tab reaches the entry's Open button (${tabs.join(" → ")})`);
    await page.keyboard.press("Enter");
    const editor = page.locator(`#settings-editor-${INPUT_ENTRY.editor}`);
    await editor.waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate((id) => document.activeElement?.id, `settings-editor-${INPUT_ENTRY.editor}`), `settings-editor-${INPUT_ENTRY.editor}`, "the opened section has the focus");
    await page.keyboard.press("Tab");
    const focusedChoice = () => page.evaluate(() => ({
      value: document.activeElement?.value ?? null,
      ring: getComputedStyle(document.activeElement?.closest(".input-send-choice") ?? document.body).outlineStyle,
    }));
    assert.deepEqual(await focusedChoice(), { value: "auto", ring: "solid" }, "Tab reaches the choice in effect, with a ring");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    assert.deepEqual(await editorState(editor), { status: "Saved on this device", alert: null, checked: "enter" });
    assert.equal(await stored(page), '{"sendKey":"enter"}');
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
    check("path: keyboard alone, Settings' search → Open → the section → a choice saved; Escape closes", { tabs });
  } finally {
    await app.context.close();
  }
}

/** A 320 px phone at the largest text: both sections in the real Settings, and a refusal. */
async function phonePath() {
  const label = "path, phone 320 px, 24 px";
  const app = await openApp("phone", undefined, label, 24);
  const { page } = app;
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fontSize), "24");
    for (const entry of [INPUT_ENTRY, SHORTCUTS_ENTRY]) {
      const editor = await openEditor(page, entry);
      await editor.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(150);
      const m = await measure(page);
      report.layout.push({ screen: "phone, real Settings", fontSize: 24, editor: entry.editor, ...m });
      await page.screenshot({ path: resolve(output, `path-phone-24-${entry.editor}.png`) });
      assert.ok(m.page.scroll <= m.page.client, `${entry.editor}: the page doesn't scroll sideways`);
      assert.ok(m.pane.scroll <= m.pane.client, `${entry.editor}: Settings' pane doesn't scroll sideways`);
      assert.deepEqual(m.outside, [], `${entry.editor}: nothing sticks out of the pane`);
      assert.deepEqual(m.overlaps, [], `${entry.editor}: no shortcut's keys on what it does`);
      assert.deepEqual(m.clipped, [], `${entry.editor}: no text cut off`);
      if (entry === INPUT_ENTRY) assert.ok(m.choices.length === 3 && m.choices.every((height) => height >= 44), `choices: ${m.choices}`);
    }
    // Refused, on the phone: said, with both buttons on screen.
    const editor = await openEditor(page, INPUT_ENTRY);
    await refuseWrites(page, true);
    await editor.locator('input[name="input-send-key"][value="enter"]').check();
    assert.match((await editorState(editor)).alert ?? "", /^Not saved on this device: /);
    await editor.locator(".save-status").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(150);
    const buttons = await editor.locator(".save-status button").evaluateAll((list) => list.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    }));
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.screenshot({ path: resolve(output, "path-phone-24-refused.png") });
    assert.deepEqual(buttons.map((b) => b.text), ["Try again", "Restore defaults"]);
    assert.ok(buttons.every((b) => b.left >= 0 && b.right <= size.width && b.top >= 0 && b.bottom <= size.height), `both buttons on screen ${JSON.stringify(buttons)}`);
    await closeSettings(page);
    assert.equal(await composerHint(page), SENDS_HINT, "the refused choice applies on the phone too");
    check("path: 320 px phone at 24 px, both sections fit in the real Settings; a refusal is said with its buttons on screen and applies");
  } finally {
    await app.context.close();
  }
}

async function pathCases() {
  await desktopPath();
  await keyboardPath();
  await phonePath();
}

// Each part runs, and the report is written, also when one fails.
report.failed = {};
for (const [part, run] of [["composer", composerCases], ["settings", settingsCases], ["path", pathCases]]) {
  if (!parts.includes(part)) continue;
  try {
    await run();
  } catch (error) {
    report.failed[part] = String(error?.stack || error).slice(0, 4000);
    console.log(`FAILED ${part}: ${String(error?.message || error).split("\n")[0]}`);
  }
}
await browser.close();
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 1));
assert.deepEqual(Object.keys(report.failed), [], "every part");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.requests.filter((r) => r.unexpected), [], "no request this check doesn't answer by design");
console.log(`checks ${report.checks.length}; sends answered 400: ${report.requests.filter((r) => r.path === "/api/agents/a/messages").length}; unmodelled GETs ${Object.values(report.unmodelledGets).reduce((a, b) => a + b, 0)}`);
