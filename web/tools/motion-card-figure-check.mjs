// T-19 HM:B14, a summary card's kept image (its figure, SummaryCard's FigureFrame), in Chromium on a
// production build of the app with a synthetic Workspace and every API answered here (no Core, no
// Agent). It arrives as the same picture does on its report page (kept-image.ts): the same snapshot and
// read, so it stays unseen until its decode succeeds, fades in over small the first time this window
// shows it (under reduced motion it is there at once), and a failed decode says so in the frame. Images
// answer 700 ms after they are asked for; decodes are refused or held in the page.
// - "shot": its picture is hidden until decoded, then comes in once; its frame keeps one size.
// - "bad": the picture loads but its decode is refused: the frame says it could not be loaded, keeps its
//   size, and the picture is never shown.
// - "held": its decode is held 1.5 s: hidden all that while, then in once.
// - "shot" moved to version 2, its caption only changed (the same snapshot): while its newer address
//   loads, the same picture stays painted (screenshots of its middle compared), and nothing plays.
// - "shot"'s report page, opened from its card after the card showed it: the page's picture plays no
//   second arrival (one window, one snapshot shown).
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: none; Home's list read
// of linked repositories is a POST and counted apart; anything else is refused and counted. Chromium is
// not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-card-figure-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-card-figure");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], listReads: 0, images: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 600)}`}`);
};

/** A solid PNG with a darker band. */
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
const images = {
  "shot.png": png(480, 300, [122, 156, 110]),
  "bad.png": png(480, 300, [150, 110, 140]),
  "held.png": png(480, 300, [94, 129, 172]),
};
const DELAY = 700;

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const kept = (name) => ({ name, kind: "image", mime: "image/png", size: images[name].length, snapshot: true, mayChange: false,
  takenAt: iso(-30 * MIN), width: 480, height: 300 });
/** "shot"'s version: 2 changes only its caption (the same file, the same snapshot). */
let version = 1;
/** A report whose summary is a lead and its one image, the card's figure. */
const card = (key, id, title, name, caption, at) => ({
  id, key, kind: "report", title, version: key === "shot" ? version : 1, owner, updatedAt: iso(at * MIN), updatedTurnId: null, refs: {},
  seen: null, history: false, attachments: [kept(name)],
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "shot", size: "large" } }, children: ["lead", "shot"] },
    lead: { type: "Markdown", props: { text: `${title}: the picture.` } },
    shot: { type: "Attachments", props: { items: [{ name, caption }] } },
  } },
});
const home = () => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: 10 + version, sections: [
      card("shot", 51, "A shot", "shot.png", version === 1 ? "The shot" : "The shot, as captioned again", -3),
      card("bad", 52, "A picture that cannot be decoded", "bad.png", "The bad picture", -4),
      card("held", 53, "A picture slow to decode", "held.png", "The held picture", -5),
    ], history: [] },
    unseen: 3, missing: [],
  }],
});
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci/runs": noCiRuns, "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/home": home(),
  "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const ATTACHMENT = /^\/api\/projects\/p1\/brief\/attachments\/(shot|bad|held)\/([^/]+)$/;
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/__check/caption") {
    version = 2;
    return route.fulfill({ json: {} });
  }
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "POST" && url.pathname === "/api/collaboration/github_repositories") {
      report.listReads++;
      return route.fulfill({ json: { repositories: [], links: [] } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const file = ATTACHMENT.exec(url.pathname);
    if (file) {
      const name = decodeURIComponent(file[2]);
      report.images.push(`${file[1]}/${name}@${url.searchParams.get("version")}`);
      await new Promise((done) => setTimeout(done, DELAY));
      const bytes = images[name];
      if (!bytes) return route.fulfill({ status: 404, json: { error: "snapshot_not_found" } });
      return route.fulfill({ body: bytes, contentType: "image/png" }).catch(() => {});
    }
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/agents\/[^/]+\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page, from the first script on: the event stream, spoken for Core by this check; decodes
 * refused (bad.png) or held 1.5 s (held.png); and each frame, each card's frame and the report page's
 * picture. */
function pageHelpers() {
  let id = 0;
  const streams = [];
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      streams.push(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  // "shot" moves to version 2, then Core says the Brief changed.
  window.__caption = async () => {
    await fetch("/__check/caption");
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: String(++id) });
  };
  window.__decodes = [];
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    const done = decode.call(this);
    const name = this.src.split("/").pop().split("?")[0];
    window.__decodes.push(name);
    const refused = () => Promise.reject(new DOMException("The source image cannot be decoded.", "EncodingError"));
    if (name === "bad.png") return done.then(refused, refused);
    if (name === "held.png") return done.then((v) => new Promise((resolve) => setTimeout(() => resolve(v), 1500)), (e) => Promise.reject(e));
    return done;
  };
  const entries = (el) => el.getAnimations().filter((a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation));
  let mark = 0;
  const picture = (img) => {
    if (!img) return null;
    img.__mark ??= ++mark;
    const plays = entries(img);
    const keys = new Set();
    for (const a of plays) for (const k of a.effect?.getKeyframes?.() ?? [])
      for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) keys.add(p);
    return { element: img.__mark, src: img.getAttribute("src"), complete: img.complete && img.naturalWidth > 0, natural: img.naturalWidth,
      loading: img.hasAttribute("data-loading"), opacity: Number(getComputedStyle(img).opacity), entries: plays.length,
      keys: [...keys].sort().join("+"), duration: plays[0]?.effect?.getComputedTiming().duration ?? null };
  };
  const frames = [];
  window.__frames = frames;
  const step = () => {
    const shown = {};
    for (const key of ["shot", "bad", "held"]) {
      const body = document.querySelector(`.home-main [data-section-key="${key}"] .home-card-frame-body`);
      if (!body) continue;
      const at = body.getBoundingClientRect();
      shown[key] = { frame: [Math.round(at.width * 10) / 10, Math.round(at.height * 10) / 10],
        failed: !!body.querySelector('.home-card-figure-unavailable[role="status"]'), picture: picture(body.querySelector("img")) };
    }
    const page = document.querySelector(".report-article .brief-image img");
    if (page) shown.page = { picture: picture(page) };
    frames.push(shown);
    if (frames.length < 30_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const spread = (values) => (values.length ? Math.max(...values) - Math.min(...values) : 0);
const of = (frames, key) => frames.map((f) => f[key]).filter(Boolean);
/** Hidden until it is there whole; then in over small once (or, under reduced motion, at once). */
function cameIn(shown, reduced) {
  const pictures = shown.map((f) => f.picture).filter(Boolean);
  if (!pictures.length || !pictures.at(-1).complete) return false;
  if (pictures.some((p) => !p.complete && (p.opacity !== 0 || p.entries))) return false;
  const last = pictures.at(-1);
  if (last.opacity !== 1 || last.entries) return false;
  const plays = pictures.filter((p, i) => p.entries && !pictures[i - 1]?.entries);
  if (reduced) return plays.length === 0;
  return plays.length === 1 && plays[0].keys === "opacity" && Math.abs((plays[0].duration ?? 0) - 180) < 0.5 && plays[0].opacity < 1;
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  version = 1;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const frameAt = () => page.evaluate(() => window.__frames.length);
  const into = (key) => page.evaluate((key) => document.querySelector(`.home-main [data-section-key="${key}"]`)
    ?.scrollIntoView({ block: "center", behavior: "instant" }), key);
  const settled = (key) => page.waitForFunction((key) => {
    const body = document.querySelector(`.home-main [data-section-key="${key}"] .home-card-frame-body`);
    const img = body?.querySelector("img");
    return !!body?.querySelector('.home-card-figure-unavailable[role="status"]')
      || (!!img && img.complete && img.naturalWidth > 0 && !img.hasAttribute("data-loading") && Number(getComputedStyle(img).opacity) === 1
        && !img.getAnimations().length);
  }, key, { timeout: 10_000 });
  try {
    await page.goto("http://127.0.0.1:4325/");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator('.home-main [data-section-key="shot"] .home-card-frame-body').waitFor({ timeout: 10_000 });
    for (const key of ["shot", "bad", "held"]) {
      await into(key);
      await settled(key);
    }
    await page.waitForTimeout(300);
    const first = record("first view", await framesSince(0));
    const shot = of(first, "shot");
    ok(`${tag}: the card's picture is hidden until its decode succeeds, then comes in over small, once (under reduced motion, at once)`,
      shot.some((f) => f.picture && !f.picture.complete) && cameIn(shot, reduced), { first: shot.find((f) => f.picture)?.picture, last: shot.at(-1)?.picture });
    ok(`${tag}: the card's frame keeps one size while its picture loads and after`,
      shot.length > 0 && spread(shot.map((f) => f.frame[0])) <= 0.5 && spread(shot.map((f) => f.frame[1])) <= 0.5, { first: shot[0]?.frame, last: shot.at(-1)?.frame });
    const bad = of(first, "bad");
    ok(`${tag}: a picture whose decode is refused: the frame says it could not be loaded, keeps its size, and the picture is never shown`,
      bad.at(-1)?.failed === true && spread(bad.map((f) => f.frame[1])) <= 0.5 && bad.every((f) => !f.picture || (f.picture.opacity === 0 && !f.picture.entries)),
      { last: bad.at(-1), shown: bad.filter((f) => f.picture && (f.picture.opacity > 0 || f.picture.entries)).length });
    const held = of(first, "held");
    const hidden = held.filter((f) => f.picture?.complete && f.picture.opacity === 0).length;
    ok(`${tag}: a picture whose decode is held: hidden, though loaded, until the decode succeeds, then in once (under reduced motion, at once)`,
      hidden >= 20 && cameIn(held, reduced), { hidden, last: held.at(-1)?.picture });

    // "shot" moves to version 2, its caption only changed: the same snapshot. Its newer address is
    // read again (700 ms), and while it loads the element may report no picture (naturalWidth 0), so
    // what is painted is compared: the middle of the picture before, and again while the newer
    // address is still loading (the same bytes from the same encoder mean the same pixels).
    await into("shot");
    const shotImg = '.home-main [data-section-key="shot"] .home-card-frame-body img';
    const at = await page.locator(shotImg).boundingBox();
    const clip = at && { x: at.x + at.width / 4, y: at.y + at.height / 4, width: at.width / 2, height: at.height / 2 };
    const paintedBefore = clip && (await page.screenshot({ clip }));
    const before = await frameAt();
    await page.evaluate(() => window.__caption());
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("src")?.includes("version=2"), shotImg, { timeout: 10_000 });
    const loadingWhenShot = await page.evaluate((sel) => !document.querySelector(sel)?.complete, shotImg);
    const paintedDuring = clip && (await page.screenshot({ clip }));
    const stillLoading = await page.evaluate((sel) => !document.querySelector(sel)?.complete, shotImg);
    await settled("shot");
    await page.waitForTimeout(DELAY + 400);
    const again = of(record("caption changed", await framesSince(before)), "shot");
    const painted = !!paintedBefore && !!paintedDuring && paintedBefore.equals(paintedDuring);
    if (paintedDuring) await writeFile(join(output, `${tag}-caption-during.png`), paintedDuring);
    ok(`${tag}: a newer version that changes only the caption: the same picture stays painted while the newer address loads, and plays nothing`,
      again.length > 0 && again.every((f) => f.picture && !f.picture.loading && f.picture.opacity === 1 && !f.picture.entries)
        && spread(again.map((f) => f.picture.element)) === 0 && loadingWhenShot && stillLoading && painted,
      { elements: [...new Set(again.map((f) => f.picture?.element))], painted, loadingWhenShot, stillLoading,
        withoutPicture: again.filter((f) => !f.picture?.natural).length, unseen: again.filter((f) => !f.picture || f.picture.loading || f.picture.opacity !== 1).length });

    // Its report page, opened from the card that showed it: one window, one snapshot shown.
    const opened = await frameAt();
    await page.locator('.home-main [data-section-key="shot"] .home-report-open').first().click();
    await page.locator(".report-article .brief-image img").waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => {
      const img = document.querySelector(".report-article .brief-image img");
      return !!img && img.complete && img.naturalWidth > 0 && !img.hasAttribute("data-loading");
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    const onPage = of(record("its report page", await framesSince(opened)), "page");
    ok(`${tag}: its report page, opened from the card that showed the picture: the page's picture plays no second arrival`,
      onPage.length > 0 && onPage.every((f) => !f.picture?.entries) && onPage.at(-1)?.picture?.opacity === 1,
      { plays: onPage.filter((f) => f.picture?.entries).length, last: onPage.at(-1)?.picture });
    report.decodes = { ...report.decodes, [tag]: await page.evaluate(() => window.__decodes) };
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written; Home's list reads of linked repositories, counted apart: ${report.listReads}`, report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "motion-card-figure-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
