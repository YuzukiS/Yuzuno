// YN-234: what each append of a long Agent reply costs the conversation,
// before and after Prose keeps the blocks already written (ProseBlocks).
// The same replay goes to each build of the real app, in Chromium, with every
// API answered here (no Core, no daily window or data): the conversation of
// one Agent whose Turn is running, its reply already some text long, then 30
// appends as Core streams them (`agent.delta`, one append per batch of
// detail-sync.ts, ~100 ms). Per append: the renderer's main-thread time (CDP
// Performance metrics) from the send to two frames after the text shows. A
// probe run per build also counts the prose's top-level nodes replaced per
// append, checks a selection and the reading position across appends, and
// how long re-opening the reply mid-stream takes. At the end the reply
// completes; its prose (without fading words' spans) is compared across
// builds and with the same reply opened again (drawn whole).
//   PROSE_DISTS=baseline=<dist>,candidate=<dist> PROSE_OUT=<dir> [PROSE_REPS=5] \
//     node acceptance/stream-prose/profile.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import { APPENDS, scenarios } from "./inputs.mjs";

const builds = Object.fromEntries(
  (process.env.PROSE_DISTS || "").split(",").filter(Boolean).map((pair) => {
    const [name, dir] = pair.split("=");
    return [name, resolve(dir)];
  }),
);
assert.ok(Object.keys(builds).length >= 1, "PROSE_DISTS=name=<dist>,...");
assert.ok(process.env.PROSE_OUT, "PROSE_OUT=<dir>");
const out = resolve(process.env.PROSE_OUT);
const reps = Number(process.env.PROSE_REPS || 5);
const browserBin = process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium";
const HOST = "yn234-prose.test";
// After a send: detail-sync applies a batch 100 ms after its first event;
// then two frames. Idle time is not main-thread time, so the wait adds none.
const WAIT_MS = 160;
await mkdir(out, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
async function distInfo(dir) {
  const index = await readFile(join(dir, "index.html"));
  const digest = JSON.parse(await readFile(join(dir, "source-digest.json"), "utf8"));
  const assets = (await readdir(join(dir, "assets"))).filter((f) => f.endsWith(".js")).sort();
  return { dir, indexSha256: sha256(index), sourceDigest: digest.sha256, jsFiles: assets.length };
}

async function run(buildName, dist, scenario, { probe }) {
  const browser = await chromium.launch({ headless: true, executablePath: browserBin, args: ["--disable-gpu"] });
  const errors = [];
  const base = { harness: "codex", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, reviewedSeq: 0, connectionState: "connected", lastSeq: 10, rev: 10 };
  const agents = [{ ...base, id: "a1", name: "Writer", status: "working" }, { ...base, id: "a2", name: "Other", status: "idle" }];
  const state = { text: scenario.text, rev: 10, status: "inProgress", completed: false };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
      localStorage.setItem("yuzuno.selected.ws-prose", JSON.stringify("a1"));
      window.EventSource = class {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          window.__stream = this;
        }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
      window.__send = (data) => window.__stream.onmessage?.({ data: JSON.stringify(data), lastEventId: "" });
      window.__prose = () => document.querySelector('[data-item-id="m1"] .prose');
      window.__frames = (n) => new Promise((done) => { const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : done()); step(n); });
      /** The prose without fading words' spans. */
      window.__plain = () => {
        const copy = window.__prose().cloneNode(true);
        for (const span of copy.querySelectorAll(".stream-word")) span.replaceWith(...span.childNodes);
        copy.normalize();
        return copy.innerHTML;
      };
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (url.host !== HOST) return route.abort();
      if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
      if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path)) return route.fulfill({ status: 404, json: { error: "No usage" } });
      if (path === "/api/agents/a1") {
        const reply = { id: "m1", type: "agentMessage", text: state.text, ...(state.completed ? { _yuzunoCompletedText: state.text } : {}) };
        const agent = { ...agents[0], rev: state.rev, lastSeq: state.rev, status: state.status === "inProgress" ? "working" : "idle" };
        return route.fulfill({ json: { agent, pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "t1", status: state.status, items: [
          { id: "u1", type: "userMessage", content: [{ type: "text", text: "Write it up." }] }, reply] }] } });
      }
      if (path === "/api/agents/a2")
        return route.fulfill({ json: { agent: agents[1], pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "t2", status: "completed", items: [
          { id: "u2", type: "userMessage", content: [{ type: "text", text: "Hi." }] }, { id: "m2", type: "agentMessage", text: "Hello." }] }] } });
      const json = {
        "/api/workspace": { workspace: { id: "ws-prose" }, agents, projects: [], runtime: { connected: true }, defaultCwd: "/w" },
        "/api/home": { generatedAt: new Date(0).toISOString(), order: [], needsYou: [], projects: [] },
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
        "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null }, "/api/jobs/live": { agents: {} },
        "/api/ci": { runs: [], subscriptions: [], hasMore: false, nextBefore: null }, "/api/ci/live": { agents: {} }, "/api/waits/live": { agents: {} },
        "/api/reviews": { reviews: [], hasMore: false, nextBefore: null }, "/api/machines": { machines: [] }, "/api/machine-live": { machines: [] },
        "/api/merge-queue": { entries: [] }, "/api/updates": { channel: "unmanaged" },
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
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://${HOST}/`);
    await page.waitForFunction(() => document.querySelector('[data-item-id="m1"]'), null, { timeout: 30_000 });
    await page.evaluate(() => {
      window.__stream.readyState = 1;
      window.__stream.onopen?.({});
      window.__send({ type: "reset", reason: "open" });
    });
    await page.waitForTimeout(1_500);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];
    const delta = (a, b) => Object.fromEntries(keys.map((k) => [k, (b[k] - a[k]) * 1000]));
    const result = { build: buildName, scenario: scenario.name, prefillChars: scenario.text.length, appends: [], idle: [], errors };

    // Idle windows of the same length, nothing sent: the app's own background.
    for (let i = 0; i < 5; i++) {
      const a = await metric();
      await page.evaluate(async (ms) => { await new Promise((r) => setTimeout(r, ms)); await window.__frames(2); }, WAIT_MS);
      result.idle.push(delta(a, await metric()));
    }
    if (probe) {
      // Probe only: the reader scrolled up to the first paragraph and selected a word in it.
      result.probe = await page.evaluate(() => {
        const prose = window.__prose();
        const first = prose.firstElementChild;
        first?.scrollIntoView({ block: "center" });
        const strong = first?.querySelector("strong");
        if (strong) {
          const range = document.createRange();
          range.selectNodeContents(strong);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }
        window.__firstNode = first;
        window.__removed = 0;
        window.__observer = new MutationObserver((records) => {
          for (const r of records) window.__removed += r.removedNodes.length;
        });
        window.__observer.observe(prose, { childList: true });
        return { firstTop: first ? first.getBoundingClientRect().top : null, selected: getSelection().toString() };
      });
    }
    for (const [i, piece] of scenario.appends.entries()) {
      state.text += piece;
      state.rev += 1;
      const a = await metric();
      // A few of its last characters, and the text shown, without Markdown's
      // marks and white space (none for a fence's first line).
      const tail = piece.startsWith("```") ? "" : piece.replace(/[*`#>|\-[\]()]|https?:\/\/\S+/g, "").replace(/\s+/g, "").slice(-3);
      const { shown, removed } = await page.evaluate(async ({ piece, rev, ms, tail }) => {
        window.__send({ type: "agent.delta", agentId: "a1", rev, turnId: "t1", itemId: "m1", op: "append", field: "text", text: piece });
        await new Promise((r) => setTimeout(r, ms));
        await window.__frames(2);
        const removed = window.__removed;
        window.__removed = 0;
        const text = (window.__prose()?.textContent ?? "").replace(/[*`#>|\-[\]()]/g, "").replace(/\s+/g, "");
        return { shown: text.includes(tail), removed };
      }, { piece, rev: state.rev, ms: WAIT_MS, tail });
      const d = delta(a, await metric());
      result.appends.push({ i, ...d, shown, ...(probe ? { removed } : {}) });
    }
    if (probe) {
      result.probe = {
        ...result.probe,
        replacedPerAppend: result.appends.map((a) => a.removed),
        ...(await page.evaluate(() => {
          window.__observer.disconnect();
          const prose = window.__prose();
          const first = prose.firstElementChild;
          return {
            firstKept: window.__firstNode === first,
            firstTopAfter: first ? first.getBoundingClientRect().top : null,
            selectedAfter: getSelection().toString(),
            topLevelNodes: prose.childNodes.length,
            fadingSpans: prose.querySelectorAll(".stream-word").length,
          };
        })),
      };
    }
    {
      // Re-opening the reply while it is still being written: away to the
      // other Agent and back, from the click to two frames after it shows.
      await page.click('.agent-row[data-agent-id="a2"] .agent-select');
      await page.waitForFunction(() => document.querySelector('[data-item-id="m2"]'), null, { timeout: 10_000 });
      await page.waitForTimeout(500);
      const a = await metric();
      await page.evaluate(async () => {
        document.querySelector('.agent-row[data-agent-id="a1"] .agent-select').click();
        while (!window.__prose()) await new Promise((r) => setTimeout(r, 5));
        await window.__frames(2);
      });
      result.reopenLive = delta(a, await metric());
    }
    // The reply completes, as Core says so, and its Turn ends.
    state.completed = true;
    state.rev += 1;
    await page.evaluate(({ rev, text }) => window.__send({ type: "agent.item", agentId: "a1", rev, turnId: "t1", item: { id: "m1", type: "agentMessage", text, _yuzunoCompletedText: text } }), { rev: state.rev, text: state.text });
    state.status = "completed";
    state.rev += 1;
    await page.evaluate((rev) => window.__send({ type: "agent.changed", agentId: "a1", rev, lastSeq: rev }), state.rev);
    await page.waitForTimeout(800);
    const streamed = await page.evaluate(() => window.__plain());
    result.final = { textChars: state.text.length, htmlSha256: sha256(streamed), htmlChars: streamed.length };
    if (probe) {
      // Opened again: drawn whole, as any finished reply is.
      await page.click('.agent-row[data-agent-id="a2"] .agent-select');
      await page.waitForFunction(() => document.querySelector('[data-item-id="m2"]'), null, { timeout: 10_000 });
      await page.click('.agent-row[data-agent-id="a1"] .agent-select');
      await page.waitForFunction(() => document.querySelector('[data-item-id="m1"] .prose'), null, { timeout: 10_000 });
      await page.waitForTimeout(500);
      const reopened = await page.evaluate(() => window.__plain());
      result.final.reopenedSha256 = sha256(reopened);
      result.final.sameAsReopened = reopened === streamed;
      if (!result.final.sameAsReopened) await writeFile(join(out, `final-${buildName}-${scenario.name}.html`), `${streamed}\n<!-- reopened -->\n${reopened}\n`);
    }
    return result;
  } finally {
    await browser.close();
  }
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};
const report = {
  task: "YN-234 R-46 long replies",
  started: new Date().toISOString(),
  environment: {
    platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, node: process.version,
    browser: browserBin, reps, appends: APPENDS, waitMs: WAIT_MS, viewport: "1440x1000", reducedMotion: false, gpu: "disabled",
    jobCpuMillis: process.env.YUZUNO_JOB_CPU_MILLIS ?? null,
  },
  builds: Object.fromEntries(await Promise.all(Object.entries(builds).map(async ([name, dir]) => [name, await distInfo(dir)]))),
  scenarios: scenarios.map((s) => ({ name: s.name, prefillChars: s.text.length, appendedChars: s.appends.join("").length, prefillSha256: sha256(s.text) })),
  probe: [],
  runs: [],
};
const save = () => writeFile(join(out, "stream-prose.json"), `${JSON.stringify(report, null, 2)}\n`);
{
  const b = await chromium.launch({ headless: true, executablePath: browserBin });
  report.environment.browserVersion = b.version();
  await b.close();
}
const names = Object.keys(builds);
for (const scenario of scenarios)
  for (const name of names) {
    const result = await run(name, builds[name], scenario, { probe: true });
    report.probe.push(result);
    const p = result.probe;
    console.log(`probe ${name} ${scenario.name}: replaced/append p50 ${quantile(p.replacedPerAppend, 0.5)} max ${Math.max(...p.replacedPerAppend)}, first kept ${p.firstKept}, selection ${JSON.stringify(p.selected)}→${JSON.stringify(p.selectedAfter)}, top ${p.firstTop}→${p.firstTopAfter}, same as reopened ${result.final.sameAsReopened}`);
    await save();
  }
for (let rep = 0; rep < reps; rep++)
  for (const scenario of scenarios)
    for (const name of rep % 2 ? [...names].reverse() : names) {
      const result = await run(name, builds[name], scenario, { probe: false });
      result.rep = rep;
      report.runs.push(result);
      console.log(`rep ${rep} ${name} ${scenario.name}: per append p50 ${quantile(result.appends.map((a) => a.TaskDuration), 0.5).toFixed(2)} ms, idle p50 ${quantile(result.idle.map((a) => a.TaskDuration), 0.5).toFixed(2)} ms, unshown ${result.appends.filter((a) => !a.shown).length}`);
      await save();
    }

report.summary = [];
for (const scenario of scenarios) {
  const finals = new Set([...report.runs, ...report.probe].filter((r) => r.scenario === scenario.name).map((r) => r.final.htmlSha256));
  for (const name of names) {
    const runs = report.runs.filter((r) => r.scenario === scenario.name && r.build === name);
    const probe = report.probe.find((r) => r.scenario === scenario.name && r.build === name);
    const all = (key) => runs.flatMap((r) => r.appends.map((a) => a[key]));
    const stats = (values) => ({ p50: quantile(values, 0.5), p90: quantile(values, 0.9), p95: quantile(values, 0.95), max: Math.max(...values), n: values.length });
    report.summary.push({
      scenario: scenario.name, build: name,
      taskMs: stats(all("TaskDuration")), scriptMs: stats(all("ScriptDuration")), layoutMs: stats(all("LayoutDuration")), styleMs: stats(all("RecalcStyleDuration")),
      idleTaskMs: stats(runs.flatMap((r) => r.idle.map((a) => a.TaskDuration))),
      perRunTaskP50: runs.map((r) => quantile(r.appends.map((a) => a.TaskDuration), 0.5)),
      unshown: runs.reduce((n, r) => n + r.appends.filter((a) => !a.shown).length, 0),
      replacedPerAppend: { p50: quantile(probe.probe.replacedPerAppend, 0.5), max: Math.max(...probe.probe.replacedPerAppend) },
      firstKept: probe.probe.firstKept, selection: [probe.probe.selected, probe.probe.selectedAfter], firstTop: [probe.probe.firstTop, probe.probe.firstTopAfter],
      reopenLiveTaskMs: stats(runs.map((r) => r.reopenLive.TaskDuration)),
      finalSameAsReopened: probe.final.sameAsReopened,
      finalSameAcrossBuildsAndRuns: finals.size === 1,
      errors: [...runs, probe].flatMap((r) => r.errors),
    });
  }
}
report.finished = new Date().toISOString();
await save();
for (const s of report.summary)
  console.log(`${s.scenario.padEnd(10)} ${s.build.padEnd(10)} task/append p50 ${s.taskMs.p50.toFixed(2)} p90 ${s.taskMs.p90.toFixed(2)} p95 ${s.taskMs.p95.toFixed(2)} ms (idle p50 ${s.idleTaskMs.p50.toFixed(2)}) | script p50 ${s.scriptMs.p50.toFixed(2)} | replaced p50 ${s.replacedPerAppend.p50} | reopen p50 ${s.reopenLiveTaskMs.p50.toFixed(1)} ms [${Math.min(...report.runs.filter((r) => r.scenario === s.scenario && r.build === s.build).map((r) => r.reopenLive.TaskDuration)).toFixed(1)}–${s.reopenLiveTaskMs.max.toFixed(1)}] | final same: reopened ${s.finalSameAsReopened}, builds ${s.finalSameAcrossBuildsAndRuns}`);
