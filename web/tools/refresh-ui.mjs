// Build and check away from the daily assets, then switch index.html last.
// No network requests, Core processes, database access, or window operations.
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const web = fileURLToPath(new URL("../", import.meta.url));
const daily = join(web, "dist");
const digest = (data) => createHash("sha256").update(data).digest("hex");
async function files(root, prefix = "") {
  const result = [];
  for (const entry of (
    await readdir(join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function hashes(root, paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        digest(await readFile(join(root, path))),
      ]),
    ),
  );
}
async function sourceHash() {
  const paths = [
    ...(await files(join(web, "src"))).map((p) => join("src", p)),
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
  ];
  return digest(JSON.stringify(await hashes(web, paths)));
}
function run(script, args, dist) {
  const result = spawnSync(process.execPath, [join(web, script), ...args], {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, YUZUNO_UI_DIST: dist },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${script} failed; daily UI was not changed.`);
}
async function stage() {
  const dist = await mkdtemp(join(tmpdir(), "yuzuno-ui-"));
  const previousIndex = await readFile(join(daily, "index.html"));
  const source = await sourceHash();
  run("node_modules/typescript/bin/tsc", ["--noEmit"], dist);
  run(
    "node_modules/vite/bin/vite.js",
    ["build", "--outDir", dist, "--emptyOutDir"],
    dist,
  );
  run("tools/create-preview.mjs", [], dist);
  run("tools/ui.test.mjs", [], dist);
  run("tools/projects-ui.test.mjs", [], dist);
  if (source !== (await sourceHash()))
    throw new Error(
      `UI source changed during validation. Build again. Staged files: ${dist}`,
    );
  const outputs = await hashes(dist, await files(dist));
  await writeFile(
    join(dist, ".refresh-ui.json"),
    JSON.stringify(
      { source, previousIndex: digest(previousIndex), outputs },
      null,
      2,
    ),
  );
  await writeFile(join(dist, ".previous-index.html"), previousIndex);
  console.log(`Validated UI staged at ${dist}`);
  return dist;
}
async function atomicCopy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  const temporary = `${to}.refresh-${process.pid}`;
  await cp(from, temporary);
  await rename(temporary, to);
}
async function publish(dist) {
  dist = resolve(dist);
  if (dist === daily)
    throw new Error("Publish requires an isolated staged build.");
  const manifest = JSON.parse(
    await readFile(join(dist, ".refresh-ui.json"), "utf8"),
  );
  if (manifest.source !== (await sourceHash()))
    throw new Error("UI source changed since validation. Stage again.");
  const paths = Object.keys(manifest.outputs);
  if (
    !paths.includes("index.html") ||
    paths.some(
      (p) =>
        p.includes("..") ||
        !(
          p === "index.html" ||
          p === "design-preview.html" ||
          p.startsWith("assets/")
        ),
    )
  )
    throw new Error("Unexpected staged output paths.");
  if (
    JSON.stringify(manifest.outputs) !==
    JSON.stringify(await hashes(dist, paths))
  )
    throw new Error("Staged files changed after validation.");
  const lock = join(daily, ".refresh-lock");
  await mkdir(lock);
  try {
    if (
      digest(await readFile(join(daily, "index.html"))) !==
      manifest.previousIndex
    )
      throw new Error("Another publisher changed the daily UI. Stage again.");
    // Keep old hashed assets for already-open windows and an index rollback.
    for (const path of paths.filter((p) => p !== "index.html"))
      await atomicCopy(join(dist, path), join(daily, path));
    await atomicCopy(join(dist, "index.html"), join(daily, "index.html"));
  } finally {
    await rm(lock, { recursive: true });
  }
  console.log(
    `Daily UI updated. Refresh the existing window. Previous index: ${dist}/.previous-index.html`,
  );
}

const args = process.argv.slice(2);
if (args[0] === "--publish" && args.length === 2) await publish(args[1]);
else if (
  args.length === 0 ||
  (args.length === 1 && args[0] === "--stage-only")
) {
  const dist = await stage();
  if (!args.length) await publish(dist);
} else
  throw new Error(
    "Usage: node tools/refresh-ui.mjs [--stage-only | --publish STAGED_DIRECTORY]",
  );
