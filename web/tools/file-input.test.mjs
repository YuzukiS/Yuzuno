import test from "node:test";
import assert from "node:assert/strict";
import {
  DraftStorage,
  emptyDraft,
  hasDraftContent,
  savedDraftSummary,
} from "../src/composer-draft.ts";
import {
  appendFile,
  fileSize,
  MAX_FILES,
  splitDropped,
  uploadFileName,
  validDraftFiles,
  validateFileChoice,
} from "../src/file-input.ts";

const file = (name, bytes, agentId = "a") => ({
  id: name.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a"),
  agentId,
  name,
  bytes,
});
const report = file("q3-report.pdf", 2400000);
const log = file("sensor-log.csv", 860000);

/** The two views a browser gives one payload. */
function dropped(items, files) {
  return {
    items: items.map((entry) => ({ kind: "file", getAsFile: () => entry })),
    files,
  };
}
const asFile = (name, type, size = 4) => ({ name, type, size });

test("file sizes are decimal with one place, as the Agent's notice writes them", () => {
  assert.equal(fileSize(1), "1 B");
  assert.equal(fileSize(860000), "860.0 KB");
  assert.equal(fileSize(2400000), "2.4 MB");
  assert.equal(fileSize(40 * 1024 * 1024), "41.9 MB");
});

test("an upload name is cut to 200 units without leaving half an emoji (YN-145)", () => {
  assert.equal(uploadFileName("q3-report.pdf"), "q3-report.pdf");
  assert.equal(uploadFileName("a".repeat(300)), "a".repeat(200));
  // The 200th unit would be the high half of an emoji: it is dropped, so
  // encodeURIComponent gets a whole string.
  const split = `${"a".repeat(199)}😀b`;
  assert.equal(uploadFileName(split), "a".repeat(199));
  assert.equal(encodeURIComponent(uploadFileName(split)), "a".repeat(199));
  // A whole emoji before the cut survives.
  const whole = `${"a".repeat(198)}😀b`;
  assert.equal(uploadFileName(whole), `${"a".repeat(198)}😀`);
  assert.equal(uploadFileName(""), "Pasted file");
  assert.equal(uploadFileName("😀"), "😀");
});

test("the choice is refused before anything is sent: count, empty files and size (YN-145)", () => {
  const nine = Array.from({ length: MAX_FILES + 1 }, (_, i) => asFile(`f${i}.txt`, "text/plain"));
  const eight = nine.slice(0, MAX_FILES);
  assert.throws(() => validateFileChoice(nine, []), /Attach at most 8 files per message\./);
  assert.throws(() => validateFileChoice(nine, [], "zh-Hans"), /每条消息最多 8 个文件。/);
  assert.throws(() => validateFileChoice([asFile("empty.txt", "text/plain", 0)], []), /empty\.txt is empty\./);
  assert.throws(() => validateFileChoice([asFile("empty.txt", "text/plain", 0)], [], "zh-Hans"), /empty\.txt 是空文件。/);
  assert.throws(
    () => validateFileChoice([asFile("big.bin", "application/octet-stream", 41 * 1024 * 1024)], []),
    /big\.bin: 43\.0 MB, over the 40 MiB a message can carry\./,
  );
  assert.throws(
    () => validateFileChoice([asFile("x.bin", "application/octet-stream", 30 * 1024 * 1024)], [{ bytes: 20 * 1024 * 1024 }], "zh-Hans"),
    /x\.bin：31\.5 MB，超过每条消息合计 40 MiB 的上限。/,
  );
  // Exactly at both limits passes.
  validateFileChoice([asFile("ok.bin", "application/octet-stream", 40 * 1024 * 1024)], []);
  validateFileChoice(eight.slice(1), eight.slice(0, 1).map((entry) => ({ bytes: entry.size })));
});

test("a drop splits PNG, JPEG and WebP from everything else, items before files", () => {
  const png = asFile("shot.png", "image/png");
  const pdf = asFile("report.pdf", "application/pdf");
  const gif = asFile("loop.gif", "image/gif");
  // `files` is a second view of the same payload; it is never added too.
  assert.deepEqual(splitDropped(dropped([png, pdf], [asFile("other.txt", "text/plain")])), {
    images: [png],
    files: [pdf],
  });
  // No items: the files view is read, and an image type outside the three
  // the image channel takes goes in as a file (D11).
  assert.deepEqual(splitDropped(dropped([], [png, pdf, gif])), {
    images: [png],
    files: [pdf, gif],
  });
  assert.deepEqual(splitDropped(null), { images: [], files: [] });
});

test("a draft keeps its files as small references across a reload, and only files is content", () => {
  const data = new Map();
  const writes = [];
  const store = {
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      data.set(key, value);
      writes.push(value);
    },
    removeItem: (key) => data.delete(key),
  };
  let draft = appendFile(emptyDraft(), report);
  draft = appendFile(draft, { ...log, agentId: "a" });
  assert.equal(hasDraftContent(draft), true);
  assert.equal(appendFile(draft, report), draft, "same id, Agent and name once");
  const storage = new DraftStorage(store);
  storage.save("a", draft);
  assert.ok(writes.every((value) => value.length < 500), "no file bytes in draft storage");
  const loaded = new DraftStorage(store).load("a");
  assert.deepEqual(loaded.files, [report, log]);
  assert.deepEqual(savedDraftSummary(store, "a"), { state: "saved", textChars: 0, pastes: 0, images: 0, files: 2, skills: 0 });
  // A draft saved by a version that knows nothing of files still loads.
  assert.equal(new DraftStorage(store).load("b").files, undefined);
});

test("saved file references are checked on load", () => {
  assert.equal(validDraftFiles([report, log]), true);
  for (const broken of [
    [{ ...report, id: "not-a-hash" }],
    [{ ...report, name: "" }],
    [{ ...report, bytes: 0 }],
    [{ ...report, agentId: "" }],
    Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`, 1)),
    [{ ...report, bytes: 40 * 1024 * 1024 }, { ...log, bytes: 40 * 1024 * 1024 }],
  ])
    assert.equal(validDraftFiles(broken), false, JSON.stringify(broken).slice(0, 80));
  assert.equal(validDraftFiles("files"), false);
});
