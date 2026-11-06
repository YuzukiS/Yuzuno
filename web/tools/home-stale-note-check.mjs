// T-51 PR 8, a row the user added on 11-06 (T-51 HM:U1), in Chromium: Home mounted on its own with the app's CSS,
// every API answered here (no Core), on the source of the tree it runs in (so a copy of main runs it on main's).
// When Home's read fails, the overview's "Home could not refresh" note floats over the top of its tiles, in a slot of
// no height: the overview keeps its height and the first part of Home below it stays where it was, while the note
// shows and as it goes. It fades in over small and out over exit-small, the same note all the way out; under reduced
// motion it is there and gone at once. It takes no pointer: under it, a click or tap on a tile's top strip still
// reaches the tile (#630 R2). Desktop 1280×860 and phone 390×844, each with normal and reduced motion.
// Positions are measured inside .home-layout, so Home's own error banner above it does not count.
//   YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-stale-note-check.mjs
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/home-stale-note"));
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

// ---- The fixture: two projects with a few results each.
const owner = { agentId: "a", name: "Mina", state: "active" };
const md = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text } } } });
const result = (pid, n) => ({ id: Number(pid.slice(1)) * 100 + n, key: `${pid}-r${n}`, kind: "report", title: `Result ${n}`, version: 1, owner,
  updatedAt: "2026-11-05T10:00:00Z", updatedTurnId: null, body: md("A result worth reading, in a few words."), attachments: [], refs: {},
  seen: null, history: false });
const panel = (id, name) => ({ project: { id, name }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 1, sections: [1, 2, 3].map((n) => result(id, n)), history: [] } });
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1", "p2"], needsYou: [], projects: [panel("p1", "Northstar"), panel("p2", "Atlas")] });

// ---- The next /api/home read is answered or failed when the test says.
const server = { homeNext: "ok" };
const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

let http, browser;
// A fresh install (npm ci) leaves no node_modules/.cache.
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/home-stale-note-check-"));
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderHome=()=>root.render(<Home workspaceId="ws" revision={0} jobsRevision={0} agents={[]} projects={[]} readOnly={false} arrival={null} onBackToReply={()=>{}} onNavigate={()=>{}} onChanged={()=>{}}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "HomeStaleNoteCheck", formats: ["iife"] } } });
  const out = (Array.isArray(built) ? built[0] : built).output;
  const bundle = out.find((item) => item.type === "chunk").code;
  const css = [...(await Promise.all(["styles.css", "appearance.css", "palettes.css"].map((f) => readFile(path.join(root, "src", f), "utf8")))),
    ...out.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => String(item.source))].join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="garden"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><style>${css}
html,body{height:100%;margin:0}#root{height:100vh;display:flex;flex-direction:column}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  http = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    for await (const _ of request);
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }); return response.end(html); }
    if (url.pathname === "/api/home" && request.method === "GET") {
      if (server.homeNext === "fail") { server.homeNext = "ok"; return send(response, 503, { error: "Core is restarting" }); }
      return send(response, 200, home());
    }
    if (url.pathname === "/api/collaboration/github_repositories") return send(response, 200, { repositories: [], links: [] });
    if (request.method !== "GET") report.writes.push(`${request.method} ${url.pathname}`);
    send(response, 404, { error: "not in this fixture" });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${http.address().port}/`;
  browser = await launchBrowser();

  for (const run of [
    { name: "desktop", viewport: { width: 1280, height: 860 }, reduced: false },
    { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reduced: true },
    { name: "phone", viewport: { width: 390, height: 844 }, reduced: false, phone: true },
    { name: "phone-reduced", viewport: { width: 390, height: 844 }, reduced: true, phone: true },
  ]) {
    const tag = run.name;
    const motion = (normal, still) => (run.reduced ? still : normal);
    server.homeNext = "ok";
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reduced ? "reduce" : "no-preference", locale: "en-US",
      hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    try {
      await page.goto(base);
      await page.evaluate(() => window.renderHome());
      await page.locator(".home-return-overview").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      // In the page: where the overview and what follows it sit inside .home-layout, and what the note plays, each frame.
      await page.evaluate(() => {
        window.__read = () => {
          const layout = document.querySelector(".home-layout");
          const overview = document.querySelector(".home-return-overview");
          const next = overview?.nextElementSibling;
          const note = document.querySelector(".home-return-stale");
          if (note && !window.__first) window.__first = note;
          const top = layout?.getBoundingClientRect().top ?? 0;
          return { overview: overview ? Math.round(overview.getBoundingClientRect().height) : null,
            next: next ? Math.round(next.getBoundingClientRect().top - top) : null,
            note: note ? { same: note === window.__first, position: getComputedStyle(note).position, leaving: note.classList.contains("is-leaving"),
              plays: note.getAnimations().filter((a) => a.playState === "running").map((a) => `${a.animationName}:${a.effect.getTiming().duration}`),
              hit: window.__hit(note) } : null };
        };
        // What a click or tap 4 px below the first tile's top, at its middle, lands on, and whether the note covers it.
        window.__hit = (note) => {
          const tile = document.querySelector(".home-return-tile");
          if (!tile) return null;
          const r = tile.getBoundingClientRect(), n = note.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + 4);
          const at = document.elementFromPoint(x, y);
          return { covered: x >= n.left && x <= n.right && y >= n.top && y <= n.bottom, tile: !!at && at.closest(".home-return-tile") === tile,
            at: at ? `${at.tagName.toLowerCase()}.${at.className}` : null };
        };
        window.__sample = (ms) => new Promise((done) => {
          const frames = [];
          const t0 = performance.now();
          const frame = () => {
            frames.push({ t: Math.round(performance.now() - t0), ...window.__read() });
            if (performance.now() - t0 < ms) requestAnimationFrame(frame); else done(frames);
          };
          requestAnimationFrame(frame);
        });
      });
      const before = await page.evaluate(() => window.__read());
      // The next read fails: Refresh asks for it.
      server.homeNext = "fail";
      const coming = page.evaluate(() => window.__sample(700));
      await page.evaluate(() => document.querySelector('[aria-label="Refresh Home"]').click());
      const shown = await coming;
      // The read after answers: the note goes.
      const going = page.evaluate(() => window.__sample(600));
      await page.evaluate(() => document.querySelector('[aria-label="Refresh Home"]').click());
      const gone = await going;
      report.measured[tag] = { before, shown, gone };
      const withNote = shown.filter((f) => f.note);
      const leaving = gone.filter((f) => f.note);
      const still = (f) => f.overview === before.overview && f.next === before.next;
      ok(`${tag}: Home's failed read says so over the top of the overview's tiles: the overview keeps its height and what follows it stays where it was (HM:U1)`,
        withNote.length > 0 && withNote.every((f) => f.note.position === "absolute") && shown.every(still) && gone.every(still),
        { before, shown: withNote.slice(0, 2), moved: [...shown, ...gone].filter((f) => !still(f)).slice(0, 3) });
      const covering = withNote.filter((f) => f.note.hit?.covered);
      ok(`${tag}: under the note, a click or tap on a tile's top strip still reaches the tile (HM:U1, PR 630 R2)`,
        covering.length > 0 && covering.every((f) => f.note.hit.tile), { covering: covering.length, missed: covering.filter((f) => !f.note.hit.tile).slice(0, 2),
          first: withNote[0]?.note.hit ?? null });
      ok(`${tag}: the note ${motion("fades in over small (home-return-stale-in 180 ms)", "is there at once, nothing playing")} (HM:U1)`,
        withNote.length > 0 && (run.reduced ? withNote.every((f) => !f.note.plays.length) : withNote[0].note.plays.includes("home-return-stale-in:180")),
        withNote.slice(0, 2));
      ok(`${tag}: as the next read answers, the note ${motion("takes its way out over exit-small (home-return-stale-out 130 ms), the same note, then is gone", "is gone at once")} (HM:U1)`,
        !gone.at(-1).note && (run.reduced ? leaving.every((f) => !f.note.leaving && !f.note.plays.length)
          : leaving.length > 0 && leaving.every((f) => f.note.same) && leaving.some((f) => f.note.leaving && f.note.plays.includes("home-return-stale-out:130"))),
        { leaving: leaving.slice(0, 3), end: gone.at(-1) });
      await page.screenshot({ path: path.join(output, `${tag}-end.png`) });
    } catch (error) {
      ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    }
    await context.close();
  }
} finally {
  await browser?.close();
  http?.close();
  await rm(fixture, { recursive: true, force: true });
}
ok("no page errors", report.errors.length === 0, report.errors);
ok("nothing was written", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0;
await writeFile(path.join(output, "home-stale-note-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
process.exit(report.passed ? 0 : 1);
