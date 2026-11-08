// Home's count on the desktop app's taskbar button (YN-43): the page hands
// it to the desktop shell only when it changes.
import assert from "node:assert/strict";
import test from "node:test";
import { desktopBadge } from "../src/desktop-badge.ts";

function shell({ refuse = false } = {}) {
  const calls = [];
  const invoke = (command, args) => {
    calls.push([command, args]);
    return refuse ? Promise.reject(new Error("unknown command desktop_badge")) : Promise.resolve(null);
  };
  return { calls, invoke };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the count goes to the desktop shell once per change", () => {
  const { calls, invoke } = shell();
  const send = desktopBadge(invoke);
  send(3, "en");
  send(3, "en");
  send(3, "en");
  send(4, "en");
  send(4, "en");
  send(0, "en");
  send(0, "en");
  assert.deepEqual(calls, [
    ["desktop_badge", { count: 3, lang: "en" }],
    ["desktop_badge", { count: 4, lang: "en" }],
    ["desktop_badge", { count: 0, lang: "en" }],
  ]);
});

test("a new language sends the same count again, for its words", () => {
  const { calls, invoke } = shell();
  const send = desktopBadge(invoke);
  send(12, "en");
  send(12, "zh");
  send(12, "zh");
  assert.deepEqual(calls, [
    ["desktop_badge", { count: 12, lang: "en" }],
    ["desktop_badge", { count: 12, lang: "zh" }],
  ]);
});

test("only whole counts above zero are sent as they are; anything else is 0", () => {
  const { calls, invoke } = shell();
  const send = desktopBadge(invoke);
  send(Number.NaN, "en");
  send(-2, "en");
  send(2.5, "en");
  send(Infinity, "en");
  assert.deepEqual(calls, [["desktop_badge", { count: 0, lang: "en" }]]);
});

test("outside the desktop app nothing is sent", () => {
  const send = desktopBadge(undefined);
  assert.doesNotThrow(() => send(5, "en"));
});

test("an older desktop app's refusal is ignored, and the same count may be offered again", async () => {
  const { calls, invoke } = shell({ refuse: true });
  const send = desktopBadge(invoke);
  send(2, "en");
  await settle();
  send(2, "en");
  await settle();
  assert.equal(calls.length, 2, "tried again after the refusal, not lost");
});
