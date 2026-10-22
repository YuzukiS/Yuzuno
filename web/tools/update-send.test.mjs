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
  if (initial.outbox)
    localStorage.setItem("yuzuno.outbox", JSON.stringify(initial.outbox));
  useConversationSend ||= (await import(moduleUrl(hookSource)))
    .useConversationSend;
  let hook;
  let refreshes = 0;
  function Harness() {
    hook = useConversationSend("a", initial.turnId === null ? null : "turn1", () => refreshes++, initial.harness || "codex");
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

test("an explicit update fence rejects a fresh send and removes only the unsent outbox", async (t) => {
  const f = await fixture(t);
  assert.match((await f.submit("保留 draft")).message, /workspace_updating/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.hook().outgoing[0].receipt.status, "rejected");
  assert.equal(f.hook().sending, false);
  assert.deepEqual(JSON.parse(localStorage.getItem("yuzuno.outbox")), {});
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
    JSON.parse(localStorage.getItem("yuzuno.outbox"))["a:composer"],
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
    JSON.parse(localStorage.getItem("yuzuno.outbox"))["a:composer"]
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
  assert.deepEqual(JSON.parse(localStorage.getItem("yuzuno.outbox")), {});
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
  assert.deepEqual(JSON.parse(localStorage.getItem("yuzuno.outbox")), {}, "no old id or turn kept to reuse");
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
  const persisted = JSON.parse(localStorage.getItem("yuzuno.outbox"));
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
  assert.deepEqual(JSON.parse(localStorage.getItem("yuzuno.outbox")), {});
});
