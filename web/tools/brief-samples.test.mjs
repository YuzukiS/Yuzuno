// YN-16 S5: the twelve samples of brief-samples.mjs against the contract and
// brief_guide interactive's "When to draw". Pure: no DOM, no model.
import test from "node:test";
import assert from "node:assert/strict";
import { briefGuide, checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";
import { INTERACTIVE, SAMPLES } from "./brief-samples.mjs";

const types = (put) => new Set(Object.values(put.body.elements).map((node) => node.type));

test("twelve samples: eight that draw, four that do not, each a section the contract accepts", () => {
  assert.equal(SAMPLES.length, 12);
  assert.equal(new Set(SAMPLES.map((sample) => sample.id)).size, 12);
  assert.deepEqual([SAMPLES.filter((s) => s.draws).length, SAMPLES.filter((s) => !s.draws).length], [8, 4]);
  for (const sample of SAMPLES) {
    assert.ok(checkBriefSection(sample.put), sample.id);
    const used = types(sample.put);
    for (const type of sample.uses) assert.ok(used.has(type), `${sample.id} uses ${type}`);
    const drawn = INTERACTIVE.filter((type) => used.has(type));
    if (sample.draws) assert.ok(drawn.length > 0, `${sample.id} draws`);
    else assert.deepEqual(drawn, [], `${sample.id} draws nothing`);
  }
});

test("the guide's When to draw names the form of every sample", () => {
  const part = briefGuide("interactive");
  for (const phrase of [
    /A quantity the reader will scale or split \(servings, a bill, a budget, a what-if\) is NumberInput, Segmented or Switch with a Calc/, // recipe, bill, savings
    /The parts of a physical thing, or a screenshot with callouts, is a Figure over an image attachment/, // parts
    /A process with a decision or a loop, or more than four steps that branch, is a Diagram/, // flow
    /A procedure the reader follows step by step is Steps \(walk for four or more steps done with busy hands\)/, // wifi
    /Three or more dated events are a Timeline; a planned date says it is planned/, // release
    /A single fact, a yes or no, a number or a short status is one sentence of Markdown, no component/, // status, yesno, number
    /never draw what Core already shows \(a task's state is a LiveRefs item\)/, // task
    /The reader's values never reach you: ask with an ask when you need an answer/,
  ])
    assert.match(part, phrase);
});
