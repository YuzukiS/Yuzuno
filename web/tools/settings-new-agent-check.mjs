// T-51 PR 1 (T-19's group 1 rows: Settings and New agent), in Chromium on a production build of the app with a
// synthetic Workspace and every API answered here (no Core, no Agent):
// - ST:AG2: Actions → Close agent swaps in its confirmation in place, fading in over small, and Keep agent takes focus.
// - ST:SX-02: New agent's panes keep what was typed across a switch, the New form is never remounted, and the pane
//   switched to fades in over small.
// - ST:SX-14: while the defaults for new Agents are read, the harness and model choices wait with a note, so a late
//   answer never undoes a pick.
// - ST:SX-28: editing a previewed Codex session ID keeps the preview, dimmed and out of reach, until the ID is the
//   one read again.
// - ST:SX-50: Escape with the SSH machine editor open closes the editor, not New agent; New agent closed with it open
//   opens again without it.
// - ST:SX-65: Settings · Home: Restore default with unsaved changes asks first; afterwards focus is on Presentation.
// - ST:SX-105: Settings · Diagnostics: Clear recorded errors asks first; the result shows next to it, with focus.
// - ST:AS2: Agent settings: while the model catalog loads, its note waits in the model chips' row, a chip high, so a
//   one-row catalog moves the model setting not at all.
// Under reduced motion nothing plays. Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes:
// the Home preference saves this check makes and the app's own saves of where an Agent was read; anything else is
// refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/settings-new-agent-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/settings-new-agent");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], unknownGets: [], readingSaves: [], presentationSaves: [], previews: 0, measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const WORKSPACE = "ws-settings-new-agent";
const agent = { id: "a", name: "Mori", status: "idle", goal: "", cwd: "/fixture", model: "m", color: "sage", createdAt: "",
  updatedAt: "1", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex",
  connectionState: "connected" };
const THREAD = "019a1234-5678-4321-aaaa-123456789abc";
const codexPreview = { threadId: THREAD, name: "Fixture session", cwd: "/fixture", preview: "Carry on with the fixture.",
  model: "gpt-fixture", reasoningEffort: "high", turnCount: 12, updatedAt: Date.now() / 1000, existingAgentId: null, warnings: [],
  permissions: { presets: ["ask", "auto", "full", "config"].map((id) => ({ id, available: true })) } };
// The Workspace's defaults: Claude Code for new Agents, so an answer would turn a New agent opened on Codex.
const defaults = {
  saved: { harness: "claude" },
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default", codexModel: null, codexReasoningEffort: null, claudeModel: null },
  effective: {
    harness: { value: "claude", source: "workspace" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
  },
};
// A one-row catalog: the Agent's model and one more.
const catalog = { models: [
  { id: "m", model: "m", displayName: "Model M", isDefault: true },
  { id: "n", model: "n", displayName: "Model N" },
] };
let presentation;
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/agents/a/models": catalog,
  "/api/agent-defaults": defaults,
  "/api/backlog": { observedAt: "2026-11-05T00:00:00Z", agents: {} },
  "/api/models": { models: [] },
  "/api/claude/sessions": { sessions: [], next: null },
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
};
const holding = new Set();
const held = new Map();
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    const answer = (json) => route.fulfill({ json });
    let reply;
    if (method === "GET" && path === "/api/agents/a/reading") reply = () => ({ handoff: null });
    else if (method === "PUT" && path === "/api/agents/a/reading") {
      report.readingSaves.push(path);
      reply = () => ({ accepted: true, sourceSeq: 0 });
    } else if (method === "GET" && path === "/api/home/presentation") reply = () => presentation;
    else if (method === "PUT" && path === "/api/home/presentation") {
      const body = request.postDataJSON();
      report.presentationSaves.push(body);
      reply = () => {
        presentation = { ...presentation, style: body.style, note: body.note, updatedAt: "2026-11-05T05:00:00Z",
          agentText: body.style === "default" && !body.note ? null : `Present results ${body.style === "visual" ? "visually first" : "as the information suits"}.` };
        return presentation;
      };
    } else if (method === "POST" && path === "/api/collaboration/github_repositories") reply = () => ({ repositories: [], links: [] });
    else if (method === "POST" && path === "/api/codex/sessions/preview") {
      report.previews++;
      reply = () => codexPreview;
    } else if (method === "GET") {
      if (gets[path] !== undefined) reply = () => gets[path];
      else {
        if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
        reply = () => ({});
      }
    } else {
      report.writes.push(`${method} ${path}`);
      return route.fulfill({ status: 400, json: { error: "this check writes nothing" } });
    }
    const k = `${method} ${path}`;
    if (holding.has(k)) {
      if (!held.has(k)) held.set(k, []);
      held.get(k).push(() => answer(reply()));
      return;
    }
    return answer(reply());
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
const hold = (method, path) => holding.add(`${method} ${path}`);
async function waiting(method, path) {
  const until = Date.now() + 10_000;
  while (!(held.get(`${method} ${path}`)?.length)) {
    if (Date.now() > until) throw new Error(`no ${method} ${path} came`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function release(method, path) {
  holding.delete(`${method} ${path}`);
  for (const answer of held.get(`${method} ${path}`)?.splice(0) ?? []) await answer();
}

/** In the page from the first script: the event stream, recorded errors to clear, and what plays on an element. */
function pageHelpers() {
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
  if (!sessionStorage.getItem("t51-seeded")) {
    sessionStorage.setItem("t51-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    const at = "2026-11-05T04:00:00.000Z";
    localStorage.setItem("yuzuno.diagnostics.v1", JSON.stringify({ errors: [
      { kind: "error", name: "TypeError", codes: [], summary: "React error #418", where: [], first: at, last: at, count: 1 },
      { kind: "rejection", name: "Error", codes: [], summary: "React error #423", where: [], first: at, last: at, count: 2 },
    ] }));
  }
  /** The animations running or about to run on `el` itself: their properties and duration. */
  window.__plays = (el) => !el ? null : el.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending").map((a) => ({
    props: [...new Set((a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k))
      .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))].sort().join("+"),
    duration: a.effect?.getTiming?.().duration ?? null,
  }));
  window.__focus = () => {
    const el = document.activeElement;
    return !el || el === document.body ? "the page" : `${el.tagName.toLowerCase()}: ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60)}`;
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
/** One fade over small, opacity only; under reduced motion, nothing. */
const fadedSmall = (plays, reduced) => Array.isArray(plays) && (reduced ? plays.length === 0
  : plays.length === 1 && plays[0].props === "opacity" && plays[0].duration === 180);
/** A reveal over small, its height and opacity; under reduced motion, nothing. */
const revealedSmall = (plays, reduced) => Array.isArray(plays) && (reduced ? plays.length === 0
  : plays.length === 1 && plays[0].props === "height+opacity" && plays[0].duration === 180);
const near = (a, b, tolerance = 0.5) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tolerance;

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, still) => (reduced ? still : normal);
  presentation = { style: "visual", note: "Charts first", updatedAt: "2026-11-04T00:00:00Z", scope: "workspace",
    agentText: "Present results visually first. Charts first" };
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("http://yuzuno-t51-settings.test/**", serve);
  await page.addInitScript(pageHelpers);
  const measured = (report.measured[tag] = {});
  const dialog = page.getByRole("dialog");
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const focus = () => page.evaluate(() => window.__focus());
  const toList = async () => {
    if (run.phone && !(await page.locator(".app.phone-list").count()) && (await page.locator(".phone-back").count()))
      await page.locator(".phone-back").click();
  };
  const rowMenu = async (item) => {
    await toList();
    await page.getByRole("button", { name: "Actions for Mori", exact: true }).first().click();
    await page.locator('[role="menu"]').getByRole("menuitem", { name: item, exact: true }).click();
    await dialog.waitFor();
  };
  const closeDialog = async () => {
    if (await dialog.count()) await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  };
  const openNewAgent = async () => {
    await toList();
    await page.locator(".add-agent").first().click();
    await dialog.getByRole("button", { name: "New agent", exact: true }).waitFor();
  };
  const openEditor = async (query, title, editor) => {
    if (!(await page.locator(".settings-search input").isVisible().catch(() => false))) {
      await toList();
      await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    await page.locator(".settings-search input").fill(query);
    const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
    await card.locator("button").click({ timeout: 10_000 });
    await page.locator(`#settings-editor-${editor}`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  try {
    await page.goto("http://yuzuno-t51-settings.test/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });

    // ---- ST:AG2: Actions → Close agent.
    {
      let swapped = null;
      try {
        await rowMenu("Manage…");
        await dialog.getByRole("button", { name: /^Close agent/ }).first().click();
        swapped = await page.evaluate(() => {
          const step = document.querySelector('[role="dialog"] .agent-action-explanation')?.parentElement;
          return { plays: window.__plays(step), focus: window.__focus(), confirm: !!step };
        });
        await frames();
        swapped.focusAfter = await focus();
      } catch (error) {
        swapped = { error: String(error).slice(0, 200) };
      }
      measured.ag2 = swapped;
      ok(`${tag}: Actions → Close agent swaps in its confirmation ${motion("fading in over small, opacity only", "with nothing playing")}, and Keep agent takes focus`,
        !!swapped?.confirm && fadedSmall(swapped.plays, reduced) && swapped.focusAfter === "button: Keep agent", swapped);
      await closeDialog();
    }

    // ---- ST:SX-14: the defaults for new Agents, held until they are read.
    {
      let reading = null;
      let read = null;
      try {
        hold("GET", "/api/agent-defaults");
        await openNewAgent();
        await waiting("GET", "/api/agent-defaults");
        await frames();
        const state = () => page.evaluate(() => {
          const box = document.querySelector('[role="dialog"]');
          const radios = (name) => [...box.querySelectorAll(`input[name="${name}"]`)];
          return {
            // Off as their fieldset is: `:disabled`, which the radios' own `disabled` does not say.
            harnessOff: radios("create-harness").length > 0 && radios("create-harness").every((r) => r.matches(":disabled")),
            modelOff: radios("create-model").length > 0 && radios("create-model").every((r) => r.matches(":disabled")),
            harness: radios("create-harness").find((r) => r.checked)?.value ?? null,
            note: [...box.querySelectorAll('[role="status"]')].some((p) => p.textContent.trim() === "Reading the defaults for new Agents…"),
          };
        });
        reading = await state();
        await release("GET", "/api/agent-defaults");
        await page.waitForTimeout(200);
        await frames();
        read = await state();
      } catch (error) {
        reading = { error: String(error).slice(0, 200) };
        await release("GET", "/api/agent-defaults").catch(() => {});
      }
      measured.sx14 = { reading, read };
      ok(`${tag}: while the defaults for new Agents are read, the harness and model choices wait with a note; read, they are on and the harness is the Workspace's default, Claude Code`,
        reading?.harnessOff === true && reading.modelOff === true && reading.note === true
        && read?.harnessOff === false && read.note === false && read.harness === "claude", measured.sx14);
    }

    // ---- ST:SX-02: switching panes (New agent is open from SX-14).
    {
      let codex = null;
      let back = null;
      let again = null;
      try {
        await page.evaluate(() => { document.querySelector('[role="dialog"] form.remote-create').__t51 = "kept"; });
        await dialog.getByRole("button", { name: "Existing Codex session", exact: true }).click();
        codex = await page.evaluate(() => ({ plays: window.__plays(document.querySelector('[role="dialog"] .session-import')?.parentElement) }));
        await dialog.getByLabel("Codex session ID").fill(THREAD);
        await dialog.getByRole("button", { name: "Preview session", exact: true }).click();
        await dialog.locator(".session-preview").waitFor({ timeout: 5000 });
        await page.waitForTimeout(250);
        await dialog.getByRole("button", { name: "New agent", exact: true }).click();
        back = await page.evaluate(() => {
          const form = document.querySelector('[role="dialog"] form.remote-create');
          return { plays: window.__plays(form?.parentElement), same: form?.__t51 === "kept" };
        });
        await page.waitForTimeout(250);
        await dialog.getByRole("button", { name: "Existing Codex session", exact: true }).click();
        await frames();
        again = await page.evaluate(() => ({
          id: document.querySelector('[role="dialog"] #import-session-id')?.value ?? null,
          preview: !!document.querySelector('[role="dialog"] .session-preview'),
        }));
      } catch (error) {
        codex = { error: String(error).slice(0, 200) };
      }
      measured.sx02 = { codex, back, again, previews: report.previews };
      ok(`${tag}: New agent → Existing Codex session and back: the pane switched to ${motion("fades in over small, opacity only", "shows with nothing playing")}`,
        fadedSmall(codex?.plays, reduced) && fadedSmall(back?.plays, reduced), measured.sx02);
      ok(`${tag}: across the switches the New form stays the same element, and the session ID typed and previewed there are kept, read once`,
        back?.same === true && again?.id === THREAD && again.preview === true && report.previews === 1, measured.sx02);
      report.previews = 0;
    }

    // ---- ST:SX-28: the preview, its ID edited (Existing Codex is shown).
    {
      let before = null;
      let edited = null;
      let restored = null;
      try {
        const state = () => page.evaluate(() => {
          const section = document.querySelector('[role="dialog"] .session-preview');
          // The preview and its fields; the form's actions row is not part of it (R2 70ad905d).
          const part = section?.closest(".session-preview-body");
          const nameInput = part ? [...part.querySelectorAll("input")].find((i) => i.closest("label")?.textContent.includes("Agent name")) : null;
          const buttons = [...(section?.closest("form")?.querySelectorAll(".modal-actions button") ?? [])];
          const cancel = buttons.find((b) => b.textContent.trim() === "Cancel");
          const add = buttons.find((b) => b.textContent.trim() === "Add to workspace");
          // Chromium keeps focus out of an inert subtree: Cancel taking focus says it is in reach.
          const was = document.activeElement;
          cancel?.focus();
          const reach = { cancel: !!cancel && document.activeElement === cancel && !cancel.disabled, addDisabled: add?.disabled ?? null };
          if (was instanceof HTMLElement) was.focus();
          return { preview: !!section, stale: part?.hasAttribute("data-stale") ?? null, inert: part?.inert ?? null,
            opacity: part ? getComputedStyle(part).opacity : null, name: nameInput?.value ?? null, ...reach };
        });
        const name = dialog.getByLabel("Agent name", { exact: true });
        await name.fill("Kept name");
        await frames();
        before = await state();
        const id = dialog.getByLabel("Codex session ID");
        await id.click();
        await page.keyboard.press("End");
        await page.keyboard.type("x");
        await frames();
        edited = await state();
        await id.click();
        await page.keyboard.press("End");
        await page.keyboard.press("Backspace");
        await frames();
        restored = await state();
      } catch (error) {
        edited = { error: String(error).slice(0, 200) };
      }
      measured.sx28 = { before, edited, restored };
      ok(`${tag}: editing a previewed session ID keeps the preview, dimmed and out of reach with its name, until the ID is the one read again; Cancel stays in reach and only Add waits`,
        edited?.preview === true && edited.stale === true && edited.inert === true && edited.opacity === "0.55" && edited.name === "Kept name"
        && edited.cancel === true && edited.addDisabled === true
        && restored?.preview === true && restored.stale === false && restored.inert === false && restored.name === "Kept name"
        && restored.cancel === true && typeof before?.addDisabled === "boolean" && restored.addDisabled === before.addDisabled, measured.sx28);
    }

    // ---- ST:SX-50: the SSH machine editor and Escape.
    {
      let escaped = null;
      let reopened = null;
      try {
        await dialog.getByRole("button", { name: "New agent", exact: true }).click();
        await page.waitForTimeout(250);
        const add = dialog.getByRole("button", { name: "Add SSH machine" });
        await add.click();
        await dialog.locator("#new-ssh-machine").waitFor({ timeout: 5000 });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        await frames();
        escaped = { dialog: (await dialog.count()) === 1, editor: await page.locator("#new-ssh-machine").count(), focus: await focus() };
        if (escaped.dialog) {
          await add.click();
          await dialog.locator("#new-ssh-machine").waitFor({ timeout: 5000 });
          await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
        }
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        await page.waitForTimeout(300);
        await openNewAgent();
        await frames();
        reopened = { editor: await page.locator("#new-ssh-machine").count() };
      } catch (error) {
        escaped = { ...(escaped ?? {}), error: String(error).slice(0, 200) };
      }
      measured.sx50 = { escaped, reopened };
      ok(`${tag}: Escape with the SSH machine editor open closes the editor and not New agent, and focus is back on Add SSH machine`,
        escaped?.dialog === true && escaped.editor === 0 && escaped.focus === "button: Add SSH machine", measured.sx50);
      ok(`${tag}: New agent closed with the machine editor open opens again without it`, reopened?.editor === 0, measured.sx50);
      await closeDialog();
    }

    // ---- ST:AS2: Agent settings, the model catalog held.
    {
      let loading = null;
      let loaded = null;
      try {
        hold("GET", "/api/agents/a/models");
        await rowMenu("Agent settings…");
        await waiting("GET", "/api/agents/a/models");
        // The dialog's own entrance (a rise over medium) ends first: it moves everything in it.
        await page.evaluate(() => Promise.all((document.querySelector(".modal")?.getAnimations() ?? []).map((a) => a.finished)));
        await frames();
        const state = () => page.evaluate(() => {
          const box = document.querySelector('[role="dialog"]');
          const radio = box.querySelector('input[name="agent-model"]');
          const setting = radio?.closest(".agent-setting");
          const r = setting?.getBoundingClientRect();
          const status = box.querySelector(".choice-chip-row > .choice-chip-status");
          return { top: r ? r.top : null, height: r ? r.height : null, chips: box.querySelectorAll('input[name="agent-model"]').length,
            statusInRow: !!status && status.closest(".agent-setting") === setting, statusHeight: status ? status.getBoundingClientRect().height : null,
            rows: setting ? new Set([...setting.querySelectorAll(".choice-chip-row > *")].map((c) => Math.round(c.getBoundingClientRect().top))).size : null };
        });
        loading = await state();
        await release("GET", "/api/agents/a/models");
        await page.waitForTimeout(250);
        await frames();
        loaded = await state();
      } catch (error) {
        loading = { ...(loading ?? {}), error: String(error).slice(0, 200) };
        await release("GET", "/api/agents/a/models").catch(() => {});
      }
      measured.as2 = { loading, loaded };
      ok(`${tag}: while the model catalog loads, its note waits in the model chips' row a chip high, and the one-row catalog arriving moves the model setting not at all`,
        loading?.statusInRow === true && near(loading.statusHeight, 32, 1) && loading.rows === 1
        && loaded?.chips === 2 && loaded.rows === 1 && near(loaded.top, loading.top) && near(loaded.height, loading.height), measured.as2);
      await closeDialog();
    }

    // ---- ST:SX-65: Settings · Home.
    {
      const box = "#settings-editor-home";
      let asked = null;
      let kept = null;
      let confirmed = null;
      let atOnce = null;
      try {
        await openEditor("home presentation", "Home presentation", "home");
        const note = page.locator(`${box} textarea`);
        await note.fill("Charts first, please");
        const restore = page.locator(box).getByRole("button", { name: "Restore default", exact: true }).first();
        await restore.click();
        asked = await page.evaluate((box) => {
          const confirm = document.querySelector(`${box} .settings-confirm`);
          return { confirm: !!confirm, plays: window.__plays(confirm?.parentElement), focus: document.activeElement === confirm };
        }, box);
        asked.saves = report.presentationSaves.length;
        await page.waitForTimeout(250);
        await page.locator(`${box} .settings-confirm`).getByRole("button", { name: "Keep editing", exact: true }).click();
        await frames();
        kept = { confirm: await page.locator(`${box} .settings-confirm`).count(), note: await note.inputValue(), focus: await focus(),
          saves: report.presentationSaves.length };
        await restore.click();
        await page.locator(`${box} .settings-confirm`).getByRole("button", { name: "Restore default", exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.matches?.('select[aria-label="Home presentation"]'), null, { timeout: 3000 }).catch(() => {});
        confirmed = { saves: report.presentationSaves.slice(), focus: await focus() };
        // Saved visual again, with nothing unsaved: Restore default restores at once.
        await page.locator(`${box} select`).selectOption("visual");
        await page.locator(box).getByRole("button", { name: "Save Home preference", exact: true }).click();
        await page.locator(box).getByRole("button", { name: "Restore default", exact: true }).waitFor({ timeout: 3000 });
        await page.waitForTimeout(200);
        const before = report.presentationSaves.length;
        await page.locator(box).getByRole("button", { name: "Restore default", exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.matches?.('select[aria-label="Home presentation"]'), null, { timeout: 3000 }).catch(() => {});
        atOnce = { confirm: await page.locator(`${box} .settings-confirm`).count(), saves: report.presentationSaves.slice(before), focus: await focus() };
      } catch (error) {
        asked = { ...(asked ?? {}), error: String(error).slice(0, 200) };
      }
      measured.sx65 = { asked, kept, confirmed, atOnce };
      ok(`${tag}: Restore default with an unsaved note asks first below the actions, ${motion("revealed over small", "shown at once")}, the question taking focus, and saves nothing`,
        asked?.confirm === true && revealedSmall(asked.plays, reduced) && asked.focus === true && asked.saves === 0, measured.sx65);
      ok(`${tag}: Keep editing keeps the note as typed and gives focus back to Restore default`,
        kept?.confirm === 0 && kept.note === "Charts first, please" && kept.focus === "button: Restore default" && kept.saves === 0, measured.sx65);
      ok(`${tag}: confirmed, Home's preference is saved as the default once and focus is on Presentation`,
        confirmed?.saves.length === 1 && confirmed.saves[0].style === "default" && confirmed.saves[0].note === "" && confirmed.focus === "select: Home presentation", measured.sx65);
      ok(`${tag}: with nothing unsaved, Restore default saves at once, without asking, and focus is on Presentation`,
        atOnce?.confirm === 0 && atOnce.saves.length === 1 && atOnce.saves[0].style === "default" && atOnce.focus === "select: Home presentation", measured.sx65);
      report.presentationSaves = [];
    }

    // ---- ST:SX-105: Settings · Diagnostics, two errors recorded.
    {
      const box = "#settings-editor-diagnostics";
      let asked = null;
      let keptErrors = null;
      let cleared = null;
      const recorded = () => page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.diagnostics.v1") || '{"errors":[]}').errors.length);
      try {
        await openEditor("diagnostics", "Copy diagnostics", "diagnostics");
        const clear = page.locator(box).getByRole("button", { name: "Clear recorded errors", exact: true });
        await clear.click();
        asked = await page.evaluate((box) => {
          const confirm = document.querySelector(`${box} .settings-confirm`);
          return { confirm: !!confirm, plays: window.__plays(confirm?.parentElement), focus: document.activeElement === confirm };
        }, box);
        asked.errors = await recorded();
        await page.waitForTimeout(250);
        await page.locator(`${box} .settings-confirm`).getByRole("button", { name: "Keep them", exact: true }).click();
        await frames();
        keptErrors = { confirm: await page.locator(`${box} .settings-confirm`).count(), errors: await recorded(), focus: await focus() };
        await clear.click();
        await page.locator(`${box} .settings-confirm`).getByRole("button", { name: "Clear them", exact: true }).click();
        await frames();
        cleared = await page.evaluate((box) => {
          const button = [...document.querySelectorAll(`${box} button`)].find((b) => b.textContent.trim() === "Clear recorded errors");
          const status = [...document.querySelectorAll(`${box} .diagnostics-clear [role="status"]`)].find((p) => p.textContent.startsWith("Cleared"));
          const b = button?.getBoundingClientRect();
          const s = status?.getBoundingClientRect();
          return { text: status?.textContent ?? null, focus: !!status && document.activeElement === status,
            next: !!b && !!s && s.top >= b.bottom - 0.5 && s.top - b.bottom <= 24 };
        }, box);
        cleared.errors = await recorded();
      } catch (error) {
        asked = { ...(asked ?? {}), error: String(error).slice(0, 200) };
      }
      measured.sx105 = { asked, keptErrors, cleared };
      ok(`${tag}: Clear recorded errors asks first, ${motion("revealed over small", "shown at once")}, the question taking focus; Keep them clears nothing and gives focus back to it`,
        asked?.confirm === true && revealedSmall(asked.plays, reduced) && asked.focus === true && asked.errors === 2
        && keptErrors?.confirm === 0 && keptErrors.errors === 2 && keptErrors.focus === "button: Clear recorded errors", measured.sx105);
      ok(`${tag}: Clear them clears both errors, and the result shows next to the button with focus`,
        cleared?.errors === 0 && cleared.text?.startsWith("Cleared 2 recorded errors") && cleared.focus === true && cleared.next === true, measured.sx105);
    }
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("writes: none but the Home preference saves this check made and the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "settings-new-agent-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
