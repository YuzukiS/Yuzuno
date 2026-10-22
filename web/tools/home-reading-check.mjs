// T-173: how Home cards read in Chromium, on a production build with every
// API answered here (no Core, no GitHub). Bodies are shaped like the Home
// audit's examples, with synthetic text: a summary-first overview with short
// references, a card that opens with evidence and a chart, a closed author's
// status with a dozen screenshots, and sub-topics without their topic's
// section. A wide window and a phone, open and folded; screenshots for review.
//   YUZUNO_UI_DIST=<isolated build> node tools/home-reading-check.mjs
// YUZUNO_READING_BEFORE=1 only takes the screenshots, for a build without
// T-173 to compare against.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const before = process.env.YUZUNO_READING_BEFORE === "1";
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/home-reading");
await mkdir(output, { recursive: true });
const report = { before, checks: [], errors: [], writes: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

/** A solid PNG with a darker band, so each screenshot fixture is told apart. */
function png(width, height, [r, g, b]) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    const shade = y > height * 0.4 && y < height * 0.6 ? 0.6 : 1;
    for (let x = 0; x < width; x++) row.set([r * shade, g * shade, b * shade].map(Math.round), 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const palette = [[122, 156, 110], [94, 129, 172], [196, 148, 92], [168, 108, 132]];
const images = new Map(Array.from({ length: 12 }, (_, index) => [`screen-${index + 1}.png`, png(640, 400, palette[index % palette.length])]));

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
const active = { agentId: "a", name: "Mori", state: "active" };
const closed = { agentId: "k", name: "Kumo", state: "closed" };
const section = (key, kind, title, body, extra = {}) => ({ key, kind, title, version: 1, owner: active, updatedAt: ago(5), updatedTurnId: "t1",
  body, attachments: [], refs: {}, seen: null, history: false, ...extra });
const observedAt = ago(2);
const sections = [
  section("development", "report", "Development", spec(["lead", "plan", "refs"], {
    lead: node("Group", { title: "Where we are", tone: "accent" }, ["now"]),
    now: md("Release **core.15** is installed. Two fixes are accepted and wait for main; nothing is blocked.\n\nThe order and the evidence are on the tasks below."),
    plan: node("Plan", { steps: [
      { id: "offline", text: "Offline banner", state: "done" },
      { id: "phone", text: "Phone checks: waits for main", state: "todo" },
      { id: "docs", text: "Docs evidence: waits for main", state: "todo" },
    ] }),
    refs: node("LiveRefs", { items: [
      { kind: "task", id: "T-9", label: "UI refine 9" },
      { kind: "task", id: "T-12", label: "Phone checks" },
    ] }),
  }), { refs: {
    "task:T-9": { kind: "task", id: "T-9", found: true, title: "UI refine 9: Home cards, Jobs list density, keyboard order and narrow layouts", state: "done", tone: "ok", observedAt },
    "task:T-12": { kind: "task", id: "T-12", found: true, title: "Cross-device follow-up and light control: Tailnet Web now, a mobile client later", state: "review", tone: "active", observedAt },
  } }),
  section("reconnect", "report", "Reconnect memory", spec(["runs", "cost", "limits"], {
    runs: node("Group", { title: "Runs" }, ["log"]),
    log: md("Runs 101, 102 and 103 on the lab host, after the allocation change."),
    cost: node("BarChart", { title: "Allocated per reconnect", x: { label: "Operation" }, y: { label: "Allocated", unit: "MiB" }, series: [
      { name: "Before", points: [["list", 1286], ["read", 5143], ["resume", 2210]] },
      { name: "After", points: [["list", 1013], ["read", 3945], ["resume", 1742]] },
    ] }),
    limits: md("Cumulative allocation, not resident memory; one run per operation."),
  })),
  section("home-layout", "status", "Home layout", spec(["state", "screens"], {
    state: md("Daily runs core.12; the narrow layout is checked on Chromium only."),
    screens: node("Attachments", { items: [...images.keys()].map((name, index) => ({ name, caption: `${index % 2 ? "After" : "Before"}: view ${Math.floor(index / 2) + 1}` })) }),
  }), { owner: closed, status: { asOf: ago(4 * 24 * 60), validFor: 7 * 24 * 3600, stale: false },
    attachments: [...images.keys()].map((name) => ({ name, kind: "image", mime: "image/png", size: images.get(name).length, snapshot: true, mayChange: false, takenAt: ago(4 * 24 * 60) })) }),
  section("memory-read-progress/reconnect", "report", "Read progress", spec(["text"], { text: md("Reads resume where they stopped.") })),
  section("ops/disk", "report", "Disk", spec(["text", "bytes"], {
    text: md("Lab disk at 41%."),
    bytes: node("BarChart", { title: "Bytes written", x: { label: "Day" }, y: { label: "Bytes" }, series: [
      { name: "Written", points: [["Mon", 81234567890], ["Tue", 92345678901]] },
    ] }),
  })),
  section("ops/backup", "report", "Backup", spec(["text"], { text: md("Nightly copy kept for 7 days.") })),
];
const home = {
  generatedAt: ago(0),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [],
    brief: { version: 9, history: [], sections },
  }],
};
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };
const keys = ["development", "reconnect", "home-layout"];

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const viewport of [{ name: "wide", width: 1280, height: 900, touch: false }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
      assert.equal(url.hostname, "yuzuno-home-reading.test");
      if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
      if (method !== "GET") {
        report.writes.push({ viewport: viewport.name, method, path });
        return route.fulfill({ json: {} });
      }
      const image = path.match(/^\/api\/projects\/p1\/brief\/attachments\/home-layout\/(screen-\d+\.png)$/);
      if (image && images.has(image[1])) return route.fulfill({ body: images.get(image[1]), contentType: "image/png" });
      const json = {
        "/api/workspace": { workspace: { id: "ws-reading" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }, "/api/agents/a/reading": { handoff: null },
        "/api/home": home, "/api/machine-load": machineLoad,
        "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
        "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
    await page.goto("http://yuzuno-home-reading.test/");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    const card = (key) => page.locator(`[data-section-key="${key}"]`);
    await card("home-layout").waitFor();
    await card("reconnect").locator(".recharts-bar-rectangle").first().waitFor();
    await page.screenshot({ path: resolve(output, `${viewport.name}-open.png`), fullPage: true });
    for (const key of keys) await card(key).locator(".home-fold").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(output, `${viewport.name}-folded.png`), fullPage: true });
    // The closed author's card on its own, folded, for a close look.
    await card("home-layout").screenshot({ path: resolve(output, `${viewport.name}-closed-author-folded.png`) });
    for (const key of keys) await card(key).locator(".home-fold").click();
    await page.waitForTimeout(200);
    await card("development").screenshot({ path: resolve(output, `${viewport.name}-refs.png`) });
    await card("reconnect").screenshot({ path: resolve(output, `${viewport.name}-chart.png`) });
    if (before) {
      check(`${viewport.name}: screenshots only (a build without T-173)`);
      await context.close();
      continue;
    }

    // Folded, a card says what it is about, when its data is from and who keeps it.
    const development = card("development"), reconnect = card("reconnect"), layout = card("home-layout");
    await development.locator(".home-fold").focus();
    await page.keyboard.press("Enter");
    assert.equal(await development.locator(".home-fold").getAttribute("aria-expanded"), "false");
    assert.ok(await development.locator(".home-fold").evaluate((el) => el === document.activeElement), "the fold keeps focus");
    assert.equal(await development.locator(".home-card-summary").innerText(), "Release core.15 is installed. Two fixes are accepted and wait for main; nothing is blocked.");
    const clamp = await development.locator(".home-card-summary .brief-markdown").evaluate((el) => getComputedStyle(el).webkitLineClamp);
    assert.equal(clamp, "3");
    await reconnect.locator(".home-fold").click();
    assert.equal(await reconnect.locator(".home-card-glance").count(), 0, "evidence first: no summary rather than the evidence");
    await layout.locator(".home-fold").click();
    assert.ok(await layout.locator(".home-section-head .home-unmaintained").isVisible());
    assert.match(await layout.locator(".home-card-glance").innerText(), /Daily runs core\.12.*\n?.*Data as of/s);
    check(`${viewport.name}: folded cards show their summary, data time and maintenance; evidence is not taken for a summary; the fold keeps focus`);
    for (const root of [development, reconnect, layout]) await root.locator(".home-fold").click();
    assert.match(await layout.locator(".home-unmaintained-note").innerText(), /Kumo has closed.*can claim it.*nothing is removed by itself/s);

    // Short labels lead; the current title is in the tooltip and the accessible name.
    const chip = development.locator('.brief-ref[data-kind="task"]').first();
    assert.equal(await chip.locator("span").first().innerText(), "UI refine 9");
    assert.match(await chip.getAttribute("title"), /^(Open )?Task T-9: UI refine 9: Home cards/);
    assert.match(await chip.evaluate((el) => el.textContent), /^UI refine 9: UI refine 9: Home cards/);
    const chipBox = await chip.boundingBox();
    assert.ok(chipBox.height < 40, `a chip stays one line (${chipBox.height})`);
    check(`${viewport.name}: a short label leads and the current title stays reachable`);

    // A few bars carry their values.
    const values = await reconnect.locator(".recharts-label-list text").allTextContents();
    assert.deepEqual(values.map((v) => v.replace(/[,\s]/g, "")).sort(), ["1013", "1286", "1742", "2210", "3945", "5143"]);
    assert.ok(await reconnect.getByText("Cumulative allocation, not resident memory").isVisible(), "the limit stays beside the chart");
    const disk = card("ops/disk");
    await disk.locator(".recharts-bar-rectangle").first().waitFor();
    assert.equal(await disk.locator(".recharts-label-list").count(), 0, "values too long to fit stay in the tooltip and table");
    check(`${viewport.name}: a six-bar chart labels its values in full; values too long to fit are not labelled`);

    // Sub-topics: one stands alone, several get a heading in words.
    assert.equal(await page.locator('[data-topic="memory-read-progress"] .home-topic-name').count(), 0);
    assert.equal(await page.getByText("memory-read-progress", { exact: true }).count(), 0, "no bare key");
    assert.equal(await page.locator('[data-topic="ops"] .home-topic-name').innerText(), "Ops");
    check(`${viewport.name}: no bare topic key on Home`);

    // A dozen screenshots: the first four, the rest by keyboard.
    const shots = layout.locator(".brief-attachments > li");
    assert.equal(await shots.count(), 4);
    const more = layout.locator(".brief-attachments-more");
    await more.focus();
    await page.keyboard.press("Enter");
    assert.equal(await shots.count(), 12);
    assert.ok(await more.evaluate((el) => el === document.activeElement), "the toggle keeps focus");
    await page.screenshot({ path: resolve(output, `${viewport.name}-attachments-all.png`), fullPage: true });
    await page.keyboard.press("Enter");
    assert.equal(await shots.count(), 4);
    check(`${viewport.name}: twelve screenshots show four, then all by keyboard`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${viewport.name}: no sideways scroll (${overflow})`);
    assert.deepEqual(report.writes.filter((w) => w.viewport === viewport.name), [], "reading wrote nothing");
    check(`${viewport.name}: no sideways scroll, nothing written`);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
assert.deepEqual(report.unexpected, []);
