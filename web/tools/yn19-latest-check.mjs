// YN-19: the bottom of a conversation, in a real browser layout.
//  1. Newer saved pages load by themselves as the reader scrolls toward the
//     end of an older window (there is no "Continue to newer messages"
//     link), with a quiet loading line, and the message being read stays
//     where it was. A failed read says so inline and can be tried again.
//  2. Back to latest shows whenever the newest end is out of view, the end
//     of an older window included, and hides at the true end.
//  3. One press lands at the very end of the newest window.
//  4. On a desktop the pill is centred on the conversation column just above
//     the composer: it covers no line of text and none of the composer, its
//     expand icon included. On a phone it stays clear of the dock buttons.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, no daily window, no writes, no model turns.
//   YUZUNO_UI_DIST=<isolated build> [YN19_OUTPUT=dir] node tools/yn19-latest-check.mjs
// YN19_VIEWPORTS (1440x900,951x669,390x844), YN19_LANGS (en,zh-Hans) and
// YN19_THEMES (light,dark) choose the matrix. Below 1000px wide the screen is
// a touch one: 951x669 is the folding phone opened (T-15's Duo), 390 a phone.
// The reader scrolls by wheel or finger (CDP synthesized gestures), so the
// app sees a reader scrolling, not a script setting scrollTop.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YN19_OUTPUT || "../acceptance/yn19-latest");
await mkdir(output, { recursive: true });
const VIEWPORTS = (process.env.YN19_VIEWPORTS || "1440x900,951x669,390x844").split(",").map((v) => {
  const [width, height] = v.split("x").map(Number);
  return { name: v, width, height, phone: width < 600, touch: width < 1000 };
});
const LANGS = (process.env.YN19_LANGS || "en,zh-Hans").split(",");
const THEMES = (process.env.YN19_THEMES || "light,dark").split(",");
const TEXT = {
  en: { latest: "Back to latest", newer: "Continue to newer messages", loading: "Loading newer messages…", retry: "Try again" },
  "zh-Hans": { latest: "返回最新", newer: "继续看更新的消息", loading: "正在载入更新的消息…", retry: "重试" },
};

const agent = {
  id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
};
// Sixty Turns of uneven length, longest at the end, so the newest window's
// rows measure well past their estimates as they mount.
const paragraph = (n, p) => `第 ${n} 轮的第 ${p + 1} 段：把检查结果逐条整理，写到足以换行好几次，让每条回复的高度都不一样。Turn ${n} keeps its notes here.`;
const TURNS = 60;
const turns = Array.from({ length: TURNS }, (_, i) => {
  const n = i + 1;
  const paragraphs = n > TURNS - 12 ? 5 + (n % 4) : 1 + ((n * 7) % 6);
  const code = n % 3 === 0 ? `\n\n\`\`\`\n${Array.from({ length: 6 + (n % 7) }, (_, l) => `line ${l} of turn ${n}`).join("\n")}\n\`\`\`` : "";
  return {
    id: `t${n}`, status: "completed",
    items: [
      { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `问题 ${n}：请看一下这一段。Question ${n}.` }] },
      { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: paragraphs }, (_, p) => paragraph(n, p)).join("\n\n") + code },
    ],
  };
});
const all = turns.flatMap((turn) => turn.items.map((item) => JSON.stringify([turn.id, item.id])));
const NEWEST = JSON.parse(all.at(-1))[1];
// Core's window rules (conversation_window.rs): `before` ends at its Item,
// `after` and `turnId` start at theirs, the latest is the last SIZE.
const SIZE = 40;
const windowOf = (from, to) => {
  from = Math.max(0, from); to = Math.min(all.length - 1, to);
  const shown = all.slice(from, to + 1);
  return {
    agent, pending: [], messageReceipts: [], artifacts: [],
    turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => shown.includes(JSON.stringify([turn.id, item.id]))) }))
      .filter((turn) => turn.items.length),
    conversation: {
      // As Core indexes every Turn: its first request as a preview.
      index: turns.map((turn, i) => ({ id: turn.id, status: turn.status, number: i + 1, _yuzunoIndex: true, _yuzunoRequestCount: 1,
        itemCount: turn.items.length, items: [turn.items[0]] })),
      questions: [], nativeClientIds: [],
      start: shown[0], end: shown.at(-1), hasBefore: from > 0, hasAfter: to < all.length - 1, totalItems: all.length,
    },
  };
};
const detailFor = (query) => {
  if (query.has("before")) { const end = all.indexOf(query.get("before")); return windowOf(end - SIZE + 1, end); }
  if (query.has("after")) { const from = all.indexOf(query.get("after")); return windowOf(from, from + SIZE - 1); }
  if (query.has("turnId")) {
    const from = query.has("itemId") ? all.indexOf(JSON.stringify([query.get("turnId"), query.get("itemId")]))
      : all.findIndex((key) => JSON.parse(key)[0] === query.get("turnId"));
    return windowOf(from, from + SIZE - 1);
  }
  return windowOf(all.length - SIZE, all.length - 1);
};

const report = { checks: [], failed: [], errors: [], console: [], unexpected: [], writes: [], runs: [] };
const check = (ok, name, extra = {}) => {
  report.checks.push({ name, ok, ...extra });
  if (!ok) report.failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(extra)}`}`);
  return ok;
};
const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open(viewport, lang, theme, fixture) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([lang, theme]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
  }, [lang, theme]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "localhost");
    if (request.method() !== "GET") { report.unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === "/api/agents/a") {
      const query = url.searchParams;
      const read = { at: Date.now(), query: query.toString(), direction: query.has("after") ? "after" : query.has("before") ? "before" : query.has("turnId") ? "turn" : "latest" };
      fixture.reads.push(read);
      // Windowed reads answer a little later, as a read from Core does;
      // newer pages slower still, so their loading line can be seen.
      if (read.direction === "after") await new Promise((done) => setTimeout(done, 700));
      else if (fixture.reads.length > 1) await new Promise((done) => setTimeout(done, 250));
      if (read.direction === "after" && fixture.failAfter) {
        fixture.failAfter = false;
        read.failed = true;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The saved window could not be read" }) });
      }
      return route.fulfill({ json: detailFor(query) });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
      "/api/ci/live": noLiveCi,
      "/api/home": emptyHome,
      "/api/agents/a/conversation/inputs": noConversationInputs,
      "/api/reviews": noReviews,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      // Read since this check was written (who waits on what, live).
      "/api/waits/live": { agents: {} },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) { report.unexpected.push(url.pathname); return route.fulfill({ json: {} }); }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") report.console.push(message.text().slice(0, 300)); });
  await page.goto("http://localhost/");
  await page.locator(".app").waitFor({ timeout: 15_000 });
  // A phone opens on its Agent list: the conversation is a screen of its own.
  if (viewport.phone) {
    await page.locator(".agent-row .agent-select").first().waitFor({ timeout: 15_000 });
    if (await page.locator(".app.phone-list").count()) await page.locator(".agent-row .agent-select").first().click();
  }
  await page.locator(`.main-panel [data-item-id="${NEWEST}"]`).waitFor({ state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  // A frame as it was drawn: a task posted from the frame's callback runs
  // once the frame is drawn, after the page's own callbacks in it.
  await page.addScriptTag({ content: "window.drawn = (look) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = look; c.port2.postMessage(null); });" });
  // How far the app itself has scrolled the pane (its scrollTop writes), so
  // a step's movement can be split into the reader's scroll and the app's.
  await pane(page).evaluate((el) => {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    window.appScrolled = 0;
    const note = (fn) => { const was = d.get.call(el); const r = fn(); window.appScrolled += d.get.call(el) - was; return r; };
    Object.defineProperty(el, "scrollTop", { configurable: true, get() { return d.get.call(this); }, set(v) { note(() => d.set.call(this, v)); } });
    for (const name of ["scrollTo", "scrollBy"]) { const orig = el[name]; el[name] = function (...a) { return note(() => orig.apply(this, a)); }; }
  });
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

const pane = (page) => page.locator(".main-panel .conversation-scroll");
const gap = (page) => pane(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Where Back to latest is, against the column, the composer and its
 * expand icon, the phone's dock buttons and every line of text in view. */
const placement = (page, latestText) => page.evaluate((latestText) => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
  const shown = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const main = document.querySelector(".main-panel");
  const pillEl = main.querySelector("button.jump-latest");
  const pill = shown(pillEl) ? box(pillEl) : null;
  const view = box(main.querySelector(".conversation-scroll"));
  const column = box(main.querySelector(".conversation-inner"));
  const composer = box(main.querySelector(".composer"));
  const expandEl = main.querySelector(".composer-expand");
  const expand = shown(expandEl) ? box(expandEl) : null;
  const buttons = [...main.querySelectorAll(".phone-dock-button")].filter(shown).map(box);
  // Lines of text the pill lies over, as the pane shows them (T-15's
  // measure: each line's own box, clipped to the pane).
  const covered = pill ? [...main.querySelectorAll(".conversation-inner [data-item-id] p, .conversation-inner [data-item-id] li, .conversation-inner [data-item-id] pre")]
    .filter((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].some((line) => {
        if (!(line.width > 0 && line.height > 0)) return false;
        const top = Math.max(line.top, view.top), bottom = Math.min(line.bottom, view.bottom);
        return bottom - top > 0 && pill.left < line.right && pill.right > line.left && pill.top < bottom && pill.bottom > top;
      });
    }).length : null;
  const ways = [...document.querySelectorAll("button, a")]
    .filter((el) => (el.textContent || "").trim().includes(latestText) && shown(el))
    .map((el) => el.closest(".source-navigation") ? "reading-bar" : el.classList.contains("jump-latest") ? "floating" : "elsewhere");
  return {
    pill, view, column, composer, expand, buttons, covered, ways,
    pillText: pillEl ? (pillEl.textContent || "").trim() : null,
    pillCentreOff: pill && column ? Math.round(((pill.left + pill.right) / 2 - (column.left + column.right) / 2) * 10) / 10 : null,
    meetsExpand: meets(pill, expand), meetsComposer: meets(pill, composer), meetsButtons: buttons.some((b) => meets(pill, b)),
    belowView: pill && view ? Math.round((pill.top - view.bottom) * 10) / 10 : null,
    aboveComposer: pill && composer ? Math.round((composer.top - pill.bottom) * 10) / 10 : null,
    turnDockLatest: shown(main.querySelector(".turn-dock-latest")),
    continueLink: [...main.querySelectorAll("button, a")].some((el) => /Continue to newer messages|继续看更新的消息/.test(el.textContent || "") && shown(el)),
  };
}, latestText);

/** The message at the top of the view and where it is on screen: the
 * first whose top is in view, else the one filling it (as the app picks). */
const reading = (page) => pane(page).evaluate((el) => {
  const box = el.getBoundingClientRect();
  const visible = [...el.querySelectorAll("[data-item-id]")]
    .map((item) => ({ id: item.dataset.itemId, rect: item.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom);
  const first = visible.find(({ rect }) => rect.top >= box.top) || visible[0];
  return first ? { id: first.id, top: Math.round((first.rect.top - box.top) * 10) / 10 } : null;
});
/** Every drawn frame for `ms`: where `id` is, how far the end is, and
 * whether a loading line or an error shows. */
const frames = (page, id, ms, loadingText) => pane(page).evaluate((el, [id, ms, loadingText]) => new Promise((done) => {
  const trace = [];
  const began = performance.now();
  const look = () => {
    const box = el.getBoundingClientRect();
    const item = id ? el.querySelector(`[data-item-id="${id}"]`) : null;
    trace.push({
      t: Math.round(performance.now() - began),
      top: item ? Math.round((item.getBoundingClientRect().top - box.top) * 10) / 10 : null,
      gap: Math.round((el.scrollHeight - el.scrollTop - el.clientHeight) * 10) / 10,
      loading: (el.textContent || "").includes(loadingText),
    });
    if (performance.now() - began < ms) window.drawn(look);
    else done(trace);
  };
  look();
}), [id, ms, loadingText]);

/** Into history from the turn dock: Turn 1, which the latest window does
 * not hold, so an older window replaces it. */
async function jumpToFirstTurn(page, viewport, fixture) {
  if (viewport.phone) {
    await page.locator(".phone-dock-turns").click();
    await page.waitForTimeout(300);
  }
  const reads = fixture.reads.length;
  await page.locator(".turn-dock .turn-dock-stop").first().focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.locator('.main-panel [data-item-id="t1-u"]').waitFor({ state: "attached", timeout: 10_000 });
  await page.waitForTimeout(900);
  return fixture.reads.slice(reads).map((r) => r.direction);
}

/** The message being read (or `id`), where it is in the pane, the pane's
 * scrollTop and how far the app has scrolled it so far. */
const placeOfReading = async (page, id) => {
  const at = id ? null : await reading(page);
  const which = id ?? at?.id;
  if (!which) return null;
  return pane(page).evaluate((el, which) => {
    const item = el.querySelector(`[data-item-id="${which}"]`);
    return { id: which, top: item ? item.getBoundingClientRect().top - el.getBoundingClientRect().top : null, scrollTop: el.scrollTop, app: window.appScrolled };
  }, which);
};

/** A reader's scroll toward the end, a wheel or finger step at a time,
 * until a newer page starts loading by itself or the end of what is loaded
 * is reached. A step the pane did not take is said in `stalled`. */
async function scrollTowardEnd(page, cdp, viewport, fixture, run) {
  const view = await pane(page).boundingBox();
  const reads = fixture.reads.length;
  run.stalled = 0;
  for (let step = 0; step < 160; step++) {
    const before = await pane(page).evaluate((el) => el.scrollTop);
    // Where the message being read was before this step: the place to hold
    // if this step starts a newer page's read (YN-114: taken after the read
    // began, a drop already made was the baseline, and the check passed).
    const pre = await placeOfReading(page);
    const x = Math.round(view.x + view.width / 2), y = Math.round(view.y + view.height * 0.6);
    if (viewport.touch) {
      // A finger: touch moves through Chromium's input pipeline pan the pane
      // (a synthesized touch gesture sends the page no moves; reader-row-check).
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 11; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 20 }] });
        await page.waitForTimeout(16);
      }
      // The finger rests before it lifts, so no fling carries the pane on
      // after the step: what moves after this is the app's doing.
      for (let i = 0; i < 3; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 220 }] });
        await page.waitForTimeout(50);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -220, speed: 1600, gestureSourceType: "mouse", preventFling: true });
    }
    await page.waitForTimeout(40);
    if (await pane(page).evaluate((el, before) => el.scrollTop === before, before)) run.stalled++;
    if (fixture.reads.slice(reads).some((r) => r.direction === "after")) {
      const post = pre && await placeOfReading(page, pre.id);
      run.readStep = { pre, post, jump: pre && post?.top != null
        ? Math.round(((post.top - pre.top) + ((post.scrollTop - pre.scrollTop) - (post.app - pre.app))) * 10) / 10 : null };
      return "loading";
    }
    if (await gap(page) < 2) { await page.waitForTimeout(400); return fixture.reads.slice(reads).some((r) => r.direction === "after") ? "loading" : "end"; }
    if (run.stalled > 6) return "stuck";
  }
  return "stuck";
}

let failures = 0;
for (const viewport of VIEWPORTS) for (const lang of LANGS) for (const theme of THEMES) {
  const tag = `${viewport.name}-${lang}-${theme}`;
  const t = TEXT[lang];
  const fixture = { reads: [], failAfter: false };
  const run = { tag };
  report.runs.push(run);
  let context, page;
  try {
    let cdp;
    ({ context, page, cdp } = await open(viewport, lang, theme, fixture));
    if (await gap(page) > 2) await pane(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);

    // A draft of four lines, so the composer offers its expand icon.
    await page.locator(".main-panel [data-composer-input]").click();
    await page.keyboard.insertText("First line of a draft\nSecond line\nThird line\nFourth line");
    await page.locator(".main-panel .composer-expand").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);

    // Scrolled up in the newest window: the pill, and where it sits.
    await pane(page).evaluate((el) => { el.scrollTop = Math.round(el.scrollHeight * 0.4); });
    await page.waitForTimeout(500);
    const up = run.scrolledUp = await placement(page, t.latest);
    await page.screenshot({ path: resolve(output, `${tag}-pill.png`) });
    check(!!up.pill && up.ways.length === 1 && up.ways[0] === "floating", `${tag}: scrolled up, the one way back is the floating pill`, { ways: up.ways });
    check(up.pillText === t.latest, `${tag}: the pill says "${t.latest}"`, { text: up.pillText });
    check(!up.meetsExpand, `${tag}: (c) the pill does not lie over the composer's expand icon`, { pill: up.pill, expand: up.expand });
    check(!up.meetsComposer, `${tag}: the pill does not lie over the composer`, { aboveComposer: up.aboveComposer });
    check(up.covered === 0, `${tag}: the pill covers no line of text`, { covered: up.covered });
    if (viewport.phone) {
      check(!up.meetsButtons, `${tag}: on a phone the pill keeps clear of the dock buttons`, { pill: up.pill, buttons: up.buttons });
    } else {
      check(up.pillCentreOff !== null && Math.abs(up.pillCentreOff) <= 2, `${tag}: the pill is centred on the conversation column`, { off: up.pillCentreOff });
      check(up.belowView !== null && up.belowView >= -0.5 && up.aboveComposer !== null && up.aboveComposer >= 0 && up.aboveComposer <= 24,
        `${tag}: the pill sits just above the composer, in room the transcript leaves for it`, { belowView: up.belowView, aboveComposer: up.aboveComposer });
    }

    // Into history: an older window, read toward its end.
    run.jump = await jumpToFirstTurn(page, viewport, fixture);
    const how = run.reached = await scrollTowardEnd(page, cdp, viewport, fixture, run);
    const atBoundary = await reading(page);
    const trace = run.boundaryTrace = how === "loading" ? await frames(page, atBoundary?.id, 1800, t.loading) : [];
    const near = run.nearEnd = await placement(page, t.latest);
    check(how === "loading", `${tag}: (1) toward the end of an older window, the newer page loads by itself`, { how, reads: fixture.reads.map((r) => r.direction) });
    check(!near.continueLink, `${tag}: (1) no "${t.newer}" link`, { how });
    check(!!near.pill && near.ways.length === 1 && near.ways[0] === "floating", `${tag}: (a) at the end of an older window the pill shows, the one way back`, { ways: near.ways, how });
    if (how === "loading") {
      // The step that started the read: what is being read moves only as far
      // as the reader scrolled it (the room kept above for the page included).
      check(run.readStep?.jump != null && Math.abs(run.readStep.jump) <= 2,
        `${tag}: (1) the message being read does not move by itself as the newer page starts loading`, run.readStep ?? {});
      const moved = trace.filter((f) => f.top !== null).map((f) => Math.abs(f.top - atBoundary.top));
      run.boundary = { anchor: atBoundary, maxMove: Math.max(0, ...moved), lostFrames: trace.filter((f) => f.top === null).length };
      check(!!atBoundary && moved.length === trace.length && Math.max(...moved) <= 2,
        `${tag}: (1) the message being read stays in place while the page loads and lands`, run.boundary);
      check(trace.some((f) => f.loading), `${tag}: (1) a quiet loading line shows while it loads`, { loadingFrames: trace.filter((f) => f.loading).length });
      await page.screenshot({ path: resolve(output, `${tag}-boundary.png`) });
    }

    // On to the end of what is loaded: still an older window here? The
    // newest end is not in view, so the pill still shows.
    const pressedFrom = run.pressedFrom = await placement(page, t.latest);
    const pressed = pressedFrom.pill ? "floating" : pressedFrom.ways.includes("reading-bar") ? "reading-bar" : null;
    run.pressed = pressed;
    if (pressed === "floating") await page.locator(".main-panel button.jump-latest").click();
    else if (pressed === "reading-bar") await page.locator(".main-panel .source-navigation button", { hasText: t.latest }).first().click();
    const landing = run.landingTrace = await frames(page, NEWEST, 2000, t.loading);
    const final = landing.at(-1);
    const landed = run.landed = { gap: final.gap, newestTop: final.top, view: await pane(page).evaluate((el) => el.clientHeight),
      firstFrameAtEnd: landing.find((f) => f.gap <= 2)?.t ?? null, after: await placement(page, t.latest) };
    check(pressed !== null && final.gap <= 2 && final.top !== null && final.top < landed.view,
      `${tag}: (b) one press of Back to latest lands at the very end`, { pressed, gap: final.gap, newestTop: final.top });
    check(!landed.after.pill && landed.after.ways.length === 0, `${tag}: (2) at the true end Back to latest is gone`, { ways: landed.after.ways });
    check(!landed.after.turnDockLatest, `${tag}: (2) and so is the turn dock's latest stop`);
    await page.screenshot({ path: resolve(output, `${tag}-latest.png`) });

    // Main's way from the end of an older window, as the user took it:
    // "Continue to newer messages" until the newest end is in the window
    // (main's link goes then), then Back to latest until at the end.
    // Observed, not asserted, and only where that link exists.
    if (near.continueLink) {
      await jumpToFirstTurn(page, viewport, fixture);
      await scrollTowardEnd(page, cdp, viewport, fixture, {});
      const link = page.locator(".main-panel .conversation-history-window button");
      let continues = 0;
      for (; continues < 5 && await link.count(); continues++) {
        await link.first().click();
        await page.waitForTimeout(1500);
        await pane(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(400);
      }
      if (continues) {
        const continued = await placement(page, t.latest);
        const continuedGap = Math.round(await gap(page));
        const presses = [];
        // The user pressed it because it showed: at least once, then again
        // while it still shows or the end is not reached.
        for (let press = 0; press < 3 && (press === 0 || (await gap(page)) > 2 || (await placement(page, t.latest)).pill); press++) {
          const from = await placement(page, t.latest);
          if (from.pill) await page.locator(".main-panel button.jump-latest").click();
          else if (from.ways.includes("reading-bar")) await page.locator(".main-panel .source-navigation button", { hasText: t.latest }).first().click();
          else break;
          const trace = await frames(page, NEWEST, 1500, t.loading);
          presses.push({ via: from.pill ? "floating" : "reading-bar", gap: trace.at(-1).gap, newestTop: trace.at(-1).top,
            gaps: trace.filter((_, i) => i % 6 === 0).map((f) => f.gap) });
        }
        run.userPath = { continues, afterContinue: { gap: continuedGap, pill: !!continued.pill, ways: continued.ways }, presses };
        console.log(`OBSERVE ${tag}: main's own path ${JSON.stringify(run.userPath)}`);
      }
    }

    // A newer page that cannot be read: said inline, with a retry.
    if (viewport.name === VIEWPORTS[0].name && theme === THEMES[0]) {
      await jumpToFirstTurn(page, viewport, fixture);
      fixture.failAfter = true;
      const second = await scrollTowardEnd(page, cdp, viewport, fixture, {});
      await page.waitForTimeout(1200);
      // At the window's end, where the reader is, not only the pane's top alert.
      const failed = run.failedRead = await page.evaluate((retry) => {
        const end = document.querySelector(".main-panel .conversation-history-window");
        const alert = end && [...end.querySelectorAll("[role=alert]")].find((el) => /could not be read/.test(el.textContent || ""));
        const button = end && [...end.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === retry && el.getBoundingClientRect().height > 0);
        return { alert: alert ? (alert.textContent || "").trim().slice(0, 160) : null, retry: !!button };
      }, t.retry);
      check(second === "loading" && !!failed.alert && failed.retry, `${tag}: (1) a newer page that fails says so inline, with "${t.retry}"`, { second, failed });
      if (failed.retry) {
        const reads = fixture.reads.length;
        await page.locator(".main-panel .conversation-history-window button", { hasText: t.retry }).click();
        await page.waitForTimeout(1400);
        const again = fixture.reads.slice(reads).filter((r) => r.direction === "after" && !r.failed).length;
        const alertGone = await page.evaluate(() => ![...document.querySelectorAll(".main-panel .conversation-history-window [role=alert]")].some((el) => /could not be read/.test(el.textContent || "")));
        check(again >= 1 && alertGone, `${tag}: (1) and the retry reads it`, { again, alertGone });
        await page.screenshot({ path: resolve(output, `${tag}-retried.png`) });
      }
    }
    run.reads = fixture.reads.map((r) => `${r.direction}${r.failed ? "!" : ""}`);
  } catch (error) {
    run.failure = String(error?.stack || error);
    check(false, `${tag}: the run finished`, { error: String(error?.message || error).slice(0, 300) });
    if (page) await page.screenshot({ path: resolve(output, `${tag}-failed.png`) }).catch(() => {});
  } finally {
    await context?.close();
  }
}
await browser.close();
check(report.errors.length === 0, "no page errors", { errors: report.errors.slice(0, 3) });
check(report.unexpected.length === 0, "nothing written and no unexpected reads", { unexpected: report.unexpected.slice(0, 5) });
failures = report.failed.length;
report.status = failures ? "failed" : "passed";
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
