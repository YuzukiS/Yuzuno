import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Bot, CircleAlert, HardDrive, KeyRound, LoaderCircle, Lock, Plus, RefreshCw, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { errorText } from "./api";
import { langTag, strings, useLanguage, type Language } from "./i18n";
import {
  KEY_ID, KEY_PROVIDERS, checkKey, freeKeyId, putCodexHomes, putCswapCommand, putLocalKey, putReferenceKey, putToken,
  ROUTING_CREDENTIALS_CHANGED, announceCredentialsChanged, readAccountsShared, readKeys, readOnePassword, removeKey, removeToken, shortFingerprint,
  type AccountsView, type CodexHome, type KeyProvider, type KeySource, type KeysView, type OnePasswordView, type RoutingKey, type Unavailable,
} from "./routing-keys";
import { timeFormatter, useTimeDisplay } from "./time-preferences";
import "./executor-routing.css";

const providerName: Record<KeyProvider, string> = { deepseek: "DeepSeek", anthropic: "Anthropic", openai: "OpenAI" };
const harnessOf: Record<KeyProvider, string> = { deepseek: "OpenCode", anthropic: "Claude Code", openai: "Codex" };

const text = strings({
  title: "Accounts and keys",
  intro: "The accounts and API keys executor routing may start an executor with. Each key chooses its source: this host's key store, where you enter it here and it is never shown again, or 1Password, where Core keeps only an op:// reference and reads the key when an executor starts. A key goes only to the one executor started with it.",
  boundary: "Accounts and keys are read and changed from Yuzuno's page on the computer that runs Core or on the phone. Any device signed in to the allowed Tailscale login can change them; an Agent's token cannot.",
  reading: "Reading…",
  cswapTitle: "Claude subscription accounts (claude-swap)",
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
  codexTitle: "Codex accounts",
  codexHost: "This host's own login needs no entry. Each other account is a CODEX_HOME folder signed in with codex login there.",
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
  addKey: "Add a key",
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
  title: "账号和密钥",
  intro: "执行者路由可以用来启动执行者的账号和 API key。每把 key 自己选来源：本机密钥库（在这里填，填完不再显示），或 1Password（Core 只记 op:// 引用，启动执行者时才取 key）。key 只交给用它启动的那一个执行者。",
  boundary: "账号和密钥在运行 Core 的电脑上或手机上，通过 Yuzuno 的页面读取和更改。登录了允许的 Tailscale 账号的设备都能更改；Agent 的令牌不能。",
  reading: "正在读取…",
  cswapTitle: "Claude 订阅账号（claude-swap）",
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
  codexTitle: "Codex 账号",
  codexHost: "主机自己的登录不用添加。其他每个账号是一个 CODEX_HOME 文件夹，在那里用 codex login 登录过。",
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
  addKey: "添加 key",
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

/** Settings → Executor routing: the accounts and keys routing may start an
 * executor with (YN-49 S4a), on S1's routes (docs/executor-routing.md). */
export function RoutingKeys({ active }: { active: boolean }) {
  const language = useLanguage();
  const t = text(language);
  const time = useTimeDisplay();
  const when = (at?: string) => { const ms = at ? Date.parse(at) : NaN; return Number.isFinite(ms) ? setAtFormat(time).format(ms) : ""; };
  const [keys, setKeys] = useState<KeysView | null>(null);
  const [op, setOp] = useState<OnePasswordView | null>(null);
  const [accounts, setAccounts] = useState<AccountsView | null>(null);
  const [readError, setReadError] = useState("");
  const [accountsError, setAccountsError] = useState("");
  const [readingAccounts, setReadingAccounts] = useState(false);
  // One edit open at a time, by what it edits: "key:<id>:local|1password", "remove:<id>", "add", "token", "remove-token", "cswap", "homes".
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
    readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next); }).catch((e) => { if (!signal.aborted) setReadError(errorText(e)); });
    readOnePassword(signal).then((next) => { if (!signal.aborted) setOp(next); }).catch(() => { /* the keys' read says why */ });
    loadAccounts(signal, false);
    // A key added elsewhere on the page (a routing candidate's own form, YN-57 S3) is listed here too.
    const changed = () => { readKeys(signal).then((next) => { if (!signal.aborted) setKeys(next); }).catch(() => { /* the next read says why */ }); };
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

  // Whether the token is set, from the keys' own read (R1 42b80551): the
  // 1Password read also asks op for its version and can answer later, or not.
  const tokenSet = !!keys?.onePasswordToken.set;
  const keyRow = (key: RoutingKey) => {
    const title = t.keyTitle(providerName[key.provider], harnessOf[key.provider]);
    const check = checks[key.id];
    const editingSource = editing?.startsWith(`key:${key.id}:`) ? editing.split(":")[2] as KeySource : null;
    const shownSource = editingSource ?? key.source;
    const bad = key.source === "1password" && (!tokenSet || check?.ok === false);
    const status = key.source === "local"
      ? (key.set ? t.keySet(when(key.setAt)) : t.keyUnset)
      : !tokenSet ? t.tokenUnset : check ? (check.ok ? t.checked : check.reason ? reasonText(check.reason, language) : "") : "";
    return (
      <div className="settings-row routing-key" key={key.id} data-key={key.id}>
        {key.source === "1password" ? <Lock size={16} className="settings-row-icon" aria-hidden="true" /> : <KeyRound size={16} className="settings-row-icon" aria-hidden="true" />}
        <div className="settings-row-main">
          <span className="settings-row-title">
            {title}
            {key.id !== key.provider && <span className="settings-tag is-mono">{key.id}</span>}
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

  const cswap = accounts?.cswap;
  return (
    <section className="settings-section routing-keys" aria-labelledby="routing-keys-title" lang={langTag(language)}>
      <header className="settings-section-heading">
        <div>
          <h3 id="routing-keys-title">{t.title}</h3>
          <p>{t.intro}</p>
        </div>
      </header>
      {readError && <div className="routing-read-error" role="alert"><p className="inline-error">{readError}</p><p className="settings-row-help">{t.boundary}</p></div>}
      {active && !keys && !readError && <p className="settings-row-help" role="status">{t.reading}</p>}
      {keys && (
        <div className="settings-group">
          {/* Claude subscription accounts, as claude-swap lists them. */}
          <div className="settings-row routing-cswap">
            <Users size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.cswapTitle}</span>
              {readingAccounts && !cswap ? <p className="settings-row-help" role="status">{t.reading}</p>
                : accountsError ? <p className="inline-error">{accountsError}</p>
                  : cswap?.unavailable ? <p className="settings-row-help"><CircleAlert size={13} className="routing-icon" aria-hidden="true" /> {reasonText(cswap.unavailable, language)}</p>
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
            </div>
            <div className="settings-row-action">
              {cswap && editing !== "cswap" && <button type="button" className="quiet-button" disabled={busy} onClick={() => open("cswap")}>{t.change}</button>}
              <button type="button" className="secondary-button" disabled={readingAccounts} onClick={() => loadAccounts()}>
                {readingAccounts ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} {t.reread}
              </button>
            </div>
          </div>
          {/* Codex accounts: the host's login, and a CODEX_HOME per other account. */}
          <div className="settings-row routing-codex">
            <Bot size={16} className="settings-row-icon" aria-hidden="true" />
            <div className="settings-row-main">
              <span className="settings-row-title">{t.codexTitle}</span>
              <p className="settings-row-help">{t.codexHost}</p>
              {accounts && editing !== "homes" && (accounts.codexHomes.length
                ? <ul className="routing-accounts">{accounts.codexHomes.map((h) => (
                  <li key={h.id}><span>{h.label}</span><code className="routing-path">{h.home}</code><span className="settings-tag is-mono">{h.id}</span></li>
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
            {accounts && editing !== "homes" && (
              <div className="settings-row-action">
                <button type="button" className="quiet-button" disabled={busy} onClick={() => open("homes")}>{t.editHomes}</button>
              </div>
            )}
          </div>
          {keys.keys.map(keyRow)}
          {/* A new key: its provider, id and source. */}
          {editing === "add" ? (
            <div className="settings-row routing-add-key">
              <Plus size={16} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                <NewKeyForm t={t} busy={busy} taken={keys.keys.map((k) => k.id)} onCancel={() => open(null)}
                  onSave={(id, provider, source, value) => act("add", async () => {
                    await (source === "local" ? putLocalKey(id, provider, value) : putReferenceKey(id, provider, value));
                    await reloadKeys();
                  })} />
                {errorAt("add")}
              </div>
            </div>
          ) : (
            <div className="settings-row settings-row-end routing-add-key">
              <div className="settings-row-action">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => open("add")}><Plus size={14} /> {t.addKey}</button>
              </div>
            </div>
          )}
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
        </div>
      )}
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
  const title = fixed ? t.newKeyFor(providerName[provider]) : t.keyTitle(providerName[provider], harnessOf[provider]);
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
            {KEY_PROVIDERS.map((p) => <option key={p} value={p}>{t.keyTitle(providerName[p], harnessOf[p])}</option>)}
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
