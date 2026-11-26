// A Project's page read by request (YN-212 W1): each request one block with
// one latest fact and one action, each task one row with one card under the
// first request routed to it, and the Project's own block for the rest. The
// joining is pure; the page that draws it is W3's.
import test from "node:test";
import assert from "node:assert/strict";
import {
  askUpFront, authorOf, barCells, blockCounts, blockOfSection, commonTasks, followUpsOf, forYouTodo, isPlaceholder, pageBlocks, projectCardsCount,
  projectLine, relatedRequests, splitLead,
} from "../src/home/request-blocks.ts";
import { summaryOf } from "../src/home/report/report-model.ts";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const lead = { agentId: "lead", name: "Dev Lead", state: "active" };
const lead2 = { agentId: "lead2", name: "Dev Lead 2", state: "active" };
const who = (agentId, name) => ({ agentId, name, kind: "executor", state: "running" });
const x181 = who("x181", "YN-181 · 独立核查");
const x197 = who("x197", "YN-197 · 设计先行");
const x207 = who("x207", "YN-207 · 按批准的设计实现");
const desk = { agentId: "lead", name: "Dev Lead" };

let ids = 900;
function section(key, kind, title, version, minutes, owner, extra = {}) {
  return {
    id: ids++, key, kind, title, version, owner, updatedAt: at(minutes), updatedTurnId: "t",
    body: { root: "body", elements: { body: { type: "BriefBody", props: {} } } },
    attachments: [], refs: {}, seen: null, history: false, ...extra,
  };
}
const binding = (task, status, responsible, extra = {}) => ({ task: { id: task, title: task, status, archived: false }, responsible, ...extra });
const status = (minutes, stale = false) => ({ asOf: at(minutes), validFor: 14_400, stale });
const ask = (question, state, extra = {}) => ({ question, reply: { freeText: true }, state, ...extra });

function routed(s, task, taskStatus, responsible, items = null, reportedAt = 0) {
  return {
    sectionId: s?.id ?? null, key: s?.key ?? null, title: s?.title ?? null, live: !!s && !s.history,
    task: { id: task, status: taskStatus, archived: false }, responsible,
    result: items ? { id: `res-${task}`, status: "review", reportedAt: at(reportedAt) } : null,
    deliverables: items ? { resultId: `res-${task}`, reportedAt: at(reportedAt), items } : null,
  };
}
function request(n, minutes, state, cards, extra = {}) {
  return {
    id: `req-${n}`, n, text: `R-${n} words`, textBlocks: null, images: [], files: [], title: `R-${n}`, createdAt: at(minutes),
    frontAgentId: "lead", messageId: `m${n}`, delivery: "accepted", replies: [],
    notes: [{ note: "好，交给执行者。", by: desk, at: at(minutes - 1) }], routes: [], cards, state,
    progress: { cards: cards.length, ended: cards.filter((c) => c.task.status === "done").length }, lines: [], ...extra,
  };
}
const report = (key, version, sectionId, state = "live") =>
  ({ kind: "report", title: `报告 ${key}`, note: null, key, version, sectionId, state, currentVersion: version });
const pr = (number, state = "merged") =>
  ({ kind: "pr", title: `PR #${number}`, note: null, url: `https://example.com/pull/${number}`, repository: "o/r", number, state, observedAt: at(5) });
const release = (tag) => ({ kind: "release", title: tag, note: null, url: `https://example.com/releases/${tag}`, repository: "o/r", tag });

/** R-7 at one of its five moments (the design's §3.3), as the prototype drew them. */
function r7At(stage) {
  ids = 900;
  const done = stage === "result" || stage === "confirmed";
  const replyMin = stage === "approved" ? 2 : 9;
  const cardMin = done ? 6 : stage === "working" ? 2 : 52;
  const responsible = done ? null : x181;
  const card = section("yn-181", done ? "report" : "status",
    done ? "R-7 · Mac 桌面版 0.7.0 已发布" : stage === "working" ? "正在用 v3 脚本重签：3/5 个文件已签" : "等你决定是否重签",
    done ? 6 : stage === "working" ? 5 : 4, cardMin, lead, {
      author: { agentId: "x181", name: x181.name },
      ...(done ? {} : { status: status(cardMin) }),
      card: binding("YN-181", done ? "done" : "doing", responsible),
      ...(stage === "confirmed" ? { seen: { version: 6, at: at(2) }, history: true, historyReason: "archived" } : {}),
    });
  const question = section("yn-181/sign", "ask", "用 v3 重签？", stage === "asked" ? 1 : 2, stage === "asked" ? 50 : replyMin,
    { agentId: "x181", name: x181.name, state: "active" }, {
      ask: ask("desktop-0.7.0：用 v3 脚本重签一次并发布？", stage === "asked" ? "open" : stage === "approved" ? "replied" : "resolved",
        stage === "asked" ? {} : { repliedAt: at(replyMin), replyText: "批准：用 v3 重签一次并发布" }),
      card: binding("YN-181", done ? "done" : "doing", responsible),
      ...(stage === "asked" ? {} : { seen: { version: 2, at: at(replyMin) } }),
      ...(done ? { history: true, historyReason: "resolved" } : {}),
    });
  const items = done ? [report("yn-181", 6, card.id, stage === "confirmed" ? "history" : "live"), release("desktop-0.7.0"), pr(1077)] : null;
  const r7 = request(7, 2900, done ? (stage === "confirmed" ? "done" : "ended") : "doing", [routed(card, "YN-181", done ? "done" : "doing", responsible, items, 6)], {
    lines: [
      { kind: "ask", sectionId: question.id, key: question.key, title: question.title, state: question.ask.state, at: at(stage === "asked" ? 50 : replyMin), task: "YN-181", cardSectionId: card.id },
      ...(done ? [{ kind: "done", task: "YN-181", status: "done", at: at(6), cardSectionId: card.id, title: card.title }] : []),
    ],
    ...(stage === "confirmed" ? { confirmedAt: at(2) } : {}),
  });
  return { r7, sections: [card, question] };
}

/** The rest of the screenshots' page: R-19 (two tasks, cards from before one card a task), R-12 joined by R-14,
 * R-21 just said, the Project's own statuses. */
function neighbours() {
  const design = section("yn-205", "report", "Job 输入检查设计", 3, 260, lead, {
    author: { agentId: "x205", name: "YN-205 · 设计" }, seen: { version: 3, at: at(200) }, card: binding("YN-205", "done", null),
  });
  const placeholder = section("yn-207", "status", "按批准的设计实现 Job 输入检查", 1, 240, lead2, {
    status: { asOf: at(240), validFor: 31_536_000, stale: false }, card: binding("YN-207", "doing", x207, { placeholder: true }),
  });
  const slices = section("yn-207/slices", "status", "两个切片已写出，第一片正在补兼容性修复", 3, 31,
    { agentId: "x207", name: x207.name, state: "active" }, { status: status(31), card: binding("YN-207", "doing", x207) });
  const old = section("yn-207/lead", "status", "等你决定是否实施", 2, 252, lead2, { status: status(252), card: binding("YN-207", "doing", x207) });
  const decided = section("yn-207/ask", "ask", "是否实施？", 2, 250, lead, {
    ask: ask("Job 输入检查设计完成，是否实施？", "resolved", { repliedAt: at(255), replyText: "按设计实施两个切片" }),
    seen: { version: 2, at: at(250) }, card: binding("YN-207", "doing", x207),
  });
  const r19 = request(19, 1600, "doing", [
    routed(design, "YN-205", "done", null, [report("yn-205", 3, design.id)], 260),
    routed(slices, "YN-207", "doing", x207, [pr(1082, "open")], 40),
  ], { lines: [{ kind: "done", task: "YN-205", status: "done", at: at(258), cardSectionId: design.id, title: design.title }] });
  const cpu = section("yn-197", "status", "Core CPU 调查 · 阶段对照完成，根因未定", 7, 330, lead, {
    author: { agentId: "x197", name: x197.name }, status: status(330, true), seen: { version: 7, at: at(300) }, card: binding("YN-197", "doing", x197),
  });
  const r12 = request(12, 2000, "doing", [routed(cpu, "YN-197", "doing", x197)]);
  const r14 = request(14, 1440, "doing", [routed(cpu, "YN-197", "doing", x197)], {
    notes: [{ note: "这和 R-12 是同一项调查，并进 YN-197。", by: desk, at: at(1430) }],
  });
  const r21 = request(21, 1, "waiting", [], { notes: [], title: null });
  const overview = section("development", "status", "开发状态", 12, 75, lead, { status: status(75) });
  const checklist = section("desktop-check", "status", "桌面 0.6.0 待你有空实测", 3, 1200, lead, { status: status(1200) });
  return { requests: [r21, r19, r14, r12], sections: [design, placeholder, slices, old, decided, cpu, overview, checklist] };
}

function page(stage) {
  const { r7, sections } = r7At(stage);
  const rest = neighbours();
  return pageBlocks([...rest.requests.slice(0, 3), r7, rest.requests[3]].sort((a, b) => b.n - a.n), [...sections, ...rest.sections]);
}
const block = (blocks, n) => blocks.find((b) => b.request.n === n);

test("R-7's five moments: one block each time, its fact, action and group from Core's facts (§3.3)", () => {
  const expected = {
    // Its own open Ask is shown in the block, to answer there (W5): no Answer leads to it.
    asked: { group: "needs", kind: "ask", action: null },
    approved: { group: "doing", kind: "replied", action: "follow" },
    working: { group: "doing", kind: "card", action: "follow" },
    result: { group: "needs", kind: "result", action: "confirm" },
    confirmed: { group: "done", kind: "result", action: null },
  };
  for (const [stage, want] of Object.entries(expected)) {
    const { blocks } = page(stage);
    assert.equal(blocks.filter((b) => b.request.n === 7).length, 1, stage);
    const r7 = block(blocks, 7);
    assert.deepEqual({ group: r7.group, kind: r7.fact.kind, action: r7.action }, want, stage);
    assert.equal(r7.tasks.length, 1, `${stage}: YN-181 is shown under R-7`);
    assert.deepEqual(r7.joined, []);
    assert.equal(blocks.flatMap((b) => b.tasks).filter((row) => row.task.id === "YN-181").length, 1, `${stage}: one task, one row`);
  }
  const asked = block(page("asked").blocks, 7).fact;
  assert.deepEqual([asked.title, asked.key, asked.count, asked.task, asked.home], ["desktop-0.7.0：用 v3 脚本重签一次并发布？", "yn-181/sign", 1, "YN-181", null]);
  const shown = page("asked");
  assert.deepEqual(block(shown.blocks, 7).asks.map((s) => s.key), ["yn-181/sign"], "the block holds its task's Ask");
  assert.equal(askUpFront("yn-181/sign", shown.blocks, shown.project), true, "a jump to it opens nothing");
  assert.equal(askUpFront("yn-181", shown.blocks, shown.project), false, "a card is no Ask");
  // Answered, it is no longer open: the page keeps it where it was for the visit (ProjectHome), the model says so.
  const replied = page("approved");
  assert.deepEqual(block(replied.blocks, 7).asks.map((s) => [s.key, s.ask?.state]), [["yn-181/sign", "replied"]]);
  assert.equal(askUpFront("yn-181/sign", replied.blocks, replied.project), false);
  // Just answered: the reply, not the card that still asks, until the card is written again.
  const approved = block(page("approved").blocks, 7);
  assert.deepEqual([approved.fact.reply, approved.fact.who?.agentId, approved.fact.taken], ["批准：用 v3 重签一次并发布", "x181", false]);
  assert.equal(approved.tasks[0].cardBeforeReply, true, "the card was written before the reply");
  const working = block(page("working").blocks, 7);
  assert.deepEqual([working.fact.title, working.fact.author], ["正在用 v3 脚本重签：3/5 个文件已签", "YN-181 · 独立核查"]);
  assert.equal(working.tasks[0].cardBeforeReply, false);
  const result = block(page("result").blocks, 7);
  assert.deepEqual([result.fact.count, result.fact.task, result.fact.ended, result.fact.going], [3, "YN-181", true, 0]);
  assert.deepEqual(result.delivered.map((d) => [d.task, d.items.map((i) => i.kind)]), [["YN-181", ["report", "release", "pr"]]]);
  // Confirmed: in Done; its archived report is still its task's card, to open by version.
  const confirmed = block(page("confirmed").blocks, 7);
  assert.equal(confirmed.tasks[0].card?.key, "yn-181");
  assert.equal(confirmed.unread, false, "history is not news");
  const groups = page("confirmed").blocks.map((b) => b.group);
  assert.deepEqual(groups, [...groups].sort((a, b) => ["needs", "doing", "done"].indexOf(a) - ["needs", "doing", "done"].indexOf(b)), "grouped in order");
});

test("each request is one block, and the order is needs you, then in progress newest first, then done", () => {
  const { blocks, project } = page("asked");
  assert.deepEqual(blocks.map((b) => b.request.n).sort((a, b) => a - b), [7, 12, 14, 19, 21]);
  assert.deepEqual(blocks.map((b) => [b.request.n, b.group]), [[7, "needs"], [21, "doing"], [19, "doing"], [14, "doing"], [12, "doing"]]);
  assert.ok(project.sections.length > 0, "the Project has cards of its own");
  // R-27 §3.7: requests only; the Project's own block is no request.
  assert.deepEqual(blockCounts(blocks), { needs: 1, doing: 4, done: 0 }, "the Project's own block is not counted");
});

test("a task serving two requests is one row under the first; the other names it and shares its fact (R-12, R-14)", () => {
  const { blocks } = page("working");
  const r12 = block(blocks, 12);
  const r14 = block(blocks, 14);
  assert.deepEqual(r12.tasks.map((row) => [row.task.id, row.home, row.alsoFor]), [["YN-197", 12, [14]]]);
  assert.deepEqual(r12.joined, []);
  assert.deepEqual(r14.tasks, []);
  assert.deepEqual(r14.joined.map((row) => [row.task.id, row.home, row.title]), [["YN-197", 12, "Core CPU 调查 · 阶段对照完成，根因未定"]]);
  for (const b of [r12, r14]) {
    assert.deepEqual([b.fact.kind, b.fact.task, b.fact.author, b.fact.stale], ["card", "YN-197", "YN-197 · 设计先行", true], `R-${b.request.n}`);
  }
  assert.equal(blockOfSection("yn-197", blocks, null), "r12", "a link to the card opens the block it is shown in");
});

// W5: an open Ask of a task two requests share is shown once, in the block of the request it is under; the other
// request says where, and its action goes there.
test("an Ask of a task two requests share is in the first one's block once; the other points to it (R-12, R-14)", () => {
  const { r7, sections } = r7At("working");
  const rest = neighbours();
  const question = section("yn-197/scope", "ask", "范围", 1, 3, lead, { ask: ask("只查 Core 吗？", "open"), card: binding("YN-197", "doing", x197) });
  const { blocks, project } = pageBlocks([...rest.requests, r7], [...sections, ...rest.sections, question]);
  const r12 = block(blocks, 12);
  const r14 = block(blocks, 14);
  assert.deepEqual([r12.fact.kind, r12.fact.home, r12.action, r12.group], ["ask", null, null, "needs"]);
  assert.deepEqual(r12.asks.map((s) => s.key), ["yn-197/scope"]);
  assert.equal(r12.askedElsewhere, null);
  // R-38 §2.4: the Ask counts in Needs you once, under R-12; R-14 stays in progress and points to it.
  assert.deepEqual([r14.fact.kind, r14.fact.home, r14.fact.key, r14.action, r14.group], ["ask", 12, "yn-197/scope", "answer", "doing"]);
  assert.deepEqual(r14.next, { kind: "elsewhere", task: "YN-197", home: 12, title: "只查 Core 吗？" });
  assert.deepEqual([r12.state, r12.next], ["decide", { kind: "ask" }]);
  assert.deepEqual(blockCounts(blocks).needs, blocks.filter((b) => b.group === "needs").length);
  assert.deepEqual(r14.asks, [], "not drawn twice");
  assert.deepEqual(r14.askedElsewhere, { home: 12, key: "yn-197/scope", title: "只查 Core 吗？", count: 1 });
  assert.equal(blocks.flatMap((b) => b.asks).filter((s) => s.key === "yn-197/scope").length, 1, "one Ask, one block");
  assert.equal(askUpFront("yn-197/scope", blocks, project), true);
});

test("two tasks, two deliverables, the newest result first; a card written since outranks the result (R-19)", () => {
  const { blocks } = page("working");
  const r19 = block(blocks, 19);
  assert.deepEqual(r19.delivered.map((d) => [d.task, d.items.map((i) => i.kind)]), [["YN-207", ["pr"]], ["YN-205", ["report"]]]);
  assert.deepEqual([r19.fact.kind, r19.fact.task, r19.fact.title], ["card", "YN-207", "两个切片已写出，第一片正在补兼容性修复"]);
  assert.deepEqual(r19.tasks.map((row) => row.task.id), ["YN-205", "YN-207"]);
  // A card from before one card a task (a lead's second status) folds under the one card; a placeholder is no card.
  const yn207 = r19.tasks.find((row) => row.task.id === "YN-207");
  assert.equal(yn207.card.key, "yn-207/slices");
  assert.deepEqual(yn207.earlier.map((s) => s.key), ["yn-207/lead"]);
  assert.equal(yn207.placeholder?.key, "yn-207");
  assert.deepEqual(yn207.asks.map((s) => s.key), ["yn-207/ask"]);
  assert.equal(yn207.cardBeforeReply, false, "the card is newer than the reply");
});

test("the Project's own block: every live section bound to no request's task, never a placeholder", () => {
  const { blocks, project } = page("working");
  assert.deepEqual(project.sections.map((s) => s.key), ["development", "desktop-check"]);
  assert.deepEqual(project.asks, []);
  assert.equal("group" in project, false, "in no group of requests (R-27)");
  assert.equal(blockOfSection("development", blocks, project), "project");
  // An open Ask of its own is shown up front (in Needs you, R-27 §3.5): a jump to it opens nothing.
  const pick = section("pick", "ask", "选一个", 1, 3, lead, { ask: ask("选哪个？", "open") });
  const withAsk = pageBlocks([], [pick, ...neighbours().sections.slice(-2)]).project;
  assert.deepEqual(withAsk.asks.map((s) => s.key), ["pick"]);
  assert.equal(askUpFront("pick", [], withAsk), true, "its open Ask is up front");
  assert.equal(blockOfSection("pick", [], withAsk), "project");
  assert.equal(pageBlocks([], []).project, null);
  // A section bound to a task no request has is the Project's too; a history entry is not.
  const loose = section("yn-300", "status", "无请求的任务", 1, 4, lead, { card: binding("YN-300", "doing", null) });
  const gone = section("old", "report", "已看过", 1, 4, lead, { history: true, historyReason: "seen" });
  assert.deepEqual(pageBlocks([], [loose, gone]).project.sections.map((s) => s.key), ["yn-300"]);
});

test("the facts of the design's §3.2 table, row by row", () => {
  ids = 1;
  const card = (minutes, extra = {}) => section("yn-1", "status", "卡片标题", 2, minutes, lead, { status: status(minutes), card: binding("YN-1", "doing", x207), ...extra });
  const one = (req, sections = []) => pageBlocks([req], sections).blocks[0];

  // 1. Not confirmed delivered: send again, before an open Ask.
  const open = section("yn-1/ask", "ask", "Q", 1, 5, lead, { ask: ask("要哪个？", "open"), card: binding("YN-1", "doing", x207) });
  for (const delivery of [null, "failed", "unknown"]) {
    const b = one(request(1, 10, "doing", [routed(card(8), "YN-1", "doing", x207)], { delivery }), [card(8), open]);
    assert.deepEqual([b.fact.kind, b.action, b.group], ["unconfirmed", "resend", "needs"], String(delivery));
  }
  assert.equal(one(request(1, 10, "doing", [], { delivery: "queued" })).fact.kind, "waiting", "queued is delivered");

  // 2. An open Ask: the oldest, with how many more. Shown in the block, each to answer there (W5): no action.
  const later = section("yn-1/more", "ask", "Q2", 1, 2, lead, { ask: ask("还有一个？", "open"), card: binding("YN-1", "doing", x207) });
  const asked = one(request(1, 10, "doing", [routed(card(8), "YN-1", "doing", x207)]), [card(8), later, open]);
  assert.deepEqual([asked.fact.kind, asked.fact.title, asked.fact.count, asked.action, asked.group], ["ask", "要哪个？", 2, null, "needs"]);
  assert.deepEqual(asked.asks.map((s) => s.key), ["yn-1/ask", "yn-1/more"], "each Ask, in the order they were put");
  assert.equal(blockOfSection("yn-1/more", [asked], null), "r1");
  assert.equal(askUpFront("yn-1/more", [asked], null), true, "a jump to an Ask lands on it in the first look");
  // A newer version of the first Ask moves neither: they stay in the order they were put.
  const rewritten = { ...open, version: 2, updatedAt: at(1) };
  assert.deepEqual(one(request(1, 10, "doing", [routed(card(8), "YN-1", "doing", x207)]), [card(8), later, rewritten]).asks.map((s) => s.key),
    ["yn-1/ask", "yn-1/more"]);

  // 3. Answered by the front desk: its answer, confirm done.
  const answered = one(request(1, 10, "answered", [], { notes: [{ note: "已经支持了。", by: desk, at: at(3) }] }));
  assert.deepEqual([answered.fact.kind, answered.fact.text, answered.action, answered.group], ["answered", "已经支持了。", "confirm", "needs"]);

  // 4. Delivered: confirm done once every task ended, else follow up, with how many go on.
  const two = [routed(null, "YN-1", "done", null, [pr(1), pr(2)], 4), routed(card(9), "YN-2", "doing", x207)];
  const going = one(request(1, 10, "doing", two), [card(9, { key: "yn-2", card: binding("YN-2", "doing", x207) })]);
  assert.deepEqual([going.fact.kind, going.fact.count, going.fact.ended, going.fact.going, going.action], ["result", 2, true, 1, "follow"]);
  const finished = one(request(1, 10, "ended", [routed(null, "YN-1", "done", null, [pr(1)], 4)]));
  assert.deepEqual([finished.fact.kind, finished.action, finished.group], ["result", "confirm", "needs"]);

  // 5. Ended with nothing to open: confirm done.
  const ended = one(request(1, 10, "ended", [routed(null, "YN-1", "cancelled", null)], {
    lines: [{ kind: "done", task: "YN-1", status: "cancelled", at: at(4), cardSectionId: null, title: null }],
  }));
  assert.deepEqual([ended.fact.kind, ended.fact.task, ended.fact.status, ended.action, ended.group], ["ended", "YN-1", "cancelled", "confirm", "needs"]);

  // 6. No task yet: the front desk's newest note, or none.
  assert.deepEqual(one(request(1, 10, "waiting", [])).fact.note, "好，交给执行者。");
  const fresh = one(request(1, 10, "waiting", [], { notes: [] }));
  assert.deepEqual([fresh.fact.kind, fresh.fact.note, fresh.action, fresh.group], ["waiting", null, "follow", "doing"]);

  // 7. In progress: the reply when newer than the card, the card when newer, else whom it went to.
  const replied = (minutes, state) => section("yn-1/ask", "ask", "Q", 2, minutes, lead, {
    ask: ask("要哪个？", state, { repliedAt: at(minutes), replyText: "左边" }), card: binding("YN-1", "doing", x207),
  });
  const req = () => request(1, 60, "doing", [routed(card(20), "YN-1", "doing", x207)]);
  const reply = one(req(), [card(20), replied(10, "replied")]);
  assert.deepEqual([reply.fact.kind, reply.fact.reply, reply.fact.taken], ["replied", "左边", false]);
  assert.equal(one(req(), [card(20), replied(10, "resolved")]).fact.taken, true, "its lead took the reply in");
  const newer = one(req(), [card(5), replied(10, "resolved")]);
  assert.deepEqual([newer.fact.kind, newer.fact.title, newer.fact.author, newer.fact.stale], ["card", "卡片标题", "Dev Lead", false]);
  const none = one(request(1, 60, "doing", [routed(null, "YN-1", "doing", x207)], {
    routes: [{ kind: "card", index: 0, request: 1, at: at(50), state: "done", why: "", by: desk, to: desk, task: "YN-1", cardKey: "yn-1", sectionId: null }],
  }));
  assert.deepEqual([none.fact.kind, none.fact.who.agentId, none.fact.at], ["working", "x207", at(50)]);
  // The newest of several tasks going on.
  const both = one(request(1, 60, "doing", [routed(null, "YN-1", "doing", x207), routed(null, "YN-2", "doing", x181)]), [
    card(30), card(6, { key: "yn-2", title: "第二个", card: binding("YN-2", "doing", x181) }),
  ]);
  assert.deepEqual([both.fact.task, both.fact.title], ["YN-2", "第二个"]);
});

test("an older Core: no author, no placeholder mark, no deliverables, no section identity", () => {
  ids = 1;
  const strip = ({ id, author, ...rest }) => rest;
  const placeholder = strip(section("yn-1", "status", "→ 执行者: 原因", 1, 40, lead, { status: status(40), card: binding("YN-1", "doing", x207) }));
  const sub = strip(section("yn-1/result", "status", "执行者写的", 2, 10, { agentId: "x207", name: x207.name, state: "active" },
    { status: status(10), card: binding("YN-1", "doing", x207) }));
  const req = request(1, 60, "doing", [{ ...routed(placeholder, "YN-1", "doing", x207), result: undefined, deliverables: undefined }]);
  const { blocks } = pageBlocks([req], [placeholder, sub, { ...sub }]);
  const row = blocks[0].tasks[0];
  assert.equal(isPlaceholder(placeholder), false, "unmarked, so shown as a card");
  assert.deepEqual([row.card.key, row.earlier.map((s) => s.key), row.placeholder], ["yn-1/result", ["yn-1"], null]);
  assert.deepEqual(blocks[0].delivered, []);
  assert.deepEqual([blocks[0].fact.kind, blocks[0].fact.author], ["card", "YN-207 · 按批准的设计实现"]);
  assert.equal(authorOf(placeholder), "Dev Lead", "who wrote it is its owner");
  assert.equal(authorOf({ ...placeholder, author: { agentId: "x", name: "Writer" } }), "Writer");
});

test("a task's card and Ask kept live and in history count once, the live one first", () => {
  ids = 1;
  const live = section("yn-1", "status", "现在", 3, 5, lead, { status: status(5), card: binding("YN-1", "doing", x207) });
  const past = { ...live, version: 2, title: "以前", history: true, historyReason: "seen" };
  const removed = section("yn-1/gone", "report", "删掉的", 1, 1, lead, { history: true, historyReason: "removed", card: binding("YN-1", "doing", x207) });
  const { blocks } = pageBlocks([request(1, 60, "doing", [routed(live, "YN-1", "doing", x207)])], [past, live, removed]);
  const row = blocks[0].tasks[0];
  assert.deepEqual([row.card.title, row.earlier.length], ["现在", 0], "a removed section is no card of the task");
  assert.equal(blocks[0].unread, true, "changed since seen");
});

// R-27 §3.1: the card the project's page leads with. Only a lead's cards of no task; the newest status, stale or not,
// else the newest report; the first of two written at once; any member's when the project names no leads.
test("the banner's card: a lead's newest status of no task, stale or not, else its newest report", () => {
  ids = 2000;
  const older = section("week", "status", "This week", 1, 30, lead, { status: status(30) });
  const stale = section("development", "status", "开发状态", 1, 10, lead, { status: status(10, true) });
  const bound = section("yn-300", "status", "绑任务的卡", 1, 1, lead, { card: binding("YN-300", "doing", null), status: status(1) });
  const other = section("notes", "status", "成员的卡", 1, 2, lead2, { status: status(2) });
  const newer = section("summary", "report", "周报", 1, 0, lead);
  assert.equal(projectLine([older, stale, bound, other, newer], ["lead"])?.key, "development", "a status before a report; stale, still it");
  assert.equal(projectLine([older, bound, other, newer], ["lead"])?.key, "week");
  assert.equal(projectLine([bound, other, newer], ["lead"])?.key, "summary", "no status of a lead's: its newest report");
  assert.equal(projectLine([bound, newer], ["lead2"]), null, "nothing a lead wrote");
  assert.equal(projectLine([other, older], null)?.key, "notes", "no leads named: any member's, the newest");
  const twin = section("twin", "status", "同时写的", 1, 30, lead, { status: status(30) });
  assert.equal(projectLine([older, twin], ["lead"])?.key, "week", "the first of two written at the same time");
  assert.equal(projectLine([], null), null);
});

// R-27 §3.2: the heading is the lead's bold opening, else its first sentence, else all of it, as plain text.
test("the banner's heading: a bold opening, else the first sentence, else the whole lead", () => {
  assert.deepEqual(splitLead("**core.38 已安装，新版项目首页已启用。** 项目页正在修复长对话。"), { head: "core.38 已安装，新版项目首页已启用。", rest: "项目页正在修复长对话。" });
  assert.deepEqual(splitLead("core.38 已安装。项目页正在修复长对话。"), { head: "core.38 已安装。", rest: "项目页正在修复长对话。" }, "a full stop inside a version is no sentence's end");
  assert.deepEqual(splitLead("Two cards run. One waits for `you`."), { head: "Two cards run.", rest: "One waits for `you`." }, "the rest stays Markdown");
  assert.deepEqual(splitLead("Ready? Ship it"), { head: "Ready?", rest: "Ship it" });
  assert.deepEqual(splitLead("The [release](https://example.com/r) is out"), { head: "The release is out", rest: null }, "no sentence's end: all of it, plain");
  assert.deepEqual(splitLead("Done."), { head: "Done.", rest: null });
  assert.equal(splitLead(""), null);
  assert.equal(splitLead(null), null);
});

/** A status whose summary names `forYou` (R-27 §3.3). */
function withForYou(items, { title = "桌面0.6.0待你有空实测", type = "Checklist", slot = "todo" } = {}) {
  return section("development", "status", "开发状态", 2, 5, lead, {
    status: status(5),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", forYou: slot, size: "wide" } }, children: ["lead", "todo", "mine"] },
      lead: { type: "Markdown", props: { text: "**core.38 已安装。** 其余在做。" } },
      todo: type === "Checklist" ? { type: "Checklist", props: { title, items } } : { type: "Plan", props: { steps: items.map((i) => ({ id: i.id, text: i.text, state: "todo" })) } },
      mine: { type: "Checklist", props: { items: [{ id: "self", text: "Agent 自己的待办", done: false }] } },
    } },
  });
}

test("what the user is asked to do: only the Checklist the author names forYou, its open items in order", () => {
  const items = [
    { id: "a", text: "在 0.5.0 里检查更新", done: false }, { id: "b", text: "已做完的", done: true },
    { id: "c", text: "拖文件进输入框", done: false }, { id: "d", text: "第三项", done: false },
  ];
  assert.deepEqual(forYouTodo(withForYou(items)), {
    title: "桌面0.6.0待你有空实测", open: 3,
    items: [{ id: "a", text: "在 0.5.0 里检查更新" }, { id: "c", text: "拖文件进输入框" }, { id: "d", text: "第三项" }],
  });
  assert.equal(summaryOf(withForYou(items))?.forYou, "todo");
  assert.equal(forYouTodo(withForYou(items, { title: "" }))?.title, null, "no title: none");
  assert.equal(forYouTodo(withForYou(items.map((i) => ({ ...i, done: true })))), null, "every item done: nothing for the user");
  assert.equal(forYouTodo(withForYou(items, { type: "Plan" })), null, "a Plan named forYou is taken as none");
  assert.equal(summaryOf(withForYou(items, { type: "Plan" }))?.lead, "lead", "and the summary still holds");
  assert.equal(forYouTodo(withForYou(items, { slot: "lead" })), null, "the lead's block is no forYou");
  // No forYou named: an Agent's own Checklist on the card is never the user's.
  const plain = withForYou(items);
  delete plain.body.elements.body.props.summary.forYou;
  assert.equal(forYouTodo(plain), null);
  assert.equal(summaryOf(plain)?.forYou, null);
  assert.equal(forYouTodo(section("x", "status", "No body", 1, 1, lead)), null);
});

// R-27 §3.6: the group holds the Project's cards, the banner's among them, and its Asks answered before this visit;
// with only the banner's card, no group: the banner is that card's one place (the lead's call, seq 12072).
test("the Project cards group's count: its cards and answered Asks, none when only the banner's card is there", () => {
  ids = 2100;
  const dev = section("development", "status", "开发状态", 1, 5, lead, { status: status(5) });
  const notes = section("notes", "report", "Notes", 1, 9, lead);
  const block = (sections) => ({ kind: "project", key: "project", sections, asks: [], unread: false, last: 0 });
  assert.equal(projectCardsCount(block([dev, notes]), 0, dev), 2, "both: the banner's card is in the group too");
  assert.equal(projectCardsCount(block([dev]), 0, dev), 0, "only the banner's: no group");
  assert.equal(projectCardsCount(block([dev]), 1, dev), 2, "and an answered Ask: a group of both");
  assert.equal(projectCardsCount(block([dev]), 0, null), 1, "no banner: every card is the group's");
  assert.equal(projectCardsCount(null, 0, null), 0);
});

// R-38: a request's status label, its bar of outcomes, its one next step, and what its evidence counts.
const x227 = who("x227", "YN-227 · 按批准的设计实现");
const pull = (number, installed, state = "merged", repository = "o/r") =>
  ({ number, title: `[YN-227] #${number}`, url: `https://example.com/${repository}/pull/${number}`, repository, state,
    mergedAt: state === "merged" ? at(20) : null, installed });
/** A card of `task` whose summary names its Plan of `steps` as the task's progress. */
function planCard(key, task, steps, minutes, extra = {}) {
  return section(key, "status", `${task} 进展`, 2, minutes, lead, {
    status: status(minutes), card: binding(task, "doing", x227),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", progress: "plan", size: "wide" } }, children: ["lead", "plan"] },
      lead: { type: "Markdown", props: { text: "进展。" } },
      plan: { type: "Plan", props: { steps } },
    } },
    ...extra,
  });
}
/** A card's route with its task's progress, blocker and PRs (S2), as Core reads them. */
function withTask(card, { progress = null, progressAt = undefined, blocker = null, prs = [] } = {}) {
  return { ...card, task: { ...card.task, progress, ...(progressAt === undefined ? {} : { progressAt }), blocker }, prs: { items: prs } };
}
const R38_STEPS = [
  { id: "s1", text: "S1 契约 — summary.progress 与步骤 prs", state: "done", prs: [1121] },
  { id: "s2", text: "S2 Core — 任务进度与安装核实", state: "doing", prs: [1122] },
  { id: "s3", text: "S3 网页模型", state: "todo" },
];

test("R-38 a request whose design is final and whose implementation goes on: in progress, its bar by outcome", () => {
  ids = 900;
  // The design delivered its report, which stays as evidence; the same task now implements, its card naming the Plan.
  const card = planCard("yn-227", "YN-227", R38_STEPS, 3);
  const design = { kind: "report", title: "R-38 · 请求卡定稿", note: null, key: "yn-227", version: 6, sectionId: 619, state: "history", currentVersion: 7 };
  const r38 = request(38, 300, "doing", [withTask(routed(card, "YN-227", "doing", x227, [design], 60),
    { progress: "① 分段成果条已定稿，正在实施。S1 等 CI。", prs: [pull(1121, false), pull(1122, null, "open")] })]);
  const b = block(pageBlocks([r38], [card]).blocks, 38);
  assert.deepEqual([b.state, b.group], ["team", "doing"], "a design delivered is no request done");
  assert.equal(b.now.kind, "bar");
  assert.deepEqual(b.now.segments.map((s) => [s.name, s.detail, s.state, s.asking]), [
    ["S1 契约", "summary.progress 与步骤 prs", "merged", false], ["S2 Core", "任务进度与安装核实", "doing", false], ["S3 网页模型", null, "todo", false]]);
  assert.deepEqual([b.now.done, b.now.total, b.now.available, b.now.merged], [1, 3, 0, 1], "done 1/3: merged, install not verified");
  assert.deepEqual(b.next, { kind: "step", text: "S2 Core", task: "YN-227", who: x227 });
  assert.deepEqual(b.details.got.map((i) => i.name), ["S1 契约"]);
  assert.deepEqual(b.details.left.map((i) => [i.name, i.state]), [["S2 Core", "doing"], ["S3 网页模型", "todo"]]);
  assert.deepEqual([b.evidence.installed.length, b.evidence.pending.map((p) => p.number), b.evidence.open.map((p) => p.number)], [0, [1121], [1122]]);
  assert.equal(b.stale, null, "the card is newer than every fact Core knows");

  // Once Core keeps that #1121 is in the release, S1 is usable: 1 of 3.
  const installed = request(38, 300, "doing", [withTask(routed(card, "YN-227", "doing", x227), { prs: [pull(1121, true), pull(1122, null, "open")] })]);
  const now = block(pageBlocks([installed], [card]).blocks, 38).now;
  assert.deepEqual([now.done, now.available, now.merged, now.segments[0].state], [1, 1, 0, "available"]);
  assert.deepEqual(now.segments[0].facts.map((f) => [f.number, f.kind, f.pr?.installed]), [[1121, "linked", true]]);
  // Done by its author, but a PR it names is not one merged PR its task links: done as marked, with what is known.
  const facts = (prs, steps = [{ ...R38_STEPS[0], prs: [1121, 1124] }]) => {
    const marked = planCard("yn-227", "YN-227", steps, 3);
    const req = request(38, 300, "doing", [withTask(routed(marked, "YN-227", "doing", x227), { prs })]);
    return block(pageBlocks([req], [marked]).blocks, 38).now.segments[0];
  };
  const mixed = facts([pull(1121, true), pull(1124, null, "draft")]);
  assert.deepEqual([mixed.state, mixed.facts.map((f) => [f.number, f.kind, f.pr?.state])], ["done", [[1121, "linked", "merged"], [1124, "linked", "draft"]]],
    "a merged PR and a draft: neither merged nor usable as a whole");
  const missing = facts([pull(1121, true)]);
  assert.deepEqual([missing.state, missing.facts.map((f) => [f.number, f.kind])], ["done", [[1121, "linked"], [1124, "unlinked"]]], "a PR its task does not link");
  const twice = facts([pull(1121, true), pull(1121, true, "merged", "o/other")], [R38_STEPS[0]]);
  assert.deepEqual([twice.state, twice.facts.map((f) => f.kind)], ["done", ["ambiguous"]], "a number two linked PRs share");
  // The user's confirmation is asked only once the task itself ended.
  const ended = request(38, 300, "ended", [withTask(routed(card, "YN-227", "done", null), {})]);
  const settled = block(pageBlocks([ended], [card]).blocks, 38);
  assert.deepEqual([settled.state, settled.next, settled.group], ["accept", { kind: "accept" }, "needs"]);
});

test("R-38 the progress card may be an Ask (R-31); without a Plan, the task's own progress, its first sentence", () => {
  ids = 900;
  // R-31: the task's only card is an answered Ask; its summary names the Plan of six outcomes.
  const asked = planCard("yn-221", "YN-221", [{ id: "a", text: "静态资源缓存与压缩", state: "done", prs: [1105] },
    { id: "b", text: "定位 Core CPU — 等含分步计量的版本安装", state: "blocked" }], 40, {
    kind: "ask", status: undefined, ask: ask("这轮做哪些运行改进？", "replied", { repliedAt: at(39), replyText: "6 项都做" }) });
  const r31 = request(31, 900, "doing", [withTask(routed(asked, "YN-221", "doing", lead), { prs: [pull(1105, true)] })]);
  const b = block(pageBlocks([r31], [asked]).blocks, 31);
  assert.deepEqual(b.now.segments.map((s) => s.state), ["available", "blocked"]);
  assert.deepEqual([b.now.done, b.now.total, b.now.available], [1, 2, 1]);
  assert.equal(b.evidence.answered, 1);
  // No card names a Plan: the first sentence of the task's progress, never a card's title.
  const plain = section("yn-228", "status", "某张卡的标题", 2, 10, lead, { status: status(10), card: binding("YN-228", "doing", x227) });
  const r40 = request(40, 60, "doing", [withTask(routed(plain, "YN-228", "doing", x227), { progress: "查明了两个原因。第三个还在查。" })]);
  const own = block(pageBlocks([r40], [plain]).blocks, 40);
  assert.deepEqual([own.now, own.details, own.next], [{ kind: "progress", text: "查明了两个原因。", task: "YN-228" }, null, null]);
  // Neither: no progress is guessed.
  const r41 = request(41, 60, "doing", [withTask(routed(plain, "YN-228", "doing", x227))]);
  assert.equal(block(pageBlocks([r41], [plain]).blocks, 41).now, null);
});

test("R-38 §2.2 Details list the hand-offs its lead planned after the outcomes, from the card's relay Plan only", () => {
  ids = 900;
  const relayed = (relaySteps, minutes = 3) => {
    const card = planCard("yn-221", "YN-221", [{ id: "a", text: "静态资源缓存与压缩", state: "done" }, { id: "b", text: "定位 Core CPU", state: "blocked" }], minutes);
    card.body.elements.body.props.summary.relay = "next";
    card.body.elements.body.children.push("next");
    card.body.elements.next = { type: "Plan", props: { title: "之后", steps: relaySteps } };
    return card;
  };
  // R-31: a release, then the user's install, then a re-check: the steps not done, in order; the user's step is words.
  const card = relayed([{ id: "r", text: "版本发布", state: "doing" }, { id: "i", text: "你安装", state: "todo" },
    { id: "c", text: "YN-221 复测", state: "todo" }, { id: "w", text: "写测量方法", state: "done" }]);
  const r31 = request(31, 900, "doing", [withTask(routed(card, "YN-221", "doing", lead))]);
  const b = block(pageBlocks([r31], [card]).blocks, 31);
  assert.deepEqual(b.details.relay, [{ task: "YN-221", text: "版本发布", state: "doing" }, { task: "YN-221", text: "你安装", state: "todo" },
    { task: "YN-221", text: "YN-221 复测", state: "todo" }]);
  assert.equal(b.group, "doing", "a planned step of the user's is no to-do");
  assert.deepEqual(b.next, null, "nor its next step: none of the outcomes is in progress");
  // No relay Plan, or every step done: nothing planned to show.
  const none = planCard("yn-221", "YN-221", [{ id: "a", text: "x", state: "doing" }], 3);
  assert.deepEqual(block(pageBlocks([request(31, 900, "doing", [withTask(routed(none, "YN-221", "doing", lead))])], [none]).blocks, 31).details.relay, []);
  const finished = relayed([{ id: "r", text: "版本发布", state: "done" }]);
  assert.deepEqual(block(pageBlocks([request(31, 900, "doing", [withTask(routed(finished, "YN-221", "doing", lead))])], [finished]).blocks, 31).details.relay, []);
  // A relay named by no progress Plan's card shows no Details at all (§2.2: Details only with a Plan of outcomes).
  const alone = relayed([{ id: "r", text: "版本发布", state: "todo" }]);
  alone.body.elements.body.props.summary.progress = undefined;
  delete alone.body.elements.body.props.summary.progress;
  assert.equal(block(pageBlocks([request(31, 900, "doing", [withTask(routed(alone, "YN-221", "doing", lead))])], [alone]).blocks, 31).details, null);
});

test("R-38 the status label: the first that holds, in order", () => {
  ids = 900;
  const card = section("yn-230", "status", "进行中", 2, 10, lead, { status: status(10), card: binding("YN-230", "doing", x227) });
  const label = (req, sections = [card]) => block(pageBlocks([req], sections).blocks, req.n).state;
  const going = (extra = {}, task = {}, responsible = x227) => request(50, 60, "doing", [withTask(routed(card, "YN-230", "doing", responsible), task)], extra);
  assert.equal(label(request(50, 60, "done", [withTask(routed(card, "YN-230", "done", null))], { delivery: "rejected" })), "done", "done comes first");
  assert.equal(label(going({ delivery: "rejected" })), "deliveryFailed");
  for (const delivery of ["sending", "uncertain", "unknown", null]) assert.equal(label(going({ delivery })), "unconfirmed", String(delivery));
  const question = section("yn-230/q", "ask", "选哪个？", 1, 5, lead, { ask: ask("选哪个？", "open"), card: binding("YN-230", "doing", x227) });
  assert.equal(label(going(), [card, question]), "decide");
  assert.equal(label(request(50, 60, "answered", [])), "accept");
  const waits = block(pageBlocks([going({}, { blocker: "等 core.40 发布后用户安装" })], [card]).blocks, 50);
  assert.deepEqual([waits.state, waits.next], ["condition", { kind: "condition", text: "等 core.40 发布后用户安装", task: "YN-230" }]);
  assert.equal(label(going({}, {}, { ...x227, state: "idle" })), "going", "an executor that has stopped: only facts, no verdict");
  assert.equal(label(going({}, {}, { agentId: "lead", name: "Dev Lead", kind: "lead", state: "active" })), "team");
  assert.equal(label(request(50, 1, "waiting", [])), "frontDesk");
});

test("R-38 a progress written before later facts says which, at most three kinds; several tasks name their outcomes", () => {
  ids = 900;
  const card = planCard("yn-231", "YN-231", [{ id: "a", text: "导出", state: "doing", prs: [7] }], 30, { status: status(30, true) });
  const r = withTask(routed(card, "YN-231", "doing", x227, [], 5), { prs: [pull(7, null)] });
  const req = request(60, 300, "doing", [r], {
    replies: [{ n: 1, text: "还要导入", textBlocks: null, images: [], files: [], at: at(2), messageId: "f1", deliveredTo: [] }],
    lines: [{ kind: "done", task: "YN-231", status: "done", at: at(1), cardSectionId: card.id, title: card.title }],
  });
  const stale = block(pageBlocks([req], [card]).blocks, 60).stale;
  assert.equal(stale.at, card.updatedAt);
  assert.equal(stale.expired, true, "its status is past its validity");
  assert.deepEqual(stale.facts, [{ kind: "merged", prs: [7] }, { kind: "result", task: "YN-231" }, { kind: "ended", task: "YN-231" }]);

  const a = planCard("yn-232", "YN-232", [{ id: "a", text: "契约", state: "done" }], 10, { card: binding("YN-232", "doing", x227, {}) });
  a.card.task.shortName = "契约";
  const b2 = planCard("yn-233", "YN-233", [{ id: "a", text: "视图", state: "todo" }], 10);
  b2.card.task.shortName = "视图";
  const both = request(61, 300, "doing", [withTask(routed(a, "YN-232", "doing", x227)), withTask(routed(b2, "YN-233", "doing", x227))]);
  const bar = block(pageBlocks([both], [a, b2]).blocks, 61).now;
  assert.deepEqual(bar.segments.map((s) => s.name), ["契约 · 契约", "视图 · 视图"]);
  assert.deepEqual([bar.done, bar.total, bar.available, bar.merged], [1, 2, 0, 0], "no step names a PR: done, never usable");
});

test("R-38 a bar of more than ten outcomes draws adjacent ones of one state as one cell, never one asking", () => {
  const seg = (i, state, asking = false) => ({ id: `t:${i}`, task: "t", name: `第 ${i} 项`, detail: null, state, facts: [], asking });
  const few = Array.from({ length: 10 }, (_, i) => seg(i, "done"));
  assert.equal(barCells(few).length, 10, "ten: one cell each");
  const many = [...Array.from({ length: 6 }, (_, i) => seg(i, "done")), seg(6, "doing", true), seg(7, "doing"), ...Array.from({ length: 4 }, (_, i) => seg(8 + i, "todo"))];
  assert.deepEqual(barCells(many).map((cell) => [cell.state, cell.segments.length]), [["done", 6], ["doing", 1], ["doing", 1], ["todo", 4]]);
});

test("R-38 §2.4 a project card relates to requests only by the tasks its LiveRefs name, each request once", () => {
  ids = 900;
  const card = planCard("yn-227", "YN-227", [{ id: "a", text: "a", state: "doing" }], 10);
  const r38 = request(38, 300, "doing", [withTask(routed(card, "YN-227", "doing", x227))]);
  const dev = section("development", "status", "R-31 和 R-38 都在等 core.40", 3, 5, lead, {
    status: status(5),
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: {}, children: ["lead", "refs"] },
      lead: { type: "Markdown", props: { text: "R-31 和 R-38 都在等 core.40（YN-221）。" } },
      refs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "YN-227" }, { kind: "pr", id: "o/r#7" }, { kind: "task", id: "YN-999" }, { kind: "task", id: "YN-227" }] } },
    } },
  });
  assert.deepEqual(commonTasks(dev), ["YN-227", "YN-999"], "tasks only, each once; R-31 and YN-221 in its words are not read");
  const { blocks } = pageBlocks([r38], [card, dev]);
  assert.deepEqual(relatedRequests(dev, blocks), [{ task: "YN-227", n: 38 }], "a task no request has relates to none");
  assert.deepEqual(commonTasks(null), []);
});

test("R-43 with no progress yet, the front desk's newest reply is in the first look, unless a card came after it", () => {
  ids = 900;
  const said = "我会把规则写进 Agent 提交 Job 时看到的说明，并核实主线是否允许直接快进。";
  const notes = [{ note: "好，交给执行者。", by: desk, at: at(5) }, { note: ` ${said} `, by: desk, at: at(3) }];
  // R-42: routed to a task the lead answers for, which has no card and no progress yet.
  const r42 = request(42, 6, "doing", [withTask(routed(null, "YN-230", "doing", lead))], { notes });
  const b = block(pageBlocks([r42], []).blocks, 42);
  assert.equal(b.fact.kind, "working");
  assert.deepEqual([b.now, b.reply], [null, { text: said, by: desk, at: at(3) }], "its newest note, trimmed");
  // A card written after the reply: the card's line stands, and the reply is in the conversation.
  const later = section("yn-230", "status", "规则已写好", 2, 1, lead, { status: status(1), card: binding("YN-230", "doing", lead) });
  const r42b = request(42, 6, "doing", [withTask(routed(later, "YN-230", "doing", lead))], { notes });
  assert.equal(block(pageBlocks([r42b], [later]).blocks, 42).reply, null);
  // A card older than the reply: the reply is newer, so it is in the first look.
  const earlier = section("yn-230", "status", "开始写规则", 2, 4, lead, { status: status(4), card: binding("YN-230", "doing", lead) });
  const r42c = request(42, 6, "doing", [withTask(routed(earlier, "YN-230", "doing", lead))], { notes });
  assert.equal(block(pageBlocks([r42c], [earlier]).blocks, 42).reply?.text, said);
  // Its task's own progress is the first look: no reply beside it.
  const r42d = request(42, 6, "doing", [withTask(routed(null, "YN-230", "doing", lead), { progress: "规则已写进说明。" })], { notes });
  assert.equal(block(pageBlocks([r42d], []).blocks, 42).reply, null);
  // No task yet: the reply is its fact already, not said twice.
  const r43 = request(43, 6, "doing", [], { notes });
  const none = block(pageBlocks([r43], []).blocks, 43);
  assert.deepEqual([none.fact.kind, none.fact.note, none.reply], ["waiting", ` ${said} `, null]);
  // No note, or a blank one: nothing.
  const r44 = request(44, 6, "doing", [withTask(routed(null, "YN-231", "doing", lead))], { notes: [{ note: "  ", by: desk, at: at(3) }] });
  assert.equal(block(pageBlocks([r44], []).blocks, 44).reply, null);
});

test("R-38 §2.5 a task's own progress is dated by when it was written: what came after it is said; unknown, nothing", () => {
  ids = 900;
  const replies = [{ n: 1, text: "还要 JSON", textBlocks: null, images: [], files: [], at: at(5), messageId: "m-1", deliveredTo: [] }];
  const merged = { number: 1130, title: "#1130", url: "https://example.com/pull/1130", repository: "o/r", state: "merged", mergedAt: at(10), installed: null };
  const r50 = request(50, 120, "doing", [withTask(routed(null, "YN-240", "doing", x227),
    { progress: "导出已能用。JSON 还在做。", progressAt: at(30), prs: [merged] })], { replies });
  const b = block(pageBlocks([r50], []).blocks, 50);
  assert.deepEqual(b.now, { kind: "progress", text: "导出已能用。", task: "YN-240" });
  assert.deepEqual(b.stale, { at: at(30), facts: [{ kind: "merged", prs: [1130] }, { kind: "followUp", count: 1 }], expired: false });
  // Written after both: nothing to say.
  const r51 = request(51, 120, "doing", [withTask(routed(null, "YN-240", "doing", x227),
    { progress: "导出已能用。", progressAt: at(2), prs: [merged] })], { replies });
  assert.equal(block(pageBlocks([r51], []).blocks, 51).stale, null);
  // An older Core, or a task whose record does not say: unknown, so nothing is claimed either way.
  for (const progressAt of [undefined, null]) {
    const r52 = request(52, 120, "doing", [withTask(routed(null, "YN-240", "doing", x227), { progress: "导出已能用。", progressAt, prs: [merged] })], { replies });
    assert.equal(block(pageBlocks([r52], []).blocks, 52).stale, null);
  }
  // Several tasks: of those going on, the progress written last; an ended task's newer progress is not it.
  const r53 = request(53, 120, "doing", [
    withTask(routed(null, "YN-241", "doing", x227), { progress: "旧的进度。", progressAt: at(40) }),
    withTask(routed(null, "YN-242", "doing", x207), { progress: "新的进度。", progressAt: at(8) }),
    withTask(routed(null, "YN-243", "done", null), { progress: "已结束的任务。", progressAt: at(1) }),
  ], { replies });
  const several = block(pageBlocks([r53], []).blocks, 53);
  assert.deepEqual(several.now, { kind: "progress", text: "新的进度。", task: "YN-242" });
  assert.deepEqual(several.stale?.facts, [{ kind: "followUp", count: 1 }]);
});

// R-45 (YN-233 §3.1–3.3): R-44 as it was, delivered and followed up twice after its report (synthetic data in its shape).
const x232 = who("x232", "YN-232 · 只读调查");
const deskTo = { agentId: "lead", name: "Dev Lead" };
const execTo = { agentId: "x232", name: "YN-232 · 只读调查" };
const F1 = "什么是未读规则？我没有点开看的意思吗？";
const F2 = "什么情况？这个request不会更新回复我了吗？";
function followUp(n, minutes, text, to, delivery = "accepted") {
  return { n, text, textBlocks: null, images: [], files: [], at: at(minutes), messageId: `f${n}`, deliveredTo: to.map((t) => ({ ...t, delivery })) };
}
function r44({ replies = [followUp(1, 12, F1, [execTo]), followUp(2, 5, F2, [deskTo])], notes = [], state = "ended", progress = "已验收 core.39 的只读调查和界面对照记录。" } = {}) {
  ids = 900;
  const card = section("yn-232", "report", "R-44 · 侧栏状态：是未读规则，不是刷新慢", 3, 13, lead, { card: binding("YN-232", "done", null) });
  const routedCard = withTask(routed(card, "YN-232", "done", null, [report("yn-232", 3, card.id)], 13), { progress });
  const req = request(44, 20, state, [routedCard], {
    replies, notes: [{ note: "我会先复现，再说明原因。", by: desk, at: at(19) }, ...notes],
  });
  return { req, card, b: block(pageBlocks([req], [card]).blocks, 44) };
}

test("R-45 a follow-up waiting for a reply: not the user's to accept, in progress, no next step; Core's lines and cards are no answer", () => {
  const { req, b } = r44();
  assert.deepEqual(b.follow.items.map((i) => [i.n, i.state]), [[1, "waiting"], [2, "waiting"]]);
  assert.equal(b.follow.latest.n, 2);
  assert.deepEqual([b.follow.answered, b.follow.waiting], [0, 2]);
  assert.deepEqual(b.follow.latest.to, [deskTo]);
  assert.deepEqual([b.state, b.group, b.next, b.action], ["followUp", "doing", null, "confirm"], "Confirm done stays, not the user's turn");
  // A report delivered after a follow-up (at 13 min), its task done, the card's newer version and its progress answer none.
  const done = r44({ replies: [followUp(1, 15, F1, [execTo])] });
  assert.equal(done.b.follow.latest.state, "waiting");
  assert.equal(done.b.state, "followUp");
  // None: as before.
  const none = r44({ replies: [] });
  assert.deepEqual([none.b.follow, none.b.state, none.b.group, none.b.next?.kind], [null, "accept", "needs", "accept"]);
  assert.equal(followUpsOf(req).items.length, 2);
});

test("R-45 a note answers only the follow-ups its replyTo names, the newest such note; the user's turn again once the newest is answered", () => {
  const answer1 = { note: "对，就是这个意思：本机还没看过这一轮，侧栏就先显示 Between turns。", by: desk, at: at(11), replyTo: [1] };
  const one = r44({ notes: [answer1] }).b;
  assert.deepEqual(one.follow.items.map((i) => i.state), ["answered", "waiting"]);
  assert.deepEqual(one.follow.items[0].note, { n: 2, note: answer1.note, by: desk, at: answer1.at });
  assert.equal(one.state, "followUp", "its newest still waits");
  const both = r44({ notes: [answer1, { note: "可以继续追问；漏了回来答你。", by: desk, at: at(3), replyTo: [2] }] }).b;
  assert.deepEqual(both.follow.items.map((i) => i.state), ["answered", "answered"]);
  assert.deepEqual([both.state, both.group, both.next?.kind, both.follow.answered], ["accept", "needs", "accept", 2]);
  // Two notes name it: the newest.
  const twice = r44({ notes: [{ ...answer1, at: at(11) }, { ...answer1, note: "补一句。", at: at(4) }] }).b;
  assert.equal(twice.follow.items[0].note.note, "补一句。");
  // replyTo [] names none: it neither answers this one nor is said after it unmarked.
  const empty = r44({ notes: [{ note: "顺带一提。", by: desk, at: at(3), replyTo: [] }] }).b;
  assert.deepEqual(empty.follow.items.map((i) => i.state), ["waiting", "waiting"]);
});

test("R-45 an unmarked note after follow-ups is said after them all alike, never matched by time; then the user's turn", () => {
  const late = { note: "可以继续在 R-44 追问。之前我只交了报告，漏了回来答你。", by: desk, at: at(3) };
  const { b } = r44({ notes: [late] });
  assert.deepEqual(b.follow.items.map((i) => [i.state, i.note?.n, i.together]), [["later", 2, [1, 2]], ["later", 2, [1, 2]]],
    "together 2: which it answers is not known");
  assert.deepEqual([b.state, b.group], ["accept", "needs"], "someone spoke: the user decides");
  assert.equal(b.follow.answered, 0, "not counted as answered");
  // A note before a follow-up is no answer to it.
  const before = r44({ replies: [followUp(1, 2, F1, [deskTo])], notes: [late] }).b;
  assert.equal(before.follow.latest.state, "waiting");
  // An older Core: no replyTo, no n, no names; the same.
  const older = r44({ replies: [{ ...followUp(1, 12, F1, []), deliveredTo: [{ agentId: "x232", delivery: "accepted" }] }], notes: [late] }).b;
  assert.deepEqual([older.follow.latest.state, older.follow.latest.to], ["later", [{ agentId: "x232", name: null }]]);
});

test("R-45 a follow-up not confirmed delivered, or refused; waiting replaces only For you to accept", () => {
  const sending = r44({ replies: [followUp(1, 12, F1, [execTo]), followUp(2, 5, F2, [deskTo], "sending")] }).b;
  assert.deepEqual([sending.follow.latest.state, sending.follow.latest.failed, sending.state], ["unsent", false, "followUp"]);
  const refused = r44({ replies: [followUp(1, 5, F1, [deskTo], "rejected")] }).b;
  assert.deepEqual([refused.follow.latest.state, refused.follow.latest.failed], ["unsent", true]);
  const nobody = r44({ replies: [{ ...followUp(1, 5, F1, []) }] }).b;
  assert.equal(nobody.follow.latest.state, "unsent", "sent to no one");
  // The team on it: its label stays, the zone is under it.
  const going = r44({ state: "doing" });
  const team = block(pageBlocks([{ ...going.req, cards: [withTask(routed(going.card, "YN-232", "doing", x232))] }], [going.card]).blocks, 44);
  assert.deepEqual([team.state, team.follow.latest.state], ["team", "waiting"]);
  // No task: Core reopened it for the front desk (waiting), With the front desk stays.
  const plain = request(46, 20, "waiting", [], { replies: [followUp(1, 1, "能改成 60 天吗？", [deskTo])],
    notes: [{ note: "默认保留 30 天。", by: desk, at: at(18) }] });
  const p = block(pageBlocks([plain], []).blocks, 46);
  assert.deepEqual([p.state, p.follow.latest.state, p.fact.kind, p.fact.note], ["frontDesk", "waiting", "waiting", "默认保留 30 天。"]);
});

test("R-45 what came after the first follow-up is said once, by the follow-ups: not as R-43's reply or the fact", () => {
  // Answered with no card, followed up, answered again by replyTo: the fact is the first answer, the zone the second.
  const first = { note: "默认保留 30 天，到期滚动归档。", by: desk, at: at(18) };
  const again = { note: "可以，改成 60 天。", by: desk, at: at(1), replyTo: [1] };
  const r46 = request(46, 20, "answered", [], { replies: [followUp(1, 5, "能改成 60 天吗？", [deskTo])], notes: [first, again] });
  const b = block(pageBlocks([r46], []).blocks, 46);
  assert.deepEqual([b.fact.kind, b.fact.text, b.follow.latest.state, b.follow.latest.note.note, b.state], ["answered", first.note, "answered", again.note, "accept"]);
  // A task with no progress yet: R-43's reply is the note before the first follow-up; with none before, none.
  const r42 = (notes) => block(pageBlocks([request(42, 20, "doing", [withTask(routed(null, "YN-230", "doing", lead))],
    { replies: [followUp(1, 5, "还要 JSON", [deskTo])], notes })], []).blocks, 42);
  assert.equal(r42([first, { note: "JSON 也加。", by: desk, at: at(2) }]).reply.text, first.note);
  assert.equal(r42([{ note: "JSON 也加。", by: desk, at: at(2) }]).reply, null);
});
