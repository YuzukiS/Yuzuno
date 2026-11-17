// YN-194 (memo item 12(c)): a built UI says what it was built from, and a
// test of it refuses one built from other sources.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIGEST_FILE, checkDist, sourceDigest } from "./source-digest.mjs";

async function folder(files) {
  const root = await mkdtemp(join(tmpdir(), "yn194-digest-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const sources = { "src/main.tsx": "a", "src/deep/b.ts": "b", "index.html": "<html>", "package.json": "{}",
  "package-lock.json": "{}", "tsconfig.json": "{}", "vite.config.ts": "export default {}" };

test("the digest follows every source file, by path and content, and nothing else", async () => {
  const root = await folder(sources);
  try {
    const first = await sourceDigest(root);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await sourceDigest(root), first, "stable");
    await writeFile(join(root, "dist-or-other.txt"), "not a source");
    assert.equal(await sourceDigest(root), first, "files outside the sources do not count");
    await writeFile(join(root, "src/deep/b.ts"), "changed");
    const edited = await sourceDigest(root);
    assert.notEqual(edited, first, "a changed source counts");
    await writeFile(join(root, "src/deep/c.ts"), "new");
    assert.notEqual(await sourceDigest(root), edited, "a new source counts");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a built UI of these sources passes; one without a stamp or from other sources is refused, saying how to fix it", async () => {
  const dist = await folder({ "index.html": "<html>" });
  try {
    await assert.rejects(checkDist(dist), (e) => e.message.includes(`has no ${DIGEST_FILE}`) && e.message.includes("npm run build"));
    await writeFile(join(dist, DIGEST_FILE), JSON.stringify({ schema: 1, sha256: "0".repeat(64) }));
    await assert.rejects(checkDist(dist), (e) => e.message.includes("built from other sources") && e.message.includes("npm run build"));
    await writeFile(join(dist, DIGEST_FILE), JSON.stringify({ schema: 1, sha256: await sourceDigest() }));
    await checkDist(dist);
  } finally { await rm(dist, { recursive: true, force: true }); }
});
