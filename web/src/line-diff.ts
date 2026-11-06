/** One line of a line diff: kept, added or removed. */
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** At most this many cells in the comparison table: beyond it, the changed
 * middle is shown as removed then added, whole. Two 32 KiB documents of short
 * lines stay well inside it. */
const MAX_CELLS = 4_000_000;

const lines = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));

/**
 * The lines of `after` against `before` (T-34 S3b, a handover proposal on
 * Home): the common start and end kept, the middle compared by its longest
 * common subsequence. CRLF and LF lines are the same line.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  const tail: DiffLine[] = a.slice(a.length - end).map((text) => ({ kind: "same", text }));
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    return [...head, ...x.map((text): DiffLine => ({ kind: "del", text })), ...y.map((text): DiffLine => ({ kind: "add", text })), ...tail];
  }
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
  const width = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * width + j] = x[i] === y[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      middle.push({ kind: "same", text: x[i] });
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      // A removed line before the added one that replaces it.
      middle.push({ kind: "del", text: x[i++] });
    } else {
      middle.push({ kind: "add", text: y[j++] });
    }
  }
  return [...head, ...middle, ...tail];
}

/** The changed lines with `context` kept lines around each run of changes;
 * the kept lines between are one `skip` entry with their count. */
export function changedHunks(diff: DiffLine[], context = 2): (DiffLine | { kind: "skip"; count: number })[] {
  const near = diff.map(() => false);
  diff.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k++) near[k] = true;
  });
  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  diff.forEach((line, index) => {
    if (near[index]) {
      if (skipped) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
