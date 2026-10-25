// A daily backup's failure as a system notification (T-196), through the app
// as built: Core's change stream says the last run changed, the app reads it
// only while this device chose the kind and its browser allows it, notifies
// once per run, and a click opens Settings → Backup of this Workspace, where
// the reason shows. The browser's Notification API is a recorder; nothing
// here asks the system, retries or starts a backup.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = (ms = 45) => new Promise((r) => setTimeout(r, ms));
async function until(check, label = "condition") {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await pause(20);
  }
  assert.ok(check(), `${label} should settle`);
}

const SLOT = "2026-10-26T03:00:00Z";
const run = (state, extra = {}) => ({
  slot: SLOT, missed: 0, startedAt: "2026-10-26T03:00:05Z", to: "/backups/daily/yuzuno-backup-20261026T0300Z", operationId: "op-26",
  state, error: state === "failed" ? "Not enough space in /backups/daily: needs 2 GiB more. Nothing was written" : null,
  finishedAt: state === "running" ? null : "2026-10-26T03:00:40Z", ...extra,
});

async function mount({ saved = { enabled: true, categories: { backupFailed: true } }, permission = "granted" } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4452/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  if (!w.isSecureContext) Object.defineProperty(w, "isSecureContext", { value: true, configurable: true });
  const core = { lastRun: run("running"), calls: [], streams: [], shown: [], asked: 0 };
  class Recorder {
    static permission = permission;
    static requestPermission() {
      core.asked += 1;
      return Promise.resolve(Recorder.permission);
    }
    constructor(title, options) {
      this.onshow = this.onerror = this.onclick = null;
      this.close = () => {};
      core.shown.push({ title, body: options.body, tag: options.tag, notification: this });
      setTimeout(() => this.onshow?.(), 0);
    }
  }
  w.Notification = Recorder;
  if (saved) w.localStorage.setItem("yuzuno.notifications", JSON.stringify(saved));
  w.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      core.streams.push(this);
    }
    close() { this.readyState = 2; }
  };
  const agent = { id: "a", name: "Mori", cwd: "/w", model: "m", color: "sage", status: "idle", createdAt: "", updatedAt: "",
    unreadCount: 0, pendingCount: 0, reviewedSeq: 0, lastSeq: 10, rev: 10 };
  w.fetch = async (url, init = {}) => {
    const { pathname: path } = new URL(String(url), w.location.href);
    core.calls.push({ path, method: init.method || "GET" });
    let body = {};
    if (path === "/api/workspace") body = { agents: [{ ...agent }], runtime: { connected: true }, defaultCwd: "/w", workspace: { id: "ws-synthetic", name: "Lab" } };
    else if (path === "/api/agents/a") body = { agent: { ...agent }, pending: [], artifacts: [], turns: [{ id: "t-a", status: "completed", items: [
      { id: "m-a", type: "agentMessage", text: "Ready." },
    ] }] };
    else if (path === "/api/catchup") body = { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } };
    else if (path === "/api/workspace/backup/last-run") body = { lastRun: core.lastRun };
    else if (path === "/api/machines") body = { machines: [] };
    else if (path === "/api/workspace/backup") body = {
      canChange: true, workspaceId: "ws-synthetic", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 1024,
      current: null, recent: [], notCovered: [], schedule: { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-27T03:00:00Z", lastRun: core.lastRun },
    };
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  w.eval(bundle);
  const d = w.document;
  try {
    await until(() => d.querySelector('[data-item-id="m-a"]'), "first conversation");
  } catch (error) {
    w.close();
    throw error;
  }
  const stream = () => core.streams.at(-1);
  let n = 0;
  const send = (data) => stream().onmessage?.({ data: JSON.stringify(data), lastEventId: `e-${++n}` });
  const reads = () => core.calls.filter((c) => c.path === "/api/workspace/backup/last-run").length;
  stream().readyState = 1;
  stream().onopen?.({});
  return { w, d, core, send, reads, errors, close: () => w.close() };
}

test("a failed daily backup is one notification, not repeated on a reconnect, and its click opens Settings → Backup", async () => {
  const p = await mount();
  try {
    p.send({ type: "reset", reason: "new" });
    await until(() => p.reads() >= 1, "the last run read");
    // Real time: the read's answer and any notice it would give.
    await pause(200);
    assert.deepEqual(p.core.shown, [], "a running backup is not a failure, and a first read is no change");

    p.core.lastRun = run("failed");
    const before = p.reads();
    p.send({ type: "workspace.changed", scope: "backup" });
    await until(() => p.core.shown.length === 1, "the notification");
    assert.equal(p.reads(), before + 1, "one read for one change");
    const [shown] = p.core.shown;
    assert.deepEqual({ title: shown.title, body: shown.body, tag: shown.tag }, {
      title: "The daily backup failed",
      body: "The backup due at 2026-10-26 03:00 UTC did not finish. Open Settings → Backup to see why.",
      tag: "yuzuno:backupFailed:ws-synthetic:op-26",
    });

    // A reconnect, then another change notice, each read it again: the same run, not again.
    // (Sent together, React would batch them into one read.)
    p.send({ type: "reset", reason: "open" });
    await until(() => p.reads() >= before + 2, "read on the reconnect");
    p.send({ type: "workspace.changed", scope: "backup" });
    await until(() => p.reads() >= before + 3, "read on the next notice");
    await pause(200);
    assert.equal(p.core.shown.length, 1, "once per run");

    // The click opens this Workspace's Backup status, where the reason shows; nothing is sent.
    const posts = () => p.core.calls.filter((c) => c.method !== "GET").map((c) => c.path);
    const postsBefore = posts();
    shown.notification.onclick();
    await until(() => p.d.querySelector("#settings-editor-backup"), "Settings → Backup");
    await until(() => /Not enough space/.test(p.d.querySelector("#settings-editor-backup").textContent), "the reason in Settings");
    await pause(200);
    assert.deepEqual(posts(), postsBefore, "no backup, retry or removal is started");
    assert.equal(p.core.asked, 0, "the system is never asked from here");

    // Settings left through a card that opens another dialog: opened again, it
    // starts where it always does, not at Backup (review bbce8367, P3).
    const search = p.d.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(p.w.HTMLInputElement.prototype, "value").set.call(search, "Execution machines");
    search.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    const leave = () => [...p.d.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Open Execution machines"));
    await until(() => leave() && !leave().disabled, "the machines card");
    leave().click();
    await until(() => !p.d.querySelector("#settings-editor-backup"), "Settings closed");
    for (const close of p.d.querySelectorAll('[aria-label="Close dialog"]')) close.click();
    await pause(100);
    p.d.querySelector('[aria-label="Settings and updates"]').click();
    await until(() => p.d.querySelector("#settings-editor-updates"), "Settings again");
    await pause(150);
    assert.equal(p.d.querySelector("#settings-editor-backup") === null, true, "not at Backup again");
  } finally {
    p.close();
  }
});

test("nothing is read or shown unless this device chose the kind, isn't muted and its browser allows it", async () => {
  const cases = [
    { saved: { enabled: true, categories: { needsYou: true, failed: true, finished: true } } },
    { saved: null },
    { saved: { enabled: true, muted: true, categories: { backupFailed: true } } },
    { permission: "denied" },
    { permission: "default" },
  ];
  for (const options of cases) {
    const p = await mount(options);
    try {
      p.core.lastRun = run("failed");
      p.send({ type: "workspace.changed", scope: "backup" });
      p.send({ type: "reset", reason: "open" });
      // Real time: longer than a read and its notice would take.
      await pause(400);
      assert.equal(p.reads(), 0, `no read: ${JSON.stringify(options)}`);
      assert.deepEqual(p.core.shown, [], JSON.stringify(options));
      assert.equal(p.core.asked, 0);
    } finally {
      p.close();
    }
  }
});

test("a backup Core stopped in the middle of, or one that couldn't start, notifies as such", async () => {
  const p = await mount();
  try {
    await until(() => p.reads() >= 1, "the first read");
    await pause(150);
    p.core.lastRun = run("interrupted");
    p.send({ type: "reset", reason: "open" });
    await until(() => p.core.shown.length === 1, "the interrupted notice");
    assert.equal(p.core.shown[0].title, "The daily backup was interrupted");
    p.core.lastRun = run("not_started", { slot: "2026-10-27T03:00:00Z", operationId: null, error: "Cannot back up to /backups/daily: its folder does not exist" });
    p.send({ type: "workspace.changed", scope: "backup" });
    await until(() => p.core.shown.length === 2, "the not-started notice");
    assert.deepEqual([p.core.shown[1].title, p.core.shown[1].tag], ["The daily backup didn’t start", "yuzuno:backupFailed:ws-synthetic:2026-10-27T03:00:00Z"]);
    assert.doesNotMatch(p.core.shown.map((s) => s.body).join(" "), /backups\/daily|does not exist/);
  } finally {
    p.close();
  }
});
