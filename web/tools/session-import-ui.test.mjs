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
const fixture = await mkdtemp(path.join(cache, "session-import-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
import {useSessionHistory} from ${JSON.stringify(path.join(root, "src/useSessionHistory.ts"))};
import {useConversationSend} from ${JSON.stringify(path.join(root, "src/useConversationSend.ts"))};
import {errorText} from ${JSON.stringify(path.join(root, "src/api.ts"))};
window.errorText = errorText;
window.errorMessage = message => errorText(new Error(message));
const root = createRoot(document.getElementById('root'));
function History({detail,selected}) {const h=useSessionHistory(detail,selected);React.useEffect(()=>{window.historyReady=true;});window.historyDetail=h.detail;return <div><p>{h.detail?.turns.map(t=>t.id).join(',')}</p><button disabled={h.loading||!h.detail?.history?.hasMore} onClick={()=>h.loadEarlier()}>Earlier</button>{h.error&&<span role="alert">{h.error}</span>}</div>}
function Delivery({detail}) {const h=useConversationSend("agent-a",null,()=>{},"codex",detail);return <div><button onClick={()=>void h.submit("A delivery preview")}>Send</button><p id="outgoing">{JSON.stringify(h.outgoing)}</p></div>}
window.renderDelivery = props => root.render(<Delivery {...props}/>);
window.renderCreate = props => root.render(<RemoteCreateAgent {...props}/>);
window.renderHistory = props => {window.historyReady=false;root.render(<History {...props}/>);};`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "ImportUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const id = "019a1234-5678-4321-aaaa-123456789abc";
const other = "019a1234-5678-4321-bbbb-123456789abc";
const permissions = {
  presets: ["ask", "auto", "full", "config"].map((id) => ({
    id,
    available: true,
  })),
};
const preview = {
  threadId: id,
  name: "Yuzuno development",
  cwd: "/home/me/yuzuno-next",
  preview: "Let’s continue designing the workspace.",
  model: "gpt-6.1",
  reasoningEffort: "high",
  turnCount: 42,
  updatedAt: 123,
  existingAgentId: null,
  warnings: [],
  permissions,
};
const agent = {
  id: "agent-a",
  name: "My development agent",
  cwd: preview.cwd,
  threadId: id,
};
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
      (url.endsWith("/preview")
        ? preview
        : url.endsWith("/import")
          ? agent
          : url.endsWith("/machines")
            ? { machines: [] }
            : url.endsWith("/models")
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
async function renderHistory(page, props) {
  page.window.renderHistory(props);
  // The hook's selection effect must finish before a request can be started.
  for (let attempt = 0; attempt < 80 && !page.window.historyReady; attempt++)
    await tick();
  assert.ok(page.window.historyReady, "history selection effects completed");
}
function button(page, label) {
  return [...page.document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === label,
  );
}
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
    ...props,
  });
  await tick();
  button(page, "Existing Codex session").click();
  await tick();
}
async function read(page, session = id) {
  await value(page, page.document.querySelector("#import-session-id"), session);
  button(page, "Preview session").click();
  await tick();
}
function importCalls(page) {
  return page.calls.filter((call) => call.url.endsWith("/import"));
}

// Permissions are chips: one radio per mode in the "Permissions" group.
async function permission(page, mode) {
  page.document.querySelector(`[aria-label="Permissions"] input[value="${mode}"]`).click();
  await tick();
}
test("preview is read-only; imports selected permissions without a new turn or resume", async () => {
  const page = mount();
  let created;
  try {
    await open(page, { onCreated: (a) => (created = a) });
    await read(page);
    assert.match(page.document.body.textContent, /42 turns/);
    assert.match(page.document.body.textContent, /gpt-6.1 · high reasoning/);
    const handoff = page.document.querySelector(
      ".session-handoff-note",
    ).textContent;
    assert.match(handoff, /original client must release this session/);
    assert.match(handoff, /idle session can still be owned/);
    assert.match(
      handoff,
      /Codex fork can continue independently with a new session ID/,
    );
    assert.match(handoff, /does not send a message or start a turn/);
    assert.equal(importCalls(page).length, 0);
    await permission(page, "full");
    button(page, "Add to workspace").click();
    button(page, "Add to workspace").click();
    await tick();
    assert.equal(importCalls(page).length, 1);
    assert.deepEqual(importCalls(page)[0].body, {
      threadId: id,
      name: preview.name,
      permissionPreset: "full",
    });
    assert.equal(created.id, agent.id);
    assert.ok(page.calls.every((c) => !/(turn|resume|reconnect)/.test(c.url)));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
test("native writer conflicts explain session ownership and preserve the draft", () => {
  const page = mount();
  try {
    const native = `thread ${id} already has an active writer`;
    const message = page.window.errorMessage(native);
    assert.match(message, /original client still owns this Codex session/);
    assert.match(message, /even if its turn has finished/);
    assert.match(message, /Release the session there/);
    assert.match(message, /official Codex fork/);
    assert.match(message, /message was not sent; your draft is kept/);
    assert.equal(page.window.errorText(native), message);
  } finally {
    page.close();
  }
});
test("unrelated native errors and partial writer text keep their original details", () => {
  const page = mount();
  try {
    for (const message of [
      "no active turn to steer",
      `thread ${id} not found`,
      "thread not-a-session-id already has an active writer",
      `remote error: thread ${id} already has an active writer`,
      `thread ${id} already has an active writer; additional diagnostic`,
    ]) {
      assert.equal(page.window.errorMessage(message), message);
      assert.equal(page.window.errorText(message), message);
    }
    assert.equal(
      page.window.errorText({ code: -32600, message: "Invalid request" }),
      JSON.stringify({ code: -32600, message: "Invalid request" }),
    );
  } finally {
    page.close();
  }
});
test("invalid IDs never reach preview API", async () => {
  const page = mount();
  try {
    await open(page);
    await read(page, "codex resume not-an-id");
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /session ID/,
    );
    assert.equal(
      page.calls.filter((c) => c.url.endsWith("/preview")).length,
      0,
    );
  } finally {
    page.close();
  }
});
test("editing ID invalidates preview and late response cannot restore previous session", async () => {
  let done;
  const page = mount((url) =>
    url.endsWith("/preview")
      ? new Promise((resolve) => (done = resolve))
      : undefined,
  );
  try {
    await open(page);
    await read(page);
    assert.ok(button(page, "Reading session…"));
    await value(page, page.document.querySelector("#import-session-id"), other);
    done(preview);
    await tick();
    assert.ok(page.document.querySelector(".session-preview") === null, ".session-preview is absent");
    assert.ok(button(page, "Preview session"));
    assert.equal(importCalls(page).length, 0);
  } finally {
    page.close();
  }
});
test("existing Agent opens without creating another Agent, including a closed one", async () => {
  const page = mount((url) =>
    url.endsWith("/preview")
      ? { ...preview, existingAgentId: "agent-a" }
      : url.endsWith("/agents/agent-a")
        ? { agent: { ...agent, closedAt: "2026-10-12" } }
        : undefined,
  );
  let created;
  try {
    await open(page, { onCreated: (a) => (created = a) });
    await read(page);
    assert.ok(page.document.querySelector('[aria-label="Permissions"]') === null, '[aria-label="Permissions"] is absent');
    button(page, "Open agent").click();
    await tick();
    assert.equal(created.id, "agent-a");
    assert.ok(created.closedAt);
    assert.equal(importCalls(page).length, 0);
  } finally {
    page.close();
  }
});
test("unavailable permission catalog blocks import but can retry preview", async () => {
  const page = mount((url) =>
    url.endsWith("/preview")
      ? { ...preview, permissions: undefined }
      : undefined,
  );
  try {
    await open(page);
    await read(page);
    assert.equal(button(page, "Add to workspace").disabled, true);
    assert.ok(button(page, "Read again"));
  } finally {
    page.close();
  }
});
test("import errors retain name, selected permissions and history preview", async () => {
  const page = mount((url) =>
    url.endsWith("/import")
      ? new Error("Session cannot be imported yet")
      : undefined,
  );
  try {
    await open(page);
    await read(page);
    await permission(page, "auto");
    button(page, "Add to workspace").click();
    await tick();
    assert.match(
      page.document.querySelector('[role="alert"]').textContent,
      /cannot be imported/,
    );
    assert.equal(
      page.document.querySelector('[aria-label="Permissions"] input:checked').value,
      "auto",
    );
    assert.ok(page.document.querySelector(".session-preview"));
    assert.equal(button(page, "Add to workspace").disabled, false);
  } finally {
    page.close();
  }
});
test("closing import during an in-flight operation is guarded", async () => {
  let done,
    closed = 0;
  const page = mount((url) =>
    url.endsWith("/import")
      ? new Promise((resolve) => (done = resolve))
      : undefined,
  );
  try {
    await open(page, { close: () => closed++ });
    await read(page);
    button(page, "Add to workspace").click();
    await tick();
    assert.equal(button(page, "New agent").disabled, true);
    assert.equal(button(page, "Cancel").disabled, true);
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await tick();
    assert.equal(closed, 0);
    done(agent);
    await tick();
    assert.equal(closed, 1);
  } finally {
    page.close();
  }
});
test("read-only preview never queries or imports sessions", async () => {
  const page = mount();
  try {
    await open(page, { disabled: true });
    assert.equal(
      page.document.querySelector("#import-session-id").disabled,
      true,
    );
    assert.deepEqual(page.calls, []);
  } finally {
    page.close();
  }
});
const turn = (id) => ({ id, status: "completed", items: [] });
const detail = {
  agent,
  turns: [turn("c"), turn("d")],
  history: { hasMore: true, nextCursor: "older", loadedCount: 2 },
  pending: [],
  artifacts: [],
};
test("history pages deduplicate and survive live refresh; changing Agent releases old pages", async () => {
  const page = mount((url) =>
    url.includes("/history?")
      ? {
          turns: [turn("a"), turn("b"), turn("c")],
          hasMore: false,
          nextCursor: null,
        }
      : undefined,
  );
  try {
    await renderHistory(page, { detail, selected: agent.id });
    await tick();
    button(page, "Earlier").click();
    for (let i = 0; i < 80 && page.window.historyDetail.history.hasMore; i++)
      await tick();
    assert.equal(page.window.historyDetail.history.hasMore, false, "earlier page finished loading");
    assert.equal(page.document.querySelector("p").textContent, "a,b,c,d");
    await renderHistory(page, {
      detail: { ...detail, turns: [turn("d"), turn("e")] },
      selected: agent.id,
    });
    await tick();
    assert.equal(page.document.querySelector("p").textContent, "a,b,c,d,e");
    await renderHistory(page, {
      detail: { ...detail, agent: { id: "other" }, turns: [turn("z")] },
      selected: "other",
    });
    await tick();
    assert.equal(page.document.querySelector("p").textContent, "z");
  } finally {
    page.close();
  }
});
test("late history from another Agent is ignored", async () => {
  let done;
  const page = mount((url) =>
    url.includes("/history?")
      ? new Promise((resolve) => (done = resolve))
      : undefined,
  );
  try {
    await renderHistory(page, { detail, selected: agent.id });
    await tick();
    button(page, "Earlier").click();
    await tick();
    await renderHistory(page, {
      detail: { ...detail, agent: { id: "other" }, turns: [turn("z")] },
      selected: "other",
    });
    await tick();
    done({ turns: [turn("a")], hasMore: false, nextCursor: null });
    await tick();
    assert.equal(page.document.querySelector("p").textContent, "z");
  } finally {
    page.close();
  }
});

test("reconnect advancing the native history cursor uses the new boundary instead of skipping unseen turns", async () => {
  const page = mount((url) =>
    url.includes("/history?")
      ? { turns: [turn("a"), turn("b")], hasMore: false, nextCursor: null }
      : undefined,
  );
  try {
    await renderHistory(page, { detail, selected: agent.id });
    await tick();
    button(page, "Earlier").click();
    await tick();
    assert.equal(button(page, "Earlier").disabled, true);
    await renderHistory(page, {
      detail: {
        ...detail,
        turns: [turn("g"), turn("h")],
        history: { ...detail.history, nextCursor: "new-gap" },
      },
      selected: agent.id,
    });
    await tick();
    assert.equal(page.document.querySelector("p").textContent, "g,h");
    assert.equal(button(page, "Earlier").disabled, false);
    button(page, "Earlier").click();
    await tick();
    assert.ok(page.calls.at(-1).url.includes("cursor=new-gap"));
  } finally {
    page.close();
  }
});

test("a paged middle gap is placed between old cached and recent native turns, and refreshed contents win", async () => {
  const timed = (n) => ({
    ...turn(`T${n}`),
    startedAt: 1700000000 + n,
    items: [],
  });
  const cached = { ...detail, turns: [9, 10, 11, 16, 17, 18].map(timed) };
  let pageNumber = 0;
  const page = mount((url) =>
    url.includes("/history?")
      ? ++pageNumber === 1
        ? {
            turns: [13, 14, 15].map(timed),
            hasMore: true,
            nextCursor: "older-gap",
          }
        : { turns: [10, 11, 12].map(timed), hasMore: false, nextCursor: null }
      : undefined,
  );
  try {
    await renderHistory(page, { detail: cached, selected: agent.id });
    await tick();
    button(page, "Earlier").click();
    await tick();
    assert.equal(
      page.document.querySelector("p").textContent,
      "T9,T10,T11,T13,T14,T15,T16,T17,T18",
    );
    button(page, "Earlier").click();
    await tick();
    assert.equal(
      page.document.querySelector("p").textContent,
      "T9,T10,T11,T12,T13,T14,T15,T16,T17,T18",
    );
    const updated = {
      ...cached,
      turns: [
        ...cached.turns.map((t) =>
          t.id === "T18"
            ? {
                ...t,
                items: [
                  { id: "reply", type: "agentMessage", text: "fresh reply" },
                ],
              }
            : t,
        ),
        timed(19),
      ],
    };
    await renderHistory(page, { detail: updated, selected: agent.id });
    await tick();
    assert.equal(
      page.document.querySelector("p").textContent,
      "T9,T10,T11,T12,T13,T14,T15,T16,T17,T18,T19",
    );
    assert.equal(
      page.window.historyDetail.turns.find((t) => t.id === "T18").items[0].text,
      "fresh reply",
    );
  } finally {
    page.close();
  }
});

test("native sequence and overlap order remain authoritative for equal or missing timestamps", async () => {
  const t = (id, time) => ({ ...turn(id), startedAt: time });
  const page = mount((url) =>
    url.includes("/history?")
      ? {
          turns: [
            t("z-first", null),
            t("b-second", 1700000001),
            t("a-third", 1700000001),
          ],
          hasMore: false,
          nextCursor: null,
        }
      : undefined,
  );
  try {
    await renderHistory(page, {
      detail: {
        ...detail,
        turns: [
          t("b-second", 1700000001),
          t("a-third", 1700000001),
          t("c-fourth", null),
        ],
      },
      selected: agent.id,
    });
    await tick();
    button(page, "Earlier").click();
    // Fetch and React's commit are separate work. A fixed 25 ms tick can
    // still show the old snapshot on CI; wait for the terminal history page.
    for (let i = 0; i < 80 && page.window.historyDetail.history.hasMore; i++)
      await tick();
    assert.equal(page.window.historyDetail.history.hasMore, false, "earlier page finished loading");
    assert.equal(
      page.document.querySelector("p").textContent,
      "z-first,b-second,a-third,c-fourth",
    );
  } finally {
    page.close();
  }
});

test("native completedAt and millisecond runtime timestamps provide ordering when startedAt is absent", async () => {
  const page = mount((url) =>
    url.includes("/history?")
      ? {
          turns: [
            { ...turn("middle"), startedAt: null, completedAt: 1700000002 },
          ],
          hasMore: false,
          nextCursor: null,
        }
      : undefined,
  );
  try {
    await renderHistory(page, {
      detail: {
        ...detail,
        turns: [
          { ...turn("old"), _yuzunoStartedAt: 1700000001000 },
          { ...turn("new"), startedAt: 1700000003 },
        ],
      },
      selected: agent.id,
    });
    await tick();
    button(page, "Earlier").click();
    await tick();
    assert.equal(
      page.document.querySelector("p").textContent,
      "old,middle,new",
    );
  } finally {
    page.close();
  }
});

test("acknowledged outgoing previews stay gone when imported history pages are discarded", async () => {
  let receipt;
  const page = mount((url, init) => {
    if (!url.endsWith("/messages")) return;
    receipt = {
      input: JSON.parse(init.body),
      status: "accepted",
      turnId: "new-turn",
      error: null,
    };
    return receipt;
  });
  const detail = { agent: { id: "agent-a" }, turns: [], messageReceipts: [] };
  try {
    page.window.renderDelivery({ detail });
    await tick();
    button(page, "Send").click();
    await tick();
    assert.match(
      page.document.querySelector("#outgoing").textContent,
      /A delivery preview/,
    );
    const native = {
      ...detail,
      turns: [
        {
          id: "new-turn",
          items: [
            { type: "userMessage", clientId: receipt.input.clientMessageId },
          ],
        },
      ],
    };
    page.window.renderDelivery({ detail: native });
    await tick();
    assert.equal(page.document.querySelector("#outgoing").textContent, "[]");
    page.window.renderDelivery({ detail });
    await tick();
    assert.equal(page.document.querySelector("#outgoing").textContent, "[]");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("Existing Codex session follows a language change from another window; the preview, name and chosen permissions are kept and nothing is read again (T-189)", async () => {
  const page = mount();
  const language = async (value) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: value }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
    await tick();
    await tick();
  };
  try {
    await open(page);
    // A typed ID that isn't one: the note is worded when shown.
    await value(page, page.document.querySelector("#import-session-id"), "not-an-id");
    button(page, "Preview session").click();
    await tick();
    assert.match(page.document.querySelector('[role="alert"]').textContent, /^Paste the session ID from Codex/);
    await language("zh-Hans");
    assert.match(page.document.querySelector('[role="alert"]').textContent, /^请粘贴 Codex 的会话 ID/);
    await language("en");
    await read(page);
    const name = [...page.document.querySelectorAll("label")].find((l) => l.textContent.startsWith("Agent name")).querySelector("input");
    await value(page, name, "Kept name");
    await permission(page, "full");
    const kept = () => ({
      id: page.document.querySelector("#import-session-id").value,
      name: name.value,
      permission: page.document.querySelector('[aria-label="Permissions"] input:checked')?.value,
      folder: page.document.querySelector(".session-preview-folder").textContent,
      excerpt: page.document.querySelector(".session-preview-excerpt").textContent,
      warnings: [...page.document.querySelectorAll(".session-import-warnings p")].map((p) => p.textContent),
    });
    const english = { text: page.document.body.textContent, kept: kept() };
    assert.match(english.text, /42 turns.*gpt-6.1 · high reasoning.*Add to workspace/s);
    const before = page.calls.length;
    await language("zh-Hans");
    const text = page.document.body.textContent;
    assert.match(text, /欢迎回到你的工作.*Codex 会话 ID.*42 个 Turn.*gpt-6\.1 · high 推理.*添加到 Workspace/s);
    assert.match(page.document.querySelector(".session-handoff-note").textContent, /^原客户端必须先释放此会话.*添加会话不会发送消息/);
    assert.deepEqual(kept(), english.kept, "the ID, name, chosen permission, folder, excerpt and Codex's warnings as they were");
    await language("en");
    assert.equal(page.document.body.textContent, english.text);
    assert.equal(page.calls.length, before, "changing the language reads and imports nothing");
    assert.equal(importCalls(page).length, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
