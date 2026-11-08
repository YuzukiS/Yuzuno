import { useEffect, useState } from "react";
import { errorText } from "./api";
import { strings, useLanguage } from "./i18n";
import { AskReply } from "./home/AskReply";
import { readHome } from "./home/home-api";
import { SectionBody } from "./home/SectionBody";
import type { HomeData, NeedsYouItem, Section } from "./home/types";
import type { Agent } from "./types";
import "./gate-asks.css";

const text = strings({
  heading: "Waiting for your approval",
  note: "Its executor asked this on Home. Answer here, in its other tab or on Home: one answer settles it everywhere.",
  loading: "Reading what it asks…",
  unread: (error: string) => `Couldn't read what it asks: ${error}`,
}, {
  heading: "等你批准",
  note: "执行者在 Home 发的提问。在这里、另一个页签或 Home 回答都行，答一处各处都解决。",
  loading: "正在读取它问的…",
  unread: (error) => `读取提问失败：${error}`,
});

/**
 * An executor's gate asks (T-43 S4, the user's option D): the approvals it
 * asked for with its own Home Asks, each as Home shows it, answered here
 * with Home's own reply. It is the same Ask, so an answer here is the
 * answer on Home and in its other tab. `items` are its asks in Home's
 * Needs you.
 */
export function GateAsks({ items, workspaceId, agents, readOnly, onSent }: {
  items: readonly NeedsYouItem[];
  workspaceId: string;
  /** The Project's open Agents, any of which can receive the reply. */
  agents: Agent[];
  readOnly: boolean;
  onSent: () => void;
}) {
  const t = text(useLanguage());
  const [home, setHome] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wanted = items.map((item) => `${item.projectId}/${item.sectionKey}@${item.since}`).join(" ");
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    setError(null);
    readHome(controller.signal)
      .then(setHome)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [wanted]);
  if (!items.length) return null;
  const section = (item: NeedsYouItem): Section | null =>
    home?.projects.find((p) => p.project.id === item.projectId)?.brief.sections.find((s) => s.key === item.sectionKey && s.kind === "ask") ?? null;
  return (
    <div className="gate-asks">
      {items.map((item) => {
        const shown = section(item);
        // Home no longer has it as an ask: answered or changed since Needs you was read.
        if (home && !shown) return null;
        return (
          <section key={`${item.projectId}/${item.sectionKey}`} className="gate-ask" aria-label={`${t.heading} · ${item.title}`}>
            <h3>{t.heading} <span>· {item.title}</span></h3>
            {shown && item.projectId ? (
              <>
                <p className="gate-ask-question">{shown.ask!.question}</p>
                <div className="gate-ask-body">
                  <SectionBody section={shown} projectId={item.projectId} />
                </div>
                <AskReply section={shown} projectId={item.projectId} workspaceId={workspaceId} agents={agents} readOnly={readOnly} onSent={onSent} />
              </>
            ) : error ? (
              <p className="gate-ask-error" role="alert">{t.unread(error)}</p>
            ) : (
              <p className="gate-ask-loading">{t.loading}</p>
            )}
            <p className="note">{t.note}</p>
          </section>
        );
      })}
    </div>
  );
}
