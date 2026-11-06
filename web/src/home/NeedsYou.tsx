import { BadgeCheck, Bell, CircleAlert, CircleCheck, FileText, MessageCircleQuestionMark, MessagesSquare, OctagonPause, ShieldCheck } from "lucide-react";
import type { Agent } from "../types";
import { useLanguage } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { absolute, relative } from "./format";
import type { NeedsYouItem } from "./types";
import { FoldButton, useCardFold } from "./card-fold";
import { homeText } from "./home-text";

export const needsYouKey = (item: NeedsYouItem) =>
  item.kind === "approval"
    ? `approval:${item.requestId}`
    : item.kind === "question"
      ? `question:${item.agentId}:${item.turnId}:${item.itemId}`
      : item.kind === "handover"
        ? `handover:${item.proposalId}`
        : item.kind === "executor"
          ? `executor:${item.agentId}:${item.state}`
          : `ask:${item.projectId}:${item.sectionKey}`;

/** Turn ends this device hasn't shown (T-42), failed and finished. */
export type UnseenEnds = { failed: Agent[]; finished: Agent[] };

/**
 * Every approval, open question and open ask across projects, in Core's
 * order (Project Priority, then wait time). One fixed-height row: however
 * many arrive, the panels below never move. It only links; it never reorders
 * the panels. After them in the same row, the Turns that failed and then
 * those that finished since this device last showed them (T-42), each a way
 * to its conversation.
 */
export function NeedsYou({
  items,
  projectName,
  onJump,
  unseen = { failed: [], finished: [] },
  onOpenAgent,
}: {
  items: NeedsYouItem[];
  projectName: (id: string | null) => string;
  onJump: (item: NeedsYouItem) => void;
  unseen?: UnseenEnds;
  onOpenAgent?: (agentId: string) => void;
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  // Collapsed, the count still shows (T-115); nothing is answered by it.
  const [collapsed, toggleFold] = useCardFold("needs-you");
  return (
    <section className={`home-needs-you${collapsed ? " is-collapsed" : ""}`} aria-label={t.needsYou}>
      <h2>
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label={t.needsYou} controls="home-needs-you-body" />
        <Bell size={14} />
        {t.needsYou}
        <span className={`nav-count${items.length ? " attention" : ""}`}>{items.length}</span>
      </h2>
      <div className="home-card-body" id="home-needs-you-body" hidden={collapsed}>
      {items.length || unseen.failed.length || unseen.finished.length ? (
        <ol className="home-needs-list">
          {items.map((item) => (
            <li key={needsYouKey(item)}>
              <button
                type="button"
                className={`home-needs-item kind-${item.kind}`}
                data-needs-you={needsYouKey(item)}
                title={t.waitingSince(item.kind === "executor" ? `${item.agentName} · ${item.title}` : item.title, absolute(item.since, time))}
                onClick={() => onJump(item)}
              >
                {item.kind === "approval" ? (
                  <ShieldCheck size={14} />
                ) : item.kind === "question" ? (
                  <MessagesSquare size={14} />
                ) : item.kind === "handover" ? (
                  <FileText size={14} />
                ) : item.kind === "executor" ? (
                  item.state === "delivering" ? <BadgeCheck size={14} /> : item.state === "failed" ? <CircleAlert size={14} /> : <OctagonPause size={14} />
                ) : (
                  <MessageCircleQuestionMark size={14} />
                )}
                <span className="home-needs-text">
                  {/* An executor you dispatched (T-36 S3): what it waits for,
                      then its task; its name repeats its task's number. */}
                  <span className="home-needs-source">
                    {projectName(item.projectId)} · {item.kind === "executor" && item.state ? t.executorNeeds[item.state] : item.agentName}
                  </span>
                  <strong>{item.kind === "executor" && item.taskId ? `${item.taskId} · ${item.title}` : item.title}</strong>
                </span>
                <span className="home-needs-since">{relative(item.since, language)}</span>
              </button>
            </li>
          ))}
          {(["failed", "finished"] as const).flatMap((outcome) =>
            unseen[outcome].map((agent) => (
              <li key={`unseen:${agent.id}`}>
                <button
                  type="button"
                  className={`home-needs-item kind-unseen-${outcome}`}
                  data-unseen-agent={agent.id}
                  data-unseen={outcome}
                  title={t.unseenOpen(agent.name)}
                  onClick={() => onOpenAgent?.(agent.id)}
                >
                  {outcome === "failed" ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
                  <span className="home-needs-text">
                    <span className="home-needs-source">
                      {projectName(agent.projectId ?? null)} · {outcome === "failed" ? t.unseenFailed : t.unseenFinished}
                    </span>
                    <strong>{agent.name}</strong>
                  </span>
                  {agent.lastTurnEnd && (
                    <span className="home-needs-since">{relative(agent.lastTurnEnd.at, language)}</span>
                  )}
                </button>
              </li>
            )),
          )}
        </ol>
      ) : (
        <p className="home-needs-empty">{t.nothingNeedsYou}</p>
      )}
      </div>
    </section>
  );
}
