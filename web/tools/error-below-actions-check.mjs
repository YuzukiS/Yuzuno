// T-19 CV:CX-70, ST:SX-25, ST:SX-35 and ST:SX-47 (F3): a dialog's failure alert does not push its buttons
// down under the pointer. In Chromium on a production build of the app with a synthetic Workspace that is
// never written to. Four failures, each refused by the fixture:
// - CX-70: Discard saved draft, on Mori's draft that could not be read; browser storage refuses the reset.
// - SX-25: Create agent in New agent; Core refuses the create.
// - SX-35: Add to workspace for an existing Codex session, after its preview; Core refuses the import.
// - SX-47: Add to workspace for an existing Claude session, after its preview; Core refuses the import.
// For each, Cancel and the pressed button keep their places, the alert shows (role="alert") and is wholly in
// view, the refused write happens once, and focus does not fall to the page. New agent and its two import tabs
// scroll, so there the alert keeps its line above the buttons; the draft dialog does not, so there it comes
// below them. Desktop 1280×860 (a click) and phone 390×844 (a tap), and Enter on the focused button in each. Writes other than the refused ones and the app's
// own saves of where an Agent was read are refused and listed. Reads the fixture does not know are answered
// {} and listed. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/error-below-actions-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/error-below-actions");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], refused: [], readingSaves: [], unknownGets: [], cases: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)}`}`);
};

const WORKSPACE = "ws-error-below";
const agents = [{ id: "a", name: "Mori", status: "idle", goal: "", cwd: "/fixture", model: "m", color: "sage", createdAt: "",
  updatedAt: "1", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex",
  connectionState: "connected" }];
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Tidy the fixture notes." }] },
  { id: "a1", type: "agentMessage", text: "Done." },
] }];
const THREAD = "019a1234-5678-4321-aaaa-123456789abc";
const CLAUDE = "5e55a0ee-0000-4000-8000-0000000000a1";
const codexPreview = { threadId: THREAD, name: "Fixture session", cwd: "/fixture", preview: "Carry on with the fixture.",
  model: "gpt-fixture", reasoningEffort: "high", turnCount: 12, updatedAt: Date.now() / 1000, existingAgentId: null, warnings: [],
  permissions: { presets: ["ask", "auto", "full", "config"].map((id) => ({ id, available: true })) } };
const claudeSession = { sessionId: CLAUDE, title: "Fix the build", firstPrompt: "Fix the build", cwd: "/fixture", gitBranch: "main",
  tag: null, lastModified: Date.now() - 3 * 86_400_000, createdAt: null, fileSize: 100, existingAgentId: null };
const claudePreview = { session: claudeSession, saved: 9, prompts: 2, images: 0, compacted: false, subagents: 0, model: "claude-fixture",
  recent: [{ role: "user", text: "Run the tests", at: null }, { role: "assistant", text: "All 12 pass.", at: null }],
  folderExists: true, existingAgentId: null, occupancy: "unknown" };
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/backlog": { observedAt: "2026-11-04T00:00:00Z", agents: {} },
  "/api/models": { models: [] },
  "/api/claude/sessions": { sessions: [claudeSession], next: null },
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
};
// The writes each case expects, all refused as Core would refuse them; previews only read.
const refusals = {
  "POST /api/agents": "Core refused to create this Agent (fixture).",
  "POST /api/codex/sessions/import": "Core refused to import this session (fixture).",
  "POST /api/claude/sessions/import": "Core refused to import this session (fixture).",
};
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
    if (method === "POST" && url.pathname === "/api/codex/sessions/preview") return route.fulfill({ json: codexPreview });
    if (method === "POST" && url.pathname === "/api/claude/sessions/preview") return route.fulfill({ json: claudePreview });
    const refusal = refusals[`${method} ${url.pathname}`];
    if (refusal) {
      report.refused.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: refusal } });
    }
    if (method !== "GET") {
      report.writes.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 400, json: { error: "this check writes nothing" } });
    }
    const json = gets[url.pathname];
    if (json) return route.fulfill({ json });
    report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
}

/** Where two buttons and the alert are, and whether the alert can be seen in its dialog and the window. */
function measure([cancel, pressed]) {
  const dialog = document.querySelector('[role="dialog"]');
  const button = (label) => [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };
  const scroller = dialog.closest(".modal") || dialog;
  const frame = scroller.getBoundingClientRect();
  const alert = dialog.querySelector('[role="alert"]');
  const a = alert?.getBoundingClientRect();
  const a11y = document.activeElement;
  return {
    cancel: box(button(cancel)),
    pressed: box(button(pressed)),
    alert: box(alert),
    alertText: alert?.textContent.trim().slice(0, 120) ?? null,
    // In view: the whole alert inside both the dialog's visible box and the window.
    alertInView: !!a && a.top >= Math.max(frame.top, 0) - 0.5 && a.bottom <= Math.min(frame.bottom, innerHeight) + 0.5,
    dialog: { top: Math.round(frame.top), bottom: Math.round(frame.bottom), scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    focus: !a11y || a11y === document.body ? "page" : a11y.tagName === "BUTTON" ? `button: ${a11y.textContent.trim()}`
      : a11y.closest('[role="dialog"]') ? `in the dialog: ${a11y.tagName.toLowerCase()}` : `elsewhere: ${a11y.tagName.toLowerCase()}`,
  };
}
const same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;

const browser = await launchBrowser();
const runs = [
  { tag: "desktop", width: 1280, height: 860, touch: false },
  { tag: "phone", width: 390, height: 844, touch: true },
];
const inputs = ["pointer", "Enter"];
const DRAFT = `yuzuno.composer.v1:${JSON.stringify([WORKSPACE, "a"])}`;
const cases = [
  { key: "CX-70", tag: "Discard saved draft", cancel: "Cancel", pressed: "Discard saved draft", write: null },
  { key: "SX-25", tag: "New agent's Create agent", cancel: "Cancel", pressed: "Create agent", write: "POST /api/agents" },
  { key: "SX-35", tag: "an existing Codex session's Add to workspace", cancel: "Cancel", pressed: "Add to workspace",
    write: "POST /api/codex/sessions/import" },
  { key: "SX-47", tag: "an existing Claude session's Add to workspace", cancel: "Cancel", pressed: "Add to workspace",
    write: "POST /api/claude/sessions/import" },
];

/** A click (a tap on a phone), or Enter on the button once it has focus. */
async function press(run, input, button) {
  if (input === "Enter") {
    await button.focus();
    await button.press("Enter");
  } else if (run.touch) await button.tap();
  else await button.click();
}

try {
  for (const run of runs) for (const input of inputs) {
    const how = `${run.tag}, ${input === "Enter" ? "Enter" : run.touch ? "a tap" : "a click"}`;
    for (const c of cases) {
      const context = await browser.newContext({ viewport: { width: run.width, height: run.height }, hasTouch: run.touch, isMobile: run.touch });
      const page = await context.newPage();
      await page.addInitScript(({ draft, broken }) => {
        // The event stream, spoken for Core by this check: a fresh one starts with `reset`.
        let id = 0;
        window.EventSource = class {
          constructor() {
            this.readyState = 0;
            setTimeout(() => {
              if (this.readyState === 2) return;
              this.readyState = 1;
              this.onopen?.({});
              this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
            }, 0);
          }
          addEventListener() {}
          close() { this.readyState = 2; }
        };
        localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
        // Mori's saved draft, which this version cannot read: the composer offers Reset saved draft….
        if (broken) localStorage.setItem(draft, JSON.stringify({ version: 2 }));
      }, { draft: DRAFT, broken: c.key === "CX-70" });
      page.on("pageerror", (error) => report.errors.push(`${how} ${c.key}: ${error.message}`));
      await page.route("http://yuzuno-error-below.test/**", serve);
      const name = `${how}: ${c.tag} (${c.key})`;
      const refusedBefore = report.refused.length;
      try {
        await page.goto("http://yuzuno-error-below.test/");
        const dialog = page.getByRole("dialog");
        if (c.key === "CX-70") {
          const composer = page.locator('[data-composer-input][aria-label="Message Mori"]');
          if (!(await composer.isVisible().catch(() => false))) {
            if (run.touch && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
            await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
          }
          await page.getByRole("button", { name: "Reset saved draft…", exact: true }).click();
          await dialog.getByRole("button", { name: c.pressed, exact: true }).waitFor();
          // Browser storage refuses the reset (as pasted-text-browser does), so the draft is not discarded.
          await page.evaluate((key) => {
            const set = Storage.prototype.setItem;
            Storage.prototype.setItem = function (k, v) {
              if (k === key) throw new Error("Fixture denied reset");
              return set.call(this, k, v);
            };
          }, DRAFT);
        } else {
          if (run.touch && !(await page.locator(".add-agent").isVisible().catch(() => false)))
            await page.locator(".phone-back").click().catch(() => {});
          const add = page.locator(".add-agent");
          await (run.touch ? add.tap() : add.click());
          await dialog.getByRole("button", { name: "Cancel", exact: true }).waitFor();
          if (c.key === "SX-25") await dialog.getByLabel("Name", { exact: true }).fill("Peach");
          else if (c.key === "SX-35") {
            await dialog.getByRole("button", { name: "Existing Codex session", exact: true }).click();
            await dialog.getByLabel("Codex session ID").fill(THREAD);
            await dialog.getByRole("button", { name: "Preview session", exact: true }).click();
            await dialog.locator(".session-preview").waitFor();
          } else {
            await dialog.getByRole("button", { name: "Existing Claude session", exact: true }).click();
            await dialog.getByRole("button", { name: "Fix the build" }).first().click();
            await dialog.getByRole("button", { name: c.pressed, exact: true }).waitFor();
          }
        }
        const button = dialog.getByRole("button", { name: c.pressed, exact: true });
        await button.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const before = await page.evaluate(measure, [c.cancel, c.pressed]);
        await press(run, input, button);
        await dialog.getByRole("alert").waitFor();
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const after = await page.evaluate(measure, [c.cancel, c.pressed]);
        const refused = report.refused.slice(refusedBefore);
        report.cases[name] = { before, after, refused };
        const detail = { before, after, refused };
        ok(`${name}: the failure is refused once, and its alert shows`,
          !!after.alertText && (c.write ? refused.length === 1 && refused[0] === c.write : refused.length === 0), detail);
        ok(`${name}: Cancel and ${c.pressed} stay where they were`, same(before.cancel, after.cancel) && same(before.pressed, after.pressed), detail);
        ok(`${name}: the alert is in view`, after.alertInView, detail);
        ok(`${name}: focus does not fall to the page`, after.focus !== "page", detail);
        await page.screenshot({ path: resolve(output, `${run.tag}-${input}-${c.key}.png`) });
      } catch (error) {
        ok(`${name}: the sequence ran to its end`, false, String(error?.message ?? error).slice(0, 400));
      }
      await context.close();
    }
  }
  ok("no page errors", report.errors.length === 0, report.errors);
  ok("writes: none but the refused ones and the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
} finally {
  await browser.close();
  report.unknownGets = [...new Set(report.unknownGets)];
  await writeFile(resolve(output, "error-below-actions-check.json"), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
