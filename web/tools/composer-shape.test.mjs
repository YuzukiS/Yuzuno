import test from "node:test";
import assert from "node:assert/strict";
import { LINE_RETURN_MARGIN, nextShape } from "../src/composer-shape.ts";

// T-44: which shape the composer takes for what its editor shows. A line is
// laid out one text line high (28 px at 16 px); `room` is the text's width
// in the line shape.
const line = (width, { lines = 1, height = 17 } = {}) => ({ lines, width, height, lineHeight: 28 });

test("something under the text, a second line, or nothing measured keeps a block", () => {
  for (const current of ["line", "block"]) {
    assert.equal(nextShape(current, true, line(40), 600), "block", `${current}: forced`);
    assert.equal(nextShape(current, false, line(40, { lines: 2 }), 600), "block", `${current}: two lines`);
    assert.equal(nextShape(current, false, null, 600), "block", `${current}: no layout`);
    assert.equal(nextShape(current, false, line(40), 0), "block", `${current}: no room`);
  }
});

test("a line stays a line until its text wraps", () => {
  assert.equal(nextShape("line", false, line(599), 600), "line");
  assert.equal(nextShape("line", false, line(600, { height: 45 }), 600), "block");
});

test("a block goes back to a line only when its text is narrower than the room by the margin", () => {
  assert.equal(LINE_RETURN_MARGIN, 8);
  assert.equal(nextShape("block", false, line(591.9), 600), "line");
  assert.equal(nextShape("block", false, line(592), 600), "block");
  assert.equal(nextShape("block", false, line(300, { height: 45 }), 600), "block", "wrapped at the full width");
});

test("typing to the edge and back switches once each way", () => {
  // The text grows a few px a key until it wraps in the line, then shrinks.
  const room = 240;
  let shape = "line";
  const seen = [];
  const step = (width) => {
    const wraps = shape === "line" && width > room;
    shape = nextShape(shape, false, line(width, { height: wraps ? 45 : 17 }), room);
    seen.push(shape);
  };
  for (let width = 200; width <= 250; width += 7) step(width);
  for (let width = 250; width >= 200; width -= 7) step(width);
  const switches = seen.filter((s, i) => i > 0 && s !== seen[i - 1]).length;
  assert.equal(switches, 2, seen.join(" "));
});
