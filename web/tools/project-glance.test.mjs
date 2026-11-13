// Each project at a glance on the whole of Home (YN-86 §2.1, §8 S1b): from
// the same read, its Needs you and new counts are the ones a project's panel
// on Home counted before it gave way to the glance (HomePanel: Core's Needs you
// for the project, and projectUnseen), and its facts are Core's.
import test from "node:test";
import assert from "node:assert/strict";
import { projectGlance } from "../src/home/project-glance.ts";
import { projectUnseen } from "../src/home/unseen.ts";

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const lead = { agentId: "lead", name: "Dev Lead", state: "active" };
const exec = { agentId: "exec", name: "YN-90 · Design", state: "active" };
const markdown = (text) => ({
  root: "body",
  elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } },
});
const section = (key, kind, extra = {}) => ({
  key,
  kind,
  title: `About ${key}`,
  version: 2,
  owner: lead,
  updatedAt: at(30),
  updatedTurnId: "t1",
  body: markdown(`${key} says this.`),
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...extra,
});
const ask = (key, state = "open", extra = {}) =>
  section(key, "ask", {
    owner: exec,
    ask: { question: `${key}?`, state, reply: { freeText: true }, ...(state === "replied" ? { repliedAt: at(20), replyText: "yes" } : {}) },
    ...extra,
  });
const status = (key, minutes, extra = {}) =>
  section(key, "status", { updatedAt: at(minutes), status: { asOf: at(minutes), validFor: 86_400, stale: false }, ...extra });
const panel = (id, sections, extra = {}) => ({
  project: { id, name: id.toUpperCase() },
  contentEditors: { version: 1, editorAgentIds: ["lead"] },
  agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
  errors: [],
  pending: [],
  jobs: [],
  brief: { version: 3, sections, history: [] },
  unseen: 0,
  missing: [],
  ...extra,
});
const need = (kind, projectId, extra = {}) => ({ kind, projectId, agentId: "exec", agentName: "YN-90 · Design", title: kind, since: at(5), ...extra });

// HomePanel's own counts, as it computed them from the same read before S1b (its header's chips).
const panelCounts = (p, needsYou) => ({
  needs: needsYou.filter((item) => item.projectId === p.project.id).length,
  unseen: projectUnseen(p),
});

test("a glance counts what a project's panel counted from the same read: Core's Needs you for it, and its new cards (§8 S1b)", () => {
  const app = panel("app", [
    ask("ship"),
    // Answered at this version and not changed since: not new to the user, though Core counts it.
    ask("plan", "replied", { updatedAt: at(40) }),
    status("dev", 10),
    section("eval", "report", { updatedAt: at(3) }),
    section("old", "report", { seen: { version: 2, at: at(50) } }),
  ], { unseen: 4, pending: [{ id: "r1", agentId: "exec", agentName: "YN-90", method: "item/commandExecution/requestApproval", params: {}, createdAt: at(4) }] });
  const docs = panel("docs", [section("guide", "report", { seen: { version: 2, at: at(60) } })]);
  const needsYou = [
    need("ask", "app", { sectionKey: "ship" }),
    // Core lists an approval in Needs you itself: counted once, not again from the panel's pending.
    need("approval", "app", { requestId: "r1" }),
    need("executor", "app", { state: "delivering", taskId: "YN-90" }),
    need("question", "app", { turnId: "t", itemId: "i" }),
    need("ask", "docs", { sectionKey: "elsewhere" }),
    need("approval", null, { requestId: "r2" }),
  ];
  for (const p of [app, docs]) {
    const glance = projectGlance(p, needsYou, []);
    assert.deepEqual({ needs: glance.needs, unseen: glance.unseen }, panelCounts(p, needsYou), p.project.id);
  }
  assert.deepEqual(panelCounts(app, needsYou), { needs: 4, unseen: 3 }, "the read's own numbers");
  assert.deepEqual(panelCounts(docs, needsYou), { needs: 1, unseen: 0 });
  // Never below zero, as the panel never showed.
  assert.equal(projectGlance(panel("x", [ask("a", "replied"), ask("b", "replied")], { unseen: 1 }), [], []).unseen, 0);
});

test("a glance says the newest current status a lead wrote, else the latest report's title, else that there is none", () => {
  const sections = [
    status("older", 50),
    status("newer", 5, { body: markdown("Two cards in progress; one design waits for you.") }),
    // Out of date, or written by a member who does not edit Home: never what the project says.
    status("stale", 1, { status: { asOf: at(1), validFor: 60, stale: true } }),
    status("member", 2, { owner: exec }),
    section("report", "report", { updatedAt: at(4) }),
  ];
  const line = projectGlance(panel("app", sections), [], []).line;
  assert.equal(line.kind, "status");
  assert.equal(line.section.key, "newer");
  assert.equal(line.text, "Two cards in progress; one design waits for you.");
  // A project that names no leads: any current status is its own.
  assert.equal(projectGlance(panel("app", sections, { contentEditors: { version: 1, editorAgentIds: null } }), [], []).line.section.key, "member");
  const reports = projectGlance(panel("app", [section("a", "report", { updatedAt: at(9) }), section("b", "report", { updatedAt: at(2) })]), [], []).line;
  assert.deepEqual([reports.kind, reports.section.key], ["report", "b"]);
  assert.equal(projectGlance(panel("app", [ask("only")]), [], []).line, null);
});

test("a glance's facts are Core's: cards in progress, executors as the rail counts them, running Jobs, errors; two recent cards", () => {
  const p = panel("app", [
    ask("ship", "open", { updatedAt: at(1) }),
    ask("plan", "replied", { updatedAt: at(40) }),
    status("dev", 10),
    section("eval", "report", { updatedAt: at(3) }),
    section("read", "report", { seen: { version: 2, at: at(2) }, updatedAt: at(20) }),
  ], {
    jobs: [
      { id: "j1", name: "web tests", status: "running", agentId: "exec", agentName: "YN-90" },
      { id: "j2", name: "build", status: "queued", agentId: "exec", agentName: "YN-90" },
    ],
    errors: [{ agentId: "exec", agentName: "YN-90", message: "exited", at: at(2) }],
  });
  const agents = ["running", "delivering", "queued", "starting", "archived", undefined].map((state) => ({ executor: state ? { state } : null }));
  const glance = projectGlance(p, [], agents);
  // In progress, as the page's group: the current status, the unread report and the Ask waiting on its owner.
  assert.deepEqual(glance.facts, { doing: 3, running: 2, queued: 2, jobs: 1, errors: 1 });
  assert.deepEqual(glance.recent.map((r) => [r.section.key, r.unread]), [["ship", true], ["eval", true]]);
  assert.equal(glance.updatedAt, p.brief.sections[0].updatedAt);
  assert.equal(glance.quiet, false);
  // A card bound to a task is grouped by its task, as the project's page groups it (YN-86 §2.2, §3.4): the read report
  // in progress while its task goes on, the current status done once its task is over.
  const taskOf = (section) => ({ read: "open", dev: "ended" })[section.key] ?? null;
  assert.equal(projectGlance(p, [], agents, taskOf).facts.doing, 3, "one in, one out");
  assert.equal(projectGlance(p, [], agents, () => "ended").facts.doing, 1, "only the Ask waiting on its owner");
});

test("a project with nothing for the user and nothing at work is quiet; a live Job, an executor or a new card is not", () => {
  const read = section("guide", "report", { seen: { version: 2, at: at(60) }, updatedAt: at(3 * 24 * 60) });
  const calm = panel("docs", [read]);
  assert.equal(projectGlance(calm, [], []).quiet, true);
  assert.equal(projectGlance(calm, [], []).updatedAt, read.updatedAt);
  assert.equal(projectGlance(panel("docs", [read], { jobs: [{ id: "j", name: "x", status: "queued", agentId: null, agentName: null }] }), [], []).quiet, false);
  assert.equal(projectGlance(calm, [], [{ executor: { state: "queued" } }]).quiet, false);
  assert.equal(projectGlance(calm, [need("ask", "docs", { sectionKey: "x" })], []).quiet, false);
  assert.equal(projectGlance(panel("docs", [read], { unseen: 1 }), [], []).quiet, false);
  // An executor done with its work is not at work.
  assert.equal(projectGlance(calm, [], [{ executor: { state: "archived" } }]).quiet, true);
  assert.equal(projectGlance(panel("empty", []), [], []).updatedAt, null);
});
