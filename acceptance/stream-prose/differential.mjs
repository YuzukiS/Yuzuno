// YN-234: ProseBlocks against Prose's whole-text HTML, in Chromium, where a
// parse keeps no memory as it does in JSDOM and many more streams fit than in
// web/tools/prose-blocks.test.mjs. The head's own src/prose-blocks.ts and
// src/prose-html.ts, bundled by Vite as the app is, in a blank page; the
// same samples and random documents (web/tools/prose-blocks-corpus.mjs), and
// the long replies of profile.mjs. At every step of every stream, the root's
// HTML without fading words' spans must be exactly what Prose shows for the
// text so far, and finishing must draw nothing again.
//   PROSE_WEB=<head's web/> PROSE_OUT=<dir> [PROSE_DOCS=4000] node acceptance/stream-prose/differential.mjs
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const web = resolve(process.env.PROSE_WEB || "web");
const out = resolve(process.env.PROSE_OUT || ".");
const docs = Number(process.env.PROSE_DOCS || 4000);
const browserBin = process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium";
const { build } = await import(join(web, "node_modules/vite/dist/node/index.js"));
const { chromium } = await import(join(web, "node_modules/playwright-core/index.mjs"));
await mkdir(out, { recursive: true });

const fixture = join(web, "node_modules/.cache/yn234-differential");
await mkdir(fixture, { recursive: true });
let bundle;
try {
  const entry = join(fixture, "entry.ts");
  await writeFile(
    entry,
    `import { ProseBlocks } from ${JSON.stringify(join(web, "src/prose-blocks.ts"))};
import { proseHtml } from ${JSON.stringify(join(web, "src/prose-html.ts"))};
import { corpus, every, random, randomDocument } from ${JSON.stringify(join(web, "tools/prose-blocks-corpus.mjs"))};
window.__differential = { ProseBlocks, proseHtml, corpus: { corpus, every, random, randomDocument } };`,
  );
  const result = await build({
    root: web,
    configFile: false,
    logLevel: "silent",
    // As the app's build has it: React reads it as it loads.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, minify: true, lib: { entry, name: "ProseDifferential", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

// The long replies of profile.mjs, as it builds them.
const profile = await import(new URL("./inputs.mjs", import.meta.url));

const browser = await chromium.launch({ headless: true, executablePath: browserBin, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundle });
  assert.deepEqual(errors, [], "the bundle loads");
  const report = await page.evaluate(
    ({ docs, long }) => {
      if (!window.__differential) throw new Error("the bundle did not load");
      const { ProseBlocks, proseHtml, corpus: c } = window.__differential;
      const plain = (root) => {
        const copy = root.cloneNode(true);
        for (const span of copy.querySelectorAll(".stream-word")) span.replaceWith(...span.childNodes);
        copy.normalize();
        return copy.innerHTML;
      };
      const failures = [];
      let streams = 0;
      let steps = 0;
      let redrawnOnFinish = 0;
      const stream = (text, cuts, label) => {
        const root = document.createElement("div");
        root.className = "prose";
        document.body.append(root);
        const blocks = new ProseBlocks(root);
        let now = 1000;
        let at = 0;
        streams++;
        try {
          for (const cut of [...cuts, text.length]) {
            if (cut <= at) continue;
            const shown = text.slice(0, cut);
            blocks.show(shown, false, (now += 100));
            steps++;
            const expected = proseHtml(shown);
            if (plain(root) !== expected) {
              failures.push({ label, at: cut, text: shown, shown: plain(root), expected });
              return;
            }
            at = cut;
          }
          const before = [...root.childNodes];
          blocks.show(text, true, (now += 100));
          const after = [...root.childNodes];
          if (after.length !== before.length || after.some((node, i) => node !== before[i])) redrawnOnFinish++;
          if (plain(root) !== proseHtml(text)) failures.push({ label: `${label} whole`, text, shown: plain(root), expected: proseHtml(text) });
        } finally {
          root.remove();
        }
      };
      for (const [name, text] of Object.entries(c.corpus)) {
        for (const size of [1, 2, 3, 5, 7, 11, 16, 29, 61]) stream(text, c.every(text, size), `${name} by ${size}`);
        const next = c.random(name.length * 7919);
        for (let run = 0; run < 20; run++) {
          const cuts = [];
          for (let at = 0; at < text.length; ) cuts.push((at += 1 + Math.floor(next() * 40)));
          stream(text, cuts, `${name}, run ${run}`);
        }
      }
      const next = c.random(234046);
      for (let doc = 0; doc < docs; doc++) {
        const text = c.randomDocument(next);
        const mode = next();
        const cuts = mode < 0.4 ? c.every(text, 1) : mode < 0.7 ? c.every(text, 1 + Math.floor(next() * 12)) : (() => {
          const list = [];
          for (let at = 0; at < text.length; ) list.push((at += 1 + Math.floor(next() * 30)));
          return list;
        })();
        stream(text, cuts, `random ${doc}`);
      }
      for (const { name, text, appends } of long) {
        // The prefill, then each append as profile.mjs sends it; also the
        // whole reply streamed from nothing, some 20 characters at a time.
        const whole = text + appends.join("");
        const cuts = [text.length];
        for (const piece of appends) cuts.push(cuts.at(-1) + piece.length);
        stream(whole, cuts, `${name} appends`);
        stream(whole, c.every(whole, 20), `${name} from nothing`);
      }
      return { streams, steps, redrawnOnFinish, failures: failures.slice(0, 20), failureCount: failures.length };
    },
    { docs, long: profile.scenarios.map(({ name, text, appends }) => ({ name, text, appends })) },
  );
  report.engine = browser.version();
  report.docs = docs;
  await writeFile(join(out, "differential.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`differential: ${report.streams} streams, ${report.steps} steps, ${report.failureCount} failures, ${report.redrawnOnFinish} redrawn on finish (${report.engine})`);
  for (const f of report.failures.slice(0, 5)) console.log(`  ${f.label} at ${f.at}: ${JSON.stringify(f.text).slice(0, 200)}`);
  assert.equal(report.failureCount, 0, "every step shows what the whole text shows");
  assert.equal(report.redrawnOnFinish, 0, "finishing draws nothing again");
} finally {
  await browser.close();
}
