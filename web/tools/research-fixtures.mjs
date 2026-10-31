// Two synthetic research desks (T-9) with different shapes, for the
// contract and the renderer: neither is real data, and both render through
// the same ResearchDesk with no code of their own.

/** A two-arm dose study whose outcome definition changed from v1 to v2. */
export const doseStudy = {
  key: "dose-study",
  kind: "report",
  title: "Dose study (synthetic)",
  attachments: [
    { name: "results.json", path: "/home/me/study/results.json" },
    { name: "protocol.md", path: "/home/me/study/protocol.md" },
    { name: "paper.tex", path: "/home/me/study/paper.tex" },
  ],
  body: {
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["desk"] },
      desk: {
        type: "ResearchDesk",
        props: {
          schema: "research/1",
          title: "Does the higher dose shorten recovery?",
          claims: [
            {
              id: "c1",
              title: "High dose shortens recovery",
              statement: "Against placebo, the high dose shortens mean recovery by about two days under the v2 outcome.",
              status: "conditional",
              primary: "high-v2",
              plots: ["recovery-v2", "recovery-v1"],
              paper: [{ label: "Abstract, sentence 3", cite: { source: "paper", lines: "12" } }],
              conditions: [
                { id: "adults", text: "Adults 18-65 only" },
                { id: "site", text: "One site, one season" },
              ],
              statements: [
                { id: "s1", stance: "can", kind: "criterion", text: "The 95% interval of high dose − placebo excludes 0 under v2.", basis: ["high-v2"] },
                { id: "s2", stance: "cannot", kind: "interpretation", text: "The low dose works.", basis: ["low-v2"] },
                { id: "s3", stance: "can", kind: "exploratory", text: "Older adults may differ; not tested.", basis: [] },
              ],
              dependsOn: [{ id: "recovery", version: 2 }],
            },
          ],
          plots: [
            {
              id: "recovery-v2",
              title: "Recovery time vs placebo (v2)",
              unit: "days",
              digits: 2,
              interval: "95% interval",
              reference: { value: 0, label: "0 = no difference" },
              diffLabel: "Δ = arm − placebo",
              partsLabel: "Each arm's own mean",
              rows: [
                {
                  id: "low-v2",
                  label: "Low dose",
                  compare: "low",
                  estimate: {
                    value: { from: "results.json", pointer: "/v2/low/diff" },
                    low: { from: "results.json", pointer: "/v2/low/lo" },
                    high: { from: "results.json", pointer: "/v2/low/hi" },
                    definition: { id: "recovery", version: 2 },
                    cite: { source: "results" },
                  },
                  parts: [
                    { id: "low-v2-arm", label: "Low dose", estimate: { value: { from: "results.json", pointer: "/v2/low/arm" } } },
                    { id: "low-v2-placebo", label: "Placebo", estimate: { value: { from: "results.json", pointer: "/v2/placebo" } } },
                  ],
                },
                {
                  id: "high-v2",
                  label: "High dose",
                  compare: "high",
                  estimate: {
                    value: { from: "results.json", pointer: "/v2/high/diff" },
                    low: { from: "results.json", pointer: "/v2/high/lo" },
                    high: { from: "results.json", pointer: "/v2/high/hi" },
                    definition: { id: "recovery", version: 2 },
                    cite: { source: "results" },
                  },
                  parts: [
                    { id: "high-v2-arm", label: "High dose", estimate: { value: { from: "results.json", pointer: "/v2/high/arm" } } },
                    { id: "high-v2-placebo", label: "Placebo", estimate: { value: { from: "results.json", pointer: "/v2/placebo" } } },
                  ],
                },
              ],
            },
            {
              id: "recovery-v1",
              title: "Recovery time vs placebo (v1, superseded)",
              unit: "days",
              digits: 2,
              reference: { value: 0, label: "0 = no difference" },
              rows: [
                { id: "low-v1", label: "Low dose", compare: "low", estimate: { value: -0.9, low: -2.1, high: 0.3, definition: { id: "recovery", version: 1 }, cite: { source: "protocol", lines: "40-44" } } },
                { id: "high-v1", label: "High dose", compare: "high", estimate: { value: -2.6, low: -3.8, high: -1.4, definition: { id: "recovery", version: 1 }, cite: { source: "protocol", lines: "40-44" } } },
              ],
            },
          ],
          sources: [
            { id: "results", label: "Analysis output", kind: "data", snapshot: "results.json", location: "study/results.json", revision: "0f3a9c1" },
            { id: "protocol", label: "Protocol", kind: "notes", snapshot: "protocol.md" },
            { id: "paper", label: "Draft", kind: "paper", snapshot: "paper.tex", sha256: "0".repeat(64) },
          ],
          definitions: [
            {
              id: "recovery",
              title: "Recovery",
              versions: [
                { version: 1, text: "Symptom-free for 48 hours.", frozenAt: "2026-09-01T00:00:00Z", cite: { source: "protocol", lines: "20-24" } },
                { version: 2, text: "Symptom-free for 72 hours.", frozenAt: "2026-10-01T00:00:00Z", cite: { source: "protocol", lines: "30-34" }, change: "48 h counted relapses as recovered." },
              ],
            },
          ],
          revisions: [
            { id: "rev1", claim: "c1", target: "Abstract, sentence 3", definition: { id: "recovery", from: 1, to: 2 }, basis: "declared", draft: "…shortens recovery (72 h symptom-free) by about two days." },
          ],
          plans: [
            {
              id: "older",
              title: "Re-read the older subgroup",
              question: "Does the effect hold for adults over 50?",
              state: "candidate",
              inputs: [{ label: "Analysis output", source: "results" }],
              params: [{ name: "age", value: "≥ 50" }],
              compute: "cpu",
              budget: "minutes",
              outputs: ["A subgroup table"],
              notProduced: ["Any new trial data"],
            },
          ],
        },
      },
    },
  },
};

/** A four-condition benchmark read as fractions and shown in percent, one definition, a plan linked to a task. */
export const benchmark = {
  key: "pass-bench",
  kind: "report",
  title: "Compiler pass benchmark (synthetic)",
  attachments: [
    { name: "bench.json", path: "/home/me/bench/bench.json" },
    { name: "method.md", path: "/home/me/bench/method.md" },
  ],
  body: {
    root: "body",
    elements: {
      body: { type: "BriefBody", props: {}, children: ["desk"] },
      desk: {
        type: "ResearchDesk",
        props: {
          schema: "research/1",
          claims: [
            {
              id: "speed",
              title: "The pass speeds up O2 builds",
              statement: "The new pass lowers median runtime on O2 builds on both targets; O3 shows no reliable change.",
              status: "supported",
              primary: "o2-arm",
              plots: ["speedup"],
              statements: [{ id: "k1", stance: "cannot", kind: "criterion", text: "O3 builds get faster.", basis: ["o3-arm", "o3-x86"] }],
              dependsOn: [{ id: "timing", version: 1 }],
            },
          ],
          plots: [
            {
              id: "speedup",
              title: "Runtime change with the pass",
              unit: "%",
              digits: 1,
              // The summary stores fractions; shown in percent.
              scale: 100,
              reference: { value: 0, label: "0 = unchanged" },
              rows: ["o2-arm", "o2-x86", "o3-arm", "o3-x86"].map((id, i) => ({
                id,
                label: id.replace("-", " · "),
                group: id.startsWith("o2") ? "O2" : "O3",
                estimate: {
                  value: { from: "bench.json", pointer: `/conditions/${i}/change` },
                  low: { from: "bench.json", pointer: `/conditions/${i}/lo` },
                  high: { from: "bench.json", pointer: `/conditions/${i}/hi` },
                  definition: { id: "timing", version: 1 },
                },
              })),
            },
          ],
          sources: [
            { id: "bench", label: "Benchmark summary", kind: "data", snapshot: "bench.json" },
            { id: "method", label: "Method", kind: "notes", snapshot: "method.md" },
          ],
          definitions: [{ id: "timing", title: "Timing window", versions: [{ version: 1, text: "Median of 30 runs after 5 warm-ups.", cite: { source: "method", lines: "3-9" } }] }],
          plans: [
            {
              id: "rerun",
              title: "Re-run O3 on a quiet machine",
              question: "Is the O3 interval wide because of machine noise?",
              state: "approved",
              compute: "cpu",
              outputs: ["A new bench.json"],
              links: [{ kind: "task", id: "T-12" }],
              note: "Linked task shows its own state; a finished run is not a result that holds.",
            },
          ],
        },
      },
    },
  },
};

/** What the attachments of each desk hold, for a Core or UI test that writes them. */
export const fixtureFiles = {
  "results.json": {
    v2: {
      placebo: 9.4,
      low: { diff: -0.62, lo: -1.71, hi: 0.47, arm: 8.78 },
      high: { diff: -2.04, lo: -3.12, hi: -0.96, arm: 7.36 },
    },
  },
  "protocol.md": "# Protocol (synthetic)\n\nRecovery v1: symptom-free for 48 hours.\n\nRecovery v2: symptom-free for 72 hours.\n",
  "paper.tex": "\\section{Results} High dose shortens recovery (synthetic).\n",
  "bench.json": {
    conditions: [
      { change: -0.061, lo: -0.08, hi: -0.042 },
      { change: -0.044, lo: -0.063, hi: -0.025 },
      { change: -0.008, lo: -0.039, hi: 0.023 },
      { change: 0.004, lo: -0.026, hi: 0.034 },
    ],
  },
  "method.md": "# Method (synthetic)\n\nMedian of 30 runs after 5 warm-ups.\n",
};
