import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTimeDisplay } from "../../time-preferences";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { api, errorText } from "../../api";
import { useStrings } from "../../i18n";
import { briefText } from "./brief-text";
import { useBrief } from "./BriefContext";
import { useBriefDensity } from "../home-density";
import {
  chartPath,
  formatTime,
  MAX_SERIES,
  MAX_SERIES_POINTS,
  type Axis,
  type ChartData,
  type ChartProps,
  type Point,
  type Series,
} from "./brief-catalog";

export type ChartKind = "line" | "bar" | "scatter";
type Kind = ChartKind;
/** The plot's own height: fixed, so data arriving never moves the blocks around it. */
export const CHART_HEIGHT = 260;
/** A trend's height in a short card (low density): the line, its ends, no axis. */
export const MINI_CHART_HEIGHT = 120;
/** At most this many bars (categories × series) show their values on the bars. */
export const LABELLED_BARS = 12;
/** The longest value a bar label shows: side by side, grouped bars have less room. */
const LABEL_CHARS = { single: 10, grouped: 6 };

// Series take the categorical slots in a fixed order (brief.css,
// --brief-series-1…8). Past eight a slot is reused with a second encoding:
// dashed lines, lighter bars, and for scatter, where only the first three
// slots stay apart for every pair, marker shapes from the fourth series on.
const SLOTS = 8;
const color = (index: number) => `var(--brief-series-${(index % SLOTS) + 1})`;
const SHAPES = ["circle", "square", "triangle", "diamond", "cross", "star", "wye"] as const;

const ticks = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 3 });
const tick = (value: unknown) => (typeof value === "number" ? ticks.format(value) : String(value));
/** A bar's own value, whole, as the data table shows it; the unit is on the axis. */
const barValue = (value: unknown) => (typeof value === "number" ? value.toLocaleString() : String(value));
const withUnit = (axis: Axis) => (axis.unit ? `${axis.label} (${axis.unit})` : axis.label);
const valueText = (value: unknown, axis: Axis) =>
  `${typeof value === "number" ? value.toLocaleString() : String(value)}${axis.unit ? ` ${axis.unit}` : ""}`;

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) &&
  value.length === 2 &&
  ((typeof value[0] === "number" && Number.isFinite(value[0])) || typeof value[0] === "string") &&
  ((typeof value[1] === "number" && Number.isFinite(value[1])) || value[1] === null);
/** Core's answer, checked: at most 12 series of at most 5000 points each. */
function chartData(value: unknown): ChartData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<ChartData>;
  if (!Array.isArray(data.series)) return null;
  const series: Series[] = [];
  for (const item of data.series.slice(0, MAX_SERIES)) {
    if (!item || typeof item.name !== "string" || !Array.isArray(item.points)) return null;
    series.push({ name: item.name, points: item.points.slice(0, MAX_SERIES_POINTS).filter(isPoint) });
  }
  return {
    series,
    downsampled: data.downsampled === true,
    sourcePoints:
      typeof data.sourcePoints === "number" && Number.isFinite(data.sourcePoints)
        ? data.sourcePoints
        : series.reduce((sum, item) => sum + item.points.length, 0),
  };
}

/** Why a chart has no points: Core's reason, or Yuzuno's own words, worded when shown. */
type Problem = { reason: string } | { word: "chartUnreadable" | "chartNoData" | "chartNotFound" };
type Loaded = { key: string; data?: ChartData; error?: Problem };
/**
 * Inline series as they are; attachment data read from Core once per
 * section version. Only the data read for the very chart shown is drawn
 * (T-18, Lead 2752): while another version, section or element loads, the
 * chart says it is loading, in a box of the same size, and never shows the
 * earlier points under the new names, units and series; an answer that
 * comes late for an earlier one is dropped.
 */
function useSeries(props: ChartProps, elementKey: string | undefined) {
  const { projectId, section } = useBrief();
  const path = props.data && elementKey ? chartPath(projectId, section.key, elementKey, section.version) : null;
  // The data's identity: its project, section key and version, and element (the path), and Core's id for the section.
  const key = path && `${path}#${section.id ?? ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!key || !path) return;
    const controller = new AbortController();
    api<unknown>(path, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        const data = chartData(value);
        setLoaded(data ? { key, data } : { key, error: { word: "chartUnreadable" } });
      },
      (error) => {
        if (!controller.signal.aborted) setLoaded({ key, error: { reason: errorText(error) } });
      },
    );
    return () => controller.abort();
  }, [key, path]);
  if (props.series) return { series: props.series, data: null, error: null, loading: false };
  if (!props.data) return { series: [], data: null, error: { word: "chartNoData" } as Problem, loading: false };
  if (!path) return { series: [], data: null, error: { word: "chartNotFound" } as Problem, loading: false };
  const current = loaded?.key === key ? loaded : null;
  return {
    series: current?.data?.series ?? [],
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: !current,
  };
}

type Row = { x: number | string; [series: string]: number | string | null };
/** One row per x, in x order when x is numeric, otherwise in first-seen order. */
function mergeRows(series: Series[], numeric: boolean) {
  const rows = new Map<number | string, Row>();
  series.forEach((item, index) => {
    for (const [x, y] of item.points) {
      let row = rows.get(x);
      if (!row) rows.set(x, (row = { x }));
      row[`s${index}`] = y;
    }
  });
  const list = [...rows.values()];
  if (numeric) list.sort((a, b) => (a.x as number) - (b.x as number));
  // Series on different x grids leave holes in each other's rows; join over those.
  const gaps = series.some((item) => item.points.length !== list.length);
  return { rows: list, gaps };
}

function Plot({ kind, props, series, mini }: { kind: Kind; props: ChartProps; series: Series[]; mini?: boolean }) {
  const numeric = series.every((item) => item.points.every(([x]) => typeof x === "number"));
  const merged = useMemo(() => mergeRows(series, kind === "line" && numeric), [series, kind, numeric]);
  const grid = <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />;
  const yAxis = (
    <YAxis
      type="number"
      width={52}
      tickFormatter={tick}
      tick={{ fill: "var(--muted)", fontSize: 11 }}
      axisLine={false}
      tickLine={false}
    />
  );
  const xTick = { fill: "var(--muted)", fontSize: 11 };
  const tooltip = (
    <Tooltip
      contentStyle={{
        background: "var(--paper)",
        borderColor: "var(--line)",
        color: "var(--ink)",
        borderRadius: 8,
        fontSize: 12,
      }}
      cursor={kind === "bar" ? { fill: "var(--cream)" } : { stroke: "var(--muted)", strokeDasharray: "3 3" }}
      labelFormatter={(x) => `${props.x.label}: ${valueText(x, props.x)}`}
      formatter={(value, name) => [valueText(value, props.y), name]}
    />
  );
  const margin = { top: 8, right: 12, bottom: 4, left: 0 };
  if (kind === "scatter")
    return (
      <ScatterChart margin={margin} accessibilityLayer>
        {grid}
        <XAxis type="number" dataKey="x" name={props.x.label} tickFormatter={tick} tick={xTick} domain={["auto", "auto"]} />
        <YAxis
          type="number"
          dataKey="y"
          name={props.y.label}
          width={52}
          tickFormatter={tick}
          tick={{ fill: "var(--muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          domain={["auto", "auto"]}
        />
        <ZAxis range={[64, 64]} />
        <Tooltip
          contentStyle={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)", borderRadius: 8, fontSize: 12 }}
          cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
          formatter={(value, name) => [valueText(value, name === props.x.label ? props.x : props.y), name]}
        />
        {series.map((item, index) => (
          <Scatter
            key={index}
            name={item.name}
            data={item.points
              .filter((point): point is [number, number] => typeof point[0] === "number" && typeof point[1] === "number")
              .map(([x, y]) => ({ x, y }))}
            fill={color(index)}
            shape={series.length > 3 ? SHAPES[index % SHAPES.length] : "circle"}
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    );
  // A few bars carry their values, so the comparison is read without hovering
  // (T-173); a crowded chart, or values too long to fit over their bars,
  // keep them in the tooltip and the data table.
  const longest = series.length > 1 ? LABEL_CHARS.grouped : LABEL_CHARS.single;
  const labelled =
    kind === "bar" &&
    merged.rows.length * series.length <= LABELLED_BARS &&
    series.every((item) => item.points.every(([, y]) => barValue(y).length <= longest));
  if (kind === "bar")
    return (
      <BarChart data={merged.rows} margin={labelled ? { ...margin, top: 20 } : margin} accessibilityLayer barCategoryGap="20%">
        {grid}
        <XAxis type="category" dataKey="x" tickFormatter={tick} tick={xTick} tickLine={false} />
        {yAxis}
        {tooltip}
        {series.map((item, index) => (
          <Bar
            key={index}
            dataKey={`s${index}`}
            name={item.name}
            fill={color(index)}
            fillOpacity={index >= SLOTS ? 0.55 : 1}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          >
            {labelled && (
              <LabelList dataKey={`s${index}`} position="top" formatter={barValue} fill="var(--muted)" fontSize={10} />
            )}
          </Bar>
        ))}
      </BarChart>
    );
  // A short card's trend: the line and its ends only. The y range is the
  // data's own, not from zero, so a change shows; the values stay in the
  // tooltip and the data table.
  const ends = mini ? { interval: "preserveStartEnd" as const, minTickGap: 48 } : {};
  const last = merged.rows.length - 1;
  const endDot = (index: number) =>
    function EndDot(dot: { cx?: number; cy?: number; index?: number }) {
      return dot.index === last && dot.cx !== undefined && dot.cy !== undefined ? (
        <circle cx={dot.cx} cy={dot.cy} r={3} fill={color(index)} />
      ) : (
        <g />
      );
    };
  return (
    <LineChart data={merged.rows} margin={mini ? { top: 8, right: 8, bottom: 0, left: 8 } : margin} accessibilityLayer>
      {grid}
      {numeric ? (
        <XAxis type="number" dataKey="x" domain={["dataMin", "dataMax"]} tickFormatter={tick} tick={xTick} {...ends} />
      ) : (
        <XAxis type="category" dataKey="x" tick={xTick} {...ends} />
      )}
      {mini ? <YAxis type="number" hide domain={["auto", "auto"]} /> : yAxis}
      {tooltip}
      {series.map((item, index) => (
        <Line
          key={index}
          type="linear"
          dataKey={`s${index}`}
          name={item.name}
          stroke={color(index)}
          strokeWidth={2}
          strokeDasharray={index >= SLOTS ? "6 4" : undefined}
          dot={mini ? endDot(index) : false}
          activeDot={{ r: 4 }}
          connectNulls={merged.gaps}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}

/** Rows shown in a chart's data table; the attachment has the rest. */
const TABLE_ROWS = 500;
/**
 * The chart's values as a table, for readers who can't use the plot. It is
 * closed at first and builds its rows only when opened, so it neither
 * moves the section nor costs anything for a large series.
 */
function DataTable({ kind, props, series }: { kind: Kind; props: ChartProps; series: Series[] }) {
  const t = useStrings(briefText);
  const [open, setOpen] = useState(false);
  const table = useMemo(() => {
    if (!open) return null;
    if (kind === "scatter")
      return {
        columns: [t.series, withUnit(props.x), withUnit(props.y)],
        rows: series.flatMap((item) => item.points.map(([x, y]) => [item.name, x, y])),
      };
    const numeric = series.every((item) => item.points.every(([x]) => typeof x === "number"));
    return {
      columns: [withUnit(props.x), ...series.map((item) => item.name)],
      rows: mergeRows(series, kind === "line" && numeric).rows.map((row) => [row.x, ...series.map((_, i) => row[`s${i}`] ?? null)]),
    };
  }, [open, kind, props.x, props.y, series, t.series]);
  return (
    <details className="brief-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t.dataTable}</summary>
      {table && (
        <div className="brief-preview">
          <div className="brief-preview-frame brief-preview-scroll" tabIndex={0} role="region" aria-label={t.tableOf(props.title)}>
            <table>
              <thead>
                <tr>
                  {table.columns.map((column, index) => (
                    <th key={index} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, TABLE_ROWS).map((row, index) => (
                  <tr key={index}>
                    {row.map((value, column) => (
                      <td key={column}>{value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>
            {!table.rows.length
              ? t.noPointsYet
              : table.rows.length > TABLE_ROWS
                ? t.firstRowsOf(TABLE_ROWS, table.rows.length.toLocaleString())
                : t.rowCount(table.rows.length)}
          </small>
        </div>
      )}
    </details>
  );
}

function BriefChart({ kind, props }: { kind: Kind; props: Placed }) {
  const time = useTimeDisplay();
  const t = useStrings(briefText);
  const { section } = useBrief();
  const { series, data, error, loading } = useSeries(props, props.elementKey);
  const density = useBriefDensity();
  const mini = kind === "line" && density === "low";
  // The legend comes from the chart's own declaration, so its height is
  // known before attachment data arrives.
  const names = (props.series ?? props.data?.series ?? []).map((item) => item.name);
  const attachment = props.data
    ? section.attachments.find((item) => item.name === props.data!.attachment)
    : undefined;
  const points = series.reduce((sum, item) => sum + item.points.length, 0);
  return (
    <section className="brief-chart" data-density={mini ? "low" : undefined} aria-label={props.title}>
      <header>
        <h4>{props.title}</h4>
        {names.length > 1 && (
          <ul className="brief-legend" aria-label={t.series}>
            {names.map((name, index) => (
              <li key={index}>
                <i
                  data-slot={(index % SLOTS) + 1}
                  data-repeat={index >= SLOTS || undefined}
                  data-shape={kind === "scatter" && names.length > 3 ? SHAPES[index % SHAPES.length] : undefined}
                  aria-hidden="true"
                />
                {name}
              </li>
            ))}
          </ul>
        )}
      </header>
      <div className="brief-chart-axis is-y">{withUnit(props.y)}</div>
      <div className="brief-chart-plot">
        {error ? (
          <p className="brief-chart-state" role="status">
            {t.chartError("reason" in error ? error.reason : t[error.word])}
          </p>
        ) : loading && !points ? (
          <p className="brief-chart-state" role="status">
            {t.loadingChart}
          </p>
        ) : !points ? (
          <p className="brief-chart-state">{t.noPoints}</p>
        ) : (
          <ResponsiveContainer width="100%" height={mini ? MINI_CHART_HEIGHT : CHART_HEIGHT}>
            <Plot kind={kind} props={props} series={series} mini={mini} />
          </ResponsiveContainer>
        )}
      </div>
      <footer className="brief-chart-foot">
        <span>
          {props.data && (
            <>
              {t.dataFrom}
              {props.data.attachment}
              {attachment?.takenAt && t.snapshotAt(formatTime(attachment.takenAt, time))}
            </>
          )}
        </span>
        <span className="brief-chart-axis is-x">{withUnit(props.x)}</span>
        {/* A line of its own, there before the data arrives: the note never
            rewraps the line above or adds one. */}
        {props.data && (
          <span className="brief-chart-points">
            {data?.downsampled
              ? t.downsampled(data.sourcePoints.toLocaleString())
              : data
                ? t.points(data.sourcePoints.toLocaleString())
                : " "}
          </span>
        )}
      </footer>
      {/* Always there, so the card keeps its height when data arrives. */}
      <DataTable kind={kind} props={props} series={series} />
    </section>
  );
}

/** `elementKey` is the chart's id in the body, added by BriefSectionBody. */
type Placed = ChartProps & { elementKey?: string };
export const BriefLineChart = (props: Placed) => <BriefChart kind="line" props={props} />;
export const BriefBarChart = (props: Placed) => <BriefChart kind="bar" props={props} />;
export const BriefScatterChart = (props: Placed) => <BriefChart kind="scatter" props={props} />;

/**
 * The plot of a card's chart: both axes with their ticks, and nothing to
 * hover or focus. `labelPx` is its tick labels' size, which follows the
 * user's text size: the x axis is as tall as its labels need.
 */
function CardPlot({ kind, series, labelPx }: { kind: Kind; series: Series[]; labelPx: number }) {
  const numeric = series.every((item) => item.points.every(([x]) => typeof x === "number"));
  const merged = useMemo(() => mergeRows(series, kind === "line" && numeric), [series, kind, numeric]);
  const grid = <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />;
  const tickStyle = { fill: "var(--home-ink-2, var(--muted))", fontSize: labelPx };
  const margin = { top: 6, right: 8, bottom: 0, left: 0 };
  // Below the axis line: the tick's own 6 px and 2 px of space, then the label.
  const x = { tick: tickStyle, tickFormatter: tick, height: Math.ceil(labelPx + 10), minTickGap: 12 };
  // Three values on the side; a bar's from zero, as on the page. The axis is as wide as its widest label, as drawn
  // at the user's text size (Recharts measures them), so "-200M" at 24 px is not cut on the left (Lead 2752).
  const y = { type: "number" as const, width: "auto" as const, tick: tickStyle, tickFormatter: tick, axisLine: false, tickLine: false, tickCount: 3 };
  if (kind === "scatter")
    return (
      <ScatterChart margin={margin} accessibilityLayer={false}>
        {grid}
        <XAxis type="number" dataKey="x" domain={["auto", "auto"]} {...x} />
        <YAxis dataKey="y" domain={["auto", "auto"]} {...y} />
        <ZAxis range={[20, 20]} />
        {series.map((item, index) => (
          <Scatter
            key={index}
            data={item.points
              .filter((point): point is [number, number] => typeof point[0] === "number" && typeof point[1] === "number")
              .map(([x, y]) => ({ x, y }))}
            fill={color(index)}
            shape={series.length > 3 ? SHAPES[index % SHAPES.length] : "circle"}
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    );
  if (kind === "bar")
    return (
      <BarChart data={merged.rows} margin={margin} accessibilityLayer={false} barCategoryGap="20%">
        {grid}
        <XAxis type="category" dataKey="x" tickLine={false} {...x} />
        <YAxis {...y} />
        {series.map((item, index) => (
          <Bar
            key={index}
            dataKey={`s${index}`}
            fill={color(index)}
            fillOpacity={index >= SLOTS ? 0.55 : 1}
            radius={[3, 3, 0, 0]}
            maxBarSize={20}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  // A trend's range is the data's own, so a change shows; its axis says where it starts.
  return (
    <LineChart data={merged.rows} margin={margin} accessibilityLayer={false}>
      {grid}
      {numeric ? (
        <XAxis type="number" dataKey="x" domain={["dataMin", "dataMax"]} {...x} />
      ) : (
        <XAxis type="category" dataKey="x" {...x} />
      )}
      <YAxis domain={["auto", "auto"]} {...y} />
      {series.map((item, index) => (
        <Line
          key={index}
          type="linear"
          dataKey={`s${index}`}
          stroke={color(index)}
          strokeWidth={1.75}
          strokeDasharray={index >= SLOTS ? "6 4" : undefined}
          dot={false}
          activeDot={false}
          connectNulls={merged.gaps}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}

/** An axis's name with its unit: the name may be cut short, its unit never. */
function AxisName({ axis, side }: { axis: Axis; side: "x" | "y" }) {
  return (
    <span className={`home-card-chart-axis is-${side}`}>
      <span>{axis.label}</span>
      {axis.unit && <span>({axis.unit})</span>}
    </span>
  );
}

/**
 * A chart as a card's figure on Home (T-18, Lead 2655): its plot with both
 * axes, their names and units, and a legend for every series it draws,
 * fitted to the frame its card gives it, whatever that frame's height. It is
 * a picture of the chart: no tooltip, no data table, nothing to focus; the
 * report page has the whole chart. A legend that can't name every series in
 * its lines draws only the series it names, and says how many there are.
 * The names and the legend are there before attachment data arrives, so the
 * plot has the same room loading as drawn.
 */
export function CardChart({ kind, props, elementKey, legendLines }: { kind: Kind; props: ChartProps; elementKey: string; legendLines: number }) {
  const t = useStrings(briefText);
  const { series, error, loading } = useSeries(props, elementKey);
  const names = useMemo(() => (props.series ?? props.data?.series ?? []).map((item) => item.name), [props.series, props.data]);
  const root = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // How many series the legend names and the plot draws: all of them, at
  // each width, unless its lines can't hold them; then one fewer, until they
  // do. One name that still can't share a line with the count is cut short.
  const [fit, setFit] = useState({ width, names, named: names.length, squeezed: false });
  const current = fit.width === width && fit.names === names;
  const named = current ? fit.named : names.length;
  const squeezed = current && fit.squeezed;
  useLayoutEffect(() => {
    const list = legend.current;
    if (!list || squeezed) return;
    const lines = new Set([...list.children].map((item) => (item as HTMLElement).offsetTop)).size;
    if (lines > legendLines) setFit({ width, names, named: Math.max(1, named - 1), squeezed: named <= 1 });
  });
  // Its tick labels a step smaller than its names, as its CSS draws them (summary-card.css).
  const [labelPx, setLabelPx] = useState(10);
  useLayoutEffect(() => {
    const size = root.current ? parseFloat(getComputedStyle(root.current).fontSize) - 1.5 : NaN;
    if (size > 0 && size !== labelPx) setLabelPx(size);
  });
  const drawn = useMemo(() => series.slice(0, named), [series, named]);
  const points = drawn.reduce((sum, item) => sum + item.points.length, 0);
  const state = error ? t.chartError("reason" in error ? error.reason : t[error.word]) : loading && !points ? t.loadingChart : !points ? t.noPoints : null;
  return (
    <div ref={root} className="home-card-chart" data-chart={kind}>
      {props.title && <p className="home-card-chart-title">{props.title}</p>}
      {names.length > 1 && (
        <ul ref={legend} className={`brief-legend home-card-chart-legend${squeezed ? " is-squeezed" : ""}`} aria-label={t.series}>
          {names.slice(0, named).map((name, index) => (
            <li key={index} data-series={index}>
              <i
                data-slot={(index % SLOTS) + 1}
                data-repeat={index >= SLOTS || undefined}
                data-shape={kind === "scatter" && names.length > 3 ? SHAPES[index % SHAPES.length] : undefined}
                aria-hidden="true"
              />
              <span>{name}</span>
            </li>
          ))}
          {named < names.length && <li className="is-count">{t.seriesShown(named, names.length)}</li>}
        </ul>
      )}
      <AxisName axis={props.y} side="y" />
      <div className="home-card-chart-plot">
        {state ? (
          <p className="home-card-chart-state" role="status">
            <span>{state}</span>
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <CardPlot kind={kind} series={drawn} labelPx={labelPx} />
          </ResponsiveContainer>
        )}
      </div>
      <AxisName axis={props.x} side="x" />
    </div>
  );
}
