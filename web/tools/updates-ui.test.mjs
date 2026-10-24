import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { DraftStorage, emptyDraft, pastedText } from "../src/composer-draft.ts";
import {
  composerText,
  savedDraftText,
  setComposerText,
} from "./composer-driver.mjs";

// CI's fresh checkout has its own build; local runs name an isolated output.
const buildDir =
  process.env.YUZUNO_UI_DIST ||
  (process.env.GITHUB_ACTIONS === "true"
    ? new URL("../dist/", import.meta.url).pathname
    : null);
assert.ok(buildDir, "Use an isolated build directory for update tests");
const dist = pathToFileURL(resolve(buildDir) + "/");
const html = await readFile(new URL("index.html", dist), "utf8");
const entry = html.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
const code = await uiTestBundle(new URL(entry, dist));
const wait = (ms = 60) => new Promise((done) => setTimeout(done, ms));
// Status is polled every 1.5 s while Settings is open, a choice is saved or
// an update is under way (WorkspaceUpdates.tsx). These tests run that poll
// every POLL_MS instead: the page's setTimeout maps exactly 1500 to it and
// leaves every other delay, and Date, as they are.
const PRODUCT_POLL_MS = 1500;
const POLL_MS = 100;
const until = async (check, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (check()) return true;
    await wait(10);
  }
  return check();
};
const statusReads = (f) =>
  f.calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/updates")).length;
// For "nothing happens" checks: wait until the page has read Core's status
// n more times. The poll asks again only after it has handled the previous
// answer, so with n = 2 the page has seen, and acted on, at least one whole
// answer since this point.
const polls = async (f, n = 2) => {
  const target = statusReads(f) + n;
  assert.ok(await until(() => statusReads(f) >= target), `${n} more status reads`);
  assert.ok(f.pollTimers.mapped > 0, "the status poll ran on the test interval (still 1500 ms in the product?)");
};
const posts = (calls, path) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith(`/api/updates/${path}`));
const intentKey = "yuzuno.update-intent";
const release = (id) => ({
  releaseId: id,
  version: `2026.10.${id}`,
  gitSha: "a".repeat(40),
  builtAt: "2026-10-13T00:00:00Z",
  platform: "linux-x86_64",
  protocol: 1,
  schema: { writes: 2, readsMin: 2, readsMax: 2 },
  records: { writes: 1, readsMin: 0, readsMax: 1 },
  notes: "A reviewed local release.\nConversations stay together.",
  bytes: 12345678,
  source: "Reviewed local build",
});
const agent = {
  id: "a",
  name: "Mori",
  goal: "",
  cwd: "/fixture",
  harness: "codex",
  threadId: "native-a",
  connectionState: "connected",
  status: "working",
  model: "fixture-model",
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  settings: {},
};

async function mount(overrides = {}, shell, seed) {
  const status = {
    managed: true,
    current: release("A"),
    candidates: [release("B")],
    blockers: [{ agentId: "a", name: "Mori", reason: "Turn is still running" }],
    acceptingWork: true,
    storage: {
      releaseBytes: 24691356,
      backupBytes: 1000,
      retainedReleases: 1,
      keepReleases: 3,
    },
    ...overrides,
  };
  const calls = [];
  // Every /updates/check answer can be held until released, so a test can
  // keep Settings' own check out (see `press`).
  const checks = { held: false, waiting: [] };
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="yuzuno-release" content="A"></head><body><div id="root"></div></body></html>',
    {
      url: "http://127.0.0.1:4399/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const { window: w } = dom;
  w.localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  w.localStorage.setItem(
    "yuzuno.drafts",
    JSON.stringify({ a: "中文 draft kept while updating" }),
  );
  w.matchMedia = (media) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  w.EventSource = class {
    close() {}
  };
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  seed?.(w);
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  const respond = (value) => ({
    ok: true,
    status: 200,
    json: async () => structuredClone(value),
    text: async () => JSON.stringify(value),
  });
  w.fetch = async (url, init = {}) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({
      url,
      method: init.method || "GET",
      body,
      savedDraft: savedDraftText(w.localStorage, "a"),
    });
    if (url.endsWith("/api/updates")) return respond(status);
    if (url.endsWith("/api/updates/check")) {
      if (checks.held) await new Promise((resume) => checks.waiting.push(resume));
      return respond(status);
    }
    if (url.endsWith("/api/updates/download")) {
      status.releaseSource.phase = "downloading";
      status.releaseSource.receivedBytes = 1024;
      return respond(status);
    }
    if (url.endsWith("/api/updates/download/cancel")) {
      status.releaseSource.phase = "cancelled";
      return respond(status);
    }
    if (url.endsWith("/api/updates/prepare")) {
      status.preparedReleaseId = "B";
      status.operation = {
        id: "prepare",
        releaseId: "B",
        phase: "prepared",
        startedAt: "",
        updatedAt: "",
      };
      return respond({ operationId: "prepare" });
    }
    if (url.endsWith("/api/updates/apply")) {
      status.acceptingWork = false;
      status.operation = {
        id: "update-one",
        releaseId: "B",
        phase: "waiting",
        startedAt: "",
        updatedAt: "",
        deadline: "2026-10-13T23:00:00Z",
      };
      return respond({ operationId: "update-one" });
    }
    if (url.endsWith("/api/updates/cancel")) {
      status.acceptingWork = true;
      status.operation.phase = "cancelled";
      return respond({ cancelled: true });
    }
    if (url.endsWith("/api/workspace"))
      return respond({
        agents: [agent],
        runtime: { connected: true },
        defaultCwd: "/fixture",
        workspace: { id: "fixture-workspace" },
        projects: [],
        projectUsage: {},
      });
    if (url.endsWith("/api/agents/a"))
      return respond({
        agent,
        turns: [
          {
            id: "turn-a",
            status: "inProgress",
            items: [
              {
                id: "prompt",
                type: "userMessage",
                content: [
                  { type: "inputText", text: "Keep this conversation" },
                ],
              },
            ],
          },
        ],
        pending: [],
        artifacts: [],
        messageReceipts: [],
      });
    if (url.endsWith("/api/health"))
      return respond({ product: "yuzuno", application: "yuzuno-next" });
    if (url.endsWith("/api/models")) return respond({ models: [] });
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    if (url.includes("/api/catchup")) return respond({ items: [], agents: [] });
    if (url.includes("/api/collaboration/"))
      return respond({ tasks: [], messages: [], agents: [] });
    return respond({});
  };
  // The desktop window's command bridge, if this page runs inside it.
  if (shell) {
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = { core: { invoke: (command, args) => shell(command, args, w) } };
  }
  const pollTimers = { mapped: 0 };
  const later = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...rest) => {
    if (ms === PRODUCT_POLL_MS) {
      pollTimers.mapped++;
      return later(fn, POLL_MS, ...rest);
    }
    return later(fn, ms, ...rest);
  };
  w.eval(code);
  // A busy CI runner may not finish React's initial detail/composer render
  // within the first timer. Wait for the fixture state the tests actually use.
  assert.ok(
    await until(() => !!w.document.querySelector("[data-composer-input]"), 2100),
    "Update fixture composer is ready",
  );
  const button = (text) =>
    [...w.document.querySelectorAll("button")].find(
      (el) => el.textContent.trim() === text,
    );
  const open = async () => {
    w.document.querySelector('[aria-label="Settings and updates"]').click();
    assert.ok(await until(() => !!w.document.querySelector('[role="dialog"]')), "Settings opens");
  };
  // Settings shows one category at a time and opens on Updates, which holds
  // the desktop app's updates after the Workspace service's.
  const openDesktop = async () => {
    await open();
    assert.ok(
      await until(() => !!w.document.querySelector('#settings-panel-updates [aria-label="Desktop app"]')),
      "the desktop app shows under Updates",
    );
    assert.ok(!w.document.querySelector("#settings-tab-desktop"), "no Desktop app category of its own");
  };
  const close = async () => {
    w.document.querySelector('[role="dialog"]').dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    assert.ok(await until(() => !w.document.querySelector('[role="dialog"]')), "Settings closes");
  };
  const steps = () =>
    [...w.document.querySelectorAll('[aria-label="Update progress"] li')].map(
      (li) => `${li.querySelector(".update-step-label")?.textContent ?? ""}:${li.className.replace("is-", "")}`,
    );
  // Presses a button once it takes a press and `when` holds, `times` times.
  // While Settings' own update check is out, Update and Reload are disabled
  // (WorkspaceUpdates `blocked`), and jsdom dispatches no click on a
  // disabled button: a click then is lost. The checks and the clicks are one
  // predicate call, so nothing runs between them.
  const press = (text, { times = 1, when = () => true } = {}) =>
    until(() => {
      const el = button(text);
      if (!el || el.disabled || !when()) return false;
      for (let n = 0; n < times; n++) el.click();
      return true;
    });
  // Core's status shows the release transfer (the card's progress bar).
  const transferShown = () => !!w.document.querySelector('progress[aria-label="Release download"]');
  const holdChecks = () => {
    checks.held = true;
  };
  const releaseChecks = () => {
    checks.held = false;
    for (const resume of checks.waiting.splice(0)) resume();
  };
  return { dom, w, status, calls, errors, button, press, transferShown, holdChecks, releaseChecks, open, close, openDesktop, steps, pollTimers };
}

test("one click prepares a local release, saves drafts, applies once and survives closing the dialog", async () => {
  const f = await mount();
  try {
    await f.open();
    assert.match(f.w.document.body.textContent, /Workspace service/);
    assert.match(f.w.document.body.textContent, /Desktop app/);
    for (const name of ["Download update", "Prepare update", "Apply when idle"])
      assert.ok(f.button(name) === undefined, `no separate "${name}" step`);
    // Pressed twice in one go: one choice, applied once.
    assert.ok(await f.press("Update to 2026.10.B", { times: 2 }), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "apply").length > 0), "Apply follows preparation");
    await polls(f);
    assert.equal(posts(f.calls, "prepare").length, 1);
    assert.equal(posts(f.calls, "prepare")[0].body.releaseId, "B");
    const sends = posts(f.calls, "apply");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.releaseId, "B");
    assert.equal(sends[0].savedDraft, "中文 draft kept while updating");
    // Apply carries the request ID saved with the choice, so a repeat
    // after a lost answer names the same operation.
    const chosen = JSON.parse(f.w.localStorage.getItem(intentKey));
    assert.equal(sends[0].body.requestId, chosen.requestId);
    assert.equal(chosen.accepted.step, "apply");
    assert.equal(chosen.accepted.operationId, "update-one");
    assert.match(f.w.document.body.textContent, /Updating to 2026\.10\.B/);
    assert.match(f.w.document.body.textContent, /Waiting for your agents/);
    assert.match(f.w.document.body.textContent, /Turn is still running/);
    assert.deepEqual(f.steps(), [
      "Download:reused", "Verify:reused", "Prepare:done", "Wait for agents:current", "Install:next",
    ]);
    await f.close();
    assert.ok(f.w.document.querySelector('[role="dialog"]') === null, '[role="dialog"] is absent');
    assert.equal(
      f.calls.filter((c) => /interrupt|\/review$/.test(c.url)).length,
      0,
    );
    await f.open();
    assert.match(f.w.document.body.textContent, /Waiting for your agents/);
    f.button("Cancel update").click();
    await wait();
    assert.equal(posts(f.calls, "cancel")[0].body.operationId, "update-one");
    assert.equal(f.w.localStorage.getItem(intentKey), null, "cancelling forgets the choice");
    assert.equal(
      savedDraftText(f.w.localStorage, "a"),
      "中文 draft kept while updating",
    );
    await polls(f);
    assert.equal(posts(f.calls, "apply").length, 1, "a cancelled choice is not applied again");
    assert.deepEqual(f.errors, []);
  } finally {
    f.dom.window.close();
  }
});

test("while Settings' own update check is out, a click on Update is lost; pressing waits for the check", async () => {
  const f = await mount();
  try {
    f.holdChecks();
    await f.open();
    assert.ok(await until(() => posts(f.calls, "check").length === 1), "opening Settings checks for a release");
    const update = () => f.button("Update to 2026.10.B");
    assert.ok(await until(() => update()?.disabled === true), "Update waits for the check");
    // A click now is dropped: nothing is chosen, saved or sent, however long
    // the page then runs.
    update().click();
    await polls(f);
    assert.equal(f.w.localStorage.getItem(intentKey), null, "the click chose nothing");
    assert.equal(f.calls.filter((c) => /updates\/(download|prepare|apply)$/.test(c.url)).length, 0, "the click sent nothing");
    // Pressing waits while the check is out, then clicks once it is done.
    const pressed = f.press("Update to 2026.10.B");
    await polls(f);
    assert.equal(f.w.localStorage.getItem(intentKey), null, "not pressed while the check is out");
    f.releaseChecks();
    assert.ok(await pressed, "Update is pressed once the check has answered");
    assert.ok(await until(() => posts(f.calls, "apply").length === 1), "the choice runs: Apply is sent once");
    assert.equal(posts(f.calls, "check").length, 1, "one check");
    assert.deepEqual(f.errors, []);
  } finally {
    f.releaseChecks();
    f.dom.window.close();
  }
});

test("an unavailable update response leaves the conversation and draft usable", async () => {
  const f = await mount({ current: undefined });
  try {
    assert.ok(f.w.document.querySelector(".conversation-scroll"));
    assert.equal(
      composerText(f.w.document.querySelector("[data-composer-input]")),
      "中文 draft kept while updating",
    );
    await f.open();
    assert.match(
      f.w.document.body.textContent,
      /Workspace update status is unavailable/,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    f.dom.window.close();
  }
});

test("a new verified Core version offers reload while leaving the current page and draft intact", async () => {
  const f = await mount({
    current: release("B"),
    candidates: [],
    operation: {
      id: "done",
      releaseId: "B",
      phase: "complete",
      startedAt: "",
      updatedAt: "",
    },
  });
  try {
    assert.ok(f.w.document.querySelector(".updates-banner"));
    assert.equal(
      f.w.document.querySelector('meta[name="yuzuno-release"]').content,
      "A",
    );
    await f.open();
    assert.ok(f.button("Reload this window"));
    assert.equal(
      savedDraftText(f.w.localStorage, "a"),
      "中文 draft kept while updating",
    );
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.url.includes("/updates/"))
        .length,
      0,
    );
  } finally {
    f.dom.window.close();
  }
});

test("development installations explain why applying is unavailable", async () => {
  const f = await mount({
    managed: false,
    candidates: [],
    reason: "Install a managed release to enable updates here.",
  });
  try {
    await f.open();
    assert.match(f.w.document.body.textContent, /Install a managed release/);
    assert.equal(f.button("Check for updates").disabled, true);
    assert.ok(
      ![...f.w.document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Update to")),
      'no "Update to" button',
    );
    assert.equal(posts(f.calls, "check").length, 0, "nothing to check on a development Core");
  } finally {
    f.dom.window.close();
  }
});

// What the next test can see when the storage report is missing, built only
// then. Stored or reported text never appears: the saved draft is given by the
// kinds of its parts, update requests by method and path, a value that cannot
// be read by its error's name, and JSDOM errors by count and kind.
function draftReportContext(f, action, clickedAt, readsBefore, refused) {
  const read = (key, describe) => {
    try {
      const value = JSON.parse(f.w.localStorage.getItem(key) ?? "null");
      return value === null ? "none" : describe(value);
    } catch (error) {
      return `unreadable (${error?.name ?? "error"})`;
    }
  };
  const dialog = f.w.document.querySelector('[role="dialog"]');
  const card = dialog?.querySelector('[role="group"][aria-label="Update status"]');
  const texts = (root, selector) =>
    [...(root?.querySelectorAll(selector) ?? [])].map((node) => node.textContent.trim()).filter(Boolean);
  return JSON.stringify({
    action,
    waitedMs: Date.now() - clickedAt,
    statusReadsWhileWaiting: statusReads(f) - readsBefore,
    dialog: !!dialog,
    card: card && {
      tone: [...card.classList].find((name) => name.startsWith("is-")) ?? null,
      title: card.querySelector(".update-card-title")?.textContent.trim() ?? null,
      lines: texts(card, ".update-card-line"),
      buttons: texts(card, "button"),
    },
    alerts: texts(dialog, '[role="alert"]'),
    // In order; a repeated request is shown once with its count.
    updateRequests: f.calls
      .filter((call) => call.url.includes("/api/updates"))
      .map((call) => `${call.method} ${call.url.replace(/^.*\/api/, "")}`)
      .reduce((runs, request) => {
        if (runs.at(-1)?.request === request) runs.at(-1).count++;
        else runs.push({ request, count: 1 });
        return runs;
      }, [])
      .map(({ request, count }) => (count > 1 ? `${request} ×${count}` : request)),
    // Each body write this test refused, in ms from the click (negative: before it).
    refusedBodyWrites: refused.map((at) => at - clickedAt),
    savedDraftParts: read("yuzuno.composer.v1:a", (draft) => draft.parts.map((part) => part.kind)),
    pastedChips: f.w.document.querySelectorAll(".pasted-text-chip").length,
    choice: read(intentKey, (intent) => ({
      from: intent.from,
      asked: intent.asked?.step ?? null,
      accepted: intent.accepted?.step ?? null,
      unanswered: intent.unanswered ?? 0,
    })),
    jsdomErrors: {
      count: f.errors.length,
      kinds: f.errors.map((message) =>
        /^Not implemented: navigation/.test(message) ? "navigation_not_implemented" : "other",
      ),
    },
  });
}

test("Apply and Reload cannot discard a pasted body whose storage write failed; Apply retries saving before posting", async () => {
  const raw = "  original\r\n中文\r\n".repeat(12);
  for (const action of ["apply", "reload"]) {
    const f = await mount(
      action === "reload"
        ? {
            current: release("B"),
            candidates: [],
            operation: {
              id: "done",
              releaseId: "B",
              phase: "complete",
              startedAt: "",
              updatedAt: "",
            },
          }
        : {},
    );
    const proto = f.w.Storage.prototype,
      set = proto.setItem;
    const refused = [];
    try {
      const field = f.w.document.querySelector("[data-composer-input]");
      setComposerText(field, "");
      await wait();
      proto.setItem = function (key, value) {
        if (key.startsWith("yuzuno.paste.v1:")) {
          refused.push(Date.now());
          throw new f.w.Error("Draft body storage is full");
        }
        return set.call(this, key, value);
      };
      const paste = new f.w.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: () => raw },
      });
      field.dispatchEvent(paste);
      await wait();
      assert.equal(
        f.w.document.querySelectorAll(".pasted-text-chip").length,
        1,
      );
      assert.equal(savedDraftText(f.w.localStorage, "a"), "");
      await f.open();
      const name =
        action === "apply" ? "Update to 2026.10.B" : "Reload this window";
      const readsBefore = statusReads(f);
      const clickedAt = Date.now();
      assert.ok(await f.press(name), `${name} can be pressed`);
      const reported = await until(() =>
        /Draft body storage is full/.test(f.w.document.querySelector('[role="dialog"]').textContent),
      );
      if (!reported)
        assert.fail(`the full draft storage is reported: ${draftReportContext(f, action, clickedAt, readsBefore, refused)}`);
      assert.match(
        f.w.document.querySelector('[role="dialog"]').textContent,
        /Draft body storage is full/,
      );
      assert.equal(
        f.calls.filter((c) => c.url.endsWith("/updates/apply")).length,
        0,
      );
      assert.equal(
        f.w.document.querySelectorAll(".pasted-text-chip").length,
        1,
      );
      assert.equal(savedDraftText(f.w.localStorage, "a"), "");
      assert.deepEqual(f.errors, []); // In JSDOM an attempted reload would report an error.
      proto.setItem = set;
      if (action === "apply") {
        assert.equal(f.w.localStorage.getItem(intentKey), null, "the stopped choice is not resumed by itself");
        assert.ok(await f.press(name), `${name} can be pressed again`);
        assert.ok(await until(() => posts(f.calls, "apply").length > 0), "Apply is sent");
        assert.equal(posts(f.calls, "prepare").length, 1, "the prepared release is reused");
        const apply = f.calls.filter((c) => c.url.endsWith("/updates/apply"));
        assert.equal(apply.length, 1);
        assert.equal(apply[0].savedDraft, raw);
        assert.equal(savedDraftText(f.w.localStorage, "a"), raw);
      }
    } finally {
      proto.setItem = set;
      f.dom.window.close();
    }
  }
});

test("Apply and Reload never republish a clean stale draft after another window edits or sends it", async () => {
  const oldBody = "  saved locally\r\n中文\r\n".repeat(12);
  const newBody = "  newer window\r\n原文\r\n".repeat(12);
  for (const action of ["apply", "reload"]) {
    for (const external of ["edit", "send"]) {
      const f = await mount(
        action === "reload" ? { current: release("B"), candidates: [] } : {},
      );
      const proto = f.w.Storage.prototype,
        set = proto.setItem;
      try {
        const field = f.w.document.querySelector("[data-composer-input]");
        setComposerText(field, "");
        const paste = new f.w.Event("paste", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(paste, "clipboardData", {
          value: { getData: () => oldBody },
        });
        field.dispatchEvent(paste);
        await wait();
        assert.equal(savedDraftText(f.w.localStorage, "a"), oldBody);

        // Independent writer shares storage, while this window retains its
        // already-saved snapshot and makes no further local edits.
        new DraftStorage(f.w.localStorage).save(
          "a",
          external === "edit"
            ? { version: 1, nextNumber: 2, parts: [pastedText(newBody, 1)] }
            : emptyDraft(),
        );
        const savedEntries = () =>
          Object.entries(f.w.localStorage)
            .filter(([key]) =>
              /^yuzuno\.(composer\.v1:|paste\.v1:|drafts$)/.test(key),
            )
            .sort();
        const snapshot = savedEntries();
        const writes = [];
        proto.setItem = function (key, value) {
          if (/^yuzuno\.(composer|paste)\.v1:/.test(key)) writes.push(key);
          return set.call(this, key, value);
        };
        assert.equal(
          f.w.document.querySelectorAll(".pasted-text-chip").length,
          1,
        );
        await f.open();
        assert.ok(await f.press(action === "apply" ? "Update to 2026.10.B" : "Reload this window"), `${action} can be pressed`);
        if (action === "apply") assert.ok(await until(() => posts(f.calls, "apply").length > 0), "Apply is sent");
        await wait();
        assert.deepEqual(writes, []);
        assert.deepEqual(savedEntries(), snapshot);
        assert.equal(
          savedDraftText(f.w.localStorage, "a"),
          external === "edit" ? newBody : "",
        );
        if (action === "apply") {
          assert.equal(
            f.calls.filter((c) => c.url.endsWith("/updates/apply")).length,
            1,
          );
          assert.deepEqual(f.errors, []);
        } else {
          assert.equal(f.errors.length, 1);
          assert.match(f.errors[0], /Not implemented: navigation/);
        }
      } finally {
        proto.setItem = set;
        f.dom.window.close();
      }
    }
  }
});

test("update wait separates notification delivery from actual idle and preserves manual cancel", async () => {
  for (const delivery of ["pending", "sending", "delivered", "uncertain"]) {
    const f = await mount({
      acceptingWork: false,
      operation: { id: "wait", releaseId: "B", phase: "waiting", startedAt: "", updatedAt: "" },
      waitNotices: [
        { agentId: "a", name: "Mori", messageId: "pause-a", turnId: "turn-a", delivery, active: true, idle: false },
        { agentId: "idle", name: "Quiet Agent", messageId: "pause-idle", turnId: "old", delivery: "delivered", active: false, idle: true },
      ],
    });
    try {
      await f.open();
      const list = f.w.document.querySelector('[aria-label="What the update is waiting for"]');
      const rows = [...list.querySelectorAll("li")];
      assert.equal(rows.length, 2);
      assert.match(rows[0].textContent, /Turn is still running/);
      assert.equal(rows[0].classList.contains("is-idle"), false);
      assert.match(rows[1].textContent, /Quiet AgentIdle/);
      assert.equal(rows[1].classList.contains("is-idle"), true);
      assert.match(list.textContent, delivery === "pending" ? /not yet delivered/ : delivery === "sending" ? /native delivery receipt/ : delivery === "uncertain" ? /delivery uncertain/ : /request delivered/);
      assert.equal(f.calls.filter(c => /interrupt|\/turns$/.test(c.url)).length, 0);
      assert.deepEqual(f.errors, []);
    } finally { f.w.close(); }
  }
});

const published = (id, phase = "available") => ({
  configured: true, repository: "owner/repo", phase, candidate: release(id),
  receivedBytes: 0, totalBytes: 12345678, checkedAt: "2026-10-14T00:00:00Z",
});

test("one click carries a signed release through download, verification, preparation and apply, step by Core's state", async () => {
  const f = await mount({ candidates: [], releaseSource: published("B") });
  try {
    await f.open();
    assert.match(f.w.document.body.textContent, /Publisher signature verified/);
    assert.match(f.w.document.body.textContent, /One click downloads and verifies it/);
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "download").length === 1));
    assert.equal(posts(f.calls, "download")[0].body.releaseId, "B");
    assert.ok(await until(() => !!f.w.document.querySelector('progress[aria-label="Release download"]')), "the transfer shows");
    assert.deepEqual(f.steps().slice(0, 2), ["Download:current", "Verify:next"]);
    // Accepting the download is not having it: nothing is prepared yet.
    await f.close();
    f.status.releaseSource.phase = "verifying";
    await polls(f);
    assert.equal(posts(f.calls, "prepare").length, 0, "a transfer still verifying is not prepared");
    f.status.releaseSource.phase = "downloaded";
    f.status.candidates = [release("B")];
    assert.ok(await until(() => posts(f.calls, "apply").length === 1), "the chain goes on with Settings closed");
    assert.equal(posts(f.calls, "download").length, 1, "a finished download is not repeated");
    assert.equal(posts(f.calls, "prepare").length, 1);
    assert.equal(posts(f.calls, "apply")[0].savedDraft, "中文 draft kept while updating");
    await f.open();
    assert.match(f.w.document.body.textContent, /Waiting for your agents/);
    assert.deepEqual(f.steps(), [
      "Download:done", "Verify:done", "Prepare:done", "Wait for agents:current", "Install:next",
    ]);
    assert.equal(f.calls.filter(c => /interrupt|\/review$/.test(c.url)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("cancelling during the download stops the transfer and the rest of the chain", async () => {
  const f = await mount({ candidates: [], releaseSource: published("B") });
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    // Cancel update shows once the release is chosen, but it stops a transfer
    // only once Core's status shows one; before that it forgets the choice.
    assert.ok(await f.press("Cancel update", { when: f.transferShown }), "the update can be cancelled during the download");
    assert.ok(await until(() => /Download cancelled/.test(f.w.document.body.textContent)), "the cancel is answered");
    assert.equal(posts(f.calls, "download/cancel").length, 1);
    assert.equal(f.w.localStorage.getItem(intentKey), null);
    // Even a download Core still finishes is not taken further.
    f.status.releaseSource.phase = "downloaded";
    f.status.candidates = [release("B")];
    await polls(f);
    assert.equal(f.calls.filter(c => /updates\/(apply|prepare)$|interrupt|\/review$/.test(c.url)).length, 0);
    assert.ok(f.button("Update to 2026.10.B"), "the next step is again the user's");
    assert.equal(savedDraftText(f.w.localStorage, "a"), "中文 draft kept while updating");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("a release published while a local package waits is a second explicit choice, not a switch", async () => {
  const f = await mount({ releaseSource: published("C") });
  try {
    await f.open();
    const row = () => f.w.document.querySelector(".update-card-also");
    assert.ok(row(), "the also-published row shows");
    assert.ok(f.button("Update to 2026.10.B"), "the local package keeps its own one click");
    const later = [...row().querySelectorAll("button")].find((b) => b.textContent.trim() === "Update to 2026.10.C");
    assert.ok(later, "the published release has its own one click");
    assert.ok(await f.press("Update to 2026.10.C"), "Update to 2026.10.C can be pressed");
    assert.ok(await until(() => posts(f.calls, "download").length === 1));
    assert.equal(posts(f.calls, "download")[0].body.releaseId, "C");
    assert.ok(await until(() => /Updating to 2026\.10\.C/.test(f.w.document.body.textContent)), "the update to C shows");
    assert.ok(await until(f.transferShown), "the card shows the transfer");
    assert.ok(await f.press("Cancel update", { when: f.transferShown }), "Update to 2026.10.C can be cancelled");
    assert.ok(await until(() => posts(f.calls, "download/cancel").length > 0), "the cancel is sent");
    assert.equal(posts(f.calls, "download/cancel").length, 1);
    assert.equal(f.calls.filter(c => /updates\/(apply|prepare)$|interrupt/.test(c.url)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("a downloaded release reuses its download: one click prepares and applies", async () => {
  const f = await mount({ releaseSource: published("B", "downloaded") });
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "apply").length === 1));
    assert.equal(posts(f.calls, "download").length, 0);
    assert.equal(posts(f.calls, "prepare").length, 1);
    assert.deepEqual(f.steps().slice(0, 3), ["Download:reused", "Verify:reused", "Prepare:done"]);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("opening Settings checks once for a newer release; a check is not consent to install", async () => {
  const f = await mount({ candidates: [], releaseSource: published("B", "current") });
  try {
    await f.open();
    assert.ok(await until(() => posts(f.calls, "check").length > 0), "opening Settings checks");
    assert.equal(posts(f.calls, "check").length, 1, "opening Settings checks");
    await f.close();
    await f.open();
    await polls(f);
    assert.equal(posts(f.calls, "check").length, 1, "a quick reopening does not check again");
    // The check finds a release: it is offered, never fetched by itself.
    f.status.releaseSource.phase = "available";
    assert.ok(await until(() => !!f.button("Update to 2026.10.B")), "the found release is offered");
    await polls(f);
    assert.equal(f.calls.filter(c => /updates\/(download|prepare|apply)$/.test(c.url)).length, 0);
    f.button("Check for updates").click();
    assert.ok(await until(() => posts(f.calls, "check").length === 2), "checking by hand still works");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("a choice survives a reload: an accepted Apply is followed, never sent again", async () => {
  const seeded = (accepted) => (w) =>
    w.localStorage.setItem(intentKey, JSON.stringify({
      releaseId: "B", version: "2026.10.B", requestId: "6f1c1d7e-56b8-4c1e-9f55-0d9d3a2c0b11", from: "prepare", accepted,
    }));
  const waiting = { id: "update-one", releaseId: "B", phase: "waiting", startedAt: "", updatedAt: "" };
  const f = await mount(
    { preparedReleaseId: "B", acceptingWork: false, operation: waiting },
    undefined,
    seeded({ step: "apply", at: Date.now() - 60000, operationId: "update-one" }),
  );
  try {
    await f.open();
    assert.match(f.w.document.body.textContent, /Updating to 2026\.10\.B/);
    await polls(f);
    assert.equal(f.calls.filter(c => /updates\/(download|prepare|apply)$/.test(c.url)).length, 0);
    // Core finishes in the new version: the choice is done and forgotten,
    // and the window offers the new UI when the user is ready.
    f.status.current = release("B");
    f.status.candidates = [];
    f.status.operation = { ...waiting, phase: "complete" };
    f.status.acceptingWork = true;
    // The reload offer renders first; the finished choice is forgotten by
    // the chain's next pass over the same status.
    assert.ok(await until(() => !!f.button("Reload this window") && f.w.localStorage.getItem(intentKey) === null), "the reload is offered and the choice forgotten");
    assert.ok(f.button("Reload this window"));
    assert.equal(f.w.localStorage.getItem(intentKey), null);
    assert.equal(posts(f.calls, "apply").length, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
  // Preparation Core accepted before the reload goes on to Apply, with the
  // request ID chosen then.
  const g = await mount(
    { preparedReleaseId: "B", operation: { id: "prepare", releaseId: "B", phase: "prepared", startedAt: "", updatedAt: "" } },
    undefined,
    seeded({ step: "prepare", at: Date.now() - 60000, operationId: "prepare" }),
  );
  try {
    assert.ok(await until(() => posts(g.calls, "apply").length === 1));
    assert.equal(posts(g.calls, "apply")[0].body.requestId, "6f1c1d7e-56b8-4c1e-9f55-0d9d3a2c0b11");
    assert.equal(posts(g.calls, "prepare").length, 0);
  } finally { g.w.close(); }
});

test("an unanswered Apply is asked again with the same request ID, a bounded number of times", async () => {
  const f = await mount({ preparedReleaseId: "B" });
  const answer = f.w.fetch;
  let lost = 0;
  f.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/apply") && lost < 5) {
      lost++;
      f.calls.push({ url, method: "POST", body: JSON.parse(init.body) });
      throw new TypeError("Failed to fetch");
    }
    return answer(url, init);
  };
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => /Workspace did not answer/.test(f.w.document.body.textContent), 8000));
    const sent = posts(f.calls, "apply");
    assert.equal(sent.length, 3, "three unanswered requests, then the user decides");
    assert.equal(new Set(sent.map((c) => c.body.requestId)).size, 1, "every repeat names the same request");
    assert.equal(f.w.localStorage.getItem(intentKey), null);
    await polls(f);
    assert.equal(posts(f.calls, "apply").length, 3);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("an Apply Core acted on whose answer was lost is followed, not sent again", async () => {
  const f = await mount({ preparedReleaseId: "B" });
  const answer = f.w.fetch;
  f.w.fetch = async (url, init = {}) => {
    const reply = await answer(url, init);
    // Core began the update; only its answer is lost on the way back.
    if (url.endsWith("/api/updates/apply")) throw new TypeError("Failed to fetch");
    return reply;
  };
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "apply").length === 1));
    await polls(f);
    assert.equal(posts(f.calls, "apply").length, 1);
    assert.match(f.w.document.body.textContent, /Waiting for your agents/);
    assert.ok(f.w.localStorage.getItem(intentKey), "the choice is still followed");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

test("a preparation or download Core began whose answer was lost is followed to its failure, not started again", async () => {
  // Preparation: Core records a new operation, the answer never arrives,
  // then the preparation fails.
  const f = await mount();
  const answer = f.w.fetch;
  f.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/prepare")) {
      f.calls.push({ url, method: "POST", body: JSON.parse(init.body) });
      f.status.operation = { id: "prepare-lost", releaseId: "B", phase: "preparing", startedAt: "", updatedAt: "" };
      throw new TypeError("Failed to fetch");
    }
    return answer(url, init);
  };
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "prepare").length === 1));
    await polls(f);
    assert.deepEqual(f.steps().slice(2, 3), ["Prepare:current"], "the preparation Core began is followed");
    f.status.operation = { ...f.status.operation, phase: "failed", error: "Not enough disk space to prepare this release" };
    assert.ok(await until(() => /Not enough disk space/.test(f.w.document.body.textContent)));
    await polls(f);
    assert.equal(posts(f.calls, "prepare").length, 1, "the failed preparation is not started again");
    assert.equal(posts(f.calls, "apply").length, 0);
    assert.equal(f.w.localStorage.getItem(intentKey), null);
    assert.ok(f.button("Update to 2026.10.B"), "trying again is the user's one click");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
  // Download: Core starts it, the answer never arrives, then it fails.
  const g = await mount({ candidates: [], releaseSource: published("B") });
  const fetch = g.w.fetch;
  g.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/download")) {
      await fetch(url, init);
      throw new TypeError("Failed to fetch");
    }
    return fetch(url, init);
  };
  try {
    await g.open();
    assert.ok(await g.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(g.calls, "download").length === 1));
    await polls(g);
    g.status.releaseSource.phase = "failed";
    g.status.releaseSource.error = "Downloaded archive does not match its signed checksum";
    assert.ok(await until(() => g.w.localStorage.getItem(intentKey) === null));
    await polls(g);
    assert.equal(posts(g.calls, "download").length, 1, "the failed download is not started again");
    assert.match(g.w.document.body.textContent, /does not match its signed checksum/);
    assert.deepEqual(g.errors, []);
  } finally { g.w.close(); }
});

test("a reload while a step is out still follows what Core did with it", async () => {
  // The first window sends Prepare; Core begins it, and the page reloads
  // before any answer arrives.
  const f = await mount();
  const answer = f.w.fetch;
  f.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/prepare")) {
      f.calls.push({ url, method: "POST", body: JSON.parse(init.body) });
      return new Promise(() => {});
    }
    return answer(url, init);
  };
  let saved;
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(f.calls, "prepare").length === 1));
    saved = f.w.localStorage.getItem(intentKey);
    assert.equal(JSON.parse(saved).asked?.step, "prepare", "the pending step is saved before it is sent");
  } finally { f.w.close(); }
  const preparing = { id: "prepare-after-reload", releaseId: "B", phase: "preparing", startedAt: "", updatedAt: "" };
  const g = await mount({ operation: preparing }, undefined, (w) => w.localStorage.setItem(intentKey, saved));
  try {
    await g.open();
    await polls(g);
    g.status.operation = { ...preparing, phase: "failed", error: "Not enough disk space to prepare this release" };
    assert.ok(await until(() => /Not enough disk space/.test(g.w.document.body.textContent)));
    await polls(g);
    assert.equal(posts(g.calls, "prepare").length, 0, "the preparation Core began is not started again");
    assert.equal(g.w.localStorage.getItem(intentKey), null);
    assert.deepEqual(g.errors, []);
  } finally { g.w.close(); }
});

test("Apply is sent only from the window where the release was chosen, unless the user continues here", async () => {
  // Another tab chose B and the release is prepared; that tab saves its own
  // drafts and uploads before applying, so this one waits.
  const chosenElsewhere = (w) =>
    w.localStorage.setItem(intentKey, JSON.stringify({
      releaseId: "B", version: "2026.10.B", requestId: "0f6a3c1e-1d2b-4c5d-8e9f-a0b1c2d3e4f5",
      from: "prepare", owner: "another-tab",
    }));
  const prepared = {
    preparedReleaseId: "B",
    operation: { id: "prepare", releaseId: "B", phase: "prepared", startedAt: "", updatedAt: "" },
  };
  const f = await mount(prepared, undefined, chosenElsewhere);
  try {
    await f.open();
    await polls(f);
    assert.equal(posts(f.calls, "apply").length, 0, "this window does not apply another window's choice");
    assert.match(f.w.document.body.textContent, /The window where you chose this update saves its drafts/);
    f.button("Continue in this window").click();
    assert.ok(await until(() => posts(f.calls, "apply").length === 1));
    const apply = posts(f.calls, "apply")[0];
    assert.equal(apply.body.requestId, "0f6a3c1e-1d2b-4c5d-8e9f-a0b1c2d3e4f5", "the same choice, now applied here");
    assert.equal(apply.savedDraft, "中文 draft kept while updating", "this window saved its drafts first");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
  // Cancelling there only forgets the choice: Core has no wait to cancel.
  const g = await mount(prepared, undefined, chosenElsewhere);
  try {
    await g.open();
    assert.ok(await until(() => !!g.button("Cancel update")), "the update can be cancelled");
    g.button("Cancel update").click();
    await polls(g);
    assert.equal(posts(g.calls, "cancel").length, 0);
    assert.equal(g.w.localStorage.getItem(intentKey), null);
    assert.deepEqual(g.errors, []);
  } finally { g.w.close(); }
});

test("a step Core refuses or fails ends the chain once, with its reason, and is not retried", async () => {
  const f = await mount({ candidates: [], releaseSource: published("B") });
  const answer = f.w.fetch;
  f.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/download")) {
      f.calls.push({ url, method: "POST", body: JSON.parse(init.body) });
      return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Available release changed; check again" }) };
    }
    return answer(url, init);
  };
  try {
    await f.open();
    assert.ok(await f.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => /The update to 2026\.10\.B stopped\. Available release changed/.test(f.w.document.body.textContent)));
    await polls(f);
    assert.equal(posts(f.calls, "download").length, 1);
    assert.equal(f.w.localStorage.getItem(intentKey), null);
  } finally { f.w.close(); }
  // Preparation that Core records as failed shows Core's own reason.
  const g = await mount();
  const prepare = g.w.fetch;
  g.w.fetch = async (url, init = {}) => {
    if (url.endsWith("/api/updates/prepare")) {
      g.calls.push({ url, method: "POST", body: JSON.parse(init.body) });
      g.status.operation = { id: "prepare", releaseId: "B", phase: "preparing", startedAt: "", updatedAt: "" };
      return { ok: true, status: 200, json: async () => ({ operationId: "prepare" }) };
    }
    return prepare(url, init);
  };
  try {
    await g.open();
    assert.ok(await g.press("Update to 2026.10.B"), "Update can be pressed");
    assert.ok(await until(() => posts(g.calls, "prepare").length === 1), "the preparation is sent");
    await polls(g);
    assert.deepEqual(g.steps().slice(2, 3), ["Prepare:current"], "preparation accepted is not preparation done");
    assert.equal(posts(g.calls, "apply").length, 0);
    g.status.operation = { ...g.status.operation, phase: "failed", error: "Not enough disk space to prepare this release" };
    assert.ok(await until(() => /Not enough disk space/.test(g.w.document.body.textContent)));
    await polls(g);
    assert.equal(posts(g.calls, "prepare").length, 1);
    assert.equal(posts(g.calls, "apply").length, 0);
    assert.ok(g.button("Update to 2026.10.B"), "trying again is one click");
    assert.deepEqual(g.errors, []);
  } finally { g.w.close(); }
});

// Data & storage is one of Settings' editors (T-193): its card under Data,
// privacy & recovery opens it in place. It reads Core's overview only while
// it is shown, and again each time it is shown.
test("data & storage opens from Data, privacy & recovery and reads Core's overview each time it is shown", async () => {
  const f = await mount();
  const view = {
    format: 1, readAt: "2026-10-24T22:00:00Z", dataDir: "/fixture/data",
    entries: [{ name: "jobs", what: "jobs", kind: "folder", backup: "copied", backupReason: null }],
    unreadable: null, database: { pageSize: 4096, pages: 10, freePages: 0 }, jobs: { total: 0, unfinished: 0 },
    native: [], notInBackup: [], measurement: null, bounds: { entries: 1000000, seconds: 30 },
  };
  const answer = f.w.fetch;
  f.w.fetch = async (url, init = {}) => {
    if (!url.includes("/api/storage")) return answer(url, init);
    f.calls.push({ url, method: init.method || "GET" });
    return { ok: true, status: 200, json: async () => structuredClone(view), text: async () => JSON.stringify(view) };
  };
  const reads = () => f.calls.filter((c) => c.url.includes("/api/storage")).length;
  const editor = () => f.w.document.querySelector("#settings-editor-storage");
  const openStorage = async () => {
    f.w.document.querySelector("#settings-tab-data").click();
    assert.ok(await f.press("Open Data & storage overview"), "Data, privacy & recovery offers it");
    assert.ok(await until(() => editor() && !editor().hidden && /Job records and output logs/.test(editor().textContent)), "it shows Core's overview");
  };
  try {
    await f.open();
    f.w.document.querySelector("#settings-tab-data").click();
    assert.ok(await until(() => !!f.button("Open Data & storage overview")));
    assert.equal(reads(), 0, "finding the setting reads nothing");
    await openStorage();
    assert.equal(reads(), 1);
    // The update status Settings already holds is passed in, not read again.
    assert.match(editor().textContent, /This Core is not a managed install|Releases: /);
    f.w.document.querySelector("#settings-tab-updates").click();
    assert.ok(await until(() => editor()?.hidden === true), "another category hides it, still mounted");
    await polls(f);
    assert.equal(reads(), 1, "hidden, it reads nothing");
    await openStorage();
    assert.ok(await until(() => reads() === 2), "shown again, it reads Core's overview again");
    await f.close();
    await wait(300);
    assert.equal(reads(), 2, "closed, it reads nothing");
    assert.deepEqual(f.calls.filter((c) => c.url.includes("/api/storage") && c.method !== "GET"), [], "it changes nothing");
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }
});

// The desktop shell's own update state, as desktop/src/update.rs reports it.
function desktopShell(overrides = {}) {
  const state = {
    version: "0.1.0",
    channel: "installer",
    unavailable: null,
    phase: "idle",
    error: null,
    receivedBytes: 0,
    totalBytes: null,
    available: null,
    ...overrides,
  };
  const invoked = [];
  const shell = async (command, args, w) => {
    // Appearance and other shell commands are not this test's concern.
    if (!command.startsWith("desktop_update_")) return null;
    invoked.push({ command, args, savedDraft: savedDraftText(w.localStorage, "a") });
    if (command === "desktop_update_check") {
      state.phase = "available";
      state.available = { version: "0.2.0", notes: "Signed desktop fixes.", date: null };
    }
    if (command === "desktop_update_install") {
      // The shell exits into the installer; this page never hears back.
      state.phase = "installing";
      return new Promise(() => {});
    }
    return structuredClone(state);
  };
  return { state, invoked, shell };
}

test("a browser page explains the desktop app is updated separately and offers no desktop actions", async () => {
  const f = await mount();
  try {
    await f.openDesktop();
    const desktop = f.w.document.querySelector('[aria-label="Desktop app"]');
    assert.match(desktop.textContent, /updated separately/);
    assert.equal(desktop.querySelectorAll("button").length, 0, "no desktop buttons in a browser");
    assert.deepEqual(f.errors, []);
  } finally {
    f.dom.window.close();
  }
});

test("the desktop checks its Core, installs only when asked, and saves drafts first", async () => {
  const d = desktopShell();
  const f = await mount({}, d.shell);
  const proto = f.w.Storage.prototype,
    set = proto.setItem;
  try {
    await f.openDesktop();
    const desktop = () => f.w.document.querySelector('[aria-label="Desktop app"]');
    assert.match(desktop().textContent, /Version 0\.1\.0/);
    assert.ok(f.button("Connection"), "the connection page stays reachable");
    assert.deepEqual(d.invoked.map((c) => c.command), ["desktop_update_status"]);
    f.button("Check for desktop update").click();
    await wait();
    assert.match(desktop().textContent, /Version 0\.2\.0 is available/);
    assert.match(desktop().textContent, /Signed desktop fixes/);
    assert.match(desktop().textContent, /Drafts and the Workspace connection are kept/);
    assert.equal(
      d.invoked.filter((c) => c.command === "desktop_update_install").length,
      0,
      "a check never installs",
    );
    // A draft that cannot be saved keeps the window open.
    const raw = "  desktop\r\n中文\r\n".repeat(12);
    const field = f.w.document.querySelector("[data-composer-input]");
    setComposerText(field, "");
    await wait();
    proto.setItem = function (key, value) {
      if (key.startsWith("yuzuno.paste.v1:"))
        throw new f.w.Error("Draft body storage is full");
      return set.call(this, key, value);
    };
    const paste = new f.w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => raw } });
    field.dispatchEvent(paste);
    await wait();
    f.button("Download and install 0.2.0").click();
    await wait();
    assert.match(desktop().textContent, /Draft body storage is full/);
    assert.equal(
      d.invoked.filter((c) => c.command === "desktop_update_install").length,
      0,
      "no install while a draft is unsaved",
    );
    proto.setItem = set;
    const install = f.button("Download and install 0.2.0");
    install.click();
    install.click();
    await wait();
    const installs = d.invoked.filter((c) => c.command === "desktop_update_install");
    assert.equal(installs.length, 1);
    assert.equal(JSON.stringify(installs[0].args), '{"version":"0.2.0"}');
    assert.equal(installs[0].savedDraft, raw);
    assert.equal(
      // Opening Settings may check for a release; nothing more.
      f.calls.filter((c) => c.method === "POST" && /\/updates\/(?!check$)/.test(c.url)).length,
      0,
      "the Workspace service is not updated or restarted",
    );
    assert.deepEqual(f.errors, []);
  } finally {
    proto.setItem = set;
    f.dom.window.close();
  }
});

for (const managed of [false, true]) {
  test(`desktop updates work without a Core release source (managed=${managed})`, async () => {
    const d = desktopShell();
    const f = await mount({ managed, releaseSource: { configured: false, phase: "unavailable", reason: "No Core publisher key" } }, d.shell);
    try {
      await f.openDesktop();
      assert.equal(f.button("Check for desktop update").disabled, false);
      f.button("Check for desktop update").click();
      await wait();
      const install = f.button("Download and install 0.2.0");
      assert.ok(install);
      assert.equal(install.disabled, false);
      install.click();
      await wait();
      assert.equal(d.invoked.filter(c => c.command === "desktop_update_check").length, 1);
      assert.equal(d.invoked.filter(c => c.command === "desktop_update_install").length, 1);
      assert.equal(f.calls.filter(c => c.method === "POST" && /\/updates\/(?!check$)/.test(c.url)).length, 0);
      assert.deepEqual(f.errors, []);
    } finally { f.w.close(); }
  });
}

test("a copy not installed by the Yuzuno installer can check but not install", async () => {
  const d = desktopShell({ channel: "unknown" });
  const f = await mount({}, d.shell);
  try {
    await f.openDesktop();
    const desktop = f.w.document.querySelector('[aria-label="Desktop app"]');
    assert.match(desktop.textContent, /not installed by the Yuzuno installer/);
    f.button("Check for desktop update").click();
    await wait();
    assert.equal(f.button("Download and install 0.2.0").disabled, true);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dom.window.close();
  }
});

test("a non-loopback Core or an older desktop explains the manual path", async () => {
  const remote = desktopShell({
    unavailable: "Desktop updates come through a Core on this computer. Connect to it, or update by hand.",
  });
  let f = await mount({}, remote.shell);
  try {
    await f.openDesktop();
    assert.match(f.w.document.body.textContent, /Core on this computer/);
    assert.equal(f.button("Check for desktop update").disabled, true);
  } finally {
    f.dom.window.close();
  }
  f = await mount({}, async (command) => {
    throw `Command ${command} not found`;
  });
  try {
    await f.openDesktop();
    const desktop = f.w.document.querySelector('[aria-label="Desktop app"]');
    assert.match(desktop.textContent, /cannot update itself\. Install a newer release by hand/);
    assert.ok(f.button("Check for desktop update") === undefined, "no desktop check button");
    assert.ok(f.button("Connection"));
    assert.deepEqual(f.errors, []);
  } finally {
    f.dom.window.close();
  }
});
