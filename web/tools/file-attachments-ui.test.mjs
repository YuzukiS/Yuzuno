import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { setComposerText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// The conversation composer's files (YN-145 F5): the menu's Add files, the
// file saved to the Agent's own route, chips in the draft, a drop or paste
// split between images and files, a send that waits for a save, and the sent
// message's downloads. Against the built app (YUZUNO_UI_DIST, else web/dist),
// as ui.test.mjs.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundleScript = new vm.Script(await uiTestBundle(new URL(entry, distUrl)));
const pause = () => new Promise((resolve) => setTimeout(resolve, 45));
async function until(read, message) {
  const deadline = Date.now() + 60 * 45;
  for (;;) {
    if (read()) return;
    if (Date.now() >= deadline) assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/** A file as a browser gives one: its bytes are only counted here. */
const file = (window, name, type = "application/pdf", size = 2400000) => {
  const chosen = new window.File(["x".repeat(Math.min(size, 4096))], name, { type });
  Object.defineProperty(chosen, "size", { configurable: true, value: size });
  return chosen;
};
const dropped = (window, files) => ({
  types: ["Files"],
  items: files.map((entry) => ({ kind: "file", getAsFile: () => entry })),
  files,
});
function dropOn(window, element, payload, kind = "drop") {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { configurable: true, value: payload });
  element.dispatchEvent(event);
}
function pasteOn(window, element, payload) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { configurable: true, value: payload });
  element.dispatchEvent(event);
}
const clipboard = (files, text = "") => ({
  items: files.map((entry) => ({ kind: "file", getAsFile: () => entry })),
  files,
  getData: (type) => (type === "text/plain" ? text : ""),
});

/** The app with one idle Agent, Mori; `messages` answers its sends in turn. */
async function mount(harness = "codex", { messages = [], seed = {}, turns = [], remote = false } = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.EventSource = class { close() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
  const agent = { id: "a", name: "Mori", harness, cwd: "/workspace", model: "", color: "green", status: "idle",
    createdAt: "2026-10-28", updatedAt: "2026-10-28", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
    ...(remote ? { remote: { machine: { id: "m1", name: "studio-mac" }, cwd: "/Users/someone/work" } } : {}) };
  let saved = 0;
  let hold = null;
  const uploads = [];
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/api/workspace"))
      return reply(200, { workspace: { id: "ws-1" }, agents: [agent], runtime: { connected: true }, defaultCwd: "/workspace" });
    if (url.endsWith("/api/agents/a")) return reply(200, { agent, pending: [], artifacts: [], messageReceipts: [], turns });
    if (/\/api\/agents\/a\/files\?name=/.test(url)) {
      if (hold) await hold;
      const name = decodeURIComponent(new URL(url, "http://core").searchParams.get("name"));
      const bytes = init.body?.size ?? 12;
      const answer = { id: (++saved).toString(16).padStart(64, "0"), name, bytes };
      uploads.push(answer);
      return reply(200, answer);
    }
    if (url.endsWith("/api/agents/a/messages")) return messages.shift()(JSON.parse(init.body));
    if (/\/models(\?|$)/.test(url)) return reply(200, { models: [] });
    return reply(200, {});
  };
  bundleScript.runInContext(dom.getInternalVMContext());
  const document = window.document;
  const composer = () => document.querySelector('[data-composer-input]');
  await until(() => composer() && !document.querySelector(".conversation-scroll .loading-state"), "Mori's conversation opens");
  const page = {
    window, document, calls, errors, uploads,
    composer: composer(),
    close: () => window.close(),
    filePicker: () => document.querySelector('input[type="file"]:not([accept])'),
    imagePicker: () => document.querySelector('input[type="file"][accept]'),
    chips: () => document.querySelectorAll(".composer-area .input-file"),
    menu: async () => {
      document.querySelector('.composer-tools button[aria-haspopup="menu"]').click();
      await pause();
      return [...document.querySelectorAll('.composer-add-menu [role="menuitem"]')];
    },
    choose: async (files) => {
      const picker = page.filePicker();
      Object.defineProperty(picker, "files", { configurable: true, value: files });
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    chooseImage: async (files) => {
      const picker = page.imagePicker();
      Object.defineProperty(picker, "files", { configurable: true, value: files });
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    holdFiles() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      hold = promise;
      return () => { hold = null; release(); };
    },
    send: () => document.querySelector('[aria-label="Send message"], [aria-label="Send while working"]').click(),
    seed: () => {
      const values = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        values[key] = window.localStorage.getItem(key);
      }
      return values;
    },
  };
  return page;
}

test("the Add menu offers files between Mark up and Ask for an interactive result (YN-145)", async () => {
  const page = await mount("codex");
  try {
    const items = await page.menu();
    assert.deepEqual(items.map((item) => item.getAttribute("aria-label")),
      ["Add images", "Mark up an image", "Add files", "Ask for an interactive result"]);
    const addFiles = items.find((item) => item.getAttribute("aria-label") === "Add files");
    assert.equal(addFiles.hasAttribute("aria-disabled"), false);
    // Choosing a file saves it to this Agent's own route as raw bytes.
    await page.choose([file(page.window, "q3-report.pdf")]);
    await until(() => page.chips().length === 1, "the file is in the draft");
    const post = page.calls.find((call) => call.url.includes("/api/agents/a/files?name="));
    assert.ok(post, "the file was saved to the Agent's files");
    assert.equal(post.url, "/api/agents/a/files?name=q3-report.pdf");
    assert.equal(post.init.headers["Content-Type"], "application/octet-stream");
    const chip = page.chips()[0];
    assert.match(chip.textContent, /q3-report\.pdf/);
    assert.match(chip.textContent, /2\.4 MB/);
    assert.match(chip.textContent, /PDF/);
    chip.querySelector(".input-file-remove").click();
    await pause();
    assert.equal(page.chips().length, 0, "the chip is removed from the draft");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a draft keeps its saved file after a reload, and files alone can be sent (YN-145)", async () => {
  const first = await mount("codex");
  let seed;
  let uploaded;
  try {
    await first.choose([file(first.window, "sensor-log.csv", "text/csv", 860000)]);
    await until(() => first.chips().length === 1, "the file is in the draft");
    uploaded = first.uploads[0];
    seed = first.seed();
  } finally { first.close(); }

  const sent = [];
  const page = await mount("codex", {
    seed,
    messages: [(input) => { sent.push(input); return reply(200, { input, status: "accepted", turnId: "t1", agentId: "a" }); }],
  });
  try {
    await until(() => page.chips().length === 1, "the saved file comes back with the draft");
    assert.match(page.chips()[0].textContent, /sensor-log\.csv/);
    // No text: the file alone is a message Core accepts.
    page.send();
    await until(() => sent.length === 1, "the file-only message is sent");
    assert.equal(sent[0].text, "");
    assert.deepEqual(sent[0].files, [uploaded]);
    await until(() => page.chips().length === 0, "a sent message leaves the draft");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a message without files sends no files field at all (YN-145 D13)", async () => {
  const sent = [];
  const page = await mount("codex", {
    messages: [
      (input) => { sent.push(input); return reply(200, { input, status: "accepted", turnId: "t1", agentId: "a" }); },
      (input) => { sent.push(input); return reply(200, { input, status: "accepted", turnId: "t2", agentId: "a" }); },
    ],
  });
  try {
    setComposerText(page.composer, "plain words");
    await pause();
    page.send();
    await until(() => sent.length === 1, "the plain message is sent");
    assert.equal("files" in sent[0], false);
    await page.choose([file(page.window, "notes.txt", "text/plain", 12)]);
    await until(() => page.chips().length === 1,
      () => `the file is in the draft (${page.document.querySelector(".inline-error")?.textContent || "no error shown"})`);
    setComposerText(page.composer, "with a file");
    await pause();
    await until(() => {
      const button = page.document.querySelector('[aria-label="Send message"]');
      return button && !button.disabled;
    }, "Send is offered again");
    page.send();
    await until(() => sent.length === 2, "the message with a file is sent");
    assert.deepEqual(sent[1].files, [page.uploads[0]]);
    assert.deepEqual(Object.keys(sent[1].files[0]).sort(), ["bytes", "id", "name"]);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a PNG dropped with a PDF goes to images and files apart (YN-145 D11)", async () => {
  const page = await mount("codex");
  try {
    const png = file(page.window, "screen.png", "image/png", 9);
    const pdf = file(page.window, "report.pdf", "application/pdf", 2048);
    dropOn(page.window, page.document.querySelector(".composer"), dropped(page.window, [png, pdf]));
    await until(() => page.document.querySelectorAll(".composer-area .input-image").length === 1, "the PNG is an image");
    await until(() => page.chips().length === 1, "the PDF is a file");
    assert.ok(page.calls.some((call) => call.url.endsWith("/api/agents/a/images")));
    assert.ok(page.calls.some((call) => call.url === "/api/agents/a/files?name=report.pdf"));
    assert.match(page.chips()[0].textContent, /report\.pdf/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a file pasted into the draft goes with it as a file (YN-145)", async () => {
  const page = await mount("codex");
  try {
    pasteOn(page.window, page.composer, clipboard([file(page.window, "pasted.txt", "text/plain", 20)]));
    await until(() => page.chips().length === 1, "the pasted file is in the draft");
    assert.ok(page.calls.some((call) => call.url === "/api/agents/a/files?name=pasted.txt"));
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("Send waits while a file is still being saved (YN-145)", async () => {
  const sent = [];
  const page = await mount("codex", {
    messages: [(input) => { sent.push(input); return reply(200, { input, status: "accepted", turnId: "t1", agentId: "a" }); }],
  });
  try {
    const release = page.holdFiles();
    await page.choose([file(page.window, "big.bin", "application/octet-stream", 5000)]);
    setComposerText(page.composer, "hold on");
    await pause();
    const button = page.document.querySelector('[aria-label="Send message"]');
    assert.equal(button.disabled, true, "Send waits for the save");
    page.send();
    await pause();
    assert.equal(sent.length, 0, "nothing is sent while the file is saving");
    release();
    await until(() => page.chips().length === 1, "the saved file enters the draft");
    await until(() => !page.document.querySelector('[aria-label="Send message"]').disabled, "Send is offered again");
    page.send();
    await until(() => sent.length === 1, "the message is sent");
    assert.deepEqual(sent[0].files, [page.uploads[0]]);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a sent message shows its files as downloads, never the Agent's notice (YN-145)", async () => {
  const id = "a".repeat(64);
  const path = `/core/input-files/a/${id}/q3-report.pdf`;
  const notice = "Attached files: the user attached 1 file to this message.";
  const page = await mount("codex", {
    turns: [{
      id: "turn-1", status: "completed", items: [{
        id: "u1", type: "userMessage", _yuzunoInputText: "see the report",
        _yuzunoFiles: [{ id, name: "q3-report.pdf", bytes: 2400000, path }],
        content: [{ type: "text", text: `see the report\n\n${notice}` }],
      }],
    }],
  });
  try {
    const link = page.document.querySelector(".user-message .input-file a");
    assert.ok(link, "the message shows a file");
    assert.equal(link.getAttribute("href"), `/api/agents/a/files/${id}/q3-report.pdf`);
    assert.equal(link.getAttribute("download"), "q3-report.pdf");
    assert.equal(link.getAttribute("title"), path, "its tip is the path the Agent reads");
    assert.match(link.textContent, /q3-report\.pdf/);
    assert.match(link.textContent, /2\.4 MB/);
    const message = page.document.querySelector(".user-message").textContent;
    assert.match(message, /see the report/);
    assert.equal(message.includes("Attached files:"), false, "the notice stays out of the bubble");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("the file words are Chinese too (YN-145)", async () => {
  const page = await mount("codex", { seed: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) } });
  try {
    const items = await page.menu();
    assert.deepEqual(items.map((item) => item.getAttribute("aria-label")),
      ["添加图片", "标注图片", "添加文件", "请求可交互的结果"]);
    await page.choose([file(page.window, "季度 report.pdf")]);
    await until(() => page.chips().length === 1,
      () => `the file is in the draft (${page.document.querySelector(".inline-error")?.textContent || "no error shown"})`);
    assert.match(page.chips()[0].textContent, /季度 report\.pdf/);
    assert.equal(page.chips()[0].querySelector(".input-file-remove").getAttribute("aria-label"), "移除 季度 report.pdf");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an Agent that takes no files keeps the entry, quieted, and says why (YN-145)", async () => {
  const page = await mount("dsh");
  try {
    const items = await page.menu();
    const addFiles = items.find((item) => item.getAttribute("aria-label") === "Add files");
    assert.equal(addFiles.getAttribute("aria-disabled"), "true");
    assert.equal(addFiles.hasAttribute("data-unavailable"), true);
    assert.match(addFiles.textContent, /Files go to Codex, Claude and OpenCode Agents/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a remote Agent is quieted until files can be copied to its machine (YN-145 F5/F4)", async () => {
  const page = await mount("claude", { remote: true });
  try {
    const items = await page.menu();
    const addFiles = items.find((item) => item.getAttribute("aria-label") === "Add files");
    assert.equal(addFiles.getAttribute("aria-disabled"), "true");
    assert.match(addFiles.textContent, /Files can't go to a remote Agent yet/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
