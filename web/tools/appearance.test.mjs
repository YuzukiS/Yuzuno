import test from "node:test";
import assert from "node:assert/strict";

// The Agent list choice in Appearance: saved with the others on this device
// and applied to the page root, where the rail's compact rules read it. A
// minimal page for appearance.ts: storage, the root element, no theme meta.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};
const styles = new Map();
const root = { dataset: {}, style: { setProperty: (name, value) => styles.set(name, value) } };
globalThis.document = { documentElement: root, querySelector: () => null };
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const { applyAppearance, readAppearance, saveAppearance } = await import("../src/appearance.ts");
const KEY = "yuzuno.appearance";

test("the Agent list is detailed until chosen; earlier saved choices keep theirs", () => {
  store.clear();
  assert.equal(readAppearance().agentList, "detailed");
  // Saved before the choice existed.
  store.set(KEY, JSON.stringify({ theme: "dark", fontSize: 18, palette: "pine" }));
  assert.deepEqual(readAppearance(), { theme: "dark", fontSize: 18, palette: "pine", agentList: "detailed", projectGroups: "headers",
    dock: { jobs: 5, actions: 2, subAgents: 5 }, turnDock: { numbers: 5, bars: 5 } });
  store.set(KEY, JSON.stringify({ theme: "dark", fontSize: 18, palette: "pine", agentList: "dense" }));
  assert.equal(readAppearance().agentList, "detailed", "an unknown value falls back");
});

test("project groups are headers until chosen; a choice is saved and marks the page root", () => {
  store.clear();
  assert.equal(readAppearance().projectGroups, "headers");
  store.set(KEY, JSON.stringify({ projectGroups: "tabs" }));
  assert.equal(readAppearance().projectGroups, "headers", "an unknown value falls back");
  for (const style of ["cards", "bands", "none", "headers"]) {
    saveAppearance({ ...readAppearance(), projectGroups: style });
    assert.equal(JSON.parse(store.get(KEY)).projectGroups, style);
    assert.equal(root.dataset.projectGroups, style);
  }
});

test("choosing compact saves it and marks the page root; detailed undoes it", () => {
  store.clear();
  saveAppearance({ ...readAppearance(), agentList: "compact" });
  assert.equal(JSON.parse(store.get(KEY)).agentList, "compact");
  assert.equal(root.dataset.agentList, "compact");
  assert.equal(readAppearance().agentList, "compact");
  saveAppearance({ ...readAppearance(), agentList: "detailed" });
  assert.equal(root.dataset.agentList, "detailed");
  // Applied on start from what was saved, before React mounts.
  store.set(KEY, JSON.stringify({ ...readAppearance(), agentList: "compact" }));
  applyAppearance(readAppearance());
  assert.equal(root.dataset.agentList, "compact");
});

test("text size is any whole px from 10 to 24; below 14 only conversation text shrinks", () => {
  store.clear();
  for (const size of [10, 13, 24]) {
    store.set(KEY, JSON.stringify({ fontSize: size }));
    assert.equal(readAppearance().fontSize, size);
  }
  for (const size of [9, 25, 15.5, "18"]) {
    store.set(KEY, JSON.stringify({ fontSize: size }));
    assert.equal(readAppearance().fontSize, 16, `${size} falls back`);
  }
  // Controls are sized as an offset from 13 px; the reading size is the text size.
  for (const [size, adjust] of [[10, "1px"], [14, "1px"], [16, "3px"], [24, "11px"]]) {
    applyAppearance({ ...readAppearance(), fontSize: size });
    assert.equal(styles.get("--font-adjust"), adjust, `controls at ${size}`);
    assert.equal(styles.get("--reading-size"), `${size}px`);
  }
});

test("the dock shows 5 jobs, 2 runs and 5 sub-agents until chosen; 0 is a choice, out of range falls back", () => {
  store.clear();
  assert.deepEqual(readAppearance().dock, { jobs: 5, actions: 2, subAgents: 5 });
  store.set(KEY, JSON.stringify({ dock: { jobs: 0, actions: 10, subAgents: 3 } }));
  assert.deepEqual(readAppearance().dock, { jobs: 0, actions: 10, subAgents: 3 });
  store.set(KEY, JSON.stringify({ dock: { jobs: -1, actions: 11, subAgents: 2.5 } }));
  assert.deepEqual(readAppearance().dock, { jobs: 5, actions: 2, subAgents: 5 }, "each falls back on its own");
  saveAppearance({ ...readAppearance(), dock: { jobs: 1, actions: 0, subAgents: 0 } });
  assert.deepEqual(JSON.parse(store.get(KEY)).dock, { jobs: 1, actions: 0, subAgents: 0 });
});

test("the turn dock numbers 5 turns with 5 bars each side until chosen; 0 numbered turns hides it", () => {
  store.clear();
  assert.deepEqual(readAppearance().turnDock, { numbers: 5, bars: 5 });
  store.set(KEY, JSON.stringify({ turnDock: { numbers: 0, bars: 10 } }));
  assert.deepEqual(readAppearance().turnDock, { numbers: 0, bars: 10 });
  store.set(KEY, JSON.stringify({ turnDock: { numbers: 13, bars: -1 } }));
  assert.deepEqual(readAppearance().turnDock, { numbers: 5, bars: 5 }, "each falls back on its own");
  store.set(KEY, JSON.stringify({ turnDock: { numbers: 12, bars: "3" } }));
  assert.deepEqual(readAppearance().turnDock, { numbers: 12, bars: 5 });
  saveAppearance({ ...readAppearance(), turnDock: { numbers: 3, bars: 0 } });
  assert.deepEqual(JSON.parse(store.get(KEY)).turnDock, { numbers: 3, bars: 0 });
});
