import test from "node:test";
import assert from "node:assert/strict";
import {
  clarificationSchema,
  clarificationAnswers,
  clarificationExample,
  initialClarificationValues,
  validateClarification,
  clarificationAnswerLabel,
  clarificationDraftKey,
  readClarificationDraft,
  saveClarificationDraft,
} from "../src/intelligent-ui/clarification.ts";

test("bounded three-field catalog validates defaults and stable identities", () => {
  assert.deepEqual(
    clarificationSchema.parse(clarificationExample),
    clarificationExample,
  );
  for (const mutate of [
    (form) => form.fields.push(form.fields[0]),
    (form) => {
      form.fields[0].id = "constructor";
    },
    (form) => {
      delete form.fields[0].default.source;
    },
    (form) => {
      form.fields[1].default.value = "unknown";
    },
    (form) => {
      form.fields[1].options[1].id = "light";
    },
    (form) => {
      form.fields[2].default = {
        value: ["keyboard", "keyboard"],
        source: "Suggestion",
      };
    },
    (form) => {
      form.fields[0].type = "html";
    },
    (form) => {
      form.action = "delete_files";
    },
    (form) => {
      form.fields = Array(9).fill(form.fields[0]);
    },
  ]) {
    const form = structuredClone(clarificationExample);
    mutate(form);
    assert.equal(clarificationSchema.safeParse(form).success, false);
  }
});
test("answers validate required text, choices and optional empties without parsing labels", () => {
  const form = clarificationExample;
  const values = initialClarificationValues(form);
  assert.deepEqual(validateClarification(form, values), {});
  values.directory = "中文目录 /tmp/Project with spaces\nsecond line";
  values.checks = ["large-type"];
  assert.deepEqual(clarificationAnswers(form).parse(values), values);
  assert.equal(
    clarificationAnswerLabel(form.fields[2], values.checks),
    "20px text and narrow window",
  );
  for (const patch of [
    { directory: "  " },
    { directory: "a".repeat(2001) },
    { theme: "Dark" },
    { checks: ["unknown"] },
    { checks: ["keyboard", "keyboard"] },
    { extra: "data" },
  ])
    assert.ok(
      Object.keys(validateClarification(form, { ...values, ...patch })).length >
        0,
    );
  const changed = structuredClone(form);
  changed.fields[1].options[0].label = "浅色主题";
  assert.equal(clarificationAnswers(changed).safeParse(values).success, true);
  changed.fields[2].required = true;
  assert.ok(validateClarification(changed, { ...values, checks: [] }).checks);
});
test("incomplete drafts restore independently by source/result/form without image or composer writes", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const form = clarificationExample;
  const first = clarificationDraftKey("agent-a:result-1", form);
  const second = clarificationDraftKey("agent-a:result-2", form);
  const third = clarificationDraftKey("agent-b:result-1", form);
  const values = { directory: "", theme: "dark", checks: ["keyboard"] };
  saveClarificationDraft(storage, first, values);
  assert.deepEqual(readClarificationDraft(storage, first, form), values);
  for (const key of [second, third])
    assert.deepEqual(
      readClarificationDraft(storage, key, form),
      initialClarificationValues(form),
    );
  const before = storage.getItem(first);
  assert.throws(
    () =>
      saveClarificationDraft(
        {
          setItem() {
            throw Error("quota");
          },
        },
        first,
        values,
      ),
    /quota/,
  );
  assert.equal(storage.getItem(first), before);
  storage.setItem(first, '{"version":1,"values":{"unrecognized":"value"}}');
  assert.throws(
    () => readClarificationDraft(storage, first, form),
    /kept in storage/,
  );
  assert.match(storage.getItem(first), /unrecognized/);
  assert.equal(data.size, 1);
});
