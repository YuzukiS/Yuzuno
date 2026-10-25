import { Component, useMemo, type ComponentType, type ReactNode } from "react";
import {
  ActionProvider,
  Renderer,
  StateProvider,
  VisibilityProvider,
  type ComponentRegistry,
  type ComponentRenderProps,
} from "@json-render/react";
import { ResultProvider } from "../../intelligent-ui/ResultContext";
import { ResultTable } from "../../intelligent-ui/ResultTable";
import { SourceLinks } from "../../intelligent-ui/SourceLinks";
import type { ResultSpec } from "../../intelligent-ui/contract.ts";
import type { Section } from "../types";
import { BriefContext, type BriefContextValue } from "./BriefContext";
import { BriefMarkdown } from "./Markdown";
import { BriefMath } from "./Math";
import { BriefChecklist, BriefColumns, BriefFindings, BriefGroup, BriefMetrics, BriefPlan } from "./Blocks";
import { BriefBarChart, BriefLineChart, BriefScatterChart } from "./Charts";
import { BriefLiveRefs } from "./LiveRefs";
import { BriefAttachments } from "./AttachmentView";
import type { BlockChanges } from "./block-changes";
import { briefText } from "./brief-text";
import { useStrings } from "../../i18n";
import { recordError } from "../../diagnostics";
import {
  CHART_TYPES,
  isBriefSpec,
  type BriefSpec,
  type BriefTableProps,
  type SourcesProps,
} from "./brief-catalog";
import "../../intelligent-ui/intelligent-ui.css";
import "./brief.css";

/**
 * One failing part shows a note in its place and the rest of the section
 * still shows, as in interactive results.
 */
class PartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Unreadable /> : this.props.children;
  }
}
function Unreadable() {
  const t = useStrings(briefText);
  return (
    <p className="result-part-error" role="status">
      {t.partUnreadable}
    </p>
  );
}
function SectionUnreadable() {
  const t = useStrings(briefText);
  return (
    <div className="brief-body">
      <p className="result-part-error" role="status">
        {t.sectionUnreadable}
      </p>
    </div>
  );
}
type Drawn = { section: Section; changes?: BlockChanges | null; children: ReactNode };
/**
 * A section that can't be drawn at all, outside any one block (its result
 * provider refusing the body, say), says so in its place: the rest of Home
 * and the app still show. Its next body or marks are tried again.
 */
class SectionBoundary extends Component<Drawn, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    recordError("section", error);
  }
  componentDidUpdate(previous: Drawn) {
    if (this.state.failed && (previous.section !== this.props.section || previous.changes !== this.props.changes))
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <SectionUnreadable /> : this.props.children;
  }
}
/** The prop BriefSectionBody gives a block that changed since the seen version. */
const CHANGE = "yuzunoChange";
function part<P extends object>(Part: ComponentType<P>): ComponentType<ComponentRenderProps> {
  return function Guarded({ element, children }: ComponentRenderProps) {
    const { [CHANGE]: change, ...props } = element.props as Record<string, unknown>;
    const shown = (
      <PartBoundary>
        <Part {...(props as P)}>{children}</Part>
      </PartBoundary>
    );
    if (change !== "new" && change !== "updated") return shown;
    // A plain group keeps the rule that sets it apart from the block before.
    const rule = element.type === "Group" && (!props.tone || props.tone === "plain");
    return (
      <ChangeMark change={change} rule={rule}>
        {shown}
      </ChangeMark>
    );
  };
}

/** The mark on a block changed since the seen version, in the interface language. */
function ChangeMark({ change, rule, children }: { change: "new" | "updated"; rule: boolean; children: ReactNode }) {
  const [label, title] = useStrings(briefText).change[change];
  return (
    <div className="brief-change" data-change={change} data-rule={rule || undefined}>
      <span className="brief-change-mark" title={title}>
        {label}
      </span>
      {children}
    </div>
  );
}

// Display only: no component here starts anything. Links open pages and
// references open the panels the app already has; nothing an Agent wrote
// can call an API.
const registry: ComponentRegistry = {
  BriefBody: part(({ children }: { children?: ReactNode }) => <div className="brief-root">{children}</div>),
  Group: part(BriefGroup),
  Columns: part(BriefColumns),
  Markdown: part(BriefMarkdown),
  Math: part(BriefMath),
  Checklist: part(BriefChecklist),
  Plan: part(BriefPlan),
  Findings: part(BriefFindings),
  Metrics: part(BriefMetrics),
  // Selection only feeds a Continue draft, which a Brief does not have.
  Table: part((props: BriefTableProps) => <ResultTable {...props} selectable={false} />),
  LineChart: part(BriefLineChart),
  BarChart: part(BriefBarChart),
  ScatterChart: part(BriefScatterChart),
  LiveRefs: part(BriefLiveRefs),
  Attachments: part(BriefAttachments),
  Sources: part(BriefSources),
};
const noActions = Object.freeze({});
function BriefSources(props: SourcesProps) {
  const t = useStrings(briefText);
  return (
    <div className="result-source-list">
      <span>{t.sources}</span>
      <SourceLinks ids={props.items.map((item) => item.id)} />
    </div>
  );
}

/**
 * Tables and source links come from interactive results and read their
 * sources and view state (filter, sort) from a ResultProvider. This gives
 * them one: a Result root titled after the section, plus the section's
 * Sources, which is all the provider reads.
 */
function resultShim(spec: BriefSpec, title: string): ResultSpec {
  const elements: Record<string, unknown> = {
    root: { type: "Result", props: { title: title.slice(0, 160) || "Brief", summary: "" } },
  };
  // A change mark is the block's own frame: the provider reads the Sources
  // as the contract has them, which allows no other prop.
  Object.values(spec.elements)
    .filter((node) => node?.type === "Sources")
    .forEach((node, index) => {
      const { [CHANGE]: _mark, ...props } = node.props ?? {};
      elements[`sources${index}`] = { ...node, props };
    });
  return { root: "root", elements } as ResultSpec;
}

type BodyProps = {
  section: Section;
  projectId: string;
  /** Blocks to mark as new or changed since the version the user marked seen. */
  changes?: BlockChanges | null;
  onOpenAgent?: (agentId: string) => void;
  onOpenMachine?: (machineId: string) => void;
};

/**
 * A Brief section's body, drawn by Yuzuno from the components the Agent
 * chose. Charts and attachments are read from this Core only, for this
 * project and section.
 */
export function BriefSectionBody(props: BodyProps) {
  return (
    <SectionBoundary section={props.section} changes={props.changes}>
      <SectionBodyParts {...props} />
    </SectionBoundary>
  );
}

function SectionBodyParts({ section, projectId, changes, onOpenAgent, onOpenMachine }: BodyProps) {
  const spec = useMemo(() => {
    if (!isBriefSpec(section.body)) return null;
    // A chart's data is asked for by its element id, which json-render does
    // not pass to components; give it to charts as a prop. Titles an Agent
    // may leave out get the contract's display defaults, should Core have
    // kept a body as it was sent.
    // A block that changed since the seen version is marked the same way;
    // the mark is Yuzuno's alone, whatever a body may carry under its name.
    const elements = Object.fromEntries(
      Object.entries(section.body.elements).map(([key, given]) => {
        const change = changes?.get(key);
        const node =
          given && (change || (given.props && CHANGE in given.props))
            ? { ...given, props: { ...given.props, [CHANGE]: change } }
            : given;
        if (node?.type === "Table" && node.props?.title === undefined)
          return [key, { ...node, props: { ...node.props, title: "Table" } }];
        if (!CHART_TYPES.has(node?.type)) return [key, node];
        return [key, { ...node, props: { title: "Chart", ...node.props, elementKey: key } }];
      }),
    );
    return { ...section.body, elements };
  }, [section.body, changes]);
  // A table's filter and sort are kept against that table alone: an Agent
  // editing another block of the section, or the user marking it seen,
  // leaves them as the user set them.
  const tables = useMemo(
    () =>
      Object.fromEntries(
        Object.values(spec?.elements ?? {})
          .filter((node) => node?.type === "Table")
          .map((node) => {
            const { [CHANGE]: _mark, ...props } = node.props;
            return [String(node.props.id), JSON.stringify({ ...node, props })];
          }),
      ),
    [spec],
  );
  const shim = useMemo(() => (spec ? resultShim(spec, section.title) : null), [spec, section.title]);
  const context = useMemo<BriefContextValue>(
    () => ({ projectId, section, onOpenAgent, onOpenMachine }),
    [projectId, section, onOpenAgent, onOpenMachine],
  );
  if (!spec || !shim)
    return (
      <div className="brief-body">
        <p className="result-part-error" role="status">
          This section couldn't be displayed.
        </p>
      </div>
    );
  return (
    <div className="brief-body" data-section={section.key}>
      <BriefContext.Provider value={context}>
        <ResultProvider spec={shim} blocks={tables} identity={`brief:${projectId}:${section.key}`}>
          <StateProvider initialState={{}}>
            <VisibilityProvider>
              <ActionProvider handlers={noActions}>
                <Renderer spec={spec} registry={registry} fallback={Unreadable} />
              </ActionProvider>
            </VisibilityProvider>
          </StateProvider>
        </ResultProvider>
      </BriefContext.Provider>
    </div>
  );
}

export default BriefSectionBody;
