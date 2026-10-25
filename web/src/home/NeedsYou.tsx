import { Bell, MessageCircleQuestionMark, ShieldCheck } from "lucide-react";
import { useClockFormat } from "../time-preferences";
import { absolute, relative } from "./format";
import type { NeedsYouItem } from "./types";
import { FoldButton, useCardFold } from "./card-fold";

export const needsYouKey = (item: NeedsYouItem) =>
  item.kind === "approval"
    ? `approval:${item.requestId}`
    : `ask:${item.projectId}:${item.sectionKey}`;

/**
 * Every approval and open ask across projects, in Core's order (Project
 * Priority, then wait time). One fixed-height row: however many arrive, the
 * panels below never move. It only links; it never reorders the panels.
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
  const clock = useClockFormat();
  // Collapsed, the count still shows (T-115); nothing is answered by it.
  const [collapsed, toggleFold] = useCardFold("needs-you");
  return (
    <section className={`home-needs-you${collapsed ? " is-collapsed" : ""}`} aria-label="Needs you">
      <h2>
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label="Needs you" controls="home-needs-you-body" />
        <Bell size={14} />
        Needs you
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
                title={`${item.title} · waiting since ${absolute(item.since, clock)}`}
                onClick={() => onJump(item)}
              >
                {item.kind === "approval" ? <ShieldCheck size={14} /> : <MessageCircleQuestionMark size={14} />}
                <span className="home-needs-text">
                  <span className="home-needs-source">
                    {projectName(item.projectId)} · {item.agentName}
                  </span>
                  <strong>{item.title}</strong>
                </span>
                <span className="home-needs-since">{relative(item.since)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="home-needs-empty">Nothing needs you right now.</p>
      )}
      </div>
    </section>
  );
}
