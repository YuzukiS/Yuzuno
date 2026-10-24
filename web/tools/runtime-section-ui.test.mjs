// Runtime & versions (T-191): what Core and this client already hold, each
// fact as Yes / No / Unknown with its machine and time; opening it or Read
// again only GETs, never a check, a sign-in, a reconnect or an update.
// Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "runtime-section-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RuntimeSection} from ${src("RuntimeSection.tsx")};
const root = createRoot(document.getElementById('root'));
window.machinesOpened = 0;
window.show = (active = true) => root.render(<RuntimeSection active={active} onOpenMachines={() => window.machinesOpened++}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "RuntimeSectionUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const MIN = 60_000;

// What a Core answers, by path; a function for an error.
function core(overrides = {}) {
  return {
    "/api/health": { version: "2026.10.24-core.17", releaseId: "core-20261024-c215011", apiReady: true, storageReady: true, product: "yuzuno" },
    "/api/machines": {
      machines: [
        {
          id: "local", name: "Core host", kind: "local", defaultCwd: "/work",
          lastCheck: {
            machineId: "local", startedAt: new Date(Date.now() - 5 * MIN).toISOString(), checkedAt: new Date(Date.now() - 5 * MIN).toISOString(), durationMs: 900, reachable: true,
            harnesses: [
              { harness: "codex", supported: true, found: true, version: "codex-cli 0.162.1", executable: "/usr/bin/codex" },
              { harness: "claude", supported: true, found: true, version: "2.1.296 (Claude Code)", signIn: { state: "signedIn", method: "claude.ai" } },
            ],
          },
        },
        {
          id: "box", name: "Build box", kind: "ssh", target: "builder@box.test", defaultCwd: "/srv", limitMode: "strict",
          lastCheck: {
            machineId: "box", startedAt: hoursAgo(2), checkedAt: hoursAgo(2), durationMs: 10_000, reachable: false,
            error: "ssh: connect to host box.test port 22: Connection timed out", harnesses: [],
          },
        },
      ],
    },
    "/api/workspace": { agents: [], defaultCwd: "/work", runtime: { connected: true, account: "person@example.test" } },
    "/api/jobs/budget": { machine: { name: "Core host", scope: "Only jobs managed by this Core share this budget." }, windows: { available: false, reason: "WSL interop is not available" } },
    ...overrides,
  };
}

function mount(answers, { release = "core-20261024-c215011", desktop } = {}) {
  const calls = [];
  const invoked = [];
  const dom = new JSDOM(
    `<!doctype html><html><head>${release ? `<meta name="yuzuno-release" content="${release}">` : ""}</head><body><div id="root"></div></body></html>`,
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() },
  );
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    const path = new URL(url, "http://isolated.test").pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const answer = answers[path];
    if (typeof answer === "function") {
      const { status, body } = answer();
      return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
    }
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '{"error":"not in this fixture"}' };
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  if (desktop)
    window.__TAURI__ = { core: { invoke: async (command) => { invoked.push(command); return desktop; } } };
  window.eval(bundle);
  const document = window.document;
  // Each fact by its group and name, as "State · text · detail".
  const facts = (scope = document) =>
    Object.fromEntries([...scope.querySelectorAll(".runtime-fact")].map((row) => [
      row.querySelector("dt").textContent,
      [row.querySelector(".runtime-state").textContent, row.querySelector(".runtime-text").textContent, row.querySelector(".runtime-detail")?.textContent]
        .filter(Boolean).join(" · "),
    ]));
  const group = (title) => [...document.querySelectorAll(".runtime-group")].find((g) => g.querySelector("h4")?.textContent === title);
  const machine = (name) => [...document.querySelectorAll(".runtime-machine")].find((m) => m.querySelector("h5").textContent === name);
  const harness = (machineName, name) => [...machine(machineName).querySelectorAll(".runtime-harness")].find((h) => h.querySelector("h6").textContent === name);
  return {
    window, document, calls, invoked, facts, group, machine, harness,
    close: () => window.close(),
  };
}
// Only reads of what Core holds: no check, no sign-in, no model list, no usage or MCP request, nothing sent.
const READS = ["GET /api/health", "GET /api/machines", "GET /api/workspace", "GET /api/jobs/budget"];

test("it shows Core, this device and each machine's last check, each fact with where and when; it only reads", async () => {
  const page = mount(core());
  page.window.show();
  await tick();
  assert.deepEqual(page.facts(page.group("Workspace service")), {
    Version: "Yes · 2026.10.24-core.17",
    Release: "Yes · core-20261024-c215011",
    State: "Yes · Ready",
  });
  assert.deepEqual(page.facts(page.group("This device")), {
    "This page": "Yes · core-20261024-c215011 · The same release as Core.",
    "Desktop app": "Unknown · Not the desktop app · This page runs in a browser.",
    "iPhone app": "Unknown · Not reported · The iPhone app doesn't report its version to this page.",
  });
  const host = page.machine("Core host");
  assert.match(host.querySelector(".runtime-checked").textContent, /^Last checked 5 min ago \(.+\)$/);
  assert.equal(host.querySelector(".runtime-checked").dataset.stale, undefined);
  assert.deepEqual(page.facts(host.querySelector("dl")), {
    Reached: "Yes · Reached",
    "Codex connection": "Yes · Connected",
    "Managed Jobs": "Yes · Managed Jobs run here · Only jobs managed by this Core share this budget.",
    "Windows Jobs": "No · Windows Jobs not available · WSL interop is not available",
  });
  assert.deepEqual(page.facts(page.harness("Core host", "Codex")), {
    CLI: "Yes · Found · codex-cli 0.162.1 · /usr/bin/codex",
    "Signed in": "Yes · Signed in · person@example.test",
    Models: "Unknown · Not checked here · Models are listed when you choose one for an Agent.",
  });
  assert.deepEqual(page.facts(page.harness("Core host", "Claude Code")), {
    CLI: "Yes · Found · 2.1.296 (Claude Code)",
    "Signed in": "Yes · Signed in · claude.ai",
    Models: "Unknown · Not checked here · Models are listed when you choose one for an Agent.",
  });
  const box = page.machine("Build box");
  assert.equal(box.querySelector(".runtime-where").textContent, "builder@box.test");
  assert.match(box.querySelector(".runtime-checked").textContent, /^Last checked 2 h ago \(.+\) · older than an hour$/);
  assert.equal(box.querySelector(".runtime-checked").dataset.stale, "true");
  assert.deepEqual(page.facts(box.querySelector("dl")), {
    Reached: "No · Not reached · ssh: connect to host box.test port 22: Connection timed out",
    "Managed Jobs": "Yes · Managed · limits enforced · Whether the machine can hold them is checked when a Job starts.",
  });
  assert.deepEqual(page.facts(page.harness("Build box", "Codex")), {
    CLI: "Unknown · Not part of the last check · Not checked on this machine.",
    "Signed in": "Unknown · Not known · Not checked on this machine.",
    Models: "Unknown · Not checked here · Models are listed when you choose one for an Agent.",
  });
  assert.equal(page.facts().Compatibility,
    "Unknown · Not defined · Which versions work together isn't defined for this release, so it isn't guessed from version numbers.");
  assert.deepEqual([...page.calls].sort(), [...READS].sort(), "only reads, once each");
  page.close();
});

test("what can't be read or was never checked is Unknown, not guessed; a signed-out CLI says so", async () => {
  const answers = core({
    "/api/health": () => ({ status: 503, body: { error: "Core is starting" } }),
    "/api/workspace": { agents: [], defaultCwd: "/work", runtime: { connected: false, error: "codex app-server exited" } },
    "/api/jobs/budget": () => ({ status: 500, body: { error: "Local managed jobs require Linux with a systemd user manager" } }),
  });
  answers["/api/machines"] = {
    machines: [
      { id: "local", name: "Core host", kind: "local", defaultCwd: "/work", lastCheck: null },
      {
        id: "mac", name: "Studio", kind: "ssh", target: "me@studio.test", defaultCwd: "/Users/me",
        lastCheck: {
          machineId: "mac", startedAt: hoursAgo(0.1), checkedAt: hoursAgo(0.1), durationMs: 3000, reachable: true,
          harnesses: [
            { harness: "codex", supported: true, found: false, error: "codex: command not found" },
            { harness: "claude", supported: true, found: false, error: "Claude Code is signed out: run claude login", signIn: { state: "signedOut" } },
          ],
        },
      },
    ],
  };
  const page = mount(answers, { release: null });
  page.window.show();
  await tick();
  assert.deepEqual(page.facts(page.group("Workspace service")), {
    Version: "Unknown · Not known · Core could not be read: Core is starting",
    Release: "Unknown · Not known",
    State: "Unknown · Not known",
  });
  assert.equal(page.facts(page.group("This device"))["This page"], "Unknown · This page doesn't say which release it is");
  const host = page.machine("Core host");
  assert.equal(host.querySelector(".runtime-checked").textContent, "Never checked");
  assert.deepEqual(page.facts(host.querySelector("dl")), {
    Reached: "Unknown · Not checked yet · Check the machine on the Machines page.",
    "Codex connection": "No · Not connected · codex app-server exited",
    "Managed Jobs": "Unknown · Couldn't be confirmed · Local managed jobs require Linux with a systemd user manager",
  });
  assert.equal(page.facts(page.harness("Core host", "Codex"))["Signed in"], "Unknown · Not known · Codex is not connected on the Core host.");
  assert.equal(page.facts(page.harness("Core host", "Claude Code")).CLI, "Unknown · Not checked yet · Check the machine on the Machines page.");
  assert.deepEqual(page.facts(page.harness("Studio", "Codex")), {
    CLI: "No · Not found · codex: command not found",
    "Signed in": "Unknown · Not known · Not checked on this machine.",
    Models: "Unknown · Not checked here · Models are listed when you choose one for an Agent.",
  });
  assert.equal(page.facts(page.harness("Studio", "Claude Code"))["Signed in"], "No · Signed out · Claude Code is signed out: run claude login");
  assert.equal(page.facts(page.machine("Studio").querySelector("dl"))["Managed Jobs"],
    "Yes · Record only · Saved before Job limits: nothing is held there.");
  assert.deepEqual([...page.calls].sort(), [...READS].sort());
  page.close();
});

test("a development Core and a page from another release are said plainly", async () => {
  const page = mount(core({ "/api/health": { version: "0.1.0", releaseId: "development", apiReady: true, storageReady: false } }), { release: "core-20261020-aaaaaaa" });
  page.window.show();
  await tick();
  const service = page.facts(page.group("Workspace service"));
  assert.equal(service.Release, "No · A development build · Not installed as a release; updates don't apply to it.");
  assert.equal(service.State, "No · Not ready · storage not ready");
  assert.equal(page.facts(page.group("This device"))["This page"], "No · core-20261020-aaaaaaa · Core runs development: reload this page to use it.");
  page.close();
});

test("in the desktop app its version is read from the app's own status, never an update check", async () => {
  const page = mount(core(), { desktop: { version: "0.3.0", channel: "installer", unavailable: null, phase: "idle", error: null, receivedBytes: 0, totalBytes: null, available: null } });
  page.window.show();
  await tick();
  assert.equal(page.facts(page.group("This device"))["Desktop app"], "Yes · 0.3.0 · Installed by the Yuzuno installer, which updates it.");
  assert.deepEqual(page.invoked, ["desktop_update_status"]);
  page.close();
});

test("Read again reads the same again; nothing is read while closed; checks are left to Machines", async () => {
  const page = mount(core());
  page.window.show(false);
  await tick();
  assert.deepEqual(page.calls, [], "nothing while closed");
  page.window.show(true);
  await tick();
  assert.equal(page.calls.length, 4);
  const again = [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Read again");
  again.click();
  await tick();
  assert.deepEqual([...page.calls].sort(), [...READS, ...READS].sort(), "the same reads again, nothing else");
  assert.ok(page.document.querySelector(".runtime-read [role=status] time"), "says when it was read");
  [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Check machines").click();
  assert.equal(page.window.machinesOpened, 1, "checking is the Machines page's");
  assert.ok(page.calls.every((c) => c.startsWith("GET ")), "nothing was sent");
  page.close();
});
