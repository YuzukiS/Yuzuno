// T-170: photos as a phone takes them, attached through the composer's image
// picker in Chromium, on a production build with every API answered here (no
// Core). A photo Core takes goes up byte for byte; an iPhone's 24 MP photo
// (5712 × 4284, over Core's 24-megapixel limit) goes up as a JPEG 4096 px on
// its longer side, and one stored sideways with an EXIF rotation goes up
// upright. Chromium is not iOS Safari: how iOS hands over a HEIC photo, and
// its canvas limits, are for a real iPhone.
//   YUZUNO_UI_DIST=<isolated build> node --experimental-strip-types tools/photo-fit-check.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { imageSize } from "../src/image-fit.ts";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/photo-fit");
await mkdir(output, { recursive: true });
const report = { checks: [], uploads: [], errors: [], mutations: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agent = { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", connectionState: "connected", threadId: "thread-a" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = [{ id: "t0", status: "completed", items: [
  { id: "u0", type: "userMessage", content: [{ type: "text", text: "Here is the screen." }] },
  { id: "r0", type: "agentMessage", text: "Send me a photo of it." },
] }];
const saved = new Map();

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript(() => {
  window.EventSource = class { close() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
});
page.on("pageerror", (error) => report.errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (url.protocol !== "http:") return route.continue();
  assert.equal(url.hostname, "yuzuno-photo.test");
  const path = url.pathname;
  if (method === "POST" && path === "/api/agents/a/images") {
    const body = request.postDataBuffer();
    const size = imageSize(new Uint8Array(body));
    const id = `${createHash("sha256").update(body).digest("hex")}.jpg`;
    saved.set(id, body);
    report.uploads.push({ type: request.headers()["content-type"], bytes: body.length, size, body });
    return route.fulfill({ json: { id, width: size?.width ?? 0, height: size?.height ?? 0, bytes: body.length } });
  }
  const image = /^\/api\/agents\/a\/images\/([0-9a-f]{64}\.jpg)$/.exec(path);
  if (image && method === "GET") return route.fulfill({ body: saved.get(image[1]) ?? Buffer.alloc(0), contentType: "image/jpeg" });
  if (/^\/api\/agents\/a\/reading$/.test(path))
    return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method === "POST" && path === "/api/agents/a/review") return route.fulfill({ json: {} });
  if (method !== "GET") {
    report.mutations.push({ method, path });
    return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-photo" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
    "/api/home": { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] },
    "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
    "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
    "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  }[path];
  if (json) return route.fulfill({ json });
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] });
});

/** A JPEG drawn here, as a camera's would be: a gradient with a mark at the top left. */
const photo = (width, height) => page.evaluate(async ([width, height]) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  const fill = g.createLinearGradient(0, 0, width, height);
  fill.addColorStop(0, "#587552");
  fill.addColorStop(1, "#efd180");
  g.fillStyle = fill;
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#ac745e";
  g.fillRect(0, 0, width / 4, height / 8);
  const blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
  return [...new Uint8Array(await blob.arrayBuffer())];
}, [width, height]).then((bytes) => Buffer.from(bytes));

/** The same JPEG with an EXIF APP1 saying it is to be turned 90° clockwise
 * (orientation 6), as a phone held upright stores a photo. */
function rotated(jpeg) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, jpeg.subarray(2)]);
}

async function attach(name, buffer) {
  const before = report.uploads.length;
  await page.locator('input[type="file"][aria-label="Choose images"]').setInputFiles({ name, mimeType: "image/jpeg", buffer });
  for (let waited = 0; waited < 30000 && report.uploads.length <= before; waited += 100) await page.waitForTimeout(100);
  assert.equal(report.uploads.length, before + 1, `${name} was uploaded once`);
  // Let the draft show it before the next one (one upload at a time per Agent).
  await page.waitForTimeout(400);
  return report.uploads.at(-1);
}

try {
  await page.goto("http://yuzuno-photo.test/");
  await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
  await page.locator('[data-composer-input][aria-label="Message Mori"]').waitFor();

  const small = await photo(1600, 1200);
  const sentSmall = await attach("IMG_0001.JPG", small);
  assert.ok(sentSmall.body.equals(small), "a photo Core takes is sent byte for byte");
  check("a photo within Core's limits is sent as it was chosen", { bytes: small.length });

  const big = await photo(5712, 4284);
  assert.deepEqual(imageSize(new Uint8Array(big)), { width: 5712, height: 4284 });
  const sentBig = await attach("IMG_0002.JPG", big);
  assert.equal(sentBig.type, "image/jpeg");
  assert.deepEqual(sentBig.size, { width: 4096, height: 3072 }, "the 24 MP photo is sent at 4096 × 3072");
  assert.ok(sentBig.bytes <= 10 * 1024 * 1024, `within 10 MiB: ${sentBig.bytes}`);
  check("an iPhone's 24 MP photo is sent as a JPEG 4096 × 3072", { from: big.length, sent: sentBig.bytes });

  const upright = await attach("IMG_0003.JPG", rotated(big));
  assert.deepEqual(upright.size, { width: 3072, height: 4096 }, "a photo stored sideways is sent upright");
  check("a photo stored sideways with an EXIF rotation is sent upright, 3072 × 4096", { sent: upright.bytes });

  const shown = await page.locator(".input-images .input-image").count();
  report.shown = shown;
  await page.screenshot({ path: resolve(output, "composer.png") });
  const composerError = await page.locator(".inline-error[role='alert']").allTextContents();
  assert.deepEqual(composerError.filter((t) => t.trim()), [], "no image error in the composer");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mutations, []);
  assert.equal(shown, 3, "the draft shows the three photos");
  check("the draft shows the three photos; no page errors, no image error and no other writes", { shown });
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify({ ...report, uploads: report.uploads.map(({ body, ...u }) => u) }, null, 2));
  await browser.close();
}
