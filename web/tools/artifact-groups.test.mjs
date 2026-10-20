import test from "node:test";
import assert from "node:assert/strict";
import { groupArtifacts } from "../src/artifact-groups.ts";

const file = (path, sourceItemId) => ({ path, sourceItemId, name: path.split("/").at(-1), kind: "text" });

test("an old artifact edited again in the latest Codex turn stays current across path forms", () => {
  const edited = file("src/App.tsx", "old-edit");
  const linked = file("report.md", "new-message");
  const old = file("archive.md", "old-message");
  const unknown = file("unknown.md");
  const turn = { id: "new", items: [
    { id: "new-edit", type: "fileChange", changes: [{ path: "/workspace/./src/App.tsx" }] },
    { id: "new-message", type: "agentMessage" },
  ] };
  assert.deepEqual(groupArtifacts([edited, old, linked, unknown], turn, "/workspace"), {
    latest: [edited, linked], history: [old, unknown],
  });
});

test("Claude completed writes count as recent; reads, pending edits and failed writes do not", () => {
  const artifacts = ["Write", "Edit", "MultiEdit", "Read", "pending", "failed"].map((name) => file(`/workspace/${name}.md`, "old"));
  const items = artifacts.map((a, i) => ({
    id: `new-${i}`, type: "claudeToolUse", name: i < 4 ? a.name.replace(".md", "") : "Write",
    status: i === 4 ? "inProgress" : i === 5 ? "failed" : "completed", input: { file_path: a.path },
  }));
  assert.deepEqual(groupArtifacts(artifacts, { id: "new", items }, "/workspace"), {
    latest: artifacts.slice(0, 3), history: artifacts.slice(3),
  });
});

test("a new turn without files never promotes files from the preceding turn", () => {
  const artifacts = [file("old.md", "old")];
  for (const turn of [undefined, { id: "latest", items: [] }]) {
    assert.deepEqual(groupArtifacts(artifacts, turn, "/workspace"), { latest: [], history: artifacts });
  }
  assert.deepEqual(groupArtifacts([], undefined, "/workspace"), { latest: [], history: [] });
});
