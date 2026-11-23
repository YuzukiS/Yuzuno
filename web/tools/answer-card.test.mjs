// YN-223: the answered Ask's card as R-29 settled it reads the question as a heading and the note after it, and
// shows the reply as the user gave it only from the snapshot Core kept with it.
import test from "node:test";
import assert from "node:assert/strict";
import { answerShown, optionsThen, questionParts } from "../src/home/answer-card.ts";

test("the question's first sentence is the heading and the rest its note, both whole", () => {
  assert.deepEqual(questionParts("参照会话的回复样式，你想在首页采用哪一种排法？选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。"),
    { head: "参照会话的回复样式，你想在首页采用哪一种排法？", note: "选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。" });
  assert.deepEqual(questionParts("Which plan? Plan B costs more.\nPlan A ships later."),
    { head: "Which plan?", note: "Plan B costs more.\nPlan A ships later." });
  // One sentence, or nothing after its mark: the whole is the heading.
  assert.deepEqual(questionParts("R-26 的七项建议，这一轮你想推进哪些？"), { head: "R-26 的七项建议，这一轮你想推进哪些？", note: "" });
  assert.deepEqual(questionParts("  Ship it?  "), { head: "Ship it?", note: "" });
  assert.deepEqual(questionParts("Pick one of the layouts below"), { head: "Pick one of the layouts below", note: "" });
  // A ? inside a link or a word is no sentence's end; a closing quote stays with its question.
  assert.deepEqual(questionParts("Open https://example.com/a?b=1 and say: does it load? It should."),
    { head: "Open https://example.com/a?b=1 and say: does it load?", note: "It should." });
  assert.deepEqual(questionParts("你说「这样可以吗？」然后呢"), { head: "你说「这样可以吗？」", note: "然后呢" });
  assert.deepEqual(questionParts("Is it “done?” Check the list."), { head: "Is it “done?”", note: "Check the list." });
  assert.deepEqual(questionParts(""), { head: "", note: "" });
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
