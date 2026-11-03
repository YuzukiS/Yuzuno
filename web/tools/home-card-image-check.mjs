// An image as a card's figure on Home (T-18, R2, Lead 3275), in a browser:
// the production bundle with an explicit API fixture (synthetic sections, no
// Core, daily window or real Agent). A kept image loads in its frame; a
// referenced one (not kept, here 30 MB) is named in its frame and never asked
// for; a kept one whose snapshot can't be loaded says so in its frame, its
// caption and Open report kept; the same card's next version, or another
// image in its place, loads afresh. Reads only: nothing is written.
// Screenshots and report.json go to YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-image.test";
const WS = "ws-image";
const report = { task: "T-18", checks: [], failures: [], errors: [], unexpected: [], writes: [], images: [], agentReads: [], shots: [],
  limits: ["Chromium only: not iOS Safari, not a real iPhone, not the native desktop window."] };
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
  } finally {
    await page?.context().close().catch(() => {});
    page = undefined;
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}
async function shot(name, selector) {
  await page.locator(selector).first().screenshot({ path: resolve(output, name) });
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const owner = { agentId: "a", name: "Mori", state: "active" };
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
// A small synthetic image: six bars.
const PNG = (() => {
  const [width, height] = [240, 140];
  const crc = (bytes) => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 0xf7);
    for (let x = 0; x < width; x++) {
      const bar = Math.floor(x / 40), level = [50, 80, 110, 70, 95, 40][bar];
      if (x % 40 > 8 && x % 40 < 32 && height - y < level) row.set([0xc9, 0xbf, 0xae], 1 + x * 3);
    }
    row[0] = 0;
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
})();
const image = (name, extra = {}) => ({ name, kind: "image", mime: "image/png", size: PNG.length, snapshot: true, mayChange: false, takenAt: iso(-60 * MIN), ...extra });
// One summary each: its lead and one image, its caption as the author wrote it.
const body = (lead, name, caption) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "shot", size: "large" } }, children: ["lead", "shot"] },
  lead: { type: "Markdown", props: { text: lead } },
  shot: { type: "Attachments", props: { items: [{ name, caption }] } },
} });
const section = (key, id, version, title, name, caption, file) => ({ id, key, kind: "report", title, version, owner, body: body(`${title}: the picture.`, name, caption),
  attachments: [file], refs: {}, seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN) });
// The swap card's versions: the image at 1 can't be read; 2 is the same name, readable; 3 another image, unreadable;
// 4 another again, readable.
let swap = 1;
const swaps = { 1: "a.png", 2: "a.png", 3: "b.png", 4: "c.png" };
const sections = () => [
  section("kept", 41, 1, "A kept image", "kept.png", "The kept picture", image("kept.png")),
  // Referenced, not kept (over 25 MB): there is no snapshot to ask Core for.
  section("referenced", 42, 1, "A referenced image", "huge.png", "The referenced picture",
    image("huge.png", { size: 30 * 1024 * 1024, snapshot: false, mayChange: true, path: "/data/runs/exp-12/huge.png" })),
  section("broken", 43, 1, "An image Core can't read", "broken.png", "The unreadable picture", image("broken.png")),
  section("swap", 44, swap, "A card whose image changes", swaps[swap], `Picture ${swap}`, image(swaps[swap], { takenAt: iso(-60 * MIN + swap * 1000) })),
];
// What Core serves: every kept snapshot but broken.png, a.png at version 1 and b.png.
const readable = (key, name, version) => !(name === "broken.png" || name === "b.png" || (key === "swap" && name === "a.png" && version === 1));
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: sections(), history: [] }, unseen: 4, missing: [] }] });
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 16384, usedMiB: 4000, availableMiB: 12384, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  const method = request.method();
  // The open Agent's reads, answered as Core answers an Agent with none, counted apart from writes.
  const own = path.match(/^\/api\/agents\/a\/(reading|conversation\/inputs|codex\/mcp)$/);
  if (own) {
    report.agentReads.push(`${method} ${path}`);
    if (own[1] === "reading" && (method === "GET" || method === "PUT"))
      return route.fulfill({ json: method === "PUT" ? { handoff: null, sourceSeq: 1, accepted: true } : { handoff: null, sourceSeq: 0 } });
    if (own[1] === "conversation/inputs" && method === "GET") return route.fulfill({ json: { inputs: [], hasBefore: false, total: 0 } });
    if (own[1] === "codex/mcp" && method === "GET") return route.fulfill({ json: { state: "observed", reason: "", generation: 1, servers: [], more: 0 } });
  }
  if (method !== "GET" && path.startsWith("/api/")) {
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  // Every snapshot asked for, by section, name and version: what the card asked Core for.
  const file = path.match(/^\/api\/projects\/p1\/brief\/attachments\/([\w-]+)\/([\w.-]+)$/);
  if (file) {
    const version = Number(url.searchParams.get("version"));
    report.images.push({ key: file[1], name: file[2], version });
    return readable(file[1], file[2], version)
      ? route.fulfill({ body: PNG, contentType: "image/png" })
      : route.fulfill({ status: 404, json: { error: "attachment_unavailable" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
    "/api/appearance-preset": () => ({ workspaceId: WS, revision: 0, kind: "none" }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const built = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(built.startsWith(dist + "/"));
  try {
    return await route.fulfill({ body: await readFile(built), contentType: types[extname(built)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce" });
  page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        // The last one opened, so a step can say what Core says when a Brief changes.
        window.__events = this;
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${width}: pageerror: ${error.message}`));
  // Core's 404s for the snapshots it can't read, on purpose, are the browser's console errors too; no other.
  const unreadable = /\/brief\/attachments\/(broken\/broken\.png|swap\/a\.png\?version=1|swap\/b\.png)/;
  page.on("console", (message) => message.type() === "error" && !unreadable.test(message.location()?.url ?? "")
    && report.errors.push(`${width}: console: ${message.text()} ${message.location()?.url ?? ""}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  const nav = page.locator(".toolbar-nav .catchup-nav").first();
  await nav.waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await nav.click();
  await page.locator('.home-view [data-section-key="swap"]').waitFor({ timeout: 10_000 });
}
const card = (key) => page.locator(`.home-view [data-section-key="${key}"]`);
/** A card's figure as shown: its frame's size, an image and whether it loaded, what the frame says instead, its caption. */
const figure = (key) => card(key).evaluate((el) => {
  const frame = el.querySelector(".home-card-frame-body");
  const img = frame?.querySelector("img");
  const r = frame?.getBoundingClientRect();
  return {
    frame: r ? { width: Math.round(r.width), height: Math.round(r.height) } : null,
    img: img ? { src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0 } : null,
    says: frame?.querySelector(".home-card-figure-unavailable")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    caption: el.querySelector(".home-card-frame figcaption")?.innerText.trim() ?? null,
    open: !!el.querySelector(".home-report-open"),
  };
});
/** Core says the Brief changed: Home reads it again. */
const briefChanged = () => page.evaluate(() => window.__events?.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: "" }));

try {
  for (const [width, height] of [[1440, 1000], [390, 844]])
    await step(`${width}: a kept image shows; a referenced one is named, never asked for; one Core can't read says so, its caption and Open report kept`, async () => {
      swap = 1;
      report.images.length = 0;
      await open(width, height);
      await until("the kept image", async () => (await figure("kept")).img?.loaded);
      const kept = await figure("kept");
      assert.equal(kept.says, null);
      assert.equal(kept.caption, "The kept picture");
      const referenced = await figure("referenced");
      assert.equal(referenced.img, null, `no image asked for: ${JSON.stringify(referenced)}`);
      assert.equal(referenced.says, "Referenced · huge.png Not kept by Yuzuno, so there is nothing to preview.");
      assert.equal(referenced.caption, "The referenced picture");
      assert.ok(referenced.open, "Open report stays");
      await until("the unreadable image said", async () => (await figure("broken")).says);
      const broken = await figure("broken");
      assert.deepEqual([broken.img, broken.says, broken.caption, broken.open], [null, "This image couldn't be loaded from this Core.", "The unreadable picture", true]);
      // The frames keep their size, shown or said.
      for (const other of [referenced, broken]) assert.deepEqual(other.frame, kept.frame, `the frame keeps its size: ${JSON.stringify({ kept: kept.frame, other: other.frame })}`);
      await sleep(300);
      assert.deepEqual(report.images.filter((asked) => asked.key === "referenced"), [], "Core was never asked for the referenced image");
      await shot(`cards-${width}.png`, ".home-view .home-brief");
      return { kept, referenced, broken, asked: [...report.images] };
    });

  await step("1440: the same card's next version, and another image in its place, load afresh; one that can't be read says so again", async () => {
    swap = 1;
    report.images.length = 0;
    await open(1440, 1000);
    const element = await card("swap").elementHandle();
    const sees = [];
    // Version 1: its image can't be read.
    await until("version 1 said", async () => (await figure("swap")).says);
    sees.push(await figure("swap"));
    // Each next version: the card is read again and draws its own image.
    for (const next of [2, 3, 4]) {
      swap = next;
      await briefChanged();
      await until(`version ${next}`, async () => (await card("swap").getAttribute("data-section-version")) === String(next));
      if (readable("swap", swaps[next], next)) await until(`version ${next}'s image`, async () => (await figure("swap")).img?.loaded);
      else await until(`version ${next} said`, async () => (await figure("swap")).says);
      sees.push(await figure("swap"));
    }
    assert.equal(await card("swap").evaluate((el, before) => el === before, element), true, "the same card throughout");
    assert.deepEqual(sees.map((s) => [s.img?.loaded ?? null, s.says, s.caption]), [
      [null, "This image couldn't be loaded from this Core.", "Picture 1"],
      [true, null, "Picture 2"],
      [null, "This image couldn't be loaded from this Core.", "Picture 3"],
      [true, null, "Picture 4"],
    ]);
    assert.deepEqual(report.images.filter((asked) => asked.key === "swap").map((asked) => [asked.name, asked.version]).filter((x, i, all) => all.findIndex((y) => y[0] === x[0] && y[1] === x[1]) === i),
      [["a.png", 1], ["a.png", 2], ["b.png", 3], ["c.png", 4]], "each version's own image asked for");
    await shot("swap-1440.png", '.home-view [data-section-key="swap"]');
    return { sees };
  });

  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: [...new Set(report.unexpected)].join("\n") });
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
