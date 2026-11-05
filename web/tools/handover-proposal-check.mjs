// T-34 S3b: a lead's handover proposal on Home, in Chromium, with every API
// answered here (no Core, no CLI, no daily configuration). Through the
// production build:
//  - the lead whose proposal waits comes first in the rail's attention order,
//    and the tab title counts the proposal;
//  - Home's Needs you lists it, named by its lead; Ctrl+J goes to its card;
//  - the card shows the lead's reason and the changed lines; approved with a
//    note, it is sent against the version read and leaves Home;
//  - the user saves the document elsewhere while a proposal waits: Core's
//    event re-reads Home, and the card shows it stale before any click; it
//    can't be approved; rejected, it is sent as a rejection (#612 R1);
//  - on a phone, the card and its fields fit their width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/handover-proposal-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-34", checks: [], decisions: [], unexpected: [], errors: [], console: [], unmodelled: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-handover-proposal.test";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 4, reviewedSeq: 4, goal: "", connectionState: "connected", status: "idle", cwd: "/w/lab", projectId: "p-lab", closedAt: null };
// In the list's own order: Hana, then Mori, the lead who proposes.
const agents = [{ ...base, id: "b", name: "Hana" }, { ...base, id: "a", name: "Mori", kind: "lead" }];
const projects = [{ id: "p-lab", name: "Lab", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

// What Core keeps: one proposal, pending until decided; `stale` when the user
// has saved a version since it was made.
const scenario = { state: "pending", stale: false };
const summary = () => ({ id: "h1", projectId: "p-lab", proposer: { id: "a", name: "Mori" }, baseVersion: 1, reason: "Say how to test",
  bytes: 60, at: at(20), state: scenario.state });
const home = () => {
  const waiting = scenario.state === "pending";
  return {
    generatedAt: at(0), order: ["p-lab"],
    needsYou: waiting ? [{ kind: "handover", projectId: "p-lab", agentId: "a", agentName: "Mori", proposalId: "h1", title: "Say how to test", since: at(20) }] : [],
    projects: [{ project: { id: "p-lab", name: "Lab" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
      errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      handoverProposal: waiting ? { ...summary(), currentVersion: scenario.stale ? 2 : 1 } : null,
      brief: { version: 1, history: [], sections: [], teamSections: [] } }],
  };
};
const detail = () => ({
  proposal: { ...summary(), markdown: "# Lab\nBuild with make; test with make check.\nThe fixtures live in tests/fixtures." },
  base: { version: 1, markdown: "# Lab\nBuild with make.\nThe fixtures live in tests/fixtures." },
  currentVersion: scenario.stale ? 2 : 1, stale: scenario.stale,
});

async function serve(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (path === "/api/projects/p-lab/handover/proposals/h1") return route.fulfill({ json: detail() });
  if (path === "/api/projects/p-lab/handover/proposals/h1/decision" && method === "POST") {
    const body = JSON.parse(request.postData() || "{}");
    report.decisions.push(body);
    if (body.action === "approve" && scenario.stale) return route.fulfill({ status: 400, json: { error: "version_conflict: the handover changed since this proposal" } });
    scenario.state = body.action === "approve" ? "approved" : "rejected";
    return route.fulfill({ json: { proposal: summary(), handover: { version: 2 } } });
  }
  if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
  if (method === "POST" && ["/api/collaboration/github_links", "/api/collaboration/github_refresh"].includes(path))
    return route.fulfill({ json: { links: [], repositories: [], refreshing: false } });
  if (method !== "GET") {
    report.unmodelled[`${method} ${path}`] = (report.unmodelled[`${method} ${path}`] || 0) + 1;
    if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws-handover" }, agents, projects, projectUsage: { "p-lab": { agents: 2, tasks: 0 } }, runtime: { connected: true }, defaultCwd: "/w" }),
    "/api/home": home,
    "/api/machines": () => ({ machines: [] }), "/api/updates": () => unmanagedUpdates, "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs, "/api/jobs/live": () => noLiveJobs, "/api/ci": () => noCiRuns, "/api/ci/live": () => noCiRuns, "/api/reviews": () => noReviews,
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  const agentPath = path.match(/^\/api\/agents\/(\w)$/);
  if (agentPath) return route.fulfill({ json: { agent: agents.find((a) => a.id === agentPath[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (path.endsWith("/codex/usage")) return route.fulfill({ json: usage });
  if (path.endsWith("/codex/mcp")) return route.fulfill({ json: mcp });
  if (path.startsWith("/api/")) {
    report.unmodelled[path] = (report.unmodelled[path] || 0) + 1;
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open(viewport) {
  const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  await context.addInitScript(() => {
    // Kept, so the check can deliver an event as Core sends it.
    window.EventSource = class { constructor() { window.__events = this; setTimeout(() => this.onopen?.(), 50); } close() {} };
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    if (!localStorage.getItem("yuzuno.appearance")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ agentOrder: "attention", projectGroups: "none" }));
      localStorage.setItem("yuzuno.selected.ws-handover", JSON.stringify("b"));
    }
  });
  await context.route("**/*", serve);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
  return { context, page };
}
const card = (page) => page.locator("#home-handover-h1");
// Whether the card, and each field in it, fits its own width.
const fits = (locator) => locator.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, button")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));

try {
  // ---- Waiting on you: the rail, the title, Needs you, Ctrl+J.
  let { context, page } = await open({ width: 1280, height: 900 });
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });
  const rail = await page.locator(".agent-list .agent-row").evaluateAll((rows) => rows.map((row) => row.dataset.agentId));
  assert.deepEqual(rail, ["a", "b"], "the lead whose proposal waits comes first in the attention order");
  await page.waitForFunction(() => document.title.startsWith("(1) "), null, { timeout: 10_000 });
  check("the lead whose proposal waits comes first in the rail, and the tab title counts the proposal", { title: await page.title() });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+j");
  await card(page).waitFor({ timeout: 10_000 });
  await page.locator('.home-needs-you [data-needs-you="handover:h1"]').waitFor({ timeout: 10_000 });
  const inView = await card(page).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
  assert.equal(inView, true, "Ctrl+J brings the proposal's card into view");
  check("Home's Needs you lists the proposal, named by its lead, and Ctrl+J goes to its card");

  // ---- The card: reason, changed lines; approved with a note.
  await card(page).locator(".changes-lines").waitFor({ timeout: 10_000 });
  assert.match(await card(page).textContent(), /Say how to test/);
  const lines = await card(page).locator(".changes-lines [data-line]").evaluateAll((spans) => spans.map((s) => [s.dataset.line, s.textContent.trim()]));
  assert.deepEqual(lines.filter(([kind]) => kind !== "meta"), [["del", "- Build with make."], ["add", "+ Build with make; test with make check."]]);
  await page.screenshot({ path: join(output, "1-card.png") });
  await card(page).locator('input[aria-label="Note for Mori"]').fill("Thanks, merged");
  await card(page).getByRole("button", { name: "Approve" }).click();
  await card(page).waitFor({ state: "detached", timeout: 10_000 });
  assert.deepEqual({ ...report.decisions[0], requestId: typeof report.decisions[0].requestId },
    { requestId: "string", action: "approve", expectedVersion: 1, note: "Thanks, merged" });
  await page.locator('.home-needs-you [data-needs-you="handover:h1"]').waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForFunction(() => !document.title.startsWith("("), null, { timeout: 10_000 });
  await page.screenshot({ path: join(output, "2-approved.png") });
  check("the card shows the reason and the changed lines; approved with a note against version 1, it leaves Home and the count", { body: report.decisions[0] });
  await context.close();

  // ---- Saved elsewhere while it waits: stale before any click; not approved; rejected.
  Object.assign(scenario, { state: "pending", stale: false });
  ({ context, page } = await open({ width: 1280, height: 900 }));
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: /^Home/ }).first().click();
  await card(page).locator(".changes-lines").waitFor({ timeout: 10_000 });
  assert.equal(await card(page).getByRole("button", { name: "Approve" }).isDisabled(), false, "on the current version it can be approved");
  // The user saves version 2 in the Project's settings; Core announces the Brief scope.
  scenario.stale = true;
  await page.evaluate(() => window.__events.onmessage({ data: JSON.stringify({ type: "workspace.changed", scope: "brief", projectId: "p-lab" }), lastEventId: "" }));
  await card(page).getByText("it is at version 2 now, not 1", { exact: false }).waitFor({ timeout: 10_000 });
  assert.equal(await card(page).getByRole("button", { name: "Approve" }).isDisabled(), true, "a stale proposal can't be approved");
  assert.equal(report.decisions.length, 1, "the card showed it stale before any click");
  await page.screenshot({ path: join(output, "3-stale.png") });
  await card(page).getByRole("button", { name: "Reject" }).click();
  await card(page).waitFor({ state: "detached", timeout: 10_000 });
  assert.deepEqual({ ...report.decisions[1], requestId: typeof report.decisions[1].requestId },
    { requestId: "string", action: "reject", expectedVersion: 2 });
  check("saved elsewhere while it waits, the card shows it stale before any click; it can't be approved; rejected, it is sent against version 2", { body: report.decisions[1] });
  await context.close();

  // ---- On a phone: the card fits.
  Object.assign(scenario, { state: "pending", stale: false });
  ({ context, page } = await open({ width: 390, height: 844 }));
  await page.goto(`https://${HOST}/`);
  const home = page.getByRole("button", { name: /^Home/ }).first();
  if (await home.isVisible()) await home.click();
  else await page.keyboard.press("Control+j");
  await card(page).locator(".changes-lines").waitFor({ timeout: 10_000 });
  await card(page).scrollIntoViewIfNeeded();
  assert.deepEqual(await fits(card(page)), { box: true, wider: [] }, "on a phone the card fits its width");
  await page.screenshot({ path: join(output, "4-phone.png") });
  check("at 390 px the card and its fields fit their width");
  await context.close();

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.equal(report.decisions.length, 2, "two decisions, nothing else decided");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
