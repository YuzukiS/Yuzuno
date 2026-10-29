import { Children, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Ban,
  Circle,
  CircleCheck,
  CircleDot,
  Info,
  Minus,
  OctagonAlert,
  Square,
  SquareCheckBig,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { sourceTarget } from "../../intelligent-ui/contract.ts";
import { useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import { useBriefDensity } from "../home-density";
import {
  metricDelta,
  type ChecklistProps,
  type ColumnsProps,
  type FindingsProps,
  type GroupProps,
  type MetricsProps,
  type PlanProps,
  type PlanState,
  type Severity,
} from "./brief-catalog";

export function BriefGroup({ title, tone, children }: GroupProps & { children?: ReactNode }) {
  return (
    <section className="brief-group" data-tone={tone === "plain" ? undefined : tone}>
      {title && <h4>{title}</h4>}
      {children}
    </section>
  );
}

/** The narrowest a column may be before the columns stack, in rem. */
export const MIN_COLUMN_REM = 14;
const COLUMN_GAP_PX = 16;

/**
 * Its children side by side, one column each, at the given relative widths
 * (equal without them). Each Columns measures its own width, so nested and
 * three- or four-column layouts stack in order once their narrowest column
 * would fall below MIN_COLUMN_REM at the page's text size.
 */
export function BriefColumns({ widths, children }: ColumnsProps & { children?: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const count = Children.count(children);
  const shares = widths?.length === count ? widths : Array.from({ length: count }, () => 1);
  const ratio = Math.min(...shares) / shares.reduce((sum, share) => sum + share, 0);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const fit = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const narrowest = (node.clientWidth - COLUMN_GAP_PX * (count - 1)) * ratio;
      setStacked(narrowest < MIN_COLUMN_REM * rem);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, ratio]);
  const template = widths?.map((width) => `minmax(0, ${width}fr)`).join(" ");
  return (
    <div
      ref={frame}
      className="brief-columns"
      data-stacked={stacked || undefined}
      style={template ? ({ "--brief-columns": template } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

export function BriefChecklist({ title, items }: ChecklistProps) {
  const t = useStrings(briefText);
  const done = items.filter((item) => item.done).length;
  return (
    <section className="brief-list" aria-label={title || t.checklist}>
      <header>
        {title && <h4>{title}</h4>}
        <span>{t.doneOf(done, items.length)}</span>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id} data-done={item.done || undefined}>
            {item.done ? (
              <SquareCheckBig size={15} aria-label={t.done} />
            ) : (
              <Square size={15} aria-label={t.notDone} />
            )}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const planStates: Record<PlanState, { icon: LucideIcon }> = {
  todo: { icon: Circle },
  doing: { icon: CircleDot },
  done: { icon: CircleCheck },
  blocked: { icon: Ban },
};
/** A step's text: its first line is its name, the rest says more about it. */
function stepText(text: string) {
  const [name, ...rest] = text.split("\n");
  return { name, more: rest.join("\n").trim() };
}
/** Steps a short plan shows at once (low density). */
export const FIRST_STEPS = 5;
/**
 * Where a short plan's window starts: one step before the first that isn't
 * done, so the current step shows with the one that led to it.
 */
export function stepWindow(steps: { state: string }[], size = FIRST_STEPS) {
  if (steps.length <= size) return { start: 0, end: steps.length };
  const current = steps.findIndex((step) => step.state !== "done");
  const start = Math.max(0, Math.min((current < 0 ? steps.length : current) - 1, steps.length - size));
  return { start, end: start + size };
}
export function BriefPlan({ title, steps }: PlanProps) {
  const t = useStrings(briefText);
  const density = useBriefDensity();
  const [all, setAll] = useState(false);
  const done = steps.filter((step) => step.state === "done").length;
  const range = density === "low" && !all ? stepWindow(steps) : { start: 0, end: steps.length };
  // A blocked step is never folded away with the rest: it shows, numbered
  // as written, after a gap.
  const rows = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => (index >= range.start && index < range.end) || step.state === "blocked");
  return (
    <section className="brief-list brief-plan" data-density={density} aria-label={title || t.plan}>
      <header>
        {title && <h4>{title}</h4>}
        <span>{t.doneOf(done, steps.length)}</span>
      </header>
      <ol>
        {rows.map(({ step, index }, row) => {
          const known = step.state in planStates ? step.state : "todo";
          const Icon = planStates[known].icon;
          const { name, more } = stepText(step.text);
          const gap = row > 0 && rows[row - 1].index !== index - 1;
          return (
            <li key={step.id} value={index + 1} data-state={step.state} data-gap={gap || undefined}>
              <span className="brief-plan-mark" data-state={known} aria-hidden="true">
                <Icon size={14} />
              </span>
              <span className="brief-plan-text">
                <strong>{name}</strong>
                {more && <span className="brief-plan-more">{more}</span>}
              </span>
              <span className="brief-chip" data-state={step.state}>
                {t.planState[known]}
              </span>
            </li>
          );
        })}
      </ol>
      {density === "low" && steps.length > FIRST_STEPS && (
        <button type="button" className="quiet-button brief-plan-all" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t.showCurrentSteps : t.showAllSteps(steps.length)}
        </button>
      )}
    </section>
  );
}

const severities: Record<Severity, { icon: LucideIcon }> = {
  critical: { icon: OctagonAlert },
  high: { icon: TriangleAlert },
  medium: { icon: TriangleAlert },
  low: { icon: Info },
  info: { icon: Info },
};
/** Where a finding came from: a web link opens outside, anything else is shown as written. */
function FindingSource({ source }: { source: string }) {
  const target = sourceTarget(source);
  return target?.kind === "web" ? (
    <a href={target.path} target="_blank" rel="noopener noreferrer" title={target.path}>
      {source}
      <ArrowUpRight size={11} aria-hidden="true" />
    </a>
  ) : (
    <code title={source}>{source}</code>
  );
}
export function BriefFindings({ title, items }: FindingsProps) {
  const t = useStrings(briefText);
  return (
    <section className="brief-list brief-findings" aria-label={title || t.findings}>
      {title && (
        <header>
          <h4>{title}</h4>
        </header>
      )}
      <ul>
        {items.map((item) => {
          const known = item.severity in severities ? item.severity : "info";
          const Icon = severities[known].icon;
          return (
            <li key={item.id}>
              <span className="brief-chip" data-severity={item.severity}>
                <Icon size={12} aria-hidden="true" />
                {t.severity[known]}
              </span>
              <div>
                <p>{item.text}</p>
                <small>
                  <FindingSource source={item.source} />
                </small>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const shown = (value: number | string) => String(value);
/** Values a short metrics block shows beside its first (low density). */
export const MORE_METRICS = 3;
function Metric({ item, lead }: { item: MetricsProps["items"][number]; lead?: boolean }) {
  const t = useStrings(briefText);
  const delta = item.previous === undefined ? null : metricDelta(item.value, item.previous);
  const unit = item.unit ? ` ${item.unit}` : "";
  const Arrow = delta ? (delta.sign > 0 ? ArrowUp : delta.sign < 0 ? ArrowDown : Minus) : null;
  return (
    <div data-lead={lead || undefined}>
      <dt>{item.label}</dt>
      <dd>
        {shown(item.value)}
        {item.unit && <span className="brief-unit">{item.unit}</span>}
      </dd>
      {delta && Arrow ? (
        <small className="brief-delta" data-sign={delta.sign} title={t.previously(`${shown(item.previous!)}${unit}`)}>
          <Arrow size={12} aria-hidden="true" />
          {delta.text}
          {unit}
          <span className="sr-only">{t.sincePrevious}</span>
        </small>
      ) : (
        item.previous !== undefined && <small className="brief-delta">{t.previously(`${shown(item.previous)}${unit}`)}</small>
      )}
      {item.detail && <small>{item.detail}</small>}
    </div>
  );
}
/**
 * Metrics, every one as written. In low density the first leads, large,
 * and a few more follow small; the rest are counted and a button shows them,
 * never dropped silently.
 */
export function BriefMetrics({ items }: MetricsProps) {
  const t = useStrings(briefText);
  const density = useBriefDensity();
  const [all, setAll] = useState(false);
  if (density === "low" && items.length) {
    const [first, ...rest] = items;
    const more = all ? rest : rest.slice(0, MORE_METRICS);
    const folded = rest.length - Math.min(rest.length, MORE_METRICS);
    return (
      <>
        <dl className="brief-metrics" data-density="low">
          <Metric item={first} lead />
          {more.map((item, index) => (
            <Metric key={index} item={item} />
          ))}
        </dl>
        {folded > 0 && (
          <button type="button" className="quiet-button brief-metrics-more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? t.showFewer : t.moreMetrics(folded)}
          </button>
        )}
      </>
    );
  }
  return (
    <dl className="brief-metrics" data-density={density}>
      {items.map((item, index) => (
        <Metric key={index} item={item} />
      ))}
    </dl>
  );
}
