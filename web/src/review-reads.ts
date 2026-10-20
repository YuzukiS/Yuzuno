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

export function describeRead(read: ContextRead): ReadView {
  const asked = read.requested ?? {};
  const path = text(read.path) ?? text(asked.path);
  const query = text(read.query) ?? text(asked.query);
  const prefix = text(read.pathPrefix) ?? text(asked.pathPrefix);
  const [from, to] = [count(read.offset), count(read.endOffset)];
  const [first, last] = [count(read.startLine), count(read.endLine)];
  let label: string;
  switch (read.tool) {
    case "review_changes": {
      const files = count(read.totalFiles);
      label = `Changed files${files === undefined ? "" : ` (${files})`}`;
      break;
    }
    case "source_paths":
      label = query ? `Path list matching "${query}"` : "Path list";
      break;
    case "source_search":
      label = `Search${query ? ` "${query}"` : ""}${prefix ? ` in ${prefix}` : ""}`;
      break;
    case "source_diff":
      label = `Diff ${path ?? "of a changed file"}${from !== undefined && to !== undefined ? `, bytes ${from}–${to}${count(read.totalBytes) !== undefined ? ` of ${read.totalBytes}` : ""}` : ""}`;
      break;
    case "source_read":
      label = `Source ${path ?? "file"}${read.totalLines === 0 ? ", empty file" : first !== undefined && last !== undefined ? `, lines ${first}–${last}` : ""}`;
      break;
    default:
      // An older receipt, or a tool this version does not know: what it
      // names, never a guess at whether it succeeded.
      label = path ?? (text(read.tool) ? `${read.tool}` : "Context read");
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
