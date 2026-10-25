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
const fixture = await mkdtemp(path.join(cache, "pr-operations-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {PrOperations} from ${JSON.stringify(path.join(root, "src/PrOperations.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderOperations = props => root.render(<PrOperations {...props}/>);`,
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

function mount(handler) {
  const calls = [],
    errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  dom.window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const result = await handler(url, body, init);
    if (result instanceof Error) throw result;
    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(result),
      text: async () => JSON.stringify(result),
    };
  };
  dom.window.eval(bundle);
  return {
    window: dom.window,
    doc: dom.window.document,
    calls,
    errors,
    close: () => dom.window.close(),
  };
}
const operation = {
  id: "operation-1",
  cursor: 1,
  requestId: "accepted",
  attempt: 1,
  status: "completed",
  phase: "completed",
  repository: "owner/repo",
  input: {
    action: "create",
    base: "main",
    head: "feature",
    title: "Ship feature",
    draft: true,
  },
  createdAt: new Date().toISOString(),
  remote: {
    number: 11,
    url: "https://github.com/owner/repo/pull/11",
    title: "Ship feature",
    draft: true,
    state: "open",
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
  },
  candidates: [],
  linked: true,
  notificationRecipient: { id: "dev", name: "Dev" },
  notificationId: "notification-1",
};
const page = (operations) => ({
  operations,
  repositories: [{ id: 7, fullName: "owner/repo" }],
  hasMore: false,
  nextBefore: operations.at(-1)?.cursor ?? null,
});
const button = (p, text) =>
  [...p.doc.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
const article = (p, id) => p.doc.querySelector(`[data-operation-id="${id}"]`);
async function waitFor(f) {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await tick();
  }
  assert.fail("Expected UI state did not appear");
}
function field(p, name, value) {
  const label = [...p.doc.querySelectorAll("label")].find((l) =>
    l.textContent.startsWith(name),
  );
  assert.ok(label, name);
  const el = label.querySelector("input,textarea,select");
  const prototype =
    el.tagName === "SELECT"
      ? p.window.HTMLSelectElement.prototype
      : el.tagName === "TEXTAREA"
        ? p.window.HTMLTextAreaElement.prototype
        : p.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value);
  el.dispatchEvent(
    new p.window.Event(el.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
}
const submit = (p) =>
  p.doc
    .querySelector("form")
    .dispatchEvent(
      new p.window.Event("submit", { bubbles: true, cancelable: true }),
    );

test("lost acceptance retries the same request; updates target a number and omit draft", async () => {
  let attempts = 0,
    operations = [];
  const p = mount((url, body) => {
    if (url.includes("peers_list"))
      return { peers: [{ id: "dev", name: "Dev" }] };
    if (url === "/api/pr-operations" && body) {
      if (++attempts === 1) return new Error("Response lost");
      operations = [{ ...operation, requestId: body.requestId, input: body }];
      return operations[0];
    }
    return page(operations);
  });
  try {
    p.window.renderOperations({ taskId: "T-1", disabled: false });
    await waitFor(
      () =>
        p.doc.querySelector("fieldset") &&
        !p.doc.querySelector("fieldset").disabled,
    );
    field(p, "PR repository", "7");
    field(p, "Head branch", "feature");
    field(p, "PR title", "Literal `title`");
    field(p, "PR body", "Literal $(body)\nsecond line");
    field(p, "PR result recipient", "dev");
    await tick();
    submit(p);
    await waitFor(
      () =>
        p.doc.querySelector('[role="alert"]') &&
        !p.doc.querySelector("fieldset").disabled,
    );
    submit(p);
    await waitFor(() => article(p, operation.id));
    const starts = p.calls.filter((c) => c.url === "/api/pr-operations");
    assert.equal(starts[0].body.requestId, starts[1].body.requestId);
    assert.deepEqual(
      { ...starts[1].body, requestId: undefined },
      {
        taskId: "T-1",
        action: "create",
        repositoryId: 7,
        base: "main",
        head: "feature",
        title: "Literal `title`",
        body: "Literal $(body)\nsecond line",
        draft: true,
        notifyAgentId: "dev",
        requestId: undefined,
      },
    );
    assert.match(
      article(p, operation.id).textContent,
      /Task association at completion: linked/,
    );
    assert.match(
      article(p, operation.id).textContent,
      /Result recorded in mailbox for Dev/,
    );
    field(p, "Action", "update");
    await tick();
    field(p, "PR number", "11");
    await tick();
    submit(p);
    await waitFor(
      () => p.calls.filter((c) => c.url === "/api/pr-operations").length === 3,
    );
    const updated = p.calls
      .filter((c) => c.url === "/api/pr-operations")
      .at(-1).body;
    assert.equal(updated.action, "update");
    assert.equal(updated.number, 11);
    assert.ok(!("draft" in updated));
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("candidate recovery addresses the same operation and late task responses are discarded", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const p = mount((url, body) => {
    if (url.includes("peers_list")) return { peers: [] };
    if (url.includes("T-old")) return pending;
    if (url.endsWith("/check")) return { ...operation, status: "accepted" };
    return page([
      {
        ...operation,
        status: "needs_selection",
        candidates: [operation.remote],
        linked: false,
      },
    ]);
  });
  try {
    p.window.renderOperations({ taskId: "T-old", disabled: false });
    await tick();
    p.window.renderOperations({ taskId: "T-new", disabled: false });
    await waitFor(() => button(p, "Select #11: Ship feature"));
    button(p, "Select #11: Ship feature").click();
    await waitFor(() => p.calls.some((c) => c.url.endsWith("/check")));
    const call = p.calls.find((c) => c.url.endsWith("/check"));
    assert.equal(call.url, "/api/pr-operations/operation-1/check");
    assert.equal(call.body.taskId, "T-new");
    assert.equal(call.body.number, 11);
    assert.ok(!p.calls.some((c) => c.url === "/api/pr-operations"));
    release(page([{ ...operation, id: "wrong-task" }]));
    await tick();
    await tick();
    assert.equal(article(p, "wrong-task"), null);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("refresh covers the loaded older range and keeps expanded evidence and pagination", async () => {
  let records = Array.from({ length: 45 }, (_, i) => ({
    ...operation,
    id: `op-${45 - i}`,
    cursor: 45 - i,
    status: "unknown",
  }));
  const p = mount((url) => {
    if (url.includes("peers_list")) return { peers: [] };
    if (url.includes("/op-23?"))
      return {
        ...records.find((r) => r.id === "op-23"),
        input: { ...operation.input, body: "retained original content" },
        history: [],
      };
    const query = new URL(url, "http://isolated.test").searchParams;
    const before = Number(query.get("before") || Infinity),
      through = Number(query.get("through") || 0);
    const remaining = records.filter((r) => r.cursor < before);
    const visible = through
      ? remaining.filter((r) => r.cursor >= through)
      : remaining.slice(0, 20);
    return { ...page(visible), hasMore: remaining.length > visible.length };
  });
  const timers = new Map();
  let timerId = 0;
  p.window.setInterval = (callback) => {
    timers.set(++timerId, callback);
    return timerId;
  };
  p.window.clearInterval = (id) => timers.delete(id);
  try {
    p.window.renderOperations({ taskId: "T-1", disabled: false });
    await waitFor(() => p.doc.querySelectorAll("article").length === 20);
    button(p, "Older PR operations").click();
    await waitFor(() => article(p, "op-6"));
    const old = article(p, "op-23"),
      details = old.querySelector("details");
    details.open = true;
    await waitFor(() =>
      details.textContent.includes("retained original content"),
    );
    records = [
      { ...operation, id: "op-46", cursor: 46 },
      ...records.map((r) => ({ ...r, status: "completed", attempt: 2 })),
    ];
    [...timers.values()][0]();
    await waitFor(
      () =>
        article(p, "op-46") &&
        !article(p, "op-23").textContent.includes("Outcome unconfirmed"),
    );
    assert.ok(p.calls.some((c) => c.url.endsWith("&through=6")));
    assert.equal(article(p, "op-23"), old);
    assert.equal(details.open, true);
    assert.match(details.textContent, /retained original content/);
    assert.equal(p.doc.querySelectorAll("article").length, 41);
    assert.match(
      details.textContent,
      /detail predates the latest operation result/,
    );
    [...details.querySelectorAll("button")]
      .find((b) => b.textContent === "Refresh operation detail")
      .click();
    await waitFor(() => !details.textContent.includes("detail predates"));
    assert.equal(details.open, true);
    button(p, "Older PR operations").click();
    await waitFor(() => article(p, "op-1"));
    assert.equal(button(p, "Older PR operations"), undefined);
    assert.equal(p.doc.querySelectorAll("article").length, 46);
    [...timers.values()][0]();
    await tick();
    assert.ok(p.calls.some((c) => c.url.endsWith("&through=1")));
    assert.equal(details.open, true);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

// T-189: the operations follow the interface language, changed in another
// window. Branches, titles, bodies, GitHub's and Core's words stay as written.
const speak = (p, language) => {
  p.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  p.window.dispatchEvent(new p.window.StorageEvent("storage", { key: "yuzuno.language" }));
};
const valueOf = (p, name) =>
  [...p.doc.querySelectorAll("label")].find((l) => l.textContent.startsWith(name))?.querySelector("input,textarea,select")?.value;
test("operations follow a language change; the form, open history, a retried request and the notice stay, and nothing is asked again", async () => {
  let attempts = 0;
  const waiting = {
    ...operation, id: "operation-2", cursor: 2, status: "needs_selection", linked: false, outcome: "multiple_matches",
    candidates: [{ ...operation.remote, number: 12, title: "Ship feature again" }],
    associationError: "task link refused: archived", notificationRecipient: null, notificationId: null,
  };
  const detail = { ...waiting, input: { ...waiting.input, body: "" }, writeError: "HTTP 502 from GitHub",
    history: [{ attempt: 1, status: "failed", finishedAt: new Date().toISOString(), error: "gh: timeout" }] };
  const p = mount((url, body) => {
    if (url.includes("peers_list")) return { peers: [{ id: "dev", name: "Dev" }] };
    if (url === "/api/pr-operations" && body) {
      if (++attempts === 1) return new Error("Response lost");
      return { ...operation, id: "operation-3", status: "accepted", requestId: body.requestId };
    }
    if (url.startsWith("/api/pr-operations/operation-2?")) return detail;
    return page([waiting, operation]);
  });
  const history = () => article(p, "operation-2").querySelector("details");
  try {
    p.window.renderOperations({ taskId: "T-1", disabled: false });
    await waitFor(() => p.doc.querySelector("fieldset") && !p.doc.querySelector("fieldset").disabled && article(p, "operation-2"));
    field(p, "PR repository", "7");
    field(p, "Head branch", "feature/zh");
    field(p, "PR title", "中文标题 kept");
    field(p, "PR body", "Body as typed");
    field(p, "PR result recipient", "dev");
    history().open = true;
    await waitFor(() => history().textContent.includes("HTTP 502 from GitHub"));
    await tick();
    submit(p);
    await waitFor(() => p.doc.querySelector('[role="alert"]') && !p.doc.querySelector("fieldset").disabled);
    const before = p.calls.length;
    speak(p, "zh-Hans");
    await tick();
    await tick();
    const section = p.doc.querySelector(".pr-operations");
    assert.equal(section.getAttribute("aria-label"), "PR 操作");
    const text = section.textContent;
    for (const words of [
      "创建或更新 PR", "请选择匹配的 PR", "已完成", "第 1 次尝试", "完成时的任务关联：未关联", "观察到的 head bbbbbbbb · base aaaaaaaa",
      "任务链接：task link refused: archived", "结果只在此任务中显示", "结果已记入 Dev 的邮箱", "操作 ID：operation-2",
      "提交的内容与恢复记录", "提交的标题", "（空）", "写入回复：HTTP 502 from GitHub", "第 1 次尝试：失败 · ", "创建为草稿",
    ]) assert.ok(text.includes(words), words);
    // As written: the repository, action, branches, PR title, GitHub's outcome and Core's error.
    for (const kept of ["owner/repo · create", "feature → main", "#11 Ship feature", "· 草稿 · multiple_matches", "gh: timeout"])
      assert.ok(text.includes(kept), kept);
    assert.ok(button(p, "检查结果 / 修复链接"));
    assert.ok(button(p, "选择 #12：Ship feature again"));
    assert.ok(button(p, "创建或复用 PR"));
    assert.equal(valueOf(p, "PR 仓库"), "7");
    assert.equal(valueOf(p, "Head 分支"), "feature/zh");
    assert.equal(valueOf(p, "PR 标题"), "中文标题 kept");
    assert.equal(valueOf(p, "PR 正文"), "Body as typed");
    assert.equal(valueOf(p, "PR 结果的接收方"), "dev");
    assert.ok(history().open, "the history stays open");
    // Nothing asked of Core: no pr-operations list, detail, start or check, no peers_list.
    assert.deepEqual(p.calls.slice(before).map((c) => c.url), []);
    submit(p);
    await waitFor(() => p.doc.querySelector(".github-notice"));
    const starts = p.calls.filter((c) => c.url === "/api/pr-operations");
    assert.equal(starts.length, 2);
    assert.equal(starts[1].body.requestId, starts[0].body.requestId, "the same request, asked again");
    assert.equal(starts[1].body.title, "中文标题 kept");
    assert.equal(p.doc.querySelector(".github-notice").textContent, "操作 operation-3 · 已接受。关闭此窗口后 Core 会继续。");
    speak(p, "en");
    await tick();
    assert.equal(p.doc.querySelector(".github-notice").textContent, "Operation operation-3 · Accepted. Core continues after this window closes.");
    assert.ok(history().open);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
