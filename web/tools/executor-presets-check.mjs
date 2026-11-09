// YN-23: Settings → Executor templates in Chromium, with every API answered
// here (no Core, no CLI, no daily configuration). The eleven presets come from
// Core's own presets.json, resolved as Core serves them. In English and
// Chinese, light and dark, at 1280 px and at a 390 px phone: Add presets
// shows them in the page's language, two are added as unsaved templates,
// and each template card (delivery cards, steps) fits its width. Once, in
// English: a step its delivery can't have is marked at its row and holds the
// page's save bar, and its Save sends the presets' fields as one whole list
// against the version read. YN-70: each preset's card names its kind of work,
// and a template made from it keeps that tier, shown as its Kind of work.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-presets-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-23, YN-70", checks: [], shots: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-presets.test";

// As Core serves them (executor_templates.rs `presets`): one entry per preset and language.
const source = JSON.parse(await readFile(fileURLToPath(new URL("../../core/src/executor_templates/presets.json", import.meta.url)), "utf8"));
const presets = source.presets.flatMap((p) => ["en", "zh-Hans"].map((language) => ({
  id: p.id, language, label: p[language].label, whenToChoose: p[language].whenToChoose, modelHint: p[language].modelHint,
  instructions: p[language].instructions, deliveryMode: p.deliveryMode,
  ...(p.steps ? { steps: p.steps.map(({ label, ...step }) => (label ? { ...step, label: label[language] } : step)) } : {}),
  ...(p.permissionLevel ? { permissionLevel: p.permissionLevel } : {}),
  ...(p.tier ? { tier: p.tier } : {}),
})));
assert.equal(presets.length, 22);

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const initial = { version: 3, templates: [{ id: "dev", label: "Development (PR)", harness: "codex", instructions: "Freeze the head, then start the review." }] };
let saved = initial;
const view = () => ({ workspace: saved, available: saved.templates.map((template) => ({ template, source: "workspace" })), presets,
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false,
  general: { label: "Executor", harness: "codex", harnessSource: "builtin" },
  // YN-24: who last changed each template, when and why.
  lastModified: Object.fromEntries(saved.templates.filter((t) => t.id === "dev").map((t) => [t.id,
    { version: 3, at: "2026-11-07T20:30:00Z", reason: "Say how to test before review", by: { kind: "agent", id: "lead", name: "Dev Lead" } }])),
  appliesTo: "Dispatches from a template from now on; executors already created keep their own settings." });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function contextFor({ language, theme, phone }) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: phone ? 2 : 1, locale: language === "en" ? "en-US" : "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce",
  });
  await context.addInitScript(({ language, theme }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
  }, { language, theme });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/executor-templates" && method === "PUT") {
      const body = JSON.parse(request.postData() || "{}");
      report.writes.push({ method, path, body });
      if (body.expectedVersion !== saved.version) return route.fulfill({ status: 400, json: { error: "version_conflict: these executor templates changed; reload before saving" } });
      saved = { version: saved.version + 1, templates: body.templates };
      return route.fulfill({ json: view() });
    }
    if (method !== "GET") {
      report.writes.push({ method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-executor-presets" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
      "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/executor-templates": view(),
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  return context;
}

const words = {
  en: { settings: "Settings and updates", search: "executor", card: "Executor templates", addPresets: "Add presets", add2: "Add 2 presets",
    first: "Design", second: "Read-only investigation", strongWork: "Strong work · ", tier: "Kind of work" },
  "zh-Hans": { settings: "设置与更新", search: "执行者", card: "执行者模板", addPresets: "添加预设", add2: "添加 2 个预设",
    first: "设计", second: "只读调查", strongWork: "强活 · ", tier: "哪种活" },
};
async function openEditor(page, w) {
  const search = page.locator(".settings-search input");
  if (!(await search.isVisible())) {
    await page.locator(`button[aria-label="${w.settings}"]`).first().click({ timeout: 10_000 });
    await search.waitFor({ timeout: 10_000 });
  }
  await search.fill(w.search);
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: w.card }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator("#settings-editor-executor-templates");
  await box.waitFor({ timeout: 10_000 });
  return box;
}
// Whether the editor, and each control in it, fits its own width.
const fits = (box) => box.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input:not([type=radio]):not([type=checkbox]), select, textarea, button")]
    .filter((c) => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
    .map((c) => c.getAttribute("aria-label") || c.textContent),
}));
const shot = async (page, target, name) => {
  const path = join(output, `${name}.png`);
  await target.screenshot({ path });
  report.shots.push(name);
};

try {
  for (const language of ["en", "zh-Hans"]) {
    for (const theme of ["light", "dark"]) {
      for (const phone of [false, true]) {
        saved = initial;
        const w = words[language];
        const tag = `${language === "en" ? "en" : "zh"}-${theme}-${phone ? "phone" : "desktop"}`;
        const context = await contextFor({ language, theme, phone });
        const page = await context.newPage();
        page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
        await page.goto(`https://${HOST}/`);
        const box = await openEditor(page, w);
        // The templates are a list, each with a page of its own (YN-8 S5b).
        const rowAt = (n) => box.locator(".executor-template-row").nth(n);
        const openAt = async (n) => {
          await rowAt(n).click();
          await box.locator(".executor-template").waitFor({ timeout: 10_000 });
          return box.locator(".executor-template");
        };
        const back = async () => {
          await box.locator(".settings-crumb").click();
          await box.locator(".executor-template").waitFor({ state: "detached", timeout: 10_000 });
        };
        await rowAt(0).waitFor({ timeout: 10_000 });
        assert.equal(await box.getAttribute("lang"), language === "en" ? "en" : "zh-Hans");
        await box.getByRole("button", { name: w.addPresets }).click();
        const picker = box.locator(".executor-presets");
        await picker.waitFor({ timeout: 10_000 });
        const names = await picker.locator(".executor-preset-choice .theme-choice-name").allTextContents();
        assert.deepEqual(names.map((n) => n.trim()), presets.filter((p) => p.language === language).map((p) => p.label), `${tag}: the eleven, in the page's language`);
        // A preset's card by its own name: "Design" is also in "Build from an approved design".
        const choice = (label) => picker.locator(".executor-preset-choice").filter({ has: page.locator(".theme-choice-name", { hasText: new RegExp(`^\\s*${label}\\s*$`) }) });
        assert.ok((await choice(w.first).locator(".executor-preset-meta").first().textContent()).startsWith(w.strongWork), `${tag}: the design preset says its kind of work`);
        assert.deepEqual(await fits(box), { box: true, wider: [] }, `${tag}: the picker fits`);
        await shot(page, picker, `${tag}-1-presets`);
        await choice(w.first).click();
        await choice(w.second).click();
        await box.getByRole("button", { name: w.add2 }).click();
        await rowAt(2).waitFor({ timeout: 10_000 });
        assert.equal(await box.locator(".executor-presets").count(), 0, `${tag}: the picker closes`);
        assert.deepEqual(await fits(box), { box: true, wider: [] }, `${tag}: the list fits`);
        await shot(page, box.locator(".executor-template-list"), `${tag}-2-list`);
        const design = await openAt(1);
        assert.equal(await design.locator('input[aria-label]').first().inputValue(), w.first);
        assert.equal(await design.locator(".executor-step").count(), 4, `${tag}: the design's four steps, up to its approval`);
        assert.equal(await design.locator('.executor-delivery-choice input[value="none"]').isChecked(), true);
        assert.equal(await design.locator(`select[aria-label="${w.tier}"]`).inputValue(), "strong", `${tag}: its Kind of work, the preset's`);
        assert.deepEqual(await fits(box), { box: true, wider: [] }, `${tag}: the template's page fits`);
        await shot(page, design, `${tag}-2-design`);
        await design.locator(`select[aria-label="${w.tier}"]`).scrollIntoViewIfNeeded();
        await shot(page, design.locator(".executor-template-runs"), `${tag}-2-design-kind-of-work`);
        await back();
        const dev = await openAt(0);
        assert.match(await box.locator(".executor-template-changed").textContent(), language === "en"
          ? /^Last changed: Dev Lead · .+ · Say how to test before review$/ : /^上次修改：Dev Lead · .+ · Say how to test before review$/, `${tag}: its last change`);
        await shot(page, dev, `${tag}-3-saved-template`);
        check(`${tag}: the eleven presets in the page's language, each card with its kind of work; two added as unsaved templates, the design's tier as its Kind of work; the list and each template's page fit their width`);

        if (tag === "en-light-desktop") {
          // A step its delivery can't have, marked at its row; then the presets' fields saved as one list.
          await back();
          const investigation = await openAt(2);
          assert.equal(await investigation.locator('.executor-delivery-choice input[value="none"]').isChecked(), true);
          assert.equal(await investigation.locator(".executor-step").count(), 3);
          assert.equal(await investigation.locator(".executor-step-error").count(), 0, "its own steps fit no repository change");
          await investigation.getByRole("button", { name: "Add a step" }).click();
          await investigation.locator('select[aria-label="Step 4: kind"]').selectOption("merge");
          await investigation.locator(".executor-step-error").waitFor({ timeout: 5_000 });
          // Settings › Executors' one save bar (YN-8 S5): held while a step can't be saved.
          const bar = page.locator(".settings-savebar:not([hidden])");
          const barSave = bar.getByRole("button", { name: "Save", exact: true });
          await barSave.waitFor({ timeout: 10_000 });
          assert.equal(await box.getByRole("button", { name: "Save templates" }).count(), 0, "no Save of its own on the page");
          assert.equal(await barSave.isDisabled(), true, "nothing invalid is saved");
          await shot(page, investigation, `${tag}-4-refused-step`);
          await investigation.getByRole("button", { name: "Remove step 4" }).click();
          await bar.locator("button:enabled", { hasText: "Save" }).first().waitFor({ timeout: 5_000 }); // re-rendered: the step is gone
          assert.deepEqual(report.writes, [], "nothing is written before Save");
          await shot(page, bar, `${tag}-5-save-bar`);
          await barSave.click();
          await box.getByText("Saved.").waitFor({ timeout: 10_000 });
          const body = report.writes[0].body;
          const want = (id) => presets.find((p) => p.id === id && p.language === "en");
          assert.equal(body.expectedVersion, 3);
          assert.deepEqual(body.templates.map((t) => t.id), ["dev", "design", "investigation"]);
          const [, d, i] = body.templates;
          // As presets make them since YN-56: following routing, no harness; with their tier (YN-70).
          assert.deepEqual({ ...d }, { id: "design", label: "Design", instructions: want("design").instructions,
            deliveryMode: "none", steps: want("design").steps, whenToChoose: want("design").whenToChoose, tier: "strong" });
          assert.deepEqual({ ...i }, { id: "investigation", label: "Read-only investigation", instructions: want("investigation").instructions,
            deliveryMode: "none", steps: want("investigation").steps, whenToChoose: want("investigation").whenToChoose, tier: "strong" });
          check("en: a refused step marked at its row; Save sends the presets' fields as the whole list against version 3", { templates: body.templates.map((t) => t.id) });
        }
        await context.close();
      }
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), ["PUT /api/executor-templates"], "one save, nothing else written");
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
