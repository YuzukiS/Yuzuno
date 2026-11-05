import { useEffect, useRef, useState } from "react";
import { ChartColumn, Columns3 } from "lucide-react";
import { CopyButton, Modal, Yuzu } from "../components";
import { interactiveRequest } from "./examples";
import "./intelligent-ui.css";

/** The request's dialog, opened from the composer's "+" menu (T-44). */
export function ResultRequest({
  open,
  onOpenChange,
  onDraft,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDraft: (text: string) => void;
  /** Where focus goes back when it closes without a request added ("+"). */
  returnFocus?: () => void;
}) {
  const [kind, setKind] = useState<"comparison" | "report">("comparison");
  const appended = useRef(false);
  useEffect(() => {
    if (open) appended.current = false;
  }, [open]);
  const template = interactiveRequest(kind);
  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="A result you can explore"
        description="Add a request to your draft. Your agent can include a table or chart with its reply."
        onCloseAutoFocus={(event) => {
          // With a request added, the draft has the focus.
          if (appended.current) event.preventDefault();
          else if (returnFocus) {
            event.preventDefault();
            returnFocus();
          }
        }}
      >
        <div className="result-request-intro">
          <Yuzu size={32} />
          <p>
            Compare a few options, explore the evidence, then choose what comes
            next.
          </p>
        </div>
        <fieldset className="result-request-kinds">
          <legend>What would help?</legend>
          <label data-selected={kind === "comparison"}>
            <input
              type="radio"
              name="result-kind"
              value="comparison"
              checked={kind === "comparison"}
              onChange={() => setKind("comparison")}
            />
            <Columns3 size={19} />
            <span>
              <strong>Compare options</strong>
              <small>Filter, sort and choose a direction.</small>
            </span>
          </label>
          <label data-selected={kind === "report"}>
            <input
              type="radio"
              name="result-kind"
              value="report"
              checked={kind === "report"}
              onChange={() => setKind("report")}
            />
            <ChartColumn size={19} />
            <span>
              <strong>Explore data</strong>
              <small>Metrics, a chart and the original values.</small>
            </span>
          </label>
        </fieldset>
        <details className="result-template">
          <summary>View the request template</summary>
          <pre>{template}</pre>
          <CopyButton text={template} label="Copy request" />
        </details>
        <div className="result-request-footer">
          <span>Appends to your draft. You send when ready.</span>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              appended.current = true;
              onOpenChange(false);
              onDraft(template);
            }}
          >
            Add request to draft
          </button>
        </div>
      </Modal>
    </>
  );
}
