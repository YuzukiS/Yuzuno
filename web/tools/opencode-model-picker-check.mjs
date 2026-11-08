// YN-47, an OpenCode Agent's model list (the user's choice A, design/yn47-model-picker) in Chromium on a production
// build of the app, with no Core: the reads this check knows are answered here; any other gets {} and is listed in the
// report (unknownGets). Mori is a connected OpenCode Agent whose OpenCode lists LM Studio's and its own free models
// until it is logged in to DeepSeek here, with a synthetic key. Four runs: desktop 1280×860 and phone 390×844, each
// in English and Chinese, dark and light. In each:
// - the list sits inside the dialog, nothing in it wider than the dialog, every row at least 44 px high;
// - before the login it points to the login below; after it, DeepSeek's group comes first, logged in, read again
//   with no reload, and its model's variants are offered once it is chosen;
// - a search keeps the rows it matches; a `provider/model` OpenCode doesn't list says where to add it;
// - desktop: the list scrolls in its own box, the provider of the rows in view stays at its top;
//   phone: the list doesn't scroll on its own, and the search stays in view while the dialog scrolls.
// Writes: none but the key login and the app's own saves of where an Agent was read. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/opencode-model-picker-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/opencode-model-picker-check");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], logins: [], measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const KEY = "fixture-picker-key-9Tn";
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "", color: "green", status: "idle", createdAt: "",
  updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "opencode", connectionState: "connected",
  settings: null };
const turn = { id: "t1", status: "completed", items: [
  { id: "t1-ask", type: "userMessage", content: [{ type: "text", text: "Start" }] },
  { id: "t1-reply", type: "agentMessage", text: "Started." },
] };
const model = (provider, providerName, id, name, extra = {}) => ({ id: `${provider}/${id}`, model: `${provider}/${id}`,
  displayName: `${providerName} · ${name}`, description: null, variants: [], providerId: provider, providerName, name, status: "active",
  context: 131072, image: false, ...extra });
const free = ["Beam Free", "Big Pickle", "DeepSeek V4.1 Flash Free", "Flint 40B Free", "GLM-5.3-Flash Free", "MiMo-V2.6-Flash Free",
  "Nemotron 3.5 Lightning Free", "Nemotron 3.5 Super VL Free"].map((name) => model("opencode", "OpenCode", name.toLowerCase().replaceAll(" ", "-"), name,
  name === "Big Pickle" ? { status: "beta" } : {}));
const local = ["GPT OSS 20B", "Qwen3 30B A3B 2507", "Qwen3 Coder 30B", "Qwen3.8 27B (LM Studio)"].map((name) =>
  model("lmstudio", "LMStudio", name.toLowerCase().replace(/[^a-z0-9.]+/g, "-"), name));
const deepseek = [
  model("deepseek", "DeepSeek", "deepseek-flash", "DeepSeek V4.1 Flash 1017", { context: 1048576, image: true, variants: ["none", "low", "high", "max"] }),
  model("deepseek", "DeepSeek", "deepseek-v4-pro", "DeepSeek V4 Pro", { context: 1048576, variants: ["none", "low", "high", "max"] }),
];
let loggedIn;
const catalog = () => ({
  models: [...(loggedIn ? deepseek : []), ...local, ...free],
  providers: [...(loggedIn ? [{ id: "deepseek", name: "DeepSeek", source: "credential" }] : []),
    { id: "lmstudio", name: "LMStudio", source: "ready" }, { id: "opencode", name: "OpenCode", source: "ready" }],
  // What OpenCode would use with none chosen (YN-48's `default`): its newest enabled model, here a free one.
  default: free[3],
  opencode: { version: "2.2.5", verified: "2.2.5" },
});
const login = () => ({ state: "ready", reason: null, version: "2.2.5", integrations: [
  { id: "deepseek", name: "DeepSeek", methods: [{ kind: "key", id: null, label: "Manually enter API Key", fields: [], names: [] },
    { kind: "env", id: null, label: "", fields: [], names: ["DEEPSEEK_API_KEY"] }],
    connections: loggedIn ? [{ kind: "credential", id: "crd_1", label: "DeepSeek", method: "key", needsAuth: null }] : [] },
] });
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": { agents: {} }, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [turn] },
  "/api/agents/a/models": catalog(),
  "/api/agents/a/opencode/login": login(),
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
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && path === "/api/agents/a/reading") return route.fulfill({ json: { accepted: true } });
      if (request.method() === "POST" && path === "/api/agents/a/opencode/login/key") {
        report.logins.push({ path, url: request.url(), body: request.postDataJSON() });
        loggedIn = true;
        return route.fulfill({ json: login() });
      }
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
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

const words = {
  en: { model: "Model", search: "Search", logged: "Logged in", hint: "Log in to a provider below", key: "Log in with an API key", logIn: "Log in",
    unlisted: "Add deepseek-v9 to provider.deepseek.models", variant: "Variant" },
  "zh-Hans": { model: "模型", search: "搜索", logged: "已登录", hint: "在下面登录一个提供方", key: "用 API key 登录", logIn: "登录",
    unlisted: "provider.deepseek.models 里加上 deepseek-v9", variant: "变体" },
};
const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop-en-dark", viewport: { width: 1280, height: 860 }, language: "en", theme: "dark" },
  { name: "desktop-zh-light", viewport: { width: 1280, height: 860 }, language: "zh-Hans", theme: "light" },
  { name: "phone-zh-dark", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans", theme: "dark" },
  { name: "phone-en-light", viewport: { width: 390, height: 844 }, phone: true, language: "en", theme: "light" },
];
for (const run of runs) {
  const tag = run.name;
  const w = words[run.language];
  const context = await browser.newContext({ viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: 2 });
  try {
    loggedIn = false;
    report.logins = [];
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(({ language, theme }) => {
      window.EventSource = class { constructor() {} addEventListener() {} close() {} };
      localStorage.clear();
      localStorage.setItem("yuzuno.selected.fixture", JSON.stringify("a"));
      localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme }));
    }, { language: run.language, theme: run.theme });
    await page.goto("http://127.0.0.1:4326/");
    if (run.phone && !(await page.locator('[data-turn-id="t1"]').count()))
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click({ timeout: 5000 }).catch(() => {});
    await page.locator('[data-turn-id="t1"]').waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".agent-settings-button").click();
    const dialog = page.getByRole("dialog");
    const picker = dialog.locator(".opencode-model-picker");
    const list = picker.locator(`[role="radiogroup"][aria-label="${w.model}"]`);
    await list.locator('input[value="opencode/beam-free"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(300);

    // Inside the dialog, nothing wider than it, every row at least 44 px high.
    const fit = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      const frame = modal.getBoundingClientRect();
      const wide = [...modal.querySelectorAll(".opencode-model-picker *")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < frame.left - 1 || r.right > frame.right + 1);
      }).map((el) => el.className || el.tagName).slice(0, 5);
      const rows = [...modal.querySelectorAll(".opencode-model-row")].map((el) => Math.round(el.getBoundingClientRect().height));
      return { wide, scrollsSideways: modal.scrollWidth > modal.clientWidth + 1, shortest: Math.min(...rows), rows: rows.length };
    });
    report.measures[`${tag}: fit`] = fit;
    ok(`${tag}: the list sits in the dialog, nothing wider, every row at least 44 px`,
      fit.wide.length === 0 && !fit.scrollsSideways && fit.shortest >= 44 && fit.rows === 13, fit);
    ok(`${tag}: with nothing logged in, the login below is pointed to`,
      (await picker.locator(".opencode-model-login-hint").textContent() || "").includes(w.hint));

    // Desktop: the list scrolls in its own box, its rows' provider at its top. Phone: the dialog's scroll, the search kept in view.
    if (!run.phone) {
      const box = await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        const head = [...el.querySelectorAll(".opencode-model-group-head")].at(-1).getBoundingClientRect();
        return { client: el.clientHeight, scroll: el.scrollHeight, headTop: Math.round(head.top - el.getBoundingClientRect().top) };
      });
      report.measures[`${tag}: list box`] = box;
      ok(`${tag}: the list scrolls in its own box, the provider of the rows in view at its top`,
        box.client <= 342 && box.scroll > box.client && box.headTop >= 0 && box.headTop <= 2, box);
      await list.evaluate((el) => { el.scrollTop = 0; });
    } else {
      const kept = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        const listed = modal.querySelector(".opencode-model-list");
        const search = modal.querySelector(".opencode-model-search");
        const last = [...modal.querySelectorAll(".opencode-model-group-head")].at(-1);
        // Toward the last provider's rows, as far as the dialog scrolls.
        modal.scrollTop += last.getBoundingClientRect().top - modal.getBoundingClientRect().top + 150;
        const after = search.getBoundingClientRect().top - modal.getBoundingClientRect().top;
        // Under the search, the provider names begin at once: the first one reaching below it starts at or above its
        // bottom (stuck there, or pushed up under it by the next group), and no two names overlap.
        const bottom = search.getBoundingClientRect().bottom;
        const heads = [...modal.querySelectorAll(".opencode-model-group-head")].map((h) => h.getBoundingClientRect());
        const first = heads.find((h) => h.bottom > bottom + 1);
        const overlap = heads.some((h, i) => i > 0 && h.top < heads[i - 1].bottom - 1);
        return { own: getComputedStyle(listed).overflowY, after: Math.round(after), scrolled: modal.scrollTop,
          gap: first ? Math.round(first.top - bottom) : null, overlap };
      });
      report.measures[`${tag}: phone scroll`] = kept;
      ok(`${tag}: the list doesn't scroll on its own; the search stays at the dialog's top as it scrolls, provider names right under it`,
        kept.own === "visible" && kept.scrolled > 0 && kept.after >= -2 && kept.after <= 2 && kept.gap !== null && kept.gap <= 2 && !kept.overlap, kept);
      await page.screenshot({ path: join(output, `${tag}-scrolled.png`) });
      await page.evaluate(() => { document.querySelector('[role="dialog"]').scrollTop = 0; });
    }
    await page.screenshot({ path: join(output, `${tag}-before-login.png`) });

    // A key login to DeepSeek: its models are read again, its group first and logged in.
    const section = dialog.locator(".opencode-login");
    await section.locator(".opencode-login-provider select").selectOption("deepseek");
    await section.getByRole("button", { name: w.key }).click();
    await section.locator('input[type="password"]').fill(KEY);
    await section.locator(".opencode-login-form").getByRole("button", { name: w.logIn, exact: true }).click();
    await list.locator('input[value="deepseek/deepseek-flash"]').waitFor({ state: "attached", timeout: 10_000 });
    const firstHead = await picker.locator(".opencode-model-group-head").first().textContent();
    ok(`${tag}: after the login DeepSeek comes first, logged in, with no reload`,
      firstHead.includes("DeepSeek") && firstHead.includes(w.logged) && report.logins.length === 1, firstHead);
    await list.locator('label[data-value="deepseek/deepseek-flash"]').click();
    const variants = await dialog.locator(`[role="radiogroup"][aria-label="${w.variant}"] input`).evaluateAll((els) => els.map((e) => e.value));
    ok(`${tag}: the chosen model's variants are offered`, JSON.stringify(variants) === JSON.stringify(["", "none", "low", "high", "max"]), variants);
    await list.evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate(() => { document.querySelector('[role="dialog"]').scrollTop = 0; });
    await page.screenshot({ path: join(output, `${tag}-logged-in.png`) });

    // A search; a `provider/model` OpenCode doesn't list.
    const search = picker.locator('input[type="search"]');
    await search.fill("flash");
    const matched = await list.locator('input[type="radio"]').evaluateAll((els) => els.map((e) => e.value));
    ok(`${tag}: a search keeps the rows it matches`, matched.length === 4 && matched.every((v) => v.includes("flash")), matched);
    await search.fill("deepseek/deepseek-v9");
    const unlisted = await picker.locator(".opencode-model-unlisted").textContent();
    ok(`${tag}: a model OpenCode doesn't list says where to add it`, unlisted.includes(w.unlisted), unlisted);
    await page.screenshot({ path: join(output, `${tag}-unlisted.png`) });
    ok(`${tag}: nothing written but the login`, report.writes.length === 0, report.writes);
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
await writeFile(join(output, "opencode-model-picker-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
