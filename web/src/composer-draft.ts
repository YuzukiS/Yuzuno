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
/**
 * A Codex skill chosen for this draft from what the Agent's own Codex listed
 * (T-29): the Agent it was listed for, and its name and path there. Only a
 * choice adds one; text, even "$name", never does.
 */
export type DraftSkill = { agentId: string; name: string; path: string; scope: string };
export const MAX_DRAFT_SKILLS = 16;
export function validDraftSkills(value: unknown): value is DraftSkill[] {
  return Array.isArray(value) && value.length <= MAX_DRAFT_SKILLS && value.every((s) =>
    !!s && typeof s === "object" && typeof s.agentId === "string" && typeof s.name === "string" && !!s.name
    && typeof s.path === "string" && !!s.path && typeof s.scope === "string");
}
export type ComposerDraft = {
  version: 1;
  nextNumber: number;
  parts: readonly DraftPart[];
  images?: readonly DraftImage[];
  skills?: readonly DraftSkill[];
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
/** A draft copied to another Agent (a fork): its text and images, never
 * the skills chosen here, which this Agent's own Codex listed. */
export function copiedDraft(draft: ComposerDraft): ComposerDraft {
  const { skills: _chosen, ...copied } = draft;
  return copied;
}
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
type SavedDraft = { version: 1; nextNumber: number; parts: SavedPart[]; images?: DraftImage[]; skills?: DraftSkill[] };

/**
 * What an Agent's saved draft holds, read from its manifest alone (T-193): no
 * paste body is read. "legacy" is a draft the older string map still holds; an
 * empty saved draft (or none) is "none". `load` checks more: a draft summed up
 * here can still prove damaged when it is opened.
 */
export type SavedDraftSummary =
  | { state: "none" }
  | { state: "saved" | "legacy"; textChars: number; pastes: number; images: number; skills: number }
  | { state: "damaged"; reason: string };
export function savedDraftSummary(storage: Pick<Storage, "getItem">, agent: string): SavedDraftSummary {
  const raw = storage.getItem(prefix + agent);
  try {
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved.parts)) throw new Error("Invalid saved draft");
      const texts = saved.parts.filter((p: SavedPart) => p?.kind === "text" && typeof p.text === "string") as { text: string }[];
      const pastes = saved.parts.filter((p: SavedPart) => p?.kind === "paste").length;
      const images = Array.isArray(saved.images) ? saved.images.length : 0;
      const skills = Array.isArray(saved.skills) ? saved.skills.length : 0;
      if (!texts.some((p) => p.text.trim()) && !pastes && !images) return { state: "none" };
      return { state: "saved", textChars: texts.reduce((n, p) => n + p.text.length, 0), pastes, images, skills };
    }
    const legacy = JSON.parse(storage.getItem("yuzuno.drafts") || "{}");
    const text = typeof legacy?.[agent] === "string" ? legacy[agent] : "";
    return text.trim() ? { state: "legacy", textChars: text.length, pastes: 0, images: 0, skills: 0 } : { state: "none" };
  } catch (error) {
    return { state: "damaged", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The Agents this device's draft storage holds something for: a manifest,
 * or an entry in the older string map. Nothing is read beyond keys and that map. */
export function savedDraftAgents(storage: Pick<Storage, "getItem" | "key" | "length">): string[] {
  const agents = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) agents.add(key.slice(prefix.length));
  }
  try {
    const legacy = JSON.parse(storage.getItem("yuzuno.drafts") || "{}");
    for (const [agent, text] of Object.entries(legacy ?? {})) if (typeof text === "string") agents.add(agent);
  } catch {
    // A damaged older map is reported for each Agent it would hold (savedDraftSummary).
  }
  return [...agents];
}

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
    if (saved.skills !== undefined && !validDraftSkills(saved.skills)) throw new Error("Invalid saved skill references");
    // A skill is this Agent's: one saved for another is never offered here.
    const skills = (saved.skills || []).filter((skill) => skill.agentId === agent);
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
    return { version: 1, nextNumber: saved.nextNumber, parts, ...(saved.images?.length ? { images: saved.images } : {}),
      ...(skills.length ? { skills } : {}) };
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
        ...(draft.skills?.length ? { skills: draft.skills } : {}),
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
