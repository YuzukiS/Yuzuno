import type { DiagramProps } from "./brief-catalog";

/**
 * A Diagram's layout (YN-16 S3): node sizes from their labels, then dagre's
 * placement of nodes and edges. Pure: dagre is passed in, so the renderer
 * loads it only when a section has a Diagram, and tests run it in Node.
 */
export type Dagre = typeof import("@dagrejs/dagre");

export type Point = { x: number; y: number };
export type LaidNode = { id: string; x: number; y: number; width: number; height: number; lines: string[] };
export type LaidEdge = { from: string; to: string; points: Point[]; label?: { text: string; x: number; y: number; width: number }; dashed: boolean };
export type Laid = { width: number; height: number; nodes: LaidNode[]; edges: LaidEdge[]; direction: "down" | "right" };

const FONT = 13;
export const LINE = 17;
const MAX_TEXT = 148;
const PAD_X = 12;
const PAD_Y = 9;

/**
 * A label's width in pixels at 13 px, estimated by character so that the
 * layout is the same in every browser and in tests: a CJK or full-width
 * character takes an em, a capital about two thirds, other characters less.
 */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000))
      width += FONT;
    else if (/[A-Z]/.test(char)) width += FONT * 0.66;
    else if (/[0-9]/.test(char)) width += FONT * 0.58;
    else if (/[ .,:;'!|il]/.test(char)) width += FONT * 0.3;
    else width += FONT * 0.54;
  }
  return Math.ceil(width);
}

/** Text cut to MAX_TEXT px with "…", or as it is when it fits; `more` says text follows it, so it ends in "…" anyway. */
function fit(text: string, more = false): string {
  if (!more && textWidth(text) <= MAX_TEXT) return text;
  let cut = text;
  while (cut && textWidth(`${cut}…`) > MAX_TEXT) cut = [...cut].slice(0, -1).join("");
  return `${cut.trimEnd()}…`;
}

/** A label in at most two lines of MAX_TEXT px: by words where it has spaces, else by characters; what is left ends in "…". */
export function wrapLabel(label: string): string[] {
  const text = label.replace(/\s+/g, " ").trim();
  const parts = text.includes(" ") ? text.split(/(?<= )/) : [...text];
  const lines = [""];
  for (let index = 0; index < parts.length; index++) {
    const last = lines.length - 1;
    const next = lines[last] + parts[index];
    if (!lines[last] || textWidth(next.trimEnd()) <= MAX_TEXT) lines[last] = next;
    else if (lines.length < 2) lines.push(parts[index]);
    else return [fit(lines[0].trimEnd()), fit(lines[1].trimEnd(), true)];
  }
  return lines.map((line) => fit(line.trimEnd()));
}

/** Nodes and edges laid out by dagre, top to bottom or left to right; deterministic for one input. */
export function layoutDiagram(dagre: Dagre, { nodes, edges }: Pick<DiagramProps, "nodes" | "edges">, direction: "down" | "right"): Laid {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: direction === "right" ? "LR" : "TB", nodesep: 28, ranksep: 42, edgesep: 14, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map<string, { lines: string[]; width: number; height: number }>();
  for (const node of nodes) {
    const lines = wrapLabel(node.label);
    const text = Math.max(...lines.map(textWidth));
    let width = Math.max(56, text + PAD_X * 2);
    let height = lines.length * LINE + PAD_Y * 2;
    // A diamond holds its text in its middle: wider and taller than the text's box.
    if (node.shape === "diamond") {
      width = Math.round(width * 1.45);
      height = Math.round(height * 1.6);
    }
    sizes.set(node.id, { lines, width, height });
    graph.setNode(node.id, { width, height });
  }
  for (const edge of edges)
    graph.setEdge(edge.from, edge.to, edge.label ? { label: edge.label, width: textWidth(edge.label) + 10, height: 18, labelpos: "c" } : {});
  dagre.layout(graph);
  const size = graph.graph();
  return {
    width: Math.ceil(size.width ?? 0),
    height: Math.ceil(size.height ?? 0),
    direction,
    nodes: nodes.map((node) => {
      const at = graph.node(node.id) as { x: number; y: number };
      const { lines, width, height } = sizes.get(node.id)!;
      return { id: node.id, x: at.x, y: at.y, width, height, lines };
    }),
    edges: edges.map((edge) => {
      const at = graph.edge(edge.from, edge.to) as { points?: Point[]; x?: number; y?: number };
      return {
        from: edge.from,
        to: edge.to,
        points: at.points ?? [],
        dashed: edge.style === "dashed",
        label: edge.label && at.x !== undefined && at.y !== undefined ? { text: edge.label, x: at.x, y: at.y, width: textWidth(edge.label) + 10 } : undefined,
      };
    }),
  };
}

