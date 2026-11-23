// YN-221 S6: the built UI's /assets files, also as Brotli (`<name>.br`), for
// Core to send to a browser that accepts br (core/src/updates/assets.rs).
// Only text a browser fetches (scripts, styles, SVG, JSON, text) of at least
// MIN_BYTES: below that a header costs as much as compression saves. A file
// compression does not make smaller gets none. Quality 11 with text mode and
// the file's size as hint: the same input and Node version give the same
// bytes, which a release needs from both of its builds (tools/core-release.py).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

export const COMPRESSED = new Set([".js", ".css", ".svg", ".json", ".txt"]);
export const MIN_BYTES = 1024;

export function brotli(data) {
  return brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
}

/** Writes `<name>.br` beside each file of `dir` that is worth it; returns
 * what it wrote, `{name, bytes, compressed}`, by name. */
export function precompress(dir) {
  const written = [];
  for (const name of readdirSync(dir).sort()) {
    if (!COMPRESSED.has(extname(name))) continue;
    const data = readFileSync(join(dir, name));
    if (data.length < MIN_BYTES) continue;
    const compressed = brotli(data);
    if (compressed.length >= data.length) continue;
    writeFileSync(join(dir, `${name}.br`), compressed);
    written.push({ name, bytes: data.length, compressed: compressed.length });
  }
  return written;
}

/** The name Core reads to know which /assets files are fingerprinted
 * (core/src/updates/assets.rs IMMUTABLE_LIST). */
export const IMMUTABLE_LIST = "immutable-assets.json";

/** Writes, at the built UI's root, the files the build emitted into
 * /assets under Vite's `[name]-[hash]` naming (`emitted`: the bundle's file
 * names), sorted: only these may be kept a year. A file in /assets the list
 * does not name, such as one copied there with a fixed name, is asked again. */
export function writeImmutableList(root, emitted) {
  const files = [...new Set(emitted.filter((f) => f.startsWith("assets/")).map((f) => f.slice("assets/".length)))].sort();
  writeFileSync(join(root, IMMUTABLE_LIST), `${JSON.stringify({ schema: 1, files })}\n`);
  return files;
}
