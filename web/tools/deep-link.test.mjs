// Message links and saved reading positions (T-166): the link names a message
// by stable identities only, and positions stay bounded in this client.
import test from "node:test";
import assert from "node:assert/strict";
import { messageLinkHref, parseMessageLink } from "../src/deep-link.ts";
import { localReadingPositions } from "../src/reading-position.ts";

const link = { workspaceId: "ws-1", agentId: "agent-a", turnId: "019a-turn", itemId: "msg_7", threadId: "thread-9" };

test("a message link names its Workspace, Agent, Turn, Item and native session, and reads back from any origin", () => {
  const href = messageLinkHref("http://127.0.0.1:4317/", link);
  assert.equal(href, "http://127.0.0.1:4317/#/message?w=ws-1&a=agent-a&t=019a-turn&i=msg_7&s=thread-9");
  assert.deepEqual(parseMessageLink(href), link);
  // Another client of the same Workspace, a pasted fragment, spaces around it.
  assert.deepEqual(parseMessageLink(href.replace("http://127.0.0.1:4317", "https://core.example:8443")), link);
  assert.deepEqual(parseMessageLink("  #/message?w=ws-1&a=agent-a&t=019a-turn  "), { workspaceId: "ws-1", agentId: "agent-a", turnId: "019a-turn" });
  // Odd characters in an ID survive the round trip as data.
  const odd = { ...link, itemId: "item/1?x=#y" };
  assert.deepEqual(parseMessageLink(messageLinkHref("http://h/", odd)), odd);
});

test("anything else is not a message link", () => {
  for (const text of [
    "",
    "https://example.com/",
    "http://127.0.0.1:4317/#/messages?w=ws-1&a=a&t=t",
    "http://127.0.0.1:4317/?w=ws-1&a=a&t=t",
    "#/message?w=ws-1&a=a",
    "#/message?a=a&t=t",
    "#/message?w=ws-1&a=a&t=t&token=secret",
    "#/message?w=ws-1&a=a&t=t&t=u",
    "#/message?w=ws-1&a=a&t=two%20words",
    "#/message?w=ws-1&a=a&t=t%0A",
    `#/message?w=ws-1&a=a&t=${"x".repeat(257)}`,
    `#/message?w=ws-1&a=a&t=t&i=${"y".repeat(3000)}`,
  ]) assert.equal(parseMessageLink(text), null, text);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test("reading positions are kept per Workspace and Agent, and the oldest are forgotten past the bound", () => {
  const storage = memoryStorage();
  const positions = localReadingPositions("ws-1", storage, 3);
  positions.set("a", { mode: "anchor", turnId: "t1", itemId: "i1", offset: -12, threadId: "s", savedAt: 1 });
  positions.set("b", { mode: "latest", savedAt: 2 });
  assert.deepEqual(positions.get("a"), { mode: "anchor", turnId: "t1", itemId: "i1", offset: -12, threadId: "s", savedAt: 1 });
  assert.deepEqual(positions.get("b"), { mode: "latest", savedAt: 2 });
  assert.equal(localReadingPositions("ws-2", storage, 3).get("a"), null, "another Workspace has its own");
  positions.set("c", { mode: "latest", savedAt: 3 });
  positions.set("d", { mode: "latest", savedAt: 4 });
  assert.equal(positions.get("a"), null, "the oldest is forgotten");
  assert.deepEqual(Object.keys(JSON.parse(storage.values.get("yuzuno.reading.ws-1"))).sort(), ["b", "c", "d"]);
});

test("damaged or unwritable storage never breaks reading", () => {
  const storage = memoryStorage();
  storage.setItem("yuzuno.reading.ws-1", JSON.stringify({ a: { mode: "anchor", offset: 1, savedAt: 1 }, b: { mode: "latest", savedAt: 2 } }));
  const positions = localReadingPositions("ws-1", storage);
  assert.equal(positions.get("a"), null, "a position without its message is ignored");
  assert.deepEqual(positions.get("b"), { mode: "latest", savedAt: 2 });
  storage.setItem("yuzuno.reading.ws-1", "{not json");
  assert.equal(positions.get("b"), null);
  const full = localReadingPositions("ws-1", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  full.set("a", { mode: "latest", savedAt: 1 });
  assert.equal(full.get("a"), null);
});
