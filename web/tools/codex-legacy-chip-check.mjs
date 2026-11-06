// T-19 CV:CX-10 (F3), in Chromium on a production build of the app with a synthetic Workspace and every API
// answered here (no Core, no Agent). An Agent whose permissions predate the presets (Mori: never ask,
// read-only) shows them as a disabled "Custom · existing settings" chip; choosing a mode removes it. It now
// comes last, so no chip moves under the pointer when it goes.
// - Agent settings for Mori: the Custom chip is shown, checked and disabled; choosing Ask for approval leaves
//   every other chip where it was (within 0.5 px); Save writes what was chosen, as before.
// - Import Codex (New agent, Existing Codex session): a new Agent starts at Ask for approval, so there is no
//   Custom chip; choosing Approve for me leaves every chip where it was.
// Desktop 1280×860 with a click, phone 390×844 with a tap, each also with the keyboard (Space on the focused
// choice). Writes: the one settings save each run asks for; anything else is refused and counted.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/codex-legacy-chip-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/codex-legacy-chip");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], saves: [], readingSaves: [], unknownGets: [], cases: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)}`}`);
};

const WORKSPACE = "ws-legacy-chip";
// Mori's own permissions, from before the presets: no prompts, read-only files.
const OLDER = { reasoningEffort: "high", approvalPolicy: "never", sandbox: "read-only" };
const agent = () => ({ id: "a", name: "Mori", status: "idle", goal: "", cwd: "/fixture", model: "test-model", color: "sage",
  createdAt: "", updatedAt: "1", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex",
  connectionState: "connected", settings: { ...OLDER } });
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Tidy the fixture notes." }] },
  { id: "a1", type: "agentMessage", text: "Done." },
] }];
const preset = (id, approvalPolicy, approvalsReviewer, sandbox) =>
  ({ id, available: true, permissions: { approvalPolicy, approvalsReviewer, sandbox, profile: null } });
const permissions = { presets: [
  preset("config", "on-request", "auto_review", "read-only"),
  preset("ask", "on-request", "user", "workspace-write"),
  preset("auto", "on-request", "auto_review", "workspace-write"),
  preset("full", "never", "user", "danger-full-access"),
] };
const models = { models: [{ id: "test-model", model: "test-model", displayName: "Test model", defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Careful reasoning" }] }], permissions };
const THREAD = "019a1234-5678-4321-aaaa-123456789abc";
const codexPreview = { threadId: THREAD, name: "Fixture session", cwd: "/fixture", preview: "Carry on with the fixture.",
  model: "gpt-fixture", reasoningEffort: "high", turnCount: 12, updatedAt: Date.now() / 1000, existingAgentId: null, warnings: [],
  permissions };
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
let mori = agent();
const gets = () => ({
  "/api/workspace": { workspace: { id: WORKSPACE }, agents: [mori], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent: mori, pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a/models": models,
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/backlog": { observedAt: "2026-11-04T00:00:00Z", agents: {} },
  "/api/models": models,
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/agents/a/reading") {
      if (method === "GET") return route.fulfill({ json: { handoff: null } });
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true, sourceSeq: 0 } });
    }
    if (method === "POST" && url.pathname === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && url.pathname === "/api/agents/a/review") return route.fulfill({ json: {} });
    if (method === "POST" && url.pathname === "/api/codex/sessions/preview") return route.fulfill({ json: codexPreview });
    if (method === "POST" && url.pathname === "/api/agents/a/settings") {
      const body = request.postDataJSON();
      report.saves.push(body.settings);
      mori = { ...mori, settings: body.settings };
      return route.fulfill({ json: mori });
    }
    if (method !== "GET") {
      report.writes.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 400, json: { error: "this check writes nothing else" } });
    }
    const json = gets()[url.pathname];
    if (json) return route.fulfill({ json });
    if (!report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
}

/** Each chip of the dialog's Permissions group: where it is, and whether it is checked or disabled. */
function chips() {
  const group = document.querySelector('[role="dialog"] [role="radiogroup"][aria-label="Permissions"]');
  if (!group) return null;
  const scroller = group.closest(".modal") || group.closest('[role="dialog"]');
  return {
    scrollTop: Math.round(scroller.scrollTop * 10) / 10,
    chips: [...group.querySelectorAll(".choice-chip")].map((chip) => {
      const r = chip.getBoundingClientRect();
      const input = chip.querySelector("input");
      return { value: chip.dataset.value, x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
        w: Math.round(r.width * 10) / 10, checked: input.checked, disabled: input.disabled };
    }),
  };
}
/** The chips both sides have, each in place within 0.5 px. */
function stayed(before, after) {
  const moved = [];
  for (const chip of after?.chips ?? []) {
    const was = before?.chips.find((c) => c.value === chip.value);
    if (!was) moved.push({ value: chip.value, was: null });
    else if (Math.abs(was.x - chip.x) > 0.5 || Math.abs(was.y - chip.y) > 0.5)
      moved.push({ value: chip.value, from: [was.x, was.y], to: [chip.x, chip.y] });
  }
  return { held: !!after?.chips.length && moved.length === 0, moved };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { tag: "desktop, a click", width: 1280, height: 860, touch: false, keys: false },
  { tag: "desktop, the keyboard", width: 1280, height: 860, touch: false, keys: true },
  { tag: "phone, a tap", width: 390, height: 844, touch: true, keys: false },
  { tag: "phone, the keyboard", width: 390, height: 844, touch: true, keys: true },
];
const chipOf = (page, value) => page.getByRole("dialog").getByRole("radiogroup", { name: "Permissions", exact: true })
  .locator(`.choice-chip[data-value="${value}"]`);
/** Gets ready to choose `value` as this run does: with the keyboard, its radio is focused first (before the
 * chips are measured, so a scroll to it is not counted). */
async function ready(page, run, value) {
  if (run.keys) await chipOf(page, value).locator("input").focus();
}
/** Chooses `value` in the dialog's Permissions group as this run does: its chip clicked or tapped, or
 * Space on its focused radio. */
async function choose(page, run, value) {
  const chip = chipOf(page, value);
  if (run.keys) await page.keyboard.press("Space");
  else if (run.touch) await chip.tap();
  else await chip.click();
  await page.waitForFunction((v) => document.querySelector(`[role="dialog"] [aria-label="Permissions"] input[value="${v}"]`)?.checked, value);
  await page.waitForTimeout(200);
}
for (const run of runs) {
  const tag = run.tag;
  mori = agent();
  const context = await browser.newContext({ viewport: { width: run.width, height: run.height }, hasTouch: run.touch,
    isMobile: run.touch, deviceScaleFactor: run.touch ? 2 : 1, locale: "en-US" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} addEventListener() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  await page.route("http://yuzuno-legacy-chip.test/**", serve);
  const dialog = page.getByRole("dialog");
  const group = dialog.getByRole("radiogroup", { name: "Permissions", exact: true });
  const savesBefore = report.saves.length;
  try {
    await page.goto("http://yuzuno-legacy-chip.test/");
    // Mori's Agent settings: the header's button, or on a narrow screen the conversation's actions menu.
    const composer = page.locator('[data-composer-input][aria-label="Message Mori"]');
    if (!(await composer.isVisible().catch(() => false))) {
      if (run.touch && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click().catch(() => {});
      await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
      await composer.waitFor();
    }
    const direct = page.getByRole("button", { name: "Agent settings", exact: true });
    if (await direct.isVisible().catch(() => false)) await direct.click();
    else {
      await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Agent settings…", exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [aria-label="Permissions"] input[value="ask"]')?.disabled === false);
    await group.scrollIntoViewIfNeeded();
    await ready(page, run, "ask");
    await page.waitForTimeout(300);
    const before = await page.evaluate(chips);
    const custom = before?.chips.find((c) => c.value === "legacy");
    ok(`${tag}: Agent settings: Mori's older permissions are the checked, disabled Custom · existing settings chip`,
      !!custom && custom.checked && custom.disabled, before);
    await choose(page, run, "ask");
    const after = await page.evaluate(chips);
    const held = stayed(before, after);
    report.cases[`${tag}: Agent settings`] = { before, after, moved: held.moved };
    ok(`${tag}: Agent settings: choosing Ask for approval leaves every other chip where it was`,
      held.held && !after.chips.some((c) => c.value === "legacy"), { moved: held.moved, scrollTop: [before?.scrollTop, after?.scrollTop],
        order: before?.chips.map((c) => c.value) });
    await page.screenshot({ path: resolve(output, `${tag.replace(/[^a-z]+/g, "-")}-settings.png`) });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const saved = report.saves.slice(savesBefore);
    ok(`${tag}: Agent settings: Save writes what was chosen, once: Ask for approval, on request, workspace files`,
      saved.length === 1 && saved[0].permissionPreset === "ask" && saved[0].approvalPolicy === "on-request"
        && saved[0].sandbox === "workspace-write", saved);

    // Import Codex: New agent, an existing Codex session, after its preview.
    if (run.touch && !(await page.locator(".add-agent").isVisible().catch(() => false)))
      await page.locator(".phone-back").click().catch(() => {});
    const add = page.locator(".add-agent");
    await (run.touch ? add.tap() : add.click());
    await dialog.getByRole("button", { name: "Existing Codex session", exact: true }).click();
    await dialog.getByLabel("Codex session ID").fill(THREAD);
    await dialog.getByRole("button", { name: "Preview session", exact: true }).click();
    await dialog.locator(".session-preview").waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [aria-label="Permissions"] input[value="auto"]')?.disabled === false);
    await group.scrollIntoViewIfNeeded();
    await ready(page, run, "auto");
    await page.waitForTimeout(300);
    const first = await page.evaluate(chips);
    await choose(page, run, "auto");
    const then = await page.evaluate(chips);
    const kept = stayed(first, then);
    report.cases[`${tag}: Import Codex`] = { before: first, after: then, moved: kept.moved };
    ok(`${tag}: Import Codex: no Custom chip (a new Agent starts at Ask for approval), and choosing Approve for me leaves every chip where it was`,
      !!first && !first.chips.some((c) => c.value === "legacy") && first.chips.find((c) => c.value === "ask")?.checked && kept.held,
      { moved: kept.moved, order: first?.chips.map((c) => c.value) });
    await page.screenshot({ path: resolve(output, `${tag.replace(/[^a-z]+/g, "-")}-import.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: resolve(output, `${tag.replace(/[^a-z]+/g, "-")}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("nothing else was written (each run's one settings save is counted apart)", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(resolve(output, "codex-legacy-chip-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
