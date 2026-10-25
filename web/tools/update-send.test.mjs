// Source-level hook checks: no Vite bundle, browser process or live Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`;
const apiSource = (
  await readFile(new URL("../src/api.ts", import.meta.url), "utf8")
).replace("import.meta.env.VITE_API_BASE", '""');
const imagesSource = await readFile(new URL("../src/image-input.ts", import.meta.url), "utf8");
const hookSource = (
  await readFile(
    new URL("../src/useConversationSend.ts", import.meta.url),
    "utf8",
  )
)
  .replace('"react"', JSON.stringify(import.meta.resolve("react")))
  .replace('"./api"', JSON.stringify(moduleUrl(apiSource)))
  .replace('"./image-input"', JSON.stringify(moduleUrl(imagesSource)));
let useConversationSend;
const WORKSPACE = "ws-1";
/** The whole file, as it is on disk. */
const outboxFile = () => JSON.parse(localStorage.getItem("yuzuno.outbox"));
/** One Workspace's unsent records, keyed `<agent>:<slot>` as before. */
const outbox = (workspace = WORKSPACE) => outboxFile()[workspace] ?? {};
async function fixture(t, initial = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://127.0.0.1:4399/",
  });
  const saved = new Map();
  const calls = [];
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 503,
        text: async () =>
          JSON.stringify({
            error:
              "workspace_updating: Your input was not sent; keep the draft.",
          }),
      };
    },
  };
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  // The file keeps each Workspace's records apart (T-195); a fixture names
  // the records of the Workspace its hook is in.
  if (initial.outbox)
    localStorage.setItem(
      "yuzuno.outbox",
      JSON.stringify({ ...initial.file, [initial.workspace ?? WORKSPACE]: initial.outbox }),
    );
  else if (initial.file)
    localStorage.setItem("yuzuno.outbox", JSON.stringify(initial.file));
  useConversationSend ||= (await import(moduleUrl(hookSource)))
    .useConversationSend;
  let hook;
  let refreshes = 0;
  let workspace = initial.workspace ?? WORKSPACE;
  function Harness() {
    hook = useConversationSend(workspace, "a", initial.turnId === null ? null : "turn1", () => refreshes++, initial.harness || "codex");
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  });
  await act(async () => root.render(createElement(Harness)));
  return {
    calls,
    hook: () => hook,
    refreshes: () => refreshes,
    /** The Core at this address now answers as another Workspace, without
     * the page being reloaded (T-195). */
    async move(next) {
      workspace = next;
      await act(async () => root.render(createElement(Harness)));
    },
    async submit(text, images, clarification) {
      let error;
      await act(async () => {
        try {
          await hook.submit(text, null, images, clarification);
        } catch (caught) {
          error = caught;
        }
      });
      return error;
    },
  };
}

test("two Workspaces at one address keep their unsent records apart", async (t) => {
  // Their Agents can share an id. Keyed by Agent alone, a retry here reused
  // the other Workspace's client message id, so Core would have deduplicated
  // the two against each other and one message would never have arrived.
  const theirs = {
    clientMessageId: "their-id",
    text: "their unsent text",
    expectedTurnId: "turn1",
    question: null,
  };
  const f = await fixture(t, {
    workspace: "ws-here",
    outbox: {},
    file: { "ws-there": { "a:composer": theirs } },
  });
  // A fresh send here, not a retry of the other Workspace's message.
  assert.match((await f.submit("my own text")).message, /workspace_updating/);
  assert.notEqual(f.calls[0].body.clientMessageId, theirs.clientMessageId);
  assert.equal(f.calls[0].body.text, "my own text");
  assert.deepEqual(
    outbox("ws-there"),
    { "a:composer": theirs },
    "and the other Workspace's record is still its own",
  );
});

test("a send that outlives a move to another Workspace stays the first one's", async (t) => {
  // Same Agent id in both. The answer arrives after the move: it must not
  // draw a delivery here, must not read this Workspace's page again, and
  // must settle the records of the Workspace it was sent from -- not write
  // them under this one's name.
  const theirs = {
    clientMessageId: "their-id",
    text: "their unsent text",
    expectedTurnId: "turn1",
    question: null,
  };
  const f = await fixture(t, {
    workspace: "ws-here",
    outbox: {},
    file: { "ws-there": { "a:composer": theirs } },
  });
  let answer;
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, body: JSON.parse(init.body) });
    return new Promise((resolve) => {
      answer = (receipt) => resolve({ ok: true, json: async () => receipt });
    });
  };
  let sending;
  await act(async () => {
    sending = f.hook().submit("sent from here");
  });
  assert.equal(f.calls.length, 1);
  const input = f.calls[0].body;
  assert.deepEqual(
    outbox("ws-here"),
    { "a:composer": input },
    "its retry record is kept while it is uncertain",
  );
  await f.move("ws-there");
  assert.deepEqual(f.hook().outgoing, [], "the move leaves no delivery of the other Workspace's here");
  const before = f.refreshes();
  await act(async () => {
    answer({ input, status: "accepted", turnId: "t1", error: null });
    await sending;
  });
  assert.deepEqual(
    f.hook().outgoing,
    [],
    "an accepted send from the Workspace before does not appear in this one",
  );
  assert.equal(f.refreshes(), before, "and does not read this Workspace's page again");
  assert.deepEqual(outbox("ws-here"), {}, "it settled its own Workspace's records");
  assert.deepEqual(
    outbox("ws-there"),
    { "a:composer": theirs },
    "and left this Workspace's exactly as they were",
  );
});

test("coming back to a Workspace settles the records it is using, not an old snapshot", async (t) => {
  // A -> B -> A: reading A's records again must not hand the send that is
  // still running a bucket the window has replaced, or settling it would
  // write that snapshot over records saved since the return.
  const f = await fixture(t, { workspace: "ws-here", outbox: {} });
  let answer;
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, body: JSON.parse(init.body) });
    return new Promise((resolve) => {
      answer = (receipt) => resolve({ ok: true, json: async () => receipt });
    });
  };
  let sending;
  await act(async () => {
    sending = f.hook().submit("sent before leaving");
  });
  const input = f.calls[0].body;
  await f.move("ws-there");
  await f.move("ws-here");
  // Back here, another unsent record is saved for a second Agent.
  const other = { clientMessageId: "other-id", text: "another Agent's unsent text", expectedTurnId: "turn1", question: null };
  localStorage.setItem(
    "yuzuno.outbox",
    JSON.stringify({ ...outboxFile(), "ws-here": { ...outbox("ws-here"), "b:composer": other } }),
  );
  await act(async () => {
    answer({ input, status: "accepted", turnId: "t1", error: null });
    await sending;
  });
  assert.deepEqual(
    outbox("ws-here"),
    { "b:composer": other },
    "the finished send removed only its own record",
  );
});

test("sending one Workspace's Agent leaves the same Agent id in another free to send", async (t) => {
  const f = await fixture(t, { workspace: "ws-here", outbox: {} });
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, body: JSON.parse(init.body) });
    return new Promise(() => {});
  };
  let sending;
  await act(async () => {
    sending = f.hook().submit("still sending here");
  });
  assert.equal(f.hook().sending, true);
  void sending;
  await f.move("ws-there");
  assert.equal(
    f.hook().sending,
    false,
    "the other Workspace's Agent of the same id is not shown as sending",
  );
  // And it can send: the refusal of a second send is per Workspace and Agent.
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ input: JSON.parse(init.body), status: "accepted", turnId: "t1", error: null }) };
  };
  await act(async () => {
    await f.hook().submit("sent from there");
  });
  assert.deepEqual(
    f.calls.map((c) => c.body.text),
    ["still sending here", "sent from there"],
    "it was not refused as already sending",
  );
});

test("a record saved before the outbox was kept per Workspace is left alone, not retried here", async (t) => {
  const before = {
    clientMessageId: "unattributed-id",
    text: "saved before scoping",
    expectedTurnId: "turn1",
    question: null,
  };
  const f = await fixture(t, { outbox: {}, file: { "a:composer": before } });
  assert.match((await f.submit(before.text)).message, /workspace_updating/);
  assert.notEqual(
    f.calls[0].body.clientMessageId,
    before.clientMessageId,
    "it says which Agent but not which Workspace, so it is not claimed here",
  );
  assert.deepEqual(
    outboxFile()["a:composer"],
    before,
    "and it is kept exactly as it is",
  );
});

test("an explicit update fence rejects a fresh send and removes only the unsent outbox", async (t) => {
  const f = await fixture(t);
  assert.match((await f.submit("保留 draft")).message, /workspace_updating/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.hook().outgoing[0].receipt.status, "rejected");
  assert.equal(f.hook().sending, false);
  assert.deepEqual(outboxFile(), {});
  assert.equal(f.refreshes(), 0);
});

test("a fenced retry keeps the original uncertain identity across another mount", async (t) => {
  const input = {
    clientMessageId: "previous-id",
    text: "保留 draft",
    expectedTurnId: "turn1",
    question: null,
  };
  const f = await fixture(t, { outbox: { "a:composer": input } });
  assert.match((await f.submit(input.text)).message, /earlier delivery/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, input);
  assert.equal(f.hook().outgoing[0].receipt.status, "uncertain");
  assert.deepEqual(
    outbox()["a:composer"],
    input,
  );
});

test("a transport failure never becomes a definite update rejection", async (t) => {
  const f = await fixture(t);
  globalThis.fetch = async () => {
    throw new Error("connection lost");
  };
  assert.match((await f.submit("保留 draft")).message, /connection lost/);
  assert.equal(f.hook().outgoing[0].receipt.status, "uncertain");
  assert.ok(
    outbox()["a:composer"]
      .clientMessageId,
  );
});

test("a readiness rejection clears only the unsent preview without making it uncertain", async (t) => {
  const f = await fixture(t);
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ code: "message_not_submitted", error: "Reconnect before sending" }),
  });
  assert.match((await f.submit("保留 draft")).message, /Reconnect before sending/);
  assert.deepEqual(f.hook().outgoing, []);
  assert.deepEqual(outboxFile(), {});
  assert.equal(f.refreshes(), 1);
});


test("image references are part of the retry snapshot during an update fence", async (t) => {
  const original = { clientMessageId: "image-retry", text: "same caption", images: ["a".repeat(64) + ".png"], expectedTurnId: "turn1", question: null };
  const f = await fixture(t, { outbox: { "a:composer": original } });
  await f.submit(original.text, original.images);
  assert.deepEqual(f.calls[0].body, original);
  await f.submit(original.text, ["b".repeat(64) + ".png"]);
  assert.notEqual(f.calls[1].body.clientMessageId, original.clientMessageId);
  assert.notDeepEqual(f.calls[1].body.images, original.images);
  assert.equal(f.calls[1].body.text, original.text);
});

test("a follow-up refused before it was submitted frees its draft's id, so sending again follows the current turn (T-65)", async (t) => {
  const f = await fixture(t, { harness: "claude" });
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url, body: JSON.parse(init.body) });
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: "上一条消息的发送结果尚未确认", code: "message_not_submitted" }) };
  };
  assert.match((await f.submit("Is it done?")).message, /尚未确认/);
  assert.equal(f.calls[0].body.expectedTurnId, "turn1");
  assert.equal(f.hook().outgoing.length, 0, "no preview of a delivery to confirm");
  assert.deepEqual(outboxFile(), {}, "no old id or turn kept to reuse");
});

test("local Claude sends image references with a new message and with a follow-up", async (t) => {
  const image = "c".repeat(64) + ".png";
  for (const turnId of [null, "turn1"]) {
    await t.test(`expected turn ${turnId}`, async (t) => {
      const f = await fixture(t, { harness: "claude", turnId });
      await f.submit("", [image]);
      const { url, body } = f.calls[0];
      assert.deepEqual([url, body.text, body.images, body.expectedTurnId], ["/api/agents/a/messages", "", [image], turnId]);
    });
  }
});

test("a form retry retains its stable source and answer snapshot without changing composer delivery", async (t) => {
  const clarification = { resultId: "result-a", formId: "setup", answers: { directory: "中文", checks: ["keyboard"] } };
  const original = { clientMessageId: "form-retry", text: "form answers", expectedTurnId: "turn1", question: null, clarification };
  const composer = { clientMessageId: "composer-pending", text: "unsent composer", images: ["a".repeat(64) + ".png"], question: null };
  const f = await fixture(t, { outbox: { "a:form:result-a:setup": original, "a:composer": composer } });
  assert.match((await f.submit(original.text, [], clarification)).message, /earlier delivery/);
  assert.deepEqual(f.calls[0].body, original);
  const persisted = outbox();
  assert.deepEqual(persisted["a:form:result-a:setup"], original);
  assert.deepEqual(persisted["a:composer"], composer);
});

test("idle Claude form submissions use durable receipts and freeze answers before transport", async (t) => {
  const f = await fixture(t, { harness: "claude", turnId: null });
  const clarification = { resultId: "result-a", formId: "setup", answers: { checks: ["keyboard"] } };
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, input: JSON.parse(init.body) };
    clarification.answers.checks.push("changed-after-send");
    return { ok: true, json: async () => ({ input: sent.input, status: "accepted", turnId: "new-turn", error: null }) };
  };
  assert.equal(await f.submit("form answers", [], clarification), undefined);
  assert.equal(sent.url, "/api/agents/a/messages");
  assert.deepEqual(sent.input.clarification.answers.checks, ["keyboard"]);
  assert.deepEqual(f.hook().outgoing[0].receipt.input.clarification.answers.checks, ["keyboard"]);
  assert.equal(f.hook().outgoing[0].receipt.status, "accepted");
  assert.deepEqual(outboxFile(), {});
});
