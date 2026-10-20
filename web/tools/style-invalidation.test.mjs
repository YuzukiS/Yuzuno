// T-18: a :has() rule that reaches every descendant ("X:has(…) *") makes the
// browser re-style that whole subtree whenever anything inside might change
// what :has() matches — every keystroke and streamed line, when X is .app.
// State that must reach everything goes on a class instead.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));

test("no :has() rule restyles every descendant", async () => {
  const offenders = [];
  const files = (await readdir(src, { recursive: true })).filter((name) => name.endsWith(".css"));
  // Folders such as intelligent-ui/ hold stylesheets too.
  assert.ok(files.some((name) => name.includes(path.sep)), "nested stylesheets are read");
  for (const file of files) {
    const css = (await readFile(path.join(src, file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of css.split("{")) {
      const selectors = block.split("}").pop().split(",").map((s) => s.trim());
      for (const selector of selectors) {
        // A universal descendant (or child) after a :has() compound.
        if (/:has\(.*\)[^,]*[\s>]\*(?![\w-])/.test(selector)) offenders.push(`${file}: ${selector}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
