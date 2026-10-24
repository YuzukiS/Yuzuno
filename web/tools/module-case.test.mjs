// Module names that differ only in case (T-170). Imports here carry no
// extension, and Vite tries .mjs, .js, .mts, .ts, .jsx, .tsx and .json in
// that order (vite.config.ts sets no resolve.extensions). On a disk that
// ignores case (macOS's default APFS, Windows), `./SubAgents` then opened
// `subagents.ts` before `SubAgents.tsx`, and the build failed with a missing
// export while Linux builds were fine. Two web/src modules whose paths,
// without the extension, differ only in case would do that again. It reads
// the files on disk, so it runs the same in a source copy without .git.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Vite's default resolve.extensions: the files an extensionless import can open.
const MODULES = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const src = fileURLToPath(new URL("../src/", import.meta.url));

async function modules(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await modules(path)));
    else if (MODULES.includes(extname(entry.name))) found.push(relative(src, path));
  }
  return found;
}

const stem = (file) => file.slice(0, -extname(file).length);

test("the build resolves extensionless imports with Vite's default extensions", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(config, /\bextensions\s*:/, "vite.config.ts sets resolve.extensions: update MODULES here to match");
});

test("no two web/src modules differ only in case", async () => {
  const files = await modules(src);
  assert.ok(files.length > 100, `only ${files.length} modules found under ${src}`);
  const byKey = new Map();
  for (const file of files) {
    const key = stem(file).toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const clashes = [...byKey.values()].filter((group) => new Set(group.map(stem)).size > 1).map((group) => group.sort());
  assert.deepEqual(clashes, [], `modules that differ only in case: ${clashes.map((group) => group.join(" and ")).join("; ")}`);
});
