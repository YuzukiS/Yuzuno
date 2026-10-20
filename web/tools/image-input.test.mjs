import test from "node:test";
import assert from "node:assert/strict";
import {
  DraftStorage,
  emptyDraft,
  textDraft,
  draftText,
  hasDraftContent,
} from "../src/composer-draft.ts";
import {
  appendImage,
  clipboardImages,
  validateImageFiles,
  sameMessageImages,
  MAX_IMAGE_BYTES,
  messageImages,
} from "../src/image-input.ts";
const image = {
  agentId: "a",
  id: "a".repeat(64) + ".png",
  width: 80,
  height: 60,
  bytes: 2048,
  name: "hello.png",
};
test("forked history preserves its original image owner and rejects unmanaged paths", () => {
  const native = {
    type: "localImage",
    path: `/core/data/input-images/source-agent/${image.id}`,
  };
  const inherited = JSON.parse(JSON.stringify(native));
  assert.deepEqual(messageImages([inherited]), [
    { agentId: "source-agent", id: image.id },
  ]);
  assert.deepEqual(
    messageImages([
      { ...native, path: `C:\\core\\input-images\\source-agent\\${image.id}` },
    ]),
    messageImages([native]),
  );
  for (const path of [
    `/elsewhere/${image.id}`,
    `/input-images/source-agent/../${image.id}`,
    `/input-images/../${image.id}`,
    `/input-images/source_agent/${image.id}`,
    `https://host/input-images/source-agent/${image.id}`,
    `file:///input-images/source-agent/${image.id}`,
    `input-images/source-agent/${image.id}`,
    `/input-images/source-agent/${image.id}?extra`,
    `/input-images/source-agent/secret.txt`,
  ])
    assert.deepEqual(messageImages([{ ...native, path }]), [], path);
  assert.deepEqual(
    messageImages([
      { type: "image", path: native.path },
      { type: "localImage" },
    ]),
    [],
  );
});
test("remote native image paths resolve to the Core original for conversation preview", () => {
  const path = `/Users/remote/.yuzuno-next/image-cache/${"1".repeat(64)}/${"2".repeat(64)}/input-images/source-agent/${image.id}`;
  assert.deepEqual(messageImages([{ type: "localImage", path }]), [
    { agentId: "source-agent", id: image.id },
  ]);
});
test("image-only draft and mixed draft persist small references across reload and Agent changes", () => {
  const data = new Map();
  const writes = [];
  const store = {
    getItem: (k) => data.get(k) ?? null,
    setItem(k, v) {
      data.set(k, v);
      writes.push(v);
    },
    removeItem: (k) => data.delete(k),
  };
  let draft = appendImage(emptyDraft(), image);
  assert.equal(hasDraftContent(draft), true);
  assert.equal(draftText(draft), "");
  const storage = new DraftStorage(store);
  storage.save("a", draft);
  storage.save("b", textDraft("other Agent"));
  for (let i = 0; i < 100; i++)
    storage.save("a", {
      ...draft,
      parts: [{ kind: "text", text: `hello ${i}` }],
    });
  const loaded = new DraftStorage(store).load("a");
  assert.deepEqual(loaded.images, [image]);
  assert.equal(draftText(loaded), "hello 99");
  assert.equal(draftText(new DraftStorage(store).load("b")), "other Agent");
  assert.ok(
    writes.every((value) => value.length < 500),
    "no image bytes in keystroke storage",
  );
  assert.equal(
    appendImage(draft, image),
    draft,
    "same uploaded content deduplicated",
  );
});
test("clipboard item/file mixed representation is consumed once; size and formats are explicit", () => {
  const file = new File(["png"], "test.png", { type: "image/png" });
  assert.deepEqual(
    clipboardImages({
      items: [{ kind: "file", getAsFile: () => file }],
      files: [file],
    }),
    [file],
  );
  assert.deepEqual(clipboardImages({ items: [], files: [file] }), [file]);
  assert.throws(
    () =>
      validateImageFiles(
        [new File(["svg"], "test.svg", { type: "image/svg+xml" })],
        [],
      ),
    /PNG, JPEG or WebP/,
  );
  assert.throws(
    () =>
      validateImageFiles(
        [{ ...file, type: "image/png", size: MAX_IMAGE_BYTES + 1 }],
        [],
      ),
    /10 MiB/,
  );
  assert.throws(() => validateImageFiles(Array(9).fill(file), []), /8 images/);
});
test("message identity compares image order and content, including legacy text-only input", () => {
  assert.equal(sameMessageImages(undefined, []), true);
  assert.equal(sameMessageImages(["a"], ["b"]), false);
  assert.equal(sameMessageImages(["a", "b"], ["b", "a"]), false);
  assert.equal(sameMessageImages(["a"], ["a"]), true);
});
