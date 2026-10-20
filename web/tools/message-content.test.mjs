import test from "node:test";
import assert from "node:assert/strict";
import {
  textLabel,
  contentParts,
  draftTextBlocks,
  userText,
  userRequestText,
} from "../src/message-content.ts";
import { draftText, pastedText, emptyDraft } from "../src/composer-draft.ts";

test("labels use ten graphemes across emoji, combining accents, CJK and layout", () => {
  assert.equal(textLabel("👨‍👩‍👧‍👦e\u0301中文123456tail"), "👨‍👩‍👧‍👦e\u0301中文123456…");
  assert.equal(
    textLabel("🇯🇵👍🏽👩‍💻e\u0301中文abcdmore"),
    "🇯🇵👍🏽👩‍💻e\u0301中文abcd…",
  );
  assert.equal(textLabel("a\r\nb\tc"), "a↵b⇥c");
});

test("native text variants and exact source overrides keep image captions outside paste ranges", () => {
  const raw = "  source\r\n👩‍💻e\u0301";
  for (const type of ["text", "inputText"]) {
    const item = { content: [{type:"image"}, {type, text:raw}, {type:"localImage"}] };
    assert.equal(userText(item),raw);
    assert.equal(userRequestText(item),raw + "\n[Image]\n[Image]");
    const override = {...item,_yuzunoInputText:raw + "\r\noriginal"};
    assert.equal(userRequestText(override),override._yuzunoInputText + "\n[Image]\n[Image]");
  }
});

test("identical paste bodies have independent identity and exact ordered UTF-16 ranges", () => {
  const body = "👩‍💻e\u0301中文\r\n".repeat(12);
  const draft = {
    ...emptyDraft(),
    parts: [
      { kind: "text", text: "before " },
      pastedText(body, 1, "first"),
      { kind: "text", text: " between " },
      pastedText(body, 2, "second"),
      { kind: "text", text: " after\r\n" },
    ],
  };
  const raw = draftText(draft),
    blocks = draftTextBlocks(draft);
  const restored = contentParts(raw, JSON.parse(JSON.stringify(blocks)));
  assert.deepEqual(
    restored.filter((p) => p.kind === "paste").map((p) => [p.id, p.text]),
    [
      ["first", body],
      ["second", body],
    ],
  );
  assert.equal(restored.map((p) => p.text).join(""), raw);
  assert.equal(
    contentParts(body)[0].kind,
    "long",
    "legacy is not claimed to come from clipboard",
  );
  assert.equal(
    contentParts(body, [])[0].kind,
    "text",
    "new ordinary text retains its recorded origin",
  );
  assert.equal(
    userText({
      content: [
        { type: "text", text: raw },
        { type: "image", url: "attachment" },
      ],
    }),
    raw,
  );
});
