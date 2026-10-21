import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LoaderCircle, Plus, Trash2, Undo2 } from "lucide-react";
import { Modal } from "./components";
import { api, errorText } from "./api";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type DraftImage } from "./image-input";
import {
  MAX_NOTE,
  MAX_REGIONS,
  centeredRegion,
  clampRegion,
  feedbackText,
  imagePoint,
  outputScale,
  spanRegion,
  type PointFixSource,
  type Region,
  type Size,
} from "./point-fix";
import type { Agent } from "./types";
import "./point-fix.css";

/** Why an Agent cannot take an image, or null. Never a path in its place. */
export function imageRefusal(agent: Agent | undefined) {
  if (!agent) return "That Agent is no longer in this Workspace.";
  if (agent.closedAt) return `${agent.name} is closed and cannot receive messages.`;
  if (agent.harness !== "codex" && agent.harness !== "claude")
    return `${agent.name} cannot receive images; Codex and Claude Agents can.`;
  return null;
}

type Loaded = { url: string; bitmap: ImageBitmap; size: Size; blob: Blob };
const RED = "#e5484d";

/**
 * The original with the areas drawn on it and numbered, within Core's image
 * limits: PNG first, then JPEG and smaller sizes if it would pass 10 MiB.
 */
async function annotate(loaded: Loaded, regions: readonly Region[]): Promise<Blob> {
  const base = outputScale(loaded.size);
  const attempts: [string, number | undefined, number][] = [
    ["image/png", undefined, 1], ["image/jpeg", 0.9, 1], ["image/jpeg", 0.85, 0.7], ["image/jpeg", 0.8, 0.5],
  ];
  for (const [type, quality, factor] of attempts) {
    const scale = base * factor;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(loaded.size.width * scale));
    canvas.height = Math.max(1, Math.round(loaded.size.height * scale));
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This browser cannot draw the annotated image.");
    g.drawImage(loaded.bitmap, 0, 0, canvas.width, canvas.height);
    const line = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 250));
    const badge = Math.max(11, line * 5);
    g.lineWidth = line;
    g.font = `bold ${Math.round(badge * 1.2)}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    regions.forEach((region, index) => {
      const x = region.x * scale, y = region.y * scale;
      g.strokeStyle = RED;
      g.strokeRect(x, y, region.width * scale, region.height * scale);
      const cx = Math.max(badge, x), cy = Math.max(badge, y);
      g.fillStyle = RED;
      g.beginPath();
      g.arc(cx, cy, badge, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.fillText(String(index + 1), cx, cy);
    });
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
    if (blob && blob.size > 0 && blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error("The annotated image stays larger than 10 MiB even when reduced.");
}

/** Saved to that Agent's own images, as an attached image is (T-31). */
async function upload(agentId: string, blob: Blob, name: string): Promise<DraftImage> {
  const saved = await api<Omit<DraftImage, "agentId" | "name">>(`/agents/${encodeURIComponent(agentId)}/images`, {
    method: "POST",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  return { ...saved, agentId, name: name.slice(0, 200) };
}

const BOX = [["x", "Left"], ["y", "Top"], ["width", "Width"], ["height", "Height"]] as const;

/**
 * Point & Fix (T-167): mark areas on an image, say what to change in each,
 * and add the annotated image (and the original) with that text to an
 * Agent's draft. Nothing is sent: the user edits and sends the draft.
 */
export function PointFix({ source, agents, room, onAdd, onClose }: {
  source: PointFixSource | null;
  agents: readonly Agent[];
  /** Why that Agent's draft cannot take images of these sizes, or null. */
  room: (agentId: string, images: { bytes: number }[]) => string | null;
  /** Adds to that Agent's draft: why it could not, or null once added. */
  onAdd: (agentId: string, images: DraftImage[], text: string) => string | null;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [regions, setRegions] = useState<Region[]>([]);
  const [history, setHistory] = useState<Region[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [drawing, setDrawing] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [target, setTarget] = useState("");
  const [original, setOriginal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const nextId = useRef(1);
  const overlay = useRef<SVGSVGElement>(null);

  // Each image starts clean, read once; what this made is released after.
  useEffect(() => {
    setLoaded(null); setLoadError(""); setRegions([]); setHistory([]); setSelected(null);
    setDrawing(null); setProblem(""); setBusy(false); setOriginal(true);
    if (!source) return;
    const owner = agents.find((a) => a.id === source.ownerId);
    // Its owner first, even one that cannot take images: the reason shows.
    setTarget(owner?.id || agents.find((a) => !imageRefusal(a))?.id || "");
    const controller = new AbortController();
    let made: Loaded | null = null;
    const release = (value: Loaded) => { URL.revokeObjectURL(value.url); value.bitmap.close?.(); };
    void (async () => {
      const blob = await source.load(controller.signal);
      if (!blob.type.startsWith("image/")) throw new Error("it is not an image");
      const bitmap = await createImageBitmap(blob);
      const value = { url: URL.createObjectURL(blob), bitmap, size: { width: bitmap.width, height: bitmap.height }, blob };
      if (controller.signal.aborted) return release(value);
      made = value;
      setLoaded(value);
    })().catch((e) => {
      if (!controller.signal.aborted) setLoadError(`This image cannot be opened for marking: ${errorText(e)}`);
    });
    return () => {
      controller.abort();
      if (made) release(made);
    };
    // The Agents list changes often; only a new image starts again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const change = (next: Region[]) => {
    setHistory((past) => [...past.slice(-49), regions]);
    setRegions(next);
  };
  const reshape = (id: number, patch: Partial<Region>) =>
    loaded && change(regions.map((r) => (r.id === id ? clampRegion({ ...r, ...patch }, loaded.size) : r)));
  const focusNote = (id: number) =>
    requestAnimationFrame(() => document.getElementById(`point-fix-note-${id}`)?.focus());
  function addArea() {
    if (!loaded || regions.length >= MAX_REGIONS) return;
    const region = centeredRegion(nextId.current++, loaded.size);
    change([...regions, region]);
    setSelected(region.id);
    focusNote(region.id);
  }
  function remove(id: number) {
    change(regions.filter((r) => r.id !== id));
    if (selected === id) setSelected(null);
  }
  function undo() {
    const last = history.at(-1);
    if (!last) return;
    setHistory(history.slice(0, -1));
    setRegions(last);
    if (!last.some((r) => r.id === selected)) setSelected(null);
  }
  const point = (event: ReactPointerEvent) =>
    loaded && overlay.current
      ? imagePoint({ x: event.clientX, y: event.clientY }, overlay.current.getBoundingClientRect(), loaded.size)
      : null;

  const agent = agents.find((a) => a.id === target);
  const owner = agents.find((a) => a.id === source?.ownerId);
  const originalFits = !!loaded && IMAGE_TYPES.includes(loaded.blob.type) &&
    loaded.blob.size <= MAX_IMAGE_BYTES && outputScale(loaded.size) === 1;

  async function add() {
    if (!source || !loaded || busy) return;
    const refusal = imageRefusal(agent);
    if (refusal) return setProblem(refusal);
    if (!regions.length) return setProblem("Mark at least one area first.");
    setBusy(true);
    setProblem("");
    try {
      const marked = await annotate(loaded, regions);
      const withOriginal = original && originalFits;
      const full = room(target, [{ bytes: marked.size }, ...(withOriginal ? [{ bytes: loaded.blob.size }] : [])]);
      if (full) throw new Error(full);
      // Saved as that Agent's images, which are content-addressed: trying
      // again after a failure adds the same images, never a second copy.
      const images = [await upload(target, marked, `Annotated ${source.name}`)];
      if (withOriginal) images.push(await upload(target, loaded.blob, source.name));
      const text = feedbackText({ name: source.name, provenance: source.provenance, regions, size: loaded.size, original: withOriginal });
      const refused = onAdd(target, images, text);
      if (refused) throw new Error(refused);
      onClose();
    } catch (e) {
      // The areas and notes stay, and nothing was added: try again or cancel.
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const size = loaded?.size;
  const preview = drawing && size ? spanRegion(0, drawing.start, drawing.end, size) : null;
  return (
    <Modal
      open={!!source}
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title={`Point & Fix · ${source?.name || ""}`}
      description="Mark areas on the image and say what should change. Nothing is sent until you send the draft."
      wide
      className="point-fix-dialog"
    >
      {loadError ? (
        <p role="alert" className="inline-error">{loadError}</p>
      ) : !loaded || !size ? (
        <div className="loading-state"><LoaderCircle size={18} className="spin" />Opening image…</div>
      ) : (
        <div
          className="point-fix"
          onKeyDown={(event) => {
            const field = (event.target as HTMLElement).closest("input, textarea, select");
            if (!field && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
              event.preventDefault();
              undo();
            }
          }}
        >
          <div className="point-fix-stage">
            <div className="point-fix-image">
              <img src={loaded.url} alt={`${source?.name}, original`} draggable={false} />
              <svg
                ref={overlay}
                viewBox={`0 0 ${size.width} ${size.height}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${regions.length} marked area${regions.length === 1 ? "" : "s"}`}
                onPointerDown={(event) => {
                  if (busy || regions.length >= MAX_REGIONS) return;
                  const start = point(event);
                  if (!start) return;
                  // Keeps the drag when the pointer leaves the image; drawing
                  // works without it.
                  try { overlay.current?.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
                  setDrawing({ start, end: start });
                }}
                onPointerMove={(event) => {
                  const end = drawing && point(event);
                  if (drawing && end) setDrawing({ ...drawing, end });
                }}
                onPointerUp={(event) => {
                  if (!drawing) return;
                  const region = spanRegion(nextId.current, drawing.start, point(event) || drawing.end, size);
                  setDrawing(null);
                  if (!region) return;
                  nextId.current++;
                  change([...regions, region]);
                  setSelected(region.id);
                  focusNote(region.id);
                }}
                onPointerCancel={() => setDrawing(null)}
              >
                {regions.map((r) => (
                  <rect
                    key={r.id}
                    data-region={r.id}
                    x={r.x} y={r.y} width={r.width} height={r.height}
                    vectorEffect="non-scaling-stroke"
                    className={r.id === selected ? "selected" : undefined}
                    onPointerDown={(event) => { event.stopPropagation(); setSelected(r.id); }}
                  />
                ))}
                {preview && (
                  <rect className="drawing" x={preview.x} y={preview.y} width={preview.width} height={preview.height} vectorEffect="non-scaling-stroke" />
                )}
              </svg>
              {regions.map((r, index) => (
                <span key={r.id} className="point-fix-badge" aria-hidden="true"
                  style={{ left: `${(r.x / size.width) * 100}%`, top: `${(r.y / size.height) * 100}%` }}>
                  {index + 1}
                </span>
              ))}
            </div>
            <p className="field-hint">
              Drag on the image to mark an area, or use Add area and its fields. Areas are kept in the
              original’s pixels ({size.width}×{size.height}), so zoom never moves them.
            </p>
          </div>
          <div className="point-fix-panel">
            <div className="point-fix-actions">
              <button type="button" className="secondary-button" onClick={addArea} disabled={busy || regions.length >= MAX_REGIONS}>
                <Plus size={14} />Add area
              </button>
              <button type="button" className="quiet-button" onClick={undo} disabled={busy || !history.length}>
                <Undo2 size={14} />Undo
              </button>
            </div>
            {!regions.length && <p className="field-hint">No areas yet.</p>}
            <ol className="point-fix-areas">
              {regions.map((r, index) => (
                <li key={r.id} data-selected={r.id === selected || undefined}>
                  <div className="point-fix-area-heading">
                    <strong>Area {index + 1}</strong>
                    <button type="button" className="icon-button" aria-label={`Remove area ${index + 1}`} disabled={busy} onClick={() => remove(r.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="point-fix-box">
                    {BOX.map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          min={key === "x" || key === "y" ? 0 : 1}
                          step={1}
                          value={r[key]}
                          aria-label={`Area ${index + 1} ${label.toLowerCase()} (px)`}
                          disabled={busy}
                          onFocus={() => setSelected(r.id)}
                          onChange={(event) => reshape(r.id, { [key]: Number(event.target.value) })}
                        />
                      </label>
                    ))}
                  </div>
                  <textarea
                    id={`point-fix-note-${r.id}`}
                    aria-label={`Area ${index + 1} comment`}
                    placeholder="What should change here?"
                    maxLength={MAX_NOTE}
                    value={r.note}
                    disabled={busy}
                    onFocus={() => setSelected(r.id)}
                    onChange={(event) =>
                      setRegions((all) => all.map((x) => (x.id === r.id ? { ...x, note: event.target.value.slice(0, MAX_NOTE) } : x)))}
                  />
                </li>
              ))}
            </ol>
            <label className="point-fix-target">
              Tell
              <select value={target} disabled={busy} onChange={(event) => { setTarget(event.target.value); setProblem(""); }}>
                {!agent && <option value="">Choose an Agent</option>}
                {agents.filter((a) => !a.closedAt || a.id === target).map((a) => (
                  <option key={a.id} value={a.id} disabled={!!imageRefusal(a)}>
                    {a.name}{a.id === source?.ownerId ? " · its owner" : ""}{imageRefusal(a) ? " · cannot take images" : ""}
                  </option>
                ))}
              </select>
            </label>
            {(agent ? imageRefusal(agent) : owner && imageRefusal(owner)) && (
              <p className="field-hint" role="status">{agent ? imageRefusal(agent) : imageRefusal(owner)} Choose an Agent that can.</p>
            )}
            <label className="point-fix-original">
              <input type="checkbox" checked={original} disabled={busy} onChange={(event) => setOriginal(event.target.checked)} />
              Attach the original image too
            </label>
            {original && !originalFits && (
              <p className="field-hint">The original is beyond what Core takes (PNG, JPEG or WebP; 10 MiB; 8192 px; 24 MP), so only the annotated image is attached.</p>
            )}
            {problem && <p role="alert" className="inline-error">{problem}</p>}
            <div className="point-fix-footer">
              <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="primary-button" onClick={add} disabled={busy || !regions.length || !agent || !!imageRefusal(agent)}>
                {busy ? "Preparing…" : `Add to ${agent?.name || "the Agent"}’s draft`}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
