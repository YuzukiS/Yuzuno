import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { strings, useStrings } from "./i18n";

/** One block of a page with a change not yet saved. */
export interface SaveBarPart {
  /** False while the block can't be saved as it stands; the block says why. */
  ready?: boolean;
  /** Saves this block with its own request (and version, where it has one).
   * False when Core refused it; the block says why and keeps the change. */
  save: () => Promise<boolean>;
  /** Back to what Core has saved. */
  discard: () => void;
}

interface Registry {
  put(id: string, part: SaveBarPart): void;
  drop(id: string): void;
}

const SaveBarContext = createContext<Registry | null>(null);

const text = strings({
  label: "Changes on this page",
  changes: (n: number) => (n === 1 ? "1 change not saved" : `${n} changes not saved`),
  notReady: "Correct the marked block to save.",
  failed: (n: number) => (n === 1 ? "1 change wasn’t saved: its block says why." : `${n} changes weren’t saved: their blocks say why.`),
  saved: "All changes saved.",
  discard: "Discard",
  save: "Save",
  saving: "Saving…",
}, {
  label: "此页的更改",
  changes: (n) => `${n} 处更改还没保存`,
  notReady: "请先改好标出的那一块再保存。",
  failed: (n) => `${n} 处更改没有保存，原因写在对应的那一块里。`,
  saved: "所有更改都已保存。",
  discard: "放弃",
  save: "保存",
  saving: "正在保存…",
});

/** Joins a block to its page's save bar while it has a change (YN-8). The
 * block keeps its own draft, request and error; the bar saves or discards
 * it with the others. Returns whether there is a bar: without one (the
 * block mounted on its own) the block keeps its own Save button. */
export function useSaveBarPart(id: string, part: SaveBarPart | null): boolean {
  const registry = useContext(SaveBarContext);
  const latest = useRef(part);
  latest.current = part;
  const changed = !!part;
  const ready = part?.ready ?? true;
  const joined = (ready: boolean): SaveBarPart => ({
    ready,
    save: () => latest.current?.save() ?? Promise.resolve(true),
    discard: () => latest.current?.discard(),
  });
  // Joined while changed; a change of readiness keeps its place in the bar.
  useEffect(() => {
    if (!registry || !changed) return;
    registry.put(id, joined(latest.current?.ready ?? true));
    return () => registry.drop(id);
  }, [registry, id, changed]);
  useEffect(() => {
    if (registry && changed) registry.put(id, joined(ready));
  }, [registry, id, changed, ready]);
  return !!registry;
}

/** A Workspace page's one save (YN-8 design: "N changes not saved · Discard ·
 * Save"), in place of a Save button per block. Saving still sends each block
 * on its own, one after another, each against its own version; a block Core
 * refuses keeps its change and says why, and the others are saved. Explicit
 * commands (Archive, Link, Check) don't wait for it. */
export function SaveBarScope({ children, hidden = false }: {
  children: ReactNode;
  /** While its page isn't shown (Settings keeps visited pages mounted). */
  hidden?: boolean;
}) {
  const t = useStrings(text);
  const [parts, setParts] = useState<ReadonlyMap<string, SaveBarPart>>(() => new Map());
  const [busy, setBusy] = useState(false);
  // What the last save came to, until something changes again.
  const [outcome, setOutcome] = useState<{ failed: number } | null>(null);
  const registry = useMemo<Registry>(() => ({
    put: (id, part) => setParts((old) => new Map(old).set(id, part)),
    drop: (id) => setParts((old) => {
      if (!old.has(id)) return old;
      const next = new Map(old);
      next.delete(id);
      return next;
    }),
  }), []);
  const count = parts.size;
  const ready = [...parts.values()].every((part) => part.ready !== false);
  // A new change after a save clears what that save came to, once it has
  // been read: a failed block that stays changed keeps its "wasn't saved".
  // With no change left (its block took what Core has instead, YN-49), a
  // "wasn't saved" names nothing any more and goes.
  const seen = useRef(count);
  useEffect(() => {
    if ((count > seen.current && outcome?.failed === 0) || (count === 0 && !busy && (outcome?.failed ?? 0) > 0)) setOutcome(null);
    seen.current = count;
  }, [count, outcome, busy]);
  const line = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  useLayoutEffect(() => {
    // The Save pressed is gone with the last change: focus goes to what the bar says.
    if (!pressed.current || busy) return;
    pressed.current = false;
    const at = document.activeElement;
    if (!at || at === document.body) line.current?.focus();
  }, [busy, count]);
  async function save() {
    if (busy || !ready) return;
    setBusy(true);
    setOutcome(null);
    pressed.current = true;
    let failed = 0;
    for (const part of [...parts.values()]) {
      try {
        if (!(await part.save())) failed++;
      } catch {
        failed++;
      }
    }
    setOutcome({ failed });
    setBusy(false);
  }
  const discard = () => {
    for (const part of [...parts.values()]) part.discard();
    setOutcome(null);
  };
  const shown = count > 0 || busy || outcome !== null;
  return (
    <SaveBarContext.Provider value={registry}>
      {children}
      <div className="settings-savebar" role="region" aria-label={t.label} hidden={hidden || !shown}>
        <span ref={line} tabIndex={-1} role="status">
          {count > 0 ? t.changes(count) : outcome?.failed === 0 ? t.saved : ""}
          {count > 0 && !ready && <small> · {t.notReady}</small>}
          {outcome && outcome.failed > 0 && <small role="alert"> · {t.failed(outcome.failed)}</small>}
        </span>
        {count > 0 && (
          <>
            <button type="button" className="quiet-button" disabled={busy} onClick={discard}>
              {t.discard}
            </button>
            <button type="button" className="primary-button" disabled={busy || !ready} onClick={() => void save()}>
              {busy && <LoaderCircle size={13} className="spin" />} {busy ? t.saving : t.save}
            </button>
          </>
        )}
      </div>
    </SaveBarContext.Provider>
  );
}
