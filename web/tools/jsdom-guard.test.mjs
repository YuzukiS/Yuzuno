// The jsdom guard (T-29): when a jsdom test may run, that every test which
// loads jsdom asks first, and that asking first is enough. Decisions are
// checked on fixtures; no jsdom, DOM or real limit is needed here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_MEMORY_BYTES, cgroupLimits, verdict } from "./jsdom-limits.mjs";

const tools = dirname(fileURLToPath(import.meta.url));
const repo = resolve(tools, "../..");
const GiB = 1024 ** 3;

/** A reader of a fake /proc and /sys/fs/cgroup: path → text, else ENOENT. */
const files = (map) => (path) => {
  if (path in map) return map[path];
  throw Object.assign(new Error(`no ${path}`), { code: "ENOENT" });
};
const job = "/user.slice/app.slice/yuzuno-job-x.service";
const tree = (leaf, parent = { "memory.max": "max", "memory.swap.max": "max" }) => ({
  "/proc/self/cgroup": `0::${job}\n`,
  ...Object.fromEntries(Object.entries(leaf).map(([f, v]) => [`/sys/fs/cgroup${job}/${f}`, v])),
  ...Object.fromEntries(Object.entries(parent).map(([f, v]) => [`/sys/fs/cgroup/user.slice/app.slice/${f}`, v])),
  "/sys/fs/cgroup/user.slice/memory.max": "max",
});

test("a local run is allowed only under a confirmed limit of at most 4096 MiB with no swap", () => {
  const linux = (limits) => verdict({ platform: "linux", env: {}, limits });
  assert.equal(linux({ memory: MAX_MEMORY_BYTES, swap: 0 }).ok, true);
  assert.equal(linux({ memory: 2 * GiB, swap: 0 }).ok, true);
  for (const limits of [
    { memory: MAX_MEMORY_BYTES + 1, swap: 0 }, // larger than the cap
    { memory: 40 * GiB, swap: 0 }, // finite but the whole machine
    { memory: Infinity, swap: 0 }, // no RAM limit
    { memory: 2 * GiB, swap: Infinity }, // no swap limit
    { memory: 2 * GiB, swap: 1024 }, // any swap
    { error: "cannot read /proc/self/cgroup (EACCES)" },
    null,
  ]) {
    const { ok, why } = linux(limits);
    assert.equal(ok, false, JSON.stringify(limits));
    assert.match(why, /Linux Job limited to at most 4096 MiB with no swap, or let GitHub CI run them/);
  }
});

test("GitHub-hosted CI runs as before; a self-hosted runner or another platform must show a limit", () => {
  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  assert.equal(verdict({ platform: "linux", env: hosted, limits: { memory: Infinity, swap: Infinity } }).ok, true);
  assert.equal(verdict({ platform: "darwin", env: hosted, limits: null }).ok, true, "the macOS desktop job");
  for (const env of [{ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }, { GITHUB_ACTIONS: "true" }, { RUNNER_ENVIRONMENT: "github-hosted" }, { CI: "true" }]) {
    assert.equal(verdict({ platform: "linux", env, limits: { memory: Infinity, swap: Infinity } }).ok, false, JSON.stringify(env));
  }
  for (const platform of ["darwin", "win32"]) {
    const { ok, why } = verdict({ platform, env: {}, limits: null });
    assert.equal(ok, false);
    assert.match(why, new RegExp(`^${platform} has no cgroup v2 memory limit to confirm`));
  }
});

test("the tightest limit on the path from this process's cgroup to the root is the one that holds", () => {
  assert.deepEqual(cgroupLimits(files(tree({ "memory.max": "4294967296", "memory.swap.max": "0" }))), { memory: 4294967296, swap: 0 });
  // A parent's limit binds a child without one.
  assert.deepEqual(cgroupLimits(files(tree({ "memory.max": "max", "memory.swap.max": "max" }, { "memory.max": "2147483648", "memory.swap.max": "0" }))),
    { memory: 2147483648, swap: 0 });
  // No limit anywhere, or files that do not exist at all, is no limit.
  assert.deepEqual(cgroupLimits(files(tree({ "memory.max": "max", "memory.swap.max": "max" }))), { memory: Infinity, swap: Infinity });
  assert.deepEqual(cgroupLimits(files({ "/proc/self/cgroup": `0::${job}\n` })), { memory: Infinity, swap: Infinity });
  // What cannot be read or understood is refused, never taken as a limit.
  assert.match(cgroupLimits(files({})).error, /cannot read \/proc\/self\/cgroup \(ENOENT\)/);
  assert.match(cgroupLimits(files({ "/proc/self/cgroup": "12:memory:/x\n0::/x\n" })).error, /not in a cgroup v2 hierarchy alone/);
  assert.match(cgroupLimits(files({ "/proc/self/cgroup": "12:memory:/x\n" })).error, /not in a cgroup v2 hierarchy alone/);
  assert.match(cgroupLimits(files(tree({ "memory.max": "lots", "memory.swap.max": "0" }))).error, /unreadable .*memory\.max/);
});

// Every module a file loads, as written in it: static and dynamic imports
// and require(), the way these tests load jsdom.
function specifiers(source) {
  const found = [];
  for (const pattern of [/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}
function loadsJsdom(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return false;
  seen.add(file);
  for (const spec of specifiers(readFileSync(file, "utf8"))) {
    if (spec === "jsdom" || spec.startsWith("jsdom/")) return true;
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      for (const candidate of [target, `${target}.mjs`, `${target}.js`, `${target}.ts`, `${target}.tsx`])
        if (existsSync(candidate) && loadsJsdom(candidate, seen)) return true;
    }
  }
  return false;
}
const firstImport = (source) => source.match(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/m)?.[1];

test("every test that loads jsdom, directly or through what it imports, asks the guard first", () => {
  const entries = [
    ...readdirSync(tools).filter((f) => f.endsWith(".test.mjs")).map((f) => join(tools, f)),
    ...readdirSync(join(repo, "desktop/tests")).filter((f) => f.endsWith(".test.mjs")).map((f) => join(repo, "desktop/tests", f)),
  ];
  const guarded = entries.filter((file) => loadsJsdom(file));
  assert.ok(guarded.length >= 70, `jsdom entries found: ${guarded.length}`);
  assert.ok(guarded.includes(join(tools, "ui.test.mjs")) && guarded.includes(join(repo, "desktop/tests/connection.test.mjs")));
  const missing = guarded.filter((file) => {
    const first = firstImport(readFileSync(file, "utf8"));
    return !first || resolve(dirname(file), first) !== join(tools, "jsdom-guard.mjs");
  });
  assert.deepEqual(missing.map((file) => file.slice(repo.length + 1)), [], "the guard must be the first import");
  // The guard and its decisions load nothing that could bring jsdom in.
  for (const module of ["jsdom-guard.mjs", "jsdom-limits.mjs"])
    for (const spec of specifiers(readFileSync(join(tools, module), "utf8")))
      assert.ok(spec.startsWith("node:") || spec === "./jsdom-limits.mjs", `${module} imports ${spec}`);
});

test("a first import that ends the process runs before any later module, CommonJS or ESM, is evaluated", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsdom-guard-order-"));
  try {
    mkdirSync(join(dir, "node_modules/late-cjs"), { recursive: true });
    writeFileSync(join(dir, "node_modules/late-cjs/package.json"), JSON.stringify({ name: "late-cjs", main: "index.js" }));
    writeFileSync(join(dir, "node_modules/late-cjs/index.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "cjs-ran"))}, "");\nexports.loaded = true;\n`);
    writeFileSync(join(dir, "late.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "esm-ran"))}, "");\n`);
    writeFileSync(join(dir, "refuse.mjs"), `process.stderr.write("refused\\n");\nprocess.exit(2);\n`);
    writeFileSync(join(dir, "entry.mjs"), `import "./refuse.mjs";\nimport { loaded } from "late-cjs";\nimport "./late.mjs";\nconsole.log(loaded);\n`);
    const run = spawnSync(process.execPath, [join(dir, "entry.mjs")], { cwd: dir, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(existsSync(join(dir, "cjs-ran")), false, "the CommonJS module after it never ran");
    assert.equal(existsSync(join(dir, "esm-ran")), false, "nor the ESM one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing boolean assertion carries only the boolean, never the node it was about", () => {
  // A stand-in for a DOM node with React's fiber attached: large and cyclic.
  const node = { tagName: "DIV" };
  let fiber = { stateNode: node };
  node.__reactFiber$x = fiber;
  for (let i = 0; i < 2000; i++) fiber = fiber.return = { stateNode: node, child: fiber, memoizedProps: { i } };
  let thrown;
  try {
    assert.ok(!node, "the dialog does not reopen");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof assert.AssertionError);
  assert.equal(thrown.message, "the dialog does not reopen");
  assert.equal(thrown.actual, false);
  assert.ok(thrown.message.length < 100);
});
