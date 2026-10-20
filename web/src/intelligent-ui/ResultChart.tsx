import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartProps } from "./spec";
import { ResultTable } from "./ResultTable";
import { emptyView, useResult } from "./ResultContext";

export function ResultChart(props: ChartProps) {
  const { views, update } = useResult();
  const selected = (views[props.id] || emptyView).selected;
  const data = props.data.map((row) => ({
    resultRowKey: row.id,
    label: row.label,
    value: row.value,
    fill: selected.includes(row.id) ? "var(--green)" : "var(--result-bar)",
  }));
  return (
    <section className="result-chart" aria-label={props.title}>
      <h4>
        {props.title} <span>{props.unit}</span>
      </h4>
      <div
        className="result-chart-plot"
        aria-label={`${props.title}; exact values and selection controls in the data table below`}
      >
        <ResponsiveContainer
          width="100%"
          height={Math.max(160, data.length * 38)}
        >
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 18, bottom: 4, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid horizontal={false} stroke="var(--line)" />
            <XAxis
              type="number"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={95}
              tick={{ fill: "var(--ink)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "var(--paper)",
                borderColor: "var(--line)",
                color: "var(--ink)",
                borderRadius: 8,
              }}
              cursor={{ fill: "var(--cream)" }}
              formatter={(value) => [`${value} ${props.unit}`, "Value"]}
            />
            <Bar
              dataKey="value"
              radius={[0, 4, 4, 0]}
              maxBarSize={20}
              isAnimationActive={false}
              onClick={(row) => {
                const key = String(row.payload?.resultRowKey || "");
                if (props.data.some((item) => item.id === key))
                  update(props.id, {
                    selected: selected.includes(key)
                      ? selected.filter((id) => id !== key)
                      : [...selected, key],
                  });
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="result-chart-data" open>
        <summary>Data & selection</summary>
        <ResultTable
          id={props.id}
          title={`${props.title} data`}
          columns={[
            { key: "label", label: "Item" },
            { key: "value", label: props.unit || "Value" },
          ]}
          rows={props.data.map((row) => ({
            id: row.id,
            cells: { label: row.label, value: row.value },
            sourceIds: row.sourceIds,
          }))}
          selectable
        />
      </details>
    </section>
  );
}
