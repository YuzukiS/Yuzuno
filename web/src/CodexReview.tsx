import { useState, type FormEvent } from "react";
import { LoaderCircle, SearchCheck } from "lucide-react";
import { errorText, post } from "./api";
import { ChoiceChips } from "./ChoiceChips";
import { Modal } from "./components";
import type { Agent } from "./types";
import "./remote.css";

/** What Codex reviews: Codex's own `ReviewTarget`. */
export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

/**
 * Asks this Agent's own Codex for its review of `target` (`review/start`),
 * run as a Turn of this conversation. Core refuses it while a Turn runs or
 * an earlier result is unconfirmed; its error says whether anything may
 * have started.
 */
export function startCodexReview(agentId: string, target: ReviewTarget) {
  return post<{ accepted: true; turnId: string }>(`/agents/${encodeURIComponent(agentId)}/codex/review`, { target });
}

const choices = [
  { value: "uncommittedChanges", label: "Uncommitted changes" },
  { value: "baseBranch", label: "Against a base branch" },
  { value: "commit", label: "A commit" },
  { value: "custom", label: "Your instructions" },
];
const hints: Record<ReviewTarget["type"], string> = {
  uncommittedChanges: "Staged, unstaged and untracked files in this Agent's folder.",
  baseBranch: "What the current branch changes compared with the branch you name.",
  commit: "The changes one commit introduced.",
  custom: "Codex reviews what you describe.",
};

/**
 * `/review` alone (T-29): what Codex reviews, as its CLI asks. Nothing
 * starts until Start review; Codex then runs the review as a Turn here, and
 * its findings are that Turn's reply.
 */
export function CodexReviewDialog({ agent, open, onOpenChange, onStarted }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
}) {
  const [type, setType] = useState<ReviewTarget["type"]>("uncommittedChanges");
  const [branch, setBranch] = useState("");
  const [sha, setSha] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target: ReviewTarget | null =
    type === "uncommittedChanges" ? { type }
      : type === "baseBranch" ? (branch.trim() ? { type, branch: branch.trim() } : null)
        : type === "commit" ? (sha.trim() ? { type, sha: sha.trim(), title: title.trim() || null } : null)
          : instructions.trim() ? { type, instructions: instructions.trim() } : null;

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    try {
      await startCodexReview(agent.id, target);
      onStarted();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title="Review with Codex"
      description={`${agent.name}'s Codex reviews the changes you choose, as a turn in this conversation. Nothing is sent as a message.`}>
      <form className="create-form remote-create" onSubmit={start}>
        <fieldset className="remote-form-fields" disabled={busy}>
          <ChoiceChips label="What to review" value={type} choices={choices}
            onChange={(value) => setType(value as ReviewTarget["type"])} />
          <p className="remote-field-note">{hints[type]}</p>
          {type === "baseBranch" && (
            <label>
              Base branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" maxLength={256} required />
            </label>
          )}
          {type === "commit" && (
            <>
              <label>
                Commit
                <input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="Commit hash" maxLength={256} required />
              </label>
              <label>
                Title (optional)
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
              </label>
            </>
          )}
          {type === "custom" && (
            <label>
              Instructions
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} required />
            </label>
          )}
        </fieldset>
        {error && <p role="alert" className="remote-field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="primary-button" disabled={busy || !target}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <SearchCheck size={15} />}
            {busy ? "Starting…" : "Start review"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
