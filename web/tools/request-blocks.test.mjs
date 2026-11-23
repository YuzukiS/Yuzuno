// A Project's page read by request (YN-212 W1): each request one block with
// one latest fact and one action, each task one row with one card under the
// first request routed to it, and the Project's own block for the rest. The
// joining is pure; the page that draws it is W3's.
import test from "node:test";
import assert from "node:assert/strict";
import { askUpFront, authorOf, blockCounts, blockOfSection, isPlaceholder, pageBlocks } from "../src/home/request-blocks.ts";

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
  assert.deepEqual([r14.fact.kind, r14.fact.home, r14.fact.key, r14.action, r14.group], ["ask", 12, "yn-197/scope", "answer", "needs"]);
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
