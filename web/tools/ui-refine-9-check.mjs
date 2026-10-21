// UI refine 9 in a browser, on a production build with every API answered
// here (no Core): the Machines widget shows each GPU's use and memory as bars
// and its Jobs as a compact list that opens a Job in Jobs; the Jobs panel's
// machine card puts what jobs use on the bars of what they reserve, with its
// fine print in tips; Settings has the desktop app under Updates; the
// Machines page shows its agents as small tiles; the project menu rises and
// sinks with motion and does neither with reduced motion; the Home tab counts
// what Needs you lists; a newer version of a card marks the blocks it changed
// and does not tint the card; Codex's context window settings read as what
// Codex reports, two fields and one line on applying. Light and dark, wide
// and narrow. Screenshots for review; nothing is written.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { noCiRuns, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/ui-refine-9-browser");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-ui-refine-9.test";
const report = { checks: [], failures: [], errors: [], mutations: [], unexpected: [] };
let page;
async function step(name, run) {
  try {
    const extra = (await run()) || {};
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    const file = `fail-${report.failures.length + 1}.png`;
    report.failures.push({ name, error: error.stack || String(error), screenshot: file });
    console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
    await page?.screenshot({ path: resolve(output, file) }).catch(() => {});
  }
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const projects = [
  { id: "p1", name: "yuzuno-next", defaultDirs: { local: "/home/me/yuzuno-next" }, createdAt: "", updatedAt: "" },
  { id: "p2", name: "SampleResearch", defaultDirs: { local: "/home/me/research-demo" }, createdAt: "", updatedAt: "" },
];
const agentBase = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "",
  harness: "codex", model: "gpt-6", settings: {}, connectionState: "connected", threadId: null, closedAt: null };
const agents = [
  ["dev-1", "Dev 1", "working"], ["dev-2", "Dev 2", "working"], ["dev-3", "Dev 3", "idle"], ["lead", "Dev Lead", "idle"],
  ["dev-4", "Dev 4", "idle"], ["dev-5", "Dev 5", "working"], ["dev-6", "Dev 6", "waiting"], ["research", "SampleResearch", "idle"],
].map(([id, name, status], n) => ({
  ...agentBase, id, name, status, projectId: id === "research" ? "p2" : "p1",
  ...(id === "dev-5" ? { settings: { reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write", contextWindow: 872000 } } : {}),
  cwd: id === "research" ? "/home/me/research-demo" : "/home/me/yuzuno-next",
  color: ["sage", "sky", "peach", "lilac", "sand"][n % 5],
}));
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const counts = (working, idle) => ({ working, idle, waiting: 0, error: 0, offline: 0, total: working + idle });
// Small PNGs for image attachments: one wide (like a screenshot strip), one tall.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
const images = {
  "wide.png": png(888, 140, (x, y) => (y < 20 ? [40, 48, 38] : x % 222 < 200 && y > 40 && y < 52 ? [205, 180, 90] : [36, 42, 34])),
  "tall.png": png(330, 470, (x, y) => (y % 60 < 4 ? [60, 70, 55] : [38, 45, 36])),
};
// A section shaped like the user's 界面设计 card: a tinted summary, a group of
// text and images, three columns of groups, and a muted note.
const block = (type, props, children) => (children ? { type, props, children } : { type, props });
const designBody = {
  root: "body",
  elements: {
    body: block("BriefBody", {}, ["summary", "preview", "areas", "limits"]),
    summary: block("Group", { tone: "accent" }, ["summaryText"]),
    summaryText: block("Markdown", { text: "**UI changes are arranged with you directly.** The preview below is the first version." }),
    preview: block("Group", { title: "Preview" }, ["previewText", "previewShots"]),
    previewText: block("Markdown", { text: "- **Machine card:** one cell per resource.\n- **Widget:** a bar for GPU use and one for its memory." }),
    previewShots: block("Attachments", { items: [{ name: "wide.png", caption: "A wide screenshot" }, { name: "tall.png", caption: "A tall screenshot" }] }),
    areas: block("Columns", {}, ["home", "tasks", "turns"]),
    home: block("Group", { title: "Home" }, ["homeText"]),
    homeText: block("Markdown", { text: "- **Columns:** projects on the left, widgets on the right." }),
    tasks: block("Group", { title: "Tasks" }, ["tasksText"]),
    tasksText: block("Markdown", { text: "- **Cards** while no task is open." }),
    turns: block("Group", { title: "Conversations" }, ["turnsText"]),
    turnsText: block("Markdown", { text: "- **Turn dock** in Settings → Appearance." }),
    limits: block("Group", { title: "Known limits", tone: "muted" }, ["limitsText"]),
    limitsText: block("Markdown", { text: "One fix was not reviewed again; you accepted that." }),
  },
};
// Version 3 rewrites the summary and adds one block to the preview.
const designV3 = structuredClone(designBody);
designV3.elements.summaryText.props.text = "**UI changes are arranged with you directly.** Items 9 and 10 are ready for review.";
designV3.elements.previewNew = block("Markdown", { text: "- **Home tab:** shows how many items need you." });
designV3.elements.preview.children.splice(1, 0, "previewNew");
const designSection = {
  key: "home-layout", kind: "status", title: "Interface design", version: 2, owner: { agentId: "dev-5", name: "Dev 5", state: "active" },
  updatedAt: ago(3), updatedTurnId: "t2", body: designBody, refs: {}, seen: { version: 2, at: ago(30) }, history: false,
  status: { asOf: ago(3), validFor: 86400, stale: false },
  attachments: Object.entries(images).map(([name, bytes]) => ({ name, kind: "image", mime: "image/png", size: bytes.length,
    snapshot: true, mayChange: false, takenAt: ago(3), caption: name })),
};
const home = {
  generatedAt: ago(0),
  order: ["p1", "p2"],
  needsYou: [],
  projects: [
    { project: { id: "p1", name: "yuzuno-next" }, agents: counts(4, 3), errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: { version: 2, history: [], sections: [designSection, { key: "overview", kind: "status", title: "Overview", version: 1,
        owner: { agentId: "lead", name: "Dev Lead", state: "active" }, updatedAt: ago(5), updatedTurnId: "t1",
        body: markdown("Release core.10 is out; the next batch has started."), attachments: [], refs: {}, seen: null, history: false,
        status: { asOf: ago(5), validFor: 86400, stale: false } }] } },
    { project: { id: "p2", name: "SampleResearch" }, agents: counts(0, 1), errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: { version: 0, history: [], sections: [] } },
  ],
};
const setDesign = (version) => Object.assign(designSection, { version, body: version === 3 ? designV3 : designBody });
const researchAsk = {
  key: "plan", kind: "ask", title: "Order of the next steps", version: 1, owner: { agentId: "research", name: "SampleResearch", state: "active" },
  updatedAt: ago(2), updatedTurnId: "t3", body: markdown("Three steps; each waits for the one before."), refs: {}, seen: null, history: false,
  attachments: [], ask: { question: "Start in the order 1 → 2 → 3?", state: "open", reply: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } },
};
const researchNeed = { kind: "ask", projectId: "p2", agentId: "research", agentName: "SampleResearch", sectionKey: "plan", title: researchAsk.title, since: ago(2) };
const longName = "T-120 decision: base vs a+b ABBA, 6 rounds/attach, held + 6 s idle, then 4 browser runs; a+b binary reused";
const machineLoad = {
  at: ago(0),
  cpu: { cores: 32, totalPct: 31, jobsPct: 6.5, agentsPct: 9, otherPct: 15.5 },
  memory: { totalMiB: 40107, usedMiB: 30720, availableMiB: 9523, jobsMiB: 10650, agentsMiB: 6144 },
  gpus: [{ name: "NVIDIA GeForce RTX 5090", utilPct: 37, memUsedMiB: 5330, memTotalMiB: 32607, attribution: "unknown" }],
  jobs: [
    { id: "job-t120", name: longName, agentId: "dev-3", agentName: "Dev 3", projectId: "p1", cpuPct: 10, memMiB: 10240 },
    { id: "job-web", name: "T-127 full web suite (validator, typecheck, build, all tests)", agentId: "dev-5", agentName: "Dev 5", projectId: "p1", cpuPct: 48, memMiB: 1210 },
    { id: "job-train", name: "SampleResearch experiment sweep, seed 3", agentId: "research", agentName: "SampleResearch", projectId: "p2", cpuPct: 3, memMiB: null },
  ],
};
const GPU0 = "GPU-0d1e2f30-4a5b-6c7d-8e9f-a0b1c2d3e4f5";
const gib = 1073741824;
const budget = {
  machine: { name: "LabWorkstation", memoryAvailableMiB: 9523, scope: "fixture",
    logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384, hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 },
  reserved: { cpuMillis: 4200, memoryMiB: 14438, swapMiB: 0 },
  queuedCount: 1,
  activeCount: 2,
  disk: {
    reserveGiB: null, defaultRule: "10 GiB, or a tenth of a filesystem smaller than 100 GiB", bounds: { minGiB: 1, maxGiB: 1024 },
    observedAt: ago(0), scope: "Checked before each new job starts, not a quota.",
    volumes: [{ device: 1, totalBytes: 1510.8 * gib, availableBytes: 158.2 * gib, reserveBytes: 10 * gib, low: false, error: null,
      paths: [{ path: "/home/me/.yuzuno", role: "Core data and job records" }, { path: "/home/me/yuzuno-next", role: "working directory" },
        { path: "/home/me/research-demo", role: "working directory" }] }],
  },
  gpus: {
    devices: [{ uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryTotalMiB: 32607, memoryFreeMiB: 27277,
      admission: "open", closedReason: null, closedBy: null, sharing: false, headroomMiB: 1024,
      reservations: [{ jobId: "job-train", name: "SampleResearch experiment sweep, seed 3", memoryMiB: 8192, mode: "exclusive" }] }],
    observedAt: ago(0), problem: null,
    scope: "Admission among this Core's managed jobs by declared GPU memory. Free memory is the whole card's, other programs included.",
  },
};
const resources = { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 };
const job = (id, name, agentId, extra = {}) => ({
  id, requestId: id, name, taskRef: "T-127", agentId, agent: { name: agents.find((a) => a.id === agentId).name }, machine: { name: "LabWorkstation" },
  status: "running", reserved: true, reason: "Running with verified cgroup limits", resources,
  reservation: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 }, cursor: 1, createdAt: ago(9), startedAt: ago(8), finishedAt: null,
  argv: ["/bin/sh", "tools/web-full.sh"], cwd: "/home/me/yuzuno-next", env: {}, outputs: [], ...extra,
});
const jobs = [
  job("job-t120", longName, "dev-3"),
  job("job-web", "T-127 full web suite (validator, typecheck, build, all tests)", "dev-5"),
  job("job-train", "SampleResearch experiment sweep, seed 3", "research", { gpu: { memoryMiB: 8192 },
    gpuReservation: [{ uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryMiB: 8192, mode: "exclusive" }] }),
  job("job-queued", "T-125 stage gate dry run", "dev-2", { status: "queued", reserved: false, startedAt: null, reason: "Waiting for shared machine capacity" }),
];

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open({ theme = "dark", width = 1440, height = 900, motion = "reduce" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  const p = await context.newPage();
  await p.addInitScript((theme) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
  }, theme);
  p.on("pageerror", (error) => report.errors.push(error.message));
  await p.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.hostname, HOST);
    const path = url.pathname;
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      report.mutations.push({ method, path });
      if (method === "POST" && /^\/api\/agents\/[^/]+\/review$/.test(path)) return route.fulfill({ json: {} });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const image = path.match(/^\/api\/projects\/p1\/brief\/attachments\/home-layout\/([\w.-]+)$/);
    if (image && images[image[1]]) return route.fulfill({ body: images[image[1]], contentType: "image/png" });
    const detail = path.match(/^\/api\/jobs\/(job-[\w-]+)$/);
    if (detail) return route.fulfill({ json: jobs.find((j) => j.id === detail[1]) ?? jobs[0] });
    if (/^\/api\/jobs\/job-[\w-]+\/logs$/.test(path)) return route.fulfill({ json: { text: "running…\n", offset: 0, nextOffset: 9, oldestOffset: 0, totalBytes: 9, truncated: false } });
    // Dev 5's catalog, with a saved window Codex reported lower (as on the user's screen).
    if (path === "/api/agents/dev-5/models")
      return route.fulfill({ json: {
        models: [{ id: "gpt-6", model: "gpt-6", displayName: "GPT-6", defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "More reasoning" }] }],
        context: { supported: true, settingsSubmitted: true, canApply: true, requestedWindowTokens: 872000,
          observedWindowTokens: 828400, observedStale: false, inheritedContextWindow: null, inheritedAutoCompactTokenLimit: null },
      } });
    const agentDetail = path.match(/^\/api\/agents\/([\w-]+)$/);
    if (agentDetail) {
      const agent = agents.find((a) => a.id === agentDetail[1]) ?? agents[0];
      return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-9" }, agents, projects, runtime: { connected: true }, defaultCwd: "/home/me" },
      "/api/home": home,
      "/api/machine-load": machineLoad,
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/home/me/yuzuno-next/acceptance/live/task", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": budget,
      "/api/jobs": { jobs, liveJobs: jobs.filter((j) => j.status === "running"), hasMore: false, nextBefore: null },
      // Dev 3 waits on a Job alone, Dev 4 on CI alone: both stay beside the name.
      "/api/jobs/live": { agents: { "dev-3": { active: 1, unknown: 0 } } },
      // A run stopped after a stage for the Agent's analysis (T-125), shown beside the machine card.
      "/api/jobs/runs": { runs: [{ id: "run-demo", name: "SampleResearch experiment sweep" }], hasMore: false },
      "/api/ci/live": { agents: { "dev-4": { running: 1, discovering: 0, check: 0 } } },
      "/api/ci": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[extname(file)] });
  });
  await p.goto(`http://${HOST}/`);
  await p.locator(".catchup-nav").first().click();
  await p.locator(".home-machine:not([aria-busy])").waitFor();
  return p;
}
const shot = (locator, name) => locator.screenshot({ path: resolve(output, name), animations: "disabled" });
const noSideways = (selector) =>
  page.locator(selector).first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

/** Frames of an animation slowed to 15% speed, as a GIF for review. */
async function film(name, target, action, frames = 12) {
  await page.evaluate(() => {
    window.__slow = new MutationObserver(() => document.getAnimations().forEach((a) => (a.playbackRate = 0.15)));
    window.__slow.observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await action();
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => document.getAnimations().forEach((a) => (a.playbackRate = 0.15)));
    await target.screenshot({ path: resolve(output, `${name}-${String(i).padStart(2, "0")}.png`), animations: "allow" });
    await new Promise((done) => setTimeout(done, 70));
  }
  // Endless animations (spinners) cannot be finished; only the filmed ones are.
  await page.evaluate(() => {
    window.__slow.disconnect();
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
      else a.playbackRate = 1;
    }
  });
  try {
    await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "8", "-i", resolve(output, `${name}-%02d.png`),
      "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", resolve(output, `${name}.gif`)]);
    return `${name}.gif`;
  } catch (error) {
    return `${name}: frames only (${String(error.message).split("\n")[0]})`;
  }
}

try {
  page = await open({ theme: "dark", motion: "no-preference" });
  await step("the project menu rises from the switcher and sinks back into it", async () => {
    const menu = page.locator(".scope-menu");
    await page.locator(".workspace-scope").click();
    await menu.waitFor();
    const early = await menu.evaluate((el) => Number(getComputedStyle(el).opacity));
    await page.waitForTimeout(300);
    const settled = await menu.evaluate((el) => Number(getComputedStyle(el).opacity));
    assert.ok(early < 1 && settled === 1, JSON.stringify({ early, settled }));
    // The way out lasts 120 ms: recorded as it happens, not sampled after.
    await page.evaluate(() => {
      window.__leaving = [];
      window.__menuWatch = new MutationObserver(() => {
        const leaving = document.querySelector(".scope-menu.is-leaving");
        if (leaving) window.__leaving.push(leaving.getAttribute("aria-hidden"));
      });
      window.__menuWatch.observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached", timeout: 600 });
    const leaving = await page.evaluate(() => {
      window.__menuWatch.disconnect();
      return window.__leaving;
    });
    assert.ok(leaving.length > 0, "it sinks back before it goes");
    assert.deepEqual([...new Set(leaving)], ["true"], "hidden while it sinks");
    // A quick reopen ends on open, whatever the menu was doing.
    await page.locator(".workspace-scope").click();
    await page.keyboard.press("Escape");
    await page.locator(".workspace-scope").click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".scope-menu:not(.is-leaving)").count(), 1);
    assert.equal(await page.locator(".scope-menu").count(), 1);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached", timeout: 600 });
    const rail = page.locator("aside.rail");
    const gif = await film("project-menu-open", rail, () => page.locator(".workspace-scope").click());
    await page.keyboard.press("Escape");
    return { early, settled, gif };
  });
  await page.context().close();

  for (const theme of ["dark", "light"]) {
    page = await open({ theme });
    const machines = page.locator(".home-widget-column .home-machines");

    await step(`${theme}: Home has one frame per card: no box around a project, a plain group or an image`, async () => {
      const panel = page.locator('.home-view [data-home-project="p1"]');
      if ((await panel.locator(".home-panel-toggle").getAttribute("aria-expanded")) === "false")
        await panel.locator(".home-panel-toggle").click();
      const card = panel.locator('[data-section-key="home-layout"]');
      await card.locator(".brief-attachment img").first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll(".brief-attachment img")].every((img) => img.complete && img.naturalWidth > 0));
      const frames = await page.evaluate(() => {
        const framed = (el) => el && parseFloat(getComputedStyle(el).borderTopWidth) > 0 && parseFloat(getComputedStyle(el).borderLeftWidth) > 0;
        const tinted = (el) => !/rgba?\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(el).backgroundColor);
        const card = document.querySelector('.home-view [data-section-key="home-layout"]');
        const panel = card.closest(".home-panel");
        const groups = [...card.querySelectorAll(".brief-group")];
        return {
          panel: framed(panel), panelTinted: tinted(panel), section: framed(card),
          groups: groups.map((g) => ({ tone: g.dataset.tone || "", framed: framed(g), tinted: tinted(g) })),
          attachments: [...card.querySelectorAll(".brief-attachment")].map((a) => framed(a)),
          // An image comes first and keeps its own shape (no letterboxed well).
          images: [...card.querySelectorAll(".brief-attachment")].map((a) => {
            // The shape inside its 1 px outline.
            const img = a.querySelector("img"), box = img.getBoundingClientRect(), head = a.querySelector("header").getBoundingClientRect();
            return { first: box.top < head.top, ratio: +(img.clientWidth / img.clientHeight).toFixed(2), natural: +(img.naturalWidth / img.naturalHeight).toFixed(2) };
          }),
        };
      });
      assert.equal(frames.panel, false, "no frame around a project");
      assert.equal(frames.section, true, "the card keeps its frame");
      assert.deepEqual(frames.groups.filter((g) => g.framed), [], "no group is boxed");
      assert.deepEqual(frames.groups.filter((g) => g.tone).map((g) => [g.tone, g.tinted]), [["accent", true], ["muted", true]], "tones still tint");
      assert.deepEqual(frames.attachments, [false, false], "no card around an attachment");
      for (const image of frames.images) {
        assert.ok(image.first, "the image comes before its name");
        assert.ok(Math.abs(image.ratio - image.natural) < 0.05, `its own shape: ${JSON.stringify(image)}`);
      }
      await card.scrollIntoViewIfNeeded();
      await shot(page.locator(".home-main"), `home-card-${theme}.png`);
      return { frames };
    });

    await step(`${theme}: the Home tab counts what Needs you lists; a newer version marks only the blocks it changed and leaves the card untinted`, async () => {
      const key = 'yuzuno.home-seen-blocks.v1:["ws-9","p1","home-layout",null]';
      assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null")?.version, key), 2, "the seen version's blocks are kept");
      const tab = page.locator(".catchup-nav").first();
      assert.equal(await tab.locator(".nav-count").count(), 0, "nothing needs you yet");
      // Core's next read: an Ask from SampleResearch, and version 3 of the card.
      setDesign(3);
      home.needsYou = [researchNeed];
      home.projects[1].brief.sections = [researchAsk];
      try {
        await page.getByRole("button", { name: "Refresh Home" }).click();
        await page.waitForFunction(() => document.querySelector('.home-view [data-section-key="home-layout"]')?.dataset.sectionVersion === "3");
        await tab.locator(".nav-count").waitFor();
        assert.equal(await tab.locator(".nav-count").innerText(), "1");
        assert.equal(await tab.getAttribute("title"), "Home · 1 waiting for your response");
        const card = page.locator('.home-view [data-section-key="home-layout"]');
        const look = await card.evaluate((el) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          // Every background under an element, painted outermost first.
          const under = (node) => {
            const layers = [];
            for (let n = node; n; n = n.parentElement) layers.unshift(getComputedStyle(n).backgroundColor);
            ctx.clearRect(0, 0, 1, 1);
            for (const color of ["#fff", ...layers]) {
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
            }
            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
          };
          const rgb = (color) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
          };
          const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const contrast = (a, b) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
          };
          const other = document.querySelector('.home-view [data-section-key="overview"]');
          const paint = (n) => [getComputedStyle(n).backgroundColor, getComputedStyle(n).borderTopColor];
          return {
            sameAsOther: JSON.stringify(paint(el)) === JSON.stringify(paint(other)),
            chip: el.querySelector(".home-changed")?.textContent,
            marks: [...el.querySelectorAll(".brief-change")].map((change) => {
              const mark = change.querySelector(":scope > .brief-change-mark");
              const box = mark.getBoundingClientRect(), block = mark.nextElementSibling.getBoundingClientRect();
              return {
                change: change.dataset.change, label: mark.textContent, text: mark.nextElementSibling.textContent.slice(0, 120),
                contrast: contrast(rgb(getComputedStyle(mark).color), under(mark)),
                above: box.bottom <= block.top + 0.5, height: Math.round(box.height),
              };
            }),
          };
        });
        assert.ok(look.sameAsOther, "a changed card looks like any other card");
        assert.equal(look.chip, "Updated", "its header still says it changed");
        assert.deepEqual(look.marks.map((m) => [m.change, m.label]), [["updated", "Updated"], ["new", "New"]]);
        assert.match(look.marks[0].text, /Items 9 and 10/);
        assert.match(look.marks[1].text, /Home tab/);
        for (const mark of look.marks) {
          assert.ok(mark.contrast >= 4.5, `mark contrast ${JSON.stringify(mark)}`);
          assert.ok(mark.above && mark.height <= 20, `a small mark above its block ${JSON.stringify(mark)}`);
        }
        await shot(page.locator(".toolbar-nav"), `home-tab-count-${theme}.png`);
        await card.scrollIntoViewIfNeeded();
        await shot(card, `home-changed-blocks-${theme}.png`);
        return { look };
      } finally {
        setDesign(2);
        home.needsYou = [];
        home.projects[1].brief.sections = [];
      }
    });

    await step(`${theme}: the Machines widget has a use and a memory bar for each GPU, and its Jobs as a compact list`, async () => {
      await machines.locator(".home-gpus .home-gpu-name").filter({ hasText: "RTX 5090" }).waitFor();
      const bars = await machines.locator(".home-gpus li .home-meter").evaluateAll((els) =>
        els.map((el) => ({ label: el.getAttribute("aria-label"), width: el.querySelector(".home-meter-gpu")?.style.width })));
      assert.deepEqual(bars.map((b) => b.label), ["GPU use 37%", "GPU memory 5.2 GiB / 31.8 GiB"]);
      assert.equal(bars[0].width, "37%");
      // Each Job: a button, its name on one line, a quiet line under it.
      const rows = machines.locator(".home-machine-jobs button.home-machine-job");
      assert.equal(await rows.count(), 3);
      const first = await rows.first().evaluate((el) => {
        const name = el.querySelector("strong"), small = el.querySelector("small");
        const line = parseFloat(getComputedStyle(name).lineHeight);
        return { nameLines: Math.round(name.getBoundingClientRect().height / line), clipped: name.scrollWidth > name.clientWidth,
          small: small.textContent, height: Math.round(el.getBoundingClientRect().height) };
      });
      assert.equal(first.nameLines, 1, "a long name stays on one line");
      assert.ok(first.clipped, "and is cut with an ellipsis");
      assert.match(first.small, /^yuzuno-next · Dev 3CPU 10%Memory 10\.0 GiB$/);
      assert.ok(first.height <= 48, `a row is about two lines: ${first.height}px`);
      assert.ok(await noSideways(".home-widget-column .home-machines"), "no sideways scroll in the widget");
      await shot(machines, `machines-widget-${theme}.png`);
      return { first };
    });

    await step(`${theme}: a single wait, Job or CI, stays beside the Agent's name`, async () => {
      const row = (id) => page.locator(`[data-agent-id="${id}"]`);
      await page.waitForFunction(() => document.querySelector('[data-agent-id="dev-4"] .agent-runtime')?.textContent === "Waiting · CI");
      const place = async (id) => row(id).evaluate((el) => {
        const name = el.querySelector(".agent-name").getBoundingClientRect();
        const state = el.querySelector(".agent-runtime").getBoundingClientRect();
        return { label: el.querySelector(".agent-runtime").textContent, beside: state.top < name.bottom && state.left >= name.right };
      });
      assert.deepEqual(await place("dev-3"), { label: "Waiting · Job", beside: true });
      assert.deepEqual(await place("dev-4"), { label: "Waiting · CI", beside: true });
      await shot(page.locator("aside.rail"), `rail-waiting-${theme}.png`);
    });

    await step(`${theme}: with reduced motion the project menu opens and closes at once`, async () => {
      await page.locator(".workspace-scope").click();
      const menu = page.locator(".scope-menu");
      await menu.waitFor();
      assert.equal(await menu.evaluate((el) => Number(getComputedStyle(el).opacity)), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".scope-menu").count(), 0, "gone at once, not sinking");
    });

    await step(`${theme}: a Job in the widget opens in the Jobs panel`, async () => {
      await machines.locator("button.home-machine-job").first().click();
      const row = page.locator(".job-row[aria-current='true']");
      await row.waitFor();
      assert.match(await row.textContent(), /T-120 decision/);
      await page.locator(".job-detail").filter({ hasText: "T-120 decision" }).waitFor();
    });

    await step(`${theme}: the machine card puts use on the bars of what is reserved, with the fine print in tips`, async () => {
      const card = page.locator(".jobs-budget");
      await card.locator(".jobs-meter-used").first().waitFor();
      const meters = await card.locator(".jobs-meter").evaluateAll((els) => els.map((el) => ({
        name: el.querySelector(".jobs-meter-name")?.textContent,
        value: el.querySelector(".jobs-meter-value")?.textContent,
        used: el.querySelector(".jobs-meter-used")?.style.width ?? null,
        reserved: el.querySelector(".jobs-meter-reserved")?.style.width ?? null,
      })));
      assert.deepEqual(meters.map((m) => m.name), ["CPU", "RAM", "Disk", "GPU 0 · RTX 5090"]);
      // Runs awaiting analysis keep their own section in the same panel.
      const awaiting = page.locator('[aria-label="Runs awaiting analysis"]');
      await awaiting.waitFor();
      assert.match(await awaiting.innerText(), /Awaiting analysis[\s\S]*SampleResearch experiment sweep/);
      // In use on top. 6.5% of 32 cores is 2.1 CPU of an 8 CPU budget.
      assert.deepEqual(meters.map((m) => m.value), ["2.1 in use", "10.4 GiB in use", "158.2 GiB free", "5.2 GiB in use"]);
      assert.equal(meters[0].used, "26.25%");
      assert.equal(meters[0].reserved, "52.5%");
      assert.equal(meters[2].reserved, null);
      assert.ok(meters[3].used && meters[3].reserved, "GPU memory in use and reserved");
      // The rest beneath.
      assert.deepEqual(await card.locator(".jobs-reserved-text").allInnerTexts(), ["4.2 / 8 reserved", "14.1 GiB / 16.0 GiB reserved"]);
      assert.equal(await card.locator(".jobs-gpu-held").textContent(), "8.0 GiB reserved");
      assert.equal(await card.locator(".jobs-gpu-busy").textContent(), "37% busy");
      const tops = await card.locator(".jobs-budget-meters > .jobs-meter").evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().top)));
      assert.equal(new Set(tops).size, 1, `four cells in one row: ${tops}`);
      // The long notes are tips now, not lines.
      const text = await card.evaluate((el) => el.innerText);
      for (const gone of ["Reservations include", "Admission among", "Sampled", "Read ", "Core data and job records"])
        assert.ok(!text.includes(gone), `"${gone}" is in a tip, not on the card`);
      assert.match(await card.locator(".jobs-budget-key").getAttribute("title"), /bounded result collector/);
      assert.match(await card.locator(".jobs-disk-paths").getAttribute("title"), /Core data and job records: \/home\/me\/\.yuzuno/);
      assert.match(await card.locator(".jobs-gpu-name").getAttribute("title"), /Admission among/);
      const height = await card.evaluate((el) => Math.round(el.getBoundingClientRect().height));
      assert.ok(height <= 170, `the card is short at 1440 px: ${height}px`);
      assert.ok(await noSideways(".jobs-budget"));
      await shot(card, `jobs-machine-card-${theme}.png`);
      await page.screenshot({ path: resolve(output, `jobs-panel-${theme}.png`), animations: "disabled" });
      return { height, meters };
    });

    await step(`${theme}: the machine card's settings still open in place`, async () => {
      const card = page.locator(".jobs-budget");
      for (const summary of ["Machine budget", "Disk reserve", "Exclusive"]) {
        await card.locator("summary", { hasText: summary }).click();
        await card.locator("details[open] form").first().waitFor();
        await card.locator("summary", { hasText: summary }).click();
      }
      assert.equal(await card.locator("details[open]").count(), 0);
      assert.ok(await card.getByRole("button", { name: "Pause GPU work" }).isVisible());
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
    });

    await step(`${theme}: Settings has the desktop app under Updates, in three categories`, async () => {
      await page.getByRole("button", { name: "Settings and updates", exact: true }).click();
      const settings = page.locator(".modal.settings-modal");
      await settings.waitFor();
      assert.deepEqual(await settings.locator(".settings-nav [role=tab]").allInnerTexts(), ["Updates", "Appearance", "Code review"]);
      const desktop = settings.locator('#settings-panel-updates [aria-label="Desktop app"]');
      await desktop.waitFor();
      assert.match(await desktop.textContent(), /updated separately/);
      assert.equal(await desktop.locator("button").count(), 0, "no desktop buttons in a browser");
      await desktop.scrollIntoViewIfNeeded();
      await shot(settings, `settings-updates-${theme}.png`);
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
    });

    await step(`${theme}: the Machines page shows its agents as small tiles, several to a row`, async () => {
      await page.locator(".home-widget-column .home-machines-manage").click();
      const agentsHere = page.locator(".machine-agents").first();
      await agentsHere.locator(".machine-agent").first().waitFor();
      const tiles = await agentsHere.locator(".machine-agent").evaluateAll((els) =>
        els.map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), title: el.title }; }));
      assert.equal(tiles.length, 8);
      const rows = new Set(tiles.map((t) => t.top)).size;
      assert.ok(rows <= 3, `8 agents in ${rows} rows`);
      assert.ok(tiles.every((t) => t.height <= 48), `small tiles: ${tiles.map((t) => t.height)}`);
      assert.equal(tiles[0].title, "Open Dev 1\n/home/me/yuzuno-next");
      const text = await agentsHere.evaluate((el) => el.innerText);
      assert.ok(!text.includes("/home/me"), "folders are in the tips");
      await shot(page.getByRole("dialog"), `machines-page-${theme}.png`);
      await page.keyboard.press("Escape");
      return { rows };
    });

    await step(`${theme}: Codex's context window reads as what Codex reports, two fields side by side and one line on applying`, async () => {
      await page.getByRole("button", { name: "Open Dev 5" }).click();
      await page.getByRole("button", { name: "Agent settings" }).click();
      const block = page.locator(".codex-context-settings");
      await page.waitForFunction(() => document.querySelector('[aria-label="Context window tokens"]')?.disabled === false);
      const look = await block.evaluate((el) => {
        const fields = [...el.querySelectorAll(".codex-context-fields > label")].map((l) => l.getBoundingClientRect());
        const dialog = el.closest('[role="dialog"]');
        return {
          figure: el.querySelector(".codex-context-figure").textContent,
          differs: el.querySelector(".codex-context-differs")?.textContent ?? null,
          window: el.querySelector('[aria-label="Context window tokens"]').value,
          sideBySide: fields.length === 2 && Math.abs(fields[0].top - fields[1].top) < 1,
          status: el.querySelector('[role="status"]').textContent,
          actions: [...el.querySelectorAll(".codex-context-actions button")].map((b) => [b.textContent, b.disabled]),
          foldedHelp: !el.querySelector(".codex-context-more").open,
          fits: dialog.scrollWidth <= dialog.clientWidth + 1,
          height: Math.round(el.getBoundingClientRect().height),
        };
      });
      assert.equal(look.figure, "828,400 tokens");
      assert.match(look.differs, /saved request \(872,000 tokens\)/);
      assert.equal(look.window, "872000");
      assert.ok(look.sideBySide, "the two fields share a row");
      assert.match(look.status, /only known from its native usage report/);
      assert.deepEqual(look.actions, [["Reset to automatic", false], ["Apply now", false]]);
      assert.ok(look.foldedHelp && look.fits, JSON.stringify(look));
      await block.scrollIntoViewIfNeeded();
      await shot(block, `context-settings-${theme}.png`);
      // The fine print is one click away.
      await block.locator(".codex-context-more > summary").click();
      await shot(block, `context-settings-help-${theme}.png`);
      await page.keyboard.press("Escape");
      return { look };
    });

    if (theme === "dark") {
      await step("dark at 390 px: the machine card's cells stack and the tiles fill the width", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(150);
        await page.locator("[aria-label='Jobs']").first().click();
        const card = page.locator(".jobs-budget");
        await card.locator(".jobs-meter-used").first().waitFor();
        const lefts = await card.locator(".jobs-budget-meters > .jobs-meter").evaluateAll((els) =>
          els.map((el) => Math.round(el.getBoundingClientRect().left)));
        assert.equal(new Set(lefts).size, 1, `one column: ${lefts}`);
        assert.ok(await noSideways(".jobs-budget"));
        await shot(card, "jobs-machine-card-dark-390.png");
        await page.keyboard.press("Escape");
        await page.locator(".catchup-nav").first().click();
        await page.locator(".home-machine:not([aria-busy])").waitFor();
        await shot(page.locator(".home-machines"), "machines-widget-dark-390.png");
      });
    }
    await page.context().close();
  }
} finally {
  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  const writes = report.mutations.filter((m) => !/\/review$/.test(m.path));
  if (writes.length) report.failures.push({ name: "writes", error: JSON.stringify(writes) });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: [...new Set(report.unexpected)].join("\n") });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
