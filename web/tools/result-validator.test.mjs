// The generated validator Core runs (T-37): committed output matches its
// source, and the bundle works on its own, away from this checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generate, outputDir } from "./result-validator.mjs";
import { describeContract, SCHEMA_VERSION } from "../src/intelligent-ui/contract.ts";
import { comparisonExample } from "../src/intelligent-ui/examples.ts";

const committed = (name) => readFile(new URL(name, outputDir), "utf8");

test("the committed validator and contract are what the contract generates", async () => {
  const generated = await generate();
  for (const [name, content] of Object.entries(generated))
    assert.equal(await committed(name), content, `runtimes/result-validator/${name} is stale: npm run build:result-validator`);
  const contract = JSON.parse(generated["contract.json"]);
  // The Project Brief's part (T-85) is checked by brief-contract.test.mjs.
  const { validator, brief, ...described } = contract;
  assert.deepEqual(described, JSON.parse(JSON.stringify(describeContract())));
  assert.equal(typeof brief?.guide, "string");
  assert.equal(validator.sha256, createHash("sha256").update(generated["validator.mjs"]).digest("hex"));
});

test("the bundle runs alone, outside this checkout, and answers in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "result-validator-"));
  try {
    await copyFile(fileURLToPath(new URL("validator.mjs", outputDir)), join(dir, "validator.mjs"));
    const child = spawn(process.execPath, ["validator.mjs"], { cwd: dir, env: {}, stdio: ["pipe", "pipe", "inherit"] });
    const answers = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ask = async (line) => {
      child.stdin.write(`${line}\n`);
      return JSON.parse((await answers.next()).value);
    };
    const untitled = structuredClone(comparisonExample);
    delete untitled.elements.options.props.title;
    const accepted = await ask(JSON.stringify({ id: 1, spec: untitled }));
    assert.equal(accepted.id, 1);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.schemaVersion, SCHEMA_VERSION);
    assert.equal(accepted.spec.elements.options.props.title, "Table");
    assert.deepEqual(accepted.defaults, ["elements.options.props.title"]);
    const rejected = await ask(JSON.stringify({ id: 2, spec: { root: "r", elements: { r: { type: "Html", props: {} } } } }));
    assert.deepEqual(rejected, {
      id: 2, ok: false, schemaVersion: SCHEMA_VERSION,
      problems: [{ code: "unknown_component", reason: "Unknown or unsupported component type.", path: "elements.r.type" }],
    });
    assert.equal((await ask(JSON.stringify({ id: 3 }))).ok, false, "a missing spec is the Agent's problem");
    assert.deepEqual(await ask("not json"), { id: null, error: "unreadable request" });
    child.stdin.end();
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0, "exits when Core closes its input");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bundle accepts a Brief section it can repair, says how, and refuses one it cannot as sent (YN-14)", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("validator.mjs", outputDir))], { env: {}, stdio: ["pipe", "pipe", "inherit"] });
  const answers = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (request) => {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return JSON.parse((await answers.next()).value);
  };
  const section = (elements) => ({ key: "demo", kind: "report", title: "Demo",
    body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: Object.keys(elements) }, ...elements } } });
  const repaired = await ask({ id: 1, op: "briefSection", section: section({ log: { type: "Code", props: { code: "FAIL x" } } }) });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.deepEqual(repaired.normalized.body.elements.log, { type: "Markdown", props: { text: "```\nFAIL x\n```" } });
  assert.deepEqual(repaired.repairs.map((repair) => [repair.code, repair.path]), [["component_to_markdown", "body.elements.log"]]);
  const valid = await ask({ id: 2, op: "briefSection", section: section({ a: { type: "Markdown", props: { text: "A." } } }) });
  assert.deepEqual([valid.ok, valid.repairs], [true, []]);
  const refused = await ask({ id: 3, op: "briefSection", section: section({ f: { type: "Findings", props: { items: [{ id: "f1", severity: "low", text: "X." }] } } }) });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.problems.map((problem) => problem.code), ["missing_field"]);
  child.stdin.end();
  assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0);
});
