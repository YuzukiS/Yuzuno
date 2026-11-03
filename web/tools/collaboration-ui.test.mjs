import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// An in-memory component bundle: no live Core, browsers, or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "collaboration-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CollaborationBoard} from ${JSON.stringify(path.join(root, "src/CollaborationBoard.tsx"))};
import {Turn, turnText} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderBoard=(props)=>root.render(<CollaborationBoard {...props}/>);
window.renderTurn=(props)=>root.render(<Turn {...props}/>);
window.copyTurn=turnText;`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "CollaborationUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, description) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
const user = { kind: "user", id: "user", name: "You" };
const agents = [
  {
    id: "dev-1",
    name: "Dev 1",
    harness: "codex",
    color: "sage",
    status: "idle",
    cwd: "/work",
    goal: "",
    model: "",
    createdAt: "2026-10-12T12:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
    unreadCount: 0,
    pendingCount: 0,
    lastSeq: 0,
    reviewedSeq: 0,
  },
  {
    id: "dev-2",
    name: "Dev 2",
    harness: "claude",
    color: "yuzu",
    status: "offline",
    cwd: "/work",
    goal: "",
    model: "",
    createdAt: "2026-10-12T12:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
    unreadCount: 0,
    pendingCount: 0,
    lastSeq: 0,
    reviewedSeq: 0,
  },
];
function task(patch = {}) {
  return {
    id: "T-1",
    title: "File preview opens at the right line",
    description: "Preview the requested line and explain invalid positions.",
    status: "doing",
    assigneeAgentId: "dev-1",
    assignee: { kind: "agent", id: "dev-1", name: "Dev 1" },
    progress: "",
    blocker: "",
    result: null,
    version: 1,
    createdBy: user,
    updatedBy: user,
    createdAt: "2026-10-12T12:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
    ...patch,
  };
}
function mount(handler) {
  const calls = [],
    errors = [],
    sourceCalls = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://isolated.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole: console,
    },
  );
  const { window } = dom;
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const operation = url.split("/").at(-1);
    calls.push({ operation, body, method: init.method || "GET" });
    const response = await handler(operation, body);
    const status = response?.httpStatus || 200;
    const data = response?.httpStatus ? { error: response.error } : response;
    return {
      ok: status < 400,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    };
  };
  window.eval(bundle);
  const props = {
    open: true,
    onOpenChange() {},
    agents,
    initialAgentId: "dev-1",
    onOpenAgent: (...args) => sourceCalls.push(args),
  };
  return {
    window,
    document: window.document,
    calls,
    errors,
    sourceCalls,
    render: (extra) => window.renderBoard({ ...props, ...extra }),
    close: () => window.close(),
  };
}
function button(page, text) {
  return [...page.document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
}
function field(page, label) {
  return [...page.document.querySelectorAll("label")]
    .find((node) =>
      node.querySelector("span")?.textContent.trim().startsWith(label),
    )
    ?.querySelector("input,textarea,select");
}
async function value(page, element, text) {
  assert.ok(element, `input exists for ${text}`);
  const prototype =
    element.tagName === "TEXTAREA"
      ? page.window.HTMLTextAreaElement.prototype
      : element.tagName === "SELECT"
        ? page.window.HTMLSelectElement.prototype
        : page.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
  element.dispatchEvent(
    new page.window.Event(element.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await tick();
}
function click(page, text) {
  const node = button(page, text);
  assert.ok(node, `button ${text} exists`);
  node.click();
}

test("a lost create response keeps the draft and retries the same request ID", async () => {
  let attempts = 0;
  const page = mount((operation) => {
    if (operation === "task_list") return { tasks: [], hasMore: false };
    if (operation === "task_create") {
      attempts++;
      return { httpStatus: 503, error: "Connection ended before confirmation" };
    }
    throw new Error(operation);
  });
  try {
    page.render();
    await tick();
    click(page, "New task");
    await tick();
    await value(page, field(page, "Task title"), "Claude model dropdown");
    click(page, "Create task");
    await tick();
    assert.equal(field(page, "Task title").value, "Claude model dropdown");
    assert.match(
      page.document.body.textContent,
      /Connection ended before confirmation/,
    );
    click(page, "Create task");
    await tick();
    const writes = page.calls.filter(
      (call) => call.operation === "task_create",
    );
    assert.equal(attempts, 2);
    assert.equal(writes[0].body.requestId, writes[1].body.requestId);
    assert.equal(writes[0].body.title, "Claude model dropdown");
    assert.equal("sender" in writes[0].body, false);
  } finally {
    page.close();
  }
});

test("a background task update preserves drafts and the version the edit was based on", async () => {
  let current = task();
  const page = mount((operation) => {
    if (operation === "task_list") return { tasks: [current], hasMore: false };
    if (operation === "task_get")
      return { task: current, activities: [], executions: [], hasMore: false };
    if (operation === "task_update")
      return { httpStatus: 409, error: "Task has changed; refresh to compare" };
    throw new Error(operation);
  });
  try {
    page.render();
    (await waitFor(() => page.document.querySelector(".collab-task-card"), "task card")).click();
    await tick();
    click(page, "Edit task");
    await tick();
    await value(page, field(page, "Task title"), "Preview line links clearly");
    current = task({
      version: 2,
      progress: "Another agent is checking the bounds",
    });
    page.document.querySelector('[aria-label="Refresh task details"]').click();
    await tick();
    assert.equal(field(page, "Task title").value, "Preview line links clearly");
    click(page, "Save changes");
    await tick();
    const write = page.calls.find(
      (call) => call.operation === "task_update",
    ).body;
    assert.equal(write.expectedVersion, 1);
    assert.deepEqual(write.patch, { title: "Preview line links clearly" });
    assert.equal(field(page, "Task title").value, "Preview line links clearly");
    assert.match(page.document.body.textContent, /Your draft is kept/);
  } finally {
    page.close();
  }
});

test("results have safe links and lead back to their exact native turn", async () => {
  const current = task({
    result: {
      summary: "Line links now work",
      links: [
        { label: "Report", url: "https://example.com/report" },
        { label: "Untrusted action", url: "javascript:alert(1)" },
      ],
      reportedBy: { kind: "agent", id: "dev-1", name: "Dev 1" },
      source: { agentId: "dev-1", turnId: "native-turn-3" },
    },
  });
  const page = mount((operation) =>
    operation === "task_list"
      ? { tasks: [current], hasMore: false }
      : { task: current, activities: [], executions: [], hasMore: false },
  );
  try {
    page.render();
    (await waitFor(() => page.document.querySelector(".collab-task-card"), "task with result")).click();
    await waitFor(() => page.document.querySelector('a[href="https://example.com/report"]'), "loaded result links");
    assert.ok(page.document.querySelector('a[href^="javascript:"]') === null, 'a[href^="javascript:"] is absent');
    assert.ok(
      page.document.querySelector('a[href="https://example.com/report"]'),
    );
    click(page, "View original conversation");
    await tick();
    assert.deepEqual(page.sourceCalls, [["dev-1", "native-turn-3"]]);
  } finally {
    page.close();
  }
});

test("Messages is an observation view with a canonical task link and no user messaging controls", async () => {
  const message = {
    id: "mail-1",
    seq: 1,
    sender: { kind: "agent", id: "dev-2", name: "Dev 2" },
    recipient: { kind: "agent", id: "dev-1", name: "Dev 1" },
    body: "The bounds check is ready for review.",
    taskId: "T-1",
    replyTo: null,
    threadId: "mail-1",
    createdAt: "2026-10-12T12:00:00Z",
    firstReadAt: null,
    delivery: { state: "pending", detail: {} },
  };
  const page = mount((operation) => {
    if (operation === "workspaces") return { taskId: "T-1", repositories: [], workspaces: [] };
    if (operation === "task_list") return { tasks: [task()], hasMore: false };
    if (operation === "peer_read")
      return { messages: [message], hasMore: false };
    if (operation === "task_get")
      return { task: task(), activities: [], executions: [], hasMore: false };
    if (operation === "github_links" || operation === "github_refresh")
      return { links: [], repositories: [] };
    if (operation === "delivery_get")
      return { flow: null, settings: { harness: "codex", model: "gpt-6.1-sol" } };
    if (operation === "peers_list") return { peers: [] };
    if (operation === "pr-reviews?taskId=T-1")
      return { reviews: [], hasMore: false, nextBefore: null };
    if (operation === "pr-operations?taskId=T-1")
      return { operations: [], repositories: [], hasMore: false, nextBefore: null };
    throw new Error(operation);
  });
  try {
    page.render();
    await tick();
    click(page, "Messages");
    await tick();
    assert.equal(
      page.calls.find((call) => call.operation === "peer_read").body.agentId,
      undefined,
      "the observation view starts with all agents",
    );
    assert.match(page.document.body.textContent, /Waiting in mailbox/);
    assert.doesNotMatch(page.document.body.textContent, /Fetched by recipient/);
    const panel = page.document.getElementById("collab-messages");
    assert.ok(panel.querySelector("form,textarea,input,.collab-message-compose") === null, "form,textarea,input,.collab-message-compose is absent");
    for (const label of ["Reply as you", "Follow up", "Send message"])
      assert.ok(button(page, label) === undefined, `no "${label}" button`);
    assert.equal(
      panel.querySelectorAll("select").length,
      1,
      "only the observation mailbox filter remains",
    );
    const link = panel.querySelector('[aria-label="View task T-1"]');
    assert.equal(link.textContent.trim(), "T-1");
    link.click();
    await tick();
    assert.equal(
      page.calls.find((call) => call.operation === "task_get").body.taskId,
      "T-1",
    );
    assert.equal(
      (
        await waitFor(
          () =>
            page.document.querySelector(
              '.collab-task-card[data-task-id="T-1"] .collab-task-id',
            ),
          "task list after the link",
        )
      ).textContent,
      "T-1",
    );
    assert.equal(
      page.document.querySelector(".collab-detail .collab-task-id").textContent,
      "T-1",
    );
    assert.ok(
      button(page, "Give to agent"),
      "task delegation remains available",
    );
    assert.ok(field(page, "Add a note"), "task discussion remains available");
    const readMethods = {
      task_list: "POST", peer_read: "POST", task_get: "POST",
      github_links: "POST", github_refresh: "POST", delivery_get: "POST",
      peers_list: "POST", "pr-reviews?taskId=T-1": "GET",
      "pr-operations?taskId=T-1": "GET", workspaces: "GET",
    };
    assert.deepEqual(
      page.calls.filter(call => readMethods[call.operation] !== call.method),
      [],
      "opening the task reads evidence without starting delivery, review or PR operations",
    );
  } finally {
    page.close();
  }
});

test("task delegation defaults to normal and only requests urgent delivery when selected", async () => {
  let current = task();
  const page = mount((operation, body) => {
    if (operation === "task_list") return { tasks: [current], hasMore: false };
    if (operation === "task_get")
      return { task: current, activities: [], executions: [], hasMore: false };
    if (operation === "task_dispatch") {
      current = { ...current, version: current.version + 1 };
      return { task: current };
    }
    throw new Error(operation);
  });
  try {
    page.render();
    (await waitFor(() => page.document.querySelector(".collab-task-card"), "task card")).click();
    await tick();
    for (const priority of ["normal", "urgent"]) {
      click(page, "Give to agent");
      await tick();
      const urgent = field(page, "Urgent");
      assert.equal(urgent.checked, false);
      if (priority === "urgent") {
        urgent.click();
        await tick();
      }
      click(page, "Assign and send");
      await tick();
      const request = page.calls
        .filter((call) => call.operation === "task_dispatch")
        .at(-1);
      assert.equal(request.body.taskId, "T-1");
      assert.equal(request.body.priority, priority);
      assert.equal(request.body.toAgentId, "dev-1");
      assert.equal(request.body.expectedVersion, priority === "normal" ? 1 : 2);
    }
    assert.equal(
      page.calls.some((call) => call.operation === "peer_send"),
      false,
    );
  } finally {
    page.close();
  }
});

test("message delivery shows urgency, precise sources and hook waiting without claiming recipient understanding", async () => {
  const base = {
    sender: { kind: "agent", id: "dev-2", name: "Dev 2" },
    recipient: { kind: "agent", id: "dev-1", name: "Dev 1" },
    body: "Bounds report attached to the task.",
    threadId: "mail-1",
    taskId: "T-1",
    firstReadAt: null,
    createdAt: "2026-10-12T12:00:00Z",
    source: { agentId: "dev-2", turnId: "source-turn" },
  };
  const messages = ["steer", "start", "hook"].map((mode, index) => ({
    ...base,
    id: `mode-${mode}`,
    seq: index + 1,
    priority: mode === "steer" ? "urgent" : "normal",
    delivery: {
      state: "delivered",
      detail: { mode, turnId: `recipient-${mode}` },
    },
  }));
  messages.push({
    ...base,
    id: "waiting-hook",
    seq: 4,
    priority: "urgent",
    delivery: { state: "sending", detail: { mode: "hook" } },
  });
  messages.push({
    ...base,
    id: "deferred-hook",
    seq: 5,
    priority: "normal",
    delivery: { state: "pending", detail: { mode: "hook" } },
  });
  const page = mount((operation) => {
    if (operation === "task_list") return { tasks: [], hasMore: false };
    if (operation === "peer_read") return { messages, hasMore: false };
    throw new Error(operation);
  });
  try {
    page.render();
    await tick();
    click(page, "Messages");
    await tick();
    assert.equal(
      page.document.querySelectorAll(".collab-urgent-badge").length,
      2,
    );
    for (const [mode, label] of [
      ["steer", "Via active turn"],
      ["start", "Via new turn"],
      ["hook", "Via native hook"],
    ]) {
      const card = page.document.getElementById(`peer-message-mode-${mode}`);
      assert.ok(card.textContent.includes(label));
      [...card.querySelectorAll("button")]
        .find((node) => node.textContent.trim() === "Recipient conversation")
        .click();
    }
    assert.deepEqual(page.sourceCalls, [
      ["dev-1", "recipient-steer"],
      ["dev-1", "recipient-start"],
      ["dev-1", "recipient-hook"],
    ]);
    const pending = page.document.getElementById("peer-message-waiting-hook");
    assert.match(pending.textContent, /Awaiting tool boundary/);
    assert.doesNotMatch(
      pending.textContent,
      /Recipient notified|Via native hook|understood|completed/i,
    );
    const deferred = page.document.getElementById("peer-message-deferred-hook");
    assert.match(deferred.textContent, /Waiting in mailbox/);
    assert.doesNotMatch(
      deferred.textContent,
      /Awaiting tool boundary|Recipient notified|Via native hook/,
    );
  } finally {
    page.close();
  }
});

test("steered peer reminders preserve native order, authors and copy between agent output and human input", async () => {
  const page = mount(() => ({}));
  try {
    const turn = {
      id: "turn-steer",
      status: "inProgress",
      items: [
        {
          id: "initial",
          type: "userMessage",
          content: [{ type: "text", text: "Implement file previews." }],
        },
        {
          id: "before-peer",
          type: "agentMessage",
          phase: "commentary",
          text: "I will check the preview parser.",
        },
        {
          id: "preview-check",
          type: "commandExecution",
          command: "rg preview web/src",
          aggregatedOutput: "Found preview.ts",
          status: "completed",
          exitCode: 0,
        },
        {
          id: "peer-input",
          type: "userMessage",
          _yuzunoSource: "peer",
          content: [
            { type: "text", text: "A teammate has sent a bounds report." },
          ],
        },
        {
          id: "after-peer",
          type: "agentMessage",
          phase: "commentary",
          text: "I will read the bounds report.",
        },
        {
          id: "later-user",
          type: "userMessage",
          content: [{ type: "text", text: "Also check long files." }],
        },
      ],
    };
    page.window.renderTurn({
      turn, index: 0, agent: { ...agents[0], status: "working" },
      isLatestAgentTurn: true, sourceItemId: "peer-input", onFile() {},
    });
    await waitFor(() => page.document.querySelector('[data-item-id="later-user"]'), "interleaved conversation");
    const tools = page.document.querySelector(".tool-activity");
    assert.equal(tools.open, false);
    assert.equal(page.document.getElementById("item-preview-check"), null);
    tools.querySelector(":scope > summary").click();
    await waitFor(() => page.document.getElementById("item-preview-check"), "inspected tool row");
    const order = [...page.document.querySelectorAll(
      '.turn .user-message, .turn .commentary, .turn .tool-item',
    )].map((node) => node.dataset.itemId || node.id);
    assert.deepEqual(order, [
      "initial", "before-peer", "item-preview-check", "peer-input", "after-peer", "later-user",
    ]);
    const labels = [
      ...page.document.querySelectorAll(".user-message .message-label, .mailbox-notice > summary"),
    ].map((node) => node.textContent.trim());
    assert.deepEqual(labels, ["YYou", "Workspace mail", "YYou"]);
    assert.equal(page.document.querySelectorAll(".mailbox-notice").length, 1);
    assert.equal(page.document.querySelector(".mailbox-notice").open, false);
    assert.ok(page.document.querySelector('[data-item-id="peer-input"]').classList.contains("source-highlight"));
    assert.equal(page.document.querySelector(".turn-activity strong").textContent, "Working");
    assert.ok(page.document.querySelector('[data-item-id="initial"] .mailbox-notice') === null, '[data-item-id="initial"] .mailbox-notice is absent');
    assert.equal(
      page.window.copyTurn(turn),
      [
        "You\nImplement file previews.",
        "Agent\nI will check the preview parser.",
        "commandExecution\n$ rg preview web/src\nFound preview.ts",
        "Workspace mailbox\nA teammate has sent a bounds report.",
        "Agent\nI will read the bounds report.",
        "You\nAlso check long files.",
      ].join("\n\n"),
    );
  } finally {
    page.close();
  }
});

test("a mailbox turn and a human follow-up keep separate authors in display and copy", async () => {
  const page = mount(() => ({}));
  try {
    const turn = {
      id: "turn-mail",
      status: "completed",
      _yuzunoSource: "peer",
      items: [
        {
          id: "mail",
          type: "userMessage",
          content: [{ type: "text", text: "Mailbox has new messages." }],
        },
        {
          id: "human",
          type: "userMessage",
          content: [{ type: "text", text: "Please check the links too." }],
        },
      ],
    };
    page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
    await tick();
    const labels = [
      ...page.document.querySelectorAll(".user-message .message-label, .mailbox-notice > summary"),
    ].map((node) => node.textContent.trim());
    assert.equal(labels[0], "Workspace mail");
    assert.equal(labels[1], "YYou");
    assert.equal(page.document.querySelector(".mailbox-notice").open, false);
    assert.match(
      page.window.copyTurn(turn),
      /^Workspace mailbox\nMailbox has new messages\.\n\nYou\nPlease check the links too\.$/,
    );
  } finally {
    page.close();
  }
});

test("compact doorbells use frozen results, priorities and bounded groups without mailbox reads", async () => {
  const page = mount(() => { throw new Error("Viewing a doorbell must not fetch mail or jobs"); });
  try {
    const cases = [
      ["peer", "", "Peer message"], ["job", "succeeded", "Job passed"], ["job", "failed", "Job failed"],
      ["job", "cancelled", "Job cancelled"], ["job", "timed_out", "Job timed out"], ["job", "oom", "Job out of memory"],
      ["job", "unknown", "Job result unknown"], ["job", "interrupted", "Job interrupted"], ["job", "rejected", "Job rejected"],
      ["ci", "passed", "CI passed"], ["ci", "failed", "CI failed"], ["ci", "cancelled", "CI cancelled"],
      ["ci", "skipped", "CI skipped"], ["ci", "pending", "CI pending"],
      ["review", "no_findings", "Code review: no findings"], ["review", "changes_requested", "Code review: changes requested"],
      ["review", "failed", "Code review: failed"], ["review", "unknown", "Code review: no conclusion"],
      ["pr", "updated", "PR updated"], ["pr", "created", "PR created"], ["pr", "failed", "PR operation failed"],
      ["pr", "needs_selection", "PR operation needs a choice"], ["system", "", "System"],
    ];
    for (const [kind, status, expected] of cases) {
      for (const priority of ["normal", "urgent"]) {
        const name = kind === "peer" ? "Dev 4" : kind === "ci" ? "PR #27" : "单测";
        const snapshot = { version: 1, priority, afterSeq: 40, throughSeq: 42, messageCount: 1, count: 1, remainingCount: 0,
          groups: [{ kind, status, name, count: 1 }] };
        const turn = { id: "fixed", status: "completed", items: [
          { id: "mail", type: "userMessage", _yuzunoSource: "peer", _yuzunoMailbox: snapshot,
            content: [{ type: "text", text: "Do not infer CI failed OOM from this prose." }] },
          { id: "pasted", type: "userMessage", content: [{ type: "text", text: "[Workspace collaboration — automatic urgent mailbox delivery from Yuzuno Core]" }] },
        ] };
        page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
        // Only urgency is named; normal is the usual case.
        const expectedLabel = `${name} · ${expected}${priority === "urgent" ? " · Urgent" : ""}`;
        await waitFor(() => page.document.querySelector(".mailbox-notice summary")?.getAttribute("aria-label") === expectedLabel, expectedLabel);
        assert.equal(page.document.querySelectorAll(".mailbox-notice").length, 1, "pasted text is a human message");
        assert.equal(page.document.querySelector(".mailbox-notice").open, false);
        assert.match(page.document.querySelector(".mailbox-range").textContent, /after 40 through 42/);
      }
    }
    const longName = "Very long immutable build name ".repeat(8);
    const turn = { id: "mixed", status: "completed", _yuzunoSource: "peer", _yuzunoMailbox: {
      version: 1, priority: "normal", messageCount: 12, count: 9, afterSeq: 42, throughSeq: 54, remainingCount: 4,
      groups: [{ kind: "job", status: "failed", name: longName, count: 3 }, { kind: "ci", status: "passed", count: 2 }],
    }, items: [{ id: "mail", type: "userMessage", content: [{ type: "text", text: "Core delivery pointer" }] }] };
    page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
    await waitFor(() => page.document.querySelector(".mailbox-more"), "mixed batch");
    assert.equal(page.document.querySelectorAll(".mailbox-group").length, 2);
    assert.match(page.document.querySelector("summary").textContent, /3 Jobs failed/);
    assert.match(page.document.querySelector("summary").textContent, /2 CI passed/);
    assert.equal(page.document.querySelector(".mailbox-more").textContent, "+4");
    assert.ok(page.document.querySelector(".mailbox-full-summary").textContent.includes(longName));
    assert.match(page.document.querySelector(".mailbox-range").textContent, /repeated results grouped/);
    page.document.querySelector("summary").click();
    assert.equal(page.document.querySelector(".mailbox-notice").open, true);
    assert.equal(page.calls.length, 0);
  } finally { page.close(); }
});

test("an opened doorbell shows the mail it carried; the note to the Agent stays folded", async () => {
  const read = [];
  const page = mount((operation, body) => {
    if (operation !== "peer_read") throw new Error(`Unexpected ${operation}`);
    read.push(body);
    return {
      hasMore: false,
      nextAfterSeq: 715,
      messages: [
        { id: "m1", seq: 709, sender: { kind: "agent", id: "dev-4", name: "Dev 4" }, taskId: "T-51",
          body: "T51 范围：只改 ToolActivity。", createdAt: "2026-10-15T20:23:50Z" },
        { id: "m2", seq: 711, sender: { kind: "system", id: "core", name: "Yuzuno Core" }, taskId: "T-51",
          body: "Local job 单测 (j1) is failed. Read job_get(jobId=j1).", createdAt: "2026-10-15T20:30:00Z",
          metadata: { kind: "job", status: "failed", name: "单测", jobId: "j1", attempt: "a1", systemdResult: "oom-kill" } },
        { id: "later", seq: 715, sender: { kind: "agent", id: "dev-6", name: "Dev 6" }, body: "Not this delivery." },
      ],
    };
  });
  try {
    const snapshot = { version: 1, recipientId: "dev-1", priority: "normal", afterSeq: 708, throughSeq: 711,
      messageCount: 2, count: 2, remainingCount: 0,
      groups: [{ kind: "peer", status: "", name: "Dev 4", count: 1 }, { kind: "job", status: "oom", name: "单测", count: 1 }] };
    const turn = { id: "doorbell", status: "completed", items: [
      { id: "mail", type: "userMessage", _yuzunoSource: "peer", _yuzunoMailbox: snapshot,
        content: [{ type: "text", text: "[Workspace collaboration — automatic normal mailbox delivery from Yuzuno Core] Read this mailbox." }] },
    ] };
    page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
    const summary = await waitFor(() => page.document.querySelector(".mailbox-notice > summary"), "doorbell");
    await tick();
    assert.equal(page.calls.length, 0, "closed, it reads nothing");
    summary.click();
    await waitFor(() => page.document.querySelectorAll(".mailbox-message").length === 2, "the delivery's two messages");
    assert.deepEqual(read, [{ agentId: "dev-1", afterSeq: 708, limit: 50, priority: "normal" }]);
    assert.deepEqual(
      [...page.document.querySelectorAll(".mailbox-message")].map((row) => [
        row.querySelector(".mailbox-message-head strong")?.textContent,
        row.querySelector(".mailbox-message-task")?.textContent,
        (row.querySelector(".mailbox-message-body") || row.querySelector(".mailbox-message-result"))?.textContent,
      ]),
      [["Dev 4", "T-51", "T51 范围：只改 ToolActivity。"], ["Yuzuno Core", "T-51", "单测 · Job out of memory"]],
    );
    // The note Core wrote to the Agent is kept, one fold deeper.
    const note = page.document.querySelector(".mailbox-prompt");
    assert.equal(note?.open, false);
    assert.match(note?.textContent || "", /automatic normal mailbox delivery/);
    summary.click(); await tick();
    summary.click(); await tick();
    assert.equal(read.length, 1, "reopening does not read again");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an opened doorbell shows only the messages its delivery reserved, not older unread mail in the range", async () => {
  const read = [];
  const page = mount((operation, body) => {
    if (operation !== "peer_read") throw new Error(`Unexpected ${operation}`);
    read.push(body);
    const all = [
      { id: "old", seq: 705, sender: { kind: "agent", id: "dev-6", name: "Dev 6" }, body: "Delivered earlier, never read." },
      { id: "m1", seq: 710, sender: { kind: "agent", id: "dev-4", name: "Dev 4" }, taskId: "T-51", body: "First reserved." },
      { id: "between", seq: 711, sender: { kind: "agent", id: "dev-2", name: "Dev 2" }, body: "Delivered with another turn." },
      { id: "m2", seq: 712, sender: { kind: "agent", id: "dev-3", name: "Dev 3" }, taskId: "T-66", body: "Second reserved." },
    ];
    return { hasMore: false, nextAfterSeq: 712, messages: all.filter((m) => m.seq > body.afterSeq) };
  });
  try {
    const snapshot = { version: 1, recipientId: "dev-1", priority: "normal", afterSeq: 700, throughSeq: 712,
      messageCount: 2, count: 2, remainingCount: 0, memberSeqs: [710, 712],
      groups: [{ kind: "peer", status: "", name: null, count: 2 }] };
    const turn = { id: "doorbell-members", status: "completed", items: [
      { id: "mail", type: "userMessage", _yuzunoSource: "peer", _yuzunoMailbox: snapshot,
        content: [{ type: "text", text: "[Workspace collaboration — automatic normal mailbox delivery from Yuzuno Core] Read this mailbox." }] },
    ] };
    page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
    const summary = await waitFor(() => page.document.querySelector(".mailbox-notice > summary"), "doorbell");
    summary.click();
    await waitFor(() => page.document.querySelectorAll(".mailbox-message").length === 2, "the two reserved messages");
    assert.deepEqual(
      [...page.document.querySelectorAll(".mailbox-message-body")].map((b) => b.textContent),
      ["First reserved.", "Second reserved."],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(read)), [{ agentId: "dev-1", afterSeq: 709, limit: 50, priority: "normal" }]);
    assert.equal(!!page.document.querySelector(".mailbox-status"), false, "nothing reported missing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a review result Core sent opens that review in Jobs; mail that only claims one does not", async () => {
  const page = mount((operation) => {
    if (operation !== "peer_read") throw new Error(`Unexpected ${operation}`);
    return {
      hasMore: false,
      nextAfterSeq: 902,
      messages: [
        { id: "r1", seq: 901, sender: { kind: "system", id: "core", name: "Yuzuno Core" }, taskId: "T-54",
          reviewId: "rev-54", body: "Code review 1 has ended: completed.", createdAt: "2026-10-15T23:48:00Z",
          metadata: { kind: "review", reviewId: "rev-54", status: "completed", conclusion: "changes_requested", name: "PR #43" } },
        { id: "p1", seq: 902, sender: { kind: "agent", id: "dev-4", name: "Dev 4" }, taskId: "T-54",
          body: "Looks done to me.", createdAt: "2026-10-15T23:49:00Z",
          metadata: { kind: "review", reviewId: "rev-forged", status: "completed", conclusion: "no_findings" } },
      ],
    };
  });
  const opened = [];
  page.window.addEventListener("yuzuno:open-job", (e) => opened.push(e.detail));
  try {
    const snapshot = { version: 1, recipientId: "dev-5", priority: "normal", afterSeq: 900, throughSeq: 902,
      messageCount: 2, count: 2, remainingCount: 0,
      groups: [{ kind: "review", status: "changes_requested", name: "PR #43", count: 1 }, { kind: "peer", status: "", name: "Dev 4", count: 1 }] };
    const turn = { id: "doorbell-review", status: "completed", items: [
      { id: "mail", type: "userMessage", _yuzunoSource: "peer", _yuzunoMailbox: snapshot,
        content: [{ type: "text", text: "[Workspace collaboration — automatic normal mailbox delivery from Yuzuno Core] Read this mailbox." }] },
    ] };
    page.window.renderTurn({ turn, index: 0, agent: agents[0], onFile() {} });
    const summary = await waitFor(() => page.document.querySelector(".mailbox-notice > summary"), "doorbell");
    summary.click();
    await waitFor(() => page.document.querySelectorAll(".mailbox-message").length === 2, "both messages");
    const buttons = [...page.document.querySelectorAll(".mailbox-open-review")];
    assert.equal(buttons.length, 1, "only Core's review result offers the review");
    assert.equal(buttons[0].textContent, "Open review");
    buttons[0].click();
    // The detail was made in the page's realm; compare its data.
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ source: "reviews", taskId: "T-54", reviewId: "rev-54" }]);
    assert.equal(page.calls.filter((c) => c.operation !== "peer_read").length, 0, "opening reads or starts nothing here");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("result submission offers only supported states and preserves completion when updating a finished task", async () => {
  for (const status of ["doing", "done"]) {
    let current = task({
      status,
      ...(status === "done"
        ? { result: { summary: "Earlier result", links: [], reportedBy: user } }
        : {}),
    });
    const page = mount((operation, body) => {
      if (operation === "task_list")
        return { tasks: [current], hasMore: false };
      if (operation === "task_get")
        return {
          task: current,
          activities: [],
          executions: [],
          hasMore: false,
        };
      if (operation === "task_submit_result") {
        assert.ok(["review", "done"].includes(body.status));
        current = {
          ...current,
          status: body.status,
          version: current.version + 1,
          result: {
            summary: body.summary,
            links: body.links,
            reportedBy: user,
          },
        };
        return { task: current };
      }
      throw new Error(operation);
    });
    try {
      page.render();
      const show = await waitFor(() => field(page, "Show"), "task filter");
      if (status === "done") await value(page, show, "all");
      const card = await waitFor(
        () =>
          page.document.querySelector('.collab-task-card[data-task-id="T-1"]'),
        `${status} task card`,
      );
      card.click();
      const resultButton = await waitFor(
        () => button(page, status === "done" ? "Update result" : "Add result"),
        `${status} task result action`,
      );
      resultButton.click();
      const select = await waitFor(
        () => field(page, "After adding this result"),
        "result status field",
      );
      assert.deepEqual(
        [...select.options].map((option) => option.value),
        ["review", "done"],
      );
      assert.equal(select.value, status === "done" ? "done" : "review");
      await value(
        page,
        field(page, "Result summary"),
        "Line positioning and invalid-range handling verified.",
      );
      click(page, "Add a web link");
      await tick();
      await value(page, field(page, "Link label"), "Preview report");
      await value(
        page,
        field(page, "Web address"),
        "HTTPS://example.com/report",
      );
      click(page, "Save result");
      await tick();
      const writes = page.calls.filter(
        (call) => call.operation === "task_submit_result",
      );
      assert.equal(writes.length, 1);
      assert.equal(
        writes[0].body.status,
        status === "done" ? "done" : "review",
      );
      assert.equal(writes[0].body.links[0].url, "https://example.com/report");
    } finally {
      page.close();
    }
  }
});

test("a failed reminder is visible but recipient fetch evidence takes precedence", async () => {
  let message = {
    id: "mail-error",
    seq: 1,
    sender: user,
    recipient: { kind: "agent", id: "dev-1", name: "Dev 1" },
    body: "Please inspect this result.",
    taskId: null,
    replyTo: null,
    threadId: "mail-error",
    createdAt: "2026-10-12T12:00:00Z",
    firstReadAt: null,
    delivery: { state: "error", detail: {} },
  };
  const page = mount((operation) => {
    if (operation === "task_list") return { tasks: [], hasMore: false };
    if (operation === "peer_read")
      return { messages: [message], hasMore: false };
    throw new Error(operation);
  });
  try {
    page.render();
    await tick();
    click(page, "Messages");
    await tick();
    assert.match(
      page.document.querySelector(".collab-message-footer").textContent,
      /Reminder unavailable/,
    );
    message = { ...message, firstReadAt: "2026-10-12T12:01:00Z" };
    page.document.querySelector('[aria-label="Refresh messages"]').click();
    await waitFor(
      () =>
        /Fetched by recipient/.test(
          page.document.querySelector(".collab-message-footer")?.textContent,
        ),
      "refreshed delivery state",
    );
    assert.match(
      page.document.querySelector(".collab-message-footer").textContent,
      /Fetched by recipient/,
    );
    assert.doesNotMatch(
      page.document.querySelector(".collab-message-footer").textContent,
      /Reminder unavailable/,
    );
  } finally {
    page.close();
  }
});

test("a review's result mail and a review link open its task at that review's report, starting nothing", async () => {
  const pull = {
    id: "7:pull:1",
    repositoryId: 7,
    repository: "owner/repo",
    kind: "pull",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    syncedAt: "2026-10-12T12:00:00Z",
    lastAttemptAt: null,
    error: null,
    stale: false,
    snapshot: { baseSha: "a".repeat(40), headSha: "b".repeat(40), state: "open", title: "PR" },
  };
  const old = {
    id: "run-old",
    linkId: pull.id,
    repository: "owner/repo",
    number: 1,
    status: "completed",
    requestedHarness: "codex",
    requestedModel: "gpt-6.1-sol",
    actualHarness: "codex",
    actualModel: "gpt-6.1-sol",
    baseSha: "a".repeat(40),
    headSha: "c".repeat(40),
    mergeBaseSha: "d".repeat(40),
    conclusion: "changes_requested",
    error: null,
    createdAt: "2026-10-12T12:00:00Z",
    outdated: true,
    findings: [],
    cursor: 1,
    round: 1,
    rawReport: "round one report",
  };
  const mail = {
    id: "mail-review",
    seq: 2,
    sender: { kind: "system", id: "core", name: "Yuzuno Core" },
    recipient: { kind: "agent", id: "dev-1", name: "Dev 1" },
    body: "Code review 1 has ended: completed.",
    taskId: "T-1",
    reviewId: "run-old",
    replyTo: null,
    threadId: "mail-review",
    createdAt: "2026-10-12T12:00:00Z",
    firstReadAt: null,
    delivery: { state: "pending", detail: {} },
  };
  // Only Core's own review mail carries a trusted review link.
  const peer = {
    ...mail,
    id: "mail-peer",
    seq: 3,
    threadId: "mail-peer",
    reviewId: "run-old",
    sender: { kind: "agent", id: "dev-2", name: "Dev 2" },
  };
  const links = { links: [pull], repositories: [], refreshing: false };
  const page = mount((operation) => {
    if (operation === "task_list") return { tasks: [task()], hasMore: false };
    if (operation === "peer_read") return { messages: [mail, peer], hasMore: false };
    if (operation === "task_get")
      return { task: task(), activities: [], executions: [], hasMore: false };
    if (operation === "github_links" || operation === "github_refresh") return links;
    if (operation === "peers_list") return { peers: [] };
    if (operation === "pr-reviews?taskId=T-1")
      return { reviews: [], hasMore: false, nextBefore: null };
    if (operation === "run-old?taskId=T-1") return old;
    if (operation === "pr-operations?taskId=T-1")
      return { operations: [], repositories: [], hasMore: false, nextBefore: null };
    throw new Error(operation);
  });
  try {
    page.render();
    await tick();
    click(page, "Messages");
    await waitFor(() => page.document.getElementById("peer-message-mail-review"), "review mail");
    assert.equal(
      [...page.document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Open review").length,
      1,
    );
    click(page, "Open review");
    const focused = await waitFor(
      () => page.document.querySelector(".pr-review-run.focused"),
      "the linked review in its task",
    );
    assert.match(focused.textContent, /Review ID: run-old/);
    assert.match(focused.textContent, /Outdated report/);
    assert.equal(focused.querySelector("pre").textContent, "round one report");
    assert.equal(page.document.querySelector(".collab-detail .collab-task-id").textContent, "T-1");
    const used = new Set(page.calls.map((c) => c.operation));
    for (const write of ["pr-reviews", "task_update", "task_dispatch", "peer_send"])
      assert.equal(used.has(write), false, write);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
  // The same link from Jobs arrives as a focus on an already open board.
  const linked = mount((operation) => {
    if (operation === "task_list") return { tasks: [task()], hasMore: false };
    if (operation === "task_get")
      return { task: task(), activities: [], executions: [], hasMore: false };
    if (operation === "github_links" || operation === "github_refresh") return links;
    if (operation === "peers_list") return { peers: [] };
    if (operation === "pr-reviews?taskId=T-1")
      return { reviews: [], hasMore: false, nextBefore: null };
    if (operation === "run-old?taskId=T-1") return old;
    if (operation === "pr-operations?taskId=T-1")
      return { operations: [], repositories: [], hasMore: false, nextBefore: null };
    throw new Error(operation);
  });
  try {
    linked.render();
    await tick();
    linked.render({ focus: { taskId: "T-1", reviewId: "run-old", at: 1 } });
    await waitFor(() => linked.document.querySelector(".pr-review-run.focused"), "focused review");
    assert.equal(linked.calls.filter((c) => c.operation === "run-old?taskId=T-1").length, 1);
    assert.deepEqual(linked.errors, []);
  } finally {
    linked.close();
  }
});

// T-193: Data & storage opens a task by its ID at its own Workspace section.
test("opened at a task's Workspace section, the board shows that task there and only lists its folders: nothing is previewed or removed", async () => {
  const done = task({ id: "T-7", title: "Build cache", status: "done" });
  const folder = { id: "w1", path: "/work/build-cache", origin: "registered", state: "present",
    git: { branch: "t-7", head: "0123456789abcdef", origin: "example/demo", repositoryId: 42, sameRepository: true, changes: { modified: 0, untracked: 0, complete: true } },
    users: { agents: [], liveJobs: [], taskJobs: 0 } };
  const page = mount((operation, body) => {
    if (operation === "task_list") return { tasks: [task(), done], hasMore: false };
    if (operation === "task_get") return { task: body.taskId === "T-7" ? done : task(), activities: [], executions: [], hasMore: false };
    if (operation === "workspaces") return { taskId: "T-7", repositories: [], workspaces: [folder] };
    if (operation === "github_links" || operation === "github_refresh") return { links: [], repositories: [] };
    if (operation === "delivery_get") return { flow: null, settings: { harness: "codex", model: "gpt-6.1-sol" } };
    if (operation === "peers_list") return { peers: [] };
    if (operation === "peer_read") return { messages: [], hasMore: false };
    if (operation.startsWith("pr-reviews?")) return { reviews: [], hasMore: false, nextBefore: null };
    if (operation.startsWith("pr-operations?")) return { operations: [], repositories: [], hasMore: false, nextBefore: null };
    throw new Error(operation);
  });
  try {
    page.render({ focus: { taskId: "T-7", section: "workspaces", at: 1 } });
    const heading = await waitFor(() => page.document.querySelector(".task-workspaces h4"), "the task's Workspace section");
    assert.equal(page.calls.find((call) => call.operation === "task_get").body.taskId, "T-7", "the task named by its ID, though done");
    await waitFor(() => page.document.activeElement === heading, "the Workspace section brought into view");
    await waitFor(() => /\/work\/build-cache/.test(page.document.querySelector(".task-workspaces").textContent), "its folders listed");
    assert.deepEqual(page.calls.filter((call) => call.operation === "workspaces").map((call) => call.method), ["GET"], "only listed");
    assert.ok(!page.calls.some((call) => ["preview", "cleanup"].includes(call.operation)), "nothing is previewed or removed");
    assert.ok(button(page, "Preview cleanup"), "the cleanup is the section's own, still to be asked for");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("opened at the Workspace section of a task Core no longer has, the board says so and lists no other task's folders", async () => {
  const page = mount((operation, body) => {
    if (operation === "task_list") return { tasks: [task()], hasMore: false };
    if (operation === "task_get") return body.taskId === "T-404" ? { httpStatus: 404, error: "task T-404 was not found" } : { task: task(), activities: [], executions: [], hasMore: false };
    if (operation === "peers_list") return { peers: [] };
    if (operation === "peer_read") return { messages: [], hasMore: false };
    return { httpStatus: 500, error: `unexpected ${operation}` };
  });
  try {
    page.render({ focus: { taskId: "T-404", section: "workspaces", at: 1 } });
    await waitFor(() => /task T-404 was not found/.test(page.document.body.textContent), "Core's answer for that task");
    assert.deepEqual(page.calls.filter((call) => call.operation === "task_get").map((call) => call.body.taskId), ["T-404"], "only the task named by its ID");
    assert.ok(!page.document.querySelector(".task-workspaces"), "no Workspace section");
    assert.ok(!page.calls.some((call) => ["workspaces", "preview", "cleanup"].includes(call.operation)), "no folders listed, previewed or removed");
  } finally {
    page.close();
  }
});

// T-189: the Tasks and Messages window in Chinese. What people and Agents
// wrote, names, links and Core's errors stay as written; a language switch
// keeps what is open and typed and starts nothing.
function chinese(page) {
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
}
function speak(page, language) {
  page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
}
function quietCore(answers = {}) {
  return (operation, body) => {
    if (operation in answers) return typeof answers[operation] === "function" ? answers[operation](body) : answers[operation];
    if (operation === "workspaces") return { taskId: "T-1", repositories: [], workspaces: [] };
    if (operation === "github_links" || operation === "github_refresh") return { links: [], repositories: [] };
    if (operation === "delivery_get") return { flow: null, settings: { harness: "codex", model: "gpt-6.1-sol" } };
    if (operation === "peers_list") return { peers: [] };
    if (operation.startsWith("pr-reviews")) return { reviews: [], hasMore: false, nextBefore: null };
    if (operation.startsWith("pr-operations")) return { operations: [], repositories: [], hasMore: false, nextBefore: null };
    throw new Error(operation);
  };
}
const activities = [
  { seq: 1, taskId: "T-1", kind: "created", actor: user, at: "2026-10-12T12:00:00Z" },
  { seq: 2, taskId: "T-1", kind: "comment", body: "Bounds look right to me.", actor: { kind: "agent", id: "dev-2", name: "Dev 2" }, at: "2026-10-12T12:05:00Z" },
];

test("a research record shows as its author wrote it with each source's identity, and reads what holds now on request (T-17)", async () => {
  const record = {
    schema: "research/1",
    type: "claim",
    id: "faster",
    title: "Layout B is faster on the small inputs",
    text: "Layout B runs the small inputs about 4% faster than layout A.",
    status: "conditional",
    field: "systems",
    conditions: ["Small inputs only"],
    limits: ["One machine only"],
    method: { activitySeq: 3, id: "timing", title: "Timing protocol" },
    sources: [
      { kind: "job", label: "Raw timings", jobId: "job-1", attempt: "11111111-1111-4111-8111-111111111111", path: "out/timings.json", sha256: "a".repeat(64), bytes: 40, recorded: "recorded_match" },
      { kind: "task", taskId: "T-2", activitySeq: 9, record: { kind: "research", type: "observation", id: "ranking", title: "Ranking flips with link order" }, producer: { kind: "agent", id: "dev-5", name: "Dev 5" }, at: "2026-10-12T11:00:00Z" },
      { kind: "external", label: "Upstream benchmark notes", url: "https://example.org/bench", version: "v3", observedAt: "2026-11-01", coverage: "Small inputs only", checked: false },
    ],
  };
  const researched = { seq: 4, taskId: "T-1", kind: "comment", body: "Claim recorded.", actor: { kind: "agent", id: "dev-2", name: "Dev 2" }, at: "2026-10-12T12:10:00Z", research: record };
  const now = ["recorded_match", "readable", "stated"];
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { todo: 0, doing: 1, blocked: 0, review: 0, done: 0, cancelled: 0 } },
    task_get: { task: task(), activities: [...activities, researched], executions: [], hasMore: false },
    task_research_get: { taskId: "T-1", activitySeq: 4, version: 2, revisedBy: null, latestActivitySeq: 4,
      research: { ...record, sources: record.sources.map((source, n) => ({ ...source, now: { state: now[n] } })) },
      method: { activitySeq: 3, version: 1, revisedBy: 6, latestActivitySeq: 6, research: { type: "method", id: "timing", title: "Timing protocol", text: "Ten fresh processes." }, method: null } },
  }));
  try {
    page.render();
    await waitFor(() => page.document.querySelector(".collab-task-card"), "the task card");
    page.document.querySelector(".collab-task-card").click();
    const card = await waitFor(() => page.document.querySelector(".task-research"), "the research record");
    const text = () => card.textContent;
    assert.match(text(), /Claim/);
    assert.match(text(), /Layout B is faster on the small inputs/, "the title as written");
    assert.match(text(), /Holds under conditions \(the author's judgement\)/);
    assert.match(text(), /Made with the method “Timing protocol” as written in activity 3/);
    assert.match(text(), /Small inputs only/);
    assert.match(text(), /One machine only/);
    assert.match(text(), /out\/timings\.json/);
    assert.match(text(), /Matched this task's recorded Job check when written/);
    assert.match(text(), /T-2 · activity 9/);
    assert.match(text(), /by Dev 5/, "the cited record's own producer");
    assert.match(text(), /As its author stated it; Yuzuno did not check it/);
    assert.doesNotMatch(text(), /verified/i);
    assert.ok(!page.calls.some((call) => call.operation === "task_research_get"), "nothing is read until asked");
    const toggle = [...card.querySelectorAll("button")].find((b) => b.textContent === "Version and sources now");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    toggle.click();
    await waitFor(() => /Version 2 of this record/.test(text()), "the record's version");
    assert.match(text(), /This is the newest version/);
    assert.match(text(), /The method as cited is version 1; a newer version is activity 6/);
    assert.match(text(), /Now: the Job's record still lists this file and hash; the file itself was not read/);
    assert.match(text(), /Now: Record readable/);
    assert.match(text(), /Now: Not checked/);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const reads = page.calls.filter((call) => call.operation === "task_research_get");
    assert.deepEqual(reads.map((call) => [call.method, call.body]), [["POST", { taskId: "T-1", activitySeq: 4 }]]);
    assert.ok(!page.calls.some((call) => ["task_comment", "task_update", "task_submit_result"].includes(call.operation)), "reading writes nothing");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

/** A research method record (T-17) and Core's read of it. */
const methodV1 = { schema: "research/1", type: "method", id: "timing", title: "Timing protocol", text: "Ten iterations in one process." };
const methodV2 = { ...methodV1, text: "Ten fresh processes.", revises: { activitySeq: 3, reason: "Iterations share caches." } };
const mina = { kind: "agent", id: "dev-2", name: "Dev 2" };
const recorded = (seq, research, body) => ({ seq, taskId: "T-1", kind: "comment", body, actor: mina, at: "2026-10-12T12:10:00Z", research });
const readOf = (seq, research, version, latest) => ({ taskId: "T-1", activitySeq: seq, version, revisedBy: latest === seq ? null : latest, latestActivitySeq: latest, research, method: null });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const toggleOf = (card) => card.querySelector(".task-research-toggle");
const openTask = async (page) => {
  await waitFor(() => page.document.querySelector(".collab-task-card"), "the task card");
  page.document.querySelector(".collab-task-card").click();
};

test("a research record is read again at every opening: a revision added since shows (T-17)", async () => {
  let activities2 = [recorded(3, methodV1, "Method v1.")];
  let answer = readOf(3, methodV1, 1, 3);
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: () => ({ task: task(), activities: activities2, executions: [], hasMore: false }),
    task_research_get: () => answer,
  }));
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    const card = await waitFor(() => page.document.querySelector(".task-research"), "the method");
    toggleOf(card).click();
    await waitFor(() => /This is the newest version/.test(card.textContent), "the first read");
    assert.match(card.textContent, /Read /, "when it was read");
    toggleOf(card).click();
    // A revision is a comment: the task's version does not change, the history does.
    activities2 = [recorded(3, methodV1, "Method v1."), recorded(6, methodV2, "Method v2.")];
    answer = readOf(3, methodV1, 1, 6);
    page.render({ workspaceId: "ws-1", revision: 1 });
    await waitFor(() => page.document.querySelectorAll(".task-research").length === 2, "the revision in the history");
    const first = page.document.querySelector(".task-research");
    toggleOf(first).click();
    await waitFor(() => /A newer version is activity 6/.test(first.textContent), "the second read");
    assert.doesNotMatch(first.textContent, /This is the newest version/);
    assert.equal(page.calls.filter((call) => call.operation === "task_research_get").length, 2, "one read per opening");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("Check again reads the record again: a Job record gone shows so, the recorded identity stays (T-17)", async () => {
  const source = { kind: "job", label: "Raw timings", jobId: "job-1", attempt: "11111111-1111-4111-8111-111111111111", path: "out/timings.json", sha256: "a".repeat(64), recorded: "recorded_match" };
  const claim = { schema: "research/1", type: "claim", id: "faster", title: "B is faster", text: "About 4%.", status: "conditional", sources: [source] };
  let state = "recorded_match";
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: { task: task(), activities: [recorded(4, claim, "Claim.")], executions: [], hasMore: false },
    task_research_get: () => ({ ...readOf(4, { ...claim, sources: [{ ...source, now: { state, file: "not_read" } }] }, 1, 4) }),
  }));
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    const card = await waitFor(() => page.document.querySelector(".task-research"), "the claim");
    toggleOf(card).click();
    await waitFor(() => /Now: the Job's record still lists this file and hash/.test(card.textContent), "the first read");
    state = "job_missing";
    [...card.querySelectorAll("button")].find((b) => b.textContent === "Check again").click();
    await waitFor(() => /Now: Job record no longer kept/.test(card.textContent), "the read after the Job record went");
    assert.match(card.textContent, /out\/timings\.json/, "the recorded identity stays");
    assert.match(card.textContent, /Matched this task's recorded Job check when written/);
    assert.equal(page.calls.filter((call) => call.operation === "task_research_get").length, 2);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a read answering late, after the board turned to another Workspace, is dropped (T-17)", async () => {
  // Activity numbers are unique within one Workspace's store, so the same
  // number naming another record happens only across Workspaces.
  const ours = { schema: "research/1", type: "claim", id: "ours", title: "Our claim", text: "In ws-1.", status: "open" };
  const theirs = { ...ours, id: "theirs", title: "Another Workspace's claim", text: "In ws-2." };
  const late = deferred();
  let workspace = "ws-1";
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: () => ({ task: task(), activities: [recorded(4, workspace === "ws-1" ? ours : theirs, "Claim.")], executions: [], hasMore: false }),
    task_research_get: () => (workspace === "ws-1" ? late.promise : readOf(4, theirs, 1, 4)),
  }));
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    const card = await waitFor(() => page.document.querySelector(".task-research"), "our claim");
    toggleOf(card).click();
    await waitFor(() => /Reading the record/.test(card.textContent), "the read under way");
    workspace = "ws-2";
    page.render({ workspaceId: "ws-2", revision: 1 });
    await waitFor(() => /Another Workspace's claim/.test(page.document.querySelector(".task-research")?.textContent ?? ""), "the other Workspace's record");
    const now = page.document.querySelector(".task-research");
    assert.equal(toggleOf(now).getAttribute("aria-expanded"), "false", "closed: the open read was for another record");
    late.resolve(readOf(4, ours, 7, 4));
    await tick(30);
    assert.doesNotMatch(page.document.body.textContent, /Version 7 of this record/, "the late answer is not shown");
    toggleOf(now).click();
    await waitFor(() => /Version 1 of this record/.test(now.textContent), "its own read");
    assert.doesNotMatch(now.textContent, /Version 7/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("turning to another Workspace with the same task number opens that Workspace's task: nothing of the old one shows, its late answers are dropped, the board stays (T-17)", async () => {
  // Only the Workspace changes: the same selected T-1, the same revision.
  let workspace = "ws-1";
  const laterPage = deferred();
  const other = deferred();
  const note = (seq, body) => ({ seq, taskId: "T-1", kind: "comment", body, actor: mina, at: "2026-10-12T12:10:00Z" });
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: (body) => {
      if (body.afterSeq !== undefined) return laterPage.promise;
      if (workspace === "ws-1")
        return { task: task({ title: "The first Workspace's task" }), activities: [note(5, "A ws-1 note.")], executions: [], hasMore: true, nextAfterSeq: 5 };
      return other.promise;
    },
  }));
  const pane = () => page.document.querySelector(".collab-detail");
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    await waitFor(() => /A ws-1 note\./.test(pane()?.textContent ?? ""), "the first Workspace's task");
    const board = page.document.querySelector(".collab-task-layout");
    button(page, "More updates").click();
    await tick();
    workspace = "ws-2";
    page.render({ workspaceId: "ws-2" });
    await waitFor(() => /Opening task/.test(pane()?.textContent ?? ""), "the other Workspace's task opening");
    assert.doesNotMatch(pane().textContent, /first Workspace|A ws-1 note/, "nothing of the old task while the new one opens");
    // The old Workspace's page of history answers late: dropped.
    laterPage.resolve({ task: task({ title: "The first Workspace's task" }), activities: [note(3, "An older ws-1 note.")], executions: [], hasMore: false });
    await tick();
    assert.doesNotMatch(pane().textContent, /ws-1/);
    other.resolve({ task: task({ title: "The second Workspace's task" }), activities: [note(5, "A ws-2 note.")], executions: [], hasMore: false });
    await waitFor(() => /A ws-2 note\./.test(pane()?.textContent ?? ""), "the second Workspace's task");
    assert.doesNotMatch(pane().textContent, /ws-1|first Workspace/);
    assert.match(pane().textContent, /The second Workspace's task/);
    assert.equal(page.document.querySelector(".collab-task-layout"), board, "the board itself was not mounted again");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("an update in the same Workspace keeps a note being written (T-17)", async () => {
  let reads = 0;
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: () => {
      reads += 1;
      return { task: task(), activities: [], executions: [], hasMore: false };
    },
  }));
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    await waitFor(() => field(page, "Add a note"), "the note field");
    await value(page, field(page, "Add a note"), "A note half written");
    const before = reads;
    page.render({ workspaceId: "ws-1", revision: 1 });
    await waitFor(() => reads > before, "the task read again");
    await tick();
    assert.equal(field(page, "Add a note").value, "A note half written");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a comparison shows every entry, left out or not, with why, and says what the included ones share; no difference is computed (T-17)", async () => {
  const entries = [
    { id: "processes", label: "Fresh processes", status: "included", unit: "%", level: "process", n: 10, definition: "median of runs",
      method: { activitySeq: 6, id: "timing", title: "Timing protocol" }, value: { value: -1.2, low: -3.5, high: 1.1 } },
    { id: "again", label: "Fresh processes, second run", status: "included", unit: "%", level: "process", n: 10, definition: "median of runs",
      method: { activitySeq: 6, id: "timing", title: "Timing protocol" }, value: { value: -0.8, low: -2.9, high: 1.3 } },
    { id: "large", label: "Large inputs", status: "missing", reason: "The large set was not exported." },
    { id: "second-machine", label: "Second machine", status: "not_done", reason: "No second machine yet." },
    { id: "warm", label: "Warm cache run", status: "excluded", reason: "The cache was left warm.", value: { value: -9 } },
  ];
  const counts = { included: 2, excluded: 1, missing: 1, not_done: 1 };
  const aligned = { schema: "research/1", type: "comparison", id: "layouts", title: "Layout B vs A, fresh processes", text: "Runtime change.", entries,
    comparability: { aligned: true, shared: { unit: "%", definition: "median of runs", level: "process", method: 6 }, differs: [], unknown: [], counts } };
  const mixed = { ...aligned, id: "layouts-mixed", title: "Layout B vs A, two methods",
    entries: [entries[0], { ...entries[1], unit: "ms", level: undefined, method: { activitySeq: 3, id: "timing", title: "Timing protocol" } }, ...entries.slice(2)],
    comparability: { aligned: false, shared: { definition: "median of runs" }, differs: ["unit", "method"], unknown: ["level"], counts } };
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
    task_get: { task: task(), activities: [recorded(7, aligned, "Compared."), recorded(8, mixed, "Compared again.")], executions: [], hasMore: false },
  }));
  try {
    page.render({ workspaceId: "ws-1" });
    await openTask(page);
    await waitFor(() => page.document.querySelectorAll(".task-research").length === 2, "both comparisons");
    const [first, second] = page.document.querySelectorAll(".task-research");
    for (const card of [first, second]) {
      const text = card.textContent;
      for (const expected of ["Comparison", "Fresh processes", "Included", "Large inputs", "Missing", "The large set was not exported.",
        "Second machine", "Not done", "No second machine yet.", "Warm cache run", "Excluded", "The cache was left warm.",
        "2 included · 1 excluded · 1 missing · 1 not done", "Yuzuno computes no difference"])
        assert.ok(text.includes(expected), `${expected}: ${text}`);
      assert.equal(card.querySelectorAll(".task-research-entry").length, 5, "nothing left out is dropped");
      assert.ok(!/−0\.4|0\.4 %|difference of/i.test(text), "no difference between entries is shown");
    }
    assert.match(first.textContent, /−1\.2 \[−3\.5, 1\.1\] %/, "a value as its author gave it");
    assert.match(first.textContent, /The included entries share unit \(%\), definition \(median of runs\), sample level \(process\), method \(method in activity 6\)/);
    assert.match(second.textContent, /Side by side only: the included entries differ in unit, method; sample level is not given for every entry/);
    assert.ok(!page.calls.some((call) => call.operation === "task_research_get"), "the table is the record as written; nothing is read");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("past the length Core follows, the first of a line names its next version and its latest as unknown, never as newest or as maybe none; the last is its newest, in English and Chinese (T-17)", async () => {
  const claim = { schema: "research/1", type: "claim", id: "faster", title: "B is faster", text: "About 4%.", status: "conditional",
    method: { activitySeq: 3, id: "timing", title: "Timing protocol" } };
  const last = { ...claim, text: "About 3%.", revises: { activitySeq: 208, reason: "Step 201." } };
  // As Core reads a line of 202 (the first and 201 revisions): the first is
  // version 1 with its next version known and its latest not; the last is its
  // own latest with its version not counted. The cited method's line is long too.
  const method = { taskId: "T-1", activitySeq: 3, version: 1, revisedBy: 6, latestActivitySeq: null, research: methodV1, method: null };
  const answers = {
    4: { taskId: "T-1", activitySeq: 4, version: 1, revisedBy: 5, latestActivitySeq: null, research: claim, method },
    209: { taskId: "T-1", activitySeq: 209, version: null, revisedBy: null, latestActivitySeq: 209, research: last, method },
  };
  for (const [language, first, newest] of [
    ["en", ["Version 1 of this record", "Activity 5 revises this one; the latest version is unknown",
      "The method as cited is version 1; activity 6 revises it, and its latest version is unknown"],
      ["This record's version was not counted", "This is the newest version"]],
    ["zh-Hans", ["这条记录的第 1 版", "活动 5 修订了它；最新版本未确定", "引用的方法是第 1 版；活动 6 修订了它，最新版本未确定"],
      ["这条记录的版本数未计出", "这是最新版本"]],
  ]) {
    const page = mount(quietCore({
      task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
      task_get: { task: task(), activities: [recorded(4, claim, "Claim."), recorded(209, last, "Claim, step 201.")], executions: [], hasMore: false },
      task_research_get: (body) => answers[body.activitySeq],
    }));
    try {
      if (language !== "en") chinese(page);
      page.render({ workspaceId: "ws-1" });
      await openTask(page);
      await waitFor(() => page.document.querySelectorAll(".task-research").length === 2, "both records");
      const [one, two] = page.document.querySelectorAll(".task-research");
      toggleOf(one).click();
      toggleOf(two).click();
      await waitFor(() => first.every((text) => one.textContent.includes(text)), `${language}: ${first.join(" / ")}`);
      await waitFor(() => newest.every((text) => two.textContent.includes(text)), `${language}: ${newest.join(" / ")}`);
      assert.doesNotMatch(one.textContent, /This is the newest version|这是最新版本/, "unknown is never newest");
      // A newer version is known to exist: never worded as if there might be none.
      for (const card of [one, two]) assert.doesNotMatch(card.textContent, /whether|是否/);
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("the task list and a task read in Chinese; what was written stays as written (T-189)", async () => {
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false, counts: { todo: 0, doing: 1, blocked: 0, review: 0, done: 0, cancelled: 0 } },
    task_get: { task: task(), activities, executions: [], hasMore: false },
  }));
  try {
    chinese(page);
    page.render();
    await waitFor(() => page.document.querySelector(".collab-task-card"), "the task card");
    const body = () => page.document.body.textContent;
    assert.match(body(), /一起工作的地方/);
    assert.ok(button(page, "任务") && button(page, "消息") && button(page, "新建任务"));
    assert.match(body(), /我们在做的/);
    const show = field(page, "显示");
    assert.deepEqual([...show.options].slice(0, 4).map((option) => option.textContent), ["未结束的任务", "全部任务", "待办", "进行中"]);
    assert.ok(field(page, "项目") && field(page, "负责人"));
    assert.equal(field(page, "负责人").options[0].textContent, "所有人");
    assert.ok(page.document.querySelector('[aria-label="刷新任务"]'));
    const card = page.document.querySelector(".collab-task-card");
    assert.match(card.textContent, /进行中/);
    assert.match(card.textContent, /File preview opens at the right line/, "the title as written");
    assert.match(card.textContent, /Preview the requested line and explain invalid positions\./, "the description as written");
    assert.match(body(), /显示 1 个符合条件的任务中的 1 个/);
    card.click();
    await waitFor(() => page.document.querySelector('[aria-label="任务详情"]') && /对话与动态/.test(body()), "the task in Chinese");
    for (const label of ["全部任务", "相关 Job", "交给 Agent", "编辑任务", "添加结果", "管理", "添加备注"])
      assert.ok(button(page, label), label);
    assert.match(body(), /工作内容/);
    assert.match(body(), /创建了此任务/);
    assert.match(body(), /Bounds look right to me\./, "a note as written");
    assert.doesNotMatch(body(), /Give to agent|Edit task|Conversation & updates|What we’re making|Showing 1 of/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("switching the language keeps an open edit, its typed draft and the open task, and asks Core nothing again (T-189)", async () => {
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false },
    task_get: { task: task(), activities, executions: [], hasMore: false },
  }));
  try {
    chinese(page);
    page.render();
    (await waitFor(() => page.document.querySelector(".collab-task-card"), "the task card")).click();
    await waitFor(() => button(page, "编辑任务"), "the task");
    click(page, "编辑任务");
    await tick();
    await value(page, field(page, "任务标题"), "预览时打开正确的行");
    const asked = () => page.calls.filter((call) => ["task_list", "task_get", "peer_read"].includes(call.operation)).length;
    const before = asked();
    speak(page, "en");
    await waitFor(() => page.document.querySelector('[aria-label="Task details"]'), "the task in English");
    await tick(100);
    assert.equal(field(page, "Task title").value, "预览时打开正确的行", "the draft stays");
    assert.ok(button(page, "Save changes"), "the edit stays open");
    assert.equal(page.document.querySelector(".collab-task-card.selected")?.dataset.taskId, "T-1", "the task stays open");
    assert.equal(asked(), before, "no request is started again");
    assert.equal(page.calls.filter((call) => call.operation === "task_update").length, 0, "nothing is saved");
  } finally {
    page.close();
  }
});

test("a new task reads in Chinese and Core's refusal stays as written, keeping the draft (T-189)", async () => {
  const page = mount(quietCore({
    task_list: { tasks: [], hasMore: false },
    task_create: { httpStatus: 400, error: "Title is too long for this Core" },
  }));
  try {
    chinese(page);
    page.render();
    await waitFor(() => /暂时清闲/.test(page.document.body.textContent), "the empty list in Chinese");
    click(page, "新建任务");
    await waitFor(() => page.document.querySelector('[aria-label="新建任务"]'), "the new task form");
    const form = page.document.querySelector('[aria-label="新建任务"]');
    assert.match(form.textContent, /一件要做的事/);
    assert.match(form.textContent, /描述 可选/);
    assert.equal(field(page, "任务标题").placeholder, "你想让什么成为可能？");
    assert.match(form.textContent, /指定负责人可以明确责任/);
    await value(page, field(page, "任务标题"), "一个很长的标题");
    click(page, "创建任务");
    await waitFor(() => form.querySelector('[role="alert"]'), "Core's refusal");
    assert.match(form.querySelector('[role="alert"]').textContent, /Title is too long for this Core/);
    assert.equal(field(page, "任务标题").value, "一个很长的标题");
  } finally {
    page.close();
  }
});

test("Messages reads in Chinese; bodies, names and delivery facts are said, not invented (T-189)", async () => {
  const base = {
    sender: { kind: "agent", id: "dev-2", name: "Dev 2" },
    recipient: { kind: "agent", id: "dev-1", name: "Dev 1" },
    threadId: "m-1",
    taskId: "T-1",
    createdAt: "2026-10-12T12:00:00Z",
    source: { agentId: "dev-2", turnId: "source-turn" },
  };
  const messages = [
    { ...base, id: "m-1", seq: 1, body: "The bounds check is ready.", firstReadAt: null, delivery: { state: "pending", detail: {} } },
    { ...base, id: "m-2", seq: 2, priority: "urgent", replyTo: "m-1", body: "Reply with the report.", firstReadAt: null,
      delivery: { state: "delivered", detail: { mode: "steer", turnId: "recipient-turn" } } },
    { ...base, id: "m-3", seq: 3, body: "Read already.", firstReadAt: "2026-10-12T12:10:00Z", delivery: { state: "delivered", detail: {} } },
  ];
  const page = mount(quietCore({
    task_list: { tasks: [task()], hasMore: false },
    peer_read: { messages, hasMore: false },
  }));
  try {
    chinese(page);
    page.render();
    await tick();
    click(page, "消息");
    await waitFor(() => /The bounds check is ready\./.test(page.document.body.textContent), "the messages");
    const text = page.document.body.textContent;
    assert.match(text, /队友之间的对话/);
    assert.equal(field(page, "邮箱").options[0].textContent, "所有 Agent");
    assert.match(text, /发给 Dev 1/);
    assert.match(text, /紧急/);
    assert.match(text, /在邮箱中等待/);
    assert.match(text, /已通知收件方/);
    assert.match(text, /通过进行中的回合/);
    assert.match(text, /收件方已读取/);
    assert.ok(button(page, "回复之前的一条消息"));
    assert.ok(page.document.querySelector('[aria-label="查看任务 T-1"]'));
    assert.ok(button(page, "发件方会话") && button(page, "收件方会话"));
    assert.doesNotMatch(text, /Waiting in mailbox|Recipient notified|Fetched by recipient/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});


test("a record's proposed next check or stop shows as a proposal, in English and Chinese (T-17)", async () => {
  const observation = { schema: "research/1", type: "observation", id: "ranking-flips", title: "Ranking flips with link order",
    text: "Reordering the link step reverses which layout is faster.",
    next: { action: "check", text: "Time ten fresh processes with the link order shuffled." } };
  for (const [language, label, note] of [
    ["en", "Proposes a next check", "A proposal: nothing runs or stops because of it."],
    ["zh-Hans", "提议下一项检查", "只是提议：不会因此运行或停止任何东西。"],
  ]) {
    const page = mount(quietCore({
      task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
      task_get: { task: task(), activities: [recorded(5, observation, "Observed.")], executions: [], hasMore: false },
    }));
    try {
      if (language !== "en") chinese(page);
      page.render({ workspaceId: "ws-1" });
      await openTask(page);
      const next = await waitFor(() => page.document.querySelector(".task-research-next"), "the proposal");
      assert.equal(next.getAttribute("data-action"), "check");
      assert.ok(next.textContent.includes(label) && next.textContent.includes("Time ten fresh processes"), next.textContent);
      assert.equal(next.getAttribute("title"), note);
      assert.ok(!page.calls.some((call) => call.operation === "task_research_get"), "nothing is read for a proposal");
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("a comparison entry shows each part its author gave and says which part is missing; a field can differ and be missing at once (T-17)", async () => {
  const entries = [
    { id: "a", label: "Iterations", status: "included", unit: "ms", level: "process", definition: "median of runs",
      method: { activitySeq: 3, id: "timing", title: "Timing protocol" }, value: { value: 12, low: 10.5 } },
    { id: "b", label: "Fresh processes", status: "included", unit: "s", n: 10, definition: "median of runs",
      method: { activitySeq: 6, id: "timing", title: "Timing protocol" } },
    { id: "c", label: "Second machine", status: "included", definition: "median of runs", value: { value: 11, high: 12.5 } },
    { id: "d", label: "Large inputs", status: "missing", reason: "The large set was not exported.", unit: "ms" },
    { id: "e", label: "Warm cache", status: "excluded", reason: "The cache was left warm.", level: "iteration", n: 0 },
  ];
  const record = { schema: "research/1", type: "comparison", id: "partial", title: "Layouts, partly reported", text: "As reported.", entries,
    comparability: { aligned: false, shared: { definition: "median of runs" }, differs: ["unit", "method"], unknown: ["unit", "level", "method"],
      counts: { included: 3, excluded: 1, missing: 1, not_done: 0 } } };
  for (const [language, expected] of [
    ["en", {
      a: ["12 [10.5, high not given] ms", "process · median of runs · method in activity 3"],
      b: ["No value given · unit s", "sample level not given · n = 10 · median of runs · method in activity 6"],
      c: ["11 [low not given, 12.5]"],
      d: ["No value given · unit ms"],
      e: ["iteration · n = 0"],
      line: "Side by side only: the included entries differ in unit, method; unit, sample level, method are not given for every entry.",
    }],
    ["zh-Hans", {
      a: ["12 [10.5, 上限未给] ms"],
      b: ["未给数值 · 单位 s", "未给样本层级 · n = 10"],
      c: ["11 [下限未给, 12.5]"],
      d: ["未给数值 · 单位 ms"],
      e: ["iteration · n = 0"],
      line: "仅并列展示：纳入的条目在单位, 方法上不同；并非每个条目都给出了单位, 样本层级, 方法。",
    }],
  ]) {
    const page = mount(quietCore({
      task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
      task_get: { task: task(), activities: [recorded(9, record, "Compared.")], executions: [], hasMore: false },
    }));
    try {
      if (language !== "en") chinese(page);
      page.render({ workspaceId: "ws-1" });
      await openTask(page);
      const card = await waitFor(() => page.document.querySelector(".task-research"), "the comparison");
      const rows = [...card.querySelectorAll(".task-research-entry")];
      assert.equal(rows.length, 5, "every entry, whatever its state");
      for (const [n, id] of ["a", "b", "c", "d", "e"].entries())
        for (const text of expected[id]) assert.ok(rows[n].textContent.includes(text), `${language} ${id}: ${text} in ${rows[n].textContent}`);
      assert.ok(card.textContent.includes(expected.line), `${language}: ${card.textContent}`);
      // Nothing made up: no value where none was given, no zero for a missing bound.
      for (const n of [1, 3, 4]) assert.doesNotMatch(rows[n].querySelector(".task-research-value")?.textContent ?? "", /\d+ \[/);
      assert.doesNotMatch(rows[2].textContent, /\[0|, 0\]/);
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("value, low, high and n past JavaScript's safe integers read as approximate, with why; 0 and safe integers stay exact (T-17)", async () => {
  // Parsed from JSON text, as the page receives Core's answer: Core keeps
  // these exactly, the page has only the nearest double it can hold.
  const entries = JSON.parse(`[
    {"id":"edge","label":"Edge","status":"included","unit":"events","level":"process","n":0,"value":{"value":9007199254740991}},
    {"id":"big","label":"Big","status":"included","unit":"events","n":9007199254740993,
      "value":{"value":9007199254740993,"low":-9007199254740993,"high":18446744073709551615}},
    {"id":"pow","label":"Power","status":"included","unit":"events","level":"seed","n":9007199254740992,"value":{"value":9007199254740992}},
    {"id":"safe","label":"Safe","status":"excluded","reason":"Counted twice.","level":"seed","n":9007199254740991}
  ]`);
  const record = { schema: "research/1", type: "comparison", id: "counts", title: "Event counts", text: "As counted.", entries,
    comparability: { aligned: false, shared: { unit: "events" }, differs: ["level"], unknown: ["level", "definition", "method"],
      counts: { included: 3, excluded: 1, missing: 0, not_done: 0 } } };
  for (const [language, note, missingLevel] of [
    ["en", "≈: past JavaScript's safe integer range, the value shown may have been rounded; Core keeps the value it parsed.", "sample level not given"],
    ["zh-Hans", "≈：超出 JavaScript 安全整数范围，显示值可能已舍入；Core 保留它解析的数值。", "未给样本层级"],
  ]) {
    const page = mount(quietCore({
      task_list: { tasks: [task()], hasMore: false, counts: { doing: 1 } },
      task_get: { task: task(), activities: [recorded(9, record, "Counted.")], executions: [], hasMore: false },
    }));
    try {
      if (language !== "en") chinese(page);
      page.render({ workspaceId: "ws-1" });
      await openTask(page);
      const card = await waitFor(() => page.document.querySelector(".task-research"), "the comparison");
      const [edge, big, pow, safe] = card.querySelectorAll(".task-research-entry");
      const value = (row) => row.querySelector(".task-research-value");
      const identity = (row) => row.querySelector(".task-research-identity");
      // The safe boundary and 0 are exact, unmarked.
      assert.equal(value(edge).textContent, "9007199254740991 events");
      assert.equal(value(edge).getAttribute("title"), null);
      assert.equal(identity(edge).textContent, "process · n = 0");
      assert.equal(identity(edge).getAttribute("title"), null);
      // Past it: value, both bounds and n are marked, the u64 maximum too.
      assert.equal(value(big).textContent, "≈9007199254740992 [≈−9007199254740992, ≈18446744073709552000] events");
      assert.equal(value(big).getAttribute("title"), note);
      assert.equal(identity(big).textContent, `${missingLevel} · n = ≈9007199254740992`);
      assert.equal(identity(big).getAttribute("title"), note);
      // Exactly 2^53 may itself be a rounded value: marked as well.
      assert.equal(value(pow).textContent, "≈9007199254740992 events");
      assert.equal(identity(pow).textContent, "seed · n = ≈9007199254740992");
      assert.equal(identity(pow).getAttribute("title"), note);
      // A safe n with a sample level, on an excluded entry, is exact.
      assert.equal(identity(safe).textContent, "seed · n = 9007199254740991");
      assert.equal(identity(safe).getAttribute("title"), null);
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});
