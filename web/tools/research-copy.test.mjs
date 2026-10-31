// A research desk copied as Markdown (T-9): pure, no DOM. Dev 7's Home
// report copy calls researchDeskMarkdown for a ResearchDesk block.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { researchDeskMarkdown } from "../src/home/brief/research-copy.ts";
import { benchmark, doseStudy, fixtureFiles } from "./research-fixtures.mjs";

/** Core's read of a desk, from the fixture files. */
function resolvedOf(desk) {
  const values = {};
  const pointer = (document, at) => at.split("/").slice(1).reduce((value, step) => (value && typeof value === "object" ? value[step] : undefined), document);
  for (const plot of desk.plots)
    for (const row of plot.rows)
      for (const [id, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (number && typeof number === "object") {
            const found = pointer(fixtureFiles[number.from], number.pointer);
            values[`${id}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
          }
        }
  const sources = Object.fromEntries(desk.sources.filter((s) => s.snapshot).map((s) => [s.id, { sha256: "f".repeat(64), takenAt: "2026-10-31T08:00:00Z", available: true }]));
  return { values, sources };
}

test("a desk copies as Markdown: claims, tables of rows saying where each number came from, sources, definitions and previews", () => {
  const desk = doseStudy.body.elements.desk.props;
  const text = researchDeskMarkdown(desk, resolvedOf(desk));
  assert.match(text, /^### Does the higher dose shorten recovery\?/);
  assert.match(text, /\*\*High dose shortens recovery\*\* \(holds under conditions\)/);
  assert.match(text, /May not say:\n- The low dose works\. \(interpretation\)/);
  assert.match(text, /\| Row \| Value \| 95% interval \| From \|\n\| --- \| --- \| --- \| --- \|/);
  assert.match(text, /\| High dose \| -2\.04 \| \[-3\.12, -0\.96\] \| snapshot results\.json \|/);
  assert.match(text, /\| High dose · Placebo \| 9\.40 \|  \| snapshot results\.json \|/);
  assert.match(text, /\| High dose \| -2\.60 \| \[-3\.80, -1\.40\] \| the Agent \|/, "the v1 rows are the Agent's own");
  assert.match(text, /- Analysis output — results\.json, SHA-256 f{64}, 2026-10-31T08:00:00Z \(study\/results\.json\)/);
  assert.match(text, /- Recovery v2: Symptom-free for 72 hours\. \(48 h counted relapses as recovered\.\)\n- Recovery v1: Symptom-free for 48 hours\./);
  assert.match(text, /#### Next steps \(previews; nothing has run\)\n\nWhether a plan runs as described is not verified\./);
  assert.match(text, /  - Would not produce: Any new trial data/);
  // Nothing of the card's controls, and no URL or token of this Core.
  for (const absent of [/\/api\//, /version=/, /Views of this desk/, /Show/, /radio/i, /(?<!not )verified/])
    assert.doesNotMatch(text, absent);
  assert.equal(researchDeskMarkdown(desk, resolvedOf(desk)), text, "the same desk, the same text");
});

test("without Core's read a number from a snapshot is said to be not read, never guessed", () => {
  const desk = benchmark.body.elements.desk.props;
  const text = researchDeskMarkdown(desk);
  assert.match(text, /\| O2 · o2 · arm \| — \| \[—, —\] \| not read \|/, "a row's group names it");
  // With Core's read: fractions shown in percent, as the plot asks, and said so.
  const shown = researchDeskMarkdown(desk, resolvedOf(desk));
  assert.match(shown, /Values shown × 100 of the file's\./);
  assert.match(shown, /\| O2 · o2 · arm \| -6\.1 \| \[-8\.0, -4\.2\] \| snapshot bench\.json \|/);
  assert.doesNotMatch(text, /-6\.1/);
  const piped = structuredClone(desk);
  piped.plots[0].rows[0].label = "a | b\nc";
  assert.match(researchDeskMarkdown(piped), /\| O2 · a \\\| b c \| — \|/, "a cell keeps the table whole");
});

test("text the desk shows as written stays as written once the copy is read as Markdown", () => {
  // Every field the desk draws as plain text, each written to look like Markdown.
  const desk = structuredClone(doseStudy.body.elements.desk.props);
  const claim = desk.claims[0];
  const plot = desk.plots[0];
  const written = {
    title: "**required** ~~x~~ `code` <unknown> & &amp; [link](u) #",
    claim: "a_b_c *d*",
    statement: "- not a list item",
    said: "1. not a numbered item",
    condition: "# not a heading",
    paper: "+ not a list",
    plot: "Δ <b>bold?</b> | pipe ##",
    unit: "m_s #",
    interval: "95% [CI] *x* |",
    group: "G_1 #",
    row: "Low_dose *x*",
    part: "arm|x `y`",
    source: "Out|put",
    location: "dir/<x>/file_name.json",
    definition: "Re_covery",
    text: "4 spaces lead",
    change: "<script>x</script>",
    plan: "E.* lines",
    question: "`q`?",
    output: "a ~~b~~",
    notProduced: "&#38; c",
  };
  desk.title = written.title;
  claim.title = written.claim;
  claim.statement = written.statement;
  claim.statements[0].text = written.said;
  claim.conditions[0].text = written.condition;
  claim.paper[0].label = written.paper;
  plot.title = written.plot;
  plot.unit = written.unit;
  plot.interval = written.interval;
  plot.rows[0].group = written.group;
  plot.rows[0].label = written.row;
  plot.rows[0].parts[0].label = written.part;
  desk.sources[0].label = written.source;
  desk.sources[0].location = written.location;
  desk.definitions[0].title = written.definition;
  desk.definitions[0].versions[1].text = `    ${written.text}`;
  desk.definitions[0].versions[1].change = written.change;
  desk.plans[0].title = written.plan;
  desk.plans[0].question = written.question;
  desk.plans[0].outputs = [written.output];
  desk.plans[0].notProduced = [written.notProduced];
  const markdown = researchDeskMarkdown(desk, resolvedOf(desk));
  // As Home's BriefMarkdown reads Markdown: marked (GFM), then DOMPurify with its settings.
  const purify = createDOMPurify(new JSDOM("").window);
  const html = purify.sanitize(marked.parse(markdown, { async: false, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "form", "input", "button", "iframe", "style"],
    FORBID_ATTR: ["style"],
  });
  const shown = new JSDOM(`<body>${html}</body>`).window.document.body.textContent.replace(/\s+/g, " ");
  for (const [field, text] of Object.entries(written)) assert.ok(shown.includes(text), `${field} as written: ${text}\n${markdown}`);
});

test("each plot's table in the copy uses its own scale and unit", () => {
  const desk = structuredClone(doseStudy.body.elements.desk.props);
  desk.plots[1].scale = 100;
  desk.plots[1].unit = "centidays";
  const text = researchDeskMarkdown(desk, resolvedOf(desk));
  assert.match(text, /#### Recovery time vs placebo \(v2\) \(days\)\n\n\| Row/, "v2 in days, unscaled");
  assert.match(text, /\| High dose \| -2\.04 \| \[-3\.12, -0\.96\] \| snapshot results\.json \|/);
  assert.match(text, /#### Recovery time vs placebo \(v1, superseded\) \(centidays\)\n\nValues shown × 100 of the file's\./, "v1 in its own unit and scale");
  assert.match(text, /\| High dose \| -260\.00 \| \[-380\.00, -140\.00\] \| the Agent \|/);
});
