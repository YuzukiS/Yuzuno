// Capture the real production UI with isolated, entirely synthetic API data.
// Run in a Yuzuno Job when working in a connected workspace. After building:
// YUZUNO_UI_DIST=/absolute/path/to/dist node web/tools/readme-screenshots.mjs
// Optional: YUZUNO_BROWSER_BIN, YUZUNO_PLAYWRIGHT_MODULE (installed package path).
// No Core, model, account, external network, preview UI, or injected UI styling.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  noCiRuns,
  noLiveJobs,
  noReviews,
  unmanagedUpdates,
} from "./browser-fixtures.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.YUZUNO_PLAYWRIGHT_MODULE || "playwright-core",
);
assert.ok(
  process.env.YUZUNO_UI_DIST,
  "Set YUZUNO_UI_DIST to a production build",
);
const dist = resolve(process.env.YUZUNO_UI_DIST);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "docs/images");
await mkdir(output, { recursive: true });
const host = "yuzuno-readme.test";
const now = Date.now();
const ago = (seconds) => new Date(now - seconds * 1000).toISOString();
const project = {
  id: "demo",
  name: "Fieldnotes · sample data",
  defaultDirs: { local: "/workspace/demo" },
  archivedAt: null,
  createdAt: ago(86400),
  updatedAt: ago(300),
};
const agentBase = {
  projectId: "demo",
  goal: "Build a calm, accessible notes app",
  cwd: "/workspace/demo",
  settings: {
    reasoningEffort: "medium",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  createdAt: ago(7200),
  updatedAt: ago(120),
  closedAt: null,
  status: "idle",
  connectionState: "connected",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 8,
  reviewedSeq: 8,
};
const agents = [
  {
    ...agentBase,
    id: "mori",
    name: "Mori",
    harness: "codex",
    model: "gpt-5.4",
    color: "sage",
    threadId: "sample-codex-session",
    workSummary: {
      kind: "result",
      source: "agent",
      text: "The first-run experience is ready to review.",
      turnId: "onboarding",
      itemId: "reply",
    },
  },
  {
    ...agentBase,
    id: "hana",
    name: "Hana",
    harness: "claude",
    model: "sonnet",
    color: "rose",
    claudeSessionId: "sample-claude-session",
    workSummary: {
      kind: "result",
      source: "agent",
      text: "Keyboard navigation and empty states checked.",
    },
  },
];
const currentTurn = {
  id: "onboarding",
  status: "completed",
  items: [
    {
      id: "request",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "Make the first-run experience feel welcoming. Add a useful empty state, keep keyboard navigation clear, and check the layout on mobile.",
        },
      ],
    },
    {
      id: "plan",
      type: "agentMessage",
      phase: "commentary",
      text: "I’ll add one clear starting action. Hana is reviewing the keyboard flow.",
    },
    {
      id: "edit",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "/workspace/demo/src/Welcome.tsx",
          kind: { type: "update" },
          diff: "+<h1>A little space for your next idea.</h1>\n+<button>Create your first note</button>",
        },
      ],
    },
    {
      id: "checks",
      type: "commandExecution",
      command: "npm run check",
      cwd: "/workspace/demo",
      status: "completed",
      exitCode: 0,
      aggregatedOutput:
        "TypeScript: no errors\n24 tests passed\nKeyboard navigation: passed\nMobile layout: passed\n",
    },
    {
      id: "reply",
      type: "agentMessage",
      phase: "final_answer",
      text: "The first-run experience is ready for a look.\n\n### A quieter starting point\n\n- A single **Create your first note** action replaces the empty list.\n- The layout stays comfortable on narrow screens.\n- Keyboard focus is visible from the first interaction.\n\n**24 checks passed.** Hana also reviewed the keyboard flow. The browser capture is running as a Job; its result will return here.\n\n[Implementation](src/Welcome.tsx:1) · [Review notes](docs/onboarding.md)",
    },
  ],
};
const detail = (agent) => ({
  agent,
  pending: [],
  messageReceipts: [],
  artifacts:
    agent.id === "mori"
      ? [
          {
            name: "Welcome.tsx",
            path: "/workspace/demo/src/Welcome.tsx",
            kind: "text",
            sourceItemId: "edit",
          },
          {
            name: "onboarding.md",
            path: "/workspace/demo/docs/onboarding.md",
            kind: "text",
            sourceItemId: "reply",
          },
        ]
      : [],
  turns:
    agent.id === "mori"
      ? [currentTurn]
      : [
          {
            id: "review",
            status: "completed",
            items: [
              {
                id: "hana-reply",
                type: "agentMessage",
                text: "The sample onboarding flow works with a keyboard and at narrow widths. Review notes are ready.",
              },
            ],
          },
        ],
});
const resources = { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 };
const jobBase = {
  agentId: "mori",
  agent: { name: "Mori" },
  machine: { name: "Core host" },
  resources,
  reservation: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 },
  cwd: "/workspace/demo",
  env: {},
  argv: ["npm", "run", "check"],
  requestId: "sample-job",
  usage: null,
  outputs: [],
  guardGit: true,
  timeoutSeconds: 900,
};
const jobs = [
  {
    ...jobBase,
    id: "sample-browser",
    name: "Browser screenshots",
    taskRef: "T-12",
    status: "running",
    reserved: true,
    reason: "Running within its reservation",
    createdAt: ago(200),
    startedAt: ago(125),
    finishedAt: null,
    cursor: 4,
    argv: ["npm", "run", "screenshots"],
    usage: {
      MemoryCurrent: String(512 * 1048576),
      MemoryPeak: String(700 * 1048576),
      TasksMax: "512",
    },
  },
  {
    ...jobBase,
    id: "sample-accessibility",
    name: "Accessibility review",
    taskRef: "T-13",
    agentId: "hana",
    agent: { name: "Hana" },
    status: "queued",
    reserved: false,
    reason: "Waiting for shared machine capacity",
    createdAt: ago(60),
    startedAt: null,
    finishedAt: null,
    cursor: 5,
    resources: { cpuMillis: 3000, memoryMiB: 4096, swapMiB: 0 },
    reservation: { cpuMillis: 3100, memoryMiB: 4160, swapMiB: 0 },
  },
  {
    ...jobBase,
    id: "sample-checks",
    name: "Typecheck & unit tests",
    taskRef: "T-12",
    status: "succeeded",
    reserved: false,
    reason: "success",
    createdAt: ago(700),
    startedAt: ago(690),
    finishedAt: ago(610),
    cursor: 3,
    outputs: ["reports/checks.json"],
  },
  {
    ...jobBase,
    id: "sample-mobile",
    name: "Mobile layout check",
    taskRef: "T-11",
    agentId: "hana",
    agent: { name: "Hana" },
    status: "succeeded",
    reserved: false,
    reason: "success",
    createdAt: ago(1300),
    startedAt: ago(1290),
    finishedAt: ago(1200),
    cursor: 2,
  },
];
const budget = {
  machine: {
    name: "Core host",
    memoryAvailableMiB: 12000,
    scope: "Sample data",
    maximumBudget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 },
    suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 },
  },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 },
  reserved: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 },
  queuedCount: 1,
  activeCount: 1,
};
const node = (type, props) => ({ type, props, children: [] });
const body = (entries) => ({
  root: "body",
  elements: {
    body: {
      type: "BriefBody",
      props: {},
      children: entries.map(([key]) => key),
    },
    ...Object.fromEntries(entries),
  },
});
const section = (key, title, agent, fields) => ({
  key,
  title,
  kind: "report",
  version: 1,
  owner: { agentId: agent.id, name: agent.name, state: "active" },
  updatedTurnId: null,
  updatedAt: ago(180),
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...fields,
});
const sections = [
  section("onboarding", "A welcoming first run", agents[0], {
    body: body([
      [
        "summary",
        node("Markdown", {
          text: "The new empty state is ready. One clear action, comfortable spacing, and visible keyboard focus.",
        }),
      ],
      [
        "metrics",
        node("Metrics", {
          items: [
            { label: "Checks passed", value: 24 },
            { label: "Screens reviewed", value: 3 },
            { label: "Open findings", value: 0 },
          ],
        }),
      ],
    ]),
  }),
  section("copy", "Choose the welcome message", agents[1], {
    kind: "ask",
    body: body([]),
    ask: {
      question: "Which welcome message should we use?",
      reply: {
        options: [
          { id: "warm", label: "A space for your next idea" },
          { id: "direct", label: "Create your first note" },
        ],
        freeText: true,
      },
      state: "open",
    },
  }),
];
const home = {
  generatedAt: ago(0),
  order: ["demo"],
  needsYou: [
    {
      kind: "ask",
      projectId: "demo",
      agentId: "hana",
      agentName: "Hana",
      sectionKey: "copy",
      title: "Choose the welcome message",
      since: ago(180),
    },
  ],
  projects: [
    {
      project: { id: "demo", name: project.name },
      agents: {
        working: 0,
        idle: 2,
        waiting: 0,
        error: 0,
        offline: 0,
        total: 2,
      },
      errors: [],
      pending: [],
      jobs: jobs
        .filter((job) => ["running", "queued"].includes(job.status))
        .map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          agentId: job.agentId,
          agentName: job.agent.name,
          taskRef: job.taskRef,
        })),
      brief: { version: 1, sections, history: [] },
      unseen: 2,
      missing: [],
    },
  ],
};
const machineLoad = {
  at: ago(0),
  cpu: { cores: 8, totalPct: 32, jobsPct: 18, agentsPct: null, otherPct: null },
  memory: {
    totalMiB: 16384,
    usedMiB: 6144,
    availableMiB: 10240,
    jobsMiB: 512,
    agentsMiB: null,
  },
  gpus: null,
  jobs: [
    {
      id: jobs[0].id,
      name: jobs[0].name,
      agentId: "mori",
      agentName: "Mori",
      projectId: "demo",
      cpuPct: 18,
      memMiB: 512,
    },
  ],
};
const responses = {
  "/api/workspace": {
    workspace: { id: "sample" },
    projects: [project],
    projectUsage: { demo: { agents: 2, tasks: 3 } },
    agents,
    runtime: { connected: true },
    defaultCwd: "/workspace/demo",
  },
  "/api/home": home,
  "/api/machine-load": machineLoad,
  "/api/projects/demo/repo-activity": { observedAt: ago(0), repositories: [] },
  "/api/updates": unmanagedUpdates,
  "/api/jobs/budget": budget,
  "/api/jobs": { jobs, liveJobs: [], hasMore: false, nextBefore: null },
  "/api/jobs/live": noLiveJobs,
  "/api/ci": noCiRuns,
  "/api/reviews": noReviews,
  "/api/backlog": { observedAt: ago(0), agents: {} },
  "/api/machines": {
    machines: [
      {
        id: "local",
        name: "Core host",
        kind: "local",
        defaultCwd: "/workspace/demo",
      },
    ],
  },
  "/api/models": { models: [] },
  "/api/agents/mori/codex/usage": {
    revision: 1,
    status: "ready",
    account: { type: "chatgpt", label: "Sample account", planType: null },
    accountId: "sample-account",
    source: {
      generation: "sample",
      label: "Core host",
      machineId: "local",
      runtimeId: null,
    },
    checkedAt: ago(0),
    observedAt: ago(0),
    ordinaryUsageAllowed: true,
    error: null,
    buckets: [
      {
        limitId: "codex",
        limitName: "Codex",
        planType: null,
        observedAt: ago(0),
        credits: null,
        primary: {
          usedPercent: 18,
          windowDurationMins: 300,
          resetsAt: Math.floor(now / 1000) + 7200,
          observedAt: ago(0),
        },
        secondary: {
          usedPercent: 31,
          windowDurationMins: 10080,
          resetsAt: Math.floor(now / 1000) + 259200,
          observedAt: ago(0),
        },
      },
    ],
  },
  "/api/catchup": {
    items: [],
    generatedAt: ago(0),
    source: "records",
    coverage: { fromSeq: 0, toSeq: 0 },
  },
  ...Object.fromEntries(
    agents.map((agent) => [`/api/agents/${agent.id}`, detail(agent)]),
  ),
  ...Object.fromEntries(jobs.map((job) => [`/api/jobs/${job.id}`, job])),
};
const errors = [];
const unexpected = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  locale: "en-US",
  timezoneId: "UTC",
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.EventSource = class {
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    close() {}
  };
  localStorage.setItem(
    "yuzuno.appearance",
    JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }),
  );
  localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
  localStorage.setItem(
    "yuzuno.projectScope.sample",
    JSON.stringify("project:demo"),
  );
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== host) {
    unexpected.push("External request blocked");
    return route.abort();
  }
  const path = url.pathname;
  if (request.method() !== "GET") {
    if (path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (
      /^\/api\/agents\/(mori|hana)\/read$/.test(path) ||
      path === "/api/projects/demo/brief/seen"
    )
      return route.fulfill({ json: { ok: true } });
  } else {
    if (responses[path]) return route.fulfill({ json: responses[path] });
    if (/^\/api\/jobs\/sample-[a-z]+\/logs$/.test(path)) {
      const text =
        "Sample data — browser capture\n✓ Desktop viewport ready\n✓ Mobile layout checked\nCapturing final screenshots…\n";
      return route.fulfill({
        json: {
          text,
          offset: 0,
          nextOffset: text.length,
          oldestOffset: 0,
          totalBytes: text.length,
          truncated: false,
        },
      });
    }
    if (!path.startsWith("/api/")) {
      const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
      assert.ok(file.startsWith(`${dist}/`));
      return route.fulfill({
        body: await readFile(file),
        contentType:
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".png": "image/png",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".ttf": "font/ttf",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
          }[extname(file)] || "application/octet-stream",
      });
    }
  }
  unexpected.push(`${request.method()} ${path}`);
  return route.fulfill({
    status: 404,
    json: { error: "Not in the sample fixture" },
  });
});
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1598, 998);
  assert.deepEqual(errors, [], "No UI exceptions");
  assert.deepEqual(
    unexpected,
    [],
    "All requests stay within the explicit fixture",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal page overflow",
  );
  await page.screenshot({
    path: resolve(output, `${name}.png`),
    animations: "disabled",
  });
  console.log(
    `Captured docs/images/${name}.png (1600 × 1000, synthetic sample data)`,
  );
}
try {
  await page.goto(`https://${host}/`);
  await page.locator("[data-composer-input]").waitFor();
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  await page.locator("#home-project-demo [data-section-key='copy']").waitFor();
  await page.getByText("32%", { exact: true }).waitFor();
  await capture("home");
  await page.locator(".agent-select").filter({ hasText: "Mori" }).click();
  await page.locator("[data-composer-input]").waitFor();
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture("conversation");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .locator(".job-row")
    .filter({ hasText: "Typecheck & unit tests" })
    .waitFor();
  await page
    .locator(".job-row")
    .filter({ hasText: "Browser screenshots" })
    .click();
  await page.locator(".job-log").waitFor();
  await capture("jobs");
  console.log(
    "PASS: 3 actual UI screenshots; no external requests or UI exceptions.",
  );
} finally {
  await browser.close();
}
