import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * Which form each status bar item shows when the bar has no room for all of
 * them in full (YN-75). Nothing is cut in the middle of its words: an item
 * gives way by turns, the least important first, to a shorter form, then to
 * the overflow list behind "⋯". Widths are measured, never assumed from the
 * window's width, so the same rule holds for every language and text size.
 *
 * This follows Fluent UI's priority overflow (lower priority overflows first,
 * an overflow menu holds what did not fit: microsoft/fluentui
 * packages/react-components/priority-overflow), with one step before it:
 * shorter forms. VS Code's bar orders items by priority but drops the ones
 * that no longer fit with no way to reach them (microsoft/vscode
 * statusbarpart.css), which is what this avoids.
 */
export type Form = "full" | "compact" | "icon" | "hidden";
/**
 * news: what has to be read now, said once (a notice, a warning, a limit
 * reached); work: what is going on (reviews, CI runs); metric: what stays
 * the same most of the time (plan usage, RAM, machines).
 */
export type Tier = "news" | "work" | "metric";
export type FitItem = {
  id: string;
  side: "start" | "end";
  tier: Tier;
  /** Within its tier, a lower rank gives way first. 1–99. */
  rank: number;
  /** The shorter forms it has, besides full. */
  forms: readonly ("compact" | "icon")[];
};
export type FitRoom = {
  /** The bar's width inside its padding. */
  available: number;
  /** Between items on one side. */
  gap: number;
  /** Between the two sides. */
  sideGap: number;
  /** The "⋯" button, shown when anything is in the overflow list. */
  overflow: number;
};

const weight: Record<Tier, number> = { news: 300, work: 200, metric: 100 };
/** How much an item matters: a higher number gives way later and gets its words back first. */
export const importance = (item: FitItem) => weight[item.tier] + item.rank;

/**
 * The order things give way in: metrics shorten, work shortens, metrics
 * move out, news shortens, work moves out, news goes to its shortest. News
 * never moves out: a notice or a warning that is behind "⋯" is not said.
 */
export function giveWaySteps(items: readonly FitItem[]): [string, Form][] {
  const tier = (name: Tier) => items.filter((i) => i.tier === name).sort((a, b) => a.rank - b.rank);
  const steps: [string, Form][] = [];
  const add = (name: Tier, form: Exclude<Form, "full">) => {
    for (const i of tier(name)) if (form === "hidden" || i.forms.includes(form)) steps.push([i.id, form]);
  };
  add("metric", "compact");
  add("metric", "icon");
  add("work", "compact");
  add("work", "icon");
  add("metric", "hidden");
  add("news", "compact");
  add("work", "hidden");
  add("news", "icon");
  return steps;
}

/**
 * Each item's form for the room there is. `width(id, form)` is what that
 * form measured. Steps are taken in order until everything fits; then, most
 * important first, an item gets its last step back while everything still
 * fits, and the first one that does not ends it, so a less important item
 * never says more than a more important one only because it is narrower.
 * When even every step does not make it fit, the result is the last step's.
 */
export function fitForms(items: readonly FitItem[], width: (id: string, form: Form) => number, room: FitRoom): Record<string, Form> {
  const forms: Record<string, Form> = Object.fromEntries(items.map((i) => [i.id, "full" as Form]));
  const total = () => {
    const side = (name: "start" | "end") => {
      const widths = items.filter((i) => i.side === name && forms[i.id] !== "hidden").map((i) => width(i.id, forms[i.id]));
      if (name === "end" && items.some((i) => forms[i.id] === "hidden")) widths.push(room.overflow);
      return widths.length ? widths.reduce((a, b) => a + b, 0) + room.gap * (widths.length - 1) : 0;
    };
    const start = side("start");
    const end = side("end");
    return start + end + (start && end ? room.sideGap : 0);
  };
  const taken: [string, Form][] = [];
  for (const [id, form] of giveWaySteps(items)) {
    if (total() <= room.available) break;
    taken.push([id, forms[id]]);
    forms[id] = form;
  }
  const byImportance = [...items].sort((a, b) => importance(b) - importance(a));
  for (;;) {
    const next = byImportance.find((i) => taken.some(([id]) => id === i.id));
    if (!next) break;
    let at = taken.length - 1;
    while (taken[at][0] !== next.id) at--;
    const now = forms[next.id];
    forms[next.id] = taken[at][1];
    if (total() > room.available) {
      forms[next.id] = now;
      break;
    }
    taken.splice(at, 1);
  }
  return forms;
}

const allFull = (items: readonly FitItem[]) => Object.fromEntries(items.map((i) => [i.id, "full" as Form]));
const same = (a: Record<string, Form>, b: Record<string, Form>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/**
 * The forms for the bar `bar`, measured from `measure`: a row nobody sees
 * that holds every form of every item, each element marked
 * `data-fit="<id>"` and `data-form="<form>"`, and the "⋯" button as
 * `data-fit="overflow"`. Read again before paint whenever the bar's size or
 * any form's size changes (text, language, font size) and when the items do.
 * `measuring` is false until the bar has a layout: where it has none (laid
 * out as a panel, hidden, or a test document without layout) everything is
 * full and no measuring row needs to be drawn.
 */
export function useStatusbarFit(bar: RefObject<HTMLElement | null>, measure: RefObject<HTMLElement | null>, items: readonly FitItem[]) {
  const [forms, setForms] = useState<Record<string, Form>>(() => allFull(items));
  const [measuring, setMeasuring] = useState(false);
  const latest = useRef(items);
  latest.current = items;
  const key = items.map((i) => `${i.id}:${i.side}:${i.tier}:${i.rank}:${i.forms.join("+")}`).join(" ");

  const compute = useCallback(() => {
    const items = latest.current;
    const el = bar.current;
    const style = el ? getComputedStyle(el) : null;
    // A bar laid out as a column is the panel (T-15 V5): it has the room to
    // say everything in full.
    const laidOut = !!el && !!style && el.clientWidth > 0 && style.flexDirection !== "column" && typeof ResizeObserver !== "undefined";
    if (!laidOut) {
      setMeasuring(false);
      setForms((was) => (same(was, allFull(items)) ? was : allFull(items)));
      return;
    }
    setMeasuring(true);
    const row = measure.current;
    if (!row) return;
    const widths = new Map<string, number>();
    for (const node of row.querySelectorAll<HTMLElement>("[data-fit]")) widths.set(`${node.dataset.fit}:${node.dataset.form ?? "full"}`, node.getBoundingClientRect().width);
    const start = el.querySelector<HTMLElement>(".statusbar-start");
    const gap = start ? parseFloat(getComputedStyle(start).columnGap) || 0 : 0;
    // One pixel kept back: widths are fractional and a sum that lands on
    // the edge must not spill.
    const room: FitRoom = {
      available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1,
      gap,
      sideGap: parseFloat(style.columnGap) || 0,
      overflow: widths.get("overflow:full") ?? 0,
    };
    const next = fitForms(items, (id, form) => widths.get(`${id}:${form}`) ?? widths.get(`${id}:full`) ?? 0, room);
    setForms((was) => (same(was, next) ? was : next));
  }, [bar, measure]);

  // Before paint, whenever the items change or the measuring row appears.
  useLayoutEffect(compute, [compute, key, measuring]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    // Before paint as well: a resize observer's callback runs after layout
    // and before the frame is drawn, and the new forms are committed there.
    const observer = new ResizeObserver(() => flushSync(compute));
    if (bar.current) observer.observe(bar.current);
    if (measure.current) for (const node of measure.current.querySelectorAll("[data-fit]")) observer.observe(node);
    return () => observer.disconnect();
  }, [bar, measure, compute, key, measuring]);

  return { forms, measuring };
}
