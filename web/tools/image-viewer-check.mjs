// T-20: the image viewer in Chromium, on a production build with every API
// answered here (no Core, no GitHub, no model). Its entries: a conversation
// message's image, an Agent's image file opened from a link in its reply, a
// Home report's images, and the same report's page. Three windows: 1720 ×
// 1100 light and 1200 × 900 dark (mouse, wheel, keys), and a 390 × 844 phone
// (touch: one finger moves, two pinch, sent as the screen sends them).
// Synthetic images and names only; screenshots for review. Not a check of a
// real iPhone, Safari or the desktop app's WebView.
//   YUZUNO_UI_DIST=<isolated build> node tools/image-viewer-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/image-viewer");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [], imageReads: [], anchor: {}, screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

// ---- synthetic images ----------------------------------------------------------

/** A PNG drawn row by row: `paint(y)` gives one row, 3 bytes a pixel. */
function png(width, height, paint) {
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) paint(y).copy(raw, y * (1 + width * 3) + 1);
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const solid = (width, [r, g, b]) => {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], x * 3);
  return row;
};
// Digits 5 × 7, a row of bits each, drawn 3 × as large.
const DIGITS = ["01110100011001110101110011000101110", "00100011000010000100001000010001110", "01110100010000100010001000100011111",
  "11110000010000101110000010000111110", "00010001100101010010111110001000010", "11111100001111000001000011000101110",
  "00110010001000011110100011000101110", "11111000010001000100010000100001000", "01110100011000101110100011000101110",
  "01110100011000101111000010001001100"];
/**
 * A long screenshot: a green top bar, then numbered rows of "text", 60 px
 * apart, each "0001" to its row's number and a line of words; a red bottom
 * bar. Shrunk to fit, the numbers cannot be read; at the stage's width they can.
 */
function screenshot(width, height) {
  const paper = [250, 250, 246], ink = [54, 75, 60];
  const top = solid(width, [88, 117, 82]), bottom = solid(width, [196, 64, 60]), blank = solid(width, paper);
  const rows = new Map();
  return png(width, height, (y) => {
    if (y < 120) return top;
    if (y >= height - 120) return bottom;
    const row = Math.floor((y - 120) / 60), at = (y - 120) % 60;
    if (at < 10 || at >= 31) return blank;
    const key = `${row}:${Math.floor((at - 10) / 3)}`;
    if (!rows.has(key)) {
      const line = Buffer.from(blank);
      const glyph = Math.floor((at - 10) / 3);
      String(row + 1).padStart(4, "0").split("").forEach((digit, i) => {
        const bits = DIGITS[Number(digit)].slice(glyph * 5, glyph * 5 + 5);
        for (let b = 0; b < 5; b++) if (bits[b] === "1") for (let dx = 0; dx < 3; dx++) line.set(ink, (40 + i * 18 + b * 3 + dx) * 3);
      });
      if (at >= 16 && at < 24) {
        let x = 140, seed = row * 7919 + 1;
        const end = width - 40 - ((row * 37) % 300);
        while (x < end) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const word = 18 + (seed % 90);
          for (let i = x; i < Math.min(x + word, end); i++) line.set(ink, i * 3);
          x += word + 12;
        }
      }
      rows.set(key, line);
    }
    return rows.get(key);
  });
}
const images = {
  "settings-long.png": screenshot(1200, 6000),
  "dashboard-wide.png": png(6000, 1200, (y) => solid(6000, y < 600 ? [122, 156, 110] : [94, 129, 172])),
  "icon.png": png(200, 120, () => solid(200, [196, 148, 92])),
  "photo.png": png(1600, 1000, (y) => solid(1600, [Math.round(120 + (y / 1000) * 80), 150, 170])),
};
const messageImage = `${"c".repeat(64)}.png`;

// ---- the Workspace this page sees ------------------------------------------------

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const taken = ago(90);
const base = { cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
// Mori is working, so an Escape that reached the app would interrupt her.
const agents = [
  { ...base, id: "a", name: "Mori", harness: "codex", status: "working" },
  { ...base, id: "b", name: "Hana", harness: "claude", color: "rose", status: "idle" },
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
const snapshot = (name) => ({ name, kind: "image", mime: "image/png", size: images[name]?.length ?? 1000, snapshot: true, mayChange: false, takenAt: taken });
const captions = { "settings-long.png": "Settings, scrolled to the end", "dashboard-wide.png": "Dashboard", "icon.png": "Icon", "photo.png": "Desk photo", "gone.png": "Old capture" };
const sections = [{
  id: 11, key: "shots", kind: "report", title: "Settings screens", version: 3, owner: { agentId: "b", name: "Hana", state: "active" },
  updatedAt: ago(5), updatedTurnId: "t1", refs: {}, seen: null, history: false,
  body: spec(["text", "files"], {
    text: node("Markdown", { text: "The settings screen, whole, and other captures." }),
    files: node("Attachments", { items: Object.entries(captions).map(([name, caption]) => ({ name, caption })) }),
  }),
  attachments: Object.keys(captions).map(snapshot),
}];
const home = {
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 9, history: [], sections },
  }],
};
const conversation = {
  agent: agents[0], pending: [], messageReceipts: [], artifacts: [],
  turns: [{
    id: "turn-1", status: "completed", items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Here is the settings screen, scrolled." }, { type: "localImage", path: `/input-images/a/${messageImage}` }] },
      { id: "reply-1", type: "agentMessage", phase: "final_answer", text: "I saved the full capture as [the long capture](out/settings-capture.png)." },
    ],
  }, { id: "turn-2", status: "inProgress", items: [] }],
};
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };

// ---- reading the viewer ----------------------------------------------------------

/** The stage's inner box, the image's box and own size, and the bar's state. */
const state = (page) => page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const stage = dialog?.querySelector(".image-viewer-stage");
  const img = stage?.querySelector("img");
  if (!stage || !img) return null;
  const s = stage.getBoundingClientRect(), i = img.getBoundingClientRect();
  return {
    stage: { left: s.left + stage.clientLeft, top: s.top + stage.clientTop, width: stage.clientWidth, height: stage.clientHeight },
    image: { left: i.left, top: i.top, width: i.width, height: i.height },
    natural: { width: img.naturalWidth, height: img.naturalHeight }, src: img.getAttribute("src"),
    scale: i.width / img.naturalWidth, output: dialog.querySelector(".image-viewer-zoom output").textContent,
    pressed: [...dialog.querySelectorAll('.image-viewer-modes button[aria-pressed="true"]')].map((b) => b.textContent),
    title: dialog.querySelector("h2").textContent, details: dialog.querySelector(".modal-heading p")?.textContent ?? "",
    focused: document.activeElement === stage, movable: stage.hasAttribute("data-movable"),
    label: stage.getAttribute("aria-label"), page: { scale: visualViewport.scale },
  };
});
/** The point of the image under a point of the screen, in image pixels. */
const under = (s, at) => ({ u: (at.x - s.image.left) / s.scale, v: (at.y - s.image.top) / s.scale });
const close = (a, b, slack, what) => assert.ok(Math.abs(a - b) <= slack, `${what}: ${a} vs ${b}`);
/** Every scroll position on the page, to prove the wheel moved none of them. */
const scrolls = (page) => page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => el.scrollTop || el.scrollLeft).map((el) => `${el.className}:${el.scrollTop}:${el.scrollLeft}`).join("|"));
/** The viewer open, its image (`src` containing the given text) loaded and placed. */
async function opened(page, src = "") {
  await page.getByRole("dialog").waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"]')).opacity === "1");
  await page.waitForFunction((src) => {
    const img = document.querySelector('[role="dialog"] .image-viewer-stage img');
    const out = document.querySelector('[role="dialog"] .image-viewer-zoom output');
    return img?.complete && img.naturalWidth > 0 && img.getAttribute("src").includes(src) && out && out.textContent !== "–";
  }, src, { timeout: 15_000 });
  // Let any glide from a button settle before measuring.
  await page.waitForTimeout(250);
  return state(page);
}
const settled = async (page) => {
  await page.waitForTimeout(250);
  return state(page);
};
/** One step of a touch, as the phone's screen sends it. */
const touch = (cdp, type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

const windows = [
  { name: "wide", width: 1720, height: 1100, theme: "light", touch: false },
  { name: "dark", width: 1200, height: 900, theme: "dark", touch: false },
  { name: "phone", width: 390, height: 844, theme: "light", touch: true },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const viewport of windows) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.addInitScript((theme) => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
      // What the window saw of each wheel: whether something took it first.
      window.wheels = [];
      addEventListener("wheel", (event) => wheels.push({ prevented: event.defaultPrevented, ctrl: event.ctrlKey }), { passive: true });
    }, viewport.theme);
    page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
    const writes = () => report.writes.filter((w) => w.viewport === viewport.name);
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
      assert.equal(url.hostname, "yuzuno-image-viewer.test");
      if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
      if (method !== "GET") {
        report.writes.push({ viewport: viewport.name, method, path });
        return route.fulfill({ json: {} });
      }
      const attachment = /^\/api\/projects\/p1\/brief\/attachments\/shots\/([^/]+)$/.exec(path);
      if (attachment) {
        const name = decodeURIComponent(attachment[1]);
        report.imageReads.push(`${viewport.name} home ${name}?version=${url.searchParams.get("version")}`);
        return images[name] ? route.fulfill({ body: images[name], contentType: "image/png" }) : route.fulfill({ status: 404, json: { error: "This snapshot is no longer kept." } });
      }
      if (path === `/api/agents/a/images/${messageImage}`) {
        report.imageReads.push(`${viewport.name} message${url.search}`);
        return route.fulfill({ body: url.searchParams.get("thumb") ? images["icon.png"] : images["settings-long.png"], contentType: "image/png" });
      }
      if (path === "/api/artifact") {
        report.imageReads.push(`${viewport.name} file ${url.searchParams.get("agentId")}:${url.searchParams.get("path")}`);
        return route.fulfill({ body: images["settings-long.png"], contentType: "image/png" });
      }
      const json = {
        "/api/workspace": { workspace: { id: "ws-image-viewer" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a": conversation, "/api/agents/b": { agent: agents[1], pending: [], messageReceipts: [], artifacts: [], turns: [] },
        "/api/home": home, "/api/machine-load": machineLoad, "/api/agents/a/reading": { handoff: null }, "/api/agents/b/reading": { handoff: null },
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
    await page.goto("http://yuzuno-image-viewer.test/");
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
    const dialog = page.getByRole("dialog");
    const shot = async (name) => {
      const path = resolve(output, `${viewport.name}-${name}.png`);
      await page.screenshot({ path });
      report.screenshots.push(`${viewport.name}-${name}.png`);
    };
    const middleOf = (s) => ({ x: s.stage.left + s.stage.width / 2, y: s.stage.top + s.stage.height / 2 });
    const escape = async () => {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    };
    const noInterrupt = async (what) => {
      await page.waitForTimeout(300);
      assert.deepEqual(writes().map((w) => w.path), [], `${what}: no interrupt, nothing written`);
    };

    // ---- a conversation message's image, while its Agent is working ----
    const thumb = page.locator(".user-message .input-image-open").first();
    await thumb.waitFor();
    // By keyboard, so the stage's focus ring shows as it would.
    await thumb.focus();
    await page.keyboard.press("Enter");
    let s = await opened(page);
    assert.match(s.src, new RegExp(`/api/agents/a/images/${messageImage}$`), "the original image, not its thumbnail");
    assert.deepEqual([s.natural.width, s.natural.height], [1200, 6000]);
    assert.ok(s.focused, "the focus starts on the image");
    // A long screenshot: as wide as the stage (never enlarged), from its top.
    assert.deepEqual(s.pressed, s.stage.width >= 1200 ? ["Actual size"] : ["Fit width"]);
    close(s.image.width, Math.min(s.stage.width, 1200), 1, "as wide as the stage");
    close(s.image.top, s.stage.top, 1, "from its top");
    assert.equal(s.output, `${Math.round(Math.min(s.stage.width / 1200, 1) * 100)}%`);
    assert.match(s.details, /1200 × 6000 px · Original image attached to this message/);
    await page.waitForFunction(() => /, \d+%, Fit width$|, \d+%, Actual size$/.test(document.querySelector('[role="dialog"] .image-viewer-stage').getAttribute("aria-label")));
    await shot("message-open-focus");
    if (!viewport.touch) {
      // The wheel zooms at the pointer; neither the page nor anything behind scrolls or zooms.
      const before = await scrolls(page);
      // Whole pixels: Chromium puts the pointer on one, and the anchor is where it is.
      const at = { x: Math.round(s.stage.left + s.stage.width * 0.3), y: Math.round(s.stage.top + s.stage.height * 0.4) };
      const point = under(s, at);
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
      const z = await settled(page);
      assert.ok(z.scale > s.scale * 2, `zoomed in: ${s.scale} → ${z.scale}`);
      const after = under(z, at);
      const error = { x: Math.abs(after.u - point.u) * z.scale, y: Math.abs(after.v - point.v) * z.scale };
      report.anchor[viewport.name] = { pointer: at, imagePoint: point, scaleBefore: s.scale, scaleAfter: z.scale, errorPx: error };
      assert.ok(error.x <= 1.5 && error.y <= 1.5, `the same image point under the pointer, within 1.5 px: ${JSON.stringify(error)}`);
      assert.deepEqual(z.pressed, [], "zoomed by hand: no mode");
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -40);
      await page.keyboard.up("Control");
      const wheels = await page.evaluate(() => wheels);
      assert.ok(wheels.length >= 7 && wheels.every((w) => w.prevented), "every wheel was taken by the viewer before the page");
      assert.ok(wheels.some((w) => w.ctrl), "a trackpad pinch (Ctrl + wheel) too");
      assert.equal((await state(page)).page.scale, 1, "the page itself is not zoomed");
      assert.equal(await scrolls(page), before, "nothing behind scrolled");
      await shot("message-wheel-zoomed");
      check(`${viewport.name}: a conversation image opens its original, a long screenshot at the stage's width from its top; the wheel and Ctrl+wheel zoom at the pointer (error ${error.x.toFixed(2)}, ${error.y.toFixed(2)} px), and nothing behind scrolls or zooms`);

      // Dragging moves it with the pointer; past an edge it stops, even let go outside the dialog.
      const still = await state(page);
      const from = middleOf(still);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 150, from.y - 220, { steps: 5 });
      let d = await state(page);
      close(d.image.left - still.image.left, -150, 1.5, "moved with the pointer (x)");
      close(d.image.top - still.image.top, -220, 1.5, "moved with the pointer (y)");
      await page.mouse.move(viewport.width - 2, viewport.height - 2, { steps: 3 });
      await page.mouse.move(from.x + 5000, from.y + 5000, { steps: 2 });
      await page.mouse.up();
      d = await state(page);
      assert.ok(d.image.left <= d.stage.left + 0.5 && d.image.top <= d.stage.top + 0.5, "no gap past its top-left edge");
      assert.ok(await dialog.isVisible(), "letting go outside does not close the dialog");
      assert.equal(await page.locator('[role="dialog"] .image-viewer-stage[data-dragging]').count(), 0, "the drag ended");
      check(`${viewport.name}: dragging moves the image with the pointer and stops at its edges, let go anywhere`);

      // The keys and the bar: W, End, Home, 1, 0; Fit width and double-click.
      await page.keyboard.press("w");
      await page.keyboard.press("End");
      d = await settled(page);
      assert.deepEqual(d.pressed, ["Fit width"]);
      close(d.image.top + d.image.height, d.stage.top + d.stage.height, 1, "End: its last row at the stage's bottom");
      await shot("message-bottom");
      // The position bar's thumb, dragged to the top, brings the top back.
      const bar = await page.locator('[role="dialog"] .image-viewer-track[data-axis="y"] .image-viewer-thumb').boundingBox();
      await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x + bar.width / 2, d.stage.top - 400, { steps: 6 });
      await page.mouse.up();
      close((await state(page)).image.top, d.stage.top, 1, "the thumb dragged to the top: its top");
      await page.keyboard.press("End");
      await page.keyboard.press("Home");
      close((await settled(page)).image.top, d.stage.top, 1, "Home: its top");
      await page.keyboard.press("1");
      d = await settled(page);
      assert.equal(d.output, "100%");
      assert.deepEqual(d.pressed, ["Actual size"]);
      close(d.image.width, 1200, 1, "1: one image pixel to one CSS pixel");
      await shot("message-actual");
      await page.keyboard.press("0");
      d = await settled(page);
      assert.deepEqual(d.pressed, ["Fit"]);
      assert.ok(d.image.top >= d.stage.top - 0.5 && d.image.top + d.image.height <= d.stage.top + d.stage.height + 0.5, "0: the whole of it");
      await dialog.getByRole("button", { name: "Fit width" }).click();
      d = await settled(page);
      close(d.image.width, d.stage.width, 1, "Fit width");
      const at2 = { x: Math.round(d.stage.left + d.stage.width * 0.7), y: Math.round(d.stage.top + d.stage.height * 0.5) };
      const p2 = under(d, at2);
      await page.mouse.dblclick(at2.x, at2.y);
      d = await settled(page);
      assert.equal(d.output, "100%");
      close(under(d, at2).u, p2.u, 1.5, "double-click keeps the point (x)");
      close(under(d, at2).v, p2.v, 1.5, "double-click keeps the point (y)");
      check(`${viewport.name}: W, End, Home, 1, 0, the position bar, Fit width and double-click each show what they say`);
    }
    // Escape closes the viewer, and never reaches the working Agent.
    await escape();
    await noInterrupt("a conversation image");
    check(`${viewport.name}: Escape closes a conversation image's viewer and does not interrupt the working Agent`);

    // ---- an Agent's image file, from a link in its reply ----
    await page.getByRole("link", { name: "the long capture" }).click();
    s = await opened(page, "/api/artifact");
    assert.match(s.src, /\/api\/artifact\?agentId=a&path=out%2Fsettings-capture\.png$/);
    assert.ok(await page.locator('[role="dialog"].image-viewer-modal').count(), "the same viewer's dialog");
    close(s.image.top, s.stage.top, 1, "from its top");
    await shot("file-open");
    await escape();
    await noInterrupt("an Agent's image file");
    check(`${viewport.name}: an Agent's image file opens in the same viewer, from its top; Escape closes it without an interrupt`);

    // ---- a Home report's images ----
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    const card = page.locator('.home-section[data-section-key="shots"]');
    await card.waitFor();
    const showAll = card.locator("button.brief-attachments-more");
    if ((await showAll.count()) && (await showAll.getAttribute("aria-expanded")) === "false") await showAll.click();
    const open = async (scope, name) => {
      await scope.locator(`button.brief-image[aria-label="Open image ${name}"]`).click();
      return opened(page, `/attachments/shots/${name}?`);
    };
    s = await open(card, "settings-long.png");
    assert.match(s.src, /\/attachments\/shots\/settings-long\.png\?version=3$/);
    assert.equal(s.title, "Settings, scrolled to the end", "its caption first");
    assert.match(s.details, /^settings-long\.png · 1200 × 6000 px · Snapshot /, "then its file, size and time");
    assert.ok(Math.abs(s.image.width - Math.min(s.stage.width, 1200)) <= 1, "readable width, not a sliver");
    assert.equal(await dialog.getByRole("button", { name: "Mark up" }).count(), 1, "Mark up on the bar");
    await shot("home-long-open");
    if (viewport.touch) {
      // One finger moves it; two pinch it, about their middle. The page itself never zooms.
      const cdp = await context.newCDPSession(page);
      const c = middleOf(s);
      await touch(cdp, "touchStart", [[c.x, c.y]]);
      for (let i = 1; i <= 5; i++) await touch(cdp, "touchMove", [[c.x, c.y - i * 60]]);
      await touch(cdp, "touchEnd", []);
      let d = await state(page);
      close(d.image.top - s.image.top, -300, 2, "a finger moves it");
      await touch(cdp, "touchStart", [[c.x - 40, c.y], [c.x + 40, c.y]]);
      for (let i = 1; i <= 8; i++) await touch(cdp, "touchMove", [[c.x - 40 - i * 15, c.y], [c.x + 40 + i * 15, c.y]]);
      await touch(cdp, "touchEnd", []);
      d = await state(page);
      assert.ok(d.scale > s.scale * 2, `pinched: ${s.scale} → ${d.scale}`);
      assert.equal(d.page.scale, 1, "the page is not zoomed");
      assert.deepEqual(d.pressed, []);
      await shot("home-long-pinched");
      const row = await page.evaluate(() => {
        const bar = document.querySelector('[role="dialog"] .image-viewer-bar');
        const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const targets = [...bar.querySelectorAll("button, select")].filter((el) => el.checkVisibility()).map((el) => {
          const r = (el.tagName === "SELECT" ? el.parentElement : el).getBoundingClientRect();
          return { what: el.getAttribute("aria-label") || el.textContent, width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) };
        });
        return { overflow: bar.scrollWidth - bar.clientWidth, right: bar.getBoundingClientRect().right, dialogRight: dialog.right, full: dialog.width >= innerWidth - 1, targets };
      });
      assert.ok(row.overflow <= 0 && row.right <= row.dialogRight, `the bar fits the phone: ${JSON.stringify(row)}`);
      assert.ok(row.full, "full screen on a phone");
      assert.ok(row.targets.every((t) => t.width >= 44 && t.height >= 44), `every target at least 44 px: ${JSON.stringify(row.targets)}`);
      assert.equal(new Set(row.targets.map((t) => t.top)).size, 1, "one row");
      // The views are a menu on the scale.
      await dialog.locator("select.image-viewer-menu").selectOption("actual");
      d = await settled(page);
      assert.equal(d.output, "100%");
      await shot("home-long-menu-actual");
      check(`${viewport.name}: on a phone a Home image fills the screen; one finger moves it and two pinch it, without zooming the page; one row of ≥44 px targets; the views are a menu`, { targets: row.targets });
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await dialog.waitFor({ state: "hidden" });
    } else {
      // Mark up still takes the original image to Point & Fix, unaffected by the zoom.
      await page.keyboard.press("+");
      await page.keyboard.press("+");
      await dialog.getByRole("button", { name: "Mark up" }).click();
      const fix = page.locator(".point-fix-dialog");
      await fix.locator(".point-fix-image img").waitFor();
      await page.waitForFunction(() => document.querySelector(".point-fix-image img")?.naturalWidth > 0);
      assert.deepEqual(await fix.locator(".point-fix-image img").evaluate((img) => [img.naturalWidth, img.naturalHeight]), [1200, 6000], "the original, whole");
      await fix.getByRole("button", { name: "Cancel" }).click();
      await fix.waitFor({ state: "hidden" });
      check(`${viewport.name}: Mark up opens Point & Fix with the original image, whatever the zoom`);

      // Another image starts afresh: a wide one whole; a photo fitted; a small icon at its own size; a resize keeps Fit.
      s = await open(card, "dashboard-wide.png");
      assert.deepEqual(s.pressed, ["Fit"]);
      close(s.image.width, s.stage.width, 1, "a wide image fits the width");
      assert.ok(s.image.top > s.stage.top, "and is centred top to bottom");
      await shot("home-wide");
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForFunction((w) => document.querySelector('[role="dialog"] .image-viewer-stage').clientWidth < w, s.stage.width);
      const r = await settled(page);
      close(r.image.width, r.stage.width, 1, "still fits after the window shrinks");
      assert.deepEqual(r.pressed, ["Fit"]);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await escape();
      s = await open(card, "photo.png");
      assert.deepEqual(s.pressed, ["Fit"]);
      assert.ok(s.image.left >= s.stage.left - 0.5 && s.image.top >= s.stage.top - 0.5, "a photo, whole");
      await shot("home-photo");
      await escape();
      s = await open(card, "icon.png");
      assert.equal(s.output, "100%");
      assert.deepEqual(s.pressed, ["Actual size"], "Fit would have enlarged it");
      close(s.image.left + s.image.width / 2, s.stage.left + s.stage.width / 2, 1, "centred");
      assert.equal(s.movable, false, "nothing to drag");
      await shot("home-icon");
      await escape();
      check(`${viewport.name}: each image starts afresh; a wide one and a photo open whole, a small icon at its own size; a resize keeps Fit`);

      // The report's own page shows the same images, and opens them in the same viewer.
      await card.locator(".home-report-open").click();
      const reportPage = page.locator(".home-report");
      await reportPage.locator(".report-head h1").waitFor();
      s = await open(reportPage, "settings-long.png");
      assert.equal(s.title, "Settings, scrolled to the end");
      close(s.image.top, s.stage.top, 1, "from its top");
      await shot("report-long-open");
      await escape();
      await reportPage.locator(".report-back").click();
      await card.waitFor();
      check(`${viewport.name}: the report page's image opens in the same viewer`);
    }

    // One Core no longer has: said, with nothing to zoom.
    const gone = card.locator(".brief-attachment", { has: page.locator(".brief-attachment-caption", { hasText: "Old capture" }) });
    // A lazy image loads, and so fails, only once it is near the screen.
    await gone.scrollIntoViewIfNeeded();
    await gone.locator(".brief-image-failed").waitFor();
    await gone.locator("details.brief-image-info > summary").click();
    await gone.locator("button.brief-attachment-open").click();
    await dialog.waitFor();
    await dialog.getByRole("alert").waitFor();
    // Said in the stage's frame; nothing to zoom or mark.
    assert.equal(await dialog.locator(".image-viewer-stage [role=alert]").count(), 1);
    assert.equal(await dialog.getByRole("button", { name: "Zoom in" }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "Mark up" }).count(), 0);
    await shot("unreadable");
    await escape();
    check(`${viewport.name}: an image that cannot be read says so, with nothing to zoom`);

    assert.deepEqual(writes().map((w) => w.path), [], `${viewport.name}: looking wrote nothing`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${viewport.name}: no sideways scroll (${overflow})`);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
console.log(`anchor errors: ${JSON.stringify(report.anchor)}`);
console.log(`image reads: ${JSON.stringify([...new Set(report.imageReads)])}`);
console.log(`unexpected reads (answered {}): ${JSON.stringify([...new Set(report.unexpected)])}`);
