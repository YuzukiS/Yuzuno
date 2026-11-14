import { Component, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ComponentType, type ReactNode } from "react";
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
import { CardFoldWorkspace } from "../card-fold";
import { BriefMarkdown } from "./Markdown";
import { BriefMath } from "./Math";
import { BriefChecklist, BriefColumns, BriefFindings, BriefGroup, BriefMetrics, BriefPlan } from "./Blocks";
import { BriefBarChart, BriefLineChart, BriefScatterChart } from "./Charts";
import { BriefLiveRefs } from "./LiveRefs";
import { BriefAttachments } from "./AttachmentView";
import { BriefResearchDesk } from "./ResearchDesk";
import { BriefNumberInput, BriefSegmented, BriefSwitch } from "./Inputs";
import { BriefButton, BriefCalc, type Press } from "./Calc";
import { BriefDiagram } from "./Diagram";
import { BriefFigure } from "./Figure";
import { BriefSteps, BriefTimeline } from "./Steps";
import { BriefCollection } from "./Collection";
import { BriefTabs, TAB_PAGES, tabPages } from "./Tabs";
import { VARIABLE_NAME } from "../../intelligent-ui/brief-inputs.ts";
import { useSectionStore } from "./brief-state";
import { useBriefDensity } from "../home-density";
import type { BlockChanges } from "./block-changes";
import { briefText } from "./brief-text";
import { useStrings } from "../../i18n";
import { recordError } from "../../diagnostics";
import {
  CHART_TYPES,
  isBriefSpec,
  type BriefSpec,
  type BriefTableProps,
  type CollectionProps,
  type SourcesProps,
} from "./brief-catalog";
import "../../intelligent-ui/intelligent-ui.css";
import "./brief.css";
import { Tip, TipText } from "../../Tip";

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
/**
 * What a body showed once drawn (YN-86): real content in at least one of its
 * blocks ("drawn"); nothing but the note of each block it could not draw, an
 * unknown component's or a failed one's ("fallback"); or nothing at all, the
 * whole section refused ("failed").
 */
export type BodyDrawn = "drawn" | "fallback" | "failed";
/** Blocks that only lay others out: drawing them shows none of the body's content. */
const LAYOUT_PARTS = new Set(["BriefBody", "Group", "Columns", "Tabs"]);
/** How many of one body's content blocks are drawn and still shown: each counts itself while it stands. */
type Tally = { shown: number };
const DrawTally = createContext<Tally | null>(null);
/** Stands beside a content block inside its boundary: there only while the block drew. */
function Drew() {
  const tally = useContext(DrawTally);
  useLayoutEffect(() => {
    if (!tally) return;
    tally.shown += 1;
    return () => {
      tally.shown -= 1;
    };
  }, [tally]);
  return null;
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
type Drawn = { section: Section; changes?: BlockChanges | null; onDrawn?: (drawn: BodyDrawn) => void; children: ReactNode };
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
    this.props.onDrawn?.("failed");
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
    // A content block that drew counts itself (YN-86); one that fails shows only its note, and does not.
    const shown = (
      <PartBoundary>
        <Part {...(props as P)}>{children}</Part>
        {!LAYOUT_PARTS.has(element.type) && <Drew />}
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
      <Tip content={<TipText body={title} />}>
        <span className="brief-change-mark">
          {label}
        </span>
      </Tip>
      {children}
    </div>
  );
}

/** Rows a Home table shows before "Show all" (T-9): the card reads as part of
 * the page, which the wheel and touch scroll, never a box of its own. */
export const TABLE_ROWS = { high: 8, low: 5 } as const;

function BriefTable(props: BriefTableProps) {
  const density = useBriefDensity();
  // Selection only feeds a Continue draft, which a Brief does not have.
  return <ResultTable {...props} selectable={false} pageSize={TABLE_ROWS[density]} />;
}

// Display only: no component here starts anything. Links open pages and
// references open the panels the app already has; nothing an Agent wrote
// can call an API. Inputs (YN-16) write their own variable in the store of
// the place that shows the section, which blocks' visible conditions read.
const registry: ComponentRegistry = {
  BriefBody: part(({ children }: { children?: ReactNode }) => <div className="brief-root">{children}</div>),
  Group: part(BriefGroup),
  Columns: part(BriefColumns),
  Tabs: part(BriefTabs),
  Markdown: part(BriefMarkdown),
  Math: part(BriefMath),
  Checklist: part(BriefChecklist),
  Plan: part(BriefPlan),
  Findings: part(BriefFindings),
  Metrics: part(BriefMetrics),
  Table: part(BriefTable),
  LineChart: part(BriefLineChart),
  BarChart: part(BriefBarChart),
  ScatterChart: part(BriefScatterChart),
  LiveRefs: part(BriefLiveRefs),
  Attachments: part(BriefAttachments),
  Sources: part(BriefSources),
  ResearchDesk: part(BriefResearchDesk),
  NumberInput: part(BriefNumberInput),
  Switch: part(BriefSwitch),
  Segmented: part(BriefSegmented),
  Calc: part(BriefCalc),
  Button: part(BriefButton),
  Diagram: part(BriefDiagram),
  Figure: part(BriefFigure),
  Steps: part(BriefSteps),
  Timeline: part(BriefTimeline),
  // Drawn whole, as on its page: only Home's card gives it a face (SummaryCard.tsx).
  Collection: part((props: CollectionProps) => <BriefCollection {...props} face={undefined} />),
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

/** The prop BriefSectionBody gives a Button: what its press sets (YN-16 S2). */
const PRESS = "yuzunoPress";

/** A Button's press as setState actions of variables, each `{statePath: "/name", value}`; anything else is left out. */
function pressOf(on: unknown): Press {
  const press = on && typeof on === "object" && !Array.isArray(on) ? (on as { press?: unknown }).press : undefined;
  const actions: unknown[] = Array.isArray(press) ? press : press === undefined ? [] : [press];
  return actions.flatMap((action) => {
    const { action: kind, params } = (action && typeof action === "object" ? action : {}) as { action?: unknown; params?: { statePath?: unknown; value?: unknown } };
    const path = params?.statePath;
    const value = params?.value;
    const fits = typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    return kind === "setState" && typeof path === "string" && VARIABLE_NAME.test(path.slice(1)) && path.startsWith("/") && fits
      ? [{ statePath: path, value: value as Press[number]["value"] }]
      : [];
  });
}

/** An element as the contract keeps it: its type, props, children and visible condition; a Button's press as its own prop. */
function keptElement({ type, props, children, visible, on }: BriefSpec["elements"][string]) {
  const { [PRESS]: _given, ...own } = props ?? {};
  return {
    type,
    props: type === "Button" ? { ...own, [PRESS]: pressOf(on) } : own,
    ...(children === undefined ? {} : { children }),
    ...(visible === undefined ? {} : { visible }),
  };
}

type BodyProps = {
  section: Section;
  projectId: string;
  /** Blocks to mark as new or changed since the version the user marked seen. */
  changes?: BlockChanges | null;
  onOpenAgent?: (agentId: string) => void;
  onOpenMachine?: (machineId: string) => void;
  /** Only these top-level blocks, in this order (T-18: a report's summary
   * and its parts): the same elements and renderers as the whole body. */
  only?: readonly string[];
  /**
   * Told what the body showed once drawn (BodyDrawn), again for each new
   * section or marks (YN-86): "drawn" while at least one content block drew
   * (others may show their notes); "fallback" when every content block is
   * an unknown component's or a failed one's note; "failed" when it could
   * not be drawn at all. Files and chart data still on their way are not
   * waited for.
   */
  onDrawn?: (drawn: BodyDrawn) => void;
};

/**
 * A Brief section's body, drawn by Yuzuno from the components the Agent
 * chose. Charts and attachments are read from this Core only, for this
 * project and section.
 */
export function BriefSectionBody(props: BodyProps) {
  return (
    <SectionBoundary section={props.section} changes={props.changes} onDrawn={props.onDrawn}>
      <SectionBodyParts {...props} />
    </SectionBoundary>
  );
}

function SectionBodyParts({ section, projectId, changes, onOpenAgent, onOpenMachine, only, onDrawn }: BodyProps) {
  // Home's own Workspace, from the context its cards already read, so no
  // call site has to pass it (T-195).
  const workspaceId = useContext(CardFoldWorkspace);
  const shownOnly = only?.join("\n");
  const spec = useMemo(() => {
    if (!isBriefSpec(section.body)) return null;
    const stored = section.body.elements;
    // A chart's data is asked for by its element id, which json-render does
    // not pass to components; give it to charts as a prop. Titles an Agent
    // may leave out get the contract's display defaults, should Core have
    // kept a body as it was sent.
    // A block that changed since the seen version is marked the same way;
    // the mark is Yuzuno's alone, whatever a body may carry under its name.
    const elements = Object.fromEntries(
      Object.entries(section.body.elements).map(([key, given]) => {
        const change = changes?.get(key);
        // What json-render would also run from an element (YN-16): event
        // bindings, watches and repeats. A body keeps its type, props,
        // children and visible condition only; a Button's press is read here,
        // as setState of its section's variables and nothing else, and
        // Yuzuno's Button runs it (Calc.tsx), never json-render's actions.
        const kept = given && (given.type === "Button" || PRESS in (given.props ?? {}) || "on" in given || "watch" in given || "repeat" in given)
          ? keptElement(given)
          : given;
        const node =
          kept && (change || (kept.props && CHANGE in kept.props))
            ? { ...kept, props: { ...kept.props, [CHANGE]: change } }
            : kept;
        if (node?.type === "Table" && node.props?.title === undefined)
          return [key, { ...node, props: { ...node.props, title: "Table" } }];
        // A research desk reads its numbers and keeps its selection by its id (T-9).
        if (node?.type === "ResearchDesk") return [key, { ...node, props: { ...node.props, elementKey: key } }];
        // A Tabs names its pages on its tabs (YN-113 R6), from its own children's Groups.
        if (node?.type === "Tabs") return [key, { ...node, props: { ...node.props, [TAB_PAGES]: tabPages(stored, key) } }];
        if (!CHART_TYPES.has(node?.type)) return [key, node];
        return [key, { ...node, props: { title: "Chart", ...node.props, elementKey: key } }];
      }),
    );
    if (shownOnly !== undefined) {
      const root = elements[section.body.root];
      const top = new Set(root?.children ?? []);
      const children = shownOnly ? shownOnly.split("\n").filter((id) => top.has(id)) : [];
      elements[section.body.root] = { ...root, children };
    }
    return { ...section.body, elements };
  }, [section.body, changes, shownOnly]);
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
  const store = useSectionStore(section);
  const context = useMemo<BriefContextValue>(
    () => ({ projectId, section, onOpenAgent, onOpenMachine }),
    [projectId, section, onOpenAgent, onOpenMachine],
  );
  // After this body and every block in it committed, their counts made in
  // the layout phase before: a failure that reached SectionBoundary commits
  // none of it, and says so there instead.
  const tally = useRef<Tally>({ shown: 0 }).current;
  const drawable = !!spec && !!shim;
  useEffect(() => {
    onDrawn?.(!drawable ? "failed" : tally.shown > 0 ? "drawn" : "fallback");
  }, [onDrawn, drawable, section, changes, tally]);
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
        {/* How a table here is sorted and what is ticked in it is kept per
            Workspace (T-195): two Workspaces at one address can have the same
            project and section ids, and one window's view of a table is not
            the other's. Home already gives its cards the Workspace
            (card-fold.tsx), "" where it has none -- an identity no Workspace
            claims, never read as one's. */}
        <ResultProvider spec={shim} blocks={tables} identity={`brief:${workspaceId}:${projectId}:${section.key}`}>
          <StateProvider store={store}>
            <VisibilityProvider>
              <ActionProvider handlers={noActions}>
                <DrawTally.Provider value={tally}>
                  <Renderer spec={spec} registry={registry} fallback={Unreadable} />
                </DrawTally.Provider>
              </ActionProvider>
            </VisibilityProvider>
          </StateProvider>
        </ResultProvider>
      </BriefContext.Provider>
    </div>
  );
}

export default BriefSectionBody;
