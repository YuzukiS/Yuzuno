import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo, redo, isolateHistory } from "@codemirror/commands";
import {
  DraftStorage,
  draftText,
  emptyDraft,
  hasDraftContent,
  lineCount,
  pastedText,
  shouldFoldPaste,
  textDraft,
} from "../src/composer-draft.ts";
import {
  draftDocument,
  editPaste,
  editorDraft,
  insertPaste,
  pasteField,
  pasteHistory,
  textRange,
} from "../src/composer-editor.ts";

function editor(draft = emptyDraft()) {
  const { doc, anchors, nextNumber } = draftDocument(draft);
  let state = EditorState.create({
    doc,
    extensions: [
      pasteField.init(() => ({ anchors, nextNumber })),
      pasteHistory,
      history(),
    ],
  });
  return {
    get state() {
      return state;
    },
    dispatch(tr) {
      state = tr.state;
    },
    change(spec) {
      state = state.update({
        ...spec,
        annotations: isolateHistory.of("full"),
      }).state;
    },
    text() {
      return draftText(editorDraft(state));
    },
  };
}
const body = "  first\r\n\tsecond\r\n\r\n" + "末行\r\n".repeat(12);

test("folding has stable multiline/single-line boundaries, without treating short text as a block", () => {
  assert.equal(shouldFoldPaste("short\ntext"), false);
  assert.equal(shouldFoldPaste("x\n".repeat(11)), true);
  assert.equal(shouldFoldPaste("a".repeat(1999)), false);
  assert.equal(shouldFoldPaste("a".repeat(2000)), true);
  assert.equal(lineCount("x\r\ny\r\nz"), 3);
  assert.equal(lineCount("x\ry\nz"), 3);
  assert.equal(
    hasDraftContent({
      ...emptyDraft(),
      parts: [pastedText(" \r\n".repeat(12), 1)],
    }),
    false,
  );
});

test("insert at a selection, multiple blocks and adjacent typing expand to exact ordered original text", () => {
  const e = editor(textDraft("before REPLACE after"));
  e.dispatch(insertPaste(e.state, body, 7, 14));
  e.change({ changes: { from: 8, insert: " between " } });
  e.dispatch(insertPaste(e.state, "X".repeat(2200), 17, 17));
  assert.equal(
    e.text(),
    "before " + body + " between " + "X".repeat(2200) + " after",
  );
  assert.equal(
    textRange(e.state, 7, 18),
    body + " between " + "X".repeat(2200),
  );
  assert.deepEqual(
    e.state.field(pasteField).anchors.map((a) => a.paste.number),
    [1, 2],
  );
  assert.ok(
    e.state.doc.length < 40,
    "Large bodies do not become thousands of editable DOM characters",
  );
});

test("undo/redo restores block bodies and IDs after replacement, edits, deletion and surrounding typing", () => {
  const e = editor(textDraft("left right"));
  e.dispatch(insertPaste(e.state, body, 5, 5));
  const original = e.state.field(pasteField).anchors[0].paste;
  e.change({ changes: { from: 0, insert: "!" }, userEvent: "input" });
  assert.ok(undo(e));
  assert.equal(e.text(), "left " + body + "right");
  assert.ok(undo(e));
  assert.equal(e.text(), "left right");
  assert.ok(redo(e));
  assert.equal(e.state.field(pasteField).anchors[0].paste.id, original.id);
  e.dispatch(editPaste(e.state, original.id, "  edited\r\n"));
  assert.equal(e.text(), "left   edited\r\nright");
  assert.ok(undo(e));
  assert.equal(e.text(), "left " + body + "right");
  assert.ok(redo(e));
  assert.equal(e.text(), "left   edited\r\nright");
  e.change({
    changes: { from: 0, to: e.state.doc.length, insert: "replaced" },
    userEvent: "input",
  });
  assert.equal(e.state.field(pasteField).anchors.length, 0);
  assert.ok(undo(e));
  assert.equal(e.text(), "left   edited\r\nright");
  assert.ok(redo(e));
  assert.equal(e.text(), "replaced");
  e.dispatch(insertPaste(e.state, body));
  assert.equal(
    e.state.field(pasteField).anchors[0].paste.number,
    2,
    "Deleting/undoing never reuses a draft's number",
  );
});

function memory() {
  const data = new Map(),
    writes = [],
    reads = [];
  return {
    data,
    writes,
    reads,
    getItem: (key) => {
      reads.push(key);
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push({ key, size: value.length });
      data.set(key, value);
    },
    removeItem: (key) => data.delete(key),
  };
}
test("legacy and block drafts survive refresh; nearby typing only saves small references", () => {
  const disk = memory();
  disk.setItem(
    "yuzuno.drafts",
    JSON.stringify({ a: "legacy", b: "keep other Agent" }),
  );
  const storage = new DraftStorage(disk);
  assert.equal(draftText(storage.load("a")), "legacy");
  const paste = pastedText(body.repeat(1500), 1);
  const draft = {
    version: 1,
    nextNumber: 2,
    parts: [
      { kind: "text", text: "before " },
      paste,
      { kind: "text", text: " after" },
    ],
  };
  storage.save("a", draft);
  const baseline = disk.writes.length;
  disk.reads.length = 0;
  for (let i = 0; i < 50; i++)
    storage.save("a", {
      ...draft,
      parts: [...draft.parts, { kind: "text", text: "x".repeat(i) }],
    });
  assert.equal(disk.writes.slice(baseline).length, 50);
  assert.ok(disk.writes.slice(baseline).every((w) => w.size < 500));
  assert.ok(disk.reads.every((key) => key === "yuzuno.composer.v1:a"));
  const refreshed = new DraftStorage(disk).load("a");
  assert.equal(draftText(refreshed), draftText(draft) + "x".repeat(49));
  assert.equal(refreshed.parts[1].id, paste.id);
  assert.equal(refreshed.nextNumber, 2);
  assert.equal(draftText(new DraftStorage(disk).load("b")), "keep other Agent");
  storage.remove("a");
  assert.equal(
    draftText(new DraftStorage(disk).load("a")),
    "",
    "A sent/deleted legacy draft cannot return",
  );
});

test("two storage instances repair stale body caches after another window sends, edits or removes a block", () => {
  for (const action of ["send", "edit", "remove", "clear-storage"]) {
    const disk = memory(),
      a = new DraftStorage(disk),
      b = new DraftStorage(disk);
    const paste = pastedText(body, 1);
    const draft = { version: 1, nextNumber: 2, parts: [paste] };
    a.save("a", draft);
    a.save("other", draft);
    const inB = b.load("a");
    if (action === "send") a.remove("a");
    else if (action === "edit")
      a.save("a", { ...draft, parts: [pastedText("edited", 1, paste.id)] });
    else if (action === "remove") a.save("a", textDraft("remaining note"));
    else {
      disk.removeItem("yuzuno.composer.v1:a");
      disk.removeItem("yuzuno.paste.v1:a:" + paste.bodyId);
    }
    assert.equal(disk.getItem("yuzuno.paste.v1:a:" + paste.bodyId), null);
    const next = { ...inB, parts: [...inB.parts, { kind: "text", text: "!" }] };
    b.save("a", next);
    assert.equal(draftText(new DraftStorage(disk).load("a")), body + "!");
    assert.equal(draftText(new DraftStorage(disk).load("other")), body);
    const writeCount = disk.writes.length;
    disk.reads.length = 0;
    b.save("a", {
      ...next,
      parts: [...next.parts, { kind: "text", text: "?" }],
    });
    assert.equal(disk.writes.length, writeCount + 1);
    assert.deepEqual(disk.reads, ["yuzuno.composer.v1:a"]);
  }
});

test("failed stale-cache publication keeps existing bodies of the other window recoverable", () => {
  const disk = memory(),
    a = new DraftStorage(disk),
    b = new DraftStorage(disk);
  const original = { version: 1, nextNumber: 2, parts: [pastedText(body, 1)] };
  a.save("a", original);
  const inB = b.load("a");
  a.save("a", {
    ...original,
    parts: [...original.parts, { kind: "text", text: "A" }],
  });
  const oldSet = disk.setItem;
  disk.setItem = (key, value) => {
    if (key === "yuzuno.composer.v1:a") throw new Error("quota");
    oldSet(key, value);
  };
  assert.throws(
    () =>
      b.save("a", {
        ...inB,
        parts: [...inB.parts, pastedText("B", 2)],
        nextNumber: 3,
      }),
    /quota/,
  );
  assert.equal(draftText(new DraftStorage(disk).load("a")), body + "A");
  assert.equal(draftText(inB), body);
});

test("explicit discard recovers missing or corrupt drafts, preserves other Agents, and fails safely on denied writes", () => {
  for (const raw of [
    "not JSON",
    JSON.stringify({
      version: 1,
      nextNumber: 2,
      parts: [{ kind: "paste", id: "p", number: 1, bodyId: "missing" }],
    }),
  ]) {
    const disk = memory(),
      storage = new DraftStorage(disk);
    storage.save("other", textDraft("keep"));
    disk.setItem("yuzuno.composer.v1:a", raw);
    disk.setItem("yuzuno.drafts", JSON.stringify({ a: "do not resurrect" }));
    assert.throws(() => storage.load("a"));
    const set = disk.setItem;
    disk.setItem = () => {
      throw new Error("denied");
    };
    assert.throws(() => storage.discard("a"), /denied/);
    assert.equal(disk.getItem("yuzuno.composer.v1:a"), raw);
    disk.setItem = set;
    storage.discard("a");
    assert.equal(draftText(new DraftStorage(disk).load("a")), "");
    storage.save("a", textDraft("fresh"));
    assert.equal(draftText(new DraftStorage(disk).load("a")), "fresh");
    assert.equal(draftText(new DraftStorage(disk).load("other")), "keep");
  }
});

test("a missing body refuses to load instead of sending a placeholder or silently dropping text", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  storage.save("a", {
    version: 1,
    nextNumber: 2,
    parts: [pastedText(body, 1)],
  });
  for (const key of disk.data.keys())
    if (key.startsWith("yuzuno.paste.")) disk.data.delete(key);
  assert.throws(() => new DraftStorage(disk).load("a"), /missing/);
});

test("quota failure retains the last valid saved draft while the new body remains in memory", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  storage.save("a", textDraft("saved"));
  const oldSet = disk.setItem;
  disk.setItem = () => {
    throw new Error("Quota exceeded");
  };
  const next = { version: 1, nextNumber: 2, parts: [pastedText(body, 1)] };
  assert.throws(() => storage.save("a", next), /Quota/);
  assert.equal(draftText(next), body);
  disk.setItem = oldSet;
  assert.equal(draftText(storage.load("a")), "saved");
});

test("failed manifest publication rolls back new bodies and keeps the previous body readable", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  const previous = { version: 1, nextNumber: 2, parts: [pastedText(body, 1)] };
  storage.save("a", previous);
  const keys = [...disk.data.keys()];
  const originalSet = disk.setItem;
  disk.setItem = (key, value) => {
    if (key.startsWith("yuzuno.composer."))
      throw new Error("Manifest quota exceeded");
    originalSet(key, value);
  };
  const next = {
    version: 1,
    nextNumber: 3,
    parts: [...previous.parts, pastedText("second", 2)],
  };
  assert.throws(() => storage.save("a", next), /quota/);
  assert.deepEqual([...disk.data.keys()], keys);
  assert.equal(draftText(new DraftStorage(disk).load("a")), body);
  disk.setItem = originalSet;
  storage.save("a", next);
  assert.equal(draftText(new DraftStorage(disk).load("a")), body + "second");
});

test("a crash between body and manifest writes leaves the previous draft recoverable", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  storage.save("a", {
    version: 1,
    nextNumber: 2,
    parts: [pastedText(body, 1)],
  });
  const oldSet = disk.setItem;
  let crashSnapshot;
  disk.setItem = (key, value) => {
    oldSet(key, value);
    if (key.startsWith("yuzuno.paste.")) crashSnapshot = new Map(disk.data);
  };
  storage.save("a", {
    version: 1,
    nextNumber: 3,
    parts: [pastedText("changed", 2)],
  });
  const afterCrash = { getItem: (key) => crashSnapshot.get(key) ?? null };
  assert.equal(draftText(new DraftStorage(afterCrash).load("a")), body);
});

test("fork namespaces preserve bodies independently when the source is edited and undone", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  const original = { version: 1, nextNumber: 2, parts: [pastedText(body, 1)] };
  storage.save("source", original);
  storage.save("fork", original);
  storage.save("source", {
    ...original,
    parts: [pastedText("edited", 1, original.parts[0].id)],
  });
  assert.equal(draftText(new DraftStorage(disk).load("fork")), body);
  storage.save("source", original); // History restores the old immutable value.
  assert.equal(draftText(new DraftStorage(disk).load("source")), body);
  assert.equal(draftText(new DraftStorage(disk).load("fork")), body);
  storage.remove("source");
  assert.equal(draftText(new DraftStorage(disk).load("fork")), body);
});

test("clearing an unopened Agent after reload also removes its old body keys", () => {
  const disk = memory(),
    storage = new DraftStorage(disk);
  const draft = { version: 1, nextNumber: 2, parts: [pastedText(body, 1)] };
  storage.save("a", draft);
  storage.save("other", draft);
  new DraftStorage(disk).remove("a");
  assert.ok(
    ![...disk.data.keys()].some((key) => key.startsWith("yuzuno.paste.v1:a:")),
  );
  assert.equal(draftText(new DraftStorage(disk).load("a")), "");
  assert.equal(draftText(new DraftStorage(disk).load("other")), body);
});

test("merged ordinary typing and deletion history restores every block through undo-all and redo-all", () => {
  const e = editor(textDraft("start "));
  e.dispatch(insertPaste(e.state, body, 6, 6));
  for (const text of " after")
    e.dispatch(
      e.state.update({
        changes: { from: e.state.doc.length, insert: text },
        userEvent: "input.type",
      }),
    );
  e.dispatch(
    insertPaste(
      e.state,
      "another".repeat(400),
      e.state.doc.length,
      e.state.doc.length,
    ),
  );
  const expected = e.text(),
    ids = e.state.field(pasteField).anchors.map((a) => a.paste.id);
  let count = 0;
  while (undo(e)) {
    assert.ok(++count < 30);
  }
  assert.equal(e.text(), "start ");
  while (redo(e)) {
    assert.ok(--count >= 0);
  }
  assert.equal(e.text(), expected);
  assert.deepEqual(
    e.state.field(pasteField).anchors.map((a) => a.paste.id),
    ids,
  );
});
