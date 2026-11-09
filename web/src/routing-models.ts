/** The models a routing candidate's tool offers (YN-57 S2b), for its model
 * picker: Claude Code's from its CLI's own list (`/api/models?harness=claude`:
 * aliases, and the version each points to now), Codex's from `model/list`
 * (`/api/models`), and OpenCode's as a new executor's OpenCode lists them
 * (`/api/routing/models?harness=opencode`, docs/executor-routing.md). */
import { api } from "./api";
import type { Harness } from "./executor-routing";
import type { Model } from "./types";

/** Where an OpenCode provider gets its access, as Core says it: a login, a variable Core's environment has, nothing
 * needed, or only a routing key of it (`routingKey`); null when that was not read. */
export interface CatalogProvider { id: string; name: string; source: "credential" | "env" | "ready" | "routingKey" | null; keyProvider?: string }
export interface Catalog { models: Model[]; providers?: CatalogProvider[]; opencode?: { version?: string } }

const path: Record<Harness, string> = { claude: "/models?harness=claude", codex: "/models", opencode: "/routing/models?harness=opencode" };
/** How long a list read is kept for the page: a tool's list changes with its release or the user's config, rarely. */
const KEPT_MS = 10 * 60_000;
const kept = new Map<Harness, { at: number; read: Promise<Catalog> }>();

/** A tool's list, read once and shared while it is kept, unless a `fresh` one is asked for (Read again). A read that
 * fails is not kept: the next asks again. */
export function readModels(harness: Harness, fresh = false, now = Date.now()): Promise<Catalog> {
  const held = kept.get(harness);
  if (held && !fresh && now - held.at < KEPT_MS) return held.read;
  const read = api<Catalog>(path[harness]).then((answer) => ({ ...answer, models: Array.isArray(answer?.models) ? answer.models : [] }));
  kept.set(harness, { at: now, read });
  read.catch(() => { if (kept.get(harness)?.read === read) kept.delete(harness); });
  return read;
}
/** For tests: forget what was read. */
export const forgetModels = () => kept.clear();

export interface ModelOption { value: string; label: string }
/** `kind` says what a group's models need: nothing more, or another API key than the candidate's. */
export interface ModelGroup { label: string; options: ModelOption[]; kind?: "needsKey" }

export interface GroupWords {
  aliases: string;
  pinned: string;
  codex: string;
  withKey: (provider: string) => string;
  needsKey: (provider: string) => string;
  env: (provider: string) => string;
  ready: (provider: string) => string;
  loggedIn: (provider: string) => string;
}

const valueOf = (m: Model) => m.model || m.id;
/** "Opus · opus"; just the value when its name is the same. */
const named = (name: string | undefined, value: string) => (name && name !== value ? `${name} · ${value}` : value);

/** The select's groups for a tool's list. OpenCode's: the candidate's key's provider first, then those Core's
 * environment reaches, then those that need nothing (OpenCode's own last), then those that need another key;
 * `keyProvider` is the provider of the candidate's API key, if it has one. */
export function modelGroups(harness: Harness, catalog: Catalog, words: GroupWords, keyProvider: string | null): ModelGroup[] {
  const models = catalog.models.filter((m) => valueOf(m));
  if (harness === "claude") {
    const aliases = models.map((m) => ({ value: valueOf(m), label: named(m.displayName, valueOf(m)) }));
    const taken = new Set(aliases.map((o) => o.value));
    const pinned: ModelOption[] = [];
    for (const m of models) {
      const resolved = m.resolvedModel;
      if (resolved && !taken.has(resolved)) { taken.add(resolved); pinned.push({ value: resolved, label: resolved }); }
    }
    return [{ label: words.aliases, options: aliases }, ...(pinned.length ? [{ label: words.pinned, options: pinned }] : [])];
  }
  if (harness === "codex") {
    const shown = models.filter((m) => m.hidden !== true);
    return [{ label: words.codex, options: shown.map((m) => ({ value: valueOf(m), label: named(m.displayName, valueOf(m)) })) }];
  }
  const byProvider = new Map<string, Model[]>();
  for (const m of models) {
    const provider = m.providerId || valueOf(m).split("/")[0];
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), m]);
  }
  const providers = new Map((catalog.providers ?? []).map((p) => [p.id, p]));
  const groups = [...byProvider.entries()].map(([id, list]) => {
    const p = providers.get(id);
    const name = p?.name || list[0].providerName || id;
    const source = p?.source ?? null;
    const theirs = source === "routingKey" && (p?.keyProvider ?? id) === keyProvider;
    const rank = theirs ? 0 : source === "credential" ? 1 : source === "env" ? 2 : source === "routingKey" ? 5 : id === "opencode" ? 4 : 3;
    const label = theirs ? words.withKey(name) : source === "routingKey" ? words.needsKey(name) : source === "env" ? words.env(name)
      : source === "credential" ? words.loggedIn(name) : source === "ready" ? words.ready(name) : name;
    const group: ModelGroup = { label, options: list.map((m) => ({ value: valueOf(m), label: named(m.name, valueOf(m)) })),
      ...(source === "routingKey" && !theirs ? { kind: "needsKey" as const } : {}) };
    return { rank, name, group };
  });
  return groups.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map((g) => g.group);
}

/** The provider a model of OpenCode's list needs a routing key of, when the candidate's credential isn't one of it. */
export function keyNeeded(catalog: Catalog | null, model: string, keyProvider: string | null): string | null {
  if (!catalog || !model.includes("/")) return null;
  const provider = catalog.models.find((m) => valueOf(m) === model)?.providerId || model.split("/")[0];
  const p = catalog.providers?.find((x) => x.id === provider);
  if (p?.source !== "routingKey" || (p.keyProvider ?? provider) === keyProvider) return null;
  return p.name || provider;
}
