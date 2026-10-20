import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./resizable-panels.css";

type Side = "rail" | "inspector";
type Widths = Partial<Record<Side, number>>;
const storageKey = "yuzuno.panel-widths";
const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)));

function readWidths(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const widths: Widths = {};
    for (const side of ["rail", "inspector"] as const) {
      if (typeof saved?.[side] === "number" && Number.isFinite(saved[side]))
        widths[side] = clamp(saved[side], side === "rail" ? 180 : 240, 480);
    }
    return widths;
  } catch {
    return {};
  }
}

interface PanelSize {
  width: number;
  min: number;
  max: number;
  visible: boolean;
  change: (width: number) => void;
  reset: () => void;
}

export function usePanelWidths(railOpen: boolean, inspectorOpen: boolean) {
  const [widths, setWidths] = useState(readWidths);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [widths]);

  const railVisible = railOpen && viewport > 520;
  const inspectorVisible = inspectorOpen && viewport > 1100;
  const railMin = 180;
  const inspectorMin = 240;
  const mainMin = viewport > 1100 ? 560 : viewport > 720 ? 440 : 320;
  const available = viewport - mainMin;
  const railDefault =
    viewport >= 1500 ? 260 : viewport > 1100 ? 244 : viewport > 720 ? 220 : 180;
  const inspectorDefault = viewport >= 1500 ? 296 : 272;
  // Clamp the displayed sizes only: shrinking a window must not erase preferences.
  const inspectorWidth = inspectorVisible
    ? clamp(
        widths.inspector ?? inspectorDefault,
        inspectorMin,
        Math.min(480, available - (railVisible ? railMin : 0)),
      )
    : 0;
  const railWidth = railVisible
    ? clamp(
        widths.rail ?? railDefault,
        railMin,
        Math.min(480, available - inspectorWidth),
      )
    : railOpen
      ? 68
      : 0;
  function panel(
    side: Side,
    width: number,
    min: number,
    max: number,
    visible: boolean,
  ): PanelSize {
    return {
      width,
      min,
      max,
      visible,
      change: (value) =>
        setWidths((old) => ({ ...old, [side]: clamp(value, min, max) })),
      reset: () =>
        setWidths((old) => {
          const next = { ...old };
          delete next[side];
          return next;
        }),
    };
  }
  return {
    style: {
      "--rail-width": `${railWidth}px`,
      "--inspector-width": `${inspectorWidth}px`,
    } as CSSProperties,
    rail: panel(
      "rail",
      railWidth,
      railMin,
      Math.min(480, available - inspectorWidth),
      railVisible,
    ),
    inspector: panel(
      "inspector",
      inspectorWidth,
      inspectorMin,
      Math.min(480, available - railWidth),
      inspectorVisible,
    ),
  };
}

export function PanelResizeHandle({
  side,
  size,
}: {
  side: Side;
  size: PanelSize;
}) {
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const direction = side === "rail" ? 1 : -1;
  function finish() {
    drag.current = null;
    setDragging(false);
  }
  useEffect(() => {
    if (!size.visible) finish();
  }, [size.visible]);
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement.classList;
    root.add("is-resizing-panels");
    window.addEventListener("blur", finish);
    return () => {
      root.remove("is-resizing-panels");
      window.removeEventListener("blur", finish);
    };
  }, [dragging]);
  if (!size.visible) return null;
  return (
    <div
      className={`panel-resize-handle ${side}-resize-handle${dragging ? " is-resizing" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={
        side === "rail" ? "Agent sidebar width" : "Context panel width"
      }
      aria-controls={side === "rail" ? "agent-sidebar" : "context-panel"}
      aria-orientation="vertical"
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={size.width}
      aria-valuetext={`${size.width} pixels`}
      title="Drag to resize · Arrow keys to adjust · Double-click or Enter to reset"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          width: size.width,
          pointerId: event.pointerId,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        size.change(
          drag.current.width + direction * (event.clientX - drag.current.x),
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        finish();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={finish}
      onPointerCancel={finish}
      onDoubleClick={size.reset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        switch (event.key) {
          case "ArrowLeft":
            size.change(size.width - direction * step);
            break;
          case "ArrowRight":
            size.change(size.width + direction * step);
            break;
          case "Home":
            size.change(size.min);
            break;
          case "End":
            size.change(size.max);
            break;
          case "Enter":
            size.reset();
            break;
          case "Escape":
            if (drag.current) {
              size.change(drag.current.width);
              event.currentTarget.releasePointerCapture(drag.current.pointerId);
              finish();
            }
            break;
          default:
            return;
        }
        // Escape on a layout control must never interrupt the running Agent.
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}
