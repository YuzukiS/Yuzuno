// Isolated real-Core browser acceptance. No Tauri/CDP attachment, no mocked API.
// Default mode is read-only. Model turns and SSH experiments are root-controlled.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = dirname(fileURLToPath(import.meta.url));
const root = resolve(output, "../..");
const { chromium } = await import(
  pathToFileURL(resolve(root, "web/node_modules/playwright-core/index.mjs"))
);
const base = "http://127.0.0.1:4327";
const mode = process.argv[2] || "inventory";
assert.ok(["inventory", "capture", "compare", "exercise", "reconnect"].includes(mode),
  "Modes: inventory, capture, compare (read-only); exercise, reconnect (explicit lab GUI mutations)");
const exercise = ["exercise", "reconnect"].includes(mode);
if (process.env.YUZUNO_CORE_URL)
  assert.equal(new URL(process.env.YUZUNO_CORE_URL).origin, base,
    "This runner refuses any Core except the isolated port 4327.");

const report = {
  mode, startedAt: new Date().toISOString(), baseUrl: base,
  checks: [], browserErrors: [], blockedRequests: [],
  limitations: [
    "Headless Chromium only; no user window is opened or controlled.",
    "Inventory/capture/compare do not create Agents, send model turns, approve requests, interrupt, or change read state.",
    "Reconnect/disconnect and real model work must be performed explicitly in the isolated lab before compare.",
  ],
};
const record = (name, details = {}) => report.checks.push({ name, ...details });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Guard against accidentally reaching an unrelated service or a reused PID.
const processRecord = await readJson(resolve(output, "core-process.json"));
assert.equal(processRecord.baseUrl, base);
assert.equal(processRecord.dataDir, resolve(output, "core-data"));
const stat = await readFile(`/proc/${processRecord.pid}/stat`, "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
assert.equal(fields[19], processRecord.startTicks, "Lab process was restarted; refresh its ownership record.");
const argv = (await readFile(`/proc/${processRecord.pid}/cmdline`, "utf8")).replace(/\0$/, "").split("\0");
assert.deepEqual(argv, processRecord.argv);
assert.ok(argv.includes(resolve(output, "core-data")));
assert.ok(argv.includes(resolve(output, "web-build-src/dist")));

async function api(path) {
  assert.ok(path.startsWith("/api/"));
  const response = await fetch(`${base}${path}`);
  assert.equal(response.ok, true, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}

function identity(detail) {
  return {
    id: detail.agent.id, name: detail.agent.name, goal: detail.agent.goal,
    threadId: detail.agent.threadId, cwd: detail.agent.cwd,
    machineId: detail.agent.remote?.machine?.id ?? "local",
    runtimeInstance: detail.agent.remote?.runtime?.instanceId ?? null,
    reviewedSeq: detail.agent.reviewedSeq,
    turns: detail.turns.map(turn => ({
      id: turn.id, items: (turn.items || []).map(item => ({ id: item.id, type: item.type })),
    })),
  };
}

let browser;
let page;
await mkdir(output, { recursive: true });
try {
  assert.equal((await api("/api/health")).application, "yuzuno-next");
  const workspace = await api("/api/workspace");
  const details = await Promise.all(workspace.agents.map(agent => api(`/api/agents/${encodeURIComponent(agent.id)}`)));
  const identities = details.map(identity);
  record("real-lab-core-and-workspace", {
    pid: processRecord.pid, agentCount: workspace.agents.length,
    agents: workspace.agents.map(({ id, name, status, pendingCount, unreadCount, machineId }) =>
      ({ id, name, status, pendingCount, unreadCount, machineId })),
  });
  const initialReviewed = Object.fromEntries(details.map(detail => [detail.agent.id, detail.agent.reviewedSeq]));

  browser = await chromium.launch({
    headless: true,
    ...(process.env.YUZUNO_BROWSER_BIN
      ? { executablePath: process.env.YUZUNO_BROWSER_BIN }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
    const allowedMutation = exercise && request.method() === "POST" && (
      url.pathname === "/api/agents" || url.pathname === "/api/machines" ||
      /^\/api\/machines\/[^/]+\/check$/.test(url.pathname) ||
      /^\/api\/agents\/[^/]+\/(turns|interrupt|reconnect)$/.test(url.pathname) ||
      /^\/api\/requests\/[^/]+\/respond$/.test(url.pathname)
    );
    if (url.origin !== base || (!["GET", "HEAD"].includes(request.method()) && !allowedMutation)) {
      report.blockedRequests.push({ method: request.method(), url: request.url() });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", error => report.browserErrors.push(error.message));
  await page.goto(`${base}/?shell=desktop`);
  await page.locator(".toolbar-brand").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, `${mode}-workspace.png`), animations: "disabled" });
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width, "Horizontal overflow in workspace.");
  record("isolated-real-workspace-render", layout);

  if (exercise) {
    const { runExercise } = await import("./exercise-stage.mjs");
    await runExercise({ page, context, api, record, report, output, root, mode });
  }

  const after = await api("/api/workspace");
  for (const agent of after.agents) {
    if (Object.hasOwn(initialReviewed, agent.id))
      assert.equal(agent.reviewedSeq, initialReviewed[agent.id], "Browsing and task actions must preserve existing review state.");
  }
  assert.equal(report.blockedRequests.length, 0, "Unexpected cross-origin or mutation request.");
  assert.equal(report.browserErrors.length, 0);
  record(exercise ? "only-allowed-lab-operations-no-browser-errors" : "read-only-browser-no-mutations-or-errors");

  if (mode === "capture") {
    await writeFile(resolve(output, "recovery-baseline.json"), JSON.stringify({ capturedAt: new Date().toISOString(), identities }, null, 2));
    record("recovery-baseline-captured", { agents: identities.length });
  } else if (mode === "compare") {
    const before = await readJson(resolve(output, "recovery-baseline.json"));
    assert.equal(identities.length, before.identities.length, "Agent count changed during recovery.");
    for (const previous of before.identities) {
      const current = identities.find(agent => agent.id === previous.id);
      assert.ok(current, `Missing Agent ${previous.id}`);
      for (const key of ["name", "goal", "threadId", "cwd", "machineId", "runtimeInstance", "reviewedSeq"])
        assert.equal(current[key], previous[key], `Agent ${previous.id} changed ${key}`);
      const turnIds = current.turns.map(turn => turn.id);
      assert.equal(turnIds.length, new Set(turnIds).size, "Duplicate native turn IDs.");
      for (const oldTurn of previous.turns) {
        const turn = current.turns.find(value => value.id === oldTurn.id);
        assert.ok(turn, `Missing turn ${oldTurn.id}`);
        assert.equal(turn.items.length, new Set(turn.items.map(item => item.id)).size, "Duplicate native item IDs.");
        for (const oldItem of oldTurn.items)
          assert.ok(turn.items.some(item => item.id === oldItem.id && item.type === oldItem.type), `Missing item ${oldItem.id}`);
      }
    }
    record("same-agents-threads-history-and-read-state-after-recovery", { agents: identities.length });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  await page?.screenshot({ path: resolve(output, `${mode}-failure.png`), animations: "disabled" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, `${mode}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
