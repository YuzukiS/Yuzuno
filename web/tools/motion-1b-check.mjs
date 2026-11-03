// T-19 batch 1b, dialogs (M1): in Chromium on a production build of the
// labelled design preview (?preview=1, synthetic Agents, no Core). A dialog
// enters with a fade and a 4px rise (a confirmation only fades). When it
// closes, Radix still removes it at once, and what fades out is a copy
// (DialogExitGhost.tsx). Every frame from the close is sampled, to show:
// the dialog is gone; focus is back where the build before this batch put
// it (--baseline records that); no Radix aria-hidden mark or scroll lock is
// left; the copy is aria-hidden, inert and clicked through, adds no
// duplicate id and is gone within 400 ms; under reduced motion there is no
// copy; reopening during the exit shows the new dialog at once. Both ways a
// dialog closes are tried: its `open` going false (New agent, Search, Jobs)
// and its unmounting while open (Changes, Disconnect). The read-only preview
// offers neither Jobs, Disconnect nor a sent `/changes`, so two more runs
// ("app") load the app itself on a synthetic Workspace that is never written
// to. There an Agent's confirmations close too: Close, a confirmation from
// its opening, and Actions turned into Delete while open. Neither changes
// the live dialog's animation as it closes (Radix would wait for that), and
// each copy shows what was open and only fades. What a run cannot open is
// listed as not shown. An emulated phone is not
// a real one, and Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1b-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1b");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", checks: [], failures: [], errors: [], apiCalls: [], writes: [], notShown: [], focus: {}, exits: {} };
// A baseline run records focus only; the build before this batch has no copy to look for.
const ok = (name, cond, detail) => {
  if (baseline) return;
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const api = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs,
  "/api/jobs": noJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

// The app itself (not the preview) on a synthetic Workspace, for what the read-only
// preview does not offer: Disconnect (a confirmation that unmounts while open) and Jobs.
const fixtureAgent = (id, name) => ({
  id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected",
});
const fixtureAgents = [fixtureAgent("a", "Mori"), fixtureAgent("b", "Hana")];
const fixtureApi = {
  ...api,
  "/api/workspace": { workspace: { id: "fixture" }, agents: fixtureAgents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: fixtureAgents[0], pending: [], artifacts: [], turns: [] },
  "/api/agents/b": { agent: fixtureAgents[1], pending: [], artifacts: [], turns: [] },
};

async function serve(route, fixture = false) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    const method = route.request().method();
    report.apiCalls.push(`${fixture ? "fixture " : ""}${method} ${url.pathname}`);
    const table = fixture ? fixtureApi : api;
    const hit = Object.keys(table).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (hit && method === "GET") return route.fulfill({ json: table[hit] });
    // On the synthetic Workspace any other read is empty; nothing is ever written.
    if (fixture && method === "GET") return route.fulfill({ json: {} });
    if (fixture) report.writes.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
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

const describe = (page) => page.evaluate(() => window.__describe(document.activeElement));
const ms = (v) => (v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN);

/** In the page: what a frame shows. The dialog's own nodes are those outside the copy. */
function pageHelpers() {
  window.__describe = (el) => {
    if (!el || el === document.body) return "body";
    return `${el.tagName.toLowerCase()}${el.className ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
  };
  window.__state = () => {
    const ghost = document.querySelector(".dialog-exit-ghost");
    const outside = (list) => [...list].filter((el) => !ghost?.contains(el));
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    return {
      dialog: outside(document.querySelectorAll('[role="dialog"], .modal')).length,
      ghost: !!ghost,
      ghostHidden: ghost ? ghost.getAttribute("aria-hidden") === "true" && ghost.inert && getComputedStyle(ghost).pointerEvents === "none" : null,
      ghostRoles: ghost ? ghost.querySelectorAll("[role], [id], [aria-modal]").length : 0,
      ghostAnimations: ghost ? ghost.getAnimations({ subtree: true }).map((a) => `${a.animationName}:${a.effect.getTiming().duration}`) : [],
      // The box's and the overlay's own: both fade, so only the box tells a confirmation's copy from another.
      ghostBox: ghost ? [...ghost.querySelectorAll(":scope > .modal")].flatMap((el) => el.getAnimations().map((a) => `${a.animationName}:${a.effect.getTiming().duration}`)) : [],
      ghostOverlay: ghost ? [...ghost.querySelectorAll(":scope > .modal-overlay")].flatMap((el) => el.getAnimations().map((a) => `${a.animationName}:${a.effect.getTiming().duration}`)) : [],
      ariaHiddenMarks: document.querySelectorAll("[data-aria-hidden]").length,
      scrollLocked: document.body.hasAttribute("data-scroll-locked") || getComputedStyle(document.body).overflow === "hidden",
      duplicateIds: ids.length - new Set(ids).size,
      focus: window.__describe(document.activeElement),
      focusInGhost: !!ghost?.contains(document.activeElement),
      ghostTitle: ghost?.querySelector("h2")?.textContent ?? null,
      ghostConfirm: ghost ? ghost.hasAttribute("data-confirm") : null,
    };
  };
  /** Sample every frame from the next Escape or click, for `span` ms. */
  window.__watch = (span = 700) => {
    window.__frames = [];
    const start = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      removeEventListener("keydown", start, true);
      removeEventListener("click", start, true);
      const t0 = performance.now();
      window.__frames.push({ t: 0, phase: "before", ...window.__state() });
      const frame = () => {
        const t = performance.now() - t0;
        window.__frames.push({ t: Math.round(t), ...window.__state() });
        if (t < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("keydown", start, true);
    addEventListener("click", start, true);
  };
}

/** Open a dialog, read its entrance, close it and judge every frame after. */
async function exitCase(page, tag, reduced, { name, open, close, confirm = false, entered = confirm, title = null, clickThrough = false }) {
  const before = await page.evaluate(() => window.__state());
  if (!(await open())) return report.notShown.push(`${tag}: ${name} could not be opened in the preview`);
  // As computed, so an entrance already over still counts; the keyframes themselves are checked once per run.
  const entrance = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".modal-overlay, .modal")]
    .filter((el) => !el.closest(".dialog-exit-ghost"))
    .map((el) => { const s = getComputedStyle(el);
      return [el.classList.contains("modal") ? "box" : "overlay", { name: s.animationName, duration: s.animationDuration, easing: s.animationTimingFunction }]; })));
  await page.waitForTimeout(350);
  if (!baseline) {
    const { box, overlay } = entrance;
    if (reduced) ok(`${tag}: ${name} opens with no animation under reduced motion`, box?.name === "none" && overlay?.name === "none", entrance);
    else
      ok(`${tag}: ${name} enters over medium with the standard easing: the overlay fades, the box ${entered ? "only fades" : "fades and rises 4px"}`,
        overlay?.name === "dialog-fade-in" && ms(overlay.duration) === 240 && ms(box?.duration) === 240 && /cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/.test(box.easing) &&
          box.name === (entered ? "dialog-fade-in" : "dialog-in"), entrance);
  }
  const rect = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".modal")].find((el) => !el.closest(".dialog-exit-ghost")).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => window.__clicks.push({ ghost: !!document.querySelector(".dialog-exit-ghost"),
      inGhost: !!e.target.closest?.(".dialog-exit-ghost"), target: window.__describe(e.target) }), { capture: true });
  });
  await page.evaluate(() => window.__watch(700));
  await close();
  if (clickThrough) await page.mouse.click(rect.x, rect.y);
  await page.waitForTimeout(800);
  const frames = await page.evaluate(() => window.__frames);
  const after = frames.filter((f) => f.phase !== "before");
  report.focus[`${tag}: ${name} closed`] = await describe(page);
  report.exits[`${tag}: ${name}`] = frames;
  if (baseline) return;
  const first = after[0] || {};
  const ghostFrames = after.filter((f) => f.ghost);
  ok(`${tag}: ${name}: in the first frame after the close the dialog is gone, focus is out of it, and no aria-hidden mark (in the copy either) or scroll lock is left`,
    first.dialog === 0 && !first.focusInGhost && first.ariaHiddenMarks === before.ariaHiddenMarks && first.scrollLocked === before.scrollLocked,
    { before, first });
  // Radix gives focus back in a timeout after the close: it must settle no later than in the build
  // before this batch (where it settles is compared at the end). A click right after moves it, so not then.
  if (!clickThrough && baselineExits) {
    const settledAt = (list) => { const settled = list.at(-1)?.focus; return list.findIndex((f) => f.focus === settled); };
    const was = (baselineExits[`${tag}: ${name}`] || []).filter((f) => f.phase !== "before");
    const now = settledAt(after), then = was.length ? settledAt(was) : null;
    ok(`${tag}: ${name}: focus settles by frame ${now} after the close, as in the build before this batch (frame ${then})`,
      then !== null && now >= 0 && now <= then, { now, then, frames: after.slice(0, 4).map((f) => [f.t, f.focus]) });
  }
  if (reduced) {
    ok(`${tag}: ${name}: no copy under reduced motion`, ghostFrames.length === 0, ghostFrames.length);
  } else {
    ok(`${tag}: ${name}: a copy fades out, aria-hidden, inert and clicked through, with no role, id or duplicate id`,
      ghostFrames.length > 0 && ghostFrames.every((f) => f.ghostHidden && f.ghostRoles === 0 && f.duplicateIds === before.duplicateIds), ghostFrames.slice(0, 2));
    const { ghostBox = [], ghostOverlay = [] } = ghostFrames[0] || {};
    ok(`${tag}: ${name}: the copy plays exit-medium, the box ${confirm ? "only fading" : "fading and sinking 4px"}`,
      ghostOverlay.join() === "dialog-fade-out:170" && ghostBox.join() === `${confirm ? "dialog-fade-out" : "dialog-out"}:170`, { box: ghostBox, overlay: ghostOverlay });
    if (title)
      ok(`${tag}: ${name}: the copy shows what was open (${title}), and it is the only dialog left`,
        ghostFrames.every((f) => title.test(f.ghostTitle || "") && f.dialog === 0 && f.ghostConfirm === confirm), ghostFrames.slice(0, 1));
    const last = ghostFrames.at(-1)?.t ?? Infinity;
    ok(`${tag}: ${name}: the copy is gone within 400 ms (last seen at ${last} ms)`, last <= 400 && !after.at(-1).ghost, last);
  }
  if (clickThrough) {
    const click = await page.evaluate(() => window.__clicks.at(-1));
    ok(`${tag}: ${name}: a click right where the dialog was lands on the page${reduced ? "" : ", not on the copy"}`,
      !!click && !click.inGhost && (reduced || click.ghost), click);
  }
}

const baselineExits = process.env.BASELINE_REPORT ? JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).exits : null;
const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
  { name: "app", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference", fixture: true },
  { name: "app-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce", fixture: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", (route) => serve(route, !!run.fixture));
  await page.addInitScript(pageHelpers);
  if (run.fixture) await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.goto(run.fixture ? "http://yuzuno-motion.test/" : "http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row, .phone-dock-button").first().waitFor();
  await page.waitForTimeout(400);
  if (!baseline) {
    const keyframes = await page.evaluate(() => {
      const out = {};
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules) if (rule instanceof CSSKeyframesRule && rule.name.startsWith("dialog-")) out[rule.name] = rule.cssText;
      return out;
    });
    const moves = (n) => /translate/.test(keyframes[n] || "");
    ok(`${tag}: the dialog keyframes: dialog-in and dialog-out move 4px, the fades only fade`,
      ["dialog-in", "dialog-out", "dialog-fade-in", "dialog-fade-out"].every((n) => keyframes[n]) && moves("dialog-in") && moves("dialog-out") &&
        /4px/.test(keyframes["dialog-in"]) && !moves("dialog-fade-in") && !moves("dialog-fade-out"), keyframes);
  }
  const visible = (selector) => page.locator(selector).filter({ visible: true }).first();
  const clickIfShown = async (selector) => {
    const el = visible(selector);
    // The read-only preview disables some (Jobs): those are reported as not shown.
    if (!(await el.count()) || !(await el.isEnabled())) return false;
    await el.click();
    await page.locator(".modal").first().waitFor({ timeout: 3000 });
    return true;
  };

  // A Modal closed by its `open` (New agent), with a click right where it was.
  await exitCase(page, tag, reduced, { name: "New agent", open: () => clickIfShown(".add-agent"),
    close: () => page.keyboard.press("Escape"), clickThrough: true });
  await page.keyboard.press("Escape");

  // Reopened during its exit: the new dialog shows at once, above the copy, with focus in it.
  if (!baseline && (await visible(".add-agent").count())) {
    await clickIfShown(".add-agent");
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await visible(".add-agent").click();
    const reopened = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const box = [...document.querySelectorAll(".modal")].find((el) => !el.closest(".dialog-exit-ghost"));
      const r = box?.getBoundingClientRect();
      done({ open: !!box, focusIn: !!box?.contains(document.activeElement), ghost: !!document.querySelector(".dialog-exit-ghost"),
        onTop: !!r && box.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20)) });
    }))));
    ok(`${tag}: reopened during its exit, the dialog shows at once with focus in it, above any copy`, reopened.open && reopened.focusIn && reopened.onTop, reopened);
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Jobs and the conversation search: direct Radix dialogs.
  await exitCase(page, tag, reduced, { name: "Jobs", open: () => clickIfShown(".jobs-nav"), close: () => page.keyboard.press("Escape") });
  await exitCase(page, tag, reduced, { name: "Search", open: () => clickIfShown(".conversation-search-trigger"), close: () => page.keyboard.press("Escape") });

  // Disconnect: a confirmation that unmounts while open, from an Agent's action menu.
  await exitCase(page, tag, reduced, {
    name: "Disconnect", confirm: true,
    open: async () => {
      const row = visible(".agent-row");
      if (!(await row.count())) return false;
      await row.hover();
      const more = visible(".agent-actions-button");
      if (!(await more.count())) return false;
      await more.click();
      const item = page.locator('.agent-actions-menu [role="menuitem"]', { hasText: /^Disconnect/ }).first();
      if (!(await item.count())) {
        await page.keyboard.press("Escape");
        return false;
      }
      await item.click();
      await page.locator(".modal").first().waitFor({ timeout: 3000 });
      return true;
    },
    close: () => page.locator(".modal .secondary-button", { hasText: /^Cancel/ }).first().click(),
  });
  // An Agent's confirmations (AgentManagement): Close, a confirmation from its opening, whose mode clears
  // as it closes; and Actions (from the Agent menu's Manage…) turned into Delete while open.
  if (run.fixture) {
    const closeAgent = async () => {
      const button = visible(".agent-close-button");
      if (!(await button.count()) || !(await button.isEnabled())) return false;
      await button.click();
      await page.locator(".modal").first().waitFor({ timeout: 3000 });
      return true;
    };
    await exitCase(page, tag, reduced, { name: "Close agent", confirm: true, title: /^Close Mori\?/, open: closeAgent, close: () => page.keyboard.press("Escape") });
    await exitCase(page, tag, reduced, {
      name: "Actions, then Delete", entered: false, confirm: true, title: /^Delete Mori\?/,
      open: async () => {
        await visible(".agent-row").hover();
        const more = visible(".agent-actions-button");
        if (!(await more.count())) return false;
        await more.click();
        const manage = page.locator('.agent-actions-menu [role="menuitem"]', { hasText: /^Manage/ }).first();
        if (!(await manage.count())) {
          await page.keyboard.press("Escape");
          return false;
        }
        await manage.click();
        const remove = page.locator(".modal .agent-action-card.danger-action").first();
        await remove.waitFor({ timeout: 3000 });
        await page.waitForTimeout(350);
        await remove.click();
        await page.locator(".modal h2", { hasText: /^Delete Mori\?/ }).first().waitFor({ timeout: 3000 });
        return true;
      },
      close: () => page.keyboard.press("Escape"),
    });
    // Closed and opened again at once: the new confirmation shows, a confirmation from its first frame,
    // with focus in it; no Actions dialog is left.
    if (!baseline && (await closeAgent())) {
      await page.waitForTimeout(350);
      await page.keyboard.press("Escape");
      await visible(".agent-close-button").click();
      const reopened = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => {
        const boxes = [...document.querySelectorAll(".modal")].filter((el) => !el.closest(".dialog-exit-ghost"));
        const box = boxes[0];
        done({ boxes: boxes.length, confirm: !!box?.classList.contains("modal-confirm"), animation: box && getComputedStyle(box).animationName,
          title: box?.querySelector("h2")?.textContent, focusIn: !!box?.contains(document.activeElement) });
      })));
      ok(`${tag}: Close agent reopened during its exit is one confirmation at once${reduced ? "" : ", fading in"}, with focus in it`,
        reopened.boxes === 1 && reopened.confirm && /^Close Mori\?/.test(reopened.title || "") && reopened.focusIn &&
          reopened.animation === (reduced ? "none" : "dialog-fade-in"), reopened);
      await page.waitForTimeout(350);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
  }
  // Changes (`/changes`): a dialog App mounts as `{… && (` and removes when it closes: the unmount path in Chromium.
  // It reads nothing until asked, and the command sends nothing.
  await exitCase(page, tag, reduced, {
    name: "Changes (unmounted on close)",
    open: async () => {
      const row = visible(".agent-row");
      if (await row.count()) await page.locator(".agent-row", { hasText: "Mikan" }).first().click().catch(() => {});
      const input = visible("[data-composer-input]");
      if (!(await input.count())) return false;
      await input.click();
      await page.keyboard.type("/changes");
      const send = visible(".send-button");
      if (!(await send.count()) || !(await send.isEnabled())) return false;
      await send.click();
      try {
        await page.locator(".modal.codex-changes").first().waitFor({ timeout: 3000 });
      } catch {
        return false;
      }
      return true;
    },
    close: () => page.keyboard.press("Escape"),
  });
  if (!reduced && !baseline && !run.phone) await page.screenshot({ path: join(output, `${tag}-after.png`) });
  await context.close();
}
await browser.close();

// Focus against the build before this batch: the same places, or a difference to explain.
if (process.env.BASELINE_REPORT) {
  const before = JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).focus;
  for (const [where, after] of Object.entries(report.focus))
    ok(`focus unchanged by this batch: ${where}`, before[where] === after, { before: before[where], after });
}
ok("nothing was written to the synthetic Workspace (Disconnect was only cancelled; /changes sends nothing)", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1b-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode: report.mode, passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown, focus: report.focus }));
process.exit(report.passed ? 0 : 1);
