// YN-221 S6: the build's Brotli copies of /assets files (tools/precompress.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { MIN_BYTES, precompress } from "./precompress.mjs";

function assets() {
  const dir = mkdtempSync(join(tmpdir(), "yn221-br-"));
  const text = "export const words = [" + Array.from({ length: 400 }, (_, i) => `"word${i % 37}"`).join(",") + "];\n";
  writeFileSync(join(dir, "index-BtvMAyW4.js"), text);
  writeFileSync(join(dir, "index-BmJSJ4yL.css"), "body{margin:0}\n".repeat(200));
  writeFileSync(join(dir, "icon-AbCdEfGh.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${"<path d='M0 0'/>".repeat(100)}</svg>`);
  writeFileSync(join(dir, "small-AbCdEfGh.js"), "x".repeat(MIN_BYTES - 1));
  writeFileSync(join(dir, "font-AbCdEfGh.woff2"), "w".repeat(4096));
  writeFileSync(join(dir, "art-AbCdEfGh.png"), "p".repeat(4096));
  writeFileSync(join(dir, "noise-AbCdEfGh.txt"), randomBytes(4096));
  return dir;
}

test("scripts, styles and SVG of 1 KiB or more get a Brotli copy that decodes to them, the same each time", () => {
  const dir = assets();
  try {
    const written = precompress(dir);
    assert.deepEqual(written.map((w) => w.name), ["icon-AbCdEfGh.svg", "index-BmJSJ4yL.css", "index-BtvMAyW4.js"]);
    for (const { name, bytes, compressed } of written) {
      const br = readFileSync(join(dir, `${name}.br`));
      assert.equal(br.length, compressed);
      assert.ok(compressed < bytes, name);
      assert.deepEqual(brotliDecompressSync(br), readFileSync(join(dir, name)), name);
    }
    const first = Object.fromEntries(written.map(({ name }) => [name, readFileSync(join(dir, `${name}.br`))]));
    precompress(dir);
    for (const [name, br] of Object.entries(first)) assert.deepEqual(readFileSync(join(dir, `${name}.br`)), br, `${name} again`);
    // Too small, a font or image, and text that does not get smaller: none.
    const copies = readdirSync(dir).filter((n) => n.endsWith(".br")).sort();
    assert.deepEqual(copies, ["icon-AbCdEfGh.svg.br", "index-BmJSJ4yL.css.br", "index-BtvMAyW4.js.br"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
