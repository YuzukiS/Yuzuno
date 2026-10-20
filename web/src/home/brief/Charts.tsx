import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { useBrief } from "./BriefContext";
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

type Kind = "line" | "bar" | "scatter";
/** The plot's own height: fixed, so data arriving never moves the blocks around it. */
export const CHART_HEIGHT = 260;

// Series take the categorical slots in a fixed order (brief.css,
// --brief-series-1…8). Past eight a slot is reused with a second encoding:
// dashed lines, lighter bars, and for scatter, where only the first three
// slots stay apart for every pair, marker shapes from the fourth series on.
const SLOTS = 8;
const color = (index: number) => `var(--brief-series-${(index % SLOTS) + 1})`;
const SHAPES = ["circle", "square", "triangle", "diamond", "cross", "star", "wye"] as const;

const ticks = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 3 });
const tick = (value: unknown) => (typeof value === "number" ? ticks.format(value) : String(value));
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

type Loaded = { key: string; data?: ChartData; error?: string };
/**
 * Inline series as they are; attachment data read from Core once per
 * section version. While a newer version loads, the previous data stays up,
 * so the plot never collapses into a placeholder and back.
 */
function useSeries(props: ChartProps, elementKey: string | undefined) {
  const { projectId, section } = useBrief();
  const path = props.data && elementKey ? chartPath(projectId, section.key, elementKey, section.version) : null;
  const key = path;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!key || !path) return;
    const controller = new AbortController();
    api<unknown>(path, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        const data = chartData(value);
        setLoaded(data ? { key, data } : { key, error: "Core answered with chart data this view can't read." });
      },
      (error) => {
        if (!controller.signal.aborted) setLoaded({ key, error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [key, path]);
  if (props.series) return { series: props.series, data: null, error: null, loading: false };
  if (!props.data) return { series: [], data: null, error: "This chart has no data.", loading: false };
  if (!path) return { series: [], data: null, error: "This chart can't be located in its section.", loading: false };
  const current = loaded?.key === key ? loaded : null;
  const data = current?.data ?? (current ? undefined : loaded?.data);
  return {
    series: data?.series ?? [],
    data: data ?? null,
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

function Plot({ kind, props, series }: { kind: Kind; props: ChartProps; series: Series[] }) {
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
  if (kind === "bar")
    return (
      <BarChart data={merged.rows} margin={margin} accessibilityLayer barCategoryGap="20%">
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
          />
        ))}
      </BarChart>
    );
  return (
    <LineChart data={merged.rows} margin={margin} accessibilityLayer>
      {grid}
      {numeric ? (
        <XAxis type="number" dataKey="x" domain={["dataMin", "dataMax"]} tickFormatter={tick} tick={xTick} />
      ) : (
        <XAxis type="category" dataKey="x" tick={xTick} />
      )}
      {yAxis}
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
          dot={false}
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
  const [open, setOpen] = useState(false);
  const table = useMemo(() => {
    if (!open) return null;
    if (kind === "scatter")
      return {
        columns: ["Series", withUnit(props.x), withUnit(props.y)],
        rows: series.flatMap((item) => item.points.map(([x, y]) => [item.name, x, y])),
      };
    const numeric = series.every((item) => item.points.every(([x]) => typeof x === "number"));
    return {
      columns: [withUnit(props.x), ...series.map((item) => item.name)],
      rows: mergeRows(series, kind === "line" && numeric).rows.map((row) => [row.x, ...series.map((_, i) => row[`s${i}`] ?? null)]),
    };
  }, [open, kind, props.x, props.y, series]);
  return (
    <details className="brief-chart-data" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Data table</summary>
      {table && (
        <div className="brief-preview">
          <div className="brief-preview-frame brief-preview-scroll" tabIndex={0} role="region" aria-label={`${props.title} data`}>
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
              ? "No points yet."
              : table.rows.length > TABLE_ROWS
                ? `First ${TABLE_ROWS} of ${table.rows.length.toLocaleString()} rows`
                : `${table.rows.length} rows`}
          </small>
        </div>
      )}
    </details>
  );
}

function BriefChart({ kind, props }: { kind: Kind; props: Placed }) {
  const { section } = useBrief();
  const { series, data, error, loading } = useSeries(props, props.elementKey);
  // The legend comes from the chart's own declaration, so its height is
  // known before attachment data arrives.
  const names = (props.series ?? props.data?.series ?? []).map((item) => item.name);
  const attachment = props.data
    ? section.attachments.find((item) => item.name === props.data!.attachment)
    : undefined;
  const points = series.reduce((sum, item) => sum + item.points.length, 0);
  return (
    <section className="brief-chart" aria-label={props.title}>
      <header>
        <h4>{props.title}</h4>
        {names.length > 1 && (
          <ul className="brief-legend" aria-label="Series">
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
            Chart data couldn't be read. {error}
          </p>
        ) : loading && !points ? (
          <p className="brief-chart-state" role="status">
            Loading chart data…
          </p>
        ) : !points ? (
          <p className="brief-chart-state">No points to show.</p>
        ) : (
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <Plot kind={kind} props={props} series={series} />
          </ResponsiveContainer>
        )}
      </div>
      <footer className="brief-chart-foot">
        <span>
          {props.data && (
            <>
              Data: {props.data.attachment}
              {attachment?.takenAt && <> · snapshot {formatTime(attachment.takenAt)}</>}
            </>
          )}
        </span>
        <span className="brief-chart-axis is-x">{withUnit(props.x)}</span>
        {/* A line of its own, there before the data arrives: the note never
            rewraps the line above or adds one. */}
        {props.data && (
          <span className="brief-chart-points">
            {data?.downsampled
              ? `Downsampled from ${data.sourcePoints.toLocaleString()} points`
              : data
                ? `${data.sourcePoints.toLocaleString()} points`
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
