import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, ClipboardCopy, Copy, House, LoaderCircle, SquareArrowOutUpRight } from "lucide-react";
import { api, errorText, requestScope } from "../api";
import { copyText } from "../clipboard";
import { Prose } from "../components";
import { strings, useStrings } from "../i18n";
import { loadFullItem, useFullItem } from "../item-payload";
import { userText } from "../message-content";
import { usePhone } from "../phone-layout";
import type { HomeReplyOrigin, NativeItem } from "../types";
import { answerText, foldSource, messagePreview, unanswered } from "./home-reply-model";
import "./home-reply.css";

export { homeReplyOf } from "./home-reply-model";

export const homeReplyText = strings({
  label: "Reply from Home",
  fromHome: "From Home",
  projectBrief: "Project Brief",
  version: (n: number) => `version ${n}`,
  earlier: "an earlier reply, shown as sent",
  copyAnswer: "Copy answer",
  copied: "Copied",
  copyFailed: "Couldn't copy",
  question: "Question",
  questionAsSeen: (version: number | null) => version === null ? "The question as you saw it" : `The question as you saw it · version ${version}`,
  yourChoice: "(your choice)",
  original: "Original message",
  copyOriginal: "Copy original",
  loadingOriginal: "Loading the whole message…",
  originalFailed: (error: string) => `The whole message couldn't be read: ${error}`,
  tryAgain: "Try again",
  openOnHome: "Open on Home",
  answersTo: (title: string) => `Answers to “${title}”`,
  notAnswered: "Not answered",
  showAll: "Show all",
  showLess: "Show less",
  otherWorkspace: "This reply was sent from another Workspace's Home. Open the Yuzuno that holds that Workspace.",
}, {
  label: "来自 Home 的回复",
  fromHome: "来自 Home",
  projectBrief: "项目 Brief",
  version: (n: number) => `第 ${n} 版`,
  earlier: "较早的回复，按发送时的原样显示",
  copyAnswer: "复制回答",
  copied: "已复制",
  copyFailed: "无法复制",
  question: "问题原文",
  questionAsSeen: (version: number | null) => version === null ? "你看到的问题" : `你看到的问题 · 第 ${version} 版`,
  yourChoice: "（你的选择）",
  original: "原始消息",
  copyOriginal: "复制原文",
  loadingOriginal: "正在读取完整消息…",
  originalFailed: (error: string) => `无法读取完整消息：${error}`,
  tryAgain: "重试",
  openOnHome: "回到 Home",
  answersTo: (title: string) => `“${title}”的回答`,
  notAnswered: "未填写",
  showAll: "展开全部",
  showLess: "收起",
  otherWorkspace: "这条回复来自另一个工作区的 Home。请打开包含该工作区的 Yuzuno。",
});

/** Where a reply's "Open on Home" goes, given by the app; none where Home can't be opened. */
export interface HomeReplyLinksApi {
  open(origin: HomeReplyOrigin, from: { agentId: string; turnId: string; itemId: string }): void;
}
export const HomeReplyLinks = createContext<HomeReplyLinksApi | null>(null);

type Copied = "ready" | "copied" | "error";
function useCopy(): [Copied, (text: string | Promise<string>) => void] {
  const [state, setState] = useState<Copied>("ready");
  useEffect(() => {
    if (state === "ready") return;
    const timer = setTimeout(() => setState("ready"), 2200);
    return () => clearTimeout(timer);
  }, [state]);
  return [state, (text) => void copyText(text).then(() => setState("copied"), () => setState("error"))];
}

/**
 * A reply the user sent from Home, drawn from the snapshot Core kept with it
 * when it was sent (T-9, hr5): the answer first; where it came from on one
 * small line; the question as the user saw it and the message exactly as
 * sent on demand. A reply from before Core kept snapshots, or with one Core
 * did not read as its own, is a small container with the message as sent.
 * Nothing here is read from the message's text, and nothing is sent: "Send
 * to Agent" above still sends that text.
 */
export function HomeReply({ origin, item, agentId, turnId }: { origin: HomeReplyOrigin; item: NativeItem; agentId: string; turnId: string }) {
  const t = useStrings(homeReplyText);
  const phone = usePhone();
  const links = useContext(HomeReplyLinks);
  const id = useId();
  const [questionOpen, setQuestionOpen] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [answerCopy, copyAnswer] = useCopy();
  const [originalCopy, copyOriginal] = useCopy();
  // The message as sent: whole once read, when the conversation has only its start.
  const sent = useSentText(agentId, turnId, item, originalOpen);
  // The answer as the user gave it, when Core kept one to show.
  const snapshot = origin.snapshot && (origin.snapshot.choice || origin.snapshot.text || origin.snapshot.form) ? origin.snapshot : null;
  const asked = snapshot?.sectionKind === "ask" && snapshot.question !== null;
  const button = (key: string, label: string, open: boolean, toggle: (open: boolean) => void, second: boolean) => (
    <button
      key={key}
      type="button"
      className={`home-reply-action${second ? " second" : ""}`}
      aria-expanded={open}
      aria-controls={`${id}-${key}`}
      onClick={() => toggle(!open)}
    >
      <ChevronRight size={15} className="chev" aria-hidden="true" />
      {label}
    </button>
  );
  const home = links && (
    <button
      key="home"
      type="button"
      className="home-reply-action home"
      onClick={() => links.open(origin, { agentId, turnId, itemId: item.id })}
    >
      {t.openOnHome}
      <SquareArrowOutUpRight size={14} aria-hidden="true" />
    </button>
  );
  const question = asked ? button("question", t.question, questionOpen, setQuestionOpen, phone) : null;
  const original = button("original", t.original, originalOpen, setOriginalOpen, phone);
  const copy = snapshot ? (
    <button
      key="copy"
      type="button"
      className={`home-reply-action${answerCopy === "copied" ? " done" : ""}`}
      onClick={() => copyAnswer(answerText(snapshot, t.notAnswered))}
    >
      {answerCopy === "copied" ? <Check size={15} aria-hidden="true" /> : <ClipboardCopy size={15} aria-hidden="true" />}
      {answerCopy === "copied" ? t.copied : answerCopy === "error" ? t.copyFailed : t.copyAnswer}
    </button>
  ) : null;
  // On a phone, in the order the rows show: Copy answer and Open on Home,
  // then Question and Original message.
  const actions = !snapshot ? [original, home] : phone ? [copy, home, question, original] : [copy, question, original, home];
  const title = snapshot?.sectionKind === null ? t.projectBrief : snapshot?.title ?? origin.key;
  return (
    <section className={`home-reply${snapshot ? "" : " earlier"}`} data-layout={phone ? "phone" : undefined} aria-label={t.label}>
      <div className="home-reply-source">
        <House size={13} aria-hidden="true" />
        <span>{t.fromHome}</span>
        <span aria-hidden="true">·</span>
        {snapshot ? (
          <>
            <span className="home-reply-title">{title}</span>
            {(snapshot.sectionKind === "report" || snapshot.sectionKind === "status") && origin.version !== null && (
              <span className="home-reply-version">{t.version(origin.version)}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>{snapshot.projectName}</span>
          </>
        ) : (
          <span className="home-reply-title">{t.earlier}</span>
        )}
      </div>
      {snapshot && (
        <div className="home-reply-answer">
          {snapshot.choice && (
            <p className="home-reply-choice">
              <Check size={16} aria-hidden="true" />
              {snapshot.choice.label}
            </p>
          )}
          {snapshot.text && <Words text={snapshot.text} />}
          {snapshot.form && (
            <>
              <p className="home-reply-form-title">{t.answersTo(snapshot.form.title)}</p>
              <dl>
                {snapshot.form.fields.map((field) => (
                  <div key={field.id}>
                    <dt>{field.label}</dt>
                    <dd data-empty={unanswered(field.answer) || undefined}>
                      {unanswered(field.answer) ? (
                        t.notAnswered
                      ) : Array.isArray(field.answer) || field.type !== "text" ? (
                        <ul>
                          {[field.answer].flat().map((label, n) => <li key={n}>{label}</li>)}
                        </ul>
                      ) : (
                        <Words text={String(field.answer)} />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      )}
      <footer>{actions}</footer>
      {asked && snapshot && questionOpen && (
        <div className="home-reply-question" id={`${id}-question`} role="region" aria-label={t.question}>
          <div className="home-reply-meta">{t.questionAsSeen(origin.version)}</div>
          <p>{snapshot.question}</p>
          {!!snapshot.options?.length && (
            <ul className="home-reply-options">
              {snapshot.options.map((option) => {
                const chosen = snapshot.choice?.id === option.id;
                return (
                  <li key={option.id} className={chosen ? "chosen" : undefined}>
                    {chosen ? <Check size={14} aria-hidden="true" /> : <span className="dot" aria-hidden="true">·</span>}
                    {option.label}
                    {chosen && <span className="sr-only"> {t.yourChoice}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {originalOpen && (
        <div className="home-reply-original" id={`${id}-original`} role="region" aria-label={t.original}>
          {sent.loading && <p role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" /> {t.loadingOriginal}</p>}
          {sent.error && (
            <p role="alert">
              {t.originalFailed(sent.error)}{" "}
              <button type="button" className="inline-link" onClick={sent.retry}>{t.tryAgain}</button>
            </p>
          )}
          {/* The message as it came, in no language of the page's. */}
          <pre tabIndex={0} lang="">{sent.text}</pre>
          <button
            type="button"
            className={`home-reply-action${originalCopy === "copied" ? " done" : ""}`}
            onClick={() => copyOriginal(sent.whole())}
          >
            {originalCopy === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {originalCopy === "copied" ? t.copied : originalCopy === "error" ? t.copyFailed : t.copyOriginal}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The message as sent, for Original message: as the conversation has it, the
 * rest read when it is opened. Core's preview of a message too large for the
 * window (YN-201) has only its start: the whole is read from its original,
 * as "View full original" reads any other preview, and kept for this
 * Workspace's Agent, Turn and Item only (`originalKey`). What it says is
 * never where the reply came from: that is Core's marking on the preview.
 */
function useSentText(agentId: string, turnId: string, item: NativeItem, open: boolean) {
  const preview = messagePreview(item);
  const full = useFullItem(agentId, turnId, item);
  const { expand, truncated, expanded } = full;
  useEffect(() => {
    if (open && !preview && truncated && !expanded) expand();
  }, [open, preview, truncated, expanded, expand]);
  const key = originalKey(agentId, turnId, item.id);
  // Until /api/workspace answers, nothing of a Workspace's is read (T-195).
  const scoped = !!requestScope();
  const [read, setRead] = useState<{ key: string; text: string | null; error: string; attempt: number }>(
    { key, text: null, error: "", attempt: 0 });
  // What was read for another Workspace, Agent, Turn or Item is not this one's.
  const mine = read.key === key ? read : { key, text: null, error: "", attempt: 0 };
  const path = `/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(item.id)}/original?${new URLSearchParams({ turnId })}`;
  // Read for `key`; settled once the window is in another Workspace, it is no one's.
  const fetchText = (signal?: AbortSignal) =>
    api<NativeItem>(path, { signal }).then((original) => (originalKey(agentId, turnId, item.id) === key ? userText(original) : null));
  useEffect(() => {
    if (!open || !preview || !scoped || mine.text !== null || mine.error) return;
    const controller = new AbortController();
    fetchText(controller.signal).then(
      (text) => { if (!controller.signal.aborted && text !== null) setRead({ key, text, error: "", attempt: mine.attempt }); },
      (e) => { if (!controller.signal.aborted) setRead({ key, text: null, error: errorText(e), attempt: mine.attempt }); },
    );
    return () => controller.abort();
    // `key` names what is read; the rest only says when to read it again.
  }, [open, preview, scoped, key, mine.text, mine.error, mine.attempt]);
  if (!preview)
    return { text: userText(full.item), loading: full.loading, error: full.error, retry: expand,
      whole: () => loadFullItem(agentId, turnId, item).then(userText) };
  return {
    text: mine.text ?? "",
    loading: open && scoped && mine.text === null && !mine.error,
    error: mine.error,
    retry: () => setRead({ key, text: null, error: "", attempt: mine.attempt + 1 }),
    // Copied whole or not at all: never the preview's start in its place.
    whole: async () => {
      const text = mine.text ?? (scoped ? await fetchText() : null);
      if (text === null || originalKey(agentId, turnId, item.id) !== key) throw new Error("The whole message isn't this Workspace's to copy.");
      return text;
    },
  };
}

/** Where a preview's original is kept and read for (YN-201): the Workspace
 * this window is in, as Core answered it (api.ts `requestScope`), then the
 * Agent, Turn and Item. One address can answer as another Workspace, where
 * the same ids name other things (T-195). */
const originalKey = (agentId: string, turnId: string, itemId: string) => [requestScope(), agentId, turnId, itemId].join("\n");

/** The user's words as Markdown (YN-201: a table is a table), folded after
 * six lines behind "Show all", never cut: folded, only their start is drawn
 * (`foldSource`), and shown all, the whole. */
function Words({ text }: { text: string }) {
  const t = useStrings(homeReplyText);
  const words = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [all, setAll] = useState(false);
  const start = useMemo(() => foldSource(text), [text]);
  const long = start.length < text.length || overflow;
  useLayoutEffect(() => {
    const element = words.current;
    if (!element || all) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [start, all]);
  return (
    <>
      <div ref={words} className={`home-reply-words${all ? "" : " clamped"}${long && !all ? " folded" : ""}`}>
        {/* Drawn anew when shown all: the rest is not words streaming in (stream-reveal). */}
        <Prose key={all ? "all" : "start"} text={all ? text : start} />
      </div>
      {long && (
        <button type="button" className="home-reply-action more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t.showLess : t.showAll}
        </button>
      )}
    </>
  );
}
