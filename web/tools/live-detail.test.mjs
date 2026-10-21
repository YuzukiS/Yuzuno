// perf-sse: streamed changes patch the shown detail in place; reads and the
// stream are reconciled by journal position. Pure modules, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { patchDetail, PREVIEW, TRIM_ABOVE } from "../src/detail-patch.ts";
import { DetailSync } from "../src/detail-sync.ts";
import { parseWorkspaceEvent } from "../src/workspace-events.ts";

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function detail(revision = 10, items = undefined, lastSeq = 100) {
  return {
    agent: { id: "a", name: "A", rev: revision, lastSeq, reviewedSeq: 0, unreadCount: 0, status: "working" },
    pending: [],
    artifacts: [],
    turns: [
      { id: "t0", status: "completed", items: [{ id: "old", type: "agentMessage", text: "Earlier." }] },
      {
        id: "t1",
        status: "inProgress",
        items: items ?? [
          { id: "u", type: "userMessage", _yuzunoSource: "peer", _yuzunoMailbox: { version: 1, priority: "normal", groups: [{ kind: "job", status: "failed", count: 1, name: "Tests" }] }, content: [] },
          { id: "m", type: "agentMessage", text: "Hel" },
          { id: "r", type: "reasoning", summary: ["One"] },
          { id: "c", type: "commandExecution", aggregatedOutput: null },
        ],
      },
    ],
  };
}
const delta = (rev, itemId, field, text, extra = {}) => ({
  type: "agent.delta", agentId: "a", rev, turnId: "t1", itemId, op: "append", field, text, ...extra,
});
const item = (rev, value, extra = {}) => ({ type: "agent.item", agentId: "a", rev, turnId: "t1", item: value, ...extra });
const text = (d, id) => d.turns[1].items.find((i) => i.id === id);

test("saved body windows keep middle reading separate from live arrivals and bound a growing turn", () => {
  const base = detail();
  base.conversation = {index:[], hasAfter:true, hasBefore:true, start:'["t0","old"]', end:'["t1","c"]', totalItems:1000};
  assert.equal(patchDetail(base, delta(11,"not-loaded","text","new")),base);
  assert.equal(patchDetail(base,item(11,{id:"new",type:"agentMessage",text:"new"})),base);
  const artifacts = [{path:"new.md",name:"new.md",kind:"text"}];
  for (const turnId of ["t1", "unloaded-turn"]) {
    const changed = patchDetail(base,item(11,{id:"new",type:"fileChange"},{turnId,artifacts}));
    assert.deepEqual(changed.artifacts,artifacts,"file metadata updates even outside the body window");
    assert.equal(changed.turns,base.turns,"the reader's body is unchanged");
    assert.deepEqual(base.artifacts,[],"the prior detail is not mutated");
  }
  assert.equal(text(patchDetail(base,delta(11,"m","text","lo")),"m").text,"Hello");
  base.conversation.hasAfter = false;
  base.turns[1].items = Array.from({length:95},(_,i)=>({id:`i${i}`,type:"agentMessage",text:"x"}));
  assert.equal(patchDetail(base,item(11,{id:"overflow",type:"agentMessage",text:"new"})),null,"refetch a bounded tail instead of retaining another row");
  base.turns[1].items = [{id:"m",type:"agentMessage",text:"x".repeat(32*1024-100)}];
  assert.equal(patchDetail(base,delta(11,"m","text","x".repeat(200))),null,"huge item returns to explicit original preview");
});

test("a running sub-agent Core listed from outside the window is read again when it changes, never placed among the loaded Items", () => {
  // T-26: its call is earlier than the loaded slice, or in a Turn not loaded.
  // Appended at the end it would be out of place; while reading history,
  // left alone it would go stale.
  const running = [{turnId:"t1", position:[1,0], item:{id:"agent-bg",type:"historyPreview",status:"completed",name:"Agent",
    subAgent:{status:"running",background:true}}}];
  const ended = item(11,{id:"agent-bg",type:"claudeToolUse",name:"Agent",status:"completed",subAgent:{status:"completed",background:true}});
  for (const hasAfter of [false, true]) {
    const base = detail();
    base.conversation = {index:[], hasAfter, hasBefore:true, start:'["t0","old"]', end:'["t1","c"]', totalItems:1000, runningSubAgents:running};
    assert.equal(patchDetail(base, ended), null, `read again (hasAfter ${hasAfter})`);
  }
  const base = detail();
  base.conversation = {index:[], hasAfter:false, hasBefore:true, start:'["t0","old"]', end:'["t1","c"]', totalItems:1000, runningSubAgents:running};
  assert.equal(text(patchDetail(base,item(11,{id:"new",type:"agentMessage",text:"new"})),"new").text,"new", "a new Item is placed as before");
});

test("changing body window cancels an older read without clearing the reading view", async () => {
  const requests = [], shown = [];
  const sync = new DetailSync({fetch:(_id,signal)=>new Promise(resolve=>requests.push({resolve,signal})),publish:d=>shown.push(d),error:()=>{}});
  sync.select("a");
  requests[0].resolve(detail());
  await pause();
  sync.refetch({now:true});
  const navigating = sync.reloadWindow();
  assert.equal(requests[1].signal.aborted,true);
  assert.ok(shown.at(-1),"keep reading view until its replacement is ready");
  requests[2].resolve({...detail(12),turns:[{id:"older",items:[]}]});
  await navigating;
  requests[1].resolve(detail(11));
  await pause();
  assert.equal(sync.current.turns[0].id,"older");
  sync.dispose();
});

test("appends extend a string or one string of an array, as Core applied them", () => {
  const base = detail();
  const once = patchDetail(base, delta(11, "m", "text", "lo"));
  assert.equal(text(once, "m").text, "Hello");
  assert.equal(text(base, "m").text, "Hel", "the input is never mutated");
  assert.equal(once.turns[0], base.turns[0], "untouched Turns keep their identity");
  assert.equal(text(once, "r"), text(base, "r"), "untouched Items keep their identity");
  // Output that started as null, like a native command Item.
  assert.equal(text(patchDetail(base, delta(11, "c", "aggregatedOutput", "out\n")), "c").aggregatedOutput, "out\n");
  // A new summary part pads with "" up to its index.
  const parts = patchDetail(patchDetail(base, delta(11, "r", "summary", "", { index: 2 })), delta(12, "r", "summary", "Three", { index: 2 }));
  assert.deepEqual(text(parts, "r").summary, ["One", "", "Three"]);
  assert.deepEqual(text(patchDetail(base, delta(11, "r", "summary", " more", { index: 0 })), "r").summary, ["One more"]);
});

test("command output becomes and stays a tail preview, as Core projects it", () => {
  const utf8 = (text) => new TextEncoder().encode(text).length;
  const lines = (text) => (text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith("\n") ? 1 : 0);
  let d = detail(10, [{ id: "c", type: "commandExecution", status: "inProgress", aggregatedOutput: null }]);
  let full = "";
  // Multi-byte text and a line split across deltas.
  const chunks = Array.from({ length: 400 }, (_, n) => (n % 7 === 3 ? `part ${n} — é ` : `line ${n} ✓ ok\n`));
  for (const [n, chunk] of chunks.entries()) {
    d = patchDetail(d, delta(11 + n, "c", "aggregatedOutput", chunk));
    full += chunk;
    const item = text(d, "c");
    const meta = item._yuzunoTruncated?.aggregatedOutput;
    if (utf8(full) <= TRIM_ABOVE) {
      assert.equal(item.aggregatedOutput, full, "small output stays whole");
      assert.equal(meta, undefined);
      continue;
    }
    assert.ok(meta, `trimmed once over ${TRIM_ABOVE} bytes`);
    assert.deepEqual(meta, { bytes: utf8(full), lines: lines(full), keep: "tail" });
    assert.ok(utf8(item.aggregatedOutput) <= PREVIEW && full.endsWith(item.aggregatedOutput), "a tail of the full output");
  }
  // An approval that refers to the command keeps it whole, as Core does.
  let asked = detail(10, [{ id: "c", type: "commandExecution", aggregatedOutput: "" }]);
  asked.pending = [{ id: "p", method: "item/commandExecution/requestApproval", params: { itemId: "c" } }];
  asked = patchDetail(asked, delta(11, "c", "aggregatedOutput", "x".repeat(20_000)));
  assert.equal(text(asked, "c").aggregatedOutput.length, 20_000);
  // A head preview cannot take an append: refetch.
  const head = detail(10, [{ id: "o", type: "dynamicToolCall", output: "start", _yuzunoTruncated: { output: { bytes: 99_999, keep: "head" } } }]);
  assert.equal(patchDetail(head, delta(11, "o", "output", "more")), null);
});

test("upserts insert or replace one Item and keep its mailbox provenance", () => {
  const base = detail();
  const added = patchDetail(base, item(11, { id: "n", type: "agentMessage", text: "New" }));
  assert.deepEqual(added.turns[1].items.map((i) => i.id), ["u", "m", "r", "c", "n"]);
  const replaced = patchDetail(base, item(11, { id: "m", type: "agentMessage", text: "Hello!", phase: "final_answer" }));
  assert.deepEqual(text(replaced, "m"), { id: "m", type: "agentMessage", text: "Hello!", phase: "final_answer" });
  assert.deepEqual(replaced.turns[1].items.map((i) => i.id), ["u", "m", "r", "c"], "order kept");
  const user = patchDetail(base, item(11, { id: "u", type: "userMessage", content: [{ type: "text", text: "x" }] }));
  assert.equal(text(user, "u")._yuzunoSource, "peer");
  assert.deepEqual(text(user, "u")._yuzunoMailbox, text(base, "u")._yuzunoMailbox);
  const withFiles = patchDetail(base, item(11, { id: "w", type: "fileChange" }, { artifacts: [{ path: "a.md", name: "a.md", kind: "text" }] }));
  assert.deepEqual(withFiles.artifacts.map((a) => a.path), ["a.md"]);
  const usage = { usedTokens: 5, windowTokens: 10, usedPercent: 50, turnId: "t1", updatedAt: "", stale: false };
  assert.deepEqual(patchDetail(base, { type: "agent.context", agentId: "a", rev: 11, contextUsage: usage }).contextUsage, usage);
  const limits = { rateLimits: { status: "allowed" }, rateLimitsAt: "now" };
  const runtime = patchDetail({ ...base, contextUsage: usage }, { type: "agent.context", agentId: "a", rev: 12, claudeRuntime: limits });
  assert.deepEqual(runtime.claudeRuntime, limits);
  assert.deepEqual(runtime.contextUsage, usage, "a field not sent is kept");
});

test("a change this copy cannot place asks for a refetch", () => {
  const base = detail();
  assert.equal(patchDetail(base, delta(11, "missing", "text", "x")), null, "unknown Item");
  assert.equal(patchDetail(base, { ...item(11, { id: "n", type: "x" }), turnId: "other" }), null, "unknown Turn");
  assert.equal(patchDetail(base, delta(11, "r", "summary", "x")), null, "not a string");
  assert.equal(patchDetail(base, delta(11, "m", "text", "x", { index: 0 })), null, "not an array");
});

test("stream messages parse into kinds, and older notices keep working", () => {
  assert.equal(parseWorkspaceEvent(JSON.stringify(delta(3, "m", "text", "x"))).type, "agent.delta");
  assert.deepEqual(parseWorkspaceEvent('{"agentId":"a"}'), { type: "agent.changed", agentId: "a", lastSeq: null });
  assert.deepEqual(parseWorkspaceEvent('{"type":"agent.changed","agentId":"a","rev":9,"lastSeq":7}'), { type: "agent.changed", agentId: "a", rev: 9, lastSeq: 7 });
  assert.deepEqual(parseWorkspaceEvent('{"type":"workspace.changed","scope":"runtime","runtime":true}'), { type: "workspace.changed", scope: "runtime" });
  assert.deepEqual(parseWorkspaceEvent('{"refresh":true}'), { type: "reset", reason: "refresh" });
  assert.deepEqual(parseWorkspaceEvent('{"collaboration":true}'), { type: "workspace.changed", scope: "collaboration" });
  assert.deepEqual(parseWorkspaceEvent('{"type":"workspace.changed","scope":"machines","machines":true}'), { type: "workspace.changed", scope: "machines" });
  // A malformed streamed change is still a change to its Agent.
  assert.deepEqual(parseWorkspaceEvent('{"type":"agent.delta","agentId":"a","rev":"x"}'), { type: "agent.changed", agentId: "a", lastSeq: null });
  assert.equal(parseWorkspaceEvent("not json").type, "reset");
  assert.equal(parseWorkspaceEvent('{"type":"something.new"}').type, "reset");
  assert.equal(parseWorkspaceEvent('{"type":"resumed","from":"e-1"}').type, "resumed");
});

/** A DetailSync over a scripted Core: each read answers with `reads[i]`. */
function lab(reads, retryDelayMs = 30) {
  const calls = [];
  const shown = [];
  const errors = [];
  const pendingReads = [];
  const sync = new DetailSync({
    refetchDelayMs: 5,
    flushDelayMs: 5,
    retryDelayMs,
    fetch: (agentId, signal) => {
      calls.push({ agentId, signal });
      const next = reads.shift();
      if (next === "hold") return new Promise((resolve, reject) => pendingReads.push({ resolve, reject, signal }));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(structuredClone(next));
    },
    publish: (d) => shown.push(d),
    error: (e) => errors.push(e),
  });
  return { sync, calls, shown, errors, pendingReads, last: () => shown.at(-1) };
}

test("streamed changes render in place without reading the detail again", async () => {
  const l = lab([detail(10)]);
  l.sync.select("a");
  await pause();
  assert.equal(l.calls.length, 1);
  for (const [rev, part] of [[11, "lo"], [12, " wo"], [13, "rld"]]) l.sync.push(delta(rev, "m", "text", part));
  l.sync.push({ ...delta(14, "m", "text", "!"), agentId: "b" }); // another Agent: ignored
  await pause();
  assert.equal(text(l.last(), "m").text, "Hello world");
  assert.equal(l.calls.length, 1, "no refetch for streamed text");
  assert.ok(l.shown.length <= 3, "changes are rendered in batches");
  // Streamed text never moves the read receipt position: only reads do.
  assert.equal(l.last().agent.lastSeq, 100);
});

test("changes that arrive during a read are applied once: earlier ones are in it", async () => {
  const l = lab(["hold"]);
  l.sync.select("a");
  l.sync.push(delta(11, "m", "text", "lo"));
  l.sync.push(delta(12, "m", "text", " wo"));
  l.sync.push(delta(13, "m", "text", "rld"));
  await pause();
  // The read was taken after revision 12 was applied in Core, before 13.
  const read = detail(12);
  text(read, "m").text = "Hello wo";
  l.pendingReads[0].resolve(read);
  await pause();
  assert.equal(text(l.last(), "m").text, "Hello world");
  // Several messages can share one revision (one native event).
  l.sync.push(item(14, { id: "m", type: "agentMessage", text: "Hello world", _yuzunoCompletedText: "Hello world" }));
  l.sync.push(item(14, { id: "t", type: "claudeToolUse", status: "inProgress" }));
  await pause();
  assert.deepEqual(l.last().turns[1].items.map((i) => i.id), ["u", "m", "r", "c", "t"]);
  assert.equal(text(l.last(), "m")._yuzunoCompletedText, "Hello world");
});

test("an unknown Item is refetched; nothing is applied twice", async () => {
  const l = lab([detail(10), "hold"]);
  l.sync.select("a");
  await pause();
  l.sync.push(delta(11, "new", "text", "x"));
  l.sync.push(delta(12, "m", "text", "lo"));
  await pause();
  assert.equal(l.calls.length, 2, "one refetch");
  assert.equal(text(l.last(), "m").text, "Hello", "later known changes still show");
  l.sync.push(delta(13, "m", "text", "!"));
  const read = detail(12, undefined, 140);
  read.turns[1].items.push({ id: "new", type: "agentMessage", text: "x" });
  text(read, "m").text = "Hello";
  l.pendingReads[0].resolve(read);
  await pause();
  assert.equal(text(l.last(), "new").text, "x");
  assert.equal(text(l.last(), "m").text, "Hello!", "only the change after the read is applied again");
  assert.equal(l.last().agent.lastSeq, 140, "the read's position");
});

test("change notices share one read; a failed read is retried after its backoff, not per change", async () => {
  const l = lab([detail(10), new Error("Core busy"), detail(20)], 120);
  l.sync.select("a");
  await pause();
  for (let n = 0; n < 5; n++) l.sync.refetch();
  await pause();
  assert.equal(l.calls.length, 2, "five notices, one read");
  assert.equal(l.errors.at(-1)?.message, "Core busy");
  // Changes keep arriving, some for Items this copy lacks: no read before the retry.
  for (let n = 0; n < 10; n++) {
    l.sync.push(delta(30 + n, "unknown", "text", "x"));
    l.sync.refetch();
    await pause(5);
  }
  assert.equal(l.calls.length, 2, "backoff is respected while reads fail");
  await pause(150);
  assert.equal(l.calls.length, 3, "retried once after the backoff");
  assert.equal(l.errors.at(-1), null);
  // A read asked for now (a reset, a poll, the user's action) does not wait.
  const l2 = lab([detail(10), new Error("Core busy"), detail(20)], 10_000);
  l2.sync.select("a");
  await pause();
  l2.sync.refetch({ now: true });
  await pause();
  l2.sync.refetch({ now: true });
  await pause();
  assert.equal(l2.calls.length, 3);
  assert.equal(l2.last().agent.rev, 20);
  l2.sync.dispose();
});

test("switching Agents drops the old read; failures are retried", async () => {
  const l = lab(["hold", new Error("Core busy"), detail(10)]);
  l.sync.select("a");
  await pause();
  l.sync.select("b");
  assert.ok(l.calls[0].signal.aborted);
  l.pendingReads[0].resolve(detail(99));
  await pause();
  assert.equal(l.errors.filter(Boolean).at(-1)?.message, "Core busy");
  assert.notEqual(l.last()?.agent.rev, 99, "a late read for the old Agent is ignored");
  await pause(60);
  assert.equal(l.calls.length, 3, "retried after the failure");
  assert.equal(l.calls[2].agentId, "b");
  assert.equal(l.last().agent.rev, 10);
  assert.equal(l.errors.at(-1), null);
  l.sync.dispose();
  assert.equal(l.last(), null);
});
