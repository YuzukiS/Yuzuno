import test from "node:test";
import assert from "node:assert/strict";

// System notifications on this device (T-188), without a browser: what the
// system allows, asked only when the user asks; this device's choices; and
// which changes between two reads of the Workspace become a notification.
const access = await import("../src/notification-access.ts");
const prefs = await import("../src/notification-prefs.ts");
const events = await import("../src/notification-events.ts");

/** A Notification API as a browser has it, recording what is asked of it. */
function fakeNotifications({ permission = "default", answer = "granted", style = "promise", shows = "show" } = {}) {
  const calls = { asked: 0, shown: [] };
  class FakeNotification {
    static permission = permission;
    static requestPermission(callback) {
      calls.asked += 1;
      FakeNotification.permission = answer;
      if (style === "callback") {
        setTimeout(() => callback?.(answer), 0);
        return undefined;
      }
      return Promise.resolve(answer);
    }
    constructor(title, options) {
      if (shows === "page-only") throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
      if (shows === "throws") throw new Error("Blocked by the fixture");
      this.onshow = this.onerror = this.onclick = null;
      this.closed = false;
      calls.shown.push({ title, options, notification: this });
      if (shows === "show") setTimeout(() => this.onshow?.(), 0);
      if (shows === "error") setTimeout(() => this.onerror?.(), 0);
    }
    close() {
      this.closed = true;
    }
  }
  return { api: FakeNotification, calls };
}
const host = (api, extra = {}) => ({ Notification: api, isSecureContext: true, native: false, focus() { this.focused = (this.focused ?? 0) + 1; }, ...extra });

test("the system's answer is read as it is: not requested, allowed, denied, or not supported and why", () => {
  for (const [permission, state] of [["default", "not-requested"], ["granted", "allowed"], ["denied", "denied"]]) {
    const { api, calls } = fakeNotifications({ permission });
    assert.deepEqual(access.notificationAccess(host(api)), { state });
    assert.equal(calls.asked, 0, "reading it asks nothing");
  }
  const { api } = fakeNotifications({ permission: "granted" });
  // The desktop or iPhone app, even where its web view has the API.
  assert.deepEqual(access.notificationAccess(host(api, { native: true })), { state: "unsupported", reason: "app" });
  assert.deepEqual(access.notificationAccess(host(api, { isSecureContext: false })), { state: "unsupported", reason: "insecure" });
  assert.deepEqual(access.notificationAccess(host(undefined)), { state: "unsupported", reason: "no-api" });
});

test("the system is asked only when asked to, once: a denial is not asked again", async () => {
  const { api, calls } = fakeNotifications({ answer: "denied" });
  const device = host(api);
  assert.deepEqual(await access.requestNotificationAccess(device), { state: "denied" });
  assert.deepEqual(await access.requestNotificationAccess(device), { state: "denied" });
  assert.equal(calls.asked, 1);
  // Already allowed: nothing to ask.
  const allowed = fakeNotifications({ permission: "granted" });
  assert.deepEqual(await access.requestNotificationAccess(host(allowed.api)), { state: "allowed" });
  assert.equal(allowed.calls.asked, 0);
  // Not supported: nothing is asked of anything.
  const app = fakeNotifications();
  assert.deepEqual(await access.requestNotificationAccess(host(app.api, { native: true })), { state: "unsupported", reason: "app" });
  assert.equal(app.calls.asked, 0);
  // Older Safari answers through a callback only.
  const safari = fakeNotifications({ style: "callback" });
  assert.deepEqual(await access.requestNotificationAccess(host(safari.api)), { state: "allowed" });
});

test("a notification reports what the browser said: shown, an error, nothing, or refused before sending", async () => {
  const shown = fakeNotifications({ permission: "granted" });
  const device = host(shown.api);
  let opened = 0;
  assert.deepEqual(await access.showSystemNotification("Yuzuno", { body: "A test" }, device, { opened: () => (opened += 1) }), { outcome: "shown" });
  assert.equal(shown.calls.shown.length, 1);
  shown.calls.shown[0].notification.onclick();
  assert.deepEqual([device.focused, opened, shown.calls.shown[0].notification.closed], [1, 1, true], "a click opens the Workspace and what it is about");

  const failed = fakeNotifications({ permission: "granted", shows: "error" });
  assert.equal((await access.showSystemNotification("Yuzuno", {}, host(failed.api))).outcome, "failed");
  const thrown = fakeNotifications({ permission: "granted", shows: "throws" });
  assert.deepEqual(await access.showSystemNotification("Yuzuno", {}, host(thrown.api)), { outcome: "failed", message: "Blocked by the fixture" });
  const silent = fakeNotifications({ permission: "granted", shows: "nothing" });
  assert.deepEqual(await access.showSystemNotification("Yuzuno", {}, host(silent.api), { waitMs: 20 }), { outcome: "unconfirmed" });

  for (const permission of ["default", "denied"]) {
    const refused = fakeNotifications({ permission });
    const result = await access.showSystemNotification("Yuzuno", {}, host(refused.api));
    assert.equal(result.outcome, "refused");
    assert.equal(refused.calls.shown.length + refused.calls.asked, 0, "nothing sent, nothing asked");
  }
});

test("a browser that allows notifications but not from a page is not supported from then on", async () => {
  const { api } = fakeNotifications({ permission: "granted", shows: "page-only" });
  const device = host(api);
  assert.deepEqual(await access.showSystemNotification("Yuzuno", {}, device), { outcome: "refused", access: { state: "unsupported", reason: "page-only" } });
  assert.deepEqual(access.notificationAccess(device), { state: "unsupported", reason: "page-only" });
});

test("this device's choices: off until turned on; a saved value keeps what it holds; muting keeps the choices", () => {
  assert.equal(prefs.defaultNotificationPrefs.enabled, false);
  assert.equal(prefs.defaultNotificationPrefs.preview, false);
  for (const saved of [null, "on", 7, [], { enabled: "yes", categories: "all" }])
    assert.deepEqual(prefs.parseNotificationPrefs(saved), prefs.defaultNotificationPrefs, JSON.stringify(saved));
  assert.deepEqual(prefs.parseNotificationPrefs({ enabled: true, categories: { finished: false, other: true }, muted: true, extra: 1 }), {
    enabled: true,
    categories: { needsYou: true, failed: true, finished: false, backupFailed: false },
    preview: false,
    muted: true,
  });
});

test("a daily backup's failure is a kind of its own, off until chosen, also where an Agent's failure is on (T-196)", () => {
  assert.equal(prefs.defaultNotificationPrefs.categories.backupFailed, false);
  // Choices saved before this kind existed: it stays off.
  const earlier = prefs.parseNotificationPrefs({ enabled: true, categories: { needsYou: true, failed: true, finished: true } });
  assert.equal(earlier.categories.backupFailed, false);
  assert.equal(prefs.notifies(earlier, { state: "allowed" }, "failed"), true);
  assert.equal(prefs.notifies(earlier, { state: "allowed" }, "backupFailed"), false);
  const chosen = prefs.parseNotificationPrefs({ enabled: true, categories: { backupFailed: true } });
  assert.equal(prefs.notifies(chosen, { state: "allowed" }, "backupFailed"), true);
  for (const state of [{ state: "not-requested" }, { state: "denied" }, { state: "unsupported", reason: "app" }])
    assert.equal(prefs.notifies(chosen, state, "backupFailed"), false, JSON.stringify(state));
  assert.equal(prefs.notifies({ ...chosen, muted: true }, { state: "allowed" }, "backupFailed"), false);
});

test("a backup notice only for a run newly known to have failed, once, naming no folder or error (T-196)", () => {
  const run = (state, extra = {}) => ({ slot: "2026-10-26T03:00:00Z", operationId: "op-26", state, to: "/backups/daily/yuzuno-backup-20261026T0300Z",
    error: state === "failed" ? "Not enough space in /backups/daily: needs 2 GiB more" : null, ...extra });
  // The first read has nothing to compare with.
  assert.equal(events.backupNotice("ws-1", undefined, run("failed")), null);
  const failed = events.backupNotice("ws-1", run("running"), run("failed"));
  assert.deepEqual(failed, {
    kind: "backupFailed",
    tag: "yuzuno:backupFailed:ws-1:op-26",
    title: "The daily backup failed",
    body: "The backup due at 2026-10-26 03:00 UTC did not finish. Open Settings → Backup to see why.",
    backup: { workspaceId: "ws-1" },
  });
  assert.doesNotMatch(JSON.stringify(failed), /backups\/daily|Not enough space|GiB/);
  // Read again (a reconnect, another notice): nothing more.
  assert.equal(events.backupNotice("ws-1", run("failed"), run("failed")), null);
  // Started, waiting, succeeded, stopped by someone, or a state not known: nothing.
  for (const state of ["running", "", "succeeded", "stopped", "queued", "toString"])
    assert.equal(events.backupNotice("ws-1", run("running"), run(state)), null, state);
  assert.equal(events.backupNotice("ws-1", null, null), null);
  // Cut off by Core stopping, found once Core is back.
  assert.equal(events.backupNotice("ws-1", run("running"), run("interrupted")).title, "The daily backup was interrupted");
  // A run that could not begin has no operation: its slot names it.
  const notStarted = events.backupNotice("ws-1", null, run("not_started", { operationId: null, error: "Cannot back up to /backups/daily: its folder does not exist" }));
  assert.deepEqual([notStarted.title, notStarted.tag, notStarted.body], [
    "The daily backup didn’t start",
    "yuzuno:backupFailed:ws-1:2026-10-26T03:00:00Z",
    "The backup due at 2026-10-26 03:00 UTC could not begin. Open Settings → Backup to see why.",
  ]);
  // The next day's run failing after this one did: a notice of its own.
  const next = events.backupNotice("ws-1", run("failed"), run("failed", { slot: "2026-10-27T03:00:00Z", operationId: "op-27" }));
  assert.equal(next.tag, "yuzuno:backupFailed:ws-1:op-27");
  // Another Workspace's Core: another tag.
  assert.equal(events.backupNotice("ws-2", run("running"), run("failed")).tag, "yuzuno:backupFailed:ws-2:op-26");
});

test("a kind is shown only when chosen, not muted and allowed: the choice alone is not permission", () => {
  const on = { ...prefs.defaultNotificationPrefs, enabled: true };
  assert.equal(prefs.notifies(on, { state: "allowed" }, "failed"), true);
  for (const state of [{ state: "not-requested" }, { state: "denied" }, { state: "unsupported", reason: "no-api" }])
    assert.equal(prefs.notifies(on, state, "failed"), false, JSON.stringify(state));
  assert.equal(prefs.notifies({ ...on, muted: true }, { state: "allowed" }, "failed"), false);
  assert.equal(prefs.notifies({ ...on, categories: { ...on.categories, failed: false } }, { state: "allowed" }, "failed"), false);
  assert.equal(prefs.notifies(prefs.defaultNotificationPrefs, { state: "allowed" }, "failed"), false);
});

// T-188: the desktop app that can notify here hands them to the system itself.
test("in the desktop app that can notify, they go through it: not 'allowed', nothing to ask, a notification only handed on", async () => {
  const handed = [];
  const desktop = { notify: async (title, body, whenAway) => (handed.push({ title, body, whenAway }), true) };
  const { api } = fakeNotifications({ permission: "granted" });
  const app = host(api, { native: true, desktop });
  assert.deepEqual(access.notificationAccess(app), { state: "through-app" });
  assert.deepEqual(await access.requestNotificationAccess(app), { state: "through-app" }, "nothing is asked");
  const on = { ...prefs.defaultNotificationPrefs, enabled: true };
  assert.equal(prefs.notifies(on, { state: "through-app" }, "failed"), true);
  assert.equal(prefs.notifies({ ...on, muted: true }, { state: "through-app" }, "failed"), false);
  assert.equal(prefs.notifies(prefs.defaultNotificationPrefs, { state: "through-app" }, "failed"), false, "the choice is still needed");
  assert.deepEqual(await access.showSystemNotification("Hana finished", { body: "The Turn finished.", tag: "yuzuno:finished:b" }, app, { whenAway: true }), { outcome: "handed" });
  assert.deepEqual(await access.showSystemNotification("Yuzuno", { body: "A test" }, app), { outcome: "handed" });
  assert.deepEqual(handed, [{ title: "Hana finished", body: "The Turn finished.", whenAway: true }, { title: "Yuzuno", body: "A test", whenAway: false }], "for while away, or also while looking (a test)");
  // The app held one back, its window in front.
  const front = host(api, { native: true, desktop: { notify: async () => false } });
  assert.deepEqual(await access.showSystemNotification("Hana finished", {}, front, { whenAway: true }), { outcome: "held" });
  const refusing = host(api, { native: true, desktop: { notify: async () => { throw "The system didn't take the notification: fixture"; } } });
  assert.deepEqual(await access.showSystemNotification("Yuzuno", {}, refusing), { outcome: "failed", message: "The system didn't take the notification: fixture" });
  // Without the app's word, as in an older app: not available.
  assert.deepEqual(access.notificationAccess(host(api, { native: true, desktop: null })), { state: "unsupported", reason: "app" });
});

// T-188: on macOS the desktop app says what macOS allows it, and can ask macOS once.
test("in the desktop app on macOS, macOS's answer is read as it is, asked only before there is one, and only an allowed one is sent", async () => {
  const { api, calls } = fakeNotifications({ permission: "granted" });
  const sent = [];
  const requests = [];
  const mac = (authorization, { reason, answer = authorization, fails } = {}) => ({
    notify: async (title, body, whenAway) => (sent.push({ title, whenAway }), true),
    macos: {
      authorization,
      reason,
      request: async () => {
        requests.push(authorization);
        if (fails) throw fails;
        return mac(answer);
      },
    },
  });
  const app = (desktop) => host(api, { native: true, desktop });
  for (const [authorization, state] of [
    ["allowed", { state: "allowed", system: "macos" }],
    ["quiet", { state: "allowed", system: "macos", quiet: true }],
    ["not-requested", { state: "not-requested", system: "macos" }],
    ["denied", { state: "denied", system: "macos" }],
    ["unknown", { state: "unsupported", reason: "unread" }],
  ])
    assert.deepEqual(access.notificationAccess(app(mac(authorization))), state, authorization);
  assert.deepEqual(access.notificationAccess(app(mac("unknown", { reason: "unread here" }))), { state: "unsupported", reason: "unread", detail: "unread here" });
  assert.equal(calls.asked, 0, "the web view's own permission is never read as macOS's");

  assert.deepEqual(await access.requestNotificationAccess(app(mac("not-requested", { answer: "allowed" }))), { state: "allowed", system: "macos" });
  assert.deepEqual(await access.requestNotificationAccess(app(mac("not-requested", { answer: "denied" }))), { state: "denied", system: "macos" });
  for (const answered of ["allowed", "quiet", "denied", "unknown"]) await access.requestNotificationAccess(app(mac(answered)));
  assert.deepEqual(requests, ["not-requested", "not-requested"], "asked only before an answer: never after a no, nor for a state it couldn't read");
  await assert.rejects(access.requestNotificationAccess(app(mac("not-requested", { fails: "macOS rejected the notification request" }))), /^macOS rejected/);

  for (const authorization of ["not-requested", "denied", "unknown"]) {
    const outcome = await access.showSystemNotification("Yuzuno", { body: "A test" }, app(mac(authorization)));
    assert.equal(outcome.outcome, "refused", authorization);
  }
  assert.deepEqual(sent, [], "nothing handed on unless macOS allows it");
  assert.deepEqual(await access.showSystemNotification("Hana finished", {}, app(mac("allowed")), { whenAway: true }), { outcome: "handed" });
  assert.deepEqual(await access.showSystemNotification("Yuzuno", {}, app(mac("quiet"))), { outcome: "handed" });
  assert.deepEqual(sent, [{ title: "Hana finished", whenAway: true }, { title: "Yuzuno", whenAway: false }]);
  const on = { ...prefs.defaultNotificationPrefs, enabled: true };
  assert.equal(prefs.notifies(on, access.notificationAccess(app(mac("quiet"))), "failed"), true);
  assert.equal(prefs.notifies(on, access.notificationAccess(app(mac("denied"))), "failed"), false);
});

test("text for the desktop app fits its bounds by characters, with no control characters but a body's line breaks", () => {
  assert.equal(access.desktopText("Hana finished", access.DESKTOP_TITLE_MAX), "Hana finished");
  const long = "界".repeat(130);
  const title = access.desktopText(long, access.DESKTOP_TITLE_MAX);
  assert.equal(Array.from(title).length, access.DESKTOP_TITLE_MAX);
  assert.equal(title.endsWith("…"), true);
  assert.equal(access.desktopText("two\nlines\u001b[31m", 120), "two lines [31m");
  assert.equal(access.desktopText("Asked:\nwhich branch?\r", 400, true), "Asked:\nwhich branch? ");
  assert.equal(Array.from(access.desktopText("😀".repeat(500), access.DESKTOP_BODY_MAX, true)).length, access.DESKTOP_BODY_MAX);
});

const agent = (id, extra = {}) => ({ id, name: { a: "Mori", b: "Hana", c: "Sora", d: "Yuki" }[id], status: "idle", pendingCount: 0, closedAt: null, workSummary: null, ...extra });
const said = (kind, text) => ({ kind, text, source: "agent" });

test("a change between two reads: a request, a failure or a finished Turn; nothing on the first read", () => {
  const before = [agent("a", { status: "working" }), agent("b", { status: "working" }), agent("c", { status: "working" })];
  const after = [
    agent("a", { status: "waiting", pendingCount: 1, workSummary: said("pending", "Approve running npm ci in the worktree?") }),
    agent("b", { status: "error", error: "Codex exited unexpectedly", workSummary: said("error", "Codex exited") }),
    agent("c", { status: "idle", workSummary: said("result", "The fourth batch merged.") }),
  ];
  assert.deepEqual(events.agentNotices(null, after, true), [], "a first read is no change");
  assert.deepEqual(events.agentNotices(before, after, true), [
    { kind: "needsYou", tag: "yuzuno:needsYou:a", title: "Mori needs you", body: "Approve running npm ci in the worktree?", agentId: "a" },
    { kind: "failed", tag: "yuzuno:failed:b", title: "Hana: the Turn failed", body: "Codex exited unexpectedly", agentId: "b" },
    { kind: "finished", tag: "yuzuno:finished:c", title: "Sora finished", body: "The fourth batch merged.", agentId: "c" },
  ]);
  // Without preview, who and why only: nothing the Agent wrote.
  const quiet = events.agentNotices(before, after, false);
  assert.deepEqual(quiet.map((n) => n.body), ["Waiting for your response.", "Open the conversation to see why.", "The Turn finished."]);
  // A second request while one is open still notifies (the count went up).
  const more = events.agentNotices([after[0]], [{ ...after[0], pendingCount: 2 }], false);
  assert.deepEqual(more.map((n) => n.kind), ["needsYou"]);
});

test("a running Turn's text, read many times, notifies nothing; nor a stop, an Agent going offline, a closed or a new Agent", () => {
  let previous = [agent("a", { status: "working", workSummary: said("progress", "Running") })];
  for (let i = 0; i < 50; i += 1) {
    const next = [agent("a", { status: "working", workSummary: said("progress", `Running${".".repeat(i)}`) })];
    assert.deepEqual(events.agentNotices(previous, next, true), []);
    previous = next;
  }
  const working = [agent("a", { status: "working" })];
  assert.deepEqual(events.agentNotices(working, [agent("a", { status: "idle", workSummary: said("interrupted", "Stopped") })], true), []);
  assert.deepEqual(events.agentNotices(working, [agent("a", { status: "offline" })], true), []);
  assert.deepEqual(events.agentNotices(working, [agent("a", { status: "idle", closedAt: "2026-10-24T00:00:00Z" })], true), []);
  assert.deepEqual(events.agentNotices([], [agent("b", { status: "waiting", pendingCount: 1 })], true), []);
  // An idle Agent read again, unchanged.
  assert.deepEqual(events.agentNotices([agent("a")], [agent("a")], true), []);
});

test("one notice per Agent, the request first; a read with many becomes one notification, most urgent first", () => {
  const both = events.agentNotices([agent("a", { status: "working" })], [agent("a", { status: "waiting", pendingCount: 1, workSummary: said("result", "Done") })], true);
  assert.deepEqual(both.map((n) => n.kind), ["needsYou"]);
  const three = [
    { kind: "finished", tag: "f", title: "Sora finished", body: "" },
    { kind: "failed", tag: "x", title: "Hana: the Turn failed", body: "" },
    { kind: "needsYou", tag: "n", title: "Mori needs you", body: "" },
  ];
  assert.deepEqual(events.merged(three).map((n) => n.kind), ["needsYou", "failed", "finished"]);
  const burst = events.merged([...three, { kind: "finished", tag: "g", title: "Yuki finished", body: "" }]);
  assert.equal(burst.length, 1);
  assert.deepEqual(burst[0], {
    kind: "needsYou",
    tag: "yuzuno:summary",
    title: "4 updates in your Workspace",
    body: "Mori needs you · Hana: the Turn failed · Sora finished · Yuki finished",
  });
});

test("a new Ask in Needs you notifies once; approvals there come from the Agent list", () => {
  const ask = { kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "release/ship", title: "Ship 0.4 today?", since: "" };
  const approval = { kind: "approval", projectId: "p1", agentId: "b", agentName: "Hana", requestId: "q1", title: "Run npm ci?", since: "" };
  assert.deepEqual(events.askNotices(null, [ask], true), []);
  assert.deepEqual(events.askNotices([], [ask, approval], true), [
    { kind: "needsYou", tag: "yuzuno:needsYou:ask:p1/release/ship", title: "Mori asks you", body: "Ship 0.4 today?", home: true },
  ]);
  assert.equal(events.askNotices([], [ask], false)[0].body, "An Ask is waiting for your answer on Home.");
  assert.deepEqual(events.askNotices([ask], [ask, approval], true), []);
});

test("none of it talks to Core: muting this device changes nothing the Workspace delivers", async () => {
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    throw new Error("no request expected");
  };
  try {
    const { api } = fakeNotifications({ permission: "default", answer: "granted" });
    const device = host(api);
    access.notificationAccess(device);
    await access.requestNotificationAccess(device);
    await access.showSystemNotification("Yuzuno", {}, device);
    const muted = { ...prefs.defaultNotificationPrefs, enabled: true, muted: true };
    prefs.notifies(muted, access.notificationAccess(device), "needsYou");
    events.merged(events.agentNotices([agent("a", { status: "working" })], [agent("a", { status: "error" })], false));
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});
