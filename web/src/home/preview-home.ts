import type { HomeData, MachineLive, MachineLoad } from "./types";

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

/** Design specimen only: synthetic other machines, never requested from a Core. */
export const previewMachineLive: MachineLive = {
  machines: [
    {
      id: "preview-build",
      name: "build-box",
      state: "online",
      code: null,
      since: "2026-10-16T08:58:00Z",
      retryAt: null,
      observedAt: "2026-10-16T09:00:00Z",
      platform: "Linux",
      sameAs: null,
      load: {
        cpu: { pct: 23, cores: 32, observedAt: "2026-10-16T09:00:00Z" },
        memory: { totalMiB: 64307, usedMiB: 12698, availableMiB: 50176, estimate: false, observedAt: "2026-10-16T09:00:00Z" },
        disks: [
          {
            roles: ["root"],
            totalMiB: 953674,
            availableMiB: 421888,
            observedAt: "2026-10-16T08:59:58Z",
            error: null,
            permanent: null,
          },
        ],
        gpu: { state: "off", code: "not_enabled" },
      },
    },
    {
      id: "preview-mac",
      name: "lab-mac",
      state: "online",
      code: null,
      since: "2026-10-16T08:57:00Z",
      retryAt: null,
      observedAt: "2026-10-16T09:00:00Z",
      platform: "Darwin",
      sameAs: "preview-build",
      load: {
        cpu: { pct: 8, cores: 10, observedAt: "2026-10-16T09:00:00Z" },
        memory: { totalMiB: 32768, usedMiB: 9318, availableMiB: 15237, estimate: true, observedAt: "2026-10-16T08:59:59Z" },
        disks: [
          {
            roles: ["root"],
            totalMiB: 476837,
            availableMiB: 225280,
            observedAt: "2026-10-16T08:59:57Z",
            error: null,
            permanent: null,
          },
        ],
        gpu: { state: "off", code: "not_enabled" },
      },
    },
    {
      id: "preview-laptop",
      name: "laptop",
      state: "connecting",
      code: null,
      since: "2026-10-16T08:59:10Z",
      retryAt: null,
      observedAt: "2026-10-16T09:00:00Z",
      platform: null,
      sameAs: null,
      load: null,
    },
    {
      id: "preview-old",
      name: "old-server",
      state: "unavailable",
      code: "unclean_exit",
      since: "2026-10-16T08:55:00Z",
      retryAt: null,
      observedAt: "2026-10-16T09:00:00Z",
      platform: null,
      sameAs: null,
      load: null,
    },
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
