// The strips over a conversation's top (T-19 SH:C08, CV:CW-11): a source
// strip, opened here by a message link, floats over the conversation rather
// than standing above it, so it shrinks nothing: it is in the conversation's
// overlay of strips, before the scroller, and nothing of it stands outside.
// jsdom lays nothing out; the heights and the fade are the Chromium check's
// (conversation-strips-check.mjs).
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { installConnectionFixture, FIXTURE_WORKSPACE } from "./connection-fixture.mjs";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(15); }
  assert.ok(check(), `${label} should settle`);
}
async function mount() {
  const errors = [], vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4391/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  w.eval(`(${installConnectionFixture.toString()})({deadlineMs: 180})`);
  w.eval(bundle);
  const d = w.document;
  await until(() => d.querySelector(".prose")?.textContent.includes("initial fixture reply"), "the conversation");
  return { w, d, errors, close: () => w.close() };
}

test("a message link's source strip floats over the conversation's top, in its strips before the scroller, not above it (T-19 CV:CW-11, SH:C08)", async () => {
  const p = await mount();
  try {
    p.w.location.hash = `#/message?w=${FIXTURE_WORKSPACE}&a=a&t=turn-a&i=reply-a`;
    await until(() => [...p.d.querySelectorAll(".source-navigation")].some((el) => el.textContent.includes("Linked message")), "the source strip");
    const strip = [...p.d.querySelectorAll(".source-navigation")].find((el) => el.textContent.includes("Linked message"));
    const strips = strip.closest(".conversation-strips");
    assert.equal(!!strips, true, "the source strip floats over the conversation");
    assert.equal(strips.parentElement?.classList.contains("conversation-body"), true, "over the conversation's body");
    assert.equal(strips.compareDocumentPosition(p.d.querySelector(".conversation-scroll")) & p.w.Node.DOCUMENT_POSITION_FOLLOWING, p.w.Node.DOCUMENT_POSITION_FOLLOWING, "before the scroller");
    assert.equal([...p.d.querySelectorAll(".source-navigation")].every((el) => !!el.closest(".conversation-strips")), true, "no strip stands above the conversation");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
