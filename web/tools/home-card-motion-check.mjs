// YN-203 in Chromium: a Home card changing as the user acts on it. Home mounted on its own with the app's CSS, every
// API answered here (no Core), on the source of the tree it runs in. Desktop 1280×860 and phone 390×844, each with
// normal and reduced motion; the Ask in Needs you, and once on its project's page (the deck).
// - Its edge moves over --motion-card (500 ms); what it showed fades out over --motion-card-out (190 ms) as a copy,
//   and what changed fades in over --motion-card-in (310 ms) only once that copy is gone (the user's "渐隐到消失之后
//   再开始渐显" and "一共500ms", yn-203/ask rounds 3 and 4). What did not change does not fade.
// - The reply (the form, then the answer card), Question and details opened and closed, Reply again, a new version
//   from Core part way in (it starts again from nothing, never seen with its copy, taking no pointer meanwhile).
// - The copy takes no pointer, focus or reading, shares no id with the page, and its pictures' references find its
//   own parts; it keeps inner scrolls; one at most, nested no deeper than one.
// - Interrupted (fast presses, Reply again part way in, changes it did not make, endless changes) it ends consistent;
//   a card replied from its foot ends in view; the answer card's buttons stay under the pointer.
// - A report's Reply on the deck: opened, closed with ✕, opened again and sent, closed with Escape: its edge never
//   moves at once, the reply fades in only once the copy is gone, focus goes into its field and back to Reply, and
//   the card is as tall as before once closed.
// - Reduced motion: at its end at once; turned on meanwhile, every animation, the copy and a scroll to the focus stop
//   at their end.
//   YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-card-motion-check.mjs
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchBrowser } from "./browser-engine.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.YUZUNO_BROWSER_OUTPUT || path.join(root, "../target/home-card-motion"));
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], replies: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

// ---- The fixture: one project, its Ask long enough that its top can be above the view while its options are in it.
const owner = { agentId: "a", name: "Mina", state: "active" };
const md = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text } } } });
const filler = "A result worth reading, with enough words to take a few lines in its card on any width. ".repeat(3);
const report_ = (n) => ({ id: 100 + n, key: `p1-r${n}`, kind: "report", title: `Result ${n}`, version: 1, owner,
  updatedAt: "2026-11-05T10:00:00Z", updatedTurnId: null, body: md(filler), attachments: [], refs: {}, seen: null, history: false });
const atlasBody = (lead) => [lead, ...Array.from({ length: 16 }, (_, i) => `Part ${i + 1}. ${filler}`)].join("\n\n");
let atlas = { state: "open", version: 1, replyText: null, repliedAt: null, body: "" };
const atlasAsk = () => ({ id: 99, key: "p1-ask", kind: "ask", title: "How should the release go out?", version: atlas.version, owner,
  updatedAt: "2026-11-05T10:00:00Z", updatedTurnId: null, body: md(atlas.body || atlasBody("Choose how the release goes out.")), attachments: [], refs: {},
  seen: null, history: false,
  ask: { question: "Ship it now or hold it a day?", reply: { options: [{ id: "ship", label: "Ship it" }, { id: "hold", label: "Hold a day" }], freeText: true },
    state: atlas.state, ...(atlas.state === "replied" ? { replyText: atlas.replyText, repliedAt: atlas.repliedAt } : {}) } });
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"],
  // As Core does: an open Ask needs the user; replied, it no longer does.
  needsYou: atlas.state === "open"
    ? [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mina", sectionKey: "p1-ask", title: "How should the release go out?", since: "2026-11-05T10:00:00Z" }] : [],
  projects: [{ project: { id: "p1", name: "Atlas" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 1, sections: [atlasAsk(), ...[1, 2, 3, 4].map(report_)], history: [] } }] });

// ---- How requests are answered: a reply as Core takes it (the ask replied, then the receipt), slowly when asked.
const server = { slowReply: false, readDelay: 0 };
const until = async (fn, label, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

// ---- What the check expects, its own (styles.css --motion-card*, as the user set them: "一共500ms").
const CARD_MS = 500, OUT_MS = 190, IN_MS = 310;
// The Ask where Home shows it first, in Needs you; and on its project's page, on the deck (YN-86).
const LIST = '.home-needs-you [data-section-key="p1-ask"]';
const DECK = '[data-project-home="p1"] [data-section-key="p1-ask"]';
const REPORT = '[data-project-home="p1"] [data-section-key="p1-r1"]';
// In the page: a card as it is now (its parts, the copy fading over it, every animation of its own under way), and
// its frames for a while from now.
function cardHelpers() {
  const opacity = (e) => (e ? Number(getComputedStyle(e).opacity) : null);
  const live = (card, selector) => [...card.querySelectorAll(selector)].find((e) => !e.closest(".card-ghost")) ?? null;
  window.__card = (card) => {
    const body = card.querySelector(":scope > .home-card-body");
    const details = [...card.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details"));
    const view = card.closest(".home-view").getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const ghosts = card.querySelectorAll(":scope > .card-ghost");
    const g = ghosts[0];
    const ids = g ? [...(g.id ? [g] : []), ...g.querySelectorAll("[id]")].map((e) => e.id) : [];
    return {
      answer: card.classList.contains("is-answer"), open: card.classList.contains("is-open"),
      expanded: details?.getAttribute("aria-expanded") ?? null,
      hidden: body?.hidden ?? null, opacity: opacity(body), pointer: body ? getComputedStyle(body).pointerEvents : null, pointerStyle: body?.style.pointerEvents ?? null,
      resizing: card.dataset.resizing !== undefined, height: Math.round(r.height), top: Math.round(r.top), viewTop: Math.round(view.top), viewBottom: Math.round(view.bottom),
      form: [...card.querySelectorAll(".home-ask-reply")].filter((e) => !e.closest(".card-ghost")).length,
      ghosts: ghosts.length, deep: card.querySelectorAll(".card-ghost .card-ghost .card-ghost").length,
      ghost: g ? { opacity: opacity(g), pointer: getComputedStyle(g).pointerEvents, inert: g.inert, ariaHidden: g.getAttribute("aria-hidden"), key: g.hasAttribute("data-section-key"),
        ids: ids.length, shared: ids.filter((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length > 1).length,
        // What it holds, read whole: the Ask's options, its body.
        options: g.textContent.includes("Hold a day"), body: g.textContent.includes("Part 3."), text: g.textContent.replace(/\s+/g, " ").slice(0, 160) } : null,
      focusInGhost: !!(g && g.contains(document.activeElement)),
      headOpacity: opacity(card.querySelector(":scope > .home-section-head")),
      answerOpacity: opacity(card.querySelector(":scope > .home-answer")),
      askOpacity: opacity(live(card, ".home-ask")),
      repliedBlock: !!live(card, ".home-ask-replied"),
      // A report's reply: its box, and where focus is.
      replyOpacity: opacity(card.querySelector(":scope > .home-card-reply")),
      focus: (() => {
        const a = document.activeElement;
        if (!a || !card.contains(a) || a.closest(".card-ghost")) return a && a !== document.body ? "elsewhere" : null;
        if (card.querySelector(":scope > .home-card-reply")?.contains(a) && a.matches("[data-composer-input], textarea, [contenteditable='true']")) return "reply-field";
        if (a.classList.contains("home-reply-open")) return "reply-button";
        return "card";
      })(),
      realText: [...card.children].filter((c) => !c.classList.contains("card-ghost")).map((c) => c.textContent).join(" ").replace(/\s+/g, " ").slice(0, 300),
      // The card's own motion (its resize, the copy's fade, its fades in), not a button's hover transition.
      anims: card.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && !(typeof CSSTransition !== "undefined" && a instanceof CSSTransition)).map((a) => ({
        props: Object.keys(a.effect.getKeyframes()[0] ?? {}).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).join("+"),
        duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay,
        on: a.effect.target === card ? "card" : a.effect.target?.classList?.contains("card-ghost") ? "ghost" : String(a.effect.target?.className ?? "").slice(0, 30) })),
    };
  };
  window.__frames = (selector, ms) => new Promise((done) => {
    const card = document.querySelector(selector);
    const out = [];
    const t0 = performance.now();
    const step = () => {
      out.push({ t: Math.round(performance.now() - t0), ...window.__card(card) });
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else done(out);
    };
    // One now, before what follows is done: a change drawn by the next frame is still seen as one.
    step();
  });
}

let http, browser;
// A fresh install (npm ci) leaves no node_modules/.cache.
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "node_modules/.cache/home-card-motion-check-"));
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Home} from ${JSON.stringify(path.join(root, "src/home/Home.tsx"))};
const root=createRoot(document.getElementById('root'));
const at='2026-11-05T10:00:00Z';
const agents=[{id:'a',name:'Mina',projectId:'p1',goal:'',cwd:'/work/atlas',model:'opus',color:'#5fa39c',status:'idle',createdAt:at,updatedAt:at,harness:'claude'}];
// Each mount a fresh visit: Home, or the project's page.
window.renderHome=(mount=0,project=null)=>root.render(<Home key={mount} workspaceId="ws" revision={0} jobsRevision={0} agents={agents} projects={[]} readOnly={false} arrival={null}
  project={project} onOpenProject={()=>{}} onCloseProject={()=>{}} onBackToReply={()=>{}} onNavigate={()=>{}} onChanged={()=>{}}/>);`);
  const built = await build({ root, configFile: false, logLevel: "silent", plugins: [react()], define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, lib: { entry, name: "HomeCardMotionCheck", formats: ["iife"] } } });
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
    if (url.pathname === "/api/home" && request.method === "GET") {
      if (!server.readDelay) return send(response, 200, home());
      const ms = server.readDelay;
      server.readDelay = 0;
      return void setTimeout(() => send(response, 200, home()), ms);
    }
    if (url.pathname === "/api/projects/p1/brief/reply" && request.method === "POST") {
      const sent = JSON.parse(body);
      report.replies.push({ key: sent.key, agentId: sent.agentId ?? null, choice: sent.choice ?? null, text: sent.text ?? null,
        version: sent.version ?? null, askVersion: sent.askVersion ?? null });
      // As slowly as Core can be, when a scene asks: the reply, then Home's read after it, each a moment.
      if (server.slowReply) {
        server.slowReply = false;
        await new Promise((r) => setTimeout(r, 220));
        server.readDelay = 260;
      }
      // A report's reply is delivered and changes nothing on Home; the Ask's makes it replied.
      if (sent.key === "p1-ask") {
        const picked = sent.choice ? atlasAsk().ask.reply.options.find((o) => o.id === sent.choice)?.label : null;
        atlas = { ...atlas, state: "replied", replyText: picked || sent.text, repliedAt: new Date().toISOString() };
      }
      return send(response, 200, { input: { ...sent, expectedTurnId: null, question: null }, status: "accepted", turnId: "t-own", error: null });
    }
    // Seen, opened, defer: taken, nothing else changes here.
    if (/^\/api\/projects\/p1\/brief\/(seen|opened|defer)$/.test(url.pathname) && request.method === "POST") return send(response, 200, {});
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
    Object.assign(server, { slowReply: false, readDelay: 0 });
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reduced ? "reduce" : "no-preference", locale: "en-US",
      hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
    await context.addInitScript(cardHelpers);
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    await page.goto(base);
    let sel = LIST;
  // Each scene from a fresh visit (Home mounted again), the Ask open.
  let mounts = 0;
    const card = () => page.locator(sel);
    const look = () => card().evaluate((c) => window.__card(c));
    const frames = (ms) => page.evaluate(([s, ms]) => window.__frames(s, ms), [sel, ms]);
    const idle = async (ms = 4000) => {
      const end = Date.now() + ms;
      for (;;) {
        const s = await look();
        if ((!s.resizing && s.anims.length === 0 && s.ghosts === 0) || Date.now() > end) return s;
        await page.waitForTimeout(50);
      }
    };
    const fresh = async (project = null) => {
      atlas = { state: "open", version: atlas.version + 1, replyText: null, repliedAt: null, body: "" };
      sel = project ? DECK : LIST;
      await page.evaluate(([n, p]) => window.renderHome(n, p), [++mounts, project]);
      await page.locator(`${sel} .home-ask-options button`).first().waitFor({ timeout: 8000 });
      await card().evaluate((c) => c.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.waitForTimeout(250);
    };
    const option = () => page.locator(`${sel} .home-ask-options button`).first();
    const answer = async () => {
      await option().click();
      await page.locator(`${sel}.is-answer`).waitFor({ state: "attached", timeout: 8000 });
    };
    const toggle = () => page.locator(`${sel} > .home-answer`).getByRole("button", { name: "Question and details" });
    const again = () => page.locator(`${sel} > .home-answer`).getByRole("button", { name: "Reply again" });
    // Pressed where it is drawn now, as a pointer does (a locator click waits for it to stand still).
    const pressAt = async (locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("not on screen");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    // A copy takes no pointer, focus or reading, has no section key and shares no id with the page.
    const sound = (g) => !!g && g.pointer === "none" && g.inert === true && g.ariaHidden === "true" && !g.key && g.shared === 0;
    const settledShut = (s) => s.answer && !s.resizing && s.anims.length === 0 && s.ghosts === 0;
    const y = m;
    const cardScenes = run.reduced
      ? ["reply", "again@30", "details-fast", "hidden-top", "deck", "report-reply"]
      : ["reply", "through", "open-after-out", "close", "svg-ids", "scroll-copy", "rapid", "unseen-press", "again@200", "details-fast", "restart",
        "reduced-toggle", "reduced-midway", "reduced-scroll", "non-dom", "chase", "hidden-top", "deck", "report-reply"];
    for (const scene of cardScenes) {
      try {
        if (scene === "reply") {
          await fresh();
          await answer();
          const during = await look();
          const settled = await idle();
          y.reply = { during, settled };
          ok(`${tag}: an Ask replied here becomes its answer card and settles, no copy left${motion("", ", with no animation and no copy at any time")}`,
            settledShut(settled) && (!run.reduced || (during.anims.length === 0 && during.ghosts === 0)), y.reply);
        }
        if (scene === "through") {
          await fresh();
          server.slowReply = true;
          const pending = frames(1800);
          await option().click();
          const rows = await pending;
          // Step 1: the form gives way to the reply block. Step 2: the Ask gives way to its answer card.
          const step1 = rows.findIndex((r) => !r.answer && r.repliedBlock);
          const step2 = rows.findIndex((r) => r.answer);
          const [first1, first2] = [rows[step1], rows[step2]];
          let rising = 0, both1 = 0, both2 = 0, headDip = 1;
          for (let i = 1; i < rows.length; i++)
            if (rows[i].ghost && rows[i - 1].ghost && rows[i].ghost.opacity > rows[i - 1].ghost.opacity + 0.02 && i !== step2) rising += 1;
          for (const r of rows) {
            if (!r.answer && r.headOpacity !== null) headDip = Math.min(headDip, r.headOpacity);
            if (!r.ghost || r.ghost.opacity <= 0.02) continue;
            if (!r.answer && r.repliedBlock && r.askOpacity !== null) both1 = Math.max(both1, r.askOpacity);
            if (r.answer && r.answerOpacity !== null) both2 = Math.max(both2, r.answerOpacity);
          }
          const ghostRows = rows.filter((r) => r.ghosts);
          const lastGhost = ghostRows.at(-1)?.t ?? null;
          const settledRow = step2 >= 0 ? rows.find((r) => r.answer && r.t >= first2.t + OUT_MS + IN_MS + 100) : null;
          const plays = [...new Set(rows.flatMap((r) => r.anims.map((a) => `${a.on}:${a.props}:${a.duration}:${a.delay}`)))];
          // Every size change from the press on is the card's own resize: none at once (a reply being sent included).
          const sized = (r) => r.anims.some((a) => a.on === "card" && a.props.includes("height"));
          const jumps = rows.filter((r, i) => i > 0 && Math.abs(r.height - rows[i - 1].height) > 4 && !sized(r) && !sized(rows[i - 1]))
            .map((r) => ({ t: r.t, height: r.height }));
          y.through = { step1: first1 && { t: first1.t, ghost: first1.ghost }, step2: first2 && { t: first2.t, ghost: first2.ghost }, rising, both1, both2, headDip, jumps,
            heights: rows.map((r) => [r.t, r.height]),
            maxGhosts: Math.max(...rows.map((r) => r.ghosts)), focusInGhost: rows.some((r) => r.focusInGhost), lastGhost, settled: settledRow?.answerOpacity ?? null, plays };
          ok(`${tag}: reply, step 1: the form fades out (a copy) over the reply block`,
            !!first1?.ghost && first1.ghost.opacity >= 0.85 && first1.ghost.options && sound(first1.ghost), y.through.step1);
          ok(`${tag}: reply, step 2: the Ask fades out (a copy) over its answer card`,
            !!first2?.ghost && first2.ghost.opacity >= 0.85 && first2.ghost.body && sound(first2.ghost), y.through.step2);
          ok(`${tag}: the copies only fade out, one at a time, never focused, gone by out after step 2`,
            rising === 0 && y.through.maxGhosts <= 1 && !y.through.focusInGhost && lastGhost !== null && step2 >= 0 && lastGhost <= first2.t + OUT_MS + 150, y.through);
          ok(`${tag}: while the old is seen (copy > 0.02) the new where it changes is not (≤ 0.02: step 1 ${both1.toFixed(3)}, step 2 ${both2.toFixed(3)})`,
            step1 >= 0 && step2 >= 0 && both1 <= 0.02 && both2 <= 0.02, y.through);
          ok(`${tag}: step 1 changes only the reply area: the card's head never fades (min ${headDip})`, headDip === 1, y.through);
          ok(`${tag}: from the press on, the card's edge never moves at once (${jumps.length} jumps)`, jumps.length === 0, { jumps, heights: y.through.heights.slice(0, 40) });
          ok(`${tag}: the new has faded in by out + in after the change`, settledRow?.answerOpacity === 1, y.through);
          ok(`${tag}: its pace: the edge over ${CARD_MS} ms, the old out over ${OUT_MS}, the new in over ${IN_MS} after ${OUT_MS}`,
            plays.some((x) => x.startsWith("card:height") && x.endsWith(`:${CARD_MS}:0`)) && plays.includes(`ghost:opacity:${OUT_MS}:0`)
              && plays.some((x) => x.endsWith(`:opacity:${IN_MS}:${OUT_MS}`)) && rows.every((r) => r.anims.every((a) => !a.props.includes("height") || a.duration === CARD_MS)), plays);
        }
        if (scene === "open-after-out") {
          await fresh();
          await answer();
          await idle();
          const rows = await card().evaluate((c) => new Promise((done) => {
            const button = [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details"));
            const body = c.querySelector(":scope > .home-card-body");
            const answer = c.querySelector(":scope > .home-answer");
            const out = [];
            const t0 = performance.now();
            button.click();
            const step = () => {
              out.push([Math.round(performance.now() - t0), Number(getComputedStyle(body).opacity), body.hidden, Number(getComputedStyle(answer).opacity), getComputedStyle(body).pointerEvents]);
              if (performance.now() - t0 < 1000) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }));
          const early = rows.filter((r) => r[0] < OUT_MS - 20);
          const late = rows.filter((r) => r[0] >= OUT_MS + IN_MS + 80);
          const answerMin = Math.min(...rows.map((r) => r[3]));
          y.openAfterOut = { early: early.map((r) => [r[1], r[4]]), late: late.slice(0, 2), answerMin };
          ok(`${tag}: Question and details: the body stays unseen and takes no pointer until the old has faded out (${OUT_MS} ms), then fades in`,
            early.length > 0 && early.every((r) => r[1] <= 0.02 && r[4] === "none") && late.length > 0 && late[0][1] === 1 && late[0][4] === "auto", y.openAfterOut);
          ok(`${tag}: opening changes only the body: the answer part never fades (min ${answerMin})`, answerMin === 1, y.openAfterOut);
        }
        if (scene === "close") {
          await fresh();
          await answer();
          await idle();
          await toggle().click();
          await idle();
          const rows = await card().evaluate((c) => new Promise((done) => {
            const button = [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details"));
            const out = [];
            const t0 = performance.now();
            button.click();
            const step = () => {
              const g = c.querySelector(":scope > .card-ghost");
              out.push({ t: Math.round(performance.now() - t0), top: Math.round(button.getBoundingClientRect().top * 10) / 10, hidden: c.querySelector(":scope > .home-card-body").hidden,
                ghost: g ? { opacity: Number(getComputedStyle(g).opacity), body: g.textContent.includes("Part 3.") } : null });
              if (performance.now() - t0 < 900) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }));
          const tops = rows.map((r) => r.top);
          y.close = { first: rows[0], last: rows.at(-1), moved: Math.max(...tops) - Math.min(...tops) };
          ok(`${tag}: closing details: the body fades out in the copy as the card closes, none left`,
            rows[0].hidden === true && !!rows[0].ghost?.body && rows[0].ghost.opacity >= 0.85 && rows.at(-1).ghost === null, y.close);
          ok(`${tag}: closing, Question and details stays under the pointer (moves < 2 px)`, y.close.moved < 2, y.close);
        }
        if (scene === "svg-ids") {
          await fresh();
          await answer();
          await idle();
          await toggle().click();
          await idle();
          // A picture whose parts name each other by id, and a label for a field: in the copy each finds its own.
          await card().evaluate((c) => {
            const holder = document.createElement("div");
            holder.className = "yn203-ids-probe";
            holder.innerHTML = `<svg width="120" height="40" viewBox="0 0 120 40"><defs><linearGradient id="probe-fill"><stop offset="0" stop-color="#3a7"/><stop offset="1" stop-color="#37a"/></linearGradient>`
              + `<marker id="probe-tip" markerWidth="6" markerHeight="6" refX="3" refY="3"><circle cx="3" cy="3" r="3"/></marker><clipPath id="probe-clip"><rect width="100" height="40"/></clipPath></defs>`
              + `<rect id="probe-box" width="120" height="20" fill="url(#probe-fill)" clip-path="url(#probe-clip)"/><path d="M5 30 H100" stroke="#333" marker-end="url(#probe-tip)" style="fill: url('#probe-fill')"/>`
              + `<use href="#probe-box" y="20"/></svg><label for="probe-field">Probe</label><input id="probe-field">`;
            c.querySelector(":scope > .home-card-body").prepend(holder);
          });
          const seen = await card().evaluate((c) => new Promise((done) => {
            const button = [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details"));
            button.click();
            requestAnimationFrame(() => {
              const g = c.querySelector(":scope > .card-ghost");
              const probe = g?.querySelector(".yn203-ids-probe");
              if (!probe) return done(null);
              const ids = [...probe.querySelectorAll("[id]")].map((e) => e.id);
              const refs = [];
              for (const e of probe.querySelectorAll("*"))
                for (const a of e.attributes) {
                  if (a.localName === "href" && a.value.startsWith("#")) refs.push(a.value.slice(1));
                  else if (a.name === "for") refs.push(a.value);
                  else for (const hit of a.value.matchAll(/url\(\s*['"]?#([^'")]+?)['"]?\s*\)/g)) refs.push(hit[1]);
                }
              const own = c.querySelector(":scope > .home-card-body .yn203-ids-probe");
              done({
                ids, refs, unresolved: refs.filter((id) => { const t = document.getElementById(id); return !t || !g.contains(t); }),
                shared: ids.filter((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length > 1),
                // The card's own picture still finds its own parts.
                ownIntact: own.querySelector("rect[id]").getAttribute("fill") === "url(#probe-fill)" && own.contains(document.getElementById("probe-fill")) && own.contains(document.getElementById("probe-field")),
              });
            });
          }));
          y.svgIds = seen;
          ok(`${tag}: the copy's ids are its own: none shared with the page, each href="#…", url(#…) and label's for in it finds its part in the copy, the card's own intact`,
            !!seen && seen.ids.length === 5 && seen.refs.length === 6 && seen.unresolved.length === 0 && seen.shared.length === 0 && seen.ownIntact, seen);
        }
        if (scene === "scroll-copy") {
          await fresh();
          await answer();
          await idle();
          await toggle().click();
          await idle();
          // Media before a scrolled box: the copy has a stand-in for the media and keeps the box's scroll.
          await card().evaluate((c) => {
            const body = c.querySelector(":scope > .home-card-body");
            const video = document.createElement("video");
            for (let i = 0; i < 3; i++) video.append(document.createElement("source"));
            video.style.cssText = "display:block;width:120px;height:40px";
            const box = document.createElement("div");
            box.className = "yn203-scroll-probe";
            box.style.cssText = "height:60px;overflow:auto";
            for (let i = 0; i < 30; i++) { const p = document.createElement("p"); p.textContent = `row ${i}`; box.append(p); }
            body.prepend(box);
            body.prepend(video);
            box.scrollTop = 50;
          });
          const seen = await card().evaluate((c) => new Promise((done) => {
            [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details")).click();
            requestAnimationFrame(() => {
              const g = c.querySelector(":scope > .card-ghost");
              const copy = g?.querySelector(".yn203-scroll-probe");
              done({ ghost: !!g, scrollTop: copy ? copy.scrollTop : null, media: g ? g.querySelectorAll("video, source").length : null });
            });
          }));
          await idle();
          y.scrollCopy = seen;
          ok(`${tag}: the copy keeps an inner box's scroll with media before it replaced (scrollTop 50, no media in the copy)`,
            seen.ghost && seen.scrollTop === 50 && seen.media === 0, seen);
        }
        if (scene === "rapid") {
          await fresh();
          await answer();
          await idle();
          const pending = frames(1200);
          for (let i = 0; i < 6; i++) {
            await toggle().evaluate((b) => b.click());
            await page.waitForTimeout(40);
          }
          const rows = await pending;
          const s = await idle();
          y.rapid = { maxGhosts: Math.max(...rows.map((r) => r.ghosts)), maxDeep: Math.max(...rows.map((r) => r.deep)), settled: s };
          ok(`${tag}: six presses 40 ms apart: one copy at most, never nested deeper than one, none left, closed`,
            y.rapid.maxGhosts <= 1 && y.rapid.maxDeep === 0 && settledShut(s) && s.expanded === "false" && s.hidden === true, y.rapid);
        }
        if (scene === "unseen-press") {
          // In the first frame the answer card is drawn its Reply again is still unseen: a press where it is lands on
          // what a pointer would hit there, which must not be it.
          // The card's top at the view's top, so the answer card is drawn in the window from its first frame; the
          // option pressed where it is, with nothing scrolled.
          await fresh();
          await card().evaluate((c) => c.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.waitForTimeout(150);
          const hit = card().evaluate((c) => new Promise((done) => {
            const t0 = performance.now();
            const step = () => {
              const button = c.classList.contains("is-answer") && [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Reply again"));
              if (!button) return void (performance.now() - t0 < 5000 ? requestAnimationFrame(step) : done(null));
              const r = button.getBoundingClientRect();
              const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              const info = { t: Math.round(performance.now() - t0), answerOpacity: Number(getComputedStyle(c.querySelector(":scope > .home-answer")).opacity),
                hitIsButton: !!target && button.contains(target), hit: target ? `${target.tagName}.${String(target.className).slice(0, 40)}` : null };
              target?.click();
              done(info);
            };
            requestAnimationFrame(step);
          }));
          await option().evaluate((b) => b.click());
          const at = await hit;
          await page.waitForTimeout(900);
          const s = await idle();
          y.unseenPress = { at, settled: s };
          ok(`${tag}: a press on Reply again while it is unseen (the answer card's first frame) reaches something else and does nothing`,
            !!at && at.hit !== null && at.answerOpacity <= 0.02 && !at.hitIsButton && !s.open && s.hidden === true, y.unseenPress);
        }
        if (scene.startsWith("again@")) {
          const after = Number(scene.slice(6));
          await fresh();
          await answer();
          await page.waitForTimeout(after);
          const atPress = await look();
          await pressAt(again());
          await page.waitForTimeout(900);
          const s = await idle();
          const focusIn = await card().evaluate((c) => !!c.querySelector(":scope > .home-card-body")?.contains(document.activeElement));
          y[scene] = { atPress, settled: s, focusIn };
          ok(`${tag}: Reply again ${after} ms into the answer card's change opens the form, focus in it${motion("", ", at once")}`,
            atPress.answer && s.open && s.hidden === false && s.form >= 1 && s.opacity === 1 && s.ghosts === 0 && focusIn
              && (!run.reduced || atPress.anims.length === 0), y[scene]);
        }
        if (scene === "details-fast") {
          await fresh();
          await answer();
          await idle();
          for (let i = 0; i < 3; i++) {
            await pressAt(toggle());
            if (i < 2) await page.waitForTimeout(90);
          }
          const s = await idle();
          y.detailsFast = s;
          ok(`${tag}: three fast presses on Question and details end open and consistent`,
            s.expanded === "true" && s.hidden === false && s.opacity === 1 && s.anims.length === 0 && s.ghosts === 0 && s.pointer === "auto", s);
        }
        if (scene === "restart") {
          // Its body part way in, Core sends a new version of the card: the body starts again from nothing, unseen
          // and taking no pointer while the copy (the body as it was, part way in) fades out; never both at once.
          await fresh();
          await answer();
          await idle();
          atlas = { ...atlas, version: atlas.version + 1, body: atlasBody("Owner's update: the release waits for the signed build.") };
          const rows = await card().evaluate((c) => new Promise((done) => {
            const button = [...c.querySelectorAll(":scope > .home-answer button")].find((b) => b.textContent.includes("Question and details"));
            const out = [];
            const t0 = performance.now();
            let asked = false;
            button.click();
            const step = () => {
              const row = { t: Math.round(performance.now() - t0), ...window.__card(c) };
              if (!asked && row.hidden === false && row.opacity >= 0.3 && row.opacity <= 0.8) {
                asked = row.asked = true;
                document.querySelector('[aria-label="Refresh Home"]').click();
              }
              out.push(row);
              if (performance.now() - t0 < 2000) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }));
          const asked = rows.findIndex((r) => r.asked);
          const change = rows.findIndex((r, i) => i > asked && asked >= 0 && r.ghosts > 0);
          const from = change > 0 ? rows[change - 1].opacity : null;
          const after = change >= 0 ? rows.slice(change) : [];
          const crossing = Math.max(0, ...after.filter((r) => r.ghost && r.ghost.opacity > 0.02).map((r) => r.opacity));
          const unseen = after.filter((r) => r.t < rows[change].t + OUT_MS - 30);
          const end = after.find((r) => r.t >= rows[change].t + OUT_MS + IN_MS + 100);
          y.restart = { asked: rows[asked]?.t ?? null, change: rows[change]?.t ?? null, from, crossing, unseen: unseen.map((r) => [r.t, r.opacity, r.pointer]),
            end: end && { opacity: end.opacity, pointer: end.pointer, pointerStyle: end.pointerStyle, text: end.realText.includes("Owner's update"), ghosts: end.ghosts } };
          ok(`${tag}: a body changed again part way in (from ${from}) starts again from nothing: never seen with its copy (≤ 0.02: ${crossing.toFixed(3)}), taking no pointer until the copy is gone`,
            change > 0 && from > 0.05 && from < 0.99 && crossing <= 0.02 && unseen.length > 0 && unseen.every((r) => r.opacity <= 0.02 && r.pointer === "none")
              && !!end && end.opacity === 1 && end.pointer === "auto" && end.pointerStyle === "" && end.realText.includes("Owner's update") && end.ghosts === 0, y.restart);
        }
        if (scene === "reduced-toggle") {
          await fresh();
          await answer();
          await idle();
          await toggle().click();
          await page.waitForTimeout(60);
          await toggle().evaluate((b) => b.click());
          await page.waitForTimeout(40);
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.waitForTimeout(50);
          const closing = await look();
          await toggle().evaluate((b) => b.click());
          await page.waitForTimeout(60);
          const reopened = await look();
          await toggle().evaluate((b) => b.click());
          await page.waitForTimeout(60);
          const closed = await look();
          await page.emulateMedia({ reducedMotion: "no-preference" });
          y.reducedToggle = { closing, reopened, closed };
          ok(`${tag}: reduced motion turned on while closing: every animation and the copy stop at once`,
            closing.expanded === "false" && closing.hidden === true && closing.anims.length === 0 && closing.ghosts === 0 && !closing.resizing && closing.pointer === "auto", closing);
          ok(`${tag}: then it opens and closes at once, with no copy`,
            reopened.expanded === "true" && reopened.hidden === false && reopened.anims.length === 0 && reopened.ghosts === 0 && reopened.pointer === "auto"
              && closed.expanded === "false" && closed.hidden === true && closed.anims.length === 0 && closed.ghosts === 0, { reopened, closed });
        }
        if (scene === "reduced-midway") {
          await fresh();
          await answer();
          const before = await look();
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.waitForTimeout(50);
          const s = await look();
          await page.emulateMedia({ reducedMotion: "no-preference" });
          y.reducedMidway = { before, after: s };
          ok(`${tag}: reduced motion turned on mid-change (the system setting) stops every animation, the copy included`,
            before.anims.length > 0 && s.anims.length === 0 && s.ghosts === 0 && !s.resizing && s.answer, y.reducedMidway);
        }
        if (scene === "reduced-scroll") {
          // Reply again with the card at the window's foot (the window made as short as that: Needs you is at Home's
          // top): its field, below, is brought into view smoothly once the card has its height; reduced motion turned
          // on while that scroll is under way puts it at its end at once.
          await fresh();
          await answer();
          await idle();
          const foot = await card().evaluate((c) => Math.ceil(c.getBoundingClientRect().bottom + 4));
          await page.setViewportSize({ width: run.viewport.width, height: Math.max(foot, 320) });
          await page.waitForTimeout(300);
          const start = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
          await pressAt(again());
          const moving = await page.evaluate((start) => new Promise((done) => {
            const view = document.querySelector(".home-view");
            const t0 = performance.now();
            const step = () => {
              if (view.scrollTop !== start) return done({ at: Math.round(performance.now() - t0), top: view.scrollTop });
              if (performance.now() - t0 > 2500) return done(null);
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }), start);
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.waitForTimeout(60);
          const a = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
          await page.waitForTimeout(120);
          const b = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
          const focus = await page.evaluate(() => {
            const f = document.activeElement.getBoundingClientRect(), v = document.querySelector(".home-view").getBoundingClientRect();
            return { tag: document.activeElement.tagName, inView: f.top >= v.top - 1 && f.bottom <= Math.min(v.bottom, innerHeight) + 1, top: Math.round(f.top), bottom: Math.round(f.bottom), viewBottom: Math.round(v.bottom) };
          });
          const s = await look();
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await page.setViewportSize(run.viewport);
          y.reducedScroll = { foot, start, moving, scroll: [a, b], focus, after: s };
          ok(`${tag}: reduced motion turned on while the focus is being scrolled to: at its end at once, standing still, the field in view`,
            !!moving && moving.at >= CARD_MS - 50 && a === b && focus.inView && s.anims.length === 0 && s.ghosts === 0, y.reducedScroll);
        }
        if (scene === "non-dom") {
          await fresh();
          await answer();
          await idle();
          await pressAt(toggle());
          await page.waitForTimeout(60);
          const rows = await card().evaluate((c) => new Promise((done) => {
            c.querySelector(":scope > .home-card-body").style.paddingBottom = "160px";
            const out = [];
            const t0 = performance.now();
            const step = () => {
              out.push([Math.round(performance.now() - t0), Math.round(c.getBoundingClientRect().height * 10) / 10]);
              if (performance.now() - t0 < 1400) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }));
          // From the opening's slow end on (it began 60 ms before these frames; a tall card's opening takes big steps
          // early): the 160 px it did not make must not come in one step.
          let largest = 0;
          for (let i = 1; i < rows.length; i++) if (rows[i][0] >= CARD_MS - 120) largest = Math.max(largest, Math.abs(rows[i][1] - rows[i - 1][1]));
          const s = await idle();
          y.nonDom = { largest, from: CARD_MS - 120, rows: rows.length, settled: s };
          ok(`${tag}: a 160 px change React did not make (a size of its own) glides on at the end (largest frame step < 100 px)`, largest < 100 && !s.resizing, y.nonDom);
        }
        if (scene === "chase") {
          await fresh();
          await answer();
          await idle();
          await pressAt(toggle());
          const result = await card().evaluate((c) => new Promise((done) => {
            const body = c.querySelector(":scope > .home-card-body");
            const extra = document.createElement("div");
            body.append(extra);
            const t0 = performance.now();
            let i = 0, last = 0, started = 0;
            const seen = new WeakSet();
            const tick = setInterval(() => { i += 1; extra.textContent = "x ".repeat((i * 37) % 400); body.style.paddingBottom = `${(i * 23) % 120}px`; }, 40);
            const step = () => {
              const now = performance.now() - t0;
              for (const a of c.getAnimations()) if ("height" in (a.effect.getKeyframes()[0] ?? {})) {
                if (!seen.has(a)) { seen.add(a); started += 1; }
                if (a.playState === "running") last = now;
              }
              if (now < 4000) requestAnimationFrame(step);
              else { clearInterval(tick); extra.remove(); body.style.paddingBottom = ""; done({ lastHeightAnimMs: Math.round(last), resizesStarted: started }); }
            };
            requestAnimationFrame(step);
          }));
          y.chase = { ...result, bound: 3 * CARD_MS + 60 };
          ok(`${tag}: endless size changes are followed only within the act's time and one glide (no height animation after 3 × ${CARD_MS} ms)`,
            result.lastHeightAnimMs <= 3 * CARD_MS + 60, y.chase);
        }
        if (scene === "hidden-top") {
          // Replied from its foot with its top above the view: the answer card ends in view, where the reply was sent from.
          await fresh();
          await card().evaluate((c) => {
            const view = c.closest(".home-view");
            const button = c.querySelector(".home-ask-options button");
            view.scrollTop += button.getBoundingClientRect().bottom - Math.min(view.getBoundingClientRect().bottom, innerHeight) + 140;
          });
          await page.waitForTimeout(300);
          const before = await look();
          await pressAt(option());
          await page.locator(`${sel}.is-answer`).waitFor({ state: "attached", timeout: 8000 });
          const s = await idle();
          y.hiddenTop = { before, settled: s };
          ok(`${tag}: a long card replied from its foot, its top above the view, ends in view`,
            before.top < before.viewTop && s.answer && s.top >= s.viewTop - 1 && s.top < s.viewBottom, y.hiddenTop);
        }
        if (scene === "report-reply") {
          // A report's Reply on its project's page (its summary card): opened, a draft written, closed with ✕, opened
          // again (the draft kept), closed with Escape, opened again and sent. Each step's frames from just before it.
          await fresh("p1");
          sel = REPORT;
          await card().evaluate((c) => c.scrollIntoView({ block: "center", behavior: "instant" }));
          await page.waitForTimeout(250);
          const sized = (r) => r.anims.some((a) => a.on === "card" && a.props.includes("height"));
          const jumpsOf = (rows) => rows.filter((r, i) => i > 0 && Math.abs(r.height - rows[i - 1].height) > 4 && !sized(r) && !sized(rows[i - 1]))
            .map((r) => ({ t: r.t, height: r.height }));
          // While a copy is seen (> 0.02), the reply (new) is not (≤ 0.02): its most seen then.
          const crossing = (rows) => Math.max(0, ...rows.filter((r) => r.ghost && r.ghost.opacity > 0.02 && r.replyOpacity !== null).map((r) => r.replyOpacity));
          const still = (rows) => rows.every((r) => r.anims.length === 0 && r.ghosts === 0);
          const step = async (act, ms = 1300) => {
            const pending = frames(ms);
            await act();
            const rows = await pending;
            return { rows, end: await idle() };
          };
          const replyButton = () => page.locator(`${sel} .home-reply-open`);
          const field = () => page.locator(`${sel} > .home-card-reply`).locator("[data-composer-input], textarea").first();
          const draftText = () => field().evaluate((f) => ("value" in f ? f.value : f.textContent) ?? "");
          const words = "Looks right; ship it after the signed build.";
          const shut = await look();
          const open = await step(() => pressAt(replyButton()));
          await page.keyboard.type(words);
          const closed = await step(() => pressAt(page.locator(`${sel} > .home-card-reply button.icon-button[aria-label^="Close the reply"]`)));
          const reopened = await step(() => pressAt(replyButton()));
          const kept = await draftText();
          const escaped = await step(() => page.keyboard.press("Escape"));
          const again = await step(() => pressAt(replyButton()));
          const before = report.replies.length;
          const sent = await step(() => pressAt(page.locator(`${sel} > .home-card-reply form button[type="submit"]`)), 1600);
          await until(() => report.replies.length > before, "the report's reply sent");
          await page.waitForTimeout(300);
          const delivered = report.replies.slice(before);
          const after = { ...(await look()), draft: await draftText().catch(() => null) };
          const brief = (x) => ({ jumps: jumpsOf(x.rows), crossing: crossing(x.rows), still: still(x.rows), heights: [x.rows[0]?.height, x.end.height],
            end: { height: x.end.height, reply: x.end.replyOpacity, focus: x.end.focus, ghosts: x.end.ghosts, anims: x.end.anims.length } });
          y.reportReply = { shut: { height: shut.height, focus: shut.focus }, open: brief(open), closed: brief(closed), reopened: brief(reopened), kept,
            escaped: brief(escaped), again: brief(again), sent: brief(sent), delivered,
            after: { height: after.height, reply: after.replyOpacity, focus: after.focus, draft: after.draft, kind: await card().evaluate((c) => c.className) } };
          const settled = (x) => x.end.anims.length === 0 && x.end.ghosts === 0;
          // The edge moves, never at once, under normal motion; nothing moves under reduced (there it is at its end at once).
          const moved = (x) => (run.reduced ? still(x.rows) : jumpsOf(x.rows).length === 0 && x.rows.some(sized));
          const opened = (x) => moved(x) && crossing(x.rows) <= 0.02 && settled(x) && x.end.replyOpacity === 1 && x.end.focus === "reply-field";
          const shutAgain = (x) => moved(x) && settled(x) && x.end.replyOpacity === null && x.end.focus === "reply-button" && Math.abs(x.end.height - shut.height) <= 1;
          ok(`${tag}: a report's Reply opens ${motion("with its edge moving (never at once), the reply fading in only once the copy is gone", "at once, nothing moving")}, focus in its field`,
            opened(open), y.reportReply.open);
          ok(`${tag}: closed with ✕ ${motion("with its edge moving back", "at once")}: focus on Reply, the card as tall as before`, shutAgain(closed), { shut: y.reportReply.shut, closed: y.reportReply.closed });
          ok(`${tag}: opened again, the draft written before is in its field, focus there`, opened(reopened) && kept.includes(words), { reopened: y.reportReply.reopened, kept });
          ok(`${tag}: Escape closes it ${motion("with its edge moving back", "at once")}: focus on Reply, the card as tall as before`, shutAgain(escaped), { shut: y.reportReply.shut, escaped: y.reportReply.escaped });
          ok(`${tag}: opened again and sent: one reply to its author, with its words, on the report's version; the card's edge never moving at once; still the report's card`,
            opened(again) && moved(sent) && settled(sent)
              && delivered.length === 1 && delivered[0].key === "p1-r1" && delivered[0].agentId === "a" && delivered[0].text === words && delivered[0].version === 1
              && delivered[0].choice === null && delivered[0].askVersion === null && /\bkind-report\b/.test(y.reportReply.after.kind),
            { again: y.reportReply.again, sent: y.reportReply.sent, delivered, after: y.reportReply.after });
        }
        if (scene === "deck") {
          // On its project's page, in a cell of the deck: reply, Reply again, Question and details twice, fast.
          await fresh("p1");
          const cols = await card().evaluate((c) => c.closest("[data-deck-cols]")?.getAttribute("data-deck-cols") ?? c.getAttribute("data-deck-cols"));
          await answer();
          const settled = await idle();
          await pressAt(again());
          await page.waitForTimeout(900);
          const opened = await idle();
          const focusIn = await card().evaluate((c) => !!c.querySelector(":scope > .home-card-body")?.contains(document.activeElement));
          await toggle().evaluate((b) => b.click());
          await page.waitForTimeout(90);
          await toggle().evaluate((b) => b.click());
          const toggled = await idle();
          y.deck = { cols, settled, opened, focusIn, toggled };
          ok(`${tag}: on the project's deck, reply, Reply again and Question and details twice all settle consistently, no copy left${motion("", ", at once")}`,
            settledShut(settled) && opened.open && opened.form >= 1 && opened.ghosts === 0 && focusIn
              && toggled.expanded === "true" && toggled.hidden === false && toggled.opacity === 1 && toggled.ghosts === 0 && toggled.anims.length === 0, y.deck);
        }
      } catch (error) {
        ok(`${tag}: ${scene} ran`, false, String(error).slice(0, 400));
      }
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
ok("nothing was written but the replies sent on purpose", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(path.join(output, "home-card-motion-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exit(1);
