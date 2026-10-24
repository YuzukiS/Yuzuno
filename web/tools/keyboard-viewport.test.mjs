// A phone's on-screen keyboard (T-170): src/keyboard-viewport.ts, with the
// visual viewport stubbed as Mobile Safari reported it in the iOS 26.5
// Simulator (run 40061280002, T-170 comment 6610): 714 px tall without the
// keyboard, 377 with it upright, after Safari had scrolled the document by
// 337; 377 again with no scroll after a rotation back upright; and -12
// sideways. 100dvh is 714 throughout. This is not WebKit: it checks what the
// app does with those numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { followVisualViewport } from "../src/keyboard-viewport.ts";

const FULL = 714;

function phone({ height = FULL, offsetTop = 0, scale = 1, scrollY = 0 } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const win = dom.window;
  const viewport = new win.EventTarget();
  Object.assign(viewport, { height, offsetTop, scale, width: 402 });
  Object.defineProperty(win, "visualViewport", { value: viewport, configurable: true });
  const state = { scrollY, scrolls: [], frames: [] };
  Object.defineProperty(win, "scrollY", { get: () => state.scrollY, configurable: true });
  win.scrollTo = (x, y) => {
    state.scrolls.push([x, y]);
    state.scrollY = y;
    viewport.offsetTop = 0;
  };
  win.requestAnimationFrame = (run) => state.frames.push(run);
  win.cancelAnimationFrame = () => {};
  // The probe is 100dvh tall: 714 here, whatever the keyboard does.
  const box = win.HTMLElement.prototype.getBoundingClientRect;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.style.height === "100dvh" ? { height: FULL, width: 0, top: 0, left: 0, bottom: FULL, right: 0 } : box.call(this);
  };
  const root = win.document.documentElement;
  const read = () => ({ height: root.style.getPropertyValue("--visual-height"), keyboard: root.hasAttribute("data-keyboard") });
  const set = (next) => Object.assign(viewport, next);
  const resize = (next) => { set(next); viewport.dispatchEvent(new win.Event("resize")); };
  const scroll = (next) => { set(next); viewport.dispatchEvent(new win.Event("scroll")); };
  const flush = () => { for (const run of state.frames.splice(0)) run(0); };
  return { win, viewport, root, state, read, resize, scroll, flush };
}

test("no keyboard: nothing is set and nothing is scrolled", () => {
  const p = phone();
  followVisualViewport(p.win);
  p.flush();
  assert.deepEqual(p.read(), { height: "", keyboard: false });
  assert.deepEqual(p.state.scrolls, []);
});

test("the keyboard opens upright after Safari scrolled: the shell fits 377 px and the document goes back to its top, once", () => {
  const p = phone();
  followVisualViewport(p.win);
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

test("back upright with the keyboard still open: the shell fits 377 px without scrolling", () => {
  const p = phone({ height: 377 });
  followVisualViewport(p.win);
  p.flush();
  assert.deepEqual(p.read(), { height: "377px", keyboard: true });
  assert.deepEqual(p.state.scrolls, []);
});

test("the keyboard closes: both are removed and the shell is 100dvh again", () => {
  const p = phone({ height: 377 });
  followVisualViewport(p.win);
  p.resize({ height: FULL });
  assert.deepEqual(p.read(), { height: "", keyboard: false });
});

test("a negative visual height (sideways, as measured) is kept at 0", () => {
  const p = phone({ height: -12 });
  followVisualViewport(p.win);
  assert.deepEqual(p.read(), { height: "0px", keyboard: true });
});

test("a pinch zoom changes nothing", () => {
  const p = phone();
  followVisualViewport(p.win);
  p.resize({ height: 357, scale: 2, offsetTop: 100 });
  p.flush();
  assert.deepEqual(p.read(), { height: "", keyboard: false });
  assert.deepEqual(p.state.scrolls, []);
});

test("stopping removes the probe, the listeners and what was set", () => {
  const p = phone({ height: 377 });
  const stop = followVisualViewport(p.win);
  assert.equal(p.win.document.querySelectorAll('body > div[aria-hidden="true"]').length, 1);
  stop();
  assert.deepEqual(p.read(), { height: "", keyboard: false });
  assert.equal(p.win.document.querySelectorAll('body > div[aria-hidden="true"]').length, 0);
  p.resize({ height: 300 });
  assert.deepEqual(p.read(), { height: "", keyboard: false });
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
