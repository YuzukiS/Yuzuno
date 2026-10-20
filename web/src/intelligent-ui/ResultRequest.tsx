import { useRef, useState } from "react";
import { ChartColumn, Columns3, Shapes } from "lucide-react";
import { CopyButton, Modal, Yuzu } from "../components";
import { interactiveRequest } from "./examples";
import "./intelligent-ui.css";

export function ResultRequest({
  onDraft,
}: {
  onDraft: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"comparison" | "report">("comparison");
  const appended = useRef(false);
  const template = interactiveRequest(kind);
  return (
    <>
      <button
        type="button"
        className="result-request-button composer-tool"
        title="Ask for an interactive result: a table or chart you can explore"
        aria-label="Ask for an interactive result"
        onClick={() => {
          appended.current = false;
          setOpen(true);
        }}
      >
        <Shapes size={15} />
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="A result you can explore"
        description="Add a request to your draft. Your agent can include a table or chart with its reply."
        onCloseAutoFocus={(event) => {
          if (appended.current) event.preventDefault();
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
              setOpen(false);
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
