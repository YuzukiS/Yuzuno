import { Component, useState, type ComponentType, type ReactNode } from "react";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import { ArrowDownToLine, Check, ChevronRight } from "lucide-react";
import { CopyButton, Yuzu } from "../components";
import { catalog, type ResultSpec } from "./spec";
import { ResultProvider, useResult } from "./ResultContext";
import { ResultTable } from "./ResultTable";
import { ResultChart } from "./ResultChart";
import { SourceLinks } from "./SourceLinks";
import { PublishedClarification } from "./ClarificationHost";
import { PublishedTaskStatus } from "./TaskStatusProposal";
import "./intelligent-ui.css";

function Continue({
  label,
  instruction,
  requiresSelection = false,
}: {
  label: string;
  instruction: string;
  requiresSelection?: boolean;
}) {
  const { onDraft, selection, title } = useResult();
  const [addedDraft, setAddedDraft] = useState<string | null>(null);
  const draft = `Regarding your interactive result “${title}”:\n${instruction}${selection.length ? `\n\nSelected:\n${selection.map((row) => `- ${row}`).join("\n")}` : ""}`;
  const added = addedDraft === draft;
  return (
    <div className="result-continue">
      <p>{instruction}</p>
      <div>
        <span>
          {selection.length
            ? `${selection.length} selected`
            : requiresSelection
              ? "Select an item to continue"
              : "Ready when you are"}
        </span>
        <button
          type="button"
          className="result-primary"
          disabled={!onDraft || (requiresSelection && !selection.length)}
          onClick={() => {
            onDraft?.(draft);
            setAddedDraft(draft);
          }}
        >
          {added ? <Check size={14} /> : <ArrowDownToLine size={14} />}
          {label}
        </button>
      </div>
      <small role="status">
        {added
          ? "Added to your draft. You can edit it before sending."
          : "Adds to your draft · you choose when to send"}
      </small>
    </div>
  );
}

/**
 * json-render's own element boundary renders a failing component as nothing
 * and only logs it. Each part is guarded here first, so a display error
 * leaves a visible note in place of that part and the rest still shows.
 */
class PartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="result-part-error" role="status">
        This part of the result couldn’t be displayed.
      </p>
    ) : (
      this.props.children
    );
  }
}
export function guarded<P extends object>(Part: ComponentType<P>): ComponentType<P> {
  return function Guarded(props: P) {
    return (
      <PartBoundary>
        <Part {...props} />
      </PartBoundary>
    );
  };
}

const parts = {
    Clarification: ({ props }) => <PublishedClarification form={props} />,
    Result: ({ props, children }) => (
      <div className="result-content">
        <header>
          <h3>{props.title}</h3>
          <p>{props.summary}</p>
        </header>
        {children}
      </div>
    ),
    Section: ({ props, children }) => (
      <section className="result-section">
        <h4>{props.title}</h4>
        {children}
      </section>
    ),
    Text: ({ props }) => <p className="result-text">{props.text}</p>,
    Metrics: ({ props }) => (
      <dl className="result-metrics">
        {props.items.map((item, index) => (
          <div key={index}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
            {item.detail && <small>{item.detail}</small>}
          </div>
        ))}
      </dl>
    ),
    Table: ({ props }) => <ResultTable {...props} />,
    BarChart: ({ props }) => <ResultChart {...props} />,
    Sources: ({ props }) => (
      <div className="result-source-list">
        <span>Sources</span>
        <SourceLinks ids={props.items.map((item) => item.id)} />
      </div>
    ),
    Continue: ({ props }) => <Continue {...props} />,
    TaskStatus: ({ props }) => <PublishedTaskStatus proposal={props} />,
} satisfies Parameters<typeof defineRegistry<typeof catalog>>[1]["components"];
const { registry } = defineRegistry(catalog, {
  components: Object.fromEntries(
    Object.entries(parts).map(([type, part]) => [type, guarded(part as ComponentType<object>)]),
  ) as typeof parts,
});
const noActions = Object.freeze({});

export default function InteractiveResult({
  spec,
  raw,
  identity,
  resultId,
  onFile,
  onDraft,
  onInteract,
}: {
  spec: ResultSpec;
  raw: string;
  identity: string;
  resultId?: string;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
}) {
  return (
    <div
      className="interactive-result"
      data-result-id={identity}
      onFocusCapture={onInteract}
      onPointerDownCapture={onInteract}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <details className="result-disclosure" open>
        <summary>
          <Yuzu size={19} />
          <span>Interactive result</span>
          <ChevronRight size={14} />
        </summary>
        <ResultProvider
          key={identity + raw}
          spec={spec}
          raw={raw}
          identity={identity}
          resultId={resultId}
          onFile={onFile}
          onDraft={onDraft}
        >
          <StateProvider initialState={{}}>
            <VisibilityProvider>
              <ActionProvider handlers={noActions}>
                <Renderer spec={spec} registry={registry} />
              </ActionProvider>
            </VisibilityProvider>
          </StateProvider>
        </ResultProvider>
        <details className="result-original">
          <summary>View result JSON</summary>
          <CopyButton text={raw} label="Copy result JSON" />
          <pre>{raw}</pre>
        </details>
      </details>
    </div>
  );
}
