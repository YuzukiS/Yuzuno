// YN-16 S5: twelve synthetic samples of what an Agent might be asked, the
// form brief_guide interactive says fits, and a section in that form. Eight
// call for an interactive part, four for none (a single status, a yes or no,
// a number, a task's state Core already shows). brief-samples.test.mjs checks
// each against the contract and the guide; brief-samples-check.mjs draws and
// uses each in Chromium. They check the format and Yuzuno's drawing of it, not
// a model's judgement: no model is asked anything.

const node = (type, props, children, extra) => ({ type, props, ...(children ? { children } : {}), ...(extra ?? {}) });
const md = (text, visible) => node("Markdown", { text }, undefined, visible ? { visible } : undefined);
/** A report whose summary is its lead and the given visual, at a size. */
const report = (key, title, size, lead, visual, rest, extra = {}) => ({
  op: "put", key, kind: "report", title, ...extra,
  body: { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", ...(visual ? { visual } : {}), size } }, ["lead", ...Object.keys(rest).filter((id) => rest[id].top)]),
    lead: md(lead),
    ...Object.fromEntries(Object.entries(rest).map(([id, { top, ...element }]) => [id, element])),
  } },
});
const top = (element) => ({ ...element, top: true });

/** A synthetic drawing of a bike, the parts sample's kept image. */
export const BIKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260" width="400" height="260"><rect width="400" height="260" fill="#eef2ea"/><circle cx="100" cy="180" r="60" fill="none" stroke="#445" stroke-width="8"/><circle cx="300" cy="180" r="60" fill="none" stroke="#445" stroke-width="8"/><path d="M100 180 L180 100 L300 180 M180 100 L250 100" stroke="#a54" stroke-width="10" fill="none"/><circle cx="300" cy="180" r="14" fill="#a54"/></svg>`;

/**
 * Each sample: the request, the form the guide gives it, whether it calls for
 * an interactive part (`draws`), the component types its section must use,
 * and the section, a put change. `files` are the kept images Core would have
 * (as brief_get gives them), for the ones that show a picture.
 */
export const SAMPLES = [
  {
    id: "recipe",
    request: "Scale this scone recipe for however many guests come, vegan or not.",
    shape: "A quantity to scale: NumberInput and Switch with a Calc; the method as Steps to walk.",
    draws: true,
    uses: ["NumberInput", "Switch", "Calc", "Steps"],
    put: report("sample-recipe", "Scones for the guests", "wide", "The amounts scale with the guests; the vegan version swaps butter for oil.", "amounts", {
      amounts: top(node("Group", {}, ["guests", "vegan", "list"])),
      guests: node("NumberInput", { name: "guests", label: "Guests", value: 4, min: 1, max: 16, unit: "people", control: "both" }),
      vegan: node("Switch", { name: "vegan", label: "Vegan", value: false }),
      list: node("Calc", { items: [
        { id: "flour", label: "Flour", expr: "round(250 * guests / 4)", unit: "g", digits: 0 },
        { id: "butter", label: "Butter", expr: "round(60 * guests / 4)", unit: "g", digits: 0, when: "!vegan" },
        { id: "oil", label: "Olive oil", expr: "round(45 * guests / 4)", unit: "ml", digits: 0, when: "vegan" },
        { id: "milk", label: "Milk", expr: "round(150 * guests / 4)", unit: "ml", digits: 0 },
      ] }),
      method: top(node("Steps", { title: "Method", mode: "walk", steps: [
        { id: "mix", title: "Rub the fat into the flour", time: "3 min" },
        { id: "milk", title: "Stir in the milk", text: "Just until it holds together." },
        { id: "cut", title: "Cut and bake", time: "12 min", text: "220 °C." },
        { id: "cool", title: "Cool on a rack" },
      ] })),
    }),
  },
  {
    id: "bill",
    request: "Split our ¥684 dinner bill with a tip.",
    shape: "A quantity to split: NumberInput and Segmented with a Calc as Metrics, and a Button back to the start.",
    draws: true,
    uses: ["NumberInput", "Segmented", "Switch", "Calc", "Button"],
    put: report("sample-bill", "Splitting the dinner bill", "wide", "The bill was **¥684**. Set how many share it and the tip.", "split", {
      split: top(node("Group", {}, ["people", "tip", "roundUp", "shares", "reset"])),
      people: node("NumberInput", { name: "people", label: "People", value: 4, min: 1, max: 12 }),
      tip: node("Segmented", { name: "tip", label: "Tip", value: 10, options: [{ value: 0, label: "None" }, { value: 10, label: "10%" }, { value: 15, label: "15%" }] }),
      roundUp: node("Switch", { name: "roundUp", label: "Round each share up", value: false }),
      shares: node("Calc", { layout: "metrics", items: [
        { id: "total", label: "Total", expr: "round(684 * (1 + tip / 100), 2)", prefix: "¥", digits: 2 },
        { id: "each", label: "Each", expr: "roundUp ? ceil(total / people) : round(total / people, 2)", prefix: "¥", digits: 2, emphasis: true },
      ] }),
      reset: node("Button", { label: "Back to 4, 10%" }, undefined, { on: { press: [
        { action: "setState", params: { statePath: "/people", value: 4 } },
        { action: "setState", params: { statePath: "/tip", value: 10 } },
      ] } }),
    }),
  },
  {
    id: "savings",
    request: "If I save each month, how much will I have?",
    shape: "A what-if: sliders and a Calc with ^ and ?: for a rate of 0.",
    draws: true,
    uses: ["NumberInput", "Calc"],
    put: report("sample-savings", "What monthly saving adds up to", "wide", "Monthly saving, compounded monthly. **Not advice**: rates change.", "plan", {
      plan: top(node("Group", {}, ["monthly", "rate", "years", "outcome"])),
      monthly: node("NumberInput", { name: "monthly", label: "Each month", value: 500, min: 50, max: 5000, step: 50, prefix: "€", control: "slider" }),
      rate: node("NumberInput", { name: "rate", label: "Yearly rate", value: 3, min: 0, max: 8, step: 0.5, unit: "%", control: "both" }),
      years: node("NumberInput", { name: "years", label: "Years", value: 10, min: 1, max: 40 }),
      outcome: node("Calc", { layout: "metrics", items: [
        { id: "months", label: "Months", expr: "years * 12", digits: 0 },
        { id: "monthlyRate", label: "Monthly rate", expr: "rate / 1200", when: "false" },
        { id: "saved", label: "Paid in", expr: "monthly * months", prefix: "€", digits: 0 },
        { id: "total", label: "With interest", expr: "rate == 0 ? saved : round(monthly * ((1 + monthlyRate) ^ months - 1) / monthlyRate, 2)", prefix: "€", digits: 0, emphasis: true },
      ] }),
    }),
  },
  {
    id: "parts",
    request: "Which part of my bike is the derailleur, and what do the others do?",
    shape: "The parts of a thing: a Figure over its picture, with a Segmented naming the same parts.",
    draws: true,
    uses: ["Segmented", "Figure"],
    put: report("sample-parts", "The bike, part by part", "large", "The derailleur moves the chain across the rear gears.", "look", {
      look: top(node("Group", {}, ["part", "picture"])),
      part: node("Segmented", { name: "part", label: "Part", value: "derailleur", options: [{ value: "frame", label: "Frame" }, { value: "derailleur", label: "Derailleur" }, { value: "chain", label: "Chain" }] }),
      picture: node("Figure", { image: "bike.svg", alt: "A bike from the side", select: "part", hotspots: [
        { id: "frame", label: "Frame", x: 45, y: 38, detail: "Holds every other part." },
        { id: "derailleur", label: "Derailleur", x: 75, y: 75, detail: "Moves the chain between the seven rear gears." },
        { id: "chain", label: "Chain", x: 50, y: 70, detail: "Carries the pedals' force to the rear wheel." },
      ] }),
    }, { attachments: [{ name: "bike.svg", path: "/home/me/samples/bike.svg" }] }),
    files: [{ name: "bike.svg", svg: BIKE_SVG }],
  },
  {
    id: "flow",
    request: "How does a change get from a branch to main here?",
    shape: "A process with a decision and a loop: a Diagram.",
    draws: true,
    uses: ["Diagram"],
    put: report("sample-flow", "How a change reaches main", "wide", "A change merges only after its own CI and one review round pass.", "chart", {
      chart: top(node("Diagram", { direction: "right", nodes: [
        { id: "push", label: "Push the branch", shape: "round" },
        { id: "ci", label: "PR CI", detail: "Every test, on GitHub-hosted runners." },
        { id: "review", label: "Review round" },
        { id: "green", label: "All green?", shape: "diamond" },
        { id: "fix", label: "Fix and push", tone: "warn" },
        { id: "merge", label: "Merged", shape: "round", tone: "ok" },
      ], edges: [
        { from: "push", to: "ci" }, { from: "ci", to: "review" }, { from: "review", to: "green" },
        { from: "green", to: "merge", label: "yes" }, { from: "green", to: "fix", label: "no" }, { from: "fix", to: "ci", style: "dashed" },
      ] })),
    }),
  },
  {
    id: "wifi",
    request: "The Wi-Fi keeps dropping. What do I try, in order?",
    shape: "A procedure followed step by step with busy hands: Steps, walk.",
    draws: true,
    uses: ["Steps"],
    put: report("sample-wifi", "When the Wi-Fi drops", "small", "Try these in order; stop at the first that helps.", "steps", {
      steps: top(node("Steps", { mode: "walk", steps: [
        { id: "restart", title: "Restart the router", time: "2 min", text: "Unplug it for 30 seconds." },
        { id: "closer", title: "Move closer to it", text: "Walls and floors weaken the signal." },
        { id: "band", title: "Switch to the 5 GHz network" },
        { id: "forget", title: "Forget and rejoin the network" },
        { id: "call", title: "Call the provider", text: "Say which steps you tried." },
      ] })),
    }),
  },
  {
    id: "release",
    request: "When does release 2 reach users?",
    shape: "Three or more dated events: a Timeline, the planned one said to be planned.",
    draws: true,
    uses: ["Timeline"],
    put: report("sample-release", "Release 2: where it is", "wide", "The candidate passed its checks; the user installs it after the notes are read.", "when", {
      when: top(node("Timeline", { items: [
        { id: "cut", at: "2026-11-03", title: "Candidate cut", state: "done" },
        { id: "checks", at: "2026-11-05", title: "Checks passed", state: "done", text: "Every acceptance check on a clean machine." },
        { id: "notes", at: "2026-11-07", title: "Notes reviewed", state: "now" },
        { id: "install", at: "Week 46", title: "Install", state: "next", text: "Planned, not promised: the user decides when." },
      ] })),
    }),
  },
  {
    id: "compare",
    request: "Compare plan A and plan B for the GPU budget.",
    shape: "A choice between views: a Segmented and the Metrics each view shows.",
    draws: true,
    uses: ["Segmented", "Metrics"],
    put: report("sample-compare", "Plan A or plan B", "wide", "B costs a third more and halves the gap between seeds.", "choose", {
      choose: top(node("Group", {}, ["plan", "a", "b"])),
      plan: node("Segmented", { name: "plan", label: "Plan", value: "a", options: [{ value: "a", label: "Plan A" }, { value: "b", label: "Plan B" }] }),
      a: node("Metrics", { items: [{ label: "GPU-days", value: 3 }, { label: "Seed gap", value: 0.031 }] }, undefined, { visible: { $state: "/plan", eq: "a" } }),
      b: node("Metrics", { items: [{ label: "GPU-days", value: 4 }, { label: "Seed gap", value: 0.015 }] }, undefined, { visible: { $state: "/plan", eq: "b" } }),
    }),
  },
  {
    id: "status",
    request: "Is the build green?",
    shape: "A single status: one sentence of Markdown, no component.",
    draws: false,
    uses: ["Markdown"],
    put: report("sample-status", "Build", "small", "The build on main is **green** as of the last push.", null, {}),
  },
  {
    id: "yesno",
    request: "Did the review pass?",
    shape: "A yes or no: one sentence of Markdown, no component.",
    draws: false,
    uses: ["Markdown"],
    put: report("sample-yesno", "Review of the patch", "small", "**Yes**: the review passed with no findings.", null, {}),
  },
  {
    id: "number",
    request: "How many tests failed?",
    shape: "One number: one sentence of Markdown, no component.",
    draws: false,
    uses: ["Markdown"],
    put: report("sample-number", "Failing tests", "small", "**3 tests** fail, all in the importer.", null, {}),
  },
  {
    id: "task",
    request: "What's the state of T-12?",
    shape: "A task's state Core already shows: a LiveRefs item, never drawn.",
    draws: false,
    uses: ["LiveRefs"],
    put: report("sample-task", "Where T-12 is", "small", "T-12 is the importer fix; its live state is below.", null, {
      refs: top(node("LiveRefs", { items: [{ kind: "task", id: "T-12", label: "Importer fix" }] })),
    }),
  },
];

/** The component types brief_guide interactive covers: none of them belongs in a sample that should not draw. */
export const INTERACTIVE = ["NumberInput", "Switch", "Segmented", "Calc", "Button", "Diagram", "Figure", "Steps", "Timeline"];
