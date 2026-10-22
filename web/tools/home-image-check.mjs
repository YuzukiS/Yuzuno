// T-177: Home Brief images in Chromium, on a production build with every API
// answered here (no Core, no GitHub, no model). A wide window and a phone:
// a report image opens in the app's preview by keyboard and closes with
// Escape back to it; Open opens the same preview; Mark up reads the image
// shown and adds the annotated image, the original and the card's source to
// its author's draft, sending nothing. An Ask's image, a history entry's and
// a pinned widget's open the same preview; an unreadable snapshot says so.
// Screenshots for review. Synthetic images and names only.
//   YUZUNO_UI_DIST=<isolated build> node tools/home-image-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/home-image");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
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
const images = {
  "screen-before.png": png(640, 400, [122, 156, 110]),
  "screen-after.png": png(640, 400, [94, 129, 172]),
  "mock.png": png(480, 320, [196, 148, 92]),
  "old.png": png(480, 320, [168, 108, 132]),
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const taken = ago(90);
const base = { status: "idle", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const agents = [
  { ...base, id: "a", name: "Mori", harness: "codex" },
  { ...base, id: "b", name: "Hana", harness: "claude", color: "rose" },
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
const snapshot = (name, extra = {}) => ({ name, kind: "image", mime: "image/png", size: images[name]?.length ?? 1000, snapshot: true, mayChange: false, takenAt: taken, ...extra });
const owner = (id) => ({ agentId: id, name: agents.find((a) => a.id === id).name, state: "active" });
const section = (key, kind, title, version, by, body, attachments, extra = {}) => ({ key, kind, title, version, owner: owner(by),
  updatedAt: ago(5), updatedTurnId: "t1", body, attachments, refs: {}, seen: null, history: false, ...extra });
const sections = [
  section("shots", "report", "Screens", 3, "b", spec(["text", "files"], {
    text: node("Markdown", { text: "The login screen before and after the spacing fix." }),
    files: node("Attachments", { items: [{ name: "screen-before.png", caption: "Before" }, { name: "screen-after.png", caption: "After" }] }),
  }), [snapshot("screen-before.png"), snapshot("screen-after.png")]),
  section("decide", "ask", "Which layout?", 2, "a", spec(["files"], {
    files: node("Attachments", { items: [{ name: "mock.png", caption: "Proposed layout" }] }),
  }), [snapshot("mock.png")], { ask: { question: "Ship this layout?", state: "open", reply: { options: [{ id: "yes", label: "Ship it" }, { id: "no", label: "Not yet" }], freeText: true } } }),
  section("gone", "status", "Old capture", 5, "a", spec(["files"], {
    files: node("Attachments", { items: [{ name: "missing.png" }] }),
  }), [snapshot("missing.png")], { status: { asOf: ago(30), validFor: 86400, stale: false } }),
];
const history = [
  section("shots", "report", "Screens", 1, "b", spec(["files"], { files: node("Attachments", { items: [{ name: "old.png", caption: "First try" }] }) }),
    [snapshot("old.png")], { history: true, seen: { version: 1, at: ago(600) }, updatedAt: ago(600) }),
];
const home = {
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [],
    brief: { version: 9, history, sections },
  }],
};
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };

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
    const uploads = new Map();
    const reads = [];
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
      assert.equal(url.hostname, "yuzuno-home-image.test");
      if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
      const upload = /^\/api\/agents\/([ab])\/images$/.exec(path);
      if (method === "POST" && upload) {
        const body = request.postDataBuffer() || Buffer.alloc(0);
        const id = `${String(uploads.size + 1).repeat(64)}.png`;
        uploads.set(id, body);
        report.writes.push({ viewport: viewport.name, method, path, bytes: body.length });
        return route.fulfill({ json: { id, width: 640, height: 400, bytes: body.length } });
      }
      if (method !== "GET") {
        report.writes.push({ viewport: viewport.name, method, path });
        return route.fulfill({ json: {} });
      }
      const attachment = /^\/api\/projects\/p1\/brief\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
      if (attachment) {
        reads.push(`${decodeURIComponent(attachment[1])}/${decodeURIComponent(attachment[2])}?version=${url.searchParams.get("version")}`);
        const bytes = images[decodeURIComponent(attachment[2])];
        return bytes ? route.fulfill({ body: bytes, contentType: "image/png" }) : route.fulfill({ status: 404, json: { error: "This snapshot is no longer kept." } });
      }
      const saved = /^\/api\/agents\/[ab]\/images\/([0-9]{64}\.png)$/.exec(path);
      if (saved) return route.fulfill({ body: uploads.get(saved[1]) || images["screen-after.png"], contentType: "image/png" });
      const detail = /^\/api\/agents\/([ab])$/.exec(path);
      const json = detail ? { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } : {
        "/api/workspace": { workspace: { id: "ws-image" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
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
    await page.goto("http://yuzuno-home-image.test/");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    const card = (key) => page.locator(`.home-section[data-section-key="${key}"]`);
    const dialog = page.getByRole("dialog");
    await card("shots").locator("button.brief-image img").first().evaluate((img) => img.decode());
    await page.screenshot({ path: resolve(output, `${viewport.name}-home.png`), fullPage: true });
    assert.equal(await card("shots").locator(".brief-attachment a").count(), 0, "no image link to a browser tab");
    const writesNow = () => report.writes.filter((w) => w.viewport === viewport.name).length;

    // By keyboard: the picture opens the preview; Escape closes it back to it.
    const before = card("shots").locator("button.brief-image").first();
    await before.focus();
    await page.keyboard.press("Enter");
    await dialog.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"]')).opacity === "1");
    assert.equal(await dialog.locator("h2").innerText(), "screen-before.png");
    assert.match(await dialog.innerText(), /Before · Snapshot/);
    await dialog.locator(".input-image-dialog img").evaluate((img) => img.decode());
    const fits = await dialog.locator(".input-image-dialog img").evaluate((img) => {
      const box = img.getBoundingClientRect(), frame = img.closest('[role="dialog"]').getBoundingClientRect();
      return img.naturalWidth === 640 && box.left >= frame.left && box.right <= frame.right && box.right <= innerWidth;
    });
    assert.ok(fits, "the whole image fits the preview");
    await page.screenshot({ path: resolve(output, `${viewport.name}-preview.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(await before.evaluate((el) => el === document.activeElement), "focus returns to the image");
    assert.equal(writesNow(), 0, "looking writes nothing");
    check(`${viewport.name}: a Home image opens in the app's preview by keyboard and Escape returns to it; nothing written`);

    // Open, then Mark up: the image shown, marked, into its author's draft.
    await card("shots").locator(".brief-attachment", { hasText: "screen-after.png" }).locator("button.brief-attachment-open").click();
    await dialog.waitFor();
    assert.equal(await dialog.locator("h2").innerText(), "screen-after.png");
    await dialog.getByRole("button", { name: "Mark up" }).click();
    const fix = page.locator(".point-fix-dialog");
    await fix.locator(".point-fix-image svg").waitFor();
    assert.equal(await fix.locator(".point-fix-target select").inputValue(), "b", "the card's author is offered first");
    const svg = await fix.locator(".point-fix-image svg").boundingBox();
    await page.mouse.move(svg.x + svg.width * 0.2, svg.y + svg.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(svg.x + svg.width * 0.5, svg.y + svg.height * 0.6, { steps: 4 });
    await page.mouse.up();
    await fix.getByLabel("Area 1 comment").fill("The button is cut off on narrow screens");
    await page.screenshot({ path: resolve(output, `${viewport.name}-markup.png`) });
    assert.equal(writesNow(), 0, "marking writes nothing until it is added");
    await fix.getByRole("button", { name: "Add to Hana’s draft" }).click();
    const composer = page.locator('[data-composer-input][aria-label="Message Hana"]');
    await composer.waitFor();
    await page.locator(".composer-area .input-image img").first().waitFor();
    const text = await composer.innerText();
    assert.match(text, /Point & Fix feedback on “screen-after\.png” \(640×400 px\): 1 marked area in the attached annotated image, with the original image attached\./);
    assert.ok(text.includes(`Source: the image “screen-after.png” on the Home card “Screens” (project p1, section shots, version 3; snapshot taken ${taken})`), text);
    assert.match(text, /1\. Area at x \d+, y \d+, \d+×\d+ px: The button is cut off on narrow screens/);
    assert.equal(await page.locator(".composer-area .input-image").count(), 2, "the annotated image and the original");
    assert.deepEqual(report.writes.filter((w) => w.viewport === viewport.name).map((w) => w.path), ["/api/agents/b/images", "/api/agents/b/images"],
      "only the two images are saved: nothing is sent");
    assert.ok(reads.includes("shots/screen-after.png?version=3"));
    await page.screenshot({ path: resolve(output, `${viewport.name}-draft.png`) });
    check(`${viewport.name}: Mark up adds the image shown, its original and the card's source to its author's draft, sending nothing`);

    // An Ask's image: the same preview; marking it never answers the Ask.
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await card("decide").locator("button.brief-image").click();
    await dialog.waitFor();
    assert.equal(await dialog.locator("h2").innerText(), "mock.png");
    await dialog.getByRole("button", { name: "Mark up" }).click();
    await fix.locator(".point-fix-image svg").waitFor();
    assert.equal(await fix.locator(".point-fix-target select").inputValue(), "a", "the Ask's author is offered first");
    await fix.getByRole("button", { name: "Cancel" }).click();
    await fix.waitFor({ state: "hidden" });
    assert.ok(await card("decide").getByRole("button", { name: "Ship it" }).isVisible(), "the Ask is still open to answer");
    assert.equal(report.writes.filter((w) => w.viewport === viewport.name && w.path.includes("/brief/")).length, 0, "no reply, no Seen");
    check(`${viewport.name}: an Ask's image opens the same preview; marking it up never answers the Ask`);

    // A snapshot Core no longer has: said plainly, nothing to mark.
    await card("gone").locator("button.brief-image").click();
    await dialog.waitFor();
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.getByRole("alert").innerText(), /can't be read from this Core/);
    assert.equal(await dialog.getByRole("button", { name: "Mark up" }).count(), 0);
    await page.screenshot({ path: resolve(output, `${viewport.name}-unreadable.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    check(`${viewport.name}: an unreadable snapshot says so and offers no Mark up`);

    // History reads its own version; a pinned widget opens the same preview.
    await page.locator(".home-history > summary").click();
    await page.locator(".home-history li > details > summary").first().click();
    await page.locator(".home-history button.brief-image").click();
    await dialog.waitFor();
    assert.match(await dialog.locator(".input-image-dialog img").getAttribute("src"), /\/attachments\/shots\/old\.png\?version=1$/);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await card("shots").getByRole("button", { name: "Pin “Screens” to Widgets" }).click();
    const pinned = page.locator(".home-pinned");
    await pinned.locator("button.brief-image").first().click();
    await dialog.waitFor();
    assert.equal(await dialog.locator("h2").innerText(), "screen-before.png");
    assert.equal(await dialog.getByRole("button", { name: "Mark up" }).count(), 1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    check(`${viewport.name}: a history entry's image (its own version) and a pinned widget's open the same preview`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${viewport.name}: no sideways scroll (${overflow})`);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
console.log(`unexpected reads (answered {}): ${JSON.stringify([...new Set(report.unexpected)])}`);
