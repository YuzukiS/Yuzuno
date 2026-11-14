import test from "node:test";
import assert from "node:assert/strict";
import { cardSize } from "../src/home/card-preview.ts";
import { cadenceLabel, recentLabel, refreshStatus, weeklyRunsOf } from "../src/home/refresh-state.ts";
import { refreshText, refreshTextEn, refreshTextZh } from "../src/home/refresh-text.ts";

// YN-113 R3: a refreshing card's words, states and size, apart from any Core
// or browser. Synthetic sections only (design §3.1, §3.2, §10).
const reason = (en, zh) => ({ code: "why", message: en, messageZh: zh });
const base = (extra = {}) => ({
  version: 3,
  cadence: { every: "day", at: "08:00" },
  zone: "local",
  utcOffset: "+08:00",
  instruction: "Summarise the news.",
  enabled: true,
  pausedReason: null,
  weeklyRuns: 7,
  nextAt: "2026-11-15T00:00:00Z",
  lastSlot: "2026-11-14T00:00:00Z",
  run: null,
  recent: [],
  failures: 0,
  waiting: null,
  versions: 2,
  createdAt: "2026-11-01T00:00:00Z",
  createdBy: "a",
  updatedAt: "2026-11-14T00:01:00Z",
  ...extra,
});
const clock = (iso) => (iso ? iso.slice(11, 16) : "");
const status = (refresh, language = "en") => refreshStatus(refresh, language, clock, "Mori");

test("a schedule in words: every day, every N hours, every week on its days", () => {
  const en = refreshText("en"), zh = refreshText("zh-Hans");
  assert.equal(cadenceLabel({ every: "day", at: "08:00" }, "en", en), "Daily 08:00");
  assert.equal(cadenceLabel({ every: "day", at: "08:00" }, "zh-Hans", zh), "每天 08:00");
  assert.equal(cadenceLabel({ every: "hours", at: "00:00", hours: 3 }, "en", en), "Every 3 h");
  assert.equal(cadenceLabel({ every: "hours", at: "00:00", hours: 3 }, "zh-Hans", zh), "每 3 小时");
  assert.equal(cadenceLabel({ every: "week", at: "08:00", days: [1, 3] }, "en", en), "Weekly Mon, Wed 08:00");
  assert.equal(cadenceLabel({ every: "week", at: "08:00", days: [1, 3] }, "zh-Hans", zh), "每周 一、三 08:00");
});

test("the Turns a week are Core's: 7 a day, 168 / N by hours, one a day it runs", () => {
  assert.equal(weeklyRunsOf({ every: "day", at: "08:00" }), 7);
  assert.equal(weeklyRunsOf({ every: "hours", at: "00:00", hours: 2 }), 84);
  assert.equal(weeklyRunsOf({ every: "hours", at: "00:00", hours: 12 }), 14);
  assert.equal(weeklyRunsOf({ every: "week", at: "08:00", days: [1, 3, 5] }), 3);
});

test("every state reads as designed, in both languages", () => {
  assert.deepEqual(status(base({ run: { slot: "2026-11-14T00:00:00Z", missed: 0, state: "refreshed", endedAt: "2026-11-14T00:01:00Z" } })),
    { kind: "refreshed", text: "Refreshed 00:01" });
  assert.deepEqual(status(base({ run: { slot: "2026-11-14T00:00:00Z", missed: 2, state: "refreshed", endedAt: "2026-11-14T00:01:00Z" } }), "zh-Hans"),
    { kind: "caughtUp", text: "已补跑 00:01 · 错过 2 次" });
  assert.deepEqual(status(base({ run: { slot: "2026-11-14T00:00:00Z", missed: 0, state: "sent" } })), { kind: "refreshing", text: "Refreshing…" });
  assert.deepEqual(status(base({ waiting: { slot: "2026-11-14T00:00:00Z", missed: 0, reason: "busy", agentId: "a", agentName: "Mori", since: "" } })),
    { kind: "waiting", text: "Waiting for Mori" });
  assert.deepEqual(status(base({ waiting: { slot: "2026-11-14T00:00:00Z", missed: 1, reason: "offline", agentId: "a", agentName: "Mori", since: "" } }), "zh-Hans"),
    { kind: "waiting", text: "等 Mori 连上" });
  assert.deepEqual(status(base({ waiting: { slot: "2026-11-14T00:00:00Z", missed: 0, reason: "approval", agentId: "a", agentName: "Mori", since: "" } })),
    { kind: "waiting", text: "Mori needs your approval" });
  assert.deepEqual(status(base({ run: { slot: "2026-11-14T00:00:00Z", missed: 0, state: "failed", reason: reason("Its owner was busy", "主人一直在忙") } }), "zh-Hans"),
    { kind: "failed", text: "没刷新：主人一直在忙" });
  assert.deepEqual(status(base({ run: { slot: "2026-11-14T00:00:00Z", missed: 1, state: "skipped", reason: reason("A newer slot came first", "又到了新的时段") } })),
    { kind: "failed", text: "Didn't refresh: A newer slot came first" });
  assert.deepEqual(status(base({ enabled: false, pausedReason: reason("Paused after 3 failures in a row", "连续失败 3 次，已自动暂停") })),
    { kind: "paused", text: "Paused · Paused after 3 failures in a row" });
  assert.deepEqual(status(base({ enabled: false, pausedReason: null }), "zh-Hans"), { kind: "paused", text: "已暂停 · 没有说明原因" });
  assert.deepEqual(status(base()), { kind: "notYet", text: "Not run yet" });
});

test("a waiting send Core refused is a failure, with Core's reason", () => {
  assert.deepEqual(status(base({ waiting: { slot: "2026-11-14T00:00:00Z", missed: 0, reason: "refused", agentId: "a", agentName: "Mori", since: "", error: "no such agent" } })),
    { kind: "failed", text: "Didn't refresh: no such agent" });
});

test("the recent runs' words: a made-up run is a catch-up, a skipped one is skipped", () => {
  assert.equal(recentLabel({ state: "refreshed", missed: 0 }, "en"), "Refreshed");
  assert.equal(recentLabel({ state: "refreshed", missed: 2 }, "en"), "Caught up");
  assert.equal(recentLabel({ state: "refreshed", missed: 2 }, "zh-Hans"), "补跑");
  assert.equal(recentLabel({ state: "skipped", missed: 0 }, "en"), "Skipped");
  assert.equal(recentLabel({ state: "failed", missed: 0 }, "zh-Hans"), "失败");
});

test("a refreshing card is wide unless its author named a size", () => {
  const lead = { type: "Markdown", props: { text: "The conclusion." } };
  const section = (extra = {}) => ({
    key: "digest/news", kind: "report", title: "Today", version: 1,
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["lead"] }, lead } },
    attachments: [], refresh: base(), ...extra,
  });
  assert.equal(cardSize(section()), "wide", "no summary named: still wide");
  const named = (size) => section({ body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", ...(size ? { size } : {}) } }, children: ["lead"] }, lead } } });
  assert.equal(cardSize(named(null)), "wide");
  assert.equal(cardSize(named("small")), "small");
  assert.equal(cardSize(named("large")), "large");
  assert.equal(cardSize(section({ refresh: undefined })), "small", "an ordinary card with no figure stays small");
});

test("every word has both languages", () => {
  const keys = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, item]) =>
      item && typeof item === "object" && !Array.isArray(item) ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`]);
  assert.deepEqual(keys(refreshTextZh).sort(), keys(refreshTextEn).sort());
  assert.equal(refreshTextZh.panel.weekdays.length, 7);
  assert.equal(refreshTextEn.panel.weekdays.length, 7);
});
