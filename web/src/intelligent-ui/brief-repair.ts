/**
 * Repair-accept for Project Brief sections (YN-14 A1).
 *
 * A section that passes checkBriefSection is never touched. One that fails
 * gets one more chance: Core fixes a few kinds of slip it can fix without
 * guessing what the Agent meant, then checks the result with the same strict
 * contract. If that passes, the section is accepted and every change is
 * listed as a repair the Agent and Home see; if not, the answer is the
 * rejection the section as sent got, unchanged.
 *
 * What a repair may do (BRIEF_REPAIR_CODES): turn an unknown component into
 * Markdown or a Group; move or drop fields a component does not have; fill
 * or de-duplicate ids; fix an enum's letter case or a listed synonym; fill
 * two neutral defaults; turn reply options given as text into {id, label};
 * mend the tree and the layout; show an attachment nothing shows. Nothing
 * else: the envelope (key, kind, title, ask, status, time, attachments) is
 * the Agent's own, limits are never met by cutting, references to files and
 * evidence are never guessed, and a component's own required content (a
 * Finding's source) is never invented.
 *
 * Safety: a repaired section is one the Agent could have sent itself, and it
 * passes the same catalog check, so a repair adds no component, prop,
 * attachment or permission. Text a repair builds is HTML-escaped, so it never
 * becomes markup. Components outside REPAIRED_FIELDS (ResearchDesk, Sources,
 * and any later one until it opts in) get no field repairs, and element-level
 * `visible`, `on`, `watch`, `state` or `repeat` are never moved or dropped:
 * dropping a condition could show what was meant to stay hidden.
 */
import { z } from "zod";
import {
  BRIEF_LIMITS, BRIEF_REPAIR_CODES, BriefError, briefComponentProps, checkBriefSection, markdownProblems, withMarkdownBody,
  type BriefComponent, type BriefProblem, type BriefSection,
} from "./brief-contract.ts";

/** One repair: a stable code, the block (or field) it changed, what changed, the guide part to read. */
export type BriefRepair = BriefProblem;
type RepairCode = keyof typeof BRIEF_REPAIR_CODES;

/** At most this many repairs on one section; one that needs more is refused as sent. */
export const MAX_REPAIRS = BRIEF_LIMITS.repairsPerSection;
/** At most this many rounds of fixing what the strict check reports. */
const ROUNDS = 6;
const REASON_CHARS = 300;

type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[a-zA-Z][\w-]{0,63}$/;
const CONTAINERS = new Set(["BriefBody", "Group", "Columns", "Tabs"]);

/** Components whose props a repair may move, drop, fill or normalize. */
const REPAIRED_FIELDS = new Set<string>([
  "BriefBody", "Group", "Columns", "Tabs", "Markdown", "Math", "Checklist", "Plan", "Findings", "Metrics", "Table",
  "LineChart", "BarChart", "ScatterChart", "LiveRefs", "Attachments",
]);
/** Element-level fields a later contract may give meaning to; never moved or dropped. */
const KEPT_ELEMENT_FIELDS = new Set(["visible", "on", "watch", "state", "repeat"]);

/** Another name an Agent may give a field, tried in order when the component's own name is missing. */
const ALIASES: Record<string, readonly string[]> = {
  source: ["file", "location", "path", "ref", "where"],
  severity: ["level", "priority"],
  text: ["content", "body", "message", "description", "markdown"],
  note: ["detail", "description"],
  state: ["status"],
  done: ["checked", "completed"],
  label: ["title", "text", "name"],
};
/** Values a field may be given under another name: Plan step states only. */
const SYNONYMS: Record<string, Record<string, string>> = {
  state: { in_progress: "doing", "in-progress": "doing", active: "doing", started: "doing", complete: "done", completed: "done", finished: "done", pending: "todo", open: "todo" },
};

const schemas = new Map<string, Json>();
function propsSchema(type: BriefComponent): Json {
  let schema = schemas.get(type);
  if (!schema) schemas.set(type, (schema = z.toJSONSchema(briefComponentProps[type]) as Json));
  return schema;
}
const known = (type: unknown): type is BriefComponent => typeof type === "string" && Object.hasOwn(briefComponentProps, type);

/** Text from an Agent as Markdown that can never be markup: `<` and `&` are entities. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const TITLE_FIELDS = ["title", "heading", "label", "name"];
const TEXT_FIELDS = ["text", "content", "markdown", "body", "value", "description", "message", "caption", "summary"];

/** An unknown leaf component's props as Markdown, or "" when they hold no text. */
function markdownOf(props: unknown): string {
  if (!object(props)) return "";
  const strings = (names: string[]) => names
    .map((name) => (typeof props[name] === "number" && Number.isFinite(props[name]) ? String(props[name]) : props[name]))
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const parts: string[] = [];
  const [title] = strings(TITLE_FIELDS);
  if (title) parts.push(`**${escaped(title.trim())}**`);
  const code = typeof props.code === "string" ? props.code : undefined;
  if (code !== undefined && code !== "") {
    const language = [props.language, props.lang].find((v): v is string => typeof v === "string" && /^[\w+-]{1,20}$/.test(v)) ?? "";
    const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((run) => run[0].length + 1)));
    parts.push(`${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}`);
  }
  for (const value of strings(TEXT_FIELDS)) parts.push(escaped(value.trim()));
  if (Array.isArray(props.items)) {
    const lines = props.items
      .map((item) => (typeof item === "string" ? item : object(item) ? [...TEXT_FIELDS, ...TITLE_FIELDS].map((name) => item[name]).find((v) => typeof v === "string") : undefined))
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => `- ${escaped(v.trim().replace(/\n+/g, " "))}`);
    if (lines.length) parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/** A path as the contract reports it: dotted, numbers as digits. */
type Path = (string | number)[];
const dotted = (path: Path) => path.map(String).join(".");

class Repairs {
  private found = new Map<string, { code: RepairCode; path: string; where: string; details: string[] }>();
  add(code: RepairCode, path: string, where: string, detail: string) {
    const key = `${code}|${path}`;
    const known = this.found.get(key);
    if (known) {
      if (!known.details.includes(detail)) known.details.push(detail);
    } else this.found.set(key, { code, path, where, details: [detail] });
  }
  get size() {
    return this.found.size;
  }
  list(): BriefRepair[] {
    return [...this.found.values()].map(({ code, path, where, details }) => {
      const part = code === "reply_options" ? "ask" : code === "showed_attachment" ? "attachments" : "content";
      let reason = `${where}: ${details.join("; ")}.`;
      if ([...reason].length > REASON_CHARS) reason = `${[...reason].slice(0, REASON_CHARS - 1).join("")}…`;
      return { code, path, reason: `${reason} (brief_guide ${part})`, guide: `brief_guide ${part}` };
    });
  }
}

/** An id not yet in `taken`, from `base`: base, base-2, base-3… */
function fresh(base: string, taken: Set<string>): string {
  let candidate = ID.test(base) ? base : "i";
  for (let n = 2; taken.has(candidate); n++) candidate = `${ID.test(base) ? base : "i"}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * The props of a known component checked against its schema, fixed in
 * place: fields renamed from an alias, unknown ones dropped, missing ids
 * filled, enum values normalized, a Finding's missing severity set to info.
 */
function repairProps(type: BriefComponent, key: string, props: Json, repairs: Repairs) {
  const at = `body.elements.${key}.props`;
  const where = `${type} "${key}"`;
  const walk = (value: unknown, schema: Json, path: Path, field: string | undefined) => {
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return;
    if (schema.type === "array" && object(schema.items) && Array.isArray(value)) {
      value.forEach((item, index) => walk(item, schema.items as Json, [...path, index], field));
      return;
    }
    if (Array.isArray(schema.enum) && typeof value === "string" && !schema.enum.includes(value) && path.length) {
      const options = schema.enum as unknown[];
      const lower = value.trim().toLowerCase();
      const found = options.find((option) => typeof option === "string" && option.toLowerCase() === lower)
        ?? (field && SYNONYMS[field]?.[lower] && options.includes(SYNONYMS[field][lower]) ? SYNONYMS[field][lower] : undefined);
      if (found !== undefined) {
        setAt(props, path, found);
        repairs.add("normalized_value", at, where, `${dotted(path)} "${value}" became "${found}"`);
      }
      return;
    }
    if (schema.type !== "object" || !object(value) || !object(schema.properties)) return;
    const properties = schema.properties as Record<string, Json>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const [name, aliases] of Object.entries(ALIASES)) {
      if (!Object.hasOwn(properties, name) || Object.hasOwn(value, name)) continue;
      const alias = aliases.find((other) => Object.hasOwn(value, other) && !Object.hasOwn(properties, other));
      if (alias === undefined) continue;
      value[name] = value[alias];
      delete value[alias];
      repairs.add("renamed_field", at, where, `${dotted([...path, alias])} became ${name}`);
    }
    if (schema.additionalProperties === false) {
      const dropped = Object.keys(value).filter((name) => !Object.hasOwn(properties, name));
      for (const name of dropped) delete value[name];
      if (dropped.length) repairs.add("dropped_field", at, where, `removed ${dropped.map((name) => dotted([...path, name])).join(", ")}`);
    }
    if (type === "Findings" && path.length === 2 && path[0] === "items" && value.severity === undefined) {
      value.severity = "info";
      repairs.add("filled_default", at, where, `${dotted([...path, "severity"])} set to info`);
    }
    for (const [name, inner] of Object.entries(properties)) if (Object.hasOwn(value, name)) walk(value[name], inner, [...path, name], name);
  };
  walk(props, propsSchema(type), [], undefined);
  // Ids: a list's items, steps or rows without one get i1, i2…; a Table or chart without one, its element key.
  for (const list of ["items", "steps", "rows"]) {
    const items = props[list];
    const schema = (propsSchema(type).properties as Record<string, Json> | undefined)?.[list];
    const needsId = object(schema) && object(schema.items) && Array.isArray((schema.items as Json).required) && ((schema.items as Json).required as string[]).includes("id");
    if (!needsId || !Array.isArray(items)) continue;
    const taken = new Set(items.filter(object).map((item) => item.id).filter((v): v is string => typeof v === "string"));
    items.forEach((item, index) => {
      if (object(item) && item.id === undefined) {
        item.id = fresh(`i${index + 1}`, taken);
        repairs.add("filled_id", at, where, `${list}.${index}.id set to "${item.id}"`);
      }
    });
  }
  const top = propsSchema(type);
  if (Array.isArray(top.required) && (top.required as string[]).includes("id") && props.id === undefined && ID.test(key)) {
    props.id = key;
    repairs.add("filled_id", at, where, `id set to "${key}"`);
  }
}

function setAt(root: Json, path: Path, value: unknown) {
  let node: unknown = root;
  for (const step of path.slice(0, -1)) node = (node as Json)[step as string];
  (node as Json)[path.at(-1) as string] = value;
}

/** Ask reply options given as text, or with fields of another name, as {id, label}. */
function repairOptions(section: Json, repairs: Repairs) {
  const reply = object(section.ask) && object(section.ask.reply) ? section.ask.reply : undefined;
  if (!reply || !Array.isArray(reply.options)) return;
  const where = "Ask reply options";
  const at = "ask.reply.options";
  const taken = new Set(reply.options.filter(object).map((o) => o.id).filter((v): v is string => typeof v === "string"));
  reply.options = reply.options.map((option, index) => {
    if (typeof option === "string" && option.trim() !== "") {
      const made = { id: fresh(`o${index + 1}`, taken), label: option.trim() };
      repairs.add("reply_options", at, where, `option ${index + 1} "${option.trim().slice(0, 40)}" became {id: "${made.id}", label}`);
      return made;
    }
    if (!object(option)) return option;
    const next: Json = { ...option };
    if (next.label === undefined) {
      const alias = ["text", "title", "name", "value"].find((name) => typeof next[name] === "string");
      if (alias) {
        next.label = next[alias];
        delete next[alias];
        repairs.add("reply_options", at, where, `option ${index + 1} ${alias} became label`);
      }
    }
    if (next.id === undefined) {
      const value = typeof next.value === "string" && ID.test(next.value) && !taken.has(next.value) ? next.value : undefined;
      next.id = value ?? fresh(`o${index + 1}`, taken);
      if (value) taken.add(value);
      if (value) delete next.value;
      repairs.add("reply_options", at, where, `option ${index + 1} id set to "${next.id}"`);
    }
    const dropped = Object.keys(next).filter((name) => name !== "id" && name !== "label");
    for (const name of dropped) delete next[name];
    if (dropped.length) repairs.add("reply_options", at, where, `option ${index + 1} removed ${dropped.join(", ")}`);
    return next;
  });
  const seen = new Set<string>();
  for (const option of reply.options as unknown[])
    if (object(option) && typeof option.id === "string") {
      if (seen.has(option.id)) {
        const was = option.id;
        option.id = fresh(was, new Set([...seen, ...taken]));
        repairs.add("reply_options", at, where, `a second "${was}" became "${option.id}"`);
      }
      seen.add(option.id as string);
    }
}

/** One element before the strict check: fields moved into props, unknown types turned into Markdown or a Group. */
function repairElement(elements: Json, key: string, repairs: Repairs) {
  const node = elements[key];
  if (!object(node)) return;
  const at = `body.elements.${key}`;
  const type = node.type;
  if (Object.keys(node).some((name) => KEPT_ELEMENT_FIELDS.has(name))) return;
  if (known(type) && !REPAIRED_FIELDS.has(type)) return;
  // Fields outside props: moved in when the component has them, else dropped.
  const extra = Object.keys(node).filter((name) => !["type", "props", "children"].includes(name));
  if (extra.length || (node.props !== undefined && !object(node.props))) {
    const props: Json = object(node.props) ? node.props : {};
    const own = known(type) ? ((propsSchema(type).properties as Json | undefined) ?? {}) : undefined;
    const moved = extra.filter((name) => !own || (Object.hasOwn(own, name) && !Object.hasOwn(props, name)));
    for (const name of moved) props[name] = node[name];
    for (const name of extra) delete node[name];
    node.props = props;
    const where = `${known(type) ? type : "Element"} "${key}"`;
    if (moved.length) repairs.add("renamed_field", at, where, `moved ${moved.join(", ")} into props`);
    const dropped = extra.filter((name) => !moved.includes(name));
    if (dropped.length) repairs.add("dropped_field", at, where, `removed ${dropped.join(", ")}`);
  }
  if (node.props === undefined) node.props = {};
  if (known(type)) {
    if (!CONTAINERS.has(type) && Array.isArray(node.children) && node.children.length === 0) {
      delete node.children;
      repairs.add("dropped_field", at, `${type} "${key}"`, "removed an empty children list");
    }
    repairProps(type, key, node.props as Json, repairs);
    return;
  }
  const name = typeof type === "string" ? `"${type.slice(0, 40)}"` : "without a type";
  if (Array.isArray(node.children) && node.children.length) {
    const props = node.props as Json;
    const title = TITLE_FIELDS.map((field) => props[field]).find((v): v is string => typeof v === "string" && v.trim() !== "");
    elements[key] = { type: "Group", props: title ? { title: title.trim().slice(0, 160) } : {}, children: node.children };
    repairs.add("component_to_group", at, `Element "${key}"`, `the unknown component ${name} became a Group${title ? " with its title" : ""}`);
    return;
  }
  const text = markdownOf(node.props);
  if (text) {
    elements[key] = { type: "Markdown", props: { text } };
    repairs.add("component_to_markdown", at, `Element "${key}"`, `the unknown component ${name} became Markdown of its text`);
  } else {
    delete elements[key];
    for (const other of Object.values(elements))
      if (object(other) && Array.isArray(other.children)) other.children = other.children.filter((child) => child !== key);
    repairs.add("component_to_markdown", at, `Element "${key}"`, `the unknown component ${name} had no text and was removed`);
  }
}

/** The elements no container reaches from the root. */
function unreachable(body: Json): string[] {
  const elements = body.elements as Json;
  const seen = new Set<string>();
  const pending = typeof body.root === "string" ? [body.root] : [];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key) || !object(elements[key])) continue;
    seen.add(key);
    const node = elements[key] as Json;
    if (Array.isArray(node.children)) for (const child of node.children) if (typeof child === "string") pending.push(child);
  }
  return Object.keys(elements).filter((key) => !seen.has(key));
}

/** Whether an element carries a field a later contract may give meaning to (KEPT_ELEMENT_FIELDS): no fix touches it. */
const held = (node: unknown) => object(node) && Object.keys(node).some((name) => KEPT_ELEMENT_FIELDS.has(name));

/**
 * Fixes for what the strict check reported, by code; whether any applied.
 * `edit` is a block edit (Core gave the stored body): an element it left
 * unreachable is removed, as the edit unlinked it; a put's is shown at the
 * end of the root. An edit never registers or shows an attachment. An
 * element that `held` names is never changed, moved or removed by a fix,
 * nor a container of it changed for it (YN-14 S2): its section is refused.
 */
function fixProblems(section: Json, problems: BriefProblem[], edit: boolean, repairs: Repairs): boolean {
  const body = section.body as Json;
  const elements = body.elements as Json;
  const root = typeof body.root === "string" ? body.root : undefined;
  const rootNode = root !== undefined && object(elements[root]) ? (elements[root] as Json) : undefined;
  const rootProps = rootNode && object(rootNode.props) ? (rootNode.props as Json) : undefined;
  let fixed = false;
  const dropDetails = new Set<number>();
  for (const found of problems) {
    const path = found.path.split(".");
    const key = path[0] === "body" && path[1] === "elements" ? path[2] : undefined;
    if (key !== undefined && held(elements[key])) continue;
    switch (found.code) {
      case "root": {
        const roots = Object.keys(elements).filter((name) => object(elements[name]) && (elements[name] as Json).type === "BriefBody");
        if (roots.length === 1) {
          body.root = roots[0];
          repairs.add("fixed_tree", "body.root", "The body", `root set to its BriefBody "${roots[0]}"`);
          fixed = true;
        } else if (!roots.length && root !== undefined && object(elements[root])) {
          const made = fresh("body", new Set(Object.keys(elements)));
          elements[made] = { type: "BriefBody", props: {}, children: [root] };
          body.root = made;
          repairs.add("fixed_tree", "body.root", "The body", `"${root}" was put under a new BriefBody "${made}"`);
          fixed = true;
        }
        break;
      }
      case "extra_root":
        if (key && object(elements[key])) {
          const node = elements[key] as Json;
          elements[key] = { type: "Group", props: {}, ...(Array.isArray(node.children) ? { children: node.children } : {}) };
          repairs.add("component_to_group", `body.elements.${key}`, `Element "${key}"`, "a BriefBody below the root became a Group");
          fixed = true;
        }
        break;
      case "missing_component":
        if (key) {
          let removed = false;
          for (const node of Object.values(elements))
            if (object(node) && !held(node) && Array.isArray(node.children) && node.children.includes(key)) {
              node.children = node.children.filter((child) => child !== key);
              removed = true;
            }
          if (removed) repairs.add("fixed_tree", "body.elements", "The body", `removed the child "${key}", which names no element`);
          fixed ||= removed;
        }
        break;
      case "unused_component": {
        const orphans = unreachable(body);
        if (!orphans.length || !rootNode || orphans.some((name) => held(elements[name]))) break;
        if (edit) {
          for (const name of orphans) delete elements[name];
          repairs.add("fixed_tree", "body.elements", "The body", `removed ${orphans.map((name) => `"${name}"`).join(", ")}, which the edit no longer shows`);
          fixed = true;
          break;
        }
        // A put's: the tops of the unreached parts, appended to the root.
        const children = new Set(orphans.flatMap((name) => (Array.isArray((elements[name] as Json)?.children) ? ((elements[name] as Json).children as unknown[]) : [])));
        const tops = orphans.filter((name) => !children.has(name));
        const kids = Array.isArray(rootNode.children) ? (rootNode.children as unknown[]) : [];
        if (!tops.length || kids.length + tops.length > BRIEF_LIMITS.bodyChildren) break;
        rootNode.children = [...kids, ...tops];
        repairs.add("fixed_tree", `body.elements.${root}.children`, "The body", `added ${tops.map((name) => `"${name}"`).join(", ")}, which nothing showed, at the end`);
        fixed = true;
        break;
      }
      case "columns_widths":
        if (key && object(elements[key]) && object((elements[key] as Json).props)) {
          delete ((elements[key] as Json).props as Json).widths;
          repairs.add("dropped_layout", `body.elements.${key}.props`, `Columns "${key}"`, "removed widths that did not match its children");
          fixed = true;
        }
        break;
      case "summary": {
        const slot = path.at(-1);
        const summary = rootProps && object(rootProps.summary) ? (rootProps.summary as Json) : undefined;
        if (!summary || !slot) break;
        if (slot === "lead") delete rootProps!.summary;
        else delete summary[slot];
        repairs.add("dropped_layout", `body.elements.${root}.props.summary`, "The BriefBody summary", slot === "lead" ? "removed: its lead was not a Markdown under the root" : `removed ${slot}, which did not fit`);
        fixed = true;
        break;
      }
      case "details": {
        const index = Number(path.at(-1));
        if (Number.isInteger(index)) dropDetails.add(index);
        break;
      }
      case "duplicate_id": {
        const list = path.at(-1);
        const node = key && object(elements[key]) ? (elements[key] as Json) : undefined;
        const props = node && object(node.props) ? (node.props as Json) : undefined;
        if (path[0] === "ask" && path[2] === "options") break; // options are made unique by repairOptions
        if (props && node && known(node.type) && REPAIRED_FIELDS.has(node.type) && (list === "items" || list === "steps" || list === "rows") && Array.isArray(props[list])) {
          const taken = new Set<string>();
          for (const item of props[list] as unknown[])
            if (object(item) && typeof item.id === "string") {
              if (taken.has(item.id)) {
                const was = item.id;
                item.id = fresh(was, taken);
                repairs.add("filled_id", `body.elements.${key}.props`, `${node.type} "${key}"`, `a second "${was}" became "${item.id}"`);
                fixed = true;
              } else taken.add(item.id);
            }
        } else if (props && node && list === "id" && (node.type === "Table" || node.type === "LineChart" || node.type === "BarChart" || node.type === "ScatterChart")) {
          const taken = new Set(Object.values(elements).filter(object).map((other) => (object(other.props) ? other.props.id : undefined)).filter((v): v is string => typeof v === "string"));
          const was = String(props.id);
          props.id = fresh(key!, taken);
          repairs.add("filled_id", `body.elements.${key}.props`, `${node.type} "${key}"`, `id "${was}", used twice, became "${props.id}"`);
          fixed = true;
        }
        break;
      }
      case "row_mismatch": {
        const node = key && object(elements[key]) ? (elements[key] as Json) : undefined;
        const props = node && object(node.props) ? (node.props as Json) : undefined;
        if (!props || !Array.isArray(props.columns) || !Array.isArray(props.rows)) break;
        const keys = props.columns.filter(object).map((column) => column.key).filter((v): v is string => typeof v === "string");
        props.rows.forEach((row, index) => {
          if (!object(row) || !object(row.cells)) return;
          const cells = row.cells as Json;
          for (const column of keys)
            if (!Object.hasOwn(cells, column)) {
              cells[column] = "";
              repairs.add("filled_default", `body.elements.${key}.props`, `Table "${key}"`, `empty cells filled in, e.g. row ${index + 1} ${column}`);
              fixed = true;
            }
          for (const name of Object.keys(cells))
            if (!keys.includes(name)) {
              delete cells[name];
              repairs.add("dropped_field", `body.elements.${key}.props`, `Table "${key}"`, `removed cells of no column, e.g. row ${index + 1} ${name}`);
              fixed = true;
            }
        });
        break;
      }
      case "unused_attachment": {
        if (edit || !rootNode) break;
        const index = Number(path[1]);
        const attachments = Array.isArray(section.attachments) ? section.attachments : [];
        const name = object(attachments[index]) ? attachments[index].name : undefined;
        if (typeof name !== "string") break;
        // Shown in an Attachments block directly under the root, or a new one at its end.
        const kids = Array.isArray(rootNode.children) ? (rootNode.children as unknown[]) : [];
        let filesKey = kids.find((child): child is string => typeof child === "string" && object(elements[child]) && !held(elements[child]) && (elements[child] as Json).type === "Attachments"
          && object((elements[child] as Json).props) && Array.isArray(((elements[child] as Json).props as Json).items));
        if (filesKey === undefined) {
          if (kids.length >= BRIEF_LIMITS.bodyChildren) break;
          filesKey = fresh("files", new Set(Object.keys(elements)));
          elements[filesKey] = { type: "Attachments", props: { items: [] } };
          rootNode.children = [...kids, filesKey];
        }
        const items = ((elements[filesKey] as Json).props as Json).items as unknown[];
        if (items.length >= BRIEF_LIMITS.attachments) break;
        if (!items.some((item) => object(item) && item.name === name)) items.push({ name });
        repairs.add("showed_attachment", `body.elements.${filesKey}`, `Attachments "${filesKey}"`, `added "${name}", which nothing showed`);
        fixed = true;
        break;
      }
    }
  }
  if (dropDetails.size && rootProps && Array.isArray(rootProps.details)) {
    const kept = (rootProps.details as unknown[]).filter((_, index) => !dropDetails.has(index));
    if (kept.length) rootProps.details = kept;
    else delete rootProps.details;
    repairs.add("dropped_layout", `body.elements.${root}.props.details`, "The BriefBody details", `removed ${dropDetails.size} entr${dropDetails.size === 1 ? "y" : "ies"} that did not name a titled Group under the root`);
    fixed = true;
  }
  return fixed;
}

/**
 * Checks one section as checkBriefSection does; when it fails, tries the
 * repairs and checks again. Returns the normalized section and the repairs
 * made (none for a section valid as sent), or throws the BriefError of the
 * section as sent. previousBody marks a block edit, as for checkBriefSection.
 */
export function acceptBriefSection(envelope: unknown, previousBody?: unknown): { section: BriefSection; repairs: BriefRepair[] } {
  let original: BriefError;
  try {
    return { section: checkBriefSection(envelope, previousBody), repairs: [] };
  } catch (error) {
    if (!(error instanceof BriefError)) throw error;
    original = error;
  }
  // A markdown put is repaired as the body Core builds for it (YN-14 A3),
  // once its markdown and size pass as sent: the built body no longer has them (#723 R1 P3).
  if (markdownProblems(envelope).length) throw original;
  const expanded = withMarkdownBody(envelope);
  if (!object(expanded) || !object(expanded.body) || !object(expanded.body.elements)) throw original;
  const section = structuredClone(expanded) as Json;
  const body = section.body as Json;
  const elements = body.elements as Json;
  const repairs = new Repairs();
  repairOptions(section, repairs);
  for (const key of Object.keys(elements)) repairElement(elements, key, repairs);
  const edit = previousBody !== undefined;
  for (let round = 0; round < ROUNDS && repairs.size <= MAX_REPAIRS; round++) {
    let problems: BriefProblem[];
    try {
      const checked = checkBriefSection(section, previousBody);
      if (!repairs.size || repairs.size > MAX_REPAIRS) throw original;
      return { section: checked, repairs: repairs.list() };
    } catch (error) {
      if (error === original || !(error instanceof BriefError)) throw error;
      problems = error.problems;
    }
    if (!fixProblems(section, problems, edit, repairs)) break;
  }
  throw original;
}

/** The second pass alone, for its tests (brief-repair.test.mjs): the fixes `problems` lead to, on a copy. */
export function fixReported(section: unknown, problems: BriefProblem[], previousBody?: unknown): { section: unknown; repairs: BriefRepair[]; fixed: boolean } {
  const copy = structuredClone(section) as Json;
  const repairs = new Repairs();
  const fixed = fixProblems(copy, problems, previousBody !== undefined, repairs);
  return { section: copy, repairs: repairs.list(), fixed };
}
