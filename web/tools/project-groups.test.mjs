import test from "node:test";
import assert from "node:assert/strict";
import { NO_PROJECT_KEY, groupAgents, groupSummary, projectColour } from "../src/project-groups.ts";

// The Agent list by project while it shows All projects (T-82).
const project = (id, name, archivedAt = null) => ({ id, name, defaultDirs: {}, archivedAt, createdAt: "", updatedAt: "" });
const agent = (id, projectId, extra = {}) => ({
  id,
  name: id,
  projectId,
  status: "idle",
  pendingCount: 0,
  unreadCount: 0,
  closedAt: null,
  ...extra,
});
const projects = [project("p2", "Paper notes"), project("p1", "yuzuno-next"), project("old", "Old work", "2026-10-01")];

test("groups follow the project menu, then unlisted projects by name, then no project; each keeps the list's order", () => {
  const agents = [agent("a", null), agent("b", "p1"), agent("c", "old"), agent("d", "p2"), agent("e", "p1"), agent("f", "gone")];
  const groups = groupAgents(agents, projects);
  assert.deepEqual(
    groups.map((g) => [g.key, g.name, g.agents.map((a) => a.id), g.creatable]),
    [
      ["p2", "Paper notes", ["d"], true],
      ["p1", "yuzuno-next", ["b", "e"], true],
      ["old", "Old work", ["c"], false],
      ["gone", "Unknown project", ["f"], false],
      [NO_PROJECT_KEY, "No project", ["a"], true],
    ],
  );
  assert.equal(groups.at(-1).projectId, null);
  assert.equal(groups.at(-1).colour, null);
});

test("one group needs no heading: the list stays as it is", () => {
  assert.equal(groupAgents([agent("a", null), agent("b", null)], projects), null);
  assert.equal(groupAgents([agent("a", "p1"), agent("b", "p1")], projects), null);
  assert.equal(groupAgents([], projects), null);
  assert.equal(groupAgents([agent("a", "p1"), agent("b", null)], projects).length, 2);
});

test("a project's colour is the same every time, from its id", () => {
  assert.equal(projectColour("p1"), projectColour("p1"));
  assert.match(projectColour("p1"), /^#[0-9a-f]{6}$/);
  const groups = groupAgents([agent("a", "p1"), agent("b", "p2")], projects);
  assert.deepEqual(groups.map((g) => g.colour), [projectColour("p2"), projectColour("p1")]);
});

test("a folded group tells what waits, what runs and what is unread; closed Agents wait for nothing", () => {
  assert.deepEqual(
    groupSummary([
      agent("a", "p1", { pendingCount: 2, status: "waiting" }),
      agent("b", "p1", { status: "working", unreadCount: 3 }),
      agent("c", "p1", { unreadCount: 1 }),
      agent("d", "p1", { pendingCount: 4, closedAt: "2026-10-16" }),
    ]),
    { needs: 2, working: 1, unread: 2 },
  );
});
