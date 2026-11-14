import { useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { Bot, CircleAlert, HardDrive, KeyRound, LoaderCircle, Lock, LogIn, Plus, RefreshCw, ShieldCheck, Smartphone, Terminal, Trash2, Users, X } from "lucide-react";
import { OPENCODE_DEFAULT, cardSlots, countRefs, providerCards, usesOf, type AccountsState, type Card, type Use } from "./accounts-cards";
import { readAgentDefaults, type AgentDefaultsView } from "./agent-defaults";
import { api, errorText } from "./api";
import { DSH_NAME, dshAvailable, useDsh } from "./dsh";
import { harnessesOffered, keyFits, readPolicy, type Candidate } from "./executor-routing";
import { harnessName, nameOf } from "./executor-routing-text";
import { langTag, strings, useLanguage, type Language } from "./i18n";
import {
  KEY_ID, KEY_PROVIDERS, checkKey, freeKeyId, putCodexHomes, putCswapCommand, putLocalKey, putReferenceKey, putToken,
  ROUTING_CREDENTIALS_CHANGED, announceCredentialsChanged, readAccountsShared, readKeys, readOnePassword, removeKey, removeToken, shortFingerprint,
  type AccountsView, type CodexHome, type KeyProvider, type KeySource, type KeysView, type OnePasswordView, type RoutingKey, type Unavailable,
} from "./routing-keys";
import { timeFormatter, useTimeDisplay } from "./time-preferences";
import "./executor-routing.css";

const providerName: Record<KeyProvider, string> = { deepseek: "DeepSeek", anthropic: "Anthropic", openai: "OpenAI" };
const harnessNames: Record<KeyProvider, string> = { deepseek: "OpenCode", anthropic: "Claude Code", openai: "Codex" };
/** The tool a provider's key is for, in its title: a DeepSeek key is also DeepSeek Harness's while this Core starts it (YN-119 §3.10). */
const harnessOf = (provider: KeyProvider, dsh: boolean) => (provider === "deepseek" && dsh ? `${harnessNames.deepseek} / ${DSH_NAME}` : harnessNames[provider]);
/** "a, b and c": a list in an English sentence. */
const listEn = (parts: readonly string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

const text = strings({
  title: "Accounts & keys",
  intro: "The accounts and API keys executor routing may start an executor with, by provider: each card lists its logins, then its API keys, and which settings reference each. A key's value is never shown again once entered.",
  refsScope: "“Referenced by” covers Workspace settings only: routing candidates, the new Agent defaults and review. It leaves out projects' own settings and doesn't mean an executor is using it now.",
  boundary: "Accounts & keys are read and changed from Yuzuno's page on the computer that runs Core or on the phone. Any device signed in to the allowed Tailscale login can change them; an Agent's token cannot.",
  reading: "Reading…",
  lastRead: "Below is what was read before.",
  logins: "Logins",
  keys: "API keys",
  claudeHostTitle: "Claude Code's login on the host",
  claudeHostHelp: "The account Claude Code itself is signed in to on the machine an executor runs on. Yuzuno doesn't read or change it.",
  codexHostTitle: "Codex's login on the host (ChatGPT subscription)",
  codexHostHelp: "The account Codex itself is signed in to on the machine an executor runs on; nothing to add.",
  opencodeTitle: "OpenCode's own login",
  opencodeHelp: "OpenCode reaches this provider with its own config and Core's environment; manage it in OpenCode. Yuzuno doesn't read it.",
  opencodeDefault: "OpenCode's default model",
  opencodeDefaultSub: "Its provider comes from OpenCode's own config",
  noLogin: (provider: string) => `No login to manage here. A routing candidate that reaches ${provider} with OpenCode's own login is listed here.`,
  noKey: "No key yet.",
  addKeyFor: (provider: string) => `Add ${/^[aeiou]/i.test(provider) ? "an" : "a"} ${provider} key`,
  keysOnlyKnown: (provider: string) => `Yuzuno keeps keys for Anthropic, OpenAI and DeepSeek only; ${provider} uses OpenCode's own config.`,
  dshKeys: "DeepSeek Harness has no login of its own here: its Agents and executors run with one of these keys.",
  canUse: (tools: readonly string[]) => `${listEn(tools)} can use it`,
  opencodeProvider: "An OpenCode provider",
  opencodeOnly: "OpenCode's own login only",
  refsBy: "Referenced by",
  refsNone: "Not referenced",
  refsUnknown: "References: not all read",
  refsCount: (n: number) => (n === 1 ? "Referenced in 1 place" : `Referenced in ${n} places`),
  refsOff: (m: number) => ` · ${m} more off`,
  maybeMore: " · maybe more",
  refCandidate: (n: number, name: string) => `Routing #${n} ${name}`,
  refOff: " (off)",
  refRoutingOff: " (routing off)",
  refAgent: "New Agent default",
  refReview: (model: string) => `Review · ${model}`,
  unread: (parts: readonly string[]) => `Couldn't read ${listEn(parts)}: references may be missing.`,
  stale: (parts: readonly string[]) => `Couldn't refresh ${listEn(parts)}; showing what was read before.`,
  unmapped: (parts: readonly string[]) => `This version can't tell what ${listEn(parts)} uses; it isn't counted.`,
  partPolicy: "the routing order",
  partAgent: "the new Agent defaults",
  partReview: "the review settings",
  unmappedCandidate: (n: number) => `routing #${n}`,
  unmappedAgent: (harness: string) => `the new Agent defaults (harness ${harness})`,
  unmappedReview: (harness: string) => `the review (harness ${harness})`,
  routingOff: "Executor routing is off: its candidates aren't used now.",
  others: "Other providers:",
  othersHelp: "Not set up yet; open one to add a key or account.",
  sourcesTitle: "Where keys come from",
  sourcesHelp: "Each key chooses its source: this host's key store, where you enter it here and it is never shown again, or 1Password, where Core keeps only an op:// reference and reads the key when an executor starts. A key goes only to the one executor started with it.",
  cswapTitle: "Subscription accounts (claude-swap)",
  cswapFound: (n: number) => (n === 1 ? "1 account found" : `${n} accounts found`),
  cswapNone: "claude-swap lists no account.",
  cswapHelp: "Accounts are added and signed in with claude-swap; Yuzuno reads each account's usage and names it by its number and fingerprint, never its email.",
  account: (n: number) => `Account #${n}`,
  fingerprint: "fingerprint",
  hostLogin: "This host's login",
  command: "Command",
  commandHelp: "A name on PATH or an absolute path, without arguments.",
  change: "Change",
  save: "Save",
  cancel: "Cancel",
  reread: "Read again",
  codexTitle: "Other Codex accounts (CODEX_HOME)",
  codexHost: "Each is a CODEX_HOME folder signed in with codex login there.",
  codexNone: "No other account.",
  editHomes: "Edit accounts",
  homeId: "Id",
  homeLabel: "Label",
  homeFolder: "Folder",
  homeRow: (n: number) => `Account ${n}`,
  addHome: "Add an account",
  removeHome: (n: number) => `Remove account ${n}`,
  keyTitle: (provider: string, harness: string) => `${provider} API key (for ${harness})`,
  sourceLocal: "This host",
  source1p: "1Password",
  sourceOf: (title: string) => `Where ${title} comes from`,
  keySet: (at: string) => `Set · ${at}`,
  keyUnset: "Not set",
  reference: "1Password reference",
  checked: "The reference exists (checked just now; only the reference, the key was not read).",
  check: "Check",
  replace: "Replace",
  changeReference: "Change reference",
  remove: "Remove",
  removeKeyConfirm: (id: string) => `Remove the key ${id}? A routing candidate using it can no longer start.`,
  keyValue: (title: string) => `${title}: value`,
  keyPlaceholder: "Paste the key: it is not shown again",
  newKey: "New key",
  newKeyFor: (provider: string) => `New ${provider} API key`,
  saveKey: "Save key",
  provider: "Provider",
  keyId: "Id",
  keyIdHelp: "Lowercase letters, digits and hyphens; a routing candidate names the key by it.",
  keyIdTaken: "Another key has this id.",
  keyIdBad: "1 to 48 lowercase letters, digits or hyphens.",
  referenceBad: "A reference starts with op://",
  opTitle: "1Password service account",
  tokenSet: (at: string) => `Token set · ${at}`,
  tokenUnset: "The token is not set: keys from 1Password can't be read.",
  opVersion: (v: string) => `op ${v}`,
  opOld: (v: string) => `op ${v} is older than 2.18.0, which service accounts need`,
  opHelp: "When an executor starts, Core runs op once with this token to read its key, and hands the key to that executor only. Give the service account access to only the vault that holds these keys.",
  enterToken: "Enter token",
  replaceToken: "Replace token",
  removeToken: "Remove token",
  removeTokenConfirm: "Remove the token? Keys from 1Password can't be read until it is entered again.",
  tokenValue: "Service account token",
  tokenPlaceholder: "Paste the token: it is not shown again",
  storeTitle: "Where this host keeps keys",
  storeHelp: "In secrets/routing-keys.json in the Workspace folder, which only you can read (0600). Backups, restores and moves leave it out: enter keys again after one. It protects keys from this computer's other users, not from programs running as you, the Agents' own tools included.",
}, {
  title: "账号与密钥",
  intro: "执行者路由用来启动执行者的账号和 API key，按服务商分开：每张卡先是登录，再是 API key，并写明哪些设置引用它。key 的值填完不再显示。",
  refsScope: "「引用」只看工作区级的设置：执行者路由的候选、新 Agent 默认和审查；不含项目自己的设置，也不表示现在有执行者在用它。",
  boundary: "账号与密钥在运行 Core 的电脑上或手机上，通过 Yuzuno 的页面读取和更改。登录了允许的 Tailscale 账号的设备都能更改；Agent 的令牌不能。",
  reading: "正在读取…",
  lastRead: "下面是上次读到的。",
  logins: "登录",
  keys: "API key",
  claudeHostTitle: "Claude Code 主机登录",
  claudeHostHelp: "执行者所在机器上 Claude Code 自己登录的账号。Yuzuno 不读、不改它。",
  codexHostTitle: "Codex 主机登录（ChatGPT 订阅）",
  codexHostHelp: "执行者所在机器上 Codex 自己登录的账号，不用添加。",
  opencodeTitle: "OpenCode 自己的登录",
  opencodeHelp: "OpenCode 用它自己的配置和 Core 的环境变量连这个服务商；在 OpenCode 里管理，Yuzuno 不读。",
  opencodeDefault: "OpenCode 默认模型",
  opencodeDefaultSub: "服务商由 OpenCode 自己的配置决定",
  noLogin: (provider) => `这里没有登录要管理。路由里用 OpenCode 自己的登录连 ${provider} 的候选会列在这里。`,
  noKey: "还没有 key。",
  addKeyFor: (provider) => `添加 ${provider} 的 key`,
  keysOnlyKnown: (provider) => `Yuzuno 只保存 Anthropic、OpenAI、DeepSeek 的 key；${provider} 用 OpenCode 自己的配置。`,
  dshKeys: "DeepSeek Harness 在这里没有自己的登录：它的 Agent 和执行者用下面的某个 key 运行。",
  canUse: (tools) => `${tools.join("、")} 能用`,
  opencodeProvider: "OpenCode 的服务商",
  opencodeOnly: "只用 OpenCode 自己的登录",
  refsBy: "引用",
  refsNone: "没有引用",
  refsUnknown: "引用：读不全",
  refsCount: (n) => `${n} 处引用`,
  refsOff: (m) => ` · 另有 ${m} 处停用`,
  maybeMore: " · 可能不全",
  refCandidate: (n, name) => `路由 #${n} ${name}`,
  refOff: "（停用）",
  refRoutingOff: "（路由关着）",
  refAgent: "新 Agent 默认",
  refReview: (model) => `审查 · ${model}`,
  unread: (parts) => `读不到${parts.join("、")}：引用可能不全。`,
  stale: (parts) => `${parts.join("、")}刷新失败，用的是上次读到的。`,
  unmapped: (parts) => `这个版本认不出${parts.join("、")}用的凭据，没有算进引用。`,
  partPolicy: "路由顺序",
  partAgent: "新 Agent 默认",
  partReview: "审查设置",
  unmappedCandidate: (n) => `路由 #${n}`,
  unmappedAgent: (harness) => `新 Agent 默认（harness ${harness}）`,
  unmappedReview: (harness) => `审查（harness ${harness}）`,
  routingOff: "执行者路由关着：路由里的候选现在不会被用到。",
  others: "其他服务商：",
  othersHelp: "还没配置；点开就能添加 key 或账号。",
  sourcesTitle: "密钥从哪来",
  sourcesHelp: "每把 key 自己选来源：本机密钥库（在这里填，填完不再显示），或 1Password（Core 只记 op:// 引用，启动执行者时才取 key）。key 只交给用它启动的那一个执行者。",
  cswapTitle: "claude-swap 订阅账号",
  cswapFound: (n) => `找到 ${n} 个账号`,
  cswapNone: "claude-swap 里没有账号。",
  cswapHelp: "账号在 claude-swap 里添加和登录；Yuzuno 只读每个账号的额度，用编号和指纹称呼它，不显示邮箱。",
  account: (n) => `账号 #${n}`,
  fingerprint: "指纹",
  hostLogin: "主机当前的登录",
  command: "命令",
  commandHelp: "PATH 上的名字或绝对路径，不带参数。",
  change: "更改",
  save: "保存",
  cancel: "取消",
  reread: "重新读取",
  codexTitle: "其他 Codex 账号（CODEX_HOME）",
  codexHost: "每个账号是一个 CODEX_HOME 文件夹，在那里用 codex login 登录过。",
  codexNone: "没有其他账号。",
  editHomes: "编辑账号",
  homeId: "Id",
  homeLabel: "名称",
  homeFolder: "文件夹",
  homeRow: (n) => `账号 ${n}`,
  addHome: "添加账号",
  removeHome: (n) => `删除账号 ${n}`,
  keyTitle: (provider, harness) => `${provider} API key（${harness} 用）`,
  sourceLocal: "本机密钥库",
  source1p: "1Password",
  sourceOf: (title) => `${title} 的来源`,
  keySet: (at) => `已设置 · ${at}`,
  keyUnset: "未设置",
  reference: "1Password 引用",
  checked: "引用存在（刚检查过；只确认引用，没有取出 key）。",
  check: "检查",
  replace: "替换",
  changeReference: "改引用",
  remove: "删除",
  removeKeyConfirm: (id) => `删除 key ${id}？用它的候选就不能再启动了。`,
  keyValue: (title) => `${title}：值`,
  keyPlaceholder: "粘贴 key（填完不再显示）",
  newKey: "新的 key",
  newKeyFor: (provider) => `新的 ${provider} API key`,
  saveKey: "保存 key",
  provider: "提供方",
  keyId: "Id",
  keyIdHelp: "小写字母、数字和连字符；路由里的候选用它指名这把 key。",
  keyIdTaken: "已经有一把 key 用这个 id。",
  keyIdBad: "1 到 48 个小写字母、数字或连字符。",
  referenceBad: "引用以 op:// 开头",
  opTitle: "1Password 服务账号",
  tokenSet: (at) => `令牌已设置 · ${at}`,
  tokenUnset: "令牌没设置：取不到 1Password 里的 key。",
  opVersion: (v) => `op ${v}`,
  opOld: (v) => `op ${v} 比服务账号需要的 2.18.0 旧`,
  opHelp: "启动执行者时，Core 用这个令牌运行一次 op 取 key，只交给那一个执行者。这个服务账号只应能读放这几把 key 的 vault。",
  enterToken: "填写令牌",
  replaceToken: "替换令牌",
  removeToken: "删除令牌",
  removeTokenConfirm: "删除令牌？重新填写之前，取不到 1Password 里的 key。",
  tokenValue: "服务账号令牌",
  tokenPlaceholder: "粘贴令牌（填完不再显示）",
  storeTitle: "本机密钥库存在哪里",
  storeHelp: "存在 Workspace 文件夹里的 secrets/routing-keys.json，只有你能读（0600）。备份、恢复和迁移都不带它，之后要重新填。它挡得住这台电脑的其他用户，挡不住以你的身份运行的程序，包括 Agent 自己的工具。",
});
type Text = ReturnType<typeof text>;
/** This section's words, for its new-key form where a routing candidate opens it (YN-57 S3). */
export const keysText = text;
export type KeysText = Text;

const setAtFormat = timeFormatter({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const reasonText = (reason: Unavailable, language: Language) => (language === "zh-Hans" ? reason.messageZh : reason.message);

/** A write-only field: a password input React doesn't control, so its value
 * stays in the field's own state and is never written into the page (a
 * controlled input's value is copied to its `value` attribute). It is read
 * once, on Save, and the field is emptied once the value is kept. */
function useSecretField() {
  const ref = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  return {
    filled,
    value: () => ref.current?.value.trim() ?? "",
    clear: () => { if (ref.current) ref.current.value = ""; setFilled(false); },
    props: { ref, type: "password", autoComplete: "off", spellCheck: false, onInput: (e: FormEvent<HTMLInputElement>) => setFilled(!!e.currentTarget.value.trim()) },
  };
}

function SecretForm({ label, placeholder, t, busy, onSave, onCancel }: {
  label: string; placeholder: string; t: Text; busy: boolean; onSave: (value: string) => Promise<boolean>; onCancel: () => void;
}) {
  const field = useSecretField();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = field.value();
    if (!value || busy) return;
    if (await onSave(value)) field.clear();
  };
  return (
    <form className="routing-secret-form" onSubmit={(e) => void submit(e)}>
      <input {...field.props} className="settings-input" aria-label={label} placeholder={placeholder} disabled={busy} autoFocus />
      <button type="submit" className="primary-button" disabled={busy || !field.filled}>{busy && <LoaderCircle size={13} className="spin" />}{t.save}</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={() => { field.clear(); onCancel(); }}>{t.cancel}</button>
    </form>
  );
}

function Confirm({ message, t, busy, onConfirm, onCancel }: { message: string; t: Text; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="settings-confirm" role="group" aria-label={message}>
      <p>{message}</p>
      <span className="settings-confirm-actions">
        <button type="button" className="secondary-button routing-danger" disabled={busy} onClick={onConfirm}><Trash2 size={13} /> {t.remove}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
      </span>
    </div>
  );
}

/** A read of what references the logins and keys: null until one succeeds; a failed one keeps the last value and says why. */
type Read<T> = { value: T | null; error: string };
const unread = { value: null, error: "" };
type PolicyRefs = { enabled: boolean; candidates: Candidate[] };
type Reviewer = { harness: string; model: string };
/** Only the harness a new Agent gets in the Workspace: projects' own overrides are left out (design v3 L1). */
const harnessOfDefaults = (view: AgentDefaultsView) => {
  const harness = view?.effective?.harness?.value as unknown;
  if (typeof harness !== "string") throw new Error("Core's answer names no harness");
  return harness;
};
const reviewerOf = (view: { harness?: unknown; model?: unknown }): Reviewer => {
  if (typeof view?.harness !== "string") throw new Error("Core's answer names no harness");
  return { harness: view.harness, model: typeof view.model === "string" ? view.model : "" };
};

const cardName = (id: string, t: Text) =>
  id === "anthropic" ? "Claude" : id === "openai" ? "OpenAI / Codex" : id === "deepseek" ? "DeepSeek" : id === OPENCODE_DEFAULT ? t.opencodeDefault : id;
/** The tools a provider's key fits, as the routing editor offers it (keyFits): DeepSeek Harness while this Core starts it. */
const toolsFor = (provider: KeyProvider, dsh: boolean) => harnessesOffered(dsh).filter((h) => keyFits(h, provider)).map((h) => harnessName[h]);
function cardSub(card: Card, t: Text, dsh: boolean) {
  if (card.id === OPENCODE_DEFAULT) return t.opencodeDefaultSub;
  if (!card.known) return `${t.opencodeProvider} · ${t.opencodeOnly}`;
  const provider = card.id as KeyProvider;
  // DeepSeek is OpenCode's provider, and also DeepSeek Harness's own while this Core starts it.
  return `${provider === "deepseek" && !dsh ? t.opencodeProvider : providerName[provider]} · ${t.canUse(toolsFor(provider, dsh))}`;
}
/** The card an open edit is in: drawn while the edit is open, whatever the reads say, so a draft isn't lost. */
const editedCard = (editing: string | null) =>
  editing === "cswap" ? "anthropic" : editing === "homes" ? "openai" : editing?.startsWith("add:") ? editing.slice("add:".length) : null;
const rankOf = (use: Use) => (use.kind === "candidate" ? use.place : use.kind === "agentDefaults" ? 10_000 : 10_001);

/** Settings → Accounts & keys (YN-49 S4a, YN-84): a card per provider, its
 * logins then its API keys, each saying which Workspace settings reference
 * it; then where keys come from. On S1's routes (docs/executor-routing.md). */
export function RoutingKeys({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const dsh = dshAvailable(useDsh());
  const time = useTimeDisplay();
  const when = (at?: string) => { const ms = at ? Date.parse(at) : NaN; return Number.isFinite(ms) ? setAtFormat(time).format(ms) : ""; };
  const [keys, setKeys] = useState<KeysView | null>(null);
  const [op, setOp] = useState<OnePasswordView | null>(null);
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [readError, setReadError] = useState("");
  const [accountsError, setAccountsError] = useState("");
  const [readingAccounts, setReadingAccounts] = useState(false);
  // What references the logins and keys (YN-84 S3): each read on its own, through the routes the other pages use.
  const [policy, setPolicy] = useState<Read<PolicyRefs>>(unread);
  const [agentHarness, setAgentHarness] = useState<Read<string>>(unread);
  const [reviewer, setReviewer] = useState<Read<Reviewer>>(unread);
  // The known providers the user opened from "Other providers" since the page was last opened: only by a click.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  // One edit open at a time, by what it edits: "key:<id>:local|1password", "remove:<id>", "add:<provider>", "token", "remove-token", "cswap", "homes".
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; reason?: Unavailable }>>({});

  const loadAccounts = (signal?: AbortSignal, fresh = true) => {
    setReadingAccounts(true);
    setAccountsError("");
    readAccountsShared(fresh).then((next) => { if (!signal?.aborted) setAccounts(next); })
      .catch((e) => { if (!signal?.aborted) setAccountsError(errorText(e)); })
      .finally(() => { if (!signal?.aborted) setReadingAccounts(false); });
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setReadError("");
    setRevealed(new Set());
    readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next); }).catch((e) => { if (!signal.aborted) setReadError(errorText(e)); });
    readOnePassword(signal).then((next) => { if (!signal.aborted) setOp(next); }).catch(() => { /* the keys' read says why */ });
    loadAccounts(signal, false);
    function readOne<T>(read: Promise<T>, set: Dispatch<SetStateAction<Read<T>>>) {
      set((old) => ({ value: old.value, error: "" }));
      read.then((value) => { if (!signal.aborted) set({ value, error: "" }); })
        .catch((e) => { if (!signal.aborted) set((old) => ({ value: old.value, error: errorText(e) || "failed" })); });
    }
    const readRefs = () => readOne(readPolicy(signal).then((view) => ({ enabled: view.policy.enabled, candidates: view.policy.candidates })), setPolicy);
    readRefs();
    readOne(readAgentDefaults(signal).then(harnessOfDefaults), setAgentHarness);
    readOne(api<{ harness?: unknown; model?: unknown }>("/pr-reviews/settings", { signal }).then(reviewerOf), setReviewer);
    // A key added elsewhere (a routing candidate's own form, YN-57 S3) is listed here too, with what references it.
    const changed = () => {
      readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next); }).catch(() => { /* the next read says why */ });
      readRefs();
    };
    window.addEventListener(ROUTING_CREDENTIALS_CHANGED, changed);
    return () => { controller.abort(); window.removeEventListener(ROUTING_CREDENTIALS_CHANGED, changed); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** Runs one change; its error is shown where it was made (`at`). */
  async function act(at: string, change: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await change();
      setEditing(null);
      announceCredentialsChanged();
      return true;
    } catch (e) {
      setError({ at, text: errorText(e) });
      return false;
    } finally { setBusy(false); }
  }
  const open = (what: string | null) => { setError(null); setEditing(what); };
  const errorAt = (at: string) => error?.at === at && <p className="inline-error" role="alert">{error.text}</p>;
  const reloadKeys = async () => setKeys(await readKeys());
  // op's own read can take long (it runs op --version): a change doesn't wait for it.
  const reloadOp = () => { readOnePassword().then(setOp).catch(() => { /* the row keeps what it had */ }); };

  // The accounts' read now, apart from what the last read that succeeded found (design v3 §3.4).
  const accountsState: AccountsState = {
    current: readingAccounts || (!accounts && !accountsError) ? "reading" : accountsError ? "failed" : "read",
    ...(accounts ? { last: { cswapAccounts: accounts.cswap.accounts?.length ?? 0, codexHomes: accounts.codexHomes.map((h) => h.id) } } : {}),
  };
  const refs = usesOf({
    candidates: policy.value?.candidates ?? null, routingOn: policy.value?.enabled === true,
    agentHarness: agentHarness.value, reviewer: reviewer.value, keyIds: keys?.keys.map((k) => k.id) ?? [],
  }, nameOf);
  const edited = editedCard(editing);
  const { cards, hidden } = providerCards({
    keys: keys?.keys ?? [], accounts: accountsState, uses: refs.uses, complete: refs.complete,
    revealed: edited && !revealed.has(edited) ? new Set([...revealed, edited]) : revealed,
  });
  const routingOn = policy.value?.enabled === true;
  const usedSlot = (slot: string) => (refs.uses.get(slot)?.length ?? 0) > 0;
  const refWords = (use: Use) => (use.kind === "candidate" ? `${t.refCandidate(use.place, use.name)}${use.active ? "" : routingOn ? t.refOff : t.refRoutingOff}`
    : use.kind === "agentDefaults" ? t.refAgent : t.refReview(use.model));
  /** Which settings reference these slots: those in use, then those off, muted. Words only, never a link (D7). */
  const refList = (slots: string[]) => {
    const seen = new Set<string>();
    const list = slots.flatMap((slot) => refs.uses.get(slot) ?? []).filter((use) => {
      const id = use.kind === "candidate" ? `candidate:${use.id}` : use.kind;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!list.length) return <p className="routing-refs is-none">{refs.complete ? t.refsNone : t.refsUnknown}</p>;
    const on = list.filter((u) => u.kind !== "candidate" || u.active).sort((a, b) => rankOf(a) - rankOf(b));
    const off = list.filter((u) => u.kind === "candidate" && !u.active).sort((a, b) => rankOf(a) - rankOf(b));
    return (
      <div className="routing-refs">
        <span className="routing-refs-label">{t.refsBy}</span>
        <ul>
          {on.map((u) => <li key={u.kind === "candidate" ? u.id : u.kind}>{refWords(u)}</li>)}
          {off.map((u) => <li key={u.kind === "candidate" ? u.id : u.kind} className="is-off">{refWords(u)}</li>)}
        </ul>
      </div>
    );
  };
  /** A card's head: how many settings reference it, and whether that may be short. */
  const summary = (card: Card) => {
    const { active: n, off: m } = countRefs(cardSlots(card, accountsState), refs.uses);
    const unsure = !refs.complete || (card.id === "openai" && accountsState.current !== "read");
    return n || m ? `${t.refsCount(n)}${m ? t.refsOff(m) : ""}${unsure ? t.maybeMore : ""}` : unsure ? t.refsUnknown : t.refsNone;
  };
  const reads: [Read<unknown>, string][] = [[policy, t.partPolicy], [agentHarness, t.partAgent], [reviewer, t.partReview]];
  const unreadParts = reads.filter(([r]) => r.value === null && r.error).map(([, part]) => part);
  const staleParts = reads.filter(([r]) => r.value !== null && r.error).map(([, part]) => part);
  const unmappedParts = refs.unmapped.map((u) => (u.kind === "candidate" ? t.unmappedCandidate(u.place) : u.kind === "agentDefaults" ? t.unmappedAgent(u.harness) : t.unmappedReview(u.harness)));
  const notices = [
    unreadParts.length ? t.unread(unreadParts) : "",
    staleParts.length ? t.stale(staleParts) : "",
    unmappedParts.length ? t.unmapped(unmappedParts) : "",
    policy.value && !policy.value.enabled ? t.routingOff : "",
  ].filter(Boolean);

  // Whether the token is set, from the keys' own read (R1 42b80551): the
  // 1Password read also asks op for its version and can answer later, or not.
  const tokenSet = !!keys?.onePasswordToken.set;
  const keyRow = (key: RoutingKey) => {
    const title = t.keyTitle(providerName[key.provider], harnessOf(key.provider, dsh));
    const check = checks[key.id];
    const editingSource = editing?.startsWith(`key:${key.id}:`) ? editing.split(":")[2] as KeySource : null;
    const shownSource = editingSource ?? key.source;
    const bad = key.source === "1password" && (!tokenSet || check?.ok === false);
    const status = key.source === "local"
      ? (key.set ? t.keySet(when(key.setAt)) : t.keyUnset)
      : !tokenSet ? t.tokenUnset : check ? (check.ok ? t.checked : check.reason ? reasonText(check.reason, language) : "") : "";
    return (
      <div className="settings-row routing-key" key={key.id} data-key={key.id} role="group" aria-label={`${title} · ${key.id}`}>
        {key.source === "1password" ? <Lock size={16} className="settings-row-icon" aria-hidden="true" /> : <KeyRound size={16} className="settings-row-icon" aria-hidden="true" />}
        <div className="settings-row-main">
          <span className="settings-row-title">
            <span className="settings-tag is-mono">{key.id}</span>
            <span className="routing-seg" role="group" aria-label={t.sourceOf(title)}>
              {(["local", "1password"] as const).map((source) => (
                <button type="button" key={source} aria-pressed={shownSource === source} disabled={busy}
                  onClick={() => open(source === key.source ? null : `key:${key.id}:${source}`)}>
                  {source === "local" ? t.sourceLocal : t.source1p}
                </button>
              ))}
            </span>
          </span>
          {key.source === "1password" && key.reference && !editingSource && <code className="routing-reference">{key.reference}</code>}
          {status && !editingSource && <p className="settings-row-help">{bad && <CircleAlert size={13} className="routing-icon" aria-hidden="true" />} {status}</p>}
          {editingSource === "local" && (
            <SecretForm label={t.keyValue(title)} placeholder={t.keyPlaceholder} t={t} busy={busy} onCancel={() => open(null)}
              onSave={(value) => act(`key:${key.id}`, async () => { await putLocalKey(key.id, key.provider, value); await reloadKeys(); })} />
          )}
          {editingSource === "1password" && (
            <ReferenceForm t={t} busy={busy} initial={key.reference ?? ""} label={`${title}: ${t.reference}`} onCancel={() => open(null)}
              onSave={(reference) => act(`key:${key.id}`, async () => {
                await putReferenceKey(key.id, key.provider, reference);
                setChecks(({ [key.id]: _, ...rest }) => rest);
                await reloadKeys();
              })} />
          )}
          {editing === `remove:${key.id}` && (
            <Confirm message={t.removeKeyConfirm(key.id)} t={t} busy={busy} onCancel={() => open(null)}
              onConfirm={() => void act(`key:${key.id}`, async () => { await removeKey(key.id); await reloadKeys(); })} />
          )}
          {errorAt(`key:${key.id}`)}
          {!editingSource && refList([`key:${key.id}`])}
        </div>
        {!editingSource && editing !== `remove:${key.id}` && (
          <div className="settings-row-action">
            {key.source === "1password" && (
              <button type="button" className="secondary-button" disabled={busy || !tokenSet}
                onClick={() => void act(`key:${key.id}`, async () => { const r = await checkKey(key.id); setChecks((c) => ({ ...c, [key.id]: r })); })}>
                <ShieldCheck size={14} /> {t.check}
              </button>
            )}
            <button type="button" className="quiet-button" disabled={busy} onClick={() => open(`key:${key.id}:${key.source}`)}>
              {key.source === "local" ? t.replace : t.changeReference}
            </button>
            <button type="button" className="quiet-button" disabled={busy} onClick={() => open(`remove:${key.id}`)}>{t.remove}</button>
          </div>
        )}
      </div>
    );
  };
  /** A provider's new key: its own edit (add:<provider>) and its own form, so no draft crosses providers (D16). */
  const addRow = (provider: KeyProvider, none: boolean) => {
    const at = `add:${provider}`;
    if (editing === at && keys) {
      return (
        <div className="settings-row routing-add-key" data-provider={provider}>
          <Plus size={16} className="settings-row-icon" aria-hidden="true" />
          <div className="settings-row-main">
            <NewKeyForm key={provider} fixed={provider} t={t} busy={busy} taken={keys.keys.map((k) => k.id)} onCancel={() => open(null)}
              onSave={(id, p, source, value) => act(at, async () => {
                await (source === "local" ? putLocalKey(id, p, value) : putReferenceKey(id, p, value));
                await reloadKeys();
              })} />
            {errorAt(at)}
          </div>
        </div>
      );
    }
    const button = (
      <div className="settings-row-action">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => open(at)}><Plus size={14} /> {t.addKeyFor(providerName[provider])}</button>
      </div>
    );
    return none ? (
      <div className="settings-row routing-add-key" data-provider={provider}>
        <KeyRound size={16} className="settings-row-icon" aria-hidden="true" />
        <div className="settings-row-main"><p className="settings-row-help">{t.noKey}</p></div>
        {button}
      </div>
    ) : <div className="settings-row settings-row-end routing-add-key" data-provider={provider}>{button}</div>;
  };

  /** What an account row says of the accounts' read now: reading, or why it failed (the list below then the last read's). */
  const accountsStatus = (hasLast: boolean) => (readingAccounts ? <p className="settings-row-help" role="status">{t.reading}</p>
    : accountsError ? <><p className="inline-error">{accountsError}</p>{hasLast && <p className="settings-row-meta">{t.lastRead}</p>}</> : null);
  const rereadButton = (
    <button type="button" className="secondary-button" disabled={readingAccounts} onClick={() => loadAccounts()}>
      {readingAccounts ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} {t.reread}
    </button>
  );
  const cswap = accounts?.cswap;
  /** Claude subscription accounts, as claude-swap lists them. */
  const cswapRow = (
    <div className="settings-row routing-cswap">
      <Users size={16} className="settings-row-icon" aria-hidden="true" />
      <div className="settings-row-main">
        <span className="settings-row-title">{t.cswapTitle}</span>
        {accountsStatus(!!cswap)}
        {cswap?.unavailable ? <p className="settings-row-help"><CircleAlert size={13} className="routing-icon" aria-hidden="true" /> {reasonText(cswap.unavailable, language)}</p>
          : cswap && <p className="settings-row-help">{cswap.accounts?.length ? t.cswapFound(cswap.accounts.length) : t.cswapNone}</p>}
        {!!cswap?.accounts?.length && (
          <ul className="routing-accounts">
            {cswap.accounts.map((a) => (
              <li key={a.fingerprint}>
                <span>{t.account(a.number)}</span>
                <span className="routing-fingerprint">{t.fingerprint} <code>{shortFingerprint(a.fingerprint)}</code></span>
                {a.active && <span className="settings-tag">{t.hostLogin}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="settings-row-meta">{t.cswapHelp}</p>
        {cswap && editing !== "cswap" && <p className="settings-row-meta"><span>{t.command} <code>{cswap.command}</code></span></p>}
        {cswap && editing === "cswap" && (
          <CommandForm t={t} busy={busy} initial={cswap.command} onCancel={() => open(null)}
            onSave={(command) => act("cswap", async () => { await putCswapCommand(command); loadAccounts(); })} />
        )}
        {errorAt("cswap")}
        {refList(["cswap"])}
      </div>
      <div className="settings-row-action">
        {cswap && editing !== "cswap" && <button type="button" className="quiet-button" disabled={busy} onClick={() => open("cswap")}>{t.change}</button>}
        {rereadButton}
      </div>
    </div>
  );
  /** Codex accounts other than the host's login: a CODEX_HOME each. */
  const codexRow = (
    <div className="settings-row routing-codex">
      <Bot size={16} className="settings-row-icon" aria-hidden="true" />
      <div className="settings-row-main">
        <span className="settings-row-title">{t.codexTitle}</span>
        <p className="settings-row-help">{t.codexHost}</p>
        {accountsStatus(!!accounts)}
        {accounts && editing !== "homes" && (accounts.codexHomes.length
          ? <ul className="routing-accounts">{accounts.codexHomes.map((h) => (
            <li key={h.id}><span>{h.label}</span><code className="routing-path">{h.home}</code><span className="settings-tag is-mono">{h.id}</span>{refList([`home:${h.id}`])}</li>
          ))}</ul>
          : <p className="settings-row-meta">{t.codexNone}</p>)}
        {accounts && editing === "homes" && (
          <HomesForm t={t} busy={busy} initial={accounts.codexHomes} onCancel={() => open(null)}
            onSave={(homes) => act("homes", async () => {
              const saved = await putCodexHomes(homes);
              setAccounts((old) => (old ? { ...old, codexHomes: saved } : old));
            })} />
        )}
        {errorAt("homes")}
      </div>
      {((accounts && editing !== "homes") || (accountsError && !readingAccounts)) && (
        <div className="settings-row-action">
          {accounts && editing !== "homes" && <button type="button" className="quiet-button" disabled={busy} onClick={() => open("homes")}>{t.editHomes}</button>}
          {accountsError && !readingAccounts && rereadButton}
        </div>
      )}
    </div>
  );
  /** A tool's own login on the host an executor runs on: said, never read (L2). */
  const hostRow = (harness: "claude" | "codex") => (
    <div className="settings-row routing-host" data-host={harness}>
      <LogIn size={16} className="settings-row-icon" aria-hidden="true" />
      <div className="settings-row-main">
        <span className="settings-row-title">{harness === "claude" ? t.claudeHostTitle : t.codexHostTitle}</span>
        <p className="settings-row-help">{harness === "claude" ? t.claudeHostHelp : t.codexHostHelp}</p>
        {refList([`${harness}Host`])}
      </div>
    </div>
  );
  const opencodeRow = (provider: string) => (
    <div className="settings-row routing-opencode" data-provider={provider}>
      <Terminal size={16} className="settings-row-icon" aria-hidden="true" />
      <div className="settings-row-main">
        <span className="settings-row-title">{t.opencodeTitle}</span>
        <p className="settings-row-help">{t.opencodeHelp}</p>
        {refList([`opencode:${provider}`])}
      </div>
    </div>
  );
  /** A provider's card (layout A): its head, then its logins and its API keys, both open. */
  const card = (c: Card, index: number) => {
    const name = cardName(c.id, t);
    const head = `routing-provider-${index}`;
    const logins = c.id === "anthropic" ? <>{hostRow("claude")}{cswapRow}{usedSlot("opencode:anthropic") && opencodeRow("anthropic")}</>
      : c.id === "openai" ? <>{hostRow("codex")}{codexRow}{usedSlot("opencode:openai") && opencodeRow("openai")}</>
        : usedSlot(`opencode:${c.id}`) ? opencodeRow(c.id)
          : (
            <div className="settings-row routing-no-login">
              <LogIn size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main"><p className="settings-row-help">{t.noLogin(name)}</p></div>
            </div>
          );
    return (
      <div key={c.id} className="settings-group routing-provider" data-provider={c.id} role="group" aria-labelledby={head}>
        <div className="routing-provider-head">
          <div className="routing-provider-name">
            <h4 id={head}>{name}</h4>
            <p className="routing-provider-sub">{cardSub(c, t, dsh)}</p>
          </div>
          <p className="routing-provider-refs">{summary(c)}</p>
        </div>
        <div className="routing-layer" data-layer="logins">
          <h5 className="routing-layer-title">{t.logins}</h5>
          {logins}
        </div>
        {c.known && keys ? (
          <div className="routing-layer" data-layer="keys">
            <h5 className="routing-layer-title">{t.keys}</h5>
            {c.id === "deepseek" && dsh && <p className="settings-row-help routing-dsh-keys">{t.dshKeys}</p>}
            {c.keys.map((id) => keys.keys.find((k) => k.id === id)).filter((k): k is RoutingKey => !!k).map(keyRow)}
            {addRow(c.id as KeyProvider, c.keys.length === 0)}
          </div>
        ) : <p className="routing-provider-note">{t.keysOnlyKnown(name)}</p>}
      </div>
    );
  };

  return (
    <section className="settings-section routing-keys" aria-labelledby="routing-keys-title" lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3 id="routing-keys-title">{t.title}</h3>
          <p>{t.intro}</p>
          <p className="routing-refs-scope">{t.refsScope}</p>
        </div>
      </header>
      {readError && <div className="routing-read-error" role="alert"><p className="inline-error">{readError}</p><p className="settings-row-help">{t.boundary}</p></div>}
      {active && !keys && !readError && <p className="settings-row-help" role="status">{t.reading}</p>}
      {keys && <>
        {notices.length > 0 && (
          <div className="routing-notices" role="status">
            {notices.map((notice) => <p key={notice}><CircleAlert size={13} className="routing-icon" aria-hidden="true" /> {notice}</p>)}
          </div>
        )}
        {cards.map(card)}
        {hidden.length > 0 && (
          <div className="routing-others">
            <span className="routing-others-label">{t.others}</span>
            {hidden.map((p) => (
              <button type="button" key={p} className="secondary-button" onClick={() => setRevealed((shown) => new Set([...shown, p]))}>
                <Plus size={14} /> {cardName(p, t)}
              </button>
            ))}
            <p className="settings-row-meta">{t.othersHelp}</p>
          </div>
        )}
        <div className="routing-sources">
          <h4 className="settings-group-title">{t.sourcesTitle}</h4>
          <p className="settings-block-help">{t.sourcesHelp}</p>
          <div className="settings-group">
            {/* The 1Password service account's token, and op on this host. */}
            <div className="settings-row routing-op">
              <ShieldCheck size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                <span className="settings-row-title">{t.opTitle}</span>
                <p className="settings-row-help">
                  {keys.onePasswordToken.set ? t.tokenSet(when(keys.onePasswordToken.setAt))
                    : <><CircleAlert size={13} className="routing-icon" aria-hidden="true" /> {t.tokenUnset}</>}
                  {op && <> · {op.op.found && op.op.version ? (op.op.supported ? t.opVersion(op.op.version) : t.opOld(op.op.version))
                    : op.op.reason ? reasonText(op.op.reason, language) : ""}</>}
                </p>
                <p className="settings-row-meta">{t.opHelp}</p>
                {editing === "token" && (
                  <SecretForm label={t.tokenValue} placeholder={t.tokenPlaceholder} t={t} busy={busy} onCancel={() => open(null)}
                    onSave={(value) => act("token", async () => { await putToken(value); setChecks({}); await reloadKeys(); reloadOp(); })} />
                )}
                {editing === "remove-token" && (
                  <Confirm message={t.removeTokenConfirm} t={t} busy={busy} onCancel={() => open(null)}
                    onConfirm={() => void act("token", async () => { await removeToken(); setChecks({}); await reloadKeys(); reloadOp(); })} />
                )}
                {errorAt("token")}
              </div>
              {editing !== "token" && editing !== "remove-token" && (
                <div className="settings-row-action">
                  {keys.onePasswordToken.set ? <>
                    <button type="button" className="quiet-button" disabled={busy} onClick={() => open("token")}>{t.replaceToken}</button>
                    <button type="button" className="quiet-button" disabled={busy} onClick={() => open("remove-token")}>{t.removeToken}</button>
                  </> : <button type="button" className="secondary-button" disabled={busy} onClick={() => open("token")}><KeyRound size={14} /> {t.enterToken}</button>}
                </div>
              )}
            </div>
            <div className="settings-row routing-store">
              <HardDrive size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                <span className="settings-row-title">{t.storeTitle}</span>
                <p className="settings-row-help">{t.storeHelp}</p>
              </div>
            </div>
            {/* Who can change these: shown always, since a phone can too (YN-79). */}
            <div className="settings-row routing-boundary">
              <Smartphone size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main"><p className="settings-row-help">{t.boundary}</p></div>
            </div>
          </div>
        </div>
      </>}
    </section>
  );
}

function ReferenceForm({ t, busy, initial, label, onSave, onCancel }: {
  t: Text; busy: boolean; initial: string; label: string; onSave: (reference: string) => Promise<boolean>; onCancel: () => void;
}) {
  const [reference, setReference] = useState(initial);
  const bad = !!reference.trim() && !reference.trim().startsWith("op://");
  return (
    <form className="routing-secret-form" onSubmit={(e) => { e.preventDefault(); if (reference.trim() && !bad) void onSave(reference.trim()); }}>
      <input className="settings-input routing-reference-input" aria-label={label} placeholder="op://vault/item/field" value={reference}
        autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={bad || undefined} onChange={(e) => setReference(e.target.value)} autoFocus />
      <button type="submit" className="primary-button" disabled={busy || !reference.trim() || bad}>{busy && <LoaderCircle size={13} className="spin" />}{t.save}</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
      {bad && <span className="inline-error">{t.referenceBad}</span>}
    </form>
  );
}

function CommandForm({ t, busy, initial, onSave, onCancel }: {
  t: Text; busy: boolean; initial: string; onSave: (command: string) => Promise<boolean>; onCancel: () => void;
}) {
  const [command, setCommand] = useState(initial);
  return (
    <form className="routing-secret-form" onSubmit={(e) => { e.preventDefault(); if (command.trim()) void onSave(command.trim()); }}>
      <input className="settings-input" aria-label={t.command} value={command} autoComplete="off" spellCheck={false} disabled={busy}
        onChange={(e) => setCommand(e.target.value)} autoFocus />
      <button type="submit" className="primary-button" disabled={busy || !command.trim()}>{t.save}</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
      <span className="settings-row-meta routing-form-help">{t.commandHelp}</span>
    </form>
  );
}

let rowKeys = 0;
function HomesForm({ t, busy, initial, onSave, onCancel }: {
  t: Text; busy: boolean; initial: CodexHome[]; onSave: (homes: CodexHome[]) => Promise<boolean>; onCancel: () => void;
}) {
  const [rows, setRows] = useState(() => initial.map((h) => ({ ...h, key: `h${++rowKeys}` })));
  const change = (key: string, next: Partial<CodexHome>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...next } : r)));
  const ready = rows.every((r) => r.id.trim() && r.label.trim() && r.home.trim());
  return (
    <form className="routing-homes" onSubmit={(e) => { e.preventDefault(); if (ready) void onSave(rows.map(({ id, label, home }) => ({ id: id.trim(), label: label.trim(), home: home.trim() }))); }}>
      {rows.map((r, i) => (
        <fieldset key={r.key} className="routing-home" disabled={busy}>
          <legend className="sr-only">{t.homeRow(i + 1)}</legend>
          <input className="settings-input" aria-label={`${t.homeRow(i + 1)}: ${t.homeId}`} placeholder={t.homeId} value={r.id} spellCheck={false}
            onChange={(e) => change(r.key, { id: e.target.value })} />
          <input className="settings-input" aria-label={`${t.homeRow(i + 1)}: ${t.homeLabel}`} placeholder={t.homeLabel} value={r.label} maxLength={60}
            onChange={(e) => change(r.key, { label: e.target.value })} />
          <input className="settings-input routing-path" aria-label={`${t.homeRow(i + 1)}: ${t.homeFolder}`} placeholder="/home/you/.codex-work" value={r.home} spellCheck={false}
            onChange={(e) => change(r.key, { home: e.target.value })} />
          <button type="button" className="icon-button" aria-label={t.removeHome(i + 1)}
            onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}><X size={14} /></button>
        </fieldset>
      ))}
      <div className="routing-form-actions">
        <button type="button" className="quiet-button" disabled={busy || rows.length >= 16}
          onClick={() => setRows((list) => [...list, { id: "", label: "", home: "", key: `h${++rowKeys}` }])}><Plus size={13} /> {t.addHome}</button>
        <span className="routing-spacer" />
        <button type="submit" className="primary-button" disabled={busy || !ready}>{busy && <LoaderCircle size={13} className="spin" />}{t.save}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

/** A new key: its provider, id and source, then its write-only value or its reference. Also where a routing candidate
 * adds one (YN-57 S3): `fixed` is the provider it needs, `saveLabel` its Save's words and `note` a line above them. */
export function NewKeyForm({ t, busy, taken, fixed, saveLabel, note, onSave, onCancel }: {
  t: Text; busy: boolean; taken: string[]; fixed?: KeyProvider; saveLabel?: string; note?: ReactNode;
  onSave: (id: string, provider: KeyProvider, source: KeySource, value: string) => Promise<boolean>; onCancel: () => void;
}) {
  const [provider, setProvider] = useState<KeyProvider>(() => fixed ?? KEY_PROVIDERS.find((p) => !taken.includes(p)) ?? "deepseek");
  const [id, setId] = useState(() => freeKeyId(provider, taken));
  const [idTouched, setIdTouched] = useState(false);
  const [source, setSource] = useState<KeySource>("local");
  // A local key's value is write-only (useSecretField); a reference is not a secret.
  const secret = useSecretField();
  const [reference, setReference] = useState("");
  const idProblem = !KEY_ID.test(id) ? t.keyIdBad : taken.includes(id) ? t.keyIdTaken : "";
  const refBad = source === "1password" && !!reference.trim() && !reference.trim().startsWith("op://");
  const ready = !idProblem && (source === "local" ? secret.filled : !!reference.trim() && !refBad);
  const dsh = dshAvailable(useDsh());
  const title = fixed ? t.newKeyFor(providerName[provider]) : t.keyTitle(providerName[provider], harnessOf(provider, dsh));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = source === "local" ? secret.value() : reference.trim();
    if (!ready || busy || !value) return;
    if (await onSave(id, provider, source, value)) secret.clear();
  };
  return (
    <form className="routing-new-key" onSubmit={(e) => void submit(e)} aria-label={fixed ? title : t.newKey}>
      <span className="settings-row-title">{fixed ? title : t.newKey}</span>
      <div className="routing-new-key-grid">
        {!fixed && <label className="routing-field"><span>{t.provider}</span>
          <select className="settings-select" value={provider} disabled={busy}
            onChange={(e) => { const p = e.target.value as KeyProvider; setProvider(p); if (!idTouched) setId(freeKeyId(p, taken)); }}>
            {KEY_PROVIDERS.map((p) => <option key={p} value={p}>{t.keyTitle(providerName[p], harnessOf(p, dsh))}</option>)}
          </select>
        </label>}
        <label className="routing-field"><span>{t.keyId}</span>
          <input className="settings-input" value={id} spellCheck={false} disabled={busy} aria-invalid={!!idProblem || undefined}
            onChange={(e) => { setId(e.target.value); setIdTouched(true); }} />
          <small className={idProblem ? "inline-error" : "settings-row-meta"}>{idProblem || t.keyIdHelp}</small>
        </label>
      </div>
      <span className="routing-seg" role="group" aria-label={t.sourceOf(title)}>
        {(["local", "1password"] as const).map((s) => (
          <button type="button" key={s} aria-pressed={source === s} disabled={busy} onClick={() => { setSource(s); secret.clear(); }}>
            {s === "local" ? t.sourceLocal : t.source1p}
          </button>
        ))}
      </span>
      {source === "local"
        ? <input {...secret.props} className="settings-input" aria-label={t.keyValue(title)} placeholder={t.keyPlaceholder} disabled={busy} autoFocus={!!fixed} />
        : <input className="settings-input routing-reference-input" aria-label={`${title}: ${t.reference}`} placeholder="op://vault/item/field" value={reference}
            autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={refBad || undefined} onChange={(e) => setReference(e.target.value)} />}
      {refBad && <span className="inline-error">{t.referenceBad}</span>}
      {note && <p className="settings-row-meta routing-new-key-note">{note}</p>}
      <div className="routing-form-actions">
        <button type="submit" className="primary-button" disabled={busy || !ready}>{busy && <LoaderCircle size={13} className="spin" />}{saveLabel ?? t.save}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => { secret.clear(); onCancel(); }}>{t.cancel}</button>
      </div>
    </form>
  );
}
