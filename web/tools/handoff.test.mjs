import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_LIMIT,
  MESSAGE_LIMIT,
  handoffRefusal,
  handoffText,
  readHandoff,
  sameMachine,
} from "../src/handoff.ts";

const base = { cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const mori = { ...base, id: "a", name: "Mori" };
const hana = { ...base, id: "b", name: "Hana" };
const remote = { ...base, id: "r", name: "Sora", remote: { machine: { id: "m1", name: "lab-box", target: "lab", codex: "codex", defaultCwd: "/" } } };
const now = new Date(Date.UTC(2026, 9, 20, 7, 30));
const message = (fields = {}) => ({
  kind: "message", agentId: "a", agentName: "Mori", turnId: "t-1", itemId: "i-1",
  author: { kind: "agent" }, at: Date.UTC(2026, 9, 20, 6, 41), text: "Line one\n\nLine two", excerpt: false, ...fields,
});

test("a message keeps its author apart from the user who forwards it, and is quoted in full", () => {
  assert.equal(handoffText(message(), hana, now), [
    "Forwarded from Mori’s conversation: Mori’s reply of 2026-10-20 06:41 UTC. Mori wrote it; I am passing it on.",
    "(Turn t-1, item i-1. You cannot open that conversation; the quote below is what I am sending.)",
    "",
    "> Line one\n>\n> Line two",
  ].join("\n"));
  assert.match(handoffText(message({ author: { kind: "user" }, at: null }), hana, now), /^Forwarded from Mori’s conversation: my message to Mori\.\n/);
  assert.match(handoffText(message({ author: { kind: "mailbox" }, excerpt: true }), hana, now), /an excerpt of a Workspace mailbox notice Mori received of .* Yuzuno wrote it/);
  assert.match(handoffText(message({ author: { kind: "reminder" } }), hana, now), /a Yuzuno reminder to Mori of .* Yuzuno wrote it/);
  assert.match(handoffText(message({ excerpt: true }), hana, now), /: an excerpt of Mori’s reply of/);
});

test("a long message is cut at the limit and says how much was left out", () => {
  const text = "x".repeat(MESSAGE_LIMIT + 25);
  const draft = handoffText(message({ text }), hana, now);
  assert.ok(draft.includes(`> ${"x".repeat(MESSAGE_LIMIT)}\n> [… only the first ${MESSAGE_LIMIT} of ${MESSAGE_LIMIT + 25} characters are included]`));
  assert.ok(!draft.includes("x".repeat(MESSAGE_LIMIT + 1)));
});

test("a task is a reference with a way to read it, never an assignment", () => {
  const task = { kind: "task", taskId: "T-7", title: "Tidy the rail", status: "review", assignee: "Mori", version: 4, summary: "Result: done." };
  assert.equal(handoffText(task, hana, now), [
    "For reference: task T-7 “Tidy the rail”, status review, assigned to Mori, version 4, as of 2026-10-20 07:30 UTC. This does not assign it to you. Read its latest state with task_get(taskId=\"T-7\").",
    "",
    "> Result: done.",
  ].join("\n"));
  assert.match(handoffText({ ...task, assignee: null, summary: " " }, hana, now), /, not assigned, version 4,.*task_get\(taskId="T-7"\)\.$/);
});

test("a Job says where its files are, and warns an Agent elsewhere that the paths will not open", () => {
  const artifacts = Array.from({ length: ARTIFACT_LIMIT + 2 }, (_, i) => `/out/${i}.json`);
  const job = { kind: "job", jobId: "j-1", name: "Build", status: "succeeded", reason: "success", finishedAt: "2026-10-20T06:41:07Z", machine: { kind: "core" }, artifacts };
  const local = handoffText(job, hana, now);
  assert.match(local, /^For reference: Job “Build” \(j-1\), succeeded, finished 2026-10-20 06:41 UTC, as of 2026-10-20 07:30 UTC\. Read it with job_get\(jobId="j-1"\)\.\nReason: success\nArtifacts, on this Core’s host: \/out\/0\.json, .*\/out\/9\.json and 2 more\.$/);
  assert.match(handoffText(job, remote, now), /Those files are on this Core’s host, not where you run, so their paths will not open for you\. Use job_get/);
  const onLab = { ...job, machine: { kind: "ssh", id: "m1", name: "lab-box" } };
  assert.ok(!handoffText(onLab, remote, now).includes("will not open"));
  assert.match(handoffText(onLab, hana, now), /Those files are on lab-box, not where you run/);
  assert.match(handoffText({ ...job, machine: { kind: "windows", name: "pc" } }, hana, now), /Windows on this PC \(pc\), not where you run/);
  assert.equal(sameMachine({ kind: "core" }, hana), true);
  assert.equal(sameMachine({ kind: "windows", name: "pc" }, hana), false);
  assert.ok(!handoffText({ ...job, artifacts: [], reason: null }, remote, now).includes("\n"));
});

test("a handoff is refused for its own conversation, a closed or missing Agent, or no text", () => {
  assert.equal(handoffRefusal(message(), hana), null);
  assert.equal(handoffRefusal(message(), mori), "This already comes from Mori’s conversation.");
  assert.equal(handoffRefusal(message(), { ...hana, closedAt: "2026-10-19" }), "Hana is closed and cannot receive messages.");
  assert.equal(handoffRefusal(message(), undefined), "That Agent is no longer in this Workspace.");
  assert.equal(handoffRefusal(message({ text: "  \n" }), hana), "There is no text to send.");
  // A task or Job may go to any open Agent, its assignee included.
  assert.equal(handoffRefusal({ kind: "task", taskId: "T-7", title: "", status: "todo", assignee: "Mori", version: 1, summary: "" }, mori), null);
});

test("only a well-formed handoff is read from a drag", () => {
  const good = message();
  assert.deepEqual(readHandoff(JSON.stringify(good)), good);
  for (const bad of [
    "not json", "null", "[]", JSON.stringify({ kind: "other" }),
    JSON.stringify({ ...good, author: { kind: "root" } }),
    JSON.stringify({ ...good, at: "yesterday" }),
    JSON.stringify({ kind: "task", taskId: "T-1", title: "t", status: "todo", assignee: null, version: 1.5, summary: "" }),
    JSON.stringify({ kind: "job", jobId: "j", name: "n", status: "s", reason: null, finishedAt: null, machine: { kind: "ssh", name: "x" }, artifacts: [] }),
    JSON.stringify({ kind: "job", jobId: "j", name: "n", status: "s", reason: null, finishedAt: null, machine: { kind: "core" }, artifacts: [1] }),
  ]) assert.equal(readHandoff(bad), null, bad);
  assert.equal(readHandoff(JSON.stringify({ ...good, text: "x".repeat(8_000_001) })), null);
  assert.equal(readHandoff(JSON.stringify({ ...good, text: "x".repeat(500_000) }))?.text.length, 500_000);
});
