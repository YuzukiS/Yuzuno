// T-170: the web app at phone sizes, in Chromium, on a production build with
// every API answered here (no Core). A phone held upright, one held sideways
// and an ordinary wide window: which entries can be reached, how large the
// touch targets are, and screenshots for review. Without --baseline it also
// walks the phone navigation: the Agent list and a conversation one screen
// each, drafts, reading place and an annotation kept across the list, another
// Agent and a narrow/wide resize. Chromium's emulated phone is not a real one:
// no on-screen keyboard, lock screen or Safari.
//   YUZUNO_UI_DIST=<isolated build> node tools/narrow-layout-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/narrow-layout");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", viewports: [], checks: [], errors: [], mutations: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agents = [
  { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected", threadId: "thread-a" },
  { ...base, id: "b", name: "Hana", status: "working", harness: "claude", cwd: "/fixture", model: "claude", projectId: "p1", connectionState: "connected" },
  { ...base, id: "c", name: "Sora", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p2", connectionState: "connected", threadId: "thread-c" },
];
const projects = [
  { id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Research", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const turns = (who) => Array.from({ length: 16 }, (_, n) => ({
  id: `${who}-t${n}`,
  status: "completed",
  items: [
    { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} step ${n + 1}: check the next part.` }] },
    { id: `${who}-r${n}`, type: "agentMessage", text: `${who} reply ${n + 1}. ${"The layout keeps its place while it updates. ".repeat(4)}` },
  ],
}));
const detail = (agent) => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: turns(agent.name) });
const home = { generatedAt: new Date().toISOString(), order: ["p1", "p2"], needsYou: [], projects: [] };

/** Entries a person needs, and how each is found on screen. */
const entries = {
  "Agent list with names": ".agent-row .agent-identity",
  "Agent search": '[aria-label="Search agents"]',
  "New agent": ".add-agent, [aria-label=\"Create agent\"]",
  "Project switcher": ".project-switcher",
  Home: ".toolbar-nav .catchup-nav:not(.collab-nav):not(.jobs-nav)",
  "Tasks & messages": ".collab-nav",
  Jobs: ".jobs-nav",
  Settings: ".workspace-settings",
  "Context panel": '[aria-label="Toggle context panel"]',
  Composer: "[data-composer-input]",
  Send: ".send-button",
};
/** The ways in and out a finger needs on a phone. */
const touchTargets = ".phone-back, .toolbar .icon-button, .toolbar-nav .catchup-nav, .rail-actions .icon-button, .agent-select, .send-button";

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function open(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.hostname, "yuzuno-narrow.test");
    const path = url.pathname;
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/agents\/[abc]\/review$/.test(path)) return route.fulfill({ json: {} });
    if (method !== "GET") {
      report.mutations.push({ viewport: viewport.name, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const agent = agents.find((a) => path === `/api/agents/${a.id}`);
    const json = agent ? detail(agent) : {
      "/api/workspace": { workspace: { id: "ws-narrow" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": home,
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[extname(file)] });
  });
  await page.goto("http://yuzuno-narrow.test/");
  await page.locator(".agent-row").first().waitFor();
  await page.waitForTimeout(300);
  return { context, page };
}

/** What can be reached on screen now, and the controls under 44 × 44 CSS px. */
async function measure(page, viewport) {
  const seen = { name: viewport.name, width: viewport.width, height: viewport.height, entries: {} };
  for (const [name, selector] of Object.entries(entries)) {
    seen.entries[name] = await page.evaluate(([selector, width, height]) => {
      const shown = [...document.querySelectorAll(selector)].find((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && !el.closest("[inert]") && r.right > 0 && r.left < width && r.bottom > 0 && r.top < height;
      });
      if (!shown) return { reachable: false };
      const r = shown.getBoundingClientRect();
      return { reachable: true, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    }, [selector, viewport.width, viewport.height]);
  }
  seen.mainWidth = await page.locator(".main-panel").evaluate((el) => Math.round(el.getBoundingClientRect().width));
  seen.appClass = await page.locator(".app").getAttribute("class");
  seen.media = await page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, noHover: matchMedia("(hover: none)").matches }));
  seen.smallTargets = await page.evaluate(([width, height]) => [...document.querySelectorAll("button, a[href], input, select, [role=button]")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => r.width > 0 && r.height > 0 && r.right > 0 && r.left < width && r.bottom > 0 && r.top < height && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]"))
    .filter(({ r }) => r.width < 44 || r.height < 44)
    .map(({ el, r }) => `${el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent.trim().slice(0, 30) || el.tagName} ${Math.round(r.width)}×${Math.round(r.height)}`),
  [viewport.width, viewport.height]);
  return seen;
}
const reachable = (seen, ...names) => names.every((name) => seen.entries[name].reachable);
const shot = (page, name) => page.screenshot({ path: resolve(output, `${report.mode}-${name}.png`) });
const scroller = (page) => page.locator(".main-panel .conversation-scroll");
const composer = (page, name) => page.locator(`[data-composer-input][aria-label="Message ${name}"]`);
async function tapAgent(page, name) {
  await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).click();
  await composer(page, name).waitFor();
  await page.waitForTimeout(250);
}
async function back(page) {
  await page.locator(".phone-back").click();
  await page.waitForTimeout(250);
}
/** Which part of the app is on top at a point: nothing of a covered view may show through. */
const topAt = (page, x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return el?.closest(".rail") ? "rail" : el?.closest(".inspector") ? "inspector" : el?.closest(".main-panel") ? "main" : el?.tagName || null;
}, [x, y]);
/** The touch targets on screen that are smaller than 44 × 44 CSS px. */
const smallTouch = (page) => page.evaluate((selector) => [...document.querySelectorAll(selector)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest("[inert]") && (r.width < 44 || r.height < 44); })
  .map((el) => `${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`), touchTargets);

const portrait = { name: "phone-portrait", width: 390, height: 844, touch: true };
const landscape = { name: "phone-landscape", width: 844, height: 390, touch: true };
const wide = { name: "wide", width: 1280, height: 800, touch: false };
try {
  for (const viewport of [portrait, landscape, wide]) {
    const { context, page } = await open(viewport);
    const seen = await measure(page, viewport);
    await shot(page, viewport.name);
    report.viewports.push(seen);
    console.log(`${viewport.name}: ${Object.entries(seen.entries).map(([n, e]) => `${n}=${e.reachable ? "yes" : "NO"}`).join(", ")}; main ${seen.mainWidth}px; ${seen.smallTargets.length} controls under 44px; ${JSON.stringify(seen.media)}`);
    if (baseline) {
      await context.close();
      continue;
    }

    if (viewport === wide) {
      // Unchanged: the side-by-side layout, every entry where it was.
      assert.doesNotMatch(seen.appClass, /phone/);
      assert.ok(reachable(seen, ...Object.keys(entries)), JSON.stringify(seen.entries));
      assert.equal(seen.mainWidth, 764, "the conversation is as wide as before");
      check("a wide window keeps the side-by-side layout and every entry", { mainWidth: seen.mainWidth });
      await context.close();
      continue;
    }

    // A phone starts on the Agent list, with everything the list offers.
    assert.match(seen.appClass, /\bphone\b.*\bphone-list\b/);
    assert.ok(reachable(seen, "Agent list with names", "Agent search", "New agent", "Home", "Tasks & messages", "Jobs", "Settings", "Context panel"), JSON.stringify(seen.entries));
    const rail = await page.locator(".rail").evaluate((el) => Math.round(el.getBoundingClientRect().width));
    assert.equal(rail, viewport.width, "the list is the whole width");
    await page.locator(".project-switcher").scrollIntoViewIfNeeded();
    assert.ok(await page.locator(".project-switcher").isVisible(), "the project switcher is in the list");
    assert.deepEqual(await smallTouch(page), [], "list targets are at least 44 × 44");
    for (const y of [0.3, 0.5, 0.7]) assert.equal(await topAt(page, viewport.width - 30, Math.round(viewport.height * y)), "rail", "nothing of the conversation shows over the list");
    // Grouped by project as in a wide window: readable headings, every row shown.
    const groups = await page.evaluate(() => ({
      heads: [...document.querySelectorAll(".agent-list .project-group-head")].map((h) => Math.round(h.getBoundingClientRect().height)),
      rows: [...document.querySelectorAll(".agent-list .agent-row")].filter((r) => r.getBoundingClientRect().height >= 44).length,
      overflow: document.querySelector(".agent-list").scrollWidth > document.querySelector(".agent-list").clientWidth + 1,
    }));
    assert.ok(groups.heads.length === 2 && groups.heads.every((h) => h > 1) && groups.rows === 3 && !groups.overflow, JSON.stringify(groups));
    check(`${viewport.name}: the list is one screen with search, projects and every entry`, { rail });

    // An Agent opens its conversation at full width, with the way back.
    await tapAgent(page, "Mori");
    const opened = await measure(page, viewport);
    assert.doesNotMatch(opened.appClass, /phone-list/);
    assert.equal(opened.mainWidth, viewport.width);
    assert.ok(reachable(opened, "Composer", "Send", "Home", "Settings", "Context panel"), JSON.stringify(opened.entries));
    assert.equal(await page.evaluate(() => document.activeElement?.className), "phone-back", "focus moves to the way back");
    assert.deepEqual(await smallTouch(page), [], "conversation targets are at least 44 × 44");
    const send = await page.locator(".send-button").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { onTop: el.contains(hit), bottom: Math.round(r.bottom) };
    });
    assert.ok(send.onTop && send.bottom <= viewport.height, `Send is on screen and nothing covers it: ${JSON.stringify(send)}`);
    const room = await scroller(page).evaluate((el) => Math.round(el.getBoundingClientRect().height));
    assert.ok(room >= (viewport === landscape ? 120 : 300), `room for the conversation: ${room}px`);
    await shot(page, `${viewport.name}-conversation`);
    check(`${viewport.name}: an Agent opens full width, Send on screen and uncovered, focus on ‹ Agents`, { send: opened.entries.Send.box, room });

    if (viewport === landscape) {
      await context.close();
      continue;
    }

    // Draft and reading place survive the list and the same Agent again.
    await composer(page, "Mori").click();
    await page.keyboard.type("Draft typed on the phone.");
    await scroller(page).evaluate((el) => { el.scrollTop = 600; el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(300);
    const place = await scroller(page).evaluate((el) => el.scrollTop);
    await back(page);
    assert.match(await page.locator(".app").getAttribute("class"), /phone-list/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open Mori", "focus returns to the open Agent's row");
    // Scrolling the list stays in the list.
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    assert.equal(await scroller(page).evaluate((el) => el.scrollTop), place, "the conversation under the list did not scroll");
    await tapAgent(page, "Mori");
    assert.equal(await scroller(page).evaluate((el) => el.scrollTop), place, "the same Agent comes back where it was");
    assert.equal(await composerDraft(composer(page, "Mori")), "Draft typed on the phone.");
    check("the list and back keep the conversation's place and draft; the list scrolls on its own", { place });

    // Another Agent has its own draft; Mori's comes back with Mori.
    await back(page);
    await tapAgent(page, "Hana");
    assert.equal(await composerDraft(composer(page, "Hana")), "");
    await back(page);
    await tapAgent(page, "Mori");
    assert.equal(await composerDraft(composer(page, "Mori")), "Draft typed on the phone.");
    const restored = await scroller(page).evaluate((el) => ({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight }));
    assert.ok(restored.top < restored.bottom - 50, `Mori reopens where it was left, not at the latest: ${JSON.stringify(restored)}`);
    check("another Agent between keeps each draft and reopens Mori where it was read (T-166)", restored);

    // The context panel is a screen of its own, closed the way it opened.
    await page.locator('[aria-label="Toggle context panel"]').click();
    await page.waitForTimeout(250);
    const panel = await page.locator(".inspector").evaluate((el) => Math.round(el.getBoundingClientRect().width));
    assert.equal(panel, viewport.width);
    for (const y of [0.3, 0.5, 0.7]) assert.equal(await topAt(page, viewport.width - 30, Math.round(viewport.height * y)), "inspector", "nothing of the conversation shows over the panel");
    await shot(page, `${viewport.name}-context`);
    await page.locator('[aria-label="Close context panel"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".inspector").count(), 0);
    check("the context panel opens as its own screen and closes back to the conversation", { panel });

    // An annotation in progress (T-167) and the draft survive narrow → wide → narrow.
    const png = (await readdir(resolve(dist, "assets"))).find((name) => name.endsWith(".png"));
    await page.setInputFiles('input[aria-label="Choose an image to mark"]', { name: "screen.png", mimeType: "image/png", buffer: await readFile(resolve(dist, "assets", png)) });
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Add area" }).click();
    await dialog.getByLabel("Area 1 comment").fill("This button is too small.");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    assert.doesNotMatch(await page.locator(".app").getAttribute("class"), /phone/);
    assert.equal(await dialog.getByLabel("Area 1 comment").inputValue(), "This button is too small.");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);
    assert.match(await page.locator(".app").getAttribute("class"), /\bphone\b/);
    assert.doesNotMatch(await page.locator(".app").getAttribute("class"), /phone-list/, "it comes back to what was open");
    assert.equal(await dialog.getByLabel("Area 1 comment").inputValue(), "This button is too small.");
    await shot(page, `${viewport.name}-annotation`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await composerDraft(composer(page, "Mori")), "Draft typed on the phone.");
    check("an annotation in progress and the draft survive narrow → wide → narrow");
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, `${report.mode}-report.json`), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
assert.deepEqual(report.mutations, []);
