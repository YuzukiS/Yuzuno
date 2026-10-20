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
import {MachinesPage} from ${JSON.stringify(path.join(root, "src/MachinesPage.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderMachines=(props)=>root.render(<MachinesPage {...props}/>);`,
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
async function loaded(page) {
  const deadline = Date.now() + 3000;
  while (!card(page, "mini") && Date.now() < deadline) await tick(20);
  assert.ok(card(page, "mini"), "machines loaded");
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
    const host = card(page, "local");
    assert.match(host.textContent, /Local · runs your Workspace Core/);
    assert.match(host.querySelector(".last-check").textContent, /Not checked yet/);
    const remote = card(page, "mini");
    const check = remote.querySelector(".last-check").textContent;
    assert.match(check, /Couldn’t reach/);
    assert.match(check, /Last check 3 h ago/);
    assert.match(check, /May be out of date/);
    assert.match(check, /Operation timed out/);
    assert.match(check, /Claude Code · Core host only/);
    assert.doesNotMatch(page.document.body.textContent, /\bonline\b/i, "a check is never presented as live status");
    // Agents are grouped by where they run, with their own current state.
    assert.match(host.querySelector(".machine-agents").textContent, /Mori.*App.*Working/);
    assert.match(host.querySelector(".machine-agents").textContent, /Hana.*Closed/);
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
    const host = card(page, "local");
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
    assert.match(card(page, "mini").querySelector(".last-check").textContent, /Couldn’t reach/, "other machines keep their own result");
    button(host.querySelector(".machine-agents"), "Mori").click();
    assert.deepEqual(opened, ["a"]);
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
    await until(() => /Last check 1 min ago/.test(card(page, "local").querySelector(".last-check").textContent), "the reloaded list");
    assert.equal(page.calls.filter((c) => c.url.endsWith("/machines")).length, 2);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

function type(page, label, value) {
  const input = [...page.document.querySelectorAll(".remote-machine-editor label")]
    .find((l) => l.textContent.trim().startsWith(label)).querySelector("input");
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
const field = (page, label) => [...page.document.querySelectorAll(".remote-machine-editor label")]
  .find((l) => l.textContent.trim().startsWith(label))?.querySelector("input").value;

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
    assert.ok(page.document.querySelector('[aria-label="Edit Core host"]') === null, "the Core host is not edited");
    assert.ok(page.document.querySelector('[aria-label="Remove Core host"]') === null, "nor removed");

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

    // Editing starts from what is saved and reads the list again after.
    page.document.querySelector('[aria-label="Edit Mac mini"]').click();
    await until(() => field(page, "SSH destination") === "mac-mini", "the edit form, filled in");
    assert.equal(field(page, "Codex executable"), "/opt/homebrew/bin/codex");
    assert.match(card(page, "mini").textContent, /keep the connection they started with/);
    type(page, "SSH destination", "mini.local");
    await tick();
    const reads = page.calls.filter((c) => c.url.endsWith("/machines") && c.method === "GET").length;
    button(card(page, "mini"), "Save changes").click();
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

    page.document.querySelector('[aria-label="Remove Studio"]').click();
    await until(() => button(card(page, "studio"), "Remove machine"), "the confirmation");
    button(card(page, "studio"), "Remove machine").click();
    await until(() => card(page, "studio") === null, "the removed machine to go");
    assert.deepEqual(page.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["/api/machines/studio"]);
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
