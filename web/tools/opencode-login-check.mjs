// T-32 slice 4b, an OpenCode Agent's "Log in to a provider" in Chromium on a production build of the app, with no Core:
// the reads this check knows are answered here; any other gets {} and is listed in the report (unknownGets). Mori is a
// connected OpenCode Agent, logged in to OpenRouter as "work". On desktop 1280×860 and phone 390×844, in its settings:
// - the section lists Mori's logins, inside the dialog and overlapping nothing;
// - GitHub Copilot's device sign-in opens its form with each field's default filled in (R2 5ca76575 of #621); the
//   enterprise choice asks for its URL, and the sign-in is started with the answers, the unchanged default among them;
// - its link and instructions are shown, and Cancel cancels it at OpenCode;
// - a key logged in to OpenRouter is sent once, in the request's body; its field is empty after, the key is in no
//   link or storage, and the new login is listed.
// Writes: none but the sign-in, its cancel, the key login and the app's own saves of where an Agent was read. Served
// from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/opencode-login-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/opencode-login-check");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], logins: [], measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const KEY = "fixture-chromium-key-4Rb";
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "", color: "green", status: "idle", createdAt: "",
  updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "opencode", connectionState: "connected",
  settings: null };
const turn = { id: "t1", status: "completed", items: [
  { id: "t1-ask", type: "userMessage", content: [{ type: "text", text: "Start" }] },
  { id: "t1-reply", type: "agentMessage", text: "Started." },
] };
const copilot = { kind: "oauth", id: "github-copilot/device", label: "Login with GitHub Copilot", names: [], fields: [
  { key: "deploymentType", title: "Select GitHub deployment type", description: "", required: true, placeholder: "", default: "github.com", when: [],
    options: [{ value: "github.com", label: "GitHub.com", description: "" }, { value: "enterprise", label: "GitHub Enterprise", description: "" }] },
  { key: "enterpriseUrl", title: "Enter your GitHub Enterprise URL", description: "", required: true, placeholder: "company.ghe.com", default: null,
    options: [], when: [{ key: "deploymentType", op: "eq", value: "enterprise" }] },
  { key: "scope", title: "Scope", description: "", required: false, placeholder: "", default: "read:user", options: [], when: [] },
] };
const work = { kind: "credential", id: "crd_1", label: "work", method: "key", needsAuth: null };
const view = (connections) => ({ state: "ready", reason: null, version: "2.2.5", integrations: [
  { id: "openrouter", name: "OpenRouter", connections, methods: [{ kind: "key", id: null, label: "Manually enter API Key", fields: [], names: [] },
    { kind: "env", id: null, label: "", fields: [], names: ["OPENROUTER_API_KEY"] }] },
  { id: "github-copilot", name: "GitHub Copilot", connections: [], methods: [copilot,
    { kind: "elsewhere", id: "github-copilot/cli", label: "With its CLI", fields: [], names: [] }] },
] });
let connections;
const fresh = () => { connections = [work]; report.logins = []; };
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": { agents: {} }, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [turn] },
  "/api/agents/a/models": { models: [], opencode: { version: "2.2.5", verified: "2.2.5" } },
  "/api/agents/a/opencode/login": view(connections),
  "/api/agents/a/opencode/fork": { state: "none" },
  "/api/agents/a/rewind/attempt": { attempt: null },
  "/api/agents/a/reading": { handoff: null },
  "/api/agents/a/conversation/inputs": { inputs: [], hasBefore: false, total: 0 },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
  "/api/machines": { machines: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    const login = "/api/agents/a/opencode/login";
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && path === "/api/agents/a/reading") return route.fulfill({ json: { accepted: true } });
      if (request.method() === "POST" && path === `${login}/oauth`) {
        report.logins.push({ path, url: request.url(), body: request.postDataJSON() });
        return route.fulfill({ json: { attemptId: "con_1", url: "https://github.com/login/device", instructions: "Enter code WXYZ-0001",
          mode: "auto", time: {} } });
      }
      if (request.method() === "DELETE" && path === `${login}/oauth/github-copilot/con_1`) {
        report.logins.push({ path, url: request.url(), method: "DELETE" });
        return route.fulfill({ status: 204, body: "" });
      }
      if (request.method() === "POST" && path === `${login}/key`) {
        report.logins.push({ path, url: request.url(), body: request.postDataJSON() });
        connections = [work, { ...work, id: "crd_2", label: "home" }];
        return route.fulfill({ json: view(connections) });
      }
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    // An automatic sign-in is asked about until it ends: pending here, until it is cancelled.
    if (path === `${login}/oauth/github-copilot/con_1`) return route.fulfill({ json: { status: "pending" } });
    const known = gets()[path];
    if (known !== undefined) return route.fulfill({ json: known });
    if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
    return route.fulfill({ json: {} });
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = resolve(dist, file);
  assert.ok(full.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(full), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 } },
  { name: "phone", viewport: { width: 390, height: 844 }, phone: true },
];
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  try {
    fresh();
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(() => {
      window.EventSource = class { constructor() {} addEventListener() {} close() {} };
      localStorage.clear();
      localStorage.setItem("yuzuno.selected.fixture", JSON.stringify("a"));
    });
    await page.goto("http://127.0.0.1:4325/");
    if (run.phone && !(await page.locator('[data-turn-id="t1"]').count()))
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click({ timeout: 5000 }).catch(() => {});
    await page.locator('[data-turn-id="t1"]').waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".agent-settings-button").click();
    const dialog = page.getByRole("dialog");
    const section = dialog.locator(".opencode-login");
    await section.getByText("OpenRouter · work").waitFor({ timeout: 10_000 });
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // The section in the dialog, its parts overlapping nothing.
    const box = await section.boundingBox();
    const frame = await dialog.boundingBox();
    const parts = await section.locator(":scope > *").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, name: el.className || el.tagName };
    }));
    const clashes = parts.flatMap((a, i) => parts.slice(i + 1).filter((b) => a.width && b.width && overlaps(a, b)).map((b) => [a.name, b.name]));
    report.measures[`${tag}: section`] = { box, frame, parts };
    ok(`${tag}: the section lists Mori's logins, inside the dialog, its parts overlapping nothing`,
      !!box && !!frame && box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1 && clashes.length === 0, { clashes });

    // GitHub Copilot's form, its defaults filled in; the enterprise choice asks for its URL.
    await section.locator(".opencode-login-provider select").selectOption("github-copilot");
    await section.getByRole("button", { name: "Login with GitHub Copilot" }).click();
    const form = section.locator(".opencode-login-form");
    await form.waitFor({ timeout: 5000 });
    const choice = form.locator("select");
    const scope = form.locator("label", { hasText: "Scope" }).locator("input");
    const prefilled = [await choice.inputValue(), await scope.inputValue()];
    ok(`${tag}: the form opens with each field's default filled in`, prefilled[0] === "github.com" && prefilled[1] === "read:user", prefilled);
    const buttons = await section.locator(".opencode-login-methods > *").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, name: el.textContent };
    }));
    const crowded = buttons.flatMap((a, i) => buttons.slice(i + 1).filter((b) => a.width && b.width && overlaps(a, b)).map((b) => [a.name, b.name]));
    ok(`${tag}: its methods overlap nothing`, crowded.length === 0, { buttons, crowded });
    await page.screenshot({ path: join(output, `${tag}-form.png`) });
    await choice.selectOption("enterprise");
    await form.locator("label", { hasText: "Enterprise URL" }).locator("input").fill("company.ghe.com");
    await form.getByRole("button", { name: "Log in", exact: true }).click();
    await section.locator('a[href="https://github.com/login/device"]').waitFor({ timeout: 5000 });
    const started = report.logins.find((l) => l.path.endsWith("/oauth"));
    ok(`${tag}: the sign-in starts with the answers, the unchanged default among them`,
      JSON.stringify(started?.body) === JSON.stringify({ integration: "github-copilot", method: "github-copilot/device",
        answer: { deploymentType: "enterprise", enterpriseUrl: "company.ghe.com", scope: "read:user" } }), started?.body);
    ok(`${tag}: its link and instructions are shown`, (await section.textContent()).includes("Enter code WXYZ-0001"));
    await page.screenshot({ path: join(output, `${tag}-attempt.png`) });
    await section.getByRole("button", { name: "Cancel" }).click();
    await section.locator('a[href="https://github.com/login/device"]').waitFor({ state: "detached", timeout: 5000 });
    ok(`${tag}: Cancel cancels it at OpenCode`, report.logins.some((l) => l.method === "DELETE"), report.logins);

    // A key to OpenRouter: sent once, in the body; its field empty after, in no link or storage; the new login listed.
    await section.locator(".opencode-login-provider select").selectOption("openrouter");
    await section.getByRole("button", { name: "Log in with an API key" }).click();
    await section.locator('input[type="password"]').fill(KEY);
    await section.locator(".opencode-login-form").getByRole("button", { name: "Log in", exact: true }).click();
    await section.getByText("OpenRouter · home").waitFor({ timeout: 5000 });
    const keyed = report.logins.filter((l) => l.path.endsWith("/key"));
    ok(`${tag}: the key is sent once, in the request's body`,
      keyed.length === 1 && JSON.stringify(keyed[0].body) === JSON.stringify({ integration: "openrouter", key: KEY }), keyed);
    const left = await page.evaluate((key) => ({
      fields: [...document.querySelectorAll("input")].filter((i) => i.value.includes(key)).length,
      storage: [localStorage, sessionStorage].flatMap((s) => Object.keys(s).filter((k) => String(s.getItem(k)).includes(key))),
      link: location.href.includes(key),
    }), KEY);
    ok(`${tag}: the key is in no field, link or storage after`,
      left.fields === 0 && left.storage.length === 0 && !left.link && report.logins.every((l) => !l.url.includes(KEY)), left);
    ok(`${tag}: nothing written but the logins`, report.writes.length === 0, report.writes);
    await page.screenshot({ path: join(output, `${tag}-logged-in.png`) });
    await page.close();
  } catch (error) {
    report.failures.push({ name: `${tag}: sequence ran to its end`, detail: String(error?.stack || error).slice(0, 1200) });
    console.log(`FAIL ${tag}: sequence ran to its end: ${String(error).slice(0, 300)}`);
  } finally {
    await context.close();
  }
}
await browser.close();
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "opencode-login-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
