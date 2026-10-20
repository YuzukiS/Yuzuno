import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceReadShape } from "./review.mjs";

test("review source reads require explicit positive integer line ranges", () => {
  const schema = z.strictObject(sourceReadShape);
  const request = { path: "src/large.rs", revision: "head", startLine: 501, endLine: 700 };
  assert.deepEqual(schema.parse(request), request);
  assert.equal(schema.safeParse({ ...request, revision: "mergeBase" }).success, true);
  for (const bad of [
    { path: request.path, revision: "head" },
    { ...request, startLine: 0 },
    { ...request, endLine: 2.5 },
    { ...request, revision: "main" },
    { ...request, command: "cat file" },
  ]) assert.equal(schema.safeParse(bad).success, false);
});

const { sourceTools, reviewOptions, createReviewServer } = await import("./review.mjs");

test("search cursor defaults only when omitted; explicit continuations are preserved", () => {
  const shape = sourceTools.find(([name]) => name === "source_search")[2];
  const schema = z.strictObject(shape);
  const request = { revision: "head", query: "important_symbol", pathPrefix: "" };
  assert.deepEqual(schema.parse(request), { ...request, cursor: "0:1" });
  assert.deepEqual(schema.parse({ ...request, cursor: "12:99" }), { ...request, cursor: "12:99" });
  assert.equal(schema.safeParse({ ...request, cursor: null }).success, false);
  const advertised = z.toJSONSchema(schema, { io: "input" });
  assert.equal(advertised.required.includes("cursor"), false);
});

test("actual MCP requests forward original malformed arguments to Core but forbid other tools", async () => {
  const calls = [];
  const server = createReviewServer(async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ error: "Correct arguments", correction: { maxIdenticalFailures: 3 } }) }], isError: true };
  });
  // Exercise the SDK server's public transport, including tools/list, rather
  // than calling the handler directly or requiring a paid native model.
  let resolveResponse;
  const transport = { start: async () => {}, close: async () => {}, send: async (message) => resolveResponse?.(message) };
  await server.instance.connect(transport);
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    resolveResponse = resolve;
    transport.onmessage({ jsonrpc: "2.0", id: ++id, method, params });
  });
  try {
    const listed = await request("tools/list", {});
    const search = listed.result.tools.find((t) => t.name === "source_search");
    assert.equal(search.inputSchema.required.includes("cursor"), false);
    assert.equal(search.inputSchema.properties.cursor.default, "0:1");
    const original = { revision: "head", query: "symbol", pathPrefix: "" };
    const response = await request("tools/call", { name: "source_search", arguments: original });
    assert.equal(response.result.isError, true);
    assert.deepEqual(calls.pop(), { name: "source_search", args: original });
    for (const bad of [{}, { cursor: "bad" }, { query: 123, command: "unsafe" }]) {
      await request("tools/call", { name: "source_search", arguments: bad });
      assert.deepEqual(calls.pop(), { name: "source_search", args: bad });
    }
    const forbidden = await request("tools/call", { name: "shell", arguments: { command: "unsafe" } });
    assert.ok(forbidden.error);
    assert.equal(calls.length, 0);
  } finally {
    await server.instance.close();
  }
});
test("isolated review exposes only the five paginated source tools", () => {
  assert.deepEqual(sourceTools.map(([name]) => name), ["review_changes", "source_diff", "source_paths", "source_search", "source_read"]);
  for (const [name, , shape] of sourceTools) {
    assert.equal(z.strictObject(shape).safeParse({ command: "echo unsafe" }).success, false, name);
  }
  // CI deliberately has no installed native Claude. This test inspects options
  // without launching a runtime; provide only a discoverable inert executable.
  const directory = mkdtempSync(join(tmpdir(), "review-options-"));
  const previousPath = process.env.PATH;
  const outputSchema = { type: "object", properties: { priority: { type: "integer", enum: [0, 1, 2, 3] } } };
  let options;
  try {
    writeFileSync(join(directory, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    process.env.PATH = directory;
    options = reviewOptions({ cwd: "/tmp/review", model: "test", schema: outputSchema }, {}, new AbortController());
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.allowedTools, sourceTools.map(([name]) => `mcp__review__${name}`));
  assert.equal(options.maxTurns, 164);
  assert.equal(options.outputFormat.type, "json_schema");
  assert.strictEqual(options.outputFormat.schema, outputSchema, "forward Core's schema unchanged");
});
