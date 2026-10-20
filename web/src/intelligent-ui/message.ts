import { marked, type Token } from "marked";
import { parseResultSpec, ResultError, type ResultProblem, type ResultSpec } from "./contract.ts";

export type { ResultProblem };

/**
 * A reply in display order: its Markdown, and each explicit `yuzuno-ui`
 * fenced block (a top-level fence whose info string is exactly that).
 * Code examples, nested and quoted fences stay part of the Markdown.
 */
export type ReplySegment =
  | { kind: "text"; text: string }
  | { kind: "result"; raw: string; spec: ResultSpec; defaults: string[] }
  /** Not closed yet while the reply is still being written. */
  | { kind: "pending"; raw: string }
  | { kind: "invalid"; raw: string; problem: ResultProblem };

const MULTIPLE: ResultProblem = {
  code: "multiple_results",
  reason: "Only one interactive result per reply is shown.",
};
const UNFINISHED: ResultProblem = {
  code: "unfinished",
  reason: "The reply stopped before the result block was closed.",
};

function isResultFence(token: Token): token is Token & { type: "code"; text: string; raw: string } {
  return token.type === "code" && token.lang === "yuzuno-ui";
}

/**
 * Marked accepts an unclosed fence at the end; an interactive result must be
 * closed. Both lines are matched as marked reads them: spaces or tabs may
 * separate the opening fence from its info string (which must still be
 * exactly yuzuno-ui, see isResultFence), and only spaces may follow the
 * closing fence (marked does not close a fence followed by a tab).
 */
function closed(raw: string) {
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*yuzuno-ui[^\n]*\n/.exec(raw);
  const lines = raw.replace(/\n+$/, "").split("\n");
  return (
    !!opening &&
    lines.length > 1 &&
    new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},} *$`).test(lines.at(-1) || "")
  );
}

function problemOf(error: unknown): ResultProblem {
  if (error instanceof ResultError)
    return { code: error.code, reason: error.reason, ...(error.path ? { path: error.path } : {}) };
  return { code: "invalid_result", reason: error instanceof Error ? error.message : String(error) };
}

/**
 * The reply split into segments, or null when it has no explicit result block
 * (it is shown as plain Markdown). `complete` says the message has finished:
 * an unclosed block is then unfinished rather than still being generated.
 * The first valid block is shown; further blocks are listed as not shown.
 */
export function parseReply(text: string, complete: boolean): ReplySegment[] | null {
  if (!text.includes("yuzuno-ui")) return null;
  const normalized = text.replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(normalized);
  if (!tokens.some(isResultFence)) return null;
  // Keep reference-style links usable in every Markdown part.
  const definitions = Object.entries(tokens.links)
    .map(([label, link]) => `[${label}]: <${link.href}>${link.title ? ` ${JSON.stringify(link.title)}` : ""}`)
    .join("\n");
  const segments: ReplySegment[] = [];
  const pushText = (part: string) => {
    if (part.trim()) segments.push({ kind: "text", text: definitions ? `${part}\n\n${definitions}` : part });
  };
  let cursor = 0;
  let textStart = 0;
  let shown = false;
  // Walk top-level tokens in order so an identical fence inside an earlier
  // code example cannot be mistaken for the block's location.
  for (const token of tokens) {
    const offset = normalized.indexOf(token.raw, cursor);
    if (offset < 0) return null;
    cursor = offset + token.raw.length;
    if (!isResultFence(token)) continue;
    pushText(normalized.slice(textStart, offset));
    textStart = cursor;
    const raw = token.text;
    if (!closed(token.raw)) {
      segments.push(complete ? { kind: "invalid", raw, problem: UNFINISHED } : { kind: "pending", raw });
      continue;
    }
    if (shown) {
      segments.push({ kind: "invalid", raw, problem: MULTIPLE });
      continue;
    }
    try {
      const { spec, defaults } = parseResultSpec(raw);
      segments.push({ kind: "result", raw, spec, defaults });
      shown = true;
    } catch (error) {
      segments.push({ kind: "invalid", raw, problem: problemOf(error) });
    }
  }
  pushText(normalized.slice(textStart));
  return segments;
}

export type ParsedResult = {
  before: string;
  after: string;
  raw: string;
  spec: ResultSpec;
};

/**
 * The single shown result and the Markdown around it (as `parseReply` of a
 * finished reply with exactly one valid block), or a fallback notice. Kept
 * for callers that only need that one result.
 */
export function parseResultMessage(text: string): {
  result?: ParsedResult;
  fallback?: string;
} {
  const segments = parseReply(text, false);
  if (!segments) return {};
  const blocks = segments.filter((segment) => segment.kind !== "text");
  if (blocks.length === 1 && blocks[0].kind === "pending") return {};
  const index = segments.findIndex((segment) => segment.kind === "result");
  if (blocks.length !== 1 || index < 0)
    return {
      fallback:
        blocks.length > 1
          ? "Only one interactive result per reply is supported. Original reply shown below."
          : "This interactive result could not be displayed. The original reply is preserved below.",
    };
  const join = (parts: ReplySegment[]) =>
    parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n\n");
  const result = segments[index] as Extract<ReplySegment, { kind: "result" }>;
  return {
    result: {
      spec: result.spec,
      raw: result.raw,
      before: join(segments.slice(0, index)),
      after: join(segments.slice(index + 1)),
    },
  };
}
