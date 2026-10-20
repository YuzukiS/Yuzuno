import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { COMPONENT_DESCRIPTIONS, componentProps } from "./contract.ts";

// The format itself is defined once, in contract.ts; this adds the renderer.
export * from "./contract.ts";

export const catalog = defineCatalog(schema, {
  components: {
    Clarification: { props: componentProps.Clarification, description: COMPONENT_DESCRIPTIONS.Clarification },
    Result: { props: componentProps.Result, slots: ["default"], description: COMPONENT_DESCRIPTIONS.Result },
    Section: { props: componentProps.Section, slots: ["default"], description: COMPONENT_DESCRIPTIONS.Section },
    Text: { props: componentProps.Text, description: COMPONENT_DESCRIPTIONS.Text },
    Metrics: { props: componentProps.Metrics, description: COMPONENT_DESCRIPTIONS.Metrics },
    Table: { props: componentProps.Table, description: COMPONENT_DESCRIPTIONS.Table },
    BarChart: { props: componentProps.BarChart, description: COMPONENT_DESCRIPTIONS.BarChart },
    Sources: { props: componentProps.Sources, description: COMPONENT_DESCRIPTIONS.Sources },
    Continue: { props: componentProps.Continue, description: COMPONENT_DESCRIPTIONS.Continue },
    TaskStatus: { props: componentProps.TaskStatus, description: COMPONENT_DESCRIPTIONS.TaskStatus },
  },
  actions: {},
});
