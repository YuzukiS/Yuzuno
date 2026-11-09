// YN-49: Settings → Executor routing in Chromium, every API answered here
// (no Core, no CLI, no real key). At 1440 and 390 (a phone), light and dark,
// English and Chinese: the page fits its width, a phone's targets are 40 px,
// accounts are named by number and fingerprint only, and a key or token typed
// and kept never appears in the page or in a request other than its own write.
// The candidate order (S4a-2): reordered by dragging a handle (a mouse on the
// desktop, the arrows on a phone), a candidate's editor, saved whole against
// the version read; a newer version saved meanwhile is shown, not overwritten.
// YN-57 S2b: a candidate's model is chosen from what its tool lists: Claude
// Code's aliases and pinned versions; OpenCode's providers, the candidate's
// key's first; and the line under it says where the list comes from.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-routing-check.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const report = { task: "YN-49", checks: [], screenshots: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => { report.checks.push({ name, ...extra }); console.log(`PASS ${name}`); };
const HOST = "yuzuno-executor-routing.test";
// Synthetic only. Long and unusual, so a page holding one is found by a text search.
const SECRET = "sk-fixture-yn49-BROWSER-WRITE-ONLY-51c7";
const TOKEN = "ops_fixture-yn49-BROWSER-TOKEN-a90d";
const EMAILS = ["first@example.test", "second@example.test"];

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

/** Core's routing state, as S1's routes answer it; each run starts from it. */
const fresh = () => ({
  keys: [
    { id: "deepseek-main", provider: "deepseek", source: "local", set: true, setAt: "2026-11-08T00:10:00Z" },
    { id: "anthropic", provider: "anthropic", source: "1password", set: true, setAt: "2026-11-08T00:12:00Z", reference: "op://Yuzuno/Anthropic API/credential" },
    { id: "openai", provider: "openai", source: "1password", set: true, setAt: "2026-11-08T00:14:00Z", reference: "op://Yuzuno/OpenAI/api key" },
  ],
  token: { set: true, setAt: "2026-11-08T00:20:00Z" },
  op: { found: true, version: "2.30.0", supported: true },
  cswap: { command: "cswap", pinned: "1.0.0", accounts: [
    { number: 1, fingerprint: "a1b2c3d4e5f60718", active: true, label: EMAILS[0], usageStatus: "ok" },
    { number: 2, fingerprint: "0f1e2d3c4b5a6978", active: false, label: EMAILS[1], usageStatus: "ok" },
    { number: 3, fingerprint: "9a8b7c6d5e4f3021", active: false, label: "team alias" },
  ] },
  homes: [{ id: "work", label: "Work", home: "/home/fixture/.codex-work" }],
  policy: { version: 3, updatedAt: "2026-11-08T04:00:00Z", limits: { candidates: 8 }, policy: { enabled: true, whenNone: "wait", dailyApiCapUsd: 20, candidates: [
    { id: "ds", enabled: true, harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "apiKey", keyId: "deepseek-main" }, unknown: "skip",
      conditions: [{ kind: "timeWindow", inside: false, schedule: PEAK, minMinutesLeft: 30 }, { kind: "dailyApiCap", usd: 5 }] },
    { id: "cl", enabled: true, harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, unknown: "skip",
      conditions: [{ kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10 }] },
    { id: "cx", enabled: true, harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", credential: { kind: "codexHome", id: "work" }, unknown: "skip",
      conditions: [{ kind: "quota", fiveHourLeftPct: 15, weekLeftPct: 10 }] },
    { id: "cla", enabled: false, harness: "claude", model: "opus", credential: { kind: "apiKey", keyId: "anthropic" }, unknown: "skip", conditions: [{ kind: "dailyApiCap", usd: 8 }] },
  ] } },
  // A run that checks a conflict has another save land first.
  conflictNext: false,
  templates: { version: 2, laterTemplates: 0, templates: [
    { id: "dev", label: "Development (PR)", harness: "codex", model: "gpt-6.1-sol" }, { id: "review", label: "Review", harness: "claude", routing: "fixed" }] },
});
/** Each tool's list, as Core answers it (YN-57 S2b). */
const CATALOGS = {
  "claude": { models: [
    { id: "opus", model: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
    { id: "sonnet", model: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5" },
    { id: "haiku", model: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5-5" }] },
  "codex": { models: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }, { id: "gpt-6.1-sol-mini", model: "gpt-6.1-sol-mini", displayName: "GPT-6.1 Sol Mini" }] },
  "opencode": { opencode: { version: "2.2.5", verified: "2.2.5" }, models: [
    { id: "anthropic/claude-x", model: "anthropic/claude-x", providerId: "anthropic", providerName: "Anthropic", name: "Claude X", displayName: "Anthropic · Claude X" },
    { id: "deepseek/deepseek-flash", model: "deepseek/deepseek-flash", providerId: "deepseek", providerName: "DeepSeek", name: "DeepSeek V4.1 Flash", displayName: "DeepSeek · DeepSeek V4.1 Flash" },
    { id: "deepseek/deepseek-v4-pro", model: "deepseek/deepseek-v4-pro", providerId: "deepseek", providerName: "DeepSeek", name: "DeepSeek V4 Pro", displayName: "DeepSeek · DeepSeek V4 Pro" },
    { id: "opencode/big-pickle", model: "opencode/big-pickle", providerId: "opencode", providerName: "OpenCode", name: "Big Pickle", displayName: "OpenCode · Big Pickle" }],
  providers: [{ id: "anthropic", name: "Anthropic", source: "routingKey", keyProvider: "anthropic" },
    { id: "deepseek", name: "DeepSeek", source: "routingKey", keyProvider: "deepseek" }, { id: "opencode", name: "OpenCode", source: "ready" }] },
};
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const peakReason = { code: "peak", message: "DeepSeek's peak price now; off-peak from 12:00", messageZh: "现在是 DeepSeek 高峰价，12:00 起是闲时", condition: 0 };
/** As Core would judge a policy at an hour of the day (Asia/Shanghai, as the page's clock): one rule for
 * evaluate and simulate, so a screenshot's picked time and its strip agree. DeepSeek is off-peak before
 * 10:00; the claude-swap pool is out when an account is assumed used up; the Codex home runs low at 22:00. */
const usedUp = { code: "poolNone", message: "No account has enough left (account #2 assumed used up)", messageZh: "没有够用的账号（假设账号 #2 用完）" };
const codexLow = { code: "quotaLow", message: "5-hour left 4% (needs ≥ 15%)", messageZh: "5 小时剩 4%（要 ≥ 15%）" };
function judged(policy, hour, assume) {
  let chosen = null;
  const candidates = policy.candidates.map((c) => {
    if (!c.enabled) return { id: c.id, state: "off", reasons: [], readings: [] };
    const why = c.harness === "opencode" && hour >= 10 ? peakReason
      : c.credential.kind === "pool" && assume?.accountsUsedUp?.length ? usedUp
      : c.credential.kind === "codexHome" && hour >= 22 ? codexLow : null;
    if (why) return { id: c.id, state: "skipped", reasons: [why], readings: [] };
    if (chosen) return { id: c.id, state: "notTried", reasons: [], readings: [] };
    chosen = c.id;
    return c.credential.kind === "pool" ? { id: c.id, state: "chosen",
      reasons: [{ code: "poolPick", message: "Account #2: 71% of 5 hours and 58% of the week left", messageZh: "账号 #2：5 小时剩 71%，本周剩 58%" }],
      readings: [{ what: "fiveHourLeft", account: "1", value: 8, observedAt: ago(2), source: "cswap" }, { what: "weekLeft", account: "1", value: 64, observedAt: ago(2), source: "cswap" },
        { what: "fiveHourLeft", account: "2", value: 71, observedAt: ago(2), source: "cswap" }, { what: "weekLeft", account: "2", value: 58, observedAt: ago(2), source: "cswap" }],
      accounts: [{ number: 1, fingerprint: "a1b2c3d4e5f60718", state: "low" }, { number: 2, fingerprint: "0f1e2d3c4b5a6978", state: "pick" }] }
      : { id: c.id, state: "chosen", reasons: [], readings: [] };
  });
  const pick = candidates.find((c) => c.id === chosen);
  return { policyVersion: 3, evaluatedAt: ago(0), at: "preview", chosen, ...(pick?.accounts ? { account: { number: 2, fingerprint: "0f1e2d3c4b5a6978" } } : {}), candidates };
}
const shanghaiHour = (iso) => (new Date(iso).getUTCHours() + 8) % 24;
/** "Now" is 14:00 in this fixture, whatever the clock says: the check's assertions don't move with it. */
const evaluation = (policy, at, assume) => judged(policy, at ? shanghaiHour(at) : 14, assume);
const PEAK = { timeZone: "UTC", slots: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }, { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" }] };
let state = fresh();
const notFound = { ok: false, reason: { code: "referenceNotFound", message: "1Password has no op://Yuzuno/OpenAI/api key", messageZh: "1Password 里找不到 op://Yuzuno/OpenAI/api key" } };

async function route(r) {
  const request = r.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) { report.unexpected.push(request.url()); return r.abort(); }
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  // Evaluating is a read, by POST: not a write.
  if (method !== "GET" && path !== "/api/routing/evaluate" && path !== "/api/routing/simulate") report.writes.push({ method, path, body });
  // A secret may be in its own write only.
  const own = (method === "PUT" && /^\/api\/routing\/keys\/[^/]+$/.test(path)) || (method === "PUT" && path === "/api/routing/1password/token");
  if (!own && (request.postData() ?? "").match(new RegExp(`${SECRET}|${TOKEN}`))) report.errors.push(`a secret was sent to ${method} ${path}`);
  if (request.url().includes(SECRET) || request.url().includes(TOKEN)) report.errors.push(`a secret in a URL: ${method} ${path}`);
  const json = (value, status = 200) => r.fulfill({ status, json: value });
  if (path === "/api/routing/policy" && method === "GET") return json(state.policy);
  // YN-57 S2b: each tool's list.
  if (path === "/api/models" && method === "GET") return json(CATALOGS[url.searchParams.get("harness") ?? "codex"]);
  if (path === "/api/routing/models" && method === "GET") return json(CATALOGS[url.searchParams.get("harness")]);
  // S4b: Core's evaluation of the draft it is sent, the recent choices and today's spend.
  if (path === "/api/routing/evaluate" && method === "POST") return json(evaluation(body.policy ?? state.policy.policy, body.at, body.assume));
  // The week, by the same rule: each day's stretches before 10:00, to 22:00 and to midnight.
  if (path === "/api/routing/simulate" && method === "POST") {
    const from = Date.parse(body.from), H = 3_600_000, segments = [], policy = body.policy ?? state.policy.policy;
    for (let d = 0; d < 7; d++) for (const [a, b] of [[0, 10], [10, 22], [22, 24]])
      segments.push({ from: new Date(from + (24 * d + a) * H).toISOString(), to: new Date(from + (24 * d + b) * H).toISOString(), chosen: judged(policy, a, body.assume).chosen });
    return json({ segments });
  }
  if (path === "/api/executor-templates") {
    if (method === "PUT") { state.templates = { version: state.templates.version + 1, templates: body.templates, laterTemplates: 0 }; }
    return json({ workspace: state.templates, available: [], presets: [] });
  }
  if (path === "/api/routing/choices") return json({ choices: [
    { dispatchId: "d-905", taskId: "T-905", executorName: "T-905 · Dev", route: { ...evaluation(state.policy.policy, undefined, undefined), at: "dispatch", evaluatedAt: ago(6) } },
    { dispatchId: "d-904", taskId: "T-904", route: { at: "start", evaluatedAt: ago(200), chosen: "cx", changedAtStart: { from: "cl", reason: "Account #2 ran low while waiting" },
      candidates: [{ id: "ds", state: "skipped", reasons: [peakReason], readings: [] }, { id: "cl", state: "skipped", reasons: [{ code: "poolNone", message: "No account has enough left", messageZh: "没有够用的账号" }], readings: [] },
        { id: "cx", state: "chosen", reasons: [], readings: [] }] } }] });
  if (path === "/api/routing/readings") return json({ at: ago(0), staleAfterSeconds: 600,
    spend: { day: "2026-11-08", zone: "local", utcOffset: "+08:00", resetsAt: ago(-600), totalUsd: 3.4, byKey: { "deepseek-main": 0.62, anthropic: 2.78 } } });
  if (path === "/api/routing/policy" && method === "PUT") {
    if (state.conflictNext) {
      state.conflictNext = false;
      state.policy = { ...state.policy, version: state.policy.version + 1, updatedAt: "2026-11-08T04:55:00Z",
        policy: { ...state.policy.policy, candidates: state.policy.policy.candidates.slice(1) } };
    }
    if (body.expectedVersion !== state.policy.version) return json({ code: "version_conflict", error: "version_conflict: the routing changed", current: state.policy }, 409);
    state.policy = { ...state.policy, version: state.policy.version + 1, updatedAt: "2026-11-08T05:00:00Z", policy: body.policy };
    return json(state.policy);
  }
  if (path === "/api/routing/keys" && method === "GET") return json({ keys: state.keys, onePasswordToken: state.token });
  if (path === "/api/routing/1password" && method === "GET") return json({ token: state.token, op: state.op });
  if (path === "/api/routing/accounts" && method === "GET") return json({ cswap: state.cswap, codexHomes: state.homes });
  const key = path.match(/^\/api\/routing\/keys\/([^/]+)(\/check)?$/);
  if (key?.[2] && method === "POST") return json(decodeURIComponent(key[1]) === "openai" ? notFound : { ok: true });
  if (key && method === "PUT") {
    const id = decodeURIComponent(key[1]);
    const kept = { id, provider: body.provider, source: body.source, set: true, setAt: "2026-11-08T04:50:00Z", ...(body.reference ? { reference: body.reference } : {}) };
    state.keys = [...state.keys.filter((k) => k.id !== id), kept].sort((a, b) => a.id.localeCompare(b.id));
    return json(kept);
  }
  if (path === "/api/routing/1password/token" && method === "PUT") { state.token = { set: true, setAt: "2026-11-08T04:51:00Z" }; return json(state.token); }
  if (method !== "GET") return json({ error: "not answered by this fixture" }, 500);
  const fixed = {
    "/api/workspace": { workspace: { id: "ws-executor-routing" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  }[path];
  if (fixed) return json(fixed);
  if (path.startsWith("/api/")) return json({});
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try { await r.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); } catch { await r.fulfill({ status: 404, body: "" }); }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const words = {
  en: { settings: "Settings and updates", tab: "Executor routing", title: "Accounts and keys", account1: "Account #1", addKey: "Add a key", save: "Save",
    value: "DeepSeek API key (for OpenCode): value", check: "Check", notFound: "1Password has no op://Yuzuno/OpenAI/api key", set: "Set · ",
    replaceToken: "Replace token", token: "Service account token",
    first: "OpenCode · deepseek-flash", firstName: "OpenCode · deepseek-flash · API", second: "Claude Code · opus", edit: (t) => `Edit ${t}`, down: (t) => `Move ${t} down`, saveBar: "Save",
    saved: "All changes saved.", conflict: /A newer version \(4/, model: "Model",
    claudeGroups: ["Aliases · follow new releases", "Pinned versions"], fromClaude: /^From Claude Code on this Core host/,
    opencodeGroups: ["DeepSeek · with this candidate's API key", "OpenCode · no login needed", "Anthropic · only with its own API key"], fromOpencode: /^From OpenCode 2\.2\.5 on this Core host/ },
  zh: { settings: "Settings and updates", tab: "执行者路由", title: "账号和密钥", account1: "账号 #1", addKey: "添加 key", save: "保存",
    value: "DeepSeek API key（OpenCode 用）：值", check: "检查", notFound: "1Password 里找不到 op://Yuzuno/OpenAI/api key", set: "已设置 · ",
    replaceToken: "替换令牌", token: "服务账号令牌",
    first: "OpenCode · deepseek-flash", firstName: "OpenCode · deepseek-flash · API", second: "Claude Code · opus", edit: (t) => `编辑 ${t}`, down: (t) => `下移 ${t}`, saveBar: "保存",
    saved: "所有更改都已保存。", conflict: /Core 里有更新的版本（4/, model: "模型",
    claudeGroups: ["别名 · 跟着新版本走", "固定版本"], fromClaude: /^来自这台 Core 主机上的 Claude Code/,
    opencodeGroups: ["DeepSeek · 用这个候选的 API key", "OpenCode · 免登录", "Anthropic · 只能用它自己的 API key"], fromOpencode: /^来自这台 Core 主机上的 OpenCode 2\.2\.5/ },
};

async function run({ width, height, theme, lang }) {
  const phone = width < 600;
  const tag = `${width}-${theme}-${lang}`;
  const w = words[lang];
  state = fresh();
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  const consoleLines = [];
  page.on("console", (message) => {
    consoleLines.push(message.text());
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) report.errors.push(`${tag} console: ${message.text()}`);
  });
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const shot = async (name) => {
    const file = join(output, `${tag}-${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({ name: `${tag}-${name}`, sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
  };
  const dialog = page.locator(".modal.settings-modal");
  const pane = dialog.locator(".settings-pane");
  const section = page.locator(".routing-keys");
  /** Nothing in Settings wider than its box. */
  const fits = () => dialog.evaluate((el) => [el, el.querySelector(".settings-pane"), el.querySelector(".executor-routing"), el.querySelector(".routing-keys")].filter(Boolean)
    .map((part) => ({ name: part.className.split(" ")[0], scroll: part.scrollWidth, client: part.clientWidth })).filter((p) => p.scroll > p.client + 1));
  /** The page's text and markup hold no secret, email or label; nor do this
   * site's storage, the URL, any field's value attribute or the console. */
  const clean = async (when) => {
    const htmlNow = await page.content();
    for (const secret of [SECRET, TOKEN, ...EMAILS, "team alias"]) assert.ok(!htmlNow.includes(secret), `${tag} ${when}: the page holds ${secret}`);
    const kept = await page.evaluate(() => JSON.stringify([
      Object.entries(localStorage), Object.entries(sessionStorage), location.href,
      [...document.querySelectorAll("input")].map((i) => i.getAttribute("value") ?? ""),
    ]));
    for (const secret of [SECRET, TOKEN]) {
      assert.ok(!kept.includes(secret), `${tag} ${when}: storage, the URL or a value attribute holds ${secret}`);
      assert.ok(!consoleLines.some((line) => line.includes(secret)), `${tag} ${when}: the console holds ${secret}`);
    }
  };
  try {
    await page.goto(`https://${HOST}/`);
    await page.locator(".workspace-settings").waitFor({ timeout: 15_000 });
    await press(page.locator(".workspace-settings"));
    await dialog.locator(".settings-center").waitFor({ timeout: 10_000 });
    await press(dialog.locator("#settings-tab-routing"));
    await section.getByText(w.account1).first().waitFor({ timeout: 10_000 });
    assert.equal((await dialog.locator("#settings-tab-routing .settings-nav-label").innerText()).trim(), w.tab);
    assert.equal((await section.locator("#routing-keys-title").innerText()).trim(), w.title);
    await page.mouse.move(0, 0);
    assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box`);
    await clean("on opening");
    await shot("top");
    if (phone) {
      // Every control a finger presses is 40 px tall at least.
      const short = await section.evaluate((el) => [...el.querySelectorAll("button, select, input")].filter((c) => c.offsetParent)
        .map((c) => ({ name: c.getAttribute("aria-label") || c.textContent.trim(), h: Math.round(c.getBoundingClientRect().height) })).filter((c) => c.h < 40));
      assert.deepEqual(short, [], `${tag}: targets under 40 px`);
    }
    // ---- The candidate order: reordered, edited, saved against the version read.
    const order = page.locator(".executor-routing");
    const titles = () => order.locator(".routing-cand .routing-cand-title > span:first-child").allInnerTexts();
    assert.deepEqual((await titles()).slice(0, 2), [w.first, w.second]);
    await order.locator(".routing-now").waitFor({ timeout: 10_000 });
    assert.match(await order.locator(".routing-now-title").innerText(), lang === "zh" ? /现在会选 Claude Code · opus — 账号 #2/ : /Now it would choose Claude Code · opus — Account #2/);
    assert.equal(await order.locator(".routing-cand.is-chosen").count(), 1, `${tag}: one card would be chosen`);
    await page.mouse.move(0, 0);
    await shot("now");
    if (!phone) {
      // A time window's chip has every period in its tip (YN-44's Tip).
      await order.locator(".routing-cand").first().locator(".routing-chip").first().hover();
      const tip = page.locator(".tip");
      await tip.waitFor({ timeout: 10_000 });
      assert.match(await tip.innerText(), lang === "zh" ? /01:00–04:00；周一至五 06:00–10:00/ : /01:00–04:00; Mon–Fri 06:00–10:00/);
      await shot("chip-tip");
      await page.mouse.move(0, 0);
      await tip.waitFor({ state: "detached", timeout: 10_000 });
    }
    if (phone) {
      await press(order.getByRole("button", { name: w.down(w.firstName), exact: true }));
    } else {
      // A real drag of the first card's handle to below the second card.
      const grip = await order.locator(".routing-cand").first().locator(".routing-grip").boundingBox();
      const second = await order.locator(".routing-cand").nth(1).boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + ((second.y + second.height - grip.y) * i) / 8);
      await shot("dragging");
      await page.mouse.up();
    }
    await page.waitForFunction((want) => document.querySelector(".executor-routing .routing-cand .routing-cand-title > span")?.textContent === want, w.second);
    assert.deepEqual((await titles()).slice(0, 2), [w.second, w.first], `${tag}: the first card moved below the second`);
    await press(order.getByRole("button", { name: w.edit(w.second), exact: true }));
    await order.locator(".routing-edit").first().waitFor({ timeout: 10_000 });
    await page.mouse.move(0, 0);
    assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box, the editor open`);
    await shot("order-editor");
    // ---- YN-57 S2b: the model is chosen from what the tool lists.
    const modelOf = (editor) => editor.locator(".routing-model").evaluate((field) => ({
      value: field.querySelector("select").value,
      groups: [...field.querySelectorAll("optgroup")].map((g) => g.label),
      note: field.querySelector(".routing-model-note")?.textContent.trim() ?? "",
    }));
    const claudeEditor = order.locator(".routing-edit").first();
    await page.waitForFunction(() => document.querySelectorAll(".executor-routing .routing-edit .routing-model optgroup").length === 2);
    const claudeModel = await modelOf(claudeEditor);
    assert.deepEqual([claudeModel.value, claudeModel.groups], ["opus", w.claudeGroups], `${tag}: Claude Code's aliases and pinned versions`);
    assert.match(claudeModel.note, w.fromClaude);
    await press(order.getByRole("button", { name: w.edit(w.firstName), exact: true }));
    await page.waitForFunction(() => document.querySelectorAll(".executor-routing .routing-edit .routing-model optgroup").length === 3);
    const opencodeEditor = order.locator(".routing-edit").first();
    const opencodeModel = await modelOf(opencodeEditor);
    assert.deepEqual([opencodeModel.value, opencodeModel.groups], ["deepseek/deepseek-flash", w.opencodeGroups], `${tag}: OpenCode's list, its key's provider first`);
    assert.match(opencodeModel.note, w.fromOpencode);
    await opencodeEditor.locator(".routing-model").scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box, the model picker open`);
    await shot("model-opencode");
    check(`${tag}: the model is chosen from Claude Code's and OpenCode's own lists, each saying where it comes from`);
    if (phone) {
      const short = await order.evaluate((el) => [...el.querySelectorAll("button, select, input:not([type=checkbox]):not([type=radio])")].filter((c) => c.offsetParent)
        .map((c) => ({ name: c.getAttribute("aria-label") || c.textContent.trim(), h: Math.round(c.getBoundingClientRect().height) })).filter((c) => c.h < 40));
      assert.deepEqual(short, [], `${tag}: order targets under 40 px`);
    }
    // One desktop run has another save land first: shown, not overwritten.
    state.conflictNext = tag === "1440-light-en";
    const saveBar = dialog.locator(".settings-savebar:not([hidden])");
    await press(saveBar.getByRole("button", { name: w.saveBar, exact: true }));
    if (tag === "1440-light-en") {
      await order.locator(".routing-conflict").waitFor({ timeout: 10_000 });
      assert.match(await order.locator(".routing-conflict").innerText(), w.conflict);
      await order.locator(".routing-conflict").scrollIntoViewIfNeeded();
      await shot("conflict");
      await press(order.locator(".routing-conflict").getByRole("button").first());
      await saveBar.getByRole("button").first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
      check(`${tag}: a newer version saved meanwhile is shown with its order; nothing overwritten`);
    } else {
      await saveBar.getByText(w.saved).waitFor({ timeout: 10_000 });
      const put = report.writes.filter((x) => x.path === "/api/routing/policy").at(-1);
      assert.equal(put.body.expectedVersion, 3);
      assert.deepEqual(put.body.policy.candidates.map((c) => c.id), ["cl", "ds", "cx", "cla"]);
      await shot("order-saved");
      // The recent choices, one opened to its record; today's spend by the cap.
      const recent = order.locator(".routing-recent-row");
      await recent.nth(1).waitFor({ timeout: 10_000 });
      await press(recent.nth(1));
      await order.locator("#routing-recent-d-904").waitFor({ timeout: 10_000 });
      await order.locator(".routing-recent").scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box, a record open`);
      await shot("recent");
      // The week, assuming account #2 used up; the templates, one fixed.
      const sim = order.locator(".routing-simulate");
      await sim.locator(".routing-strip-row").nth(6).waitFor({ timeout: 10_000 });
      await press(sim.locator(".routing-pill").nth(1));
      // Assuming it, the pool is out: Codex until 22:00, then none (striped) each day.
      await sim.locator(".routing-strip-run.is-wait").nth(6).waitFor({ timeout: 10_000 });
      await sim.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box, the week drawn`);
      await shot("simulate");
      const fixedTemplate = order.locator('.routing-template[data-template="review"]');
      await fixedTemplate.scrollIntoViewIfNeeded();
      assert.match(await fixedTemplate.innerText(), lang === "zh" ? /固定：Claude Code/ : /Fixed: Claude Code/);
      await shot("templates");
      assert.match(await order.locator(".routing-spend").innerText(), /\$3\.40 (of|\/) \$20/);
    }
    // The keys, scrolled to: a 1Password key whose reference isn't there.
    const openai = section.locator('.routing-key[data-key="openai"]');
    await openai.scrollIntoViewIfNeeded();
    await press(openai.getByRole("button", { name: w.check }));
    await openai.getByText(w.notFound).waitFor({ timeout: 10_000 });
    await shot("keys");
    // A new local key, typed (masked) and kept: never in the page.
    await press(section.getByRole("button", { name: w.addKey }));
    const value = section.getByLabel(w.value, { exact: true });
    await value.waitFor({ timeout: 10_000 });
    await value.fill(SECRET);
    await clean("while a key is typed");
    await value.scrollIntoViewIfNeeded();
    await shot("new-key");
    await press(section.locator(".routing-new-key").getByRole("button", { name: w.save, exact: true }));
    const kept = section.locator('.routing-key[data-key="deepseek"]');
    await kept.getByText(w.set).waitFor({ timeout: 10_000 });
    await clean("once the key is kept");
    assert.equal(await page.evaluate((secret) => [...document.querySelectorAll("input")].some((i) => i.value === secret), SECRET), false, `${tag}: no field holds the key`);
    // The service account's token, replaced the same way.
    await press(section.getByRole("button", { name: w.replaceToken }));
    await section.getByLabel(w.token, { exact: true }).fill(TOKEN);
    await clean("while the token is typed");
    await press(section.locator(".routing-op").getByRole("button", { name: w.save, exact: true }));
    await section.getByRole("button", { name: w.replaceToken }).waitFor({ timeout: 10_000 });
    await clean("once the token is kept");
    await kept.scrollIntoViewIfNeeded();
    assert.deepEqual(await fits(), [], `${tag}: nothing wider than its box after the edits`);
    await shot("kept");
    const puts = report.writes.filter((x) => x.tag === undefined && (x.tag = tag)).filter((x) => x.path !== "/api/routing/policy");
    assert.deepEqual(puts.map((x) => `${x.method} ${x.path}`), ["POST /api/routing/keys/openai/check", "PUT /api/routing/keys/deepseek", "PUT /api/routing/1password/token"], `${tag}: these writes only`);
    assert.deepEqual(puts[1].body, { source: "local", provider: "deepseek", value: SECRET });
    assert.deepEqual(puts[2].body, { value: TOKEN });
    check(`${tag}: page fits${phone ? ", 40 px targets" : ""}; the order ${phone ? "moved by its arrows" : "dragged"}, edited and saved; accounts by number and fingerprint; a key and the token typed and kept, never in the page`);
  } finally {
    await context.close();
  }
}

try {
  for (const options of [
    { width: 1440, height: 900, theme: "light", lang: "en" },
    { width: 1440, height: 900, theme: "dark", lang: "zh" },
    { width: 390, height: 844, theme: "light", lang: "zh" },
    { width: 390, height: 844, theme: "dark", lang: "en" },
  ]) await run(options);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
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
