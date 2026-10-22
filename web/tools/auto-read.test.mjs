import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { useAutoRead, AUTO_READ_DWELL_MS } from "../src/useAutoRead.ts";

function rect(x, y, width, height) {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON() {},
  };
}

async function fixture(t, initial = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: "http://127.0.0.1:4339/",
    },
  );
  const { window } = dom;
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  let focused = true;
  let visible = true;
  let scrollTop = 600;
  let tailY = 598;
  Object.defineProperty(window.document, "hasFocus", {
    configurable: true,
    value: () => focused,
  });
  Object.defineProperty(window.document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  const calls = [];
  const scroll = window.document.createElement("section");
  const end = window.document.createElement("div");
  const pending = window.document.createElement("button");
  pending.textContent = "Approve command";
  pending.setAttribute("data-pending", "still-pending");
  scroll.append(pending, end);
  window.document.body.append(scroll);
  Object.defineProperties(scroll, {
    clientHeight: { value: 500 },
    clientWidth: { value: 700 },
    scrollHeight: { value: 1_100 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value;
      },
    },
  });
  scroll.getBoundingClientRect = () => rect(100, 100, 700, 500);
  end.getBoundingClientRect = () => rect(110, tailY, 680, 1);
  let props = {
    agentId: "a",
    throughSeq: 12,
    reviewedSeq: 5,
    unreadCount: 1,
    enabled: true,
    scrollRef: { current: scroll },
    endRef: { current: end },
    onRead: async (agentId, throughSeq) => {
      calls.push({ agentId, throughSeq });
    },
    ...initial,
  };
  let hook;
  function Harness() {
    hook = useAutoRead(props);
    return createElement("output", null, hook.error ?? "");
  }
  const root = createRoot(window.document.getElementById("root"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const render = async (update = {}) => {
    props = { ...props, ...update };
    await act(async () => root.render(createElement(Harness)));
  };
  const advance = async (ms = AUTO_READ_DWELL_MS) => {
    await act(async () => {
      t.mock.timers.tick(ms);
    });
  };
  const fire = async (node, type) => {
    await act(async () => node.dispatchEvent(new window.Event(type)));
  };
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await render();
  return {
    calls,
    render,
    advance,
    fire,
    window,
    scroll,
    end,
    pending,
    state: () => hook,
    async focus(value) {
      focused = value;
      await fire(window, value ? "focus" : "blur");
    },
    async visibility(value) {
      visible = value;
      await fire(window.document, "visibilitychange");
    },
    async position(value, tail = 598) {
      scrollTop = value;
      tailY = tail;
      await fire(scroll, "scroll");
    },
    async dialog() {
      const dialog = window.document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.getClientRects = () => [rect(150, 150, 300, 200)];
      await act(async () => window.document.body.append(dialog));
      return async () => {
        await act(async () => dialog.remove());
      };
    },
  };
}

test("requires the full visible dwell, acknowledges the rendered watermark once, and leaves Pending alone", async (t) => {
  const f = await fixture(t);
  let approvals = 0;
  f.pending.addEventListener("click", () => approvals++);
  await f.advance(AUTO_READ_DWELL_MS - 1);
  assert.deepEqual(f.calls, []);
  await f.advance(1);
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 12 }]);
  await f.advance(20_000);
  assert.equal(
    f.calls.length,
    1,
    "stale unread snapshots must not loop requests",
  );
  await f.render({ throughSeq: 13, reviewedSeq: 12, unreadCount: 0 });
  await f.advance(20_000);
  assert.equal(f.calls.length, 1, "review's own sequence update is not unread");
  assert.equal(approvals, 0);
  assert.equal(f.pending.dataset.pending, "still-pending");
});

test("composer mutations do not scan history or measure layout when there is no unread work", async (t) => {
  const f = await fixture(t, { unreadCount: 0 });
  const query = t.mock.method(f.window.document, "querySelectorAll");
  const geometry = t.mock.method(f.scroll, "getBoundingClientRect");
  for (let i = 0; i < 4; i++)
    await act(async () =>
      f.window.document.body.setAttribute("data-state", String(i)),
    );
  assert.equal(query.mock.callCount(), 0);
  assert.equal(geometry.mock.callCount(), 0);
  await f.render({ unreadCount: 1 });
  assert.ok(
    query.mock.callCount() > 0,
    "eligible content still checks overlays",
  );
  const close = await f.dialog();
  await f.advance();
  assert.deepEqual(f.calls, []);
  await close();
  await f.advance();
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 12 }]);
});

test("history browsing skips the whole-document overlay scan while retaining a fresh return dwell", async (t) => {
  const f = await fixture(t);
  await f.position(300);
  const query = t.mock.method(f.window.document, "querySelectorAll");
  await act(async () =>
    f.window.document.body.setAttribute("data-state", "streaming"),
  );
  await f.advance();
  assert.equal(query.mock.callCount(), 0);
  assert.deepEqual(f.calls, []);
  await f.position(600);
  await f.advance(AUTO_READ_DWELL_MS - 1);
  assert.deepEqual(f.calls, []);
  await f.advance(1);
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 12 }]);
});

test("switching from agent A to B cannot finish A's pending dwell", async (t) => {
  const f = await fixture(t);
  await f.advance(800);
  await f.render({ agentId: "b", throughSeq: 40, reviewedSeq: 30 });
  await f.advance(400);
  assert.deepEqual(f.calls, []);
  await f.advance(800);
  assert.deepEqual(f.calls, [{ agentId: "b", throughSeq: 40 }]);
});

test("background windows and hidden documents cancel dwell until a fresh foreground dwell", async (t) => {
  const f = await fixture(t);
  await f.advance(900);
  await f.focus(false);
  await f.advance(5_000);
  assert.deepEqual(f.calls, []);
  await f.focus(true);
  await f.advance(600);
  await f.visibility(false);
  await f.advance(5_000);
  assert.deepEqual(f.calls, []);
  await f.visibility(true);
  await f.advance(1_199);
  assert.deepEqual(f.calls, []);
  await f.advance(1);
  assert.equal(f.calls.length, 1);
});

test("both the actual bottom and latest-content sentinel must be visible", async (t) => {
  const f = await fixture(t);
  await f.advance(900);
  await f.position(540);
  await f.advance(5_000);
  assert.deepEqual(
    f.calls,
    [],
    "the UI's generous near-bottom threshold is insufficient",
  );
  await f.position(600, 900);
  await f.advance(5_000);
  assert.deepEqual(
    f.calls,
    [],
    "bottom geometry alone cannot acknowledge an offscreen end",
  );
  await f.position(600, 598);
  await f.advance();
  assert.equal(f.calls.length, 1);
});

test("visible dialogs and history-navigation gating each require a fresh dwell after closing", async (t) => {
  const f = await fixture(t);
  await f.advance(900);
  const close = await f.dialog();
  await f.advance(5_000);
  assert.deepEqual(f.calls, []);
  await close();
  await f.advance(500);
  await f.render({ enabled: false });
  await f.advance(5_000);
  assert.deepEqual(f.calls, []);
  await f.render({ enabled: true });
  await f.advance(1_199);
  assert.deepEqual(f.calls, []);
  await f.advance(1);
  assert.equal(f.calls.length, 1);
});

test("tool stream sequence changes never expand an in-progress dwell's captured watermark", async (t) => {
  const f = await fixture(t);
  await f.advance(400);
  await f.render({ throughSeq: 13 });
  await f.advance(400);
  await f.render({ throughSeq: 14 });
  await f.advance(400);
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 12 }]);
  await f.render({ throughSeq: 15, reviewedSeq: 12, unreadCount: 0 });
  await f.advance(5_000);
  assert.equal(f.calls.length, 1);
});

test("new meaningful unread content resets the dwell instead of being cleared with an older reply", async (t) => {
  const f = await fixture(t);
  await f.advance(900);
  await f.render({ throughSeq: 14, unreadCount: 2 });
  await f.advance(300);
  assert.deepEqual(f.calls, []);
  await f.advance(900);
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 14 }]);
});

test("a later unread update during an outstanding request gets its own dwell after read-state acknowledgement", async (t) => {
  let complete;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const calls = [];
  const f = await fixture(t, {
    onRead: async (agentId, throughSeq) => {
      calls.push({ agentId, throughSeq });
      if (calls.length === 1) await pending;
    },
  });
  await f.advance();
  await f.render({ throughSeq: 16, unreadCount: 2 });
  await f.advance(5_000);
  assert.equal(calls.length, 1);
  await act(async () => complete());
  await f.advance(5_000);
  assert.equal(
    calls.length,
    1,
    "must wait until the first cursor is reflected in detail",
  );
  await f.render({ reviewedSeq: 12, unreadCount: 1 });
  await f.advance(1_199);
  assert.equal(calls.length, 1);
  await f.advance(1);
  assert.deepEqual(calls, [
    { agentId: "a", throughSeq: 12 },
    { agentId: "a", throughSeq: 16 },
  ]);
});

test("failed requests stay quiet without retry loops and retry after a later foreground action", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    onRead: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Core disconnected");
    },
  });
  await f.advance();
  assert.equal(attempts, 1);
  assert.equal(f.state().error, "Core disconnected");
  await f.render({ throughSeq: 13 });
  await f.advance(20_000);
  assert.equal(
    attempts,
    1,
    "streaming or timeout alone must not flood retries",
  );
  await f.focus(false);
  await f.focus(true);
  await f.advance();
  assert.equal(attempts, 2);
  assert.equal(f.state().error, null);
});

test("deadline revalidates focus and geometry even when their browser events have not arrived", async (t) => {
  const f = await fixture(t);
  await f.advance(1_199);
  // A focus event can be delayed relative to the timer. The final check must use
  // the document's current state, not a cached event-driven boolean.
  Object.defineProperty(f.window.document, "hasFocus", { value: () => false });
  await f.advance(1);
  assert.deepEqual(f.calls, []);
  Object.defineProperty(f.window.document, "hasFocus", { value: () => true });
  await f.fire(f.window, "focus");
  await f.advance(1_199);
  f.end.getBoundingClientRect = () => rect(110, 900, 680, 1);
  await f.advance(1);
  assert.deepEqual(f.calls, []);
});

test("completion from an earlier mount cannot wedge a returned agent's new unread update", async (t) => {
  let complete;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const calls = [];
  const f = await fixture(t, {
    onRead: async (agentId, throughSeq) => {
      calls.push({ agentId, throughSeq });
      if (calls.length === 1) await pending;
    },
  });
  await f.advance();
  await f.render({ agentId: "b", throughSeq: 30, reviewedSeq: 20 });
  await f.render({
    agentId: "a",
    throughSeq: 16,
    reviewedSeq: 12,
    unreadCount: 1,
  });
  await act(async () => complete());
  await f.advance();
  assert.deepEqual(calls, [
    { agentId: "a", throughSeq: 12 },
    { agentId: "a", throughSeq: 16 },
  ]);
});

test("a regressed detail response cancels the higher watermark until the displayed detail has dwelled", async (t) => {
  const f = await fixture(t);
  await f.advance(900);
  await f.render({ throughSeq: 10 });
  await f.advance(300);
  assert.deepEqual(f.calls, []);
  await f.advance(900);
  assert.deepEqual(f.calls, [{ agentId: "a", throughSeq: 10 }]);
});
