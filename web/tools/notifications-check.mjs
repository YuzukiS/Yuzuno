// System notifications in Linux Chromium (T-188), the production bundle with
// an explicit API fixture; no Core, no daily window.
// - Settings → Notifications reads Chromium's own permission and asks only
//   from the user's click; what it shows matches Notification.permission.
// - With notifications granted, the test notification goes to Chromium's
//   real Notification API and the editor shows what Chromium reported.
// - In the app: an Agent's Turn ending, read after an agent.changed event
//   while the user looks elsewhere, is one notification; its click opens the
//   conversation; nothing is shown while the user is looking; nothing is
//   written to Core but the reading handoff (T-170) and the read marker of a
//   conversation shown, each counted apart.
// - On a 320 px phone at 24 px text, with this device's storage refusing the
//   choices: each refusal comes into view whole as it appears, the same one
//   again after the user scrolled away from it, without the check scrolling;
//   focus stays on the switch (whether it is in view is recorded).
// The Notification constructor is wrapped to record what was asked of it; the
// notification itself is Chromium's. The event stream is replaced so the check
// can send one event; "looking elsewhere" is emulated (a hidden, unfocused page).
// Usage: YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<folder>
//   [YUZUNO_BROWSER_BIN=/usr/sbin/chromium] node tools/notifications-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/notifications");
await mkdir(output, { recursive: true });
// A loopback page is a secure one: Chromium offers notifications there.
const ORIGIN = "http://127.0.0.1:4398";
const report = { task: "T-188", checks: [], observed: {}, writes: [], readingWrites: [], readWrites: [], unmodelledGets: {}, pageErrors: [], consoleErrors: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
/** The Agent list as Core would give it at each step of the app case. */
const lists = {
  start: [{ ...base, id: "a", name: "Mori", status: "idle" }, { ...base, id: "b", name: "Hana", status: "working", workSummary: { kind: "progress", text: "Running the checks", source: "agent" } }],
  finished: [{ ...base, id: "a", name: "Mori", status: "idle" }, { ...base, id: "b", name: "Hana", status: "idle", lastSeq: 2, workSummary: { kind: "result", text: "Private result text", source: "agent" } }],
  working: [{ ...base, id: "a", name: "Mori", status: "idle" }, { ...base, id: "b", name: "Hana", status: "working", lastSeq: 3, workSummary: { kind: "progress", text: "Again", source: "agent" } }],
  again: [{ ...base, id: "a", name: "Mori", status: "idle" }, { ...base, id: "b", name: "Hana", status: "idle", lastSeq: 4, workSummary: { kind: "result", text: "Done again", source: "agent" } }],
  request: [{ ...base, id: "a", name: "Mori", status: "waiting", pendingCount: 1, lastSeq: 2, workSummary: { kind: "pending", text: "Approve npm ci?", source: "runtime" } }, { ...base, id: "b", name: "Hana", status: "idle", lastSeq: 4 }],
};
const usage = { revision: 1, status: "unknown", account: null, accountId: null, source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null }, checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

/** A page of the app in its own context; `grant` grants notifications to the origin. */
async function open(label, { grant = false, saved = null, viewport = { width: 1280, height: 800 }, phone = false, fontSize = null } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  if (grant) await context.grantPermissions(["notifications"], { origin: ORIGIN });
  const state = { list: "start" };
  await context.addInitScript(({ prefs, fontSize }) => {
    if (!sessionStorage.getItem("seeded")) {
      if (prefs) localStorage.setItem("yuzuno.notifications", JSON.stringify(prefs));
      if (fontSize) localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize, palette: "garden" }));
      sessionStorage.setItem("seeded", "1");
    }
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    // What was asked of Chromium's Notification; the notification is its own.
    window.__shown = [];
    const Real = window.Notification;
    if (Real)
      window.Notification = class extends Real {
        constructor(title, options = {}) {
          super(title, options);
          window.__shown.push({ title, body: options.body ?? "", tag: options.tag ?? "" });
          window.__last = this;
        }
      };
    // The event stream, so the check can send one event.
    window.__sources = [];
    window.EventSource = class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        window.__sources.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
      addEventListener() {}
      close() {
        this.readyState = 2;
      }
    };
    window.__emit = (event) => window.__sources.at(-1)?.onmessage?.({ data: JSON.stringify(event), lastEventId: "" });
    // Looking elsewhere: a hidden, unfocused page, when the check says so.
    window.__away = false;
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => (window.__away ? "hidden" : "visible"), configurable: true });
    Document.prototype.hasFocus = () => !window.__away;
  }, { prefs: saved, fontSize });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && report.consoleErrors.length < 50) report.consoleErrors.push(`${label}: ${message.text().slice(0, 300)}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:") return route.continue();
    assert.equal(url.origin, ORIGIN);
    const path = url.pathname;
    if (/^\/api\/agents\/[ab]\/reading$/.test(path)) {
      if (method !== "GET") report.readingWrites.push({ case: label, method, path });
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    }
    // A conversation shown is marked read, by design: counted apart.
    if (method === "POST" && /^\/api\/agents\/[ab]\/review$/.test(path)) {
      report.readWrites.push({ case: label, method, path });
      return route.fulfill({ json: {} });
    }
    if (method !== "GET") {
      report.writes.push({ case: label, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const agents = lists[state.list];
    const detail = /^\/api\/agents\/([ab])$/.exec(path);
    const json = detail
      ? { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] }
      : /^\/api\/agents\/[ab]\/codex\/usage$/.test(path)
        ? usage
        : {
            "/api/workspace": { workspace: { id: "ws-notify" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
            "/api/home": { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] },
            "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
            "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
            "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  await page.goto(`${ORIGIN}/`);
  await page.locator('.agent-row[data-agent-id="b"]').waitFor({ timeout: 10_000 });
  return { context, page, state };
}
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  report.screenshots.push(name);
};
/** Settings → Notifications & attention, as the window shows it. */
async function openNotifications(page) {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const picker = dialog.getByRole("combobox", { name: "Settings category", exact: true });
  if (await picker.isVisible()) await picker.selectOption("notifications");
  else await dialog.getByRole("tab", { name: "Notifications & attention" }).click();
  const editor = dialog.locator("#settings-notifications");
  await editor.waitFor();
  return editor;
}
const labels = { default: "Not asked yet", granted: "Allowed", denied: "Blocked" };
const fits = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector(".settings-pane");
    return { sideways: pane.scrollWidth > pane.clientWidth + 1, width: pane.clientWidth };
  });

try {
  // 1. Not granted: what Chromium says, asked only from the click.
  {
    const { context, page } = await open("not granted");
    const before = await page.evaluate(() => Notification.permission);
    const editor = await openNotifications(page);
    assert.match(await editor.locator(".notification-access").innerText(), new RegExp(labels[before]));
    assert.equal(await page.evaluate(() => Notification.permission), before, "opening Settings changed nothing");
    await shot(page, "settings-not-granted-1280.png");
    const box = editor.getByRole("checkbox", { name: /Notify me on this device/ });
    let after = before;
    if (await box.count()) {
      await box.click();
      // Asking disables the switch until Chromium answers.
      await page.waitForTimeout(100);
      await page.waitForFunction(() => !document.querySelector("#settings-notifications input[disabled]"), null, { timeout: 10_000 });
      after = await page.evaluate(() => Notification.permission);
    }
    assert.match(await editor.locator(".notification-access").innerText(), new RegExp(labels[after]));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.notifications")));
    assert.equal(!!saved?.enabled, after === "granted", `saved only when allowed: ${JSON.stringify(saved)}`);
    if (after !== "granted") assert.equal(await editor.getByRole("checkbox", { name: /Notify me on this device/ }).count(), after === "default" ? 1 : 0);
    await shot(page, "settings-after-asking-1280.png");
    report.observed.notGranted = { before, after, saved };
    check("not granted: the editor shows Chromium's own permission; the browser is asked only from the switch; on anything but allow nothing is saved", report.observed.notGranted);
    await context.close();
  }

  // 2. Granted: the switch, the kinds, a real test notification and what Chromium reported.
  {
    const { context, page } = await open("granted", { grant: true });
    const editor = await openNotifications(page);
    assert.match(await editor.locator(".notification-access").innerText(), /Allowed/);
    await editor.getByRole("checkbox", { name: /Notify me on this device/ }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("yuzuno.notifications") || "{}").enabled === true);
    await editor.getByRole("button", { name: "Send a test" }).click();
    const result = editor.locator(".notification-test-result");
    await result.waitFor({ timeout: 10_000 });
    const outcome = await result.getAttribute("data-outcome");
    const text = await result.innerText();
    const shown = await page.evaluate(() => window.__shown);
    assert.deepEqual(shown, [{ title: "Yuzuno", body: "A test notification from your Workspace.", tag: "yuzuno:test" }]);
    assert.ok(["shown", "unconfirmed", "failed"].includes(outcome), outcome);
    report.observed.test = { outcome, text };
    const wide = await fits(page);
    assert.equal(wide.sideways, false, JSON.stringify(wide));
    await shot(page, "settings-granted-1280.png");
    // The dialog stays open as the window narrows to a phone's.
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.waitFor();
    const phone = await fits(page);
    assert.equal(phone.sideways, false, JSON.stringify(phone));
    await shot(page, "settings-granted-390.png");
    check("granted: on, a test sent to Chromium's Notification and its report shown; the editor fits at 1280 and 390 px", { outcome, text, wide, phone });
    await context.close();
  }

  // 3. The app: a Turn's end read while looking elsewhere is one notification.
  {
    const { context, page, state } = await open("app", { grant: true, saved: { enabled: true } });
    await page.waitForTimeout(500);
    await page.evaluate(() => (window.__away = true));
    state.list = "finished";
    await page.evaluate(() => window.__emit({ type: "agent.changed", agentId: "b", rev: 2, lastSeq: 2 }));
    await page.waitForFunction(() => window.__shown.length > 0, null, { timeout: 10_000 });
    await page.waitForTimeout(500);
    let shown = await page.evaluate(() => window.__shown);
    assert.deepEqual(shown, [{ title: "Hana finished", body: "The Turn finished.", tag: "yuzuno:finished:b" }]);
    // Its click opens the conversation.
    await page.evaluate(() => {
      window.__away = false;
      window.__last.onclick();
    });
    await page.locator('.agent-row.selected[data-agent-id="b"]').waitFor({ timeout: 10_000 });
    check("app: a Turn's end, read after agent.changed while looking elsewhere, is one notification without what was written; its click opens Hana", { shown });

    // While looking: the next end shows nothing.
    state.list = "working";
    await page.evaluate(() => window.__emit({ type: "agent.changed", agentId: "b", rev: 3, lastSeq: 3 }));
    await page.waitForTimeout(800);
    state.list = "again";
    await page.evaluate(() => window.__emit({ type: "agent.changed", agentId: "b", rev: 4, lastSeq: 4 }));
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.__shown.length), 1);
    // Away again: a request is shown.
    await page.evaluate(() => (window.__away = true));
    state.list = "request";
    await page.evaluate(() => window.__emit({ type: "agent.changed", agentId: "a", rev: 5, lastSeq: 2 }));
    await page.waitForFunction(() => window.__shown.length > 1, null, { timeout: 10_000 });
    shown = await page.evaluate(() => window.__shown);
    assert.deepEqual(shown.at(-1), { title: "Mori needs you", body: "Waiting for your response.", tag: "yuzuno:needsYou:a" });
    await shot(page, "app-after-notifications.png");
    check("app: nothing while the user is looking; a request while away is shown", { shown });
    await context.close();
  }

  // 4. A phone at the largest text, storage that refuses this device's
  // choices (one shared "blocked" outcome each time): each refusal comes into
  // view as it appears, the second too after the user scrolled away; the
  // check scrolls to neither. Focus stays on the switch.
  {
    const label = "phone 320×640, 24 px, the same refusal twice";
    const { context, page } = await open(label, { grant: true, saved: { enabled: true }, viewport: { width: 320, height: 640 }, phone: true, fontSize: 24 });
    const editor = await openNotifications(page);
    const before = await page.evaluate(() => localStorage.getItem("yuzuno.notifications"));
    await page.evaluate(() => {
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "yuzuno.notifications") throw new DOMException("Refused here.", "SecurityError");
        return set.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key) {
        if (key === "yuzuno.notifications") throw new DOMException("Refused here.", "SecurityError");
        return remove.call(this, key);
      };
    });
    // The refusal as shown, measured where it is: whole inside the pane as
    // its scrolling ancestors clip it, and what a tap at its middle reaches.
    const refusal = () =>
      page.evaluate(() => {
        const el = document.querySelector("#settings-notifications .save-status-failed");
        if (!el) return null;
        const pane = document.querySelector(".settings-pane");
        let box = { top: 0, bottom: innerHeight };
        for (let a = el.parentElement; a; a = a.parentElement) {
          const style = getComputedStyle(a);
          if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
          const r = a.getBoundingClientRect();
          box = { top: Math.max(box.top, r.top), bottom: Math.min(box.bottom, r.bottom) };
        }
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(box.top, Math.min(box.bottom - 1, r.top + r.height / 2)));
        const focus = document.activeElement, f = focus.getBoundingClientRect(), p = pane.getBoundingClientRect();
        return {
          height: Math.round(r.height),
          whole: r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
          reached: !!hit && el.contains(hit),
          focus: focus.closest("label")?.textContent.includes("Mute on this device") ? "mute" : focus.tagName,
          focusInView: f.top >= Math.max(p.top, 0) - 1 && f.bottom <= Math.min(p.bottom, innerHeight) + 1,
        };
      });
    const mute = editor.getByRole("checkbox", { name: /Mute on this device/ });
    await mute.focus();
    await page.keyboard.press("Space");
    await page.locator("#settings-notifications .save-status-failed").waitFor();
    await page.waitForTimeout(300);
    const first = await refusal();
    // The user scrolls back up to the switch: the refusal leaves the view.
    await mute.evaluate((el) => el.closest("label").scrollIntoView({ block: "start" }));
    await page.waitForTimeout(150);
    const away = await refusal();
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    const second = await refusal();
    await shot(page, "phone-24-refused-twice.png");
    const after = await page.evaluate(() => localStorage.getItem("yuzuno.notifications"));
    report.observed.refusedTwice = { first, away, second, kept: after === before };
    assert.equal(after, before, `${label}: nothing written over what was saved`);
    assert.ok(first?.whole && first.reached, `${label}: the first refusal in view as it appears (${JSON.stringify(first)})`);
    assert.ok(!away?.whole, `${label}: scrolled back up, the refusal is out of view (else this proves nothing): ${JSON.stringify(away)}`);
    assert.ok(second?.whole && second.reached, `${label}: the second, same refusal in view as it appears (${JSON.stringify(second)})`);
    assert.equal(second.focus, "mute", `${label}: focus stays on the switch`);
    check(`${label}: each refusal in view whole as it appears, the second after scrolling away; focus stays on the switch (in view: ${second.focusInView})`, report.observed.refusedTwice);
    await context.close();
  }

  assert.deepEqual(report.writes, [], "nothing written to Core");
  assert.deepEqual(report.pageErrors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
