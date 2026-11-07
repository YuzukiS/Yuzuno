import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStateBinding } from "@json-render/react";
import { useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import type { DiagramProps } from "./brief-catalog";
import { layoutDiagram, LINE, type Dagre, type LaidNode, type Point } from "./diagram-layout.ts";

/**
 * A flowchart or a diagram of parts (YN-16 S3), laid out by Yuzuno with
 * dagre, loaded only when a section has a Diagram. The Agent gives nodes and
 * edges; where each goes, the arrows, the colours and the fonts are Yuzuno's.
 * The reader selects a node, by pointer or keyboard, to read its detail; with
 * select, the node's id is also the value of that variable of the section.
 */
let dagreModule: Promise<Dagre> | null = null;
const loadDagre = () => (dagreModule ??= import("@dagrejs/dagre"));

/** A smooth path through an edge's points: straight from the first, curved at each bend, straight into the last. */
function edgePath(points: Point[]): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  let path = `M${first.x},${first.y}`;
  for (let index = 0; index < rest.length - 1; index++) {
    const corner = rest[index];
    const next = rest[index + 1];
    path += ` Q${corner.x},${corner.y} ${(corner.x + next.x) / 2},${(corner.y + next.y) / 2}`;
  }
  const last = rest[rest.length - 1] ?? first;
  return `${path} L${last.x},${last.y}`;
}

function NodeShape({ node, shape }: { node: LaidNode; shape: DiagramProps["nodes"][number]["shape"] }) {
  const { width, height } = node;
  if (shape === "diamond")
    return <polygon className="brief-diagram-shape" points={`0,${-height / 2} ${width / 2},0 0,${height / 2} ${-width / 2},0`} />;
  const radius = shape === "round" ? height / 2 : 7;
  return <rect className="brief-diagram-shape" x={-width / 2} y={-height / 2} width={width} height={height} rx={radius} ry={radius} />;
}

export function BriefDiagram({ title, caption, direction = "down", select, nodes, edges }: DiagramProps) {
  const t = useStrings(briefText);
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [dagre, setDagre] = useState<Dagre | null>(null);
  const [failed, setFailed] = useState(false);
  const [room, setRoom] = useState(0);
  // The selected node: the section's variable when select names one, else this block's own.
  const [chosen, choose] = useStateBinding<string>(select ? `/${select}` : "/");
  const [own, setOwn] = useState("");
  const selected = select ? (typeof chosen === "string" ? chosen : "") : own;
  const pick = (value: string) => (select ? choose(value) : setOwn(value));

  useEffect(() => {
    let live = true;
    loadDagre().then(
      (loaded) => live && setDagre(loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setRoom(node.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [dagre]);
  const laid = useMemo(() => {
    if (!dagre) return null;
    try {
      const first = layoutDiagram(dagre, { nodes, edges }, direction);
      // Left to right where it fits; where the window is too narrow, top to bottom.
      return direction === "right" && room > 0 && first.width > room ? layoutDiagram(dagre, { nodes, edges }, "down") : first;
    } catch {
      // Said in its place; the connections stay readable in words below.
      return "failed" as const;
    }
  }, [dagre, nodes, edges, direction, room]);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectable = !!select || nodes.some((node) => node.detail);
  const current = selected ? byId.get(selected) : undefined;
  const label = (nodeId: string) => byId.get(nodeId)?.label ?? nodeId;
  const keys = (event: KeyboardEvent<SVGGElement>, nodeId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pick(nodeId);
  };
  return (
    <figure className="brief-diagram" aria-labelledby={title ? `${id}-title` : undefined}>
      {title && (
        <h4 id={`${id}-title`} className="brief-diagram-title">
          {title}
        </h4>
      )}
      <div className="brief-diagram-frame" ref={frame}>
        {!laid || laid === "failed" ? (
          <p className="brief-diagram-loading" role="status">
            {failed || laid === "failed" ? t.diagramFailed : t.diagramLoading}
          </p>
        ) : (
          <svg
            className="brief-diagram-svg"
            viewBox={`0 0 ${laid.width} ${laid.height}`}
            width={laid.width}
            height={laid.height}
            style={{ maxWidth: "100%", height: "auto" }}
            role="group"
            aria-label={title ?? caption ?? t.diagram}
            data-direction={laid.direction}
          >
            <defs>
              <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className="brief-diagram-arrow" d="M0,0 L10,5 L0,10 z" />
              </marker>
            </defs>
            {laid.edges.map((edge) => (
              <g key={`${edge.from}\n${edge.to}`} className="brief-diagram-edge" data-dashed={edge.dashed || undefined} data-edge={`${edge.from}>${edge.to}`}>
                <path d={edgePath(edge.points)} markerEnd={`url(#${id}-arrow)`} />
                {edge.label && (
                  <g className="brief-diagram-edge-label" transform={`translate(${edge.label.x},${edge.label.y})`}>
                    <rect x={-edge.label.width / 2} y={-9} width={edge.label.width} height={18} rx={4} />
                    <text textAnchor="middle" dominantBaseline="central">
                      {edge.label.text}
                    </text>
                  </g>
                )}
              </g>
            ))}
            {laid.nodes.map((node) => {
              const given = byId.get(node.id)!;
              const on = selected === node.id;
              const top = -((node.lines.length - 1) * LINE) / 2;
              return (
                <g
                  key={node.id}
                  className="brief-diagram-node"
                  data-node={node.id}
                  data-tone={given.tone && given.tone !== "plain" ? given.tone : undefined}
                  data-shape={given.shape ?? "box"}
                  data-selected={on || undefined}
                  transform={`translate(${node.x},${node.y})`}
                  {...(selectable
                    ? {
                        role: "button",
                        tabIndex: 0,
                        "aria-pressed": on,
                        "aria-label": given.label,
                        // Selecting only: a Segmented's variable always holds one of its options.
                        onClick: () => pick(node.id),
                        onKeyDown: (event: KeyboardEvent<SVGGElement>) => keys(event, node.id),
                      }
                    : { role: "img", "aria-label": given.label })}
                >
                  <NodeShape node={node} shape={given.shape} />
                  <text textAnchor="middle" dominantBaseline="central" aria-hidden="true">
                    {node.lines.map((line, index) => (
                      <tspan key={index} x={0} y={top + index * LINE}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {/* The connections in words, for a screen reader; the drawing has them as arrows. */}
      <ul className="sr-only" aria-label={t.diagramEdges}>
        {edges.map((edge) => (
          <li key={`${edge.from}\n${edge.to}`}>{t.diagramEdge(label(edge.from), label(edge.to), edge.label)}</li>
        ))}
      </ul>
      {selectable && (
        <div className="brief-diagram-detail" aria-live="polite">
          {current ? (
            <>
              <strong>{current.label}</strong>
              {current.detail && <p>{current.detail}</p>}
            </>
          ) : (
            <p className="brief-diagram-hint">{t.diagramHint}</p>
          )}
        </div>
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
