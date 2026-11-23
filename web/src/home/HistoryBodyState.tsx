import { LoaderCircle } from "lucide-react";
import { useLanguage } from "../i18n";
import { retryBody, useHistoryBody } from "./history-bodies";
import { homeText } from "./home-text";
import type { Section } from "./types";

/**
 * In place of a history entry's body until it is read whole (YN-221 S2):
 * asks for it as it is shown, says it is reading, that it could not be read
 * with a way to read again, or that History no longer keeps it. `title`, for
 * a place that shows nothing else of the entry.
 */
export function HistoryBodyState({ projectId, section, title = false }: { projectId: string; section: Section; title?: boolean }) {
  const t = homeText(useLanguage()).historyBody;
  const state = useHistoryBody(projectId, section);
  if (state === "whole") return null;
  return (
    <div className={`history-body-state history-body-${state}`} data-history-body={state} role={state === "failed" ? "alert" : "status"}>
      {title && <strong>{section.title}</strong>}
      {state === "reading" ? (
        <span>
          <LoaderCircle className="spin" size={13} aria-hidden="true" /> {t.reading}
        </span>
      ) : state === "failed" ? (
        <span>
          {t.failed}{" "}
          <button type="button" className="quiet-button" onClick={() => typeof section.id === "number" && retryBody(projectId, section.id, section.version)}>
            {t.retry}
          </button>
        </span>
      ) : (
        <span>{t.missing}</span>
      )}
    </div>
  );
}
