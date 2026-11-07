// YN-16 S2: the Calc formula language, parsed, type-checked and evaluated by
// brief-formula.ts alone (no eval, no Function, no property access). Pure
// module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMULA_FUNCTIONS, FORMULA_LIMITS, FormulaError, calcResults, evaluateFormula, formulaType, parseFormula,
} from "../src/intelligent-ui/brief-formula.ts";

const names = { guests: "number", vegan: "boolean", tip: "number", view: "text" };
const values = { guests: 6, vegan: true, tip: 10, view: "top" };
const run = (text, given = values) => {
  const tree = parseFormula(text);
  formulaType(tree, names);
  return evaluateFormula(tree, given);
};
const refused = (text, scope = names) => {
  try {
    formulaType(parseFormula(text), scope);
  } catch (error) {
    assert.ok(error instanceof FormulaError, `${text}: ${error}`);
    assert.ok(Number.isInteger(error.at) && error.at >= 0, `${text}: a position`);
    return error;
  }
  assert.fail(`${text} was accepted`);
};

test("arithmetic, comparison, logic, ?: and the functions evaluate as written", () => {
  for (const [text, want] of [
    ["250 * guests / 4", 375],
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["10 % 4", 2],
    ["guests >= 6 && vegan", true],
    ["guests < 6 || !vegan", false],
    ["view == 'top'", true],
    ['view != "side"', true],
    ["vegan ? 1 : 2", 1],
    ["guests > 4 ? guests > 5 ? 3 : 2 : 1", 3],
    ["round(1.005, 2)", 1.01],
    ["round(2.5)", 3],
    ["floor(2.7) + ceil(2.1) + abs(-1)", 6],
    ["sqrt(16)", 4],
    ["min(3, guests, 9)", 3],
    ["max(3, guests, 9, 1)", 9],
    ["clamp(guests, 1, 4)", 4],
    ["round(684 * (1 + tip / 100), 2)", 752.4],
    ["684 * (1 + tip / 100)", 684 * (1 + 10 / 100)],
    ["0.1 + 0.2", 0.1 + 0.2],
  ])
    assert.deepEqual(run(text), want, text);
  // Whitespace of any kind between parts.
  assert.equal(run("guests\n*\t2"), 12);
});

test("a result that cannot be computed is NaN, never Infinity or a thrown error", () => {
  for (const text of ["guests / 0", "guests % 0", "sqrt(-1)", "10 ^ 400", "guests / (tip - 10)"])
    assert.ok(Number.isNaN(run(text)) || !Number.isFinite(run(text)), text);
  // calcResults keeps only finite numbers.
  const [divided, big] = calcResults([{ id: "a", expr: "1 / 0" }, { id: "b", expr: "10 ^ 400" }], {});
  assert.ok(Number.isNaN(divided.value) && Number.isNaN(big.value));
});

test("a Calc's items read the variables and earlier items in order; when may read the item itself", () => {
  const items = [
    { id: "total", expr: "round(684 * (1 + tip / 100), 2)" },
    { id: "each", expr: "round(total / guests, 2)" },
    { id: "extra", expr: "each * guests - total", when: "extra > 0.001" },
    { id: "oil", expr: "guests * 10", when: "vegan" },
  ];
  const results = calcResults(items, values);
  assert.deepEqual(results.map((r) => r.id), ["total", "each", "extra", "oil"]);
  assert.equal(results[0].value, 752.4);
  assert.equal(results[1].value, 125.4);
  assert.equal(results[2].shown, false, "each * 6 equals the total: nothing extra");
  assert.deepEqual([results[3].value, results[3].shown], [60, true]);
  assert.equal(calcResults(items, { ...values, vegan: false })[3].shown, false);
  // An item hidden by its when still gives its value to later items.
  const hidden = calcResults([{ id: "a", expr: "2", when: "false" }, { id: "b", expr: "a * 3" }], {});
  assert.deepEqual(hidden.map((r) => [r.value, r.shown]), [[2, false], [6, true]]);
  // A formula that does not parse gives NaN (Core never keeps one).
  assert.ok(Number.isNaN(calcResults([{ id: "a", expr: "fetch('x')" }], {})[0].value));
});

test("every way out of the language is refused at a position: assignment, properties, other names and functions, bad types, limits", () => {
  for (const [text, reason] of [
    ["guests = 2", /= assigns, which a formula cannot; compare with ==/],
    ["window.alert", /\. reads a property/],
    ["guests[0]", /\[ reads a property/],
    ["constructor", /"constructor" is neither a variable of this section nor an earlier item/],
    ["__proto__", /"__proto__" is neither a variable/],
    ["fetch('x')", /fetch\(\) is not a formula function; the functions are round, floor, ceil, abs, sqrt, min, max, clamp/],
    ["Function('x')", /Function\(\) is not a formula function/],
    ["alert(1)", /alert\(\) is not a formula function/],
    ["salt * 2", /"salt" is neither a variable of this section nor an earlier item of this Calc; it may use guests, vegan, tip, view/],
    ["guests + vegan", /\+ takes numbers, not a number and a boolean/],
    ["view + 1", /\+ takes numbers, not a text and a number/],
    ["view > 'a'", /> compares numbers/],
    ["view == 1", /== compares two values of one type, not a text and a number/],
    ["guests && vegan", /&& takes true or false, not a number and a boolean/],
    ["-vegan", /- negates a number, not a boolean/],
    ["!guests", /! negates true or false, not a number/],
    ["guests ? 1 : 2", /the part before \? must be true or false/],
    ["vegan ? 1 : 'a'", /the two results of \? : must be of one type, not a number and a text/],
    ["round(view)", /round\(\) takes numbers/],
    ["round(1, 2, 3)", /round\(\) takes 1 to 2 arguments, not 3/],
    ["min(1)", /min\(\) takes 2 to 4 arguments, not 1/],
    ["sqrt()", /cannot start a value here/],
    ["1 +", /the formula ends where a value is expected/],
    ["(1 + 2", /the formula ends where \) is expected/],
    ["1 2", /2 is left over after a complete formula/],
    ["'open", /no closing '/],
    ["'a\\b'", /a text cannot hold \\, ` or \$/],
    ["'${x}'", /a text cannot hold/],
    ["`x`", /"`" is not part of a formula/],
    [".5", /write a number with a digit before its point/],
    ["guests; 1", /";" is not part of a formula/],
    ["", /the formula is empty/],
    ["   ", /the formula is empty/],
    [`'${"a".repeat(65)}'`, /a text has at most 64 characters/],
    ["1+".repeat(120) + "1", /the formula has 241 characters; the limit is 240/],
    [Array.from({ length: 41 }, () => "1").join("+"), /more than 80 parts/],
    ["((((((((((1))))))))))", /nests deeper than 8 levels/],
    ["-".repeat(9) + "1", /nests deeper than 8 levels/],
  ]) {
    const error = refused(text);
    assert.match(error.reason, reason, text);
  }
  // Positions point at the part at fault.
  assert.equal(refused("guests + salt").at, 9);
  assert.equal(refused("1 + fetch(2)").at, 4);
  assert.equal(FORMULA_LIMITS.chars, 240);
  assert.deepEqual(Object.keys(FORMULA_FUNCTIONS), ["round", "floor", "ceil", "abs", "sqrt", "min", "max", "clamp"]);
});

test("evaluation reads only the names given, as own values", () => {
  const tree = parseFormula("toString");
  assert.ok(Number.isNaN(evaluateFormula(tree, {})), "an inherited name is no value");
  assert.ok(Number.isNaN(evaluateFormula(parseFormula("a + 1"), Object.create({ a: 5 }))), "a prototype's value is no value");
});
