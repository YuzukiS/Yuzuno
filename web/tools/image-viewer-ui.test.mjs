import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-20: the image viewer, in the two places images open: the preview of a
// conversation's and Home's images (ImagePreview) and an Agent's image file
// (ArtifactModal). The real components in JSDOM; sizes are given here, as
// JSDOM lays nothing out. No Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "image-viewer-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ImagePreview} from ${JSON.stringify(path.join(root, "src/ImageAttachments.tsx"))};
import {ArtifactModal} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.showPreview=(props)=>flushSync(()=>root.render(<ImagePreview unavailable="This saved image is unavailable." onClose={()=>window.closed=(window.closed||0)+1} {...props}/>));
window.showArtifact=(props)=>flushSync(()=>root.render(<ArtifactModal agentId="a" preview={false} onClose={()=>window.closed=(window.closed||0)+1} {...props}/>));
window.unmount=()=>flushSync(()=>root.render(null));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ImageViewer", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The stage's size, as a layout would give it; observers are told on resize().
  const stage = { width: 1000, height: 700 };
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  };
  for (const [name, side] of [["clientWidth", "width"], ["clientHeight", "height"]])
    Object.defineProperty(window.HTMLElement.prototype, name, {
      configurable: true,
      get() { return this.classList?.contains("image-viewer-stage") ? stage[side] : 0; },
    });
  window.fetch = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({}) });
  // What reaches the window, as App's own shortcuts and Escape-to-interrupt read it.
  const reached = [];
  window.addEventListener("keydown", (event) => reached.push({ key: event.key, prevented: event.defaultPrevented }));
  window.eval(bundle);
  const document = window.document;
  const dialog = () => document.querySelector('[role="dialog"]');
  const image = () => dialog()?.querySelector(".image-viewer-stage > img");
  const output = () => dialog()?.querySelector(".image-viewer-zoom output")?.textContent;
  const button = (name) => [...dialog().querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent) === name);
  const pressed = () => [...dialog().querySelectorAll(".image-viewer-modes button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
  const transform = () => image().style.transform;
  /** The image's own size, as it loaded. */
  const load = (width, height) => {
    Object.defineProperty(image(), "naturalWidth", { configurable: true, value: width });
    Object.defineProperty(image(), "naturalHeight", { configurable: true, value: height });
    image().dispatchEvent(new window.Event("load"));
  };
  const resize = (width, height) => {
    Object.assign(stage, { width, height });
    for (const observer of [...observers]) observer.callback([]);
  };
  const stageEl = () => dialog().querySelector(".image-viewer-stage");
  const wheel = (deltaY, at = { x: 0, y: 0 }, extra = {}) => {
    const event = new window.WheelEvent("wheel", { deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, ...extra });
    stageEl().dispatchEvent(event);
    return event;
  };
  const key = (key, target = stageEl(), extra = {}) => {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (type, x, y, id = 1, pointerType = "mouse") => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
    stageEl().dispatchEvent(event);
  };
  return { window, document, errors, reached, dialog, image, output, button, pressed, transform, load, resize, wheel, key, pointer, stageEl, close: () => window.close() };
}

test("T-20 a photo opens whole; the wheel zooms at the pointer and is taken from the page; drag moves it, within bounds", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/api/agents/a/images/one.png", name: "one.png", description: "Attached image" });
  await until(p.image, "the viewer opens");
  assert.equal(p.image().getAttribute("src"), "/api/agents/a/images/one.png", "the original, never the thumbnail");
  assert.equal(p.dialog().querySelector(".input-image-dialog img"), p.image());
  assert.equal(p.document.activeElement, p.stageEl(), "the focus starts on the image, so its keys work at once");
  assert.equal(p.stageEl().getAttribute("aria-label"), "one.png");
  assert.match(p.document.getElementById(p.stageEl().getAttribute("aria-describedby")).textContent, /Plus and minus zoom/);
  assert.equal(p.output(), "–", "no scale before the image has loaded");
  p.load(2000, 1000);
  await until(() => p.output() === "50%", "it opens fitted");
  assert.deepEqual(p.pressed(), ["Fit"]);
  assert.equal(p.transform(), "translate(0px, 100px) scale(0.5)", "whole and centred");
  assert.equal(p.button("Zoom out").disabled, true, "out no further than the whole image");

  // A wheel notch in, at a point: that point of the image stays under it.
  const event = p.wheel(-100, { x: 250, y: 150 });
  assert.equal(event.defaultPrevented, true, "the page neither scrolls nor zooms");
  await until(() => p.output() !== "50%", "the wheel zooms");
  assert.deepEqual(p.pressed(), [], "a zoom by hand is no mode");
  const [, x, y, scale] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(p.transform()).map(Number);
  assert.ok(Math.abs(x + ((250 - 0) / 0.5) * scale - 250) < 0.5 && Math.abs(y + ((150 - 100) / 0.5) * scale - 150) < 0.5, p.transform());
  // A trackpad pinch (Ctrl + wheel) zooms the image, not the page.
  const pinch = p.wheel(-20, { x: 500, y: 350 }, { ctrlKey: true });
  assert.equal(pinch.defaultPrevented, true);

  // Dragging moves it; past its edge it stops; let go, it stays in bounds.
  p.button("1:1").click();
  await until(() => p.output() === "100%", "actual size");
  assert.deepEqual(p.pressed(), ["1:1"]);
  const before = p.transform();
  p.pointer("pointerdown", 500, 300);
  assert.ok(p.stageEl().hasAttribute("data-dragging"));
  p.pointer("pointermove", 400, 250);
  await until(() => p.transform() !== before, "the drag moves it");
  p.pointer("pointermove", 99999, 99999);
  p.pointer("pointerup", 99999, 99999);
  await until(() => !p.stageEl().hasAttribute("data-dragging"), "let go");
  assert.equal(p.transform(), "translate(0px, 0px) scale(1)", "stopped at its top-left edge");
  assert.ok(p.stageEl().hasAttribute("data-movable"), "it can be moved at this size");
  assert.deepEqual(p.pressed(), ["1:1"], "moving keeps the mode");
  assert.deepEqual(p.errors, []);
});

test("T-20 a long screenshot opens as wide as the window from its top; the keys zoom and move it, and stay out of the page's way", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/long.png", name: "long.png" });
  await until(p.image, "the viewer opens");
  p.load(1250, 15000);
  await until(() => p.output() === "80%", "opens at the window's width");
  assert.deepEqual(p.pressed(), ["Fit width"]);
  assert.equal(p.transform(), "translate(0px, 0px) scale(0.8)", "from its top");

  // PageDown and End move down it; Home back to its top.
  let event = p.key("PageDown");
  assert.equal(event.defaultPrevented, true);
  await until(() => p.transform() === "translate(0px, -630px) scale(0.8)", "a page down");
  p.key("End");
  await until(() => p.transform() === `translate(0px, ${700 - 15000 * 0.8}px) scale(0.8)`, "its bottom");
  p.key("Home");
  await until(() => p.transform() === "translate(0px, 0px) scale(0.8)", "its top");
  p.key("ArrowDown", undefined, { shiftKey: true });
  await until(() => p.transform() === "translate(0px, -160px) scale(0.8)", "a long step down");

  // + and − zoom, 0 returns to how it opened, 1 its actual size.
  p.key("+");
  await until(() => p.output() === "100%", "a step in");
  p.key("-");
  await until(() => p.output() === "80%", "a step out");
  p.key("1");
  await until(() => p.output() === "100%" && p.pressed()[0] === "1:1", "actual size");
  p.key("0");
  await until(() => p.pressed()[0] === "Fit width" && p.transform() === "translate(0px, 0px) scale(0.8)", "as it opened");
  p.button("Fit to window").click();
  await until(() => p.pressed()[0] === "Fit", "the whole of it");
  assert.equal(p.output(), "5%");

  // From a button too, + zooms; arrows on a button do nothing here.
  p.key("+", p.button("Zoom in"));
  await until(() => p.output() === "6%", "zoomed from the bar");
  assert.equal(p.key("ArrowDown", p.button("Zoom in")).defaultPrevented, false);
  // None of the viewer's keys reached the window; Escape and Ctrl+key did, untouched.
  p.reached.length = 0;
  p.key("+");
  p.key("PageDown");
  p.key("=", p.stageEl(), { ctrlKey: true });
  assert.deepEqual(p.reached.map((r) => r.key), ["="], "only the browser's own Ctrl+= went on");
  assert.equal(p.reached[0].prevented, false, "and the page's zoom was left alone");
  p.key("Escape");
  await until(() => !p.dialog() || p.window.closed, "Escape closes the dialog");
  assert.deepEqual(p.errors, []);
});

test("T-20 a window resize keeps the mode; a new image starts afresh; a small image is never enlarged; a failed one says so", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/a.png", name: "a.png", onAnnotate: () => (p.window.annotated = true) });
  await until(p.image, "the viewer opens");
  p.load(3000, 1500);
  await until(() => p.output() === "33%", "fitted");
  p.resize(500, 400);
  await until(() => p.output() === "17%", "still the whole image after a resize");
  assert.deepEqual(p.pressed(), ["Fit"]);
  p.wheel(-300, { x: 100, y: 100 });
  await until(() => p.pressed().length === 0, "a free zoom");
  const zoomed = p.output();
  p.resize(800, 600);
  await tick(40);
  assert.equal(p.output(), zoomed, "a free zoom keeps its scale through a resize");

  // Mark up is on the bar, and hands the original over as before.
  p.button("Mark up").click();
  assert.equal(p.window.annotated, true);

  // Another image: nothing of the first one's view.
  p.window.showPreview({ open: true, src: "/b.png", name: "b.png" });
  await until(() => p.image()?.getAttribute("src") === "/b.png", "the next image");
  assert.equal(p.output(), "–");
  assert.deepEqual(p.pressed(), []);
  p.load(120, 80);
  await until(() => p.output() === "100%", "a small image at its own size");
  assert.deepEqual(p.pressed(), ["Fit"]);
  assert.equal(p.transform(), "translate(340px, 260px) scale(1)", "centred, not enlarged");
  assert.equal(p.stageEl().hasAttribute("data-movable"), false, "nothing to drag");
  p.button("Fit width").click();
  await until(() => p.output() === "667%", "Fit width fills the width when asked");

  // One that cannot be read: said, with nothing to zoom or mark.
  p.window.showPreview({ open: true, src: "/gone.png", name: "gone.png", onAnnotate: () => {} });
  await until(() => p.image()?.getAttribute("src") === "/gone.png", "the missing image");
  p.image().dispatchEvent(new p.window.Event("error"));
  await until(() => p.dialog().querySelector('[role="alert"]'), "the failure");
  assert.match(p.dialog().querySelector('[role="alert"]').textContent, /unavailable/);
  assert.equal(p.dialog().querySelector(".image-viewer"), null);
  assert.equal(p.button("Mark up"), undefined);
  assert.deepEqual(p.errors, []);
});

test("T-20 an Agent's image file opens in the same viewer, with Mark up below it; one that cannot be read says so", async (t) => {
  const p = mount();
  t.after(p.close);
  const shot = { kind: "image", name: "shot.png", path: "out/shot.png" };
  p.window.showArtifact({ artifact: shot, onAnnotate: () => (p.window.annotated = true) });
  await until(p.image, "the viewer opens");
  assert.equal(p.image().getAttribute("src"), "/api/artifact?agentId=a&path=out%2Fshot.png", "read as an Agent's file always was");
  assert.ok(p.dialog().classList.contains("image-viewer-modal"));
  p.load(800, 6000);
  await until(() => p.output() === "100%", "a long narrow image at its own size, from the top");
  assert.deepEqual(p.pressed(), ["1:1"]);
  assert.equal(p.transform(), "translate(100px, 0px) scale(1)");
  p.button("Mark up").click();
  assert.equal(p.window.annotated, true);
  p.image().dispatchEvent(new p.window.Event("error"));
  await until(() => p.dialog().querySelector('[role="alert"]'), "the failure");
  assert.match(p.dialog().querySelector('[role="alert"]').textContent, /can't be read/);
  assert.equal(p.button("Mark up"), undefined, "nothing to mark");
  // A text file opens as before, not in the viewer.
  p.window.showArtifact({ artifact: { kind: "text", name: "notes.md", path: "notes.md" } });
  await until(() => p.dialog() && !p.dialog().querySelector(".image-viewer"), "a text file");
  assert.equal(p.dialog().classList.contains("image-viewer-modal"), false);
  assert.deepEqual(p.errors, []);
});
