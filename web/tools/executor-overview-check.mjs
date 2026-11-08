// T-43 S3: an executor's session tabs and its Overview in Chromium (the
// user's t43-templates preview), with every API answered here (no Core, no
// CLI, no daily configuration) and synthetic executors: one at work with a
// PR in review, one waiting for your approval, one archived with its result.
// At 1440 and 390 (a phone, touch), light and dark, English and Chinese:
// - an executor opens on its Overview, the tab bar above it; its
//   Conversation and the composer are hidden, not gone;
// - nothing in the Overview is wider than it, no step's label runs into
//   its record, and every card is inside the pane;
// - the steps show five, then all on request;
// - the waiting executor's request card is in its Overview only;
// - on a phone each tab, the task link and the steps toggle are 44 px tall;
// - its Conversation shows the composer again; back to the Overview.
// - T-43 S4: two executors at a gate asked on Home with their own Asks (a
//   design note, an irreversible runbook step): each Overview has the Ask's
//   card inside the pane, its gate step waits for you, its row's ring says
//   needs you, and its Conversation shows the same card instead.
// - YN-46: at about 2000, 1440, 1100 and 390 px, light and dark, English and
//   Chinese, and at 1440 again with At a glance closed. Where the pane is
//   1000 px or wider (2000; 1440 with At a glance closed: open, it leaves the
//   pane 928 px), two columns: its steps and what it is doing now on the
//   right, beside the materials, changes, evidence and final report, which
//   are no wider than 760 px; the steps column stays in view while the other
//   scrolls. Narrower, the single column in today's order. A long acceptance
//   stops at about 12 lines and scrolls inside, a fade at the edge with more
//   beyond it; a short one keeps its own height. The gate card and the
//   red → green row in both.
// Screenshots of each, for the design Ask.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-overview-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-43 S3/S4, YN-46", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], measures: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-overview.test";

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const head = "7d10aa".padEnd(40, "3");
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "codex", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle" };
const lifecycle = (id, key, title, template, extra = {}) => ({ state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead 2" },
  task: { id: key, title }, template, dispatchedAt: ago(72.5), since: ago(6.5), ...extra });
const RED = { id: "red-first", label: "Red first" }, DESIGN = { id: "design-first", label: "Design first" };
const RUNBOOK = { id: "gated-runbook", label: "Gated runbook" };
// Synthetic executors (names and texts made up for this check).
const agents = [
  { ...base, id: "lead", name: "Dev Lead 2", kind: "lead", status: "working", workSummary: { kind: "progress", source: "agent", text: "Merging #702" } },
  { ...base, id: "yn22", name: "YN-22 · Red first", kind: "executor", status: "working",
    workSummary: { kind: "progress", source: "agent", text: "Review round 1 running on #688 at 7d10aa" },
    executor: lifecycle("yn22", "YN-22", "Fix the selection that jumps after a refresh", RED) },
  { ...base, id: "yn21", name: "YN-21 · Design first", kind: "executor", status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Allow npm run build", requestId: "q1" },
    executor: lifecycle("yn21", "YN-21", "Export and import device preferences", DESIGN) },
  { ...base, id: "yn29", name: "YN-29 · Small fix", kind: "executor", closedAt: ago(30), releasedAt: ago(30), releasedBy: "user",
    executor: lifecycle("yn29", "YN-29", "Status bar wording", { id: "small-fix", label: "Small fix" }, { state: "archived", since: ago(30) }) },
  // T-43 S4: at a gate, asked on Home.
  { ...base, id: "yn30", name: "YN-30 · Design first", kind: "executor", status: "idle",
    workSummary: { kind: "progress", source: "agent", text: "在 Home 请你批准设计说明" },
    executor: lifecycle("yn30", "YN-30", "设置页：导出/导入设备偏好", DESIGN, { task: { id: "YN-30", title: "设置页：导出/导入设备偏好", shortName: "导出设备偏好" } }) },
  { ...base, id: "yn31", name: "YN-31 · Gated runbook", kind: "executor", status: "idle",
    workSummary: { kind: "progress", source: "agent", text: "在 Home 请你批准第 2 步" },
    executor: lifecycle("yn31", "YN-31", "轮换发布签名密钥（合成示例）", RUNBOOK, { task: { id: "YN-31", title: "轮换发布签名密钥（合成示例）", shortName: "轮换签名密钥" } }) },
];
const approval = { id: "q1", agentId: "yn21", method: "item/commandExecution/requestApproval", createdAt: ago(12),
  params: { command: "npm run build", cwd: "/fixture/app/.worktrees/yn-21", reason: "Build the design note's preview" } };
const materials = (worktree, acceptance) => ({ capturedAt: ago(72), acceptance, repository: "owner/repo", baseSha: "635caab1".padEnd(40, "0"),
  worktree, returnRequirements: "Red then green; PR at a frozen head; evidence Job", handoverVersion: 3,
  contextSummary: "The selection jumps to the first row after a refresh when the list is filtered. Reproduced with a synthetic list of 40 rows." });
// A dispatch's acceptance as long as a real one (synthetic text): it stops at about 12 lines (YN-46).
const longAcceptance = [
  "Step 1, before code: a one-page note on why the selection jumps, with the list and the filter that reproduce it.",
  "Step 2: a failing test first, recorded red in a Job; then the fix, with the test left as it is.",
  "- The selected row stays selected after a refresh, filtered or not.",
  "- A row that left the list hands the selection to its neighbour, not to the first row.",
  "- Keyboard: arrow keys move from where the selection is, never from the top.",
  "- Nothing else moves: same rows, same order, same texts.",
  "- en and zh;",
  "- light and dark;",
  "- phone and desktop.",
  "- Checks: the red Job, the green Job, Chromium on the built dist at 1440 and 390, screenshots.",
  "",
  "Step 3: one PR titled [YN-22] …, from current main; two review rounds; PR CI green.",
  "- Each round's reviewId and conclusion in the result, including any that did not pass.",
  "- Known limits listed; P3 findings to the lead.",
  "",
  "Lab Cores and isolated browsers only.",
].join("\n");
const overview = {
  yn22: {
    agentId: "yn22", lifecycle: agents[1].executor, task: { id: "YN-22", title: agents[1].executor.task.title, status: "doing" },
    template: { ...RED, deliveryMode: "pr" }, materials: materials("/fixture/app/.worktrees/yn-22", longAcceptance),
    steps: [
      { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
      { kind: "job", label: "Write the failing test, record it red", state: "done", ref: { kind: "job", id: "j1", name: "red 1/1", status: "failed" } },
      { kind: "work", label: "Fix (the test unchanged)", state: "done" },
      { kind: "job", label: "Green", state: "done", ref: { kind: "job", id: "j2", name: "green 24/24", status: "succeeded" } },
      { kind: "pr", label: "PR at a frozen head", state: "done", ref: { kind: "pr", number: 688, url: "https://github.com/owner/repo/pull/688", state: "open" } },
      { kind: "review", rounds: 2, state: "doing", ref: { kind: "review", id: "r1", round: 1, conclusion: null, forCurrentHead: true } },
      { kind: "ci", state: "done", ref: { kind: "ci", state: "success", headSha: head } },
      { kind: "merge", label: "Merge (Dev 9 / the merge queue)", state: "todo" },
    ],
    jobs: [{ id: "j2", name: "green 24/24", status: "succeeded", finishedAt: ago(20) }, { id: "j1", name: "red 1/1 (the assertion \"selected stays\")", status: "failed", reason: "exit-code", finishedAt: ago(40) }],
    pullRequest: { number: 688, url: "https://github.com/owner/repo/pull/688", title: "Keep the selection after a refresh", state: "open", headSha: head,
      ci: { state: "success", headSha: head }, latestReview: { reviewId: "r1", round: 1, status: "running", conclusion: null, forCurrentHead: true },
      changes: { additions: 46, deletions: 9, files: 3 } },
    merge: null, result: null,
  },
  yn21: {
    agentId: "yn21", lifecycle: agents[2].executor, task: { id: "YN-21", title: agents[2].executor.task.title, status: "doing" },
    template: { ...DESIGN, deliveryMode: "pr" }, materials: materials("/fixture/app/.worktrees/yn-21", "Export and import cover appearance, language and notifications; older files import"),
    steps: [
      { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
      { kind: "result", label: "Design note as a result", state: "done", ref: { kind: "result", id: "2b7e41c09d", reportedAt: ago(30) } },
      { kind: "gate", label: "Approve the design note", approver: "user", state: "blocked" },
      { kind: "work", label: "Slices (3)", state: "todo" },
      { kind: "job", label: "An evidence Job each", state: "todo" },
      { kind: "pr", state: "todo" }, { kind: "review", rounds: 2, state: "todo" }, { kind: "ci", state: "todo" }, { kind: "merge", state: "todo" },
    ],
    jobs: [], pullRequest: null, merge: null,
    result: { id: "2b7e41c09d", summary: "Design note: 3 interfaces, 2 states, the evidence format. Read-only until approved.", reportedAt: ago(30), status: "submitted" },
  },
  yn29: {
    agentId: "yn29", lifecycle: agents[3].executor, task: { id: "YN-29", title: "Status bar wording", status: "done" },
    template: { id: "small-fix", label: "Small fix", deliveryMode: "pr" }, materials: null,
    steps: [{ kind: "materials", state: "done" }, { kind: "work", label: "Change one line", state: "done" },
      { kind: "job", label: "Focused check", state: "done", ref: { kind: "job", id: "j9", name: "statusbar words", status: "succeeded" } },
      { kind: "pr", state: "done", ref: { kind: "pr", number: 705 } }, { kind: "review", state: "done", ref: { kind: "review", round: 1, conclusion: "no_findings" } },
      { kind: "ci", state: "done", ref: { kind: "ci", state: "success" } }, { kind: "merge", state: "done", ref: { kind: "merge", id: "m5", state: "merged" } }],
    jobs: [{ id: "j9", name: "statusbar words", status: "succeeded", finishedAt: ago(50) }],
    pullRequest: { number: 705, url: "https://github.com/owner/repo/pull/705", title: "Status bar wording", state: "merged", ci: { state: "success" },
      latestReview: { reviewId: "r9", round: 1, status: "completed", conclusion: "no_findings", forCurrentHead: true }, changes: { additions: 1, deletions: 1, files: 1 } },
    merge: { id: "m5", state: "merged", reason: null },
    result: { id: "r29", summary: "One line changed; the focused check passed; merged as #705.\nNo behaviour change, so no red test.", reportedAt: ago(35), status: "accepted" },
  },
};
const gateRef = (key) => ({ kind: "ask", projectId: "p1", key, version: 2, state: "open", since: ago(12), repliedAt: null });
overview.yn30 = {
  agentId: "yn30", lifecycle: agents[4].executor, task: { id: "YN-30", title: agents[4].executor.task.title, status: "doing" },
  template: { ...DESIGN, deliveryMode: "pr" }, materials: materials("/fixture/app/.worktrees/yn-30", "导出/导入覆盖外观、语言、通知三类偏好；旧文件可导入；两轮审查"),
  steps: [
    { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
    { kind: "result", label: "设计说明作为结果提交", state: "done", ref: { kind: "result", id: "2b7e41c09d", reportedAt: ago(14) } },
    { kind: "gate", label: "批准设计说明", approver: "user", state: "blocked", ref: gateRef("gates/yn-30") },
    { kind: "work", label: "切片实现（3 片）", state: "todo" },
    { kind: "job", label: "每片证据 Job", state: "todo" },
    { kind: "pr", state: "todo" }, { kind: "review", rounds: 2, state: "todo" }, { kind: "ci", state: "todo" }, { kind: "merge", state: "todo" },
  ],
  jobs: [], pullRequest: null, merge: null,
  result: { id: "2b7e41c09d", summary: "设计说明：接口 3 个、状态 2 个、证据格式。批准前只读。", reportedAt: ago(14), status: "submitted" },
};
overview.yn31 = {
  agentId: "yn31", lifecycle: agents[5].executor, task: { id: "YN-31", title: agents[5].executor.task.title, status: "doing" },
  template: { ...RUNBOOK, deliveryMode: "none" }, materials: materials("/fixture/app/.worktrees/yn-31", "每个不可逆步骤先批准；第一处检查失败就停"),
  steps: [
    { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
    { kind: "work", label: "预检", state: "done" },
    { kind: "result", label: "步骤计划（含回滚）", state: "done", ref: { kind: "result", id: "5c1d09ab77", reportedAt: ago(16) } },
    { kind: "gate", label: "批准不可逆步骤", approver: "user", state: "blocked", ref: gateRef("gates/yn-31") },
    { kind: "work", label: "逐步执行与验证", state: "todo" },
    { kind: "result", label: "后检报告", state: "todo" },
  ],
  jobs: [], pullRequest: null, merge: null,
  result: { id: "5c1d09ab77", summary: "步骤计划：4 步，其中第 2 步不可逆；每步有回滚。", reportedAt: ago(16), status: "submitted" },
};
// Their Asks, as Home shows them (synthetic texts).
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["note"] }, note: { type: "Markdown", props: { text } } } });
const gateAsk = (owner, name, key, step, title, question, text, options, extra = {}) => ({
  key, kind: "ask", title, version: 2, owner: { agentId: owner, name, state: "active" }, updatedAt: ago(12), updatedTurnId: null,
  body: markdown(text), attachments: [], refs: {}, seen: null, history: false,
  ask: { question, state: "open", gate: { taskId: owner.toUpperCase().replace("YN", "YN-"), step }, reply: { options, ...extra } },
});
const gateAsks = [
  gateAsk("yn30", "YN-30 · Design first", "gates/yn-30", 2, "批准设计说明（YN-30）", "导出文件用一个 JSON（含版本号）还是三个文件？",
    "设计说明推荐一个文件：外观、语言、通知三类偏好放在一起，带版本号；旧格式仍可导入。完整说明在任务结果 2b7e41c0。",
    [{ id: "one", label: "批准：一个 JSON（推荐）" }, { id: "three", label: "批准：三个文件" }, { id: "revise", label: "改一下再批" }],
    { freeText: { prompt: "要改什么？" } }),
  gateAsk("yn31", "YN-31 · Gated runbook", "gates/yn-31", 3, "批准第 2 步：轮换签名密钥（YN-31）", "可以执行第 2 步吗？它不可逆。",
    "- **命令**：`release-keys rotate --key signing`\n- **目标**：发布签名密钥（合成示例）\n- **风险**：旧密钥签过的安装包要重新签名\n- **回滚**：旧密钥保留 7 天，可用 `release-keys restore` 恢复",
    [{ id: "go", label: "批准执行" }, { id: "stop", label: "先不执行" }]),
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const home = () => ({ generatedAt: ago(0), order: ["p1"],
  needsYou: gateAsks.map((a) => ({ kind: "ask", projectId: "p1", agentId: a.owner.agentId, agentName: a.owner.name, sectionKey: a.key,
    title: a.title, since: ago(12), gate: a.ask.gate })),
  projects: [{ project: { id: "p1", name: "Yuzuno" },
    agents: { working: 2, idle: 2, waiting: 1, error: 0, offline: 0, total: 6 }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 3, history: [], sections: gateAsks } }] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function route(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    if (op === "task_list") return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false, nextAfterSeq: null } });
    if (op === "github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (method !== "GET") return route.fulfill({ json: {} });
  const read = path.match(/^\/api\/agents\/([^/]+)\/executor$/);
  if (read) return overview[read[1]] ? route.fulfill({ json: overview[read[1]] }) : route.fulfill({ status: 404, json: { error: "This Agent is no executor", code: "not_executor" } });
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: detail[1] === "yn21" ? [approval] : [],
    messageReceipts: [], artifacts: [], turns: [] } });
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-overview" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home(), "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/executors/live": { executors: {} },
  }[path];
  if (json) return route.fulfill({ json });
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
}

// The Overview as drawn: overflow, steps whose label runs into their record, cards outside the pane, target heights.
const measure = (page) => page.evaluate(() => {
  const panel = document.querySelector("#executor-overview");
  const box = panel.getBoundingClientRect();
  const steps = [...panel.querySelectorAll(".executor-overview-steps .step")].map((s) => {
    const label = s.querySelector(".label").getBoundingClientRect(), ref = s.querySelector(".ref").getBoundingClientRect();
    return { text: s.querySelector(".label").textContent, overlap: ref.width > 0 && label.right > ref.left + 1 && label.bottom > ref.top + 1 && label.top < ref.bottom - 1 };
  });
  const wide = [...panel.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
  }).map((el) => el.className || el.tagName);
  const height = (selector) => [...document.querySelectorAll(selector)].map((el) => Math.round(el.getBoundingClientRect().height));
  const shown = (selector) => { const el = document.querySelector(selector); return !!el && el.getClientRects().length > 0; };
  return {
    overflowX: panel.scrollWidth > panel.clientWidth + 1, wide, overlaps: steps.filter((s) => s.overlap).map((s) => s.text), steps: steps.length,
    tabs: height(".executor-tabs [role=tab]"), link: height(".executor-overview-chips .chip.link"), more: height(".executor-overview-card .more"),
    conversation: shown(".conversation-body"), composer: shown(".composer-area"), cards: panel.querySelectorAll(".pending-card").length,
    gates: panel.querySelectorAll(".gate-ask .home-ask-options").length, bodyGates: document.querySelectorAll(".conversation-body .gate-ask").length,
    bodyCards: document.querySelectorAll(".conversation-body .pending-card").length,
  };
});

// YN-46: where each part of the Overview is drawn, and its long materials.
const layout = (page) => page.evaluate(() => {
  const panel = document.querySelector("#executor-overview");
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
  const progress = panel.querySelector(":scope > .executor-overview-progress");
  // The main column's parts, in the page's order: its gate's Ask, its request or banner, the materials, changes, evidence and report.
  const main = [...panel.children].filter((el) => !el.matches(".executor-overview-head, .executor-overview-progress"))
    .map((el) => ({ name: el.matches("details") ? "materials" : el.querySelector("h3")?.firstChild?.textContent?.trim() || el.className,
      gate: el.matches(".gate-asks"), ...rect(el) }));
  const capped = [...panel.querySelectorAll(".executor-overview-kv dd .executor-overview-capped")].map((el) => ({
    label: el.closest("dd").previousElementSibling.textContent, height: Math.round(el.clientHeight), content: el.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight) || null, fontSize: parseFloat(getComputedStyle(el).fontSize),
    above: el.hasAttribute("data-above"), below: el.hasAttribute("data-below"),
    tabIndex: el.getAttribute("tabindex"), role: el.getAttribute("role"), name: el.getAttribute("aria-label"),
    fade: getComputedStyle(el, "::after").height,
  }));
  const pair = panel.querySelector(".executor-overview-evidence .pair");
  const evidence = pair?.closest(".executor-overview-card");
  return {
    pane: document.querySelector(".main-panel").clientWidth, panel: rect(panel), head: rect(panel.querySelector(".executor-overview-head")),
    progress: rect(progress), steps: rect(progress.querySelector(".executor-overview-card")), now: rect(progress.querySelector(".executor-overview-now")),
    main, capped, scrollTop: Math.round(panel.scrollTop),
    pair: pair ? { ...rect(pair), inside: evidence.getBoundingClientRect().left <= pair.getBoundingClientRect().left && evidence.getBoundingClientRect().right >= pair.getBoundingClientRect().right - 1,
      tones: [...pair.querySelectorAll(".v [data-tone]")].map((v) => v.dataset.tone) } : null,
  };
});
// Two columns where the pane is 1000 px or wider, one below: checked against what is drawn.
function assertColumns(tag, id, l) {
  const two = l.pane >= 1000;
  const materials = l.main.find((part) => part.name === "materials");
  const after = l.main.slice(l.main.indexOf(materials) + 1);
  if (two) {
    for (const part of l.main) {
      assert.equal(part.left, l.main[0].left, `${tag} ${id}: ${part.name} in the main column`);
      assert.ok(part.right <= l.progress.left - 20, `${tag} ${id}: ${part.name} left of the steps column (${part.right} / ${l.progress.left})`);
      assert.ok(part.width <= 760, `${tag} ${id}: ${part.name} no wider than 760 px (${part.width})`);
    }
    assert.ok(Math.abs(l.progress.top - l.main[0].top) <= 1, `${tag} ${id}: the steps column starts with the main one (${l.progress.top} / ${l.main[0].top})`);
    assert.ok(l.progress.width >= 299 && l.progress.width <= 381, `${tag} ${id}: the steps column 300 to 380 px (${l.progress.width})`);
    assert.ok(l.now.top >= l.steps.bottom && l.now.left === l.steps.left, `${tag} ${id}: Doing now under the steps, in their column`);
    assert.ok(Math.abs(l.head.right - l.progress.right) <= 1 && l.head.left === l.main[0].left, `${tag} ${id}: the header over both columns`);
  } else {
    assert.equal(l.progress.left, materials.left, `${tag} ${id}: one column`);
    assert.equal(l.progress.width, materials.width, `${tag} ${id}: one column, one width`);
    assert.ok(materials.bottom <= l.progress.top && after.every((part) => l.progress.bottom <= part.top), `${tag} ${id}: today's order: materials, steps and Doing now, then the rest`);
  }
  for (let i = 1; i < l.main.length; i += 1) assert.ok(l.main[i].top >= l.main[i - 1].bottom + 8, `${tag} ${id}: ${l.main[i].name} after ${l.main[i - 1].name}, a gap between`);
  return two;
}

async function run({ width, height, theme, lang = "en", glance = true }) {
  const phone = width < 600;
  const tag = `${width}${glance ? "" : "-noglance"}-${theme}-${lang}`;
  // YN-46: two columns where the pane is 1000 px or wider; At a glance takes 272 px of a 1440 window.
  const twoColumns = width >= 2000 || (width >= 1440 && !glance);
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail: 240 }));
    localStorage.setItem("yuzuno.archivedExecutorsOpen.ws-executor-overview", JSON.stringify(["all"]));
    // The task board is its own check's: a task link is counted, not opened.
    window.__tasks = [];
    window.addEventListener("yuzuno:open-task-review", (event) => { window.__tasks.push(event.detail?.taskId ?? null); event.stopImmediatePropagation(); });
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const open = async (id) => {
    // A phone shows one at a time: back to its list first.
    if (phone && await page.locator(".phone-back").isVisible()) await press(page.locator(".phone-back"));
    // An archived one opened shows the closed Agents: back to the open ones for an open one.
    if (!agents.find((a) => a.id === id).closedAt && !(await page.locator(`.agent-list article[data-agent-id="${id}"]`).count()))
      await press(page.locator(".agent-scope button").first());
    await press(page.locator(`.agent-list article[data-agent-id="${id}"] .agent-select`));
    await page.locator("#executor-overview .executor-overview-head").waitFor({ timeout: 10_000 });
    // At a glance closed, as a user may: the pane is wider by its width.
    if (!glance && await page.locator(".inspector-heading .icon-button").isVisible()) {
      await press(page.locator(".inspector-heading .icon-button"));
      await page.locator(".inspector").waitFor({ state: "detached", timeout: 5_000 });
    }
    await page.mouse.move(0, 0);
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(output, `${tag}-${name}.png`) });
    report.screenshots.push(`${tag}-${name}`);
  };
  try {
    await page.goto(`https://${HOST}/`);
    await page.locator('.agent-list article[data-agent-id="yn29"]').waitFor({ timeout: 15_000 });
    for (const id of ["yn22", "yn21", "yn29", "yn30", "yn31"]) {
      await open(id);
      if (id === "yn30" || id === "yn31") await page.locator("#executor-overview .gate-ask .home-ask-options").waitFor({ timeout: 10_000 });
      const m = await measure(page);
      report.measures[`${tag}-${id}`] = m;
      // YN-46: its columns, its long materials, its gate card and its red → green row.
      const l = await layout(page);
      m.layout = l;
      const two = assertColumns(tag, id, l);
      assert.equal(two, twoColumns, `${tag} ${id}: ${twoColumns ? "two columns" : "one column"} (pane ${l.pane} px)`);
      for (const c of l.capped) {
        if (id === "yn22" && c === l.capped[0]) {
          assert.equal(c.label, lang === "zh" ? "验收" : "Acceptance");
          assert.ok(c.content > c.height + 20, `${tag}: a long acceptance scrolls inside (${c.content} / ${c.height})`);
          assert.ok(c.height >= 10 * c.fontSize && c.height <= 16 * c.fontSize, `${tag}: about 12 lines (${c.height} px at ${c.fontSize} px)`);
          assert.ok(c.below && !c.above && parseFloat(c.fade) > 0, `${tag}: a fade where more is below`);
          assert.deepEqual([c.tabIndex, c.role, c.name], ["0", "region", c.label], `${tag}: a region a keyboard can scroll`);
        } else {
          assert.ok(c.content <= c.height + 1, `${tag} ${id}: a short ${c.label} keeps its own height (${c.content} / ${c.height})`);
          assert.ok(!c.below && !c.above && c.fade === "0px" && c.tabIndex === null && c.role === null, `${tag} ${id}: no fade, no region for a short ${c.label}`);
        }
      }
      if (id === "yn22") {
        assert.deepEqual([l.pair?.inside, l.pair?.tones], [true, ["bad", "ok"]], `${tag}: the red → green row in its Evidence`);
        // To its end: the fade moves to the top.
        const edges = () => page.evaluate(() => { const el = document.querySelector("#executor-overview .executor-overview-capped"); return [el.hasAttribute("data-above"), el.hasAttribute("data-below")]; });
        await page.evaluate(() => { const el = document.querySelector("#executor-overview .executor-overview-capped"); el.scrollTop = el.scrollHeight; });
        await page.waitForFunction(() => { const el = document.querySelector("#executor-overview .executor-overview-capped"); return el.hasAttribute("data-above") && !el.hasAttribute("data-below"); });
        assert.deepEqual(await edges(), [true, false], `${tag}: at its end, the fade at the top`);
        await shot("yn22-materials-end");
        await page.evaluate(() => { document.querySelector("#executor-overview .executor-overview-capped").scrollTop = 0; });
        await page.waitForFunction(() => { const el = document.querySelector("#executor-overview .executor-overview-capped"); return !el.hasAttribute("data-above") && el.hasAttribute("data-below"); });
        check(`${tag}: a long acceptance stops at about 12 lines and scrolls, a fade at the edge with more`);
        if (two) {
          // A shorter window: the main column scrolls, the steps column stays in view.
          await page.setViewportSize({ width, height: 640 });
          await page.evaluate(() => { const panel = document.querySelector("#executor-overview"); panel.scrollTop = panel.scrollHeight; });
          await page.waitForFunction(() => document.querySelector("#executor-overview").scrollTop > 0);
          const s = await layout(page);
          m.scrolled = s;
          assert.ok(s.main[0].top < s.panel.top, `${tag}: the main column scrolled (${s.main[0].top} / ${s.panel.top})`);
          assert.ok(s.progress.top >= s.panel.top + 10 && s.progress.top <= s.panel.top + 18 && s.progress.bottom <= s.panel.bottom,
            `${tag}: the steps column in view, at the Overview's top padding (${s.progress.top}–${s.progress.bottom} in ${s.panel.top}–${s.panel.bottom})`);
          await shot("yn22-scrolled");
          await page.evaluate(() => { document.querySelector("#executor-overview").scrollTop = 0; });
          await page.setViewportSize({ width, height });
          check(`${tag}: the steps column stays in view while the main one scrolls`);
        }
      }
      if (id === "yn30" || id === "yn31") assert.ok(l.main[0].gate, `${tag} ${id}: its gate's card first in the main column`);
      assert.equal(m.overflowX, false, `${tag} ${id}: nothing wider than the Overview`);
      assert.deepEqual(m.wide, [], `${tag} ${id}: every part inside the pane`);
      assert.deepEqual(m.overlaps, [], `${tag} ${id}: no step's label runs into its record`);
      assert.equal(m.conversation, false, `${tag} ${id}: its Conversation hidden`);
      assert.equal(m.composer, false, `${tag} ${id}: the composer is the Conversation's`);
      assert.equal(m.steps, Math.min(5, overview[id].steps.length), `${tag} ${id}: five steps, then the rest on request`);
      if (phone) for (const [name, heights] of [["tabs", m.tabs], ["task link", m.link], ["steps toggle", m.more]])
        assert.ok(heights.every((h) => h >= 44), `${tag} ${id}: each ${name} 44 px tall on a phone (${heights})`);
      if (id === "yn21") {
        assert.equal(m.cards, 1, `${tag}: its request's card in its Overview`);
        assert.equal(m.bodyCards, 0, `${tag}: and not also in its hidden Conversation`);
      }
      if (id === "yn30" || id === "yn31") {
        assert.equal(m.gates, 1, `${tag} ${id}: its gate's Ask in its Overview, with Home's reply`);
        assert.equal(m.bodyGates, 0, `${tag} ${id}: and not also in its hidden Conversation`);
        // A phone shows the list or the conversation: its ring is checked where the list shows beside it.
        if (!phone) assert.equal(await page.locator(`.agent-list article[data-agent-id="${id}"] .agent-island`).getAttribute("data-state"), "waiting", `${tag} ${id}: its ring needs you`);
        await page.locator("#executor-overview .gate-ask").scrollIntoViewIfNeeded();
      }
      await shot(`${id}-overview`);
      check(`${tag} ${id}: its Overview, inside the pane, nothing overlapping`);
    }
    // yn30: the same card in its Conversation.
    await open("yn30");
    await press(page.getByRole("tab", { name: lang === "zh" ? "会话" : "Conversation" }));
    await page.locator(".conversation-body .gate-ask .home-ask-options").waitFor({ timeout: 10_000 });
    await page.locator(".conversation-body .gate-ask").scrollIntoViewIfNeeded();
    // Its question and Send to read against the card in each theme: their
    // colours, and which rules set them, are kept in the report.
    const legible = await page.evaluate(() => {
      const card = document.querySelector(".conversation-body .gate-ask");
      // Any CSS colour (color-mix gives color(srgb …)) as the rgb a canvas paints it.
      const rgb = (css) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d");
        x.fillStyle = "#000";
        x.fillStyle = css;
        x.fillRect(0, 0, 1, 1);
        return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      // The card's own background: a tint mixed into the opaque paper.
      const ground = rgb(getComputedStyle(card).backgroundColor);
      const rules = (el) => [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
        .flatMap((rule) => rule.cssRules ? [...rule.cssRules] : [rule])
        .filter((rule) => rule.selectorText && rule.style?.color && el.matches(rule.selectorText)).map((rule) => `${rule.selectorText} { color: ${rule.style.color} }`);
      return ["gate-ask-question", "home-reply-target label"].map((name) => {
        const el = card.querySelector(name === "gate-ask-question" ? ".gate-ask-question" : ".home-reply-target label");
        const color = getComputedStyle(el).color;
        return { name, color, ground, ratio: Math.round(ratio(rgb(color), ground) * 100) / 100, rules: rules(el) };
      });
    });
    report.measures[`${tag}-yn30-conversation-legible`] = legible;
    for (const { name, ratio } of legible) assert.ok(ratio >= 4.5, `${tag}: the gate card's ${name} reads at ${ratio}:1, under 4.5:1`);
    await shot("yn30-conversation");
    await press(page.getByRole("tab", { name: lang === "zh" ? "概览" : "Overview" }));
    await page.locator("#executor-overview .executor-overview-head").waitFor({ timeout: 5_000 });
    check(`${tag}: a gate's Ask in its Conversation too, when that tab shows`);
    // yn22: all its steps, then its Conversation and back.
    await open("yn22");
    await press(page.locator("#executor-overview .executor-overview-card .more"));
    await page.waitForFunction(() => document.querySelectorAll("#executor-overview .executor-overview-steps .step").length === 8);
    const all = await measure(page);
    assert.deepEqual(all.overlaps, [], `${tag}: all steps, none overlapping`);
    await page.locator("#executor-overview .executor-overview-steps").scrollIntoViewIfNeeded();
    await shot("yn22-all-steps");
    check(`${tag}: all eight steps on request`);
    await press(page.getByRole("tab", { name: lang === "zh" ? "会话" : "Conversation" }));
    await page.locator(".composer-area").waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await page.locator("#executor-overview").count(), 0);
    assert.equal(await page.getByRole("tab", { name: lang === "zh" ? "会话" : "Conversation" }).getAttribute("aria-selected"), "true");
    await shot("yn22-conversation");
    await press(page.getByRole("tab", { name: lang === "zh" ? "概览" : "Overview" }));
    await page.locator("#executor-overview .executor-overview-head").waitFor({ timeout: 5_000 });
    check(`${tag}: its Conversation shows the composer; back to its Overview`);
    // Its task, from the header.
    await press(page.locator("#executor-overview .chip.link"));
    assert.deepEqual(await page.evaluate(() => window.__tasks), ["YN-22"]);
    check(`${tag}: its task opens from the header`);
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const lang of ["en", "zh"])
    for (const theme of ["light", "dark"])
      for (const [width, height, glance] of [[2000, 1200], [1440, 900], [1440, 900, false], [1100, 800], [390, 844]]) await run({ width, height, theme, lang, glance });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "no collaboration write: a check only reads");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
