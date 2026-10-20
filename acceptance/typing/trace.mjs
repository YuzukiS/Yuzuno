// T-18: why each keystroke re-styles so much. Traces 3 s of held Backspace
// (with the three streams running) with Chromium's style invalidation
// tracking, then reports how many elements each style recalculation touched
// and which invalidations caused them.
//   node acceptance/typing/trace.mjs LABEL
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const label = process.argv[2] || "trace";
const lab = path.join(root, "target/t18/lab");
const state = JSON.parse(await readFile(path.join(lab, "lab.json"), "utf8"));
const api = (method, p, body) => fetch(`${state.base}/api${p}`, {
  method, headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const out = path.join(root, "target/t18/traces");
await mkdir(out, { recursive: true });
const file = path.join(out, `${label}.json`);

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((id) => {
    localStorage.setItem("yuzuno.selected", JSON.stringify(id));
    localStorage.removeItem("yuzuno.drafts");
  }, state.agents.Long);
  await page.goto(`${state.base}/?shell=desktop`);
  const composer = page.getByRole("textbox", { name: /^Message Long/ });
  await composer.waitFor();
  for (const id of Object.values(state.agents)) {
    for (let i = 0; i < 120; i++) {
      const d = await api("GET", `/agents/${id}`);
      if (!d.turns.some((t) => t.status === "inProgress")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await api("POST", `/agents/${id}/messages`, { clientMessageId: `${label}-${id}-${Date.now()}`, text: "stream:30:20" });
  }
  await page.waitForTimeout(2000);
  await composer.fill("x".repeat(600));
  await composer.press("End");
  await browser.startTracing(page, { path: file, categories: [
    "devtools.timeline", "disabled-by-default-devtools.timeline.invalidationTracking", "blink.user_timing"] });
  const end = Date.now() + 3000;
  await page.keyboard.down("Backspace");
  while (Date.now() < end) {
    await page.keyboard.down("Backspace");
    await page.waitForTimeout(33);
  }
  await page.keyboard.up("Backspace");
  await browser.stopTracing();
} finally {
  await browser.close();
}

const events = JSON.parse(await readFile(file, "utf8")).traceEvents;
const recalcs = events.filter((e) => e.name === "UpdateLayoutTree" && e.ph === "X");
const counts = recalcs.map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? 0);
const tally = (list, key) => {
  const map = {};
  for (const e of list) { const k = key(e); map[k] = (map[k] || 0) + 1; }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15);
};
const invalidations = events.filter((e) => /Invalidation/.test(e.name));
const summary = {
  label,
  recalcs: recalcs.length,
  recalcMs: Math.round(recalcs.reduce((s, e) => s + (e.dur || 0), 0) / 1000),
  elementsPerRecalc: { max: Math.max(0, ...counts), mean: Math.round(counts.reduce((s, c) => s + c, 0) / (counts.length || 1)) },
  invalidationKinds: tally(invalidations, (e) => e.name),
  reasons: tally(invalidations, (e) => `${e.name}: ${e.args?.data?.reason || e.args?.data?.changedClass || e.args?.data?.changedAttribute || e.args?.data?.changedPseudo || e.args?.data?.selectors?.map((s) => s.selector || s).join(" ") || ""}`),
  nodes: tally(invalidations, (e) => e.args?.data?.nodeName || "?"),
};
await writeFile(path.join(out, `${label}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
