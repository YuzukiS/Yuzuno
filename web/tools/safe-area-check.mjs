// T-170: a phone's safe area, in Chromium on a production build with every API
// answered here (no Core). DevTools gives the page the insets of a notched
// phone (Emulation.setSafeAreaInsetsOverride); the app, a conversation's
// composer, the handoff strip and the Jobs, Tasks and Settings dialogs must
// then stay inside them, held upright and sideways, and nothing may move on a screen without
// insets. Emulated insets are not an iPhone: Safari's own bars, the Home
// Screen app's status bar and the on-screen keyboard are not here.
//   YUZUNO_UI_DIST=<isolated build> node tools/safe-area-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/safe-area");
await mkdir(output, { recursive: true });
const report = { checks: [], measured: [], errors: [], mutations: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agents = [{ ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected", threadId: "thread-a" }];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = Array.from({ length: 8 }, (_, n) => ({
  id: `t${n}`,
  status: "completed",
  items: [
    { id: `u${n}`, type: "userMessage", content: [{ type: "text", text: `Step ${n + 1}: check the next part.` }] },
    { id: `r${n}`, type: "agentMessage", text: `Reply ${n + 1}. ${"The layout keeps clear of the screen's edges. ".repeat(4)}` },
  ],
}));
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const now = new Date().toISOString();
const task = {
  id: "T-1", title: "Use Yuzuno from a phone", status: "doing", description: "The app keeps clear of the screen's edges.",
  assigneeAgentId: "a", projectId: "p1", createdAt: now, updatedAt: now, version: 1, blocker: "",
};

// A phone with a notch or Dynamic Island: upright, the status bar and the
// home indicator; sideways, the notch on one side (the inset is given on both,
// as iOS does) and the home indicator.
const portrait = { name: "portrait", width: 393, height: 852, insets: { top: 59, right: 0, bottom: 34, left: 0 } };
const landscape = { name: "landscape", width: 852, height: 393, insets: { top: 0, right: 59, bottom: 21, left: 59 } };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function open(viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:") return route.continue();
    assert.equal(url.hostname, "yuzuno-safe.test");
    const path = url.pathname;
    if (/^\/api\/agents\/a\/reading$/.test(path))
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method === "POST" && path === "/api/agents/a/review") return route.fulfill({ json: {} });
    // Tasks & messages reads its lists by POST, as the Agents' tools do.
    const op = method === "POST" && path.startsWith("/api/collaboration/") ? path.split("/").at(-1) : null;
    const read = op && !JSON.parse(request.postData() || "{}").action && {
      task_list: { tasks: [task], counts: { doing: 1 }, hasMore: false, nextAfterSeq: null },
      peers_list: { peers: [{ id: "a", name: "Mori" }] },
      peer_read: { messages: [], hasMore: false, nextAfterSeq: 0 },
      github_repositories: { repositories: [], links: [] },
    }[op];
    if (read) return route.fulfill({ json: read });
    if (method !== "GET") {
      report.mutations.push({ viewport: viewport.name, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-safe" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns },
      "/api/home": home,
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] });
  });
  await page.goto("http://yuzuno-safe.test/");
  await page.locator(".agent-row").first().waitFor();
  await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
  await page.locator('[data-composer-input][aria-label="Message Mori"]').waitFor();
  await page.waitForTimeout(250);
  return { context, page };
}

/** Rounded boxes of what a finger needs at the edges. */
const boxes = (page) => page.evaluate(() => {
  const box = (selector) => {
    const el = [...document.querySelectorAll(selector)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const style = getComputedStyle(document.querySelector(".app"));
  return {
    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    toolbar: box(".toolbar"), main: box(".main-panel"), composer: box(".composer"), send: box(".send-button"),
  };
});
const inside = (box, { width, height, insets }) =>
  !!box && box.top >= insets.top && box.left >= insets.left && box.right <= width - insets.right && box.bottom <= height - insets.bottom;

async function dialog(page, viewport, open, selector, name) {
  await page.locator(open).first().click();
  const shown = page.locator(selector).first();
  await shown.waitFor();
  await page.waitForTimeout(250);
  const box = await shown.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; });
  report.measured.push({ viewport: viewport.name, dialog: name, box });
  await page.screenshot({ path: resolve(output, `${viewport.name}-${name.toLowerCase()}.png`) });
  assert.ok(inside(box, viewport), `${name} stays inside the safe area ${viewport.name}: ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`);
  await page.keyboard.press("Escape");
  await shown.waitFor({ state: "detached" });
  return box;
}

try {
  for (const viewport of [portrait, landscape]) {
    const { context, page } = await open(viewport);
    // No insets: the page is laid out as before, edge to edge.
    const plain = await boxes(page);
    report.measured.push({ viewport: viewport.name, insets: "none", ...plain });
    assert.deepEqual(plain.padding, ["0px", "0px", "0px", "0px"], "no insets, no padding");
    assert.equal(plain.toolbar.top, 0, "no insets: the toolbar starts at the top");
    assert.equal(plain.main.bottom, viewport.height - (viewport === landscape ? 0 : 27), "no insets: the open view reaches the status bar as before");

    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: viewport.insets });
    await page.waitForTimeout(250);
    const safe = await boxes(page);
    report.measured.push({ viewport: viewport.name, insets: viewport.insets, ...safe });
    await page.screenshot({ path: resolve(output, `${viewport.name}-conversation.png`) });
    const { top, right, bottom, left } = viewport.insets;
    assert.deepEqual(safe.padding, [`${top}px`, `${right}px`, `${bottom}px`, `${left}px`], `the app is padded by the insets ${viewport.name}`);
    assert.ok(inside(safe.toolbar, viewport), `the toolbar is inside the safe area ${viewport.name}: ${JSON.stringify(safe.toolbar)}`);
    assert.ok(inside(safe.composer, viewport), `the composer is inside the safe area ${viewport.name}: ${JSON.stringify(safe.composer)}`);
    assert.ok(inside(safe.send, viewport), `Send is inside the safe area ${viewport.name}: ${JSON.stringify(safe.send)}`);
    check(`${viewport.name}: the toolbar, the composer and Send stay inside the insets`, { toolbar: safe.toolbar, send: safe.send });
    // The handoff strip, fixed to the window's edges while a handoff is
    // dragged out of a dialog, here placed by hand.
    const strip = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "handoff-strip";
      el.textContent = "Drop on an Agent";
      document.body.append(el);
      const r = el.getBoundingClientRect();
      el.remove();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    });
    report.measured.push({ viewport: viewport.name, handoffStrip: strip });
    assert.ok(inside(strip, viewport), `the handoff strip stays inside the safe area ${viewport.name}: ${JSON.stringify(strip)}`);

    await dialog(page, viewport, ".jobs-nav", ".modal.jobs-dialog", "Jobs");
    await dialog(page, viewport, ".collab-nav", ".modal:has(.collaboration)", "Tasks");
    await dialog(page, viewport, ".workspace-settings", ".modal.settings-modal", "Settings");
    check(`${viewport.name}: Jobs, Tasks and Settings open inside the insets`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mutations, []);
  check("no page errors and no unexpected writes");
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
