import test from "node:test";
import assert from "node:assert/strict";

// This device's saved preferences (T-187): a read never throws and checks
// nothing but JSON; a save or reset says whether it stuck and why not; a
// change from another window is passed on for that key only.
const store = new Map();
let refuseWrites = null;
let refuseReads = null;
globalThis.localStorage = {
  getItem: (key) => {
    if (refuseReads) throw refuseReads;
    return store.has(key) ? store.get(key) : null;
  },
  setItem: (key, value) => {
    if (refuseWrites) throw refuseWrites;
    store.set(key, String(value));
  },
  removeItem: (key) => {
    if (refuseWrites) throw refuseWrites;
    store.delete(key);
  },
};
globalThis.window = new EventTarget();
const { clearDeviceValue, deviceStorageReadable, onDeviceValueChange, readDeviceValue, saveDeviceValue } =
  await import("../src/device-storage.ts");

test("a read is the saved JSON, or null: none, not JSON, or storage unreadable", () => {
  store.clear();
  assert.equal(readDeviceValue("yuzuno.preferences"), null);
  store.set("yuzuno.preferences", JSON.stringify({ sendKey: "enter" }));
  assert.deepEqual(readDeviceValue("yuzuno.preferences"), { sendKey: "enter" });
  store.set("yuzuno.preferences", "{not json");
  assert.equal(readDeviceValue("yuzuno.preferences"), null);
  refuseReads = new DOMException("The operation is insecure.", "SecurityError");
  try {
    assert.equal(readDeviceValue("yuzuno.preferences"), null);
    assert.equal(deviceStorageReadable("yuzuno.preferences"), false);
  } finally {
    refuseReads = null;
  }
  assert.equal(deviceStorageReadable("yuzuno.preferences"), true);
});

test("a save or reset says whether it stuck, and why not", () => {
  store.clear();
  assert.deepEqual(saveDeviceValue("yuzuno.preferences", { sendKey: "mod-enter" }), { saved: true });
  assert.equal(store.get("yuzuno.preferences"), JSON.stringify({ sendKey: "mod-enter" }));
  refuseWrites = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  try {
    assert.deepEqual(saveDeviceValue("yuzuno.preferences", { sendKey: "enter" }),
      { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" });
    assert.equal(clearDeviceValue("yuzuno.preferences").reason, "full");
  } finally {
    refuseWrites = null;
  }
  assert.equal(store.get("yuzuno.preferences"), JSON.stringify({ sendKey: "mod-enter" }), "unchanged by refused writes");
  assert.deepEqual(clearDeviceValue("yuzuno.preferences"), { saved: true });
  assert.equal(store.has("yuzuno.preferences"), false);
});

test("another window's change is passed on for this key, or when all storage is cleared", () => {
  const seen = [];
  const stop = onDeviceValueChange("yuzuno.preferences", () => seen.push("preferences"));
  const storage = (key) => {
    const event = new Event("storage");
    event.key = key;
    window.dispatchEvent(event);
  };
  storage("yuzuno.preferences");
  storage("yuzuno.appearance");
  storage(null);
  assert.deepEqual(seen, ["preferences", "preferences"]);
  stop();
  storage("yuzuno.preferences");
  assert.equal(seen.length, 2, "no longer after it stops");
});
