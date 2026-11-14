import { Children, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStrings } from "../../i18n";
import { useBrief } from "./BriefContext";
import { briefText } from "./brief-text";
import type { BriefElement, TabsProps } from "./brief-catalog";
import "./tabs.css";

/** A Tabs page as its tab names it: its Group's title, and how many items its one Collection lists. */
export type TabPage = { key: string; title: string; count: number | null };

/**
 * The pages of a Tabs (YN-113 R6), from the body the contract accepted:
 * each child is a titled Group, whose title is its tab. A page whose Group
 * holds exactly one Collection among its own blocks counts that Collection's
 * items on its tab (e.g. Papers 14); any other page has no number.
 */
export function tabPages(elements: Readonly<Record<string, BriefElement | undefined>>, key: string): TabPage[] {
  return (elements[key]?.children ?? []).map((child) => {
    const page = elements[child];
    const title = typeof page?.props?.title === "string" ? page.props.title : "";
    const lists = (page?.children ?? []).map((id) => elements[id]).filter((node) => node?.type === "Collection");
    const items = lists.length === 1 ? lists[0]?.props?.items : undefined;
    return { key: child, title, count: Array.isArray(items) ? items.length : null };
  });
}

/** The prop BriefSectionBody gives a Tabs: its pages, in its children's order. */
export const TAB_PAGES = "yuzunoPages";

/**
 * Pages the reader switches between, as the WAI-ARIA tabs pattern has them:
 * a tablist of one tab per page, the chosen one in the Tab order; Left and
 * Right move to the previous and next tab, round the ends, and show its page
 * at once; Home and End go to the first and the last. Each page is a
 * tabpanel named by its tab; the others stay drawn but hidden, so what the
 * reader set in one (a table's filter, a walk's step) is still there when
 * they come back. A row of tabs too wide for the window scrolls sideways.
 * The first page shows first, and again with each version: which page was
 * open is not kept, as the report's folds are not.
 */
export function BriefTabs(props: TabsProps & { [TAB_PAGES]?: TabPage[]; children?: ReactNode }) {
  const { label, children } = props;
  const pages = props[TAB_PAGES] ?? [];
  const t = useStrings(briefText);
  const { section } = useBrief();
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const version = `${section.key}\n${section.version}`;
  const [open, setOpen] = useState({ version, index: 0 });
  const count = pages.length;
  const index = open.version === version && open.index < count ? open.index : 0;
  const choose = (to: number) => setOpen({ version, index: to });
  const keys = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const to =
      event.key === "ArrowRight" ? (at + 1) % count
      : event.key === "ArrowLeft" ? (at - 1 + count) % count
      : event.key === "Home" ? 0
      : event.key === "End" ? count - 1
      : null;
    if (to === null || count === 0) return;
    event.preventDefault();
    choose(to);
    tabs.current[to]?.focus();
  };
  const tabId = (at: number) => `${base}-tab-${at}`;
  const panelId = (at: number) => `${base}-panel-${at}`;
  return (
    <div className="brief-tabs">
      <div className="brief-tablist" role="tablist" aria-label={label || t.tabs}>
        {pages.map((page, at) => (
          <button
            key={page.key}
            ref={(node) => {
              tabs.current[at] = node;
            }}
            type="button"
            role="tab"
            id={tabId(at)}
            className="brief-tab"
            aria-selected={at === index}
            aria-controls={panelId(at)}
            tabIndex={at === index ? 0 : -1}
            onClick={() => choose(at)}
            onKeyDown={(event) => keys(event, at)}
          >
            {page.title}
            {page.count !== null && <span className="brief-tab-count">{page.count}</span>}
          </button>
        ))}
      </div>
      {/* json-render gives the pages in the children's order, one each. */}
      {Children.map(children, (child, at) => (
        <div
          className="brief-tabpanel"
          role="tabpanel"
          id={panelId(at)}
          aria-labelledby={tabId(at)}
          tabIndex={0}
          hidden={at !== index}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
