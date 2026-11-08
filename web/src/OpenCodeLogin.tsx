import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api, errorText, post } from "./api";
import { strings, useLanguage } from "./i18n";

type Field = {
  key: string; title: string; description: string; required: boolean; placeholder: string; default: string | null;
  options: { value: string; label: string; description: string }[];
  when: { key: string; op: "eq" | "neq"; value: string }[];
};
type Method = { kind: "key" | "oauth" | "env" | "elsewhere"; id: string | null; label: string; fields: Field[]; names: string[] };
type Connection = { kind: "credential" | "env"; id: string | null; label: string; method: string | null; needsAuth: string | null };
type Integration = { id: string; name: string; methods: Method[]; connections: Connection[] };
type Logins = { state: "ready" | "unavailable" | "update" | "failed"; reason: string | null; version: string | null; integrations: Integration[] };
type Attempt = { attemptId: string; url: string; instructions: string; mode: "auto" | "code"; integration: string };

const text = strings({
  title: "Log in to a provider",
  note: "Each login is kept only in this Agent’s own OpenCode, never by Yuzuno, and is used from its next model call, a running turn’s included.",
  provider: "Provider",
  choose: "Choose a provider",
  logins: "Logged in",
  none: "Not logged in to any provider here.",
  logOut: "Log out",
  fromEnv: (name: string) => `From the environment variable ${name}`,
  needsAuth: (message: string) => `Needs signing in again: ${message}`,
  withKey: "Log in with an API key",
  key: "API key",
  label: "Label (optional)",
  logIn: "Log in",
  cancel: "Cancel",
  elsewhere: (label: string) => `${label}: sign in from OpenCode itself`,
  envMethod: (names: string[]) => `OpenCode also reads ${names.join(", ")} from its environment.`,
  openLink: "Open this page to sign in:",
  waiting: "Waiting for the sign-in to finish…",
  code: "Code from the sign-in page",
  complete: "Finish signing in",
  expired: "The sign-in expired before it finished.",
  failed: (message: string) => `The sign-in failed: ${message}`,
  disconnected: "Connect this Agent to log it in to a provider.",
  closed: "This Agent is closed.",
  readFailed: "OpenCode’s providers couldn’t be read.",
}, {
  title: "登录提供方",
  note: "每个登录只保存在这个 Agent 自己的 OpenCode 里，Yuzuno 不保存；从它的下一次模型调用起生效，正在运行的 Turn 也一样。",
  provider: "提供方",
  choose: "选择提供方",
  logins: "已登录",
  none: "这里还没有登录任何提供方。",
  logOut: "退出登录",
  fromEnv: (name) => `来自环境变量 ${name}`,
  needsAuth: (message) => `需要重新登录：${message}`,
  withKey: "用 API key 登录",
  key: "API key",
  label: "标签（可选）",
  logIn: "登录",
  cancel: "取消",
  elsewhere: (label) => `${label}：请在 OpenCode 里登录`,
  envMethod: (names) => `OpenCode 也会从环境变量 ${names.join("、")} 读取。`,
  openLink: "打开这个页面完成登录：",
  waiting: "正在等待登录完成…",
  code: "登录页面给出的代码",
  complete: "完成登录",
  expired: "登录在完成前已过期。",
  failed: (message) => `登录失败：${message}`,
  disconnected: "连接这个 Agent 后才能登录提供方。",
  closed: "这个 Agent 已关闭。",
  readFailed: "没有读到 OpenCode 的提供方。",
});

/** An answer as a login view: one that is not (no list of integrations) is a read that failed. */
const shaped = (read: unknown): Logins => {
  const view = read as Partial<Logins> | null;
  return view && Array.isArray(view.integrations) && typeof view.state === "string"
    ? view as Logins : { state: "failed", reason: "read_failed", version: null, integrations: [] };
};

/** A form's answers before any is given: each field's default, shown filled in and changed as any answer is (R2 5ca76575 of #621). */
const defaults = (method?: Method): Record<string, string> =>
  Object.fromEntries((method?.fields || []).flatMap((f): [string, string][] => f.default ? [[f.key, f.default]] : []));

/** Whether a form field is asked now: each of its conditions holds for the answers so far; an unanswered one never does. */
const active = (field: Field, answers: Record<string, string>) =>
  field.when.every((w) => answers[w.key] !== undefined && answers[w.key] !== "" && (answers[w.key] === w.value) === (w.op === "eq"));

/**
 * An OpenCode Agent's logins (T-32 slice 4b), through its own OpenCode. A
 * key or a form's answers go to Core once, in the request's body, and are
 * kept nowhere here: the fields are cleared after each request, and nothing
 * is stored or put in a link. Every button is `type="button"`: the section
 * sits in the settings form, whose submit saves the model. `onChanged` is
 * told after each login or logout OpenCode took: its providers, and so the
 * models it lists, may have changed (YN-47).
 */
export function OpenCodeLogin({ agentId, disabled, onChanged }: { agentId: string; disabled?: boolean; onChanged?: () => void }) {
  const t = text(useLanguage());
  const base = `/agents/${encodeURIComponent(agentId)}/opencode/login`;
  const [logins, setLogins] = useState<Logins | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState("");
  const [method, setMethod] = useState(-1);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [code, setCode] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // The latest callback, for a sign-in that finishes after a render.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const tell = () => { if (live.current) changed.current?.(); };
  const load = async () => {
    try { const read = shaped(await api<unknown>(base)); if (live.current) setLogins(read); } catch (e) { if (live.current) setError(errorText(e)); }
  };
  useEffect(() => { void load(); }, [base]);
  // An automatic sign-in finishes at the provider: asked about until it ends.
  useEffect(() => {
    if (!attempt || attempt.mode !== "auto") return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await api<{ status: string; message?: string }>(`${base}/oauth/${encodeURIComponent(attempt.integration)}/${encodeURIComponent(attempt.attemptId)}`);
        if (stopped) return;
        if (status.status === "complete") { setAttempt(null); await load(); tell(); }
        else if (status.status === "failed") { setAttempt(null); setError(t.failed(status.message || "")); }
        else if (status.status === "expired") { setAttempt(null); setError(t.expired); }
      } catch (e) { if (!stopped) { setAttempt(null); setError(errorText(e)); } }
    }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [attempt]);

  const integration = logins?.integrations.find((i) => i.id === chosen);
  const form = integration?.methods[method];
  // The key, label and code go; a form's answers go back to its defaults.
  const clear = (next?: Method) => { setKey(""); setLabel(""); setAnswers(defaults(next)); setCode(""); };
  const answer = () => {
    const out: Record<string, string> = {};
    for (const field of form?.fields || []) if (active(field, answers) && answers[field.key]) out[field.key] = answers[field.key];
    return Object.keys(out).length ? out : undefined;
  };
  async function act(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await run(); } catch (e) { setError(errorText(e)); } finally { clear(form); setBusy(false); }
  }
  const logIn = () => act(async () => {
    if (!integration || !form) return;
    if (form.kind === "key") {
      setLogins(shaped(await post<unknown>(`${base}/key`, { integration: integration.id, key, label: label || undefined, answer: answer() })));
      setMethod(-1);
      tell();
    } else if (form.kind === "oauth" && form.id) {
      const started = await post<Omit<Attempt, "integration">>(`${base}/oauth`, { integration: integration.id, method: form.id, answer: answer() });
      setAttempt({ ...started, integration: integration.id });
      setMethod(-1);
    }
  });
  const complete = () => act(async () => {
    if (!attempt) return;
    await post(`${base}/oauth/${encodeURIComponent(attempt.integration)}/${encodeURIComponent(attempt.attemptId)}/complete`, { code });
    setAttempt(null); await load(); tell();
  });
  const cancel = () => act(async () => {
    if (!attempt) return;
    const was = attempt; setAttempt(null);
    await api(`${base}/oauth/${encodeURIComponent(was.integration)}/${encodeURIComponent(was.attemptId)}`, { method: "DELETE" });
  });
  const logOut = (credential: string) => act(async () => {
    setLogins(shaped(await api<unknown>(`${base}/credential/${encodeURIComponent(credential)}`, { method: "DELETE" })));
    tell();
  });

  const off = disabled || busy;
  const held = (logins?.integrations || []).flatMap((i) => i.connections.map((c) => ({ integration: i, connection: c })));
  const ready = logins?.state === "ready";
  const required = form?.fields.filter((f) => active(f, answers) && f.required).every((f) => !!answers[f.key]) ?? false;
  return <div className="agent-setting opencode-login">
    <span className="section-eyebrow">{t.title}</span>
    {logins && !ready && <p className="field-hint" role="status">{
      logins.state === "update" ? logins.reason
        : logins.reason === "closed" ? t.closed : logins.reason === "disconnected" || logins.reason === "changed" ? t.disconnected : t.readFailed}</p>}
    {ready && <>
      <div className="opencode-logins">
        <strong>{t.logins}</strong>
        {held.length ? <ul>{held.map(({ integration: i, connection: c }) => <li key={`${i.id}:${c.id || c.label}`}>
          <span lang="">{i.name}</span> · {c.kind === "env" ? t.fromEnv(c.label) : <span lang="">{c.label}</span>}
          {c.needsAuth && <small className="inline-error"> {t.needsAuth(c.needsAuth)}</small>}
          {c.kind === "credential" && c.id && <button type="button" className="quiet-button" disabled={off} onClick={() => void logOut(c.id!)}>{t.logOut}</button>}
        </li>)}</ul> : <p className="field-hint">{t.none}</p>}
      </div>
      <label className="opencode-login-provider">{t.provider}
        <select value={chosen} disabled={off || !!attempt} onChange={(e) => { setChosen(e.target.value); setMethod(-1); clear(); }}>
          <option value="">{t.choose}</option>
          {[...logins!.integrations].sort((a, b) => a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id} lang="">{i.name}</option>)}
        </select>
      </label>
      {integration && !attempt && <div className="opencode-login-methods">
        {integration.methods.map((m, index) => m.kind === "key" || m.kind === "oauth"
          ? <button type="button" key={index} className={method === index ? "secondary-button active" : "secondary-button"} disabled={off}
              onClick={() => { setMethod(method === index ? -1 : index); clear(method === index ? undefined : m); }}>{m.kind === "key" ? t.withKey : <span lang="">{m.label}</span>}</button>
          : <small key={index} className="field-hint">{m.kind === "env" ? t.envMethod(m.names) : t.elsewhere(m.label)}</small>)}
      </div>}
      {form && !attempt && <div className="opencode-login-form">
        {form.fields.filter((f) => active(f, answers)).map((f) => <label key={f.key}><span lang="">{f.title || f.key}</span>
          {f.options.length
            ? <select value={answers[f.key] ?? ""} disabled={off} onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}>
                <option value="" />
                {f.options.map((o) => <option key={o.value} value={o.value} lang="">{o.label}</option>)}
              </select>
            : <input value={answers[f.key] ?? ""} placeholder={f.placeholder} disabled={off}
                onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))} />}
          {f.description && <small lang="">{f.description}</small>}
        </label>)}
        {form.kind === "key" && <>
          <label>{t.key}<input type="password" autoComplete="off" value={key} disabled={off} onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void logIn(); } }} /></label>
          <label>{t.label}<input value={label} autoComplete="off" disabled={off} onChange={(e) => setLabel(e.target.value)} /></label>
        </>}
        <div className="opencode-login-actions">
          <button type="button" className="primary-button" disabled={off || !required || (form.kind === "key" && !key.trim())} onClick={() => void logIn()}>
            {busy && <LoaderCircle size={14} className="spin" />}{t.logIn}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMethod(-1); clear(); }}>{t.cancel}</button>
        </div>
      </div>}
      {attempt && <div className="opencode-login-attempt" role="status">
        <p>{t.openLink} <a href={attempt.url} target="_blank" rel="noreferrer">{attempt.url}</a></p>
        {attempt.instructions && <p lang="">{attempt.instructions}</p>}
        {attempt.mode === "code"
          ? <label>{t.code}<input value={code} autoComplete="off" disabled={off} onChange={(e) => setCode(e.target.value)} /></label>
          : <small className="field-hint">{t.waiting}</small>}
        <div className="opencode-login-actions">
          {attempt.mode === "code" && <button type="button" className="primary-button" disabled={off || !code.trim()} onClick={() => void complete()}>{t.complete}</button>}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void cancel()}>{t.cancel}</button>
        </div>
      </div>}
      <small>{t.note}</small>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div>;
}
