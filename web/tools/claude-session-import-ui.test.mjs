// T-27: the "Existing Claude session" path of the create dialog, in JSDOM
// over a scripted API. Listing is one bounded page at a time; choosing a
// session reads its preview; adding sends one import with the name,
// Project and folder the user confirmed, and nothing that would run Claude.
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
const fixture = await mkdtemp(path.join(cache, "claude-session-import-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderCreate = props => root.render(<RemoteCreateAgent {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "ClaudeImportUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const A = "5e55a0ee-0000-4000-8000-0000000000a1";
const B = "5e55a0ee-0000-4000-8000-0000000000b2";
const C = "5e55a0ee-0000-4000-8000-0000000000c3";
const now = Date.now();
const session = (sessionId, title, extra = {}) => ({
  sessionId,
  title,
  firstPrompt: title,
  cwd: "/home/me/app",
  gitBranch: "main",
  tag: null,
  lastModified: now - 3 * 86_400_000,
  createdAt: null,
  fileSize: 100,
  existingAgentId: null,
  ...extra,
});
const preview = (id, extra = {}) => ({
  session: session(id, "Fix the build"),
  saved: 9,
  prompts: 2,
  images: 0,
  compacted: false,
  subagents: 0,
  model: "claude-opus-5-5",
  recent: [
    { role: "user", text: "Run the tests", at: null },
    { role: "assistant", text: "All 12 pass.", at: null },
  ],
  folderExists: true,
  existingAgentId: null,
  occupancy: "unknown",
  ...extra,
});
const agent = { id: "agent-a", name: "Build fix", harness: "claude" };
const projects = [
  { id: "p1", name: "App", defaultDirs: {}, archivedAt: null },
  { id: "p2", name: "Research", defaultDirs: {}, archivedAt: null },
];

function mount(handler) {
  const calls = [],
    errors = [];
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
    if (override instanceof Error)
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: override.message }),
      };
    const body =
      override ??
      (url.includes("/claude/sessions?")
        ? url.includes("offset=20")
          ? {
              sessions: [session(B, "Second page"), session(C, "Release")],
              next: null,
            }
          : {
              sessions: [
                session(A, "Fix the build"),
                session(B, "Second page"),
              ],
              next: 20,
            }
        : url.endsWith("/claude/sessions/preview")
          ? preview(JSON.parse(init.body).sessionId)
          : url.endsWith("/claude/sessions/import")
            ? { agent, existing: false }
            : url.endsWith("/machines")
              ? { machines: [] }
              : url.includes("/models")
                ? { models: [] }
                : { agent });
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  window.eval(bundle);
  return {
    window,
    document: window.document,
    calls,
    errors,
    close: () => window.close(),
  };
}
const buttons = (page, label) =>
  [...page.document.querySelectorAll("button")].filter((node) =>
    node.textContent.trim().startsWith(label),
  );
const button = (page, label) => buttons(page, label)[0];
async function value(page, node, text) {
  Object.getOwnPropertyDescriptor(
    node.tagName === "SELECT"
      ? page.window.HTMLSelectElement.prototype
      : page.window.HTMLInputElement.prototype,
    "value",
  ).set.call(node, text);
  node.dispatchEvent(
    new page.window.Event(node.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await tick();
}
async function open(page, props = {}) {
  page.window.renderCreate({
    open: true,
    close() {},
    defaultCwd: "/workspace",
    disabled: false,
    onCreated() {},
    projects,
    initialProjectId: "p1",
    ...props,
  });
  await tick();
  button(page, "Existing Claude session").click();
  await tick();
  await tick();
}
const listCalls = (page) =>
  page.calls.filter((c) => c.url.includes("/claude/sessions?"));
const importCalls = (page) =>
  page.calls.filter((c) => c.url.endsWith("/claude/sessions/import"));
const rows = (page) =>
  [...page.document.querySelectorAll(".claude-session-list button")].map(
    (b) => b.querySelector("strong").textContent,
  );
// Anything that would connect, resume or send a turn.
const runs = (page) =>
  page.calls.filter((c) =>
    /(reconnect|messages|turns|send|resume)/.test(c.url),
  );

test("a bounded list, a preview on choice, and one import with the confirmed name, Project and folder", async () => {
  const page = mount();
  let created;
  try {
    await open(page, { onCreated: (a, source) => (created = [a, source]) });
    assert.match(
      listCalls(page)[0].url,
      /\/api\/claude\/sessions\?offset=0&limit=20$/,
    );
    assert.deepEqual(rows(page), ["Fix the build", "Second page"]);
    button(page, "Show more").click();
    await tick();
    assert.match(listCalls(page)[1].url, /offset=20&limit=20$/);
    assert.deepEqual(
      rows(page),
      ["Fix the build", "Second page", "Release"],
      "a session listed again is not doubled",
    );
    assert.equal(button(page, "Show more"), undefined, "no more pages");

    button(page, "Fix the build").click();
    await tick();
    const chosen = page.document.querySelector(
      '.claude-session-list button[aria-pressed="true"]',
    );
    assert.equal(chosen.querySelector("strong").textContent, "Fix the build");
    assert.deepEqual(page.calls.at(-1).body, { sessionId: A });
    const text = page.document.body.textContent;
    assert.match(text, /2 prompts/);
    assert.match(text, /Run the tests/);
    assert.match(text, /All 12 pass\./);
    assert.match(text, /last used claude-opus-5-5/);
    const handoff = page.document.querySelector(
      ".session-handoff-note",
    ).textContent;
    assert.match(handoff, /doesn’t lock sessions/);
    assert.match(handoff, /can’t tell whether this one is still open/);
    assert.match(handoff, /Adding it runs nothing/);
    assert.equal(
      page.document.querySelector('[aria-label="Project"]').value,
      "p1",
      "the Project being viewed, shown for confirmation",
    );
    const folder = [...page.document.querySelectorAll("input[readonly]")][0];
    assert.equal(folder.value, "/home/me/app");

    await value(
      page,
      page.document.querySelector('[aria-label="Project"]'),
      "p2",
    );
    const name = [...page.document.querySelectorAll("label")]
      .find((l) => l.textContent.startsWith("Agent name"))
      .querySelector("input");
    assert.equal(name.value, "Fix the build");
    await value(page, name, "Build fix");
    button(page, "Add to workspace").click();
    button(page, "Add to workspace").click();
    await tick();
    assert.equal(importCalls(page).length, 1, "a double click imports once");
    assert.deepEqual(importCalls(page)[0].body, {
      sessionId: A,
      name: "Build fix",
      projectId: "p2",
      cwd: "/home/me/app",
    });
    assert.deepEqual(created, [agent, "imported"]);
    assert.deepEqual(runs(page), []);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a session already in the workspace opens that Agent and imports nothing", async () => {
  const page = mount((url) =>
    url.endsWith("/claude/sessions/preview")
      ? preview(A, { existingAgentId: "agent-a" })
      : undefined,
  );
  let created;
  try {
    await open(page, { onCreated: (a, source) => (created = [a, source]) });
    button(page, "Fix the build").click();
    await tick();
    assert.match(page.document.body.textContent, /Already in your workspace/);
    assert.equal(
      page.document.querySelector('[aria-label="Project"]'),
      null,
      "nothing to choose for an existing Agent",
    );
    button(page, "Open agent").click();
    await tick();
    assert.equal(importCalls(page).length, 0);
    assert.match(page.calls.at(-1).url, /\/api\/agents\/agent-a$/);
    assert.deepEqual(created, [agent, "existing"]);
  } finally {
    page.close();
  }
});

test("what is missing or unknown is said plainly, and a session whose folder is gone cannot be added", async () => {
  const page = mount((url) =>
    url.endsWith("/claude/sessions/preview")
      ? preview(A, {
          folderExists: false,
          compacted: true,
          images: 2,
          session: session(A, "Fix the build", {
            lastModified: Date.now() - 60_000,
          }),
        })
      : undefined,
  );
  try {
    await open(page);
    button(page, "Fix the build").click();
    await tick();
    const warnings = page.document.querySelector(
      ".session-import-warnings",
    ).textContent;
    assert.match(warnings, /folder no longer exists/);
    assert.match(warnings, /compacted this session earlier/);
    assert.match(warnings, /2 images in your messages/);
    assert.match(
      warnings,
      /Saved 1 min ago: it may still be open in Claude Code/,
    );
    assert.equal(button(page, "Add to workspace").disabled, true);
  } finally {
    page.close();
  }
});

test("a pasted ID is checked before any read; errors are shown; the filter reads page one again", async () => {
  const page = mount((url) =>
    url.endsWith("/claude/sessions/preview")
      ? new Error("本机的 Claude Code 中找不到这个会话")
      : undefined,
  );
  try {
    await open(page);
    const input = page.document.querySelector("#claude-session-id");
    await value(page, input, "claude --resume not-an-id");
    button(page, "Preview session").click();
    await tick();
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /Paste a Claude Code session ID/,
    );
    assert.equal(
      page.calls.filter((c) => c.url.endsWith("/preview")).length,
      0,
    );
    await value(page, input, ` ${C} `);
    button(page, "Preview session").click();
    await tick();
    assert.deepEqual(page.calls.at(-1).body, { sessionId: C });
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /找不到这个会话/,
    );

    const filter = page.document.querySelector(".claude-sessions-filter input");
    filter.click();
    await tick();
    assert.match(
      listCalls(page).at(-1).url,
      /offset=0&limit=20&programmatic=true$/,
    );
    await value(
      page,
      page.document.querySelector(
        '[aria-label="Only sessions in this folder"]',
      ),
      " /home/me/app ",
    );
    button(page, "Filter").click();
    await tick();
    assert.match(
      listCalls(page).at(-1).url,
      /offset=0&limit=20&programmatic=true&dir=%2Fhome%2Fme%2Fapp$/,
    );
    assert.deepEqual(runs(page), []);
  } finally {
    page.close();
  }
});

test("Existing Claude session follows a language change from another window, the chosen session, name and Project kept (T-189)", async () => {
  const page = mount();
  const language = async (value) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: value }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await tick();
    await tick();
  };
  try {
    await open(page);
    button(page, "Fix the build").click();
    await tick();
    const name = () => page.document.querySelector('.session-import input[maxlength="60"]');
    await value(page, name(), "Build fix");
    await value(page, page.document.querySelector("select"), "p2");
    const kept = () => ({
      chosen: page.document.querySelector('.claude-session-list button[aria-pressed="true"] strong').textContent,
      rows: rows(page),
      name: name().value,
      project: page.document.querySelector("select").value,
      folder: page.document.querySelector("input[readonly]").value,
      recent: [...page.document.querySelectorAll(".claude-session-recent p")].map((p) => p.textContent),
    });
    const english = { text: page.document.body.textContent, kept: kept() };
    assert.match(english.text, /Saved conversation found.*2 prompts.*last used claude-opus-5-5.*Add to workspace/s);
    const before = page.calls.length;
    await language("zh-Hans");
    const text = page.document.body.textContent;
    assert.match(text, /欢迎回到你的工作.*找到已保存的会话.*2 条提示.*上次使用 claude-opus-5-5.*添加到 Workspace/s);
    assert.match(page.document.querySelector(".session-handoff-note").textContent, /^Claude Code 不会锁定会话.*添加它不会运行任何东西/);
    assert.deepEqual(kept(), english.kept, "the session, name, Project, folder and its messages as they were");
    await language("en");
    assert.equal(page.document.body.textContent, english.text);
    assert.equal(page.calls.length, before, "changing the language reads and imports nothing");
    assert.deepEqual(runs(page), []);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
