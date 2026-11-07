/**
 * The interactive-result contract: the one source of its format.
 *
 * Everything that decides what an interactive result may contain lives here
 * and depends on zod only: the component props, the whole-result checks,
 * the display defaults, the schema version, and the notice and fence guide
 * Agents are given (YN-14 A5: no MCP tool publishes results any more; a
 * reply's yuzuno-ui block shows one). The renderer's catalog (spec.ts), the reply
 * parser (message.ts) and Core's validator all use this file; nothing
 * restates the format elsewhere. Core runs it as a generated bundle,
 * runtimes/result-validator/ (web/tools/result-validator.mjs builds it).
 */
import { z } from "zod";
import { clarificationSchema } from "./clarification.ts";
import { TASK_KEY } from "./task-key.ts";

/** Bumped when a valid result's meaning changes; stored with every result. */
export const SCHEMA_VERSION = 2;


/** The longest id: element keys, component, row, column and option ids. */
const ID_LENGTH = 64;
const id = z
  .string()
  .regex(new RegExp(`^[a-zA-Z][\\w-]{0,${ID_LENGTH - 1}}$`))
  .refine((value) => !(value in Object.prototype) && value !== "prototype");
const short = z.string().min(1).max(160);
/** A shared task's statuses, as Core's task domain has them. */
export const TASK_STATUSES = ["todo", "doing", "blocked", "review", "done", "cancelled"] as const;
const text = z.string().max(2000);
const sourceIds = z.array(id).max(12).optional();
const cell = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const componentProps = {
  Clarification: clarificationSchema,
  Result: z.strictObject({ title: short, summary: text }),
  Section: z.strictObject({ title: short }),
  Text: z.strictObject({ text }),
  Metrics: z.strictObject({
    items: z
      .array(
        z.strictObject({ label: short, value: short, detail: text.optional() }),
      )
      .min(1)
      .max(6),
  }),
  Table: z.strictObject({
    id,
    title: short,
    columns: z
      .array(z.strictObject({ key: id, label: short }))
      .min(1)
      .max(8),
    rows: z
      .array(z.strictObject({ id, cells: z.record(id, cell), sourceIds }))
      .max(100),
    selectable: z.boolean().optional(),
  }),
  BarChart: z.strictObject({
    id,
    title: short,
    unit: z.string().max(30),
    data: z
      .array(
        z.strictObject({
          id,
          label: short,
          value: z.number().finite(),
          sourceIds,
        }),
      )
      .min(1)
      .max(24),
  }),
  Sources: z.strictObject({
    items: z
      .array(
        z.strictObject({ id, label: short, href: z.string().min(1).max(2000) }),
      )
      .max(30),
  }),
  Continue: z.strictObject({
    label: short,
    instruction: text.min(1),
    requiresSelection: z.boolean().optional(),
  }),
  TaskStatus: z.strictObject({
    taskId: z.string().regex(TASK_KEY),
    status: z.enum(TASK_STATUSES),
    reason: z.string().min(1).max(1000),
  }),
};
/** What each component is for. The renderer's catalog and the capability
 * text Agents receive both use these. */
export const COMPONENT_DESCRIPTIONS = {
  Clarification: "One bounded form: id, title, optional description and 1-8 fields. Each field has id, type (text/single/multi), label, required and optional description. Text may have placeholder. Choices have 2-12 options with stable id, label and optional description. An optional default is {value, source}: source says where it came from; value is text, one option id or an array of option ids. Users explicitly submit answers once to this original conversation; never use forms as native permission approval.",
  Result: "One result root with title and conclusion.",
  Section: "A titled group.",
  Text: "Plain text, without HTML.",
  Metrics: "Up to six reported metrics.",
  Table: "A searchable sortable table. Rows may be selected for a follow-up draft.",
  BarChart: "A bar chart with equivalent selectable data table.",
  Sources: "Explicit HTTPS or local file references.",
  Continue: "A user-clicked button that appends instruction and current selection to a draft.",
  TaskStatus: "Proposes one status change to one existing shared task: taskId T-N or a Project task key such as YN-3, status todo/doing/blocked/review/done/cancelled, and why. The user sees the task as Core reads it, may change the status or reason, and confirms or declines; only a confirmation changes the task, as the user.",
} as const satisfies Record<keyof typeof componentProps, string>;
export type TableProps = z.infer<typeof componentProps.Table>;
export type ChartProps = z.infer<typeof componentProps.BarChart>;
export type Source = z.infer<typeof componentProps.Sources>["items"][number];
const element = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("Result"),
    props: componentProps.Result,
    children: z.array(id).max(24).optional(),
  }),
  z.strictObject({
    type: z.literal("Section"),
    props: componentProps.Section,
    children: z.array(id).max(24).optional(),
  }),
  ...(
    ["Text", "Metrics", "Table", "BarChart", "Sources", "Continue", "Clarification", "TaskStatus"] as const
  ).map((type) =>
    z.strictObject({
      type: z.literal(type),
      props: componentProps[type],
      children: z.array(id).max(0).optional(),
    }),
  ),
]);
const specSchema = z.strictObject({
  root: id,
  elements: z.record(id, element),
});
export type ResultSpec = z.infer<typeof specSchema>;
/**
 * A result submitted with the tool: at most this many UTF-8 bytes of its
 * compact JSON. A reply's JSON block keeps the limit it always had, 64,000
 * UTF-16 code units of the block's text (MAX_SPEC_LENGTH). A string never has
 * more code units than UTF-8 bytes, so every result the tool accepts would
 * also fit in a block.
 */
export const MAX_SPEC_BYTES = 64_000;
export const MAX_SPEC_LENGTH = 64_000;

/** URLs are host capabilities, never a renderer-provided event or HTML attribute. */
export function sourceTarget(
  href: string,
): { kind: "web" | "file"; path: string; line?: number } | null {
  if (/[\u0000-\u001f\u007f]/.test(href) || href !== href.trim()) return null;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      return url.username || url.password
        ? null
        : { kind: "web", path: url.href };
    } catch {
      return null;
    }
  }
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) &&
    !/^[\w.-]+\.[\w.-]+:\d+(?::\d+)?$/.test(href)
  )
    return null;
  if (href.startsWith("//") || href.startsWith("#") || href.includes("\\"))
    return null;
  const location = /#L(\d+)$/i.exec(href) || /:(\d+)(?::\d+)?$/.exec(href);
  let path = location ? href.slice(0, location.index) : href;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null;
  return {
    kind: "file",
    path,
    line: location ? Number(location[1]) : undefined,
  };
}

/** One reason a result is not valid: a stable code, where, and why. */
export type ResultProblem = { code: string; reason: string; path?: string };

/** Problems reported at once, so an Agent can fix them in one revision. */
export const MAX_PROBLEMS = 5;

/**
 * Why a result was not shown: a stable `code`, where in the JSON (`path`,
 * e.g. "elements.table.props.title"), and the validator's own `reason`.
 * `problems` lists every schema problem found (at most MAX_PROBLEMS), this
 * one first; a whole-result check stops at its first problem.
 */
export class ResultError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly path?: string;
  readonly problems: ResultProblem[];
  constructor(code: string, reason: string, path?: string, problems?: ResultProblem[]) {
    super(reason);
    this.name = "ResultError";
    this.code = code;
    this.reason = reason;
    this.path = path;
    this.problems = problems ?? [{ code, reason, ...(path ? { path } : {}) }];
  }
}

/**
 * Purely presentational props a component may leave out, and the stable
 * value shown instead. Nothing else is ever filled in: data, links, IDs and
 * actions must come from the Agent, and every other field stays strict.
 */
export const DISPLAY_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Table: { title: "Table" },
  BarChart: { title: "Chart" },
};

/** The parsed JSON with whitelisted display defaults filled in, and where. */
function withDisplayDefaults(value: unknown): { value: unknown; applied: string[] } {
  const applied: string[] = [];
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || !object(value.elements)) return { value, applied };
  const elements: Record<string, unknown> = { ...value.elements };
  for (const [key, element] of Object.entries(elements)) {
    if (!object(element) || typeof element.type !== "string" || !object(element.props)) continue;
    const defaults = Object.hasOwn(DISPLAY_DEFAULTS, element.type) ? DISPLAY_DEFAULTS[element.type] : undefined;
    if (!defaults) continue;
    const missing = Object.keys(defaults).filter((prop) => !Object.hasOwn(element.props as object, prop));
    if (!missing.length) continue;
    const props = { ...element.props };
    for (const prop of missing) {
      props[prop] = defaults[prop];
      applied.push(`elements.${key}.props.${prop}`);
    }
    elements[key] = { ...element, props };
  }
  return { value: { ...value, elements }, applied };
}

function problemOf(issue: z.ZodError["issues"][number]): ResultProblem {
  const path = issue.path.map(String).join(".") || undefined;
  const at = path ? { path } : {};
  if (issue.code === "unrecognized_keys")
    return { code: "unknown_field", reason: `Unknown field: ${issue.keys.join(", ")}.`, ...at };
  // A component type outside the catalog fails the discriminated union.
  if (issue.code === "invalid_union")
    return { code: "unknown_component", reason: "Unknown or unsupported component type.", ...at };
  return { code: "invalid_field", reason: issue.message, ...at };
}

/** A schema failure as a ResultError: its first issues, with JSON paths. */
function schemaError(error: z.ZodError): ResultError {
  const problems = error.issues.slice(0, MAX_PROBLEMS).map(problemOf);
  const first = problems[0];
  if (!first) return new ResultError("invalid_result", "The result does not match the format.");
  return new ResultError(first.code, first.reason, first.path, problems);
}

export function parseSpec(raw: string): ResultSpec {
  return parseResultSpec(raw).spec;
}

/** A reply's JSON block, validated, and the display defaults it needed; throws ResultError. */
export function parseResultSpec(raw: string): { spec: ResultSpec; defaults: string[] } {
  if (raw.length > MAX_SPEC_LENGTH)
    throw new ResultError("too_large", `Result exceeds ${MAX_SPEC_LENGTH} characters.`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ResultError("invalid_json", error instanceof Error ? error.message : "Invalid JSON.");
  }
  return checkSpec(json);
}

const utf8 = new TextEncoder();

/**
 * A result submitted as a value (a tool argument): its size in UTF-8 bytes,
 * then every check a reply's block gets; throws ResultError.
 */
export function checkResultSpec(json: unknown): { spec: ResultSpec; defaults: string[] } {
  if (utf8.encode(JSON.stringify(json) ?? "").length > MAX_SPEC_BYTES)
    throw new ResultError("too_large", `Result exceeds ${MAX_SPEC_BYTES} bytes of compact JSON.`);
  return checkSpec(json);
}

/**
 * A stored result, checked again before it is drawn: everything but its
 * size, which was checked when it was submitted. Throws ResultError.
 */
export function checkSpec(json: unknown): { spec: ResultSpec; defaults: string[] } {
  const { value, applied } = withDisplayDefaults(json);
  const parsed = specSchema.safeParse(value);
  if (!parsed.success) throw schemaError(parsed.error);
  const spec = parsed.data;
  const entries = Object.entries(spec.elements);
  if (!entries.length || entries.length > 32)
    throw new ResultError("component_count", "Use between 1 and 32 components.", "elements");
  if (spec.elements[spec.root]?.type !== "Result")
    throw new ResultError("root", "The root must be a Result.", "root");
  const seen = new Set<string>();
  function visit(key: string, depth: number) {
    if (depth > 6 || seen.has(key))
      throw new ResultError("not_a_tree", "Result must be a tree, at most six levels deep.", `elements.${key}`);
    const node = spec.elements[key];
    if (!node) throw new ResultError("missing_component", "Result refers to a missing component.", `elements.${key}`);
    if (key !== spec.root && node.type === "Result")
      throw new ResultError("extra_result", "Only one Result is allowed.", `elements.${key}`);
    seen.add(key);
    for (const child of node.children || []) visit(child, depth + 1);
  }
  visit(spec.root, 1);
  if (seen.size !== entries.length)
    throw new ResultError("unused_component", "Result contains unused components.", "elements");
  const allSources = new Set<string>();
  const groups = new Set<string>();
  const references: string[] = [];
  let actions = 0;
  for (const [key, node] of entries) {
    const at = `elements.${key}.props`;
    if (node.type === "Sources") {
      const props = componentProps.Sources.parse(node.props);
      for (const item of props.items) {
        if (allSources.has(item.id) || !sourceTarget(item.href))
          throw new ResultError("invalid_source", "Invalid or duplicate source.", `${at}.items`);
        allSources.add(item.id);
      }
    }
    if (node.type === "Table" || node.type === "BarChart") {
      const id = (node.props as { id: string }).id;
      if (groups.has(id))
        throw new ResultError("duplicate_id", "Selection IDs must be unique.", `${at}.id`);
      groups.add(id);
      // Then what one element shows alone, as checkElement checks it.
      for (const row of checkRows(node.type, node.props, at)) references.push(...(row.sourceIds || []));
    }
    if ((node.type === "Continue" || node.type === "Clarification" || node.type === "TaskStatus") && ++actions > 1)
      throw new ResultError("extra_action", "Only one continuation, clarification form or task status proposal is allowed.", `elements.${key}`);
  }
  if (references.some((key) => !allSources.has(key)))
    throw new ResultError("missing_source", "A referenced source is missing.");
  return { spec, defaults: applied };
}

/** Made on first use: built at load, Core's validator bundle would keep it too. */
let oneElement: z.ZodType<{ elements: Record<string, ResultSpec["elements"][string]> }> | undefined;

/**
 * One element of a result, checked on its own as checkSpec checks it: its
 * id, its component and props (display defaults filled in), and the checks
 * that read nothing else (unique row, bar and column ids, rows that match
 * their columns, valid and unique sources). What needs the whole result (the
 * tree, one Result, cited sources, one action, unique selection ids) is
 * checkSpec's alone. A reply's block still being written draws only
 * elements that pass this (stream.ts); the whole block is checked once it is
 * closed. Throws ResultError, with checkSpec's paths.
 */
export function checkElement(key: string, json: unknown): ResultSpec["elements"][string] {
  // Checked first: a key such as __proto__ is not one of the record's own.
  if (!id.safeParse(key).success) throw new ResultError("invalid_field", "Invalid element id.", "elements");
  oneElement ??= z.strictObject({ elements: z.record(id, element) });
  const parsed = oneElement.safeParse(withDisplayDefaults({ elements: { [key]: json } }).value);
  if (!parsed.success) throw schemaError(parsed.error);
  if (!Object.hasOwn(parsed.data.elements, key)) throw new ResultError("invalid_field", "Invalid element id.", "elements");
  const node = parsed.data.elements[key];
  const at = `elements.${key}.props`;
  if (node.type === "Sources") {
    const seen = new Set<string>();
    for (const item of componentProps.Sources.parse(node.props).items) {
      if (seen.has(item.id) || !sourceTarget(item.href))
        throw new ResultError("invalid_source", "Invalid or duplicate source.", `${at}.items`);
      seen.add(item.id);
    }
  }
  if (node.type === "Table" || node.type === "BarChart") checkRows(node.type, node.props, at);
  return node;
}

/**
 * A Table's or BarChart's own rows (checkElement, checkSpec): unique row and
 * bar ids, unique column keys, rows that match their columns. Returns the
 * rows, which checkSpec reads their sourceIds from. Throws ResultError.
 */
function checkRows(type: "Table" | "BarChart", props: unknown, at: string): { id: string; sourceIds?: string[] }[] {
  const parsed = type === "Table" ? componentProps.Table.parse(props) : componentProps.BarChart.parse(props);
  const rows = "rows" in parsed ? parsed.rows : parsed.data;
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new ResultError("duplicate_id", "Row IDs must be unique.", at);
  if ("columns" in parsed) {
    const keys = parsed.columns.map((column) => column.key);
    if (new Set(keys).size !== keys.length)
      throw new ResultError("duplicate_id", "Column keys must be unique.", `${at}.columns`);
    for (const row of parsed.rows)
      if (Object.keys(row.cells).length !== keys.length || keys.some((key) => !(key in row.cells)))
        throw new ResultError("row_mismatch", "Every row must match its columns.", `${at}.rows`);
  }
  return rows;
}

/**
 * The longest tool description or server instructions a supported native
 * client shows whole. Claude Code 2.1.280 keeps the first 2048 UTF-16 code
 * units (its default CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH), appends
 * "… [truncated]" and drops the rest, so every description Agents are given
 * stays within it and the full guide is a tool result instead.
 */
export const MAX_DESCRIPTION_LENGTH = 2048;
export const RESULT_LIMITS = {
  /** Results (revision chains) per Turn. */
  chainsPerTurn: 3,
  /** Accepted versions of one result, the first included. */
  versionsPerChain: 5,
  /** Rejected results per Turn; then the Agent answers in text. Failures of
   * Core or its validator never count. */
  rejectedPerTurn: 3,
} as const;

type Json = { [key: string]: unknown };
/**
 * A compact signature of a props schema, from its JSON Schema: `?` marks an
 * optional prop, `[a-b]` an array's item count, `≤n` a string's longest
 * length in characters, and `="a"|"b"` the only values a prop takes (its
 * `const` or `enum`).
 */
function signature(schema: Json): string {
  const type = schema.type;
  const items = schema.items as Json | undefined;
  const range = (min: unknown, max: unknown) =>
    min !== undefined && max !== undefined ? `[${min}-${max}]` : max !== undefined ? `[≤${max}]` : "";
  const longest = (value: Json) => (value.type === "string" && typeof value.maxLength === "number" ? `≤${value.maxLength}` : "");
  const values = (value: Json) =>
    value.const !== undefined ? JSON.stringify(value.const)
    : Array.isArray(value.enum) ? value.enum.map((choice) => JSON.stringify(choice)).join("|")
    : "";
  for (const union of ["anyOf", "oneOf"])
    if (Array.isArray(schema[union])) return (schema[union] as Json[]).map(signature).join("|");
  if (type === "array") {
    const inner = items ? signature(items) : "";
    return `${range(schema.minItems, schema.maxItems)}${inner.startsWith("{") ? inner : `(${inner})`}`;
  }
  if (type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required ?? []) as string[]);
    const extra = schema.additionalProperties;
    if (!Object.keys(properties).length && extra && typeof extra === "object")
      return `{<key>: ${signature(extra as Json)}}`;
    return `{${Object.entries(properties)
      .map(([key, value]) => {
        const inner = signature(value);
        const nested = value.type === "array" || inner.startsWith("{");
        const literal = values(value) && `=${values(value)}`;
        return `${key}${required.has(key) ? "" : "?"}${nested ? inner : literal || longest(value)}`;
      })
      .join(", ")}}`;
  }
  if (values(schema)) return values(schema);
  return typeof type === "string" ? `${type}${longest(schema)}` : "value";
}

/** Props as an Agent may send them: display defaults make their fields optional. */
function sentProps(type: keyof typeof componentProps) {
  const props = componentProps[type];
  const defaults = Object.hasOwn(DISPLAY_DEFAULTS, type) ? DISPLAY_DEFAULTS[type] : undefined;
  if (!defaults) return props;
  const object = props as z.ZodObject;
  return object.extend(
    Object.fromEntries(Object.keys(defaults).map((key) => [key, (object.shape[key] as z.ZodType).optional()])),
  );
}

type Component = keyof typeof componentProps;
const COMPONENTS = Object.keys(componentProps) as Component[];

/** How to read the signatures formatComponentGuide writes; every guide that lists components says it. */
export const SIGNATURE_LEGEND =
  `In each component's props, ? marks an optional prop, [a-b] an array's item count, ≤n a string's longest length in characters and ="a"|"b" the only values a prop takes.`;

/**
 * One component's line in a guide: its name, the signature of the props an
 * Agent sends, what it is for, and any notes. Every catalog's guide formats
 * its components with this, so they all read the same way.
 */
export function formatComponentGuide(name: string, props: z.ZodType, description: string, notes = ""): string {
  return `- ${name} ${signature(z.toJSONSchema(props) as Json)}: ${description}${notes}`;
}

/** One component's part of the guide: its props, purpose and display defaults. */
function componentGuide(type: Component): string {
  const defaults = Object.hasOwn(DISPLAY_DEFAULTS, type) ? DISPLAY_DEFAULTS[type] : undefined;
  const note = defaults
    ? ` (${Object.entries(defaults).map(([key, value]) => `${key} defaults to "${value}"`).join(", ")})`
    : "";
  const children = type === "Result" || type === "Section" ? " Has children." : "";
  return formatComponentGuide(type, sentProps(type), COMPONENT_DESCRIPTIONS[type], `${children}${note}`);
}

/**
 * The components a reply's yuzuno-ui block shows (YN-14 A5): display only.
 * Clarification, TaskStatus and Continue were result_publish's, whose
 * stored results Core still renders and answers; no new one is published.
 */
export const FENCE_COMPONENTS = ["Result", "Section", "Text", "Metrics", "Table", "BarChart", "Sources"] as const satisfies readonly Component[];

/** How an Agent shows a result in a conversation (YN-14 A5), as a reply's yuzuno-ui block. */
export const FENCE_NOTICE =
  `To show a table, chart, metrics, sections or sources in a conversation, put one yuzuno-ui fenced block in your reply: one sentence of plain text first, ` +
  "then ```yuzuno-ui with a JSON spec {root, elements}: \"root\" first, then the elements in the order they are shown, the Result first. " +
  `Yuzuno draws each element as it arrives. At most one block per reply; it only displays. A form, a choice or a status change goes to a Home Ask instead. ` +
  `yuzuno_guide topic results lists each component's props. Reply in plain text when a sentence will do.`;

const SHAPE =
  `spec is {root, elements}: elements maps ids (1-${ID_LENGTH} characters: a letter, then letters, digits, - or _; every other id has the same form) to {type, props, children?}. root names a Result. The elements form one tree, at most 6 levels and 32 components, every element used, at most ${MAX_SPEC_BYTES} bytes as compact JSON.`;

/**
 * yuzuno_guide topic results' component list, generated from the catalog:
 * the block's shape, each display component's props, and the rules a block
 * is checked with when it closes (checkSpec).
 */
export function describeFenceGuide(): string {
  return [
    `A reply's yuzuno-ui block, schema version ${SCHEMA_VERSION}. ${SIGNATURE_LEGEND}`,
    SHAPE,
    "Components:",
    ...FENCE_COMPONENTS.map(componentGuide),
    "Rules:",
    `Sources hrefs are http(s) URLs or local file paths (optionally :line); rows and bars cite them by id in sourceIds. Table and BarChart ids, row ids and column keys are unique; every Table row has a cell for each column key and no others. A block that fails these checks when it closes shows as text.`,
  ].join("\n");
}

/**
 * What Core is told about results, generated from this file only: the
 * notice every native session gets, the fence guide yuzuno_guide serves, and
 * the limits Core still applies to the results it stores.
 */
export function describeContract() {
  return {
    schemaVersion: SCHEMA_VERSION,
    limits: RESULT_LIMITS,
    capability: FENCE_NOTICE,
    fenceGuide: describeFenceGuide(),
    maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  };
}
