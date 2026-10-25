// Message times under streamed changes: agent.item and agent.delta patch the
// shown detail in place (detail-patch); minute marks and background shells
// must survive them without any extra read. Pure modules, no DOM.
import test from "node:test";
import assert from "node:assert/strict";

process.env.TZ = "Asia/Shanghai";
const { patchDetail } = await import("../src/detail-patch.ts");
const { DetailSync } = await import("../src/detail-sync.ts");
const { conversationTimeMarks, timeMarkKey, turnFooter } = await import("../src/conversation-time.ts");

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (minute, second = 0) => Date.UTC(2026, 9, 14, 2, minute, second);
const shells = { state: "known", count: 1, checkedAt: at(0) };

function detail(rev = 10) {
  return {
    agent: { id: "a", name: "A", rev, lastSeq: 100, reviewedSeq: 0, unreadCount: 0, status: "working" },
    pending: [],
    artifacts: [],
    backgroundShells: shells,
    turns: [{ id: "t", status: "inProgress", items: [
      { id: "u", type: "userMessage", content: [{ type: "text", text: "Go" }], _yuzunoTime: { at: at(0, 5), source: "core" } },
    ] }],
  };
}
const item = (rev, value) => ({ type: "agent.item", agentId: "a", rev, turnId: "t", item: value });
const delta = (rev, text) => ({ type: "agent.delta", agentId: "a", rev, turnId: "t", itemId: "m", op: "append", field: "text", text });
const labels = (d) => [...conversationTimeMarks(d.turns)].map(([key, mark]) => [key, mark.label]);

test("a streamed message keeps its time, mark and the shell count through deltas", () => {
  let d = detail();
  d = patchDetail(d, item(11, { id: "m", type: "agentMessage", text: "Hel", _yuzunoTime: { at: at(1, 10), source: "core" } }));
  const marked = labels(d);
  assert.deepEqual(marked.map(([key]) => key), [timeMarkKey("t", "u"), timeMarkKey("t", "m")]);
  for (const [rev, text] of [[12, "lo"], [13, " there"]]) d = patchDetail(d, delta(rev, text));
  const message = d.turns[0].items.find((i) => i.id === "m");
  assert.equal(message.text, "Hello there");
  assert.deepEqual(message._yuzunoTime, { at: at(1, 10), source: "core" });
  assert.deepEqual(labels(d), marked, "appends never move or add a mark");
  assert.equal(d.backgroundShells, shells, "patches keep the shell count from the last read");
  // The completed Item replaces the streamed one with the same recorded time.
  d = patchDetail(d, item(14, { id: "m", type: "agentMessage", text: "Hello there.", _yuzunoTime: { at: at(1, 10), source: "core" } }));
  assert.deepEqual(labels(d), marked);
});

test("streamed deltas never cause a read; only a change notice does", async () => {
  let reads = 0;
  let shown = null;
  const sync = new DetailSync({
    fetch: async () => { reads++; return detail(10); },
    publish: (d) => { shown = d; },
    error: () => {},
    refetchDelayMs: 5,
    flushDelayMs: 5,
  });
  sync.select("a");
  await pause();
  assert.equal(reads, 1);
  sync.push(item(11, { id: "m", type: "agentMessage", text: "", _yuzunoTime: { at: at(2), source: "core" } }));
  for (let rev = 12; rev < 112; rev++) sync.push(delta(rev, "x"));
  await pause(60);
  assert.equal(reads, 1, "a hundred deltas, no read");
  assert.equal(shown.turns[0].items.find((i) => i.id === "m").text.length, 100);
  assert.equal(conversationTimeMarks(shown.turns).size, 2);
  // A shell count change is announced as agent.changed: one read shows it.
  sync.refetch();
  await pause(60);
  assert.equal(reads, 2);
  sync.dispose();
});

// This device's clock format (T-189): the same loaded Turns, written with
// another clock, are written again, not taken from the marks already made.
test("another clock format writes the same loaded Turns' marks and ending again", () => {
  const d = detail();
  d.turns[0].status = "completed";
  d.turns[0].completedAt = at(3) / 1000;
  const written = (clock) => [...conversationTimeMarks(d.turns, clock).values()].map((mark) => mark.label);
  const ending = (clock) => turnFooter(d.turns[0], null, clock).find((part) => part.kind === "time").moment.label;
  const system = written("system");
  assert.deepEqual(system, [new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(at(0, 5)))], "unset, as before");
  assert.deepEqual(written("h24"), ["10:00"]);
  assert.equal(ending("h24"), "10:03");
  assert.match(written("h12")[0], /^10:00\s?AM$/);
  assert.deepEqual(written("h24"), ["10:00"], "and back");
  assert.equal(conversationTimeMarks(d.turns, "h24"), conversationTimeMarks(d.turns, "h24"), "one result per Turns and clock format");
  assert.deepEqual(written("system"), system);
});
