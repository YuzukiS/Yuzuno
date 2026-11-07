// What Work activity counts, and whose work it is (T-15, #459 round 1).
//
// Three findings from that round meet here, because all three are about the
// one count in the conversation's head and the column it opens:
//
//  P2c  The panel keeps history; this line is what needs a look and what is
//       going on. An old failing CI run a later run of the same workflow has
//       replaced, a Job the user cancelled, and a failure whose name has
//       since succeeded are all answered, and counting them meant the entry
//       said "needs a look" for good. (Deviation row 14.)
//  P1   Claude's background tasks and the conversation's sub-agents are both
//       drawn by SubAgentDock. Registered under one kind they overwrote each
//       other, and either one unmounting wrote [] and cleared both.
//  P3a  With the dock's limit at 0 the column's row called setCard and no
//       card was rendered; and the column's "Needs a look" counted
//       exceptions *and* unrecognised work, where the entry counts only
//       exceptions.
//
// Since YN-17 S2 (the user's decision) there is no "Needs a look" group and
// the entry counts what is running, not what went wrong: what went wrong is
// listed in its own kind's group, first, with its state. P2c is read in the
// column now, and P3a's group is the sub-agents' own.
//
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-counting.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agentOf = (id, name) => ({
  id, name, status: "working", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
});
const res = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (id, name, status, finishedAgo) => ({
  id, name, status, reason: null, agentId: "a", agent: { name: "Dev 8" }, taskRef: "T-15",
  cwd: "/w", machine: { name: "owl" }, resources: res, reservation: res, exclusive: false,
  createdAt: iso(-finishedAgo - 60_000), startedAt: iso(-finishedAgo - 30_000),
  finishedAt: status === "running" ? null : iso(-finishedAgo), reserved: false,
  cursor: Number(id.replace(/\D/g, "")) || 1, requestId: id,
});
const run = (id, name, conclusion, createdAgo, cursor) => ({
  id, name, repository: "YuzukiS/yuzuno-public", runId: id.replace(/\D/g, ""), attempt: "1",
  headSha: "f8b8a0b", status: "completed", rawStatus: "completed", conclusion,
  url: "https://example.invalid/", createdAt: iso(-createdAgo), startedAt: iso(-createdAgo),
  updatedAt: iso(-createdAgo + 1000), observedAt: iso(-1000), cursor, runWatched: false,
});
const subAgentItem = (id, status) => ({
  id, type: "claudeToolUse", name: "Task", status,
  subAgent: { taskId: `st-${id}`, runId: `sr-${id}`, type: "Explore", description: `子 Agent ${id}`, prompt: "x" },
});
const backgroundItem = (id, status) => ({
  id, type: "claudeToolUse", name: "Bash", status: status === "running" ? "inProgress" : "completed",
  input: { command: "npm test", description: `background ${id}` },
  backgroundTask: { status, description: `background ${id}` },
});
const turnsOf = (extra) => Array.from({ length: 6 }, (_, i) => ({
  id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 600 + i * 60,
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
    { id: `r${i}`, type: "agentMessage", text: "正文".repeat(12) },
    ...(i === 5 ? extra : []),
  ],
}));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function open({ jobs = [], runs = [], details, agents, appearance }) {
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([look, lang]) => {
    window.EventSource = class { close() {} };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify(look));
    if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, [appearance ?? { theme: "light", fontSize: 16, palette: "garden" }, process.env.T15_LANG || "en"]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    const who = path.match(/^\/api\/agents\/([a-z]+)$/);
    if (who) return route.fulfill({ json: details[who[1]] ?? details.a });
    if (/^\/api\/agents\/[a-z]+\/models$/.test(path))
      return route.fulfill({ json: { context: { requestedWindowTokens: null, settingsSubmitted: false, observedStale: false } } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: { runs, subscriptions: [], hasMore: false, nextBefore: null } });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  return { context, page };
}

/** What the entry says, and what the column holds once opened. */
const look = () => {
  const entry = document.querySelector(".work-activity-entry");
  const counts = (entry?.querySelector(".work-activity-counts")?.textContent || "").trim();
  const digits = counts.match(/\d+/g)?.map(Number) ?? [];
  const column = document.querySelector(".work-activity-column");
  const groups = [...(column?.querySelectorAll("section") ?? [])].map((section) => ({
    label: (section.getAttribute("aria-label") || "").trim(),
    rows: [...section.querySelectorAll(".work-activity-row")].map((row) =>
      (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)),
    states: [...section.querySelectorAll(".work-activity-row:not(.work-activity-row-list)")].map((row) =>
      row.getAttribute("data-state")),
  }));
  return { there: !!entry, counts, digits, open: !!column, groups };
};

// --- P2c: what a later run has answered is not still waiting ---
{
  const agents = [agentOf("a", "Dev 8 · Mac / iOS")];
  const details = { a: { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns: turnsOf([]) } };
  const { context, page } = await open({
    agents, details,
    jobs: [
      // The same name: failed two hours ago, succeeded one hour ago.
      job("j1", "build", "failed", 7_200_000),
      job("j2", "build", "succeeded", 3_600_000),
      // The user's own cancel, and one still going.
      job("j3", "deploy", "cancelled", 1_800_000),
      job("j4", "watch", "running", 0),
    ],
    runs: [
      // One workflow, two runs: the older failed, the newer passed.
      run("c1", "CI", "failure", 7_200_000, 1),
      run("c2", "CI", "success", 3_600_000, 2),
    ],
  });
  const seen = await page.evaluate(look);
  console.log(`\n--- P2c: an old failure a later run answered ---`);
  console.log(`  entry "${seen.counts}"  numbers ${JSON.stringify(seen.digits)}`);
  check(seen.there, "the entry is there");
  check(/1/.test(seen.counts) && /run|进行/.test(seen.counts),
    `the one still going is counted ("${seen.counts}")`);
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(500);
  const listed = await page.evaluate(look);
  const failedRows = listed.groups.flatMap((g) => g.states).filter((state) => state === "exception").length;
  check(listed.open && failedRows === 0,
    `nothing is listed as gone wrong: the rerun answered the failure, the cancel was the user's (${failedRows} of ${JSON.stringify(listed.groups.map((g) => `${g.label}:${g.states.join("/")}`))})`);
  await context.close();
}

// --- P1: two docks of the same shape, each keeping its own work ---
{
  const agents = [agentOf("a", "Dev 8 · Mac / iOS"), agentOf("b", "Dev 3 · public")];
  const details = {
    // Both kinds at once: a failed sub-agent and a running background task.
    a: { agent: agents[0], pending: [], messageReceipts: [], artifacts: [],
      turns: turnsOf([subAgentItem("sa1", "failed"), backgroundItem("bt1", "running")]) },
    // Only a sub-agent: the background-task dock unmounts when this opens.
    b: { agent: agents[1], pending: [], messageReceipts: [], artifacts: [],
      turns: turnsOf([subAgentItem("sa2", "failed")]) },
  };
  const { context, page } = await open({ agents, details });
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(500);
  const both = await page.evaluate(look);
  console.log(`\n--- P1: a sub-agent and a background task together ---`);
  console.log(`  entry "${both.counts}"  groups ${JSON.stringify(both.groups.map((g) => g.label))}`);
  check(both.open, "the column opens");
  // The union, not whichever registered last: one failed and one running,
  // each in its own kind's group. The entry counts the one running; since
  // YN-17 S2 the failed one is not counted there, so the column is where
  // both kinds are read.
  const kinds = Object.fromEntries(both.groups.map((g) => [g.label, g.states]));
  const sub = both.groups.find((g) => /Sub-agents|子 Agent/.test(g.label));
  const bg = both.groups.find((g) => /Background|后台/.test(g.label));
  check(both.digits.includes(1) && JSON.stringify(sub?.states) === JSON.stringify(["exception"])
    && JSON.stringify(bg?.states) === JSON.stringify(["current"]),
    `both kinds are listed, not one overwriting the other ("${both.counts}", ${JSON.stringify(kinds)})`);
  const labels = both.groups.map((g) => g.label).join(" | ");
  check(/Background|后台/.test(labels), `the background tasks have a group of their own (${labels})`);
  // The failed sub-agent is in its own kind's group (YN-17 S2); what matters
  // here is that it is still there.
  check(both.groups.some((g) => g.rows.some((row) => /子 Agent|Explore/.test(row))),
    `and the sub-agent's own work is still listed (${both.groups.map((g) => g.rows.join("/")).join(" | ")})`);

  // Opening the other Agent unmounts the background-task dock. Its work goes
  // and the sub-agent's stays: with one slot per kind, either cleanup wiped
  // both.
  // P2a: a background task's card, opened by touch from the column. By touch
  // the dock takes no presses, so this is the only way to one — and the row
  // has to be a finger's worth to use.
  const bgRow = page.locator(".work-activity-row", { hasText: /background|后台/ }).first();
  const bgBox = await bgRow.boundingBox();
  check(!!bgBox && bgBox.height >= 40,
    `the background task's row is a finger's worth (${Math.round(bgBox?.height ?? 0)}px)`);
  await bgRow.click();
  await page.waitForTimeout(500);
  const bgCard = await page.evaluate(() => {
    const card = document.querySelector(".subagent-card, .subagent-detail, [class*=subagent]");
    return { there: !!card, text: (card?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
  });
  check(bgCard.there, `and pressing it opens its card by touch ("${bgCard.text}")`);

  // The column stands in place of the Agent list, so it is closed first.
  await page.locator(".work-activity-column-back").click();
  await page.waitForTimeout(400);
  await page.locator(".agent-select").nth(1).click();
  await page.waitForTimeout(1200);
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(look);
  console.log(`  after opening the Agent without background tasks: "${after.counts}" groups ${JSON.stringify(after.groups.map((g) => g.label))}`);
  check(after.there && after.counts.length > 0,
    `the remaining Agent still counts its own work ("${after.counts}")`);
  check(!/Background|后台/.test(after.groups.map((g) => g.label).join(" | ")),
    "and the background-task group is gone with the dock that owned it");
  await context.close();
}

// --- P3a: the card with the dock's limit at 0, and where what failed is listed ---
{
  const agents = [agentOf("a", "Dev 8 · Mac / iOS")];
  const details = { a: { agent: agents[0], pending: [], messageReceipts: [], artifacts: [],
    turns: turnsOf([subAgentItem("sa1", "failed"), subAgentItem("sa2", "completed")]) } };
  const { context, page } = await open({
    agents, details,
    // The reader left the dock no room for sub-agents at all.
    appearance: { theme: "light", fontSize: 16, palette: "garden", dock: { jobs: 5, actions: 2, reviews: 2, subAgents: 0 } },
  });
  const entryCounts = await page.evaluate(look);
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(500);
  const column = await page.evaluate(look);
  console.log(`\n--- P3a: the dock draws no sub-agents (limit 0) ---`);
  console.log(`  entry "${entryCounts.counts}"  groups ${JSON.stringify(column.groups.map((g) => `${g.label}:${g.rows.length}`))}`);
  check(column.open, "the column still opens");
  check(column.groups.some((g) => g.rows.length > 0), "and still lists the work the dock did not draw");

  // No group of what went wrong, and no count of it on the entry: the failed
  // sub-agent is first in the sub-agents' own group, with its state.
  check(!column.groups.some((g) => /Needs a look|需要注意/.test(g.label)),
    `there is no "needs a look" group (${column.groups.map((g) => g.label).join(", ")})`);
  check(!/need|待查看/.test(entryCounts.counts), `and the entry counts nothing as needing a look ("${entryCounts.counts}")`);
  const subAgents = column.groups.find((g) => /Sub-agents|子 Agent/.test(g.label));
  check(!!subAgents && JSON.stringify(subAgents.states) === JSON.stringify(["exception", "done"]),
    `the failed sub-agent is first in the sub-agents' group, then the one that finished (${JSON.stringify(subAgents?.states)})`);

  // Its row opens the card, which used to be unreachable at this limit.
  const row = page.locator(".work-activity-row").first();
  await row.click();
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => !!document.querySelector(".subagent-card, .subagent-detail, [class*=subagent]"));
  check(card, "and pressing a row opens its card, which the dock's limit used to hide");
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
