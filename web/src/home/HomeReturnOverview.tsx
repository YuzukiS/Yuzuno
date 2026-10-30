import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  MessageSquareReply,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "../components";
import { langTag, useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { BriefMarkdown } from "./brief/Markdown";
import { sectionSummary } from "./card-summary";
import { absolute } from "./format";
import { useBriefDensity } from "./home-density";
import type { HomeTarget } from "./home-navigation";
import {
  currentOverviewSection,
  returnOverview,
  type OverviewSection,
  type ReplyReceipt,
} from "./return-overview";
import { returnOverviewText } from "./return-overview-text";
import type { HomeData } from "./types";
import "./return-overview.css";

/** A held reading, with explicit refresh. Needs you and failures are always
 * live alongside it. Mount with a Workspace key; no visit timestamp or
 * automatic Seen mark is stored on this device or sent to Core. */
export function HomeReturnOverview({
  data,
  readFailed,
  onSection,
  onNeedsYou,
  onNavigate,
}: {
  data: HomeData;
  readFailed: boolean;
  onSection: (projectId: string, key: string) => void;
  onNeedsYou: () => void;
  onNavigate: (target: HomeTarget) => void;
}) {
  const t = useStrings(returnOverviewText);
  const language = useLanguage();
  const time = useTimeDisplay();
  const density = useBriefDensity();
  const latest = useMemo(() => returnOverview(data), [data]);
  const [reading, setReading] = useState(latest);
  const [dialog, setDialog] = useState<"changes" | "replies" | "errors" | null>(
    null,
  );
  const [limit, setLimit] = useState(12);
  const leaveFocus = useRef(false);
  const waiting = reading.replies.filter((entry) => entry.state === "waiting");
  const resolved = reading.replies.length - waiting.length;
  const errors = data.projects.flatMap((panel) =>
    panel.errors.map((error) => ({
      ...error,
      projectName: panel.project.name,
    })),
  );
  const changed = reading.signature !== latest.signature;
  const open = (next: typeof dialog) => {
    setLimit(12);
    setDialog(next);
  };
  const navigate = (target: HomeTarget) => {
    leaveFocus.current = true;
    setDialog(null);
    onNavigate(target);
  };
  const openSection = (entry: OverviewSection) => {
    const current = currentOverviewSection(entry, data);
    if (!current) return;
    leaveFocus.current = true;
    setDialog(null);
    onSection(entry.projectId, current.key);
  };
  const receiptState = (entry: ReplyReceipt) =>
    entry.state === "resolved" ? t.resolved : t.waiting;
  const stamp = (entry: ReplyReceipt) =>
    entry.section.ask?.repliedAt
      ? t.repliedAt(absolute(entry.section.ask.repliedAt, time))
      : t.replyTimeUnknown;
  const displayReplies = reading.replies.slice(0, density === "high" ? 3 : 1);
  return (
    <section
      className="home-return-overview"
      aria-label={t.title}
      data-overview-at={reading.at}
    >
      <header className="home-return-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.basis}</p>
        </div>
        <span className="home-return-asof">
          {t.observed(absolute(reading.at, time))}
        </span>
        <button
          type="button"
          className={`quiet-button home-return-refresh${changed ? " has-update" : ""}`}
          disabled={!changed || readFailed}
          title={t.updateHelp}
          onClick={() => setReading(latest)}
        >
          <RefreshCw size={13} />
          {changed ? t.newReading : t.update}
        </button>
      </header>
      {readFailed && (
        <p className="home-return-stale" role="status">
          {t.stale}
        </p>
      )}
      <div className="home-return-tiles">
        <button
          type="button"
          className="home-return-tile"
          onClick={() => open("changes")}
        >
          <span className="home-return-icon">
            <FileText size={18} />
          </span>
          <span className="home-return-tile-copy">
            <span>{t.changes}</span>
            <strong>{t.changeCount(reading.changes.length)}</strong>
            <small>{reading.changes[0]?.section.title || t.changesNone}</small>
          </span>
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="home-return-tile"
          onClick={() => open("replies")}
        >
          <span className="home-return-icon is-reply">
            <MessageSquareReply size={18} />
          </span>
          <span className="home-return-tile-copy">
            <span>{t.replies}</span>
            <strong>{t.replyCount(reading.replies.length)}</strong>
            <small>
              {reading.replies.length
                ? t.replyProgress(waiting.length, resolved)
                : t.repliesNone}
            </small>
          </span>
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="home-return-tile is-live"
          onClick={onNeedsYou}
        >
          <span className="home-return-icon is-need">
            <ArrowRight size={18} />
          </span>
          <span className="home-return-tile-copy">
            <span>{t.needs}</span>
            <strong>{t.needsCount(data.needsYou.length)}</strong>
            <small>{data.needsYou.length ? t.needsLive : t.needsNone}</small>
          </span>
          <ChevronRight size={14} />
        </button>
      </div>
      {displayReplies.length > 0 && (
        <div className="home-return-receipts" aria-label={t.replies}>
          {displayReplies.map((entry) => (
            <button
              key={entry.identity}
              type="button"
              className="home-return-receipt"
              onClick={() => open("replies")}
            >
              <span className={`home-return-state ${entry.state}`}>
                {entry.state === "resolved" ? (
                  <Check size={12} />
                ) : (
                  <Clock3 size={12} />
                )}
                {receiptState(entry)}
              </span>
              <span className="home-return-receipt-title">
                {entry.section.title}
              </span>
              <span className="home-return-receipt-owner">
                {t.owner(entry.section.owner.name)}
              </span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <button
          type="button"
          className="home-return-errors"
          onClick={() => open("errors")}
        >
          <TriangleAlert size={14} />
          {t.exceptions(errors.length)}
          <ChevronRight size={13} />
        </button>
      )}
      <Modal
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value) setDialog(null);
        }}
        title={
          dialog === "replies"
            ? t.replies
            : dialog === "errors"
              ? t.errorsTitle
              : t.changes
        }
        description={
          dialog === "replies"
            ? t.repliesHelp
            : dialog === "errors"
              ? t.errorsHelp
              : t.changesHelp
        }
        className="home-return-dialog"
        lang={langTag(language)}
        closeLabel={t.close}
        onCloseAutoFocus={(event) => {
          if (leaveFocus.current) {
            event.preventDefault();
            leaveFocus.current = false;
          }
        }}
      >
        {dialog !== "errors" && (
          <p className="home-return-dialog-asof">
            {t.observed(absolute(reading.at, time))}
          </p>
        )}
        {dialog === "changes" && (
          <div className="home-return-list">
            {!reading.changes.length && (
              <p className="home-note">{t.changesNone}</p>
            )}
            {reading.changes.slice(0, limit).map((entry) => {
              const current = currentOverviewSection(entry, data);
              const summary = sectionSummary(entry.section);
              return (
                <article className="home-return-change" key={entry.identity}>
                  <div className="home-return-row-meta">
                    <span>{entry.projectName}</span>
                    <span>{t.version(entry.section.version)}</span>
                  </div>
                  <h3>{entry.section.title}</h3>
                  {summary && (
                    <div className="home-return-summary">
                      <BriefMarkdown text={summary} />
                    </div>
                  )}
                  <div className="home-return-detail-footer">
                    <span>{t.owner(entry.section.owner.name)}</span>
                    {current ? (
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => openSection(entry)}
                      >
                        {t.openCard}
                        <ArrowRight size={13} />
                      </button>
                    ) : (
                      <span>{t.noCurrentCard}</span>
                    )}
                  </div>
                  {current && current.version !== entry.section.version && (
                    <p className="home-note">{t.changedCard}</p>
                  )}
                </article>
              );
            })}
            {reading.changes.length > limit && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => setLimit((n) => n + 12)}
              >
                {t.allChanges} · {reading.changes.length - limit}
              </button>
            )}
          </div>
        )}
        {dialog === "replies" && (
          <div className="home-return-list">
            {!reading.replies.length && (
              <p className="home-note">{t.repliesNone}</p>
            )}
            {reading.replies.slice(0, limit).map((entry) => {
              const current = currentOverviewSection(entry, data);
              return (
                <article
                  className="home-return-reply-detail"
                  key={entry.identity}
                >
                  <div className="home-return-row-meta">
                    <span>{entry.projectName}</span>
                    <span className={`home-return-state ${entry.state}`}>
                      {entry.state === "resolved" ? (
                        <Check size={12} />
                      ) : (
                        <Clock3 size={12} />
                      )}
                      {receiptState(entry)}
                    </span>
                  </div>
                  <h3>{entry.section.title}</h3>
                  <p className="home-return-owner">
                    {t.owner(entry.section.owner.name)}
                    {entry.section.owner.state !== "active" && (
                      <span> · {t.ownerAway}</span>
                    )}
                  </p>
                  <blockquote>
                    <span>{t.originalReply}</span>
                    {entry.section.ask?.replyText || t.replyUnavailable}
                  </blockquote>
                  <div className="home-return-row-meta">
                    <span>{stamp(entry)}</span>
                    <span>{t.version(entry.section.version)}</span>
                  </div>
                  <details className="home-return-question">
                    <summary>{t.question}</summary>
                    <p>{entry.section.ask?.question}</p>
                    <p className="home-note">{t.questionVersionNote}</p>
                  </details>
                  <div className="home-return-detail-footer">
                    <span>{t.noReplyNeeded}</span>
                    {current ? (
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => openSection(entry)}
                      >
                        {t.openCard}
                        <ArrowRight size={13} />
                      </button>
                    ) : (
                      entry.section.owner.state === "active" && (
                        <button
                          type="button"
                          className="quiet-button"
                          onClick={() =>
                            navigate({
                              kind: "agent",
                              agentId: entry.section.owner.agentId,
                            })
                          }
                        >
                          {t.conversation(entry.section.owner.name)}
                          <ArrowRight size={13} />
                        </button>
                      )
                    )}
                  </div>
                </article>
              );
            })}
            {reading.replies.length > limit && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => setLimit((n) => n + 12)}
              >
                {t.allReplies} · {reading.replies.length - limit}
              </button>
            )}
          </div>
        )}
        {dialog === "errors" && (
          <div className="home-return-list">
            {errors.map((error) => (
              <article
                className="home-return-change"
                key={`${error.agentId}:${error.at}`}
              >
                <div className="home-return-row-meta">
                  {error.projectName} · {error.agentName}
                </div>
                <h3>{error.message}</h3>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() =>
                    navigate({ kind: "error", agentId: error.agentId })
                  }
                >
                  {t.viewError}
                  <ArrowRight size={13} />
                </button>
              </article>
            ))}
          </div>
        )}
      </Modal>
    </section>
  );
}
