// What a built UI was built from (YN-194, memo item 12(c)): one SHA-256 over
// the UI's sources, which every `vite build` with web/vite.config.ts writes
// into its output as source-digest.json. A test that reads a built UI checks
// it first, so a web/dist left from other sources (another branch, an older
// checkout, a build before the last edit) fails at once instead of testing
// code that is not the one under test. Nothing is ever rebuilt for it.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file a build writes beside index.html. */
export const DIGEST_FILE = "source-digest.json";
const web = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function files(root, prefix = "") {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

/** The digest of the sources under `root` (a web/ folder): each file of src/
 * and the build's own inputs, by path and content. */
export async function sourceDigest(root = web) {
  const paths = [
    ...(await files(join(root, "src"))).map((p) => join("src", p)),
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, sha256(await readFile(join(root, path)))])),
  );
  return sha256(JSON.stringify(hashes));
}

let current;
/** Refuses a built UI that was not built from this checkout's sources as
 * they are now, saying how to make one that is. Read once per process. */
export async function checkDist(dist) {
  current ??= sourceDigest();
  const want = await current;
  let stamp;
  try {
    stamp = JSON.parse(await readFile(join(dist, DIGEST_FILE), "utf8"));
  } catch {
    throw new Error(
      `${dist} has no ${DIGEST_FILE}: it was built before it was stamped, or not by web/vite.config.ts. Build it again from these sources (npm run build) before testing it.`,
    );
  }
  if (stamp?.sha256 !== want)
    throw new Error(
      `${dist} was built from other sources than this checkout's now (built ${String(stamp?.sha256).slice(0, 12)}, sources ${want.slice(0, 12)}). Build it again (npm run build) before testing it.`,
    );
}
