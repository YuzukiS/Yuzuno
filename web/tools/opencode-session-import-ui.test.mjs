// T-61 slice 8: the "OpenCode export" path of the create dialog, in JSDOM
// over a scripted API. The chosen file goes to Core as it is, in one upload;
// its preview says what is kept and what is left out; adding sends one
// import with the name and folder the user confirmed. An answer lost on the
// way is read back by its request, and an import not yet settled goes on
// under the same request, never as a second one.
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
const fixture = await mkdtemp(path.join(cache, "opencode-session-import-ui-"));
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
      lib: { entry, name: "OpenCodeImportUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const REQUEST = "5e55a0ee-0000-4000-8000-0000000000a1";
const EARLIER = "5e55a0ee-0000-4000-8000-0000000000b2";
const agent = { id: "agent-o", name: "Port the parser", harness: "opencode" };
const preview = (extra = {}) => ({
  requestId: REQUEST,
  sourceSession: "ses_0123456789abcdefABCDEFGHIJ",
  title: "Port the parser",
  cwd: "/home/me/app",
  turns: 2,
  messages: 9,
  model: "stub/fake",
  agent: "build",
  droppedPermissions: true,
  droppedMetadata: false,
  cost: 0.42,
  existing: null,
  pending: null,
  earlierCopies: [],
  ...extra,
});
const created = (extra = {}) => ({
  state: "completed",
  requestId: REQUEST,
  agent,
  importOutcome: "created",
  connected: true,
  warnings: [],
  ...extra,
});

/** `handler(url, init)`: an answer for a call, an Error (Core refuses it),
 * "network" (no answer reaches the page), or undefined for the default. */
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
    const json = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body: json ?? init.body });
    const override = await handler?.(url, init, json);
    if (override === "network") throw new TypeError("Failed to fetch");
    if (override instanceof Error)
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: override.message }),
      };
    const body =
      override ??
      (url.endsWith("/opencode/sessions/import/file")
        ? preview()
        : url.endsWith("/opencode/sessions/import")
          ? created()
          : url.endsWith("/machines")
            ? { machines: [] }
            : url.includes("/models")
              ? { models: [] }
              : {});
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
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(node, text);
  node.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await tick();
}
async function open(page, props = {}) {
  page.window.renderCreate({
    open: true,
    close() {},
    defaultCwd: "/workspace",
    disabled: false,
    onCreated() {},
    projects: [],
    opencode: true,
    ...props,
  });
  await tick();
  button(page, "OpenCode export").click();
  await tick();
}
/** Chooses `file` in the tab's file field, as the browser's chooser does. */
async function choose(page, file) {
  const input = page.document.querySelector('.opencode-session-import input[type="file"]');
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await tick();
  await tick();
}
const exportFile = (page, text = '{"info":{},"messages":[]}') =>
  new page.window.File([text], "session.json", { type: "application/json" });
const field = (page, label) =>
  [...page.document.querySelectorAll(".opencode-session-import label")]
    .find((l) => l.textContent.startsWith(label))
    .querySelector("input");
const uploads = (page) => page.calls.filter((c) => c.url.endsWith("/opencode/sessions/import/file"));
const imports = (page) =>
  page.calls.filter((c) => c.url.endsWith("/opencode/sessions/import") && c.init.method === "POST");
const reads = (page) => page.calls.filter((c) => c.url.includes("/opencode/sessions/import?requestId="));
// Anything that would connect, send or run a turn.
const runs = (page) => page.calls.filter((c) => /(reconnect|messages|turns|send|resume)/.test(c.url));

test("the export goes to Core as it is, its preview says what is kept, and one import sends the confirmed name and folder", async () => {
  const page = mount();
  let made;
  let closed = 0;
  try {
    await open(page, { onCreated: (...args) => (made = args), close: () => closed++ });
    assert.match(page.document.body.textContent, /from the file it was exported to/);
    const file = exportFile(page);
    await choose(page, file);
    assert.equal(uploads(page).length, 1, "one upload");
    const sent = uploads(page)[0];
    assert.equal(sent.init.method, "POST");
    assert.equal(sent.init.body, file, "the chosen file itself, not read into the page");
    assert.equal(sent.init.headers["Content-Type"], "application/octet-stream");
    const text = page.document.querySelector(".session-preview").textContent;
    assert.match(text, /Exported session read/);
    assert.match(text, /2 turns/);
    assert.match(text, /Port the parser/);
    assert.match(text, /\/home\/me\/app/);
    assert.match(text, /9 messages · model stub\/fake · agent build · cost \$0\.42/);
    const notes = page.document.querySelector(".session-import-warnings").textContent;
    assert.match(notes, /keeps stub\/fake if OpenCode on your Core host lists it/);
    assert.match(notes, /permission rules aren’t brought over/);
    assert.doesNotMatch(notes, /metadata/, "only what this file holds is said");
    assert.match(page.document.querySelector(".session-handoff-note").textContent, /asks nothing of a model/);
    assert.equal(field(page, "Agent name").value, "Port the parser");
    assert.equal(field(page, "Folder").value, "/home/me/app", "the session's folder, filled in");
    await value(page, field(page, "Agent name"), "Parser port");
    await value(page, field(page, "Folder"), "/home/me/worktree");
    button(page, "Import as a new Agent").click();
    button(page, "Import as a new Agent").click();
    await tick();
    await tick();
    assert.equal(imports(page).length, 1, "a double click imports once");
    assert.deepEqual(imports(page)[0].body, { requestId: REQUEST, name: "Parser port", cwd: "/home/me/worktree" });
    assert.deepEqual(made, [agent, "imported", true]);
    assert.equal(closed, 1);
    assert.deepEqual(runs(page), []);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("the tab is offered only while Core creates OpenCode Agents", async () => {
  const page = mount();
  try {
    page.window.renderCreate({ open: true, close() {}, defaultCwd: "/workspace", disabled: false, onCreated() {}, opencode: false });
    await tick();
    assert.equal(button(page, "OpenCode export"), undefined);
    assert.ok(button(page, "Existing Claude session"), "the other tabs stay");
    assert.deepEqual(uploads(page), []);
  } finally {
    page.close();
  }
});

test("a file past 64 MiB is refused before anything is sent, and Core's refusal of a file is shown as it came", async () => {
  const page = mount((url) =>
    url.endsWith("/import/file")
      ? new Error("这个文件来自 OpenCode 1.x；请用 OpenCode 2.x 导出：`opencode session export`；没有导入")
      : undefined,
  );
  try {
    await open(page);
    const big = exportFile(page);
    Object.defineProperty(big, "size", { value: 64 * 1024 * 1024 + 1 });
    await choose(page, big);
    assert.deepEqual(uploads(page), [], "nothing uploaded");
    assert.match(page.document.querySelector('[role="alert"]').textContent, /larger than 64 MiB/);
    await choose(page, exportFile(page));
    assert.equal(uploads(page).length, 1);
    assert.match(page.document.querySelector('[role="alert"]').textContent, /OpenCode 1\.x.*opencode session export/);
    assert.equal(page.document.querySelector(".session-preview"), null, "no preview, nothing to import");
    assert.deepEqual(imports(page), []);
  } finally {
    page.close();
  }
});

test("a name is held to Core's 100 bytes: a long title is cut on a whole character, and a longer name can't be sent", async () => {
  const title = "解析".repeat(20); // 40 characters, 120 bytes.
  const page = mount((url) => (url.endsWith("/import/file") ? preview({ title }) : undefined));
  try {
    await open(page);
    await choose(page, exportFile(page));
    const name = field(page, "Agent name");
    assert.equal(name.value, "解析".repeat(16) + "解", "33 characters, 99 bytes");
    await value(page, name, "解析".repeat(17));
    assert.match(page.document.body.textContent, /This name is 102 bytes; up to 100 bytes fit\./);
    assert.equal(button(page, "Import as a new Agent").disabled, true);
    await value(page, name, "Parser");
    assert.equal(button(page, "Import as a new Agent").disabled, false);
    await value(page, field(page, "Folder"), " ");
    assert.equal(button(page, "Import as a new Agent").disabled, true, "a folder is needed");
    assert.deepEqual(imports(page), []);
  } finally {
    page.close();
  }
});

test("the same file again opens the Agent it made and imports nothing; another export of the session is named as a new copy", async () => {
  let existing = agent;
  const page = mount((url) =>
    url.endsWith("/import/file")
      ? existing
        ? preview({ existing })
        : preview({ requestId: EARLIER, earlierCopies: [{ agentId: "agent-o", name: "Port the parser" }] })
      : undefined,
  );
  let made;
  try {
    await open(page, { onCreated: (...args) => (made = args) });
    await choose(page, exportFile(page));
    assert.match(page.document.body.textContent, /Already in your workspace/);
    assert.match(page.document.querySelector(".session-handoff-note").textContent, /imported already/);
    assert.equal(page.document.querySelector(".opencode-session-import fieldset"), null, "nothing to confirm");
    button(page, "Open agent").click();
    await tick();
    assert.deepEqual(made, [agent, "existing", false]);
    assert.deepEqual(imports(page), []);

    existing = null;
    made = undefined;
    await choose(page, exportFile(page));
    assert.match(
      page.document.querySelector(".session-import-warnings").textContent,
      /imported before, as Port the parser\. This export differs, so it becomes a new copy\./,
    );
    button(page, "Import as a new Agent").click();
    await tick();
    assert.equal(imports(page)[0].body.requestId, EARLIER);
    assert.deepEqual(made, [agent, "imported", true]);
  } finally {
    page.close();
  }
});

test("an answer lost on the way is read back by its request, and the import is never sent twice", async () => {
  const page = mount((url, init) =>
    url.endsWith("/opencode/sessions/import") && init.method === "POST"
      ? "network"
      : url.includes("/import?requestId=")
        ? created()
        : undefined,
  );
  let made;
  try {
    await open(page, { onCreated: (...args) => (made = args) });
    await choose(page, exportFile(page));
    button(page, "Import as a new Agent").click();
    await tick();
    await tick();
    assert.equal(imports(page).length, 1);
    assert.equal(reads(page).length, 1, "read back once");
    assert.match(reads(page)[0].url, new RegExp(`/api/opencode/sessions/import\\?requestId=${REQUEST}$`));
    assert.equal(reads(page)[0].init.method, undefined, "a read, not another import");
    assert.deepEqual(made, [agent, "imported", true]);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("no answer at all leaves a check by the same request; an import not settled goes on under it", async () => {
  let readBack = "network";
  let answer = { state: "uncertain", requestId: REQUEST, message: "OpenCode 没有回答这次写入；重试会接着进行，不会写第二次", warnings: [] };
  const page = mount((url, init) =>
    url.endsWith("/opencode/sessions/import") && init.method === "POST"
      ? answer
      : url.includes("/import?requestId=")
        ? readBack
        : undefined,
  );
  let made;
  try {
    await open(page, { onCreated: (...args) => (made = args) });
    await choose(page, exportFile(page));
    button(page, "Import as a new Agent").click();
    await tick();
    assert.match(page.document.body.textContent, /OpenCode 没有回答这次写入/, "Core's own words");
    assert.equal(page.document.querySelector(".opencode-session-import fieldset").disabled, true, "the name and folder are the import's now");
    answer = "network";
    button(page, "Try again").click();
    await tick();
    await tick();
    assert.equal(imports(page).length, 2);
    assert.equal(imports(page)[1].body.requestId, REQUEST, "the same request again");
    assert.match(page.document.body.textContent, /No answer from Core\. The import may have gone through: check it first\./);
    readBack = created();
    button(page, "Check the import").click();
    await tick();
    assert.equal(imports(page).length, 2, "a check sends no import");
    assert.equal(reads(page).length, 2);
    assert.deepEqual(made, [agent, "imported", true]);
  } finally {
    page.close();
  }
});

test("an import of the same file still going is continued by its own request", async () => {
  const page = mount((url) => (url.endsWith("/import/file") ? preview({ pending: EARLIER }) : undefined));
  let made;
  try {
    await open(page, { onCreated: (...args) => (made = args) });
    await choose(page, exportFile(page));
    assert.match(page.document.body.textContent, /An import of this file hasn’t finished\. Continue it/);
    button(page, "Continue import").click();
    await tick();
    assert.equal(imports(page).length, 1);
    assert.equal(imports(page)[0].body.requestId, EARLIER, "that import, not this upload's");
    assert.deepEqual(made, [agent, "imported", true]);
  } finally {
    page.close();
  }
});

test("a failed import says why and waits for the file to be chosen again", async () => {
  let fail = true;
  const page = mount((url, init) =>
    url.endsWith("/opencode/sessions/import") && init.method === "POST" && fail
      ? { state: "failed", requestId: REQUEST, message: "这个会话用的 agent「review」不是这台机器的 OpenCode 里可以选的主 agent；没有导入", warnings: [] }
      : undefined,
  );
  try {
    await open(page);
    await choose(page, exportFile(page));
    button(page, "Import as a new Agent").click();
    await tick();
    assert.match(page.document.querySelector('[role="alert"]').textContent, /agent「review」/);
    assert.equal(button(page, "Import as a new Agent").disabled, true);
    fail = false;
    await choose(page, exportFile(page));
    assert.equal(uploads(page).length, 2, "the file chosen again is uploaded again");
    assert.equal(button(page, "Import as a new Agent").disabled, false);
  } finally {
    page.close();
  }
});

test("what Core said beside a made Agent is shown before it opens", async () => {
  const notice = "文件用的模型 stub/fake 不在这台机器的 OpenCode 里；新 Agent 用 OpenCode 的默认模型，可以在设置里另选";
  const page = mount((url, init) =>
    url.endsWith("/opencode/sessions/import") && init.method === "POST" ? created({ warnings: [notice] }) : undefined,
  );
  let made;
  let closed = 0;
  try {
    await open(page, { onCreated: (...args) => (made = args), close: () => closed++ });
    await choose(page, exportFile(page));
    button(page, "Import as a new Agent").click();
    await tick();
    assert.equal(made, undefined, "not opened yet");
    assert.match(page.document.body.textContent, /Imported.*Port the parser/s);
    assert.match(page.document.querySelector(".session-import-warnings").textContent, /默认模型/);
    button(page, "Open agent").click();
    await tick();
    assert.deepEqual(made, [agent, "imported", true]);
    assert.equal(closed, 1);
  } finally {
    page.close();
  }
});

test("the tab follows a language change, the preview, name and folder kept", async () => {
  const page = mount();
  const language = async (value) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: value }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await tick();
  };
  try {
    await open(page);
    await choose(page, exportFile(page));
    await value(page, field(page, "Agent name"), "Parser port");
    const before = page.calls.length;
    await language("zh-Hans");
    const text = page.document.body.textContent;
    assert.match(text, /OpenCode 导出文件.*已读取导出的会话.*2 个 Turn.*9 条消息 · 模型 stub\/fake · agent build · 费用 \$0\.42.*导入为新 Agent/s);
    assert.match(page.document.querySelector(".session-handoff-note").textContent, /不会向模型请求任何内容/);
    assert.equal(field(page, "Agent 名称").value, "Parser port");
    assert.equal(field(page, "文件夹").value, "/home/me/app");
    await language("en");
    assert.equal(field(page, "Agent name").value, "Parser port");
    assert.equal(page.calls.length, before, "changing the language uploads and imports nothing");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
