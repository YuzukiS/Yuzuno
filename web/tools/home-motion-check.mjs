// T-51 plan item 6, Home's own motion rows (T-19 HM:A4, H2, H3, H7, H15, S11), in Chromium: Home mounted on its own
// with the app's CSS, every API answered here (no Core), on the source of the tree it runs in (so a copy of main runs
// it on main's). Desktop 1280×860 and phone 390×844, each with normal and reduced motion:
// - S11: a kept reply's Copy text says it copied, and the clipboard has it.
// - H3: Refresh, while the read it asked for is on its way, says it is busy, its icon turning (still under reduced
//   motion).
// - H2: Home's error floats over the top of what is below, which stays where it was; it fades in over small and out
//   over exit-small (there and gone at once under reduced motion).
// - H7: a moved panel's arrow keeps the focus as its panel moves, while the order saves, after, and as a refused order
//   puts it back. The panels change places at once (no motion: H7's and H8's moves are not animated).
// - A4: an ask Core reads as replied keeps its card's height, so nothing below moves, until the reader touches it.
// - H15: a reply's project no longer on Home: the note saying so, out of view, is brought into view and settles.
//   YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-motion-check.mjs
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/home-motion"));
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

// ---- The fixture: two projects, long enough that Home scrolls; Northstar's first card an open ask.
const owner = { agentId: "a", name: "Mina", state: "active" };
const md = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text } } } });
const filler = "A result worth reading, with enough words to take a few lines in its card on any width. ".repeat(3);
const report_ = (pid, n) => ({ id: Number(pid.slice(1)) * 100 + n, key: `${pid}-r${n}`, kind: "report", title: `Result ${n}`, version: 1, owner,
  updatedAt: "2026-11-05T10:00:00Z", updatedTurnId: null, body: md(filler), attachments: [], refs: {}, seen: null, history: false });
const ask = (state) => ({ id: 199, key: "p1-ask", kind: "ask", title: "Which export first?", version: 3, owner,
  updatedAt: "2026-11-05T10:00:00Z", updatedTurnId: null, body: md(`Pick the export to build first. ${filler}`), attachments: [], refs: {},
  seen: null, history: false,
  ask: { question: "Which export first: CSV or PDF?", reply: { options: [{ id: "csv", label: "CSV" }, { id: "pdf", label: "PDF" }], freeText: true },
    state, ...(state === "replied" ? { replyText: "CSV first", repliedAt: "2026-11-05T10:05:00Z" } : {}) } });
const panel = (id, name, sections) => ({ project: { id, name }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 1, sections, history: [] } });
let askState = "open";
let order = ["p1", "p2"];
const home = () => ({ generatedAt: new Date().toISOString(), order, needsYou: [],
  projects: [
    panel("p1", "Northstar", [ask(askState), ...[1, 2, 3, 4].map((n) => report_("p1", n))]),
    panel("p2", "Atlas", [1, 2, 3, 4, 5].map((n) => report_("p2", n))),
  ] });

// ---- How the next requests are answered: held, failed or refused when the test says.
const server = { homeNext: "ok", homeHeld: [], orderNext: "ok", orderHeld: [] };
const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const answerHome = (response) => {
  const how = server.homeNext;
  if (how === "hold") return server.homeHeld.push(response);
  if (how === "fail") { server.homeNext = "ok"; return send(response, 503, { error: "Core is restarting" }); }
  send(response, 200, home());
};
const answerOrder = (response, ids) => {
  const how = server.orderNext;
  if (how === "hold") return server.orderHeld.push({ response, ids });
  if (how === "refuse") { server.orderNext = "ok"; return send(response, 409, { error: "the order changed meanwhile" }); }
  order = ids;
  send(response, 200, {});
};
const release = (list, answer) => { for (const held of list.splice(0)) answer(held); };
const until = async (fn, label, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

let http, browser;
// A fresh install (npm ci) leaves no node_modules/.cache.
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/home-motion-check-"));
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
import {cardReplySlot} from ${JSON.stringify(path.join(root, "src/home/CardReply.tsx"))};
window.cardReplySlot=cardReplySlot;
const root=createRoot(document.getElementById('root'));
window.renderHome=(arrival=null)=>root.render(<Home workspaceId="ws" revision={0} jobsRevision={0} agents={[]} projects={[]} readOnly={false} arrival={arrival} onBackToReply={()=>{}} onNavigate={()=>{}} onChanged={()=>{}}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "HomeMotionCheck", formats: ["iife"] } } });
  const out = (Array.isArray(built) ? built[0] : built).output;
  const bundle = out.find((item) => item.type === "chunk").code;
  const css = [...(await Promise.all(["styles.css", "appearance.css", "palettes.css"].map((f) => readFile(path.join(root, "src", f), "utf8")))),
    ...out.filter((item) => item.type === "asset" && item.fileName.endsWith(".css")).map((item) => String(item.source))].join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="garden"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><style>${css}
html,body{height:100%;margin:0}#root{height:100vh;display:flex;flex-direction:column}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  http = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }); return response.end(html); }
    if (url.pathname === "/api/home" && request.method === "GET") return answerHome(response);
    if (url.pathname === "/api/home/order" && request.method === "POST") return answerOrder(response, JSON.parse(body).projectIds);
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
    const m = (report.measured[tag] = {});
    askState = "open";
    order = ["p1", "p2"];
    Object.assign(server, { homeNext: "ok", homeHeld: [], orderNext: "ok", orderHeld: [] });
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reduced ? "reduce" : "no-preference", locale: "en-US",
      hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    // What plays on an element now: running animations' properties and durations.
    const plays = (selector) => page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el ? el.getAnimations().filter((a) => a.playState === "running").map((a) => ({
        name: a.animationName ?? a.id, duration: a.effect?.getTiming?.().duration ?? null })) : null;
    }, selector);
    const topOf = (selector) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().top ?? null, selector);
    // Pressed where it is: a locator click would scroll Home to bring its header into view.
    const refresh = () => page.evaluate(() => document.querySelector('[aria-label="Refresh Home"]').click());
    const step = async (key, fn) => { try { m[key] = await fn(); } catch (error) { m[key] = { error: String(error).slice(0, 300) }; } return m[key]; };
    try {
      await page.goto(base);
      // A reply kept from a card that has left Home (S11).
      await page.evaluate(() => localStorage.setItem("yuzuno.home-card-drafts.v1", JSON.stringify({ [window.cardReplySlot("ws", "p1", "p1-gone")]:
        { key: "p1-gone", text: "Keep the old export", version: 2, title: "Old card", agentId: "a", at: new Date().toISOString() } })));
      await page.evaluate(() => window.renderHome());
      await page.locator('[data-home-project="p2"]').waitFor({ timeout: 15_000 });

      // ---- S11
      const s11 = await step("s11", async () => {
        const kept = page.locator(".home-kept-reply");
        await kept.scrollIntoViewIfNeeded();
        await kept.getByRole("button", { name: "Copy text" }).click();
        await kept.getByText("Copied").waitFor({ timeout: 5000 });
        return { said: "Copied", clipboard: await page.evaluate(() => navigator.clipboard.readText()) };
      });
      ok(`${tag}: a kept reply's Copy text says it copied, and the clipboard has it (S11)`, s11?.said === "Copied" && s11.clipboard === "Keep the old export", s11);

      // ---- H3
      const h3 = await step("h3", async () => {
        server.homeNext = "hold";
        await refresh();
        await until(() => server.homeHeld.length, "the read Refresh asked for");
        await page.waitForTimeout(100);
        const busy = await page.getAttribute('[aria-label="Refresh Home"]', "aria-busy");
        const turning = await plays('[aria-label="Refresh Home"] svg');
        server.homeNext = "ok";
        release(server.homeHeld, (r) => send(r, 200, home()));
        await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh Home"]').hasAttribute("aria-busy"), null, { timeout: 5000 });
        return { busy, turning, after: await plays('[aria-label="Refresh Home"] svg') };
      });
      ok(`${tag}: Refresh, while its read is on its way, says it is busy, ${motion("its icon turning", "its icon still")} (H3)`,
        h3?.busy === "true" && Array.isArray(h3.turning) && (run.reduced ? h3.turning.length === 0 : h3.turning.some((a) => a.name === "spin"))
          && Array.isArray(h3.after) && h3.after.length === 0, h3);

      // ---- H2
      const h2 = await step("h2", async () => {
        // From Home's top: scroll anchoring would hide a banner that pushes what is below when it is out of view.
        await page.evaluate(() => { document.querySelector(".home-view").scrollTop = 0; });
        await page.waitForTimeout(100);
        // What is right below the banner's slot: the overview's own notes (its last read failed) move only what is
        // inside it.
        const first = ".home-layout";
        const before = await topOf(first);
        await page.evaluate(() => {
          window.__banner = { seen: null, leaving: null };
          new MutationObserver(() => {
            const el = document.querySelector(".home-error-banner");
            const look = (el) => ({ plays: el.getAnimations().filter((a) => a.playState === "running").map((a) => ({ name: a.animationName, duration: a.effect.getTiming().duration })),
              position: getComputedStyle(el).position });
            if (el && !window.__banner.seen) window.__banner.seen = look(el);
            if (el?.classList.contains("is-leaving") && !window.__banner.leaving) window.__banner.leaving = look(el);
          }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
        });
        server.homeNext = "fail";
        await refresh();
        await page.locator(".home-error-banner").waitFor({ timeout: 5000 });
        await page.waitForTimeout(250);
        const during = await topOf(first);
        await refresh();
        await page.locator(".home-error-banner").waitFor({ state: "detached", timeout: 5000 });
        const after = await topOf(first);
        return { before, during, after, ...(await page.evaluate(() => window.__banner)) };
      });
      const fade = (look, name, ms) => !!look && (run.reduced ? look.plays.length === 0 : look.plays.some((a) => a.name === name && a.duration === ms));
      ok(`${tag}: Home's error floats over the top of what is below, which stays where it was, ${motion("fading in over small and out over exit-small", "there and gone at once")} (H2)`,
        !!h2?.seen && h2.seen.position === "absolute" && h2.before !== null && h2.before === h2.during && h2.during === h2.after
          && fade(h2.seen, "home-banner-in", 180) && (run.reduced ? !h2.leaving : fade(h2.leaving, "home-banner-out", 130)), h2);

      // ---- H7
      const h7 = await step("h7", async () => {
        const arrow = (id, dir) => `[data-home-project="${id}"] .home-reorder [data-move="${dir}"]`;
        const focused = () => page.evaluate(() => {
          const el = document.activeElement;
          return el?.dataset?.move ? `${el.closest("[data-home-project]")?.dataset.homeProject}:${el.dataset.move}` : el?.tagName ?? null;
        });
        const orderShown = () => page.evaluate(() => [...document.querySelectorAll(".home-panel")].map((el) => el.dataset.homeProject));
        await page.locator(".home-header-tools").getByRole("button", { name: "Reorder" }).click();
        await page.locator(arrow("p1", "down")).waitFor();
        server.orderNext = "hold";
        await page.locator(arrow("p1", "down")).focus();
        await page.locator(arrow("p1", "down")).click();
        await until(() => server.orderHeld.length, "the order sent");
        await page.waitForTimeout(100);
        const saving = { focus: await focused(), order: await orderShown(),
          disabled: await page.evaluate(() => [...document.querySelectorAll(".home-reorder button")].some((b) => b.disabled)) };
        server.orderNext = "ok";
        release(server.orderHeld, ({ response, ids }) => { order = ids; send(response, 200, {}); });
        await page.waitForFunction((s) => !document.querySelector(s)?.hasAttribute("aria-disabled"), arrow("p2", "down"), { timeout: 5000 });
        const saved = { focus: await focused(), order: await orderShown() };
        server.orderNext = "refuse";
        await page.locator(arrow("p1", "up")).focus();
        await page.locator(arrow("p1", "up")).click();
        await page.locator(".home-error-banner").waitFor({ timeout: 5000 });
        await page.waitForTimeout(100);
        const refused = { focus: await focused(), order: await orderShown() };
        await page.locator(".home-header-tools").getByRole("button", { name: "Done" }).click();
        server.homeNext = "ok";
        await refresh();
        await page.locator(".home-error-banner").waitFor({ state: "detached", timeout: 5000 });
        return { saving, saved, refused };
      });
      ok(`${tag}: a moved panel's arrow keeps the focus while the order saves, after, and as a refused order puts it back (H7)`,
        h7?.saving?.focus === "p1:down" && h7.saving.disabled === false && h7.saving.order?.join() === "p2,p1"
          && h7.saved?.focus === "p1:down" && h7.saved.order?.join() === "p2,p1"
          && h7.refused?.focus === "p1:up" && h7.refused.order?.join() === "p2,p1", h7);

      // ---- A4
      const a4 = await step("a4", async () => {
        const card = '[data-home-project="p1"] [data-section-key="p1-ask"]';
        const next = '[data-home-project="p1"] [data-section-key="p1-r1"]';
        await page.locator(card).scrollIntoViewIfNeeded();
        const measure = () => page.evaluate(([c, n]) => ({ height: document.querySelector(c)?.getBoundingClientRect().height ?? null,
          nextTop: document.querySelector(n)?.getBoundingClientRect().top ?? null, replied: document.querySelector(c)?.classList.contains("is-replied") ?? null }), [card, next]);
        const before = await measure();
        askState = "replied";
        await refresh();
        await page.waitForFunction((c) => document.querySelector(c)?.classList.contains("is-replied"), card, { timeout: 5000 });
        await page.waitForTimeout(200);
        const read = await measure();
        await page.evaluate((c) => document.querySelector(c).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })), card);
        await page.waitForTimeout(100);
        const touched = await measure();
        return { before, read, touched };
      });
      ok(`${tag}: an ask Core reads as replied keeps its card's height, so nothing below moves, until the reader touches it (A4)`,
        !!a4?.read?.replied && Math.abs(a4.read.height - a4.before.height) < 1 && Math.abs(a4.read.nextTop - a4.before.nextTop) < 1
          && a4.touched.height < a4.read.height - 1, a4);

      // ---- H15
      const h15 = await step("h15", async () => {
        await page.evaluate(() => { const v = document.querySelector(".home-view"); v.scrollTop = v.scrollHeight; });
        await page.waitForTimeout(200);
        const scrolledFrom = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
        await page.evaluate(() => window.renderHome({ origin: { projectId: "p-gone", key: "card-x", version: 2, workspaceId: "ws" },
          back: { workspaceId: "ws", agentId: "a", turnId: "t1", itemId: "i1" }, n: 1 }));
        const note = ".home-main > .home-reply-arrival";
        await page.locator(note).waitFor({ timeout: 5000 });
        await page.waitForFunction((s) => document.querySelector(s)?.hasAttribute("data-home-highlight"), note, { timeout: 5000 });
        const settled = await plays(note);
        const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); const v = document.querySelector(".home-view").getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, viewTop: v.top, viewBottom: v.bottom }; }, note);
        const scrolledTo = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
        return { scrolledFrom, scrolledTo, settled, box };
      });
      ok(`${tag}: a reply's project no longer on Home: the note, out of view, is brought into view and settles${motion(", its ring fading once", " with nothing playing")} (H15)`,
        h15?.scrolledFrom > 0 && h15.scrolledTo < h15.scrolledFrom && h15.box.top >= h15.box.viewTop - 1 && h15.box.bottom <= h15.box.viewBottom + 1
          && Array.isArray(h15.settled) && (run.reduced ? h15.settled.length === 0 : h15.settled.some((a) => a.name === "home-highlight")), h15);
    } catch (error) {
      ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    }
    await page.screenshot({ path: path.join(output, `${tag}-end.png`) }).catch(() => {});
    await context.close();
  }
} finally {
  await browser?.close();
  http?.closeAllConnections?.();
  await new Promise((r) => (http ? http.close(r) : r()));
  await rm(fixture, { recursive: true, force: true });
}
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(path.join(output, "home-motion-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exit(1);
