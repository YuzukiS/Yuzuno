import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// Tool rows whose output Core sent as a preview fetch the full value on
// request, keep it across snapshot refreshes, and copy it in full.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "output-on-demand-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {payloadLimits} from ${JSON.stringify(path.join(root, "src/item-payload.ts"))};
const root=createRoot(document.getElementById('root'));
window.payloadLimits=payloadLimits;
window.renderTurns=(list)=>root.render(<>{list.map((props)=><Turn key={props.turn.id} {...props}/>)}</>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "OutputOnDemand", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const lines = (prefix, count) => Array.from({ length: count }, (_, n) => `${prefix} ${n}\n`).join("");
const fullOutput = lines("build line", 4000);
const fullDiff = lines("+added", 1500);
const agent = { id: "agent-1", name: "Dev", status: "idle", color: "sage", harness: "codex" };
// What Core sends for a command whose output is over the limit (ASCII, so
// characters and UTF-8 bytes agree).
const command = (output, extra = {}) => ({
  id: "cmd", type: "commandExecution", command: "cargo build", status: "completed", exitCode: 0,
  aggregatedOutput: output.slice(-4000),
  _yuzunoTruncated: { aggregatedOutput: { bytes: output.length, lines: output.split("\n").length - 1, keep: "tail" } },
  ...extra,
});
const turnWith = (items, status = "completed", id = "turn-1") => ({
  id, status,
  items: [{ id: `${id}-ask`, type: "userMessage", content: [{ type: "text", text: "Build it please" }] }, ...items,
    { id: `${id}-reply`, type: "agentMessage", text: "Built.", phase: "final_answer" }],
});

function mount(respond) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  window.fetch = async (url) => {
    calls.push(String(url));
    const { status = 200, body } = await respond(String(url));
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const render = async (...turns) => {
    window.renderTurns(turns.map((turn, index) => ({ turn, index, agent, onFile() {} })));
    await tick();
    // These payload tests inspect rows after the reader opens their group.
    for (const group of window.document.querySelectorAll(".tool-activity"))
      if (!group.open) group.querySelector("summary").click();
    await tick();
  };
  return { window, document: window.document, calls, copied, render, close: () => window.close() };
}
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (page, id, turnId = "turn-1") => page.document.querySelector(`[id="turn-${turnId}"] [id="item-${id}"]`);
const button = (scope, pattern) => [...scope.querySelectorAll("button")].find((node) => pattern.test(node.textContent));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

test("a preview row fetches its full output on request and stays expanded across refreshes", async () => {
  const page = mount(() => ({ body: { fields: { aggregatedOutput: fullOutput } } }));
  try {
    const turn = () => turnWith([command(fullOutput),
      { id: "ls", type: "commandExecution", command: "ls", aggregatedOutput: "Cargo.toml\n", status: "completed" }]);
    await page.render(turn());
    await tick();
    const notice = row(page, "cmd").querySelector(".truncation-notice");
    assert.match(notice.textContent, /Truncated · showing the end of the output\./);
    const show = button(notice, /^Show full output/);
    assert.equal(show.textContent, `Show full output (${kb(fullOutput.length)})`);
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput.slice(-4000));
    assert.ok(row(page, "ls").querySelector(".truncation-notice") === null, "small rows are unchanged");
    assert.equal(page.calls.length, 0, "nothing is fetched before it is asked for");

    show.click();
    await tick();
    assert.deepEqual(page.calls, ["/api/agents/agent-1/items/cmd/payload?turnId=turn-1&field=aggregatedOutput"]);
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput);
    assert.ok(row(page, "cmd").querySelector(".truncation-notice") === null, ".truncation-notice is absent");

    const expanded = row(page, "cmd");
    const group = expanded.closest(".tool-activity");
    group.querySelector("summary").click();
    await tick();
    group.querySelector("summary").click();
    await tick();
    assert.equal(row(page, "cmd"), expanded, "inspected rows survive collapse/reopen");
    assert.equal(expanded.querySelector("pre").textContent, fullOutput);
    assert.equal(page.calls.length, 1, "reopening does not refetch expanded payloads");

    // A snapshot refresh brings the same preview again: the full output stays.
    await page.render(turn());
    await tick();
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput);
    assert.equal(page.calls.length, 1, "an unchanged Item is not fetched again");
    // So it does when the row is rendered anew, as after switching Agents.
    await page.render(turnWith([], "completed", "other-turn"));
    await tick();
    assert.ok(row(page, "cmd") === null, 'no "cmd" row');
    await page.render(turn());
    await tick();
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput);
    assert.equal(page.calls.length, 1);
  } finally {
    page.close();
  }
});

test("a running row grows from its previews, refetches a gap at most every few seconds, and in full when it finishes", async () => {
  let server = fullOutput;
  const page = mount(() => ({ body: { fields: { aggregatedOutput: server } } }));
  try {
    page.window.payloadLimits.runningRefetchMs = 400;
    // Disclosure and React commits need real event-loop turns. Advance only
    // the payload clock explicitly so those turns cannot exhaust the throttle.
    let now = 10000;
    let nextTimer = -1;
    const timers = new Map();
    const setTimeout = page.window.setTimeout.bind(page.window);
    const clearTimeout = page.window.clearTimeout.bind(page.window);
    page.window.Date.now = () => now;
    page.window.setTimeout = (fn, delay = 0, ...args) => {
      if (delay <= 0) return setTimeout(fn, delay, ...args);
      const id = nextTimer--;
      timers.set(id, { at: now + delay, run: () => fn(...args) });
      return id;
    };
    page.window.clearTimeout = (id) => {
      if (!timers.delete(id)) clearTimeout(id);
    };
    const advance = async (ms) => {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
      await tick();
    };
    const running = (output, status = "inProgress") =>
      turnWith([command(output, { status, exitCode: status === "inProgress" ? null : 0 })], status);
    const pre = () => row(page, "cmd").querySelector("pre").textContent;
    await page.render(running(fullOutput));
    await tick();
    button(row(page, "cmd"), /^Show full output/).click();
    await tick();
    assert.equal(pre(), fullOutput);

    // A little more output: the new preview supplies it, nothing is fetched.
    const more = fullOutput + "test a ... ok\n";
    await page.render(running(more));
    await tick();
    assert.equal(pre(), more, "the newest output shows, never the older full value");
    assert.equal(page.calls.length, 1);

    // More than a preview holds: the gap is marked, then fetched once, later.
    const much = more + lines("test b", 1000);
    server = much;
    await page.render(running(much));
    await tick();
    assert.ok(pre().startsWith(more) && pre().endsWith(much.slice(-3000)), "older text is kept and the newest shown");
    assert.match(pre(), /\[… [\d.]+ KB not loaded yet …\]/);
    assert.match(row(page, "cmd").querySelector(".truncation-notice").textContent, /Updating the full output/);
    await page.render(running(much));
    await tick();
    assert.equal(page.calls.length, 1, "a running Item is not refetched on every snapshot");
    await advance(399);
    assert.equal(page.calls.length, 1, "the gap stays throttled before its deadline");
    await advance(1);
    assert.equal(page.calls.length, 2);
    assert.equal(pre(), much);

    // Finished: the final output is read at once.
    server = much + "test result: ok\n";
    await page.render(running(server, "completed"));
    await tick();
    assert.equal(page.calls.length, 3);
    assert.equal(pre(), server);
  } finally {
    page.close();
  }
});

test("the same Item ID in two Turns is fetched, shown and copied for its own Turn", async () => {
  const outputs = { "turn-1": lines("first", 4000), "turn-2": lines("second", 4000) };
  const page = mount((url) => {
    const turnId = new URL(url, "http://x").searchParams.get("turnId") || url.split("/turns/")[1]?.split("/")[0];
    if (url.includes("/turns/")) return { body: { items: { cmd: { fields: { aggregatedOutput: outputs[turnId] } } } } };
    return { body: { fields: { aggregatedOutput: outputs[turnId] } } };
  });
  try {
    await page.render(turnWith([command(outputs["turn-1"])], "completed", "turn-1"), turnWith([command(outputs["turn-2"])], "completed", "turn-2"));
    await tick();
    button(row(page, "cmd", "turn-1"), /^Show full output/).click();
    await tick();
    assert.equal(row(page, "cmd", "turn-1").querySelector("pre").textContent, outputs["turn-1"]);
    assert.equal(row(page, "cmd", "turn-2").querySelector("pre").textContent, outputs["turn-2"].slice(-4000), "the other Turn's row stays a preview");
    button(page.document.querySelector('[id="turn-turn-2"]'), /^Copy turn$/).click();
    await tick();
    assert.ok(page.copied[0].includes(outputs["turn-2"]) && !page.copied[0].includes("first line"));
    assert.equal(page.calls.at(-1), "/api/agents/agent-1/turns/turn-2/payload");
  } finally {
    page.close();
  }
});

test("Copy turn copies every trimmed field in full, or fails visibly", async () => {
  let individual = true;
  const page = mount((url) => {
    if (url.endsWith("/turns/turn-1/payload"))
      return { body: { items: { cmd: { fields: { aggregatedOutput: fullOutput } } } } }; // "edit" is missing
    if (url.includes("/items/edit/payload") && individual)
      return { body: { fields: { changes: [{ path: "src/a.rs", diff: fullDiff }, { path: "src/b.rs", diff: fullDiff }, { path: "logo.png", diff: "" }] } } };
    return { status: 404, body: { error: "This Agent has no Item with that ID", code: "item_not_found" } };
  });
  try {
    const turn = turnWith([command(fullOutput), {
      id: "edit", type: "fileChange", status: "completed",
      changes: [{ path: "src/a.rs", diff: fullDiff.slice(0, 3000) }, { path: "src/b.rs", diff: "" }, { path: "logo.png", diff: "" }],
      _yuzunoTruncated: { changes: { bytes: 2 * fullDiff.length + 90, keep: "head", cutDiffs: [0, 1], omitted: 2 } },
    }]);
    await page.render(turn);
    await tick();
    const edit = row(page, "edit");
    assert.match(edit.querySelector(".truncation-notice").textContent, /showing the start of the diff.*Show full diff/);
    const diffs = [...edit.querySelectorAll("pre")].map((node) => node.textContent);
    assert.equal(diffs[0], fullDiff.slice(0, 3000));
    assert.match(diffs[1], /^Not in the preview/, "a diff left out says so");
    assert.equal(diffs[2], "File changed; no diff supplied.", "a genuinely empty diff says so");
    assert.match(edit.textContent, /2 more files are not in the preview\./);

    const copy = button(page.document, /^Copy turn$/);
    copy.click();
    await tick();
    assert.deepEqual(page.calls, ["/api/agents/agent-1/turns/turn-1/payload",
      "/api/agents/agent-1/items/edit/payload?turnId=turn-1&field=changes"]);
    assert.equal(page.copied.length, 1);
    assert.ok(page.copied[0].includes(`$ cargo build\n${fullOutput}`));
    assert.equal(page.copied[0].split(fullDiff).length - 1, 2, "both full diffs are copied");

    // A fresh page where that Item cannot be read at all: nothing is copied.
    page.close();
    individual = false;
    const failing = mount((url) => url.endsWith("/turns/turn-1/payload")
      ? { body: { items: { cmd: { fields: { aggregatedOutput: fullOutput } } } } }
      : { status: 404, body: { error: "This Agent has no Item with that ID", code: "item_not_found" } });
    try {
      await failing.render(turn);
      await tick();
      const failed = button(failing.document, /^Copy turn$/);
      failed.click();
      await tick();
      assert.equal(failing.copied.length, 0, "a preview is never copied as the whole text");
      assert.equal(failed.textContent, "Copy failed");
      assert.match(failed.title, /couldn't get the full output of 1 item/);
    } finally {
      failing.close();
    }
  } finally {
    page.close();
  }
});

test("labels name the trimmed field, and an expanded row on screen is never evicted", async () => {
  const longCommand = "x".repeat(20_000);
  const page = mount((url) => url.includes("/turns/")
    ? { body: { items: { other: { fields: { aggregatedOutput: lines("other", 4000) } } } } }
    : { body: { fields: { command: longCommand } } });
  try {
    page.window.payloadLimits.keepChars = 10;
    const commandOnly = { id: "cmd", type: "commandExecution", command: longCommand.slice(0, 4000), aggregatedOutput: "", status: "completed",
      _yuzunoTruncated: { command: { bytes: longCommand.length, lines: 1, keep: "head" } } };
    const other = turnWith([{ ...command(lines("other", 4000)), id: "other" }], "completed", "turn-2");
    await page.render(turnWith([commandOnly]), other);
    await tick();
    const notice = row(page, "cmd").querySelector(".truncation-notice");
    assert.match(notice.textContent, /showing the start of the command\.Show full command \(19\.5 KB\)/);
    button(notice, /^Show full command/).click();
    await tick();
    assert.equal(page.calls.length, 1);
    // Copying another Turn fills the (tiny) cache; the row on screen keeps its value.
    button(page.document.querySelector('[id="turn-turn-2"]'), /^Copy turn$/).click();
    await tick();
    await page.render(turnWith([commandOnly]), other);
    await tick();
    assert.equal(row(page, "cmd").querySelector("summary span").textContent, longCommand);
    assert.equal(page.calls.length, 2, "only the copy was fetched; the expanded row was not evicted");
  } finally {
    page.close();
  }
});

test("a failed fetch is reported and can be retried", async () => {
  let fail = true;
  const page = mount(() => fail
    ? { status: 404, body: { error: "This Agent has no Item with that ID", code: "item_not_found" } }
    : { body: { fields: { aggregatedOutput: fullOutput } } });
  try {
    await page.render(turnWith([command(fullOutput)]));
    await tick();
    button(row(page, "cmd"), /^Show full output/).click();
    await tick();
    const notice = row(page, "cmd").querySelector(".truncation-notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.textContent, /Could not load the full output: This Agent has no Item with that ID/);
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput.slice(-4000), "the preview stays");
    fail = false;
    button(notice, /^Try again$/).click();
    await tick();
    assert.equal(row(page, "cmd").querySelector("pre").textContent, fullOutput);
    assert.equal(page.calls.length, 2);
  } finally {
    page.close();
  }
});
