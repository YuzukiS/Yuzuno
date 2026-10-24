// A phone's on-screen keyboard (T-170): src/keyboard-viewport.ts, with the
// visual viewport stubbed as Mobile Safari reported it in the iOS 26.5
// Simulator (run 40061280002, T-170 comment 6610). Upright 100dvh is 714
// and the keyboard leaves 377, after Safari has scrolled the document by
// 337. Sideways 100dvh is 292 and Safari reported -12. Back upright with the
// keyboard still open, it reported 377 with no scroll. This is not WebKit:
// it checks what the app does with those numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { followVisualViewport } from "../src/keyboard-viewport.ts";

function phone({ height = 714, full = 714 } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><textarea id="field"></textarea><div id="composer" contenteditable="true" tabindex="0"></div><button id="button">Send</button></body></html>',
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  const viewport = new win.EventTarget();
  Object.assign(viewport, { height, offsetTop: 0, scale: 1, width: 402 });
  Object.defineProperty(win, "visualViewport", { value: viewport, configurable: true });
  const state = { full, scrollY: 0, scrolls: [], frames: [], written: [] };
  Object.defineProperty(win, "scrollY", { get: () => state.scrollY, configurable: true });
  win.scrollTo = (x, y) => {
    state.scrolls.push([x, y]);
    state.scrollY = y;
    viewport.offsetTop = 0;
  };
  win.requestAnimationFrame = (run) => state.frames.push(run);
  win.cancelAnimationFrame = () => {};
  // The probe is 100dvh tall: state.full, whatever the keyboard does.
  const box = win.HTMLElement.prototype.getBoundingClientRect;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.style.height === "100dvh" ? { height: state.full, width: 0, top: 0, left: 0, bottom: state.full, right: 0 } : box.call(this);
  };
  const root = win.document.documentElement;
  // Every value ever written, to check none is 0 or negative.
  const setProperty = root.style.setProperty.bind(root.style);
  root.style.setProperty = (name, value, priority) => {
    if (name === "--visual-height") state.written.push(value);
    return setProperty(name, value, priority);
  };
  const read = () => ({ height: root.style.getPropertyValue("--visual-height"), keyboard: root.hasAttribute("data-keyboard") });
  const set = (next) => Object.assign(viewport, next);
  const resize = (next) => { set(next); viewport.dispatchEvent(new win.Event("resize")); };
  const scroll = (next) => { set(next); viewport.dispatchEvent(new win.Event("scroll")); };
  const flush = () => { for (const run of state.frames.splice(0)) run(0); };
  const settle = () => new Promise((done) => queueMicrotask(done));
  const focus = async (id) => { win.document.getElementById(id).focus(); await settle(); };
  const blur = async () => { win.document.activeElement.blur(); await settle(); };
  return { win, viewport, root, state, read, resize, scroll, flush, focus, blur, settle };
}
const nothing = { height: "", keyboard: false };

test("no keyboard: nothing is set and nothing is scrolled, focused or not", async () => {
  const p = phone();
  followVisualViewport(p.win);
  assert.deepEqual(p.read(), nothing);
  await p.focus("composer");
  p.flush();
  assert.deepEqual(p.read(), nothing);
  assert.deepEqual(p.state.scrolls, []);
});

test("the keyboard opens upright after Safari's scroll: the shell fits 377 and goes back to the top, once", async () => {
  const p = phone();
  followVisualViewport(p.win);
  await p.focus("composer");
  p.state.scrollY = 337;
  p.resize({ height: 377, offsetTop: 337 });
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  p.flush();
  assert.deepEqual(p.state.scrolls, [[0, 0]]);
  // Safari scrolls again to keep the caret in view: not fought before the size changes.
  p.state.scrollY = 20;
  p.scroll({ offsetTop: 20 });
  p.flush();
  assert.deepEqual(p.state.scrolls, [[0, 0]]);
  // The next size change may scroll back once more.
  p.resize({ height: 380, offsetTop: 20 });
  p.flush();
  assert.deepEqual(p.state.scrolls, [[0, 0], [0, 0]]);
  assert.equal(p.read().height, "380px");
});

test("sideways and back with the keyboard open: never 0 or negative, and upright again the shell fits 377", async () => {
  const p = phone();
  followVisualViewport(p.win);
  await p.focus("field");
  p.resize({ height: 377 });
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  // Sideways: 100dvh 292, the visual viewport 292, then -12.
  p.state.full = 292;
  p.resize({ height: 292 });
  assert.deepEqual(p.read(), nothing);
  p.resize({ height: -12 });
  assert.deepEqual(p.read(), nothing, "-12 is ignored; 292 is kept, which is no keyboard");
  // Back upright, as measured: 377 with no scroll.
  p.state.full = 714;
  p.resize({ height: 377, offsetTop: 0 });
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  p.flush();
  assert.deepEqual(p.state.scrolls, []);
  assert.ok(p.state.written.every((value) => parseFloat(value) > 0), p.state.written.join(" "));
});

test("heights that are not finite and positive are ignored, and the last valid one is kept", async () => {
  const p = phone();
  followVisualViewport(p.win);
  await p.focus("field");
  for (const height of [NaN, 0, -12, Infinity]) {
    p.resize({ height });
    assert.deepEqual(p.read(), nothing, `first reading ${height}`);
  }
  p.resize({ height: 377 });
  for (const height of [NaN, 0, -12, Infinity]) {
    p.resize({ height });
    assert.deepEqual(p.read(), { height: "377px", keyboard: true }, `after 377, ${height}`);
  }
  assert.deepEqual(p.state.written.filter((value) => parseFloat(value) <= 0), []);
});

test("a shrink a browser's bars could make is not the keyboard", async () => {
  const p = phone();
  followVisualViewport(p.win);
  await p.focus("field");
  p.resize({ height: 660 });
  assert.deepEqual(p.read(), nothing);
});

test("nothing focused, or a button focused, is not the keyboard; focus and blur follow it", async () => {
  const p = phone({ height: 377 });
  followVisualViewport(p.win);
  assert.deepEqual(p.read(), nothing);
  await p.focus("button");
  assert.deepEqual(p.read(), nothing);
  await p.focus("composer");
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  await p.blur();
  assert.deepEqual(p.read(), nothing);
  await p.focus("field");
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
});

test("zoomed in, nothing is set and nothing is scrolled", async () => {
  const p = phone();
  followVisualViewport(p.win);
  await p.focus("field");
  p.resize({ height: 377 });
  p.state.scrollY = 100;
  p.resize({ height: 357, scale: 2, offsetTop: 100 });
  assert.deepEqual(p.read(), nothing);
  p.flush();
  assert.deepEqual(p.state.scrolls, []);
});

test("stopping removes the probe, the listeners and what was set, even with an update queued", async () => {
  const p = phone({ height: 377 });
  const stop = followVisualViewport(p.win);
  await p.focus("field");
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  assert.equal(p.win.document.querySelectorAll('body > div[aria-hidden="true"]').length, 1);
  p.win.document.getElementById("composer").focus(); // queues an update
  stop();
  await p.settle();
  assert.deepEqual(p.read(), nothing);
  assert.equal(p.win.document.querySelectorAll('body > div[aria-hidden="true"]').length, 0);
  p.resize({ height: 300 });
  await p.focus("field");
  assert.deepEqual(p.read(), nothing);
});

test("without a visual viewport nothing happens", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperty(dom.window, "visualViewport", { value: undefined, configurable: true });
  followVisualViewport(dom.window)();
  assert.equal(dom.window.document.documentElement.getAttribute("style"), null);
});

test("the phone shell uses it, and only the phone shell", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useEffect\(\(\) => \(phone \? followVisualViewport\(\) : undefined\), \[phone\]\);/);
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const shell = css.match(/\.app\.phone,\s*\.app\.phone\.rail-hidden \{[^}]*\}/)?.[0] ?? "";
  assert.match(shell, /height:\s*min\(100dvh,\s*var\(--visual-height,\s*100dvh\)\)/, shell);
  assert.match(css, /:root\[data-keyboard\] \.app\.phone \{\s*padding-bottom:\s*0;\s*\}/);
});
