import { ACT_COMPONENTS, checkElement, MAX_SPEC_LENGTH, type ResultSpec } from "./contract.ts";
import type { ReserveKind } from "./result-reserve.ts";

/**
 * A reply's yuzuno-ui block while it is still being written (YN-15): the
 * part of its result that can be drawn already. The Agent writes the same
 * {root, elements} JSON as for a whole block; nothing else is read.
 *
 * BlockStream scans the block's text as it grows, from where it stopped when
 * the new text extends the old. It notes the root's id, the `type` of each
 * element being written, and each element of `elements` once its value has
 * closed. A closed element is drawn only if it passes checkElement: its own
 * component with all of its props, never a value written halfway. The others
 * a drawn element names as children stand as placeholders (PENDING) in their
 * place, sized by their kind once their `type` is known. Nothing is drawn
 * until the root, a Result, has closed. What is drawn is a tree within
 * checkSpec's bounds (six levels, 32 components, each element once), so no
 * cycle can loop the renderer.
 *
 * Text that cannot be JSON, more of it than a block may hold, or an element
 * of a type that acts (Continue, Clarification, TaskStatus: a reply's block
 * only displays, YN-14 A5) stops the drawing: the block is then only being
 * generated, as before, and no room is kept for such a part. Once the block
 * is closed it is checked whole (parseResultSpec, in message.ts), and only
 * that decides what is shown.
 */

/** The type of a placeholder: the only element drawn that is not checked
 * against the catalog. An Agent's element of this type fails checkElement
 * (not a component), so an Agent can never write one. */
export const PENDING = "yuzuno.pending";
/** How much room a placeholder keeps: a kind of result-reserve.ts, or a line. */
export type PendingKind = ReserveKind | "line";
export type PendingElement = { type: typeof PENDING; props: { kind: PendingKind } };
export type LiveElement = ResultSpec["elements"][string] | PendingElement;
/** A result as far as it can be drawn: checked elements and placeholders. */
export type LiveSpec = { root: string; elements: Record<string, LiveElement> };

const KINDS: Partial<Record<string, ReserveKind>> = {
  Table: "table",
  BarChart: "chart",
  Metrics: "metrics",
};
/** Parts that act: a block with one is refused once closed, so it is not drawn. */
const ACTS: ReadonlySet<string> = new Set(ACT_COMPONENTS);
const MAX_DEPTH = 6;
const MAX_COMPONENTS = 32;

type Frame = {
  kind: "{" | "[";
  /** The key whose value comes next, or that is being read ("" when not kept). */
  key: string | null;
  /** In an object: a key comes next (after "{" or ","). */
  wantsKey: boolean;
  /** In an object: a key was read and its ":" comes next. */
  wantsColon: boolean;
  role?: "top" | "elements" | "element";
  /** An element's key and where its value starts. */
  name?: string;
  start?: number;
};

/** A closed element as checked: its text, the element if it passed, its type if one was read, and
 * which check this was (a new text, even of the same length, is a new check). */
type Checked = { text: string; element: ResultSpec["elements"][string] | null; type: string | null; serial: number };
let checks = 0;

const space = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";
const literal = /[\w.+-]/;

export class BlockStream {
  private text = "";
  private at = 0;
  private stack: Frame[] = [];
  private inString = false;
  private escaped = false;
  private stringStart = 0;
  private ended = false;
  private broken = false;
  private root: string | null = null;
  /** Each element whose value has closed, as written and as parsed; a later
   * one with the same key wins, as in JSON.parse. */
  private closed = new Map<string, { text: string; json: unknown }>();
  /** The type of each element still being written, once read. */
  private typed = new Map<string, string>();
  /** Closed elements checked, kept across restarts so a drawn one keeps its identity. */
  private checked = new Map<string, Checked>();
  private placeholders = new Map<string, PendingElement>();
  private last: { signature: string; view: LiveSpec | null } = { signature: "", view: null };

  /** Read `text`, the block's whole text so far. */
  update(text: string): this {
    if (text === this.text) return this;
    if (!text.startsWith(this.text)) this.restart();
    this.text = text;
    if (text.length > MAX_SPEC_LENGTH) this.broken = true;
    this.scan();
    return this;
  }

  private restart() {
    this.at = 0;
    this.stack = [];
    this.inString = this.escaped = this.ended = this.broken = false;
    this.root = null;
    this.closed.clear();
    this.typed.clear();
  }

  private scan() {
    const text = this.text;
    for (; this.at < text.length && !this.broken; this.at++) {
      const c = text[this.at];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.inString = false;
          this.string(this.stringStart, this.at + 1);
        }
        continue;
      }
      if (space(c)) continue;
      const frame = this.stack.at(-1);
      // One object, and nothing after it.
      if (this.ended || (!frame && c !== "{")) {
        this.broken = true;
        break;
      }
      switch (c) {
        case '"':
          if (frame?.wantsColon) this.broken = true;
          this.inString = true;
          this.stringStart = this.at;
          break;
        case "{":
        case "[":
          this.open(c, frame);
          break;
        case "}":
        case "]":
          this.close(c);
          break;
        case ":":
          if (frame?.kind !== "{" || !frame.wantsColon) this.broken = true;
          else frame.wantsColon = false;
          break;
        case ",":
          if (frame?.kind === "{") {
            if (frame.wantsKey || frame.wantsColon) this.broken = true;
            frame.key = null;
            frame.wantsKey = true;
          }
          break;
        default:
          // Numbers, true, false and null; JSON.parse checks them when their element closes.
          if (!literal.test(c) || (frame?.kind === "{" && (frame.wantsKey || frame.wantsColon))) this.broken = true;
      }
    }
  }

  /** A string from `start` to `end`: a key, or a value this reads (the root, a type). */
  private string(start: number, end: number) {
    const frame = this.stack.at(-1);
    if (!frame) return;
    const decode = () => {
      try {
        return JSON.parse(this.text.slice(start, end)) as string;
      } catch {
        this.broken = true;
        return null;
      }
    };
    if (frame.kind === "{" && frame.wantsKey) {
      frame.key = frame.role ? decode() : "";
      frame.wantsKey = false;
      frame.wantsColon = true;
      return;
    }
    if (frame.role === "top" && frame.key === "root") this.root = decode();
    else if (frame.role === "element" && frame.key === "type" && frame.name !== undefined) {
      const type = decode();
      if (type !== null) this.typed.set(frame.name, type);
      if (type !== null && ACTS.has(type)) this.broken = true;
    }
  }

  private open(c: "{" | "[", parent: Frame | undefined) {
    if (parent?.kind === "{" && (parent.wantsKey || parent.wantsColon)) {
      this.broken = true;
      return;
    }
    const frame: Frame = { kind: c, key: null, wantsKey: c === "{", wantsColon: false };
    if (!parent) frame.role = "top";
    else if (c === "{" && parent.role === "top" && parent.key === "elements") {
      frame.role = "elements";
      // A second `elements` replaces the first, as in JSON.parse.
      this.closed.clear();
      this.typed.clear();
    } else if (c === "{" && parent.role === "elements" && parent.key !== null) {
      frame.role = "element";
      frame.name = parent.key;
      frame.start = this.at;
    }
    this.stack.push(frame);
  }

  private close(c: "}" | "]") {
    const frame = this.stack.pop();
    if (!frame || frame.kind !== (c === "}" ? "{" : "[") || frame.wantsColon || (frame.wantsKey && frame.key === null && this.text[this.lastNonSpace()] === ",")) {
      this.broken = true;
      return;
    }
    if (frame.role === "element" && frame.name !== undefined && frame.start !== undefined) {
      const text = this.text.slice(frame.start, this.at + 1);
      try {
        // What the scan does not check (escapes, numbers, commas in arrays), JSON.parse does.
        this.closed.set(frame.name, { text, json: JSON.parse(text) });
      } catch {
        this.broken = true;
        return;
      }
      this.typed.delete(frame.name);
    }
    if (!this.stack.length) this.ended = true;
  }

  /** The last character before `at` that is not white space. */
  private lastNonSpace() {
    let i = this.at - 1;
    while (i >= 0 && space(this.text[i])) i--;
    return i;
  }

  /** A closed element, checked once for each text it was written with. */
  private element(key: string): Checked | null {
    const closed = this.closed.get(key);
    if (closed === undefined) return null;
    const { text, json } = closed;
    const known = this.checked.get(key);
    if (known?.text === text) return known;
    let checked: Checked;
    try {
      checked = { text, element: checkElement(key, json), type: null, serial: ++checks };
    } catch {
      const type = (json as { type?: unknown } | null)?.type;
      checked = { text, element: null, type: typeof type === "string" ? type : null, serial: ++checks };
    }
    checked.type ??= checked.element?.type ?? null;
    this.checked.set(key, checked);
    return checked;
  }

  private placeholder(key: string, type: string | null | undefined): PendingElement {
    const kind: PendingKind = (type && KINDS[type]) || "line";
    const known = this.placeholders.get(key);
    if (known?.props.kind === kind) return known;
    const made: PendingElement = { type: PENDING, props: { kind } };
    this.placeholders.set(key, made);
    return made;
  }

  /**
   * What can be drawn now: the root and every checked element under it, with
   * placeholders for the rest; or null until the root has closed and passed,
   * and once the text cannot be a result. The same object while nothing
   * drawn has changed.
   */
  view(): LiveSpec | null {
    const root = !this.broken && this.root !== null ? this.element(this.root) : null;
    if (!root?.element || root.element.type !== "Result") return this.remember("", null);
    const rootKey = this.root as string;
    // Keys are ids checkElement and the children's schema passed; no prototype all the same.
    const elements: Record<string, LiveElement> = Object.create(null);
    elements[rootKey] = root.element;
    const parts: string[] = [];
    let count = 1;
    // Each element placed, in checkSpec's order; one already placed, or past
    // its bounds, is left out (checkSpec refuses it once the block is closed).
    const visit = (key: string, node: ResultSpec["elements"][string], depth: number) => {
      parts.push(`${key}=${this.checked.get(key)?.serial}`);
      const named = node.children ?? [];
      const children: string[] = [];
      const drawn: [string, ResultSpec["elements"][string]][] = [];
      for (const child of named) {
        if (count >= MAX_COMPONENTS || depth >= MAX_DEPTH || Object.hasOwn(elements, child)) continue;
        count += 1;
        children.push(child);
        const found = this.element(child);
        if (found?.element && found.element.type !== "Result") {
          elements[child] = found.element;
          drawn.push([child, found.element]);
        } else {
          const placeholder = this.placeholder(child, found ? found.type : this.typed.get(child));
          elements[child] = placeholder;
          parts.push(`${child}~${placeholder.props.kind}`);
        }
      }
      if (children.length !== named.length) elements[key] = { ...node, children };
      for (const [child, element] of drawn) visit(child, element, depth + 1);
    };
    visit(rootKey, root.element, 1);
    const signature = `${rootKey}|${parts.join(",")}`;
    if (signature === this.last.signature) return this.last.view;
    return this.remember(signature, { root: rootKey, elements });
  }

  private remember(signature: string, view: LiveSpec | null) {
    if (signature !== this.last.signature) this.last = { signature, view };
    return this.last.view;
  }
}
