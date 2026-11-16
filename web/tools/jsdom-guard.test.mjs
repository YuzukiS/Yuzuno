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
import { describe, holdsDom, install } from "./jsdom-assert.mjs";

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
  // The guard, its decisions and its assertions load nothing that could bring jsdom in.
  for (const module of ["jsdom-guard.mjs", "jsdom-limits.mjs", "jsdom-assert.mjs"])
    for (const spec of specifiers(readFileSync(join(tools, module), "utf8")))
      assert.ok(spec.startsWith("node:") || ["./jsdom-limits.mjs", "./jsdom-assert.mjs"].includes(spec), `${module} imports ${spec}`);
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

// The guard's assertions (YN-196), on stand-ins: no jsdom is needed here.
// A DOM object is known by its WebIDL class names on the prototype chain.
const classed = (...names) => names.reduceRight((proto, name) => Object.create(proto, { [Symbol.toStringTag]: { value: name } }), Object.prototype);
const NODE = classed("HTMLLIElement", "HTMLElement", "Element", "Node", "EventTarget");
/** A rendered DOM node: React's fiber chain makes it large and cyclic. */
function renderedNode(tag = "li", attributes = { id: "zz", class: "row" }) {
  const node = Object.assign(Object.create(NODE), { nodeType: 1, nodeName: tag.toUpperCase(), localName: tag, getAttribute: (name) => attributes[name] ?? null });
  let fiber = { stateNode: node };
  node.__reactFiber$x = fiber;
  for (let i = 0; i < 2000; i++) fiber = fiber.return = { stateNode: node, child: fiber, memoizedProps: { i } };
  return node;
}
function failure(call) {
  try {
    call();
  } catch (error) {
    return error;
  }
  assert.fail("the assertion passed");
}
const firstFrame = (error) => error.stack.split("\n").find((line) => line.trimStart().startsWith("at ")) ?? "";

install();

test("a failing comparison names a DOM object in one short line instead of inspecting it", () => {
  const node = renderedNode();
  for (const [call, operator] of [
    [() => assert.equal(node, null, "row zz is gone"), "strictEqual"],
    [() => assert.strictEqual(node, undefined, "row zz is gone"), "strictEqual"],
    [() => assert.notEqual(node, node, "row zz is gone"), "notStrictEqual"],
    [() => assert.deepEqual([node], [], "row zz is gone"), "deepStrictEqual"],
    [() => assert.notDeepEqual({ row: node }, { row: node }, "row zz is gone"), "notDeepStrictEqual"],
  ]) {
    const error = failure(call);
    assert.ok(error instanceof assert.AssertionError, String(error).slice(0, 200));
    assert.ok(error.message.length < 500, `message length ${error.message.length}`);
    assert.match(error.message, /^row zz is gone/);
    assert.equal(error.operator, operator);
    assert.equal(typeof error.actual, "string");
    assert.ok(firstFrame(error).includes(import.meta.url), `the stack starts in the test: ${firstFrame(error)}`);
  }
  const unnamed = failure(() => assert.equal(node, null));
  assert.equal(unnamed.actual, '<li id="zz" class="row">');
  assert.equal(unnamed.expected, null);
  assert.match(unnamed.message, /^Expected values to be strictly equal:/);
  assert.ok(unnamed.message.includes('<li id="zz" class="row">'));
  assert.equal(failure(() => assert.deepEqual([node, node], [])).actual, 'Array(2) [<li id="zz" class="row">, <li id="zz" class="row">]');
  // Two different nodes that read alike still fail as different.
  assert.match(failure(() => assert.equal(node, renderedNode())).expected, /\(another object\)$/);
});

test("comparisons keep Node's own results, arguments and messages", () => {
  const node = renderedNode();
  const other = renderedNode("p", {});
  assert.equal(node, node);
  assert.notEqual(node, other);
  assert.deepEqual([node, NaN], [node, NaN]);
  failure(() => assert.deepEqual([node, 0], [node, -0]));
  assert.notDeepEqual([node, 0], [node, -0]);
  // Too few arguments are Node's error, not a pass (YN-196 review).
  for (const call of [() => assert.notEqual(node), () => assert.notDeepEqual(node), () => assert.equal(node)])
    assert.equal(failure(call).code, "ERR_MISSING_ARGS");
  // A message is taken as this Node takes it: text, a function, an Error, or an explicit undefined.
  const own = new TypeError("own");
  for (const message of ["row zz is gone", () => "lazy", own, undefined]) {
    const dom = failure(() => assert.equal(node, null, message));
    const plain = failure(() => assert.equal("x", null, message));
    assert.equal(dom.constructor, plain.constructor, String(message));
    assert.equal(dom.message.split("\n")[0], plain.message.split("\n")[0], String(message));
  }
  assert.equal(failure(() => assert.equal(node, null, own)), own);
  // Without a DOM object it is Node's own failure, stack included.
  const error = failure(() => assert.equal(1, 2));
  assert.equal(error.generatedMessage, true);
  assert.match(error.message, /^Expected values to be strictly equal:[\s\S]*1 !== 2/);
  assert.ok(firstFrame(error).includes(import.meta.url), `the stack starts in the test: ${firstFrame(error)}`);
});

test("finding a DOM object runs no getter and no Proxy trap", () => {
  let reads = 0;
  const count = () => ++reads;
  // A getter read early once made a failing comparison pass (YN-196 review):
  // it fails, as in Node, and looking for a DOM object read it not at all.
  let n = 0;
  const lazy = { get x() { return ++n; } };
  holdsDom(lazy);
  holdsDom({ wrapped: lazy });
  assert.equal(n, 0);
  failure(() => assert.deepEqual(lazy, { x: 2 }));
  const node = renderedNode();
  const sneaky = { get nodeType() { return count(); }, get window() { return count(); }, get child() { count(); return node; } };
  const trapped = new Proxy(node, { get: count, getPrototypeOf: () => (count(), NODE), ownKeys: () => (count(), []), getOwnPropertyDescriptor: count });
  for (const value of [sneaky, trapped, [trapped], new Proxy([node], { ownKeys: () => (count(), []) })]) assert.equal(holdsDom(value), false);
  // A Proxy further up the chain, as behind jsdom's Window.prototype, is not touched either.
  const traps = { get: count, getPrototypeOf: () => (count(), null), getOwnPropertyDescriptor: () => (count(), undefined), ownKeys: () => (count(), []) };
  const windowLike = Object.create(Object.create(new Proxy(classed("EventTarget"), traps), { [Symbol.toStringTag]: { value: "Window" } }));
  assert.equal(holdsDom(windowLike), true);
  assert.equal(describe(windowLike), "Window");
  assert.equal(reads, 0);
});

test("what counts as a DOM object, and how one is described", () => {
  const text = Object.assign(Object.create(classed("Text", "CharacterData", "Node")), { nodeType: 3, nodeName: "#text", data: "x".repeat(100) });
  const window = Object.create(classed("Window", "EventTarget"));
  assert.equal(holdsDom(text), true);
  assert.equal(holdsDom(window), true);
  assert.equal(holdsDom([1, renderedNode()]), true);
  assert.equal(holdsDom({ list: [renderedNode()] }), false, "only one level down");
  assert.equal(holdsDom({ nodeType: 1, nodeName: "LI" }), false, "a plain object that looks like one is not");
  assert.equal(describe(window), "Window");
  assert.equal(describe(text), `#text "${"x".repeat(39)}…"`);
  assert.equal(describe(Object.assign(Object.create(classed("Document", "Node")), { nodeType: 9, nodeName: "#document" })), "#document");
  assert.equal(describe(renderedNode("div", {})), "<div>");
  assert.equal(describe(null), "null");
});
