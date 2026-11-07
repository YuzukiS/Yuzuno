import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// An in-memory component bundle: no Core, browser, SSH or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "machines-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {MachinesPage, LastCheck} from ${JSON.stringify(path.join(root, "src/MachinesPage.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderMachines=(props)=>root.render(<MachinesPage {...props}/>);
window.renderCheck=(props)=>root.render(<LastCheck {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "MachinesUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const local = { id: "local", name: "Core host", kind: "local", defaultCwd: "/home/me/work", lastCheck: null };
const mini = {
  id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", codex: "/opt/homebrew/bin/codex",
  defaultCwd: "/Users/me/projects",
  lastCheck: { machineId: "mini", startedAt: iso(3 * 3600e3), checkedAt: iso(3 * 3600e3), durationMs: 10012,
    reachable: false, error: "ssh: connect to host mac-mini port 22: Operation timed out",
    harnesses: [{ harness: "claude", supported: false, found: false }] },
};
const agent = (id, name, extra) => ({
  id, name, cwd: "/home/me/work", model: "", color: "sage", status: "idle", createdAt: "", updatedAt: "",
  goal: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, ...extra,
});
const agents = [
  agent("a", "Mori", { status: "working", projectId: "p-app" }),
  agent("b", "Hana", { status: "offline", closedAt: "2026-10-12" }),
  agent("c", "Kaze", { cwd: "/Users/me/projects/x", remote: { machine: { ...mini, lastCheck: undefined } },
    connectionState: "disconnected" }),
];
const projects = [{ id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }];

function mount(handler) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const answer = await handler?.(url, init);
    if (answer?.status) return answer;
    const body = answer ?? (url.endsWith("/machines") ? { machines: [local, mini] } : {});
    const text = JSON.stringify(body);
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const card = (page, id) => page.document.querySelector(`[data-machine-id="${id}"]`);
// Settings › Machines lists the machines first (YN-8 S3); a row opens that
// machine's page, Back returns to the list.
const row = (page, id) => page.document.querySelector(`[data-machine-row="${id}"]`);
async function loaded(page) {
  const deadline = Date.now() + 3000;
  while (!row(page, "mini") && Date.now() < deadline) await tick(20);
  assert.ok(row(page, "mini"), "machines loaded");
}
async function show(page, id) {
  if (card(page, id)) return card(page, id);
  page.document.querySelector(".settings-machines .settings-crumb")?.click();
  await until(() => row(page, id), `the ${id} row`);
  row(page, id).click();
  await until(() => card(page, id), `${id}'s page`);
  return card(page, id);
}
// Waits for what a step should lead to, not for a fixed time; fails if it
// never happens.
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await tick(10);
  }
}
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.includes(text));
function render(page, props = {}) {
  const opened = [];
  page.window.renderMachines({ open: true, onOpenChange() {}, agents, projects, revision: 0,
    onOpenAgent: (id) => opened.push(id), ...props });
  return opened;
}

test("machines list their stored checks honestly and their agents' live state separately", async () => {
  const page = mount();
  try {
    render(page);
    await loaded(page);
    // The list says each machine's kind and last check, and how many Agents are there.
    assert.match(row(page, "local").textContent, /Core host.*Local · runs your Workspace Core.*Not checked yet.*2 Agents/);
    assert.match(row(page, "mini").textContent, /Mac mini.*SSH · mac-mini.*Couldn’t reach.*1 Agent/);
    const host = await show(page, "local");
    assert.match(host.textContent, /Local · runs your Workspace Core/);
    assert.match(host.querySelector(".last-check").textContent, /Not checked yet/);
    // Agents are grouped by where they run, with their own current state.
    assert.match(host.querySelector(".machine-agents").textContent, /Mori.*App.*Working/);
    assert.match(host.querySelector(".machine-agents").textContent, /Hana.*Closed/);
    const remote = await show(page, "mini");
    const check = remote.querySelector(".last-check").textContent;
    assert.match(check, /Couldn’t reach/);
    assert.match(check, /Last check 3 h ago/);
    assert.match(check, /May be out of date/);
    assert.match(check, /Operation timed out/);
    assert.match(check, /Claude Code · Core host only/);
    assert.doesNotMatch(page.document.body.textContent, /\bonline\b/i, "a check is never presented as live status");
    assert.match(remote.querySelector(".machine-agents").textContent, /Kaze.*Ready · Not connected/);
    // A small tile each: name, project and state; the folder is in its tip, not on the page.
    const kaze = [...remote.querySelectorAll(".machine-agent")].find((b) => b.textContent.includes("Kaze"));
    assert.equal(kaze.title, "Open Kaze\n/Users/me/projects/x");
    assert.doesNotMatch(remote.querySelector(".machine-agents").textContent, /\/Users\/me/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// YN-8 S3: a request opens Settings › Machines at a machine's page (the
// Core host's has its Job budget, T-55) or at Add SSH machine; Back returns
// to the list, which chooses none.
test("a request opens a machine's page, the Core host's with its Job budget, or Add SSH machine", async () => {
  const page = mount((url) => (url.endsWith("/jobs/budget") ? { budget: null } : undefined));
  try {
    render(page, { initialMachineId: "local", initialBlock: "jobs" });
    await until(() => card(page, "local"), "the Core host's page");
    const title = () => page.document.querySelector("#settings-machines-title").textContent;
    assert.equal(title(), "Core host");
    assert.equal(page.document.querySelector(".settings-machines .settings-current").textContent, "This PC");
    assert.match(page.document.querySelector(".settings-machines .settings-section-heading p").textContent, /can’t be removed; its Job budget is the Core host’s/);
    const jobs = page.document.querySelector("#settings-block-jobs");
    assert.ok(jobs?.querySelector("#settings-jobs-budget"), "the Core host's Job budget is on its page");
    assert.ok(page.calls.some((c) => c.url.endsWith("/jobs/budget")), "and reads it");
    page.document.querySelector(".settings-machines .settings-crumb").click();
    await until(() => row(page, "mini"), "the list");
    assert.equal(title(), "Machines");
    assert.equal(page.document.querySelector("#settings-block-jobs"), null, "the list has no budget");
    assert.equal(card(page, "local"), null, "no machine is chosen in the list");
    await show(page, "mini");
    assert.equal(page.document.querySelector("#settings-block-jobs"), null, "an SSH machine's Jobs are in its own editor");
    assert.equal(page.document.querySelector(".settings-machines .settings-current").textContent, "SSH");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
  const adding = mount();
  try {
    render(adding, { initialMachineId: "new" });
    await until(() => adding.document.querySelector("#machines-new-ssh"), "the new machine form");
    assert.equal(adding.document.querySelector("#settings-machines-title").textContent, "Add SSH machine");
    assert.deepEqual(adding.errors, []);
  } finally {
    adding.close();
  }
});

test("testing a machine stores and shows the new result, and opening an agent leaves the page", async () => {
  let release;
  const page = mount((url, init) =>
    url.endsWith("/machines/local/check") && init.method === "POST"
      ? new Promise((resolve) => {
          release = () => resolve({ machineId: "local", startedAt: iso(0), checkedAt: iso(0), durationMs: 30,
            reachable: true, host: { hostname: "wsl-box", platform: "Linux", home: "/home/me" },
            harnesses: [{ harness: "codex", supported: true, found: true, version: "codex-cli 0.162.1" },
              { harness: "claude", supported: true, found: false, error: "Claude Code was not found on Core's PATH" }],
            defaultFolder: { path: "/home/me/work", resolved: "/home/me/work" } });
        })
      : undefined,
  );
  try {
    const opened = render(page);
    await loaded(page);
    const host = await show(page, "local");
    button(host, "Test connection").click();
    await until(() => button(host, "Checking…"), "the check to start");
    assert.ok(button(host, "Checking…").disabled, "one check at a time per machine");
    release();
    await until(
      () => /Reached wsl-box/.test(host.querySelector(".last-check").textContent) && button(host, "Test connection")?.disabled === false,
      "the check's result, with the button back",
    );
    const shown = host.querySelector(".last-check").textContent;
    assert.match(shown, /Reached wsl-box/);
    assert.match(shown, /Last check just now/);
    assert.doesNotMatch(shown, /out of date/);
    assert.match(shown, /Codex found · codex-cli 0.162.1/);
    assert.match(shown, /Claude Code unavailable/);
    assert.match(shown, /Claude Code: Claude Code was not found on Core's PATH/);
    assert.equal(host.querySelector(".harness-chip.found").title, "The CLI answered --version. Sign-in is not checked.");
    button(host.querySelector(".machine-agents"), "Mori").click();
    assert.deepEqual(opened, ["a"]);
    // Back in the list, the other machine keeps its own result.
    assert.match((await show(page, "mini")).querySelector(".last-check").textContent, /Couldn’t reach/, "other machines keep their own result");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("the Core host's Claude Code sign-in check: signed in, unknown, and signed out with where to sign in", async () => {
  const hint = "Claude Code on the Core host (lab_host) is not signed in for Core: `claude auth status`, run as Core runs it, reports not logged in (auth method: none).";
  const claude = { harness: "claude", supported: true, executable: "/usr/bin/claude", version: "2.1.295 (Claude Code)" };
  let answer = { ...claude, found: true, signIn: { state: "signedIn", method: "claude.ai" } };
  const page = mount((url) => url.endsWith("/machines")
    ? { machines: [{ ...local, lastCheck: { machineId: "local", startedAt: iso(5e3), checkedAt: iso(5e3), durationMs: 30,
      reachable: true, host: { hostname: "lab_host", platform: "Linux", home: "/home/me" }, harnesses: [answer] } }, mini] }
    : undefined);
  const chip = () => card(page, "local").querySelector(".harness-chip");
  try {
    render(page);
    await loaded(page);
    await show(page, "local");
    assert.equal(chip().textContent, "Claude Code found · 2.1.295 (Claude Code)");
    assert.equal(chip().title, "The CLI answered --version and reports it is signed in (claude.ai).");
    // A check that could not tell stays usable and says why, never "not signed in".
    answer = { ...claude, found: true, signIn: { state: "unknown", detail: "`claude auth status` did not answer within 15s" } };
    render(page, { revision: 1 });
    await until(() => /could not be checked/.test(chip().title), "the unknown answer");
    assert.equal(chip().title, "The CLI answered --version. Whether it is signed in could not be checked: `claude auth status` did not answer within 15s");
    assert.ok(chip().classList.contains("found"));
    assert.doesNotMatch(card(page, "local").querySelector(".last-check").textContent, /not signed in/);
    // Signed out: unavailable, and the reason names where and how to sign in.
    answer = { ...claude, found: false, error: hint, signIn: { state: "signedOut", method: "none" } };
    render(page, { revision: 2 });
    await until(() => /unavailable/.test(chip().textContent), "the signed-out answer");
    assert.equal(card(page, "local").querySelector(".last-check-error").textContent, `Claude Code: ${hint}`);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a failed request keeps the stored result, and a workspace change reloads the list", async () => {
  let checkedElsewhere = false;
  const page = mount((url, init) => {
    if (url.endsWith("/machines/mini/check") && init.method === "POST")
      return { ok: false, status: 500, json: async () => ({}), text: async () => JSON.stringify({ error: "Core restarted" }) };
    if (url.endsWith("/machines") && checkedElsewhere)
      return { machines: [{ ...local, lastCheck: { machineId: "local", startedAt: iso(60e3), checkedAt: iso(60e3),
        durationMs: 9, reachable: true, harnesses: [] } }, mini] };
    return undefined;
  });
  try {
    render(page);
    await loaded(page);
    await show(page, "mini");
    button(card(page, "mini"), "Test connection").click();
    await until(
      () => /Core restarted/.test(card(page, "mini").querySelector('[role="alert"]')?.textContent || "")
        && button(card(page, "mini"), "Test connection")?.disabled === false,
      "the failed check's error, with the button back",
    );
    assert.match(card(page, "mini").querySelector(".last-check").textContent, /3 h ago/, "the stored result is not replaced");
    // Another window checked the Core host; Core broadcasts a change.
    checkedElsewhere = true;
    render(page, { revision: 1 });
    await show(page, "local");
    await until(() => /Last check 1 min ago/.test(card(page, "local").querySelector(".last-check").textContent), "the reloaded list");
    assert.equal(page.calls.filter((c) => c.url.endsWith("/machines")).length, 2);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// The add form's fields, or a machine's own on its page (YN-8).
const fieldLabels = (page) => [...page.document.querySelectorAll(".remote-machine-editor label, .machine-settings label")];
function type(page, label, value) {
  const input = fieldLabels(page).find((l) => l.textContent.trim().startsWith(label)).querySelector("input");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
const field = (page, label) => fieldLabels(page).find((l) => l.textContent.trim().startsWith(label))?.querySelector("input").value;
// A slider on a machine's page (YN-8), by its name: its value, or moved as a user drags it.
const slider = (page, label) => page.document.querySelector(`.machine-settings input[type=range][aria-label="${label}"]`);
function slide(page, label, value) {
  const input = slider(page, label);
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, String(value));
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
// The page's save bar, when it is shown.
const saveBar = (page) => [...page.document.querySelectorAll(".settings-savebar")].find((bar) => !bar.hidden) ?? null;

test("SSH machines are added, edited and removed here; the Core host is only checked", async () => {
  let listed = [local, mini];
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines") && method === "POST") {
      listed = [...listed, { id: "studio", kind: "ssh", ...JSON.parse(init.body), lastCheck: null }];
      return listed.at(-1);
    }
    if (url.endsWith("/machines/mini") && method === "PUT") {
      listed = listed.map((m) => (m.id === "mini" ? { ...mini, ...JSON.parse(init.body), lastCheck: null } : m));
      return listed.find((m) => m.id === "mini");
    }
    if (url.endsWith("/machines")) return { machines: listed };
    return undefined;
  });
  try {
    render(page);
    await loaded(page);
    await show(page, "local");
    assert.ok(page.document.querySelector('[aria-label="Edit Core host"]') === null, "the Core host is not edited");
    assert.ok(page.document.querySelector('[aria-label="Remove Core host"]') === null, "nor removed");

    // Adding is a page of its own, from the list.
    page.document.querySelector(".settings-machines .settings-crumb").click();
    await until(() => row(page, "mini"), "the list");
    button(page.document, "Add SSH machine").click();
    await until(() => page.document.querySelector("#machines-new-ssh"), "the new machine form");
    type(page, "Machine name", "Studio");
    type(page, "SSH destination", "me@studio.local");
    type(page, "Default working folder", "/Users/me/studio");
    await tick();
    button(page.document, "Save machine").click();
    await until(() => card(page, "studio"), "the added machine's card");
    assert.deepEqual(page.calls.find((c) => c.method === "POST").body,
      { name: "Studio", target: "me@studio.local", codex: "codex", defaultCwd: "/Users/me/studio" });
    assert.ok(page.document.querySelector("#machines-new-ssh") === null, "the form closes");
    assert.equal(page.document.querySelector("#settings-machines-title").textContent, "Studio", "the new machine's page");

    // A machine's settings are its page's (YN-8): they start from what is
    // saved, are saved with the page's bar, and the list is read again after.
    await show(page, "mini");
    assert.equal(page.document.querySelector('[aria-label="Edit Mac mini"]'), null, "no Edit: the settings are on the page");
    await until(() => field(page, "SSH destination") === "mac-mini", "the settings, filled in");
    assert.equal(field(page, "Codex executable"), "/opt/homebrew/bin/codex");
    assert.match(page.document.querySelector(".machine-settings").textContent, /keep the connection they started with/);
    assert.equal(saveBar(page), null, "nothing to save yet");
    type(page, "SSH destination", "mini.local");
    await until(() => saveBar(page), "the save bar");
    assert.match(saveBar(page).textContent, /^1 change not saved/);
    const reads = page.calls.filter((c) => c.url.endsWith("/machines") && c.method === "GET").length;
    button(saveBar(page), "Save").click();
    await until(() => /SSH · mini\.local/.test(card(page, "mini").textContent), "the edited destination");
    const put = page.calls.find((c) => c.method === "PUT");
    assert.equal(put.url, "/api/machines/mini");
    assert.deepEqual(put.body, { name: "Mac mini", target: "mini.local", codex: "/opt/homebrew/bin/codex", defaultCwd: "/Users/me/projects" });
    assert.ok(page.calls.filter((c) => c.url.endsWith("/machines") && c.method === "GET").length > reads, "read again");
    assert.match(card(page, "mini").querySelector(".last-check").textContent, /Not checked yet/, "the old address's check is gone");

    // An open agent keeps its machine; nothing is asked of Core.
    page.document.querySelector('[aria-label="Remove Mac mini"]').click();
    await until(() => card(page, "mini").querySelector(".machine-remove"), "the remove step");
    assert.match(card(page, "mini").querySelector(".machine-remove").textContent, /Kaze still works here\. Close that agent first/);
    assert.equal(button(card(page, "mini"), "Remove machine"), undefined);
    button(card(page, "mini"), "OK").click();
    await until(() => !card(page, "mini").querySelector(".machine-remove"), "the remove step to close");

    await show(page, "studio");
    page.document.querySelector('[aria-label="Remove Studio"]').click();
    await until(() => button(card(page, "studio"), "Remove machine"), "the confirmation");
    button(card(page, "studio"), "Remove machine").click();
    await until(() => card(page, "studio") === null && row(page, "mini"), "the removed machine to go, back to the list");
    assert.equal(row(page, "studio"), null, "and off the list");
    assert.deepEqual(page.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["/api/machines/studio"]);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("an edit Core saved shows its new values even if the list can't be read again (T-187)", async () => {
  let saved = false;
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/mini") && method === "PUT") {
      saved = true;
      return { ...mini, ...JSON.parse(init.body), lastCheck: null };
    }
    if (url.endsWith("/machines") && saved)
      return { ok: false, status: 503, text: async () => "Core is restarting", json: async () => ({}) };
    return undefined;
  });
  try {
    render(page);
    await loaded(page);
    await show(page, "mini");
    await until(() => field(page, "SSH destination") === "mac-mini", "the settings");
    type(page, "SSH destination", "mini.local");
    await until(() => saveBar(page), "the save bar");
    button(saveBar(page), "Save").click();
    await until(() => /Couldn’t load machines: Core is restarting/.test(page.document.body.textContent), "the failed read is said");
    assert.match(card(page, "mini").textContent, /SSH · mini\.local/, "the saved destination, not the old one");
    assert.match(card(page, "mini").querySelector(".last-check").textContent, /Not checked yet/, "the old address's check is gone");
    assert.equal(page.calls.filter((c) => c.method === "PUT").length, 1);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a removal Core refuses says why and keeps the machine", async () => {
  const page = mount((url, init) =>
    init.method === "DELETE"
      ? { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: "Yuki still works on this machine. Close that agent first, then remove it." }) }
      : undefined);
  try {
    render(page, { agents: agents.filter((a) => a.id !== "c") });
    await loaded(page);
    await show(page, "mini");
    page.document.querySelector('[aria-label="Remove Mac mini"]').click();
    await until(() => button(card(page, "mini"), "Remove machine"), "the confirmation");
    assert.match(card(page, "mini").querySelector(".machine-remove").textContent, /Remove Mac mini from this workspace\?/);
    button(card(page, "mini"), "Remove machine").click();
    await until(() => card(page, "mini").querySelector('.machine-remove [role="alert"]'), "the refusal");
    assert.match(card(page, "mini").querySelector('.machine-remove [role="alert"]').textContent, /Yuki still works on this machine/);
    assert.ok(card(page, "mini"), "the machine stays");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// T-189: the page and its editor in Chinese. Names, SSH destinations, paths,
// versions and what Core or SSH said stay as written.
const chinese = (page) => page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));

test("the Machines page reads in Chinese; names, destinations, paths and Core's reasons stay as written (T-189)", async () => {
  const page = mount();
  try {
    chinese(page);
    render(page);
    await loaded(page);
    const body = page.document.body.textContent;
    assert.match(body, /机器/);
    assert.match(body, /后台不会自动检查/);
    assert.ok(button(page.document, "添加 SSH 机器"));
    assert.match(row(page, "mini").textContent, /Mac mini.*无法连通.*1 个 Agent/, "the list in Chinese, names as written");
    const host = await show(page, "local");
    assert.equal(page.document.querySelector(".settings-machines .settings-current").textContent, "本机");
    assert.match(host.textContent, /本机 · 运行你的 Workspace Core/);
    assert.match(host.querySelector(".last-check").textContent, /尚未检查/);
    assert.match(host.querySelector(".last-check").textContent, /测试连接，看看 Core 能访问到什么。/);
    assert.match(host.querySelector(".machine-agents").textContent, /当前在此的 Agent/);
    assert.match(host.querySelector(".machine-agents").textContent, /Mori.*App.*工作中/);
    assert.match(host.querySelector(".machine-agents").textContent, /Hana.*已关闭/);
    const remote = await show(page, "mini");
    const check = remote.querySelector(".last-check").textContent;
    assert.match(check, /无法连通/);
    assert.match(check, /上次检查：3 小时前/);
    assert.match(check, /可能已过时/);
    assert.match(check, /ssh: connect to host mac-mini port 22: Operation timed out/, "SSH's reason as written");
    assert.match(check, /Claude Code · 仅限 Core 主机/);
    assert.match(remote.textContent, /SSH · mac-mini/);
    assert.ok(button(remote, "测试连接"));
    await until(() => field(page, "机器名称") === "Mac mini", "its settings on the page, the name as written");
    assert.ok(page.document.querySelector('[aria-label="移除 Mac mini"]'));
    const facts = remote.querySelector(".machine-facts").textContent;
    assert.match(facts, /默认文件夹\/Users\/me\/projects/);
    assert.match(facts, /Codex 可执行文件\/opt\/homebrew\/bin\/codex/);
    assert.match(remote.querySelector(".machine-agents").textContent, /Kaze.*就绪 · 未连接/);
    const kaze = [...remote.querySelectorAll(".machine-agent")].find((b) => b.textContent.includes("Kaze"));
    assert.equal(kaze.title, "打开 Kaze\n/Users/me/projects/x");
    assert.match(body, /Agent 的状态来自它们自己的会话/);
    assert.doesNotMatch(page.document.body.textContent, /Test connection|Not checked yet|Agents here now|Couldn’t reach/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("adding, editing and removing read in Chinese; a saved edit stays shown when the list can't be read, and Core's words stay as written (T-189)", async () => {
  let saved = false;
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/mini") && method === "PUT") {
      saved = true;
      return { ...mini, ...JSON.parse(init.body), lastCheck: null };
    }
    if (url.endsWith("/machines") && saved)
      return { ok: false, status: 503, text: async () => "Core is restarting", json: async () => ({}) };
    return undefined;
  });
  try {
    chinese(page);
    render(page);
    await loaded(page);
    button(page.document, "添加 SSH 机器").click();
    await until(() => page.document.querySelector("#machines-new-ssh"), "the new machine form");
    const form = page.document.querySelector("#machines-new-ssh");
    for (const label of ["机器名称", "SSH 目标", "默认工作文件夹", "Codex 可执行文件", "同时运行的 Job 数", "Job CPU 预算（CPU 数）", "Job 内存预算（MiB）", "此机器无法强制执行的限制"])
      assert.ok([...form.querySelectorAll("label")].some((l) => l.textContent.trim().startsWith(label)), label);
    assert.match(form.textContent, /远程工作的地方/);
    assert.match(form.textContent, /拒绝该 Job（严格）/);
    button(form, "保存机器").click();
    await until(() => form.querySelector('[role="alert"]'), "the check before saving");
    assert.equal(form.querySelector('[role="alert"]').textContent, "请填写名称、SSH 目标和工作文件夹。");
    assert.equal(page.calls.filter((c) => c.method === "POST").length, 0, "nothing sent");
    button(form, "取消").click();
    await until(() => !page.document.querySelector("#machines-new-ssh"), "the form to close");

    await show(page, "mini");
    await until(() => field(page, "SSH 目标") === "mac-mini", "the settings, filled in");
    const settings = page.document.querySelector(".machine-settings");
    assert.deepEqual([...settings.querySelectorAll("legend")].map((l) => l.textContent), ["连接", "Job 与执行者"]);
    assert.match(settings.textContent, /已在此机器上的 Agent 保留它们启动时的连接/);
    assert.deepEqual([...settings.querySelectorAll(".theme-choice-name")].map((n) => n.textContent), ["拒绝该 Job", "运行并说明", "不设限制"]);
    type(page, "SSH 目标", "mini.local");
    await until(() => saveBar(page), "the save bar");
    assert.match(saveBar(page).textContent, /^1 处更改还没保存/);
    button(saveBar(page), "保存").click();
    await until(() => /无法加载机器：Core is restarting/.test(page.document.body.textContent), "the failed read, Core's words as written");
    assert.match(card(page, "mini").textContent, /SSH · mini\.local/, "the saved destination, not the old one");
    assert.match(card(page, "mini").querySelector(".last-check").textContent, /尚未检查/);

    page.document.querySelector('[aria-label="移除 Mac mini"]').click();
    await until(() => card(page, "mini").querySelector(".machine-remove"), "the remove step");
    assert.match(card(page, "mini").querySelector(".machine-remove").textContent, /Kaze 仍在此机器上工作。请先关闭该 Agent，再移除此机器。/);
    assert.ok(!button(card(page, "mini"), "移除机器"), "no removal while an Agent works there");
    assert.ok(button(card(page, "mini"), "好"));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a removal Core refuses says why in Core's words, inside the Chinese confirmation (T-189)", async () => {
  const page = mount((url, init) =>
    init.method === "DELETE"
      ? { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: "Yuki still works on this machine. Close that agent first, then remove it." }) }
      : undefined);
  try {
    chinese(page);
    render(page, { agents: agents.filter((a) => a.id !== "c") });
    await loaded(page);
    await show(page, "mini");
    page.document.querySelector('[aria-label="移除 Mac mini"]').click();
    await until(() => button(card(page, "mini"), "移除机器"), "the confirmation");
    assert.match(card(page, "mini").querySelector(".machine-remove").textContent, /要从此 Workspace 移除 Mac mini 吗？/);
    assert.ok(button(card(page, "mini"), "取消"));
    button(card(page, "mini"), "移除机器").click();
    await until(() => card(page, "mini").querySelector('.machine-remove [role="alert"]'), "the refusal");
    assert.match(card(page, "mini").querySelector('.machine-remove [role="alert"]').textContent, /Yuki still works on this machine/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a stored check shown where no language is passed (New agent) keeps English (T-189)", async () => {
  const page = mount();
  try {
    chinese(page);
    page.window.renderCheck({ check: mini.lastCheck, compact: true });
    await tick();
    const shown = page.document.querySelector(".last-check").textContent;
    assert.match(shown, /Couldn’t reach/);
    assert.match(shown, /Last check 3 h ago/);
    assert.match(shown, /Claude Code · Core host only/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});


// T-35 S3: a machine's own limit on executors at once, as GET /api/executor-slots lists it.
const slotsView = (machines) => ({
  workspace: { version: 1, slots: 3, saved: false, default: 3, startLimitSeconds: 300 },
  limits: { min: 1, max: 64, startLimitSeconds: { min: 30, max: 3600, default: 300 } },
  inUse: { waiting: 0, starting: 0, running: 1 }, machines,
});

test("a machine's executor limit is its own part of the page's save: saved against its version, alone or after the machine, and back to the default as none of its own (YN-8)", async () => {
  let limits = [{ id: "local", name: "Core host", version: 0, slots: null, executors: 0 },
    { id: "mini", name: "Mac mini", version: 2, slots: 3, executors: 1 }];
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/mini/executor-slots") && method === "PUT") {
      const body = JSON.parse(init.body);
      limits = limits.map((m) => (m.id === "mini" ? { ...m, version: m.version + 1, slots: body.slots } : m));
      return slotsView(limits);
    }
    if (url.endsWith("/executor-slots")) return slotsView(limits);
    if (url.endsWith("/machines/mini") && method === "PUT") return { ...mini, ...JSON.parse(init.body), lastCheck: null };
    return undefined;
  });
  const puts = () => page.calls.filter((c) => c.method === "PUT");
  try {
    render(page);
    await loaded(page);
    await show(page, "mini");
    await until(() => slider(page, "Executors at once")?.value === "3", "the saved limit on the slider");
    assert.equal(slider(page, "Executors at once").max, "64", "the slider stops at Core's 64");
    // The limit alone: only its own route, against the version read.
    slide(page, "Executors at once", 5);
    await until(() => saveBar(page), "the save bar");
    button(saveBar(page), "Save").click();
    await until(() => puts().length === 1, "the limit's save");
    assert.deepEqual(puts().map((c) => [c.url, c.body]), [["/api/machines/mini/executor-slots", { expectedVersion: 2, slots: 5 }]]);
    await until(() => saveBar(page)?.textContent === "All changes saved.", "saved");
    // With the machine: each its own request, one after another.
    type(page, "Machine name", "Mac mini 2");
    button(page.document.querySelector(".machine-settings-jobs"), "Use the default (3)").click();
    await until(() => /^2 changes not saved/.test(saveBar(page)?.textContent ?? ""), "two changes");
    assert.match(page.document.querySelector(".machine-settings-jobs").textContent, /The default, 3\./, "back to the default, said");
    assert.equal(slider(page, "Executors at once").value, "3", "the slider shows the default");
    button(saveBar(page), "Save").click();
    await until(() => puts().length === 3, "the second save");
    assert.deepEqual(puts().slice(1).map((c) => [c.url, c.body]), [
      ["/api/machines/mini", { name: "Mac mini 2", target: "mac-mini", codex: "/opt/homebrew/bin/codex", defaultCwd: "/Users/me/projects" }],
      ["/api/machines/mini/executor-slots", { expectedVersion: 3, slots: null }],
    ], "the default is none of its own");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// #645 R1 ae06571c P3: a conflict keeps what was set; only the limit and
// its version are read again, and the next save sends it against that version.
test("a machine executor limit changed meanwhile is read again and said so; the change is kept and saved against the version read again", async () => {
  let version = 2;
  let limitPuts = 0;
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/mini/executor-slots") && method === "PUT") {
      if (++limitPuts === 1) {
        version = 4;
        return { status: 400, ok: false, json: async () => ({ error: "version_conflict: these executor slots changed; reload before saving" }),
          text: async () => JSON.stringify({ error: "version_conflict: these executor slots changed; reload before saving" }) };
      }
      version = 5;
      return slotsView([{ id: "mini", name: "Mac mini", version, slots: JSON.parse(init.body).slots, executors: 1 }]);
    }
    if (url.endsWith("/executor-slots")) return slotsView([{ id: "mini", name: "Mac mini", version, slots: version === 4 ? 7 : 3, executors: 1 }]);
    return undefined;
  });
  const limitWrites = () => page.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/executor-slots"));
  const limitReads = () => page.calls.filter((c) => c.method === "GET" && c.url.endsWith("/executor-slots")).length;
  const settings = () => page.document.querySelector(".machine-settings");
  try {
    render(page);
    await loaded(page);
    await show(page, "mini");
    await until(() => slider(page, "Executors at once")?.value === "3", "the saved limit");
    slide(page, "Executors at once", 5);
    await until(() => saveBar(page), "the save bar");
    const reads = limitReads();
    button(saveBar(page), "Save").click();
    await until(() => settings().querySelector('[role="alert"]'), "the conflict");
    assert.match(settings().querySelector('[role="alert"]').textContent, /This machine’s executor limit changed meanwhile and was read again\. Save again to apply yours\./);
    await until(() => limitReads() > reads, "the limit read again");
    await tick(30);
    assert.equal(slider(page, "Executors at once").value, "5", "the change is kept after the conflict");
    assert.match(saveBar(page).textContent, /^1 change not saved · 1 change wasn’t saved/);
    button(saveBar(page), "Save").click();
    await until(() => limitWrites().length === 2, "the second save");
    assert.deepEqual(limitWrites()[1].body, { expectedVersion: 4, slots: 5 }, "the change is saved against the version read again");
    await until(() => saveBar(page)?.textContent === "All changes saved.", "saved");
    assert.equal(page.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/machines/mini")).length, 0, "the machine itself was not changed, nor sent");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// #645 R1 ae06571c P2: the machine is saved and its limit is not. The list
// has the machine at once and the form edits it, so the next save changes
// that machine: it is never added twice.
test("a new machine whose executor limit fails to save is listed at once and edited in place; the next save changes it and adds nothing", async () => {
  let listed = [local, mini];
  let limits = [];
  let limitPuts = 0;
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines") && method === "POST") {
      const id = `studio${listed.length === 2 ? "" : listed.length}`;
      listed = [...listed, { id, kind: "ssh", ...JSON.parse(init.body), lastCheck: null }];
      return listed.at(-1);
    }
    if (url.endsWith("/machines/studio") && method === "PUT") {
      listed = listed.map((m) => (m.id === "studio" ? { ...m, ...JSON.parse(init.body) } : m));
      return listed.find((m) => m.id === "studio");
    }
    if (url.endsWith("/machines/studio/executor-slots") && method === "PUT") {
      if (++limitPuts === 1) return { status: 503, ok: false, json: async () => ({ error: "executor slots are not available right now" }),
        text: async () => JSON.stringify({ error: "executor slots are not available right now" }) };
      limits = [{ id: "studio", name: "Studio", version: 1, slots: JSON.parse(init.body).slots, executors: 0 }];
      return slotsView(limits);
    }
    if (url.endsWith("/executor-slots")) return slotsView(limits);
    if (url.endsWith("/machines")) return { machines: listed };
    return undefined;
  });
  const form = () => page.document.querySelector("#machines-new-ssh");
  // Its save, by either of its names: the next save is clicked the same way however the form names it.
  const save = () => [...form().querySelectorAll("button")].find((b) => /^(Save machine|Save changes)$/.test(b.textContent.trim()));
  const posts = () => page.calls.filter((c) => c.method === "POST" && c.url.endsWith("/machines"));
  const limitWrites = () => page.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/executor-slots"));
  try {
    render(page);
    await loaded(page);
    button(page.document, "Add SSH machine").click();
    await until(() => form(), "the new machine form");
    type(page, "Machine name", "Studio");
    type(page, "SSH destination", "me@studio.local");
    type(page, "Default working folder", "/Users/me/studio");
    type(page, "Executors at once", "4");
    await tick();
    save().click();
    await until(() => form()?.querySelector('[role="alert"]'), "the limit failure");
    // What the page shows at once, checked after the next save.
    const alert = form().querySelector('[role="alert"]').textContent;
    const heading = form().querySelector(".remote-editor-heading").textContent.trim();
    const kept = field(page, "Executors at once");
    save().click();
    await until(() => limitWrites().length === 2, "the second save");
    assert.equal(posts().length, 1, "the machine is added once: the next save changes it");
    assert.equal(page.calls.filter((c) => c.method === "PUT" && c.url === "/api/machines/studio").length, 1, "the next save changes the machine it saved");
    assert.deepEqual(limitWrites().map((c) => [c.url, c.body]), [
      ["/api/machines/studio/executor-slots", { expectedVersion: 0, slots: 4 }],
      ["/api/machines/studio/executor-slots", { expectedVersion: 0, slots: 4 }],
    ], "its limit is sent again with the next save");
    assert.match(alert, /The machine is saved; its executor limit is not\. executor slots are not available right now/, "the limit failure says the machine is saved");
    assert.equal(heading, "Edit Studio", "the form edits the machine it saved");
    assert.equal(kept, "4", "the value typed is kept");
    await until(() => !form(), "the form to close once both are saved");
    assert.equal(page.document.querySelectorAll('[data-machine-id="studio"]').length, 1, "its page");
    page.document.querySelector(".settings-machines .settings-crumb").click();
    await until(() => row(page, "mini"), "the list");
    assert.equal(page.document.querySelectorAll('[data-machine-row="studio"]').length, 1, "listed once");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// The Core host has no editor: its card holds its own executor limit.
const localLimit = (page) => card(page, "local")?.querySelector(".machine-executor-limit");
// The Core host's limit is a slider on its page (YN-8), saved with the page's bar.
function typeLocal(page, value) {
  const input = localLimit(page).querySelector('input[type="range"]');
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

test("the Core host card sets its own executor limit, through the route for local", async () => {
  let limits = [{ id: "local", name: "Core host", version: 0, slots: null, executors: 2 }];
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/local/executor-slots") && method === "PUT") {
      const body = JSON.parse(init.body);
      limits = [{ ...limits[0], version: limits[0].version + 1, slots: body.slots }];
      return slotsView(limits);
    }
    if (url.endsWith("/executor-slots")) return slotsView(limits);
    return undefined;
  });
  try {
    render(page);
    await loaded(page);
    await show(page, "local");
    await until(() => localLimit(page), "the Core host card control");
    assert.match(localLimit(page).textContent, /2 on this machine now/);
    assert.match(localLimit(page).textContent, /Lowering it stops no running executor/);
    assert.match(localLimit(page).textContent, /The default, 3\./, "none of its own: the default, on the slider");
    assert.equal(localLimit(page).querySelector('input[type="range"]').value, "3");
    assert.equal(button(localLimit(page), "Save executors at once"), undefined, "the page's bar saves it");
    typeLocal(page, "1");
    await until(() => saveBar(page), "the save bar");
    button(saveBar(page), "Save").click();
    await until(() => page.calls.some((c) => c.method === "PUT"), "the save");
    const put = page.calls.find((c) => c.method === "PUT");
    assert.equal(put.url, "/api/machines/local/executor-slots");
    assert.deepEqual(put.body, { expectedVersion: 0, slots: 1 });
    await until(() => saveBar(page)?.textContent === "All changes saved.", "saved");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// #645 R2 62b6a3ef: a failed read of the limit is said until a read succeeds;
// a save's own message (a conflict) is kept apart, so its reload keeps it.
test("the executor limit field says a failed read until a later read succeeds, and the Core host card keeps a conflict in view while its limit is read again", async () => {
  const unavailable = { status: 503, ok: false, json: async () => ({ error: "executor slots are not available right now" }),
    text: async () => JSON.stringify({ error: "executor slots are not available right now" }) };
  const conflict = { status: 400, ok: false, json: async () => ({ error: "version_conflict: these executor slots changed; reload before saving" }),
    text: async () => JSON.stringify({ error: "version_conflict: these executor slots changed; reload before saving" }) };
  const reads = (page) => page.calls.filter((c) => c.method === "GET" && c.url.endsWith("/executor-slots")).length;
  // What the machine's Jobs block says under its executor limit (YN-8: on its page).
  const said = (page) => page.document.querySelector(".machine-settings-jobs [role=alert]")?.textContent ?? "";
  let failNext = false;
  const page = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/mini/executor-slots") && method === "PUT") return conflict;
    if (url.endsWith("/executor-slots")) {
      if (failNext) { failNext = false; return unavailable; }
      return slotsView([{ id: "local", name: "Core host", version: 0, slots: null, executors: 0 }, { id: "mini", name: "Mac mini", version: 3, slots: 7, executors: 1 }]);
    }
    if (url.endsWith("/machines/mini") && method === "PUT") return { ...mini, ...JSON.parse(init.body), lastCheck: null };
    return undefined;
  });
  try {
    render(page);
    await loaded(page);
    await show(page, "local");
    await until(() => localLimit(page), "the Core host card control, read");
    // The page's own read fails once; it is said, and read again when asked.
    failNext = true;
    await show(page, "mini");
    await until(() => /executor slots are not available right now/.test(said(page)), "the failed read in the Jobs block");
    assert.equal(slider(page, "Executors at once"), null, "no slider without a limit read");
    button(page.document.querySelector(".machine-settings-jobs"), "Read again").click();
    await until(() => slider(page, "Executors at once")?.value === "7", "the limit, read again");
    assert.equal(said(page), "", "a read that succeeds clears the failed one");
    slide(page, "Executors at once", 5);
    await until(() => saveBar(page), "the save bar");
    const before = reads(page);
    button(saveBar(page), "Save").click();
    await until(() => /changed meanwhile and was read again/.test(said(page)) && reads(page) > before, "the conflict, and the limit read again");
    await tick(60);
    assert.match(page.document.querySelector(".machine-settings-jobs").textContent, /Lowering it stops no running executor/, "the help stays");
    assert.doesNotMatch(said(page), /not available/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }

  let version = 0;
  const host = mount((url, init) => {
    const method = init.method || "GET";
    if (url.endsWith("/machines/local/executor-slots") && method === "PUT") { version = 2; return conflict; }
    if (url.endsWith("/executor-slots")) return slotsView([{ id: "local", name: "Core host", version, slots: version ? 4 : null, executors: 0 }]);
    return undefined;
  });
  try {
    render(host);
    await loaded(host);
    await show(host, "local");
    await until(() => localLimit(host), "the Core host card control");
    typeLocal(host, "2");
    await until(() => saveBar(host), "the save bar");
    const before = reads(host);
    button(saveBar(host), "Save").click();
    await until(() => localLimit(host)?.querySelector('[role="alert"]') && reads(host) > before, "the conflict, and the limit read again");
    await tick(60);
    assert.match(localLimit(host).querySelector('[role="alert"]').textContent, /changed meanwhile and was read again/, "the conflict is still said once the limit is read again");
    assert.deepEqual(host.errors, []);
  } finally {
    host.close();
  }
});

test("the executor limit reads in Chinese on the Machines page (T-189)", async () => {
  const page = mount((url) => (url.endsWith("/executor-slots")
    ? slotsView([{ id: "local", name: "Core host", version: 0, slots: null, executors: 0 }]) : undefined));
  try {
    chinese(page);
    render(page);
    await loaded(page);
    await show(page, "local");
    await until(() => localLimit(page), "the Core host card control");
    assert.match(localLimit(page).textContent, /同时运行的执行者/);
    assert.match(localLimit(page).textContent, /调低不会停止正在运行的执行者/);
    assert.match(localLimit(page).textContent, /默认值 3。/, "none of its own: the default (YN-2 S5), said in Chinese");
    assert.match(localLimit(page).textContent, /此机器上同时最多运行这么多个执行者。整个 Workspace 最多运行各机器数量之和。/);
    typeLocal(page, "2");
    await until(() => saveBar(page), "the save bar");
    assert.ok(button(localLimit(page), "使用默认值（3）"), "back to the default reads in Chinese");
    assert.equal(saveBar(page).querySelector("span").textContent, "1 处更改还没保存");
  } finally {
    page.close();
  }
});
