import { Component, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import { ArrowDownToLine, Check, ChevronRight, LoaderCircle } from "lucide-react";
import { CopyButton, Yuzu } from "../components";
import { catalog, type ResultSpec } from "./spec";
import { ResultProvider, useResult } from "./ResultContext";
import { ResultTable } from "./ResultTable";
import { ResultChart } from "./ResultChart";
import { SourceLinks } from "./SourceLinks";
import { PublishedClarification } from "./ClarificationHost";
import { PublishedTaskStatus } from "./TaskStatusProposal";
import { resultText } from "./result-text";
import { RESERVE_HEIGHT } from "./result-reserve";
import { PENDING, type PendingKind } from "./stream";
import { useStrings } from "../i18n";
import { useSurfaceIn } from "../surface";
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
  const t = useStrings(resultText);
  const { onDraft, selection, title } = useResult();
  const [addedDraft, setAddedDraft] = useState<string | null>(null);
  const draft = `Regarding your interactive result “${title}”:\n${instruction}${selection.length ? `\n\nSelected:\n${selection.map((row) => `- ${row}`).join("\n")}` : ""}`;
  const added = addedDraft === draft;
  return (
    <div className="result-continue">
      <p>{instruction}</p>
      <div>
        <span>
          {selection.length ? t.selected(selection.length) : requiresSelection ? t.selectFirst : t.ready}
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
        {added ? t.added : t.adds}
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
      <PartFailed />
    ) : (
      this.props.children
    );
  }
}
function PartFailed() {
  const t = useStrings(resultText);
  return (
    <p className="result-part-error" role="status">
      {t.partFailed}
    </p>
  );
}
function SourcesPart({ ids }: { ids: string[] }) {
  const t = useStrings(resultText);
  return (
    <div className="result-source-list">
      <span>{t.sources}</span>
      <SourceLinks ids={ids} />
    </div>
  );
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
    Sources: ({ props }) => <SourcesPart ids={props.items.map((item) => item.id)} />,
    Continue: ({ props }) => <Continue {...props} />,
    TaskStatus: ({ props }) => <PublishedTaskStatus proposal={props} />,
} satisfies Parameters<typeof defineRegistry<typeof catalog>>[1]["components"];
const { registry } = defineRegistry(catalog, {
  components: Object.fromEntries(
    Object.entries(parts).map(([type, part]) => [type, guarded(part as ComponentType<object>)]),
  ) as typeof parts,
});
const noActions = Object.freeze({});

/** A part still being written (YN-15): the room its kind keeps, nothing of
 * what it will hold. Never from the Agent: see stream.ts, PENDING. */
function PendingPart({ element }: { element: { props: { kind?: PendingKind } } }) {
  const kind = element.props.kind ?? "line";
  return (
    <div
      className="result-pending"
      data-kind={kind}
      aria-hidden="true"
      style={kind === "line" ? undefined : { minHeight: RESERVE_HEIGHT[kind] }}
    />
  );
}
/** The parts, and placeholders for what is still being written. */
const liveRegistry = { ...registry, [PENDING]: PendingPart };

export default function InteractiveResult({
  spec,
  raw,
  identity,
  resultId,
  onFile,
  onDraft,
  onInteract,
  arrival,
  live = false,
  streamed = false,
}: {
  spec: ResultSpec;
  raw: string;
  identity: string;
  resultId?: string;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  onInteract?: () => void;
  arrival?: { readonly current: boolean };
  /** Its block is still being written: drawn as far as it is, and inert. */
  live?: boolean;
  /** Drawn while its block was written: kept as it grows and closes. */
  streamed?: boolean;
}) {
  const t = useStrings(resultText);
  // Taking the place of a placeholder, it fades in over small, opacity only,
  // so nothing in it moves (T-19 HM:I5, M9). One drawn at once does not.
  const root = useRef<HTMLDivElement>(null);
  const [arrived] = useState(() => !!arrival?.current);
  useSurfaceIn(root, arrived ? 1 : 0, "small", arrived);
  return (
    <div
      ref={root}
      className="interactive-result"
      data-result-id={identity}
      // Nothing in it can be used before the whole of it is checked (YN-15).
      data-live={live ? "" : undefined}
      aria-busy={live || undefined}
      inert={live}
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
          <span>{t.title}</span>
          {live && (
            <span className="result-live" role="status">
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
              {t.placeholder.generating}
            </span>
          )}
          <ChevronRight size={14} />
        </summary>
        <ResultProvider
          key={identity + (streamed ? "" : raw)}
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
                <Renderer spec={spec} registry={live ? liveRegistry : registry} loading={live} />
              </ActionProvider>
            </VisibilityProvider>
          </StateProvider>
        </ResultProvider>
        {!live && (
          <details className="result-original">
            <summary>{t.viewJson}</summary>
            <CopyButton text={raw} label={t.copy} />
            <pre>{raw}</pre>
          </details>
        )}
      </details>
    </div>
  );
}
