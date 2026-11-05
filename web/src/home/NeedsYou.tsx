import { Bell, CircleAlert, CircleCheck, MessageCircleQuestionMark, MessagesSquare, ShieldCheck } from "lucide-react";
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
      : `ask:${item.projectId}:${item.sectionKey}`;

/** Turn ends this device hasn't shown (T-42), failed and finished. */
export type UnseenEnds = { failed: Agent[]; finished: Agent[] };

/**
 * Every approval, open question and open ask across projects, in Core's
 * order (Project Priority, then wait time). One fixed-height row: however
 * many arrive, the panels below never move. It only links; it never reorders
 * the panels. Under them, the Turns that failed and then those that finished
 * since this device last showed them (T-42), each a way to its conversation.
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
      {items.length ? (
        <ol className="home-needs-list">
          {items.map((item) => (
            <li key={needsYouKey(item)}>
              <button
                type="button"
                className={`home-needs-item kind-${item.kind}`}
                data-needs-you={needsYouKey(item)}
                title={t.waitingSince(item.title, absolute(item.since, time))}
                onClick={() => onJump(item)}
              >
                {item.kind === "approval" ? (
                  <ShieldCheck size={14} />
                ) : item.kind === "question" ? (
                  <MessagesSquare size={14} />
                ) : (
                  <MessageCircleQuestionMark size={14} />
                )}
                <span className="home-needs-text">
                  <span className="home-needs-source">
                    {projectName(item.projectId)} · {item.agentName}
                  </span>
                  <strong>{item.title}</strong>
                </span>
                <span className="home-needs-since">{relative(item.since, language)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="home-needs-empty">{t.nothingNeedsYou}</p>
      )}
      {(["failed", "finished"] as const).map((outcome) =>
        unseen[outcome].length ? (
          <div key={outcome} className={`home-unseen home-unseen-${outcome}`} data-unseen={outcome}>
            <h3>
              {outcome === "failed" ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
              {outcome === "failed" ? t.unseenFailed : t.unseenFinished}
              <span className="nav-count">{unseen[outcome].length}</span>
            </h3>
            <ol className="home-needs-list">
              {unseen[outcome].map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={`home-needs-item kind-unseen-${outcome}`}
                    data-unseen-agent={agent.id}
                    title={t.unseenOpen(agent.name)}
                    onClick={() => onOpenAgent?.(agent.id)}
                  >
                    {outcome === "failed" ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
                    <span className="home-needs-text">
                      <span className="home-needs-source">{projectName(agent.projectId ?? null)}</span>
                      <strong>{agent.name}</strong>
                    </span>
                    {agent.lastTurnEnd && (
                      <span className="home-needs-since">{relative(agent.lastTurnEnd.at, language)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null,
      )}
      </div>
    </section>
  );
}
