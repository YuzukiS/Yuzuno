import test from "node:test";
import assert from "node:assert/strict";

// The Agent list choice in Appearance: saved with the others on this device
// and applied to the page root, where the rail's compact rules read it. A
// minimal page for appearance.ts: storage, the root element, no theme meta.
const store = new Map();
// A write the browser refuses, as it does when storage is full or blocked.
let refuse = null;
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    if (refuse) throw refuse;
    store.set(key, String(value));
  },
  removeItem: (key) => {
    if (refuse) throw refuse;
    store.delete(key);
  },
};
const styles = new Map();
const root = { dataset: {}, style: { setProperty: (name, value) => styles.set(name, value) } };
globalThis.document = { documentElement: root, querySelector: () => null };
// The system's light or dark, which the test changes as the OS does.
const system = { matches: false, listeners: [], addEventListener(type, listener) { this.listeners.push(listener); } };
const osTheme = (dark) => {
  system.matches = dark;
  system.listeners.forEach((listener) => listener());
};
globalThis.window = Object.assign(new EventTarget(), { matchMedia: () => system });
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const { applyAppearance, defaultAppearance, initializeAppearance, readAppearance, restoreDefaultAppearance, saveAppearance } =
  await import("../src/appearance.ts");
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

test("a save the browser refuses is reported, not hidden; the choice still applies in this window (T-187)", () => {
  store.clear();
  assert.deepEqual(saveAppearance({ ...readAppearance(), palette: "pine" }), { saved: true });
  refuse = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  try {
    const outcome = saveAppearance({ ...readAppearance(), palette: "graphite" });
    assert.deepEqual(outcome, { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" });
    assert.equal(root.dataset.palette, "graphite", "applied here");
    assert.equal(JSON.parse(store.get(KEY)).palette, "pine", "the saved choice is unchanged");
    refuse = new DOMException("The operation is insecure.", "SecurityError");
    assert.equal(saveAppearance({ ...readAppearance(), palette: "yuzu" }).reason, "blocked");
    refuse = new Error("disk unplugged");
    assert.deepEqual(saveAppearance({ ...readAppearance(), palette: "yuzu" }),
      { saved: false, reason: "unknown", detail: "the browser refused it (disk unplugged)" });
  } finally {
    refuse = null;
  }
  assert.deepEqual(saveAppearance({ ...readAppearance(), palette: "graphite" }), { saved: true }, "saved once it can be");
  assert.equal(JSON.parse(store.get(KEY)).palette, "graphite");
});

test("a write that doesn't stick is not called saved (T-187)", () => {
  store.clear();
  const setItem = localStorage.setItem;
  localStorage.setItem = () => {}; // accepted, not kept
  try {
    assert.deepEqual(saveAppearance({ ...readAppearance(), theme: "dark" }),
      { saved: false, reason: "unknown", detail: "the browser didn’t keep it" });
  } finally {
    localStorage.setItem = setItem;
  }
});

test("restore defaults removes this device's choice only, and says whether it could (T-187)", () => {
  store.clear();
  store.set("yuzuno.selected", JSON.stringify("a"));
  saveAppearance({ ...readAppearance(), palette: "pine", fontSize: 20 });
  assert.deepEqual(restoreDefaultAppearance(), { saved: true });
  assert.equal(store.has(KEY), false);
  assert.equal(store.get("yuzuno.selected"), JSON.stringify("a"), "nothing else is removed");
  assert.deepEqual(readAppearance(), defaultAppearance);
  assert.equal(root.dataset.palette, defaultAppearance.palette);
  saveAppearance({ ...readAppearance(), palette: "pine" });
  refuse = new DOMException("The operation is insecure.", "SecurityError");
  try {
    assert.equal(restoreDefaultAppearance().reason, "blocked");
    assert.equal(root.dataset.palette, defaultAppearance.palette, "the defaults apply here");
    assert.equal(JSON.parse(store.get(KEY)).palette, "pine", "the saved choice is still there");
  } finally {
    refuse = null;
  }
});

test("a choice this device refused to save stays in effect when the system theme changes (T-187)", () => {
  store.clear();
  osTheme(false);
  initializeAppearance();
  // Saved: follow the system. Chosen, not saved: dark.
  saveAppearance({ ...readAppearance(), theme: "system" });
  refuse = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  try {
    saveAppearance({ ...readAppearance(), theme: "dark" });
    assert.equal(root.dataset.theme, "dark");
    osTheme(false);
    assert.equal(root.dataset.theme, "dark", "the system's light does not undo the dark chosen here");
  } finally {
    refuse = null;
  }
  // Saved: dark. Chosen, not saved: follow the system.
  saveAppearance({ ...readAppearance(), theme: "dark" });
  refuse = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  try {
    saveAppearance({ ...readAppearance(), theme: "system" });
    assert.equal(root.dataset.theme, "light");
    osTheme(true);
    assert.equal(root.dataset.theme, "dark", "it follows the system, as chosen here");
    osTheme(false);
    assert.equal(root.dataset.theme, "light");
  } finally {
    refuse = null;
  }
  assert.equal(JSON.parse(store.get(KEY)).theme, "dark", "what is saved is unchanged");
});
