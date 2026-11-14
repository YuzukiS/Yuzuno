/** Settings → Accounts & keys, a card per provider (YN-84 S3, design v3
 * §3.2): which cards the page draws, and which Workspace settings reference
 * each login, account and key — routing candidates, the new Agent defaults
 * and review. A reference is a setting naming it, not an executor using it,
 * and projects' own settings are left out. What can't be read or told apart
 * is said to be so, never counted as no reference. This module imports types
 * only, so its unit test runs straight from TypeScript (CI's
 * --experimental-strip-types). */
import type { KeyProvider } from "./routing-keys";

/** The providers Core keeps keys for (routing_keys::Provider), in the page's
 * order: a provider Core adds and this list lacks fails the type check. */
const ORDER = { anthropic: 0, openai: 1, deepseek: 2 } satisfies Record<KeyProvider, number>;
export const KNOWN_PROVIDERS: readonly KeyProvider[] = (Object.keys(ORDER) as KeyProvider[]).sort((a, b) => ORDER[a] - ORDER[b]);
const isKnown = (p: string): p is KeyProvider => Object.prototype.hasOwnProperty.call(ORDER, p);
/** The card of a candidate whose model leaves its provider to OpenCode. */
export const OPENCODE_DEFAULT = "*";

/** A routing candidate as Core keeps it, read without trusting its fields. */
export type CandidateLike = {
  id: string;
  enabled?: unknown;
  harness?: unknown;
  model?: unknown;
  credential?: { kind?: unknown; keyId?: unknown; id?: unknown } | null;
  [field: string]: unknown;
};
/** One setting that references a slot. A candidate's `active` is whether it is on with routing on. */
export type Use =
  | { kind: "candidate"; place: number; id: string; name: string; active: boolean }
  | { kind: "agentDefaults" }
  | { kind: "review"; model: string };
/** A setting this version can't tell the credential of: listed, not counted. */
export type Unmapped = { kind: "candidate"; place: number; name: string } | { kind: "agentDefaults" | "review"; harness: string };
export type Missing = "policy" | "agentDefaults" | "review";
/** The accounts' read now, and what the last read that succeeded found (if one did). */
export type AccountsState = {
  current: "reading" | "failed" | "read";
  last?: { cswapAccounts: number; codexHomes: readonly string[] };
};
export type Card = { id: string; known: boolean; keys: string[] };

/** A model's provider: "deepseek/deepseek-flash" → "deepseek"; missing, null, empty or no "/" → null. */
export function modelProvider(model: string | null | undefined): string | null {
  const m = (model ?? "").trim();
  const i = m.indexOf("/");
  return i > 0 ? m.slice(0, i) : null;
}

const hostSlot = (harness: unknown) => (harness === "claude" ? "claudeHost" : harness === "codex" ? "codexHost" : null);
const UNMAPPED = Symbol("unmapped");
/** The slot a candidate's credential names; null for an API key the Workspace doesn't have (the routing page asks
 * for it), UNMAPPED for a credential this version can't tell. */
function slotOf(c: CandidateLike, keyIds: readonly string[]): string | null | typeof UNMAPPED {
  const credential = c.credential;
  switch (credential?.kind) {
    case "login":
      if (c.harness === "opencode") return `opencode:${modelProvider(typeof c.model === "string" ? c.model : null) ?? OPENCODE_DEFAULT}`;
      // DeepSeek Harness has no login here (YN-119 §3.10): one saved so lacks its DeepSeek key, as the routing page says.
      if (c.harness === "dsh") return null;
      return hostSlot(c.harness) ?? UNMAPPED;
    case "pool": return "cswap";
    case "codexHome": return typeof credential.id === "string" ? `home:${credential.id}` : UNMAPPED;
    case "apiKey":
      if (typeof credential.keyId !== "string") return UNMAPPED;
      return keyIds.includes(credential.keyId) ? `key:${credential.keyId}` : null;
    default: return UNMAPPED;
  }
}

/** Every slot's references. A read that failed is null: `missing` names it, and the references are then not
 * complete; nor are they while anything is unmapped. `place` is a candidate's place in the saved order, from 1. */
export function usesOf<C extends CandidateLike>(input: {
  candidates: readonly C[] | null;
  routingOn: boolean;
  agentHarness: string | null;
  reviewer: { harness: string; model: string } | null;
  keyIds: readonly string[];
}, nameOf: (c: C) => string): { uses: Map<string, Use[]>; unmapped: Unmapped[]; missing: Missing[]; complete: boolean } {
  const uses = new Map<string, Use[]>();
  const unmapped: Unmapped[] = [];
  const add = (slot: string, use: Use) => { const list = uses.get(slot); if (list) list.push(use); else uses.set(slot, [use]); };
  input.candidates?.forEach((c, i) => {
    const place = i + 1;
    const slot = slotOf(c, input.keyIds);
    if (slot === UNMAPPED) unmapped.push({ kind: "candidate", place, name: nameOf(c) });
    else if (slot) add(slot, { kind: "candidate", place, id: c.id, name: nameOf(c), active: c.enabled === true && input.routingOn });
  });
  if (input.agentHarness !== null) {
    const slot = hostSlot(input.agentHarness);
    if (slot) add(slot, { kind: "agentDefaults" }); else unmapped.push({ kind: "agentDefaults", harness: input.agentHarness });
  }
  if (input.reviewer) {
    const slot = hostSlot(input.reviewer.harness);
    if (slot) add(slot, { kind: "review", model: input.reviewer.model }); else unmapped.push({ kind: "review", harness: input.reviewer.harness });
  }
  const missing: Missing[] = [];
  if (!input.candidates) missing.push("policy");
  if (input.agentHarness === null) missing.push("agentDefaults");
  if (!input.reviewer) missing.push("review");
  return { uses, unmapped, missing, complete: missing.length === 0 && unmapped.length === 0 };
}

const used = (uses: Map<string, Use[]>, slot: string) => (uses.get(slot)?.length ?? 0) > 0;
/** The slots whose references a card's head counts: a Codex home only when the accounts' last read has it (one
 * that is gone is the routing page's to fix, as a key that is gone). */
export function cardSlots(card: Card, accounts: AccountsState): string[] {
  const keys = card.keys.map((id) => `key:${id}`);
  if (card.id === "anthropic") return ["claudeHost", "cswap", "opencode:anthropic", ...keys];
  if (card.id === "openai") return ["codexHost", ...(accounts.last?.codexHomes ?? []).map((id) => `home:${id}`), "opencode:openai", ...keys];
  return [`opencode:${card.id}`, ...keys];
}

/** The cards to draw, in order: the known providers, then the other OpenCode providers referenced (by id), then
 * OpenCode's default model. While anything is unread or unmapped, or the accounts are not read now, every known
 * provider is drawn: nothing is hidden while unsure. Once all is read, a known provider is drawn when it has a key,
 * a reference (one off too), a claude-swap account (Anthropic) or a Codex home (OpenAI), or is in `revealed` (the
 * ones the user opened); `hidden` are the others. The cards depend on these inputs only, not on the order reads
 * finished in. */
export function providerCards(input: {
  keys: readonly { id: string; provider: string }[];
  accounts: AccountsState;
  uses: Map<string, Use[]>;
  complete: boolean;
  revealed: ReadonlySet<string>;
}): { cards: Card[]; hidden: KeyProvider[] } {
  const { keys, accounts, uses, complete, revealed } = input;
  const sure = complete && accounts.current === "read";
  const cards: Card[] = [];
  const hidden: KeyProvider[] = [];
  for (const p of KNOWN_PROVIDERS) {
    const card: Card = { id: p, known: true, keys: keys.filter((k) => k.provider === p).map((k) => k.id) };
    const referenced = cardSlots(card, accounts).some((slot) => used(uses, slot))
      || (p === "openai" && [...uses.keys()].some((slot) => slot.startsWith("home:") && used(uses, slot)));
    const accountsFound = p === "anthropic" ? (accounts.last?.cswapAccounts ?? 0) > 0 : p === "openai" ? (accounts.last?.codexHomes.length ?? 0) > 0 : false;
    if (!sure || card.keys.length > 0 || referenced || accountsFound || revealed.has(p)) cards.push(card); else hidden.push(p);
  }
  const others = [...uses.keys()].filter((slot) => slot.startsWith("opencode:") && used(uses, slot)).map((slot) => slot.slice("opencode:".length))
    .filter((p) => !isKnown(p) && p !== OPENCODE_DEFAULT).sort();
  for (const p of others) cards.push({ id: p, known: false, keys: [] });
  if (used(uses, `opencode:${OPENCODE_DEFAULT}`)) cards.push({ id: OPENCODE_DEFAULT, known: false, keys: [] });
  return { cards, hidden };
}

/** How many settings reference these slots: a candidate once whatever slots it is in, the new Agent defaults and
 * review once each. `active` counts the ones in use with routing as saved; `off` the candidates turned off, and
 * every candidate while routing is off. */
export function countRefs(slots: readonly string[], uses: Map<string, Use[]>): { active: number; off: number } {
  const seen = new Set<string>();
  let active = 0;
  let off = 0;
  for (const slot of slots) {
    for (const use of uses.get(slot) ?? []) {
      const id = use.kind === "candidate" ? `candidate:${use.id}` : use.kind;
      if (seen.has(id)) continue;
      seen.add(id);
      if (use.kind !== "candidate" || use.active) active++; else off++;
    }
  }
  return { active, off };
}
