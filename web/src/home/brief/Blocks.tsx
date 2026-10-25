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
export function BriefPlan({ title, steps }: PlanProps) {
  const t = useStrings(briefText);
  return (
    <section className="brief-list" aria-label={title || t.plan}>
      {title && (
        <header>
          <h4>{title}</h4>
        </header>
      )}
      <ol>
        {steps.map((step) => {
          const known = step.state in planStates ? step.state : "todo";
          const Icon = planStates[known].icon;
          return (
            <li key={step.id} data-state={step.state}>
              <span className="brief-chip" data-state={step.state}>
                <Icon size={12} aria-hidden="true" />
                {t.planState[known]}
              </span>
              <span>{step.text}</span>
            </li>
          );
        })}
      </ol>
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
export function BriefMetrics({ items }: MetricsProps) {
  const t = useStrings(briefText);
  return (
    <dl className="brief-metrics">
      {items.map((item, index) => {
        const delta = item.previous === undefined ? null : metricDelta(item.value, item.previous);
        const unit = item.unit ? ` ${item.unit}` : "";
        const Arrow = delta ? (delta.sign > 0 ? ArrowUp : delta.sign < 0 ? ArrowDown : Minus) : null;
        return (
          <div key={index}>
            <dt>{item.label}</dt>
            <dd>
              {shown(item.value)}
              {item.unit && <span className="brief-unit">{item.unit}</span>}
            </dd>
            {delta && Arrow ? (
              <small
                className="brief-delta"
                data-sign={delta.sign}
                title={t.previously(`${shown(item.previous!)}${unit}`)}
              >
                <Arrow size={12} aria-hidden="true" />
                {delta.text}
                {unit}
                <span className="sr-only">{t.sincePrevious}</span>
              </small>
            ) : (
              item.previous !== undefined && (
                <small className="brief-delta">{t.previously(`${shown(item.previous)}${unit}`)}</small>
              )
            )}
            {item.detail && <small>{item.detail}</small>}
          </div>
        );
      })}
    </dl>
  );
}
