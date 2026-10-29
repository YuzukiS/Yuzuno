import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { composerText, setComposerText } from "./composer-driver.mjs";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// An OpenCode Agent's images (T-10) take the composer's image button, upload
// and receipt, as Codex's and Claude's do. Core decides whether the chosen
// model reads them; its refusal keeps the draft with its images. Against the
// built app (YUZUNO_UI_DIST, else web/dist), as ui.test.mjs.
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
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
// What Core says for a chosen model that doesn't read images (core/src/opencode_agent.rs).
const refusal = "所选模型 openrouter/anthropic/claude-x 在 OpenCode 的配置中不能读图片；这条消息没有发送，草稿和图片保留。请在设置里另选能读图片的模型";
const saved = { id: "a".repeat(64) + ".png", width: 4, height: 4, bytes: 9 };

/** The app with one idle Agent, Mori; `messages` answers its sends in turn. */
async function mount(harness, messages = []) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.EventSource = class { close() {} };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  const agent = { id: "a", name: "Mori", harness, cwd: "/workspace", model: "", color: "green", status: "idle",
    createdAt: "2026-10-28", updatedAt: "2026-10-28", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
  window.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/api/workspace"))
      return reply(200, { workspace: { id: "ws-1" }, agents: [agent], runtime: { connected: true }, defaultCwd: "/workspace" });
    if (url.endsWith("/api/agents/a")) return reply(200, { agent, pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (url.endsWith("/api/agents/a/images")) return reply(200, saved);
    if (url.endsWith("/api/agents/a/messages")) return messages.shift()(JSON.parse(init.body));
    if (/\/models(\?|$)/.test(url)) return reply(200, { models: [] });
    return reply(200, {});
  };
  bundleScript.runInContext(dom.getInternalVMContext());
  const composer = () => window.document.querySelector('[data-composer-input][aria-label="Message Mori"]');
  await until(() => composer() && !window.document.querySelector(".conversation-scroll .loading-state"), "Mori's conversation opens");
  return { window, document: window.document, calls, errors, composer: composer(), close: () => window.close() };
}

test("an OpenCode Agent's composer takes images and says they need a chosen model that reads them (T-10)", async () => {
  for (const harness of ["opencode", "codex"]) {
    const page = await mount(harness);
    try {
      const button = page.document.querySelector('.composer-tools [aria-label="Add images"]');
      assert.equal(button?.disabled, false, harness);
      assert.equal(button.hasAttribute("aria-disabled"), false, harness);
      assert.equal(/Images need a model chosen in Settings that reads images/.test(button.title), harness === "opencode", harness);
      assert.deepEqual(page.errors, []);
    } finally { page.close(); }
  }
});

test("an OpenCode draft's images go with its text; a model that can't read them keeps the draft and its images (T-10)", async () => {
  const sent = [];
  const page = await mount("opencode", [
    (input) => { sent.push(input); return reply(400, { code: "message_not_submitted", error: refusal }); },
    (input) => { sent.push(input); return reply(200, { input, status: "accepted", turnId: "t1", agentId: "a" }); },
  ]);
  try {
    // Chosen as the image button chooses them, and saved by Core.
    const picker = page.document.querySelector('input[aria-label="Choose images"]');
    Object.defineProperty(picker, "files", { configurable: true, value: [new page.window.File(["png-bytes"], "screen.png", { type: "image/png" })] });
    picker.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    const images = () => page.document.querySelectorAll(".composer-area .input-image").length;
    await until(() => images() === 1, "the image is in the draft");
    assert.equal(page.calls.filter((c) => c.init.method === "POST" && c.url.endsWith("/api/agents/a/images")).length, 1);
    setComposerText(page.composer, "look");
    await pause();

    // Refused: what Core says shows, and the text and the image stay.
    page.document.querySelector('[aria-label="Send message"]').click();
    await until(() => sent.length === 1 && page.document.body.textContent.includes(refusal), "Core's refusal shows");
    assert.deepEqual([sent[0].text, sent[0].images], ["look", [saved.id]]);
    assert.equal(composerText(page.composer), "look", "the text stays");
    assert.equal(images(), 1, "and so does the image");

    // Sent again, say once a model that reads images is chosen: the same images go.
    page.document.querySelector('[aria-label="Send message"]').click();
    await until(() => sent.length === 2, "sent again");
    assert.deepEqual([sent[1].text, sent[1].images], ["look", [saved.id]]);
    await until(() => images() === 0, "a sent message leaves the draft");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
