// T-19, a kept image on a Home card (M9 + F3: HM:B14), in Chromium on a production build of the app
// with a synthetic Workspace and every API answered here (no Core, no Agent). Images are synthetic and
// each answers 700 ms after it is asked for, so its loading is seen.
// - An image with the size Core read: its box has the picture's shape from its first frame and keeps
//   it while it loads, once shown and after; what follows it does not move.
// - Its picture is hidden until decoded, then fades in over small; under reduced motion it is there
//   at once.
// - An image Core has no size for (an older card): a fixed box, the picture fitted into it whole.
// - An image that cannot be loaded says so in its own box, which keeps its size.
// - A JPEG its EXIF turns: Chromium draws it turned, the shape Core gave (as wide as it is stored
//   high), and the box holds it exactly.
// - A file only referenced draws no picture box, whatever size its entry carries.
// - Shown again in this window (Show fewer, then Show all): no picture comes in a second time.
// - The card moves on (a new snapshot, another size) while its first picture is still decoding: the
//   new box has its own shape at once, and nothing plays on the new picture before it is decoded,
//   whatever the first one's late decode says (decode slowed by 1.5 s in the page for this).
// Writes: none; Home's list read of linked repositories is a POST and counted apart; anything else is
// refused and counted. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-image-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-image");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], listReads: 0, images: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

/** A solid PNG with a darker band, so each fixture image is told apart. */
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
/** EXIF orientation 6 (a quarter clockwise), big-endian TIFF with one entry, as a camera writes it. */
const QUARTER_EXIF = Buffer.from("4d4d002a000000080001011200030000000100060000" + "00000000", "hex");
/** `jpeg` with QUARTER_EXIF in an APP1 segment after its JFIF one. */
function turned(jpeg) {
  const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  const length = Buffer.alloc(2);
  length.writeUInt16BE(2 + 6 + QUARTER_EXIF.length);
  return Buffer.concat([jpeg.subarray(0, at), Buffer.from([0xff, 0xe1]), length, Buffer.from("Exif\0\0", "latin1"), QUARTER_EXIF, jpeg.subarray(at)]);
}

const browser = await launchBrowser();
report.browser = browser.version();
// A JPEG stored 400 x 200, drawn by Chromium's own encoder, then turned by its EXIF.
const jpeg = await (async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const draw = canvas.getContext("2d");
    draw.fillStyle = "#6c8fb0";
    draw.fillRect(0, 0, 400, 200);
    draw.fillStyle = "#2f4a63";
    draw.fillRect(0, 0, 120, 200);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  await context.close();
  return turned(Buffer.from(data, "base64"));
})();
const images = {
  "known.png": png(640, 400, [122, 156, 110]),
  "unknown.png": png(480, 320, [196, 148, 92]),
  "turned.jpg": jpeg,
  "known-4.png": png(300, 300, [94, 129, 172]),
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
const kept = (name, mime, size, extra) => ({ name, kind: "image", mime, size, snapshot: true, mayChange: false, takenAt: iso(-30 * MIN), ...extra });
/** The card as Core sends it: version 3, then (the card moved on) version 4 with a new snapshot of
 * known.png at another size. */
let version = 3;
const section = () => ({
  id: 11, key: "shots", kind: "report", title: "Screens", version, owner, updatedAt: iso(-30 * MIN), updatedTurnId: null, refs: {},
  seen: null, history: false,
  attachments: [
    version === 3
      ? kept("known.png", "image/png", images["known.png"].length, { width: 640, height: 400 })
      : kept("known.png", "image/png", images["known-4.png"].length, { width: 300, height: 300, takenAt: iso(-1 * MIN) }),
    kept("unknown.png", "image/png", images["unknown.png"].length, {}),
    kept("gone.png", "image/png", 4000, { width: 640, height: 400 }),
    kept("turned.jpg", "image/jpeg", images["turned.jpg"].length, { width: 200, height: 400 }),
    { name: "ref.png", kind: "image", mime: "image/png", size: 4000, snapshot: false, mayChange: true, takenAt: iso(-30 * MIN),
      path: "/fixture/shots/ref.png", width: 640, height: 400 },
  ],
  body: { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["text", "files"] },
    text: { type: "Markdown", props: { text: "The new screens, as built." } },
    files: { type: "Attachments", props: { items: ["known.png", "unknown.png", "gone.png", "turned.jpg", "ref.png"].map((name) => ({ name, caption: `Caption of ${name}` })) } },
  } },
});
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: version + 6, sections: [section()], history: [] },
    unseen: 1, missing: [],
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
const ATTACHMENT = /^\/api\/projects\/p1\/brief\/attachments\/shots\/([^/]+)$/;
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/__check/brief") {
    version = 4;
    return route.fulfill({ json: {} });
  }
  if (url.pathname.startsWith("/api/")) {
    // The Project's linked repositories, a list read Home asks with POST (home-api.ts).
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
      const name = decodeURIComponent(file[1]);
      const asked = url.searchParams.get("version");
      // The card's newer version answers late: its first picture's decode settles while it loads.
      const late = name === "known.png" && asked === "4";
      report.images.push(`${name}@${asked}`);
      await new Promise((done) => setTimeout(done, late ? 2500 : DELAY));
      const bytes = late ? images["known-4.png"] : images[name];
      if (!bytes) return route.fulfill({ status: 404, json: { error: "snapshot_not_found" } });
      return route.fulfill({ body: bytes, contentType: name.endsWith(".jpg") ? "image/jpeg" : "image/png" }).catch(() => {});
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

/** In the page, from the first script on: the event stream, spoken for Core by this check; a decode
 * slowed by 1.5 s for the card's first version when the check asks for it; and each frame, each
 * picture attachment: its box (or, where there is none, what stands in its place), the picture in it,
 * and where its caption is. */
function pageHelpers() {
  let id = 0;
  const streams = [];
  window.EventSource = class {
    constructor(url) {
      this.url = url;
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
  // The card moved on: Core has version 4, then says the Brief changed.
  window.__moveOn = async () => {
    await fetch("/__check/brief");
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: String(++id) });
  };
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    const done = decode.call(this);
    if (sessionStorage.getItem("slow-decode") !== "1" || !this.src.includes("version=3")) return done;
    const later = (settle) => (value) => new Promise((resolve, reject) => setTimeout(() => (settle ? resolve(value) : reject(value)), 1500));
    return done.then(later(true), later(false));
  };
  const entries = (el) => el.getAnimations().filter((a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation));
  const picture = (img) => {
    if (!img) return null;
    const plays = entries(img);
    const keys = new Set();
    for (const a of plays) for (const k of a.effect?.getKeyframes?.() ?? [])
      for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) keys.add(p);
    return { src: img.getAttribute("src"), complete: img.complete && img.naturalWidth > 0, natural: [img.naturalWidth, img.naturalHeight],
      opacity: Number(getComputedStyle(img).opacity), entries: plays.length, keys: [...keys].sort().join("+"),
      duration: plays[0]?.effect?.getComputedTiming().duration ?? null, fit: getComputedStyle(img).objectFit };
  };
  const frames = [];
  window.__frames = frames;
  window.__now = () => frames.length;
  const step = () => {
    const shown = {};
    for (const item of document.querySelectorAll('.home-section[data-section-key="shots"] .brief-attachments > li')) {
      const name = item.querySelector(".brief-image-info dd")?.textContent ?? item.querySelector("strong")?.textContent;
      if (!name) continue;
      const box = item.querySelector(".brief-image") ?? item.querySelector(".brief-image-failed");
      const caption = item.querySelector(".brief-attachment-caption");
      const at = box?.getBoundingClientRect();
      shown[name] = {
        box: box ? { tag: box.tagName.toLowerCase(), content: [box.clientWidth, box.clientHeight], outer: [Math.round(at.width * 10) / 10, Math.round(at.height * 10) / 10],
          failed: !!item.querySelector('.brief-image-failed[role="status"]'), captionGap: caption ? Math.round((caption.getBoundingClientRect().top - at.top) * 10) / 10 : null } : null,
        picture: picture(box?.querySelector?.("img")),
        note: !!item.querySelector(".brief-attachment-note"),
      };
    }
    frames.push(shown);
    if (frames.length < 30_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const spread = (values) => (values.length ? Math.max(...values) - Math.min(...values) : 0);
/** One attachment's frames from the first it is there in. */
const of = (frames, name) => frames.map((f) => f[name]).filter((f) => f?.box);
/** The box keeps one size from its first frame, through loading and after. */
const steady = (shown, which) => shown.length > 0 && spread(shown.map((f) => f.box[which][0])) <= 0.5 && spread(shown.map((f) => f.box[which][1])) <= 0.5;
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

const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  version = 3;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const card = page.locator('.home-section[data-section-key="shots"]');
  const more = card.locator("button.brief-attachments-more");
  const openHome = async () => {
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await card.waitFor({ timeout: 10_000 });
  };
  /** Shows every attachment, if the card folds some away. */
  const showAll = async () => {
    if ((await more.count()) && (await more.getAttribute("aria-expanded")) === "false") await more.click();
  };
  const complete = (name, also = "") => page.waitForFunction(([name, also]) => {
    const img = [...document.querySelectorAll('.home-section[data-section-key="shots"] .brief-attachments > li')]
      .find((li) => li.querySelector(".brief-image-info dd")?.textContent === name)?.querySelector("img");
    return !!img && img.complete && img.naturalWidth > 0 && img.getAttribute("src").includes(also);
  }, [name, also], { timeout: 10_000 });
  try {
    await page.goto("http://127.0.0.1:4323/");
    await openHome();
    await showAll();
    await complete("known.png");
    await complete("unknown.png");
    await complete("turned.jpg");
    await card.locator(".brief-image-failed").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const first = record("first view", await framesSince(0));

    const known = of(first, "known.png");
    const shape = (f) => f.box.content[0] / f.box.content[1];
    ok(`${tag}: a kept image with the size Core read: its box has the picture's shape (640 x 400) from its first frame, while it loads and after, and what follows it does not move`,
      known.some((f) => !f.picture?.complete) && known.every((f) => Math.abs(shape(f) - 640 / 400) <= 0.01) && steady(known, "content")
        && spread(known.map((f) => f.box.captionGap)) <= 0.5 && known.at(-1).box.content[0] <= 640.5,
      { first: known[0]?.box, last: known.at(-1)?.box, frames: known.length });
    ok(`${tag}: its picture is hidden until it is decoded, then comes in over small, a fade, once; under reduced motion it is there at once`,
      cameIn(known, reduced), { first: known[0]?.picture, last: known.at(-1)?.picture,
        plays: known.map((f) => f.picture).filter((p, i, all) => p?.entries && !all[i - 1]?.entries) });
    const unknown = of(first, "unknown.png");
    ok(`${tag}: an image Core has no size for (an older card): a fixed box, the picture fitted into it whole; the box keeps its size as it loads`,
      unknown.some((f) => !f.picture?.complete) && steady(unknown, "outer") && unknown.at(-1).picture?.fit === "contain",
      { first: unknown[0]?.box, last: unknown.at(-1)?.box, fit: unknown.at(-1)?.picture?.fit });
    const gone = of(first, "gone.png");
    ok(`${tag}: an image that cannot be loaded says so in its own box, which keeps the size it had while loading`,
      gone.some((f) => !f.box.failed) && gone.at(-1)?.box.failed && steady(gone, "outer"),
      { loading: gone.find((f) => !f.box.failed)?.box, failed: gone.at(-1)?.box });
    const jpg = of(first, "turned.jpg").at(-1);
    const drawn = jpg?.picture?.natural ?? [0, 0];
    ok(`${tag}: a JPEG its EXIF turns: Chromium draws it turned (200 x 400, stored 400 x 200), the shape Core gave, and its box holds it exactly`,
      !!jpg && drawn[0] === 200 && drawn[1] === 400 && Math.abs(jpg.box.content[0] / jpg.box.content[1] - 0.5) <= 0.01, { box: jpg?.box, drawn });
    const ref = first.at(-1)["ref.png"];
    ok(`${tag}: a file only referenced draws no picture box, though its entry carries a size`,
      !!ref && !ref.box && ref.note, ref);
    await page.screenshot({ path: join(output, `${tag}-first.png`) });

    // Shown again in this window: Show fewer, then Show all.
    await more.click();
    await page.waitForTimeout(300);
    const again = await page.evaluate(() => window.__now());
    await more.click();
    await complete("unknown.png");
    await complete("turned.jpg");
    await page.waitForTimeout(800);
    const shownAgain = record("shown again", await framesSince(again));
    const back = ["unknown.png", "turned.jpg"].map((name) => of(shownAgain, name));
    ok(`${tag}: pictures shown again in this window (Show fewer, then Show all) do not come in a second time`,
      back.every((shown) => shown.length > 0 && shown.every((f) => !f.picture?.entries) && shown.at(-1).picture?.opacity === 1),
      back.map((shown) => ({ frames: shown.length, playing: shown.filter((f) => f.picture?.entries).length, last: shown.at(-1)?.picture })));

    // The card moves on while its first picture is still decoding.
    await page.evaluate(() => sessionStorage.setItem("slow-decode", "1"));
    version = 3;
    await page.reload();
    await openHome();
    await complete("known.png", "version=3");
    const moved = await page.evaluate(() => window.__now());
    await page.evaluate(() => window.__moveOn());
    await complete("known.png", "version=4");
    await page.waitForTimeout(800);
    const later = of(record("moved on", await framesSince(moved)), "known.png").filter((f) => f.picture?.src.includes("version=4"));
    const sized = (f) => Math.abs(f.box.content[0] / f.box.content[1] - 1) <= 0.01;
    ok(`${tag}: the card moves on (a new snapshot, 300 x 300) while its first picture still decodes: the new box has its own shape at once, and nothing plays on the new picture before it is decoded; then it comes in once (under reduced motion, at once)`,
      later.length > 0 && later.every(sized) && later.some((f) => !f.picture.complete) && cameIn(later, reduced),
      { first: later[0], playingBeforeDecoded: later.filter((f) => !f.picture.complete && f.picture.entries).length, last: later.at(-1)?.picture });
    await page.screenshot({ path: join(output, `${tag}-moved-on.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written; Home's list reads of linked repositories, counted apart: ${report.listReads}; images read: ${report.images.length}`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-image-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
