// T-91: a context read is labelled by what it was, and shown as failed only
// when its retained receipt has an error. Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { describeRead } from "../src/review-reads.ts";

const merge = "c40b8367d2dd0f7882e6265cceb3abd5dfb309e7";
const head = "81e4faed657cbe453f2d357655ecb91632c2e3b5";

test("successful reads without a single path or revision are named by their tool, not as failures", () => {
  // Receipt shapes as Core retains them (T-86 review 7795a1e9).
  assert.deepEqual(describeRead({ tool: "review_changes", requested: { cursor: 0 }, totalFiles: 11, nextCursor: null, comparison: `${merge}..${head}` }),
    { label: "Changed files (11)", version: "c40b8367..81e4faed", error: null });
  assert.deepEqual(describeRead({ tool: "source_paths", requested: { cursor: 0, query: "codex", revision: "head" }, revision: head, nextCursor: 294 }),
    { label: 'Path list matching "codex"', version: "81e4faed", error: null });
  assert.deepEqual(describeRead({ tool: "source_search", requested: { query: "enabled_tools", pathPrefix: "core/src", revision: "head" }, revision: head, query: "enabled_tools", pathPrefix: "core/src", searchedFilesThisPage: 8, skipped: [] }),
    { label: 'Search "enabled_tools" in core/src', version: "81e4faed", error: null });
});

test("file reads name their file and part, at the fixed revision", () => {
  assert.deepEqual(describeRead({ tool: "source_diff", path: "core/src/results.rs", revision: head, offset: 0, endOffset: 11705, totalBytes: 11705 }),
    { label: "Diff core/src/results.rs, bytes 0–11705 of 11705", version: "81e4faed", error: null });
  assert.deepEqual(describeRead({ tool: "source_read", path: "core/src/collaboration_mcp.rs", revision: head, startLine: 170, endLine: 260 }),
    { label: "Source core/src/collaboration_mcp.rs, lines 170–260", version: "81e4faed", error: null });
});

test("only a receipt with an error is a failure, and it keeps what was asked", () => {
  assert.deepEqual(describeRead({ tool: "source_search", error: "Review context budget exhausted (160 calls / 1.5 MB)", kind: "source_unavailable", requested: { query: "claude_runtime", pathPrefix: "core/src", revision: "head" }, coverageIncomplete: true }),
    { label: 'Search "claude_runtime" in core/src', version: null, error: "Review context budget exhausted (160 calls / 1.5 MB)" });
});

test("older receipts with only path and revision show what they name, and guess nothing", () => {
  assert.deepEqual(describeRead({ path: "web/src/App.tsx", revision: head, blobSha: "f".repeat(40) }),
    { label: "web/src/App.tsx", version: "81e4faed", error: null });
  assert.deepEqual(describeRead({ path: "web/src/App.tsx", error: "File not in fixed revision" }),
    { label: "web/src/App.tsx", version: null, error: "File not in fixed revision" });
  assert.deepEqual(describeRead({}), { label: "Context read", version: null, error: null });
  // A tool this version does not know yet is named, not labelled as failed.
  assert.deepEqual(describeRead({ tool: "source_blame", revision: head }), { label: "source_blame", version: "81e4faed", error: null });
});

test("an actual empty source read is labelled as empty, not lines 1 to 0", () => {
  assert.deepEqual(describeRead({ tool: "source_read", path: "empty.rs", revision: head,
    startLine: 1, endLine: 0, totalLines: 0 }),
    { label: "Source empty.rs, empty file", version: "81e4faed", error: null });
});

test("in Chinese a read's own words follow; paths, queries, tools and errors stay as written (T-189)", () => {
  assert.deepEqual(describeRead({ tool: "review_changes", totalFiles: 11, comparison: `${merge}..${head}` }, "zh-Hans"),
    { label: "变更文件（11）", version: "c40b8367..81e4faed", error: null });
  assert.equal(describeRead({ tool: "source_paths", query: "codex", revision: head }, "zh-Hans").label, "匹配“codex”的路径列表");
  assert.equal(describeRead({ tool: "source_search", query: "enabled_tools", pathPrefix: "core/src", revision: head }, "zh-Hans").label,
    "在 core/src 中搜索“enabled_tools”");
  assert.equal(describeRead({ tool: "source_diff", path: "web/src/App.tsx", offset: 0, endOffset: 4096, totalBytes: 9000, revision: head }, "zh-Hans").label,
    "web/src/App.tsx 的 diff，字节 0–4096（共 9000）");
  assert.deepEqual(describeRead({ tool: "source_read", path: "core/src/lib.rs", startLine: 1, endLine: 40, revision: head }, "zh-Hans"),
    { label: "源文件 core/src/lib.rs，第 1–40 行", version: "81e4faed", error: null });
  assert.deepEqual(describeRead({ tool: "source_read", error: "Line range is outside the file", requested: { path: "core/src/lib.rs", startLine: 9000, endLine: 9100 } }, "zh-Hans"),
    { label: "源文件 core/src/lib.rs", version: null, error: "Line range is outside the file" });
  assert.equal(describeRead({ tool: "source_read", path: "empty.txt", totalLines: 0, revision: head }, "zh-Hans").label, "源文件 empty.txt，空文件");
  assert.equal(describeRead({ tool: "future_tool" }, "zh-Hans").label, "future_tool");
  assert.equal(describeRead({}, "zh-Hans").label, "上下文读取");
  // English stays the default.
  assert.equal(describeRead({ tool: "review_changes", totalFiles: 2 }).label, "Changed files (2)");
});
