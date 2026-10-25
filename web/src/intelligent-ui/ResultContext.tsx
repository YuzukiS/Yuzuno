import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ResultSpec, Source } from "./spec";
import { componentProps } from "./spec";
import {
  readViews,
  saveViews,
  resultFingerprint,
  VIEW_PREFIX,
  type Views,
  type ViewState,
} from "./view-storage";
export type { ViewState } from "./view-storage";

export const emptyView: ViewState = { selected: [], filter: "", sort: [] };
type ResultContextValue = {
  identity: string;
  resultId?: string;
  views: Views;
  update: (id: string, patch: Partial<ViewState>) => void;
  sources: Source[];
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
  selection: string[];
  title: string;
};
const Context = createContext<ResultContextValue | null>(null);
export function useResult() {
  return useContext(Context)!;
}

/**
 * View state (filter, sort, selection) is kept against a fingerprint, so a
 * changed result does not inherit a view meant for other content. An
 * interactive result is one whole (raw). A Brief section changes block by
 * block, so it passes blocks instead: each view's id mapped to the content
 * of the block it belongs to, kept under its own key and fingerprint, so an
 * edit to one block leaves every other block's view as the user set it.
 */
export function ResultProvider({
  spec,
  raw = "",
  blocks,
  identity,
  resultId,
  onFile,
  onDraft,
  children,
}: {
  spec: ResultSpec;
  raw?: string;
  blocks?: Record<string, string>;
  identity: string;
  resultId?: string;
  children: ReactNode;
  onFile?: (path: string, line?: number) => void;
  onDraft?: (text: string) => void;
}) {
  const key = `${VIEW_PREFIX}${identity}`;
  const fingerprint = useMemo(() => resultFingerprint(raw), [raw]);
  const prints = useMemo(
    () =>
      blocks &&
      Object.fromEntries(Object.entries(blocks).map(([id, content]) => [id, resultFingerprint(content)])),
    [blocks],
  );
  const saved = (at: string): Views => {
    const under = `${VIEW_PREFIX}${at}`;
    if (!prints) return readViews(under, fingerprint);
    const kept: Views = {};
    for (const [id, print] of Object.entries(prints)) {
      const view = readViews(`${under}#${id}`, print)[id];
      if (view) kept[id] = view;
    }
    return kept;
  };
  const [views, setViews] = useState<Views>(() => saved(identity));
  // A live update keeps this provider mounted: a block that changed or is
  // gone drops its view here too, and every other view stays as it is.
  const [drawn, setDrawn] = useState(prints);
  // So does the Core at this address answering as another Workspace, which
  // changes the identity under it (T-195). These views are then the identity
  // before's: they are read again for this one rather than kept in memory
  // and saved under its key by the next change to them.
  const [shownFor, setShownFor] = useState(identity);
  if (shownFor !== identity) {
    setShownFor(identity);
    setViews(saved(identity));
    setDrawn(prints);
  } else if (prints && drawn && prints !== drawn) {
    setDrawn(prints);
    const stale = Object.keys(views).filter((id) => prints[id] !== drawn[id]);
    if (stale.length)
      setViews((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !stale.includes(id))));
  }
  const sources: Source[] = [];
  const selection: string[] = [];
  for (const node of Object.values(spec.elements)) {
    if (node.type === "Sources")
      sources.push(...componentProps.Sources.parse(node.props).items);
    if (node.type === "Table") {
      const props = componentProps.Table.parse(node.props);
      if (props.selectable)
        for (const row of props.rows) {
          if (views[props.id]?.selected.includes(row.id))
            selection.push(
              `${props.title}: ${props.columns.map((c) => `${c.label}: ${row.cells[c.key] ?? "—"}`).join("; ")}`,
            );
        }
    }
    if (node.type === "BarChart") {
      const props = componentProps.BarChart.parse(node.props);
      for (const row of props.data)
        if (views[props.id]?.selected.includes(row.id))
          selection.push(
            `${props.title}: ${row.label} — ${row.value} ${props.unit}`,
          );
    }
  }
  const title = componentProps.Result.parse(
    spec.elements[spec.root].props,
  ).title;
  const update = (id: string, patch: Partial<ViewState>) =>
    setViews((current) => {
      const next = {
        ...current,
        [id]: { ...(current[id] || emptyView), ...patch },
      };
      if (!prints) saveViews(key, fingerprint, next);
      else if (prints[id]) saveViews(`${key}#${id}`, prints[id], { [id]: next[id] });
      return next;
    });
  return (
    <Context.Provider
      value={{ identity, resultId, views, update, sources, onFile, onDraft, selection, title }}
    >
      {children}
    </Context.Provider>
  );
}
