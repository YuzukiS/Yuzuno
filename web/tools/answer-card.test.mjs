// YN-223: the answered Ask's card as R-29 settled it reads the question as a heading and the note after it, and
// shows the reply as the user gave it only from the snapshot Core kept with it. YN-230 (R-41): one line of what was
// decided, and the options not chosen for its record.
import test from "node:test";
import assert from "node:assert/strict";
import { answerLine, answerShown, optionsThen, otherOptions, questionParts } from "../src/home/answer-card.ts";

test("the question is shown word for word: set as a heading and a note only where that is plain, else whole", () => {
  assert.deepEqual(questionParts("参照会话的回复样式，你想在首页采用哪一种排法？选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。"),
    { head: "参照会话的回复样式，你想在首页采用哪一种排法？", note: "选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。" });
  assert.deepEqual(questionParts("Which plan? Plan B costs more.\nPlan A ships later."),
    { head: "Which plan?", note: "Plan B costs more.\nPlan A ships later." });
  assert.deepEqual(questionParts("你说「这样可以吗？」然后呢"), { head: "你说「这样可以吗？」", note: "然后呢" });
  assert.deepEqual(questionParts("Is it “done?” Check the list."), { head: "Is it “done?”", note: "Check the list." });
  // One question and nothing after it, or no question mark: the whole is the heading.
  for (const question of ["R-26 的七项建议，这一轮你想推进哪些？", "Pick one of the layouts below", "", "  Ship it?  "])
    assert.deepEqual(questionParts(question), { head: question.trim(), note: "" }, question);
  // Several questions, a ? inside a word or a link: not plain, so whole, exactly as written.
  for (const question of [
    "先做 A 吗？还是先做 B？选一个即可。",
    "Ship today? Or wait for the docs? Either is fine.",
    "Is v2?x the build to ship? It is the newest.",
    "Open https://example.com/a?b=1 and say: does it load? It should.",
    "看一下 https://example.com/r29 再选？选完写在补充里。",
  ]) assert.deepEqual(questionParts(question), { head: question, note: "" }, question);
  // Whatever the split, nothing of the question is lost or changed.
  for (const question of ["参照会话的回复样式，你想？选择只定设计。", "A? B", "One?\n\nTwo lines after."]) {
    const { head, note } = questionParts(question);
    assert.equal(`${head}${note}`.replace(/\s/g, ""), question.replace(/\s/g, ""), question);
  }
});

const snapshot = (fields) => ({ format: 1, projectName: "Code", sectionKind: "ask", title: "Which plan?", question: "Plan A or B?",
  options: [{ id: "a", label: "Plan A" }, { id: "b", label: "Plan B" }], choice: null, text: null, form: null, ...fields });
const ask = (fields) => ({ question: "Plan A or B now?", reply: {}, state: "replied", replyText: "Plan B: soon", ...fields });

test("a kept reply shows the question it answered; an earlier one its text as sent and the Ask's question now, said so", () => {
  const kept = snapshot({ choice: { id: "b", label: "Plan B" }, text: "soon" });
  assert.deepEqual(answerShown(ask({ replySnapshot: kept }), "Plan B: soon"), { question: "Plan A or B?", questionKept: true, snapshot: kept });
  // Before Core kept one: nothing read back from the text.
  assert.deepEqual(answerShown(ask({}), "Plan B: soon"), { question: "Plan A or B now?", questionKept: false, snapshot: null, text: "Plan B: soon" });
  // A snapshot with no answer in it, or of another format, is none.
  assert.equal(answerShown(ask({ replySnapshot: snapshot({}) }), "x").snapshot, null);
  assert.equal(answerShown(ask({ replySnapshot: { ...kept, format: 2 } }), "x").snapshot, null);
  // One without its question: the answer as kept, the question the Ask's now, said so.
  const noQuestion = { ...kept, question: null };
  assert.deepEqual(answerShown(ask({ replySnapshot: noQuestion }), "x"), { question: "Plan A or B now?", questionKept: false, snapshot: noQuestion });
});

test("the options then are the snapshot's, the chosen one marked", () => {
  assert.deepEqual(optionsThen(snapshot({ choice: { id: "b", label: "Plan B" } })),
    [{ id: "a", label: "Plan A", chosen: false }, { id: "b", label: "Plan B", chosen: true }]);
  assert.deepEqual(optionsThen(snapshot({ options: null, form: { id: "f", title: "F", fields: [] } })), []);
});

// R-40's form (yn-229/ask v2), as Core kept the user's answer: one choice, the optional words left empty.
const r40Form = { id: "sample2", title: "Windows 客户端实测（第 2 轮）", fields: [
  { id: "how", type: "single", label: "补样本的方式", required: true, options: [{ id: "run", label: "我在 Windows 运行一条命令（推荐）" },
    { id: "fix", label: "先恢复互操作，再由你跑 Job" }, { id: "shots", label: "我自己截图，附在这里" }, { id: "later", label: "先不测" }] },
  { id: "doing", type: "text", label: "开着 Yuzuno 时你一般在做什么？（可选）", required: false }] };
const r40 = snapshot({ options: [], form: { id: "sample2", title: r40Form.title, fields: [
  { id: "how", type: "single", label: "补样本的方式", answer: "先恢复互操作，再由你跑 Job" },
  { id: "doing", type: "text", label: "开着 Yuzuno 时你一般在做什么？（可选）", answer: "" }] } });
const zh = { list: "、", fields: "；" };

test("one line of what was decided: the choices, never a field left empty or the form's wording; written answers and notes counted", () => {
  assert.deepEqual(answerLine(r40, zh), { text: "先恢复互操作，再由你跑 Job", words: false, notes: 0 });
  // A multi-select and a written field: the choices joined, the words a note.
  const multi = snapshot({ options: [], form: { id: "f", title: "采样范围", fields: [
    { id: "s", type: "multi", label: "使用场景", answer: ["窗口被挡住", "长会话滚动"] },
    { id: "w", type: "text", label: "你的补充", answer: "两个场景请分开记录。" }] } });
  assert.deepEqual(answerLine(multi, zh), { text: "窗口被挡住、长会话滚动", words: false, notes: 1 });
  // Two choice fields, and the user's words beside the form: a note too.
  const two = snapshot({ options: [], text: "顺便看下内存", form: { id: "f", title: "T", fields: [
    { id: "a", type: "single", label: "A", answer: "甲" }, { id: "b", type: "multi", label: "B", answer: ["乙", "丙"] }] } });
  assert.deepEqual(answerLine(two, zh), { text: "甲；乙、丙", words: false, notes: 1 });
  // Only written answers: the first is the line, as words; the rest notes.
  const written = snapshot({ options: [], form: { id: "f", title: "T", fields: [
    { id: "a", type: "text", label: "A", answer: "" }, { id: "b", type: "text", label: "B", answer: "first words" },
    { id: "c", type: "text", label: "C", answer: "more words" }] } });
  assert.deepEqual(answerLine(written, zh), { text: "first words", words: true, notes: 1 });
  // A form left empty: nothing to show but that.
  assert.deepEqual(answerLine(snapshot({ options: [], form: { id: "f", title: "T", fields: [{ id: "a", type: "single", label: "A", answer: "" }] } }), zh),
    { text: "", words: true, notes: 0 });
  // A choice, with words or without; words alone.
  assert.deepEqual(answerLine(snapshot({ choice: { id: "b", label: "Plan B" }, text: "soon" }), zh), { text: "Plan B", words: false, notes: 1 });
  assert.deepEqual(answerLine(snapshot({ choice: { id: "b", label: "Plan B" }, text: "  " }), zh), { text: "Plan B", words: false, notes: 0 });
  assert.deepEqual(answerLine(snapshot({ options: [], text: "Windows 桌面版 0.7.0。" }), zh), { text: "Windows 桌面版 0.7.0。", words: true, notes: 0 });
});

test("the options not chosen: the Ask's own from the snapshot; a form's from the form answered, only while it is provably that one", () => {
  assert.deepEqual(otherOptions(snapshot({ choice: { id: "b", label: "Plan B" } }), undefined, true), [{ field: null, labels: ["Plan A"] }]);
  assert.deepEqual(otherOptions(snapshot({ choice: { id: "b", label: "Plan B" } }), undefined, false), [{ field: null, labels: ["Plan A"] }],
    "the snapshot's own, whatever changed since");
  // R-40: the field's other three options, as the form answered offered them.
  assert.deepEqual(otherOptions(r40, r40Form, true),
    [{ field: "补样本的方式", labels: ["我在 Windows 运行一条命令（推荐）", "我自己截图，附在这里", "先不测"] }]);
  // Its owner changed the Ask since the reply, or it is another form, or the field changed: none read from it.
  assert.deepEqual(otherOptions(r40, r40Form, false), []);
  assert.deepEqual(otherOptions(r40, { ...r40Form, id: "sample3" }, true), []);
  assert.deepEqual(otherOptions(r40, { ...r40Form, fields: [{ ...r40Form.fields[0], label: "换了措辞" }, r40Form.fields[1]] }, true), []);
  assert.deepEqual(otherOptions(r40, null, true), []);
  assert.deepEqual(otherOptions(r40, { id: "sample2", fields: "nope" }, true), [], "a form Home can't read is none");
  // A multi-select: what was not among the chosen.
  const multi = snapshot({ options: [], form: { id: "f", title: "T", fields: [{ id: "s", type: "multi", label: "S", answer: ["a", "c"] }] } });
  assert.deepEqual(otherOptions(multi, { id: "f", fields: [{ id: "s", type: "multi", label: "S", options: [{ label: "a" }, { label: "b" }, { label: "c" }] }] }, true),
    [{ field: "S", labels: ["b"] }]);
});
