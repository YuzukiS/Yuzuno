// Does Chinese text actually get a heavier face at 600/700 in a given build?
// Read-only: it loads the built UI, draws text, and reports what the browser
// did. Nothing is written but its own JSON, and no Core is involved.
//
//   YUZUNO_UI_DIST=<isolated build> node acceptance/brief-typography/font-weight-probe.mjs
//   YUZUNO_BROWSER_BIN=... selects a Chromium build (a Mac's Google Chrome works)
//   YUZUNO_PROBE_OUT=<file.json> writes the full record
//
// Method, and why each step is there:
//  - Canvas never triggers a web font to load, and a font that is not loaded
//    is silently replaced by a fallback, which would make two weights look
//    identical for the wrong reason. So every (weight, family) is loaded with
//    `document.fonts.load(font, sample)` for the exact sample text first, and
//    `document.fonts.check` is recorded after it.
//  - `ctx.font` is read back after assignment: the browser normalises it, and
//    a string it rejected would silently leave the previous font in place.
//  - The canvas is larger than the text, and the glyphs' bounding box is
//    measured and reported, so clipping cannot be mistaken for less ink.
//  - CJK glyphs keep the same advance width at any weight, so width proves
//    nothing: weight shows as ink. Ink is the sum of the alpha channel over
//    every pixel, with a count of pixels above half alpha beside it.
//  - A canvas result alone cannot say which face the DOM used, so the same
//    text is also rendered in the DOM and Chrome is asked, through
//    CSS.getPlatformFontsForNode, which font file drew those glyphs. Forcing
//    a family name, or fonts.check succeeding, does not prove that.
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const dist = resolve(process.env.YUZUNO_UI_DIST ?? "");
if (!process.env.YUZUNO_UI_DIST) throw new Error("Set YUZUNO_UI_DIST to a built UI");
const out = process.env.YUZUNO_PROBE_OUT || resolve("../acceptance/brief-typography/font-weight-probe.json");
const SAMPLE_ZH = "加粗的中文";
const SAMPLE_EN = "bold English";

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(dist + "/")) return route.fulfill({ status: 403, body: "" });
  try {
    return route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
});
await page.goto("https://font-probe.test/");

// The DOM side first: it also loads the web font for the canvas side.
await page.evaluate(async ([zh, en]) => {
  const box = document.createElement("div");
  box.id = "font-probe";
  box.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fff;padding:24px;font-size:32px;line-height:2";
  box.innerHTML = `
    <p id="zh-400">${zh}</p>
    <p id="zh-600" style="font-weight:600">${zh}</p>
    <p id="zh-700" style="font-weight:700">${zh}</p>
    <p id="en-400">${en}</p>
    <p id="en-700" style="font-weight:700">${en}</p>`;
  document.body.appendChild(box);
  await document.fonts.ready;
}, [SAMPLE_ZH, SAMPLE_EN]);

const measured = await page.evaluate(async ([zh, en]) => {
  const stack = getComputedStyle(document.body).fontFamily;
  const SIZE = 64;
  const draw = async (text, weight, family) => {
    const font = `${weight} ${SIZE}px ${family}`;
    // Load this exact face for this exact text before drawing it.
    let loadError = null;
    try {
      await document.fonts.load(font, text);
    } catch (error) {
      loadError = String(error);
    }
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 200;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    const accepted = ctx.font; // what the browser kept, normalised
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    const metrics = ctx.measureText(text);
    const x = 20;
    const y = 120;
    ctx.fillText(text, x, y);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    let covered = 0;
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (!alpha) continue;
      ink += alpha;
      if (alpha > 128) covered++;
      const pixel = i / 4;
      const px = pixel % canvas.width;
      const py = (pixel - px) / canvas.width;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return {
      requested: font,
      accepted,
      accepted_matches_request: accepted.includes(String(weight)) || weight === 400,
      loadError,
      check_after_load: document.fonts.check(font, text),
      width: Math.round(metrics.width * 100) / 100,
      ink,
      covered,
      // Where the glyphs landed, to show the canvas did not cut them off.
      bbox: maxX < 0 ? null : { minX, maxX, minY, maxY },
      fitsCanvas: maxX >= 0 && minX > 0 && maxX < canvas.width - 1 && minY > 0 && maxY < canvas.height - 1,
    };
  };
  const result = { stack, fontSynthesis: getComputedStyle(document.body).fontSynthesis, canvas: {}, dom: {} };
  for (const [key, text, weight, family] of [
    ["zh-400-stack", zh, 400, stack],
    ["zh-600-stack", zh, 600, stack],
    ["zh-700-stack", zh, 700, stack],
    ["zh-400-han", zh, 400, "'Yuzuno Han'"],
    ["zh-700-han", zh, 700, "'Yuzuno Han'"],
    ["en-400-stack", en, 400, stack],
    ["en-700-stack", en, 700, stack],
  ]) {
    result.canvas[key] = await draw(text, weight, family);
  }
  for (const id of ["zh-400", "zh-600", "zh-700", "en-400", "en-700"]) {
    const el = document.getElementById(id);
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    result.dom[id] = {
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }
  result.fontFaces = [...document.fonts].map((face) => ({ family: face.family, weight: face.weight, status: face.status }));
  return result;
}, [SAMPLE_ZH, SAMPLE_EN]);

// Which font file actually drew each line: Chrome's own answer.
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
const { root } = await cdp.send("DOM.getDocument");
const platform = {};
for (const id of ["zh-400", "zh-600", "zh-700", "en-400", "en-700"]) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  platform[id] = fonts;
}
await page.locator("#font-probe").screenshot({ path: out.replace(/\.json$/, ".png") });
await browser.close();

const record = { at: new Date().toISOString(), dist, sample: { zh: SAMPLE_ZH, en: SAMPLE_EN }, ...measured, platformFonts: platform };
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);

const c = record.canvas;
console.log(`font-synthesis: ${record.fontSynthesis}`);
console.log(`stack: ${record.stack}\n`);
console.log("canvas ink (same text, same size; CJK advance width is fixed, so ink is the measure):");
for (const [key, value] of Object.entries(c))
  console.log(`  ${key.padEnd(14)} ink=${String(value.ink).padStart(9)} covered=${String(value.covered).padStart(6)} width=${value.width} loaded=${value.check_after_load} fits=${value.fitsCanvas}\n    ctx.font kept: ${value.accepted}`);
console.log("\nwhich file drew the glyphs (Chrome, CSS.getPlatformFontsForNode):");
for (const [id, fonts] of Object.entries(platform))
  console.log(`  ${id.padEnd(8)} ${fonts.map((f) => `${f.familyName} / ${f.postScriptName} (custom=${f.isCustomFont}, glyphs=${f.glyphCount})`).join("; ")}`);
console.log(`\nwritten: ${out}`);
