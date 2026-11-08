/** Executor routing's keys and accounts as Core answers them (YN-34 S1,
 * docs/executor-routing.md): routing keys, the 1Password service account's
 * token, claude-swap's accounts and Codex homes. No route answers a key's or
 * the token's value; a write sends one and gets back only whether it is set. */
import { api } from "./api";

export type KeyProvider = "anthropic" | "openai" | "deepseek";
export const KEY_PROVIDERS: readonly KeyProvider[] = ["deepseek", "anthropic", "openai"];
export type KeySource = "local" | "1password";

/** A key as a read shows it: never its value. */
export interface RoutingKey {
  id: string;
  provider: KeyProvider;
  source: KeySource;
  set: boolean;
  setAt: string;
  /** A 1Password key's `op://` reference: it names an item, not its value. */
  reference?: string;
}
export interface TokenView { set: boolean; setAt?: string }
/** Why something can't be had now, in both languages, as Core says it. */
export interface Unavailable { code: string; message: string; messageZh: string }
export interface KeysView { keys: RoutingKey[]; onePasswordToken: TokenView }
/** Whether `op` is installed here, its version, and whether it has service accounts. */
export interface OpView { found: boolean; version?: string; supported: boolean; reason?: Unavailable }
export interface OnePasswordView { token: TokenView; op: OpView }

/** A claude-swap account. Its label (an alias or an email) is not shown:
 * the page names an account by its slot number and fingerprint only. */
export interface CswapAccount { number: number; fingerprint: string; active: boolean; usageStatus?: string }
export interface CodexHome { id: string; label: string; home: string }
export interface AccountsView {
  cswap: { command: string; pinned: string; accounts?: CswapAccount[]; unavailable?: Unavailable };
  codexHomes: CodexHome[];
}

const words = (value: unknown): value is string => typeof value === "string";
const reasonOf = (value: unknown): Unavailable | undefined => {
  const r = value as Partial<Unavailable> | null | undefined;
  return r && words(r.code) ? { code: r.code, message: words(r.message) ? r.message : r.code, messageZh: words(r.messageZh) ? r.messageZh : (words(r.message) ? r.message : r.code) } : undefined;
};
const tokenOf = (value: unknown): TokenView => {
  const t = value as Partial<TokenView> | null | undefined;
  return { set: t?.set === true, ...(t?.set === true && words(t.setAt) ? { setAt: t.setAt } : {}) };
};
const keyOf = (value: unknown): RoutingKey | null => {
  const k = value as Partial<RoutingKey> | null | undefined;
  if (!k || !words(k.id) || !KEY_PROVIDERS.includes(k.provider as KeyProvider) || (k.source !== "local" && k.source !== "1password")) return null;
  return { id: k.id, provider: k.provider as KeyProvider, source: k.source, set: k.set === true, setAt: words(k.setAt) ? k.setAt : "",
    ...(k.source === "1password" && words(k.reference) ? { reference: k.reference } : {}) };
};
/** Only the fields this page shows: an account's label and anything else
 * Core sends are dropped as they arrive, so they never reach the page. */
const accountOf = (value: unknown): CswapAccount | null => {
  const a = value as Partial<CswapAccount> | null | undefined;
  if (!a || typeof a.number !== "number" || !words(a.fingerprint)) return null;
  return { number: a.number, fingerprint: a.fingerprint, active: a.active === true, ...(words(a.usageStatus) ? { usageStatus: a.usageStatus } : {}) };
};
const homeOf = (value: unknown): CodexHome | null => {
  const h = value as Partial<CodexHome> | null | undefined;
  return h && words(h.id) && words(h.home) ? { id: h.id, label: words(h.label) ? h.label : h.id, home: h.home } : null;
};
const listOf = <T>(value: unknown, of: (item: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.map(of).filter((item): item is T => item !== null) : [];

export const keysView = (value: Partial<KeysView>): KeysView => ({ keys: listOf(value.keys, keyOf), onePasswordToken: tokenOf(value.onePasswordToken) });
export const onePasswordView = (value: { token?: unknown; op?: unknown }): OnePasswordView => {
  const op = value.op as Partial<OpView> | null | undefined;
  return { token: tokenOf(value.token), op: { found: op?.found === true, supported: op?.supported === true,
    ...(words(op?.version) ? { version: op.version } : {}), ...(reasonOf(op?.reason) ? { reason: reasonOf(op?.reason) } : {}) } };
};
export const accountsView = (value: { cswap?: Partial<AccountsView["cswap"]>; codexHomes?: unknown }): AccountsView => {
  const cswap = value.cswap ?? {};
  const unavailable = reasonOf(cswap.unavailable);
  return {
    cswap: { command: words(cswap.command) ? cswap.command : "cswap", pinned: words(cswap.pinned) ? cswap.pinned : "",
      ...(unavailable ? { unavailable } : { accounts: listOf(cswap.accounts, accountOf) }) },
    codexHomes: listOf(value.codexHomes, homeOf),
  };
};

const path = (id: string) => `/routing/keys/${encodeURIComponent(id)}`;
export const readKeys = (signal?: AbortSignal) => api<Partial<KeysView>>("/routing/keys", { signal }).then(keysView);
export const readOnePassword = (signal?: AbortSignal) => api<{ token?: unknown; op?: unknown }>("/routing/1password", { signal }).then(onePasswordView);
export const readAccounts = (signal?: AbortSignal) => api<Parameters<typeof accountsView>[0]>("/routing/accounts", { signal }).then(accountsView);
/** Reading the accounts runs claude-swap (up to a minute): a read already
 * under way is shared by the page's two blocks, unless a `fresh` one is asked
 * for (Read again, a changed command), which the later callers then share. */
let accountsRead: Promise<AccountsView> | null = null;
export function readAccountsShared(fresh = false): Promise<AccountsView> {
  if (!accountsRead || fresh) {
    const read: Promise<AccountsView> = readAccounts().finally(() => { if (accountsRead === read) accountsRead = null; });
    accountsRead = read;
  }
  return accountsRead;
}
/** Said on the window when a key, the token, the claude-swap command or the
 * Codex homes changed here, so the candidate order offers what is there now. */
export const ROUTING_CREDENTIALS_CHANGED = "yuzuno:routing-credentials-changed";
export const announceCredentialsChanged = () => window.dispatchEvent(new Event(ROUTING_CREDENTIALS_CHANGED));

/** Keeps a local key's value. The value goes in this one request body and
 * nowhere else; the answer says only that it is set. */
export const putLocalKey = (id: string, provider: KeyProvider, value: string) =>
  api<unknown>(path(id), { method: "PUT", body: JSON.stringify({ source: "local", provider, value }) }).then(keyOf);
export const putReferenceKey = (id: string, provider: KeyProvider, reference: string) =>
  api<unknown>(path(id), { method: "PUT", body: JSON.stringify({ source: "1password", provider, reference }) }).then(keyOf);
export const removeKey = (id: string) => api<{ removed?: boolean }>(path(id), { method: "DELETE" });
/** Whether a 1Password key's reference names a field the token can read, without reading it. */
export const checkKey = (id: string) =>
  api<{ ok?: boolean; reason?: unknown }>(`${path(id)}/check`, { method: "POST", body: "{}" })
    .then((r) => (r.ok === true ? { ok: true as const } : { ok: false as const, reason: reasonOf(r.reason) }));
export const putToken = (value: string) =>
  api<unknown>("/routing/1password/token", { method: "PUT", body: JSON.stringify({ value }) }).then(tokenOf);
export const removeToken = () => api<{ removed?: boolean }>("/routing/1password/token", { method: "DELETE" });
export const putCswapCommand = (command: string) =>
  api<{ command?: string }>("/routing/cswap", { method: "PUT", body: JSON.stringify({ command }) });
export const putCodexHomes = (homes: CodexHome[]) =>
  api<{ codexHomes?: unknown }>("/routing/codex-homes", { method: "PUT", body: JSON.stringify({ homes }) })
    .then((r) => listOf(r.codexHomes, homeOf));

/** A key's id as Core takes it: 1 to 48 of a-z, 0-9 and -. */
export const KEY_ID = /^[a-z0-9-]{1,48}$/;
/** The first id free for a provider's new key: its name, then name-2… */
export function freeKeyId(provider: KeyProvider, taken: readonly string[]): string {
  let id: string = provider;
  for (let n = 2; taken.includes(id); n++) id = `${provider}-${n}`;
  return id;
}
/** An account's fingerprint as the page shows it: its first eight characters. */
export const shortFingerprint = (fingerprint: string) => fingerprint.slice(0, 8);
