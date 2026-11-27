import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { strings, useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { absolute, relative } from "./format";
import { useReportOpen } from "./report/report-open";
import type { BlockFollowUp, FollowUpItem, LookResult, RequestBlock, StaleFact } from "./request-blocks";
import { progressText } from "./RequestProgress";

/**
 * A request's first look (YN-237 ②, the approved design's "收起时也看得到四件事"), in English and Simplified Chinese:
 * what goes on now and since when, what needs the user, its newest result, and its newest follow-up with what came of
 * it, each one line with one step to the whole of it. The words are Core's facts or the author's own first sentence;
 * "Replied" and "Delivered" are said apart, as the user asked: a reply is not the work done.
 */
export const lookText = strings(
  {
    now: "Now",
    asOf: (time: string) => `as of ${time}`,
    expired: "past its validity",
    later: (facts: string) => `since then ${facts}`,
    openStatus: (title: string) => `Open the status “${title}”`,
    needs: "Needs you",
    more: (n: number) => ` (+${n} more)`,
    elsewhere: (n: number) => `under R-${n}`,
    decide: "Decide",
    decideLabel: (title: string) => `Decide: ${title}`,
    result: "Result",
    whole: "Full text",
    wholeLabel: (title: string) => `Open the full text of “${title}”`,
    follow: (m: number) => `Follow-up #${m}`,
    state: { answered: "Replied", later: "Later note", waiting: "Waiting for the project's reply", unsent: "Not confirmed delivered" } as Record<
      FollowUpItem["state"], string>,
    failed: "Not delivered",
    talk: "Conversation",
    talkLabel: (m: number) => `Show follow-up #${m} in the conversation`,
    undelivered: "Work still going on, not delivered",
    related: "Related",
    openedFrom: (n: number) => `Opened from a proposal in R-${n}`,
    openedHere: (n: number) => `R-${n}, opened from a proposal here`,
    showRequest: (n: number) => `Show R-${n}`,
  },
  {
    now: "现在",
    asOf: (time) => `截至 ${time}`,
    expired: "已过有效期",
    later: (facts) => `之后${facts}`,
    openStatus: (title) => `打开状态「${title}」`,
    needs: "需要你",
    more: (n) => `（另 ${n} 项）`,
    elsewhere: (n) => `在 R-${n} 下`,
    decide: "去决定",
    decideLabel: (title) => `去决定：${title}`,
    result: "结果",
    whole: "全文",
    wholeLabel: (title) => `打开「${title}」全文`,
    follow: (m) => `追问 #${m}`,
    state: { answered: "已回复", later: "后续留言", waiting: "等项目回复", unsent: "没确认送达" },
    failed: "送达失败",
    talk: "对话",
    talkLabel: (m) => `在对话中查看追问 #${m}`,
    undelivered: "工作仍在进行，未交付",
    related: "相关",
    openedFrom: (n) => `从 R-${n} 的提议拆出`,
    openedHere: (n) => `R-${n} 从这里的提议拆出`,
    showRequest: (n) => `查看 R-${n}`,
  },
);

/** A time as the first look says it: how long ago, the exact time in its tip. */
function Ago({ at }: { at: string | null | undefined }) {
  const language = useLanguage();
  const time = useTimeDisplay();
  if (!at) return null;
  return (
    <Tip content={<TipText title={absolute(at, time)} />} describe={false}>
      <time dateTime={at}>{relative(at, language)}</time>
    </Tip>
  );
}

/** The later facts after the now line, as the summary's stale line says them (R-38 §2.5). */
function laterText(facts: readonly StaleFact[], p: ReturnType<typeof progressText>) {
  return facts.map((fact) => {
    switch (fact.kind) {
      case "merged":
        return p.fact.merged(fact.prs);
      case "result":
        return p.fact.result(fact.task);
      case "ended":
        return p.fact.ended(fact.task);
      case "followUp":
        return p.fact.followUp(fact.count);
    }
  }).join(p.factJoin);
}

/** One line of the first look: its label, what it says, and its one step. */
function Line({ kind, label, children, meta, action, dim }: {
  kind: string; label: ReactNode; children: ReactNode; meta?: ReactNode; action?: ReactNode; dim?: boolean;
}) {
  return (
    <div className="request-look-line" data-look={kind} data-dim={dim ? "" : undefined}>
      <span className="request-look-label">{label}</span>
      <span className="request-look-text">
        <span className="request-look-said">{children}</span>
        {meta && <span className="request-look-meta">{meta}</span>}
      </span>
      {action}
    </div>
  );
}

/** A line's one step: a quiet link with its arrow, named for what it opens. */
function Step({ label, aria, onClick, data }: { label: string; aria: string; onClick: (from: HTMLElement) => void; data: string }) {
  return (
    <button type="button" className="request-look-step" data-step={data} aria-label={aria} onClick={(event) => onClick(event.currentTarget)}>
      {label}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  );
}

/**
 * The four lines (YN-237 ②). `fact`: the block's own fact line, said as its now when no status or progress of its
 * tasks says it (FactLines), or null where another line says the same (an Ask, a result). `onDecide` lands on the open
 * Ask, opening the block; `onElsewhere` shows the block of the request a joined task's Ask is under; `onThread` opens
 * its conversation at the follow-up; `onResult` opens a result that is no report Home has (its deliverable's own way).
 */
export function LookLines({ block, projectId, fact, onDecide, onElsewhere, onThread, onResult, onShowBlock, onResend, resending = false, readOnly = false }: {
  block: RequestBlock;
  projectId: string;
  fact: ReactNode | null;
  onDecide: (key: string) => void;
  /** Shows another request's block: one this was opened from, or one opened from it (YN-237 ④). */
  onShowBlock: (n: number) => void;
  onElsewhere: (home: number, key: string) => void;
  onThread: (m: number, marked: string[]) => void;
  onResult: (result: LookResult, from: HTMLElement) => void;
  onResend?: (m: number) => void;
  resending?: boolean;
  readOnly?: boolean;
}) {
  const language = useLanguage();
  const t = lookText(language);
  const p = progressText(language);
  const openReport = useReportOpen();
  const { now, later, ask, result } = block.look;
  const follow = block.follow;
  return (
    <div className="request-look">
      {now.kind !== "fact" ? (
        <Line
          kind="now"
          label={t.now}
          dim={now.kind === "status" && now.stale || later.length > 0}
          meta={
            <>
              {now.at && <>{t.asOf("")}<Ago at={now.at} /></>}
              {now.kind === "status" && now.stale && <> · <span className="request-block-stale">{t.expired}</span></>}
              {later.length > 0 && <> · <span className="request-look-later">{t.later(laterText(later, p))}</span></>}
            </>
          }
          action={now.kind === "status" && openReport ? (
            <Step label={t.whole} aria={t.openStatus(now.section.title)} data="status" onClick={(from) => openReport(projectId, now.section, from)} />
          ) : undefined}
        >
          {now.text}
        </Line>
      ) : fact ? (
        <div className="request-look-line" data-look="fact">
          <span className="request-look-label">{t.now}</span>
          <span className="request-look-text">{fact}</span>
        </div>
      ) : null}
      {ask && (
        <Line
          kind="ask"
          label={t.needs}
          meta={ask.home !== null ? t.elsewhere(ask.home) : undefined}
          action={<Step label={t.decide} aria={t.decideLabel(ask.title)} data="decide"
            onClick={() => (ask.home === null ? onDecide(ask.key) : onElsewhere(ask.home, ask.key))} />}
        >
          {ask.title}
          {ask.count > 1 ? t.more(ask.count - 1) : ""}
        </Line>
      )}
      {result && (
        <Line
          kind="result"
          label={t.result}
          meta={<Ago at={result.at} />}
          action={
            result.section && openReport ? (
              <Step label={t.whole} aria={t.wholeLabel(result.title)} data="report" onClick={(from) => openReport(projectId, result.section!, from)} />
            ) : result.item && result.item.kind !== "answer" ? (
              <Step label={t.whole} aria={t.wholeLabel(result.title)} data="deliverable" onClick={(from) => onResult(result, from)} />
            ) : undefined
          }
        >
          {result.text}
        </Line>
      )}
      {follow && <FollowLine follow={follow} block={block} onThread={onThread} onResend={onResend} resending={resending} readOnly={readOnly} />}
      <RelatedLine block={block} onShowBlock={onShowBlock} />
    </div>
  );
}

/**
 * The requests a proposal links this one to (YN-237 ④, the design's "相关"): the one it was opened from, and those
 * opened from proposals made here, each one step to its block. Nothing for a request with neither.
 */
export function RelatedLine({ block, onShowBlock }: { block: RequestBlock; onShowBlock: (n: number) => void }) {
  const t = lookText(useLanguage());
  const from = block.request.from ?? null;
  const opened = block.request.proposals ?? [];
  if (!from && !opened.length) return null;
  return (
    <div className="request-look-line" data-look="related">
      <span className="request-look-label">{t.related}</span>
      <span className="request-look-text">
        {from && (
          <button type="button" className="talk-link request-look-related" data-related={from.n} aria-label={t.showRequest(from.n)}
            onClick={() => onShowBlock(from.n)}>
            {t.openedFrom(from.n)}
          </button>
        )}
        {opened.map((link) => (
          <button key={link.n} type="button" className="talk-link request-look-related" data-related={link.n} aria-label={t.showRequest(link.n)}
            onClick={() => onShowBlock(link.n)}>
            {t.openedHere(link.n)}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * The newest follow-up's line (YN-237 ②): its number, what came of it (the project replied, a later note, waiting, not
 * delivered), the reply's words on one line, and, when the project replied while the work goes on, that it is not
 * delivered: a reply is not the delivery. "Conversation" opens it there, at that follow-up, marked as R-45 marks it.
 */
function FollowLine({ follow, block, onThread, onResend, resending, readOnly }: {
  follow: BlockFollowUp; block: RequestBlock; onThread: (m: number, marked: string[]) => void; onResend?: (m: number) => void;
  resending: boolean; readOnly: boolean;
}) {
  const language = useLanguage();
  const t = lookText(language);
  const resend = progressText(language).follow.resend;
  const { latest } = follow;
  const marked =
    latest.state === "answered" ? [`note:${latest.note.n}`]
      : latest.state === "later" ? [`note:${latest.note.n}`, ...latest.together.filter((n) => n !== latest.n).map((n) => `reply:${n}`)]
        : [];
  const settled = block.group === "done" || block.state === "accept" || block.state === "followUp";
  const said = latest.state === "answered" || latest.state === "later" ? latest.note.note : latest.text;
  const state = latest.state === "unsent" && latest.failed ? t.failed : t.state[latest.state];
  return (
    <Line
      kind="follow"
      label={t.follow(latest.n)}
      meta={
        <>
          <span className="request-look-tag" data-state={latest.state}>{state}</span>
          {(latest.state === "answered" || latest.state === "later") && !settled && (
            <span className="request-look-tag" data-state="undelivered">{t.undelivered}</span>
          )}
          {latest.state === "unsent" && onResend && !readOnly && (
            <button type="button" className="talk-link" disabled={resending} onClick={() => onResend(latest.n)}>
              {resend}
            </button>
          )}
        </>
      }
      action={<Step label={t.talk} aria={t.talkLabel(latest.n)} data="talk" onClick={() => onThread(latest.n, marked)} />}
    >
      {said}
    </Line>
  );
}
