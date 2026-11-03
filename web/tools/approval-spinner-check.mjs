// T-19 CV:Q-02: in Chromium on a production build of the app with a synthetic Workspace. A Codex
// approval card's decision, once pressed, shows the spinner the answer form has, on its own button
// only, while Core has not answered; every decision stays disabled meanwhile. The reply is held and
// never answered, so this is the state a slow Core leaves. Desktop and narrow, normal and reduced
// motion. Under reduced motion the spinner is there but still, as every animation is
// (styles.css's reduced-motion rule), the answer form's included. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/approval-spinner-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/approval-spinner");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], held: [] };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "waiting", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 1, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const request = { id: "decide", agentId: "a", method: "item/commandExecution/requestApproval", createdAt: "",
  params: { command: "npm test", cwd: "/w", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] } };
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [request], artifacts: [], turns: [] },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    // The decision itself: held, never answered.
    if (request.method() === "POST" && url.pathname === "/api/requests/decide/respond") {
      report.held.push(request.postData());
      return;
    }
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) return route.fulfill({ json: { accepted: true } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    return route.fulfill({ json: gets[url.pathname] ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "narrow", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "narrow-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  try {
    await page.goto("http://yuzuno-approval.test/");
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    const card = page.locator(".pending-card").first();
    await card.waitFor();
    const decline = card.getByRole("button", { name: "Decline" });
    await decline.scrollIntoViewIfNeeded();
    await decline.click();
    await page.waitForTimeout(300);
    const state = await card.evaluate((el) => [...el.querySelectorAll("button")].filter((b) => b.closest(".button-row")).map((b) => {
      const spin = b.querySelector(".spin");
      return { text: b.textContent.trim(), disabled: b.disabled, busy: b.getAttribute("aria-busy"),
        spin: !!spin, turning: spin ? spin.getAnimations().some((a) => a.playState === "running") : false };
    }));
    await card.screenshot({ path: join(output, `${tag}-decline-sending.png`) });
    const spinning = state.filter((b) => b.spin).map((b) => b.text);
    ok(`${tag}: once Decline is pressed, only Decline shows the spinner (${JSON.stringify(spinning)}), aria-busy`,
      spinning.length === 1 && spinning[0] === "Decline" && state.find((b) => b.text === "Decline")?.busy === "true", state);
    ok(`${tag}: every decision is disabled while it is on its way`, state.length === 4 && state.every((b) => b.disabled), state);
    const reduced = run.reducedMotion === "reduce";
    ok(reduced ? `${tag}: under reduced motion the spinner is there and still` : `${tag}: the spinner turns, as the answer form's does`,
      state.find((b) => b.text === "Decline")?.turning === !reduced, state.find((b) => b.text === "Decline"));
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`each decision was sent once and held (${report.held.length})`, report.held.length === runs.length &&
  report.held.every((body) => JSON.parse(body).response?.decision === "decline"), report.held);
ok("nothing else was written", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "approval-spinner-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
