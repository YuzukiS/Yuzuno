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
    const where = new URL(url, "http://isolated.test");
    // The two model catalogs differ only by their query.
    const path = where.pathname + (where.pathname === "/api/models" ? where.search : "");
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
    "Desktop app": "Unknown · Not known here · This page isn't open in the desktop app, so it can't read the app's version.",
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
    Models: "Unknown · Not checked yet · Check models lists them from the Core host's CLIs, as the New Agent dialog does.",
  });
  assert.deepEqual(page.facts(page.harness("Core host", "Claude Code")), {
    CLI: "Yes · Found · 2.1.296 (Claude Code)",
    "Signed in": "Yes · Signed in · claude.ai",
    Models: "Unknown · Not checked yet · Check models lists them from the Core host's CLIs, as the New Agent dialog does.",
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
    CLI: "Unknown · Not known · The last check didn't reach this machine.",
    "Signed in": "Unknown · Not known · Machine checks don't read Codex's sign-in; Core knows it only on its own host.",
    Models: "Unknown · Not checked here · An SSH machine's models are listed when an Agent there chooses one.",
  });
  assert.equal(page.facts().Compatibility,
    "Unknown · Not defined · Which versions work together isn't defined for this release, so it isn't guessed from version numbers.");
  assert.deepEqual([...page.calls].sort(), [...READS].sort(), "only reads, once each");
  page.close();
});

test("what can't be read or was never checked is Unknown, not guessed; a CLI Core can't use says why", async () => {
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
            // As an SSH check reports it: not usable, with Core's reason, and no sign-in of its own.
            { harness: "claude", supported: true, found: false, executable: "/opt/homebrew/bin/claude", version: "2.1.296 (Claude Code)", error: "Claude Code there is not logged in: run claude login on it" },
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
    "Signed in": "Unknown · Not known · Machine checks don't read Codex's sign-in; Core knows it only on its own host.",
    Models: "Unknown · Not checked here · An SSH machine's models are listed when an Agent there chooses one.",
  });
  assert.deepEqual(page.facts(page.harness("Studio", "Claude Code")), {
    CLI: "No · Not usable · 2.1.296 (Claude Code) · Claude Code there is not logged in: run claude login on it",
    "Signed in": "Unknown · Not known · The last check didn't report it: `claude auth status` there gave no answer, Claude Code couldn't run, or the check was made before SSH checks reported sign-in. A sign-in problem shows on the CLI line.",
    Models: "Unknown · Not checked here · An SSH machine's models are listed when an Agent there chooses one.",
  });
  assert.equal(page.facts(page.machine("Studio").querySelector("dl"))["Managed Jobs"],
    "Yes · Record only · Saved before Job limits: nothing is held there.");
  assert.deepEqual([...page.calls].sort(), [...READS].sort());
  page.close();
});

test("on the Core host a signed-out Claude Code is found and signed out; one that can't run is found but not usable", async () => {
  // Core's check counts both as not found; its sign-in is what tells them apart.
  const hint = "Claude Code on host-a is not logged in: run claude login";
  const bridge = "Claude Code was found, but node (needed by Yuzuno's Claude bridge) was not";
  for (const [claude, cli, signedIn] of [
    [{ error: hint, signIn: { state: "signedOut", method: "none" } }, "Yes · Found · 2.1.296 (Claude Code) · /usr/bin/claude", `No · Signed out · ${hint}`],
    [{ error: bridge }, `No · Not usable · 2.1.296 (Claude Code) · ${bridge}`, "Unknown · Not known · Sign-in is read only when the CLI can run."],
  ]) {
    const answers = core();
    const local = answers["/api/machines"].machines[0];
    local.lastCheck.harnesses[1] = { harness: "claude", supported: true, found: false, executable: "/usr/bin/claude", version: "2.1.296 (Claude Code)", ...claude };
    const page = mount(answers);
    page.window.show();
    await tick();
    const facts = page.facts(page.harness("Core host", "Claude Code"));
    assert.equal(facts.CLI, cli);
    assert.equal(facts["Signed in"], signedIn);
    page.close();
  }
});

test("an SSH machine's Claude Code sign-in is what its last check's `claude auth status` said there, signed in or out, apart from unreported, unreached and never checked", async () => {
  const hint = "Claude Code is installed there but not logged in for SSH sessions: run over SSH, `claude auth status` reports not logged in (auth method: none).";
  for (const [claude, cli, signedIn] of [
    [{ found: true, signIn: { state: "signedIn", method: "claude.ai" } }, "Yes · Found · 2.1.296 (Claude Code) · /opt/homebrew/bin/claude", "Yes · Signed in · claude.ai"],
    [{ found: false, error: hint, signIn: { state: "signedOut", method: "none" } }, "Yes · Found · 2.1.296 (Claude Code) · /opt/homebrew/bin/claude", `No · Signed out · ${hint}`],
    // Found, but the check didn't report a sign-in: not known, never signed out.
    [{ found: true }, "Yes · Found · 2.1.296 (Claude Code) · /opt/homebrew/bin/claude",
      "Unknown · Not known · The last check didn't report it: `claude auth status` there gave no answer, Claude Code couldn't run, or the check was made before SSH checks reported sign-in. A sign-in problem shows on the CLI line."],
  ]) {
    const answers = core();
    answers["/api/machines"].machines[1].lastCheck = {
      machineId: "box", startedAt: hoursAgo(0.1), checkedAt: hoursAgo(0.1), durationMs: 3000, reachable: true,
      harnesses: [{ harness: "claude", supported: true, executable: "/opt/homebrew/bin/claude", version: "2.1.296 (Claude Code)", ...claude }],
    };
    const page = mount(answers);
    page.window.show();
    await tick();
    const facts = page.facts(page.harness("Build box", "Claude Code"));
    assert.equal(facts.CLI, cli);
    assert.equal(facts["Signed in"], signedIn);
    assert.deepEqual([...page.calls].sort(), [...READS].sort(), "only reads: the sign-in is the stored check's");
    page.close();
  }
  // Never checked: nothing to say yet.
  const answers = core();
  answers["/api/machines"].machines[1].lastCheck = null;
  const page = mount(answers);
  page.window.show();
  await tick();
  assert.equal(page.facts(page.harness("Build box", "Claude Code"))["Signed in"], "Unknown · Not checked yet · Check the machine on the Machines page.");
  page.close();
});

test("an SSH machine the last check didn't reach: its CLIs are Unknown, even with Core's placeholder Claude entry", async () => {
  // As Core stores a failed SSH probe (machines.rs): unreachable, with a
  // placeholder {harness: "claude", supported: true, found: false}.
  const answers = core();
  answers["/api/machines"].machines[1].lastCheck.harnesses = [{ harness: "claude", supported: true, found: false }];
  const page = mount(answers);
  page.window.show();
  await tick();
  const reach = "Unknown · Not known · The last check didn't reach this machine.";
  assert.equal(page.facts(page.machine("Build box").querySelector("dl")).Reached, "No · Not reached · ssh: connect to host box.test port 22: Connection timed out");
  assert.equal(page.facts(page.harness("Build box", "Claude Code")).CLI, reach, "not 'No · Not found'");
  assert.equal(page.facts(page.harness("Build box", "Claude Code"))["Signed in"], "Unknown · Not known · The last check didn't reach this machine.");
  assert.equal(page.facts(page.harness("Build box", "Codex")).CLI, reach);
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

test("a Core without its update manager reports no release or readiness: Unknown, not \"not ready\"", async () => {
  // As /api/health answers when Core runs without the update manager.
  const page = mount(core({ "/api/health": { product: "yuzuno", application: "yuzuno", version: "0.1.0", workspaceId: "w" } }));
  page.window.show();
  await tick();
  assert.deepEqual(page.facts(page.group("Workspace service")), {
    Version: "Yes · 0.1.0",
    Release: "Unknown · Not reported",
    State: "Unknown · Not reported · This Core doesn't report whether its API and storage are ready.",
  });
  page.close();
});

test("in the desktop app its version is read from the app's own status, never an update check", async () => {
  const page = mount(core(), { desktop: { version: "0.3.0", channel: "installer", unavailable: null, phase: "idle", error: null, receivedBytes: 0, totalBytes: null, available: null } });
  page.window.show();
  await tick();
  assert.equal(page.facts(page.group("This device"))["Desktop app"], "Yes · 0.3.0 · Installed by the Yuzuno installer; it updates from the Desktop app card.");
  assert.deepEqual(page.invoked, ["desktop_update_status"]);
  page.close();
  // A copy the installer didn't install, and one whose updates are blocked,
  // say so as the Desktop app card does.
  for (const [status, said] of [
    [{ channel: "unknown", unavailable: null }, "Yes · 0.3.0 · Not installed by the Yuzuno installer, so it can't update itself."],
    [{ channel: "installer", unavailable: "Updates are off for this copy." }, "Yes · 0.3.0 · Updates are off for this copy."],
  ]) {
    const other = mount(core(), { desktop: { version: "0.3.0", phase: "idle", error: null, receivedBytes: 0, totalBytes: null, available: null, ...status } });
    other.window.show();
    await tick();
    assert.equal(other.facts(other.group("This device"))["Desktop app"], said);
    assert.deepEqual(other.invoked, ["desktop_update_status"]);
    other.close();
  }
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

test("the Core host's models are listed only on Check models, with when; a failure says why; SSH machines stay not checked here", async () => {
  const page = mount(core({
    "/api/models": { models: [
      { id: "gpt-6", model: "gpt-6", displayName: "GPT-6", isDefault: true },
      { id: "gpt-6-mini", model: "gpt-6-mini", displayName: "GPT-6 mini" },
    ] },
    "/api/models?harness=claude": () => ({ status: 502, body: { error: "Claude Code could not start" } }),
  }));
  page.window.show();
  await tick();
  assert.ok(!page.calls.some((c) => c.includes("/api/models")), "opening lists no models");
  const buttons = [...page.document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Check models");
  assert.equal(buttons.length, 1, "only the Core host has one");
  assert.ok(page.machine("Core host").contains(buttons[0]));
  buttons[0].click();
  await tick(80);
  assert.match(page.facts(page.harness("Core host", "Codex")).Models, /^Yes · 2 models · Default GPT-6 · checked .+$/);
  assert.match(page.facts(page.harness("Core host", "Claude Code")).Models, /^No · Couldn't list models · .*Claude Code could not start.* · checked .+$/);
  assert.equal(page.facts(page.harness("Build box", "Codex")).Models,
    "Unknown · Not checked here · An SSH machine's models are listed when an Agent there chooses one.");
  // The dialog's two catalog reads, then the section reads again (a Codex
  // failure would change its connection); nothing else, nothing sent.
  assert.deepEqual([...page.calls].sort(), [...READS, ...READS, "GET /api/models", "GET /api/models?harness=claude"].sort());
  page.close();
});
