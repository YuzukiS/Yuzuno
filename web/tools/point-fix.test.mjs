// Point & Fix (T-167): areas are kept in the original's pixels, whatever the
// zoom, and the draft text keeps the source apart from the user's notes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NOTE, centeredRegion, clampRegion, feedbackText, imagePoint, outputScale, spanRegion,
} from "../src/point-fix.ts";

const size = { width: 1600, height: 900 };

test("a point on the shown image is the same pixel of the original at any zoom or pixel ratio", () => {
  // The same spot, a quarter across and a third down, drawn at three sizes.
  for (const box of [{ left: 10, top: 20, width: 800, height: 450 }, { left: 0, top: 0, width: 1600, height: 900 }, { left: -300, top: 5, width: 3200, height: 1800 }]) {
    const point = imagePoint({ x: box.left + box.width / 4, y: box.top + box.height / 3 }, box, size);
    assert.deepEqual(point, { x: 400, y: 300 }, JSON.stringify(box));
  }
  assert.deepEqual(imagePoint({ x: -50, y: 9999 }, { left: 0, top: 0, width: 800, height: 450 }, size), { x: 0, y: 900 });
  assert.equal(imagePoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, size), null, "an image not laid out marks nothing");
});

test("a drag becomes an area inside the image on whole pixels; a click does not", () => {
  assert.deepEqual(spanRegion(1, { x: 120.4, y: 80.6 }, { x: 20.2, y: 10.1 }, size), { id: 1, x: 20, y: 10, width: 100, height: 71, note: "" });
  assert.equal(spanRegion(2, { x: 5, y: 5 }, { x: 7, y: 40 }, size), null);
  assert.deepEqual(clampRegion({ id: 3, x: 1590, y: -20, width: 400, height: 50, note: "n".repeat(MAX_NOTE + 5) }, size),
    { id: 3, x: 1590, y: 0, width: 10, height: 50, note: "n".repeat(MAX_NOTE) });
  assert.deepEqual(centeredRegion(4, size), { id: 4, x: 600, y: 338, width: 400, height: 225, note: "" });
});

test("the annotated image stays within Core's 8192 px and 24 megapixels", () => {
  assert.equal(outputScale(size), 1);
  assert.equal(outputScale({ width: 16384, height: 1000 }), 0.5);
  const scale = outputScale({ width: 6000, height: 6000 });
  assert.ok(6000 * scale * 6000 * scale <= 24_000_000 && scale > 0.8);
});

test("the draft text names the source apart from the notes, each area numbered as drawn", () => {
  const text = feedbackText({
    name: "shot.png", provenance: "the file /work/shot.png in Mori’s conversation", size, original: true,
    regions: [{ id: 1, x: 10, y: 20, width: 50, height: 40, note: " Too tight " }, { id: 2, x: 0, y: 0, width: 5, height: 5, note: "" }],
  });
  assert.equal(text, [
    "Point & Fix feedback on “shot.png” (1600×900 px): 2 marked areas in the attached annotated image, with the original image attached.",
    "Source: the file /work/shot.png in Mori’s conversation",
    "",
    "1. Area at x 10, y 20, 50×40 px: Too tight",
    "2. Area at x 0, y 0, 5×5 px: (no comment)",
  ].join("\n"));
});

test("an original already in the draft is named by its place there, as pasted images often share a name", () => {
  const text = feedbackText({
    name: "image.png", provenance: "the image image.png you attached", original: { position: 3 },
    size: { width: 400, height: 300 }, regions: [{ id: 1, x: 1, y: 2, width: 30, height: 40, note: "Here" }],
  });
  assert.match(text, /^Point & Fix feedback on “image.png” \(400×300 px\): 1 marked area in the attached annotated image; the original is attached image 3 \(“image.png”\)\.\n/);
});

test("an annotated image reduced to fit says so, and which pixels the areas are in", () => {
  const text = feedbackText({
    name: "big.png", provenance: "an image you chose (big.png)", original: false,
    size: { width: 9000, height: 4000 }, annotated: { width: 7348, height: 3266 },
    regions: [{ id: 1, x: 3375, y: 1500, width: 2250, height: 1000, note: "Here" }],
  });
  assert.match(text, /^Point & Fix feedback on “big.png” \(9000×4000 px\): 1 marked area in the attached annotated image\.\n/);
  assert.match(text, /\nThe annotated image is reduced to 7348×3266 px; the areas below are in the original’s 9000×4000 pixels\.\n\n1\. Area at x 3375, y 1500, 2250×1000 px: Here$/);
});
