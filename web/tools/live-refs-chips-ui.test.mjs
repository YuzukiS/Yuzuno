import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Live reference chips (T-9) through the real BriefSectionBody: a task Core
// does not know is "not found"; one Core could not read says so instead,
// and a found one keeps the state Core read. No Core or browser.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "live-refs-chips-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {BriefSectionBody} from ${JSON.stringify(path.join(root, "src/home/brief/BriefSectionBody.tsx"))};
import {saveLanguagePreferences} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
const root=createRoot(document.getElementById('root'));
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
window.renderSection=(section)=>flushSync(()=>root.render(<BriefSectionBody section={section} projectId="p1"/>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "LiveRefsChips", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const section = {
  key: "work", kind: "report", title: "Work", version: 2, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: "2026-10-30T00:00:00Z", updatedTurnId: null, attachments: [], seen: null, history: false,
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["refs"] },
    refs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-9" }, { kind: "task", id: "T-999" }, { kind: "task", id: "T-15" }] } },
  } },
  refs: {
    "task:T-9": { kind: "task", id: "T-9", found: true, title: "Live list", state: "doing", tone: "active",
      assignee: { kind: "agent", id: "a", name: "Mori" }, updatedAt: "2026-10-30T00:10:00Z" },
    "task:T-999": { kind: "task", id: "T-999", found: false },
    "task:T-15": { kind: "task", id: "T-15", found: false, unavailable: true },
  },
};

test("a chip says not found for an unknown item and couldn't read for one Core failed to read", async () => {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  try {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.eval(bundle);
    const chips = () => [...window.document.querySelectorAll(".brief-ref")].map((chip) => [
      chip.querySelector("span")?.textContent, chip.querySelector(".brief-ref-state")?.textContent, chip.dataset.tone]);
    window.renderSection(section);
    await tick();
    assert.deepEqual(chips(), [["Live list", "doing", "active"], ["T-999", "not found", "missing"], ["T-15", "couldn't read", "missing"]]);
    window.chooseLanguage("zh-Hans");
    window.renderSection(structuredClone(section));
    await tick();
    assert.deepEqual(chips().map((chip) => chip[1]), ["doing", "未找到", "读取失败"]);
    assert.deepEqual(errors, []);
  } finally {
    window.close();
  }
});
