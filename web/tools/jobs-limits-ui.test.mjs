// The concurrency settings T-108 adds, against fixture HTTP only; no Core:
// Windows' ceiling in the Jobs panel and an SSH machine's Jobs settings in
// its editor.
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
const fixture = await mkdtemp(path.join(cache, "jobs-limits-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WindowsJobs} from ${JSON.stringify(path.join(root, "src/JobBudget.tsx"))};
import {MachineEditor} from ${JSON.stringify(path.join(root, "src/MachineEditor.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderWindows = props => root.render(<WindowsJobs {...props}/>);
window.renderEditor = props => root.render(<MachineEditor onCancel={() => {}} {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "JobsLimitsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = "condition settles") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.ok(check(), what);
}
const windows = (extra = {}) => ({
  available: true, maxJobs: 2, set: false, defaultMaxJobs: 2, activeCount: 1, sharesThisBudget: true, ...extra,
});
const mini = {
  id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", codex: "codex", defaultCwd: "/Users/me/projects",
  maxJobs: 3, budget: { cpuMillis: 4000, memoryMiB: 8192 }, limitMode: "limited",
};

function mount() {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const answers = [];
  window.fetch = async (url, init = {}) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url, method: init.method || "GET", body });
    const [status, answer] = answers.shift() ?? [200, body];
    return { ok: status < 400, status, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  window.eval(bundle);
  const label = (text) => [...window.document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(text));
  return {
    window, document: window.document, calls, errors, answers,
    button: (text) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === text),
    input: (text) => label(text)?.querySelector("input"),
    select: (text) => label(text)?.querySelector("select"),
    type(text, value) {
      const input = label(text).querySelector("input");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    choose(text, value) {
      const select = label(text).querySelector("select");
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(select, value);
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    close: () => window.close(),
  };
}

test("Windows shows its jobs against the ceiling it keeps inside this host's budget", async () => {
  const page = mount();
  try {
    page.window.renderWindows({ windows: windows(), onSaved: () => {} });
    await until(() => page.document.querySelector(".jobs-windows"));
    const cell = page.document.querySelector(".jobs-windows");
    assert.equal(cell.querySelector(".jobs-meter-name").textContent, "Windows");
    assert.equal(cell.querySelector(".jobs-meter-value").textContent, "1 of 2 in use");
    assert.equal(cell.querySelector(".jobs-meter-bar").getAttribute("aria-label"), "Windows: 1 in use of 2 at once (default)");
    assert.equal(cell.querySelector(".jobs-meter-used").style.width, "50%");
    assert.equal(cell.querySelector(".jobs-reserved-text").textContent, "Shares this host's budget");
    const input = page.input("At most at once");
    assert.equal(input.value, "", "the default is an empty field");
    assert.equal(input.placeholder, "Default (2)");
    assert.equal(input.min, "1");
    assert.equal(input.max, "64");
    assert.match(cell.textContent, /only a ceiling: Windows jobs still share this host's CPU and RAM budget/);
    assert.equal(page.button("Use default"), undefined, "nothing to return to while the default applies");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("the Windows ceiling is saved as a number, returns to the default as null, and a refusal keeps what was typed", async () => {
  const page = mount();
  let saved = 0;
  try {
    page.window.renderWindows({ windows: windows({ maxJobs: 3, set: true, activeCount: 4 }), onSaved: () => saved++ });
    await until(() => page.button("Save"));
    const cell = page.document.querySelector(".jobs-windows");
    // Lowered below the slots held: the bar is full and the words say so.
    assert.equal(cell.querySelector(".jobs-meter-value").textContent, "4 of 3 in use");
    assert.equal(cell.querySelector(".jobs-meter-used").style.width, "100%");
    assert.equal(page.input("At most at once").value, "3");
    page.type("At most at once", "5");
    page.answers.push([200, { maxJobs: 5, set: true, defaultMaxJobs: 2 }]);
    page.button("Save").click();
    await until(() => saved === 1);
    assert.deepEqual(page.calls[0], { url: "/api/jobs/windows", method: "POST", body: { maxJobs: 5 } });
    page.answers.push([200, { maxJobs: 2, set: false, defaultMaxJobs: 2 }]);
    page.button("Use default").click();
    await until(() => saved === 2);
    assert.deepEqual(page.calls[1].body, { maxJobs: null });
    // Opened again, it starts from what is saved (still 3 in these props).
    cell.querySelector("summary").click();
    await until(() => cell.querySelector("details").open);
    assert.equal(page.input("At most at once").value, "3");
    // Out of 1–64 the field itself stops the save; nothing is sent.
    page.type("At most at once", "65");
    page.button("Save").click();
    await pause();
    assert.equal(page.calls.length, 2);
    assert.equal(page.input("At most at once").validity.rangeOverflow, true);
    const refusal = "workspace_updating: Workspace is preparing an update. Your input was not sent; keep the draft or cancel the update wait.";
    page.type("At most at once", "6");
    page.answers.push([409, { error: refusal }]);
    page.button("Save").click();
    await until(() => cell.querySelector("[role=alert]"));
    assert.equal(cell.querySelector("[role=alert]").textContent, refusal);
    assert.deepEqual(page.calls[2].body, { maxJobs: 6 });
    assert.equal(page.input("At most at once").value, "6", "the typed value stays to try again");
    assert.equal(cell.querySelector("details").open, true);
    assert.equal(saved, 2);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an SSH machine's Jobs settings start from what is saved and only a changed one is sent", async () => {
  const page = mount();
  const saved = [];
  try {
    page.window.renderEditor({ machine: mini, onSaved: (m) => saved.push(m) });
    await until(() => page.input("Jobs at once"));
    assert.equal(page.input("Jobs at once").value, "3");
    assert.equal(page.input("Jobs at once").placeholder, "Default (2)");
    assert.equal(page.input("Jobs CPU budget").value, "4");
    assert.equal(page.input("Jobs RAM budget").value, "8192");
    assert.equal(page.select("A limit this machine can’t enforce").value, "limited");
    // An edit elsewhere leaves every Jobs setting to Core as it is.
    page.type("Default working folder", "/Users/me/work");
    await pause();
    page.answers.push([200, { ...mini, defaultCwd: "/Users/me/work" }]);
    page.button("Save changes").click();
    await until(() => saved.length === 1);
    assert.deepEqual(page.calls[0], {
      url: "/api/machines/mini", method: "PUT",
      body: { name: "Mac mini", target: "mac-mini", codex: "codex", defaultCwd: "/Users/me/work" },
    });
    // Cleared fields go back to the defaults as null; strict is chosen by name.
    page.type("Jobs at once", "");
    page.type("Jobs CPU budget", "");
    page.type("Jobs RAM budget", "");
    page.choose("A limit this machine can’t enforce", "strict");
    await pause();
    page.button("Save changes").click();
    await until(() => saved.length === 2);
    assert.deepEqual(page.calls[1].body, {
      name: "Mac mini", target: "mac-mini", codex: "codex", defaultCwd: "/Users/me/work",
      maxJobs: null, budget: null, limitMode: "strict",
    });
    // Back to recording only, as before limits: null, said in words.
    page.choose("A limit this machine can’t enforce", "legacy");
    await pause();
    assert.match(page.document.body.textContent, /Jobs there run as they did before limits: their CPU and RAM are recorded, not held/);
    page.button("Save changes").click();
    await until(() => saved.length === 3);
    assert.deepEqual(page.calls[2].body.limitMode, null);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a machine saved before limits shows the record-only mode it keeps until it chooses", async () => {
  const page = mount();
  const saved = [];
  try {
    const { limitMode, ...before } = mini;
    page.window.renderEditor({ machine: before, onSaved: (m) => saved.push(m) });
    await until(() => page.select("A limit this machine can’t enforce"));
    assert.equal(page.select("A limit this machine can’t enforce").value, "legacy");
    assert.match(page.document.body.textContent, /Hold no limits: record resources only, as before/);
    // An edit elsewhere leaves it so: no limitMode is sent.
    page.type("Default working folder", "/Users/me/work");
    await pause();
    page.button("Save changes").click();
    await until(() => saved.length === 1);
    assert.equal("limitMode" in page.calls[0].body, false, JSON.stringify(page.calls[0].body));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a new machine's Jobs settings are sent as numbers; half a budget or a refusal keeps the form", async () => {
  const page = mount();
  const saved = [];
  try {
    page.window.renderEditor({ onSaved: (m) => saved.push(m) });
    await until(() => page.input("Jobs at once"));
    assert.equal(page.input("Jobs at once").value, "");
    assert.equal(page.select("A limit this machine can’t enforce").value, "strict");
    page.type("Machine name", "Studio");
    page.type("SSH destination", "me@studio.local");
    page.type("Default working folder", "/Users/me/studio");
    page.type("Jobs at once", "4");
    page.type("Jobs CPU budget", "1.5");
    await pause();
    page.button("Save machine").click();
    await until(() => page.document.querySelector("[role=alert]"));
    assert.equal(page.document.querySelector("[role=alert]").textContent, "Give the Jobs budget both CPU and RAM, or leave both empty.");
    assert.equal(page.calls.length, 0, "nothing is sent");
    page.type("Jobs RAM budget", "4096");
    page.choose("A limit this machine can’t enforce", "limited");
    await pause();
    page.answers.push([400, { error: "maxJobs 应在 1–64 之间" }]);
    page.button("Save machine").click();
    await until(() => page.calls.length === 1 && /maxJobs/.test(page.document.querySelector("[role=alert]")?.textContent));
    assert.deepEqual(page.calls[0], {
      url: "/api/machines", method: "POST",
      body: {
        name: "Studio", target: "me@studio.local", codex: "codex", defaultCwd: "/Users/me/studio",
        maxJobs: 4, budget: { cpuMillis: 1500, memoryMiB: 4096 }, limitMode: "limited",
      },
    });
    assert.equal(saved.length, 0);
    assert.equal(page.input("Jobs at once").value, "4", "the typed values stay");
    assert.equal(page.input("Jobs CPU budget").value, "1.5");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
