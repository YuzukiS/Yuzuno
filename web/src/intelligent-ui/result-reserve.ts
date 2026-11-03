import type { ResultSpec } from "./contract.ts";

/**
 * The room a result's placeholder keeps while the renderer loads (T-19
 * HM:I5, F3). Its spec is known then, and checked, so the kinds of block it
 * holds are known too: each kind keeps a fixed height, together at most
 * RESERVE_CAP. A result of text alone keeps none past the placeholder's one
 * line. This is room, not the result's height: what is drawn can still be
 * taller or shorter, so what follows can still move a little.
 *
 * Where no spec is known yet (a published result before its first read, a
 * block still being written, the rest of a long reply), nothing is reserved:
 * the placeholder stays the compact one and does not guess a kind or a
 * height, so the result's arrival can move what follows.
 */
export const RESERVE_HEIGHT = { table: 180, chart: 220, form: 200, task: 200, metrics: 88 } as const;
export const RESERVE_CAP = 360;
export type ReserveKind = keyof typeof RESERVE_HEIGHT;
export type Reserve = { kinds: ReserveKind[]; height: number };

const KINDS: Partial<Record<string, ReserveKind>> = {
  Table: "table",
  BarChart: "chart",
  Clarification: "form",
  TaskStatus: "task",
  Metrics: "metrics",
};

/** The kinds `spec` holds, read within the contract's bounds (a tree at
 * most six levels deep, of at most 32 components), and the room they keep;
 * null when none keeps any. */
export function reserveFor(spec: ResultSpec): Reserve | null {
  const found = new Set<ReserveKind>();
  const seen = new Set<string>();
  const visit = (key: string, depth: number) => {
    if (depth > 6 || seen.has(key) || seen.size >= 32) return;
    const node = spec.elements[key];
    if (!node) return;
    seen.add(key);
    const kind = KINDS[node.type];
    if (kind) found.add(kind);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(spec.root, 1);
  const kinds = (Object.keys(RESERVE_HEIGHT) as ReserveKind[]).filter((kind) => found.has(kind));
  if (!kinds.length) return null;
  return { kinds, height: Math.min(RESERVE_CAP, kinds.reduce((sum, kind) => sum + RESERVE_HEIGHT[kind], 0)) };
}
