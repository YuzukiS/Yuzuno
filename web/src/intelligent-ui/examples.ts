export const comparisonExample = {
  root: "result",
  elements: {
    result: {
      type: "Result",
      props: {
        title: "Conversation navigation",
        summary:
          "Sample comparison. Pick the direction you would like to explore.",
      },
      children: ["options", "sources", "continue"],
    },
    options: {
      type: "Table",
      props: {
        id: "navigation",
        title: "Options",
        selectable: true,
        columns: [
          { key: "name", label: "Option" },
          { key: "strength", label: "Strength" },
          { key: "tradeoff", label: "Trade-off" },
        ],
        rows: [
          {
            id: "dock",
            cells: {
              name: "Turn dock",
              strength: "Tracks the reading position",
              tradeoff: "Uses a slim side column",
            },
            sourceIds: ["dock-source"],
          },
          {
            id: "outline",
            cells: {
              name: "Compact outline",
              strength: "Shows descriptive titles",
              tradeoff: "Takes more horizontal space",
            },
          },
          {
            id: "markers",
            cells: {
              name: "Chapter markers",
              strength: "Keeps the page quiet",
              tradeoff: "Less detail before opening",
            },
          },
        ],
      },
    },
    sources: {
      type: "Sources",
      props: {
        items: [
          {
            id: "dock-source",
            label: "Turn navigator source",
            href: "web/src/TurnNavigator.tsx:1",
          },
        ],
      },
    },
    continue: {
      type: "Continue",
      props: {
        label: "Continue with selection",
        instruction:
          "Explore the selected navigation option and explain the next small improvement.",
        requiresSelection: true,
      },
    },
  },
};
export const reportExample = {
  root: "result",
  elements: {
    result: {
      type: "Result",
      props: {
        title: "Where the wait goes",
        summary: "Illustrative data only. Select a stage to ask about it.",
      },
      children: ["metrics", "chart", "continue"],
    },
    metrics: {
      type: "Metrics",
      props: {
        items: [
          { label: "Sample size", value: "12 updates" },
          {
            label: "Median",
            value: "210 ms",
            detail: "Illustrative values, not live telemetry",
          },
        ],
      },
    },
    chart: {
      type: "BarChart",
      props: {
        id: "latency",
        title: "Update latency",
        unit: "ms",
        data: [
          { id: "queue", label: "Queue", value: 65 },
          { id: "fetch", label: "Snapshot", value: 120 },
          { id: "paint", label: "Render", value: 25 },
        ],
      },
    },
    continue: {
      type: "Continue",
      props: {
        label: "Explore selection",
        instruction:
          "Explain what we would measure to investigate the selected stage.",
        requiresSelection: true,
      },
    },
  },
};

/**
 * What the request button adds to a draft: one editable line of intent. How
 * to build a result is the result_publish tool's own description; a draft
 * never carries the format.
 */
export function interactiveRequest(kind: "comparison" | "report") {
  return kind === "comparison"
    ? "If it helps, show the options as an interactive result: a table I can sort and select from."
    : "If it helps, show the data as an interactive result: key metrics and a chart.";
}

/** The long fenced-block template earlier versions put in drafts; kept only
 * to show such replies still render (see intelligent-ui.test.mjs). */
export function legacyInteractiveRequest(kind: "comparison" | "report") {
  return `Please include an interactive ${kind === "comparison" ? "comparison of the options" : "data report"} with your answer, when useful. Keep the ordinary Markdown explanation, then provide ONE complete fenced block labelled yuzuno-ui containing a static json-render spec. Use real evidence; clearly label assumptions and sample data. Do not call publish_result or write files for this.\n\nUse only root and elements at the top level. Each element has type, props and optional children IDs. Root must be Result; only Result and Section may have children. Allowed components and exact props:\nResult {title,summary}; Section {title}; Text {text}; Metrics {items:[{label,value,detail?}]}; Table {id,title,columns:[{key,label}],rows:[{id,cells:{columnKey:string|number|boolean|null},sourceIds?:[sourceId]}],selectable?:boolean}; BarChart {id,title,unit,data:[{id,label,value:number,sourceIds?:[sourceId]}]}; Sources {items:[{id,label,href}]}; Continue {label,instruction,requiresSelection?:boolean}. Continue only adds instruction plus the user's selections to their existing draft. One Continue maximum. Sources must be real HTTP(S) URLs or files relative to this agent's working directory (optionally :line or #Lline).\n\nAll IDs and column keys begin with an ASCII letter and contain only letters, digits, underscores and hyphens (max 64 chars). IDs within each group are unique. Every row must have exactly the declared column keys. Plain static values only: no watch/on/actions/state/visible/repeat/slots/dynamic expressions/HTML/JS. Max 32 elements, depth 6, 100 table rows, 8 columns, 24 chart values, 64 KB JSON. Prefer a small result.\n\nExample (illustrative, replace with relevant content):\n\`\`\`yuzuno-ui\n${JSON.stringify(kind === "comparison" ? comparisonExample : reportExample, null, 2)}\n\`\`\``;
}
