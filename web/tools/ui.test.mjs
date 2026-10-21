import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerView, composerText, composerSelection, setComposerText, savedDraftText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { comparisonExample } from "../src/intelligent-ui/examples.ts";

const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundle = await uiTestBundle(new URL(entry, distUrl));
// The flattened bundle is one classic script (no top-level let/const/class).
// Compile it once and run it in each window's own context, as window.eval did,
// instead of parsing and compiling the whole bundle again on every mount.
const bundleScript = new vm.Script(bundle);
const pause = () => new Promise((resolve) => setTimeout(resolve, 45));
async function waitForPreviewState(read, message) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = read();
    if (value) return value;
    await pause();
  }
  assert.fail(message);
}
// The same bounded wait polled every 5 ms, for positive waits whose next
// checks read the state waited for rather than a settle period after it.
async function until(read, message) {
  const deadline = Date.now() + 60 * 45;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const base = {
  cwd: "/workspace",
  model: "test-model",
  color: "green",
  status: "idle",
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  unreadCount: 1,
  pendingCount: 0,
  lastSeq: 12,
  reviewedSeq: 5,
};
const agents = [
  { ...base, id: "a", name: "Mori", goal: "Review the interface" },
  { ...base, id: "b", name: "Hana", goal: "Check the results" },
];
const permissionCatalog = { presets: [
  { id: "config", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "read-only", profile: null } },
  { id: "ask", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", profile: null } },
  { id: "auto", available: true, permissions: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", profile: null } },
  { id: "full", available: true, permissions: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access", profile: null } },
] };

async function mount({
  preview = false,
  pending = [],
  status = "idle",
  harness = "codex",
  turnStatus,
  message = "A real-looking test reply.",
  questionItem,
  historyPage,
  receipts: initialReceipts = [],
  workSummary,
  agentError,
  turns = true,
  extraTurns = [],
  history,
  catchupItems = [],
  artifacts = [],
  files = {},
  artifactResponse,
  contextUsage,
  contextSettings,
  collaboration,
  backgroundShells,
  agentFields,
  settings,
  permissions = permissionCatalog,
  appearance,
  stored = {},
  detailDelay = 0,
  messageResponse,
  messagePayload,
  failMessageResponseOnce = false,
  failTurnResponseOnce = false,
  url,
  nativeWindow,
  beforeLoad,
  liveJobs,
  liveCI,
  workspaceIdentity,
  models,
  modelsResponse,
  claudeRuntime,
  settingsResponse,
  compactResponse,
} = {}) {
  const calls = [];
  const eventUrls = [];
  const eventSources = [];
  const metrics = { detailInFlight: 0, maxDetailInFlight: 0 };
  const scrollTargets = [];
  const errors = [];
  const copied = [];
  const receipts = initialReceipts;
  let messageResponseLost = false;
  let turnResponseLost = false;
  const console = new VirtualConsole();
  console.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: url || `http://127.0.0.1:4317/${preview ? "?preview=1" : ""}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole: console,
    },
  );
  const { window } = dom;
  window.matchMedia = (media) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.EventSource = class {
    constructor(url) {
      eventUrls.push(url);
      eventSources.push(this);
    }
    close() {}
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrollTargets.push(this);
  };
  window.HTMLElement.prototype.scrollTo = function () {};
  window.navigator.clipboard = { writeText: async (text) => copied.push(text) };
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/messages") && messageResponse) return messageResponse(url, init);
    if (url.endsWith("/settings") && settingsResponse) return settingsResponse(url, init);
    if (url.endsWith("/compact") && compactResponse) return compactResponse(url, init);
    if (url.endsWith("/models") && modelsResponse) return modelsResponse(url, init);
    if (url.includes("/api/artifact?") && artifactResponse)
      return artifactResponse(url, init);
    let body;
    if (url.includes("/history?") && historyPage) body = historyPage;
    else if (url.endsWith("/api/workspace"))
      body = {
        ...(liveCI || workspaceIdentity ? { workspace: { id: workspaceIdentity || "ci-fixture" } } : {}),
        agents: agents.map((a) =>
          a.id === "a"
            ? {
                ...a,
                status,
                harness,
                settings,
                pendingCount: pending.length,
                workSummary,
                error: agentError,
                ...agentFields,
              }
            : a,
        ),
        runtime: { connected: true },
        defaultCwd: "/workspace",
      };
    else if (url.match(/\/api\/agents\/[ab]$/)) {
      const agent = agents.find((a) => url.endsWith(`/${a.id}`));
      body = {
        agent: {
          ...agent,
          status,
          harness: agent.id === "a" ? harness : "codex",
          settings,
          workSummary,
          error: agentError,
          ...agentFields,
        },
        pending: agent.id === "a" ? pending : [],
        artifacts,
        contextUsage: agent.id === "a" ? contextUsage : null,
        collaboration: agent.id === "a" ? collaboration : null,
        backgroundShells: agent.id === "a" ? backgroundShells : null,
        claudeRuntime: agent.id === "a" ? claudeRuntime : null,
        messageReceipts: receipts.filter((r) => r.agentId === agent.id),
        history,
        turns: turns
          ? [
              {
                id: "t1",
                status: turnStatus || (status === "working" ? "inProgress" : "completed"),
                items: [
                  {
                    id: "u1",
                    type: "userMessage",
                    content: [{ type: "text", text: "Please review." }],
                  },
                  {
                    id: "r1",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: message,
                    ...(agent.id === "a" ? questionItem : {}),
                  },
                ],
              },
              ...extraTurns,
            ]
          : [],
      };
    } else if (messagePayload && url.includes("/items/") && url.includes("/payload")) {
      body = messagePayload;
    } else if (url.endsWith("/turns") && failTurnResponseOnce && !turnResponseLost) {
      turnResponseLost = true;
      throw new window.Error("Native session reconnect is not confirmed");
    } else if (url.endsWith("/messages")) {
      const input = JSON.parse(init.body);
      body = receipts.find(
        (r) => r.input.clientMessageId === input.clientMessageId,
      );
      if (!body) {
        body = {
          input,
          status: "accepted",
          turnId: "t1",
          agentId: url.split("/").at(-2),
        };
        receipts.push(body);
      }
      if (failMessageResponseOnce && !messageResponseLost) {
        messageResponseLost = true;
        throw new window.Error("Response lost after acceptance");
      }
    } else if (url.endsWith("/models")) {
      body = {
        permissions,
        context: contextSettings,
        models: models || [
          {
            id: "test-model",
            model: "test-model",
            displayName: "Test model",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "More reasoning" },
            ],
          },
        ],
      };
    } else if (url.endsWith("/context/apply")) {
      body = { ...contextSettings, settingsSubmitted: true, observedWindowTokens: null };
    } else if (url.includes("/api/artifact?"))
      body =
        files[new URL(url, window.location.href).searchParams.get("path")] ??
        "";
    else if (url.endsWith("/api/jobs/live") && liveJobs) body = liveJobs();
    else if (url.endsWith("/api/ci/live")) body = liveCI ? liveCI() : { agents: {} };
    else if (url.endsWith("/api/catchup"))
      body = {
        generatedAt: "2026-10-12",
        items: catchupItems,
        source: "records",
        coverage: { fromSeq: 0, toSeq: 12 },
      };
    else body = {};
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (detailDelay && url.match(/\/api\/agents\/[ab]$/)) {
          metrics.maxDetailInFlight = Math.max(metrics.maxDetailInFlight, ++metrics.detailInFlight);
          const snapshot = JSON.parse(JSON.stringify(body));
          await new Promise((resolve) => setTimeout(resolve, detailDelay));
          metrics.detailInFlight--;
          return snapshot;
        }
        return body;
      },
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
    };
  };
  if (appearance) window.localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  if (nativeWindow) window.__TAURI__ = { window: { getCurrentWindow: () => nativeWindow } };
  beforeLoad?.(window);
  bundleScript.runInContext(dom.getInternalVMContext());
  // Wait for the fixture detail, not a fixed delay that races React effects
  // when several agents are building/testing on this machine. Check before
  // the first wait and then every 5 ms, within the old 40 x 45 ms deadline.
  const loaded = () =>
    window.document.querySelector(".conversation-scroll") &&
    !window.document.querySelector(".conversation-scroll .loading-state");
  const loadDeadline = Date.now() + 40 * 45;
  while (!loaded() && Date.now() < loadDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    window.document.querySelector(".conversation-scroll"),
    "Conversation mounted",
  );
  assert.ok(window.document.querySelector(".conversation-scroll .loading-state") === null, "Fixture detail loaded");
  return {
    dom,
    window,
    document: window.document,
    calls,
    eventUrls,
    eventSources,
    metrics,
    scrollTargets,
    errors,
    copied,
    close: () => window.close(),
  };
}
function button(page, text) {
  return [...page.document.querySelectorAll("button")].find((b) =>
    b.textContent.includes(text),
  );
}
async function openQuestion(page) {
  page.document.querySelector(".question-dock-open").click();
  await pause();
  assert.equal(page.document.querySelectorAll(".async-question").length, 1);
}
function answerValue(page, value) {
  const input = page.document.querySelector('.async-question input[type="text"]');
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
function setValue(window, input, value) {
  setComposerText(input, value);
}
function pasteText(page, text) {
  const field = page.document.querySelector("[data-composer-input]");
  field.focus();
  const event = new page.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: type => type === "text/plain" ? text : "" } });
  field.dispatchEvent(event);
}

test("history, pinned request, dock and rail preserve two identical blocks without closed full-source DOM", async () => {
  const source = "👨‍👩‍👧‍👦e\u0301中文123456" + "\r\n  complete source".repeat(150);
  const text = "before " + source + " between " + source + " after\r\n";
  const blocks = [{id:"paste-one",start:7,end:7+source.length},{id:"paste-two",start:16+source.length,end:16+source.length*2}];
  const label = "👨‍👩‍👧‍👦e\u0301中文123456…";
  const item = {id:"pasted-user",type:"userMessage",clientId:"pasted-client",content:[{type:"text",text}],_yuzunoTextBlocks:blocks};
  const requestParts = [{kind:"text",text:"before "},{kind:"paste",...blocks[0],label:label.slice(0,-1),truncated:true,preview:source.slice(0,160)},
    {kind:"text",text:" between "},{kind:"paste",...blocks[1],label:label.slice(0,-1),truncated:true,preview:source.slice(0,160)},{kind:"text",text:" after\r\n"}];
  const page = await mount({ status:"working", extraTurns:[{id:"t-paste",status:"inProgress",items:[item]}],
    workSummary:{text:"before source",kind:"task",source:"user",turnId:"t-paste",itemId:item.id,requestParts},
    messagePayload:{itemId:item.id,fields:{content:item.content,_yuzunoTextBlocks:blocks}} });
  try {
    for (const selector of ['[data-item-id="pasted-user"] .user-text', '.current-turn-excerpt', '.current-turn-messages', '.agent-work-summary']) {
      const node = page.document.querySelector(selector);
      assert.ok(node,selector);
      const chips = [...node.querySelectorAll('.pasted-text-chip')];
      assert.equal(chips.length,2,selector);
      assert.deepEqual(chips.map(c => c.dataset.pasteId),blocks.map(b => b.id));
      assert.ok(chips.every(c => c.textContent.startsWith(label)),selector);
      assert.ok(!node.textContent.includes('complete source'),selector + ' excludes closed body');
    }
    assert.ok(!page.document.body.textContent.includes(source));
    const trigger = page.document.querySelector('[data-item-id="pasted-user"] .pasted-text-chip');
    trigger.click(); await pause();
    assert.equal(page.document.querySelector('.message-text-source').textContent,source);
    button(page,'Copy full text').click(); await pause();
    assert.equal(page.copied.at(-1),source);
    page.document.querySelector('.message-text-source').dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await pause(); assert.equal(page.document.activeElement,trigger);
    assert.ok(!page.document.querySelector('.message-text-source'));
    page.document.querySelector('.agent-work-summary .pasted-text-chip').click(); await pause(); await pause();
    assert.equal(page.document.querySelector('.message-text-source').textContent,source);
    assert.ok(page.calls.some(c => c.url === '/api/agents/a/items/pasted-user/payload?turnId=t-paste'));
    page.document.querySelector('.message-text-source').dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await pause();
    const dock = page.document.querySelector('[data-turn-choice="t-paste"]'); dock.focus(); await pause();
    const dockBlock = page.document.querySelector('.turn-dock-preview .pasted-text-chip');
    assert.ok(dockBlock); dockBlock.click(); await pause();
    assert.equal(page.document.querySelector('.message-text-source').textContent,source,'dock dialog survives focus moving outside dock');
    assert.deepEqual(page.errors,[]);
  } finally { page.close(); }
});

test("image-only and mixed pasted requests retain attachment captions and exact block ranges", async () => {
  const source = "  image context\r\n".repeat(15);
  for (const type of ["image", "localImage"]) {
    for (const mixed of [false, true]) {
      const text = "before " + source + " after\r\n";
      const item = {id:"image-user",type:"userMessage",content:[{type,url:"attachment",path:"/fixture/input-images/a/" + "a".repeat(64) + ".png"},
        ...(mixed ? [{type:"text",text}] : [])],
        _yuzunoTextBlocks:mixed ? [{id:"image-paste",start:7,end:7+source.length}] : []};
      const page = await mount({status:"working",extraTurns:[{id:"image-turn",status:"inProgress",items:[item]}]});
      try {
        for (const selector of [".current-turn-excerpt", ".current-turn-messages"]) {
          const node = page.document.querySelector(selector);
          assert.ok(node,selector);
          assert.match(node.textContent,/\[Image\]/);
          assert.equal(node.querySelectorAll(".pasted-text-chip").length,mixed ? 1 : 0);
        }
        page.document.querySelector('[data-turn-choice="image-turn"]').focus();
        const preview = await waitForPreviewState(() => {
          const shown = page.document.querySelector(".turn-dock-preview");
          return shown && /\[Image\]/.test(shown.textContent) && shown;
        }, "the Turn preview with its image caption");
        if (mixed) {
          preview.querySelector(".pasted-text-chip").click();
          const opened = await waitForPreviewState(() => page.document.querySelector(".message-text-source"), "the pasted text to open");
          assert.equal(opened.textContent,source);
          const copies = page.copied.length;
          button(page,"Copy full text").click();
          await waitForPreviewState(() => page.copied.length > copies, "the full text to be copied");
          assert.equal(page.copied.at(-1),source);
        }
        assert.deepEqual(page.errors,[]);
      } finally { page.close(); }
    }
  }
});

test("legacy long user history is generic while Agent updates keep attribution", async () => {
  const text = "legacy user text\n".repeat(15);
  const page = await mount({extraTurns:[{id:"legacy",status:"completed",items:[{id:"legacy-u",type:"userMessage",content:[{type:"text",text}]}]}],
    workSummary:{text:"Agent progress remains an update",source:"agent",kind:"progress",turnId:"legacy",itemId:"report"}});
  try {
    const message = page.document.querySelector('[data-item-id="legacy-u"]');
    assert.match(message.textContent,/Long text/); assert.ok(!message.textContent.includes(text));
    assert.ok(!page.document.querySelector('.agent-work-summary .pasted-text-chip'));
    assert.match(page.document.querySelector('.agent-work-summary').textContent,/Update · Agent progress/);
  } finally { page.close(); }
});

test("both Harnesses send complete ordered paste bodies and retain them after a failed request", async () => {
  for (const harness of ["codex", "claude"]) {
    const page = await mount({ harness, failMessageResponseOnce: true, failTurnResponseOnce: true });
    try {
      const field = page.document.querySelector("[data-composer-input]");
      const first = "  code\r\n\tindented\r\n".repeat(12), second = "长".repeat(2100);
      setValue(page.window, field, "  Before ");
      pasteText(page, first);
      composerView(field).dispatch({ changes: { from: composerText(field).length, insert: " between " }, selection: { anchor: composerText(field).length + 9 } });
      pasteText(page, second);
      composerView(field).dispatch({ changes: { from: composerText(field).length, insert: " after\n\n" } });
      await pause();
      const expected = "  Before " + first + " between " + second + " after\n\n";
      const ids = [...page.document.querySelectorAll(".pasted-text-composer .pasted-text-chip")].map(el => el.dataset.pasteId);
      assert.equal(ids.length, 2);
      assert.equal(savedDraftText(page.window.localStorage, "a"), expected);
      page.document.querySelector('[aria-label="Send message"]').click();
      await pause(); await pause();
      assert.deepEqual([...page.document.querySelectorAll(".pasted-text-composer .pasted-text-chip")].map(el => el.dataset.pasteId), ids);
      assert.equal(savedDraftText(page.window.localStorage, "a"), expected);
      page.document.querySelector('[aria-label="Send message"]').click();
      await pause(); await pause();
      const requests = page.calls.filter(c => c.init.method === "POST" && /\/(messages|turns)$/.test(c.url));
      assert.equal(requests.length, 2);
      assert.equal(JSON.parse(requests[0].init.body).text, expected);
      assert.equal(JSON.parse(requests[1].init.body).text, expected);
      assert.equal(composerText(field), "");
      assert.equal(savedDraftText(page.window.localStorage, "a"), "");
      assert.deepEqual(page.errors, []);
    } finally { page.close(); }
  }
});

test("opening, editing and removing a paste never submits; Escape restores focus and deletion can be undone", async () => {
  const page = await mount({ status: "working" });
  try {
    pasteText(page, "  first\r\n".repeat(12));
    await pause();
    const input = page.document.querySelector("[data-composer-input]");
    input.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await pause();
    assert.equal(savedDraftText(page.window.localStorage, "a"), "  first\r\n".repeat(12), "Code-editor line duplication cannot copy an unbacked block marker");
    const chip = page.document.querySelector(".pasted-text-chip"), id = chip.dataset.pasteId;
    chip.click(); await pause();
    const source = page.document.querySelector('[aria-label="Full pasted text"]');
    assert.equal(source.value, "  first\n".repeat(12));
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(source, "  edited\n\n");
    source.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await pause();
    button(page, "Save changes").click(); await pause();
    assert.equal(savedDraftText(page.window.localStorage, "a"), "  edited\r\n\r\n");
    assert.equal(page.document.querySelector(".pasted-text-chip").dataset.pasteId, id);
    page.document.querySelector(".pasted-text-chip").click(); await pause();
    page.document.querySelector('[aria-label="Full pasted text"]').dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.equal(page.document.activeElement.dataset.pasteId, id);
    page.document.querySelector(".pasted-text-chip").click(); await pause();
    button(page, "Remove block").click(); await pause();
    assert.ok(page.document.querySelector(".pasted-text-chip") === null, ".pasted-text-chip is absent");
    const field = page.document.querySelector("[data-composer-input]");
    field.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await pause();
    assert.equal(page.document.querySelector(".pasted-text-chip").dataset.pasteId, id);
    assert.equal(savedDraftText(page.window.localStorage, "a"), "  edited\r\n\r\n");
    assert.equal(page.calls.filter(c => c.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("context tooltip has no fabricated live usage and Escape never interrupts working", async () => {
  const page = await mount({ status: "working" });
  try {
    const trigger = page.document.querySelector(".context-usage-button");
    assert.match(trigger.getAttribute("aria-label"), /Usage unavailable/);
    assert.equal(
      page.document.querySelector(".context-usage").dataset.level,
      "unknown",
    );
    trigger.focus();
    await pause();
    assert.match(
      page.document.querySelector('[role="tooltip"]').textContent,
      /isn't available/,
    );
    page.window.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await pause();
    assert.ok(page.document.querySelector('[role="tooltip"]') === null, '[role="tooltip"] is absent');
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
    trigger.click();
    await pause();
    assert.ok(page.document.querySelector('[role="tooltip"]'));
    button(page, "Hana").click();
    await pause();
    assert.ok(page.document.querySelector('[role="tooltip"]') === null, '[role="tooltip"] is absent');
    assert.match(
      page.document
        .querySelector(".context-usage-button")
        .getAttribute("aria-label"),
      /Usage unavailable/,
    );
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("context color samples are confined to the labelled read-only preview", async () => {
  const page = await mount({ preview: true });
  try {
    for (const [name, percent, level] of [
      ["Mikan", 46, "low"],
      ["Mori", 78, "medium"],
      ["Hana", 94, "high"],
    ]) {
      button(page, name).click();
      await pause();
      const trigger = page.document.querySelector(".context-usage-button");
      assert.match(
        trigger.getAttribute("aria-label"),
        new RegExp(`${percent}% used.*sample`),
      );
      assert.equal(
        page.document.querySelector(".context-usage").dataset.level,
        level,
      );
      trigger.focus();
      await pause();
      assert.match(
        page.document.querySelector('[role="tooltip"]').textContent,
        /not live conversation usage/,
      );
    }
    assert.equal(page.calls.length, 0);
    assert.equal(page.eventUrls.length, 0);
  } finally {
    page.close();
  }
});

// Catch Up's reply list was replaced by Home (T-85), which lists no replies.
// Opening an Agent's item from Home and returning without reading anything
// is covered by home-ui.test.mjs.

test("latest tools expand until an Agent reply and manual history expansion survives live updates", async () => {
  const turn = {
    id: "progress-turn",
    status: "inProgress",
    items: [
      {
        id: "progress-1",
        type: "agentMessage",
        phase: "commentary",
        text: "I will inspect the file preview first.",
      },
      {
        id: "tool-1",
        type: "commandExecution",
        command: "rg preview web/src",
        aggregatedOutput: "Found preview",
        status: "completed",
        exitCode: 0,
      },
      {
        id: "progress-2",
        type: "agentMessage",
        phase: "commentary",
        text: "The parser drops line numbers. I am fixing that now.",
      },
      {
        id: "tool-2",
        type: "commandExecution",
        command: "npm test",
        status: "inProgress",
      },
    ],
  };
  const page = await mount({ extraTurns: [turn] });
  try {
    const stream = page.document.querySelector(
      '[data-turn-id="progress-turn"] .agent-message',
    );
    const order = () =>
      [...stream.querySelectorAll(".commentary, .final-message, .tool-activity")]
        .map((element) => element.dataset.itemId || "tools");
    assert.deepEqual(order(), ["progress-1", "tools", "progress-2", "tools"]);
    for (const message of stream.querySelectorAll(".commentary")) {
      assert.ok(message.closest("details") === null, "not inside details");
      assert.match(message.textContent, /inspect|fixing/);
    }
    const groups = stream.querySelectorAll(".execution");
    assert.equal(groups.length, 2);
    assert.equal(groups[0].open, false);
    assert.equal(groups[1].open, true);
    assert.match(
      groups[0].querySelector("summary").textContent,
      /Tool activity/,
    );
    assert.match(
      groups[1].querySelector("summary").textContent,
      /Running tools/,
    );
    groups[0].open = true;
    turn.items.splice(2, 0, {
      id: "tool-1b",
      type: "commandExecution",
      command: "cat web/package.json",
      status: "completed",
      exitCode: 0,
    });
    turn.items.at(-1).status = "completed";
    turn.status = "completed";
    turn.items.push({
      id: "progress-final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Line references are ready.",
    });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause();
    await pause();
    assert.ok(stream.querySelector(".execution") === groups[0], "the first execution group is the one rendered");
    assert.equal(groups[0].open, true);
    assert.match(groups[0].querySelector("summary").textContent, /Shell×2/);
    assert.equal(groups[1].open, false);
    assert.deepEqual(order(), [
      "progress-1",
      "tools",
      "progress-2",
      "tools",
      "progress-final",
    ]);
    assert.equal(stream.querySelectorAll(".commentary").length, 2);
    assert.equal(
      page.calls.filter((call) => call.init.method === "POST").length,
      0,
    );
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

for (const harness of ["codex", "claude"]) test(`${harness}: steering stays in native order and only visible Agent messages fold tools`, async () => {
  const tool = (id) => harness === "claude"
    ? { id, type: "claudeToolUse", name: "Bash", input: { command: "pwd" }, status: "inProgress" }
    : { id, type: "commandExecution", command: "pwd", status: "inProgress" };
  const turn = {
    id: "interleaved-turn", status: "inProgress",
    items: [
      { id: "first-input", type: "userMessage", content: [{ type: "text", text: "开始检查" }] },
      { id: "first-progress", type: "agentMessage", phase: "commentary", text: "我先检查当前文件。" },
      tool("first-tool"),
    ],
  };
  const extraTurns = [turn];
  const page = await mount({ harness, status: "working", extraTurns });
  const refresh = async () => {
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
  };
  try {
    const view = page.document.querySelector('[data-turn-id="interleaved-turn"]');
    const order = () => [...view.querySelectorAll(".user-message, .commentary, .final-message, .tool-item")]
      .map((el) => el.dataset.itemId || el.id.replace("item-", ""));
    const group = view.querySelector(".tool-activity");
    assert.equal(group.open, true);
    turn.items.push({ id: "steering-input", type: "userMessage", content: [{ type: "text", text: "请先保留现有样式。" }] });
    await refresh();
    assert.deepEqual(order(), ["first-input", "first-progress", "first-tool", "steering-input"]);
    assert.equal(group.open, true, "User steering must not prematurely fold tools");
    const user = view.querySelector('[data-item-id="steering-input"]');
    assert.ok(user.closest("details") === null, "not inside details");
    assert.match(user.querySelector(".message-label").textContent, /You/);
    const empty = { id: "next-progress", type: "agentMessage", phase: "commentary", text: "  " };
    turn.items[2].status = "completed";
    turn.items.push(empty);
    await refresh();
    assert.equal(group.open, true, "Completion and empty streaming placeholders keep tools open");
    assert.ok(view.querySelector('[data-item-id="next-progress"]') === null, '[data-item-id="next-progress"] is absent');
    empty.text = "收到，我会保留现有样式。";
    await refresh();
    assert.equal(group.open, false, "The next visible commentary folds the preceding tools");
    turn.items.push(tool("second-tool"));
    await refresh();
    const second = view.querySelectorAll(".tool-activity")[1];
    assert.equal(second.open, true);
    second.open = false;
    turn.items.at(-1).status = "completed";
    await refresh();
    assert.equal(second.open, false, "An explicit manual collapse survives tool updates");
    group.open = true;
    turn.items.push({ id: "last-reply", type: "agentMessage", phase: "final_answer", text: "修改完成。" });
    turn.status = "completed";
    await refresh();
    assert.equal(group.open, true, "Manual history inspection stays open");
    assert.equal(second.open, false);
    assert.equal(view.querySelector('#item-second-tool'), null, "Closed tools have no retained body DOM");
    second.querySelector('summary').click();
    await pause();
    assert.deepEqual(order(), ["first-input", "first-progress", "first-tool", "steering-input", "next-progress", "second-tool", "last-reply"]);
    assert.ok(view.querySelector('[data-item-id="steering-input"]') === user, "Streaming preserves message anchors");
    assert.ok(view.querySelector(".tool-activity") === group, "the tool activity group is the same element");
    assert.deepEqual(page.errors, []);
    assert.equal(page.calls.filter((call) => call.init.method === "POST").length, 0);
  } finally { page.close(); }
});

test("claude: a follow-up while your turn runs is sent once, as queued and not yet read", async () => {
  const queued = (url, init) => {
    const receipt = { input: JSON.parse(init.body), status: "queued", turnId: "t1", error: null };
    return { ok: true, status: 200, json: async () => receipt, text: async () => JSON.stringify(receipt) };
  };
  const page = await mount({ harness: "claude", status: "working", messageResponse: queued });
  try {
    const field = page.document.querySelector("[data-composer-input]");
    setValue(page.window, field, "Also run the linter.");
    const send = await until(() => {
      const button = page.document.querySelector('[aria-label="Send while working"]');
      return button && !button.disabled && button;
    }, "the follow-up button to accept the draft");
    assert.equal(send.disabled, false);
    send.click();
    await pause(); await pause();
    const posts = page.calls.filter((c) => c.init.method === "POST");
    assert.deepEqual(posts.map((c) => c.url.split("/").at(-1)), ["messages"], "a follow-up, never a new turn");
    const body = JSON.parse(posts[0].init.body);
    assert.equal(body.expectedTurnId, "t1");
    assert.equal(body.text, "Also run the linter.");
    assert.match(page.document.querySelector(".outgoing-message")?.textContent ?? "", /Sent · waiting for Claude Code to confirm/);
    assert.equal(composerText(field), "");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
  // In the turn, a follow-up says whether Claude has read it.
  const unread = await mount({ harness: "claude", status: "working", extraTurns: [{ id: "t2", status: "inProgress", items: [
    { id: "q", type: "userMessage", clientId: "q", _yuzunoDelivery: "queued", content: [{ type: "text", text: "Queued thought" }] },
    { id: "u", type: "userMessage", clientId: "u", _yuzunoDelivery: "unknown", content: [{ type: "text", text: "Lost thought" }] },
  ] }] });
  try {
    const label = (id) => unread.document.querySelector(`[data-item-id="${id}"] .message-delivery`)?.textContent;
    assert.equal(label("q"), "Sent · waiting for Claude Code to confirm");
    assert.equal(label("u"), "Not confirmed by Claude Code · not sent again");
    assert.equal(label("u1"), undefined, "an ordinary message has no delivery note");
  } finally { unread.close(); }
  // Only a turn of Claude's own is running: there is no turn of yours to add to.
  const own = await mount({ harness: "claude", status: "working", turnStatus: "completed",
    extraTurns: [{ id: "native-x", status: "inProgress", _yuzunoSource: "native", items: [] }] });
  try {
    setValue(own.window, own.document.querySelector("[data-composer-input]"), "Hello");
    await pause();
    assert.equal(own.document.querySelector('[aria-label="Send message"]')?.disabled, true);
    assert.equal(!!own.document.querySelector('[aria-label="Send while working"]'), false);
  } finally { own.close(); }
  // A kept draft whose delivery became unknown is never sent again under its
  // old id: sending it is a new message, whether or not the page knew yet.
  const lost = { clientMessageId: "lost", text: "Also run the linter.", expectedTurnId: "t1", question: null };
  const unknown = { input: lost, status: "unknown", turnId: "t1", error: "Not confirmed by Claude; not sent again" };
  const reply = (url, init) => {
    const input = JSON.parse(init.body);
    const receipt = input.clientMessageId === "lost" ? unknown : { input, status: "queued", turnId: "t1", error: null };
    return { ok: true, status: 200, json: async () => receipt, text: async () => JSON.stringify(receipt) };
  };
  for (const known of [true, false]) {
    const page = await mount({ harness: "claude", status: "working", messageResponse: reply,
      receipts: known ? [{ ...unknown, agentId: "a" }] : [],
      stored: { "yuzuno.outbox": JSON.stringify({ "a:composer": lost }) } });
    try {
      const field = page.document.querySelector("[data-composer-input]");
      setValue(page.window, field, lost.text);
      await pause();
      const send = () => page.document.querySelector('[aria-label="Send while working"]').click();
      send();
      await pause(); await pause();
      if (!known) {
        assert.equal(composerText(field), lost.text, "the old id's unknown result keeps the draft");
        send();
        await pause(); await pause();
      }
      const ids = page.calls.filter((c) => c.init.method === "POST").map((c) => JSON.parse(c.init.body).clientMessageId);
      assert.deepEqual(ids.map((id) => id === "lost"), known ? [false] : [true, false], `known=${known}`);
      assert.equal(composerText(field), "", `known=${known}`);
    } finally { page.close(); }
  }
});

test("an unconfirmed delivery preview can be hidden without marking it sent or sending it again (T-65)", async () => {
  const lost = { clientMessageId: "lost-delivery", text: "Is it done?", expectedTurnId: "t1", question: null };
  const receipts = [{ agentId: "a", input: lost, status: "uncertain", turnId: null, error: "Response lost" }];
  const outbox = JSON.stringify({ "a:composer": lost });
  const page = await mount({ harness: "claude", status: "working", receipts, stored: { "yuzuno.outbox": outbox } });
  let hidden;
  try {
    const preview = () => page.document.querySelector('[data-client-message-id="lost-delivery"]');
    assert.match(preview()?.textContent ?? "", /Delivery unconfirmed · draft kept/);
    const hide = [...preview().querySelectorAll("button")].find((b) => b.textContent === "Hide");
    hide.click();
    await pause();
    assert.equal(!!preview(), false, "hidden");
    assert.equal(page.window.localStorage.getItem("yuzuno.outbox"), outbox, "the kept draft's message id stays");
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0, "nothing is sent again");
    hidden = page.window.localStorage.getItem("yuzuno.hiddenDeliveries");
  } finally { page.close(); }
  const again = await mount({ harness: "claude", status: "working", receipts, stored: { "yuzuno.hiddenDeliveries": hidden } });
  try {
    assert.equal(!!again.document.querySelector('[data-client-message-id="lost-delivery"]'), false, "stays hidden after reload");
  } finally { again.close(); }
});

test("local Claude takes images and says large ones are scaled for Claude while originals are kept", async () => {
  for (const harness of ["claude", "codex"]) {
    const page = await mount({ harness });
    try {
      // The composer's image button takes images for both; its tooltip
      // carries the note for Claude.
      const button = page.document.querySelector('.composer-tools [aria-label="Add images"]');
      assert.equal(button?.disabled, false, harness);
      assert.equal(button?.hasAttribute("aria-disabled"), false, harness);
      assert.equal(/scaled or compressed when sent to Claude · originals are kept/.test(button?.title ?? ""), harness === "claude", harness);
      assert.deepEqual(page.errors, []);
    } finally { page.close(); }
  }
});

test("the live log shows ongoing work outside tools, distinguishes waiting and unknown, and clears on completion", async () => {
  const turn = {
    id: "live-activity",
    status: "inProgress",
    items: [
      {
        id: "done-tool",
        type: "commandExecution",
        command: "npm test",
        status: "completed",
        exitCode: 0,
      },
    ],
  };
  const page = await mount({ extraTurns: [turn] });
  try {
    const stream = page.document.querySelector(
      '[data-turn-id="live-activity"] .agent-message',
    );
    const activity = stream.querySelector('.turn-activity[role="status"]');
    assert.equal(activity.querySelector("strong").textContent, "Working");
    assert.ok(activity.closest("details") === null, "not inside details");
    assert.ok(stream.lastElementChild === activity, "the activity line is last in the stream");
    assert.equal(stream.querySelector(".execution").open, true);
    turn.status = "completed";
    turn.items[0].status = "inProgress";
    delete turn.items[0].exitCode;
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause();
    await pause();
    assert.ok(stream.querySelector(".turn-activity") === null, ".turn-activity is absent");
    assert.equal(
      stream.querySelector(".tool-result").textContent,
      "Unconfirmed",
    );
    assert.equal(
      page.calls.filter((call) => call.init.method === "POST").length,
      0,
    );
  } finally {
    page.close();
  }
  for (const [status, label] of [
    ["waiting", "Waiting for you"],
    ["offline", "Check status"],
  ]) {
    const statePage = await mount({
      status,
      extraTurns: [
        {
          ...turn,
          status: "inProgress",
          items: [
            {
              id: "cached-tool",
              type: "commandExecution",
              command: "sleep 30",
              status: "inProgress",
            },
          ],
        },
      ],
    });
    try {
      const stream = statePage.document.querySelector(
        '[data-turn-id="live-activity"] .agent-message',
      );
      assert.equal(
        stream.querySelector(".turn-activity strong").textContent,
        label,
      );
      assert.equal(stream.querySelector(".working-caption").textContent, label);
      assert.ok(stream.querySelector(".turn-activity .spin") === null, ".turn-activity .spin is absent");
      assert.match(
        stream.querySelector(".execution summary").textContent,
        /Tool activity/,
      );
      assert.ok(stream.querySelector(".execution .spin") === null, ".execution .spin is absent");
      if (status === "offline")
        assert.equal(
          stream.querySelector(".tool-result").textContent,
          "Unconfirmed",
        );
    } finally {
      statePage.close();
    }
  }
});

test("tool counts distinguish native kinds, named MCP tools and Claude tools", async () => {
  const turn = { id: "counts", status: "inProgress", items: [
    { id: "sh1", type: "commandExecution", command: "pwd", status: "inProgress" },
    { id: "sh2", type: "commandExecution", command: "ls", status: "completed" },
    { id: "edit", type: "fileChange", changes: [{ path: "a" }, { path: "b" }] },
    { id: "mcp1", type: "mcpToolCall", server: "docs", tool: "search" },
    { id: "mcp2", type: "mcpToolCall", server: "docs", tool: "search" },
    { id: "mcp3", type: "mcpToolCall", server: "docs", tool: "fetch" },
    { id: "mcp4", type: "mcpToolCall", server: "other", tool: "search" },
    { id: "bash", type: "claudeToolUse", name: "Bash" },
    { id: "read1", type: "claudeToolUse", name: "Read" },
    { id: "read2", type: "claudeToolUse", name: "Read" },
  ] };
  const page = await mount({ extraTurns: [turn] });
  try {
    const labels = () => [...page.document.querySelectorAll('[data-turn-id="counts"] .tool-count')].map(el => el.textContent);
    assert.deepEqual(labels(), ["Shell×2", "Edit×1", "docs/search×2", "docs/fetch×1", "other/search×1", "Bash×1", "Read×2"]);
    turn.items[0].status = "completed";
    turn.items[0].aggregatedOutput = "New output must not count as a new call";
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.equal(labels()[0], "Shell×2");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("Compacting follows live evidence and yields to waiting, disconnection and completion", async () => {
  const turn = { id: "compact-turn", status: "inProgress", items: [
    { id: "compact", type: "contextCompaction" },
  ] };
  const page = await mount({ status: "working", extraTurns: [turn] });
  const refresh = async () => {
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
  };
  const label = () => page.document.querySelector('[data-turn-id="compact-turn"] .turn-activity strong')?.textContent;
  try {
    assert.equal(label(), "Working", "A historical compaction item is not a live status");
    turn._yuzunoCompactionId = "compact";
    await refresh();
    assert.equal(label(), "Compacting");
    assert.equal(page.document.querySelector(".conversation-header .status-label").textContent.trim(), "Compacting");
    assert.ok(page.document.querySelector('[data-state="compacting"] .activity-yuzu img'));
    delete turn._yuzunoCompactionId;
    await refresh();
    assert.equal(label(), "Working");
    turn._yuzunoCompactionId = "compact";
    turn.status = "completed";
    await refresh();
    assert.equal(label(), undefined);
    assert.equal(page.calls.filter(call => call.init.method === "POST").length, 0);
  } finally { page.close(); }
  for (const [status, expected] of [["waiting", "Waiting for you"], ["offline", "Check status"], ["uncertain", "Check status"]]) {
    const page = await mount({ status, extraTurns: [{ ...turn, status: "inProgress" }] });
    try {
      assert.equal(page.document.querySelector('[data-turn-id="compact-turn"] .turn-activity strong').textContent, expected);
      assert.ok(page.document.querySelector('[data-state="compacting"]') === null, '[data-state="compacting"] is absent');
    } finally { page.close(); }
  }
});

test("native async questions add a referenced answer to the existing draft without sending or creating an RPC request", async () => {
  const title = "Which accent\r\ncolor should\rthe acceptance note use?";
  const page = await mount({
    questionItem: {
      id: "call_async_real_shape",
      delivery: "async",
      questions: [{ title, options: ["Yuzu", "Sage"] }],
    },
  });
  try {
    const composer = page.document.querySelector(
      '[data-composer-input][aria-label="Message Mori"]',
    );
    setValue(page.window, composer, "Keep this existing note.");
    await pause();
    await openQuestion(page);
    const card = page.document.querySelector(".async-question");
    assert.ok(card);
    assert.ok(page.document.querySelector(".pending-card") === null, ".pending-card is absent");
    assert.equal(button(page, "Add answer to draft").disabled, true);
    card.querySelectorAll('input[type="radio"]')[1].click();
    await pause();
    button(page, "Add answer to draft").click();
    await pause();
    assert.equal(
      composerText(composer),
      `Keep this existing note.\n\nRegarding your question “${title.replace(/\r\n|\r/g, "\n")}”:\nSage`,
    );
    assert.ok(page.document.activeElement === composer, "the composer has focus");
    assert.equal(
      page.calls.filter((call) => call.init.method === "POST").length,
      0,
    );
  } finally {
    page.close();
  }
});

test("Continue appends CRLF/CR result text at the actual normalized document end", async () => {
  const spec = structuredClone(comparisonExample);
  spec.elements.result.props.title = "Result\r\nwith\rnewlines";
  spec.elements.continue.props.instruction = "Continue\r\nfrom here\rplease";
  spec.elements.continue.props.requiresSelection = false;
  const page = await mount({ message: "```yuzuno-ui\n" + JSON.stringify(spec) + "\n```" });
  try {
    const field = page.document.querySelector("[data-composer-input]");
    setValue(page.window, field, "existing");
    for (let i = 0; i < 40 && !button(page, "Continue with selection"); i++) await pause();
    button(page, "Continue with selection").click();
    await pause();
    assert.equal(composerText(field), "existing\n\nRegarding your interactive result “Result\nwith\nnewlines”:\nContinue\nfrom here\nplease");
    assert.equal(composerSelection(field), composerText(field).length);
    assert.deepEqual(page.errors, []);
    assert.equal(page.calls.filter(c => c.init.method === "POST").length, 0);
  } finally { page.close(); }
});

test("broken drafts require explicit discard confirmation; cancel and storage failure preserve saved data", async () => {
  const key = "yuzuno.composer.v1:a", raw = JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "paste", id: "p", number: 1, bodyId: "missing" }] });
  const page = await mount({ stored: { [key]: raw, "yuzuno.composer.v1:b": JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "other" }] }) } });
  try {
    const field = page.document.querySelector("[data-composer-input]");
    assert.equal(field.getAttribute("contenteditable"), "false");
    button(page, "Reset saved draft").click(); await pause();
    button(page, "Cancel").click(); await pause();
    assert.equal(page.window.localStorage.getItem(key), raw);
    button(page, "Reset saved draft").click(); await pause();
    const proto = page.window.Storage.prototype, set = proto.setItem;
    proto.setItem = () => { throw new Error("denied"); };
    button(page, "Discard saved draft").click(); await pause();
    assert.equal(page.window.localStorage.getItem(key), raw);
    assert.equal(field.getAttribute("contenteditable"), "false");
    assert.match(page.document.querySelector('[role="dialog"] [role="alert"]').textContent, /has not been discarded/);
    proto.setItem = set;
    button(page, "Discard saved draft").click(); await pause();
    assert.equal(field.getAttribute("contenteditable"), "true");
    assert.equal(savedDraftText(page.window.localStorage, "a"), "");
    assert.equal(savedDraftText(page.window.localStorage, "b"), "other");
    setValue(page.window, field, "new draft"); await pause();
    assert.equal(savedDraftText(page.window.localStorage, "a"), "new draft");
    assert.equal(page.calls.filter(c => c.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("working messages carry the active turn and retries retain the same identity and draft", async () => {
  const page = await mount({
    status: "working",
    failMessageResponseOnce: true,
  });
  try {
    const composer = page.document.querySelector(
      '[data-composer-input][aria-label="Message Mori"]',
    );
    setValue(page.window, composer, "补充消息 Keep this detail.");
    const send = await waitForPreviewState(() => {
      const button = page.document.querySelector('[aria-label="Send while working"]');
      return button && !button.disabled && button;
    }, "the send button to accept the draft");
    send.click();
    await waitForPreviewState(
      () => /Delivery unconfirmed · draft kept/.test(page.document.querySelector(".outgoing-message")?.textContent || ""),
      "the lost response to be shown",
    );
    assert.equal(composerText(composer), "补充消息 Keep this detail.");
    assert.match(page.document.body.textContent, /Response lost/);
    send.click();
    const messages = () => page.calls.filter((r) => r.url.endsWith("/messages"));
    await waitForPreviewState(
      () => messages().length === 2 && composerText(composer) === ""
        && /Received by Codex · syncing conversation/.test(page.document.querySelector(".outgoing-message")?.textContent || ""),
      "the retry to be accepted",
    );
    const requests = messages();
    assert.equal(requests.length, 2);
    const [first, retry] = requests.map((r) => JSON.parse(r.init.body));
    assert.deepEqual(first, retry);
    assert.equal(first.expectedTurnId, "t1");
    assert.ok(first.clientMessageId);
    assert.equal(composerText(composer), "");
    assert.equal(page.document.querySelectorAll(".outgoing-message").length, 1);
    // Sending never interrupts, marks the conversation read or starts a Turn:
    // none of those endpoints was called, by any method. (The status bar's
    // own GET /api/reviews, read 400 ms after it mounts, is a list of PR
    // reviews, not this Agent's mark-read; an unanchored /review/ took it
    // for one once a slow run outlasted that delay.)
    assert.deepEqual(
      page.calls
        .map((r) => r.url.split("?")[0])
        .filter((url) => /^\/api\/agents\/a\/(interrupt|review)$|responses|\/turns$/.test(url)),
      [],
    );
    // The only writes were the send and its retry.
    assert.deepEqual(
      page.calls.filter((r) => (r.init?.method || "GET") !== "GET").map((r) => r.url),
      ["/api/agents/a/messages", "/api/agents/a/messages"],
    );
  } finally {
    page.close();
  }
});

// A phone's request can hang after sleep or a network change (T-170). Such
// a request is given up after DELIVERY_WAIT_MS (shortened here) and treated
// as unconfirmed, like a lost reply: nothing is sent again by itself.
const DELIVERY_WAIT_MS = 60_000;
function noReplyTo(path, hung) {
  return (window) => {
    const setTimeout = window.setTimeout;
    // Only this wait is shortened: no other app timer is a 60 s setTimeout
    // while a conversation is shown.
    window.setTimeout = function (handler, delay, ...args) {
      return setTimeout.call(window, handler, delay === DELIVERY_WAIT_MS ? 40 : delay, ...args);
    };
    const fetch = window.fetch;
    window.fetch = (url, init = {}) => {
      if (!url.includes(path)) return fetch(url, init);
      hung.push({ url, init });
      return new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new window.DOMException("The operation was aborted.", "AbortError"))));
    };
  };
}

test("a message with no reply in time is unconfirmed: the draft stays, nothing is sent again, Send works (T-170)", async () => {
  const hung = [];
  const page = await mount({ beforeLoad: noReplyTo("/messages", hung) });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Sent from a phone.");
    const send = await waitForPreviewState(() => {
      const button = page.document.querySelector('[aria-label="Send message"]');
      return button && !button.disabled && button;
    }, "the send button to accept the draft");
    send.click();
    await waitForPreviewState(
      () => /Delivery unconfirmed · draft kept/.test(page.document.querySelector(".outgoing-message")?.textContent || ""),
      "the unconfirmed delivery to be shown",
    );
    assert.match(page.document.body.textContent, /No reply from Core within 60 seconds\. It may have arrived; nothing is sent again by itself\./);
    assert.equal(composerText(composer), "Sent from a phone.");
    await pause();
    await pause();
    assert.equal(hung.length, 1, "sent once, not again");
    assert.equal(page.document.querySelector('[aria-label="Send message"]').disabled, false, "Send is usable again");
  } finally {
    page.close();
  }
});

test("an answer with no reply in time stays unconfirmed: Core's record is read, and answering again is a choice (T-170)", async () => {
  const question = {
    id: "ask",
    agentId: "a",
    method: "item/tool/requestUserInput",
    createdAt: "",
    params: {
      questions: [{ id: "pick", question: "Which one?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
    },
  };
  // Core's record after the lost reply: still unanswered, or recorded as sent
  // (the answer arrived; only its reply was lost).
  for (const recorded of [false, true]) {
    const hung = [];
    const page = await mount({
      status: "waiting",
      pending: [question],
      beforeLoad(window) {
        noReplyTo("/respond", hung)(window);
        const fetch = window.fetch;
        window.fetch = async (url, init) => {
          const response = await fetch(url, init);
          if (!recorded || !hung.length || !/\/api\/agents\/a$/.test(url)) return response;
          const body = await response.json();
          body.pending = body.pending.map((p) => ({ ...p, params: { ...p.params, _responseSent: true } }));
          return { ...response, json: async () => body, text: async () => JSON.stringify(body) };
        };
      },
    });
    try {
      const card = page.document.querySelector(".pending-card");
      card.querySelector("label.answer-option input").click();
      await pause();
      const reads = page.calls.filter((c) => /\/api\/agents\/a$/.test(c.url)).length;
      button(page, "Send answer").click();
      await waitForPreviewState(
        () => page.calls.filter((c) => /\/api\/agents\/a$/.test(c.url)).length > reads,
        "Core's record to be read again after no reply",
      );
      assert.equal(hung.length, 1);
      if (!recorded) {
        await waitForPreviewState(() => button(page, "Answer again"), "the choice to answer again");
        assert.match(card.textContent, /No reply from Core within 60 seconds, so whether your answer arrived is not known\. Core keeps only the first answer it records for this request/);
        assert.equal(button(page, "Send answer").disabled, true, "the card stays closed until the person chooses");
        button(page, "Answer again").click();
        await pause();
        assert.equal(button(page, "Send answer").disabled, false);
        assert.equal(button(page, "Answer again"), undefined);
        assert.doesNotMatch(card.textContent, /No reply from Core/);
      } else {
        await waitForPreviewState(() => /Response sent\. Waiting for the harness to confirm\./.test(card.textContent), "the record to lock the card as sent");
        assert.equal(button(page, "Answer again"), undefined, "nothing to answer again");
        assert.doesNotMatch(card.textContent, /No reply from Core/);
        assert.equal(button(page, "Send answer").disabled, true);
      }
      assert.equal(hung.length, 1, "nothing was sent again by itself");
    } finally {
      page.close();
    }
  }
});

// Unsent answers to native questions (T-170) are kept in this browser, per
// Workspace and native request, so a reload or a reopened page keeps them.
const DRAFTS = 'yuzuno.request-drafts.v1:["ws-1"]';
const nativeQuestion = (id, params = {}) => ({
  id,
  agentId: "a",
  method: "item/tool/requestUserInput",
  createdAt: "",
  params: {
    threadId: "thread-1",
    turnId: "t1",
    itemId: "ask-1",
    questions: [
      { id: "why", question: "Why this one?" },
      { id: "token", question: "Paste the token", isSecret: true },
    ],
    ...params,
  },
});
const answerField = (page, question) =>
  page.document.querySelector(`.pending-card input[aria-label="Your answer: ${question}"]`);
function typeAnswer(page, input, text) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}
/** What the page left in localStorage, for the next page to start with. */
const storageOf = (page) =>
  Object.fromEntries(
    Array.from({ length: page.window.localStorage.length }, (_, i) => page.window.localStorage.key(i))
      .map((key) => [key, page.window.localStorage.getItem(key)]),
  );
const respondCalls = (page) => page.calls.filter((c) => c.url.includes("/respond")).length;

test("an unsent answer to a native question survives a reload, into the same request only, and never a secret (T-170)", async () => {
  const first = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [nativeQuestion("r1")] });
  let stored;
  try {
    typeAnswer(first, answerField(first, "Why this one?"), "Because it is smaller.");
    typeAnswer(first, answerField(first, "Paste the token"), "s3cret-value");
    setValue(first.window, first.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "A message draft.");
    await pause();
    stored = storageOf(first);
    assert.match(stored[DRAFTS], /Because it is smaller\./);
    assert.doesNotMatch(JSON.stringify(stored), /s3cret-value/, "a secret answer is not kept");
    assert.equal(savedDraftText(first.window.localStorage, "a"), "A message draft.");
    assert.equal(respondCalls(first), 0);
  } finally {
    first.close();
  }
  // A reload after a reconnect: Core lists the same native request under a
  // new id. The answer is filled in, the secret is not, and nothing is sent.
  const reloaded = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [nativeQuestion("r2")], stored });
  try {
    assert.equal(answerField(reloaded, "Why this one?").value, "Because it is smaller.");
    assert.equal(answerField(reloaded, "Paste the token").value, "");
    assert.equal(button(reloaded, "Send answer").disabled, true, "the secret is still to be typed");
    assert.equal(savedDraftText(reloaded.window.localStorage, "a"), "A message draft.", "the message draft is its own");
    // Another Agent and back: the card is mounted again from the saved draft.
    [...reloaded.document.querySelectorAll(".agent-row")].find((el) => el.textContent.includes("Hana")).querySelector(".agent-select").click();
    await pause();
    await pause();
    assert.equal(answerField(reloaded, "Why this one?"), null);
    [...reloaded.document.querySelectorAll(".agent-row")].find((el) => el.textContent.includes("Mori")).querySelector(".agent-select").click();
    await waitForPreviewState(() => answerField(reloaded, "Why this one?"), "Mori's question again");
    assert.equal(answerField(reloaded, "Why this one?").value, "Because it is smaller.");
    assert.equal(respondCalls(reloaded), 0, "restoring sends nothing");
  } finally {
    reloaded.close();
  }
  // Another question of the same Turn, another session and another Workspace start empty.
  for (const [request, workspaceIdentity] of [
    [nativeQuestion("r3", { itemId: "ask-2" }), "ws-1"],
    [nativeQuestion("r4", { threadId: "thread-2" }), "ws-1"],
    [nativeQuestion("r5"), "ws-2"],
  ]) {
    const other = await mount({ workspaceIdentity, status: "waiting", pending: [request], stored });
    try {
      assert.equal(answerField(other, "Why this one?").value, "", JSON.stringify(request.params));
    } finally {
      other.close();
    }
  }
});

test("a draft is not restored once Core's record shows the request answered or gone (T-170)", async () => {
  const entry = (attempted) => JSON.stringify({ version: 1, entries: {
    [JSON.stringify(["a", "codex", "thread-1", "t1", "ask-1"])]: { answers: { why: "An old answer." }, ...(attempted ? { attempted: true } : {}), at: 1 },
  } });
  for (const attempted of [false, true]) {
    // Answered, from this browser or anywhere else: the card says only that it was sent.
    const answered = await mount({ workspaceIdentity: "ws-1", status: "waiting",
      pending: [nativeQuestion("r1", { _responseSent: true })], stored: { [DRAFTS]: entry(attempted) } });
    try {
      const card = answered.document.querySelector(".pending-card");
      assert.match(card.textContent, /Response sent\. Waiting for the harness to confirm\./);
      assert.doesNotMatch(card.textContent, /another device|No reply from Core/);
      assert.equal(answerField(answered, "Why this one?").value, "");
      assert.equal(button(answered, "Answer again"), undefined);
      await pause();
      assert.equal(answered.window.localStorage.getItem(DRAFTS), null, "the old input is dropped");
    } finally {
      answered.close();
    }
    // No longer pending (answered, cancelled or expired): dropped as well.
    const gone = await mount({ workspaceIdentity: "ws-1", status: "idle", pending: [], stored: { [DRAFTS]: entry(attempted) } });
    try {
      await waitForPreviewState(() => gone.window.localStorage.getItem(DRAFTS) === null, "the draft of a request no longer pending to be dropped");
    } finally {
      gone.close();
    }
  }
});

test("an answer with no reply is still unconfirmed after a reload, until Core's record shows it (T-170)", async () => {
  const question = nativeQuestion("r1", { questions: [{ id: "why", question: "Why this one?" }] });
  const hung = [];
  const first = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [question],
    beforeLoad: (window) => noReplyTo("/respond", hung)(window) });
  let stored;
  try {
    typeAnswer(first, answerField(first, "Why this one?"), "Because.");
    await pause();
    button(first, "Send answer").click();
    await waitForPreviewState(() => button(first, "Answer again"), "the answer to be unconfirmed");
    assert.equal(hung.length, 1);
    stored = storageOf(first);
    assert.match(stored[DRAFTS], /"attempted":true/);
  } finally {
    first.close();
  }
  // Reloaded while Core's record still shows it unanswered: as before the reload.
  const reloaded = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [nativeQuestion("r2", question.params)], stored });
  try {
    const card = reloaded.document.querySelector(".pending-card");
    assert.match(card.textContent, /No reply from Core within 60 seconds, so whether your answer arrived is not known\./);
    assert.equal(answerField(reloaded, "Why this one?").value, "Because.");
    assert.equal(button(reloaded, "Send answer").disabled, true, "closed until the person chooses");
    assert.equal(respondCalls(reloaded), 0, "nothing is sent again by itself");
    button(reloaded, "Answer again").click();
    await pause();
    assert.equal(button(reloaded, "Send answer").disabled, false);
    assert.equal(respondCalls(reloaded), 0);
  } finally {
    reloaded.close();
  }
  // The late record shows it arrived: sent, and the old input is not restored.
  const late = await mount({ workspaceIdentity: "ws-1", status: "waiting",
    pending: [nativeQuestion("r3", { ...question.params, _responseSent: true })], stored });
  try {
    const card = late.document.querySelector(".pending-card");
    assert.match(card.textContent, /Response sent\. Waiting for the harness to confirm\./);
    assert.equal(button(late, "Answer again"), undefined);
    assert.equal(answerField(late, "Why this one?").value, "");
    await pause();
    assert.equal(late.window.localStorage.getItem(DRAFTS), null);
  } finally {
    late.close();
  }
});

test("an answer Core recorded leaves no draft behind, and a refused one keeps it (T-170)", async () => {
  const question = nativeQuestion("r1", { questions: [{ id: "why", question: "Why this one?" }] });
  const page = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [question] });
  try {
    typeAnswer(page, answerField(page, "Why this one?"), "Because.");
    await pause();
    assert.match(page.window.localStorage.getItem(DRAFTS), /Because\./);
    button(page, "Send answer").click();
    await pause();
    await pause();
    assert.equal(respondCalls(page), 1);
    assert.equal(page.window.localStorage.getItem(DRAFTS), null);
  } finally {
    page.close();
  }
  const refused = await mount({ workspaceIdentity: "ws-1", status: "waiting", pending: [question],
    beforeLoad: (window) => {
      const fetch = window.fetch;
      window.fetch = async (url, init) =>
        url.includes("/respond")
          ? { ok: false, status: 409, text: async () => JSON.stringify({ error: "Session disconnected; the request was not sent" }) }
          : fetch(url, init);
    } });
  try {
    typeAnswer(refused, answerField(refused, "Why this one?"), "Because.");
    await pause();
    button(refused, "Send answer").click();
    await pause();
    await pause();
    const saved = refused.window.localStorage.getItem(DRAFTS);
    assert.match(saved, /Because\./);
    assert.doesNotMatch(saved, /attempted/, "a refused answer was not sent");
  } finally {
    refused.close();
  }
});

test("collaboration recovery holds composer and async answers, keeps drafts and native interrupt, and refreshes without a new record revision", async () => {
  const collaboration = { ready: false, error: "Workspace MCP check failed; reconnect to verify." };
  const backgroundShells = { state: "known", count: 1, checkedAt: Date.now() };
  const page = await mount({ status: "working", collaboration,
    backgroundShells, extraTurns: [{ id: "finished", status: "completed", items: [
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Finished response." },
    ] }],
    agentFields: { connectionState: "connected", threadId: "thread", rev: 12 },
    questionItem: { id: "q1", delivery: "async", questions: [{ title: "Which color?", options: ["Yuzu", "Sage"] }] },
  });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Keep this recovery draft.");
    await pause();
    assert.ok(page.document.querySelector(".recovery-notice"));
    assert.match(page.document.body.textContent, /1 shell/);
    assert.equal(page.document.querySelector('[aria-label="Send while working"]').disabled, true);
    assert.equal(button(page, "Interrupt").disabled, false);
    await openQuestion(page);
    page.document.querySelector('.async-question input[type="radio"]').click();
    await pause();
    button(page, "Send answer").click();
    await pause();
    assert.match(page.document.querySelector(".async-question").textContent, /Workspace MCP check failed/);
    assert.equal(page.calls.some(c => /\/(turns|messages)$/.test(c.url) && c.init.method === "POST"), false);
    assert.equal(composerText(composer), "Keep this recovery draft.");
    page.document.querySelector('[aria-label="Close dialog"]')?.click();
    await pause();
    button(page, "Reconnect and check").click();
    await pause();
    assert.equal(page.calls.filter(c => c.url.endsWith("/reconnect?view=summary")).length, 1);
    assert.ok(page.document.querySelector(".recovery-notice"), "A reconnect ACK alone cannot unlock input");
    collaboration.ready = true;
    backgroundShells.count = 2;
    page.eventSources.at(-1).onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: "a", rev: 12 }) });
    for (let i = 0; i < 40 && page.document.querySelector(".recovery-notice"); i++) await pause();
    assert.ok(page.document.querySelector(".recovery-notice") === null, ".recovery-notice is absent");
    assert.equal(page.document.querySelector('[aria-label="Send while working"]').disabled, false);
    assert.equal(composerText(composer), "Keep this recovery draft.");
    assert.match(page.document.body.textContent, /2 shells/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("stale readiness rejected before admission keeps draft without an uncertain delivery preview", async () => {
  const page = await mount({ messageResponse: async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ code: "message_not_submitted", error: "Workspace collaboration needs reconnect; input was not submitted." }),
  }) });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Keep this unsent draft.");
    await pause();
    page.document.querySelector('[aria-label="Send message"]').click();
    for (let i = 0; i < 20 && !page.calls.some(c => c.url.endsWith("/messages")); i++) await pause();
    await pause();
    assert.equal(composerText(composer), "Keep this unsent draft.");
    assert.equal(page.document.querySelectorAll(".outgoing-message").length, 0);
    assert.match(page.document.body.textContent, /input was not submitted/);
    assert.equal(page.window.localStorage.getItem("yuzuno.outbox"), "{}");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("direct async answers submit once during work and preserve the composer draft", async () => {
  const page = await mount({
    status: "working",
    questionItem: {
      id: "q1",
      delivery: "async",
      questions: [{ title: "Which color?", options: ["Yuzu", "Sage"] }],
    },
  });
  try {
    const composer = page.document.querySelector(
      '[data-composer-input][aria-label="Message Mori"]',
    );
    setValue(page.window, composer, "My unfinished draft.");
    await openQuestion(page);
    page.document.querySelector('.async-question input[type="radio"]').click();
    await pause();
    const send = button(page, "Send answer");
    send.click();
    send.click();
    await pause();
    await pause();
    const requests = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(requests.length, 1);
    const input = JSON.parse(requests[0].init.body);
    assert.equal(input.expectedTurnId, "t1");
    assert.deepEqual(input.question, { turnId: "t1", itemId: "q1" });
    assert.match(input.text, /Which color.*\nYuzu/);
    assert.equal(composerText(composer), "My unfinished draft.");
    assert.equal(button(page, "Answer sent").disabled, true);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("live context uses this agent's data and clears when changing agents", async () => {
  const page = await mount({
    status: "working",
    contextUsage: {
      usedPercent: 76.5,
      usedTokens: 76500,
      windowTokens: 100000,
      stale: false,
      turnId: "t1",
      updatedAt: "now",
    },
  });
  try {
    const trigger = page.document.querySelector(".context-usage-button");
    assert.match(trigger.getAttribute("aria-label"), /77% used/);
    assert.equal(
      page.document.querySelector(".context-usage").dataset.level,
      "medium",
    );
    trigger.click();
    await pause();
    assert.match(
      page.document.querySelector('[role="tooltip"]').textContent,
      /76,500 \/ 100,000 tokens/,
    );
    button(page, "Hana").click();
    await pause();
    await pause();
    assert.match(
      page.document
        .querySelector(".context-usage-button")
        .getAttribute("aria-label"),
      /Usage unavailable/,
    );
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
  } finally {
    page.close();
  }
});

test("agent settings use the runtime catalog, save explicit choices and consume Escape", async () => {
  const page = await mount({ status: "working" });
  try {
    const trigger = page.document.querySelector(
      '[aria-label="Agent settings"]',
    );
    trigger.click();
    await pause();
    await pause();
    const modal = page.document.querySelector('[role="dialog"]');
    assert.ok(modal);
    modal.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    trigger.click();
    await pause();
    await pause();
    await choose(page, "Reasoning effort", "high");
    await choose(page, "Permissions", "auto");
    button(page, "Save").click();
    await pause();
    await pause();
    const requests = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/agents/a/settings");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      model: "test-model",
      settings: {
        reasoningEffort: "high",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        permissionPreset: "auto",
        contextWindow: null,
        autoCompactTokenLimit: null,
      },
    });
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("context changes save without applying and stay open for explicit same-agent reload", async () => {
  const settings = { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" };
  const page = await mount({ settings, contextSettings: {
    supported: true, settingsSubmitted: false, canApply: true,
    observedWindowTokens: 258400, observedStale: true,
  }, settingsResponse: async (_url, init) => {
    Object.assign(settings, JSON.parse(init.body).settings);
    return { ok: true, status: 200, json: async () => ({}) };
  } });
  try {
    page.document.querySelector('[aria-label="Agent settings"]').click();
    await until(() => page.document.querySelector('[aria-label="Context window tokens"]')?.disabled === false,
      "runtime context capability should enable the editor");
    const windowInput = page.document.querySelector('[aria-label="Context window tokens"]');
    Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(windowInput, "872000");
    windowInput.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await pause();
    button(page, "Save").click();
    await until(() => page.document.querySelector('[role="dialog"]')?.textContent.includes("Saved. Apply"),
      "saving context should keep its Apply action visible");
    const posts = () => page.calls.filter((r) => r.init.method === "POST");
    assert.deepEqual(posts().map((r) => r.url), ["/api/agents/a/settings"]);
    const saved = JSON.parse(posts()[0].init.body).settings;
    assert.equal(saved.contextWindow, 872000);
    assert.equal(saved.autoCompactTokenLimit, null);
    assert.equal(saved.reasoningEffort, "low");
    assert.equal(page.document.querySelector('[role="dialog"] .codex-context-figure').textContent, "258,400 tokenslast known");
    button(page, "Apply now").click();
    await until(() => page.document.querySelector('[role="dialog"]')?.textContent.includes("Reload requested"),
      "explicit Apply should finish without closing the settings");
    assert.deepEqual(posts().map((r) => r.url), ["/api/agents/a/settings", "/api/agents/a/context/apply"]);
    assert.equal(page.document.querySelector('[role="dialog"] .codex-context-figure').textContent, "Unknown");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("saved context can reset with unsupported or unavailable runtime catalogs without applying", async () => {
  for (const unavailable of [false, true]) {
    const settings = { reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write",
      permissionPreset: "ask", contextWindow: 872000, autoCompactTokenLimit: 600000 };
    const page = await mount({ settings, contextSettings: { supported: false, canApply: false },
      modelsResponse: unavailable ? async () => ({ ok: false, status: 503,
        text: async () => "Runtime catalog unavailable" }) : undefined,
      settingsResponse: async (_url, init) => {
        Object.assign(settings, JSON.parse(init.body).settings);
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    try {
      page.document.querySelector('[aria-label="Agent settings"]').click();
      await until(() => page.document.querySelector('[role="dialog"]')?.textContent.includes(
        unavailable ? "Runtime catalog unavailable" : "execution machine has not reported support"),
        `context recovery should remain visible when catalog unavailable=${unavailable}`);
      assert.equal(page.document.querySelector('[aria-label="Context window tokens"]').disabled, true);
      const reset = button(page, "Reset to automatic");
      assert.equal(reset.disabled, false);
      reset.click();
      await until(() => page.document.querySelector('[role="dialog"]')?.textContent.includes("Saved context overrides cleared"));
      const posts = page.calls.filter((call) => call.init.method === "POST");
      assert.deepEqual(posts.map((call) => call.url), ["/api/agents/a/settings"]);
      assert.deepEqual(JSON.parse(posts[0].init.body), { model: "test-model", settings: {
        reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write", permissionPreset: "ask",
        contextWindow: null, autoCompactTokenLimit: null,
      } });
      assert.equal(page.document.querySelector('[aria-label="Context window tokens"]').value, "");
      assert.equal(page.document.querySelector('[aria-label="Auto-compaction threshold"]').value, "");
    } finally { page.close(); }
  }
});

test("unified permissions show native review routing, follow config and preserve custom settings", async () => {
  const custom = { reasoningEffort: "low", approvalPolicy: "never", sandbox: "read-only" };
  const page = await mount({ settings: custom, permissions: { presets: permissionCatalog.presets.map((p) => p.id === "full" ? { id: "full", available: false, reason: "Managed policy disallows full access" } : p) } });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Keep my unfinished note.");
    await pause();
    const open = async () => {
      page.document.querySelector('[aria-label="Agent settings"]').click();
      await pause(); await pause();
    };
    await open();
    const permissions = chipGroup(page, "Permissions");
    assert.equal(chosen(page, "Permissions"), "legacy");
    assert.equal(permissions.querySelector('[value="full"]').disabled, true);
    assert.match(permissions.textContent, /Full access\s*unavailable/);
    button(page, "Save").click();
    await pause(); await pause();
    assert.deepEqual(JSON.parse(page.calls.filter((r) => r.init.method === "POST").at(-1).init.body).settings,
      { ...custom, contextWindow: null, autoCompactTokenLimit: null });
    await open();
    for (const [mode, preview] of [["ask", /You review requests · Workspace files/], ["auto", /Automatic review · Workspace files/], ["config", /Automatic review · Read only/]]) {
      await choose(page, "Permissions", mode);
      assert.match(page.document.querySelector(".permission-preview").textContent, preview);
    }
    assert.match(page.document.querySelector('[role="dialog"]').textContent, /does not edit your shared config file/);
    button(page, "Save").click();
    await pause(); await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(posts.length, 2);
    assert.ok(posts.every((r) => r.url === "/api/agents/a/settings"));
    assert.equal(JSON.parse(posts.at(-1).init.body).settings.permissionPreset, "config");
    assert.equal(composerText(composer), "Keep my unfinished note.");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("legacy appearance preferences keep their font size and palettes apply without interrupting", async () => {
  const page = await mount({ status: "working", appearance: { theme: "dark", fontSize: 20 } });
  try {
    const root = page.document.documentElement;
    assert.equal(root.dataset.palette, "garden");
    // Appearance is a category of Settings.
    page.document.querySelector('[aria-label="Settings and updates"]').click();
    await pause();
    page.document.querySelector("#settings-tab-appearance").click();
    await pause();
    assert.match(page.document.querySelector(".settings-current").textContent, /Garden · Dark · 20 px/);
    for (const palette of ["yuzu", "graphite", "pine", "sunroom", "garden"]) {
      page.document.querySelector(`input[name="appearance-palette"][value="${palette}"]`).click();
      await pause();
      assert.equal(root.dataset.palette, palette);
      assert.equal(root.dataset.fontSize, "20");
      // Saved again with the choices it lacked at their defaults.
      assert.deepEqual(JSON.parse(page.window.localStorage.getItem("yuzuno.appearance")), { theme: "dark", fontSize: 20, palette, agentList: "detailed", projectGroups: "headers",
        dock: { jobs: 5, actions: 2, subAgents: 5 }, turnDock: { numbers: 5, bars: 5 } });
    }
    // Sliders: text size from 10 to 24 px, and how many of each kind the
    // conversation dock shows, where 0 is shown as Hidden.
    const slide = async (name, value) => {
      const input = page.document.querySelector(`input[type="range"][name="${name}"]`);
      Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, String(value));
      input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      await pause();
      return input;
    };
    const size = await slide("appearance-font-size", 12);
    assert.deepEqual([size.min, size.max], ["10", "24"]);
    assert.equal(root.dataset.fontSize, "12");
    assert.equal(root.style.getPropertyValue("--reading-size"), "12px");
    assert.equal(root.style.getPropertyValue("--font-adjust"), "1px", "controls keep their 14 px size");
    assert.match(page.document.querySelector(".settings-current").textContent, /12 px/);
    const jobs = await slide("appearance-dock-jobs", 0);
    assert.deepEqual([jobs.min, jobs.max], ["0", "10"]);
    assert.equal(jobs.getAttribute("aria-valuetext"), "Hidden");
    assert.equal(jobs.closest(".dock-limit").querySelector("output").textContent, "Hidden");
    await slide("appearance-dock-subAgents", 8);
    assert.deepEqual(JSON.parse(page.window.localStorage.getItem("yuzuno.appearance")).dock, { jobs: 0, actions: 2, subAgents: 8 });
    page.document.querySelector('[role="dialog"]').dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("continuous events render during the stream even when each snapshot takes longer than a refresh interval", async () => {
  const item = { id: "stream", type: "agentMessage", text: "Before streaming." };
  const page = await mount({ status: "working", detailDelay: 300, extraTurns: [{ id: "t2", status: "inProgress", items: [item] }] });
  let flood;
  try {
    item.text = "Updated while the stream is still running.";
    flood = setInterval(() => page.eventSources.at(-1).onmessage?.({ data: '{"agentId":"a"}' }), 25);
    const deadline = Date.now() + 1500;
    while (!page.document.querySelector('[data-item-id="stream"]').textContent.includes("Updated while") && Date.now() < deadline) await pause();
    assert.match(page.document.querySelector('[data-item-id="stream"]').textContent, /Updated while/);
    assert.equal(page.metrics.maxDetailInFlight, 1, "continuous events coalesce behind an existing fetch");
    button(page, "Hana").click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(page.document.querySelector('[data-composer-input][aria-label="Message Hana"]'));
    assert.deepEqual(page.errors, []);
  } finally { clearInterval(flood); page.close(); }
});

test("Codex sends echo immediately, keep drafts during submission and replace the preview by native client ID", async () => {
  let complete;
  const extraTurns = [{ id: "live", status: "inProgress", items: [] }];
  const page = await mount({ status: "working", extraTurns, messageResponse: () => new Promise((resolve) => { complete = resolve; }) });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Show my message immediately.");
    await pause();
    page.document.querySelector('[aria-label="Send while working"]').click();
    await pause();
    const echo = page.document.querySelector(".outgoing-message");
    assert.match(echo.textContent, /Show my message immediately/);
    assert.match(echo.textContent, /Sending/);
    assert.equal(composerText(composer), "Show my message immediately.");
    const input = JSON.parse(page.calls.find((r) => r.url.endsWith("/messages")).init.body);
    complete({ ok: true, status: 200, json: async () => ({ input, status: "accepted", turnId: "live", error: null }) });
    await pause(); await pause();
    assert.equal(composerText(composer), "");
    assert.match(page.document.querySelector(".outgoing-message").textContent, /Received by Codex · syncing conversation/);
    extraTurns[0].items.push({ id: "native-user", clientId: input.clientMessageId, type: "userMessage", content: [{ type: "text", text: input.text }] });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.ok(page.document.querySelector(".outgoing-message") === null, ".outgoing-message is absent");
    assert.match(page.document.querySelector('[data-item-id="native-user"]').textContent, /Show my message immediately/);
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 1);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a delivery note names the Agent's own harness, and only its acceptance reads as received (T-120)", async () => {
  for (const [status, note] of [
    ["accepted", "Received by OpenCode · syncing conversation"],
    ["unknown", "Not confirmed by OpenCode · not sent again"],
  ]) {
    const reply = (url, init) => {
      const receipt = { input: JSON.parse(init.body), status, turnId: null, error: status === "unknown" ? "Not confirmed; not sent again" : null };
      return { ok: true, status: 200, json: async () => receipt, text: async () => JSON.stringify(receipt) };
    };
    const page = await mount({ harness: "opencode", agentFields: { opencodeSessionId: "ses_0123456789" }, messageResponse: reply });
    try {
      setValue(page.window, page.document.querySelector("[data-composer-input]"), "One more thing");
      await pause();
      page.document.querySelector('[aria-label="Send message"]').click();
      const shown = await until(() => {
        const text = page.document.querySelector(".outgoing-message [role=status]")?.textContent;
        return text && text !== "Sending…" && text;
      }, `the ${status} note`);
      assert.equal(shown, note);
      assert.doesNotMatch(page.document.querySelector(".outgoing-message").textContent, /Claude/);
    } finally { page.close(); }
  }
});

test("the current request stays outside the scrolling log, includes human follow-ups and resets on turn or Agent changes", async () => {
  const input = (id, text, extra = {}) => ({ id, type: "userMessage", content: [{ type: "text", text }], ...extra });
  const turn = { id: "active", status: "inProgress", items: [input("request", "保留本轮最初的请求"), input("peer", "Private mailbox content", { _yuzunoSource: "peer" })] };
  const extraTurns = [turn];
  const page = await mount({ status: "working", turnStatus: "completed", extraTurns });
  const refresh = async () => { page.window.dispatchEvent(new page.window.Event("focus")); await pause(); await pause(); };
  try {
    const prompt = page.document.querySelector(".current-turn-prompt");
    assert.ok(prompt);
    assert.ok(prompt.closest(".conversation-scroll") === null, "not inside .conversation-scroll");
    assert.match(prompt.textContent, /保留本轮最初的请求/);
    assert.doesNotMatch(prompt.textContent, /Private mailbox/);
    prompt.open = true;
    turn.items.push(input("followup", "并且保留这条运行中的补充"));
    turn._yuzunoCompactionId = "compaction";
    await refresh();
    assert.ok(page.document.querySelector(".current-turn-prompt") === prompt, "the current turn prompt is the same element");
    assert.equal(prompt.open, true);
    assert.match(prompt.textContent, /Follow-up 1/);
    assert.match(prompt.textContent, /并且保留这条运行中的补充/);
    prompt.querySelector("summary").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await pause();
    assert.equal(prompt.open, false);
    turn.status = "completed";
    await refresh();
    assert.ok(page.document.querySelector(".current-turn-prompt") === null, ".current-turn-prompt is absent");
    extraTurns.push({ id: "next", status: "inProgress", items: [input("next-request", "新的任务")] });
    await refresh();
    assert.equal(page.document.querySelector(".current-turn-prompt").open, false);
    assert.doesNotMatch(page.document.querySelector(".current-turn-prompt").textContent, /最初的请求/);
    button(page, "Hana").click();
    await pause(); await pause();
    assert.ok(page.document.querySelector(".current-turn-prompt") === null, ".current-turn-prompt is absent");
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("mailbox-origin turns never pin a peer reminder as the user's request", async () => {
  const turn = { id: "peer-turn", status: "inProgress", _yuzunoSource: "peer", items: [{ id: "mail", type: "userMessage", content: [{ type: "text", text: "Peer delivery" }] }] };
  const page = await mount({ status: "working", turnStatus: "completed", extraTurns: [turn] });
  try {
    assert.ok(page.document.querySelector(".current-turn-prompt") === null, ".current-turn-prompt is absent");
    turn.items.push({ id: "human", type: "userMessage", content: [{ type: "text", text: "This is my own input" }] });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    const prompt = page.document.querySelector(".current-turn-prompt");
    assert.match(prompt.textContent, /This is my own input/);
    assert.doesNotMatch(prompt.textContent, /Peer delivery/);
  } finally { page.close(); }
});

test("a turn Claude started on its own says so instead of looking like an answer to you", async () => {
  const unmatched = { id: "native-0", status: "completed", _yuzunoSource: "native", _yuzunoUnmatched: true,
    items: [{ id: "other", type: "agentMessage", text: "Output nothing matched." }] };
  const turn = { id: "native-1", status: "inProgress", _yuzunoSource: "native",
    items: [{ id: "reply", type: "agentMessage", text: "Checking the finished background test." }] };
  const page = await mount({ status: "working", turnStatus: "completed", extraTurns: [unmatched, turn] });
  try {
    const shown = () => page.document.querySelector('[data-turn-id="native-1"]');
    assert.match(shown().querySelector(".native-turn-notice").textContent, /^Claude continued on its own$/);
    assert.ok(shown().querySelector(".user-text") === null, ".user-text is absent");
    assert.match(shown().textContent, /Checking the finished background test/);
    assert.equal(page.document.querySelector('[data-turn-id="native-0"] .native-turn-notice').textContent,
      "Claude output not matched to a message");
    assert.equal(page.document.querySelectorAll(".native-turn-notice").length, 2);
    Object.assign(turn, { status: "completed", _yuzunoOrigin: "task-notification" });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.match(shown().querySelector(".native-turn-notice").textContent, /after a background task finished/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("turn dock offers keyboard navigation and exact jumps without interrupting or losing the draft", async () => {
  const turns = Array.from({ length: 21 }, (_, index) => ({ id: `history-${index}`, status: index === 20 ? "inProgress" : "completed", items: [{ id: `request-${index}`, type: "userMessage", content: [{ type: "text", text: `Request ${index + 2}` }] }] }));
  const page = await mount({ status: "working", turnStatus: "completed", extraTurns: turns });
  try {
    const dock = page.document.querySelector('.turn-dock');
    const choice = (id) => dock.querySelector(`[data-turn-choice="${id}"]`);
    const kinds = () => [...dock.querySelectorAll(".turn-dock-list li")].map((li) => li.dataset.kind);
    // Reading the last Turn: its five numbers, and five bars above them.
    assert.deepEqual(kinds(), [...Array(5).fill("bar"), ...Array(5).fill("number")]);
    assert.match(choice("history-20").getAttribute("aria-label"), /Turn 22.*Working/);
    assert.equal(choice("history-20").getAttribute("aria-current"), "location");
    assert.ok(page.document.querySelector('.conversation-meta') === null, ".conversation-meta is absent");
    // Under the box: where and with what the Agent works, and the context
    // meter. The machine is on the rail card; the keys are in the box.
    const footer = page.document.querySelector('.composer-footnote');
    assert.match(footer.textContent, /workspace.*test-model/);
    assert.doesNotMatch(footer.textContent, /Core host|Send|New line/);
    assert.ok(footer.querySelector('.context-usage'));
    // In the box: the tools as icons, then the keys (shown while typing).
    const row = page.document.querySelector('.composer-bottom');
    assert.deepEqual(
      [...row.querySelectorAll(".composer-tools > button")].map((b) => b.getAttribute("aria-label")),
      ["Add images", "Mark up an image", "Ask for an interactive result"],
    );
    assert.equal(row.querySelector(".composer-keys")?.textContent.replace(/\s+/g, " ").trim(), "↵ Send ⇧ ↵ New line");
    assert.doesNotMatch(page.document.querySelector('.composer-area').textContent, /Pastes of 12|Room for your next idea|work is underway|Interactive result/);
    assert.doesNotMatch(page.document.querySelector('.conversation-header').textContent, /Core host|test-model/);
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Keep my navigation draft");
    const key = (name) => page.document.activeElement.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    choice("history-20").focus(); await pause();
    // Home reaches Turn 1, which was not on show: the window moves to it.
    key("Home"); await pause();
    assert.equal(page.document.activeElement.dataset.turnChoice, "t1");
    assert.deepEqual(kinds(), [...Array(5).fill("number"), ...Array(5).fill("bar")]);
    key("End"); await pause();
    assert.equal(page.document.activeElement.dataset.turnChoice, "history-20");
    assert.match(dock.querySelector('[role="tooltip"]').textContent, /Turn 22.*Working.*Request 22/);
    key("ArrowUp"); await pause();
    assert.equal(page.document.activeElement.dataset.turnChoice, "history-19");
    key("Escape"); await pause();
    assert.ok(dock.querySelector('[role="tooltip"]') === null, '[role="tooltip"] is absent');
    key("Home"); await pause();
    // A bar is a Turn too: Turn 9 sits four bars below the numbers 1–5.
    assert.equal(choice("history-7").closest("li").dataset.kind, "bar");
    choice("history-7").click();
    await pause(); await pause();
    assert.equal(page.document.activeElement.id, "turn-history-7");
    assert.equal(page.scrollTargets.at(-1).id, "turn-history-7");
    assert.ok(button(page, "Back to latest"));
    const jumps = page.scrollTargets.length;
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.equal(page.scrollTargets.length, jumps);
    assert.equal(composerText(composer), "Keep my navigation draft");
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
    button(page, "Hana").click(); await pause(); await pause();
    assert.ok(page.document.querySelector('.turn-dock [role="tooltip"]') === null, '.turn-dock [role="tooltip"] is absent');
  } finally { page.close(); }
});

test("earlier saved messages load in front of what is being read, within three windows (T-161)", async () => {
  // Five Turns, three Items to a window as Core pages them (T-77): a window
  // before an Item ends at it, a pinned one starts at it.
  const turns = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, status: "completed", items: [
    { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
    { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: `Answer ${n}` },
  ] }));
  const all = turns.flatMap((turn) => turn.items.map((item) => JSON.stringify([turn.id, item.id])));
  const windowFrom = (from) => {
    const shown = all.slice(Math.max(0, from), Math.max(0, from) + 3);
    const start = all.indexOf(shown[0]), end = start + shown.length - 1;
    return {
      turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => shown.includes(JSON.stringify([turn.id, item.id]))) }))
        .filter((turn) => turn.items.length),
      conversation: { index: turns.map((turn, i) => ({ ...turn, number: i + 1, itemCount: 2 })), questions: [], nativeClientIds: [],
        start: shown[0], end: shown.at(-1), hasBefore: start > 0, hasAfter: end < all.length - 1, totalItems: all.length },
    };
  };
  const requests = [];
  let failEarlier = false;
  const page = await mount({ beforeLoad(window) {
    const fetch = window.fetch;
    window.fetch = async (url, init) => {
      const [path, search = ""] = url.split("?");
      if (!/\/api\/agents\/a$/.test(path)) return fetch(url, init);
      requests.push(url);
      const query = new URLSearchParams(search);
      if (failEarlier && query.has("before"))
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: "The saved window could not be read" }) };
      const response = await fetch(path, init);
      const from = query.has("before") ? all.indexOf(query.get("before")) - 2
        : query.has("after") ? all.indexOf(query.get("after"))
        : query.has("turnId") ? all.indexOf(JSON.stringify([query.get("turnId"), query.get("itemId")]))
        : all.length - 3;
      const body = { ...(await response.json()), ...windowFrom(from) };
      return { ...response, json: async () => body };
    };
  } });
  try {
    const text = () => page.document.querySelector(".conversation-scroll").textContent;
    const earlier = () => requests.filter((url) => url.includes("before=")).length;
    assert.match(text(), /Answer 4[\s\S]*Question 5[\s\S]*Answer 5/);
    button(page, "Load earlier messages").click();
    await until(() => /Question 4/.test(text()), "the earlier window is shown");
    // In front of what was being read, not instead of it.
    assert.match(text(), /Answer 3[\s\S]*Question 4[\s\S]*Answer 4[\s\S]*Question 5[\s\S]*Answer 5/);
    assert.equal(text().match(/Answer 4/g).length, 1, "the Item both windows hold is shown once");
    assert.equal(earlier(), 1);
    assert.equal(button(page, "Continue to newer messages"), undefined);
    button(page, "Load earlier messages").click();
    await until(() => /Question 3/.test(text()), "a second earlier window is shown");
    assert.match(text(), /Answer 2[\s\S]*Question 3[\s\S]*Answer 3[\s\S]*Answer 5/);
    assert.equal(earlier(), 2);
    // A third would pass the bound: the windows are replaced as before, and
    // the newer messages are one click away.
    button(page, "Load earlier messages").click();
    await until(() => /Question 2/.test(text()) && !/Answer 5/.test(text()), "the window before them replaces them");
    assert.match(text(), /Answer 1[\s\S]*Question 2[\s\S]*Answer 2/);
    assert.equal(earlier(), 3);
    assert.ok(button(page, "Continue to newer messages"));
    button(page, "Back to latest").click();
    await until(() => /Answer 5/.test(text()) && !/Question 2/.test(text()), "back at the latest window");
    // A failed read keeps what is shown and says why; it can be tried again.
    failEarlier = true;
    button(page, "Load earlier messages").click();
    const alert = await until(() => page.document.querySelector(".conversation-history-window [role=alert]"), "the failure is shown");
    assert.match(alert.textContent, /could not be read/);
    assert.match(text(), /Answer 4[\s\S]*Answer 5/);
    assert.equal(button(page, "Load earlier messages").disabled, false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

// Five Turns of a question and an answer for Mori, read in windows of three
// Items as Core pages them (T-77), with Core's 404 for a Turn or Item it does
// not have. Each window read is recorded.
function windowedMori(requests, { replyText = {} } = {}) {
  const turns = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, status: "completed", items: [
    { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
    { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: replyText[n] || `Answer ${n}` },
  ] }));
  const all = turns.flatMap((turn) => turn.items.map((item) => JSON.stringify([turn.id, item.id])));
  const windowFrom = (from) => {
    const shown = all.slice(Math.max(0, from), Math.max(0, from) + 3);
    const start = all.indexOf(shown[0]), end = start + shown.length - 1;
    return {
      turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => shown.includes(JSON.stringify([turn.id, item.id]))) }))
        .filter((turn) => turn.items.length),
      conversation: { index: turns.map((turn, i) => ({ ...turn, number: i + 1, itemCount: 2 })), questions: [], nativeClientIds: [],
        start: shown[0], end: shown.at(-1), hasBefore: start > 0, hasAfter: end < all.length - 1, totalItems: all.length },
    };
  };
  return (window) => {
    const fetch = window.fetch;
    window.fetch = async (url, init) => {
      const [path, search = ""] = url.split("?");
      if (!/\/api\/agents\/a$/.test(path)) return fetch(url, init);
      requests.push(search);
      const query = new URLSearchParams(search);
      const turn = query.has("turnId") && turns.find((t) => t.id === query.get("turnId"));
      if (query.has("turnId") && (!turn || (query.has("itemId") && !turn.items.some((i) => i.id === query.get("itemId")))))
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: "This Agent has no Turn with that ID", code: turn ? "item_not_found" : "turn_not_found" }) };
      const response = await fetch(path, init);
      const from = query.has("before") ? all.indexOf(query.get("before")) - 2
        : query.has("after") ? all.indexOf(query.get("after"))
        : turn ? all.indexOf(JSON.stringify([turn.id, query.get("itemId") || turn.items[0].id]))
        : all.length - 3;
      const body = { ...(await response.json()), ...windowFrom(from) };
      return { ...response, json: async () => body };
    };
  };
}
function typeInto(page, input, value) {
  Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

test("a message link opens its message, loading its window, and says plainly when it cannot (T-166)", async () => {
  const requests = [];
  const page = await mount({ workspaceIdentity: "ws-1", agentFields: { threadId: "thread-1" }, beforeLoad: windowedMori(requests) });
  try {
    const text = () => page.document.querySelector(".conversation-scroll").textContent;
    const bar = () => page.document.querySelector(".source-navigation")?.textContent || "";
    const toast = () => page.document.querySelector(".toast")?.textContent || "";
    const reply = page.document.querySelector('[data-item-id="t5-r"]');
    [...reply.querySelectorAll("button")].find((b) => b.textContent.includes("Copy link")).click();
    await until(() => page.copied.length, "the link is copied");
    assert.equal(page.copied[0], "http://127.0.0.1:4317/#/message?w=ws-1&a=a&t=t5&i=t5-r&s=thread-1");
    // An earlier message: its window is read and the message has the focus.
    page.window.location.hash = "#/message?w=ws-1&a=a&t=t2&i=t2-r&s=thread-1";
    await until(() => /Answer 2/.test(text()) && page.document.activeElement?.dataset.itemId === "t2-r", "the linked message is shown");
    assert.ok(requests.includes("turnId=t2&itemId=t2-r"), requests.join(" | "));
    assert.match(bar(), /Back to latest.*Linked message/);
    assert.ok(page.document.querySelector('[data-item-id="t2-r"]').classList.contains("source-highlight"));
    assert.equal(page.window.location.hash, "", "a reload does not open the link again");
    // A message Core no longer has is asked for once, then explained.
    page.window.location.hash = "#/message?w=ws-1&a=a&t=t9&i=t9-r&s=thread-1";
    await until(() => /no longer in Mori’s conversation, for example after Rewind/.test(bar()), "a message that is gone is explained");
    await pause(); await pause();
    assert.equal(requests.filter((r) => r.startsWith("turnId=t9")).length, 1, requests.join(" | "));
    assert.match(text(), /Answer 5/, "the latest messages are shown instead");
    page.window.location.hash = "#/message?w=ws-1&a=a&t=t8&s=thread-0";
    await until(() => /earlier native session of Mori/.test(bar()), "another native session is named");
    // Another Workspace, or an Agent no longer here: nothing is opened.
    const read = requests.length;
    page.window.location.hash = "#/message?w=ws-2&a=a&t=t1";
    await until(() => /another Workspace/.test(toast()), "another Workspace is refused");
    page.window.location.hash = "#/message?w=ws-1&a=gone&t=t1";
    await until(() => /no longer in this Workspace/.test(toast()), "a removed Agent is explained");
    assert.equal(requests.length, read);
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0, "opening a link changes nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a message link in a reply or pasted into agent search opens here, not as a web page (T-166)", async () => {
  const requests = [];
  const href = "http://127.0.0.1:4317/#/message?w=ws-1&a=a&t=t1&i=t1-r";
  const page = await mount({ workspaceIdentity: "ws-1", beforeLoad: windowedMori(requests, { replyText: { 5: `See [the first answer](${href}).` } }) });
  try {
    const text = () => page.document.querySelector(".conversation-scroll").textContent;
    const anchor = page.document.querySelector('[data-item-id="t5-r"] a');
    anchor.click();
    await until(() => /Answer 1/.test(text()), "the linked message opens in the conversation");
    assert.ok(requests.includes("turnId=t1&itemId=t1-r"), requests.join(" | "));
    assert.notEqual(anchor.target, "_blank");
    page.document.querySelector('button[aria-label="Search agents"]').click();
    await pause();
    typeInto(page, page.document.querySelector('input[aria-label="Search agents"]'), " http://localhost:9/#/message?w=ws-1&a=a&t=t3&i=t3-u ");
    await pause();
    assert.equal(page.document.querySelector(".rail-empty"), null, "a link is not an Agent search");
    button(page, "Open linked message").click();
    await until(() => /Question 3/.test(text()) && page.document.activeElement?.dataset.itemId === "t3-u", "the pasted link opens");
    assert.ok(requests.includes("turnId=t3&itemId=t3-u"), requests.join(" | "));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a conversation reopens where it was left, and one left at the latest stays there (T-166)", async () => {
  const requests = [];
  const saved = (position) => JSON.stringify({ a: { savedAt: 1, ...position } });
  const page = await mount({
    workspaceIdentity: "ws-1", agentFields: { threadId: "thread-1" }, beforeLoad: windowedMori(requests),
    stored: { "yuzuno.selected": JSON.stringify("a"), "yuzuno.reading.ws-1": saved({ mode: "anchor", turnId: "t2", itemId: "t2-u", offset: -10 }) },
  });
  try {
    const text = () => page.document.querySelector(".conversation-scroll").textContent;
    const pane = () => page.document.querySelector(".conversation-scroll");
    const stored = () => JSON.parse(page.window.localStorage.getItem("yuzuno.reading.ws-1")).a;
    await until(() => /Question 2/.test(text()), "the reload opens where Mori was left");
    assert.ok(requests.includes("turnId=t2&itemId=t2-u"), requests.join(" | "));
    assert.match(page.document.querySelector(".source-navigation").textContent, /Where you left off/);
    assert.equal(page.document.querySelector(".source-highlight"), null, "a reading position is not highlighted");
    // Back at the latest when leaving: reopening stays at the latest.
    button(page, "Back to latest").click();
    await until(() => /Answer 5/.test(text()) && !page.document.querySelector(".source-navigation"), "the latest messages");
    pane().dispatchEvent(new page.window.Event("scroll"));
    button(page, "Hana").click();
    await until(() => stored().mode === "latest", "leaving at the latest is kept");
    button(page, "Mori").click();
    await until(() => /Answer 5/.test(text()), "Mori opens at the latest");
    assert.equal(page.document.querySelector(".source-navigation"), null);
    // Reading higher up when leaving: that message and its offset are kept.
    Object.defineProperty(pane(), "scrollHeight", { configurable: true, value: 2000 });
    const rect = page.window.HTMLElement.prototype.getBoundingClientRect;
    page.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const top = this.dataset?.itemId === "t4-r" ? -15 : this.dataset?.itemId ? 100 : 0;
      return { top, bottom: top + 55, height: this.dataset?.itemId ? 55 : 0, left: 0, right: 0, width: 0, x: 0, y: top };
    };
    pane().dispatchEvent(new page.window.Event("scroll"));
    await pause();
    page.window.HTMLElement.prototype.getBoundingClientRect = rect;
    button(page, "Hana").click();
    await until(() => stored().mode === "anchor", "the reading position is kept");
    assert.deepEqual({ ...stored(), savedAt: 0 }, { mode: "anchor", turnId: "t4", itemId: "t4-r", offset: -15, threadId: "thread-1", savedAt: 0 });
    // A position whose message is gone opens the latest and says so.
    page.window.localStorage.setItem("yuzuno.reading.ws-1", saved({ mode: "anchor", turnId: "t9", itemId: "t9-u", offset: 0 }));
    button(page, "Mori").click();
    await until(() => /Where you left off is no longer in this conversation/.test(page.document.querySelector(".toast")?.textContent || ""), "a lost position is explained");
    await until(() => /Answer 5/.test(text()) && !page.document.querySelector(".source-navigation"), "the latest messages are shown");
    assert.equal(requests.filter((r) => r.startsWith("turnId=t9")).length, 1, requests.join(" | "));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

// What Point & Fix needs from a browser, which jsdom lacks: decoding an
// image (400×300 here), drawing it and object URLs. Uploads answer as Core's
// content-addressed images do: the same bytes, the same ID.
function pointFixBrowser(window, uploads, { failFirst = false, failAnnotatedOnce = false } = {}) {
  const drawn = [];
  window.createImageBitmap = async () => ({ ...(window.pointFixSize || { width: 400, height: 300 }), close() {} });
  window.URL.createObjectURL = () => "blob:point-fix";
  window.URL.revokeObjectURL = (url) => drawn.push(["revoked", url]);
  // Each canvas draws its own picture: the same areas, the same bytes.
  window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    canvas.areas = [];
    return { drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText: (text) => drawn.push(["number", text]),
      strokeRect: (...box) => { canvas.areas.push(box); drawn.push(["area", canvas.width, canvas.height, ...box]); } };
  };
  window.HTMLCanvasElement.prototype.toBlob = function (done, type) {
    done(new window.Blob([`annotated ${this.width}x${this.height} ${JSON.stringify(this.areas)}`], { type }));
  };
  const ids = new Map();
  const fetch = window.fetch;
  window.fetch = async (url, init = {}) => {
    if (url.includes("/api/artifact?"))
      return { ok: true, status: 200, blob: async () => new window.Blob(["png-bytes"], { type: "image/png" }) };
    // Hana is a Codex Agent, as her own detail says.
    if (url.endsWith("/api/workspace")) {
      const response = await fetch(url, init), body = await response.json();
      body.agents = body.agents.map((agent) => (agent.id === "b" ? { ...agent, harness: "codex" } : agent));
      return { ...response, json: async () => body };
    }
    // A saved image, read back by its ID.
    const saved = /\/api\/agents\/[ab]\/images\/([0-9a-f]{64}\.png)$/.exec(url);
    if (saved && !init.method) {
      const content = [...ids].find(([, id]) => id === saved[1])?.[0];
      return content === undefined ? { ok: false, status: 404, text: async () => "{}" }
        : { ok: true, status: 200, blob: async () => new window.Blob([content], { type: "image/png" }) };
    }
    const upload = /\/api\/agents\/([ab])\/images$/.exec(url);
    if (upload && init.method === "POST") {
      const content = await init.body.text();
      uploads.push({ agent: upload[1], type: init.body.type, content });
      if ((failFirst && uploads.length === 1) ||
          (failAnnotatedOnce && content.startsWith("annotated") && uploads.filter((u) => u.content.startsWith("annotated")).length === 1))
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: "Disk full" }) };
      if (!ids.has(content)) ids.set(content, `${String(ids.size + 1).repeat(64)}.png`);
      return { ok: true, status: 200, json: async () => ({ id: ids.get(content), width: 400, height: 300, bytes: content.length }) };
    }
    return fetch(url, init);
  };
  return drawn;
}
function pasteImage(page, content, name) {
  const field = page.document.querySelector("[data-composer-input]");
  field.focus();
  const file = new page.window.File([content], name, { type: "image/png" });
  const event = new page.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file], getData: () => "" },
  });
  field.dispatchEvent(event);
}
function typeText(page, field, value) {
  const prototype = field.tagName === "TEXTAREA" ? page.window.HTMLTextAreaElement.prototype : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
  field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

test("Point & Fix marks areas on an image and adds it, the original and the notes to the chosen Agent's draft, sending nothing (T-167)", async () => {
  const uploads = [];
  let drawn;
  const page = await mount({
    harness: "opencode",
    artifacts: [{ path: "/workspace/shot.png", name: "shot.png", kind: "image", sourceItemId: "r1" }],
    beforeLoad: (window) => { drawn = pointFixBrowser(window, uploads, { failFirst: true }); },
  });
  try {
    const dialog = () => page.document.querySelector(".point-fix-dialog");
    const field = (label) => dialog().querySelector(`[aria-label="${label}"]`);
    const hana = () => page.document.querySelector('[data-composer-input][aria-label="Message Hana"]');
    button(page, "Hana").click();
    await until(hana, "Hana opens");
    setValue(page.window, hana(), "Hana’s own draft");
    await pause();
    button(page, "Mori").click();
    await until(() => page.document.querySelector('[data-composer-input][aria-label="Message Mori"]') &&
      page.document.querySelector(".artifacts-panel .artifact-row"), "Mori's artifacts");
    page.document.querySelector(".artifacts-panel .artifact-row").click();
    await until(() => button(page, "Mark up"), "an image artifact can be marked up");
    button(page, "Mark up").click();
    await until(() => dialog()?.querySelector(".point-fix-image svg"), "the image opens for marking");
    // Mori owns the image but cannot take one: said, and nothing can be added.
    assert.match(dialog().textContent, /Mori cannot receive images; Codex and Claude Agents can/);
    assert.equal(button(page, "Add to Mori’s draft").disabled, true);
    // Two areas without a pointer: Add area, its fields and its note.
    button(page, "Add area").click();
    await pause();
    for (const [label, value] of [["left", "10"], ["top", "20"], ["width", "50"], ["height", "40"]])
      typeText(page, field(`Area 1 ${label} (px)`), value);
    typeText(page, field("Area 1 comment"), "Too tight");
    button(page, "Add area").click();
    await pause();
    typeText(page, field("Area 2 comment"), "Wrong colour");
    // One drawn at half size lands on the original's pixels, and zoom keeps it.
    const svg = dialog().querySelector(".point-fix-image svg");
    let box = { left: 0, top: 0, width: 200, height: 150 };
    svg.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top });
    const pointer = async (type, x, y) => {
      svg.dispatchEvent(new page.window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
      await pause();
    };
    await pointer("pointerdown", 20, 20); await pointer("pointermove", 60, 50); await pointer("pointerup", 60, 50);
    assert.deepEqual(["left", "top", "width", "height"].map((k) => field(`Area 3 ${k} (px)`).value), ["40", "40", "80", "60"]);
    box = { left: 0, top: 0, width: 800, height: 600 };
    const third = svg.querySelectorAll("rect[data-region]")[2];
    assert.deepEqual(["x", "y", "width", "height"].map((k) => third.getAttribute(k)), ["40", "40", "80", "60"]);
    assert.equal(dialog().querySelectorAll(".point-fix-badge")[2].style.left, "10%");
    // A note typed after the last area was drawn survives Undo.
    typeText(page, field("Area 1 comment"), "Too tight, by 4 px");
    button(page, "Undo").click();
    await pause();
    assert.equal(field("Area 3 comment"), null, "Undo takes the last area back");
    assert.equal(field("Area 1 comment").value, "Too tight, by 4 px");
    // Another Agent: checked again, and enabled.
    const select = dialog().querySelector(".point-fix-target select");
    select.value = "b";
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await pause();
    assert.doesNotMatch(dialog().textContent, /cannot receive images/);
    // A failed upload keeps everything; trying again adds it.
    button(page, "Add to Hana’s draft").click();
    await until(() => dialog()?.querySelector('[role="alert"]'), "the failure is shown");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /Disk full/);
    assert.equal(field("Area 2 comment").value, "Wrong colour");
    button(page, "Add to Hana’s draft").click();
    await until(() => !dialog() && hana(), "the draft opens");
    // The failed upload, then the same annotated image and the original.
    const marked = "annotated 400x300 [[10,20,50,40],[150,113,100,75]]";
    assert.deepEqual(uploads.map((u) => [u.agent, u.type, u.content]), [
      ["b", "image/png", marked], ["b", "image/png", marked], ["b", "image/png", "png-bytes"],
    ]);
    assert.deepEqual(drawn.filter((d) => d[0] === "area").slice(-2), [["area", 400, 300, 10, 20, 50, 40], ["area", 400, 300, 150, 113, 100, 75]]);
    assert.ok(drawn.some((d) => d[0] === "revoked" && d[1] === "blob:point-fix"), "what Point & Fix made is released");
    const text = composerText(hana());
    assert.ok(text.startsWith("Hana’s own draft"), text);
    assert.match(text, /Point & Fix feedback on “shot.png” \(400×300 px\): 2 marked areas in the attached annotated image, with the original image attached\./);
    assert.match(text, /Source: the file \/workspace\/shot.png in Mori’s conversation/);
    assert.match(text, /1\. Area at x 10, y 20, 50×40 px: Too tight, by 4 px\n2\. Area at x 150, y 113, 100×75 px: Wrong colour/);
    assert.equal(page.document.querySelector(".composer-area").querySelectorAll(".input-image").length, 2);
    assert.equal(page.calls.filter((c) => c.init.method === "POST" && /\/(messages|turns)$/.test(c.url)).length, 0, "nothing is sent");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a screenshot you choose is marked up with the keyboard alone, into this Agent's draft, without doubling images (T-167)", async () => {
  const uploads = [];
  const page = await mount({ beforeLoad: (window) => { pointFixBrowser(window, uploads); } });
  try {
    const dialog = () => page.document.querySelector(".point-fix-dialog");
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Before the feedback");
    await pause();
    const choose = async () => {
      const input = page.document.querySelector('input[aria-label="Choose an image to mark"]');
      Object.defineProperty(input, "files", { configurable: true, value: [new page.window.File(["png-bytes"], "screen.png", { type: "image/png" })] });
      input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      await until(() => dialog()?.querySelector(".point-fix-image svg"), "the chosen image opens");
      button(page, "Add area").click();
      await until(() => page.document.activeElement?.id?.startsWith("point-fix-note-"), "its note has the focus");
      typeText(page, page.document.activeElement, "Align the buttons");
      button(page, "Add to Mori’s draft").click();
      await until(() => !dialog(), "added");
    };
    await choose();
    const text = composerText(composer);
    assert.ok(text.startsWith("Before the feedback"), text);
    assert.match(text, /Source: an image you chose \(screen.png\)\n\n1\. Area at x 150, y 113, 100×75 px: Align the buttons/);
    const images = () => page.document.querySelector(".composer-area").querySelectorAll(".input-image").length;
    assert.equal(images(), 2);
    // The same again: the same images, not a second copy of each.
    await choose();
    assert.equal(images(), 2);
    // An image larger than Core takes: the annotated copy is reduced, the
    // text says so, and the original is not attached.
    page.window.pointFixSize = { width: 9000, height: 4000 };
    await choose();
    const big = composerText(composer).split("Point & Fix feedback").at(-1);
    assert.match(big, /^ on “screen.png” \(9000×4000 px\): 1 marked area in the attached annotated image\.\n/);
    assert.match(big, /The annotated image is reduced to 7348×3266 px; the areas below are in the original’s 9000×4000 pixels\./);
    assert.equal(images(), 3);
    assert.equal(page.calls.filter((c) => c.init.method === "POST" && /\/(messages|turns)$/.test(c.url)).length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an image pasted into the draft is marked up where it is: no file is chosen again, and its original is never added twice (T-167)", async () => {
  const uploads = [], pickers = [];
  const page = await mount({ beforeLoad: (window) => {
    pointFixBrowser(window, uploads, { failAnnotatedOnce: true });
    const click = window.HTMLInputElement.prototype.click;
    window.HTMLInputElement.prototype.click = function () {
      if (this.type === "file") pickers.push(this.getAttribute("aria-label"));
      return click.call(this);
    };
  } });
  try {
    const dialog = () => page.document.querySelector(".point-fix-dialog");
    const draftImages = () => [...page.document.querySelector(".composer-area").querySelectorAll(".input-image")];
    const mori = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    const sent = () => page.calls.filter((c) => c.init.method === "POST" && /\/(messages|turns)$/.test(c.url)).length;
    const markUp = async (index, name) => {
      page.document.querySelector(`.composer-area [aria-label="Mark up image ${index}"]`).click();
      await until(() => dialog()?.querySelector(".point-fix-image svg"), `${name} opens for marking`);
      assert.match(dialog().querySelector(".modal-heading").textContent, new RegExp(`Point & Fix · ${name.replace(".", "\\.")}`));
    };
    setValue(page.window, mori, "Look at these");
    await pause();
    pasteImage(page, "pasted-one", "one.png");
    await until(() => draftImages().length === 1, "the first pasted image is in the draft");
    pasteImage(page, "pasted-two", "two.png");
    await until(() => draftImages().length === 2, "the second pasted image is in the draft");
    const pasted = uploads.length;
    // Cancel changes nothing.
    await markUp(1, "one.png");
    button(page, "Add area").click();
    await pause();
    button(page, "Cancel").click();
    await until(() => !dialog(), "cancelled");
    assert.equal(composerText(mori), "Look at these");
    assert.equal(draftImages().length, 2);
    assert.equal(uploads.length, pasted);
    // The second of two: its original is already in this draft.
    await markUp(2, "two.png");
    assert.match(dialog().textContent, /The original is already in Mori’s draft; only the annotated copy is added\./);
    button(page, "Add area").click();
    await until(() => page.document.activeElement?.id?.startsWith("point-fix-note-"), "its note has the focus");
    typeText(page, page.document.activeElement, "Crop this");
    button(page, "Add to Mori’s draft").click();
    await until(() => dialog()?.querySelector('[role="alert"]'), "a failed upload is shown");
    assert.equal(composerText(mori), "Look at these", "a failure adds nothing");
    assert.equal(draftImages().length, 2);
    button(page, "Add to Mori’s draft").click();
    await until(() => !dialog(), "added");
    const text = composerText(mori);
    assert.ok(text.startsWith("Look at these"), text);
    assert.match(text, /“two\.png” \(400×300 px\): 1 marked area in the attached annotated image; the original is the other image you attached\.\nSource: the image two\.png you attached\n\n1\. Area at x 150, y 113, 100×75 px: Crop this/);
    assert.equal(draftImages().length, 3, "both pasted images stay, and the annotated copy joins them");
    assert.deepEqual(uploads.slice(pasted).map((u) => [u.agent, u.content.slice(0, 9)]), [["a", "annotated"], ["a", "annotated"]],
      "the annotated copy, failed once and then saved; never the original again");
    // Told to another Agent: the original goes along there; Mori's draft stays.
    await markUp(1, "one.png");
    button(page, "Add area").click();
    await pause();
    const select = dialog().querySelector(".point-fix-target select");
    select.value = "b";
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await pause();
    assert.doesNotMatch(dialog().textContent, /already in/);
    button(page, "Add to Hana’s draft").click();
    await until(() => !dialog() && page.document.querySelector('[data-composer-input][aria-label="Message Hana"]'), "Hana's draft opens");
    assert.equal(draftImages().length, 2, "Hana gets the annotated copy and the original");
    assert.deepEqual(uploads.slice(-2).map((u) => [u.agent, u.content.slice(0, 10)]), [["b", "annotated "], ["b", "pasted-one"]]);
    button(page, "Mori").click();
    await until(() => page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "back to Mori");
    assert.equal(draftImages().length, 3);
    assert.ok(composerText(page.document.querySelector('[data-composer-input][aria-label="Message Mori"]')).startsWith("Look at these"));
    assert.deepEqual(pickers, [], "no file picker was opened");
    assert.equal(sent(), 0, "nothing was sent");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("the composer says something under the draft only when it needs you", async () => {
  for (const [status, notice] of [
    ["idle", null],
    ["offline", "Send a message to resume this session"],
    ["uncertain", "Send to check the previous result first"],
  ]) {
    const page = await mount({ status });
    try {
      const hint = page.document.querySelector(".composer-bottom > .composer-hint");
      assert.equal(hint?.hasAttribute("data-notice"), notice !== null, status);
      if (notice) assert.equal(hint.textContent, notice, status);
      // Otherwise the line holds only the keys, which show while typing.
      else assert.ok(!!hint?.querySelector(".composer-keys"), status);
    } finally { page.close(); }
  }
});

test("the composer box focuses its input, but not for presses from a portalled dialog", async () => {
  const page = await mount();
  try {
    const field = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, field, "Keep this draft");
    field.blur();
    const press = (el) => el.dispatchEvent(new page.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    assert.equal(press(page.document.querySelector(".composer-bottom > span")), false);
    assert.ok(page.document.activeElement === field, "the composer field keeps focus");
    assert.equal(composerSelection(field), "Keep this draft".length);
    field.blur();
    page.document.querySelector('[aria-label="Ask for an interactive result"]').click();
    await pause();
    const overlay = page.document.querySelector(".modal-overlay");
    assert.ok(overlay, "the result request dialog is open");
    // React bubbles portal events through the composer; the overlay is not in it.
    assert.equal(press(overlay), true);
    assert.ok(page.document.activeElement !== field, "the overlay takes focus from the composer field");
  } finally { page.close(); }
});

test("without a system frame the toolbar moves the window and carries its own window controls", async () => {
  const calls = [];
  let maximized = false;
  const record = (name) => async () => { calls.push(name); };
  const frameless = {
    isDecorated: async () => false,
    isMaximized: async () => maximized,
    minimize: record("minimize"),
    toggleMaximize: record("toggleMaximize"),
    close: record("close"),
    startDragging: record("startDragging"),
  };
  const page = await mount({ nativeWindow: frameless });
  try {
    await pause();
    const toolbar = page.document.querySelector(".toolbar");
    const group = toolbar.querySelector('[role="group"][aria-label="Window"]');
    assert.ok(group, "window controls sit in the toolbar");
    assert.ok(toolbar.lastElementChild === group, "the controls end the toolbar");
    for (const name of ["Minimize", "Maximize", "Close window"])
      group.querySelector(`[aria-label="${name}"]`).click();
    assert.deepEqual(calls, ["minimize", "toggleMaximize", "close"]);
    calls.length = 0;
    const press = (target, detail = 1) => target.dispatchEvent(new page.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail }));
    press(toolbar.querySelector(".workspace-name"));
    press(toolbar, 2);
    press(toolbar.querySelector('[aria-label="Settings and updates"]'));
    press(toolbar.querySelector(".catchup-nav"));
    assert.deepEqual(calls, ["startDragging", "toggleMaximize"], "buttons keep their own clicks");
    maximized = true;
    page.window.dispatchEvent(new page.window.Event("resize"));
    await pause();
    assert.ok(group.querySelector('[aria-label="Restore"]'), "maximized shows Restore");
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
  } finally { page.close(); }
  for (const nativeWindow of [{ ...frameless, isDecorated: async () => true }, { ...frameless, isDecorated: async () => { throw new Error("not allowed"); } }, undefined]) {
    const other = await mount({ nativeWindow });
    try {
      await pause();
      assert.equal(!!other.document.querySelector('[aria-label="Window"]'), false, "system frame, older shell or browser: no second set of controls");
    } finally { other.close(); }
  }
});

test("words streaming onto a reply fade in; the first render and an edit show text as is", async () => {
  const reply = { id: "stream-reply", type: "agentMessage", text: "First words" };
  const turn = { id: "streaming", status: "inProgress", items: [{ id: "ask", type: "userMessage", content: [{ type: "text", text: "Go" }] }, reply] };
  const page = await mount({ status: "working", turnStatus: "completed", extraTurns: [turn] });
  const refresh = async () => { page.window.dispatchEvent(new page.window.Event("focus")); await pause(); await pause(); };
  try {
    const prose = () => page.document.querySelector('[data-item-id="stream-reply"] .prose');
    const fading = () => [...prose().querySelectorAll(".stream-word")].map((w) => w.textContent.trim());
    assert.deepEqual(fading(), [], "the first render is shown as is");
    reply.text = "First words and then some more";
    await refresh();
    assert.deepEqual(fading(), ["and", "then", "some", "more"]);
    assert.match(prose().textContent, /^First words and then some more/);
    reply.text = "Rewritten from the start";
    await refresh();
    assert.deepEqual(fading(), [], "an edit is not animated");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

for (const harness of ["codex", "claude"]) test(`${harness}: deferred tools mount on inspection and only new live rows unfold`, async () => {
  const tool = (id) => harness === "claude"
    ? { id, type: "claudeToolUse", name: "Bash", input: { command: "pwd" }, output: "fixture", status: "completed" }
    : { id, type: "commandExecution", command: "pwd", aggregatedOutput: "fixture", status: "completed", exitCode: 0 };
  const turn = { id: "deferred", status: "completed", items: [tool("deferred-a"), { id: "done", type: "agentMessage", text: "Done." }] };
  const played = [];
  const page = await mount({ harness, extraTurns: [turn], beforeLoad(window) {
    window.HTMLElement.prototype.animate = function (_, options) {
      if (options?.id === "tool-unfold") played.push(this.id || this.className);
      return { addEventListener() {}, cancel() {} };
    };
  } });
  try {
    const group = page.document.querySelector('[data-turn-id="deferred"] .tool-activity');
    assert.equal(group.open, false);
    assert.match(group.querySelector("summary").textContent, harness === "claude" ? /Bash×1/ : /Shell×1/);
    assert.equal(page.document.getElementById("item-deferred-a"), null);
    group.querySelector("summary").click();
    await pause(); await pause();
    const original = page.document.getElementById("item-deferred-a");
    assert.ok(original);
    assert.deepEqual(played, [], "opening history does not replay arrival animations");
    original.open = true;
    await pause();
    group.querySelector("summary").click();
    await pause();
    assert.equal(page.document.getElementById("item-deferred-a"), null, "closed groups release their rows");
    group.querySelector("summary").click();
    await pause();
    const reopened = page.document.getElementById("item-deferred-a");
    assert.equal(reopened.open, true, "nested disclosure choice survives row remount");
    assert.deepEqual(played, [], "remounting inspected history does not replay arrivals");
    turn.items.splice(1, 0, tool("deferred-b"));
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.deepEqual(played, ["item-deferred-b"], "only the genuinely new row unfolds");
    assert.equal(page.document.getElementById("item-deferred-a"), reopened);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("deferred tools are mounted before original-source navigation resolves its target", async () => {
  const page = await mount({
    extraTurns: [{ id: "source-tools", status: "completed", items: [
      { id: "source-command", type: "commandExecution", command: "pwd", aggregatedOutput: "fixture", status: "completed" },
      { id: "source-done", type: "agentMessage", text: "Done." },
    ] }],
    workSummary: { text: "Tool source", kind: "result", source: "agent", turnId: "source-tools", itemId: "source-command" },
  });
  try {
    assert.equal(page.document.getElementById("item-source-command"), null);
    page.document.querySelector(".inspector-work-source").click();
    await pause(); await pause();
    const target = page.document.getElementById("item-source-command");
    assert.ok(target);
    assert.equal(target.closest(".tool-activity").open, true);
    assert.equal(page.document.activeElement, target);
    assert.equal(page.scrollTargets.at(-1), target);
    assert.equal(page.document.querySelector("[data-source-jump]"), null, "manual disclosure motion is restored after navigation");
    assert.doesNotMatch(page.document.querySelector(".source-navigation").textContent, /unavailable/);
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("deferred tools cancel source focus when another agent is selected", async () => {
  const page = await mount({
    extraTurns: [{ id: "source-tools", status: "completed", items: [
      { id: "source-command", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "source-done", type: "agentMessage", text: "Done." },
    ] }],
    workSummary: { text: "Tool source", kind: "result", source: "agent", turnId: "source-tools", itemId: "source-command" },
  });
  try {
    // Hold the next rendering opportunity so navigation can supersede the
    // source jump before its target receives focus or a scroll request.
    const frames = new Map();
    let nextFrame = 0;
    page.window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
    page.window.cancelAnimationFrame = (id) => frames.delete(id);
    page.document.querySelector(".inspector-work-source").click();
    await pause(); await pause();
    const target = page.document.getElementById("item-source-command");
    const group = target.closest(".tool-activity");
    assert.equal(group.hasAttribute("data-source-jump"), true);
    page.document.querySelector('[aria-label="Open Hana"]').click();
    await pause(); await pause();
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
    await pause();
    assert.equal(group.hasAttribute("data-source-jump"), false);
    assert.equal(page.scrollTargets.includes(target), false);
    assert.notEqual(page.document.activeElement, target);
    assert.ok(page.document.querySelector('[aria-label="Message Hana"]'));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("deferred tools keep pending file-approval targets available without mounting unrelated groups", async () => {
  const page = await mount({ status: "waiting", pending: [{
    id: "approval-edit", agentId: "a", method: "item/fileChange/requestApproval", createdAt: "",
    params: { itemId: "pending-edit" },
  }], extraTurns: [{ id: "pending-tools", status: "inProgress", items: [
    { id: "unrelated-tool", type: "commandExecution", command: "pwd", status: "completed" },
    { id: "comment", type: "agentMessage", phase: "commentary", text: "Proposing a change." },
    { id: "pending-edit", type: "fileChange", changes: [{ path: "src/example.ts", diff: "+proposed" }], status: "inProgress" },
    { id: "awaiting", type: "agentMessage", text: "Waiting for approval." },
  ] }] });
  try {
    assert.equal(page.document.getElementById("item-unrelated-tool"), null);
    const target = page.document.getElementById("item-pending-edit");
    assert.ok(target);
    assert.equal(target.closest(".tool-activity").open, false);
    // Model a busy renderer: source navigation can take longer than pause().
    // Wait for the observable result rather than assuming two frames fit 45 ms.
    page.window.requestAnimationFrame = (callback) =>
      page.window.setTimeout(() => callback(page.window.performance.now()), 80);
    page.window.cancelAnimationFrame = (id) => page.window.clearTimeout(id);
    button(page, "View proposed changes").click();
    const deadline = Date.now() + 2_000;
    while (page.document.activeElement !== target && Date.now() < deadline) await pause();
    assert.equal(target.open, true);
    assert.equal(target.closest(".tool-activity").open, true);
    assert.match(target.querySelector("pre").textContent, /proposed/);
    // Compare booleans so a failed assertion cannot inspect the whole JSDOM tree.
    assert.equal(page.scrollTargets.at(-1) === target, true, "scrolls to the proposed change");
    assert.equal(page.document.activeElement === target, true, "focuses the proposed change");
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("tool activity that arrives live unfolds and settles; what loads with the page and reduced motion stay still", async () => {
  const shell = (id, status = "inProgress", exitCode) => ({ id, type: "commandExecution", command: `run ${id}`, status, ...(exitCode == null ? {} : { exitCode }) });
  const turn = {
    id: "tools-live",
    status: "inProgress",
    items: [
      { id: "go", type: "userMessage", content: [{ type: "text", text: "Go" }] },
      { id: "note", type: "agentMessage", phase: "commentary", text: "Checking." },
      shell("tool-a"),
    ],
  };
  const played = [];
  const page = await mount({
    status: "working",
    turnStatus: "completed",
    extraTurns: [turn],
    beforeLoad(window) {
      window.HTMLElement.prototype.animate = function (keyframes, options) {
        if (/^tool-/.test(options?.id)) played.push(`${options.id}:${this.id || this.className}`);
        return { addEventListener() {}, cancel() {} };
      };
    },
  });
  const refresh = async () => { page.window.dispatchEvent(new page.window.Event("focus")); await pause(); await pause(); };
  try {
    const row = (id) => page.document.getElementById(`item-${id}`);
    const spinner = () => page.document.querySelector('[data-turn-id="tools-live"] .tool-spinner');
    assert.deepEqual(played, [], "what loads with the page does not move");
    assert.equal(row("tool-a")?.hasAttribute("data-running"), true);
    assert.equal(spinner()?.hasAttribute("data-on"), true);
    // A row arrives: it unfolds, the count ticks, the finished status settles.
    turn.items[2] = shell("tool-a", "completed", 0);
    turn.items.push(shell("tool-b"));
    await refresh();
    assert.deepEqual(played.sort(), ["tool-count-tick:tool-count-number", "tool-result:tool-result", "tool-unfold:item-tool-b"]);
    assert.equal(row("tool-a")?.hasAttribute("data-running"), false);
    // Commentary folds the block, whose rows then change out of sight; the
    // heading settles and the next block unfolds.
    played.length = 0;
    turn.items[3] = shell("tool-b", "completed", 0);
    turn.items.push({ id: "note-2", type: "agentMessage", phase: "commentary", text: "Both passed." }, shell("tool-c"));
    await refresh();
    const blocks = page.document.querySelectorAll('[data-turn-id="tools-live"] .tool-activity');
    assert.deepEqual([...blocks].map((block) => block.open), [false, true]);
    assert.deepEqual(played.sort(), ["tool-label:tool-activity-label", "tool-unfold:execution tool-activity"]);
    assert.equal(spinner()?.hasAttribute("data-on"), false);
    played.length = 0;
    page.window.matchMedia = (media) => ({ media, matches: /reduce/.test(media), addEventListener() {}, removeEventListener() {} });
    turn.items.push(shell("tool-d"));
    await refresh();
    assert.equal(!!row("tool-d"), true);
    assert.deepEqual(played, [], "reduced motion shows rows in place");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a tap on any Yuzu mark restarts its hop; reduced motion only brightens it", async () => {
  const page = await mount({ status: "working", turnStatus: "inProgress" });
  try {
    const played = [];
    let cancelled = 0;
    page.window.HTMLImageElement.prototype.animate = function (keyframes, options) {
      const animation = { id: "", playState: "running", cancel() { cancelled++; } };
      played.push({ mark: this, keyframes, options });
      this.running = [animation];
      return animation;
    };
    page.window.HTMLImageElement.prototype.getAnimations = function () { return this.running || []; };
    const tap = (el) => el.dispatchEvent(new page.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    const marks = [...page.document.querySelectorAll("img.yuzu-mark")];
    assert.ok(marks.length >= 2, "the brand and at least one more Yuzu are on screen");
    for (const mark of marks) tap(mark);
    assert.equal(played.length, marks.length);
    const moved = (keyframes) => [...new Set(keyframes.flatMap((k) => Object.keys(k)))]
      .filter((k) => !["offset", "easing"].includes(k)).sort();
    assert.deepEqual(moved(played[0].keyframes), ["rotate", "scale", "translate"]);
    tap(marks[0]);
    assert.equal(cancelled, 1, "a second tap restarts the hop");
    page.window.matchMedia = (media) => ({ media, matches: /reduce/.test(media), addEventListener() {}, removeEventListener() {} });
    tap(marks[0]);
    assert.deepEqual(moved(played.at(-1).keyframes), ["filter"]);
    marks[0].dispatchEvent(new page.window.MouseEvent("pointerdown", { bubbles: true, button: 2 }));
    assert.equal(played.length, marks.length + 2, "only the primary button taps");
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
  } finally { page.close(); }
});

test("the model label carries the saved reasoning effort only where turns are sent it", async () => {
  const settings = { reasoningEffort: "xhigh", approvalPolicy: "on-request", sandbox: "workspace-write" };
  for (const [harness, label] of [["codex", "test-model · xhigh"], ["claude", "test-model"]]) {
    const page = await mount({ harness, settings });
    try {
      const metadata = page.document.querySelector(".composer-footnote .conversation-metadata");
      const model = [...metadata.children].find((chip) => chip.title.startsWith("Model:"));
      assert.equal(model.textContent, label, harness);
      assert.equal(/Reasoning effort: xhigh/.test(model.title), harness === "codex");
    } finally { page.close(); }
  }
});

test("the dock follows the reading marker; the wheel walks it while the pointer is on it", async () => {
  const page = await mount({ extraTurns: Array.from({ length: 119 }, (_, i) => ({ id: `scroll-${i}`, status: "completed", items: [] })) });
  try {
    const scroller = page.document.querySelector('.conversation-scroll');
    const dock = page.document.querySelector('.turn-dock');
    Object.defineProperties(scroller, { clientHeight: { value: 260 }, scrollHeight: { value: 36000 } });
    scroller.getBoundingClientRect = () => ({ top: 100 });
    page.document.querySelectorAll('.turn[data-turn-id]').forEach((node, i) => { node.getBoundingClientRect = () => ({ top: 100 + i * 300 - scroller.scrollTop }); });
    page.window.dispatchEvent(new page.window.Event('resize'));
    const numbers = () => [...dock.querySelectorAll('li[data-kind="number"] [data-turn-choice]')].map((b) => b.dataset.turnChoice);
    const scrollTo = async (top) => { scroller.scrollTop = top; scroller.dispatchEvent(new page.window.Event('scroll')); await pause(); await pause(); };
    await scrollTo(2740);
    assert.equal(dock.querySelector('[aria-current="location"]').dataset.turnChoice, 'scroll-8');
    // At most five numbers and ten bars, however long the conversation.
    assert.deepEqual(numbers(), ['scroll-6', 'scroll-7', 'scroll-8', 'scroll-9', 'scroll-10']);
    assert.equal(dock.querySelectorAll('li[data-kind="bar"]').length, 10);
    assert.deepEqual([...dock.querySelectorAll('.turn-dock-bar')].map((d) => d.style.getPropertyValue('--bar-distance')),
      ['5', '4', '3', '2', '1', '1', '2', '3', '4', '5']);
    dock.dispatchEvent(new page.window.MouseEvent('pointerover', { bubbles: true, relatedTarget: page.document.body }));
    await pause();
    assert.equal(dock.dataset.engaged, 'true');
    dock.dispatchEvent(new page.window.WheelEvent('wheel', { bubbles: true, deltaY: 180 }));
    await pause();
    assert.deepEqual(numbers(), ['scroll-9', 'scroll-10', 'scroll-11', 'scroll-12', 'scroll-13'], 'three steps of the wheel');
    assert.equal(scroller.scrollTop, 2740, 'the conversation stays put');
    await scrollTo(20740);
    assert.match(dock.querySelector('.turn-dock-position').textContent, /^70\s*\/ 120$/);
    assert.deepEqual(numbers(), ['scroll-9', 'scroll-10', 'scroll-11', 'scroll-12', 'scroll-13'], 'held while engaged');
    dock.dispatchEvent(new page.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: page.document.body }));
    await pause(); await pause();
    assert.equal(dock.dataset.engaged, 'false');
    assert.equal(dock.querySelector('[aria-current="location"]').dataset.turnChoice, 'scroll-68');
    assert.deepEqual(numbers(), ['scroll-66', 'scroll-67', 'scroll-68', 'scroll-69', 'scroll-70']);
    assert.equal(page.calls.filter((r) => r.init.method === 'POST').length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("design specimen is labelled and never opens a runtime connection", async () => {
  const page = await mount({ preview: true });
  try {
    assert.match(page.document.body.textContent, /Design preview/);
    assert.match(page.document.body.textContent, /read-only/);
    assert.equal(page.calls.length, 0);
    assert.ok(page.document.querySelector('[aria-label="Create agent"]'));
    button(page, "Home").click();
    await pause();
    assert.match(page.document.body.textContent, /Needs you/);
    assert.equal(page.calls.length, 0);
  } finally {
    page.close();
  }
});
test("desktop presentation keeps requests, events, and artifacts on the configured Core origin", async () => {
  const page = await mount({
    url: "http://localhost:9321/?shell=desktop",
    message: "[Open report](report.md)",
  });
  try {
    assert.ok(page.document.querySelector(".app.native"));
    assert.ok(page.calls.every((call) => call.url.startsWith("/api/")));
    assert.deepEqual(page.eventUrls, ["/api/events"]);
    page.document.querySelector(".prose a").click();
    await pause();
    assert.ok(page.calls.some((call) => call.url.startsWith("/api/artifact?")));
    // The bottom-left entry is the Workspace/project scope, not a machine.
    assert.match(
      page.document.querySelector(".workspace-scope").textContent,
      /All projects.*Personal workspace/,
    );
    page.document.querySelector('[aria-label="Close dialog"]').click();
    page.document.querySelector('[aria-label="Create agent"]').click();
    await pause();
    assert.match(
      page.document.querySelector('[role="dialog"]').textContent,
      /machine running your workspace Core/,
    );
  } finally {
    page.close();
  }
});
test("drafts follow their agent and reading the conversation never implicitly acknowledges requests", async () => {
  const page = await mount();
  try {
    const input = page.document.querySelector("[data-composer-input]");
    setValue(page.window, input, "Remember the small details");
    await pause();
    button(page, "Hana").click();
    await pause();
    await pause();
    assert.equal(composerText(page.document.querySelector("[data-composer-input]")), "");
    setValue(
      page.window,
      page.document.querySelector("[data-composer-input]"),
      "A different task",
    );
    await pause();
    button(page, "Mori").click();
    await pause();
    await pause();
    assert.equal(
      composerText(page.document.querySelector("[data-composer-input]")),
      "Remember the small details",
    );
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
    page.document.querySelector('[aria-label="Conversation actions"]').click();
    await pause();
    button(page, "Mark all as read").click();
    await pause();
    const review = page.calls.find((c) => c.url.endsWith("/review"));
    assert.equal(JSON.parse(review.init.body).throughSeq, 12);
    assert.equal(review.init.headers["X-Yuzuno-Client"], "desktop");
  } finally {
    page.close();
  }
});
test("stale and already-submitted approvals cannot be sent again", async () => {
  for (const params of [
    { stale: true, params: {} },
    { stale: false, params: { _responseSent: true } },
  ]) {
    const page = await mount({
      pending: [
        {
          id: "p1",
          agentId: "a",
          method: "item/commandExecution/requestApproval",
          createdAt: "2026-10-12",
          ...params,
        },
      ],
    });
    try {
      assert.equal(button(page, "Allow once").disabled, true);
      button(page, "Allow once").click();
      await pause();
      assert.equal(
        page.calls.filter((c) => c.url.includes("/respond")).length,
        0,
      );
    } finally {
      page.close();
    }
  }
});

test("approval choices respect harness capabilities and hide internal transport metadata", async () => {
  const page = await mount({
    pending: [
      {
        id: "p1",
        agentId: "a",
        method: "item/commandExecution/requestApproval",
        createdAt: "2026-10-12",
        params: {
          availableDecisions: ["decline"],
          _rpcId: "internal-only",
          command: "npm run build",
        },
      },
    ],
  });
  try {
    assert.equal(button(page, "Allow once").disabled, true);
    assert.equal(button(page, "Decline").disabled, false);
    assert.equal(button(page, "Cancel turn").disabled, true);
    assert.doesNotMatch(
      page.document.querySelector(".request-details").textContent,
      /internal-only|_rpcId/,
    );
    button(page, "Decline").click();
    await pause();
    const request = page.calls.find((c) => c.url.includes("/respond"));
    assert.deepEqual(JSON.parse(request.init.body), {
      response: { decision: "decline" },
    });
  } finally {
    page.close();
  }
  const unsupported = await mount({
    pending: [
      {
        id: "p2",
        agentId: "a",
        method: "item/unknown/requestApproval",
        createdAt: "2026-10-12",
        params: {},
      },
    ],
  });
  try {
    assert.ok(button(unsupported, "Allow once") === undefined, 'no "Allow once" button');
    assert.match(unsupported.document.body.textContent, /not available yet/);
  } finally {
    unsupported.close();
  }
});

test("non-blocking questions do not claim that execution has stopped", async () => {
  const page = await mount({
    status: "working",
    pending: [
      {
        id: "p1",
        agentId: "a",
        method: "item/tool/requestUserInput",
        createdAt: "2026-10-12",
        params: {
          isBlocking: false,
          questions: [{ id: "q", question: "Any extra context?" }],
        },
      },
    ],
  });
  try {
    // A question that does not block the turn asks nothing of the composer.
    assert.equal(!!page.document.querySelector(".composer-hint[data-notice]"), false);
    assert.doesNotMatch(
      page.document.querySelector(".composer-bottom").textContent,
      /Waiting for your response/,
    );
    assert.ok(page.document.querySelector(".pending-card"));
  } finally {
    page.close();
  }
});

test("session approval is offered only when native supports it and leaves Pending until confirmation", async () => {
  const page = await mount({
    status: "waiting",
    pending: [
      {
        id: "session",
        agentId: "a",
        method: "item/commandExecution/requestApproval",
        createdAt: "",
        params: {
          command: "bounded task",
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      },
    ],
  });
  try {
    button(page, "Allow for this session").click();
    await pause();
    await pause();
    const requests = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/requests/session/respond");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      response: { decision: "acceptForSession" },
    });
    assert.equal(page.document.querySelectorAll(".pending-card").length, 1);
  } finally {
    page.close();
  }
});
test("a delivered answer stays locked and says so before a refetch marks it sent (T-120)", async () => {
  const question = {
    id: "ask",
    agentId: "a",
    method: "item/tool/requestUserInput",
    createdAt: "",
    params: {
      questions: [{ id: "pick", question: "Which one?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
    },
  };
  // Core's later detail reads still list the request without _responseSent,
  // as one taken before the reply was recorded does.
  const page = await mount({ status: "waiting", pending: [question] });
  try {
    const card = page.document.querySelector(".pending-card");
    card.querySelector("label.answer-option input").click();
    await pause();
    button(page, "Send answer").click();
    await pause();
    await pause();
    assert.equal(page.calls.filter((c) => c.url.includes("/respond")).length, 1);
    assert.equal(page.document.querySelectorAll(".pending-card").length, 1);
    assert.equal(button(page, "Send answer").disabled, true);
    assert.match(card.textContent, /Response sent\. Waiting for the harness to confirm\./);
    page.document.querySelector(".pending-card form").requestSubmit();
    await pause();
    assert.equal(page.calls.filter((c) => c.url.includes("/respond")).length, 1);
  } finally {
    page.close();
  }
  // A reply Core refused was not sent: the card can be answered again.
  const refused = await mount({
    status: "waiting",
    pending: [question],
    beforeLoad: (window) => {
      const fetch = window.fetch;
      window.fetch = async (url, init) =>
        url.includes("/respond")
          ? { ok: false, status: 409, text: async () => JSON.stringify({ error: "Session disconnected; the request was not sent" }) }
          : fetch(url, init);
    },
  });
  try {
    refused.document.querySelector(".pending-card label.answer-option input").click();
    await pause();
    button(refused, "Send answer").click();
    await pause();
    await pause();
    const card = refused.document.querySelector(".pending-card");
    assert.match(card.textContent, /the request was not sent/);
    assert.doesNotMatch(card.textContent, /Response sent/);
    assert.equal(button(refused, "Send answer").disabled, false);
  } finally {
    refused.close();
  }
});
test("Escape interrupts the current turn but not while the creation dialog is open", async () => {
  const page = await mount({ status: "working" });
  try {
    page.document.querySelector('[aria-label="Create agent"]').click();
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]'));
    page.window.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    await pause();
    assert.equal(
      page.calls.filter((c) => c.url.endsWith("/interrupt")).length,
      0,
    );
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    page.window.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    await pause();
    assert.equal(
      page.calls.filter((c) => c.url.endsWith("/interrupt")).length,
      1,
    );
    assert.match(page.document.body.textContent, /Interrupt requested/);
  } finally {
    page.close();
  }
});
test("Markdown retains tables and code while stripping executable HTML and remote image loads", async () => {
  const page = await mount({
    message:
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n<script>window.bad=true</script><img src="https://evil.invalid/track" onerror="alert(1)"><iframe src="https://evil.invalid"></iframe><a href="javascript:alert(1)">bad</a>\n\n[Open report](report.md)',
  });
  try {
    const prose = page.document.querySelector(".prose");
    assert.ok(prose.querySelector("table"));
    assert.ok(prose.querySelector("pre code"));
    assert.ok(prose.querySelector("script,img,iframe") === null, "script,img,iframe is absent");
    assert.ok(prose.querySelector('[href^="javascript:"]') === null, '[href^="javascript:"] is absent');
    assert.equal(page.window.bad, undefined);
    const report = [...prose.querySelectorAll("a")].find(
      (a) => a.textContent === "Open report",
    );
    report.click();
    await pause();
    assert.ok(
      page.calls.some((c) =>
        c.url.includes("/api/artifact?agentId=a&path=report.md"),
      ),
    );
    assert.equal(page.window.location.pathname, "/");
  } finally {
    page.close();
  }
});

test("file links retain line locations while the artifact API receives only decoded paths", async () => {
  const cases = [
    ["web/src/App.tsx:42", "web/src/App.tsx", 42],
    ["web/src/App.tsx#L42", "web/src/App.tsx", 42],
    ["web/src/App.tsx:42:8", "web/src/App.tsx", 42],
    ["file:///workspace/my%20file.ts#L2", "/workspace/my file.ts", 2],
    ["/workspace/my%20file.ts:1", "/workspace/my file.ts", 1],
    ["web/src/App.tsx#L60", "web/src/App.tsx", 60],
    ["literal%23L42.ts:3", "literal#L42.ts", 3],
  ];
  const source = Array.from({ length: 60 }, (_, i) => `source ${i + 1}`).join(
    "\r\n",
  );
  const page = await mount({
    message: cases.map(([href], i) => `[Case ${i}](${href})`).join("\n\n"),
    files: Object.fromEntries(cases.map(([, path]) => [path, source])),
  });
  try {
    for (const [i, [, path, line]] of cases.entries()) {
      [...page.document.querySelectorAll(".final-message a")][i].click();
      const dialog = await waitForPreviewState(() => {
        const open = page.document.querySelector('[role="dialog"]');
        return open?.querySelector(".source-line-highlight") && open;
      }, `case ${i} to open at its line`);
      assert.equal(dialog.querySelectorAll(".source-line").length, 60);
      const highlighted = dialog.querySelectorAll(".source-line-highlight");
      assert.equal(highlighted.length, 1);
      assert.equal(highlighted[0].dataset.line, String(line));
      assert.equal(
        highlighted[0].querySelector(".source-line-text").textContent,
        `source ${line}`,
      );
      assert.equal(highlighted[0].getAttribute("aria-current"), "location");
      const request = page.calls
        .filter((call) => call.url.includes("/api/artifact?"))
        .at(-1);
      const params = new URL(request.url, page.window.location.href)
        .searchParams;
      assert.deepEqual(
        [...params],
        [
          ["agentId", "a"],
          ["path", path],
        ],
      );
      const copies = page.copied.length;
      button(page, "Copy contents").click();
      await waitForPreviewState(() => page.copied.length > copies, `case ${i}'s contents to be copied`);
      assert.equal(page.copied.at(-1), source);
      dialog.querySelector('[aria-label="Close dialog"]').click();
      await waitForPreviewState(() => !page.document.querySelector('[role="dialog"]'), `case ${i}'s preview to close`);
    }
    assert.equal(page.window.location.pathname, "/");
    assert.equal(page.window.location.hash, "");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("Artifacts show the latest turn, preserve history preview and reset disclosure for another turn or Agent", async () => {
  const extraTurns = [{ id: "t2", status: "inProgress", items: [{ id: "edit2", type: "fileChange", changes: [{ path: "/workspace/current.md" }] }] }];
  const page = await mount({
    status: "working", extraTurns,
    artifacts: [
      { path: "current.md", name: "current.md", kind: "text", sourceItemId: "r1" },
      { path: "earlier.md", name: "earlier.md", kind: "text", sourceItemId: "u1" },
    ],
    files: { "earlier.md": "Earlier file content" },
  });
  try {
    const panel = () => page.document.querySelector(".artifacts-panel");
    const current = () => panel().querySelector('[aria-label="Latest turn artifacts"]');
    const history = () => panel().querySelector(".artifact-history");
    assert.equal(current().querySelectorAll(".artifact-row").length, 1);
    assert.match(current().textContent, /current.md/);
    assert.doesNotMatch(current().textContent, /earlier.md/);
    assert.equal(history().open, false);
    history().querySelector("summary").click();
    assert.equal(history().open, true);
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Keep this draft.");
    await pause();
    history().querySelector(".artifact-row").click();
    await pause(); await pause();
    assert.match(page.document.querySelector('[role="dialog"]').textContent, /Earlier file content/);
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    assert.equal(composerText(composer), "Keep this draft.");
    assert.equal(history().open, true);
    extraTurns[0].items.push({ id: "progress2", type: "agentMessage", text: "Still working" });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.equal(history().open, true, "same-turn events preserve the opened history");
    extraTurns.push({ id: "t3", status: "inProgress", items: [] });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await pause(); await pause();
    assert.match(current().textContent, /No files in this turn/);
    assert.equal(history().open, false);
    assert.equal(history().querySelectorAll(".artifact-row").length, 2);
    history().querySelector("summary").click();
    button(page, "Hana").click();
    await pause(); await pause();
    assert.equal(history().open, false);
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("ordinary Markdown renders normally, targeted Markdown shows source, and ordinary text and images still open", async () => {
  const markdown =
    "# Report\n\n**Original source**\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const files = {
    "report.md": markdown,
    "notes.txt": "hello\n\n<script>window.bad = true</script>\n",
  };
  const page = await mount({
    message:
      "[Markdown](report.md) [Source](report.md#L3) [Text](notes.txt) [Image](photo.png)",
    artifactResponse: async (url) => ({
      ok: true,
      text: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return files[new URL(url, "http://localhost").searchParams.get("path")];
      },
    }),
  });
  try {
    const links = [...page.document.querySelectorAll(".final-message a")];
    for (const index of [0, 1, 0, 2, 3]) {
      links[index].click();
      const selector = [
        ".prose h1",
        ".source-line-highlight .source-line-text",
        ".source-line",
        "img",
      ][index];
      const content = await until(
        () => page.document.querySelector(`[role="dialog"] ${selector}`),
        `Preview content appeared for link ${index}`,
      );
      const dialog = content.closest('[role="dialog"]');
      if (index === 0) {
        assert.equal(dialog.querySelector(".prose h1").textContent, "Report");
        assert.ok(dialog.querySelector(".prose table"));
        assert.ok(dialog.querySelector(".source-line") === null, ".source-line is absent");
      } else if (index === 1) {
        assert.ok(dialog.querySelector(".prose") === null, ".prose is absent");
        assert.equal(
          dialog.querySelector(".source-line-highlight .source-line-text")
            .textContent,
          "**Original source**",
        );
      } else if (index === 2) {
        assert.equal(dialog.querySelectorAll(".source-line").length, 4);
        assert.ok(dialog.querySelector(".source-line-highlight") === null, ".source-line-highlight is absent");
        assert.ok(dialog.querySelector("script") === null, "script is absent");
        assert.equal(page.window.bad, undefined);
      } else {
        assert.match(dialog.querySelector("img").src, /path=photo.png$/);
      }
      dialog.querySelector('[aria-label="Close dialog"]').click();
      await until(
        () => !page.document.querySelector('[role="dialog"]'),
        `Preview closed after link ${index}`,
      );
    }
  } finally {
    page.close();
  }
});

test("out-of-range, zero, negative, unsafe, and empty-file locations show an explicit range error", async () => {
  const hrefs = [
    "short.txt:4",
    "short.txt#L0",
    "short.txt:-1",
    "short.txt#L999999999999999999999",
    "empty.txt:1",
  ];
  const files = { "short.txt": "one\n\ntwo", "empty.txt": "" };
  const page = await mount({
    message: hrefs.map((href, i) => `[Case ${i}](${href})`).join(" "),
    artifactResponse: async (url) => ({
      ok: true,
      text: async () => {
        // Even a correct preview may need more than one 45 ms React tick.
        await new Promise((resolve) => setTimeout(resolve, 120));
        return files[new URL(url, "http://localhost").searchParams.get("path")];
      },
    }),
  });
  try {
    const links = [...page.document.querySelectorAll(".final-message a")];
    assert.equal(links.length, hrefs.length, "one link per case, or a case would go unchecked");
    for (const [index, link] of links.entries()) {
      link.click();
      const alert = await until(
        () => page.document.querySelector('[role="dialog"] [role="alert"]'),
        `Range error appeared for ${hrefs[index]}`,
      );
      const dialog = alert.closest('[role="dialog"]');
      assert.match(
        alert.textContent,
        /out of range/,
      );
      assert.match(
        alert.textContent,
        index === 4 ? /empty \(0 lines\)/ : /3 lines \(1–3\)/,
      );
      assert.ok(dialog.querySelector(".source-line-highlight") === null, ".source-line-highlight is absent");
      dialog.querySelector('[aria-label="Close dialog"]').click();
      await until(
        () => !page.document.querySelector('[role="dialog"]'),
        `Preview closed after ${hrefs[index]}`,
      );
    }
  } finally {
    page.close();
  }
});

test("closing a file preview restores reading position, link focus, and the existing draft without interrupting", async () => {
  const page = await mount({
    status: "working",
    message: "[Source](source.ts:2)",
    files: { "source.ts": "first\nsecond\nthird" },
  });
  try {
    const composer = page.document.querySelector("[data-composer-input]");
    setValue(page.window, composer, "Keep this unsent draft\n第二行");
    await pause();
    const conversation = page.document.querySelector(".conversation-scroll");
    Object.defineProperties(conversation, {
      scrollHeight: { value: 3000 },
      clientHeight: { value: 500 },
    });
    conversation.scrollTop = 320;
    conversation.dispatchEvent(new page.window.Event("scroll"));
    const link = page.document.querySelector(".final-message a");
    link.focus();
    link.click();
    await pause();
    assert.equal(conversation.scrollTop, 320);
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    assert.equal(conversation.scrollTop, 320);
    assert.ok(page.document.activeElement === link, "the link has focus");
    assert.equal(composerText(composer), "Keep this unsent draft\n第二行");
    link.click();
    await pause();
    page.document.querySelector('[aria-label="Close dialog"]').dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.equal(conversation.scrollTop, 320);
    assert.equal(composerText(composer), "Keep this unsent draft\n第二行");
    assert.equal(
      savedDraftText(page.window.localStorage, "a"),
      composerText(composer),
    );
    assert.equal(
      page.calls.filter((call) => call.init.method === "POST").length,
      0,
    );
  } finally {
    page.close();
  }
});

test("late file responses cannot replace a newer preview or hide its loading state", async () => {
  const requests = [];
  const page = await mount({
    message: "[Slow](slow.ts:2) [Next](next.ts#L3)",
    artifactResponse: (url, init) =>
      new Promise((resolve) => requests.push({ url, init, resolve })),
  });
  const respond = (request, text) =>
    request.resolve({ ok: true, text: async () => text });
  try {
    const links = [...page.document.querySelectorAll(".final-message a")];
    links[0].click();
    await pause();
    assert.match(
      page.document.querySelector('[role="dialog"]').textContent,
      /Opening file/,
    );
    assert.ok(page.document.querySelector('[role="dialog"] [role="alert"]') === null, '[role="dialog"] [role="alert"] is absent');
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    links[1].click();
    await pause();
    assert.equal(requests[0].init.signal.aborted, true);
    respond(requests[0], "stale\nstale");
    await pause();
    assert.match(
      page.document.querySelector('[role="dialog"]').textContent,
      /Opening file/,
    );
    respond(requests[1], "first\nsecond\ncurrent");
    await pause();
    assert.equal(
      page.document.querySelector(".source-line-highlight .source-line-text")
        .textContent,
      "current",
    );
    assert.doesNotMatch(
      page.document.querySelector('[role="dialog"]').textContent,
      /stale|out of range/,
    );
  } finally {
    page.close();
  }
});

test("rail shows attributed current work as plain text; the inspector opens the exact original reply", async () => {
  const page = await mount({
    workSummary: {
      text: "Tests passed according to the agent",
      kind: "result",
      source: "agent",
      turnId: "t1",
      itemId: "r1",
    },
  });
  try {
    const rail = page.document.querySelector('[data-agent-id="a"]');
    assert.equal(
      page.document.body.textContent.includes("Review the interface"),
      false,
    );
    assert.match(rail.textContent, /Reported/);
    // One target per card; the machine is shown, the working folder is not.
    assert.equal(rail.querySelectorAll("button").length, 1);
    // The machine heads the name, beside the avatar, inside the one target.
    const identity = rail.querySelector(".agent-select .agent-identity");
    assert.deepEqual(
      [...(identity?.children || [])].map((el) => el.className),
      ["remote-machine-badge", "agent-name"],
    );
    assert.match(identity?.textContent || "", /^Core host/);
    assert.match(rail.querySelector(".agent-select").getAttribute("aria-description"), /on Core host/);
    assert.doesNotMatch(rail.textContent, /workspace/);
    page.document.querySelector(".inspector-work-source").click();
    await pause();
    const reply = page.document.querySelector(
      '[data-turn-id="t1"] [data-item-id="r1"]',
    );
    assert.ok(page.document.activeElement === reply, "the reply has focus");
    assert.ok(page.scrollTargets.at(-1) === reply, "the reply was scrolled to");
    assert.match(
      page.document.querySelector(".source-navigation").textContent,
      /Back to latest/,
    );
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("runtime error current work focuses the error rather than the earlier task", async () => {
  const page = await mount({
    status: "error",
    agentError: "Connection lost before result confirmation",
    workSummary: {
      text: "Connection lost before result confirmation",
      kind: "error",
      source: "runtime",
      turnId: "t1",
    },
  });
  try {
    page.document.querySelector(".inspector-work-source").click();
    await pause();
    const error = page.document.getElementById("runtime-error-a");
    assert.ok(page.document.activeElement === error, "the runtime error has focus");
    assert.ok(page.scrollTargets.at(-1) === error, "the runtime error was scrolled to");
    assert.ok(error.classList.contains("source-highlight"));
    assert.equal(page.calls.filter((c) => c.init.method === "POST").length, 0);
  } finally {
    page.close();
  }
});

test("Claude sends native turns, offers a native model picker, excludes Codex settings and shows its own context usage", async () => {
  const page = await mount({
    harness: "claude",
    contextUsage: {
      usedPercent: 76.5,
      usedTokens: 76500,
      windowTokens: 100000,
      stale: false,
      turnId: "t1",
      updatedAt: "now",
    },
  });
  try {
    const modelSettings = page.document.querySelector('[aria-label="Agent settings"]');
    assert.ok(!!modelSettings, "Claude model settings are available");
    assert.match(modelSettings.textContent.trim(), /^Model\b/);
    assert.equal(
      page.document
        .querySelector(".context-usage-button")
        .getAttribute("aria-label"),
      "Context: 77% used",
    );
    const composer = page.document.querySelector(
      '[data-composer-input][aria-label="Message Mori"]',
    );
    setValue(page.window, composer, "Please continue this Claude session.");
    await until(() => page.document.querySelector('[aria-label="Send message"]')?.disabled === false,
      "Send to accept the draft");
    page.document.querySelector('[aria-label="Send message"]').click();
    await pause();
    await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/agents/a/messages");
    assert.equal(JSON.parse(posts[0].init.body).text, "Please continue this Claude session.");
    assert.deepEqual(JSON.parse(posts[0].init.body).textBlocks, []);
    assert.equal(composerText(composer), "");
    assert.equal(
      page.calls.some((r) => /\/turns$|\/models$|\/settings$/.test(r.url)),
      false,
    );
    modelSettings.click();
    await pause();
    await pause();
    assert.ok(!!chipGroup(page, "Model"));
    for (const label of ["Permissions", "Access", "Approval requests"])
      assert.equal(!!page.document.querySelector(`[role="dialog"] [aria-label="${label}"]`), false);
    // A model whose catalog row lists no effort offers only Claude Code's own.
    assert.deepEqual(levels(page), [""]);
    assert.equal(page.calls.filter((r) => r.url === "/api/agents/a/models").length, 1);
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    button(page, "Hana").click();
    await pause();
    await pause();
    assert.ok(
      page.document.querySelector('[aria-label="Agent settings"]'),
      "Codex settings remain available after switching",
    );
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

const claudeModels = [
  { id: "default", model: "default", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "opus", model: "opus", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "sonnet", model: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { id: "haiku", model: "haiku", displayName: "Haiku", supportsEffort: false, supportedEffortLevels: [] },
];
// Agent settings shows its choices as chips: radios in a named group.
function chipGroup(page, label) {
  return page.document.querySelector(`[role="dialog"] [role="radiogroup"][aria-label="${label}"]`);
}
function chosen(page, label) {
  return chipGroup(page, label).querySelector("input:checked")?.value;
}
async function choose(page, label, value) {
  chipGroup(page, label).querySelector(`input[value="${value}"]`).click();
  await pause();
}
const saveButton = (page) =>
  [...page.document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Save");
const levels = (page) => [...chipGroup(page, "Reasoning effort").querySelectorAll("input")].map((o) => o.value);

test("Claude effort offers the model's own levels, resets on a model that lacks it, keeps what Claude reported apart and survives a refused save", async () => {
  let refused = false;
  const page = await mount({
    harness: "claude",
    agentFields: { model: "opus" },
    settings: { reasoningEffort: "max", approvalPolicy: "on-request", sandbox: "workspace-write", permissionMode: "default" },
    models: claudeModels,
    claudeRuntime: { effort: { level: "high", turnId: "t1" } },
    settingsResponse: async () => {
      if (refused) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      refused = true;
      const error = JSON.stringify({ error: "所选 Claude 模型不支持推理强度 low；请重新选择" });
      return { ok: false, status: 400, json: async () => JSON.parse(error), text: async () => error };
    },
  });
  try {
    // What Claude reported stays visible outside the dialog, named as reported.
    assert.match(page.document.querySelector(".inspector").textContent, /Effort\s*high · reported/);
    page.document.querySelector('[aria-label="Agent settings"]').click();
    await pause(); await pause();
    const dialog = page.document.querySelector('[role="dialog"]');
    assert.equal(chosen(page, "Reasoning effort"), "max");
    assert.deepEqual(levels(page), ["", "low", "medium", "high", "xhigh", "max"]);
    assert.match(dialog.textContent, /Claude Code reported high for the latest turn\./);
    assert.match(dialog.textContent, /a running turn keeps its own/);
    await choose(page, "Model", "sonnet");
    assert.equal(chosen(page, "Reasoning effort"), "");
    assert.deepEqual(levels(page), ["", "low", "medium", "high"]);
    assert.match(dialog.textContent, /Sonnet does not take reasoning effort max; it is back to Claude Code default\./);
    await choose(page, "Model", "haiku");
    assert.deepEqual(levels(page), [""]);
    assert.match(dialog.textContent, /This model does not take a reasoning effort\./);
    await choose(page, "Model", "opus");
    await choose(page, "Reasoning effort", "low");
    assert.equal(dialog.textContent.includes("back to Claude Code default"), false);
    saveButton(page).click();
    await pause(); await pause();
    // Core refused: the dialog stays open with the reason and the choice.
    assert.match(page.document.querySelector('[role="dialog"] [role="alert"]').textContent, /不支持推理强度 low/);
    assert.equal(chosen(page, "Reasoning effort"), "low");
    saveButton(page).click();
    await pause(); await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(posts.length, 2);
    assert.ok(posts.every((r) => r.url === "/api/agents/a/settings"));
    assert.deepEqual(JSON.parse(posts[1].init.body), { model: "opus", permissionMode: "default", effort: "low" });
    assert.equal(!!page.document.querySelector('[role="dialog"]'), false);
    // Claude Code default is sent as an explicit null, not left out.
    page.document.querySelector('[aria-label="Agent settings"]').click();
    await pause(); await pause();
    await choose(page, "Reasoning effort", "");
    assert.match(page.document.querySelector('[role="dialog"]').textContent, /Claude Code decides/);
    saveButton(page).click();
    await pause(); await pause();
    assert.deepEqual(JSON.parse(page.calls.filter((r) => r.init.method === "POST").at(-1).init.body), { model: "opus", permissionMode: "default", effort: null });
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a saved Claude effort the model no longer lists is shown, not silently replaced, and blocks saving until changed", async () => {
  const page = await mount({
    harness: "claude",
    agentFields: { model: "sonnet" },
    settings: { reasoningEffort: "max", approvalPolicy: "on-request", sandbox: "workspace-write", permissionMode: "default" },
    models: claudeModels,
    claudeRuntime: { effort: { level: "max", turnId: "earlier" } },
  });
  try {
    page.document.querySelector('[aria-label="Agent settings"]').click();
    await pause(); await pause();
    const dialog = page.document.querySelector('[role="dialog"]');
    assert.equal(chosen(page, "Reasoning effort"), "max");
    assert.match(chipGroup(page, "Reasoning effort").textContent, /max\s*not available for this model/);
    assert.match(dialog.textContent, /does not take the saved effort/);
    assert.match(dialog.textContent, /Claude Code reported max for an earlier turn\./);
    assert.equal(saveButton(page).disabled, true);
    await choose(page, "Reasoning effort", "high");
    assert.equal(saveButton(page).disabled, false);
    // The Harness default model uses the catalog's default row.
    await choose(page, "Model", "");
    assert.deepEqual(levels(page), ["", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("working Claude keeps its draft and interrupt, and offers a follow-up to your turn", async () => {
  const page = await mount({ harness: "claude", status: "working" });
  try {
    const composer = page.document.querySelector(
      '[data-composer-input][aria-label="Message Mori"]',
    );
    setValue(page.window, composer, "Keep this for the next turn.");
    await pause();
    // Booleans, not nodes: a failing assert would print a whole jsdom window.
    assert.equal(!!page.document.querySelector('[aria-label="Send message"]'), false);
    assert.equal(page.document.querySelector('[aria-label="Send while working"]')?.disabled, false);
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.equal(composerText(composer), "Keep this for the next turn.");
    button(page, "Interrupt").click();
    await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/agents/a/interrupt");
    assert.equal(composerText(composer), "Keep this for the next turn.");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("task current work visibly highlights and focuses its original user message", async () => {
  const page = await mount({
    workSummary: {
      text: "Please review",
      kind: "task",
      source: "user",
      turnId: "t1",
      itemId: "u1",
    },
  });
  try {
    page.document.querySelector(".inspector-work-source").click();
    await pause();
    const source = page.document.querySelector(
      '[data-turn-id="t1"] [data-item-id="u1"]',
    );
    assert.ok(page.document.activeElement === source, "the source message has focus");
    assert.ok(page.scrollTargets.at(-1) === source, "the source message was scrolled to");
    assert.ok(source.classList.contains("source-highlight"));
    assert.equal(page.calls.filter((r) => r.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("agent settings suspend automatic reading until the closed dialog starts a fresh dwell", async () => {
  const page = await mount();
  try {
    page.document.querySelector('[aria-label="Agent settings"]').click();
    await pause();
    await pause();
    assert.ok(page.document.querySelector('[role="dialog"]'));
    const scroller = page.document.querySelector(".conversation-scroll");
    const end = page.document.querySelector(".read-end-marker");
    Object.defineProperty(page.document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(page.document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 700 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    scroller.getBoundingClientRect = () => ({
      top: 100,
      left: 100,
      bottom: 600,
      right: 800,
      width: 700,
      height: 500,
    });
    end.getBoundingClientRect = () => ({
      top: 598,
      left: 110,
      bottom: 599,
      right: 790,
      width: 680,
      height: 1,
    });
    page.window.dispatchEvent(new page.window.Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(page.calls.filter((r) => r.url.endsWith("/review")).length, 0);
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(page.calls.filter((r) => r.url.endsWith("/review")).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const reads = page.calls.filter((r) => r.url.endsWith("/review"));
    assert.equal(reads.length, 1);
    assert.deepEqual(JSON.parse(reads[0].init.body), { throughSeq: 12 });
    assert.equal(
      page.calls.filter((r) =>
        /\/settings$|\/responses$|\/interrupt$/.test(r.url),
      ).length,
      0,
    );
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

// Phones (T-170): the same queries the app reads, answered as a phone would.
const PHONE = "(max-width: 520px), (max-height: 500px) and (hover: none) and (pointer: coarse)";
function asPhone(window) {
  window.matchMedia = (media) => ({ media, matches: media === PHONE, addEventListener() {}, removeEventListener() {} });
}
const appClass = (page) => page.document.querySelector(".app").className;
const openAgent = (page, name) =>
  page.document.querySelector(`.agent-row .agent-select[aria-label="Open ${name}"]`).click();
/** Makes the conversation readable to useAutoRead, as the settings test does. */
function readable(page) {
  const scroller = page.document.querySelector(".conversation-scroll");
  const end = page.document.querySelector(".read-end-marker");
  Object.defineProperty(page.document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(page.document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 },
    clientWidth: { configurable: true, value: 700 },
    scrollHeight: { configurable: true, value: 500 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  scroller.getBoundingClientRect = () => ({ top: 100, left: 100, bottom: 600, right: 800, width: 700, height: 500 });
  end.getBoundingClientRect = () => ({ top: 598, left: 110, bottom: 599, right: 790, width: 680, height: 1 });
  page.window.dispatchEvent(new page.window.Event("focus"));
}

test("on a phone the Agent list and what is open are one screen each, and the way back keeps the conversation (T-170)", async () => {
  const page = await mount({ beforeLoad: asPhone, stored: { "yuzuno.selected": JSON.stringify("a") } });
  try {
    // It starts on the list; the conversation is there underneath, out of reach.
    assert.match(appClass(page), /\bphone\b.*\bphone-list\b/);
    assert.equal(page.document.querySelector(".main-panel").hasAttribute("inert"), true);
    assert.equal(page.document.querySelector(".rail").hasAttribute("inert"), false);
    assert.equal(button(page, "Agents"), undefined);
    readable(page);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(page.calls.filter((r) => r.url.endsWith("/review")).length, 0, "nothing is read while the list covers it");
    openAgent(page, "Mori");
    await pause();
    assert.doesNotMatch(appClass(page), /phone-list/);
    assert.equal(page.document.querySelector(".main-panel").hasAttribute("inert"), false);
    assert.equal(page.document.querySelector(".rail").hasAttribute("inert"), true);
    const back = button(page, "Agents");
    assert.equal(page.document.activeElement, back, "focus moves to the way back");
    readable(page);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(page.calls.filter((r) => r.url.endsWith("/review")).length, 1, "the open conversation is read as before");
    // A draft stays with its Agent across the list and another Agent.
    setValue(page.window, page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori's draft.");
    await pause();
    back.click();
    await pause();
    assert.match(appClass(page), /phone-list/);
    assert.equal(page.document.activeElement, page.document.querySelector('.agent-row.selected .agent-select'), "focus returns to the open Agent's row");
    assert.ok(page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "the conversation stays mounted under the list");
    openAgent(page, "Hana");
    await waitForPreviewState(() => page.document.querySelector('[data-composer-input][aria-label="Message Hana"]'), "Hana's conversation");
    assert.equal(composerText(page.document.querySelector('[data-composer-input][aria-label="Message Hana"]')), "");
    button(page, "Agents").click();
    await pause();
    openAgent(page, "Mori");
    await waitForPreviewState(() => page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori's conversation");
    assert.equal(composerText(page.document.querySelector('[data-composer-input][aria-label="Message Mori"]')), "Mori's draft.");
    assert.equal(savedDraftText(page.window.localStorage, "b") || "", "", "Mori's draft never lands in Hana's");
    // The context panel is a screen of its own over the conversation.
    assert.equal(page.document.querySelector(".inspector"), null);
    page.document.querySelector('[aria-label="Toggle context panel"]').click();
    await pause();
    assert.ok(page.document.querySelector(".inspector"));
    assert.match(appClass(page), /phone-inspector/);
    assert.equal(page.document.querySelector(".main-panel").hasAttribute("inert"), true);
    page.document.querySelector('[aria-label="Close context panel"]').click();
    await pause();
    assert.equal(page.document.querySelector(".inspector"), null);
    assert.equal(page.document.querySelector(".main-panel").hasAttribute("inert"), false);
    // Home opens from the toolbar whichever screen shows.
    button(page, "Agents").click();
    await pause();
    page.document.querySelector(".toolbar-nav .catchup-nav").click();
    await pause();
    assert.doesNotMatch(appClass(page), /phone-list/);
    assert.equal(page.document.querySelector(".toolbar-nav .catchup-nav").getAttribute("aria-current"), "page");
    assert.ok(button(page, "Agents"), "the way back to the list stays");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a sidebar hidden in a wide window still leaves the phone its Agent list, and comes back wide (T-170)", async () => {
  // One media query list per query, so the window can turn into a phone.
  let phone = false;
  const lists = new Map();
  const page = await mount({ beforeLoad(window) {
    window.matchMedia = (media) => {
      if (!lists.has(media)) {
        const listeners = new Set();
        lists.set(media, { listeners, list: {
          media, get matches() { return media === PHONE && phone; },
          addEventListener: (_, listener) => listeners.add(listener),
          removeEventListener: (_, listener) => listeners.delete(listener),
        } });
      }
      return lists.get(media).list;
    };
  } });
  try {
    page.document.querySelector('[aria-label="Hide agent sidebar"]').click();
    await pause();
    assert.match(appClass(page), /\brail-hidden\b/);
    phone = true;
    for (const listener of lists.get(PHONE)?.listeners || []) listener();
    await pause();
    assert.match(appClass(page), /\bphone\b.*\bphone-list\b/);
    assert.doesNotMatch(appClass(page), /rail-hidden/, "the phone list is not the wide sidebar");
    phone = false;
    for (const listener of lists.get(PHONE)?.listeners || []) listener();
    await pause();
    assert.match(appClass(page), /\brail-hidden\b/, "wide again, the sidebar stays as it was chosen");
  } finally {
    page.close();
  }
});

test("wider windows keep the side-by-side layout, with the context panel as it was (T-170)", async () => {
  const page = await mount();
  try {
    assert.doesNotMatch(appClass(page), /phone/);
    assert.equal(page.document.querySelector(".main-panel").hasAttribute("inert"), false);
    assert.equal(page.document.querySelector(".rail").hasAttribute("inert"), false);
    assert.equal(button(page, "Agents"), undefined);
    assert.ok(page.document.querySelector(".inspector"), "the context panel starts open, as before");
  } finally {
    page.close();
  }
});

test("offline Claude can resume despite stale in-progress history and keeps its draft on a failed response", async () => {
  const page = await mount({ harness: "claude", status: "offline", turnStatus: "inProgress", failMessageResponseOnce: true });
  try {
    const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
    setValue(page.window, composer, "Resume our native Claude session.");
    await pause();
    const send = page.document.querySelector('[aria-label="Send message"]');
    assert.equal(send.disabled, false);
    send.click();
    await pause(); await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/agents/a/messages");
    assert.equal(JSON.parse(posts[0].init.body).text, "Resume our native Claude session.");
    assert.match(page.document.body.textContent, /Response lost after acceptance/);
    assert.equal(composerText(composer), "Resume our native Claude session.");
    assert.equal(page.calls.some((r) => /\/turns$|\/models$|\/settings$/.test(r.url)), false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});


test("imported history labels the dock and pinned request as loaded turns", async () => {
  const page = await mount({ status: "working", history: { hasMore: true, nextCursor: "earlier", loadedCount: 1 } });
  try {
    assert.ok(page.document.querySelector('nav[aria-label="Loaded conversation turns"]'));
    assert.ok(page.document.querySelector('[data-turn-choice="t1"][aria-label="Loaded turn 1 · Working"]'));
    assert.ok(page.document.querySelector('summary[aria-label="Your request for loaded turn 1"]'));
    assert.match(page.document.querySelector(".turn-divider").textContent, /LOADED TURN 01/);
    assert.match(page.document.querySelector(".session-history-loader").textContent, /Load earlier turns/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

const pinnedQuestion = { id: "q-fixed", delivery: "async", questions: [{ title: "Choose the garden", options: ["Yuzu", "Sage"] }] };

test("known unanswered questions stay outside the scrolling stream across completed turns and do not steal focus", async () => {
  const extraTurns = Array.from({ length: 25 }, (_, i) => ({ id: `later-${i}`, status: "completed", items: [{ id: `log-${i}`, type: "agentMessage", text: "Later output ".repeat(200) }] }));
  const page = await mount({ status: "working", questionItem: pinnedQuestion, turnStatus: "completed", extraTurns });
  try {
    const dock = page.document.querySelector(".pending-questions");
    assert.match(dock.textContent, /Questions to answer · 1/);
    assert.equal(dock.closest(".conversation-scroll") === null, true);
    const composer = page.document.querySelector("[data-composer-input]");
    composer.focus();
    extraTurns.push({ id: "continued", status: "inProgress", items: [{ id: "more", type: "agentMessage", text: "Still working" }] });
    page.eventSources.at(-1).onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: "a" }) });
    for (let i = 0; i < 40 && !page.document.querySelector('[data-turn-id="continued"]'); i++) await pause();
    assert.equal(page.document.activeElement === composer, true);
    assert.ok(page.document.querySelector(".pending-questions"));
    assert.equal(page.document.querySelector(".async-question") === null, true);
    assert.equal(page.document.querySelector(".pending-card") === null, true);
    assert.equal(page.calls.filter(c => c.init.method === "POST" && /messages|turns|respond/.test(c.url)).length, 0);
  } finally { page.close(); }
});

test("the dock and original anchor use one answer draft across navigation, Agent changes and refresh", async () => {
  let page = await mount({ questionItem: pinnedQuestion });
  let stored;
  try {
    await openQuestion(page);
    answerValue(page, "Keep my exact answer 中文");
    await pause();
    button(page, "Original question").click();
    // Dialog teardown and source navigation can span rendering frames. Wait
    // for the promised focus target rather than assuming one 45 ms tick.
    for (let i = 0; i < 40 && page.document.activeElement?.dataset.itemId !== "q-fixed"; i++) await pause();
    assert.equal(page.document.querySelector(".async-question") === null, true);
    assert.equal(page.document.activeElement.dataset.itemId, "q-fixed");
    button(page, "View question and answer").click();
    await pause();
    assert.equal(page.document.querySelectorAll(".async-question").length, 1);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "Keep my exact answer 中文");
    page.document.querySelector('[aria-label="Close dialog"]').click();
    await pause();
    const row = [...page.document.querySelectorAll(".agent-row")].find(el => el.textContent.includes("Hana"));
    assert.ok(row); row.querySelector(".agent-select").click();
    for (let i = 0; i < 40 && page.document.querySelector(".question-dock-open"); i++) await pause();
    assert.equal(!!page.document.querySelector(".question-dock-open"), false);
    [...page.document.querySelectorAll(".agent-row")].find(el => el.textContent.includes("Mori")).querySelector(".agent-select").click();
    await pause(); await pause();
    await openQuestion(page);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "Keep my exact answer 中文");
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
    assert.equal(page.calls.filter(c => c.init.method === "POST" && /messages|turns/.test(c.url)).length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
  page = await mount({ questionItem: pinnedQuestion, stored });
  try {
    await openQuestion(page);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "Keep my exact answer 中文");
  } finally { page.close(); }
});

test("multiple questions keep separate answers by turn and item, including repeated item IDs", async () => {
  const page = await mount({ questionItem: pinnedQuestion, extraTurns: [{ id: "second-turn", status: "completed", items: [{ type: "agentMessage", ...pinnedQuestion, questions: [{ title: "Second choice" }] }] }] });
  try {
    await openQuestion(page); answerValue(page, "First answer"); await pause();
    page.document.querySelector('[aria-label="Close dialog"]').click(); await pause();
    page.document.querySelector('[aria-label="Next question"]').click(); await pause();
    await openQuestion(page); answerValue(page, "Second answer"); await pause();
    page.document.querySelector('[aria-label="Close dialog"]').click(); await pause();
    page.document.querySelector('[aria-label="Previous question"]').click(); await pause();
    await openQuestion(page);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "First answer");
    assert.match(page.document.querySelector(".pending-questions").textContent, /· 2/);
  } finally { page.close(); }
});

test("a rejected answer stays visible with its draft and an explicit retry submits only once", async () => {
  const receipts = [];
  let attempts = 0;
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const page = await mount({ questionItem: pinnedQuestion, receipts, messageResponse: async (url, init) => {
    const receipt = { agentId: "a", input: JSON.parse(init.body), status: ++attempts === 1 ? "rejected" : "accepted", error: attempts === 1 ? "Native fixture rejected this answer" : null, turnId: "t1" };
    if (attempts === 1) await firstResponse;
    receipts.push(receipt);
    return { ok: true, json: async () => receipt };
  } });
  try {
    await openQuestion(page); answerValue(page, "Keep through rejection"); await pause();
    button(page, "Send answer").click(); await pause(); await pause();
    assert.equal(attempts, 1);
    assert.match(page.document.querySelector(".pending-questions").textContent, /Sending/);
    assert.equal(page.document.querySelector(".async-question .primary-button").disabled, true);
    releaseFirst(); await pause(); await pause();
    assert.match(page.document.querySelector(".pending-questions").textContent, /Answer needs attention/);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "Keep through rejection");
    button(page, "Send answer").click(); button(page, "Send answer")?.click(); await pause(); await pause();
    assert.equal(attempts, 2);
    assert.equal(!!page.document.querySelector(".question-dock-open"), false);
    assert.equal(button(page, "Answer sent").disabled, true);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("lost answer delivery remains unconfirmed after refresh without resending and clears only on accepted evidence", async () => {
  let page = await mount({ questionItem: pinnedQuestion, messageResponse: async () => { throw new Error("Response lost"); } });
  let stored, input;
  try {
    await openQuestion(page); answerValue(page, "Never send twice"); await pause();
    button(page, "Send answer").click(); await pause(); await pause();
    assert.match(page.document.querySelector(".pending-questions").textContent, /Delivery unconfirmed/);
    assert.equal(page.document.querySelector(".async-question .primary-button").disabled, true);
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
    input = JSON.parse(page.calls.find(c => c.url.endsWith("/messages")).init.body);
  } finally { page.close(); }
  const receipts = [];
  page = await mount({ questionItem: pinnedQuestion, stored, receipts });
  try {
    assert.match(page.document.querySelector(".pending-questions").textContent, /Delivery unconfirmed/);
    await openQuestion(page);
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "Never send twice");
    assert.equal(page.document.querySelector(".async-question .primary-button").disabled, true);
    receipts.push({ agentId: "a", input, status: "accepted", turnId: "t1", error: null });
    button(page, "Check delivery").click();
    for (let i = 0; i < 40 && page.document.querySelector(".question-dock-open"); i++) await pause();
    assert.equal(!!page.document.querySelector(".question-dock-open"), false);
    assert.equal(page.calls.filter(c => c.init.method === "POST" && /messages|turns/.test(c.url)).length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a reconnect asks Core for the Agent only and the conversation stays as the windowed detail shows it", async () => {
  // As an older Core does, the reconnect answers with a whole record that
  // differs from what is shown: none of it is read, and the detail read
  // after it (the windowed one) is what the page shows.
  const page = await mount({
    collaboration: { ready: false, error: "Workspace MCP check failed; reconnect to verify." },
    agentFields: { connectionState: "connected", threadId: "thread" },
    extraTurns: [{ id: "finished", status: "completed", items: [
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Finished response." },
    ] }],
    beforeLoad(window) {
      const fetch = window.fetch;
      window.fetch = async (url, init) => {
        if (!url.includes("/reconnect")) return fetch(url, init);
        await fetch(url, init);
        const old = { agent: { id: "a", name: "From the answer", harness: "codex", status: "idle" }, turns: [], pending: [], artifacts: [] };
        return { ok: true, status: 200, json: async () => old, text: async () => JSON.stringify(old) };
      };
    },
  });
  try {
    const conversation = () => page.document.querySelector(".conversation")?.textContent || page.document.body.textContent;
    assert.match(conversation(), /Finished response\./);
    button(page, "Reconnect and check").click();
    const posted = () => page.calls.findIndex(c => c.init?.method === "POST" && c.url.includes("/reconnect"));
    await until(() => posted() >= 0 && page.calls.slice(posted() + 1).some(c => /\/api\/agents\/a$/.test(c.url)), "a detail read after the reconnect");
    await pause();
    assert.deepEqual(page.calls.filter(c => c.url.includes("/reconnect")).map(c => c.url.replace(/^.*\/api/, "/api")), ["/api/agents/a/reconnect?view=summary"]);
    assert.match(conversation(), /Finished response\./, "the conversation is still there");
    assert.match(conversation(), /A real-looking test reply\./);
    assert.doesNotMatch(page.document.body.textContent, /From the answer/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("read-only imported history questions stay distinct from Core-known pending questions", async () => {
  const page = await mount({ questionItem: pinnedQuestion, history: { hasMore: true, nextCursor: "older", loadedCount: 1 }, historyPage: { turns: [{ id: "older-turn", status: "completed", items: [{ type: "agentMessage", id: "historical-question", delivery: "async", questions: [{ title: "Old unconfirmed question" }] }] }], hasMore: false, nextCursor: null } });
  try {
    assert.match(page.document.querySelector(".session-history-loader").textContent, /Earlier history has not been checked/);
    assert.equal(page.calls.filter(c => c.url.includes("/history?")).length, 0);
    button(page, "Load earlier turns").click(); await pause(); await pause();
    assert.match(page.document.querySelector(".pending-questions").textContent, /· 1/);
    assert.match(page.document.querySelector('[data-item-id="historical-question"]').textContent, /Historical question · answer status unconfirmed/);
    button(page, "View historical question").click(); await pause();
    assert.equal(button(page, "Send answer") === undefined, true);
    answerValue(page, "My quoted reference"); await pause();
    button(page, "Add answer to draft").click(); await pause();
    assert.match(composerText(page.document.querySelector("[data-composer-input]")), /My quoted reference/);
    assert.match(page.document.querySelector(".pending-questions").textContent, /· 1/);
    assert.equal(page.calls.filter(c => c.init.method === "POST" && /messages|turns/.test(c.url)).length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});


test("earlier native turns are offered where the saved conversation starts and each load says what it added (T-161)", async () => {
  // A saved window that starts later: the native Turns come before the oldest
  // saved one, so loading them here would put them next to unrelated messages.
  const away = await mount({ history: { hasMore: true, nextCursor: "older", loadedCount: 3 }, beforeLoad(window) {
    const fetch = window.fetch;
    window.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!/\/api\/agents\/a$/.test(url)) return response;
      const body = await response.json();
      const conversation = { index: body.turns.map((turn, i) => ({ ...turn, number: i + 4, itemCount: turn.items.length })),
        questions: [], nativeClientIds: [], start: '["t1","u1"]', end: '["t1","r1"]', hasBefore: true, hasAfter: false, totalItems: 8 };
      return { ...response, json: async () => ({ ...body, conversation }) };
    };
  } });
  try {
    const loader = away.document.querySelector(".session-history-loader");
    assert.match(loader.textContent, /come before the start of the saved conversation/);
    assert.equal(button(away, "Load earlier turns"), undefined);
    assert.ok(button(away, "Load earlier messages"));
  } finally { away.close(); }
  const saved = { id: "t1", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "Please review." }] }] };
  const known = await mount({ history: { hasMore: true, nextCursor: "older", loadedCount: 3 },
    historyPage: { turns: [saved], hasMore: true, nextCursor: "older-still" } });
  try {
    button(known, "Load earlier turns").click(); await pause(); await pause();
    assert.equal(known.calls.filter(c => c.url.includes("/history?")).length, 1);
    assert.match(known.document.querySelector(".session-history-loader [role=status]").textContent,
      /no turns beyond the saved conversation/);
    assert.ok(button(known, "Load earlier turns"), "the next page can still be read");
  } finally { known.close(); }
  const turn = (id) => ({ id, status: "completed", items: [{ id: `${id}-reply`, type: "agentMessage", text: `Earlier ${id}` }] });
  const fresh = await mount({ history: { hasMore: true, nextCursor: "older", loadedCount: 3 },
    historyPage: { turns: [turn("t-old-1"), turn("t-old-2")], hasMore: false, nextCursor: null } });
  try {
    button(fresh, "Load earlier turns").click(); await pause(); await pause();
    const loader = fresh.document.querySelector(".session-history-loader");
    assert.match(loader.querySelector("[role=status]").textContent, /Loaded 2 earlier turns\./);
    assert.match(loader.textContent, /All saved turns are loaded|All earlier native history pages are loaded/);
    assert.match(fresh.document.querySelector(".conversation-scroll").textContent, /Earlier t-old-2/, "the earlier turns are shown");
  } finally { fresh.close(); }
});

test("accepted questions plus more history leave no question dock", async () => {
  const receipts = [{ agentId: "a", input: { clientMessageId: "done", text: "Yuzu", question: { turnId: "t1", itemId: pinnedQuestion.id } }, status: "accepted" }];
  const page = await mount({ questionItem: pinnedQuestion, receipts, history: { hasMore: true, nextCursor: "older", loadedCount: 1 } });
  try {
    assert.equal(!!page.document.querySelector(".pending-questions"), false);
    assert.match(page.document.querySelector(".session-history-loader").textContent, /Earlier history has not been checked/);
    assert.equal(page.calls.some(c => c.url.includes("/history?")), false);
  } finally { page.close(); }
});

test("dismissed questions stay hidden across Agent switches and refresh, and restore from their source with drafts intact", async () => {
  let page = await mount({ questionItem: pinnedQuestion });
  let stored;
  try {
    await openQuestion(page);
    answerValue(page, "保留问题草稿"); await pause();
    button(page, "Dismiss question").click(); await pause();
    assert.equal(!!page.document.querySelector(".pending-questions"), false);
    assert.match(page.document.querySelector('[role="dialog"]').textContent, /Dismissed in this browser/);
    page.document.querySelector('[aria-label="Close dialog"]').click(); await pause();
    for (const name of ["Hana", "Mori"]) {
      [...page.document.querySelectorAll(".agent-row")].find(el => el.textContent.includes(name)).querySelector(".agent-select").click();
      await pause(); await pause();
      assert.equal(!!page.document.querySelector(".pending-questions"), false);
    }
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
    assert.equal(page.calls.some(c => c.init.method === "POST" && /messages|turns|respond/.test(c.url)), false);
  } finally { page.close(); }
  page = await mount({ questionItem: pinnedQuestion, stored });
  try {
    assert.equal(!!page.document.querySelector(".pending-questions"), false);
    button(page, "View question and answer").click(); await pause();
    assert.equal(page.document.querySelector('.async-question input[type="text"]').value, "保留问题草稿");
    button(page, "Restore to questions").click(); await pause();
    assert.equal(!!page.document.querySelector(".pending-questions"), true);
    assert.equal(page.calls.some(c => c.init.method === "POST" && /messages|turns|respond/.test(c.url)), false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("proven pre-import questions do not auto-pin but keep original source, manual restoration and answering", async () => {
  const extraTurns = [{ id: "imported", status: "completed", _yuzunoImportedQuestions: true, items: [{ type: "agentMessage", ...pinnedQuestion }] }];
  let page = await mount({ extraTurns });
  let stored;
  try {
    assert.equal(!!page.document.querySelector(".pending-questions"), false);
    button(page, "View question and answer").click(); await pause();
    assert.match(page.document.querySelector('[role="dialog"]').textContent, /answer status unconfirmed/);
    answerValue(page, "Manually answer this old question"); await pause();
    assert.equal(button(page, "Send answer").disabled, false);
    button(page, "Restore to questions").click(); await pause();
    assert.equal(!!page.document.querySelector(".pending-questions"), true);
    stored = Object.fromEntries(Object.entries(page.window.localStorage));
    assert.equal(page.calls.some(c => c.init.method === "POST" && /messages|turns/.test(c.url)), false);
  } finally { page.close(); }
  page = await mount({ extraTurns, stored });
  try {
    assert.equal(!!page.document.querySelector(".pending-questions"), true);
    await openQuestion(page);
    button(page, "Send answer").click(); await pause(); await pause();
    const request = page.calls.find(c => c.init.method === "POST" && c.url.endsWith("/messages"));
    assert.deepEqual(JSON.parse(request.init.body).question, { turnId: "imported", itemId: pinnedQuestion.id });
    assert.equal(!!page.document.querySelector(".pending-questions"), false);
  } finally { page.close(); }
});

test("dismiss and restore do not authorize resending a terminal unknown answer", async () => {
  const receipts = [{ agentId: "a", input: { clientMessageId: "unknown", text: "Sage", question: { turnId: "t1", itemId: pinnedQuestion.id } }, status: "unknown" }];
  const page = await mount({ questionItem: pinnedQuestion, receipts });
  try {
    assert.match(page.document.querySelector(".pending-questions").textContent, /Delivery unconfirmed/);
    await openQuestion(page);
    button(page, "Dismiss question").click(); await pause();
    button(page, "Restore to questions").click(); await pause();
    assert.equal(page.document.querySelector(".async-question .primary-button").disabled, true);
    assert.equal(page.calls.some(c => c.init.method === "POST" && /messages|turns/.test(c.url)), false);
  } finally { page.close(); }
});


test("import provenance never hides an unconfirmed Yuzuno answer or permits its resend", async () => {
  const receipts = [{ agentId: "a", input: { clientMessageId: "import-unknown", text: "Sage", question: { turnId: "imported", itemId: pinnedQuestion.id } }, status: "unknown" }];
  const page = await mount({ receipts, extraTurns: [{ id: "imported", status: "completed", _yuzunoImportedQuestions: true, items: [{ type: "agentMessage", ...pinnedQuestion }] }] });
  try {
    assert.match(page.document.querySelector(".pending-questions").textContent, /Delivery unconfirmed/);
    await openQuestion(page);
    assert.equal(button(page, "Send answer") === undefined, true);
    button(page, "Dismiss question").click(); await pause();
    button(page, "Restore to questions").click(); await pause();
    assert.match(page.document.querySelector(".pending-questions").textContent, /Delivery unconfirmed/);
    assert.equal(page.calls.some(c => c.init.method === "POST" && /messages|turns/.test(c.url)), false);
  } finally { page.close(); }
});

test("an idle Agent with unfinished jobs shows Waiting · Job in the Agent list until its last job ends", async () => {
  // Mori (a) is working and has a job; Hana (b) is idle with two.
  let live = { agents: { a: { active: 1, unknown: 0 }, b: { active: 2, unknown: 0 } } };
  const page = await mount({ status: "working", liveJobs: () => live });
  const runtime = (id) =>
    page.document.querySelector(`[data-agent-id="${id}"] .agent-runtime`)?.textContent;
  const liveReads = () => page.calls.filter((c) => c.url.endsWith("/api/jobs/live")).length;
  const title = (id) => page.document.querySelector(`[data-agent-id="${id}"] .agent-select`)?.title || "";
  // A jobs change makes the app read live jobs again; wait for that read,
  // then for what it should show.
  const jobsChanged = async (shows, what) => {
    const reads = liveReads();
    page.eventSources.at(-1).onmessage?.({
      data: JSON.stringify({ type: "workspace.changed", scope: "jobs" }),
    });
    await waitForPreviewState(() => liveReads() > reads, "live jobs to be read again");
    await waitForPreviewState(shows, what);
  };
  try {
    for (let n = 0; n < 40 && runtime("b") !== "Waiting · Job"; n++) await pause();
    assert.equal(runtime("b"), "Waiting · Job");
    assert.equal(runtime("a"), "Working", "a running Agent stays Working");
    assert.match(
      page.document.querySelector('[data-agent-id="b"] .agent-select').title,
      /2 jobs queued or running/,
    );
    // One of two finished: still waiting.
    live = { agents: { b: { active: 1, unknown: 0 } } };
    await jobsChanged(() => /\b1 job queued or running/.test(title("b")), "one job left");
    assert.equal(runtime("b"), "Waiting · Job");
    // Only a job whose outcome is unknown remains: not called running.
    live = { agents: { b: { active: 1, unknown: 1 } } };
    await jobsChanged(() => runtime("b") === "Check job", "Check job");
    assert.equal(runtime("b"), "Check job");
    // The last one ended.
    live = { agents: {} };
    await jobsChanged(() => runtime("b") === "Ready", "Ready");
    assert.equal(runtime("b"), "Ready");
    assert.ok(page.calls.every((c) => !c.url.includes("/api/jobs/live") || !c.init.method || c.init.method === "GET"));
  } finally {
    page.close();
  }
});

test("CI rail refreshes on Jobs, collaboration closure and reconnect, without reloading conversations", async () => {
  let ci={agents:{b:{running:1,discovering:0,check:0}}};
  const page=await mount({status:"working",liveCI:()=>ci});
  const runtime=id=>page.document.querySelector(`[data-agent-id="${id}"] .agent-runtime`)?.textContent;
  const reads=()=>page.calls.filter(c=>c.url.endsWith("/api/ci/live")).length;
  try {
    await until(()=>runtime("b")==="Waiting · CI","idle CI visible");
    assert.equal(runtime("a"),"Working");
    const before=page.calls.filter(c=>/\/api\/agents\/[^/]+$/.test(c.url)).length;
    ci={agents:{}};
    page.eventSources.at(-1).onmessage?.({data:JSON.stringify({type:"workspace.changed",scope:"jobs"})});
    await until(()=>runtime("b")==="Ready","completion event clears waiting");
    assert.equal(page.calls.filter(c=>/\/api\/agents\/[^/]+$/.test(c.url)).length,before,"CI event does not refetch conversation");
    ci={agents:{b:{running:0,discovering:1,check:0}}};
    const n=reads();page.eventSources.at(-1).onopen?.();
    await until(()=>reads()>n&&runtime("b")==="Waiting · CI","reconnect refreshes counts");
    ci={agents:{}};
    page.eventSources.at(-1).onmessage?.({data:JSON.stringify({type:"workspace.changed",scope:"collaboration"})});
    await until(()=>runtime("b")==="Ready","task done or delivery stop clears waiting immediately");
    assert.equal(page.calls.filter(c=>/\/api\/agents\/[^/]+$/.test(c.url)).length,before,"collaboration closure does not refetch conversation");
    assert.ok(page.calls.every(c=>!c.url.includes("/api/ci/refresh")),"no GitHub refresh");
  }finally{page.close();}
});

test("a sub-agent's approvals show which sub-agent asks and what it would change, and answer only it", async () => {
  const child = "11111111-1111-4111-8111-111111111111";
  const page = await mount({ status: "waiting", pending: [
    { id: "child-command", agentId: "a", method: "item/commandExecution/requestApproval", createdAt: "",
      params: { threadId: child, turnId: "turn-alpha", itemId: "exec-1", command: "/bin/zsh -lc 'touch alpha.txt'",
        availableDecisions: ["accept", "cancel"], _rpcId: 0, _runtimeGeneration: 1,
        _subAgent: { threadId: child, path: "/root/alpha" } } },
    { id: "child-edit", agentId: "a", method: "item/fileChange/requestApproval", createdAt: "",
      params: { threadId: child, turnId: "turn-alpha", itemId: "edit-1", _rpcId: 1, _runtimeGeneration: 1,
        _subAgent: { threadId: child, path: "/root/alpha" },
        _changes: { changes: [{ path: "/work/alpha.md", kind: { type: "add" }, diff: "+alpha", truncated: false }], omitted: 0 } } },
    { id: "own-edit", agentId: "a", method: "item/fileChange/requestApproval", createdAt: "",
      params: { itemId: "own-edit-item", _rpcId: 2, _runtimeGeneration: 1 } },
  ] });
  try {
    const card = (id) => page.document.getElementById(`request-${id}`);
    assert.match(card("child-command").querySelector(".pending-source").textContent, /From sub-agent \/root\/alpha/);
    assert.match(card("child-command").textContent, /touch alpha\.txt/);
    assert.ok([...card("child-command").querySelectorAll("button")].some((b) => b.textContent === "Cancel sub-agent’s turn"));
    // The child's proposed change is on its card; the parent's link would find nothing.
    assert.match(card("child-edit").textContent, /add · \/work\/alpha\.md/);
    assert.match(card("child-edit").querySelector("pre").textContent, /\+alpha/);
    assert.ok([...card("child-edit").querySelectorAll("button")].every((b) => !b.textContent.includes("View proposed changes")));
    // The parent's own request is unchanged.
    assert.ok(card("own-edit").querySelector(".pending-source") === null, "no sub-agent line on the parent's request");
    assert.ok([...card("own-edit").querySelectorAll("button")].some((b) => b.textContent.includes("View proposed changes")));
    assert.ok([...card("own-edit").querySelectorAll("button")].some((b) => b.textContent === "Cancel turn"));
    // Internal routing fields stay out of the request details.
    assert.doesNotMatch(card("child-command").querySelector(".request-details pre").textContent, /_subAgent|_rpcId/);
    [...card("child-command").querySelectorAll("button")].find((b) => b.textContent === "Allow once").click();
    await pause();
    const replies = page.calls.filter((c) => c.url.includes("/respond"));
    assert.equal(replies.length, 1);
    assert.ok(replies[0].url.endsWith("/api/requests/child-command/respond"));
    assert.deepEqual(JSON.parse(replies[0].init.body), { response: { decision: "accept" } });
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

// Send to Agent (T-152): a stand-in DataTransfer, since JSDOM has none.
function dragData() {
  const data = new Map();
  return {
    types: [],
    dropEffect: "none",
    effectAllowed: "uninitialized",
    setData(type, value) {
      data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData: (type) => data.get(type) ?? "",
  };
}
function fireDrag(page, target, type, dataTransfer) {
  const event = new page.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}
const railRow = (page, id) => page.document.querySelector(`article.agent-row[data-agent-id="${id}"]`);
const handoffDraft = (page, name) =>
  until(() => page.document.querySelector(`[data-composer-input][aria-label="Message ${name}"]`), `${name}'s composer opens`);
const hanaNote = JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "Hana's own note." }] });

test("Send to Agent adds a reply after another Agent's existing draft and opens it, without sending or dispatching", async () => {
  const page = await mount({ stored: { "yuzuno.composer.v1:b": hanaNote } });
  try {
    const send = await until(() => page.document.querySelector(".final-message .send-to-agent-button"), "the reply offers Send to Agent");
    send.click();
    await pause();
    const items = [...page.document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    // Its own Agent is not offered.
    assert.deepEqual(items.map((item) => item.querySelector(".send-to-agent-name")?.textContent), ["Hana"]);
    assert.ok(page.document.activeElement === items[0], "the first Agent has focus");
    items[0].click();
    const composer = await handoffDraft(page, "Hana");
    await pause();
    const text = composerText(composer);
    assert.ok(text.startsWith("Hana's own note.\n\nForwarded from Mori’s conversation: Mori’s reply"), text);
    assert.ok(text.includes("Mori wrote it; I am passing it on."), text);
    assert.ok(text.endsWith("> A real-looking test reply."), text);
    assert.equal(savedDraftText(page.window.localStorage, "b"), text);
    assert.match(page.document.querySelector(".toast").textContent, /Added a message from Mori’s conversation to Hana’s draft\. Edit it, then send\./);
    assert.equal(page.calls.filter((call) => call.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a reply dragged onto an Agent in the rail lands in its draft; its own Agent, outside text and a cancelled drag change nothing", async () => {
  const page = await mount();
  try {
    const send = await until(() => page.document.querySelector(".final-message .send-to-agent-button"), "the reply offers Send to Agent");
    // Text from outside Yuzuno is not a handoff: no row takes it.
    const outside = dragData();
    outside.setData("text/plain", "outside text");
    assert.equal(fireDrag(page, railRow(page, "b"), "dragover", outside).defaultPrevented, false);
    await pause();
    assert.ok(!railRow(page, "b").className.includes("handoff"));
    // The type alone proves nothing: a drag this window did not start is not
    // taken, nor is one whose content changed on the way.
    const forged = dragData();
    forged.setData("application/x-yuzuno-handoff", JSON.stringify({ kind: "task", taskId: "T-9", title: "forged", status: "todo", assignee: null, version: 1, summary: "" }));
    assert.equal(fireDrag(page, railRow(page, "b"), "dragover", forged).defaultPrevented, false);
    assert.equal(fireDrag(page, railRow(page, "b"), "drop", forged).defaultPrevented, false);
    const started = dragData();
    fireDrag(page, send, "dragstart", started);
    assert.equal(fireDrag(page, railRow(page, "b"), "drop", forged).defaultPrevented, false);
    fireDrag(page, send, "dragend", started);
    await pause();
    assert.equal(savedDraftText(page.window.localStorage, "b"), "");
    assert.ok(page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori stays open");
    // A drag let go nowhere (Escape, or outside) leaves no highlight and no draft.
    const cancelled = dragData();
    fireDrag(page, send, "dragstart", cancelled);
    fireDrag(page, railRow(page, "b"), "dragover", cancelled);
    await pause();
    assert.ok(railRow(page, "b").classList.contains("handoff-accept"));
    fireDrag(page, send, "dragend", cancelled);
    await pause();
    assert.ok(!railRow(page, "b").className.includes("handoff"));
    assert.equal(savedDraftText(page.window.localStorage, "b"), "");

    const drag = dragData();
    fireDrag(page, send, "dragstart", drag);
    assert.deepEqual(drag.types, ["application/x-yuzuno-handoff"]);
    await pause();
    // The rail is in view: the dialogs' drop strip is not shown.
    assert.equal(page.document.querySelector(".handoff-strip"), null);
    // Its own Agent refuses it and says why.
    assert.equal(fireDrag(page, railRow(page, "a"), "dragover", drag).defaultPrevented, false);
    await pause();
    assert.ok(railRow(page, "a").classList.contains("handoff-refuse"));
    assert.match(railRow(page, "a").querySelector(".handoff-hint").textContent, /already comes from Mori’s conversation/);
    fireDrag(page, railRow(page, "a"), "dragleave", drag);
    assert.equal(fireDrag(page, railRow(page, "b"), "dragover", drag).defaultPrevented, true);
    await pause();
    assert.ok(railRow(page, "b").classList.contains("handoff-accept"));
    assert.match(railRow(page, "b").querySelector(".handoff-hint").textContent, /Drop to add it to Hana’s draft/);
    fireDrag(page, railRow(page, "b"), "drop", drag);
    const composer = await handoffDraft(page, "Hana");
    await pause();
    assert.match(composerText(composer), /^Forwarded from Mori’s conversation: Mori’s reply/);
    assert.ok(!railRow(page, "b").className.includes("handoff"));
    assert.equal(page.calls.filter((call) => call.init.method === "POST").length, 0);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("selected text dragged out of a reply keeps the browser's text and lands as a sourced excerpt", async () => {
  const page = await mount();
  try {
    const reply = await until(() => page.document.querySelector(".final-message .prose"), "the reply is shown");
    const walker = page.document.createTreeWalker(reply, page.window.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes("real-looking")) node = walker.nextNode();
    const range = page.document.createRange();
    const start = node.textContent.indexOf("real-looking");
    range.setStart(node, start);
    range.setEnd(node, start + "real-looking".length);
    const selection = page.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const drag = dragData();
    drag.setData("text/plain", "real-looking");
    fireDrag(page, node.parentElement, "dragstart", drag);
    assert.equal(drag.getData("text/plain"), "real-looking");
    const source = JSON.parse(drag.getData("application/x-yuzuno-handoff"));
    assert.deepEqual([source.kind, source.agentName, source.author.kind, source.text, source.excerpt], ["message", "Mori", "agent", "real-looking", true]);
    fireDrag(page, railRow(page, "b"), "dragover", drag);
    fireDrag(page, railRow(page, "b"), "drop", drag);
    const composer = await handoffDraft(page, "Hana");
    await pause();
    assert.match(composerText(composer), /: an excerpt of Mori’s reply[^]*\n\n> real-looking$/);
    assert.equal(page.calls.filter((call) => call.init.method === "POST").length, 0);
  } finally { page.close(); }
});

test("the Send to Agent menu closes on Escape with nothing added, and a damaged draft is never overwritten", async () => {
  const page = await mount({ stored: { "yuzuno.composer.v1:b": "{damaged" } });
  try {
    const send = await until(() => page.document.querySelector(".final-message .send-to-agent-button"), "the reply offers Send to Agent");
    send.click();
    await pause();
    const menu = page.document.querySelector('[role="menu"]');
    menu.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await pause();
    assert.ok(!page.document.querySelector('[role="menu"]'), "the menu closed");
    assert.ok(page.document.activeElement === send, "focus returns to the button");
    send.click();
    await pause();
    page.document.querySelector('[role="menu"] [role="menuitem"]').click();
    await pause();
    assert.match(page.document.querySelector(".toast").textContent, /Hana’s saved draft needs recovering first; nothing was added/);
    assert.equal(page.window.localStorage.getItem("yuzuno.composer.v1:b"), "{damaged");
    assert.ok(page.document.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori stays open");
    assert.equal(page.calls.filter((call) => call.init.method === "POST").length, 0);
  } finally { page.close(); }
});

// T-29: "/model" and a Codex "/compact" typed in the composer are Yuzuno
// controls run on Send, never prompts; anything else is a message as before.
async function sendDraft(page, text) {
  const composer = page.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
  setValue(page.window, composer, text);
  // A kept draft leaves Send enabled: let the App take the new text first.
  await pause();
  await until(() => page.document.querySelector('[aria-label="Send message"]')?.disabled === false, "Send to accept the draft");
  page.document.querySelector('[aria-label="Send message"]').click();
  await pause();
  await pause();
  return composer;
}
const posts = (page) => page.calls.filter((r) => r.init.method === "POST").map((r) => r.url);

test("a Codex Agent's /compact asks Codex itself to compact and is never sent as a message", async () => {
  const page = await mount({ harness: "codex" });
  try {
    const composer = await sendDraft(page, "/compact");
    assert.deepEqual(posts(page), ["/api/agents/a/compact"]);
    assert.equal(composerText(composer), "", "the handled command leaves the draft");
    assert.match(page.document.body.textContent, /Codex accepted \/compact/);
    // Instructions are not something Codex's compaction takes: nothing is sent, the draft stays.
    await sendDraft(page, "/compact keep the API notes");
    assert.deepEqual(posts(page), ["/api/agents/a/compact"]);
    assert.equal(composerText(composer), "/compact keep the API notes");
    assert.match(page.document.body.textContent, /takes no instructions/);
    // A slash later in the text is a message as before.
    await sendDraft(page, "please run /compact later");
    assert.deepEqual(posts(page), ["/api/agents/a/compact", "/api/agents/a/messages"]);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("when Codex refuses /compact, the reason shows and the draft is kept", async () => {
  const page = await mount({
    harness: "codex",
    compactResponse: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: "当前 Turn 尚未结束或正在等待回应；没有执行 /compact" }) }),
  });
  try {
    const composer = await sendDraft(page, "/compact");
    assert.deepEqual(posts(page), ["/api/agents/a/compact"]);
    assert.equal(composerText(composer), "/compact");
    assert.match(page.document.body.textContent, /没有执行 \/compact/);
  } finally { page.close(); }
});

test("/model opens this Agent's settings with that model chosen, and sends nothing", async () => {
  const page = await mount({
    harness: "codex",
    models: [
      { id: "test-model", model: "test-model", displayName: "Test model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] },
      { id: "other-model", model: "other-model", displayName: "Other model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] },
    ],
  });
  try {
    const composer = await sendDraft(page, "/model other-model");
    await until(() => chipGroup(page, "Model"), "the settings dialog to open");
    await until(() => chosen(page, "Model") === "other-model", "the named model to be chosen");
    assert.deepEqual(posts(page), [], "nothing is sent or saved until the user saves");
    assert.equal(composerText(composer), "/model other-model", "the draft stays");
    assert.match(page.document.body.textContent, /applies from this Agent's next turn/);
  } finally { page.close(); }
});

test("a Claude Agent's /compact is Claude Code's own command and goes as a message", async () => {
  const page = await mount({ harness: "claude" });
  try {
    await sendDraft(page, "/compact");
    assert.deepEqual(posts(page), ["/api/agents/a/messages"]);
    const sent = JSON.parse(page.calls.find((r) => r.url.endsWith("/messages")).init.body);
    assert.equal(sent.text, "/compact");
  } finally { page.close(); }
});

// R1 P2: /model chooses a model exactly as its chip does; only Save keeps it.
async function modelSwitch(mountOptions, target, how, read) {
  const page = await mount(mountOptions);
  try {
    if (how === "chip") {
      page.document.querySelector('[aria-label="Agent settings"]').click();
      await until(() => chipGroup(page, "Model")?.querySelector(`input[value="${target}"]`), "the catalog");
      await choose(page, "Model", target);
    } else {
      await sendDraft(page, `/model ${target}`);
    }
    await until(() => chipGroup(page, "Model") && chosen(page, "Model") === target, `${target} chosen via ${how}`);
    const state = read(page);
    const before = page.calls.filter((r) => r.init.method === "POST").length;
    saveButton(page).click();
    await pause(); await pause();
    const posts = page.calls.filter((r) => r.init.method === "POST");
    return { state, savedBefore: before, saved: JSON.parse(posts.at(-1).init.body) };
  } finally { page.close(); }
}

test("Codex: /model resets effort and context overrides exactly as the model chip does", async () => {
  const models = [
    { id: "test-model", model: "test-model", displayName: "Test model", defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "More" }] },
    { id: "other-model", model: "other-model", displayName: "Other model", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }] },
  ];
  const options = () => ({ harness: "codex", models,
    settings: { reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write", contextWindow: 872000, autoCompactTokenLimit: 600000 },
    contextSettings: { supported: true, settingsSubmitted: true, canApply: true } });
  const read = (page) => ({
    effort: chosen(page, "Reasoning effort"),
    window: page.document.querySelector('[aria-label="Context window tokens"]').value,
    compact: page.document.querySelector('[aria-label="Auto-compaction threshold"]').value,
    reset: /Context overrides reset to automatic/.test(page.document.querySelector('[role="dialog"]').textContent),
  });
  const chip = await modelSwitch(options(), "other-model", "chip", read);
  const command = await modelSwitch(options(), "other-model", "command", read);
  assert.deepEqual(command, chip);
  assert.deepEqual(chip.state, { effort: "medium", window: "", compact: "", reset: true });
  assert.equal(chip.savedBefore, 0, "nothing is saved before Save");
  assert.equal(chip.saved.model, "other-model");
  assert.equal(chip.saved.settings.reasoningEffort, "medium", "the new model's own default, not the old one's");
  assert.equal(chip.saved.settings.contextWindow, null);
  assert.equal(chip.saved.settings.autoCompactTokenLimit, null);
});

test("Claude: /model drops an effort the new model lacks exactly as the model chip does", async () => {
  const options = () => ({ harness: "claude", agentFields: { model: "opus" }, models: claudeModels,
    settings: { reasoningEffort: "max", approvalPolicy: "on-request", sandbox: "workspace-write", permissionMode: "default" } });
  const read = (page) => ({
    effort: chosen(page, "Reasoning effort"),
    note: /Sonnet does not take reasoning effort max; it is back to Claude Code default\./.test(page.document.querySelector('[role="dialog"]').textContent),
  });
  const chip = await modelSwitch(options(), "sonnet", "chip", read);
  const command = await modelSwitch(options(), "sonnet", "command", read);
  assert.deepEqual(command, chip);
  assert.deepEqual(chip.state, { effort: "", note: true });
  assert.equal(chip.savedBefore, 0);
  assert.equal(chip.saved.model, "sonnet");
});

test("an OpenCode Agent at work takes no message into its turn and shows OpenCode's own facts", async () => {
  const page = await mount({ harness: "opencode", status: "working", agentFields: { opencodeSessionId: "ses_0123456789" } });
  try {
    setValue(page.window, page.document.querySelector("[data-composer-input]"), "One more thing");
    await pause();
    const send = page.document.querySelector('[aria-label="Send message"]');
    assert.equal(send?.disabled, true, "OpenCode takes no message into a running turn");
    assert.equal(send.title, "Wait for this turn to finish, or interrupt");
    assert.equal(page.document.querySelector('[aria-label="Send while working"]'), null);
    assert.equal(page.document.querySelector('[aria-label="Agent settings"]'), null, "its model and permissions are OpenCode's own");
    const fact = (name) => [...page.document.querySelectorAll("dt")].find((dt) => dt.textContent === name)?.nextElementSibling?.textContent.trim();
    assert.equal(fact("Harness"), "OpenCode");
    assert.equal(fact("Session"), "ses_0123");
    assert.equal(page.calls.some((call) => /codex\/usage/.test(call.url)), false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
