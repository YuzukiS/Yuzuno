import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// Compile the source component in memory, leaving every served dist untouched.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "plan-source-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurn=(props)=>root.render(<Turn {...props}/>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "PlanSource", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

test("native plan summary resolves to visible source evidence and survives phase updates", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  try {
    window.eval(bundle);
    const turn = {id:"native-turn", status:"inProgress", items:[], _yuzunoPlan:[
      {step:"Inspect the native session",status:"completed"},
      {step:"验证中断与恢复",status:"inProgress"},
    ]};
    // The Core's rail projector returns this stable evidence-anchor contract.
    const summary = {turnId:"native-turn",itemId:"yuzuno-plan-native-turn",text:"验证中断与恢复"};
    const props = {turn,index:0,agent:{id:"a",name:"Dev",status:"working",color:"sage",harness:"codex"},sourceItemId:summary.itemId,onFile(){}};
    window.renderTurn(props);
    await new Promise(resolve => setTimeout(resolve, 35));
    const conversation = window.document.getElementById(`turn-${summary.turnId}`);
    const source = [...conversation.querySelectorAll("[data-item-id]")].find(node => node.dataset.itemId === summary.itemId);
    assert.ok(source, "source jump must resolve the exact projected anchor");
    assert.equal(source.id, `item-${summary.itemId}`);
    assert.ok(source.classList.contains("source-highlight"));
    assert.ok(source.textContent.includes(summary.text));
    assert.equal(source.querySelector('[data-plan-status="inProgress"]').textContent.trim(),"验证中断与恢复 · In progress");
    const details = source.closest("details");
    assert.match(details.querySelector("summary").textContent,/Agent plan/);
    // The App source jump opens ancestor details; the target is inside them.
    details.open = true;
    assert.equal(details.open,true);
    assert.equal(source.querySelectorAll(".final-message, .commentary").length,0,"plan evidence must not impersonate a conversation message");
    window.renderTurn({...props,turn:{...turn,_yuzunoPlan:turn._yuzunoPlan.map(step=>({...step,status:"completed"}))}});
    await new Promise(resolve => setTimeout(resolve,35));
    assert.ok(window.document.getElementById(`item-${summary.itemId}`) === source, "plan updates must retain the same source anchor");
    assert.equal(source.querySelectorAll('[data-plan-status="completed"]').length,2);
  } finally { window.close(); }
});
