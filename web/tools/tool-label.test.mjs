import test from "node:test";
import assert from "node:assert/strict";
import { toolActivityCounts, toolLabel } from "../src/conversation-blocks.ts";

// T-9: a tool call is named the same way in its own row and in its group's
// summary. Codex MCP calls showed only their kind ("mcp Tool Call").
const mcp = (id, extra = {}) => ({ id, type: "mcpToolCall", status: "completed", ...extra });

test("an MCP call is named by its server and tool, in its row and its group's summary alike", () => {
  const items = [mcp("a", { server: "yuzuno", tool: "task_get" }), mcp("b", { server: "yuzuno", tool: "task_get" }),
    mcp("c", { server: "github", tool: "get_pr" })];
  assert.deepEqual(items.map((item) => toolLabel(item)), [
    { label: "yuzuno/task_get", named: true }, { label: "yuzuno/task_get", named: true }, { label: "github/get_pr", named: true }]);
  const counts = toolActivityCounts(items);
  assert.deepEqual(counts.map(({ label, count }) => [label, count]), [["yuzuno/task_get", 2], ["github/get_pr", 1]]);
  for (const item of items) assert.ok(counts.some(({ label }) => label === toolLabel(item).label));
  // A tool's own name stays as the harness gives it, in either language.
  assert.deepEqual(toolLabel(items[0], "zh-Hans"), { label: "yuzuno/task_get", named: true });
});

test("a call that names no tool is named by its kind", () => {
  assert.deepEqual(toolLabel(mcp("s", { server: "yuzuno" })), { label: "MCP tool", named: false });
  assert.deepEqual(toolLabel(mcp("e"), "zh-Hans"), { label: "MCP 工具", named: false });
  // Only strings name a tool.
  assert.deepEqual(toolLabel(mcp("n", { server: 3, tool: { name: "x" } })), { label: "MCP tool", named: false });
  assert.deepEqual(toolLabel({ id: "w", type: "webSearch" }), { label: "Web search", named: false });
  assert.deepEqual(toolLabel({ id: "u", type: "someNewCall" }), { label: "Some New Call", named: false });
  assert.deepEqual(toolLabel({ id: "d", type: "dynamicToolCall", tool: "lookup" }), { label: "lookup", named: true });
  // Calls of one kind that name no tool still count apart by server, as before.
  assert.deepEqual(toolActivityCounts([mcp("s1", { server: "a" }), mcp("s2", { server: "b" })]).map(({ label, count }) => [label, count]),
    [["MCP tool", 1], ["MCP tool", 1]]);
});
