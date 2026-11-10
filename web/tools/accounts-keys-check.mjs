// YN-84 S3: Settings → Accounts & keys in Chromium, every API answered here
// (no Core, no CLI, no real key or account). A card per provider (layout A):
// its logins then its API keys, all open, each row saying which Workspace
// settings reference it. Four states — an ordinary Workspace, a new one, the
// routing order unreadable, the accounts' read failing — at 1440 light English,
// 1440 dark Chinese, 390 light Chinese and 390 dark English: nothing wider than
// its box, nothing covered or overlapping, a phone's targets 40 px, accounts by
// number and fingerprint only, and a key or token typed and kept only in its
// own write, never in the page.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/accounts-keys-check.mjs
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
const report = { task: "YN-84 S3", checks: [], screenshots: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => { report.checks.push({ name, ...extra }); console.log(`PASS ${name}`); };
const HOST = "yuzuno-accounts-keys.test";
// Synthetic only. Long and unusual, so a page holding one is found by a text search.
const SECRET = "sk-fixture-yn84-S3-WRITE-ONLY-e61b";
const TOKEN = "ops_fixture-yn84-S3-TOKEN-07d2";
const EMAILS = ["first@example.test", "second@example.test"];

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const cand = (id, harness, model, credential, more = {}) => ({ id, enabled: true, harness, model, credential, conditions: [], unknown: "skip", ...more });

/** An ordinary Workspace: a key per known provider, claude-swap's accounts, a Codex home, and routing that reaches
 * them, an OpenCode provider Yuzuno keeps no key for and OpenCode's default model; new Agents use Codex, review
 * Claude Code. */
const ordinary = () => ({
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
  ] },
  homes: [{ id: "work", label: "Work", home: "/home/fixture/.codex-work" }],
  policy: { enabled: true, whenNone: "wait", candidates: [
    cand("ds", "opencode", "deepseek/deepseek-flash", { kind: "apiKey", keyId: "deepseek-main" }, { tiers: ["fast"] }),
    cand("cl", "claude", "opus", { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }, { tiers: ["strong"] }),
    cand("cx", "codex", "gpt-6.1-sol", { kind: "codexHome", id: "work" }, { reasoningEffort: "high" }),
    cand("or", "opencode", "openrouter/qwen-3-coder", { kind: "login" }),
    cand("oc", "opencode", undefined, { kind: "login" }, { enabled: false }),
    cand("cla", "claude", "opus", { kind: "apiKey", keyId: "anthropic" }, { enabled: false }),
  ] },
  agentHarness: "codex",
  review: { harness: "claude", model: "opus" },
  fail: [],
});
/** A Workspace on someone else's machine, just made: nothing set up, routing off; new Agents and review use Codex. */
const newWorkspace = () => ({ ...ordinary(), keys: [], token: { set: false }, cswap: { command: "cswap", pinned: "1.0.0", accounts: [] }, homes: [],
  policy: { enabled: false, whenNone: "wait", candidates: [] }, review: { harness: "codex", model: "gpt-6.1-sol" } });
const STATES = {
  ordinary,
  fresh: newWorkspace,
  policyFailed: () => ({ ...ordinary(), fail: ["policy"] }),
  accountsFailed: () => ({ ...ordinary(), fail: ["accounts"] }),
};
let state = ordinary();

async function route(r) {
  const request = r.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) { report.unexpected.push(request.url()); return r.abort(); }
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  if (method !== "GET") report.writes.push({ method, path, body });
  // A secret may be in its own write only.
  const own = (method === "PUT" && /^\/api\/routing\/keys\/[^/]+$/.test(path)) || (method === "PUT" && path === "/api/routing/1password/token");
  if (!own && (request.postData() ?? "").match(new RegExp(`${SECRET}|${TOKEN}`))) report.errors.push(`a secret was sent to ${method} ${path}`);
  if (request.url().includes(SECRET) || request.url().includes(TOKEN)) report.errors.push(`a secret in a URL: ${method} ${path}`);
  const json = (value, status = 200) => r.fulfill({ status, json: value });
  const refused = (what) => json({ error: `${what} timed out` }, 503);
  if (path === "/api/routing/keys" && method === "GET") return json({ keys: state.keys, onePasswordToken: state.token });
  if (path === "/api/routing/1password" && method === "GET") return json({ token: state.token, op: state.op });
  if (path === "/api/routing/accounts" && method === "GET") return state.fail.includes("accounts") ? refused("claude-swap") : json({ cswap: state.cswap, codexHomes: state.homes });
  if (path === "/api/routing/policy" && method === "GET") return state.fail.includes("policy") ? refused("Reading the routing")
    : json({ version: 3, updatedAt: "2026-11-08T04:00:00Z", limits: { candidates: 8 }, policy: state.policy });
  if (path === "/api/agent-defaults" && method === "GET") return json({ saved: {}, builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
    effective: { harness: { value: state.agentHarness, source: "workspace" }, codexPermissionPreset: { value: null, source: "builtin" }, claudePermissionMode: { value: "default", source: "builtin" } } });
  if (path === "/api/pr-reviews/settings" && method === "GET") return json({ ...state.review, source: "workspace" });
  const key = path.match(/^\/api\/routing\/keys\/([^/]+)$/);
  if (key && method === "PUT") {
    const id = decodeURIComponent(key[1]);
    const kept = { id, provider: body.provider, source: body.source, set: true, setAt: "2026-11-08T04:50:00Z", ...(body.reference ? { reference: body.reference } : {}) };
    state.keys = [...state.keys.filter((k) => k.id !== id), kept].sort((a, b) => a.id.localeCompare(b.id));
    return json(kept);
  }
  if (path === "/api/routing/1password/token" && method === "PUT") { state.token = { set: true, setAt: "2026-11-08T04:51:00Z" }; return json(state.token); }
  if (method !== "GET") return json({ error: "not answered by this fixture" }, 500);
  const fixed = {
    "/api/workspace": { workspace: { id: "ws-accounts-keys" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
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
  en: { tab: "Accounts & keys", account1: "Account #1",
    names: ["Claude", "OpenAI / Codex", "DeepSeek", "openrouter", "OpenCode's default model"],
    heads: ["Referenced in 2 places · 1 more off", "Referenced in 2 places", "Referenced in 1 place", "Referenced in 1 place", "Referenced in 0 places · 1 more off"],
    layers: ["Logins", "API keys"], scope: /^“Referenced by” covers Workspace settings only/, others: ["Claude", "DeepSeek"],
    noLogin: /^No login to manage here\. A routing candidate that reaches DeepSeek/, noKey: "No key yet.",
    addDeepseek: "Add a DeepSeek key", value: "New DeepSeek API key: value", save: "Save", set: "Set · ", replaceToken: "Replace token", token: "Service account token",
    unread: "Couldn't read the routing order: references may be missing.", unsure: "References: not all read", failed: "claude-swap timed out", reread: "Read again",
    routingOff: "Executor routing is off: its candidates aren't used now." },
  zh: { tab: "账号与密钥", account1: "账号 #1",
    names: ["Claude", "OpenAI / Codex", "DeepSeek", "openrouter", "OpenCode 默认模型"],
    heads: ["2 处引用 · 另有 1 处停用", "2 处引用", "1 处引用", "1 处引用", "0 处引用 · 另有 1 处停用"],
    layers: ["登录", "API key"], scope: /^「引用」只看工作区级的设置/, others: ["Claude", "DeepSeek"],
    noLogin: /^这里没有登录要管理。路由里用 OpenCode 自己的登录连 DeepSeek/, noKey: "还没有 key。",
    addDeepseek: "添加 DeepSeek 的 key", value: "新的 DeepSeek API key：值", save: "保存", set: "已设置 · ", replaceToken: "替换令牌", token: "服务账号令牌",
    unread: "读不到路由顺序：引用可能不全。", unsure: "引用：读不全", failed: "claude-swap timed out", reread: "重新读取",
    routingOff: "执行者路由关着：路由里的候选现在不会被用到。" },
};

async function run({ width, height, theme, lang }) {
  const phone = width < 600;
  const tag = `${width}-${theme}-${lang}`;
  const w = words[lang];
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
  const dialog = page.locator(".modal.settings-modal");
  const section = page.locator(".routing-keys");
  const shot = async (name) => {
    await page.mouse.move(0, 0);
    const file = join(output, `${tag}-${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({ name: `${tag}-${name}`, sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
  };
  /** Nothing in Settings wider than its box: the dialog, its pane, the section and each card. */
  const fits = () => dialog.evaluate((el) => [el, el.querySelector(".settings-pane"), el.querySelector(".routing-keys"), ...el.querySelectorAll(".routing-provider, .routing-sources .settings-group")]
    .filter(Boolean).map((part) => ({ name: `${part.className.split(" ").pop()}${part.dataset?.provider ? `[${part.dataset.provider}]` : ""}`, scroll: part.scrollWidth, client: part.clientWidth }))
    .filter((p) => p.scroll > p.client + 1));
  /** No row's parts over one another, nor a card head's name over its count. */
  const overlaps = () => section.evaluate((el) => {
    const out = [];
    const name = (n) => (n.getAttribute("class") || n.tagName.toLowerCase()).split(" ")[0];
    for (const parent of el.querySelectorAll(".settings-row, .routing-provider-head")) {
      const parts = [...parent.children].map((c) => [c, c.getBoundingClientRect()]).filter(([, b]) => b.width > 0 && b.height > 0);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        const [a, A] = parts[i], [b, B] = parts[j];
        if (A.left < B.right - 0.5 && B.left < A.right - 0.5 && A.top < B.bottom - 0.5 && B.top < A.bottom - 0.5) out.push(`${name(parent)}${parent.closest(".routing-provider")?.dataset.provider ? `[${parent.closest(".routing-provider").dataset.provider}]` : ""}: ${name(a)} × ${name(b)}`);
      }
    }
    return out;
  });
  /** Every control, card name, reference and error can be reached: centred in view, the point at its middle is its own. */
  const covered = () => section.evaluate((el) => {
    const out = [];
    for (const c of el.querySelectorAll("button, select, input, .routing-provider-head h4, .routing-refs li, .routing-refs.is-none, .inline-error, .routing-notices p")) {
      if (!c.offsetParent) continue;
      c.scrollIntoView({ block: "center" });
      const b = c.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit || !(hit === c || c.contains(hit))) out.push(`${c.tagName.toLowerCase()} "${(c.getAttribute("aria-label") || c.textContent).trim().slice(0, 40)}" under ${hit ? `${hit.tagName.toLowerCase()}.${hit.getAttribute("class") ?? ""}` : "nothing"}`);
    }
    el.closest(".settings-pane")?.scrollTo({ top: 0 });
    return out;
  });
  /** Every control a finger presses is 40 px tall at least. */
  const short = () => section.evaluate((el) => [...el.querySelectorAll("button, select, input")].filter((c) => c.offsetParent)
    .map((c) => ({ name: c.getAttribute("aria-label") || c.textContent.trim(), h: Math.round(c.getBoundingClientRect().height) })).filter((c) => c.h < 40));
  /** The page's text and markup hold no secret, email or label; nor do this site's storage, the URL, any field's
   * value attribute or the console. */
  const clean = async (when) => {
    const htmlNow = await page.content();
    for (const secret of [SECRET, TOKEN, ...EMAILS]) assert.ok(!htmlNow.includes(secret), `${tag} ${when}: the page holds ${secret}`);
    const kept = await page.evaluate(() => JSON.stringify([
      Object.entries(localStorage), Object.entries(sessionStorage), location.href,
      [...document.querySelectorAll("input")].map((i) => i.getAttribute("value") ?? ""),
    ]));
    for (const secret of [SECRET, TOKEN]) {
      assert.ok(!kept.includes(secret), `${tag} ${when}: storage, the URL or a value attribute holds ${secret}`);
      assert.ok(!consoleLines.some((line) => line.includes(secret)), `${tag} ${when}: the console holds ${secret}`);
    }
  };
  const layout = async (what) => {
    assert.deepEqual(await fits(), [], `${tag} ${what}: nothing wider than its box`);
    assert.deepEqual(await overlaps(), [], `${tag} ${what}: nothing over another`);
    assert.deepEqual(await covered(), [], `${tag} ${what}: nothing covered`);
    if (phone) assert.deepEqual(await short(), [], `${tag} ${what}: targets under 40 px`);
  };
  const cards = () => section.locator(".routing-provider").evaluateAll((list) => list.map((c) => c.dataset.provider));
  const heads = () => section.locator(".routing-provider-head").evaluateAll((list) => list.map((h) => [h.querySelector("h4").textContent.trim(), h.querySelector(".routing-provider-refs").textContent.trim()]));
  /** Settings, opened at Accounts & keys in the state `name`: on a phone Back goes to the list of pages first. */
  const openAccounts = async (name) => {
    state = STATES[name]();
    await page.goto(`https://${HOST}/`);
    await page.locator(".workspace-settings").waitFor({ timeout: 15_000 });
    await press(page.locator(".workspace-settings"));
    await dialog.locator(".settings-center").waitFor({ timeout: 10_000 });
    if (phone) {
      const back = dialog.locator(".settings-back");
      if (await back.count()) await press(back);
    }
    await press(dialog.locator("#settings-tab-accounts"));
    await section.locator(".routing-sources").waitFor({ timeout: 15_000 });
    assert.equal((await dialog.locator("#settings-tab-accounts .settings-nav-label").innerText()).trim(), w.tab);
  };
  try {
    // ---- An ordinary Workspace: every kind of card, each row's references.
    await openAccounts("ordinary");
    await page.waitForFunction(() => document.querySelectorAll(".routing-keys .routing-provider").length === 5
      && !document.querySelector('.routing-keys [role="status"]:not(.routing-notices)'), null, { timeout: 15_000 });
    await section.getByText(w.account1).first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await cards(), ["anthropic", "openai", "deepseek", "openrouter", "*"], `${tag}: the known providers, then OpenCode's`);
    assert.deepEqual(await heads(), w.names.map((n, i) => [n, w.heads[i]]), `${tag}: each card's name and count`);
    assert.deepEqual(await section.locator('.routing-provider[data-provider="deepseek"] .routing-layer-title').allInnerTexts(), w.layers);
    assert.equal(await section.locator('.routing-provider[data-provider="openrouter"] [data-layer="keys"]').count(), 0, `${tag}: no key layer for a provider Yuzuno keeps no key for`);
    assert.match((await section.locator(".routing-refs-scope").innerText()).trim(), w.scope);
    assert.equal(await section.locator(".routing-notices").count(), 0, `${tag}: nothing to warn of`);
    await layout("an ordinary Workspace");
    await clean("on opening");
    await shot("ordinary-top");
    await section.locator('.routing-provider[data-provider="openai"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot("ordinary-openai");
    await section.locator('.routing-provider[data-provider="openrouter"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot("ordinary-opencode");
    // A new DeepSeek key, typed (masked) and kept: never in the page, only in its own write.
    const deepseek = section.locator('.routing-provider[data-provider="deepseek"]');
    await press(deepseek.getByRole("button", { name: w.addDeepseek }));
    const value = section.getByLabel(w.value, { exact: true });
    await value.waitFor({ timeout: 10_000 });
    await value.fill(SECRET);
    await clean("while a key is typed");
    await value.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await layout("the new key's form open");
    await shot("ordinary-new-key");
    await press(deepseek.locator(".routing-new-key").getByRole("button", { name: w.save, exact: true }));
    const kept = deepseek.locator('.routing-key[data-key="deepseek"]');
    await kept.getByText(w.set).waitFor({ timeout: 10_000 });
    await clean("once the key is kept");
    assert.equal(await page.evaluate((secret) => [...document.querySelectorAll("input")].some((i) => i.value === secret), SECRET), false, `${tag}: no field holds the key`);
    // The service account's token, replaced at the foot: where keys come from.
    await press(section.locator(".routing-sources").getByRole("button", { name: w.replaceToken }));
    await section.getByLabel(w.token, { exact: true }).fill(TOKEN);
    await clean("while the token is typed");
    await press(section.locator(".routing-op").getByRole("button", { name: w.save, exact: true }));
    await section.getByRole("button", { name: w.replaceToken }).waitFor({ timeout: 10_000 });
    await clean("once the token is kept");
    await section.locator(".routing-sources").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await layout("after the edits");
    await shot("ordinary-sources");
    const own = report.writes.filter((x) => x.tag === undefined && (x.tag = tag));
    assert.deepEqual(own.map((x) => `${x.method} ${x.path}`), ["PUT /api/routing/keys/deepseek", "PUT /api/routing/1password/token"], `${tag}: these writes only`);
    assert.deepEqual(own[0].body, { source: "local", provider: "deepseek", value: SECRET });
    assert.deepEqual(own[1].body, { value: TOKEN });
    check(`${tag}: an ordinary Workspace: five cards in order, each count and two layers; a key and the token kept only in their own writes`);

    // ---- A new Workspace: only what is set up; the others to open.
    await openAccounts("fresh");
    await section.locator(".routing-others").waitFor({ timeout: 15_000 });
    assert.deepEqual(await cards(), ["openai"], `${tag}: new Agents and review use Codex's host login`);
    assert.deepEqual((await section.locator(".routing-others button").allInnerTexts()).map((s) => s.trim()), w.others);
    assert.equal((await section.locator(".routing-notices p").innerText()).trim(), w.routingOff);
    await layout("a new Workspace");
    await shot("fresh");
    await press(section.locator(".routing-others").getByRole("button", { name: "DeepSeek", exact: true }));
    const opened = section.locator('.routing-provider[data-provider="deepseek"]');
    await opened.waitFor({ timeout: 10_000 });
    assert.match((await opened.locator(".routing-no-login").innerText()).trim(), w.noLogin);
    assert.equal((await opened.locator('.routing-add-key .settings-row-help').innerText()).trim(), w.noKey);
    await layout("a provider opened");
    await shot("fresh-opened");
    check(`${tag}: a new Workspace shows only what is set up; another provider opens empty`);

    // ---- The routing order can't be read: said, every known card shown, nothing counted as no reference.
    await openAccounts("policyFailed");
    await section.locator(".routing-notices").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector('.routing-keys [role="status"]:not(.routing-notices)'), null, { timeout: 15_000 });
    assert.equal((await section.locator(".routing-notices p").innerText()).trim(), w.unread);
    assert.deepEqual(await cards(), ["anthropic", "openai", "deepseek"], `${tag}: every known card, no OpenCode one without the routing`);
    assert.ok((await section.locator(".routing-refs.is-none").allInnerTexts()).every((s) => s.trim() === w.unsure), `${tag}: a row with none says not all read`);
    await layout("the routing unreadable");
    await shot("policy-failed");
    check(`${tag}: the routing order unreadable is said, and no card is hidden`);

    // ---- The accounts' read fails: Claude's and OpenAI's cards keep the error and Read again.
    await openAccounts("accountsFailed");
    await section.locator(".routing-codex .inline-error").waitFor({ timeout: 15_000 });
    assert.deepEqual(await cards(), ["anthropic", "openai", "deepseek", "openrouter", "*"]);
    assert.deepEqual((await section.locator(".routing-cswap .inline-error, .routing-codex .inline-error").allInnerTexts()).map((s) => s.trim()), [w.failed, w.failed]);
    assert.equal(await section.locator(".routing-cswap").getByRole("button", { name: w.reread }).isEnabled(), true);
    assert.equal(await section.locator(".routing-codex").getByRole("button", { name: w.reread }).isEnabled(), true);
    await section.locator('.routing-provider[data-provider="anthropic"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await layout("the accounts unreadable");
    await shot("accounts-failed");
    check(`${tag}: the accounts unreadable: both cards with the error and Read again`);
    check(`${tag}: page fits, nothing covered or overlapping${phone ? ", 40 px targets" : ""}; accounts by number and fingerprint only`);
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
