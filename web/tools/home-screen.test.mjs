// The Home Screen entry in the built UI (T-170, web/vite.config.ts): the page
// links a web app manifest and an apple-touch-icon at the root; the manifest
// is JSON with a stable id, start_url and scope, opens standalone and names no
// origin; every icon it names is a PNG in the build whose pixel size is the
// size it declares and whose bytes are the character art's, unchanged. What
// Core sends for these files (types, and the page for a missing one) is
// checked in core/src/updates/assets.rs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const built = (path) => new URL(path.replace(/^\//, ""), distUrl);
const index = await readFile(built("index.html"), "utf8");
const head = index.slice(0, index.indexOf("</head>"));
const links = (rel) => [...head.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
  .filter((tag) => new RegExp(`\\brel="${rel}"`).test(tag))
  .map((tag) => tag.match(/\bhref="([^"]*)"/)?.[1]);

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test("the page links one manifest and one apple-touch-icon, by root path", () => {
  assert.deepEqual(links("manifest"), ["/manifest.webmanifest"]);
  assert.deepEqual(links("apple-touch-icon"), ["/apple-touch-icon.png"]);
});

test("the manifest opens Yuzuno standalone at a stable id, start and scope, with no origin", async () => {
  const text = await readFile(built("/manifest.webmanifest"), "utf8");
  const manifest = JSON.parse(text);
  assert.equal(manifest.name, "Yuzuno");
  assert.equal(manifest.short_name, "Yuzuno");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.doesNotMatch(text, /:\/\//, "every URL is a path on whatever address Core is reached at");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, "it names its icons");
});

test("every icon is the character art, unchanged, at the pixel size it declares", async () => {
  const manifest = JSON.parse(await readFile(built("/manifest.webmanifest"), "utf8"));
  const art = await readFile(new URL("../src/assets/yuzu-character.png", import.meta.url));
  const named = [...manifest.icons.map((icon) => icon.src), ...links("apple-touch-icon")];
  for (const src of new Set(named)) {
    assert.match(src, /^\/[^/]/, `${src} is a root path`);
    const bytes = await readFile(built(src));
    assert.ok(bytes.equals(art), `${src} is src/assets/yuzu-character.png`);
  }
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.equal(pngSize(await readFile(built(icon.src))), icon.sizes, `${icon.src} is ${icon.sizes}`);
  }
});
