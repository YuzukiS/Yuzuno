import test from "node:test";
import assert from "node:assert/strict";
import { toolLabel } from "../src/conversation-blocks.ts";

// T-9: a tool call is named in its row by the tool it names. Codex MCP calls
// showed only their kind ("mcp Tool Call").
const mcp = (id, extra = {}) => ({ id, type: "mcpToolCall", status: "completed", ...extra });

test("an MCP call is named by its server and tool", () => {
  const items = [mcp("a", { server: "yuzuno", tool: "task_get" }), mcp("b", { server: "yuzuno", tool: "task_get" }),
    mcp("c", { server: "github", tool: "get_pr" })];
  assert.deepEqual(items.map((item) => toolLabel(item)), [
    { label: "yuzuno/task_get", named: true }, { label: "yuzuno/task_get", named: true }, { label: "github/get_pr", named: true }]);
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
});
