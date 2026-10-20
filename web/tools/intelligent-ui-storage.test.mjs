import assert from "node:assert/strict";
import test from "node:test";
import {
  VIEW_PREFIX,
  VIEW_MAX_ENTRIES,
  VIEW_MAX_BYTES,
  VIEW_ENTRY_MAX_BYTES,
  resultFingerprint,
  pruneResultViewCache,
  readViews,
  saveViews,
} from "../src/intelligent-ui/view-storage.ts";

class Storage {
  data = new Map();
  quota = Infinity;
  get length() {
    return this.data.size;
  }
  key(i) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  removeItem(key) {
    this.data.delete(key);
  }
  setItem(key, value) {
    const next = new Map(this.data).set(key, value);
    const bytes = [...next].reduce(
      (n, [k, v]) => n + 2 * (k.length + v.length),
      0,
    );
    if (bytes > this.quota)
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.data = next;
  }
}
const views = {
  options: {
    selected: ["dock"],
    filter: "中文 DOCK",
    sort: [{ id: "name", desc: true }],
  },
};
const fingerprint = resultFingerprint("native result");
const own = (storage) =>
  [...storage.data].filter(([k]) => k.startsWith(VIEW_PREFIX));
const size = (storage) =>
  own(storage).reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0);
const key = VIEW_PREFIX + '["agent","turn","item"]';
function protectedStorage() {
  const storage = new Storage();
  storage.setItem("yuzuno.drafts", '{"agent":"existing draft"}');
  storage.setItem(
    "yuzuno.outbox",
    '{"agent:composer":{"clientMessageId":"keep-me","text":"unsent"}}',
  );
  storage.setItem("other-feature", "not our cache");
  return storage;
}
function checkProtected(storage) {
  for (const [k, v] of protectedStorage().data)
    assert.equal(storage.getItem(k), v);
}

test("large native text is replaced by a short fingerprint and matching views restore", () => {
  const storage = protectedStorage();
  const raw = "原始结果".repeat(16000);
  const fp = resultFingerprint(raw);
  saveViews(key, fp, views, storage);
  assert.ok(storage.getItem(key).length < 500);
  assert.ok(!storage.getItem(key).includes("原始结果"));
  assert.deepEqual(readViews(key, fp, storage), views);
  assert.deepEqual(
    readViews(key, resultFingerprint(raw + "changed"), storage),
    {},
  );
  checkProtected(storage);
});

test("count budget evicts the oldest changes and keeps the latest result", () => {
  const storage = protectedStorage();
  for (let i = 0; i < 150; i++) {
    const k = VIEW_PREFIX + String(i).padStart(3, "0");
    saveViews(k, fingerprint, views, storage);
    const saved = JSON.parse(storage.getItem(k));
    storage.setItem(k, JSON.stringify({ ...saved, touched: i }));
  }
  assert.equal(own(storage).length, VIEW_MAX_ENTRIES);
  assert.equal(storage.getItem(VIEW_PREFIX + "000"), null);
  assert.deepEqual(readViews(VIEW_PREFIX + "149", fingerprint, storage), views);
  checkProtected(storage);
});

test("total UTF-16 byte budget evicts before entry count is reached", () => {
  const storage = protectedStorage();
  const large = {
    options: {
      selected: Array.from(
        { length: 100 },
        (_, i) => "row" + i + "x".repeat(45),
      ),
      filter: "中".repeat(200),
      sort: [],
    },
  };
  for (let i = 0; i < 40; i++)
    saveViews(VIEW_PREFIX + i, fingerprint, large, storage);
  assert.ok(own(storage).length < 40);
  assert.ok(size(storage) <= VIEW_MAX_BYTES);
  assert.deepEqual(readViews(VIEW_PREFIX + "39", fingerprint, storage), large);
  assert.ok(
    own(storage).every(
      ([k, v]) => (k.length + v.length) * 2 <= VIEW_ENTRY_MAX_BYTES,
    ),
  );
  checkProtected(storage);
});

test("startup removes legacy raw, corrupt and oversized cache without touching drafts/outbox", () => {
  const storage = protectedStorage();
  storage.setItem(
    VIEW_PREFIX + "legacy",
    JSON.stringify({ raw: "x".repeat(64000), views }),
  );
  storage.setItem(VIEW_PREFIX + "invalid", "broken JSON");
  storage.setItem(VIEW_PREFIX + "large", " ".repeat(VIEW_ENTRY_MAX_BYTES));
  pruneResultViewCache(storage);
  assert.equal(own(storage).length, 0);
  checkProtected(storage);
});

test("a real quota exception releases only reconstructible preferences", () => {
  const storage = protectedStorage();
  saveViews(key, fingerprint, views, storage);
  storage.quota = [...storage.data].reduce(
    (n, [k, v]) => n + 2 * (k.length + v.length),
    0,
  );
  saveViews(VIEW_PREFIX + "second", fingerprint, views, storage);
  assert.equal(own(storage).length, 0);
  checkProtected(storage);
  storage.setItem("yuzuno.drafts", '{"agent":"existing draft with new text"}');
  assert.match(storage.getItem("yuzuno.drafts"), /new text/);
});

test("cache yields under origin pressure, even when its individual write would fit", () => {
  const storage = protectedStorage();
  saveViews(key, fingerprint, views, storage);
  storage.setItem("unrelated-large-data", "x".repeat(1600000));
  saveViews(VIEW_PREFIX + "new", fingerprint, views, storage);
  assert.equal(own(storage).length, 0);
  assert.equal(storage.getItem("unrelated-large-data").length, 1600000);
  checkProtected(storage);
});

test("unavailable storage is nonfatal and malformed saved view IDs are discarded", () => {
  const blocked = {
    get length() {
      throw new Error("blocked");
    },
  };
  assert.doesNotThrow(() => saveViews(key, fingerprint, views, blocked));
  assert.deepEqual(readViews(key, fingerprint, blocked), {});
  const storage = protectedStorage();
  saveViews(
    key,
    fingerprint,
    JSON.parse(
      '{"toString":{"selected":["a"]},"options":{"selected":["valid","__proto__",null],"filter":null,"sort":[{"id":"constructor","desc":true}]}}',
    ),
    storage,
  );
  assert.deepEqual(readViews(key, fingerprint, storage), {
    options: { selected: ["valid"], filter: "", sort: [] },
  });
  checkProtected(storage);
});
