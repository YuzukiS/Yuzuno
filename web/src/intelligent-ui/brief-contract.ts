/**
 * The Project Brief section contract (T-85): the one source of a Brief
 * section's format.
 *
 * An Agent writes a section with brief_update; Core checks it here before
 * keeping it. Everything that decides what a section may contain lives in
 * this file and depends on zod only, like contract.ts, whose component props
 * and field schemas it reuses where they fit: the envelope (key, kind,
 * title, ask, status, time, attachments), the body (a json-render spec with
 * a BriefBody root), the per-block limits, and the text Agents are given
 * (hard rules, tool descriptions and brief_guide). Core runs it in the same
 * generated bundle as results, runtimes/result-validator/, and reads the text
 * from its contract.json. Rules across sections (topic counts, open asks per
 * Agent, owners, versions) are Core's.
 */
import { z } from "zod";
import {
  COMPONENT_DESCRIPTIONS, componentProps, DISPLAY_DEFAULTS, formatComponentGuide, MAX_DESCRIPTION_LENGTH, MAX_PROBLEMS, SIGNATURE_LEGEND,
  MAX_SPEC_BYTES, ResultError, sourceTarget,
} from "./contract.ts";
import { clarificationSchema } from "./clarification.ts";

/** Bumped when a valid section's meaning changes; Core stores it with every section. */
export const BRIEF_SCHEMA_VERSION = 1;

/** A key: `topic` or `topic/sub`. */
export const BRIEF_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}(\/[a-z0-9][a-z0-9-]{0,47})?$/;

export const BRIEF_LIMITS = {
  // Across sections; Core enforces these.
  topics: 12,
  subtopicsPerTopic: 4,
  openAsksPerAgent: 3,
  historyDays: 30,
  snapshotFileBytes: 25 * 1024 * 1024,
  snapshotBriefBytes: 1024 * 1024 * 1024,
  // One section; checked here.
  bodyBytes: MAX_SPEC_BYTES,
  components: 32,
  depth: 6,
  bodyChildren: 32,
  groupChildren: 24,
  columns: 4,
  titleChars: 120,
  questionChars: 500,
  codeBlockLines: 200,
  mathChars: 4000,
  listItems: 30,
  metrics: 12,
  tableRows: 200,
  tableColumns: 12,
  chartSeries: 12,
  chartPoints: 500,
  chartPointsPerSeriesFromData: 5000,
  liveRefs: 50,
  sources: 30,
  attachments: 12,
  askOptionsMin: 2,
  askOptionsMax: 8,
  formFields: 8,
  formOptions: 12,
  validForMin: 60,
  validForMax: 31_536_000,
  problems: MAX_PROBLEMS,
  keyPattern: BRIEF_KEY_PATTERN.source,
  // Advice only (T-176, brief-advice.ts): adjustable hints in characters
  // (Unicode code points) and references, never a limit.
  advice: { markdownChars: 1200, sectionMarkdownChars: 3000, refs: 12 },
} as const;
const L = BRIEF_LIMITS;

// Field schemas shared with result_publish.
const id = componentProps.Table.shape.id;
const short = componentProps.Table.shape.title;
const text = componentProps.Text.shape.text;
const unit = componentProps.BarChart.shape.unit;
const line = z.string().trim().min(1).max(1000);
const time = z.iso.datetime({ offset: true, error: "Use an ISO 8601 time with a time zone, e.g. 2026-10-17T08:00:00Z." });
const attachmentName = z
  .string()
  .regex(/^(?!\.{1,2}$)[\w.-]{1,80}$/, "Use 1-80 letters, digits, _, . or - (not . or ..).");
const axis = z.strictObject({ label: short, unit: unit.optional() });
const column = z.string().min(1).max(80);

function chartProps<X extends z.ZodType>(x: X) {
  return z.strictObject({
    id,
    title: short,
    x: axis,
    y: axis,
    series: z
      .array(
        z.strictObject({
          name: short,
          points: z.array(z.tuple([x, z.number().finite()])).min(1).max(L.chartPoints),
        }),
      )
      .min(1)
      .max(L.chartSeries)
      .optional(),
    data: z
      .strictObject({
        attachment: attachmentName,
        x: column,
        series: z.array(z.strictObject({ name: short, column })).min(1).max(L.chartSeries),
      })
      .optional(),
  });
}
const metricValue = z.union([z.number().finite(), short]);
const tableShape = componentProps.Table.shape;

export const briefComponentProps = {
  BriefBody: z.strictObject({}),
  Group: z.strictObject({ title: short.optional(), tone: z.enum(["plain", "accent", "muted"]).optional() }),
  Columns: z.strictObject({ widths: z.array(z.number().int().min(1).max(4)).min(2).max(L.columns).optional() }),
  Markdown: z.strictObject({ text: z.string().min(1).max(L.bodyBytes) }),
  Math: z.strictObject({ tex: z.string().min(1).max(L.mathChars), display: z.boolean().optional() }),
  Checklist: z.strictObject({
    title: short.optional(),
    items: z.array(z.strictObject({ id, text: line, done: z.boolean() })).min(1).max(L.listItems),
  }),
  Plan: z.strictObject({
    title: short.optional(),
    steps: z
      .array(z.strictObject({ id, text: line, state: z.enum(["todo", "doing", "done", "blocked"]) }))
      .min(1)
      .max(L.listItems),
  }),
  Findings: z.strictObject({
    title: short.optional(),
    items: z
      .array(
        z.strictObject({
          id,
          source: short,
          severity: z.enum(["info", "low", "medium", "high", "critical"]),
          text: text.min(1),
        }),
      )
      .min(1)
      .max(L.listItems),
  }),
  Metrics: z.strictObject({
    items: z
      .array(
        z.strictObject({
          label: short,
          value: metricValue,
          unit: unit.optional(),
          previous: metricValue.optional(),
          detail: text.optional(),
        }),
      )
      .min(1)
      .max(L.metrics),
  }),
  // result_publish's Table with Brief limits.
  Table: componentProps.Table.extend({
    columns: z.array(tableShape.columns.element).min(1).max(L.tableColumns),
    rows: z.array(tableShape.rows.element).max(L.tableRows),
  }),
  LineChart: chartProps(z.union([z.number().finite(), z.string().min(1).max(64)])),
  BarChart: chartProps(z.union([z.number().finite(), z.string().min(1).max(64)])),
  ScatterChart: chartProps(z.number().finite()),
  LiveRefs: z.strictObject({
    items: z
      .array(
        z.strictObject({
          kind: z.enum(["task", "pr", "ci", "job", "review", "agent", "machine"]),
          id: z.string().regex(/^[^\u0000-\u001f\u007f]{1,200}$/, "Use the 1-200 character id the matching yuzuno tool uses."),
          label: short.optional(),
        }),
      )
      .min(1)
      .max(L.liveRefs),
  }),
  Attachments: z.strictObject({
    items: z
      .array(z.strictObject({ name: attachmentName, caption: z.string().max(500).optional() }))
      .min(1)
      .max(L.attachments),
  }),
  Sources: componentProps.Sources,
};
export type BriefComponent = keyof typeof briefComponentProps;
type Props<K extends BriefComponent> = z.infer<(typeof briefComponentProps)[K]>;
const CHARTS = ["LineChart", "BarChart", "ScatterChart"] as const;
const isChart = (type: string): type is (typeof CHARTS)[number] => (CHARTS as readonly string[]).includes(type);

/** What each component is for; brief_guide and the renderer's catalog use these. */
export const BRIEF_COMPONENT_DESCRIPTIONS = {
  BriefBody: "The root of every section body; no props, children only.",
  Group: "A group of components with an optional title. tone accent or muted tints its background, e.g. for a summary across the top.",
  Columns: "Lays out its children side by side, each child one column (usually a Group). widths gives their relative widths, e.g. [2, 1]; equal without it. A narrow window stacks the columns in the order given.",
  Markdown: "GitHub-flavoured Markdown: paragraphs, lists, links, tables and fenced code or log excerpts. Raw HTML is not supported.",
  Math: "A KaTeX formula; display:true sets it on its own line.",
  Checklist: "Items with done flags.",
  Plan: "Ordered steps, each todo, doing, done or blocked.",
  Findings: "Review or analysis findings, each with its source (file, tool or reviewer) and severity.",
  Metrics: "Key numbers with optional unit; give previous (the value in your last version) to show the change when both are numbers.",
  Table: "A searchable sortable table; every row has a cell for every column key.",
  LineChart: "A line chart from inline points or a data attachment.",
  BarChart: "A bar chart from inline points or a data attachment; x is usually a label.",
  ScatterChart: "A scatter plot with numeric x, from inline points or a data attachment.",
  LiveRefs: "References that Yuzuno shows with their current state: task (e.g. T-12), pr (owner/repo#12), ci (run id), job, review (review id), agent or machine id.",
  Attachments: "Shows this section's attachments by name with optional captions.",
  Sources: "Explicit HTTPS or local file references; Table rows cite them by id in sourceIds.",
} as const satisfies Record<BriefComponent, string>;

const leaves = [
  "Markdown", "Math", "Checklist", "Plan", "Findings", "Metrics", "Table",
  "LineChart", "BarChart", "ScatterChart", "LiveRefs", "Attachments", "Sources",
] as const satisfies readonly Exclude<BriefComponent, "BriefBody" | "Group" | "Columns">[];
const element = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("BriefBody"),
    props: briefComponentProps.BriefBody.default({}),
    children: z.array(id).max(L.bodyChildren).optional(),
  }),
  z.strictObject({
    type: z.literal("Group"),
    props: briefComponentProps.Group,
    children: z.array(id).max(L.groupChildren).optional(),
  }),
  z.strictObject({
    type: z.literal("Columns"),
    props: briefComponentProps.Columns.default({}),
    children: z.array(id).min(2).max(L.columns),
  }),
  ...leaves.map((type) =>
    z.strictObject({
      type: z.literal(type),
      props: briefComponentProps[type],
      children: z.array(id).max(0).optional(),
    }),
  ),
]);
const bodySchema = z.strictObject({ root: id, elements: z.record(id, element) });

const replyOption = z.strictObject({ id, label: short });
const approach = z.strictObject({ id, label: short, detail: text.optional() });
const askSchema = z.strictObject({
  question: z.string().trim().min(1).max(L.questionChars),
  reply: z.strictObject({
    options: z.array(replyOption).min(L.askOptionsMin).max(L.askOptionsMax).optional(),
    freeText: z.union([z.literal(true), z.strictObject({ prompt: short.optional() })]).optional(),
    form: clarificationSchema.optional(),
    choice: z.strictObject({ a: approach, b: approach }).optional(),
  }),
});
const statusSchema = z.strictObject({ asOf: time, validFor: z.number().int().min(L.validForMin).max(L.validForMax) });
const timeSchema = z.strictObject({ due: time.optional(), eta: time.optional(), nextUpdate: time.optional() });
const attachmentSchema = z.strictObject({
  name: attachmentName,
  path: z.string().min(1).max(4096).optional(),
  url: z.string().min(1).max(2000).optional(),
  caption: z.string().max(500).optional(),
});
/** One `put`: the envelope without its op. */
const sectionSchema = z.strictObject({
  key: z.string().regex(BRIEF_KEY_PATTERN, "Use topic or topic/sub: each part 1-48 of a-z, 0-9 and -, starting with a letter or digit, e.g. round-12/review."),
  kind: z.enum(["ask", "report", "status"]),
  title: z.string().trim().min(1).max(L.titleChars),
  body: bodySchema,
  ask: askSchema.optional(),
  status: statusSchema.optional(),
  time: timeSchema.optional(),
  attachments: z.array(attachmentSchema).max(L.attachments).optional(),
});
export type BriefSection = z.infer<typeof sectionSchema>;
export type BriefBodySpec = z.infer<typeof bodySchema>;

/** Purely presentational props an Agent may leave out, as in result_publish. */
const BRIEF_DISPLAY_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ...DISPLAY_DEFAULTS,
  LineChart: { title: "Chart" },
  ScatterChart: { title: "Chart" },
};

/** What a rejected section's problems may say, for brief_guide errors. */
export const BRIEF_PROBLEM_CODES = {
  invalid_section: "The change is not an object.",
  unknown_field: "A field the format does not have.",
  missing_field: "A required field is missing.",
  invalid_field: "A value of the wrong type, format or range.",
  invalid_key: "The key is not topic or topic/sub.",
  unknown_component: "A component type outside the catalog.",
  too_many: "A list over its limit.",
  too_long: "A text over its limit.",
  too_large: `The body is over ${MAX_SPEC_BYTES} bytes of compact JSON.`,
  block_too_long: `A Markdown code or log block is over ${L.codeBlockLines} lines.`,
  too_many_points: `An inline chart has over ${L.chartPoints} points.`,
  too_many_refs: `The section has over ${L.liveRefs} LiveRefs.`,
  ask_required: "kind ask without ask.",
  ask_without_reply: "An ask without options, freeText, form or choice.",
  status_required: "kind status without status.",
  misplaced_field: "ask or status on a section of another kind.",
  root: "The root is not a BriefBody.",
  component_count: `Fewer than 1 or more than ${L.components} components.`,
  not_a_tree: `Elements are shared, cyclic or deeper than ${L.depth} levels.`,
  missing_component: "A child names a missing element.",
  extra_root: "More than one BriefBody.",
  unused_component: "An element not reachable from the root.",
  columns_widths: "Columns widths that do not match its children.",
  duplicate_id: "Two items, rows, columns, series or components share an id.",
  row_mismatch: "A Table row's cells do not match its columns.",
  invalid_source: "A Sources href that is not an http(s) URL or local path, or a duplicate source id.",
  missing_source: "A sourceIds entry with no matching source.",
  chart_data: "A chart without exactly one of series or data.",
  missing_attachment: "A name not in the section's attachments.",
  unused_attachment: "An attachment not used by a reachable Attachments block or chart data; add a reference or remove its registration with put.",
  chart_attachment: "A chart attachment that is not a CSV, JSON or JSONL file with a path.",
  attachment_location: "An attachment without exactly one of path or url, or with a path that is not absolute or a url that is not https.",
  duplicate_attachment: "Two attachments share a name.",
} as const;
type ProblemCode = keyof typeof BRIEF_PROBLEM_CODES;

/** Advice on a valid report or status section (brief-advice.ts); none refuses anything. */
export const BRIEF_ADVICE_CODES = {
  long_markdown: `A Markdown block over ${L.advice.markdownChars} characters, or a section whose Markdown is over ${L.advice.sectionMarkdownChars} characters in all.`,
  summary_may_be_missing: "A Table or chart and no non-empty Markdown, Findings or Metrics block.",
  duplicate_ref: "One LiveRefs or Sources block that names the same target twice.",
  many_refs: `Over ${L.advice.refs} different LiveRefs and Sources targets in one section.`,
} as const;

export const BRIEF_GUIDE_PARTS = ["sections", "ask", "content", "charts", "attachments", "limits", "errors", "examples"] as const;
export type BriefGuidePart = (typeof BRIEF_GUIDE_PARTS)[number];

/**
 * One reason a section is not valid: a stable code, where in the change
 * (e.g. "body.elements.log.props.text"), a reason an Agent can act on, and
 * the brief_guide part to read, e.g. "brief_guide charts".
 */
export type BriefProblem = { code: string; path: string; reason: string; guide: string };

/** A rejected section: at most MAX_PROBLEMS problems, the first one first. */
export class BriefError extends ResultError {
  readonly problems: BriefProblem[] = [];
  constructor(problems: BriefProblem[]) {
    const [first] = problems;
    super(first.code, first.reason, first.path, problems);
    this.name = "BriefError";
    this.problems = problems;
  }
}

type Path = (string | number)[];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function valueAt(value: unknown, path: Path): unknown {
  for (const step of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  return value;
}

/** The element a path is inside, if any: its key, type and the path within its props. */
function elementAt(input: unknown, path: Path) {
  if (path[0] !== "body" || path[1] !== "elements" || path.length < 3) return null;
  const key = String(path[2]);
  const node = valueAt(input, ["body", "elements", key]);
  const type = object(node) && typeof node.type === "string" ? node.type : undefined;
  const tail = path[3] === "props" ? path.slice(4) : path.slice(3);
  return { key, type, tail: tail.map(String), inProps: path[3] === "props" };
}

function where(input: unknown, path: Path): string {
  const found = elementAt(input, path);
  if (found) return `${found.type ?? "Element"} "${found.key}"${found.tail.length ? ` ${found.tail.join(".")}` : ""}`;
  return path.length ? path.join(".") : "The change";
}

/** The guide part for a path, before any remedy picks a better one. */
function partOf(input: unknown, path: Path): BriefGuidePart {
  const top = path[0];
  if (top === "ask") return "ask";
  if (top === "attachments") return "attachments";
  if (top !== "body") return "sections";
  const type = elementAt(input, path)?.type;
  if (type && isChart(type)) return "charts";
  return type === "Attachments" ? "attachments" : "content";
}

const remedies: Record<string, [string, BriefGuidePart]> = {
  "Table rows": ["Show the rows the user needs and leave the full table on its Task; a chart can read a CSV file attached as its data.", "content"],
  "Table columns": ["Keep the key columns and leave the full table on its Task.", "content"],
  "Markdown text": ["Keep the conclusion and a short excerpt here and leave the full text or log on its Task.", "content"],
  "Math tex": ["Split it into several Math blocks.", "content"],
  "Metrics items": ["Keep the key metrics and put the rest in a Table.", "content"],
  "Checklist items": ["Keep the open or most important items; the rest stay on the Task.", "limits"],
  "Plan steps": ["Keep the current steps; earlier ones stay on the Task.", "limits"],
  "Findings items": ["Keep the most severe findings and leave the full list on its Task.", "limits"],
  "LiveRefs items": ["Keep the most relevant references.", "limits"],
  "Attachments items": [`A section has at most ${L.attachments} attachments; show only the images and chart data the user needs.`, "attachments"],
  "series points": ["Read the data from a CSV, JSON or JSONL attachment with data:{attachment, x, series} instead.", "charts"],
  series: ["Split the series across several charts.", "charts"],
  "data series": ["Split the series across several charts.", "charts"],
  children: ["Group related components, or keep less here and leave the detail on its Task.", "content"],
  attachments: [`A section has at most ${L.attachments} attachments; show only the images and chart data the user needs.`, "attachments"],
};
function remedyFor(input: unknown, path: Path): [string, BriefGuidePart] | undefined {
  const found = elementAt(input, path);
  if (!found) return remedies[path.map(String).join(" ")];
  const named = found.tail.filter((step) => !/^\d+$/.test(step));
  if (found.inProps && found.type && named.length === 1 && remedies[`${found.type} ${named[0]}`])
    return remedies[`${found.type} ${named[0]}`];
  if (found.inProps && found.type && isChart(found.type) && named.length) return remedies[named.join(" ")];
  if (!found.inProps && found.tail[0] === "children") return remedies.children;
  return undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ID_PATTERN = String(/^[a-zA-Z][\w-]{0,63}$/);
const ID_RULE = "must start with a letter, then up to 63 letters, digits, - or _";

function problem(code: ProblemCode, path: Path | string, reason: string, part: BriefGuidePart): BriefProblem {
  return {
    code,
    path: typeof path === "string" ? path : path.map(String).join("."),
    reason: `${reason} (brief_guide ${part})`,
    guide: `brief_guide ${part}`,
  };
}

/** A zod issue as a problem an Agent can fix directly. */
function issueProblem(issue: z.ZodError["issues"][number], input: unknown): BriefProblem {
  const path = issue.path as Path;
  const at = where(input, path);
  const value = valueAt(input, path);
  const part = partOf(input, path);
  const found = elementAt(input, path);
  const component = found?.type && Object.hasOwn(briefComponentProps, found.type) ? (found.type as BriefComponent) : undefined;
  const propsHint = component ? ` ${component} props: ${componentSignature(component)}.` : "";
  switch (issue.code) {
    case "unrecognized_keys": {
      const shape = fieldHints[path.map((step) => (typeof step === "number" ? "N" : step)).join(".")];
      const hint = component && found?.inProps
        ? propsHint
        : found ? " Elements are {type, props, children?}." : shape ? ` Fields: ${signature(jsonSchema(shape), 1)}.` : "";
      const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
      return problem("unknown_field", path, `${at} has unknown field${issue.keys.length > 1 ? "s" : ""} ${keys}.${hint}`, part);
    }
    case "invalid_union":
      if (found && found.tail.length === 1 && found.tail[0] === "type" && !found.inProps)
        return problem(
          "unknown_component", path,
          `${value === undefined ? "Missing" : `Unknown`} component type${value === undefined ? "" : ` ${JSON.stringify(value)}`} in "${found.key}". Use one of: ${Object.keys(briefComponentProps).join(", ")}.`,
          "content",
        );
      return problem("invalid_field", path, `${at} has an invalid value.${propsHint}`, part);
    case "invalid_type":
      if (value === undefined) {
        const hint = path.join(".") === "ask.reply"
          ? " Give options, freeText, form or choice."
          : path.join(".") === "body" ? " body is {root, elements} with a BriefBody root." : propsHint;
        return problem(path.length === 0 ? "invalid_section" : "missing_field", path, `${at} is required.${hint}`, part);
      }
      return path.length === 0
        ? problem("invalid_section", path, `A put change is an object: {op:"put", key, kind, title, body, ...}.`, "sections")
        : problem("invalid_field", path, `${at} must be ${issue.expected}, not ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}.${propsHint}`, part);
    case "invalid_value":
      return problem("invalid_field", path, `${at} must be ${issue.values.map((v) => JSON.stringify(v)).join(" or ")}.`, part);
    case "invalid_format": {
      const code = path[0] === "key" && path.length === 1 ? "invalid_key" : "invalid_field";
      const isId = issue.format === "regex" && "pattern" in issue && issue.pattern === ID_PATTERN;
      return problem(code, path, isId ? `${at} ${ID_RULE}.` : `${at} is invalid. ${issue.message}`, part);
    }
    case "invalid_key":
      return problem("invalid_field", path, `Element id ${JSON.stringify(String(path.at(-1)))} ${ID_RULE}.`, "content");
    case "too_big": {
      const [remedy, remedyPart] = remedyFor(input, path) ?? ["", part];
      const tail = remedy ? ` ${remedy}` : "";
      if (issue.origin === "array" && Array.isArray(value)) {
        if (issue.maximum === 0) return problem("invalid_field", path, `${found?.type ?? "This component"} "${found?.key}" cannot have children; only BriefBody, Group and Columns do.`, "content");
        return problem("too_many", path, `${at} has ${value.length} items; the limit is ${issue.maximum}.${tail}`, remedyPart);
      }
      if (issue.origin === "string" && typeof value === "string")
        return problem("too_long", path, `${at} has ${value.length} characters; the limit is ${issue.maximum}.${tail}`, remedyPart);
      return problem("invalid_field", path, `${at} is ${String(value)}; the most is ${issue.maximum}.`, part);
    }
    case "too_small":
      if (issue.origin === "array" && Array.isArray(value))
        return problem("invalid_field", path, `${at} has ${plural(value.length, "item")}; it needs at least ${issue.minimum}.`, part);
      if (issue.origin === "string" && typeof value === "string") return problem("invalid_field", path, `${at} is empty.`, part);
      return problem("invalid_field", path, `${at} is ${String(value)}; the least is ${issue.minimum}.`, part);
    default:
      return problem("invalid_field", path, `${at}: ${issue.message}`, part);
  }
}

/** Lines inside each fenced block (``` or ~~~), in order; an unclosed fence runs to the end. */
export function fencedBlockLines(markdown: string): number[] {
  const sizes: number[] = [];
  let fence: { char: string; length: number } | null = null;
  let count = 0;
  for (const row of markdown.split(/\r\n|\r|\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row);
    if (!fence) {
      if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
        fence = { char: match[1][0], length: match[1].length };
        count = 0;
      }
    } else if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
      sizes.push(count);
      fence = null;
    } else count++;
  }
  if (fence) sizes.push(count);
  return sizes;
}

const DATA_FILE = /\.(csv|json|jsonl)$/i;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

/** The section with display defaults filled in, and without its op. */
function prepared(input: unknown): unknown {
  if (!object(input)) return input;
  const { op, ...rest } = input;
  const section: Record<string, unknown> = op === "put" ? rest : input;
  const body = section.body;
  if (!object(body) || !object(body.elements)) return section;
  const elements: Record<string, unknown> = { ...body.elements };
  for (const [key, node] of Object.entries(elements)) {
    if (!object(node) || typeof node.type !== "string" || !object(node.props)) continue;
    const defaults = Object.hasOwn(BRIEF_DISPLAY_DEFAULTS, node.type) ? BRIEF_DISPLAY_DEFAULTS[node.type] : undefined;
    const missing = defaults ? Object.keys(defaults).filter((prop) => !Object.hasOwn(node.props as object, prop)) : [];
    if (missing.length)
      elements[key] = { ...node, props: { ...node.props, ...Object.fromEntries(missing.map((prop) => [prop, defaults![prop]])) } };
  }
  return { ...section, body: { ...body, elements } };
}

/**
 * Checks one section, the `put` envelope with or without `op:"put"`, and
 * returns it normalized (without op, display defaults filled in, BriefBody
 * props {}). Throws BriefError with at most MAX_PROBLEMS problems. Schema
 * problems come first, all at once; then the body's tree; then every
 * per-block limit and cross-reference, all at once. previousBody is internal
 * Core context for a block edit with unchanged attachment registrations;
 * it is never read from the envelope or used for a put.
 */
export function checkBriefSection(envelope: unknown, previousBody?: unknown): BriefSection {
  const input = prepared(envelope);
  const problems: BriefProblem[] = [];
  const full = () => problems.length >= MAX_PROBLEMS;
  const add = (found: BriefProblem) => {
    if (!full()) problems.push(found);
  };
  const fail = () => new BriefError(problems.slice(0, MAX_PROBLEMS));

  // Measured as sent, before display defaults, like result_publish.
  const body = object(envelope) ? envelope.body : undefined;
  if (body !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(body) ?? "").length;
    if (bytes > L.bodyBytes)
      add(problem("too_large", "body", `The body is ${bytes} bytes of compact JSON; the limit is ${L.bodyBytes}. Keep the conclusion and short excerpts in the body and leave long logs, tables and data on the Task.`, "content"));
  }
  const parsed = sectionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(issueProblem(issue, input));
    throw fail();
  }
  const section = parsed.data;

  // The envelope.
  if (section.kind === "ask" && !section.ask)
    add(problem("ask_required", "ask", `A section of kind ask needs ask: {question, reply}.`, "ask"));
  if (section.kind !== "ask" && section.ask)
    add(problem("misplaced_field", "ask", `ask is only for kind ask; this section is ${section.kind}. Remove ask or use kind ask.`, "ask"));
  if (section.kind === "status" && !section.status)
    add(problem("status_required", "status", `A section of kind status needs status: {asOf, validFor}.`, "sections"));
  if (section.kind !== "status" && section.status)
    add(problem("misplaced_field", "status", `status is only for kind status; this section is ${section.kind}. Remove status or use kind status.`, "sections"));
  if (section.ask) {
    const { options, freeText, form, choice } = section.ask.reply;
    if (!options && !freeText && !form && !choice)
      add(problem("ask_without_reply", "ask.reply", "An ask needs at least one way to answer: options (2-8 buttons), freeText, form or choice.", "ask"));
    if (options && new Set(options.map((o) => o.id)).size !== options.length)
      add(problem("duplicate_id", "ask.reply.options", "Option ids must be unique.", "ask"));
    if (choice && choice.a.id === choice.b.id)
      add(problem("duplicate_id", "ask.reply.choice", "choice.a and choice.b need different ids.", "ask"));
  }
  const files = new Map<string, NonNullable<BriefSection["attachments"]>[number]>();
  (section.attachments ?? []).forEach((attachment, index) => {
    const at = `attachments.${index}`;
    if (files.has(attachment.name))
      add(problem("duplicate_attachment", `${at}.name`, `Attachment name "${attachment.name}" is used twice; names must be unique in a section.`, "attachments"));
    files.set(attachment.name, attachment);
    if ((attachment.path === undefined) === (attachment.url === undefined))
      add(problem("attachment_location", at, `Attachment "${attachment.name}" needs exactly one of path (an absolute file path on the Core host) or url (an https link).`, "attachments"));
    else if (attachment.path !== undefined && (!ABSOLUTE.test(attachment.path) || /[\u0000-\u001f\u007f]/.test(attachment.path)))
      add(problem("attachment_location", `${at}.path`, `Attachment "${attachment.name}" path must be absolute, e.g. /home/me/run/loss.csv.`, "attachments"));
    else if (attachment.url !== undefined && (!/^https:\/\//i.test(attachment.url) || sourceTarget(attachment.url)?.kind !== "web"))
      add(problem("attachment_location", `${at}.url`, `Attachment "${attachment.name}" url must be an https link without credentials.`, "attachments"));
  });

  // The body's tree: one BriefBody root, every element used once.
  const spec = section.body;
  const entries = Object.entries(spec.elements);
  if (!entries.length || entries.length > L.components) {
    add(problem("component_count", "body.elements", `The body has ${entries.length} components; use between 1 and ${L.components}. Keep what the user needs here and leave the detail on its Task.`, "content"));
    throw fail();
  }
  if (spec.elements[spec.root]?.type !== "BriefBody") {
    add(problem("root", "body.root", `body.root must name a BriefBody element; "${spec.root}" is ${spec.elements[spec.root] ? `a ${spec.elements[spec.root].type}` : "missing"}.`, "content"));
    throw fail();
  }
  const seen = new Set<string>();
  const tree = (key: string, depth: number): BriefProblem | null => {
    if (depth > L.depth || seen.has(key))
      return problem("not_a_tree", `body.elements.${key}`, `"${key}" is used twice, is part of a cycle or is deeper than ${L.depth} levels; each element is the child of one parent.`, "content");
    const node = spec.elements[key];
    if (!node) return problem("missing_component", `body.elements.${key}`, `A child names "${key}", which is not in body.elements.`, "content");
    if (key !== spec.root && node.type === "BriefBody")
      return problem("extra_root", `body.elements.${key}`, `Only the root is a BriefBody; use Group for "${key}".`, "content");
    seen.add(key);
    for (const child of node.children ?? []) {
      const found = tree(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const broken = tree(spec.root, 1);
  if (broken) {
    add(broken);
    throw fail();
  }
  if (seen.size !== entries.length) {
    const unused = entries.map(([key]) => key).filter((key) => !seen.has(key));
    const names = unused.map((key) => `"${key}"`).join(", ");
    add(problem("unused_component", "body.elements", `${unused.length === 1 ? `Element ${names} is` : `Elements ${names} are`} not reachable from the root; add ${unused.length === 1 ? "it" : "them"} as a child or remove ${unused.length === 1 ? "it" : "them"}.`, "content"));
    throw fail();
  }

  // Each block: limits, unique ids and references.
  const groups = new Set<string>();
  const sources = new Set<string>();
  const cited: { key: string; source: string }[] = [];
  let refs = 0;
  const unique = (ids: string[], path: string, what: string) => {
    const dupe = ids.find((value, index) => ids.indexOf(value) !== index);
    if (dupe !== undefined) add(problem("duplicate_id", path, `${what} "${dupe}" is used twice; ids must be unique.`, "content"));
  };
  const needsFile = (name: string, path: string, chart: boolean) => {
    const file = files.get(name);
    if (!file)
      return add(problem("missing_attachment", path, `"${name}" is not in this section's attachments; add {name: "${name}", path} to attachments.`, "attachments"));
    if (chart && (file.path === undefined || !DATA_FILE.test(file.path)))
      add(problem("chart_attachment", path, `Charts read data files only: attachment "${name}" needs a path ending in .csv, .json or .jsonl.`, "charts"));
  };
  for (const [key, node] of entries) {
    const at = `body.elements.${key}.props`;
    switch (node.type) {
      case "Markdown": {
        fencedBlockLines((node.props as Props<"Markdown">).text).forEach((lines, index) => {
          if (lines > L.codeBlockLines)
            add(problem("block_too_long", `${at}.text`, `Markdown "${key}" code block ${index + 1} has ${lines} lines; the limit is ${L.codeBlockLines}. Keep a short excerpt here and leave the full log or code on its Task.`, "content"));
        });
        break;
      }
      case "Checklist":
      case "Findings":
        unique((node.props as Props<"Checklist">).items.map((item) => item.id), `${at}.items`, `${node.type} "${key}" item id`);
        break;
      case "Plan":
        unique((node.props as Props<"Plan">).steps.map((step) => step.id), `${at}.steps`, `Plan "${key}" step id`);
        break;
      case "LiveRefs":
        refs += (node.props as Props<"LiveRefs">).items.length;
        break;
      case "Columns": {
        const widths = (node.props as Props<"Columns">).widths;
        const count = node.children?.length ?? 0;
        if (widths && widths.length !== count)
          add(problem("columns_widths", `${at}.widths`, `Columns "${key}" has ${count} children but ${widths.length} widths; give one width per child, or leave widths out for equal columns.`, "content"));
        break;
      }
      case "Attachments":
        (node.props as Props<"Attachments">).items.forEach((item, index) => needsFile(item.name, `${at}.items.${index}.name`, false));
        break;
      case "Sources":
        for (const item of (node.props as Props<"Sources">).items) {
          if (sources.has(item.id) || !sourceTarget(item.href))
            add(problem("invalid_source", `${at}.items`, `Source "${item.id}" is a duplicate or its href is not an http(s) URL or local file path.`, "content"));
          sources.add(item.id);
        }
        break;
      case "Table": {
        const props = node.props as Props<"Table">;
        if (groups.has(props.id)) add(problem("duplicate_id", `${at}.id`, `Table and chart ids must be unique; "${props.id}" is used twice.`, "content"));
        groups.add(props.id);
        unique(props.rows.map((row) => row.id), `${at}.rows`, `Table "${key}" row id`);
        const keys = props.columns.map((column) => column.key);
        unique(keys, `${at}.columns`, `Table "${key}" column key`);
        const mismatch = props.rows.findIndex(
          (row) => Object.keys(row.cells).length !== keys.length || keys.some((column) => !Object.hasOwn(row.cells, column)),
        );
        if (mismatch >= 0)
          add(problem("row_mismatch", `${at}.rows.${mismatch}.cells`, `Table "${key}" row ${mismatch + 1} must have exactly one cell per column key: ${keys.join(", ")}.`, "content"));
        for (const item of props.rows) for (const source of item.sourceIds ?? []) cited.push({ key, source });
        break;
      }
      default:
        if (isChart(node.type)) {
          const props = node.props as Props<"LineChart">;
          if (groups.has(props.id)) add(problem("duplicate_id", `${at}.id`, `Table and chart ids must be unique; "${props.id}" is used twice.`, "charts"));
          groups.add(props.id);
          if (!props.series === !props.data) {
            add(problem("chart_data", at, `${node.type} "${key}" needs exactly one of series (inline points) or data (a data attachment).`, "charts"));
            break;
          }
          if (props.series) {
            const points = props.series.reduce((sum, series) => sum + series.points.length, 0);
            if (points > L.chartPoints)
              add(problem("too_many_points", `${at}.series`, `${node.type} "${key}" has ${points} inline points; the limit is ${L.chartPoints} across all series. Read the data from a CSV, JSON or JSONL attachment with data:{attachment, x, series} instead.`, "charts"));
            const names = props.series.map((series) => series.name);
            if (new Set(names).size !== names.length) add(problem("duplicate_id", `${at}.series`, `${node.type} "${key}" series names must be unique.`, "charts"));
          }
          if (props.data) {
            needsFile(props.data.attachment, `${at}.data.attachment`, true);
            const names = props.data.series.map((series) => series.name);
            if (new Set(names).size !== names.length) add(problem("duplicate_id", `${at}.data.series`, `${node.type} "${key}" series names must be unique.`, "charts"));
          }
        }
    }
  }
  if (refs > L.liveRefs)
    add(problem("too_many_refs", "body.elements", `The section has ${refs} LiveRefs items; the limit is ${L.liveRefs} per section, across all LiveRefs. Keep the most relevant references.`, "limits"));
  const missing = cited.find(({ source }) => !sources.has(source));
  if (missing)
    add(problem("missing_source", `body.elements.${missing.key}.props.rows`, `Table "${missing.key}" cites source "${missing.source}", which no Sources element lists.`, "content"));
  const usedFiles = attachmentReferences(section.body);
  // Only Core's block-edit path supplies the stored body. Edits cannot
  // change attachments: tolerate an already-unused registration, but never
  // let an edit remove its last reference. Puts get no compatibility context.
  const previousUses = previousBody === undefined ? undefined : attachmentReferences(previousBody);
  (section.attachments ?? []).forEach((attachment, index) => {
    if (!usedFiles.has(attachment.name) && (previousUses === undefined || previousUses.has(attachment.name)))
      add(problem("unused_attachment", `attachments.${index}.name`,
        `Attachment "${attachment.name}" is registered but not used in the body. Add a reachable Attachments block with items:[{name:"${attachment.name}"}] (for data files, chart data.attachment also counts), or put the section without this registration. Registration alone does not display a preview.`, "attachments"));
  });
  if (problems.length) throw fail();
  return section;
}

/** Actual consumers only, reached from the root; Markdown/Sources text and
 * orphaned components do not display registered files. Also reads stored
 * pre-upgrade bodies without applying new write-time rules to history. */
function attachmentReferences(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!object(body) || typeof body.root !== "string" || !object(body.elements)) return names;
  const elements = body.elements;
  const seen = new Set<string>();
  const pending = [body.root];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = elements[key];
    if (!object(node)) continue;
    if (object(node.props)) {
      if (node.type === "Attachments" && Array.isArray(node.props.items)) {
        for (const item of node.props.items)
          if (object(item) && typeof item.name === "string") names.add(item.name);
      } else if (typeof node.type === "string" && isChart(node.type) && object(node.props.data)
        && typeof node.props.data.attachment === "string") names.add(node.props.data.attachment);
    }
    if (["BriefBody", "Group", "Columns"].includes(String(node.type)) && Array.isArray(node.children))
      for (const child of node.children) if (typeof child === "string") pending.push(child);
  }
  return names;
}

// ---------------------------------------------------------------------------
// What Agents are told: hard rules, tool descriptions and brief_guide, all
// generated from the catalog above.

type Json = { [key: string]: unknown };
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Json;

/**
 * A compact signature of a schema, from its JSON Schema: `{a, b?, c[1-30]{…}, d: x|y}`.
 * Objects deeper than `depth`, and properties named in `collapse`, are shown as {…}.
 */
function signature(schema: Json, depth = Infinity, collapse: readonly string[] = []): string {
  const inner = (value: Json) => signature(value, depth, collapse);
  const range = (min: unknown, max: unknown) =>
    min !== undefined && max !== undefined ? `[${min}-${max}]` : max !== undefined ? `[≤${max}]` : min ? `[≥${min}]` : "";
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return (union as Json[]).map(inner).join("|");
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).join("|");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === "array") {
    if (Array.isArray(schema.prefixItems)) return `[${(schema.prefixItems as Json[]).map(inner).join(", ")}]`;
    const items = schema.items ? inner(schema.items as Json) : "";
    return `${range(schema.minItems, schema.maxItems)}${/^[{[]/.test(items) ? items : `(${items})`}`;
  }
  if (schema.type === "object") {
    if (depth < 1) return "{…}";
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required ?? []) as string[]);
    const extra = schema.additionalProperties;
    if (!Object.keys(properties).length && extra && typeof extra === "object")
      return `{<key>: ${signature(extra as Json, depth - 1, collapse)}}`;
    return `{${Object.entries(properties)
      .map(([key, value]) => {
        const shown = collapse.includes(key) ? "{…}" : signature(value, depth - 1, collapse);
        const name = `${key}${required.has(key) || value.default !== undefined ? "" : "?"}`;
        if (value.type === "array" || /^[{[]/.test(shown)) return `${name}${shown}`;
        return value.type === "string" && !value.enum ? name : `${name}: ${shown}`;
      })
      .join(", ")}}`;
  }
  return typeof schema.type === "string" ? schema.type : "value";
}
const componentSignature = (type: BriefComponent) => signature(jsonSchema(sentProps(type)));
/** The allowed fields named when an envelope object has an unknown one. */
const fieldHints: Record<string, z.ZodType> = {
  "": sectionSchema, body: bodySchema, ask: askSchema, "ask.reply": askSchema.shape.reply,
  "ask.reply.choice": askSchema.shape.reply.shape.choice, status: statusSchema, time: timeSchema, "attachments.N": attachmentSchema,
};

/** Props as an Agent may send them: display defaults make their fields optional. */
function sentProps(type: BriefComponent): z.ZodType {
  const props = briefComponentProps[type];
  const defaults = Object.hasOwn(BRIEF_DISPLAY_DEFAULTS, type) ? BRIEF_DISPLAY_DEFAULTS[type] : undefined;
  if (!defaults) return props;
  const shape = (props as z.ZodObject).shape;
  return (props as z.ZodObject).extend(
    Object.fromEntries(Object.keys(defaults).map((key) => [key, (shape[key] as z.ZodType).optional()])),
  );
}

// Every component line uses the formatter result_guide uses (T-86), so the
// two guides read alike. Its notes follow the description directly.
const spaced = (notes: string) => (notes ? ` ${notes}` : "");

const componentLine = (type: BriefComponent) => {
  const defaults = Object.hasOwn(BRIEF_DISPLAY_DEFAULTS, type) ? BRIEF_DISPLAY_DEFAULTS[type] : undefined;
  const notes = [
    type === "BriefBody" ? `Children: at most ${L.bodyChildren}.` : type === "Group" ? `Children: at most ${L.groupChildren}.` : type === "Columns" ? `Children: 2-${L.columns}, one per column.` : "",
    // The shared formatter has no notation for a tuple: say what a point is.
    type === "LineChart" || type === "BarChart" || type === "ScatterChart" ? "Each point is an [x, y] pair." : "",
    defaults ? Object.entries(defaults).map(([key, value]) => `${key} defaults to "${value}".`).join(" ") : "",
  ].filter(Boolean).join(" ");
  return formatComponentGuide(type, sentProps(type), BRIEF_COMPONENT_DESCRIPTIONS[type], spaced(notes));
};

/** Worked examples: each is a valid `put` change. */
export const BRIEF_EXAMPLES = {
  image: {
    op: "put", key: "preview", kind: "report", title: "Layout preview",
    attachments: [{ name: "layout.png", path: "/home/me/run/layout.png" }],
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["image"] },
        image: { type: "Attachments", props: { items: [{ name: "layout.png", caption: "Screenshot of the updated layout" }] } },
      },
    },
  },
  status: {
    op: "put",
    key: "training",
    kind: "status",
    title: "Training run 12",
    status: { asOf: "2026-10-17T08:00:00Z", validFor: 3600 },
    time: { eta: "2026-10-17T14:00:00Z", nextUpdate: "2026-10-17T09:00:00Z" },
    attachments: [{ name: "loss.csv", path: "/home/me/runs/12/loss.csv", caption: "Loss per step" }],
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["metrics", "loss"] },
        metrics: {
          type: "Metrics",
          props: {
            items: [
              { label: "Validation loss", value: 0.412, previous: 0.437 },
              { label: "Throughput", value: 1830, unit: "samples/s", previous: 1795 },
              { label: "Step", value: "18k of 40k" },
            ],
          },
        },
        loss: {
          type: "LineChart",
          props: {
            id: "loss",
            title: "Loss",
            x: { label: "Step" },
            y: { label: "Loss" },
            data: {
              attachment: "loss.csv",
              x: "step",
              series: [{ name: "Train", column: "train_loss" }, { name: "Validation", column: "val_loss" }],
            },
          },
        },
      },
    },
  },
  result: {
    op: "put",
    key: "round-12/review",
    kind: "report",
    title: "Review of round 12",
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["summary", "findings", "evidence"] },
        summary: {
          type: "Markdown",
          props: { text: "Round 12 passes **213 of 214** tests and is merged; it is not in a release yet. The failure:\n\n```text\nFAIL brief limits: stale version accepted after restart\n```" },
        },
        findings: {
          type: "Findings",
          props: {
            title: "Findings",
            items: [
              { id: "f1", source: "core/src/project_brief/mod.rs:120", severity: "medium", text: "A stale version is accepted after a restart." },
              { id: "f2", source: "web/src/home/Home.tsx", severity: "low", text: "Long titles are clipped in a narrow window." },
            ],
          },
        },
        evidence: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-12", label: "Round 12, with its test log" }] } },
      },
    },
  },
  compare: {
    op: "put",
    key: "batch-size",
    kind: "report",
    title: "Larger batch against the baseline",
    attachments: [{ name: "runs.csv", path: "/home/me/runs/summary.csv", caption: "Validation loss of each run" }],
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["answer", "loss"] },
        answer: {
          type: "Markdown",
          props: { text: "The larger batch ends with **6% lower validation loss** than the baseline. One seed each, so the gap may be noise; a second seed is queued." },
        },
        loss: {
          type: "BarChart",
          props: {
            id: "loss",
            title: "Validation loss, lower is better",
            x: { label: "Run" },
            y: { label: "Loss" },
            data: { attachment: "runs.csv", x: "run", series: [{ name: "Validation loss", column: "val_loss" }] },
          },
        },
      },
    },
  },
  overview: {
    op: "put",
    key: "overview",
    kind: "status",
    title: "Overview",
    status: { asOf: "2026-10-18T05:00:00Z", validFor: 86400 },
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["now", "split"] },
        now: { type: "Group", props: { title: "Where we are", tone: "accent" }, children: ["summary"] },
        summary: { type: "Markdown", props: { text: "Run 12 is converging; **one decision** blocks run 13." } },
        split: { type: "Columns", props: { widths: [3, 2] }, children: ["work", "next"] },
        work: { type: "Group", props: { title: "Progress and findings" }, children: ["progress", "findings"] },
        progress: {
          type: "Plan",
          props: {
            steps: [
              { id: "baseline", text: "Baseline run", state: "done" },
              { id: "run-12", text: "Run 12, larger batch", state: "doing" },
              { id: "ablations", text: "Ablations", state: "todo" },
            ],
          },
        },
        findings: {
          type: "Findings",
          props: { items: [{ id: "warmup", source: "run 12", severity: "info", text: "Validation loss falls 6% once warm-up ends." }] },
        },
        next: { type: "Group", props: { title: "Decisions and Jobs" }, children: ["decisions", "jobs"] },
        decisions: { type: "Checklist", props: { items: [{ id: "split", text: "Choose the run 13 split", done: false }] } },
        jobs: { type: "LiveRefs", props: { items: [{ kind: "task", id: "T-12", label: "Run 12" }] } },
      },
    },
  },
  decision: {
    op: "put",
    key: "next-run",
    kind: "ask",
    title: "Which split for run 13?",
    ask: {
      question: "Run 12 overfits after step 30k. Should run 13 use the larger validation split or keep the current one?",
      reply: {
        options: [{ id: "larger", label: "Larger split" }, { id: "keep", label: "Keep current" }],
        freeText: { prompt: "Anything else to change?" },
      },
    },
    body: {
      root: "body",
      elements: {
        body: { type: "BriefBody", props: {}, children: ["why"] },
        why: { type: "Markdown", props: { text: "The larger split costs about 6% of training data." } },
      },
    },
  },
} as const;

// Built on first use: the validator Core runs never needs the guide.
let built: Record<BriefGuidePart, string[]> | undefined;
const guideParts = (): Record<BriefGuidePart, string[]> => (built ??= {
  sections: [
    `This guide is the format. What to write and in which form is yuzuno_guide topic brief ("Write for Home"): one conclusion first, important limits beside it, each fact in one place, and execution evidence (logs, raw data, full test output, run and PR lists) left on its Task and linked.`,
    `What goes where: ${BRIEF_OUTCOME_HINT} Update a section when something changed, not every turn; a status past its validFor shows as stale until new facts refresh it. Details stay on the Task and its sources.`,
    `Home content editors are set by the user per Project. brief_get returns you.capabilities. When editContent is false and writeOwnAsk is true, only create/update/resolve/remove your own Asks or send noChange; do not claim sections, convert regular content into an Ask, or write reports/status. When writeOwnAsk is false, this Brief is read-only, including no noChange writes. Ownership rules still apply to editors. Hidden old content remains in team details/history.`,
    `brief_update takes changes: [...]. put creates or replaces one section you own:`,
    `- put {op:"put", ${signature(jsonSchema(sectionSchema), 1).slice(1)}`,
    `- key: topic or topic/sub; each part 1-48 of a-z, 0-9 and -, starting with a letter or digit (round-12, round-12/review). A Brief has at most ${L.topics} topics with ${L.subtopicsPerTopic} subs each.`,
    `- kind: ask (a question for the user, see ask); report (a result the user reads and marks seen; seen reports stay in history ${L.historyDays} days); status (current state; needs status {asOf, validFor}, validFor ${L.validForMin}-${L.validForMax} seconds; greyed once asOf + validFor has passed).`,
    `- title: 1-${L.titleChars} characters. body: {root, elements}, see content. time: due, eta and nextUpdate, ISO 8601 with a time zone. attachments: see attachments.`,
    `edit {op:"edit", key, elements:{<id>: {type, props, children?}}, status?} replaces blocks of a section you own by id and keeps the rest as it was: the other blocks and their order, title, attachments, time and the ask's state. Each id is one the body already has, or a new block named as a child by a block you edit; the root is not edited (rearrange with put). Core checks the whole section again. status (kind status only) refreshes asOf. Day to day, edit the blocks that changed, e.g. {op:"edit", key:"overview", elements:{progress:{type:"Plan", props:{steps:[...]}}}}; put a section to create it or change its layout.`,
    `Other changes: {op:"resolve", key} resolves your ask; {op:"remove", key} removes your section (reports and status go to history); {op:"claim", key} takes an orphaned section of your Project; change it in a later brief_update, not in the one that claims it.`,
    `Only a section's owner changes it. To add to another Agent's section, put your own section under its key as topic/sub; Home shows them together with each author.`,
    `Pass expectedVersion from brief_get. On version_conflict the rejection includes latest: merge and retry with a new requestId. Nothing requires an update each turn; noChange:true is still accepted and changes nothing.`,
  ],
  ask: [
    `kind ask needs ask:`,
    `- ask ${signature(jsonSchema(askSchema), Infinity, ["form"])}: a question and how the user can answer.`,
    `- question: 1-${L.questionChars} characters. reply needs at least one of options, freeText, form or choice; otherwise the change is rejected.`,
    `- options: ${L.askOptionsMin}-${L.askOptionsMax} buttons; each sends one prefilled reply message to you. freeText: true, or {prompt} to label the text box. choice: two approaches a and b.`,
    formatComponentGuide("form", clarificationSchema, COMPONENT_DESCRIPTIONS.Clarification, spaced(`At most ${L.formFields} fields, ${L.formOptions} options each.`)),
    `The user's answer reaches you as an ordinary message quoting the section. The ask then shows "replied": it leaves Needs you, and brief_get lists it in you.repliedAsks (key, title, repliedAt, the reply in short, updatedSinceReply). It stays until you resolve it with {op:"resolve", key}; nothing closes it for you.`,
    `When to resolve: a preference or information you asked for, once you have taken it in; an action the reply authorizes, only after that action is confirmed done and its result is on the existing Task or a Brief section. A green CI or a whole Task being done is not that action. While it runs, or after it fails, keep the ask replied and report progress on the Task or Brief: edit keeps it replied, while put asks it again. Ask again only when the user has something new to decide. A reply executes nothing by itself: act on what the user has authorized, an explicit reply included, without asking for it again, and never infer a retry, merge or wider permission from an answer that does not grant it.`,
    `openAsks counts your unresolved asks, open or replied; at most ${L.openAsksPerAgent} per Agent.`,
    `Answers never execute actions: nothing in a Brief merges, deploys or approves; Core approvals stay separate.`,
  ],
  content: [
    `body is {root, elements}: elements maps ids (a letter, then letters, digits, - or _) to {type, props, children?}. root names the one BriefBody. The elements form one tree: each used once, at most ${L.depth} levels and ${L.components} components, at most ${L.bodyBytes} bytes of compact JSON. Only BriefBody, Group and Columns have children. ${SIGNATURE_LEGEND} Components:`,
    ...(Object.keys(briefComponentProps) as BriefComponent[]).filter((type) => !isChart(type)).map(componentLine),
    `- ${CHARTS.join(", ")}: see charts.`,
    `Table and chart ids, row ids, item ids and column keys are unique. Sources hrefs are http(s) URLs or local file paths (optionally :line); Table rows cite them by id in sourceIds.`,
    `Form follows the information, unless the user or Project prefers another: a real screenshot or a labelled sketch (say which) for a UI or layout change, a chart of measured data for quantities and how they relate, a short sentence for a single state. The result, compare and decision examples show each; image shows a screenshot.`,
    `Layout: a short answer first, the first Markdown on its own or in a Group with tone accent, since its first paragraph is what a reader sees first; then a Columns of Groups for parts that sit side by side, as in the overview example. Keep each block's id across versions: edit changes one block by its id (see sections).`,
  ],
  charts: [
    ...CHARTS.map(componentLine),
    `Give exactly one of:`,
    `- series: inline points [[x, y], ...], at most ${L.chartPoints} points across all series. LineChart and BarChart x is a number or a short label; ScatterChart x is a number; y is a number.`,
    `- data: {attachment, x, series:[{name, column}]}. attachment names one of this section's attachments whose path ends in .csv, .json or .jsonl (CSV with a header row, a JSON array of objects, or one JSON object per line). x and each column name a CSV header or JSON key. Yuzuno reads the snapshot taken when you wrote the section and downsamples each series to at most ${L.chartPointsPerSeriesFromData} points.`,
    `At most ${L.chartSeries} series per chart. Use data for anything over ${L.chartPoints} points.`,
  ],
  attachments: [
    formatComponentGuide("attachments", z.array(attachmentSchema).max(L.attachments), "Files and links of this section."),
    `- Give exactly one of path or url. name is unique in the section; the body refers to it.`,
    `- path: an absolute path on the machine where Core runs. Files up to 25 MB are kept as a snapshot when you write the section; larger files and directories are only referenced and marked "may have changed".`,
    `- url: an https link, shown as a link only, never embedded.`,
    `Images, data files (CSV, JSON, JSONL), PDF, logs and text (the last 200 lines are previewed) and links. Show them in the body with Attachments; charts read data files (see charts).`,
    `Registration alone saves/references a file; it does not show it. Every attachment in a put must be used by a reachable Attachments.items entry with the exact name, or by LineChart/BarChart/ScatterChart data.attachment. Markdown/Sources mentions and disconnected blocks do not count. Multiple components may use the same name. Chart data use does not also display a file preview; add Attachments if that is wanted.`,
    `An unused_attachment rejection leaves the old content, snapshots and ask state unchanged. Add a reachable Attachments block, reference a supported data file from a chart, or put the section without the unused registration. Checks use the final merged body, not just an edit's blocks. Existing sections/history remain readable. An unrelated edit keeps already-unused old registrations; removing a previously used attachment's last reference is rejected. A put checks every registration, including old ones.`,
    `Image preview example: ${JSON.stringify(BRIEF_EXAMPLES.image)}`,
    `Chart-only data example: ${JSON.stringify(BRIEF_EXAMPLES.status)}`,
    `Attach what the user should look at: a screenshot or a sketch (its caption says which) and the data file a chart reads. Logs, raw data, full tables and test output are execution evidence: leave them on their Task and link it with LiveRefs instead of attaching them here.`,
  ],
  limits: [
    `- Brief: ${L.topics} topics, ${L.subtopicsPerTopic} subs per topic, ${L.openAsksPerAgent} open asks per Agent; seen reports stay ${L.historyDays} days.`,
    `- Body: ${L.bodyBytes} bytes of compact JSON, ${L.components} components, ${L.depth} levels; BriefBody ${L.bodyChildren} children, Group ${L.groupChildren}, Columns 2-${L.columns}.`,
    `- Markdown: each fenced code or log block ${L.codeBlockLines} lines. Math: ${L.mathChars} characters.`,
    `- Checklist, Plan and Findings: ${L.listItems} items each. Metrics: ${L.metrics}. Sources: ${L.sources}.`,
    `- Table: ${L.tableRows} rows, ${L.tableColumns} columns.`,
    `- Charts: ${L.chartSeries} series; inline ${L.chartPoints} points in total; data attachments downsampled to ${L.chartPointsPerSeriesFromData} points per series.`,
    `- LiveRefs: ${L.liveRefs} per section. Attachments: ${L.attachments} per section; snapshots 25 MB per file, 1 GB per Brief (oldest history pruned first).`,
    `- ask: ${L.askOptionsMin}-${L.askOptionsMax} options; form 1-${L.formFields} fields, 2-${L.formOptions} options each.`,
    `Over a limit, the rejection says what to keep here and what to leave on the Task.`,
  ],
  errors: [
    `A rejected brief_update lists at most ${MAX_PROBLEMS} problems {code, path, reason, guide}. path is where in your change (e.g. body.elements.log.props.text); reason says what to change; guide names the brief_guide part to read. Fix them all and call brief_update again with a new requestId.`,
    ...Object.entries(BRIEF_PROBLEM_CODES).map(([code, meaning]) => `- ${code}: ${meaning}`),
    `- ask_only: Your current Project permission allows only your own valid asks and optional noChange. Only the user can select content editors. Read brief_get you.capabilities and keep internal progress in tasks and mail.`,
    `Core also rejects version_conflict (the Brief changed; the rejection includes latest: merge and retry), no_active_turn (call it during your turn), unknown_element and edit_root (an edit naming a block the section does not have, or its root), and changes that break owner, topic or open-ask rules.`,
  ],
  examples: [
    `Each is one change for brief_update changes.`,
    ...Object.entries(BRIEF_EXAMPLES).map(([name, example]) => `${name}:\n${JSON.stringify(example)}`),
  ],
});

/** brief_guide text: one part, or every part in order. */
export function briefGuide(part?: BriefGuidePart): string {
  if (part === undefined)
    return [
      `# brief_guide (Project Brief schema ${BRIEF_SCHEMA_VERSION})`,
      `Parts: ${BRIEF_GUIDE_PARTS.join(", ")}. Call brief_guide with part to read one.`,
      ...BRIEF_GUIDE_PARTS.map((name) => briefGuide(name)),
    ].join("\n\n");
  if (!(BRIEF_GUIDE_PARTS as readonly string[]).includes(part)) throw new Error(`Unknown brief_guide part: ${part}`);
  return [`## ${part}`, ...guideParts()[part]].join("\n");
}

/**
 * Where an outcome belongs on Home, in one sentence. Core adds it, without
 * acting on it, where a content editor meets an outcome: brief_get, a task
 * result it submits or receives, and result_publish.
 */
export const BRIEF_OUTCOME_HINT =
  `Home: a lasting finding, decision or stage result goes in a short report linked to its Task and sources; a current state in a status; a choice for the user in an ask. result_publish shows only in this turn. How to write it: yuzuno_guide brief.`;

/**
 * Always loaded, so short and most important first: Claude's system prompt
 * append and MCP server instructions, Codex's developerInstructions.
 */
export const BRIEF_HARD_RULES = [
  `Yuzuno Project Brief rules:`,
  `1. No Brief update is required each turn: write when something changed, for the user: conclusion first, limits beside it, evidence on its Task. A current state goes in a status, a lasting finding or decision in a short report linked to its Task, a choice for the user in an ask; result_publish never reaches Home. Load tools with tool search if needed.`,
  `2. Pass expectedVersion from brief_get. On version_conflict, re-read (the rejection has the latest), merge and retry with a new requestId.`,
  `3. Only the user selects Home content editors. If editContent is false and writeOwnAsk is true, write only your own Asks. If writeOwnAsk is false, this Brief is read-only. Editors still edit only their own sections; add a topic/sub to another author's topic.`,
  `4. An ask needs a question plus reply options, freeText, a form or a choice. A reply marks it replied. Resolve your asks explicitly with resolve once they are handled: a preference once taken in, an authorized action only after it is done and its result is on the Task or Brief. A reply executes nothing itself: act on what the user authorized, a reply included, and infer no retry, merge or permission it does not grant.`,
  `5. Brief content never executes actions: nothing you write merges, deploys or approves; answers come back to you as messages.`,
  `6. If brief_update is rejected, fix the listed problems and call it again. Read yuzuno_guide brief for what to write and brief_guide for formats, limits and examples.`,
].join("\n");

export const BRIEF_TOOL_DESCRIPTIONS = {
  brief_get:
    `Read your Project's Brief: its version, the live sections (key, kind, title, owner, body, ask state, status, attachments), ` +
    `you {agentId, ownsKeys, openAsks, repliedAsks (your asks the user answered, to act on and resolve), staleStatus, capabilities} and the limits. ` +
    `keys: omit for every section with its body; [] for an index of the sections without bodies; [key, ...] for those sections in full. ` +
    `Pass its version to brief_update as expectedVersion. projectId defaults to your own Project. Nothing requires reading or updating the Brief each turn. Formats: brief_guide.`,
  brief_update:
    `Write Brief changes when something changed; nothing requires a call each turn. Ask-only members may write only their own Asks. Pass expectedVersion (from ` +
    `brief_get) and a new requestId (reuse it only to retry the same call). Send changes:[...] (noChange:true is accepted and ` +
    `changes nothing). Changes: put {op:"put", key, kind, title, body, ask?, status?, time?, attachments?} ` +
    `creates or replaces a section you own; edit {op:"edit", key, elements:{<id>: block}} replaces only those ` +
    `blocks; resolve {op:"resolve", key} resolves your ask; remove {op:"remove", key} ` +
    `removes your section; claim {op:"claim", key} takes an orphaned section of your Project (change it in a later call). ` +
    `key is topic or topic/sub ` +
    `(a-z, 0-9, -); add to another Agent's section with a topic/sub key of your own. kind ask needs ask {question, reply} ` +
    `with reply options, freeText, form or choice; kind status needs status {asOf, validFor}. body is {root, elements} ` +
    `with a BriefBody root. A rejection lists problems {code, path, reason, guide}: fix them and retry with a new ` +
    `requestId; on version_conflict merge with the latest it returns. Content never executes actions. Formats, limits ` +
    `and examples: brief_guide.`,
  brief_guide:
    `The Project Brief format guide, generated from the contract: sections and their kinds, ask replies, body components ` +
    `with props and limits, charts, attachments, error codes and worked examples; what to write is in yuzuno_guide brief. part is one of ` +
    `${BRIEF_GUIDE_PARTS.join(", ")}; omit it for everything. Read the part a rejection's guide names: ` +
    `"brief_guide charts" means part charts.`,
} as const;

/** Every tool description and the server instructions stay within what Harnesses show in full. */
export const DESCRIPTION_CAP = MAX_DESCRIPTION_LENGTH;

/** contract.json's `brief`: what Core serves without Node. */
export function describeBrief() {
  for (const [name, text] of [["hardRules", BRIEF_HARD_RULES], ...Object.entries(BRIEF_TOOL_DESCRIPTIONS)])
    if (text.length > DESCRIPTION_CAP) throw new Error(`${name} has ${text.length} characters; the cap is ${DESCRIPTION_CAP}.`);
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    hardRules: BRIEF_HARD_RULES,
    outcomeHint: BRIEF_OUTCOME_HINT,
    toolDescriptions: BRIEF_TOOL_DESCRIPTIONS,
    limits: BRIEF_LIMITS,
    guide: briefGuide(),
    guideParts: Object.fromEntries(BRIEF_GUIDE_PARTS.map((part) => [part, briefGuide(part)])) as Record<BriefGuidePart, string>,
  };
}
