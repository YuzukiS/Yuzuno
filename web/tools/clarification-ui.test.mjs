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

// T-189: the form's own words follow the interface language, changed in
// another window. The questions, options, answers, the Agent's name and
// Core's words stay as written; nothing is sent by the change.
test("the form's own words follow a language change; the answers stay and nothing is sent", async () => {
  const page = mount();
  const sent = [];
  const speak = (language) => {
    page.window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    page.window.dispatchEvent(new page.window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  try {
    page.render({ onSubmit: async (values) => void sent.push(values) });
    await tick();
    const input = page.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(input, "/work/中文");
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await tick();
    speak("zh-Hans");
    await tick();
    const text = page.document.body.textContent;
    for (const words of ["Working directory必填", "Preview theme必填", "你的答案会在此会话中发给 Mori。"]) assert.ok(text.includes(words), words);
    assert.ok(text.includes("Light") && text.includes("Dark"), "the options as written");
    assert.ok(page.button("提交答案"));
    assert.equal(page.document.querySelector("textarea").value, "/work/中文", "the answer stays");
    assert.deepEqual(sent, [], "nothing is sent by the change");
    page.render({ delivery: { status: "queued", input: {}, values: {} } });
    await tick();
    assert.ok(page.document.body.textContent.includes("已发送 · 等待 Mori 确认。"));
    page.render({ delivery: { status: "uncertain", input: {}, values: {} }, onCheck: () => {} });
    await tick();
    assert.ok(page.document.body.textContent.includes("投递尚未确认。再次发送之前，请先查看会话。"));
    assert.ok(page.button("检查投递"));
    page.render({ blockedReason: "Core closed this Agent: archived" });
    await tick();
    assert.ok(page.document.body.textContent.includes("Core closed this Agent: archived"), "a reason given by the caller as it came");
    speak("en");
    await tick();
    assert.ok(page.button("Submit answers"));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
