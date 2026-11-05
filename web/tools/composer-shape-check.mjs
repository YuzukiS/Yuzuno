// T-44 (Lead 2 3967, plan 3966), in Chromium on a production build of the app with a synthetic Workspace and
// every API answered here (no Core, no Agent). The composer sizes itself as the ChatGPT app's does:
// - empty or one short line, it is one line, with "+", the text and Send on one row;
// - three lines make a block: the text above at the full width, with "+" and Send below where they were;
// - past the cap (desktop min(12 lines, 40dvh), phone min(8 lines, 30dvh)) the text scrolls inside.
// Typing to the edge switches once each way, the way back only after the margin. "+" and Send keep their
// place, focus and the caret stay, and nothing animates the switch or a height.
// Each placeholder reads whole: on one line when it fits, otherwise in a block. A draft restored from
// storage opens in its shape from its first frame.
// "+" is one menu (Add images, Mark up an image, Ask for an interactive result) that works from the
// keyboard and moves like the app's other small menus. Images still come in by paste and by drop, without
// the menu. An image, a skill chip, an error line or the waiting-for-your-answer notice under the text
// keeps the box a block. Codex's Plan mode sign sits beside Send.
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: none but the images
// uploaded, which are answered here; anything else but a read is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/composer-shape-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/composer-shape");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], unknownGets: [], writes: [], uploads: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const WORKSPACE = "ws-shape";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, connectionState: "connected", projectId: "p", goal: "" };
const agents = [
  { id: "a", name: "Mori", status: "idle", threadId: "th-a" },
  { id: "k", name: "Kai", status: "working", threadId: "th-k" },
  { id: "l", name: "Lumi", status: "working", harness: "claude", threadId: "th-l" },
  { id: "p", name: "Pia", status: "waiting", threadId: "th-p" },
  { id: "t", name: "Tui", status: "idle", threadId: "th-t" },
  { id: "r", name: "Ren", status: "idle", threadId: "th-r" },
  { id: "s", name: "Sol", status: "idle", threadId: "th-s" },
  { id: "d", name: "Ada", status: "idle", threadId: "th-d" },
].map((agent) => ({ ...base, ...agent }));
const done = (id) => ({ id, status: "completed", items: [
  { id: `${id}-u`, type: "userMessage", content: [{ type: "text", text: "Tidy the fixture notes." }] },
  { id: `${id}-r`, type: "agentMessage", text: "Done." },
] });
const running = (id) => ({ id, status: "inProgress", items: [
  { id: `${id}-u`, type: "userMessage", content: [{ type: "text", text: "Sort the fixture list." }] },
] });
const question = { id: "ask-p", agentId: "p", method: "item/tool/requestUserInput", createdAt: "",
  params: { threadId: "th-p", turnId: "p2", itemId: "ask-1", questions: [{ id: "pick", question: "Which list comes first?",
    options: [{ label: "Notes", description: "the notes" }, { label: "Tasks", description: "the tasks" }] }] } };
const plan = { generation: 4, reported: { mode: "plan", source: "settings", observedAt: "2026-10-22T00:00:00Z" }, switch: null };
const detail = (agent) => ({ agent, messageReceipts: [], artifacts: [],
  pending: agent.id === "p" ? [question] : [],
  // Lumi (Claude) works with no Turn of its own running: a draft waits for the turn to end.
  turns: [done(`${agent.id}1`), ...(agent.status === "idle" || agent.id === "l" ? [] : [running(`${agent.id}2`)])],
  ...(agent.id === "d" ? { codexPlan: plan } : {}) });
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns,
  "/api/ci/live": noCiRuns, "/api/reviews": noReviews, "/api/home": { generatedAt: "", order: [], needsYou: [], projects: [] },
};
for (const agent of agents) {
  gets[`/api/agents/${agent.id}`] = detail(agent);
  gets[`/api/agents/${agent.id}/codex/usage`] = usage;
  gets[`/api/agents/${agent.id}/codex/mcp`] = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
  gets[`/api/agents/${agent.id}/conversation/inputs`] = noConversationInputs;
  gets[`/api/agents/${agent.id}/reading`] = { handoff: null };
}
gets["/api/agents/s/codex/skills"] = { state: "ready", reason: "", source: "session", sessionId: null, total: 1, truncated: false, skillsKnown: true,
  commands: [{ name: "tidy-notes", description: "Tidy the notes", argumentHint: "", aliases: [], source: "skill",
    path: "/fixture/.codex/skills/tidy-notes/SKILL.md", scope: "repo" }] };
// Drafts this browser kept (composer-draft.ts): Tui's three lines, Ren's and Sol's one short line.
const TUI = ["Check the notes", "then the tasks", "then the list"];
// Each placeholder and its short form, shown where the long one does not fit the line (Lead 2 4757).
const PLACEHOLDERS = {
  Mori: ["A task, a question, a new idea for Mori…", "Message Mori…"],
  Kai: ["Add a thought while your agent works…", "Add a thought…"],
  Lumi: ["Your draft will be ready when this turn finishes…", "Draft for after this turn…"],
};
const REN = "Sort by date";
const SOL = "Use the skill";
const saved = (agent, text, extra = {}) => [`yuzuno.composer.v1:${JSON.stringify([WORKSPACE, agent])}`,
  JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text }], ...extra })];
const stored = Object.fromEntries([
  saved("t", TUI.join("\n")),
  saved("r", REN),
  saved("s", SOL),
]);

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
let uploaded = 0;
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    const image = url.pathname.match(/^\/api\/agents\/([a-z])\/images(?:\/(.+))?$/);
    if (image && request.method() === "POST" && !image[2]) {
      report.uploads.push(`POST ${url.pathname} ${request.headers()["content-type"]}`);
      const id = (++uploaded).toString(16).padStart(64, "0") + ".png";
      return route.fulfill({ json: { id, width: 1, height: 1, bytes: PNG.length } });
    }
    if (image && request.method() === "GET" && image[2]) return route.fulfill({ body: PNG, contentType: "image/png" });
    if (request.method() === "PUT" && /^\/api\/agents\/[a-z]\/reading$/.test(url.pathname)) return route.fulfill({ json: { accepted: true } });
    if (request.method() === "POST" && url.pathname === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const json = gets[url.pathname];
    if (json) return route.fulfill({ json });
    if (!report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
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

/** In the page: the composer's geometry, what plays in it, and each frame's shape from the first. */
function pageHelpers({ stored, workspace, select }) {
  window.EventSource = class { close() {} addEventListener() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  if (!sessionStorage.getItem("shape-check-seeded")) {
    sessionStorage.setItem("shape-check-seeded", "1");
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
    if (select) localStorage.setItem(`yuzuno.selected.${workspace}`, JSON.stringify(select));
  }
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom };
  };
  const form = () => document.querySelector("form.composer");
  window.__geom = () => {
    const box = form();
    if (!box) return null;
    const content = box.querySelector(".cm-content");
    const scroller = box.querySelector(".cm-scroller");
    const hint = box.querySelector(".composer-hint");
    const line = content?.querySelector(".cm-line");
    const range = document.createRange();
    if (line) range.selectNodeContents(line);
    const sel = getSelection();
    let caretAtEnd = false;
    if (sel?.rangeCount && sel.isCollapsed && content?.contains(sel.focusNode)) {
      const rest = document.createRange();
      rest.setStart(sel.focusNode, sel.focusOffset);
      rest.setEnd(content, content.childNodes.length);
      caretAtEnd = rest.toString() === "";
    }
    const style = content && getComputedStyle(content);
    // The line's room, worked out as styles.css lays a line out (composer-shape.ts does the same).
    const vars = getComputedStyle(box);
    const px = (name) => parseFloat(vars.getPropertyValue(name)) || 0;
    const room = box.clientWidth - (box.querySelector(".composer-tools")?.getBoundingClientRect().width ?? 0)
      - (box.querySelector(".composer-send-actions")?.getBoundingClientRect().width ?? 0)
      - px("--composer-inset-start") - px("--composer-inset-end") - 2 * px("--composer-line-text-x");
    // A text's width in the editor's font.
    const measureText = (text) => {
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return context.measureText(text).width;
    };
    return {
      room, measureText: Object.fromEntries((window.__measure ?? []).map((text) => [text, measureText(text)])),
      shape: box.dataset.shape ?? null, label: content?.getAttribute("aria-label") ?? null,
      form: rect(box), plus: rect(box.querySelector(".composer-plus")), send: rect(box.querySelector(".send-button")),
      editor: rect(box.querySelector(".pasted-text-composer")), content: rect(content),
      contentBox: content && { left: content.getBoundingClientRect().left + parseFloat(style.paddingLeft), right: content.getBoundingClientRect().right - parseFloat(style.paddingRight) },
      scroller: scroller && { ...rect(scroller), clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop,
        overflowY: getComputedStyle(scroller).overflowY },
      firstLine: line ? { ...rect(range), text: line.textContent } : null,
      placeholder: rect(box.querySelector(".cm-placeholder")), placeholderText: box.querySelector(".cm-placeholder")?.textContent ?? null,
      lineHeight: style ? parseFloat(style.lineHeight) : null, innerHeight,
      hintShown: !!hint && getComputedStyle(hint).display !== "none" && hint.getBoundingClientRect().width > 0,
      notice: box.querySelector(".composer-hint[data-notice]")?.textContent ?? null,
      noticeRect: rect(box.querySelector(".composer-hint[data-notice]")),
      focus: !!content && content.contains(document.activeElement) || document.activeElement === content,
      caretAtEnd,
      mode: rect(box.querySelector(".composer-send-actions .composer-mode")),
      modeInTools: !!box.querySelector(".composer-tools .composer-mode"),
      images: box.querySelectorAll(".input-image").length, chips: box.querySelectorAll(".skill-chip, .skill-chips li").length,
      errors: [...box.querySelectorAll(".inline-error")].map((e) => ({ text: e.textContent, ...rect(e) })),
    };
  };
  // What plays inside the box that would move or size something: an animation or transition of a
  // layout property anywhere in it (colours and opacity are not). The "+" menu is checked on its own.
  const layout = /^(height|width|min-height|max-height|min-width|max-width|transform|translate|scale|rotate|top|bottom|left|right|inset.*|margin.*|padding.*|grid.*|flex.*|line-height|font-size)$/;
  window.__plays = () => {
    const box = form();
    if (!box) return [];
    return box.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && !a.effect?.target?.closest?.(".composer-add-menu")
      && !String(a.animationName || "").startsWith("cm-blink")).map((a) => {
      const props = a.transitionProperty ?? (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k)).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).join("+");
      return { target: a.effect?.target?.className?.toString?.().slice(0, 60), pseudo: a.effect?.pseudoElement ?? null, props, name: a.animationName ?? null };
    }).filter((p) => p.props.split("+").some((prop) => layout.test(prop)));
  };
  window.__focusLog = [];
  for (const type of ["focusin", "focusout"])
    document.addEventListener(type, (e) => window.__focusLog.push(`${Math.round(performance.now())} ${type} ${e.target?.getAttribute?.("aria-label") ?? e.target?.className?.toString?.().slice(0, 40) ?? e.target?.nodeName}`), true);
  window.__frames = [];
  const frame = () => {
    const box = form();
    if (box && window.__frames.length < 4000) {
      const line = box.querySelector(".cm-line");
      window.__frames.push({ t: Math.round(performance.now()), label: box.querySelector(".cm-content")?.getAttribute("aria-label") ?? null,
        shape: box.dataset.shape ?? null, text: line?.textContent?.slice(0, 40) ?? null, lines: box.querySelectorAll(".cm-line").length });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const near = (a, b, tolerance = 0.5) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tolerance;
const samePlace = (a, b) => !!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
/** "+" and Send on the box's bottom edge, at its insets: the same place in either shape. */
const onEdge = (g, inset) => !!g?.plus && !!g.send && near(g.plus.b, g.send.b) && near(g.send.b, g.form.b - 1 - inset);
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const inset = run.phone ? 6 : 10;
  const pad = run.phone ? 14 : 21;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers, { stored, workspace: WORKSPACE, select: "t" });
  const measured = (report.measured[tag] = {});
  const geom = () => page.evaluate(() => window.__geom());
  const plays = () => page.evaluate(() => window.__plays());
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const input = (name) => page.locator(`[data-composer-input][aria-label="Message ${name}"]`);
  const open = async (name) => {
    if (!(await input(name).isVisible().catch(() => false))) {
      if (run.phone && (await page.locator(".phone-back").count()) && !(await page.locator(".app.phone-list").count()))
        await page.locator(".phone-back").click();
      await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
    }
    await input(name).waitFor();
    await settle();
    return input(name);
  };
  const framesOf = async (name) => (await page.evaluate(() => window.__frames)).filter((f) => f.label === `Message ${name}`);
  const clear = async () => {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await settle();
  };
  const imageFile = (name, type = "image/png") => page.evaluate(([name, type, bytes]) => {
    window.__file = new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type });
  }, [name, type, PNG.toString("base64")]);
  const removeImages = async () => {
    while (await page.locator("form.composer .input-image").count()) {
      await page.locator('form.composer button[aria-label^="Remove image"]').first().click();
      await settle();
    }
  };
  /** Opens "+" by a click; the menu and what plays on it from then on. */
  const menu = () => page.evaluate(() => {
    const el = document.querySelector(".composer-add-menu");
    return el && { items: [...el.querySelectorAll('[role="menuitem"]')].map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()),
      leaving: el.classList.contains("is-leaving"), focus: document.activeElement?.closest?.('[role="menuitem"]')?.getAttribute("aria-label") ?? null,
      plays: el.getAnimations().map((a) => ({ name: a.animationName, duration: a.effect.getTiming().duration })),
      rect: (() => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, b: b.bottom, r: b.right }; })() };
  });
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? null);
  try {
    await page.goto("http://yuzuno-composer-shape.test/");
    await page.locator(".agent-row").first().waitFor();

    // A draft restored from storage: Tui's three lines (the page opens on Tui on a desktop; a phone opens
    // its list, and Tui from it), then Ren's one short line on the way to Mori.
    await open("Tui");
    await settle();
    const tuiFrames = await framesOf("Tui");
    const tui = await geom();
    measured.restoredBlock = { frames: tuiFrames.length, shapes: [...new Set(tuiFrames.map((f) => f.shape))], first: tuiFrames[0] };
    await open("Ren");
    await settle();
    const renFrames = await framesOf("Ren");
    const ren = await geom();
    measured.restoredLine = { frames: renFrames.length, shapes: [...new Set(renFrames.map((f) => f.shape))], first: renFrames[0] };
    ok(`${tag}: a draft restored from storage opens in its shape from its first frame: three lines a block, one short line a line`,
      tuiFrames.length > 0 && tuiFrames.every((f) => f.shape === "block") && tui?.firstLine?.text === TUI[0]
      && renFrames.length > 0 && renFrames.every((f) => f.shape === "line") && ren?.firstLine?.text === REN,
      { tui: measured.restoredBlock, ren: measured.restoredLine });

    // Mori, empty: one line, with the placeholder that fits, from its first frame.
    const field = await open("Mori");
    const moriFrames = await framesOf("Mori");
    await field.click();
    // The focus glow behind the box (its ::before, over medium) settles first.
    await page.waitForTimeout(400);
    await settle();
    const empty = await geom();
    measured.empty = empty;
    // Its placeholder's width at the full width: whether it fits the line's room, with the margin.
    const fitsLine = !!empty?.placeholder && empty.placeholder.h <= empty.lineHeight * 1.5 && empty.placeholder.w < empty.room - 8;
    measured.emptyFits = { fitsLine, width: empty?.placeholder?.w, room: empty?.room, frames: moriFrames.length,
      shapes: [...new Set(moriFrames.map((f) => f.shape))], texts: [...new Set(moriFrames.map((f) => f.text))] };
    ok(`${tag}: empty, the box is one line when its placeholder fits beside "+" and Send, as high as Send and its insets; otherwise a block, the placeholder whole`,
      onEdge(empty, inset) && !!empty.placeholder && moriFrames.length > 0
      && moriFrames.every((f) => f.shape === empty.shape && f.text === empty.placeholderText.slice(0, 40)) && (fitsLine
        ? empty.shape === "line" && near(empty.form.h, empty.send.h + 2 * inset + 2) && empty.placeholder.h <= empty.lineHeight * 1.5
          && empty.placeholder.x >= empty.plus.r && empty.placeholder.r <= empty.send.x && !empty.hintShown
        : empty.shape === "block" && empty.placeholder.r <= empty.contentBox.right + 0.5 && empty.placeholder.b <= empty.scroller.b + 0.5),
      { shape: empty?.shape, fitsLine, frames: measured.emptyFits, form: empty?.form, plus: empty?.plus, send: empty?.send, placeholder: empty?.placeholder, room: empty?.room, hint: empty?.hintShown });

    await page.keyboard.type("Short note for Mori");
    await settle();
    const one = await geom();
    measured.oneLine = one;
    ok(`${tag}: one line of text is one line, as high as Send and its insets, "+" and Send where they were`,
      one?.shape === "line" && near(one.form.h, one.send.h + 2 * inset + 2) && samePlace(one.plus, empty.plus) && samePlace(one.send, empty.send)
      && one.firstLine.h <= one.lineHeight * 1.5 && !one.hintShown,
      { shape: one?.shape, form: one?.form, plus: one?.plus, send: one?.send });

    const growPlays = [];
    for (const text of ["then the second", "and a third"]) {
      await page.keyboard.press("Shift+Enter");
      growPlays.push(...(await plays()));
      await page.keyboard.type(text);
      await settle();
    }
    const three = await geom();
    measured.threeLines = three;
    ok(`${tag}: three lines make a block: the text above at the full width, "+" and Send below where they were`,
      three?.shape === "block" && three.editor.w >= three.form.w - 2.5 && three.editor.b <= three.plus.y + 0.5
      && samePlace(three.plus, empty.plus) && samePlace(three.send, empty.send)
      && near(three.scroller.clientHeight, 3 * three.lineHeight + pad, 1) && three.focus && three.caretAtEnd,
      { shape: three?.shape, editor: three?.editor, form: three?.form, plus: three?.plus, send: three?.send, scroller: three?.scroller,
        lineHeight: three?.lineHeight, focus: three?.focus, caret: three?.caretAtEnd });

    for (let i = 4; i <= 40; i++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`line ${i}`);
    }
    await settle();
    const full = await geom();
    const cap = Math.min((run.phone ? 8 : 12) * full.lineHeight + pad, Math.floor(full.innerHeight * (run.phone ? 0.3 : 0.4)));
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line 41");
    await settle();
    const fuller = await geom();
    measured.pastCap = { full, cap, fuller: fuller?.form };
    const caret = await page.evaluate(() => {
      const sel = getSelection();
      const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const s = document.querySelector("form.composer .cm-scroller").getBoundingClientRect();
      return r && { caretTop: r.top, caretBottom: r.bottom, top: s.top, bottom: s.bottom };
    });
    ok(`${tag}: past the cap the box stops growing and the text scrolls inside, its end in view`,
      full?.shape === "block" && Math.abs(full.scroller.clientHeight - cap) <= 1 && full.scroller.overflowY === "auto"
      && full.scroller.scrollHeight > full.scroller.clientHeight + full.lineHeight && full.scroller.scrollTop > 0
      && near(fuller.form.h, full.form.h) && samePlace(fuller.plus, empty.plus) && samePlace(fuller.send, empty.send)
      && !!caret && caret.caretTop >= caret.top - 0.5 && caret.caretBottom <= caret.bottom + 0.5,
      { cap, scroller: full?.scroller, form: [full?.form?.h, fuller?.form?.h], caret });
    await page.locator("form.composer").screenshot({ path: join(output, `${tag}-past-cap.png`) });

    // To the edge and back, one key at a time.
    await clear();
    const steps = [];
    const switchPlays = [];
    let typed = 0;
    while (typed < 240) {
      await page.keyboard.type("word "[typed % 5]);
      typed++;
      const g = await geom();
      switchPlays.push(...(await plays()));
      steps.push({ way: "type", n: typed, shape: g.shape, plus: g.plus, send: g.send, focus: g.focus, caret: g.caretAtEnd });
      if (g.shape === "block" && steps.filter((s) => s.shape === "block").length >= 3) break;
    }
    let back = null;
    while (typed > 0) {
      await page.keyboard.press("Backspace");
      typed--;
      const g = await geom();
      switchPlays.push(...(await plays()));
      steps.push({ way: "delete", n: typed, shape: g.shape, plus: g.plus, send: g.send, focus: g.focus, caret: g.caretAtEnd });
      if (g.shape === "line" && !back) back = { n: typed, width: g.firstLine.w, room: g.contentBox.right - g.contentBox.left };
      if (back && typed <= back.n - 3) break;
    }
    const switches = steps.reduce((n, s, i) => n + (i > 0 && s.shape !== steps[i - 1].shape ? 1 : 0), 0);
    const wrapAt = steps.find((s) => s.way === "type" && s.shape === "block")?.n ?? null;
    measured.edge = { wrapAt, back, switches };
    ok(`${tag}: typing to the edge switches to a block once and deleting back to a line once, after the margin; "+" and Send keep their place; focus and the caret stay`,
      steps[0]?.shape === "line" && switches === 2 && wrapAt !== null && !!back && back.n < wrapAt && back.width < back.room - 8 + 0.5
      && steps.every((s) => samePlace(s.plus, empty.plus) && samePlace(s.send, empty.send) && s.focus && s.caret),
      { wrapAt, back, switches, moved: steps.filter((s) => !samePlace(s.plus, empty.plus) || !samePlace(s.send, empty.send)).slice(0, 3),
        lost: steps.filter((s) => !s.focus || !s.caret).slice(0, 3) });
    ok(`${tag}: the switch and every height change are instant: nothing plays that moves or sizes the box, the editor or the tools`,
      growPlays.length === 0 && switchPlays.length === 0, { growPlays: growPlays.slice(0, 4), switchPlays: switchPlays.slice(0, 4) });
    await clear();

    // The "+" menu, by pointer.
    const plus = page.locator("form.composer .composer-plus");
    let opened = null;
    let closing = null;
    if (await plus.count()) {
      await plus.click();
      opened = await menu();
      await page.keyboard.press("Escape");
      closing = await menu();
      await page.waitForFunction(() => !document.querySelector(".composer-add-menu"), null, { timeout: 2000 }).catch(() => {});
    }
    const gone = await menu();
    const backOnPlus = (await focused()) === "Add";
    measured.menu = { opened, closing, gone: !gone };
    ok(`${tag}: "+" opens one menu, above it: Add images, Mark up an image and Ask for an interactive result`,
      !!opened && JSON.stringify(opened.items) === JSON.stringify(["Add images", "Mark up an image", "Ask for an interactive result"])
      && opened.rect.b <= (await geom()).plus.y + 0.5 && opened.focus === "Add images",
      { opened });
    if (reduced) ok(`${tag}: under reduced motion the menu shows and goes at once, with nothing playing`,
      !!opened && opened.plays.length === 0 && !closing && !gone && backOnPlus, { opened, closing });
    else ok(`${tag}: the menu rises from "+" over small and sinks back over exit-small, then is gone`,
      !!opened && opened.plays.length === 1 && opened.plays[0].name === "composer-add-in" && opened.plays[0].duration === 180
      && !!closing && closing.leaving && closing.plays.length === 1 && closing.plays[0].name === "composer-add-out" && closing.plays[0].duration === 130
      && !gone && backOnPlus, { opened, closing, gone });

    // The pickers and the result request.
    let pickers = null;
    if (await plus.count()) {
      await plus.click();
      const [images] = await Promise.all([page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null),
        page.locator('.composer-add-menu [role="menuitem"][aria-label="Add images"]').click()]);
      await plus.click();
      const [mark] = await Promise.all([page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null),
        page.locator('.composer-add-menu [role="menuitem"][aria-label="Mark up an image"]').click()]);
      pickers = { images: images && images.isMultiple(), mark: mark && !mark.isMultiple(), focus: await focused() };
      if (images) {
        await images.setFiles({ name: "chosen.png", mimeType: "image/png", buffer: PNG });
        await page.locator("form.composer .input-image").first().waitFor({ timeout: 4000 }).catch(() => {});
        await settle();
      }
    }
    const chosen = await geom();
    await removeImages();
    const afterRemove = await geom();
    ok(`${tag}: Add images and Mark up an image open the image pickers, for several images and for one`,
      !!pickers && pickers.images === true && pickers.mark === true && pickers.focus === "Add", { pickers });
    ok(`${tag}: an image chosen joins the draft; the box is a block while it is there and empty again once it is removed`,
      chosen?.images === 1 && chosen.shape === "block" && samePlace(chosen.plus, empty.plus) && afterRemove?.images === 0 && afterRemove.shape === empty.shape,
      { chosen: [chosen?.images, chosen?.shape], afterRemove: [afterRemove?.images, afterRemove?.shape] });

    let dialog = null;
    await page.evaluate(() => { window.__focusLog.length = 0; });
    if (await plus.count()) {
      await plus.click();
      await page.locator('.composer-add-menu [role="menuitem"][aria-label="Ask for an interactive result"]').click();
      dialog = await page.getByRole("dialog", { name: "A result you can explore" }).waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
      // Radix gives focus back in a timer after the dialog has gone.
      await page.waitForFunction(() => document.activeElement?.getAttribute?.("aria-label") === "Add", null, { timeout: 1500 }).catch(() => {});
    }
    ok(`${tag}: Ask for an interactive result opens its dialog, and focus is back on "+" when it closes`,
      dialog === true && (await focused()) === "Add", { dialog, focus: await focused(), log: await page.evaluate(() => window.__focusLog.slice(-16)) });

    // Images without the menu: pasted into the text, dropped on the text, dropped beside it.
    await field.click();
    await imageFile("pasted.png");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(window.__file);
      document.querySelector("form.composer .cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator("form.composer .input-image").first().waitFor({ timeout: 4000 }).catch(() => {});
    const pasted = await geom();
    await removeImages();
    ok(`${tag}: an image pasted into the text joins the draft, without the menu`, pasted?.images === 1, { images: pasted?.images });
    const drop = async (selector) => {
      await imageFile("dropped.png");
      await page.evaluate((selector) => {
        const target = document.querySelector(selector);
        const b = target.getBoundingClientRect();
        const at = { clientX: b.x + Math.min(8, b.width / 2), clientY: b.y + Math.min(8, b.height / 2) };
        const data = new DataTransfer();
        data.items.add(window.__file);
        for (const type of ["dragenter", "dragover", "drop"])
          target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, ...at }));
      }, selector);
      await page.locator("form.composer .input-image").first().waitFor({ timeout: 4000 }).catch(() => {});
      const g = await geom();
      const text = await page.evaluate(() => document.querySelector("form.composer .cm-content").textContent);
      await removeImages();
      return { images: g?.images, shape: g?.shape, text };
    };
    const onText = await drop("form.composer .cm-content");
    const beside = await drop("form.composer .composer-tools");
    ok(`${tag}: an image dropped on the text joins the draft, and no text is put in for it`, onText.images === 1 && !onText.text.includes("PNG"), onText);
    ok(`${tag}: an image dropped on the box beside the text joins the draft`, beside.images === 1, beside);

    // A skill chip: one chosen from Sol's Codex skills with "$" makes a block; removed, its one line again.
    await open("Sol");
    await input("Sol").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" $tid");
    await page.locator(".slash-menu [role=option]", { hasText: "tidy-notes" }).first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press("Enter");
    await page.locator("form.composer .skill-chips").waitFor({ timeout: 3000 }).catch(() => {});
    await settle();
    const withSkill = await geom();
    const remove = page.locator('form.composer button[aria-label="Remove skill tidy-notes"]');
    const removable = await remove.isVisible().catch(() => false);
    if (removable) await remove.click();
    await settle();
    const noSkill = await geom();
    ok(`${tag}: a skill chip makes the box a block, the chip removable; removed, the box is one line again`,
      withSkill?.shape === "block" && removable && withSkill.firstLine.text.startsWith(SOL) && samePlace(withSkill.plus, empty.plus)
      && noSkill?.shape === "line" && noSkill.firstLine.text.startsWith(SOL),
      { withSkill: withSkill?.shape, removable, text: withSkill?.firstLine?.text, noSkill: noSkill?.shape });

    // Each placeholder: Mori's (idle), Kai's (working), Lumi's (Claude, working); the long one where it
    // fits the line's room with the margin, its short form where it does not.
    const placeholders = [];
    for (const name of ["Mori", "Kai", "Lumi"]) {
      await open(name);
      await page.evaluate((texts) => { window.__measure = texts; }, PLACEHOLDERS[name]);
      const g = await geom();
      const [long, shortForm] = PLACEHOLDERS[name];
      const longFits = g.measureText[long] < g.room - 8;
      const whole = !!g.placeholder && g.placeholder.r <= g.contentBox.right + 0.5 && g.placeholder.b <= g.scroller.b + 0.5;
      const oneLine = !!g.placeholder && g.placeholder.h <= g.lineHeight * 1.5;
      placeholders.push({ name, text: g.placeholderText, longFits, form: g.placeholderText === (longFits ? long : shortForm),
        longWidth: g.measureText[long], shortWidth: g.measureText[shortForm], shape: g.shape, whole, oneLine, width: g.placeholder?.w, room: g.room,
        fits: oneLine && g.placeholder.w < g.room - 8,
        clear: g.shape === "line" ? g.placeholder.x >= g.plus.r && g.placeholder.r <= g.send.x : true });
    }
    measured.placeholders = placeholders;
    ok(`${tag}: each placeholder reads whole, its short form where the long one does not fit the line: on one line when it fits beside "+" and Send, otherwise in a block`,
      placeholders.every((p) => p.form && ((p.shape === "line" && p.oneLine && p.whole && p.clear) || (p.shape === "block" && p.whole && !p.fits))),
      { placeholders });

    // Working: the menu from the keyboard, where Escape would otherwise interrupt.
    await open("Kai");
    const writesBefore = report.writes.length;
    let keys = null;
    if (await plus.count()) {
      await plus.focus();
      await page.keyboard.press("ArrowUp");
      const last = (await menu())?.focus;
      await page.keyboard.press("Home");
      const first = (await menu())?.focus;
      await page.keyboard.press("ArrowDown");
      const second = (await menu())?.focus;
      await page.keyboard.press("End");
      const end = (await menu())?.focus;
      await page.keyboard.press("ArrowDown");
      const wrapped = (await menu())?.focus;
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".composer-add-menu"), null, { timeout: 2000 }).catch(() => {});
      keys = { last, first, second, end, wrapped, focus: await focused() };
    }
    await page.waitForTimeout(150);
    ok(`${tag}: the menu works from the keyboard: the arrow keys, Home and End move, Escape closes it and focus is back on "+", with nothing interrupted`,
      !!keys && keys.last === "Ask for an interactive result" && keys.first === "Add images" && keys.second === "Mark up an image"
      && keys.end === "Ask for an interactive result" && keys.wrapped === "Add images" && keys.focus === "Add"
      && report.writes.length === writesBefore, { keys, writes: report.writes.slice(writesBefore) });

    // An error line under the draft (Ren's): a GIF, which images refuse.
    await open("Ren");
    await input("Ren").click();
    await imageFile("moving.gif", "image/gif");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(window.__file);
      document.querySelector("form.composer .cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator("form.composer .inline-error").first().waitFor({ timeout: 3000 }).catch(() => {});
    await settle();
    const refused = await geom();
    ok(`${tag}: an error line under the draft makes the box a block, with the error whole between the text and the tools`,
      refused?.errors.length === 1 && /PNG, JPEG or WebP/.test(refused.errors[0].text) && refused.shape === "block"
      && refused.errors[0].y >= refused.editor.b - 0.5 && refused.errors[0].b <= refused.plus.y + 0.5 && refused.errors[0].r <= refused.form.r,
      { errors: refused?.errors, shape: refused?.shape });

    // The notice that waits for your answer (Pia).
    await open("Pia");
    const waiting = await geom();
    ok(`${tag}: "Waiting for your response above" shows whole on the tools row of a block`,
      waiting?.shape === "block" && waiting.notice === "Waiting for your response above" && !!waiting.noticeRect
      && waiting.noticeRect.r <= waiting.form.r && waiting.noticeRect.h <= 2 * waiting.lineHeight && waiting.noticeRect.y >= waiting.editor.b - 0.5,
      { shape: waiting?.shape, notice: waiting?.notice, rect: waiting?.noticeRect });
    await page.locator("form.composer").screenshot({ path: join(output, `${tag}-waiting.png`) });

    // Codex's Plan mode sign (Ada).
    await open("Ada");
    const ada = await geom();
    measured.plan = ada;
    ok(`${tag}: Codex's Plan mode sign sits with the controls beside Send, not with "+"`,
      !!ada?.mode && !ada.modeInTools && ada.mode.r <= ada.send.x + 0.5 && near(ada.mode.y + ada.mode.h / 2, ada.send.y + ada.send.h / 2, 1.5),
      { mode: ada?.mode, send: ada?.send, inTools: ada?.modeInTools, shape: ada?.shape });
    await page.locator("form.composer").screenshot({ path: join(output, `${tag}-plan.png`) });
    await open("Mori");
    await page.locator("form.composer").screenshot({ path: join(output, `${tag}-empty.png`) });
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("nothing was written but the images uploaded", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "composer-shape-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; uploads ${report.uploads.length}; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
