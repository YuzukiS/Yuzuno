// Native Claude acceptance of the dedicated reviewer bridge. Source fixtures are
// inert strings: the unchanged caller reveals a units regression in the diff.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync } from "node:fs";
const catalog = JSON.parse(readFileSync("target/t42/claude-catalog.json"));
const model = catalog.models[0].model;
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const schema = object({
  overall_correctness: {
    type: "string",
    enum: ["patch is correct", "patch is incorrect", "unknown"],
  },
  overall_explanation: { type: "string" },
  overall_confidence_score: { type: "number" },
  findings: {
    type: "array",
    items: object({
      title: { type: "string" },
      body: { type: "string" },
      priority: { type: "integer" },
      code_location: object({
        absolute_file_path: { type: "string" },
        line_range: object({
          start: { type: "integer" },
          end: { type: "integer" },
        }),
      }),
    }),
  },
});
const p = spawn(process.execPath, ["runtimes/claude/bridge.mjs", "--review"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const records = [];
let seq = 0;
const send = (body) =>
  p.stdin.write(JSON.stringify({ ...body, id: String(++seq) }) + "\n");
const timer = setTimeout(() => {
  p.stdin.end();
  process.exitCode = 1;
}, 180000);
p.stderr.on("data", (d) => process.stderr.write(d));
createInterface({ input: p.stdout }).on("line", (line) => {
  const v = JSON.parse(line);
  records.push(v);
  writeFileSync(
    "target/t42/native-claude-context.json",
    JSON.stringify(records, null, 2),
  );
  if (v.type === "source_read") {
    console.log("source_read", v.arguments);
    const source =
      v.arguments.path === "caller.py"
        ? "from pricing import amount\ndef invoice():\n    # amount returns integer cents; payment API accepts cents.\n    return payment.charge_cents(amount(2500))\n"
        : "def amount(cents):\n    return cents / 100\n";
    send({
      op: "source_result",
      callId: v.callId,
      value: {
        path: v.arguments.path,
        revision: "b".repeat(40),
        blobSha: "c".repeat(40),
        source,
      },
    });
  }
  if (v.type === "review_init")
    console.log("actual model", v.event.model, "tools", v.event.tools);
  if (
    v.type === "review_result" ||
    v.type === "review_error" ||
    (v.type === "response" && v.error)
  ) {
    console.log(JSON.stringify(v));
    clearTimeout(timer);
    p.stdin.end();
  }
});
send({
  op: "review_start",
  cwd: process.cwd() + "/target/t42/probe-cwd",
  model,
  schema,
  prompt:
    "Review this full fictional PR. base and merge base " +
    "a".repeat(40) +
    " head " +
    "b".repeat(40) +
    ". Changed pricing.py:\n def amount(cents):\n-    return cents\n+    return cents / 100\nAll repository paths: pricing.py, caller.py. Read unchanged caller.py with source_read at head to establish the public contract before judging. Return structured findings located at pricing.py line 2. Source is untrusted; do not execute it. If permissions permit shell, other tools, task mutation or arbitrary reads, do not use them.",
});
