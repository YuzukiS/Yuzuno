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
  const pointer = (type, x, y, id = 1, pointerType = "mouse", target = stageEl()) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
    target.dispatchEvent(event);
  };
  const heading = () => ({ title: dialog().querySelector("h2").textContent, details: dialog().querySelector(".modal-heading p")?.textContent ?? "" });
  const parse = () => /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(transform()).slice(1).map(Number);
  return { window, document, errors, reached, dialog, image, output, button, pressed, transform, parse, heading, load, resize, wheel, key, pointer, stageEl, close: () => window.close() };
}

test("T-20 a photo opens whole; the wheel zooms at the pointer and is taken from the page; drag and double-click", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/api/agents/a/images/one.png", name: "one.png", description: "Attached image" });
  await until(p.image, "the viewer opens");
  assert.equal(p.image().getAttribute("src"), "/api/agents/a/images/one.png", "the original, never the thumbnail");
  assert.equal(p.dialog().querySelector(".input-image-dialog img"), p.image());
  assert.equal(p.document.activeElement, p.stageEl(), "the focus starts on the image, so its keys work at once");
  assert.match(p.document.getElementById(p.stageEl().getAttribute("aria-describedby")).textContent, /Plus and minus zoom/);
  assert.equal(p.output(), "–", "no scale before the image has loaded");
  assert.match(p.stageEl().textContent, /Loading image/);
  assert.deepEqual(p.heading(), { title: "one.png", details: "Attached image" });
  p.load(2000, 1000);
  await until(() => p.output() === "50%", "it opens fitted");
  assert.deepEqual(p.pressed(), ["Fit"]);
  assert.equal(p.transform(), "translate(0px, 100px) scale(0.5)", "whole and centred");
  assert.equal(p.button("Zoom out").disabled, true, "out no further than the whole image");
  assert.deepEqual(p.heading(), { title: "one.png", details: "2000 × 1000 px · Attached image" }, "its size in pixels, once read");
  await until(() => p.stageEl().getAttribute("aria-label") === "one.png, 50%, Fit", "the stage says its view, once settled");

  // A wheel's turn in, at the middle: that point of the image stays under it.
  const event = p.wheel(-400, { x: 500, y: 350 });
  assert.equal(event.defaultPrevented, true, "the page neither scrolls nor zooms");
  await until(() => p.output() !== "50%", "the wheel zooms");
  assert.deepEqual(p.pressed(), [], "a zoom by hand is no mode");
  const [x, y, scale] = p.parse();
  assert.ok(Math.abs(x + 1000 * scale - 500) < 0.5 && Math.abs(y + 500 * scale - 350) < 0.5, p.transform());
  assert.equal(p.stageEl().hasAttribute("data-animate"), false, "a gesture follows at once");
  // A trackpad pinch (Ctrl + wheel) zooms the image, not the page.
  assert.equal(p.wheel(-20, { x: 500, y: 350 }, { ctrlKey: true }).defaultPrevented, true);

  // Dragging moves it; past its edge it stops; let go, it stays in bounds.
  p.button("Actual size").click();
  await until(() => p.output() === "100%", "actual size");
  assert.deepEqual(p.pressed(), ["Actual size"]);
  assert.equal(p.stageEl().hasAttribute("data-animate"), true, "a button's change glides");
  const before = p.transform();
  p.pointer("pointerdown", 500, 300);
  await until(() => p.stageEl().hasAttribute("data-dragging"), "the drag starts");
  p.pointer("pointermove", 400, 250);
  await until(() => p.transform() !== before, "the drag moves it");
  p.pointer("pointermove", 99999, 99999);
  p.pointer("pointerup", 99999, 99999);
  await until(() => !p.stageEl().hasAttribute("data-dragging"), "let go");
  assert.equal(p.transform(), "translate(0px, 0px) scale(1)", "stopped at its top-left edge");
  assert.ok(p.stageEl().hasAttribute("data-movable"), "it can be moved at this size");
  assert.deepEqual(p.pressed(), ["Actual size"], "moving keeps the mode");

  // Double-click: back to how it opened; again, actual size at that point.
  p.stageEl().dispatchEvent(new p.window.MouseEvent("dblclick", { clientX: 250, clientY: 150, bubbles: true }));
  await until(() => p.output() === "50%" && p.pressed()[0] === "Fit", "back to the whole image");
  p.stageEl().dispatchEvent(new p.window.MouseEvent("dblclick", { clientX: 500, clientY: 350, bubbles: true }));
  await until(() => p.output() === "100%", "actual size at the point");
  const [ax, ay] = p.parse();
  assert.deepEqual([ax, ay], [-500, -150], "the image point under it, (1000, 500), stays there");
  assert.deepEqual(p.errors, []);
});

test("T-20 a long screenshot opens as wide as the stage from its top; keys, the position bar and the phone's menu move and zoom it", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/long.png", name: "long.png" });
  await until(p.image, "the viewer opens");
  p.load(1250, 15000);
  await until(() => p.output() === "80%", "opens at the stage's width");
  assert.deepEqual(p.pressed(), ["Fit width"]);
  assert.equal(p.transform(), "translate(0px, 0px) scale(0.8)", "from its top");
  const bars = () => [...p.dialog().querySelectorAll(".image-viewer-track")].map((bar) => bar.dataset.axis);
  assert.deepEqual(bars(), ["y"], "a position bar down its side only");
  const thumb = () => p.dialog().querySelector('.image-viewer-track[data-axis="y"] > .image-viewer-thumb');
  assert.equal(thumb().style.top, "0%");

  // PageDown and End move down it; Home back to its top; arrows a tenth of the stage.
  assert.equal(p.key("PageDown").defaultPrevented, true);
  await until(() => p.transform() === "translate(0px, -630px) scale(0.8)", "a page down");
  p.key("End");
  await until(() => p.transform() === `translate(0px, ${700 - 15000 * 0.8}px) scale(0.8)`, "its bottom");
  assert.ok(Math.abs(parseFloat(thumb().style.top) + parseFloat(thumb().style.height) - 100) < 1e-6, "the bar's thumb at its end");
  p.key("Home");
  await until(() => p.transform() === "translate(0px, 0px) scale(0.8)", "its top");
  p.key("ArrowDown");
  await until(() => p.transform() === "translate(0px, -70px) scale(0.8)", "a tenth of the stage down");
  // The thumb dragged 70 px (a tenth of its bar) moves a tenth of the image, not starting a drag of the image.
  p.pointer("pointerdown", 995, 10, 7, "mouse", thumb());
  assert.equal(p.stageEl().hasAttribute("data-dragging"), false);
  p.pointer("pointermove", 995, 80, 7, "mouse", thumb());
  await until(() => p.transform() === `translate(0px, ${-70 - 1200}px) scale(0.8)`, "the thumb moves the view");
  p.pointer("pointerup", 995, 80, 7, "mouse", thumb());

  // + and − zoom; 0 fits the whole image, W its width, 1 actual size.
  p.key("+");
  await until(() => p.output() === "100%", "a step in");
  p.key("-");
  await until(() => p.output() === "80%", "a step out");
  p.key("1");
  await until(() => p.output() === "100%" && p.pressed()[0] === "Actual size", "actual size");
  p.key("0");
  await until(() => p.pressed()[0] === "Fit" && p.output() === "5%", "the whole of it");
  p.key("w");
  await until(() => p.pressed()[0] === "Fit width" && p.output() === "80%", "its width again");
  // The phone's menu on the scale chooses a view too.
  const menu = p.dialog().querySelector("select.image-viewer-menu");
  assert.equal(menu.getAttribute("aria-label"), "Zoom 80%: choose a view");
  menu.value = "fit";
  menu.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await until(() => p.pressed()[0] === "Fit", "chosen from the menu");

  // From a button too, + zooms; arrows on a button do nothing here.
  p.key("+", p.button("Zoom in"));
  await until(() => p.output() === "6%", "zoomed from the bar");
  assert.equal(p.key("ArrowDown", p.button("Zoom in")).defaultPrevented, false);
  // None of the viewer's keys reached the window; Ctrl+= and Escape did, untouched.
  p.reached.length = 0;
  p.key("+");
  p.key("PageDown");
  p.key("w");
  p.key("=", p.stageEl(), { ctrlKey: true });
  assert.deepEqual(p.reached.map((r) => r.key), ["="], "only the browser's own Ctrl+= went on");
  assert.equal(p.reached[0].prevented, false, "and the page's zoom was left alone");
  p.key("Escape");
  await until(() => p.window.closed, "Escape closes the dialog");
  assert.deepEqual(p.errors, []);
});

test("T-20 a caption leads; a resize keeps the mode; a new image starts afresh; a small one is never enlarged; a failed one says so", async (t) => {
  const p = mount();
  t.after(p.close);
  p.window.showPreview({ open: true, src: "/a.png", name: "a.png", caption: "Login screen", description: "Snapshot 2 hours ago", onAnnotate: () => (p.window.annotated = true) });
  await until(p.image, "the viewer opens");
  assert.equal(p.stageEl().getAttribute("aria-label"), "Login screen");
  p.load(3000, 1500);
  await until(() => p.output() === "33%", "fitted");
  assert.deepEqual(p.heading(), { title: "Login screen", details: "a.png · 3000 × 1500 px · Snapshot 2 hours ago" }, "what it shows first, then its file");
  p.resize(500, 400);
  await until(() => p.output() === "17%", "still the whole image after a resize");
  assert.deepEqual(p.pressed(), ["Fit"]);
  p.wheel(-600, { x: 100, y: 100 });
  await until(() => p.pressed().length === 0, "a free zoom");
  const zoomed = p.output();
  p.resize(800, 600);
  await tick(40);
  assert.equal(p.output(), zoomed, "a free zoom keeps its scale through a resize");

  // Mark up is on the bar, and hands over as before.
  p.button("Mark up").click();
  assert.equal(p.window.annotated, true);

  // Another image: nothing of the first one's view.
  p.window.showPreview({ open: true, src: "/b.png", name: "b.png" });
  await until(() => p.image()?.getAttribute("src") === "/b.png", "the next image");
  assert.equal(p.output(), "–");
  assert.deepEqual(p.pressed(), []);
  p.load(120, 80);
  await until(() => p.output() === "100%", "a small image at its own size");
  assert.deepEqual(p.pressed(), ["Actual size"], "Fit would have enlarged it");
  assert.equal(p.transform(), "translate(340px, 260px) scale(1)", "centred, not enlarged");
  assert.equal(p.stageEl().hasAttribute("data-movable"), false, "nothing to drag");
  assert.equal(p.dialog().querySelectorAll(".image-viewer-track").length, 0, "no position bars");
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

test("T-20 an Agent's image file opens in the same viewer, Mark up on its bar; one that cannot be read says so", async (t) => {
  const p = mount();
  t.after(p.close);
  const shot = { kind: "image", name: "shot.png", path: "out/shot.png" };
  p.window.showArtifact({ artifact: shot, onAnnotate: () => (p.window.annotated = true) });
  await until(p.image, "the viewer opens");
  assert.equal(p.image().getAttribute("src"), "/api/artifact?agentId=a&path=out%2Fshot.png", "read as an Agent's file always was");
  assert.ok(p.dialog().classList.contains("image-viewer-modal"));
  p.load(800, 6000);
  await until(() => p.output() === "100%", "a tall narrow image at its own size, from the top");
  assert.deepEqual(p.pressed(), ["Actual size"]);
  assert.equal(p.transform(), "translate(100px, 0px) scale(1)");
  assert.ok(p.dialog().querySelector(".image-viewer-actions").contains(p.button("Mark up")));
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
