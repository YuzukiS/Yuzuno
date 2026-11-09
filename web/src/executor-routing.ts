/** Executor routing's policy as Core keeps it (YN-34 S3, `executors.routing`;
 * docs/executor-routing.md): an ordered list of candidates, each a harness,
 * a model and an account or key, with conditions. The whole policy is
 * replaced at once, against the version it was read at. Fields this version
 * doesn't know are kept as they came and sent back on save. */
import { API_BASE, NetworkError, api } from "./api";

export type Harness = "claude" | "codex" | "opencode";
export const HARNESSES: readonly Harness[] = ["claude", "codex", "opencode"];
export type Credential =
  | { kind: "login" }
  | { kind: "pool"; manager: "cswap"; accounts: "all" | string[]; pick: "mostRemaining" }
  | { kind: "apiKey"; keyId: string }
  | { kind: "codexHome"; id: string };
/** One weekly period: ISO days (Monday 1 … Sunday 7), from and to as HH:MM, `to` exclusive ("24:00" allowed). */
export interface Slot { days: number[]; from: string; to: string }
export interface Schedule { timeZone: "UTC" | "local"; slots: Slot[] }
export type Condition =
  | { kind: "timeWindow"; inside: boolean; schedule: Schedule; minMinutesLeft?: number }
  /** The share of the week left: Claude and Codex have no 5-hour quota now (YN-60). */
  | { kind: "quota"; weekLeftPct?: number }
  | { kind: "dailyApiCap"; usd: number };
/** A condition of a kind this version doesn't know: shown, kept, never edited. */
export type AnyCondition = Condition | ({ kind: string } & Record<string, unknown>);
export interface Candidate {
  id: string;
  label?: string;
  enabled: boolean;
  harness: Harness;
  model: string;
  reasoningEffort?: string;
  credential: Credential;
  conditions: AnyCondition[];
  unknown: "skip" | "pass";
  [field: string]: unknown;
}
export interface Policy {
  enabled: boolean;
  candidates: Candidate[];
  dailyApiCapUsd?: number;
  whenNone: "wait";
  [field: string]: unknown;
}
export interface PolicyView { version: number; policy: Policy; updatedAt?: string; limits: { candidates: number } }

/** The kinds of work an executor's tier names (YN-70): strong for designing, investigating, deciding and checking, fast for
 * building what was decided. */
export type Tier = "strong" | "fast";
export const TIERS: readonly Tier[] = ["strong", "fast"];
/** The tiers a candidate serves: those it lists, or both when it lists none (as every candidate saved before YN-70). */
export const tiersOf = (c: Candidate): Tier[] =>
  Array.isArray(c.tiers) ? TIERS.filter((tier) => (c.tiers as unknown[]).includes(tier)) : [...TIERS];
/** `c` serving `tiers`: both is no list at all, so a candidate the user leaves at both is saved as it was. */
export function withTiers(c: Candidate, tiers: readonly Tier[]): Candidate {
  const next = { ...c };
  if (TIERS.every((tier) => tiers.includes(tier))) delete next.tiers;
  else next.tiers = TIERS.filter((tier) => tiers.includes(tier));
  return next;
}

export const isKnown = (c: AnyCondition): c is Condition => c.kind === "timeWindow" || c.kind === "quota" || c.kind === "dailyApiCap";
export const emptyPolicy = (): Policy => ({ enabled: false, candidates: [], whenNone: "wait" });

/** The view as this client reads it: lists and switches even from an answer without them. */
export function policyView(value: Partial<PolicyView> | null | undefined): PolicyView {
  const policy = (value?.policy ?? {}) as Partial<Policy>;
  const limit = value?.limits?.candidates;
  return {
    version: typeof value?.version === "number" ? value.version : 0,
    policy: { ...emptyPolicy(), ...policy, enabled: policy.enabled === true, candidates: Array.isArray(policy.candidates) ? policy.candidates : [] },
    ...(typeof value?.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    limits: { candidates: typeof limit === "number" && limit > 0 ? limit : 8 },
  };
}

export const readPolicy = (signal?: AbortSignal) => api<Partial<PolicyView>>("/routing/policy", { signal }).then(policyView);

/** A save Core refused: a newer version was saved (`current`), or a field
 * isn't accepted (`path`, as "candidates[2].conditions[0].usd"). */
export class PolicyRefused extends Error {
  constructor(message: string, readonly code: string, readonly path?: string, readonly current?: PolicyView) {
    super(message);
    this.name = "PolicyRefused";
  }
}

/** Replaces the whole policy, checked against the version it was read at.
 * A stale version is refused with the one saved now; nothing is overwritten. */
export async function savePolicy(expectedVersion: number, policy: Policy): Promise<PolicyView> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/routing/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" },
      body: JSON.stringify({ expectedVersion, policy }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new NetworkError(error);
    throw error;
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* a plain HTTP error */ }
  if (response.ok) return policyView(body as Partial<PolicyView>);
  const message = typeof body.error === "string" ? body.error : text || `HTTP ${response.status}`;
  const code = typeof body.code === "string" ? body.code : response.status === 409 ? "version_conflict" : "refused";
  const current = body.current && typeof body.current === "object" ? policyView(body.current as Partial<PolicyView>) : undefined;
  throw new PolicyRefused(message, code, typeof body.path === "string" ? body.path : undefined, current);
}

/** Where a refused field is: its candidate's and condition's places, from Core's path. */
export function pathPlace(path: string | undefined): { candidate?: number; condition?: number } {
  const candidate = path?.match(/^candidates\[(\d+)\]/);
  const condition = path?.match(/^candidates\[\d+\]\.conditions\[(\d+)\]/);
  return { ...(candidate ? { candidate: Number(candidate[1]) } : {}), ...(condition ? { condition: Number(condition[1]) } : {}) };
}

/** DeepSeek's peak hours: UTC, Monday to Friday, 01–04 and 06–10. Its
 * off-peak price is outside them (S0 design §3; Chinese holidays count as
 * working days, as decided). */
export const DEEPSEEK_PEAK: Schedule = {
  timeZone: "UTC",
  slots: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }, { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" }],
};
export const sameSchedule = (a: Schedule, b: Schedule) => JSON.stringify(a) === JSON.stringify(b);

/** Which credentials a harness takes (Core refuses the rest): Claude Code an
 * Anthropic key, Codex an OpenAI key, OpenCode any of the three. */
export const keyFits = (harness: Harness, provider: string) =>
  harness === "claude" ? provider === "anthropic" : harness === "codex" ? provider === "openai" : ["deepseek", "anthropic", "openai"].includes(provider);
export const credentialFits = (harness: Harness, credential: Credential) =>
  credential.kind === "login" || credential.kind === "apiKey"
  || (credential.kind === "pool" && harness === "claude") || (credential.kind === "codexHome" && harness === "codex");
export const usesApi = (c: Candidate) => c.credential.kind === "apiKey";

/** A tool's first model for a new or changed candidate, and Yuzuno's short list when the tool's own can't be read (YN-57 S2b). */
export const MODEL_HINTS: Record<Harness, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol"],
  opencode: ["deepseek/deepseek-flash"],
};
export const EFFORTS = ["low", "medium", "high", "xhigh"];
/** A model's short name, as a card's title shows it: "deepseek-flash" for "deepseek/deepseek-flash". */
export const modelShort = (model: string) => (model.includes("/") ? model.split("/").pop()! : model);

/** A new candidate's id, unlike the others': "c-" and six letters or digits. */
export function newCandidateId(taken: readonly string[], random: () => number = Math.random): string {
  for (;;) {
    const id = `c-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken.includes(id)) return id;
  }
}

export type PresetId = "deepseekFirst" | "subscriptions" | "subscriptionsThenApi";
export const PRESETS: readonly PresetId[] = ["deepseekFirst", "subscriptions", "subscriptionsThenApi"];
/** A preset's candidates, with the key of each provider the Workspace has
 * (the first by id), or the provider's name as its id when it has none: that
 * candidate then says its key is missing until one is added. */
export function presetCandidates(preset: PresetId, keys: readonly { id: string; provider: string }[], taken: readonly string[] = []): Candidate[] {
  const keyFor = (provider: string) => keys.find((k) => k.provider === provider)?.id ?? provider;
  const ids = [...taken];
  const make = (c: { harness: Harness; model: string; reasoningEffort?: string; credential: Credential; conditions: AnyCondition[] }): Candidate => {
    const id = newCandidateId(ids);
    ids.push(id);
    return { id, enabled: true, unknown: "skip", ...c };
  };
  const deepseek = () => make({ harness: "opencode", model: "deepseek/deepseek-flash", credential: { kind: "apiKey", keyId: keyFor("deepseek") },
    conditions: [{ kind: "timeWindow", inside: false, schedule: DEEPSEEK_PEAK, minMinutesLeft: 30 }, { kind: "dailyApiCap", usd: 5 }] });
  const claudePool = () => make({ harness: "claude", model: "opus", credential: { kind: "pool", manager: "cswap", accounts: "all", pick: "mostRemaining" },
    conditions: [{ kind: "quota", weekLeftPct: 10 }] });
  const codex = () => make({ harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", credential: { kind: "login" },
    conditions: [{ kind: "quota", weekLeftPct: 10 }] });
  const claudeApi = () => make({ harness: "claude", model: "opus", credential: { kind: "apiKey", keyId: keyFor("anthropic") }, conditions: [] });
  const codexApi = () => make({ harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", credential: { kind: "apiKey", keyId: keyFor("openai") }, conditions: [] });
  if (preset === "subscriptions") return [claudePool(), codex()];
  if (preset === "subscriptionsThenApi") return [claudePool(), codex(), claudeApi(), codexApi()];
  return [deepseek(), claudePool(), codex(), claudeApi(), codexApi()];
}

/** Moves the item at `from` to `to`, the others keeping their order. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
