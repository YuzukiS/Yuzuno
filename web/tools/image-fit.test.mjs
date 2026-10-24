// A photo too large for Core is made smaller in the browser before it is
// uploaded (T-170, web/src/image-fit.ts); anything Core takes as it is goes
// unchanged and is never decoded. The canvas itself is checked in Chromium by
// tools/photo-fit-check.mjs; here the decoder is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { FIT_SIDE, fitImage, fitsCore, fittedSize, imageSize, MAX_IMAGE_PIXELS } from "../src/image-fit.ts";
import { MAX_IMAGE_BYTES } from "../src/image-input.ts";

const u16 = (n) => [n >> 8, n & 0xff];
const le16 = (n) => [n & 0xff, n >> 8];
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32 = (n) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const png = (width, height) => new Uint8Array([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...ascii("IHDR"), ...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
// SOI, an APP1 (EXIF) segment, a DHT, then a start of frame (baseline C0 or progressive C2).
const jpeg = (width, height, frame = 0xc0) => new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe1, ...u16(16), ...ascii("Exif"), 0, 0, 1, 2, 3, 4, 5, 6, 7, 8,
  0xff, 0xc4, ...u16(5), 0, 1, 2,
  0xff, frame, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  0xff, 0xda, ...u16(8), 3, 1, 0, 2, 0x11,
]);
const riff = (chunk, body) => new Uint8Array([...ascii("RIFF"), ...le24(body.length + 12), 0, ...ascii("WEBP"), ...ascii(chunk), ...le24(body.length), 0, ...body]);
const webpLossy = (w, h) => riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const webpLossless = (w, h) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0]);
};
const webpExtended = (w, h) => riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]);
const file = (bytes, name, type, padTo = 0) =>
  new File(padTo > bytes.length ? [bytes, new Uint8Array(padTo - bytes.length)] : [bytes], name, { type });

test("the size is read from a PNG, JPEG or WebP header, without decoding", () => {
  assert.deepEqual(imageSize(png(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(jpeg(5712, 4284)), { width: 5712, height: 4284 });
  assert.deepEqual(imageSize(jpeg(8064, 6048, 0xc2)), { width: 8064, height: 6048 }, "progressive, after a DHT");
  assert.deepEqual(imageSize(webpLossy(1600, 1200)), { width: 1600, height: 1200 });
  assert.deepEqual(imageSize(webpLossless(5000, 4000)), { width: 5000, height: 4000 });
  assert.deepEqual(imageSize(webpExtended(9000, 3000)), { width: 9000, height: 3000 });
  for (const [bytes, what] of [
    [new Uint8Array(ascii("png-bytes")), "not an image"],
    [jpeg(5712, 4284).slice(0, 30), "a JPEG cut before its frame"],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xda, ...u16(8), 3, 1, 0, 2, 0x11]), "a JPEG whose scan starts before a frame"],
    [png(0, 10), "a zero width"],
  ])
    assert.equal(imageSize(bytes), null, what);
});

test("Core's limits: 10 MiB, 8192 px a side and 24 megapixels", () => {
  assert.equal(fitsCore({ width: 6000, height: 4000 }, MAX_IMAGE_BYTES), true);
  assert.equal(MAX_IMAGE_PIXELS, 24_000_000);
  assert.equal(fitsCore({ width: 6000, height: 4001 }, 1000), false, "one row over 24 MP");
  assert.equal(fitsCore({ width: 8193, height: 100 }, 1000), false, "a side over 8192");
  assert.equal(fitsCore({ width: 100, height: 100 }, MAX_IMAGE_BYTES + 1), false, "over 10 MiB");
  assert.equal(fitsCore({ width: 5712, height: 4284 }, 5_000_000), false, "an iPhone's default 24 MP photo");
});

test("a too-large image keeps its shape with the longer side at most 4096 px", () => {
  assert.equal(FIT_SIDE, 4096);
  assert.deepEqual(fittedSize({ width: 5712, height: 4284 }), { width: 4096, height: 3072 });
  assert.deepEqual(fittedSize({ width: 4284, height: 5712 }), { width: 3072, height: 4096 });
  assert.deepEqual(fittedSize({ width: 8064, height: 6048 }), { width: 4096, height: 3072 });
  assert.deepEqual(fittedSize({ width: 9000, height: 3000 }), { width: 4096, height: 1365 });
  assert.deepEqual(fittedSize({ width: 4000, height: 3000 }), { width: 4000, height: 3000 }, "never enlarged");
});

/** A stand-in for the browser's decoder that records what it was asked. */
function decoder(decoded, blobBytes = 2_000_000) {
  const calls = { opened: 0, jpeg: [], closed: 0 };
  const open = async () => {
    calls.opened++;
    return {
      ...decoded,
      jpeg: async (size, quality) => {
        calls.jpeg.push({ size, quality });
        return blobBytes === null ? null : new Blob([new Uint8Array(blobBytes)], { type: "image/jpeg" });
      },
      close: () => calls.closed++,
    };
  };
  return { open, calls };
}

test("an image Core takes, or one whose header is unknown, is sent as it is and never decoded", async () => {
  const { open, calls } = decoder({ width: 1, height: 1 });
  for (const original of [
    file(png(4032, 3024), "IMG_0001.png", "image/png", 3_000_000),
    file(jpeg(4000, 6000), "tall.jpg", "image/jpeg", 9_000_000),
    file(new Uint8Array(ascii("png-bytes")), "screen.png", "image/png"),
    file(new Uint8Array(ascii("<svg/>")), "x.svg", "image/svg+xml"),
  ])
    assert.equal(await fitImage(original, open), original, original.name);
  assert.equal(calls.opened, 0);
});

test("an iPhone's 24 MP photo is redrawn upright as a JPEG, its longer side 4096 px", async () => {
  // Held upright: stored 5712 × 4284 with an EXIF rotation, decoded 4284 × 5712.
  const { open, calls } = decoder({ width: 4284, height: 5712 });
  const original = file(jpeg(5712, 4284), "IMG_0042.JPG", "image/jpeg", 6_000_000);
  const sent = await fitImage(original, open);
  assert.notEqual(sent, original);
  assert.deepEqual(calls.jpeg, [{ size: { width: 3072, height: 4096 }, quality: 0.9 }]);
  assert.equal(sent.type, "image/jpeg");
  assert.equal(sent.name, "IMG_0042.jpg");
  assert.equal(sent.size, 2_000_000);
  assert.equal(calls.closed, 1);
});

test("a JPEG whose frame is past the first MiB is still measured, from the whole file", async () => {
  // Seventeen full-size APP1 segments of metadata before the frame.
  const app = [0xff, 0xe1, 0xff, 0xff, ...new Array(65533).fill(0)];
  const frame = jpeg(5712, 4284).slice(2);
  const bytes = new Uint8Array([0xff, 0xd8, ...Array.from({ length: 17 }, () => app).flat(), ...frame]);
  assert.ok(bytes.length > 1024 * 1024);
  const { open, calls } = decoder({ width: 5712, height: 4284 });
  await fitImage(file(bytes, "IMG_0099.JPG", "image/jpeg"), open);
  assert.deepEqual(calls.jpeg.map((c) => c.size), [{ width: 4096, height: 3072 }]);
});

test("an image over 10 MiB but small in pixels is re-encoded at its own size", async () => {
  const { open, calls } = decoder({ width: 4000, height: 3000 });
  const sent = await fitImage(file(png(4000, 3000), "scan.png", "image/png", MAX_IMAGE_BYTES + 1), open);
  assert.deepEqual(calls.jpeg.map((c) => c.size), [{ width: 4000, height: 3000 }]);
  assert.equal(sent.name, "scan.jpg");
});

test("when it cannot be made small enough, the reason names the image and nothing is sent", async () => {
  const big = () => file(jpeg(8064, 6048), "IMG_0048.JPG", "image/jpeg", 12_000_000);
  const over = decoder({ width: 8064, height: 6048 }, MAX_IMAGE_BYTES + 1);
  await assert.rejects(fitImage(big(), over.open), /IMG_0048\.JPG: still over 10 MiB/);
  assert.equal(over.calls.closed, 1);
  const none = decoder({ width: 8064, height: 6048 }, null);
  await assert.rejects(fitImage(big(), none.open), /IMG_0048\.JPG: too large to send/);
  await assert.rejects(fitImage(big(), async () => { throw new Error("no decoder"); }), /IMG_0048\.JPG: too large to send.*no decoder/);
});
