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
    // A form is shown for one source in one Workspace, and saves its unsent
    // answers under both (T-195); a test that needs another Workspace, or no
    // Workspace yet, passes its own draftIdentity.
    render: ({ identity = "a:result1", ...props } = {}) =>
      window.renderForm({
        identity,
        draftIdentity: JSON.stringify(["ws-1", identity]),
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
// T-195: two saved Workspaces can sit at one address and their Agents can
// share an id, so a key of the source alone handed each the other's answers.
test("the same form source in two Workspaces keeps two sets of unsent answers", async () => {
  const page = mount();
  const type = (text) => {
    const input = page.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  };
  const submit = async () => {};
  try {
    page.render({ onSubmit: submit });
    await tick();
    type("written here");
    await tick();
    // The same source, read by the same page in another Workspace.
    page.render({ draftIdentity: JSON.stringify(["ws-other", "a:result1"]), onSubmit: submit });
    await tick();
    assert.equal(
      page.document.querySelector("textarea").value,
      "/home/me/project",
      "the other Workspace sees the form as it was published, not these answers",
    );
    type("written there");
    await tick();
    page.render({ onSubmit: submit });
    await tick();
    assert.equal(page.document.querySelector("textarea").value, "written here");
    const keys = Object.keys(page.window.localStorage).filter((key) => key.startsWith("yuzuno.clarification.v1:"));
    assert.equal(keys.length, 2, "one saved draft each, apart");
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("answers typed before this window knows its Workspace are kept, reach disk once it does, and overwrite nothing", async () => {
  const page = mount();
  const submit = async () => {};
  try {
    // A form shown before /api/workspace answers has no Workspace to be
    // attributed to, so nothing is read or written for it.
    page.render({ draftIdentity: null, onSubmit: submit });
    await tick();
    const input = page.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(input, "typed before the Workspace was known");
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await tick();
    assert.deepEqual(
      Object.keys(page.window.localStorage).filter((key) => key.startsWith("yuzuno.clarification.v1:")),
      [],
      "nothing is saved where no Workspace owns it",
    );
    // The Workspace arrives. What is on screen is the person's own newer
    // answer: it stays, and is what reaches disk.
    page.render({ onSubmit: submit });
    await tick();
    assert.equal(
      page.document.querySelector("textarea").value,
      "typed before the Workspace was known",
      "what was typed is not thrown away",
    );
    const keys = Object.keys(page.window.localStorage).filter((key) => key.startsWith("yuzuno.clarification.v1:"));
    assert.equal(keys.length, 1);
    assert.match(page.window.localStorage.getItem(keys[0]), /typed before the Workspace was known/);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a refusal from the Workspace before this one is not shown here, and leaves this form usable", async () => {
  const page = mount();
  let refuse;
  const submit = () => new Promise((_, reject) => { refuse = () => reject(Error("Native rejected this reply")); });
  try {
    page.render({ onSubmit: submit });
    await tick();
    const input = page.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, "value").set.call(input, "answered here");
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    page.document.querySelector('input[value="keyboard"]').click();
    await tick();
    page.button("Submit answers").click();
    await tick();
    assert.ok(page.button("Sending answers…"), "it is sending");
    // The Core at this address now answers as another Workspace.
    page.render({ draftIdentity: JSON.stringify(["ws-other", "a:result1"]), onSubmit: submit });
    await tick();
    assert.equal(
      page.document.querySelector("textarea").value,
      "/home/me/project",
      "this Workspace's form is its own",
    );
    assert.ok(
      page.button("Submit answers"),
      "and is not left sending the other Workspace's answers",
    );
    refuse();
    await tick();
    assert.doesNotMatch(
      page.document.body.textContent,
      /Native rejected/,
      "the other Workspace's refusal is not shown here",
    );
    assert.ok(
      page.button("Submit answers") && !page.button("Submit answers").disabled,
      "and this form can still be submitted",
    );
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
