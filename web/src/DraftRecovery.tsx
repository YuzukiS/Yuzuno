import { useState } from "react";
import { Modal } from "./components";

export function DraftRecovery({ onDiscard }: { onDiscard: () => boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        className="quiet-button"
        onClick={() => {
          setFailed(false);
          setOpen(true);
        }}
      >
        Reset saved draft…
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Discard this saved draft?"
        description="Some or all of this draft could not be read. This permanently discards this Agent’s saved draft, including any readable text. Copy text from another open window first. Conversation messages are not affected."
      >
        {failed && (
          <p className="inline-error" role="alert">
            The draft could not be reset. It has not been discarded. Check
            browser storage access and try again.
          </p>
        )}
        <div className="pasted-text-dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="quiet-button danger"
            onClick={() => {
              if (onDiscard()) setOpen(false);
              else setFailed(true);
            }}
          >
            Discard saved draft
          </button>
        </div>
      </Modal>
    </>
  );
}
