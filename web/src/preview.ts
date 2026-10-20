import type { Agent, AgentDetail, Catchup, Workspace } from "./types";

// An explicit, read-only design specimen. Never used when connecting to a runtime.
export const previewMode =
  new URLSearchParams(window.location.search).get("preview") === "1" ||
  document.documentElement.dataset.visualPreview === "true";
// Only the explicitly labelled design specimen uses sample context occupancy.
export const previewContextPercent: Record<string, number> = {
  mikan: 46,
  mori: 78,
  hana: 94,
};
const base = {
  cwd: "/workspace/project",
  model: "gpt-5.4",
  createdAt: "2026-10-12T09:00:00Z",
  updatedAt: "2026-10-12T09:28:00Z",
  lastSeq: 8,
  reviewedSeq: 5,
};
const agents: Agent[] = [
  {
    ...base,
    id: "mikan",
    name: "Mikan",
    goal: "Make the workspace feel like home",
    color: "yellow",
    status: "idle",
    unreadCount: 1,
    pendingCount: 0,
    lastMessage: "A quieter workspace, with a little more personality.",
  },
  {
    ...base,
    id: "mori",
    name: "Mori",
    goal: "Explore remote session recovery",
    color: "green",
    status: "working",
    unreadCount: 0,
    pendingCount: 0,
    lastMessage: "Checking what survives a dropped connection.",
  },
  {
    ...base,
    id: "hana",
    name: "Hana",
    goal: "Turn real work into a useful catch-up",
    color: "pink",
    status: "waiting",
    unreadCount: 2,
    pendingCount: 1,
    lastMessage: "One small decision before I continue.",
  },
];
export const previewWorkspace: Workspace = {
  agents,
  defaultCwd: base.cwd,
  runtime: {
    connected: true,
    version: "visual specimen",
    account: "Preview · no runtime",
  },
};
export function previewDetail(id: string): AgentDetail {
  const agent = agents.find((a) => a.id === id) || agents[0];
  return {
    agent,
    turns: [
      {
        id: "turn-preview-1",
        status: "completed",
        items: [
          {
            id: "u1",
            type: "userMessage",
            content: [
              {
                type: "text",
                text: "Let’s make this a place I actually want to work in. Keep it calm, a little cute, and easy to pick up after a break.",
              },
            ],
          },
          {
            id: "c1",
            type: "agentMessage",
            phase: "commentary",
            text: "I’m looking at the conversation rhythm and the small details that make a desktop workspace feel natural.",
          },
          {
            id: "cmd1",
            type: "commandExecution",
            command: "npm run build",
            aggregatedOutput:
              "✓ TypeScript checked\n✓ Production build complete",
            status: "completed",
            exitCode: 0,
          },
          {
            id: "f1",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/workspace.css",
                kind: { type: "update" },
                diff: "+ background: var(--paper);\n+ color: var(--forest);",
              },
            ],
          },
          {
            id: "a1",
            type: "agentMessage",
            phase: "final_answer",
            text: "### A little room to think\n\nThe workspace now has a quieter rhythm: **your agents on the left, the work in the middle, and useful context close by.**\n\n- Each agent keeps a name, a purpose, and its own draft.\n- Tool runs tuck away into the turn they belong to.\n- New results and things that need you have separate signals.\n\nThe warm paper, leafy greens, and tiny yuzu add a little personality without getting in the way.\n\n> Next, try leaving a few agents working and coming back. The best test is how quickly you feel at home again.",
          },
        ],
      },
    ],
    pending:
      id === "hana"
        ? [
            {
              id: "request-preview",
              agentId: id,
              method: "item/tool/requestUserInput",
              createdAt: base.updatedAt,
              params: {
                questions: [
                  {
                    id: "scope",
                    header: "Catch-up scope",
                    question:
                      "Should the first catch-up include only changes since your last review?",
                    options: [
                      {
                        label: "Since last review",
                        description:
                          "Keep the briefing focused on what is new.",
                      },
                      {
                        label: "Entire session",
                        description: "Include the full work history.",
                      },
                    ],
                  },
                ],
              },
            },
          ]
        : [],
    artifacts: [
      {
        path: "notes/workspace-direction.md",
        name: "workspace-direction.md",
        kind: "text",
        sourceItemId: "a1",
      },
      {
        path: "src/workspace.css",
        name: "workspace.css",
        kind: "text",
        sourceItemId: "f1",
      },
    ],
  };
}
export const previewCatchup: Catchup = {
  generatedAt: "2026-10-12T09:30:00Z",
  source: "records",
  coverage: { fromSeq: 5, toSeq: 8 },
  items: [
    {
      id: "catch-hana",
      agentId: "hana",
      agentName: "Hana",
      kind: "pending",
      title: "One decision to keep going",
      body: "Choose how much history belongs in your catch-up.",
      turnId: "turn-preview-1",
      seq: 8,
    },
    {
      id: "catch-mikan",
      agentId: "mikan",
      agentName: "Mikan",
      kind: "result",
      title: "The workspace direction is ready",
      body: "A quieter conversation view, separate attention signals, and a warmer desktop palette.",
      turnId: "turn-preview-1",
      seq: 7,
    },
    {
      id: "catch-mori",
      agentId: "mori",
      agentName: "Mori",
      kind: "progress",
      title: "Recovery checks are in progress",
      body: "Exploring what survives a dropped connection. No result yet.",
      seq: 6,
    },
  ],
};
