// YN-119 W1: DeepSeek Harness (dsh) in the web. It is offered only while
// Core says it starts it (`dsh.available` of /api/workspace); a new dsh
// Agent runs on the Core host with a DeepSeek key and one of the three levels
// dsh keeps, never Read only; its settings send the model, an effort of
// off/low/high/max and the level; routing gives it a DeepSeek key only; and
// Codex's own panels are named for Codex, so no other harness falls into
// them. Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "dsh-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${src("RemoteCreateAgent.tsx")};
import {AgentSettings} from ${src("AgentSettings.tsx")};
import {DshContext} from ${src("dsh.ts")};
import {MODEL_HINTS, credentialFits, effortsOf, harnessesOffered, keyFits} from ${src("executor-routing.ts")};
import {usesOf} from ${src("accounts-cards.ts")};
import {dshControls} from ${src("slash-commands.ts")};
import {harnessName, nativeSession} from ${src("machine-checks.ts")};
const root = createRoot(document.getElementById('root'));
window.renderCreate = (props) => root.render(<RemoteCreateAgent {...props}/>);
window.renderSettings = (props, dsh) => root.render(<DshContext.Provider value={dsh ?? null}><AgentSettings {...props}/></DshContext.Provider>);
window.rules = {MODEL_HINTS, credentialFits, effortsOf, harnessesOffered, keyFits, usesOf, dshControls, harnessName, nativeSession};`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "DshUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// Copied out of the page's realm: deepEqual compares prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/workspace" };
const studio = { id: "studio", name: "Studio", kind: "ssh", target: "dev@studio.example", defaultCwd: "/srv/work" };
const defaults = {
  saved: {},
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default" },
  effective: {
    harness: { value: "codex", source: "builtin" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
  },
};
const dshModels = [
  { id: "deepseek-flash", model: "deepseek-flash", displayName: "DeepSeek Flash", isDefault: true },
  { id: "deepseek-v4-pro", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
];
const key = (id, provider, rest = {}) => ({ id, provider, source: "local", set: true, setAt: "2026-11-14T00:00:00Z", ...rest });
const someKeys = [
  key("anthropic", "anthropic"),
  key("deepseek", "deepseek"),
  key("deepseek-team", "deepseek", { source: "1password", reference: "op://Synthetic/DeepSeek/credential" }),
];
const AVAILABLE = { available: true, version: "0.2.2-rc.3", label: null };

function mount({ keys = someKeys, language } = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.fetch = async (url, init = {}) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, method: init.method || "GET", body });
    const answer = (status, value) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
    if (url.includes("/agent-defaults")) return answer(200, defaults);
    if (url.endsWith("/machines")) return answer(200, { machines: [local, studio] });
    // The Agent's own routes first: its catalog's path also ends in /models.
    if (url.endsWith("/agents/ds/models")) return answer(200, { models: dshModels });
    if (url.endsWith("/agents/ds/settings")) return answer(200, { id: "ds", ...body });
    if (url.endsWith("/models?harness=dsh")) return answer(200, { models: dshModels });
    if (url.endsWith("/models?harness=claude")) return answer(200, { models: [] });
    if (url.endsWith("/models")) return answer(200, { models: [{ id: "gpt", model: "gpt", displayName: "GPT" }] });
    if (url.endsWith("/routing/keys")) return answer(200, { keys, onePasswordToken: { set: true } });
    if (url.endsWith("/agents") && init.method === "POST") return answer(200, { id: "new", ...body });
    return answer(200, {});
  };
  window.eval(bundle);
  const page = { window, document: window.document, calls, errors, created: [] };
  page.open = async (extra = {}) => {
    window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated: (agent) => page.created.push(agent), ...extra });
    await tick();
    await tick();
  };
  page.close = () => window.close();
  return page;
}
const group = (page, label) => page.document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const offered = (page, label) => [...(group(page, label)?.querySelectorAll("input") || [])].map((input) => input.value);
const labels = (page, label) => [...(group(page, label)?.querySelectorAll(".choice-chip-label") || [])].map((node) => node.textContent);
const picked = (page, label) => group(page, label)?.querySelector("input:checked")?.value;
const choice = (page, label, value) => group(page, label)?.querySelector(`input[value="${value}"]`);
async function pick(page, label, value) {
  choice(page, label, value).click();
  await tick();
}
async function type(page, label, text) {
  const node = [...page.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(label))?.querySelector("input");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
const createButton = (page) => page.document.querySelector(".remote-create .primary-button");
const posts = (page) => page.calls.filter((c) => c.method === "POST");
async function submit(page) {
  const before = posts(page).length;
  page.document.querySelector("form.remote-create").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => posts(page).length > before, "the create request");
  return posts(page).at(-1).body;
}

test("New agent offers DeepSeek Harness only while Core says it starts it", async () => {
  const page = mount();
  try {
    for (const dsh of [undefined, null, { available: false, version: "0.2.2-rc.3" }, {}]) {
      await page.open({ dsh });
      await until(() => offered(page, "Harness").length > 0, "the harness choices");
      assert.deepEqual(offered(page, "Harness"), ["codex", "claude"], `nothing for ${JSON.stringify(dsh)}`);
    }
    await page.open({ dsh: AVAILABLE });
    assert.deepEqual(offered(page, "Harness"), ["codex", "claude", "dsh"]);
    const chip = choice(page, "Harness", "dsh").closest("label");
    assert.equal(chip.querySelector(".choice-chip-label").textContent, "DeepSeek Harness");
    assert.equal(chip.querySelector("small").textContent, "0.2.2-rc.3", "the version Core found");
    // Chosen, then no longer offered: back to Codex, as an OpenCode choice goes.
    await pick(page, "Harness", "dsh");
    await page.open({ dsh: { available: false } });
    await until(() => picked(page, "Harness") === "codex", "Codex again");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a new DeepSeek Harness Agent runs on the Core host with a DeepSeek key and one of the three levels it keeps", async () => {
  const page = mount();
  try {
    await page.open({ dsh: { ...AVAILABLE, label: "Newer than the verified 0.2.2-rc.3." } });
    await until(() => offered(page, "Where to work").includes("studio"), "the machines");
    await pick(page, "Where to work", "studio");
    assert.equal(picked(page, "Where to work"), "studio");
    await pick(page, "Harness", "dsh");
    // The Core host only: back there, and SSH machines can't be chosen.
    assert.equal(picked(page, "Where to work"), "local");
    assert.ok(choice(page, "Where to work", "studio").disabled);
    assert.ok(page.document.querySelector(".choice-chip-action").disabled, "no machine added for it");
    // Its own models, from dsh on the Core host; its key from the Workspace's DeepSeek keys.
    await until(() => offered(page, "Model").includes("deepseek-v4-pro"), "dsh's models");
    assert.ok(page.calls.some((c) => c.url.endsWith("/models?harness=dsh")), "dsh's own catalog is read");
    assert.deepEqual(offered(page, "Model"), ["", "deepseek-flash", "deepseek-v4-pro"]);
    await until(() => group(page, "DeepSeek key"), "the keys");
    assert.deepEqual(offered(page, "DeepSeek key"), ["deepseek", "deepseek-team"], "DeepSeek's keys only");
    assert.equal(picked(page, "DeepSeek key"), "deepseek", "the first one, until another is chosen");
    assert.match(page.document.body.textContent, /it runs with this key from Settings → Accounts & keys/);
    // Its three levels, Ask you first unless chosen; never Read only, and none of Codex's or Claude's own.
    assert.deepEqual(offered(page, "Permissions"), ["ask", "auto", "full"]);
    assert.deepEqual(labels(page, "Permissions"), ["Ask you first", "Auto-approve", "Full access"]);
    assert.equal(picked(page, "Permissions"), "ask");
    assert.match(page.document.body.textContent, /Its network isn’t limited at any level, so Read only isn’t offered/);
    assert.match(page.document.querySelector(".create-dsh-note").textContent, /its session log isn’t uploaded.*Newer than the verified 0\.2\.2-rc\.3\.$/,
      "what it is, and Core's note of its version");

    await pick(page, "DeepSeek key", "deepseek-team");
    await pick(page, "Permissions", "auto");
    await pick(page, "Model", "deepseek-v4-pro");
    await type(page, "Name", "Dune");
    const body = await submit(page);
    assert.deepEqual(plain(body), {
      name: "Dune", cwd: "/workspace", machineId: "local", harness: "dsh", model: "deepseek-v4-pro",
      permissionLevel: "auto", runtimeProfile: { kind: "apiKey", keyId: "deepseek-team" },
    });
    await until(() => page.created.length === 1, "the Agent Core made");

    // Ask you first, sent as such, when nothing else is chosen.
    await pick(page, "Harness", "codex");
    await pick(page, "Harness", "dsh");
    await until(() => group(page, "DeepSeek key"), "the keys again");
    assert.equal(picked(page, "DeepSeek key"), "deepseek-team", "a key chosen stays while it is there");
    await type(page, "Name", "Dune 2");
    const second = await submit(page);
    assert.equal(second.permissionLevel, "ask");
    assert.equal(second.model, undefined, "dsh's own default model");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("without a DeepSeek key that is set, the dialog says where to add one and creates nothing", async () => {
  const page = mount({ keys: [key("anthropic", "anthropic"), key("deepseek-old", "deepseek", { set: false })] });
  try {
    await page.open({ dsh: AVAILABLE });
    await until(() => offered(page, "Harness").includes("dsh"), "dsh offered");
    await pick(page, "Harness", "dsh");
    await until(() => page.document.querySelector(".create-dsh-no-key"), "the missing key");
    assert.equal(page.document.querySelector(".create-dsh-no-key").textContent,
      "DeepSeek Harness needs a DeepSeek key: add one in Settings → Accounts & keys.");
    const old = choice(page, "DeepSeek key", "deepseek-old");
    assert.ok(old.disabled, "a key not set can't be chosen");
    assert.equal(old.closest("label").querySelector("small").textContent, "not set");
    await type(page, "Name", "Dune");
    assert.ok(createButton(page).disabled, "nothing to create with");
    page.document.querySelector("form.remote-create").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(posts(page).length, 0, "no request");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("the dialog's DeepSeek Harness words in Chinese", async () => {
  const page = mount({ language: "zh-Hans" });
  try {
    await page.open({ dsh: AVAILABLE });
    await until(() => offered(page, "Harness").includes("dsh"), "dsh offered");
    await pick(page, "Harness", "dsh");
    await until(() => group(page, "DeepSeek key"), "the keys");
    assert.deepEqual(labels(page, "权限"), ["先问你", "自动审批", "完全放开"]);
    const text = page.document.body.textContent;
    assert.match(text, /DeepSeek Harness 在这里没有自己的登录：它用「设置 → 账号与密钥」里的这个 key 运行。/);
    assert.match(text, /它在任何级别都不限网络，所以不提供只读。/);
    assert.match(text, /请求里也不附带会话日志/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a DeepSeek Harness Agent's settings send its model, effort and level, and nothing of Codex's", async () => {
  const agent = { id: "ds", name: "Dune", harness: "dsh", model: "deepseek-flash", settings: { reasoningEffort: "high", permissionLevel: "auto" },
    dshVersion: "0.2.2-rc.3", status: "idle", connectionState: "connected", cwd: "/workspace" };
  const page = mount();
  const saved = () => page.calls.filter((c) => c.url.endsWith("/agents/ds/settings")).map((c) => plain(c.body));
  const save = async () => {
    page.document.querySelector(".agent-settings-form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick(); await tick();
  };
  try {
    page.window.renderSettings({ agent, onSaved() {} }, { ...AVAILABLE, label: "Newer than the verified 0.2.2-rc.3." });
    await tick();
    const opener = page.document.querySelector(".agent-settings-button");
    assert.equal(opener.textContent.trim(), "Model & reasoning");
    opener.click(); await tick(); await tick();
    const dialog = page.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /keeps Ask you first, Auto-approve and Full access, never Read only/);
    assert.ok(page.calls.some((c) => c.url.endsWith("/agents/ds/models")), "its own dsh's models are read");
    await until(() => offered(page, "Model").includes("deepseek-v4-pro"), "its models");
    assert.deepEqual(offered(page, "Model"), ["", "deepseek-flash", "deepseek-v4-pro"]);
    assert.equal(picked(page, "Model"), "deepseek-flash");
    assert.deepEqual(offered(page, "Reasoning effort"), ["", "off", "low", "high", "max"]);
    assert.equal(picked(page, "Reasoning effort"), "high");
    assert.deepEqual(offered(page, "Permissions"), ["ask", "auto", "full"]);
    assert.equal(picked(page, "Permissions"), "auto");
    assert.match(dialog.textContent, /anything beyond it is refused without asking you/);
    assert.equal(page.document.querySelectorAll('[role="radiogroup"][aria-label="Permissions"]').length, 1, "its levels alone");
    assert.equal(page.document.querySelector(".codex-permissions"), null, "no Codex permissions");
    assert.equal(page.document.querySelector(".codex-context-settings"), null, "no Codex context settings");
    assert.equal(group(page, "Approvals"), null, "no Claude approvals");
    assert.equal(page.document.querySelector(".dsh-version-note").textContent,
      "DeepSeek Harness 0.2.2-rc.3 on the Core host. Newer than the verified 0.2.2-rc.3.");

    await pick(page, "Model", "deepseek-v4-pro");
    assert.equal(picked(page, "Reasoning effort"), "high", "the effort stays with another model");
    await pick(page, "Reasoning effort", "max");
    await pick(page, "Permissions", "full");
    await save();
    assert.deepEqual(saved().at(-1), { model: "deepseek-v4-pro", effort: "max", permissionLevel: "full" });

    // DeepSeek's default effort, and a saved level it doesn't keep read as Ask you first.
    page.window.renderSettings({ agent: { ...agent, settings: { reasoningEffort: null, permissionLevel: "read-only" } }, onSaved() {} }, AVAILABLE);
    await tick();
    page.document.querySelector(".agent-settings-button").click(); await tick(); await tick();
    await until(() => offered(page, "Model").includes("deepseek-v4-pro"), "its models again");
    assert.equal(picked(page, "Reasoning effort"), "");
    assert.equal(picked(page, "Permissions"), "ask");
    await save();
    assert.deepEqual(saved().at(-1), { model: "deepseek-flash", effort: null, permissionLevel: "ask" });
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("routing, keys, names and controls take DeepSeek Harness as its own", () => {
  const page = mount();
  try {
    const r = page.window.rules;
    assert.deepEqual(plain(r.harnessesOffered(false)), ["claude", "codex", "opencode"], "not while Core doesn't start it");
    assert.deepEqual(plain(r.harnessesOffered(true)), ["claude", "codex", "opencode", "dsh"]);
    assert.deepEqual(plain(r.harnessesOffered(false, "dsh")), ["claude", "codex", "opencode", "dsh"], "a candidate saved with it stays shown");
    assert.ok(r.keyFits("dsh", "deepseek"));
    assert.ok(!r.keyFits("dsh", "anthropic") && !r.keyFits("dsh", "openai"), "a DeepSeek key only");
    assert.ok(r.keyFits("opencode", "deepseek"), "OpenCode keeps its keys");
    assert.ok(!r.credentialFits("dsh", { kind: "login" }), "no login of its own");
    assert.ok(r.credentialFits("dsh", { kind: "apiKey", keyId: "deepseek" }));
    assert.ok(!r.credentialFits("dsh", { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" }));
    assert.deepEqual(plain(r.effortsOf("dsh")), ["off", "low", "high", "max"]);
    assert.deepEqual(plain(r.effortsOf("codex")), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(plain(r.effortsOf("claude")), []);
    assert.equal(r.MODEL_HINTS.dsh[0], "deepseek-flash", "its default model first");
    assert.equal(r.harnessName("dsh"), "DeepSeek Harness");
    assert.equal(r.nativeSession({ harness: "dsh", dshSessionId: "acp-1", threadId: "thread-x" }), "acp-1");
    assert.deepEqual([...r.dshControls.commands].map((c) => c.name), ["model", "permissions", "new"], "Yuzuno's own controls only");
    // Accounts & keys: a dsh candidate's key is counted on DeepSeek's card; one saved with a login lacks its key,
    // which the routing page says, rather than being a credential this version can't tell.
    const { uses, unmapped, complete } = r.usesOf({
      candidates: [
        { id: "a", enabled: true, harness: "dsh", model: "deepseek-v4-pro", credential: { kind: "apiKey", keyId: "deepseek" } },
        { id: "b", enabled: true, harness: "dsh", model: "deepseek-flash", credential: { kind: "login" } },
      ],
      routingOn: true, agentHarness: "codex", reviewer: { harness: "codex", model: "gpt" }, keyIds: ["deepseek"],
    }, (c) => c.id);
    assert.deepEqual(plain([...uses.get("key:deepseek")].map((u) => u.id)), ["a"]);
    assert.equal(unmapped.length, 0);
    assert.ok(complete);
  } finally { page.close(); }
});

test("Codex's own panels and dialogs are named for Codex, not for whatever isn't Claude or OpenCode", async () => {
  const app = await readFile(path.join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(app, /!isClaude && !isOpenCode/, "a fourth harness would fall into Codex's panels");
  assert.match(app, /const isCodex = !!agent && \(!agent\.harness \|\| agent\.harness === "codex"\);/, "an Agent from before harnesses were named ran Codex");
  for (const panel of ["CodexPlanChip", "CodexPlanUsage", "CodexMcpStatus", "CodexGoalDialog", "CodexPlanDialog", "CodexReviewDialog",
    "CodexChangesDialog", "CodexTerminalsDialog", "CodexDiffDialog", "ForkCodexDialog", "CodexWriterNotice"]) {
    const at = app.indexOf(`<${panel}`);
    assert.ok(at > 0, panel);
    assert.match(app.slice(Math.max(0, at - 160), at), /isCodex/, `${panel} is Codex's`);
  }
});
