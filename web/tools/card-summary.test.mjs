import test from "node:test";
import assert from "node:assert/strict";
import { firstParagraph, sectionSummary, unmaintained } from "../src/home/card-summary.ts";
import { topicName } from "../src/home/brief-layout.ts";

// T-173: what a folded Home card says about itself, from bodies shaped like
// the Home audit's examples. Synthetic content only.
const owner = (state = "active") => ({ agentId: "a", name: "Mori", state });
const section = (top, elements, extra = {}) => ({
  key: "overview", kind: "report", title: "Overview", version: 1, owner: owner(),
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: top }, ...elements } },
  ...extra,
});
const md = (text) => ({ type: "Markdown", props: { text } });
const group = (children, tone) => ({ type: "Group", props: tone ? { title: "Now", tone } : { title: "Now" }, children });

test("an accent Group first is the summary: its first Markdown, first paragraph only", () => {
  const card = section(["lead", "plan"], {
    lead: group(["numbers", "text", "more"], "accent"),
    numbers: { type: "Metrics", props: { items: [{ label: "Open", value: "3" }] } },
    text: md("Release **core.15** is out; the next batch has started.\n\nDetails follow below."),
    more: md("A second note."),
    plan: { type: "Plan", props: { steps: [{ id: "one", text: "Ship", state: "todo" }] } },
  });
  assert.equal(sectionSummary(card), "Release **core.15** is out; the next batch has started.");
});

test("a Markdown block first is the summary", () => {
  assert.equal(sectionSummary(section(["text", "refs"], { text: md("  Two outcomes are active.  "), refs: { type: "LiveRefs", props: { items: [] } } })),
    "Two outcomes are active.");
});

test("an old card opening with another Group, a chart or attachments has no summary, not the wrong one", () => {
  // The audit's Group-first card: a plain Group of evidence, then the result.
  const evidence = section(["evidence", "result"], {
    evidence: group(["log"]),
    log: md("Run 39702937947: 412 passed."),
    result: md("Merged."),
  });
  assert.equal(sectionSummary(evidence), null, "evidence is never taken for the summary");
  assert.equal(sectionSummary(section(["evidence"], { evidence: group(["log"], "muted"), log: md("Logs") })), null);
  assert.equal(sectionSummary(section(["chart", "text"], { chart: { type: "BarChart", props: {} }, text: md("Later text") })), null);
  assert.equal(sectionSummary(section(["files", "text"], { files: { type: "Attachments", props: { items: [] } }, text: md("Later text") })), null);
  // An accent Group without Markdown says nothing either.
  assert.equal(sectionSummary(section(["lead", "text"], { lead: group(["numbers"], "accent"), numbers: { type: "Metrics", props: { items: [] } }, text: md("Later") })), null);
});

test("a top-level block named summary is the summary wherever it stands", () => {
  const named = section(["evidence", "summary"], { evidence: group(["log"]), log: md("Logs"), summary: md("The fix is merged.") });
  assert.equal(sectionSummary(named), "The fix is merged.");
  const grouped = section(["evidence", "summary"], {
    evidence: group(["log"]), log: md("Logs"),
    summary: group(["line", "tail"]), line: md("Waiting for the release window."), tail: md("More"),
  });
  assert.equal(sectionSummary(grouped), "Waiting for the release window.");
  // Only at the top level, and only as Markdown or a Group that opens with one.
  const nested = section(["evidence"], { evidence: group(["summary"]), summary: md("Nested") });
  assert.equal(sectionSummary(nested), null);
  const notText = section(["evidence", "summary"], { evidence: group(["log"]), log: md("Logs"), summary: { type: "Metrics", props: { items: [] } } });
  assert.equal(sectionSummary(notText), null);
});

test("a malformed or empty body has no summary and does not throw", () => {
  for (const body of [null, undefined, {}, { root: 3, elements: {} }, { root: "body" }, { root: "missing", elements: {} },
    { root: "body", elements: { body: { type: "BriefBody", props: {} } } },
    { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["gone"] } } },
    { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text: 4 } } } },
    { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: md("   \n\n  ") } }])
    assert.equal(sectionSummary({ ...section([], {}), body }), null, JSON.stringify(body));
});

test("first paragraphs keep their Markdown whole", () => {
  assert.equal(firstParagraph("See [the PR](https://example.com/pr/1) and `make test`.\n \nNext."), "See [the PR](https://example.com/pr/1) and `make test`.");
  assert.equal(firstParagraph("One line\nstill the same paragraph"), "One line\nstill the same paragraph");
  assert.equal(firstParagraph("\n\n"), null);
});

test("a report or status whose author is not active is unmaintained; an Ask never is", () => {
  assert.equal(unmaintained(section([], {})), false);
  for (const state of ["closed", "deleted", "moved"]) {
    assert.equal(unmaintained(section([], {}, { owner: owner(state) })), true, state);
    assert.equal(unmaintained(section([], {}, { kind: "status", owner: owner(state) })), true, state);
    assert.equal(unmaintained(section([], {}, { kind: "ask", owner: owner(state) })), false, `${state} ask`);
  }
});

test("a topic reads as words, not its key", () => {
  assert.equal(topicName("release-core12"), "Release core12");
  assert.equal(topicName("home"), "Home");
  assert.equal(topicName("a--b"), "A b");
});
