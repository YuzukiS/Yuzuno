import { useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle } from "lucide-react";
import { errorText } from "../api";
import { langTag, strings, useLanguage } from "../i18n";
import { changedHunks, lineDiff } from "../line-diff";
import {
  decideHandoverProposal, readHandoverProposal,
  type HandoverProposalDetail, type HandoverProposalSummary,
} from "../project-handover";
import { handoverDomId } from "./brief-layout";
import { relative } from "./format";
import "../codex-changes.css";
import "./handover-proposal.css";

const text = strings({
  title: "Handover change proposed",
  by: (name: string) => `by ${name}`,
  reading: "Reading the proposal…",
  onVersion: (base: number) => `On version ${base} of the handover.`,
  stale: (base: number, current: number) =>
    `The handover changed since: it is at version ${current} now, not ${base}. This proposal can't be approved; reject it, and its lead is told to propose again on version ${current}.`,
  same: "The proposal is the same as the current document.",
  unchanged: (count: number) => `… ${count} unchanged ${count === 1 ? "line" : "lines"}`,
  note: (name: string) => `Note for ${name}`,
  notePlaceholder: "Optional, sent with your decision",
  noteBytes: (used: number) => `${used} of 1000 bytes.`,
  noteTooLong: "At most 1000 bytes.",
  approve: "Approve",
  reject: "Reject",
  changes: "Changes",
}, {
  title: "提议修改交接文档",
  by: (name) => `来自 ${name}`,
  reading: "正在读取提议…",
  onVersion: (base) => `基于交接文档第 ${base} 版。`,
  stale: (base, current) =>
    `交接文档此后已更改：现在是第 ${current} 版，不是第 ${base} 版。此提议不能批准；拒绝它，提议者会收到提示，基于第 ${current} 版重新提议。`,
  same: "提议与当前文档相同。",
  unchanged: (count) => `… ${count} 行未变`,
  note: (name) => `给 ${name} 的备注`,
  notePlaceholder: "可选，随你的决定发送",
  noteBytes: (used) => `${used} / 1000 字节。`,
  noteTooLong: "最多 1000 字节。",
  approve: "批准",
  reject: "拒绝",
  changes: "改动",
});

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** As Core's `handover::MAX_REASON`: a note is held to a reason's limit. */
const NOTE_BYTES = 1_000;

/**
 * A lead's handover proposal on Home (T-34 S3b): who proposed it and why,
 * the changed lines against the version it was made on, and the user's
 * decision with an optional note. A decision is checked against the version
 * read here; Core's refusal is shown as it came, and the proposal read again.
 */
export function HandoverProposal({ projectId, proposal, readOnly = false, onChanged }: {
  projectId: string;
  proposal: HandoverProposalSummary;
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const language = useLanguage();
  const t = text(language);
  const [detail, setDetail] = useState<HandoverProposalDetail | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reload, setReload] = useState(0);
  // One requestId per decision attempt: a retry after a lost reply is the same decision.
  const attempt = useRef<{ action: string; requestId: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readHandoverProposal(projectId, proposal.id, controller.signal).then(next => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
    // Home's data names the document's version: a save elsewhere reads the proposal again (#612 R1).
  }, [projectId, proposal.id, proposal.currentVersion, reload]);
  const noteSize = bytes(note.trim());
  const tooLong = noteSize > NOTE_BYTES;
  async function decide(action: "approve" | "reject") {
    if (!detail) return;
    if (attempt.current?.action !== action) attempt.current = { action, requestId: crypto.randomUUID() };
    setBusy(action);
    setError("");
    try {
      await decideHandoverProposal(projectId, proposal.id,
        { requestId: attempt.current.requestId, action, expectedVersion: detail.currentVersion, note });
      attempt.current = null;
      onChanged();
    } catch (e) {
      // Kept: the same decision tried again is the same request to Core.
      setError(errorText(e));
      setReload(n => n + 1);
    } finally {
      setBusy(null);
    }
  }
  const diff = detail ? changedHunks(lineDiff(detail.base.markdown, detail.proposal.markdown)) : [];
  const name = proposal.proposer.name;
  // Read before the document moved: nothing is decided until it is read again.
  const moved = !!detail && proposal.currentVersion !== undefined && proposal.currentVersion !== detail.currentVersion;
  const locked = readOnly || busy !== null || !detail || moved;
  return (
    <div className="home-widget home-handover-proposal" id={handoverDomId(proposal.id)} tabIndex={-1}
      aria-label={`${t.title} ${t.by(name)}`} lang={langTag(language)}>
      <div className="home-card-head">
        <h4>
          <FileText size={13} /> {t.title}
        </h4>
        <span className="home-from">{t.by(name)} · {relative(proposal.at, language)}</span>
      </div>
      <div className="home-card-body">
        {proposal.reason && <p className="home-handover-reason">{proposal.reason}</p>}
        {!detail && !error && <p className="home-note" role="status">{t.reading}</p>}
        {detail && (
          <>
            <p className="home-note">{t.onVersion(detail.proposal.baseVersion)}</p>
            {detail.stale && <p className="inline-error" role="alert">{t.stale(detail.proposal.baseVersion, detail.currentVersion)}</p>}
            {diff.length === 0 || diff.every(line => line.kind === "same" || line.kind === "skip")
              ? <p className="home-note">{t.same}</p>
              : (
                <pre className="changes-lines" aria-label={t.changes}>
                  {diff.map((line, index) => line.kind === "skip"
                    ? <span key={index} data-line="meta">{t.unchanged(line.count)}{"\n"}</span>
                    : <span key={index} data-line={line.kind === "same" ? undefined : line.kind}>
                        {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}
                      </span>)}
                </pre>
              )}
            <label className="home-handover-note">
              <span>{t.note(name)} <span className="home-note">{t.noteBytes(noteSize)}</span></span>
              <input aria-label={t.note(name)} value={note} placeholder={t.notePlaceholder} disabled={locked}
                onChange={e => setNote(e.target.value)} />
            </label>
            {tooLong && <p className="inline-error" role="alert">{t.noteTooLong}</p>}
            <div className="home-handover-actions">
              <button type="button" className="primary-button" disabled={locked || tooLong || detail.stale} onClick={() => void decide("approve")}>
                {busy === "approve" && <LoaderCircle size={13} className="spin" />} {t.approve}
              </button>
              <button type="button" className="secondary-button" disabled={locked || tooLong} onClick={() => void decide("reject")}>
                {busy === "reject" && <LoaderCircle size={13} className="spin" />} {t.reject}
              </button>
            </div>
          </>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
