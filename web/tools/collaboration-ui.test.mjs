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
