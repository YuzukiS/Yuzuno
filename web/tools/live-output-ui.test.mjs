// perf-sse with output on demand: streamed command output appends to the
// tail preview Core sent (detail-patch.ts), and an expanded row's full value
// (item-payload.ts) grows from that preview by exactly what was appended:
// nothing twice, nothing lost, no refetch while the preview covers it.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "live-output-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {payloadLimits} from ${JSON.stringify(path.join(root, "src/item-payload.ts"))};
import {patchDetail} from ${JSON.stringify(path.join(root, "src/detail-patch.ts"))};
const root=createRoot(document.getElementById('root'));
window.payloadLimits=payloadLimits;
window.patchDetail=patchDetail;
window.renderTurns=(list)=>root.render(<>{list.map((props)=><Turn key={props.turn.id} {...props}/>)}</>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "LiveOutput", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, description) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
const agent = { id: "agent-1", name: "Dev", status: "working", color: "sage", harness: "codex" };

test("streamed output into an expanded row's preview extends its full value exactly once", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  // Core's full output, as the payload route reads it at request time.
  let core = Array.from({ length: 3000 }, (_, n) => `build line ${n} ✓\n`).join("");
  window.fetch = async (url) => {
    calls.push(String(url));
    const body = { fields: { aggregatedOutput: core } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  try {
    window.payloadLimits.runningRefetchMs = 60_000;
    const utf8 = (text) => new window.TextEncoder().encode(text).length;
    // What Core's projection sends: a tail preview and the full size.
    const preview = (text) => {
      const bytes = new window.TextEncoder().encode(text);
      return new window.TextDecoder().decode(bytes.subarray(bytes.length - 4000));
    };
    let detail = {
      agent: { ...agent, lastSeq: 1, rev: 10 }, pending: [], artifacts: [],
      turns: [{ id: "t", status: "inProgress", items: [
        { id: "ask", type: "userMessage", content: [{ type: "text", text: "Build it" }] },
        { id: "cmd", type: "commandExecution", command: "cargo build", status: "inProgress",
          aggregatedOutput: preview(core),
          _yuzunoTruncated: { aggregatedOutput: { bytes: utf8(core), lines: 3000, keep: "tail" } } },
      ] }],
    };
    const render = () => window.renderTurns(detail.turns.map((turn, index) => ({ turn, index, agent, onFile() {} })));
    const pre = () => window.document.querySelector('[id="item-cmd"] pre').textContent;
    render();
    const tools = await waitFor(() => window.document.querySelector(".tool-activity"), "tool group");
    assert.equal(tools.open, false);
    assert.equal(window.document.getElementById("item-cmd"), null);
    tools.querySelector(":scope > summary").click();
    const expand = await waitFor(() => [...window.document.querySelectorAll('[id="item-cmd"] button')]
      .find((b) => /^Show full output/.test(b.textContent)), "inspected output preview");
    expand.click();
    await tick();
    assert.equal(pre(), core, "expanded to the full output");
    assert.equal(calls.length, 1);
    // Output streams in: Core appends to its record; the client to its preview.
    let rev = 10;
    for (let n = 0; n < 40; n++) {
      const chunk = n % 5 === 4 ? `progress ${n} — é` : `test ${n} ... ok\n`;
      core += chunk;
      const next = window.patchDetail(detail, {
        type: "agent.delta", agentId: agent.id, rev: ++rev, turnId: "t", itemId: "cmd",
        op: "append", field: "aggregatedOutput", text: chunk,
      });
      assert.ok(next, "the preview takes the append");
      detail = next;
      // Several deltas may render together, as the 100 ms flush batches them.
      if (n % 3 === 2 || n === 39) {
        render();
        await tick();
        assert.equal(pre(), core, `after delta ${n}: the full value grew by exactly what streamed`);
      }
    }
    assert.equal(calls.length, 1, "no refetch while the preview covers what streamed");
    const meta = detail.turns[0].items[1]._yuzunoTruncated.aggregatedOutput;
    assert.equal(meta.bytes, utf8(core));
    // The command finishes: its projected Item arrives whole; the full value
    // is read once more, as for any finished row.
    detail = window.patchDetail(detail, { type: "agent.item", agentId: agent.id, rev: ++rev, turnId: "t", item: {
      ...detail.turns[0].items[1], status: "completed", exitCode: 0,
      aggregatedOutput: preview(core), _yuzunoTruncated: { aggregatedOutput: { bytes: utf8(core), lines: 3032, keep: "tail" } } } });
    render();
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(pre(), core);
  } finally {
    window.close();
  }
});
