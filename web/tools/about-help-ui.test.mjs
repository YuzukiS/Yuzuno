// About & help in Settings (T-191): opened from Updates & about, it shows the
// version and release notes the Workspace service reports, the project's own
// help and feedback pages, and the license texts this page's build serves,
// read only when opened. Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(root, ".about-help-test-"));
let bundle;
try {
  const entry = path.join(temporary, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceUpdatesHost} from ${JSON.stringify(path.join(root, "src/WorkspaceUpdates.tsx"))};
const root = createRoot(document.getElementById('root'));
const navigation = { agents: [], projects: [], onNavigate: () => {} };
window.renderSettings = () => root.render(<WorkspaceUpdatesHost enabled open onOpenChange={() => {}}
  onNeedsReloadChange={() => {}} preserveDrafts={() => {}} navigation={navigation}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: { entry, name: "AboutHelpTest", formats: ["iife"] } } });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check, message) {
  for (let n = 0; n < 300; n++) { const result = check(); if (result) return result; await tick(); }
  assert.fail(message);
}
const COMMIT = "c215011" + "9".repeat(33);
const release = {
  ...unmanagedUpdates.current,
  releaseId: "core-20261024-c215011",
  version: "2026.10.24-core.17",
  gitSha: COMMIT,
  notes: "Settings gains Runtime & versions.\nFixes a fixture problem.",
};
const managed = { ...unmanagedUpdates, managed: true, reason: undefined, current: release };
const development = {
  ...unmanagedUpdates,
  current: { ...unmanagedUpdates.current, releaseId: "development", version: "0.1.0", gitSha: "", notes: "Development checkout" },
};
const text = (body, type = "text/plain; charset=utf-8") => ({
  ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === "content-type" ? type : null) },
  json: async () => JSON.parse(body), text: async () => body,
});

function mount(t, answers) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [];
  window.fetch = async (url, init = {}) => {
    const where = new URL(url, "http://isolated.test").pathname;
    calls.push(`${init.method ?? "GET"} ${where}`);
    const value = answers[where];
    if (typeof value === "function") return value(window);
    if (value === undefined) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '{"error":"not in this fixture"}' };
    return text(JSON.stringify(value), "application/json");
  };
  window.eval(bundle);
  window.renderSettings();
  const document = window.document;
  const page = {
    window, document, calls, errors,
    button: (label) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label),
    about: () => document.querySelector("#settings-about"),
    row: (label) => document.querySelector(`#settings-about [role="group"][aria-label="${label}"]`),
    link: (label) => [...document.querySelectorAll("#settings-about a")].find((a) => a.textContent.trim() === label),
  };
  page.open = async () => {
    (await until(() => page.button("Open About & help"), "Updates & about offers About & help")).click();
    return until(() => page.row("This version"), "About & help is shown");
  };
  return page;
}
async function openLicense(page, title) {
  const details = [...page.document.querySelectorAll("#settings-about .about-license")]
    .find((item) => item.querySelector("summary").textContent.trim() === title);
  details.open = true;
  await tick();
  return details;
}

test("About & help shows the version and notes the Workspace service runs, and the project's pages for that version", async (t) => {
  const page = mount(t, { "/api/updates": managed });
  await page.open();
  const version = page.row("This version").textContent;
  assert.match(version, /Workspace service 2026\.10\.24-core\.17/);
  assert.match(version, /core-20261024-c215011/);
  assert.match(version, /c2150119/, "the short commit");
  assert.equal(page.about().querySelector(".settings-current").textContent, "2026.10.24-core.17");
  const notes = page.row("Release notes").querySelector("details");
  assert.equal(notes.querySelector("summary").textContent.trim(), "What’s in 2026.10.24-core.17");
  assert.equal(notes.querySelector(".updates-release-notes").textContent, release.notes);
  const links = {
    "Read me for this version": `https://github.com/YuzukiS/Yuzuno/blob/${COMMIT}/README.md`,
    "Every published release": "https://github.com/YuzukiS/Yuzuno/releases",
    "Report a problem or request a feature": "https://github.com/YuzukiS/Yuzuno/issues/new/choose",
    "Report a security problem privately": "https://github.com/YuzukiS/Yuzuno/security/advisories/new",
  };
  for (const [label, href] of Object.entries(links)) {
    const link = page.link(label);
    assert.ok(link, `a link: ${label}`);
    assert.deepEqual([link.href, link.target, link.rel], [href, "_blank", "noreferrer"], label);
  }
  assert.ok(!page.calls.some((c) => c.includes("/licenses/")), "no license text is read before it is opened");
  // The one write is Updates' own: opening Settings on a managed install
  // looks for a newer release. About & help sends nothing.
  assert.deepEqual(page.calls.filter((c) => !c.startsWith("GET ")), ["POST /api/updates/check"]);
  // Help it points to is the editors Settings already has.
  page.button("Keyboard shortcuts").click();
  await until(() => page.document.querySelector('#settings-editor-shortcuts:not([hidden]) #settings-shortcuts-title'), "the shortcuts editor");
  assert.equal(page.document.querySelector("#settings-tab-appearance").getAttribute("aria-selected"), "true");
  assert.equal(page.document.querySelector("#settings-editor-about").hidden, true);
  page.document.querySelector("#settings-tab-updates").click();
  await page.open();
  page.button("Runtime & versions").click();
  await until(() => page.document.querySelector("#settings-editor-runtime:not([hidden]) #settings-runtime"), "Runtime & versions");
  assert.deepEqual(page.errors, []);
});

test("a license text is read from this page's build only when opened, once; the app's own page is not shown as one", async (t) => {
  let noto = 0;
  const page = mount(t, {
    "/api/updates": managed,
    "/licenses/LICENSE": () => text("                                 Apache License\n                           Version 2.0, January 2004\n"),
    // A file the build lacks: Core answers with index.html.
    "/licenses/THIRD_PARTY_NOTICES.txt": () => text("<!doctype html><title>Yuzuno</title>", "text/html; charset=utf-8"),
    // As a browser's fetch fails: a TypeError of the page's own.
    "/licenses/LICENSE-NotoSansSC.txt": (window) => {
      if (noto++ === 0) throw new window.TypeError("Failed to fetch");
      return text("SIL OPEN FONT LICENSE Version 1.1\n");
    },
  });
  await page.open();
  const reads = (file) => page.calls.filter((c) => c === `GET /licenses/${file}`).length;
  const license = await openLicense(page, "Yuzuno · Apache License 2.0");
  await until(() => license.querySelector("pre"), "the license text");
  assert.match(license.querySelector("pre").textContent, /Apache License\n\s+Version 2\.0/);
  license.open = false;
  await tick();
  license.open = true;
  await tick();
  assert.equal(reads("LICENSE"), 1, "read once");

  const notices = await openLicense(page, "Third-party notices for this page");
  await until(() => notices.querySelector('[role="alert"]'), "the missing notices are said to be missing");
  assert.match(notices.textContent, /doesn’t include this file/);
  assert.equal(notices.querySelector("pre"), null, "the app's page is not shown as a license");

  const font = await openLicense(page, "Noto Sans SC font · SIL Open Font License 1.1");
  await until(() => font.querySelector('[role="alert"]'), "the failed read is said");
  assert.match(font.textContent, /Couldn’t read it from the Workspace service: Failed to fetch/);
  font.open = false;
  await tick();
  font.open = true;
  await until(() => font.querySelector("pre"), "opening it again reads again");
  assert.equal(font.querySelector('[role="alert"]'), null);
  assert.equal(reads("LICENSE-NotoSansSC.txt"), 2);
  assert.deepEqual(page.calls.filter((c) => !c.startsWith("GET ")), ["POST /api/updates/check"], "Updates' own check, nothing of About's");
  assert.deepEqual(page.errors, []);
});

test("a development checkout says it has no release notes and links the newest source; search finds About & help", async (t) => {
  const page = mount(t, { "/api/updates": development });
  await page.open();
  assert.match(page.row("This version").textContent, /development/);
  assert.match(page.row("This version").textContent, /git rev-parse HEAD/);
  assert.equal(page.row("This version").querySelectorAll("code").length, 1, "no commit to show");
  assert.match(page.row("Release notes").textContent, /A development checkout has no release notes\./);
  assert.equal(page.row("Release notes").querySelector("details"), null, "\"Development checkout\" is not shown as notes");
  assert.equal(page.link("Read me (newest source)")?.href, "https://github.com/YuzukiS/Yuzuno#readme");

  const search = page.document.querySelector('input[type="search"]');
  for (const word of ["license", "反馈", "release notes"]) {
    Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(search, word);
    search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await until(() => page.document.querySelector("#settings-search-results"), "search results");
    assert.ok(page.button("Open About & help"), `"${word}" finds About & help`);
  }
  assert.deepEqual(page.errors, []);
});

test("before the Workspace service says its version, About & help says so instead of guessing", async (t) => {
  const page = mount(t, {});
  await page.open();
  assert.match(page.row("This version").textContent, /hasn’t said which version it runs yet/);
  assert.match(page.row("Release notes").textContent, /Shown once the Workspace service says which release it runs/);
  assert.equal(page.about().querySelector(".settings-current"), null);
  assert.equal(page.link("Read me (newest source)")?.href, "https://github.com/YuzukiS/Yuzuno#readme");
});
