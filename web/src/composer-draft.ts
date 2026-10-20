import { validDraftImages, type DraftImage } from "./image-input.ts";
/** Draft text stays ordered. Paste bodies are immutable values, never labels sent to a Harness. */
export type PastedText = {
  kind: "paste";
  id: string;
  number: number;
  bodyId: string;
  text: string;
  lines: number;
  hasContent: boolean;
  preview: string;
};
export type DraftPart = { kind: "text"; text: string } | PastedText;
export type ComposerDraft = {
  version: 1;
  nextNumber: number;
  parts: readonly DraftPart[];
  images?: readonly DraftImage[];
};
export const emptyDraft = (): ComposerDraft => ({
  version: 1,
  nextNumber: 1,
  parts: [],
});
export const textDraft = (text: string): ComposerDraft => ({
  ...emptyDraft(),
  parts: text ? [{ kind: "text", text }] : [],
});
export const draftText = (draft: ComposerDraft) =>
  draft.parts.map((p) => p.text).join("");
export const hasDraftContent = (draft: ComposerDraft) =>
  !!draft.images?.length || draft.parts.some((p) =>
    p.kind === "paste" ? p.hasContent : !!p.text.trim(),
  );
export const lineCount = (text: string) =>
  1 + (text.match(/\r\n|\r|\n/g)?.length || 0);
export function shouldFoldPaste(text: string) {
  return text.length >= 2000 || lineCount(text) >= 12;
}
export function pastedText(
  text: string,
  number: number,
  id: string = crypto.randomUUID(),
): PastedText {
  return {
    kind: "paste",
    id,
    number,
    bodyId: crypto.randomUUID(),
    text,
    lines: lineCount(text),
    hasContent: !!text.trim(),
    preview: text
      .slice(0, 800)
      .split(/\r\n|\r|\n/)
      .slice(0, 6)
      .join("\n"),
  };
}
export function appendDraft(draft: ComposerDraft, text: string): ComposerDraft {
  return {
    ...draft,
    parts: [
      ...draft.parts,
      { kind: "text", text: `${hasDraftContent(draft) ? "\n\n" : ""}${text}` },
    ],
  };
}

const prefix = "yuzuno.composer.v1:";
const bodyPrefix = "yuzuno.paste.v1:";
type SavedPart =
  | { kind: "text"; text: string }
  | Pick<PastedText, "kind" | "id" | "number" | "bodyId">;
type SavedDraft = { version: 1; nextNumber: number; parts: SavedPart[]; images?: DraftImage[] };

/** Cache only identities, so nearby keystrokes never stringify/read paste bodies. */
export class DraftStorage {
  private written = new Set<string>();
  private bodies = new Map<string, Set<string>>();
  private manifests = new Map<string, string | null>();
  private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  constructor(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    this.storage = storage;
  }

  load(agent: string): ComposerDraft {
    const raw = this.storage.getItem(prefix + agent);
    if (!raw) {
      // Read the old string map without rewriting or deleting other Agents' drafts.
      const legacy = JSON.parse(this.storage.getItem("yuzuno.drafts") || "{}");
      this.manifests.set(agent, raw);
      return textDraft(
        typeof legacy?.[agent] === "string" ? legacy[agent] : "",
      );
    }
    const saved: SavedDraft = JSON.parse(raw);
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.parts) ||
      !Number.isSafeInteger(saved.nextNumber) ||
      saved.nextNumber < 1
    )
      throw new Error("Invalid saved draft");
    if (saved.images !== undefined && !validDraftImages(saved.images)) throw new Error("Invalid saved image references");
    const keys = new Set<string>();
    const parts = saved.parts.map((p): DraftPart => {
      if (p.kind === "text" && typeof p.text === "string") return p;
      if (
        p.kind !== "paste" ||
        typeof p.id !== "string" ||
        typeof p.bodyId !== "string" ||
        !Number.isSafeInteger(p.number) ||
        p.number < 1 ||
        p.number >= saved.nextNumber
      )
        throw new Error("Invalid pasted text reference");
      const key = bodyPrefix + agent + ":" + p.bodyId;
      const text = this.storage.getItem(key);
      if (text === null) throw new Error("Saved pasted text is missing");
      keys.add(key);
      this.written.add(key);
      return { ...pastedText(text, p.number, p.id), bodyId: p.bodyId };
    });
    this.bodies.set(agent, keys);
    this.manifests.set(agent, raw);
    return { version: 1, nextNumber: saved.nextNumber, parts, ...(saved.images?.length ? { images: saved.images } : {}) };
  }

  save(agent: string, draft: ComposerDraft) {
    // Another window can remove bodies that this instance previously loaded.
    // Compare only the small manifest on each save, without reading large bodies
    // or waiting for asynchronous storage events. Reconcile bodies only when the
    // manifest changed outside this instance (including before opening an Agent).
    const current = this.storage.getItem(prefix + agent);
    if (!this.bodies.has(agent) || this.manifests.get(agent) !== current) {
      for (const key of this.bodies.get(agent) || []) this.written.delete(key);
      const saved = JSON.parse(current || "null");
      if (saved && !Array.isArray(saved.parts))
        throw new Error("Invalid saved draft");
      this.bodies.set(
        agent,
        new Set<string>(
          (saved?.parts || [])
            .filter(
              (p: SavedPart) =>
                p.kind === "paste" && typeof p.bodyId === "string",
            )
            .map(
              (p: Extract<SavedPart, { kind: "paste" }>) =>
                bodyPrefix + agent + ":" + p.bodyId,
            ),
        ),
      );
    }
    const keys = new Set<string>();
    const created: string[] = [];
    try {
      const parts: SavedPart[] = draft.parts.map((p) => {
        if (p.kind === "text") return p;
        const key = bodyPrefix + agent + ":" + p.bodyId;
        keys.add(key);
        if (!this.written.has(key)) {
          // Existing immutable bodies belong to the previous manifest too.
          // Rollback must remove only bodies actually created by this save.
          if (this.storage.getItem(key) === null) {
            this.storage.setItem(key, p.text);
            created.push(key);
          }
          this.written.add(key);
        }
        return { kind: "paste", id: p.id, number: p.number, bodyId: p.bodyId };
      });
      // Publish references only after their bodies exist. A quota failure leaves
      // the previous saved draft valid and the latest draft available in memory.
      const manifest = JSON.stringify({
        version: 1,
        nextNumber: draft.nextNumber,
        parts,
        ...(draft.images?.length ? { images: draft.images } : {}),
      });
      this.storage.setItem(prefix + agent, manifest);
      this.manifests.set(agent, manifest);
    } catch (error) {
      for (const key of created) {
        try {
          this.storage.removeItem(key);
        } catch {
          /* Storage may have become unavailable. */
        }
        this.written.delete(key);
      }
      throw error;
    }
    for (const key of this.bodies.get(agent) || []) {
      if (!keys.has(key)) {
        this.storage.removeItem(key);
        this.written.delete(key);
      }
    }
    this.bodies.set(agent, keys);
  }

  remove(agent: string) {
    // A tombstone also prevents a cleared legacy string from reappearing.
    this.save(agent, emptyDraft());
  }

  /** Explicit user-confirmed recovery; works even for malformed manifests. */
  discard(agent: string) {
    const raw = this.storage.getItem(prefix + agent);
    let parts: SavedPart[] = [];
    try {
      const saved = JSON.parse(raw || "null");
      if (Array.isArray(saved?.parts)) parts = saved.parts;
    } catch {
      /* A corrupt manifest cannot enumerate its body keys. */
    }
    const manifest = JSON.stringify(emptyDraft());
    // Do not unlock or delete anything unless the empty draft is durable.
    this.storage.setItem(prefix + agent, manifest);
    for (const part of parts) {
      if (part?.kind !== "paste" || typeof part.bodyId !== "string") continue;
      const key = bodyPrefix + agent + ":" + part.bodyId;
      this.written.delete(key);
      try {
        this.storage.removeItem(key);
      } catch {
        /* Unreferenced body only. */
      }
    }
    for (const key of this.bodies.get(agent) || []) this.written.delete(key);
    this.bodies.set(agent, new Set());
    this.manifests.set(agent, manifest);
  }
}
