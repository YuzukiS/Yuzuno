import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-29 /diff: Git's diff of a Codex Agent's folder, read by Core where the
// Agent's Codex runs. The dialog is rendered alone against a fake Core whose
// read waits until a test answers it, as a real read can take seconds.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "codex-diff-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodexDiffDialog, diffLimits} from ${JSON.stringify(path.join(root, "src/CodexDiff.tsx"))};
import {diffFiles, gitPath, stagedLabel} from ${JSON.stringify(path.join(root, "src/codex-diff.ts"))};
import {changesLimits} from ${JSON.stringify(path.join(root, "src/changes.ts"))};
const root=createRoot(document.getElementById('root'));
Object.assign(window, {diffLimits, changesLimits, diffFiles, gitPath, stagedLabel});
window.renderDiff=(props)=>root.render(props ? <CodexDiffDialog {...props}/> : null);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, cssCodeSplit: false, lib: { entry, name: "CodexDiff", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output).find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = { id: "agent-1", name: "Dev", status: "idle", color: "sage", harness: "codex", cwd: "/work/app", lastSeq: 1, connectionState: "connected" };
const ready = { state: "ready", reason: "ready", generation: 7, cwd: "/work/app" };
const part = (text, extra = {}) => ({ text, complete: true, notUtf8: false, ...extra });
const read = (extra = {}) => ({
  state: "read", reason: "read", detail: null, generation: 7, cwd: "/work/app",
  tracked: part(""), staged: { entries: [], complete: true, error: null }, untracked: { files: [], listedAll: true, error: null },
  complete: true, stopped: null, bytes: 0, commands: 5, elapsedMs: 120, ...extra,
});
const PARSER = "diff --git a/src/parser.rs b/src/parser.rs\nindex 1111111..2222222 100644\n--- a/src/parser.rs\n+++ b/src/parser.rs\n@@ -1,2 +1,2 @@\n fn parse() {\n-    old();\n+    new();\n";
const QUOTED = 'diff --git "a/\\343\\203\\246 x.txt" "b/\\343\\203\\246 x.txt"\nindex 3333333..4444444 100644\n--- "a/\\343\\203\\246 x.txt"\t\n+++ "b/\\343\\203\\246 x.txt"\t\n@@ -1 +1,2 @@\n a\n+--- not a header\n';

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const calls = [];
  const signals = new Map();
  const events = [];
  // The target answers at once; each read waits for answer(body) or fail(status, error).
  let target = ready;
  const reads = [];
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    // Kept apart from the call, so the call stays plain data for deepEqual.
    signals.set(calls.length, init.signal);
    calls.push(call);
    if (call.method === "GET") return Promise.resolve(reply(target));
    if (call.method === "DELETE") return Promise.resolve(reply({ cancelled: true }));
    return new Promise((resolve) => reads.push(resolve));
  };
  window.eval(bundle);
  const text = () => window.document.querySelector('[role="dialog"]')?.textContent ?? "";
  return {
    window, document: window.document, calls, events, errors, text,
    /** Whether the request at this index was aborted by the dialog. */
    aborted: (index) => !!signals.get(index)?.aborted,
    setTarget: (next) => { target = next; },
    answer: async (body, index = reads.length - 1) => { reads[index](reply(body)); await tick(); },
    fail: async (status, error, index = reads.length - 1) => { reads[index](reply({ error }, status)); await tick(); },
    render: async (extra) => {
      window.renderDiff(extra === null ? null : { agent, open: true, onOpenChange: (open) => events.push(["open", open]), ...extra });
      await tick();
    },
    button: (name) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === name),
    close: () => window.close(),
  };
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message) {
  for (let n = 0; n < 200; n++) {
    const value = read();
    if (value) return value;
    await tick(10);
  }
  assert.fail(message);
}
const asked = (page) => page.calls.map((c) => `${c.method} ${c.url.replace("/api/agents/agent-1/codex/diff", "")}`);

test("it reads as soon as it opens: the target first, then one read bound to that connection and folder", async () => {
  const page = mount();
  try {
    await page.render({ agent: { ...agent, remote: { machine: { id: "m1", name: "build-box" } } } });
    await until(() => page.calls.length === 2, "the read");
    assert.deepEqual(asked(page), ["GET ", "POST "]);
    const { token, generation, cwd } = page.calls[1].body;
    assert.match(token, /^diff-[0-9a-f]{24}$/);
    assert.deepEqual({ generation, cwd }, { generation: 7, cwd: "/work/app" }, "the connection and folder it showed");
    assert.match(page.text(), /\/work\/app/);
    assert.match(page.text(), /On build-box, read with Git where this Agent's Codex runs/);
    await until(() => /Reading the folder…/.test(page.text()), "the read shown as running");
    assert.ok(page.button("Refresh").disabled, "no second read while one runs");
    await page.answer(read({ tracked: part(PARSER) }));
    assert.match(page.text(), /Changes not staged · 1 file/);
    assert.match(page.text(), /read at /);
    for (const internal of [/command\/exec/, /rev-parse/, /ls-files/, /processId/, /argv/, /--no-index/, /generation/]) {
      assert.doesNotMatch(page.text(), internal, "the target, scope and results only, never how they were read");
    }
    assert.deepEqual(asked(page), ["GET ", "POST "], "nothing else, and nothing again");
    await page.render({ agent });
    assert.equal(page.calls.length, 2, "a rerender reads nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("each part is shown as Git gave it: unstaged changes by file, staged names, untracked files and why one was not read", async () => {
  const page = mount();
  try {
    await page.render();
    await page.answer(read({
      tracked: part(PARSER + QUOTED),
      staged: { entries: [{ status: "M", path: "src/lib.rs", from: null }, { status: "R100", path: "new.rs", from: "old.rs" }], complete: true, error: null },
      untracked: { listedAll: false, error: null, files: [
        { path: "notes.txt", diff: part("diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n"), notRead: null },
        { path: "vendor/", diff: null, notRead: "nested_repository" },
        { path: "link-dir", diff: null, notRead: "exit 1: error: Could not access 'link-dir/null'" },
        { path: "z.txt", diff: null, notRead: "limit" },
      ] },
      complete: false,
    }));
    const unstaged = page.document.querySelector('section[aria-label="Changes not staged"]');
    assert.match(unstaged.textContent, /Changes not staged · 2 files/);
    assert.deepEqual([...unstaged.querySelectorAll(".changes-edit .changes-path")].map((p) => p.textContent), ["src/parser.rs", "ユ x.txt"],
      "names as Git wrote them, quoted bytes decoded");
    [...unstaged.querySelectorAll("button")].filter((b) => b.textContent === "Show").forEach((b) => b.click());
    await tick();
    const kinds = [...unstaged.querySelectorAll(".changes-lines")].map((pre) => [...pre.children].map((line) => line.dataset.line));
    assert.deepEqual(kinds[0], ["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add"]);
    assert.deepEqual(kinds[1], ["meta", "meta", "meta", "meta", "hunk", "ctx", "add"], "a removed-looking added line in a hunk stays added");
    const staged = page.document.querySelector('section[aria-label="Staged changes"]');
    assert.match(staged.textContent, /Staged changes, names only · 2 files/);
    assert.match(staged.textContent, /Modified src\/lib\.rs/);
    assert.match(staged.textContent, /Renamed \(100% similar\) old\.rs → new\.rs/);
    const untracked = page.document.querySelector('section[aria-label="Untracked files"]');
    assert.match(untracked.textContent, /A separate Git repository inside this folder; not read\./);
    assert.match(untracked.textContent, /Git couldn't read it: exit 1: error: Could not access 'link-dir\/null'/);
    assert.match(untracked.textContent, /Not read: this read shows at most 100 untracked files\./);
    assert.match(untracked.textContent, /There are more untracked files than this read lists\./);
    assert.equal(untracked.querySelectorAll("button").length, 1, "only the file that was read can be opened");
    assert.doesNotMatch(page.text(), /No changes here/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an empty result says what it covers, and staged changes are never called no changes", async () => {
  const page = mount();
  try {
    await page.render();
    await page.answer(read());
    assert.match(page.text(), /No changes here: nothing unstaged, nothing staged and no untracked files \(ignored files aren't listed\)\./);
    await page.render(null);
    await page.render();
    await page.answer(read({ staged: { entries: [{ status: "A", path: "added.rs", from: null }], complete: true, error: null } }));
    assert.doesNotMatch(page.text(), /No changes here/);
    assert.match(page.text(), /None: every change is staged \(listed below; their content isn't shown\)\./);
    assert.match(page.text(), /Added added\.rs/);
    await page.render(null);
    await page.render();
    await page.answer(read({ staged: { entries: [], complete: false, error: "timeout" }, untracked: { files: [], listedAll: false, error: "exit 128: fatal: bad index" }, complete: false }));
    assert.doesNotMatch(page.text(), /No changes here/, "a list Git could not give is not an empty list");
    assert.match(page.text(), /Staged changes, names only\s*Git couldn't list them: timeout/);
    assert.match(page.text(), /Untracked files\s*Git couldn't list them: exit 128: fatal: bad index/);
    await page.render(null);
    await page.render();
    await page.answer(read({ tracked: part(PARSER, { complete: false, notUtf8: true }), stopped: "budget", complete: false }));
    assert.match(page.text(), /The read stopped at its time limit \(30 seconds\); what was read by then is shown\./);
    assert.match(page.text(), /Git wrote more than this read keeps; only the start of the changes is shown\./);
    assert.match(page.text(), /Some bytes aren't UTF-8 text/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("with nothing to read on, nothing is read or connected; each reason it cannot read is said", async () => {
  const page = mount();
  try {
    page.setTarget({ state: "unavailable", reason: "not_connected", generation: null, cwd: "/work/app" });
    await page.render();
    await until(() => /isn't connected to Codex/.test(page.text()), "why");
    assert.match(page.text(), /doesn't connect by itself/);
    assert.deepEqual(asked(page), ["GET "], "no read without a connection");
    page.button("Refresh").click();
    await tick();
    assert.deepEqual(asked(page), ["GET ", "GET "], "Refresh looks again, and still reads nothing");
    page.setTarget(ready);
    for (const [answer, said] of [
      [read({ state: "unavailable", reason: "target_changed", tracked: null, staged: null, untracked: null }), /connection or folder changed just before the read, so nothing was read/],
      [read({ state: "unavailable", reason: "git_missing", tracked: null, staged: null, untracked: null }), /Git isn't available where this Agent's Codex runs/],
      [read({ state: "unavailable", reason: "platform", tracked: null, staged: null, untracked: null }), /doesn't read without one/],
      [read({ state: "not_repository", reason: "not_work_tree", tracked: null, staged: null, untracked: null, detail: "fatal: not a git repository" }), /isn't in a Git work tree[\s\S]*fatal: not a git repository/],
      [read({ state: "failed", reason: "dubious_ownership", tracked: null, staged: null, untracked: null, detail: "fatal: detected dubious ownership" }), /another user owns it[\s\S]*doesn't change that setting[\s\S]*Nothing is shown[\s\S]*dubious ownership/],
      [read({ state: "busy", reason: "busy", tracked: null, staged: null, untracked: null }), /already running/],
    ]) {
      await page.render(null);
      await page.render();
      await until(() => page.calls.at(-1).method === "POST", "the read");
      await page.answer(answer);
      assert.match(page.text(), said);
    }
    await page.render(null);
    await page.render();
    await until(() => page.calls.at(-1).method === "POST", "the read");
    await page.fail(400, "无效的读取标识");
    assert.match(page.text(), /Couldn't read the folder: 无效的读取标识/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("Cancel and Close stop this read only, by its token; an answer after Close is dropped", async () => {
  const page = mount();
  try {
    await page.render();
    await until(() => page.calls.length === 2, "the read");
    const token = page.calls[1].body.token;
    page.button("Cancel").click();
    await tick();
    assert.deepEqual(page.calls.at(-1), { url: `/api/agents/agent-1/codex/diff?token=${token}`, method: "DELETE", body: null });
    assert.ok(!page.aborted(1), "Cancel keeps waiting for what was read");
    await page.answer(read({ state: "cancelled", reason: "read", stopped: "cancelled", complete: false, untracked: null, tracked: part(PARSER) }));
    assert.match(page.text(), /You cancelled the read; what was read by then is shown\./);
    assert.match(page.text(), /Changes not staged · 1 file/);
    // Refresh: a new read, a new token.
    page.button("Refresh").click();
    await until(() => page.calls.at(-1).method === "POST", "the next read");
    const second = page.calls.at(-1).body.token;
    assert.notEqual(second, token);
    const secondPost = page.calls.length - 1;
    page.button("Close").click();
    await tick();
    assert.equal(page.calls.at(-1).url, `/api/agents/agent-1/codex/diff?token=${second}`, "Close cancels the read it started");
    assert.ok(page.aborted(secondPost), "and lets its request go, so Core ends a read the cancel came too early for");
    assert.deepEqual(page.events, [["open", false]]);
    await page.render(null);
    await page.answer(read({ tracked: part(PARSER) }));
    assert.equal(page.calls.filter((c) => c.method === "DELETE").length, 2, "nothing more");
    // Leaving without Close (another Agent selected) stops it too.
    await page.render();
    await until(() => page.calls.at(-1).method === "POST", "a read");
    const third = page.calls.at(-1).body.token;
    const thirdPost = page.calls.length - 1;
    await page.render(null);
    assert.equal(page.calls.at(-1).url, `/api/agents/agent-1/codex/diff?token=${third}`);
    assert.ok(page.aborted(thirdPost));
    // A finished read is not cancelled by Close.
    await page.answer(read());
    await page.render();
    await until(() => page.calls.at(-1).method === "POST", "a read");
    await page.answer(read());
    const before = page.calls.length;
    page.button("Close").click();
    await page.render(null);
    assert.equal(page.calls.length, before, "nothing to stop");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("long results are drawn in steps: files, then lines", async () => {
  const page = mount();
  const files = Array.from({ length: 5 }, (_, n) => `diff --git a/f${n}.rs b/f${n}.rs\n--- a/f${n}.rs\n+++ b/f${n}.rs\n@@ -1 +1 @@\n${Array.from({ length: 7 }, (_, l) => `+line ${l}`).join("\n")}\n`).join("");
  try {
    page.window.diffLimits.files = 2;
    Object.assign(page.window.changesLimits, { segmentLines: 4, maxLines: 8 });
    await page.render();
    await page.answer(read({ tracked: part(files) }));
    const unstaged = page.document.querySelector('section[aria-label="Changes not staged"]');
    assert.equal(unstaged.querySelectorAll(".changes-edit").length, 2);
    page.button("Show 2 more files (3 left)").click();
    await tick();
    assert.equal(unstaged.querySelectorAll(".changes-edit").length, 4);
    unstaged.querySelector(".changes-edit button").click();
    await tick();
    assert.equal(unstaged.querySelector(".changes-lines").children.length, 4);
    page.button("Show 4 more lines (7 left)").click();
    await tick();
    assert.equal(unstaged.querySelector(".changes-lines").children.length, 8);
    assert.match(unstaged.textContent, /The rest \(3 more lines\) is not shown here\./);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("Git's names and sections are read from its own headers", () => {
  const page = mount();
  try {
    const { gitPath, diffFiles, stagedLabel } = page.window;
    assert.equal(gitPath('"\\343\\203\\246 x.txt"'), "ユ x.txt");
    assert.equal(gitPath('"new\\nline \\"q\\".txt"'), 'new\nline "q".txt');
    assert.equal(gitPath("plain name.txt"), "plain name.txt");
    const whole = [
      "diff --git a/x y b/x y\nold mode 100644\nnew mode 100755\n",
      "diff --git a/bin.dat b/bin.dat\nindex 1..2 100644\nBinary files a/bin.dat and b/bin.dat differ\n",
      "diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-diff --git a/fake b/fake\n",
      "diff --git a/old.rs b/new.rs\nsimilarity index 90%\nrename from old.rs\nrename to new.rs\n",
    ].join("");
    const sections = diffFiles(whole);
    // Copied out of the page's realm: deepStrictEqual compares prototypes.
    assert.deepEqual([...sections].map((s) => s.path), ["x y", "bin.dat", "gone.rs", "new.rs"],
      "a removed line that reads like a header is content, not a new file");
    assert.equal([...sections].map((s) => s.text).join(""), whole, "every byte in one section, in order");
    assert.equal(stagedLabel("C75"), "Copied (75% similar)");
    assert.equal(stagedLabel("T"), "Type changed");
  } finally { page.close(); }
});
