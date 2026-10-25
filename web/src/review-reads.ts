import type { Language } from "./i18n.ts";

/**
 * One context read a reviewer made, as Core retained it (pr_review/source.rs):
 * the tool, what was asked (`requested`), and the answer's small fields. Many
 * successful reads name no single file or revision: the changed-file list
 * has a comparison instead, and path lists and searches cover many files. A
 * read failed only when its receipt has an `error`. Reviews retained before
 * receipts named their tool have only path, revision, blobSha and error.
 */
export type ContextRead = {
  tool?: string;
  requested?: Record<string, unknown>;
  path?: string;
  revision?: string;
  comparison?: string;
  query?: string;
  pathPrefix?: string;
  totalFiles?: number;
  offset?: number;
  endOffset?: number;
  totalBytes?: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  error?: string;
};

/** What a read was, the fixed version or range it read, and its error if it failed. */
export type ReadView = { label: string; version: string | null; error: string | null };

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const sha = (value: string) => (/^[a-f0-9]{40}$/i.test(value) ? value.slice(0, 8) : value);

// A read's own words in the interface language (T-189). Paths, queries,
// prefixes, tool names and the read's error are shown as they are. Plain
// tables, not i18n's strings(): review-reads.test.mjs imports this file in
// Node, without React.
type Words = {
  changed: (files?: number) => string;
  paths: (query?: string) => string;
  search: (query?: string, prefix?: string) => string;
  diff: (path: string | undefined, part: string) => string;
  bytes: (from: number, to: number, total?: number) => string;
  source: (path: string | undefined, part: string) => string;
  empty: string;
  lines: (first: number, last: number) => string;
  read: string;
};
const en: Words = {
  changed: (files) => `Changed files${files === undefined ? "" : ` (${files})`}`,
  paths: (query) => (query ? `Path list matching "${query}"` : "Path list"),
  search: (query, prefix) => `Search${query ? ` "${query}"` : ""}${prefix ? ` in ${prefix}` : ""}`,
  diff: (path, part) => `Diff ${path ?? "of a changed file"}${part}`,
  bytes: (from, to, total) => `, bytes ${from}–${to}${total !== undefined ? ` of ${total}` : ""}`,
  source: (path, part) => `Source ${path ?? "file"}${part}`,
  empty: ", empty file",
  lines: (first, last) => `, lines ${first}–${last}`,
  read: "Context read",
};
const zh: Words = {
  changed: (files) => `变更文件${files === undefined ? "" : `（${files}）`}`,
  paths: (query) => (query ? `匹配“${query}”的路径列表` : "路径列表"),
  search: (query, prefix) => `${prefix ? `在 ${prefix} 中` : ""}搜索${query ? `“${query}”` : ""}`,
  diff: (path, part) => `${path ?? "某个变更文件"} 的 diff${part}`,
  bytes: (from, to, total) => `，字节 ${from}–${to}${total !== undefined ? `（共 ${total}）` : ""}`,
  source: (path, part) => `源文件${path ? ` ${path}` : ""}${part}`,
  empty: "，空文件",
  lines: (first, last) => `，第 ${first}–${last} 行`,
  read: "上下文读取",
};

export function describeRead(read: ContextRead, language: Language = "en"): ReadView {
  const w = language === "zh-Hans" ? zh : en;
  const asked = read.requested ?? {};
  const path = text(read.path) ?? text(asked.path);
  const query = text(read.query) ?? text(asked.query);
  const prefix = text(read.pathPrefix) ?? text(asked.pathPrefix);
  const [from, to] = [count(read.offset), count(read.endOffset)];
  const [first, last] = [count(read.startLine), count(read.endLine)];
  let label: string;
  switch (read.tool) {
    case "review_changes": {
      label = w.changed(count(read.totalFiles));
      break;
    }
    case "source_paths":
      label = w.paths(query);
      break;
    case "source_search":
      label = w.search(query, prefix);
      break;
    case "source_diff":
      label = w.diff(path, from !== undefined && to !== undefined ? w.bytes(from, to, count(read.totalBytes)) : "");
      break;
    case "source_read":
      label = w.source(path, read.totalLines === 0 ? w.empty : first !== undefined && last !== undefined ? w.lines(first, last) : "");
      break;
    default:
      // An older receipt, or a tool this version does not know: what it
      // names, never a guess at whether it succeeded.
      label = path ?? (text(read.tool) ? `${read.tool}` : w.read);
  }
  // The fixed revision read, else the range a changed-file list covers;
  // nothing at all rather than a status the read never had.
  const range = text(read.comparison)?.split("..");
  const version = text(read.revision)
    ? sha(read.revision!)
    : range?.length === 2 && range[0] && range[1]
      ? `${sha(range[0])}..${sha(range[1])}`
      : null;
  return { label, version, error: text(read.error) ?? null };
}
