import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// The turn dock follows Settings (Appearance, Turn dock): how many Turns show
// their number, how many bars lead on each side, and 0 numbers hides it. The
// real TurnNavigator in JSDOM; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "turn-dock-settings-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React, {useRef} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {TurnNavigator} from ${JSON.stringify(path.join(root, "src/TurnNavigator.tsx"))};
import {readAppearance, saveAppearance} from ${JSON.stringify(path.join(root, "src/appearance.ts"))};
function Dock({turns}) {
  const scroll = useRef(null);
  return <div className="conversation-body"><div ref={scroll} /><TurnNavigator turns={turns} scrollRef={scroll} onNavigate={() => {}} onInteractionChange={() => {}} /></div>;
}
const root = createRoot(document.getElementById('root'));
window.renderDock = (turns) => flushSync(() => root.render(<Dock turns={turns} />));
window.setTurnDock = (turnDock) => flushSync(() => saveAppearance({...readAppearance(), turnDock}));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "TurnDockSettings", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const turns = Array.from({ length: 30 }, (_, n) => ({
  id: `t${n}`,
  status: "completed",
  items: [{ id: `u${n}`, type: "userMessage", content: [{ type: "text", text: `Request ${n}` }] }],
}));

function mount(appearance) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (appearance) window.localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  window.eval(bundle);
  window.renderDock(turns);
  const doc = window.document;
  return {
    window,
    errors,
    dock: () => doc.querySelector(".turn-dock"),
    numbers: () => [...doc.querySelectorAll(".turn-dock-chip")].map((chip) => chip.textContent.trim()),
    bars: () => doc.querySelectorAll(".turn-dock-bar").length,
    // The bars' fade spreads over the configured count (turn-dock.css).
    span: () => doc.querySelector(".turn-dock-list").style.getPropertyValue("--bar-span"),
    close: () => window.close(),
  };
}

test("by default the dock numbers the five latest turns, with five bars before them", (t) => {
  const page = mount();
  t.after(page.close);
  assert.deepEqual(page.numbers(), ["26", "27", "28", "29", "30"]);
  assert.equal(page.bars(), 5);
  assert.equal(page.span(), "4", "five bars fade as before");
  assert.deepEqual(page.errors, []);
});

test("Settings choose how many turns are numbered and how many bars lead on; a change applies at once", (t) => {
  const page = mount({ turnDock: { numbers: 3, bars: 2 } });
  t.after(page.close);
  assert.deepEqual(page.numbers(), ["28", "29", "30"]);
  assert.equal(page.bars(), 2);
  page.window.setTurnDock({ numbers: 3, bars: 10 });
  assert.equal(page.bars(), 10);
  assert.equal(page.span(), "9", "ten bars spread the same fade over ten");
  page.window.setTurnDock({ numbers: 8, bars: 0 });
  assert.deepEqual(page.numbers(), ["23", "24", "25", "26", "27", "28", "29", "30"]);
  assert.equal(page.bars(), 0, "no bars");
  // 0 numbered turns hides the dock; choosing again brings it back.
  page.window.setTurnDock({ numbers: 0, bars: 5 });
  assert.equal(page.dock(), null, "the dock is hidden");
  page.window.setTurnDock({ numbers: 1, bars: 1 });
  assert.deepEqual(page.numbers(), ["30"]);
  assert.equal(page.bars(), 1);
  assert.deepEqual(page.errors, []);
});
