import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Folder, GitFork, LoaderCircle } from "lucide-react";
import { api, errorText, post } from "./api";
import { Modal } from "./components";
import { Tip, TipText } from "./Tip";
import { strings, useLanguage } from "./i18n";
import type { Agent, NativeTurn } from "./types";
import "./session-import.css";
import "./codex-fork.css";
import { randomId } from "./random-id";

/** What a fork through a Turn would keep (`/opencode/fork/preview`, T-10 Fork). */
export interface OpenCodeForkPreview {
  turnId: string;
  keptTurns: number;
  laterTurns: number;
  messages: number;
  cwd: string;
  name: string;
  model: string;
  variant: string | null;
}

/** An attempt as Core holds it: `pending` is one that can go on with the same request, never forked again. */
export interface OpenCodeForkOutcome {
  state: "completed" | "uncertain" | "failed" | "pending" | "none";
  requestId?: string;
  agent?: Agent;
  connected?: boolean;
  message?: string;
  warnings?: string[];
}

// One request ID per Workspace, source Agent and Turn, kept across reloads
// until its attempt has an outcome: a page that asks again, after a lost
// answer or a reload, goes on with that same attempt, and OpenCode is never
// asked a second time for it. Core also finds the live attempt for a Turn
// when a page has lost its request ID.
const storageKey = "yuzuno.opencodeForkRequests";
const requestKey = (workspace: string, agent: string, turn: string) => JSON.stringify([workspace, agent, turn]);
function requests(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function keep(key: string, requestId: string | undefined) {
  const saved = requests();
  if (requestId) saved[key] = requestId;
  else delete saved[key];
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved));
  } catch {
    /* The attempt is still Core's; it finds it again by its Turn. */
  }
}

/** The longest name Core takes for the new agent, in UTF-8 bytes, as it counts them. */
const NAME_BYTES = 100;
const nameBytes = (value: string) => new TextEncoder().encode(value.trim()).length;

const text = strings({
  fork: "Fork",
  forkTitle: "Fork a new agent from here",
  busyTitle: "Finish the active turn and pending answers before forking",
  title: "Fork from this turn",
  description: "Creates a new OpenCode agent holding this conversation through this turn. Nothing happens until you confirm.",
  reading: "Reading this conversation…",
  preview: "Fork preview",
  kept: (turns: number) => `Keeps ${turns} ${turns === 1 ? "turn" : "turns"}, through this one`,
  later: (turns: number) => `${turns} later ${turns === 1 ? "turn stays" : "turns stay"} only here`,
  model: (model: string, variant: string | null) => `${model || "OpenCode’s default model"}${variant ? ` · ${variant}` : ""}`,
  name: "New agent name",
  nameTooLong: `The name is too long: at most ${NAME_BYTES} bytes, about 33 Chinese characters.`,
  note: "The new agent works in this same folder with its own OpenCode session; this agent and its session are not changed and stay open. Files are not restored: the new agent sees the folder as it is now. Your draft and any running sub-agents are not copied, and nothing is sent.",
  login: "No login is copied: unless its provider key comes from OpenCode’s config or environment, sign the new agent in before its first message.",
  rewind: "Turns copied into the new agent can’t be rewound there; its own turns can.",
  uncertain: "The new agent’s OpenCode has not confirmed it holds this fork yet. Continuing checks what it holds first and never writes it twice; this agent can go on meanwhile. ",
  pending: "This fork is not finished yet. ",
  failed: "The fork didn’t complete. ",
  completed: (name: string) => `Forked as ${name}.`,
  cancel: "Cancel",
  close: "Close",
  forking: "Forking…",
  confirm: "Fork",
  carryOn: "Continue this fork",
  open: "Open",
}, {
  fork: "分叉",
  forkTitle: "从这里分叉出一个新 Agent",
  busyTitle: "请先结束进行中的 Turn 和待回答的请求，再分叉",
  title: "从这个 Turn 分叉",
  description: "创建一个新的 OpenCode Agent，带着截至这个 Turn 的对话。确认之前不会发生任何事。",
  reading: "正在读取这段对话…",
  preview: "分叉预览",
  kept: (turns) => `保留 ${turns} 个 Turn，截至这一个`,
  later: (turns) => `之后的 ${turns} 个 Turn 只留在这里`,
  model: (model, variant) => `${model || "OpenCode 的默认模型"}${variant ? ` · ${variant}` : ""}`,
  name: "新 Agent 名称",
  nameTooLong: `名称太长：最多 ${NAME_BYTES} 字节，约 33 个汉字。`,
  note: "新 Agent 在同一个文件夹工作，有自己的 OpenCode 会话；这个 Agent 和它的会话不会改变，也保持打开。文件不会被还原：新 Agent 看到的是文件夹现在的样子。草稿和运行中的子 Agent 不会复制，也不会发送任何内容。",
  login: "不会复制登录：除非服务商的密钥来自 OpenCode 的配置或环境变量，请在新 Agent 发第一条消息前为它登录。",
  rewind: "复制到新 Agent 的 Turn 在那里不能回退；它自己的 Turn 可以。",
  uncertain: "新 Agent 的 OpenCode 还没有确认收下这次分叉。继续会先核对它已有的内容，不会写第二次；这个 Agent 可以照常继续。",
  pending: "这次分叉还没有完成。",
  failed: "分叉没有完成。",
  completed: (name) => `已分叉为 ${name}。`,
  cancel: "取消",
  close: "关闭",
  forking: "正在分叉…",
  confirm: "分叉",
  carryOn: "继续这次分叉",
  open: "打开",
});

const Host = createContext<((turnId: string) => void) | null>(null);

/**
 * OpenCode's fork for one Agent (T-10 Fork), held by the Agent rather than by
 * the turn it starts from, which may scroll out of view: its dialog stays
 * while a request is out. Gone with its Workspace or Agent, as is anything
 * an answer that ends afterwards would open.
 */
export function OpenCodeForkHost({ workspaceId, agent, onForked, children }: {
  workspaceId: string;
  agent?: Agent;
  onForked: (outcome: OpenCodeForkOutcome) => void;
  children: ReactNode;
}) {
  const [turnId, setTurnId] = useState<string>();
  const id = agent?.harness === "opencode" && workspaceId && !agent.closedAt ? agent.id : undefined;
  useEffect(() => setTurnId(undefined), [workspaceId, id]);
  return <Host.Provider value={id ? setTurnId : null}>
    {children}
    {id && agent && turnId && <OpenCodeForkDialog key={requestKey(workspaceId, id, turnId)} workspaceId={workspaceId} agent={agent}
      turnId={turnId} onForked={onForked} onClose={() => setTurnId(undefined)} />}
  </Host.Provider>;
}

/** "Fork" on a completed OpenCode turn, beside Rewind. */
export function OpenCodeForkButton({ agent, turn }: { agent: Agent; turn: NativeTurn }) {
  const open = useContext(Host);
  const t = text(useLanguage());
  if (!open || agent.harness !== "opencode" || turn.status !== "completed") return null;
  const blocked = ["working", "waiting"].includes(agent.status);
  // Busy, it says why it waits (a disabled button still shows a tip).
  return <Tip content={blocked ? <TipText body={t.busyTitle} /> : <TipText title={t.forkTitle} />} hold>
    <button type="button" className="quiet-button fork-open" disabled={blocked} aria-description={blocked ? t.busyTitle : undefined}
      onClick={() => open(turn.id)}><GitFork size={12} />{t.fork}</button>
  </Tip>;
}

function OpenCodeForkDialog({ workspaceId, agent, turnId, onForked, onClose }: {
  workspaceId: string;
  agent: Agent;
  turnId: string;
  onForked: (outcome: OpenCodeForkOutcome) => void;
  onClose: () => void;
}) {
  const t = text(useLanguage());
  const key = requestKey(workspaceId, agent.id, turnId);
  const base = `/agents/${encodeURIComponent(agent.id)}/opencode/fork`;
  const [preview, setPreview] = useState<OpenCodeForkPreview>();
  const [outcome, setOutcome] = useState<OpenCodeForkOutcome>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const running = useRef(false);
  // An answer after this dialog went (its Workspace or Agent left) opens nothing.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);

  async function look() {
    const saved = requests()[key];
    const seen = await api<OpenCodeForkOutcome>(`${base}?${saved ? `requestId=${encodeURIComponent(saved)}` : `turnId=${encodeURIComponent(turnId)}`}`);
    if (seen.state === "none" || seen.state === "failed") keep(key, undefined);
    else if (seen.requestId) keep(key, seen.requestId);
    return seen;
  }

  // One asked already for this turn is read again, never asked anew.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const seen = await look();
        if (!live) return;
        if (seen.state !== "none") setOutcome(seen);
        if (seen.state === "none" || seen.state === "failed") {
          const value = await post<OpenCodeForkPreview>(`${base}/preview`, { turnId });
          if (live) { setPreview(value); setName(value.name); }
        }
      } catch (e) {
        if (live) setError(errorText(e));
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key, turnId]);

  function settled(value: OpenCodeForkOutcome) {
    if (value.state === "completed" || value.state === "failed") keep(key, undefined);
    if (!shown.current) return;
    if (value.state === "completed" && value.agent) {
      onForked(value);
      onClose();
    } else setOutcome(value);
  }

  // The one request: its ID kept before it is sent, and kept until Core says how it ended.
  async function fork() {
    // One not finished, or whose copy the new OpenCode has not confirmed, goes on with the same request (D-33).
    const going = outcome?.state === "pending" || outcome?.state === "uncertain";
    if (running.current || (!going && (!name.trim() || nameBytes(name) > NAME_BYTES))) return;
    running.current = true; setBusy(true); setError("");
    const requestId = requests()[key] || outcome?.requestId || randomId();
    keep(key, requestId);
    try {
      // One going on keeps the name it was asked with; Core reads it from the attempt.
      settled(await post<OpenCodeForkOutcome>(base, { requestId, turnId, name: name.trim() || agent.name }));
    } catch (e) {
      // Core answers every refusal the same way, so it is asked what it holds of this request (R2 of #535).
      const seen = await look().catch(() => undefined);
      if (seen?.state === "completed") { settled(seen); return; }
      if (!shown.current) return;
      setError(errorText(e));
      if (seen?.state === "none" || seen?.state === "failed") {
        // Refused before anything was kept, or it ended: the preview and its name stay, to change and fork again.
        setOutcome(seen.state === "failed" ? seen : undefined);
        if (!preview) {
          // Read again as when the dialog opens, its suggested name with it unless one was typed (R1 57ed7974 of #564).
          try {
            const value = await post<OpenCodeForkPreview>(`${base}/preview`, { turnId });
            if (shown.current) { setPreview(value); setName((typed) => typed.trim() ? typed : value.name); }
          } catch (again) { if (shown.current) setError(errorText(again)); }
        }
      } else {
        // It may have reached Core: the same request goes on next time, never a new one.
        setOutcome(seen ?? { state: "pending", requestId, message: "" });
        setPreview(undefined);
      }
    } finally { running.current = false; if (shown.current) setBusy(false); }
  }

  const state = outcome?.state;
  const asking = state === "pending" || state === "uncertain";
  const tooLong = nameBytes(name) > NAME_BYTES;
  return <Modal open confirm onOpenChange={next => !next && !busy && onClose()} title={t.title} description={t.description}>
    <form className="session-import create-form codex-fork-dialog opencode-fork-dialog" onSubmit={event => {
      event.preventDefault();
      void fork();
    }}>
      {busy && !preview && !outcome && <p role="status" className="remote-field-note"><LoaderCircle size={14} className="spin" /> {t.reading}</p>}
      {preview && !asking && <>
        <section className="session-preview" aria-label={t.preview}>
          <div className="session-preview-heading">
            <span><GitFork size={14} /> {t.kept(preview.keptTurns)}</span>
            {preview.laterTurns > 0 && <span>{t.later(preview.laterTurns)}</span>}
          </div>
          <div className="session-preview-folder"><Folder size={14} /><span>{preview.cwd}</span></div>
          <p className="session-preview-model">{t.model(preview.model, preview.variant)}</p>
        </section>
        <fieldset className="remote-form-fields" disabled={busy}>
          <label>{t.name}<input value={name} onChange={event => setName(event.target.value)} required aria-invalid={tooLong} autoFocus /></label>
        </fieldset>
        {tooLong && <p role="alert" className="remote-field-error">{t.nameTooLong}</p>}
        <p className="session-handoff-note">{t.note}</p>
        <p className="session-handoff-note">{t.login} {t.rewind}</p>
      </>}
      {outcome && state !== "none" && state !== "completed" && <p role="alert" className="remote-field-error">
        {state === "uncertain" ? t.uncertain : state === "pending" ? t.pending : t.failed}{outcome.message}
      </p>}
      {state === "completed" && outcome?.agent && <p role="status" className="remote-field-note">{t.completed(outcome.agent.name)}</p>}
      {error && <p role="alert" className="remote-field-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{asking || state === "completed" ? t.close : t.cancel}</button>
        {state === "completed" && outcome?.agent ? (
          <button type="button" className="primary-button" onClick={() => { onForked(outcome); onClose(); }}><ArrowUpRight size={15} />{t.open}</button>
        ) : asking ? (
          <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <GitFork size={15} />}{busy ? t.forking : t.carryOn}</button>
        ) : (
          <button className="primary-button" disabled={busy || !preview || !name.trim() || tooLong}>{busy && preview ? <LoaderCircle size={15} className="spin" /> : <GitFork size={15} />}{busy && preview ? t.forking : t.confirm}</button>
        )}
      </div>
    </form>
  </Modal>;
}
