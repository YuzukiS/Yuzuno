// YN-84 S1: a candidate's "work it takes" is one of three choices — strong
// only, fast only, both — over the format Core keeps (a non-empty list of
// tiers, or no `tiers` field at all for both). Every row of the design's
// mapping table, and what the editor writes back.
import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, TIER_CHOICES, tiersOf, tierChoiceOf, withTierChoice } from "../src/routing-tiers.ts";

const candidate = (tiers) => (tiers === undefined ? { id: "c1", enabled: true } : { id: "c1", enabled: true, tiers });

test("the choices are one of three, in the user's order, over the two tiers", () => {
  assert.deepEqual([...TIER_CHOICES], ["strong", "fast", "both"]);
  assert.deepEqual([...TIERS], ["strong", "fast"]);
});

// The design's mapping table: what is stored, what shows, and what each choice writes.
const rows = [
  { name: "no field (saved before YN-70)", stored: undefined, shows: "both" },
  { name: "null", stored: null, shows: "both" },
  { name: "strong", stored: ["strong"], shows: "strong" },
  { name: "fast", stored: ["fast"], shows: "fast" },
  { name: "strong then fast", stored: ["strong", "fast"], shows: "both" },
  { name: "fast then strong", stored: ["fast", "strong"], shows: "both" },
];
for (const row of rows) {
  test(`${row.name} shows ${row.shows} and each choice writes what Core takes`, () => {
    const c = candidate(row.stored);
    assert.equal(tierChoiceOf(c), row.shows);
    const strong = withTierChoice(c, "strong");
    const fast = withTierChoice(c, "fast");
    const both = withTierChoice(c, "both");
    assert.deepEqual(tiersOf(strong), ["strong"]);
    assert.deepEqual(tiersOf(fast), ["fast"]);
    assert.deepEqual(tiersOf(both), ["strong", "fast"]);
    assert.deepEqual(strong.tiers, ["strong"]);
    assert.deepEqual(fast.tiers, ["fast"]);
    assert.equal("tiers" in both, false, "both is no field at all");
    // Picking the shown choice again leaves it as it was.
    assert.deepEqual(withTierChoice(c, row.shows), row.shows === "both" ? { id: "c1", enabled: true } : { id: "c1", enabled: true, tiers: [row.shows] });
  });
}

test("a shape Core refuses is read without failing and left alone until a choice is made", () => {
  for (const stored of [[], "strong", 5, {}]) {
    const c = { id: "c1", enabled: true, tiers: stored };
    assert.equal(tierChoiceOf(c), "both", `${JSON.stringify(stored)} shows both`);
    // Rendering changes nothing: only a choice writes.
    assert.deepEqual(c.tiers, stored);
  }
  // A list with one known tier and a stray value shows that one, and is not rewritten while it is merely shown.
  const stray = { id: "c1", enabled: true, tiers: ["strong", "bogus"] };
  assert.equal(tierChoiceOf(stray), "strong");
  assert.deepEqual(stray.tiers, ["strong", "bogus"]);
  // Choosing both from `[]` drops the field rather than writing an empty list.
  assert.equal("tiers" in withTierChoice({ id: "c1", tiers: [] }, "both"), false);
});

test("other fields are kept, unknown ones as they came, and the candidate passed in is not changed", () => {
  const c = { id: "c1", label: "DeepSeek", enabled: true, harness: "opencode", later: { kept: true }, tiers: ["strong"] };
  const fast = withTierChoice(c, "fast");
  assert.deepEqual(fast, { id: "c1", label: "DeepSeek", enabled: true, harness: "opencode", later: { kept: true }, tiers: ["fast"] });
  assert.notEqual(fast, c);
  assert.deepEqual(c.tiers, ["strong"], "the candidate it was given is untouched");
  const both = withTierChoice(c, "both");
  assert.deepEqual(both, { id: "c1", label: "DeepSeek", enabled: true, harness: "opencode", later: { kept: true } });
  assert.deepEqual(c.tiers, ["strong"]);
});
