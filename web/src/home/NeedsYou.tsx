import { BadgeCheck, Bell, CircleAlert, MessageCircleQuestionMark, MessagesSquare, OctagonPause, ShieldCheck } from "lucide-react";
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
      : item.kind === "executor"
          ? `executor:${item.agentId}:${item.state}`
          : `ask:${item.projectId}:${item.sectionKey}`;

/**
 * Every approval, open question and open ask across projects, in Core's
 * order (Project Priority, then wait time). One fixed-height row: however
 * many arrive, the panels below never move. It only links; it never reorders
 * the panels. Only what waits for the user's decision (YN-3): a Turn that
 * ended and that this device has not shown, a CI run or a Job that finished,
 * is its Agent's to follow, marked on the Agent list (unseenEnd), not here.
 */
export function NeedsYou({
  items,
  projectName,
  onJump,
}: {
  items: NeedsYouItem[];
  projectName: (id: string | null) => string;
  onJump: (item: NeedsYouItem) => void;
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
                title={t.waitingSince(item.kind === "executor" ? [item.agentName, item.title, item.reason].filter(Boolean).join(" · ") : item.title, absolute(item.since, time))}
                onClick={() => onJump(item)}
              >
                {item.kind === "approval" ? (
                  <ShieldCheck size={14} />
                ) : item.kind === "question" ? (
                  <MessagesSquare size={14} />
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
                  {/* Why (T-43 S4a): why its start failed, what blocks its task. */}
                  {item.kind === "executor" && item.reason && <span className="home-needs-reason">{item.reason}</span>}
                </span>
                <span className="home-needs-since">{relative(item.since, language)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="home-needs-empty">{t.nothingNeedsYou}</p>
      )}
      </div>
    </section>
  );
}
