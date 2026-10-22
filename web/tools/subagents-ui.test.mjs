import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-60, moved to the left dock by T-79: Codex sub-agents of the loaded Turns
// as a dock group, a card beside it, and only anchors left in the Turn. The
// real Turn and SubAgentDock in JSDOM, with Core's sub-agent endpoint answered
// here; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "subagents-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {SubAgentDock} from ${JSON.stringify(path.join(root, "src/SubAgents.tsx"))};
const root=createRoot(document.getElementById('root'));
window.navigated=[];
window.renderTurn=(turn,agent)=>flushSync(()=>root.render(<><nav className="work-dock"><SubAgentDock agentId={agent.id} turns={[turn]} onNavigate={(id)=>window.navigated.push(id)}/></nav><Turn turn={turn} index={0} agent={agent} onFile={()=>{}} onAnswer={()=>{}}/></>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "SubAgentsTurn", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const PARENT = "01a1418f-71e0-7150-850d-89ca9fbcb69c";
const A = "01a1418f-8744-7533-af1c-da150088054d";
const B = "01a1418f-9dc3-7f00-98af-5fc645888bb8";
const agent = (status = "working") => ({
  id: "a",
  name: "Mori",
  harness: "codex",
  color: "sage",
  status,
  cwd: "/w",
  goal: "",
  model: "",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 0,
  reviewedSeq: 0,
});
const activity = (kind, child, path) => ({
  type: "subAgentActivity",
  kind,
  agentThreadId: child,
  agentPath: path,
  id: kind === "started" ? `call_${path}` : `subagent-${kind}-${child}`,
  model: kind === "started" ? "gpt-6-astra" : null,
});
const turn = (status, extra = []) => ({
  id: "t",
  status,
  items: [
    {
      id: "u",
      type: "userMessage",
      content: [{ type: "text", text: "Use two sub-agents" }],
    },
    {
      id: "m1",
      type: "agentMessage",
      phase: "commentary",
      text: "I'll start both sub-agents.",
    },
    activity("started", A, "/root/alpha"),
    activity("started", B, "/root/beta"),
    ...extra,
  ],
});
const detail = (child, over) => ({
  threadId: child,
  parentThreadId: PARENT,
  nickname: child === A ? "Sartre" : "Kant",
  role: null,
  path: child === A ? "/root/alpha" : "/root/beta",
  depth: 1,
  model: "gpt-6-astra",
  status: "idle",
  turn: { id: "ct", status: "completed", error: null },
  result: { text: "ALPHA", truncated: false },
  readFrom: "live",
  readAt: "2026-10-15T21:55:00Z",
  ...over,
});
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function mount(respond) {
  const errors = [],
    requests = [],
    vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://isolated.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole: vc,
    },
  );
  const { window } = dom;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.fetch = async (url, init = {}) => {
    const pathname = decodeURIComponent(
      new URL(String(url), window.location.href).pathname,
    );
    requests.push({ url: pathname, method: init.method || "GET" });
    const { status = 200, body = {} } = (await respond(pathname)) ?? {};
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  window.eval(bundle);
  const document = window.document;
  // The dock's nodes, in the order shown, and the card beside them.
  const nodes = () => [...document.querySelectorAll(".conversation-subagent")];
  const node = (label) =>
    nodes().find((n) => n.querySelector(".work-dock-label strong").textContent === label);
  const card = () => document.querySelector(".subagent-card");
  const cardButton = (text) =>
    [...(card()?.querySelectorAll("button") || [])].find((b) =>
      (b.getAttribute("aria-label") || b.textContent).includes(text),
    );
  return {
    window,
    document,
    errors,
    requests,
    nodes,
    node,
    card,
    cardButton,
    close: () => window.close(),
  };
}

test("two children: one to confirm, one ended; each opens its own card, read only when opened", async (t) => {
  const page = mount((url) =>
    url === `/api/agents/a/subagents/${A}`
      ? { body: detail(A) }
      : url === `/api/agents/a/subagents/${B}`
        ? {
            body: detail(B, {
              status: "active",
              turn: { id: "bt", status: "inProgress", error: null },
              result: null,
            }),
          }
        : { status: 404 },
  );
  t.after(page.close);
  page.window.renderTurn(
    turn("inProgress", [activity("completed", A, "/root/alpha")]),
    agent(),
  );
  // The child still to confirm first, then the latest.
  assert.deepEqual(
    page.nodes().map((n) => [n.querySelector(".work-dock-label strong").textContent, n.className.match(/state-(\w+)/)[1]]),
    [["beta", "running"], ["alpha", "ended"]],
  );
  assert.deepEqual(
    page.nodes().map((n) => n.getAttribute("aria-label")),
    ["beta · Started · status to confirm · /root/beta · gpt-6-astra", "alpha · Ended · /root/alpha · gpt-6-astra"],
    "never called running or successful from the dock alone",
  );
  assert.ok(
    page.document.querySelector(".work-dock-group[aria-label='Sub-agents']"),
    "a group of the dock",
  );
  assert.deepEqual(page.requests, [], "nothing is read until a node is opened");
  assert.ok(page.document.querySelector(".subagents") === null, "no sub-agent block in the Turn");
  for (const id of [
    `call_/root/alpha`,
    `subagent-completed-${A}`,
    `call_/root/beta`,
  ])
    assert.ok(
      page.document.getElementById(`item-${id}`) !== null,
      `native Item ${id} keeps its anchor`,
    );
  assert.ok(page.card() === null, "no card before opening");

  page.node("alpha").click();
  await until(() => page.card()?.querySelector(".subagent-answer"), "alpha's details");
  assert.equal(page.card().getAttribute("aria-label"), "Sub-agent alpha");
  assert.match(page.card().textContent, /Name\s*Sartre/);
  assert.match(page.card().textContent, /Answer\s*ALPHA/);
  assert.match(
    page.card().textContent,
    /Latest turn\s*Completed/,
    "success comes from the child's own Turn",
  );
  assert.match(page.card().textContent, /Goal\s*Not provided by this Codex version/);
  assert.match(page.card().textContent, new RegExp(A));

  page.node("beta").click();
  await until(() => page.card()?.textContent.includes("Kant") && page.card().querySelector(".subagent-answer"), "beta's details");
  assert.match(page.card().textContent, /Latest turn\s*In progress/);
  assert.match(page.card().textContent, /Thread\s*Working/);
  assert.match(page.card().textContent, /No answer yet/);
  assert.deepEqual(
    page.requests.map((r) => r.url),
    [`/api/agents/a/subagents/${A}`, `/api/agents/a/subagents/${B}`],
  );
  assert.ok(
    page.requests.every((r) => r.method === "GET"),
    "read only",
  );
  const reply = page.document.querySelector(".commentary").textContent;
  assert.doesNotMatch(
    reply,
    /ALPHA/,
    "a child's answer is not mixed into the Agent's reply",
  );
  page.cardButton("Go to its Turn").click();
  await tick();
  // jsdom's array, copied into this realm before comparing.
  assert.deepEqual([...page.window.navigated], ["t"]);
  assert.ok(page.card() === null, "going to the Turn closes the card");
  assert.deepEqual(page.errors, []);
});

test("an ended Turn without a completion says unknown; a failed read keeps the card and can be read again", async (t) => {
  let fail = true;
  const page = mount((url) =>
    fail
      ? {
          status: 404,
          body: { error: "This Agent's Turns do not record that sub-agent" },
        }
      : url.endsWith(B)
        ? { body: detail(B) }
        : { status: 404 },
  );
  t.after(page.close);
  page.window.renderTurn(turn("completed"), agent("idle"));
  assert.deepEqual(
    page.nodes().map((n) => [n.className.match(/state-(\w+)/)[1], n.querySelector(".work-dock-label small").textContent]),
    [["unconfirmed", "Status unknown"], ["unconfirmed", "Status unknown"]],
  );
  page.node("beta").click();
  await until(() => page.card()?.querySelector("[role=alert]"), "the read error");
  assert.match(page.card().textContent, /do not record that sub-agent/);
  fail = false;
  page.cardButton("Read again").click();
  await until(() => page.card()?.querySelector(".subagent-answer"), "details after reading again");
  page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick();
  assert.ok(page.card() === null, "Escape closes the card");
  assert.deepEqual(page.errors, []);
});

test("a child whose own Turn failed says so, with Codex's error, though the dock only says Ended", async (t) => {
  const page = mount((url) =>
    url.endsWith(A)
      ? {
          body: detail(A, {
            turn: { id: "ct", status: "failed", error: "Model error" },
            result: null,
          }),
        }
      : { status: 404 },
  );
  t.after(page.close);
  page.window.renderTurn(
    turn("completed", [activity("completed", A, "/root/alpha")]),
    agent("idle"),
  );
  assert.equal(page.node("alpha").querySelector(".work-dock-label small").textContent, "Ended");
  page.node("alpha").click();
  await until(() => page.card()?.querySelector(".subagent-answer"), "the failed child's details");
  assert.match(page.card().textContent, /Latest turn\s*Failed/);
  assert.match(page.card().querySelector("[role=alert]").textContent, /Model error/);
  assert.deepEqual(page.errors, []);
});

test("more than five children: five on the dock, the rest behind its list, every child reachable", async (t) => {
  const ids = Array.from({ length: 7 }, (_, n) => `child-${n}`);
  const page = mount((url) => {
    const id = url.split("/").at(-1);
    return ids.includes(id) ? { body: detail(id, { threadId: id, nickname: `Nick ${id}`, path: `/root/c${id.at(-1)}` }) } : { status: 404 };
  });
  t.after(page.close);
  page.window.renderTurn(
    {
      id: "t",
      status: "completed",
      items: ids.flatMap((id, n) => [activity("started", id, `/root/c${n}`), activity("completed", id, `/root/c${n}`)]),
    },
    agent("idle"),
  );
  assert.deepEqual(
    page.nodes().map((n) => n.querySelector(".work-dock-label strong").textContent),
    ["c6", "c5", "c4", "c3", "c2"],
    "the latest five",
  );
  const more = page.document.querySelector(".work-dock-more");
  assert.equal(more.getAttribute("aria-label"), "Sub-agents: 2 more, open the list");
  more.click();
  await tick();
  assert.equal(page.card().getAttribute("aria-label"), "Sub-agents in this conversation");
  const listed = [...page.card().querySelectorAll(".subagent-card-list strong")].map((s) => s.textContent);
  assert.deepEqual(listed, ["c6", "c5", "c4", "c3", "c2", "c1", "c0"]);
  // Each way between the list and a child removes the button that had focus;
  // focus stays in the card.
  const oldest = [...page.card().querySelectorAll(".subagent-card-list button")].at(-1);
  oldest.focus();
  oldest.click();
  await until(() => page.card()?.querySelector(".subagent-answer"), "the oldest child's details");
  assert.match(page.card().textContent, /Nick child-0/);
  assert.ok(page.card().contains(page.document.activeElement), "choosing a child keeps focus in the card");
  const back = page.cardButton("All sub-agents");
  back.focus();
  back.click();
  await tick();
  assert.equal(page.card().querySelectorAll(".subagent-card-list li").length, 7);
  assert.ok(page.card().contains(page.document.activeElement), "going back keeps focus in the card");
  assert.match(page.document.activeElement.textContent, /^c0/, "back on the list, at the child just read");
  assert.deepEqual(page.requests.map((r) => r.url), ["/api/agents/a/subagents/child-0"]);
  assert.deepEqual(page.errors, []);
});

test("a Turn without sub-agents puts nothing on the dock", async (t) => {
  const page = mount(() => ({ status: 404 }));
  t.after(page.close);
  page.window.renderTurn(
    {
      id: "t",
      status: "completed",
      items: [
        {
          id: "u",
          type: "userMessage",
          content: [{ type: "text", text: "Hi" }],
        },
        { id: "m", type: "agentMessage", text: "Hello" },
      ],
    },
    agent("idle"),
  );
  assert.ok(page.document.querySelector(".work-dock-group") === null, "no sub-agent group");
  assert.ok(page.document.querySelector(".subagents") === null, "no sub-agent section");
  assert.deepEqual(page.requests, []);
});
