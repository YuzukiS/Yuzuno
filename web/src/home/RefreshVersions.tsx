import { useEffect, useMemo, useState } from "react";
import { errorText } from "../api";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { readRefreshIssue, readRefreshIssues, type RefreshIssue } from "./home-api";
import { refreshDateTime } from "./refresh-state";
import { refreshText } from "./refresh-text";
import type { Section } from "./types";
import "./refresh.css";

/**
 * A refreshing report's issues (YN-113 R3, design §3.4): "This issue · Nov
 * 14, 08:01" and, in the same list, the past ones Core keeps for 30 days,
 * each with its time and conclusion (Core's own words for it, `lead`). A
 * past issue is read whole from Core and handed up to be shown read only;
 * Core keeps past issues out of Home's history, so this is the only way to
 * them. The list is read again when a new issue arrives (liveVersion).
 */
export function RefreshVersions({
  projectId,
  identity,
  linkedVersion,
  liveVersion,
  liveAt,
  selected,
  onSelect,
}: {
  projectId: string;
  identity: number;
  /** The version the page linked: its option returns to that one, as it was. */
  linkedVersion: number;
  /** The live issue's version: "This issue" in the list. */
  liveVersion: number;
  /** When the live issue was written, for the list's label while it loads. */
  liveAt: string;
  /** The past issue on screen, if any. */
  selected: number | null;
  /** A past issue read whole, or null for the one the page linked. */
  onSelect: (section: Section | null, at: string | null) => void;
}) {
  const language = useLanguage();
  const t = useStrings(refreshText);
  const time = useTimeDisplay();
  const dates = useMemo(() => refreshDateTime(time), [time]);
  const [issues, setIssues] = useState<RefreshIssue[] | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setIssues(null);
    readRefreshIssues(projectId, identity, controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setIssues(answer.versions);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(t.issues.failed(errorText(e)));
      });
    return () => controller.abort();
  }, [projectId, identity, liveVersion, t.issues]);
  async function choose(version: number) {
    if (version === linkedVersion) {
      onSelect(null, null);
      return;
    }
    const issue = issues?.find((one) => one.version === version) ?? null;
    setReading(true);
    setError("");
    try {
      const section = await readRefreshIssue(projectId, identity, version);
      onSelect(section, issue?.at ?? section.updatedAt);
    } catch (e) {
      setError(t.issues.issueFailed(errorText(e)));
    } finally {
      setReading(false);
    }
  }
  return (
    <div className="home-refresh-issues" aria-busy={reading}>
      <label>
        <span className="sr-only">{t.issues.label}</span>
        <select
          aria-label={t.issues.label}
          value={selected ?? linkedVersion}
          disabled={reading || !issues}
          onChange={(event) => void choose(Number(event.target.value))}
        >
          {!issues ? (
            <option value={linkedVersion}>
              {linkedVersion === liveVersion ? t.issues.current(dates(liveAt)) : t.issues.past(dates(liveAt))}
            </option>
          ) : (
            issues.map((issue) => (
              <option key={issue.version} value={issue.version}>
                {issue.live ? t.issues.current(dates(issue.at)) : issue.lead ? `${t.issues.past(dates(issue.at))} — ${issue.lead}` : t.issues.past(dates(issue.at))}
              </option>
            ))
          )}
        </select>
      </label>
      {!issues && !error && <span className="home-refresh-issues-note">{t.issues.loading}</span>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
