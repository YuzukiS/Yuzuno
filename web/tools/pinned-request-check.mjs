// T-170: on a phone, a working Agent's pinned request ("Your request", the
// pin held at the conversation's top while its Turn runs) leaves the latest
// message's approval visible and clickable, in a short conversation too. In
// Chromium (or Playwright's Linux WebKit, see browser-engine.mjs), on a
// production build with every API answered here (no Core), synthetic content
// only: Sora is working and asks to run a long command; its request is above
// the view, so the pin shows.
// Short: a phone held sideways (844×390, and 667×375 as a small phone's) and
// one upright with the on-screen keyboard up (402×874, the keyboard leaving
// the 377 px Mobile Safari measured, set as keyboard-viewport.ts sets it).
// There, with the conversation at its latest:
// - visible: each of the approval's buttons lies within the conversation's
//   view, below the pin;
// - clickable: a press at its middle reaches it (elementFromPoint), and
//   Allow once, pressed as a person would, sends one answer, accept;
// - the pin is one line, and a tap on it opens it to the request, which a
//   second tap closes again, asking Core for nothing.
// Tall (402×874 upright, no keyboard) and wide (1280×800), the approval is
// clear and a pin that shows keeps its excerpt, as on main. An emulated
// phone is not a real one: no on-screen keyboard, iOS Safari or real Core.
//   YUZUNO_UI_DIST=<isolated build> node tools/pinned-request-check.mjs [--baseline]
// --baseline only measures and takes the screenshots (a build from before).
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/pinned-request");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", viewports: [], checks: [], errors: [], unexpected: [], mutations: [], answers: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const seconds = (minutesAgo) => Math.floor((now - minutesAgo * 60_000) / 1000);
const base = { color: "sage", createdAt: at(900), updatedAt: at(1), unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", cwd: "/fixture", model: "gpt-6", projectId: "p1" };
const agents = [
  { ...base, id: "c", name: "Sora", status: "waiting", harness: "codex", connectionState: "connected", threadId: "thread-c", pendingCount: 1 },
  { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", connectionState: "connected", threadId: "thread-a" },
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: at(900), updatedAt: at(900) }];
const requestText = "Check the phone layout again: run the layout check, then tell me which parts still run off the side and why.";
const progress = "I'll run the layout check first. It writes its report under the fixture's nested folders, so I need your approval for the command.";
const turns = (who, count, running) => Array.from({ length: count }, (_, n) => {
  const last = n === count - 1;
  return {
    id: `${who}-t${n}`,
    status: last && running ? "inProgress" : "completed",
    startedAt: seconds(count - n + 2),
    completedAt: last && running ? undefined : seconds(count - n + 1),
    items: [
      { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: last ? requestText : `${who} step ${n + 1}: check the next part.` }] },
      { id: `${who}-r${n}`, type: "agentMessage", ...(last && running ? { phase: "commentary" } : {}), text: last && running ? progress : `${who} reply ${n + 1}.` },
    ],
  };
});
const longCommand = "node tools/a-long-script-name-for-the-phone-check.mjs --output=/fixture/" + "nested/".repeat(10) + "report.json";
const approval = {
  id: "req-1", agentId: "c", method: "item/commandExecution/requestApproval", createdAt: at(1),
  params: { command: longCommand, cwd: "/fixture", reason: "Run the check that writes its report", itemId: "cmd-1", turnId: "Sora-t11", availableDecisions: ["accept", "decline", "cancel"] },
};
const details = {
  c: { agent: agents[0], pending: [approval], messageReceipts: [], artifacts: [], turns: turns("Sora", 12, true) },
  a: { agent: agents[1], pending: [], messageReceipts: [], artifacts: [], turns: turns("Mori", 4, false) },
};

const browser = await launchBrowser();
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
    localStorage.setItem("yuzuno.selected", JSON.stringify("c"));
  });
  page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
    assert.equal(url.hostname, "yuzuno-pinned.test");
    const path = url.pathname;
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/agents\/[ac]\/review$/.test(path)) return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[ac]\/reading$/.test(path))
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    // The approval's answer: the one write this check expects.
    if (method === "POST" && path === "/api/requests/req-1/respond") {
      report.answers.push({ viewport: viewport.name, body: request.postDataJSON() });
      return route.fulfill({ json: { accepted: true } });
    }
    if (method !== "GET") {
      report.mutations.push({ viewport: viewport.name, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const id = path.match(/^\/api\/agents\/([ac])$/)?.[1];
    const json = id ? details[id] : {
      "/api/workspace": { workspace: { id: "ws-pinned" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": { generatedAt: at(0), order: ["p1"], needsYou: [], projects: [] },
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
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] });
  });
  await page.goto("http://yuzuno-pinned.test/");
  await page.locator(".app").waitFor();
  return { context, page };
}
const composer = (page) => page.locator('[data-composer-input][aria-label="Message Sora"]');
/** Sora's conversation, at its latest: from the Agent list on a phone. */
async function openSora(page, phone) {
  if (!(await composer(page).isVisible().catch(() => false))) {
    if (phone && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
    await page.locator('.agent-row .agent-select[aria-label="Open Sora"]').click();
  }
  await composer(page).waitFor();
  await page.locator(".main-panel .pending-card").waitFor();
  await page.waitForTimeout(500);
  await toLatest(page);
}
/** As a reader would: Back to latest when it is offered, else a scroll down. */
async function toLatest(page) {
  const scroll = page.locator(".main-panel .conversation-scroll");
  const away = await scroll.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  if (away <= 2) return 0;
  if (await page.locator(".jump-latest").isVisible()) await page.locator(".jump-latest").click();
  else await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(600);
  return away;
}
/** The keyboard up, as keyboard-viewport.ts marks it: the shell fits the
 * visual viewport's height. */
const keyboardUp = (page, height) => page.evaluate((visible) => {
  document.documentElement.style.setProperty("--visual-height", `${visible}px`);
  document.documentElement.setAttribute("data-keyboard", "");
}, height);
const shot = (page, viewport, what) => page.screenshot({ path: resolve(output, `${report.mode}-${viewport.name}-${what}.png`) });

/** The pin, the approval's buttons and the composer, as a person sees them. */
const measure = (page) => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
  const onTop = (el) => {
    if (!shown(el)) return "hidden";
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? "self" : hit ? (hit.className?.toString() || hit.tagName).slice(0, 60) : "nothing";
  };
  const main = document.querySelector(".main-panel");
  const scroll = main.querySelector(".conversation-scroll");
  const view = scroll.getBoundingClientRect();
  const pin = main.querySelector(".current-turn-prompt");
  const pinned = !!pin && pin.dataset.pinned === "true" && shown(pin);
  const pinBottom = pinned ? pin.getBoundingClientRect().bottom : view.top;
  const excerpt = pin?.querySelector(".current-turn-excerpt");
  return {
    viewport: [innerWidth, innerHeight],
    appClass: document.querySelector(".app")?.className,
    keyboard: document.documentElement.hasAttribute("data-keyboard"),
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    away: Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
    view: box(scroll),
    pin: pin ? { pinned, open: pin.open, box: box(pin), excerpt: shown(excerpt) } : null,
    actions: [...main.querySelectorAll(".pending-card .button-row button")].map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.textContent.trim(), box: box(el), onTop: onTop(el),
        inView: r.top >= pinBottom - 1 && r.bottom <= view.bottom + 1 && r.left >= view.left - 1 && r.right <= view.right + 1 };
    }),
    composer: { input: onTop(main.querySelector("[data-composer-input]")), send: onTop(main.querySelector(".send-button")) },
  };
});

const viewports = [
  { name: "sideways-844", width: 844, height: 390, touch: true, short: true },
  { name: "sideways-667", width: 667, height: 375, touch: true, short: true },
  { name: "keyboard-402", width: 402, height: 874, touch: true, short: true, keyboard: 377 },
  { name: "upright-402", width: 402, height: 874, touch: true },
  { name: "wide", width: 1280, height: 800, touch: false },
];
try {
  for (const viewport of viewports) {
    const { context, page } = await open(viewport);
    await openSora(page, viewport.touch);
    if (viewport.keyboard) {
      await keyboardUp(page, viewport.keyboard);
      await page.waitForTimeout(400);
      await toLatest(page);
    }
    const seen = await measure(page);
    await shot(page, viewport, "latest");
    report.viewports.push({ name: viewport.name, seen });
    console.log(`${viewport.name}: pin ${JSON.stringify(seen.pin)}, view ${JSON.stringify(seen.view)}, actions ${JSON.stringify(seen.actions.map((a) => [a.label, a.onTop, a.inView, a.box]))}`);
    if (baseline) {
      await context.close();
      continue;
    }

    if (viewport.short)
      assert.ok(seen.pin?.pinned, `${viewport.name}: the request is above the view, so the pin shows: ${JSON.stringify(seen.pin)}`);
    if (viewport.touch) assert.match(seen.appClass, /\bphone\b/);
    assert.equal(seen.keyboard, !!viewport.keyboard);
    assert.ok(seen.pageOverflow <= 0, `${viewport.name}: nothing runs off the side`);
    assert.ok(seen.away <= 2, `${viewport.name}: at the latest (${seen.away} px away)`);
    assert.ok(seen.actions.length >= 2, JSON.stringify(seen.actions));
    for (const action of seen.actions) {
      assert.equal(action.onTop, "self", `${viewport.name}: ${action.label} is not under anything: ${JSON.stringify(action)}`);
      assert.ok(action.inView, `${viewport.name}: ${action.label} lies in the view, below the pin: ${JSON.stringify({ action, pin: seen.pin, view: seen.view })}`);
    }
    assert.equal(seen.composer.input, "self", `${viewport.name}: the composer is clear`);
    if (!viewport.keyboard) assert.equal(seen.composer.send, "self", `${viewport.name}: Send is clear`);
    if (viewport.short) {
      assert.ok(!seen.pin.excerpt && seen.pin.box[3] <= 40, `${viewport.name}: closed, the pin is one line: ${JSON.stringify(seen.pin)}`);
      check(`${viewport.name}: the approval's buttons are in view below a one-line pin and nothing covers them`, { pin: seen.pin.box, actions: seen.actions.map((a) => a.box) });

      // The request is a tap away; a second tap puts it back.
      await page.locator(".current-turn-prompt > summary").click();
      await page.locator(".current-turn-prompt[open] .current-turn-messages").waitFor();
      const opened = await page.locator(".current-turn-prompt .current-turn-messages").innerText();
      assert.ok(opened.includes("run the layout check"), `the open pin reads the request: ${opened}`);
      await shot(page, viewport, "pin-open");
      await page.locator(".current-turn-prompt > summary").click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".current-turn-prompt[open]").count(), 0, "a second tap closes the pin");
      assert.deepEqual(report.mutations.filter((m) => m.viewport === viewport.name), [], "and asks Core for nothing");
      check(`${viewport.name}: a tap opens the one-line pin to the request, and another closes it`);

      // Allow once, pressed as a person would (Playwright presses only what
      // is on top at its middle), sends one answer.
      await toLatest(page);
      await page.locator(".pending-card .button-row button", { hasText: "Allow once" }).click({ timeout: 5000 });
      await page.waitForTimeout(500);
      const answers = report.answers.filter((a) => a.viewport === viewport.name);
      assert.deepEqual(answers.map((a) => a.body), [{ response: { decision: "accept" } }], `one answer, accept: ${JSON.stringify(answers)}`);
      check(`${viewport.name}: Allow once, pressed where it shows, sends one answer`);
    } else {
      if (seen.pin?.pinned) assert.ok(seen.pin.excerpt, `${viewport.name}: a tall conversation's pin keeps its excerpt`);
      check(`${viewport.name}: the approval is clear, and a pin that shows keeps its excerpt, as before`, { pin: seen.pin });
    }
    await context.close();
  }
  if (!baseline) {
    assert.deepEqual(report.errors, [], "no page errors");
    assert.deepEqual(report.mutations, [], "nothing else was asked of Core");
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, `${report.mode}-report.json`), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
