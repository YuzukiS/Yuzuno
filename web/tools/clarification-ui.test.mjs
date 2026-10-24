import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { clarificationExample } from "../src/intelligent-ui/clarification.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "../target/t38/unit");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "form-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom'; import {createRoot} from 'react-dom/client';
import {Clarification} from ${JSON.stringify(path.join(root, "src/intelligent-ui/ClarificationForm.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderForm=(props)=>flushSync(()=>root.render(<Clarification {...props}/>));`,
  );
  const result = await build({
    root,
    resolve: {
      alias: {
        react: path.join(root, "node_modules/react"),
        "react-dom": path.join(root, "node_modules/react-dom"),
      },
    },
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "ClarificationFixture", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
function mount() {
  const errors = [];
  const logs = new VirtualConsole();
  logs.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://form.test",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole: logs,
    },
  );
  const { window } = dom;
  window.structuredClone = structuredClone;
  window.eval(bundle);
  return {
    window,
    document: window.document,
    errors,
    close: () => window.close(),
    render: (props) =>
      window.renderForm({
        identity: "a:result1",
        form: clarificationExample,
        agentName: "Mori",
        ...props,
      }),
    button: (text) =>
      [...window.document.querySelectorAll("button")].find(
        (button) => button.textContent === text,
      ),
  };
}
test("explicit submit sends the exact values once, rejected delivery preserves draft, source switches restore independently", async () => {
  const page = mount();
  const sent = [];
  let release;
  const submit = (values) => {
    sent.push(values);
    return new Promise((resolve, reject) => {
      release = () => reject(Error("Native rejected this reply"));
    });
  };
  try {
    page.render({ onSubmit: submit });
    await tick();
    const input = page.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(
      page.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input, "中文项目");
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    page.document.querySelector('input[value="keyboard"]').click();
    await tick();
    page.button("Submit answers").click();
    page.button("Submit answers")?.click();
    await tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      directory: "中文项目",
      theme: "light",
      checks: ["keyboard"],
    });
    release();
    await tick();
    assert.equal(page.document.querySelector("textarea").value, "中文项目");
    assert.match(page.document.body.textContent, /Native rejected/);
    page.render({ identity: "b:other", onSubmit: submit });
    await tick();
    assert.equal(
      page.document.querySelector("textarea").value,
      "/home/me/project",
    );
    page.render({ onSubmit: submit });
    await tick();
    assert.equal(page.document.querySelector("textarea").value, "中文项目");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
test("IME does not submit, Escape stays inside the form, and uncertain receipts prevent another send", async () => {
  const page = mount();
  let escaped = 0;
  let sent = 0;
  try {
    page.window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") escaped++;
    });
    page.render({
      onSubmit: async () => {
        sent++;
      },
    });
    await tick();
    const input = page.document.querySelector("textarea");
    input.dispatchEvent(
      new page.window.CompositionEvent("compositionstart", { bubbles: true }),
    );
    page.button("Submit answers").click();
    await tick();
    assert.equal(page.document.querySelector('[role="dialog"]'), null);
    input.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    );
    assert.equal(escaped, 0);
    input.dispatchEvent(
      new page.window.CompositionEvent("compositionend", { bubbles: true }),
    );
    page.render({
      onSubmit: async () => {
        sent++;
      },
      delivery: { status: "uncertain" },
      onCheck: () => {},
    });
    await tick();
    assert.equal(page.button("Submit answers").disabled, true);
    assert.ok(page.button("Check delivery"));
    assert.equal(sent, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
