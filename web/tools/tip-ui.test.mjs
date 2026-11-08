// The app's one tip (web/src/Tip.tsx, YN-44) where S2b moved the composer's
// and the conversation's titles onto it:
//  - `cut`: a name's tip shows only while the name is cut;
//  - a held trigger (`hold`): a disabled control's tip opens from the span
//    around it, which is what an engine that sends a disabled control no
//    pointer events (WebKit) leaves to the pointer; enabled and disabled,
//    the control stays the same element;
//  - the composer's "+" says what it holds, not while its menu is open, and
//    each entry of the menu says what it adds.
// No Core, no browser, no web/dist writes, and nothing is fetched.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { hoverTip, readTip, shownTip } from "./tip-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "tip-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Tip, TipText} from ${JSON.stringify(path.join(root, "src/Tip.tsx"))};
import {ComposerAddMenu} from ${JSON.stringify(path.join(root, "src/ComposerAddMenu.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTips=({chosen,sendDisabled=true})=>flushSync(()=>root.render(<>
  <Tip content={<TipText title="A name long enough to be cut" />} cut><span className="name">A name long enough to be cut</span></Tip>
  <Tip content={<TipText title="Send message" body="Wait for this turn to finish, or interrupt" />} hold>
    <button type="button" className="send" disabled={sendDisabled} aria-label="Send message">↑</button>
  </Tip>
  <ComposerAddMenu label="Add" menuLabel="Add to your draft"
    tip={<TipText title="Add to your draft" meta={["Add images", "Mark up an image", "Ask for an interactive result"]} />}
    items={[
      { key: "images", label: "Add images", icon: null, tip: <TipText body="PNG, JPEG or WebP, up to 8 per message." />, onSelect: () => chosen.push("images") },
      { key: "result", label: "Ask for an interactive result", icon: null, tip: <TipText body="A table or chart you can explore." />, onSelect: () => chosen.push("result") },
      { key: "none", label: "Unavailable", icon: null, note: "Says why under its label", unavailable: true, onSelect: () => chosen.push("none") },
    ]} />
</>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "TipUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.eval(bundle);
  const chosen = [];
  window.renderTips({ chosen });
  return { window, document: window.document, errors, chosen, render: (props) => window.renderTips({ chosen, ...props }), close: () => window.close() };
}

/** Rests a pointer on `target` past the delay; whether a tip showed. */
async function rests(page, target) {
  target.dispatchEvent(new page.window.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  await pause(600);
  const shown = !!shownTip(page.window);
  target.dispatchEvent(new page.window.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: page.document.body }));
  await pause(450);
  return shown;
}

/** Gives `element` a box `client` wide holding text `scroll` wide. */
function measure(element, client, scroll) {
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => client });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scroll });
}

test("a cut name's tip shows only while the name is cut", async () => {
  const page = mount();
  try {
    const name = page.document.querySelector(".name");
    measure(name, 200, 120);
    assert.equal(await rests(page, name), false, "shown whole, it has no tip");
    measure(name, 120, 200);
    assert.deepEqual(await hoverTip(page.window, name), ["A name long enough to be cut"], "cut, its whole name");
    assert.equal(name.hasAttribute("title"), false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a held disabled control shows its tip from the span around it, and stays the same element enabled", async () => {
  const page = mount();
  try {
    const send = page.document.querySelector(".send");
    const hold = send.parentElement;
    assert.equal(send.disabled, true);
    assert.ok(hold.matches("span.tip-hold"), "held in a span of its own");
    // Where WebKit sends the pointer: past the disabled button, to the span.
    assert.deepEqual(await hoverTip(page.window, hold), ["Send message", "Wait for this turn to finish, or interrupt"]);
    // Where Chromium sends it: the button, its events passing up to the span.
    assert.deepEqual(await hoverTip(page.window, send), ["Send message", "Wait for this turn to finish, or interrupt"]);
    assert.equal(send.hasAttribute("title"), false);
    page.render({ sendDisabled: false });
    assert.equal(page.document.querySelector(".send"), send, "enabled, the same button: nothing was remounted");
    assert.equal(send.parentElement, hold);
    assert.equal(send.disabled, false);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("the composer's + says what it holds, not while its menu is open; each entry says what it adds", async () => {
  const page = mount();
  try {
    const plus = page.document.querySelector(".composer-plus");
    assert.deepEqual(await readTip(page.window, plus), ["Add to your draft", "Add images · Mark up an image · Ask for an interactive result"]);
    // A press, as a mouse gives it: the focus the menu moves in is not the keyboard's.
    plus.dispatchEvent(new page.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    plus.click();
    const images = await (async () => {
      for (let i = 0; i < 50; i++) {
        const item = page.document.querySelector('.composer-add-menu [role="menuitem"][aria-label="Add images"]');
        if (item) return item;
        await pause(20);
      }
      assert.fail("the menu did not open");
    })();
    assert.equal(await rests(page, plus), false, "open, the menu says it all");
    assert.deepEqual(await hoverTip(page.window, images), ["PNG, JPEG or WebP, up to 8 per message."]);
    const result = page.document.querySelector('.composer-add-menu [role="menuitem"][aria-label="Ask for an interactive result"]');
    assert.deepEqual(await hoverTip(page.window, result), ["A table or chart you can explore."]);
    const none = page.document.querySelector('.composer-add-menu [role="menuitem"][aria-label="Unavailable"]');
    assert.equal(await rests(page, none), false, "an unavailable entry's note under its label says why; no tip repeats it");
    assert.equal(page.document.querySelectorAll(".composer-add-menu [title], .composer-plus[title]").length, 0, "no native titles");
    assert.deepEqual(page.chosen, [], "resting chooses nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
