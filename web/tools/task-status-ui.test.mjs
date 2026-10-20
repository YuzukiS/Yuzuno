// T-39: the card for a task status change an Agent proposed. It shows the
// task as Core read it and the proposal; the user may change the status and
// reason, then confirm or decline; it shows Core's outcome.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "../target/t39/unit");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "card-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom'; import {createRoot} from 'react-dom/client';
import {TaskStatusCard} from ${JSON.stringify(path.join(root, "src/intelligent-ui/TaskStatusProposal.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderCard=(props)=>flushSync(()=>root.render(<TaskStatusCard {...props}/>));`,
  );
  const result = await build({
    root,
    resolve: {
      alias: {
        react: path.join(root, "node_modules/react"),
        "react-dom": path.join(root, "node_modules/react-dom"),
      },
    },
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "TaskStatusFixture", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const proposal = { taskId: "T-88", status: "review", reason: "Merged, but cross-host acceptance is still open" };
const task = { id: "T-88", title: "Independent Core", status: "doing", version: 4, blocker: "", assignee: "Dev 3", archived: false };
const view = (patch = {}) => ({ resultId: "r1", agentId: "a", proposal, task, blocked: null, attempts: [], ...patch });
const attempt = (patch) => ({
  requestId: "c1", action: "confirm", status: "review", reason: proposal.reason, expectedVersion: 4,
  state: "applied", error: null, taskVersion: 5, by: { name: "You" }, at: "now", ...patch,
});

function mount() {
  const errors = [];
  const logs = new VirtualConsole();
  logs.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://card.test", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: logs,
  });
  const { window } = dom;
  window.eval(bundle);
  const text = () => window.document.body.textContent;
  return {
    window, document: window.document, errors, text,
    close: () => window.close(),
    render: (props) => window.renderCard({ proposal, view: view(), ...props }),
    buttons: () => [...window.document.querySelectorAll("button")].map((b) => b.textContent.trim()),
    button: (label) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label),
    choose: (value) => {
      const select = window.document.querySelector("select");
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(select, value);
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
  };
}

test("shows Core's task beside the proposal and confirms exactly what the user chose", async () => {
  const page = mount();
  const decided = [];
  try {
    page.render({ onDecide: (d) => decided.push(JSON.parse(JSON.stringify(d))) });
    await tick();
    assert.match(page.text(), /Proposed change to T-88 · Independent Core/);
    assert.match(page.text(), /NowDoing · version 4 · Dev 3/);
    assert.match(page.text(), /Agent proposesIn review: Merged, but cross-host acceptance is still open/);
    assert.match(page.text(), /T-88 goes from Doing to In review\./);
    assert.deepEqual(page.buttons(), ["Change T-88 to In review", "Decline"]);
    page.button("Change T-88 to In review").click();
    await tick();
    assert.deepEqual(decided, [{ action: "confirm", status: "review", reason: proposal.reason, expectedVersion: 4 }]);
    // The user changes it: blocked, with the reason as the blocker.
    page.choose("blocked");
    await tick();
    assert.match(page.text(), /Its blocker becomes your reason\./);
    assert.match(page.text(), /You changed the Agent’s proposal\./);
    page.button("Change T-88 to Blocked").click();
    assert.equal(decided.at(-1).status, "blocked");
    // Closing the task says so; the task's own status cannot be confirmed.
    page.choose("done");
    await tick();
    assert.match(page.text(), /This closes T-88\. Only confirm it if the work is really finished\./);
    page.choose("doing");
    await tick();
    assert.match(page.text(), /T-88 is already Doing\./);
    assert.equal(page.button("Change T-88 to Doing").disabled, true);
    page.button("Decline").click();
    assert.deepEqual(decided.at(-1), { action: "decline" });
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("shows Core's outcome: applied, declined, refused as stale, unanswered and not decidable", async () => {
  const page = mount();
  try {
    page.render({ view: view({ attempts: [attempt({})] }) });
    await tick();
    assert.match(page.text(), /You confirmed it: T-88 is now In review \(version 5\)\./);
    assert.deepEqual(page.buttons(), []);
    page.render({ view: view({ attempts: [attempt({ action: "decline", state: "declined", status: null, taskVersion: null })] }) });
    await tick();
    assert.match(page.text(), /You declined it\. T-88 was not changed by this proposal\./);
    // Refused because the task changed: the newer facts are shown, nothing changed.
    const stale = attempt({ state: "failed", taskVersion: null, error: "version_conflict: expected 4, current 5. Read the task before updating it" });
    page.render({ view: view({ task: { ...task, version: 5 }, attempts: [stale] }), mine: "c1", onDecide: () => {} });
    await tick();
    assert.match(page.text(), /T-88 changed while you were deciding \(now version 5, Doing\)\. Nothing was changed\./);
    assert.equal(page.button("Change T-88 to In review").disabled, false, "it can be confirmed again on the new version");
    // Core's answer was lost: only the same decision can be sent again.
    page.render({ unanswered: { requestId: "c2", action: "confirm", status: "review", expectedVersion: 5 }, onDecide: () => {}, onCheck: () => {} });
    await tick();
    assert.match(page.text(), /Core’s answer to your confirmation was lost/);
    assert.equal(page.button("Change T-88 to In review").disabled, true);
    assert.equal(page.button("Check again").disabled, false);
    page.render({ view: view({ blocked: "The Agent replaced this proposal with a newer version; decide that one instead." }) });
    await tick();
    assert.match(page.text(), /replaced this proposal/);
    assert.deepEqual(page.buttons(), []);
    page.render({ view: null, readOnly: "Ask the Agent to publish this proposal with result_publish so you can confirm it here." });
    await tick();
    assert.match(page.text(), /Ask the Agent to publish this proposal/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
