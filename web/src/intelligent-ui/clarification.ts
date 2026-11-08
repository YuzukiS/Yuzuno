import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-zA-Z][\w-]{0,63}$/)
  .refine((value) => !(value in Object.prototype) && value !== "prototype");
const label = z.string().trim().min(1).max(160);
const note = z.string().max(1000);
const base = { id, label, required: z.boolean(), description: note.optional() };
const options = z
  .array(z.strictObject({ id, label, description: note.optional() }))
  .min(2)
  .max(12);
const source = label;
export const clarificationSchema = z
  .strictObject({
    id,
    title: label,
    description: note.optional(),
    fields: z
      .array(
        z.discriminatedUnion("type", [
          z.strictObject({
            ...base,
            type: z.literal("text"),
            placeholder: label.optional(),
            default: z
              .strictObject({ value: z.string().max(2000), source })
              .optional(),
          }),
          z.strictObject({
            ...base,
            type: z.literal("single"),
            options,
            default: z.strictObject({ value: id, source }).optional(),
          }),
          z.strictObject({
            ...base,
            type: z.literal("multi"),
            options,
            default: z
              .strictObject({ value: z.array(id).max(12), source })
              .optional(),
          }),
        ]),
      )
      .min(1)
      .max(8),
  })
  .superRefine((form, context) => {
    const seen = new Set<string>();
    form.fields.forEach((field, index) => {
      const at = ["fields", index];
      const problem = (message: string, path: (string | number)[]) =>
        context.addIssue({ code: "custom", message, path: [...at, ...path] });
      if (seen.has(field.id)) problem("Field IDs must be unique.", ["id"]);
      seen.add(field.id);
      if (field.type === "text") return;
      const ids = new Set(field.options.map((option) => option.id));
      if (ids.size !== field.options.length)
        problem("Option IDs must be unique.", ["options"]);
      if (field.default) {
        const values = Array.isArray(field.default.value)
          ? field.default.value
          : [field.default.value];
        if (
          new Set(values).size !== values.length ||
          values.some((value) => !ids.has(value))
        )
          problem("Defaults must name distinct options from this field.", [
            "default",
            "value",
          ]);
      }
    });
  });
export type ClarificationProps = z.infer<typeof clarificationSchema>;
export type ClarificationValues = Record<string, string | string[]>;
export type ClarificationErrors = Record<string, string>;

export type ClarificationAnswer = {
  resultId: string;
  formId: string;
  answers: ClarificationValues;
};

export function clarificationMessage(
  resultId: string,
  form: ClarificationProps,
  answers: ClarificationValues,
) {
  const values = clarificationAnswers(form).parse(answers);
  return `Answers to “${form.title}”:\n${JSON.stringify({ resultId, formId: form.id, answers: values }, null, 2)}`;
}

/** One schema for answer validation in both the browser and Core's validator.
 * Values contain stable option IDs, never labels parsed from display text. */
export function clarificationAnswers(form: ClarificationProps) {
  const fields: Record<string, z.ZodType> = {};
  for (const field of form.fields) {
    if (field.type === "text") {
      fields[field.id] = z
        .string()
        .max(2000, "Use at most 2,000 characters.")
        .refine(
          (value) => !field.required || !!value.trim(),
          "Enter an answer.",
        );
    } else {
      const choices = new Set(field.options.map((option) => option.id));
      fields[field.id] =
        field.type === "single"
          ? z
              .string()
              .refine(
                (value) =>
                  choices.has(value) || (!field.required && value === ""),
                "Choose an option.",
              )
          : z
              .array(z.string())
              .max(field.options.length)
              .refine(
                (values) => !field.required || values.length > 0,
                "Choose at least one option.",
              )
              .refine(
                (values) =>
                  new Set(values).size === values.length &&
                  values.every((value) => choices.has(value)),
                "Choose only the listed options.",
              );
    }
  }
  return z.strictObject(fields);
}
export function validateClarification(
  form: ClarificationProps,
  values: unknown,
): ClarificationErrors {
  const result = clarificationAnswers(form).safeParse(values);
  const errors: ClarificationErrors = {};
  if (!result.success)
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] || "form");
      errors[key] ??= issue.message;
    }
  return errors;
}
export function initialClarificationValues(
  form: ClarificationProps,
): ClarificationValues {
  return Object.fromEntries(
    form.fields.map((field) => [
      field.id,
      field.type === "multi"
        ? [...(field.default?.value || [])]
        : field.default?.value || "",
    ]),
  );
}
export function clarificationAnswerLabel(
  field: ClarificationProps["fields"][number],
  value: string | string[],
) {
  if (field.type === "text") return typeof value === "string" ? value : "";
  const selected = new Set(Array.isArray(value) ? value : [value]);
  return field.options
    .filter((option) => selected.has(option.id))
    .map((option) => option.label)
    .join(", ");
}

/**
 * What happened to one answer when its form changed (YN-38): `dropped`, picks
 * the form no longer offers (their labels as the user saw them); `changed`, a
 * field that now asks another kind of question, whose answer is not kept;
 * `reworded`, a kept answer whose question or option now reads differently;
 * `new`, a required field the answers never saw; `gone`, an answered field
 * the form no longer asks (`field` null, `label` its question).
 */
export type CarryNote =
  | { field: string; kind: "dropped"; labels: string[] }
  | { field: string; kind: "changed" | "reworded" | "new" }
  | { field: null; kind: "gone"; label: string };

const answered = (value: unknown) =>
  Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "";

/**
 * Answers given on `basis` (or saved without it), carried to `form`, a newer
 * version of the same form (YN-38): an answer stays only where its field ID
 * is still a field of the same type and each option ID picked is still one
 * of its options. Nothing is ever moved to another field or option: a pick
 * no longer offered leaves its field empty, never at its default. Fields the
 * answers never saw start at their defaults. `notes` say what changed, on
 * the fields concerned; with no basis, only what the values themselves show.
 */
export function carryClarification(
  basis: ClarificationProps | null,
  form: ClarificationProps,
  saved: unknown,
): { values: ClarificationValues; notes: CarryNote[] } {
  const given =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  const before = new Map((basis?.fields ?? []).map((field) => [field.id, field]));
  const values = initialClarificationValues(form);
  const notes: CarryNote[] = [];
  for (const field of form.fields) {
    const old = before.get(field.id);
    const had = Object.hasOwn(given, field.id) ? given[field.id] : undefined;
    if (had === undefined) {
      // Not among the answers: new to them when the form they were given on is known.
      if (basis && !old && field.required) notes.push({ field: field.id, kind: "new" });
      continue;
    }
    const shape = field.type === "multi" ? Array.isArray(had) : typeof had === "string";
    if ((old && old.type !== field.type) || !shape) {
      values[field.id] = field.type === "multi" ? [] : "";
      if (answered(had)) notes.push({ field: field.id, kind: "changed" });
      continue;
    }
    if (field.type === "text") {
      values[field.id] = (had as string).slice(0, 2000);
      if (old && old.label !== field.label && answered(had)) notes.push({ field: field.id, kind: "reworded" });
      continue;
    }
    const offered = new Map(field.options.map((option) => [option.id, option.label]));
    const picked = (Array.isArray(had) ? had : had ? [had] : []).filter(
      (id): id is string => typeof id === "string",
    );
    const kept = [...new Set(picked.filter((id) => offered.has(id)))];
    const lost = picked.filter((id) => !offered.has(id));
    values[field.id] = field.type === "single" ? (kept[0] ?? "") : kept;
    const oldLabel = (id: string) =>
      old && old.type !== "text" ? old.options.find((option) => option.id === id)?.label : undefined;
    if (lost.length)
      notes.push({ field: field.id, kind: "dropped", labels: lost.map((id) => oldLabel(id) ?? id) });
    else if (
      old &&
      kept.length &&
      (old.label !== field.label || kept.some((id) => (oldLabel(id) ?? offered.get(id)) !== offered.get(id)))
    )
      notes.push({ field: field.id, kind: "reworded" });
  }
  for (const [id, had] of Object.entries(given))
    if (!form.fields.some((field) => field.id === id) && answered(had))
      notes.push({ field: null, kind: "gone", label: before.get(id)?.label ?? id });
  return { values, notes };
}

export const clarificationDraftKey = (
  identity: string,
  form: ClarificationProps,
) => `yuzuno.clarification.v1:${identity}:${form.id}`;

/** Drafts may be incomplete. Validate shape and option membership without
 * imposing required fields until the user reviews the answers. */
export function readClarificationDraft(
  storage: Pick<Storage, "getItem">,
  key: string,
  form: ClarificationProps,
): ClarificationValues {
  const raw = storage.getItem(key);
  if (raw === null) return initialClarificationValues(form);
  const saved = JSON.parse(raw);
  const permissive = {
    ...form,
    fields: form.fields.map((field) => ({ ...field, required: false })),
  };
  if (
    saved?.version !== 1 ||
    !clarificationAnswers(permissive).safeParse(saved.values).success
  )
    throw new Error(
      "This saved form draft could not be restored. It has been kept in storage.",
    );
  return saved.values;
}
export function saveClarificationDraft(
  storage: Pick<Storage, "setItem">,
  key: string,
  values: ClarificationValues,
) {
  storage.setItem(key, JSON.stringify({ version: 1, values }));
}

export const clarificationExample: ClarificationProps = {
  id: "dev-preview",
  title: "Set up the development preview",
  description: "Confirm these details before I prepare the isolated preview.",
  fields: [
    {
      id: "directory",
      type: "text",
      label: "Working directory",
      required: true,
      default: {
        value: "/home/me/project",
        source: "The project path in your request",
      },
    },
    {
      id: "theme",
      type: "single",
      label: "Preview theme",
      required: true,
      options: [
        { id: "light", label: "Light" },
        { id: "dark", label: "Dark" },
      ],
      default: {
        value: "light",
        source: "Agent suggestion; you can change it",
      },
    },
    {
      id: "checks",
      type: "multi",
      label: "Checks to include",
      required: false,
      options: [
        { id: "keyboard", label: "Keyboard and Chinese input" },
        { id: "large-type", label: "20px text and narrow window" },
      ],
    },
  ],
};
