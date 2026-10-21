import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Bundle the components in memory, without replacing the running UI's dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "remote-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
import {RemoteControls} from ${JSON.stringify(path.join(root, "src/RemoteControls.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderCreate=(props)=>root.render(<RemoteCreateAgent {...props}/>);
// Committed with its effects when this returns, so a click right after a
// render is not taken for one from before it (RemoteControls's agent effect).
window.renderControls=(props)=>flushSync(()=>root.render(<RemoteControls {...props}/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "RemoteUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
// Waits for what a step should lead to, not for a fixed time; fails if it
// never happens.
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const local = {
  id: "local",
  name: "Core host",
  kind: "local",
  defaultCwd: "/workspace",
};
const remote = {
  id: "mini",
  name: "Mac mini",
  kind: "ssh",
  target: "mac-mini",
  codex: "/opt/homebrew/bin/codex",
  defaultCwd: "/Users/test/projects",
};
const baseAgent = {
  id: "remote-a",
  name: "Mori",
  status: "working",
  remote: { machine: remote },
  connectionState: "disconnected",
};

function mount(handler, status = 200) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://isolated.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    const override = await handler?.(url, init);
    const body =
      override ??
      (url.endsWith("/machines")
        ? { machines: [local, remote] }
        : url.endsWith("/models")
          ? {
              models: [
                {
                  id: "local-only",
                  model: "local-only",
                  displayName: "Local model",
                },
              ],
            }
          : {});
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  window.eval(bundle);
  return {
    dom,
    window,
    document: window.document,
    calls,
    errors,
    close: () => window.close(),
  };
}
function button(page, text) {
  return [...page.document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
}

test("remote unconfirmed or connected-uncertain sessions can check again after an error", async () => {
  for (const connectionState of ["unconfirmed", "connected"]) {
    const page = mount(() => ({ error: "Native check timed out" }), 400);
    let refreshed = 0;
    page.window.renderControls({ agent: { ...baseAgent, connectionState, status: "uncertain" },
      onReconnected: () => refreshed++ });
    await tick(); await tick();
    assert.equal(button(page, "Reconnect").disabled, false);
    button(page, "Reconnect").click();
    button(page, "Reconnect").click();
    await tick(); await tick();
    assert.equal(refreshed, 1, "Failed checks also refresh Core's settled connection state");
    assert.equal(page.calls.length, 1, "Two clicks before React updates still send only one check");
    assert.equal(button(page, "Reconnect").disabled, false);
    assert.match(page.document.body.textContent, /Native check timed out/);
    button(page, "Reconnect").click();
    await tick(); await tick();
    assert.equal(page.calls.length, 2);
    page.close();
  }
});
function input(page, label) {
  return [...page.document.querySelectorAll("label")]
    .find((node) => node.textContent.trim().startsWith(label))
    ?.querySelector("input,textarea,select");
}
async function value(page, node, text) {
  const prototype =
    node.tagName === "TEXTAREA"
      ? page.window.HTMLTextAreaElement.prototype
      : node.tagName === "SELECT"
        ? page.window.HTMLSelectElement.prototype
        : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, text);
  node.dispatchEvent(
    new page.window.Event(node.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await tick();
}
// New agent shows its choices as chips: radios inside a named group.
function group(page, label) {
  return page.document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
}
async function pick(page, label, choice) {
  group(page, label).querySelector(`input[value="${choice}"]`).click();
  await tick();
}
const picked = (page, label) => group(page, label).querySelector("input:checked")?.value;
async function createDialog(page, overrides = {}) {
  page.window.renderCreate({
    open: true,
    close() {},
    defaultCwd: "/workspace",
    disabled: false,
    onCreated() {},
    ...overrides,
  });
  await tick();
  await tick();
}

test("remote creation sends selected machine and remote folder without a local model", async () => {
  const page = mount((url, init) =>
    url.endsWith("/agents")
      ? { id: "new-agent", ...JSON.parse(init.body) }
      : undefined,
  );
  let created;
  let closed = false;
  try {
    await createDialog(page, {
      onCreated: (agent) => {
        created = agent;
      },
      close: () => {
        closed = true;
      },
    });
    // Local models are chips; a remote machine takes a typed model.
    assert.equal(picked(page, "Model"), "");
    assert.equal(input(page, "Model"), undefined);
    await pick(page, "Where to work", "mini");
    assert.equal(group(page, "Model"), null);
    assert.equal(input(page, "Working folder").value, remote.defaultCwd);
    assert.equal(input(page, "Model").tagName, "INPUT");
    assert.equal(input(page, "Model").value, "");
    await value(page, input(page, "Name"), "Remote teammate");
    assert.equal(
      page.document.body.textContent.includes("A lasting purpose"),
      false,
    );
    page.document
      .querySelector("form")
      .dispatchEvent(
        new page.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await tick();
    const request = page.calls.find((call) => call.url.endsWith("/agents"));
    assert.equal(request.body.machineId, "mini");
    assert.equal(request.body.cwd, remote.defaultCwd);
    assert.equal("model" in request.body, false);
    assert.equal("goal" in request.body, false);
    assert.equal(created.id, "new-agent");
    assert.ok(closed);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("adding a machine validates fields, saves only machine configuration, and selects its folder", async () => {
  const page = mount((url, init) =>
    url.endsWith("/machines") && init.method === "POST"
      ? { id: "mini-new", kind: "ssh", ...JSON.parse(init.body) }
      : undefined,
  );
  try {
    await createDialog(page);
    button(page, "Add SSH machine").click();
    await tick();
    button(page, "Save machine").click();
    await tick();
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /name.*SSH destination/,
    );
    assert.equal(
      page.calls.filter((call) => call.init.method === "POST").length,
      0,
    );
    await value(page, input(page, "Machine name"), "Garden mini");
    await value(page, input(page, "SSH destination"), "mini-alias");
    await value(page, input(page, "Default working folder"), "/Users/me/work");
    await value(
      page,
      input(page, "Codex executable"),
      "/opt/homebrew/bin/codex",
    );
    button(page, "Save machine").click();
    await tick();
    const posts = page.calls.filter((call) => call.init.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      name: "Garden mini",
      target: "mini-alias",
      codex: "/opt/homebrew/bin/codex",
      defaultCwd: "/Users/me/work",
    });
    assert.equal(picked(page, "Where to work"), "mini-new");
    assert.equal(input(page, "Working folder").value, "/Users/me/work");
    assert.ok(page.document.querySelector("#new-ssh-machine") === null, "#new-ssh-machine is absent");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a late connection check cannot mark a newly selected machine as connected", async () => {
  let resolveCheck;
  const page = mount((url) =>
    url.endsWith("/check")
      ? new Promise((resolve) => {
          resolveCheck = resolve;
        })
      : undefined,
  );
  try {
    await createDialog(page);
    await pick(page, "Where to work", "mini");
    button(page, "Test connection").click();
    await tick();
    assert.ok(button(page, "Checking…"));
    await pick(page, "Where to work", "local");
    resolveCheck({ machineId: "mini", startedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
      durationMs: 5, reachable: true, host: { hostname: "mini-host", platform: "Darwin", home: "/Users/test" },
      harnesses: [{ harness: "codex", supported: true, found: true, version: "test-version" }] });
    await tick();
    // The late result belongs to the Mac mini; the Core host stays unchecked.
    assert.match(page.document.querySelector(".last-check").textContent, /Not checked yet/);
    assert.doesNotMatch(page.document.body.textContent, /mini-host/);
    assert.equal(input(page, "Working folder").value, "/workspace");
    await pick(page, "Where to work", "mini");
    assert.match(page.document.querySelector(".last-check").textContent, /Reached mini-host/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("New agent shows the stored last check the Machines page shows, and can test the Core host", async () => {
  const checkedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const page = mount((url) =>
    url.endsWith("/machines")
      ? { machines: [local, { ...remote, lastCheck: { machineId: "mini", startedAt: checkedAt, checkedAt,
          durationMs: 900, reachable: false, error: "ssh: connect timed out",
          harnesses: [{ harness: "claude", supported: false, found: false }] } }] }
      : url.endsWith("/machines/local/check")
        ? { machineId: "local", startedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), durationMs: 20,
            reachable: true, host: { hostname: "wsl-box", platform: "Linux", home: "/home/me" },
            harnesses: [{ harness: "codex", supported: true, found: true, version: "codex-cli 0.162.1" },
              { harness: "claude", supported: true, found: false, error: "Claude Code was not found on Core's PATH" }] }
        : undefined,
  );
  try {
    await createDialog(page);
    assert.match(page.document.querySelector(".last-check").textContent, /Not checked yet/);
    await pick(page, "Where to work", "mini");
    const stored = page.document.querySelector(".last-check").textContent;
    assert.match(stored, /Couldn’t reach/);
    assert.match(stored, /2 h ago/);
    assert.match(stored, /May be out of date/, "old results are labelled, not called offline");
    await pick(page, "Where to work", "local");
    button(page, "Test connection").click();
    await tick();
    await tick();
    assert.ok(page.calls.some((call) => call.url.endsWith("/machines/local/check") && call.init.method === "POST"));
    const fresh = page.document.querySelector(".last-check").textContent;
    assert.match(fresh, /Reached wsl-box/);
    assert.match(fresh, /Codex found · codex-cli 0.162.1/);
    assert.match(fresh, /Claude Code unavailable/);
    assert.match(fresh, /Claude Code: Claude Code was not found on Core's PATH/, "the reason is text, not only a tooltip");
    assert.doesNotMatch(fresh, /out of date/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a failed test in New agent shows why, where the user ran it", async () => {
  const now = new Date().toISOString();
  const results = {
    // A failed connection is a stored 200 result, not a request error.
    unreachable: { machineId: "mini", startedAt: now, checkedAt: now, durationMs: 5, reachable: false,
      error: "远程操作失败：ssh: Could not resolve hostname host.invalid: Name or service not known",
      harnesses: [{ harness: "claude", supported: false, found: false }] },
    folder: { machineId: "mini", startedAt: now, checkedAt: now, durationMs: 700, reachable: true,
      host: { hostname: "mini-host", platform: "Darwin", home: "/Users/test" },
      harnesses: [{ harness: "codex", supported: true, found: false, error: "找不到指定的远程 Codex；请先安装官方 CLI" },
        { harness: "claude", supported: false, found: false }],
      defaultFolder: { path: "/Users/test/projects", error: "[Errno 2] No such file or directory: '/Users/test/projects'" } },
  };
  let next = "unreachable";
  const page = mount((url, init) =>
    url.endsWith("/machines/mini/check") && init.method === "POST" ? results[next] : undefined,
  );
  try {
    await createDialog(page);
    await pick(page, "Where to work", "mini");
    button(page, "Test connection").click();
    await tick();
    await tick();
    const failed = page.document.querySelector(".last-check");
    assert.match(failed.textContent, /Couldn’t reach/);
    const reason = failed.querySelector(".last-check-error");
    assert.ok(reason, "the reason is rendered as its own text");
    assert.match(reason.textContent, /Could not resolve hostname host\.invalid/);
    assert.equal(failed.getAttribute("role"), "status", "announced to assistive technology");

    next = "folder";
    button(page, "Test connection").click();
    await tick();
    await tick();
    const reached = page.document.querySelector(".last-check").textContent;
    assert.match(reached, /Reached mini-host/);
    assert.match(reached, /Codex unavailable/);
    assert.match(reached, /Codex: 找不到指定的远程 Codex/);
    assert.match(reached, /Default folder \/Users\/test\/projects: \[Errno 2\] No such file or directory/);
    assert.ok(page.document.querySelector(".remote-field-error") === null, "no request error was involved");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("reconnect preserves unknown execution state and never spawns or sends a new turn", async () => {
  const page = mount();
  let refreshed = false;
  try {
    page.window.renderControls({
      agent: baseAgent,
      onReconnected: () => {
        refreshed = true;
      },
    });
    await until(() => /Disconnected/.test(page.document.body.textContent), "the disconnected notice");
    assert.match(page.document.body.textContent, /may still be working/);
    button(page, "Reconnect").click();
    // onReconnected also runs when the request fails, so wait for the
    // request to end too, and require that it showed no error.
    await until(
      () => refreshed && !/Connecting…/.test(page.document.body.textContent),
      "the reconnect to finish",
    );
    assert.ok(page.document.querySelector('[role="alert"]') === null, "the reconnect showed no error");
    const posts = page.calls.filter((call) => call.init.method === "POST");
    assert.deepEqual(
      posts.map((call) => call.url),
      ["/api/agents/remote-a/reconnect?view=summary"],
    );
    assert.match(page.document.body.textContent, /Disconnected/);
    page.window.renderControls({
      agent: { ...baseAgent, connectionState: "connected" },
    });
    await until(() => button(page, "Reconnect") === undefined, 'the "Reconnect" button to go');
    assert.match(page.document.body.textContent, /Connected/);
    // Through the whole reconnect, still nothing but the reconnect request.
    assert.deepEqual(
      page.calls.filter((call) => call.init.method === "POST").map((call) => call.url),
      ["/api/agents/remote-a/reconnect?view=summary"],
    );
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("read-only preview makes no machine or agent requests", async () => {
  const page = mount();
  try {
    await createDialog(page, { disabled: true });
    assert.equal(button(page, "Add SSH machine").disabled, true);
    assert.equal(button(page, "Create agent").disabled, true);
    assert.deepEqual(page.calls, []);
  } finally {
    page.close();
  }
});
