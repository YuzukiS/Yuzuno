// A research desk copied as Markdown (T-9): pure, no DOM. Dev 7's Home
// report copy calls researchDeskMarkdown for a ResearchDesk block.
import test from "node:test";
import assert from "node:assert/strict";
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
  assert.match(text, /\| o2 · arm \| — \| \[—, —\] \| not read \|/);
  assert.doesNotMatch(text, /-6\.1/);
  const piped = structuredClone(desk);
  piped.plots[0].rows[0].label = "a | b\nc";
  assert.match(researchDeskMarkdown(piped), /\| a \\\| b c \| — \|/, "a cell keeps the table whole");
});
