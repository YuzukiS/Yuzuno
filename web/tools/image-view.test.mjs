// T-20: how an image sits in its viewer. Pure arithmetic, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { bounds, MAX_SCALE, modeScale, opening, pan, place, resized, same, track, wheelFactor, zoomTo } from "../src/image-view.ts";

const box = { width: 1000, height: 700 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} ≠ ${expected}`);
const shown = (image, view) => ({ left: view.x, top: view.y, right: view.x + image.width * view.scale, bottom: view.y + image.height * view.scale });

test("an ordinary image opens whole and centred; one smaller than the stage at its own size, never enlarged", () => {
  const photo = { width: 2000, height: 1000 };
  const first = opening(photo, box);
  assert.equal(first.mode, "fit");
  near(first.view.scale, 0.5, "fits the width");
  near(first.view.y, (700 - 500) / 2, "centred top to bottom");
  const icon = { width: 120, height: 80 };
  const small = opening(icon, box);
  assert.equal(small.mode, "actual", "Fit would enlarge it: its actual size instead");
  near(small.view.scale, 1, "not enlarged");
  near(small.view.x, (1000 - 120) / 2, "and centred");
  // A wide panorama fitted is as wide as the stage: readable as it is.
  assert.equal(opening({ width: 9000, height: 600 }, box).mode, "fit");
});

test("a tall image (more than twice the stage's height to width) opens as wide as the stage, from its top", () => {
  const long = { width: 1170, height: 12000 };
  const first = opening(long, box);
  assert.equal(first.mode, "width");
  near(first.view.scale, 1000 / 1170, "as wide as the stage");
  near(first.view.x, 0, "edge to edge");
  near(first.view.y, 0, "its first row at the top");
  // Narrower than the stage: its actual size (never enlarged), centred, from the top.
  const phone = opening({ width: 390, height: 8000 }, box);
  assert.equal(phone.mode, "actual");
  near(phone.view.scale, 1, "its own size");
  near(phone.view.x, (1000 - 390) / 2, "centred side to side");
  near(phone.view.y, 0, "from the top");
  // The rule's edge: exactly twice the stage's ratio is not tall; just over is.
  assert.equal(opening({ width: 1000, height: 1400 }, box).mode, "fit");
  assert.equal(opening({ width: 1000, height: 1401 }, box).mode, "width");
});

test("zooming keeps the image's point under the pointer, within bounds", () => {
  const image = { width: 2000, height: 1400 };
  const start = opening(image, box).view;
  // At the middle, so neither edge stops it.
  const at = { x: 500, y: 350 };
  const u = (at.x - start.x) / start.scale, v = (at.y - start.y) / start.scale;
  const zoomed = zoomTo(start, start.scale * 3, at, image, box);
  near(zoomed.x + u * zoomed.scale, at.x, "same image point under the pointer (x)");
  near(zoomed.y + v * zoomed.scale, at.y, "same image point under the pointer (y)");
  const { min, max } = bounds(image, box);
  near(zoomTo(start, 1e6, at, image, box).scale, max, "never past the closest zoom");
  near(max, MAX_SCALE, "four times its own size");
  near(zoomTo(start, 1e-6, at, image, box).scale, min, "never past the whole image");
  // Each mode stays within reach, even a tiny image's Fit width.
  assert.ok(bounds({ width: 50, height: 40 }, box).max >= 1000 / 50);
  near(bounds({ width: 50, height: 40 }, box).min, 1, "a tiny image goes out no further than its own size");
});

test("panning stops at the edges; an image smaller than the stage stays centred", () => {
  const image = { width: 4000, height: 3000 };
  const view = { scale: 1, x: 0, y: 0 };
  const far = pan(view, 1e6, 1e6, image, box);
  assert.deepEqual([far.x, far.y], [0, 0], "no gap past its top-left");
  const other = pan(view, -1e6, -1e6, image, box);
  assert.deepEqual([other.x, other.y], [1000 - 4000, 700 - 3000], "no gap past its bottom-right");
  const small = pan({ scale: 1, x: 0, y: 0 }, 500, -500, { width: 200, height: 100 }, box);
  assert.deepEqual([small.x, small.y], [400, 300], "a small image cannot be dragged away");
  // Moved and let go anywhere, the view is always within bounds.
  for (const [dx, dy] of [[123, -77], [-9999, 42], [0.5, 9999], [Infinity, -Infinity]]) {
    const at = shown(image, pan(view, dx, dy, image, box));
    assert.ok(at.left <= 0 && at.top <= 0 && at.right >= 1000 && at.bottom >= 700, JSON.stringify(at));
  }
});

test("each mode's scale is just what it says; a resize keeps the mode and the middle", () => {
  const image = { width: 3000, height: 1500 };
  near(modeScale("fit", image, box), 1000 / 3000, "fit");
  near(modeScale("width", image, box), 1000 / 3000, "width");
  near(modeScale("actual", image, box), 1, "actual");
  near(modeScale("fit", { width: 100, height: 100 }, box), 7, "Fit, asked for, enlarges");
  near(modeScale("width", { width: 100, height: 100 }, box), 10, "and so does Fit width");
  const narrow = { width: 500, height: 400 };
  const fitted = resized(place({ scale: 1 / 3, x: 0, y: 0 }, image, box), "fit", image, box, narrow);
  near(fitted.scale, 500 / 3000, "still the whole image");
  // A free zoom keeps its scale, and the image point in the middle stays there.
  const free = zoomTo({ scale: 1, x: 0, y: 0 }, 2, { x: 500, y: 350 }, image, box);
  const middle = { u: (500 - free.x) / free.scale, v: (350 - free.y) / free.scale };
  const after = resized(free, "free", image, box, narrow);
  near(after.scale, 2, "scale kept");
  near(after.x + middle.u * after.scale, 250, "middle kept (x)");
  near(after.y + middle.v * after.scale, 200, "middle kept (y)");
});

test("a wheel's turn: one notch is a modest step; a fast spin is held to doubling; a pinch's small deltas still zoom", () => {
  const notch = wheelFactor(-100, 0, false);
  assert.ok(notch > 1.12 && notch < 1.2, `${notch}`);
  near(wheelFactor(100, 0, false) * notch, 1, "out undoes in");
  near(wheelFactor(-3, 1, false), wheelFactor(-48, 0, false), "lines count as 16 pixels");
  near(wheelFactor(-1, 2, false, 400), wheelFactor(-400, 0, false), "a page counts as the stage's height");
  assert.equal(wheelFactor(-1e5, 0, false), 2);
  assert.equal(wheelFactor(1e5, 0, false), 0.5);
  assert.ok(wheelFactor(-10, 0, true) > wheelFactor(-10, 0, false), "a trackpad pinch");
  assert.equal(wheelFactor(0, 0, false), 1);
});

test("the position bar shows the share in view and where it is; none when all of a side is in view", () => {
  assert.equal(track(0, 600, 700), null, "smaller than the stage");
  assert.equal(track(0, 700, 700), null, "just fits");
  assert.deepEqual(track(0, 7000, 700), { size: 0.1, start: 0 }, "at the top");
  assert.deepEqual(track(-6300, 7000, 700), { size: 0.1, start: 0.9 }, "at the bottom");
  assert.deepEqual(track(-3150, 7000, 700), { size: 0.1, start: 0.45 }, "halfway");
});

test("nothing breaks before the image or the stage has a size", () => {
  const none = { width: 0, height: 0 };
  const first = opening(none, box);
  assert.equal(first.mode, "fit");
  assert.ok(Number.isFinite(first.view.scale));
  const zoomed = zoomTo({ scale: 1, x: 0, y: 0 }, 2, { x: 0, y: 0 }, { width: 10, height: 10 }, none);
  assert.ok([zoomed.scale, zoomed.x, zoomed.y].every(Number.isFinite), JSON.stringify(zoomed));
  assert.deepEqual(place({ scale: 1, x: 3, y: 4 }, none, none), { scale: 1, x: 0, y: 0 }, "nothing to move: it stays put");
  assert.ok(same({ scale: 1, x: 0.2, y: 0 }, { scale: 1, x: 0, y: 0.3 }) && !same({ scale: 1, x: 0, y: 0 }, { scale: 1.5, x: 0, y: 0 }));
  const view = resized({ scale: 0, x: 0, y: 0 }, "fit", { width: 10, height: 10 }, box, box);
  assert.ok(Number.isFinite(view.x) && Number.isFinite(view.y));
});
