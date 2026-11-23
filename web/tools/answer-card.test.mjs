// YN-223: the answered Ask's card as R-29 settled it reads the question as a heading and the note after it, and
// shows the reply as the user gave it only from the snapshot Core kept with it.
import test from "node:test";
import assert from "node:assert/strict";
import { answerShown, optionsThen, questionParts } from "../src/home/answer-card.ts";

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
