import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { errorText } from "../api";
import { Modal } from "../components";
import { readExecutorTemplates, type ExecutorTemplate } from "../executor-templates";
import { useLanguage } from "../i18n";
import { randomId } from "../random-id";
import type { Agent } from "../types";
import { reassignCard, type ReassignTo } from "./project-talk-api";
import { MAX_LINE_CHARS } from "./project-talk";
import { talkText } from "./talk-text";
import type { Section } from "./types";

/**
 * A card's reassignment, the user's (YN-86 §3.3, §4.2): to another open
 * Agent of the Project that is no executor, as Core's own rule has it
 * (routes.rs may_take), or to a new executor from one of the Workspace's
 * templates, with a reason if the user gives one. Core dispatches to the new
 * one first and only then releases the earlier executor; the answer says
 * so. One client ID per choice, so a retry is the same reassignment; any
 * change of choice is a new one.
 */
export function ReassignCard({
  open,
  onOpenChange,
  section,
  sectionId,
  projectId,
  workspaceId,
  members,
  responsible,
  task,
  onOpenTask,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: Section;
  sectionId: number;
  projectId: string;
  workspaceId: string;
  /** The Project's open Agents. */
  members: Agent[];
  /** Who answers for the card now, as its foot shows them. */
  responsible: { agentId: string; name: string } | null;
  task: string;
  onOpenTask: () => void;
  /** What the card's foot says once Core has reassigned it. */
  onDone: (note: string) => void;
}) {
  const t = talkText(useLanguage());
  const [choice, setChoice] = useState("");
  const [why, setWhy] = useState("");
  const [templates, setTemplates] = useState<ExecutorTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The same choice sent again is the same reassignment (a release that failed is made then).
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!open || templates) return;
    const controller = new AbortController();
    readExecutorTemplates(controller.signal)
      .then((view) => !controller.signal.aborted && setTemplates(view.available.map((entry) => entry.template)))
      .catch((e) => !controller.signal.aborted && (setTemplates([]), setError(errorText(e))));
    return () => controller.abort();
  }, [open, templates]);
  const candidates = members.filter((agent) => agent.kind !== "executor" && !agent.closedAt && agent.id !== responsible?.agentId);
  const to: ReassignTo | null = choice.startsWith("agent:")
    ? { agentId: choice.slice(6) }
    : choice.startsWith("template:") ? { executor: { templateId: choice.slice(9) } } : null;
  async function send() {
    if (!to || busy) return;
    const reason = why.trim();
    const key = JSON.stringify([choice, reason]);
    const id = attempt?.key === key ? attempt.id : randomId();
    setAttempt({ key, id });
    setBusy(true);
    setError("");
    try {
      const answer = await reassignCard(projectId, sectionId, {
        workspaceId, to, clientRequestId: id, ...(reason ? { why: reason } : {}),
      });
      const name = answer.route.to?.name || candidates.find((agent) => agent.id === choice.slice(6))?.name || "";
      const said = "agentId" in to ? t.reassignedTo(name) : t.reassignedExecutor;
      const released = answer.released
        ? t.released(members.find((agent) => agent.id === answer.released!.agentId)?.name || responsible?.name || answer.released.agentId)
        : "";
      onDone([said, released].filter(Boolean).join(" "));
      setChoice("");
      setWhy("");
      setAttempt(null);
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const option = (value: string, label: string, note?: string) => (
    <label key={value} className="reassign-option">
      <input type="radio" name={`reassign-${sectionId}`} value={value} checked={choice === value} disabled={busy} onChange={() => setChoice(value)} />
      <span>
        {label}
        {note && <small>{note}</small>}
      </span>
    </label>
  );
  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title={t.reassignTitle(section.title)} confirm>
      <form
        className="reassign-card"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <p className="reassign-now">
          {responsible ? t.reassignNow(responsible.name) : t.reassignNone} {t.reassignHow}
        </p>
        <fieldset>
          <legend>{t.toMember}</legend>
          {candidates.length ? candidates.map((agent) => option(`agent:${agent.id}`, agent.name)) : <p className="home-note">{t.noMembers}</p>}
        </fieldset>
        <fieldset>
          <legend>{t.toExecutor}</legend>
          {templates === null ? (
            <p className="home-note">{t.templatesReading}</p>
          ) : templates.length ? (
            templates.map((template) => option(`template:${template.id}`, template.label, template.whenToChoose))
          ) : (
            <p className="home-note">{t.noTemplates}</p>
          )}
        </fieldset>
        <label className="reassign-why">
          <span>{t.why}</span>
          <input type="text" value={why} maxLength={MAX_LINE_CHARS} disabled={busy} onChange={(event) => setWhy(event.target.value)} />
          <small>{t.whyHint}</small>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="quiet-button reassign-task" onClick={onOpenTask}>
            {t.openTaskInstead(task)}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="primary-button" disabled={!to || busy}>
            {busy && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
            {busy ? t.reassigning : t.reassignSend}
          </button>
        </div>
      </form>
    </Modal>
  );
}
