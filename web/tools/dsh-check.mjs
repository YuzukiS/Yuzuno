// YN-119 W1: DeepSeek Harness (dsh) in Chromium, against a disposable
// fixture server (no Core) whose /api/workspace says Core starts dsh
// (`dsh {available, version, label}`). Desktop 1280 px, English and Chinese:
//  - New agent offers DeepSeek Harness; chosen, it runs on the Core host
//    with a DeepSeek key and one of Ask you first, Auto-approve and Full
//    access (never Read only), and Create sends that;
//  - a dsh Agent's settings offer its models, an effort of off/low/high/max
//    and the three levels, and Save sends the model, effort and level.
// Synthetic Agents, keys and folders only.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/dsh-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "YUZUNO_BROWSER_OUTPUT: where screenshots and the report go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });

const base = {
  cwd: "/fixture/project", color: "sage", goal: "", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, status: "idle", connectionState: "connected",
};
const agents = [
  { ...base, id: "ds", name: "Dune", harness: "dsh", model: "deepseek-flash", dshSessionId: "acp-fixture", dshVersion: "0.2.2-rc.3",
    settings: { reasoningEffort: "high", permissionLevel: "auto" } },
  { ...base, id: "cx", name: "Mori", harness: "codex", model: "codex-fixture", threadId: "thread-cx",
    settings: { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" } },
];
const dsh = { available: true, version: "0.2.2-rc.3", label: null };
const dshModels = { models: [
  { id: "deepseek-flash", model: "deepseek-flash", displayName: "DeepSeek Flash", isDefault: true },
  { id: "deepseek-v4-pro", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
] };
const keys = { keys: [
  { id: "anthropic", provider: "anthropic", source: "local", set: true, setAt: "2026-11-14T00:00:00Z" },
  { id: "deepseek", provider: "deepseek", source: "local", set: true, setAt: "2026-11-14T00:00:00Z" },
  { id: "deepseek-team", provider: "deepseek", source: "1password", set: true, setAt: "2026-11-14T00:00:00Z", reference: "op://Synthetic/DeepSeek/credential" },
], onePasswordToken: { set: true } };
const defaults = {
  saved: {}, builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
  effective: {
    harness: { value: "codex", source: "builtin" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
  },
};
const calls = [];
const report = { checks: [], screenshots: [], errors: [], console: [], requests: [] };
const check = (name) => {
  report.checks.push(name);
  console.log(`ok - ${name}`);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname + url.search, ...(body !== undefined ? { body } : {}) });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture\n\n");
      return;
    }
    const [, , kind, id, action] = url.pathname.split("/");
    const agent = kind === "agents" ? agents.find((a) => a.id === id) : undefined;
    if (url.pathname === "/api/workspace")
      return send(200, { agents, runtime: { connected: true }, defaultCwd: "/fixture/project", workspace: { id: "ws-dsh" }, projects: [], dsh });
    if (url.pathname === "/api/machines") return send(200, { machines: [
      { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" },
      { id: "studio", name: "Studio", kind: "ssh", target: "dev@studio.example", defaultCwd: "/srv/work" },
    ] });
    if (url.pathname === "/api/home") return send(200, { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] });
    if (url.pathname === "/api/agent-defaults") return send(200, defaults);
    if (url.pathname === "/api/models" && url.searchParams.get("harness") === "dsh") return send(200, dshModels);
    if (url.pathname === "/api/models") return send(200, { models: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Codex fixture" }] });
    if (url.pathname === "/api/routing/keys") return send(200, keys);
    if (url.pathname === "/api/agents" && req.method === "POST") return send(400, { error: "Fixture: nothing is created here." });
    if (agent && action === "models") return send(200, agent.harness === "dsh" ? dshModels : { models: [] });
    if (agent && action === "settings") return send(200, { ...agent, model: body?.model ?? agent.model });
    if (agent && action) return send(404, { error: "Not served by this fixture" });
    if (agent)
      return send(200, {
        agent, pending: [], artifacts: [],
        turns: [{ id: `${id}-turn`, status: "completed",
          items: [{ id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "Please tidy the fixture notes." }] },
            { id: `${id}-reply`, type: "agentMessage", text: `Saved reply from ${agent.name}` }] }],
      });
    return send(200, {});
  }
  const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  const file = path.startsWith(dist + sep) ? await readFile(path).catch(() => null) : null;
  const served = file ?? (await readFile(resolve(dist, "index.html")));
  res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[file ? extname(path) : ".html"] || "application/octet-stream" });
  res.end(served);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function shot(target, page, name) {
  await page.waitForTimeout(300);
  await target.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  assert.equal(await page.locator("#app-recovery-title").count(), 0, `${name}: the app fell to its error screen: ${JSON.stringify(report.console)}`);
}
async function open(language) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: "reduce", locale: language === "zh-Hans" ? "zh-CN" : "en-US" });
  await context.addInitScript((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
  await page.goto(origin);
  await page.locator('.agent-row[data-agent-id="ds"]').waitFor();
  return { context, page };
}
const W = {
  en: { permissions: "Permissions", levels: ["Ask you first", "Auto-approve", "Full access"], effort: "Reasoning effort", harness: "Harness", model: "Model", where: "Where to work" },
  "zh-Hans": { permissions: "权限", levels: ["先问你", "自动审批", "完全放开"], effort: "推理强度", harness: "Harness", model: "模型", where: "工作位置" },
};
const dialog = (page) => page.locator('[role="dialog"]');
const radios = (scope, label) => scope.locator(`[role="radiogroup"][aria-label="${label}"]`);
const values = (scope, label) => radios(scope, label).locator("input").evaluateAll((inputs) => inputs.map((i) => i.value));
const chipLabels = (scope, label) => radios(scope, label).locator(".choice-chip-label").allTextContents();
const checked = (scope, label) => radios(scope, label).locator("input:checked").evaluate((i) => i.value);
const choose = (scope, label, value) => radios(scope, label).locator(`label.choice-chip[data-value="${value}"]`).click();

let failed = null;
try {
  for (const language of ["en", "zh-Hans"]) {
    const t = W[language];
    const tag = language === "en" ? "en" : "zh";
    const { context, page } = await open(language);

    // New agent, DeepSeek Harness chosen.
    await page.locator("button.add-agent").click();
    const create = dialog(page);
    await create.waitFor();
    assert.deepEqual(await values(create, t.harness), ["codex", "claude", "dsh"]);
    await create.locator(".remote-create input[required]").first().fill("Dune");
    await choose(create, t.harness, "dsh");
    await radios(create, "DeepSeek key").waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [aria-label] input[value="deepseek-v4-pro"]').length > 0);
    assert.deepEqual(await values(create, "DeepSeek key"), ["deepseek", "deepseek-team"]);
    assert.equal(await checked(create, "DeepSeek key"), "deepseek");
    assert.deepEqual(await values(create, t.permissions), ["ask", "auto", "full"]);
    assert.deepEqual(await chipLabels(create, t.permissions), t.levels);
    assert.equal(await checked(create, t.permissions), "ask");
    assert.ok(await radios(create, t.where).locator('input[value="studio"]').isDisabled(), "SSH can't be chosen");
    await choose(create, "DeepSeek key", "deepseek-team");
    await choose(create, t.permissions, "auto");
    await shot(create, page, `new-agent-dsh-${tag}`);
    const before = calls.length;
    await create.locator(".remote-create .primary-button").click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] .kept-error:not(.is-empty)'));
    const sent = calls.slice(before).find((c) => c.method === "POST" && c.path === "/api/agents");
    assert.deepEqual(sent?.body, { name: "Dune", cwd: "/fixture/project", machineId: "local", harness: "dsh",
      permissionLevel: "auto", runtimeProfile: { kind: "apiKey", keyId: "deepseek-team" } });
    check(`${tag}: New agent offers DeepSeek Harness; chosen, it is on the Core host with a DeepSeek key and Ask you first / Auto-approve / Full access, and Create sends them`);
    await page.keyboard.press("Escape");
    await create.waitFor({ state: "detached" });

    // The dsh Agent's settings.
    await page.locator('.agent-row[data-agent-id="ds"] .agent-select').click();
    await page.locator(".agent-settings-button").first().click();
    const settings = dialog(page);
    await settings.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] input[value="deepseek-v4-pro"]').length > 0);
    assert.deepEqual(await values(settings, t.effort), ["", "off", "low", "high", "max"]);
    assert.equal(await checked(settings, t.effort), "high");
    assert.deepEqual(await values(settings, t.permissions), ["ask", "auto", "full"]);
    assert.equal(await checked(settings, t.permissions), "auto");
    assert.equal(await settings.locator(".codex-permissions, .codex-context-settings").count(), 0, "nothing of Codex's");
    await shot(settings, page, `settings-dsh-${tag}`);
    const posted = calls.length;
    await choose(settings, t.model, "deepseek-v4-pro");
    await choose(settings, t.effort, "max");
    await choose(settings, t.permissions, "full");
    await settings.locator(".agent-settings-form .primary-button").click();
    await settings.waitFor({ state: "detached" });
    const saved = calls.slice(posted).find((c) => c.method === "POST" && c.path === "/api/agents/ds/settings");
    assert.deepEqual(saved?.body, { model: "deepseek-v4-pro", effort: "max", permissionLevel: "full" });
    check(`${tag}: a dsh Agent's settings offer its models, off/low/high/max and the three levels, and Save sends the model, effort and level`);
    await context.close();
  }
  assert.deepEqual(report.errors, [], "no page errors");
} catch (error) {
  failed = error;
} finally {
  report.requests = calls.map((c) => `${c.method} ${c.path}`);
  if (failed) report.failure = String(failed?.stack ?? failed);
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  server.close();
}
if (failed) throw failed;
console.log(`dsh check: ${report.checks.length} checks, ${report.screenshots.length} screenshots`);
