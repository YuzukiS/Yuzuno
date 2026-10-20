import type { HomeData, MachineLoad } from "./types";

/** Design preview only: a small, read-only Home with no runtime behind it. */
const markdown = (text: string) => ({
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["text"] },
    text: { type: "Markdown", props: { text }, children: [] },
  },
});

/** The preview workspace's Agents (preview.ts) have no project; these are the specimen's. */
export const previewProjectAgents: Record<string, string[]> = { "p-app": ["mikan", "mori"] };

export const previewMachineLoad: MachineLoad = {
  at: "2026-10-16T09:00:00Z",
  cpu: { cores: 16, totalPct: 38, jobsPct: 12, agentsPct: 9, otherPct: 17 },
  memory: { totalMiB: 32768, usedMiB: 14336, availableMiB: 18432, jobsMiB: 3072, agentsMiB: 2048 },
  gpus: [{ name: "Sample GPU", utilPct: 22, memUsedMiB: 3072, memTotalMiB: 16384, attribution: "unknown" }],
  jobs: [
    { id: "preview-job", name: "npm run build", agentId: "mori", agentName: "Mori", projectId: "p-app", cpuPct: 12, memMiB: 3072 },
  ],
};

export const previewHome: HomeData = {
  generatedAt: "2026-10-16T09:00:00Z",
  order: ["p-app"],
  needsYou: [
    {
      kind: "ask",
      projectId: "p-app",
      agentId: "mikan",
      agentName: "Mikan",
      sectionKey: "release",
      title: "Ship the onboarding copy today?",
      since: "2026-10-16T08:40:00Z",
    },
  ],
  projects: [
    {
      project: { id: "p-app", name: "Yuzuno app" },
      agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
      errors: [],
      pending: [],
      jobs: [{ id: "preview-job", name: "npm run build", status: "running", agentId: "mori", agentName: "Mori" }],
      unseen: 1,
      missing: [],
      brief: {
        version: 3,
        history: [],
        sections: [
          {
            key: "release",
            kind: "ask",
            title: "Ship the onboarding copy today?",
            version: 2,
            owner: { agentId: "mikan", name: "Mikan", state: "active" },
            updatedAt: "2026-10-16T08:40:00Z",
            updatedTurnId: null,
            body: markdown("The copy review is done. Two strings still mention the old menu."),
            ask: {
              question: "Ship today with the two strings fixed, or wait for the menu change?",
              reply: {
                options: [
                  { id: "ship", label: "Ship today" },
                  { id: "wait", label: "Wait for the menu" },
                ],
                freeText: true,
              },
              state: "open",
            },
            attachments: [],
            refs: {},
            seen: null,
            history: false,
          },
        ],
      },
    },
  ],
};
