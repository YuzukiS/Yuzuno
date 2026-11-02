// T-19 batch 1a: the shared motion tokens, press and hover, the toast layer
// and reduced motion, in Chromium on a production build of the labelled
// design preview (?preview=1, synthetic Agents, no Core). Ordinary controls
// dip to .97 when pressed; anything that approves, answers or destroys only
// takes the pressed colour; with reduced motion nothing scales; the toasts
// sit above an open dialog; a theme switch runs no colour transition; the
// "go to pending" jump scrolls smoothly only without reduced motion. The
// pressed tint's text contrast is measured in every palette and theme.
// Where focus goes when a dialog or a menu closes is recorded, so a run on
// the build before this batch (--baseline) can show it did not change.
// The preview is read-only, so its answer and Interrupt buttons are
// disabled: the check enables them in the page to press them, since the
// CSS is what is under test. An emulated phone is not a real one, and
// Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1a-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1a");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", checks: [], failures: [], errors: [], apiCalls: [], notShown: [], focus: {}, contrast: [] };
// A baseline run records focus only; the build before this batch has no tokens or press rules.
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

async function serve(route) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    report.apiCalls.push(`${route.request().method()} ${url.pathname}`);
    const hit = Object.keys(api).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (hit && route.request().method() === "GET") return route.fulfill({ json: api[hit] });
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

/** Press and hold the first visible `selector`, read its transform and shadow, then leave without a click. */
async function press(page, selector, shot, { enable = false } = {}) {
  const el = page.locator(selector).filter({ visible: true }).first();
  if (!(await el.count())) return null;
  if (enable)
    await el.evaluate((node) => {
      for (let n = node; n; n = n.parentElement) if (n.disabled) n.disabled = false;
    });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(220);
  const state = await el.evaluate((node) => ({
    active: node.matches(":active"), transform: getComputedStyle(node).transform, shadow: getComputedStyle(node).boxShadow,
  }));
  if (shot) await el.screenshot({ path: join(output, shot) });
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  return state;
}
const pressedScale = (s) => !!s && s.active && /^matrix\(0\.97, 0, 0, 0\.97/.test(s.transform) && /inset/.test(s.shadow);
const pressedStill = (s) => !!s && s.active && s.transform === "none" && /inset/.test(s.shadow);
const describe = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "body";
  return `${el.tagName.toLowerCase()}${el.className ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
});
const ms = (v) => (v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN);

/** Text contrast of the visible pressable controls, and whether the pressed-in shadow (an inset
 *  edge shadow) stays clear of the text: if it reaches less far than the top padding, the
 *  background under the text is unchanged and pressed contrast is the resting contrast. */
function measureContrast() {
  // Any CSS colour (the build writes rgb(0 0 0 / 6%) as #0000000f) resolved by the browser itself.
  const probe = document.body.appendChild(document.createElement("i"));
  const parse = (c) => {
    probe.style.color = "";
    probe.style.color = c;
    const v = getComputedStyle(probe).color;
    const m = v.match(/rgba?\(([^)]+)\)/) || v.match(/color\(srgb ([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].replace("/", " ").split(/[\s,]+/).filter(Boolean)
      .map((p) => (p.endsWith("%") ? parseFloat(p) / 100 : Number(p)));
    const scale = v.startsWith("color(") ? 255 : 1;
    return { r: parts[0] * scale, g: parts[1] * scale, b: parts[2] * scale, a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 1) break;
    }
    return layers.reverse().reduce((acc, c) => over(c, acc), { r: 255, g: 255, b: 255, a: 1 });
  };
  const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const shadow = getComputedStyle(document.documentElement).getPropertyValue("--press-shadow").trim();
  // The first shadow's lengths (the build may write 0 without a unit and the colour as hex).
  const first = shadow.split(/,(?![^(]*\))/)[0];
  const lengths = first.replace(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b|inset/gi, " ").trim().split(/\s+/)
    .map(parseFloat).filter((n) => !Number.isNaN(n));
  if (!/inset/.test(first) || lengths.length < 3) return { shadow: null, rows: [] };
  const reach = Math.abs(lengths[1]) + lengths[2] + (lengths[3] || 0);
  const selector = ".primary-button, .secondary-button, .quiet-button, .icon-button, .catchup-nav, .conversation-action, .send-button, .choice-chips .choice-chip, .phone-dock-button, .interrupt-button";
  const rows = [...document.querySelectorAll(selector)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && (el.textContent || "").trim();
  }).slice(0, 40).map((el) => {
    const text = parse(getComputedStyle(el).color);
    // How far the text starts below the control's top edge (a flex-centred button may have no padding).
    const top = el.getBoundingClientRect().top;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let gap = Infinity;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) gap = Math.min(gap, r.top - top);
    }
    gap = +gap.toFixed(1);
    return { el: `${el.className.toString().split(/\s+/).slice(0, 2).join(".")} "${el.textContent.trim().slice(0, 18)}"`,
      rest: +ratio(text, background(el)).toFixed(2), gap, clear: gap >= reach };
  });
  probe.remove();
  return { shadow, reach, rows };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  // Record the behavior every scroll call asks for.
  await page.addInitScript(() => {
    window.__scrolls = [];
    for (const name of ["scrollTo", "scrollIntoView"]) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) {
        const options = args[0] && typeof args[0] === "object" ? args[0] : {};
        window.__scrolls.push({ name, behavior: options.behavior ?? null, cls: this.className?.toString?.().slice(0, 40) ?? "" });
        return original.apply(this, args);
      };
    }
  });
  await page.goto("http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row").first().waitFor();
  await page.waitForTimeout(400);
  const shot = (name) => (baseline || reduced ? null : name);

  // Tokens (the build writes 120ms as .12s), and no transition on "all" with a duration anywhere.
  const tokens = await page.evaluate(() => Object.fromEntries(["micro", "small", "medium", "exit-small", "exit-medium", "settle", "reveal"]
    .map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(`--motion-${n}`).trim()])));
  const want = { micro: 120, small: 180, medium: 240, "exit-small": 130, "exit-medium": 170, settle: 1200, reveal: 420 };
  ok(`${tag}: motion tokens are defined`, Object.entries(want).every(([k, v]) => ms(tokens[k]) === v), tokens);
  const allTransitions = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    const props = s.transitionProperty.split(", "), durations = s.transitionDuration.split(", ");
    return props.some((p, i) => p === "all" && parseFloat(durations[i % durations.length]) > 0);
  }).map((el) => el.className.toString().slice(0, 40)));
  ok(`${tag}: no element transitions "all"`, allTransitions.length === 0, allTransitions);

  if (!run.phone) {
    // Ordinary press: a toolbar nav button.
    const nav = await press(page, ".toolbar-nav .catchup-nav", shot("press-ordinary.png"));
    ok(`${tag}: an ordinary button ${reduced ? "keeps its size but takes the pressed colour" : "dips to .97 with the pressed colour"}`,
      reduced ? pressedStill(nav) : pressedScale(nav), nav);
    const navDuration = await page.locator(".toolbar-nav .catchup-nav").first().evaluate((n) => getComputedStyle(n).transitionDuration);
    ok(`${tag}: the nav button's transitions use micro (none under reduced motion)`, navDuration.split(", ").every((d) => d === (reduced ? "0s" : "0.12s")), navDuration);

    // Hana's question: its Send answer button only takes the colour.
    await page.locator(".agent-row", { hasText: "Hana" }).first().click();
    await page.locator(".pending-card").first().waitFor();
    const answer = await press(page, ".pending-card .primary-button", shot("press-approval.png"), { enable: true });
    ok(`${tag}: an answer button in a request card never moves, and takes the pressed colour`, pressedStill(answer), answer);

    // "Go to pending": smooth only without reduced motion.
    const shortcut = page.locator(".pending-shortcut").filter({ visible: true });
    if (await shortcut.count()) {
      await page.evaluate(() => (window.__scrolls.length = 0));
      await shortcut.first().click();
      const scrolls = await page.evaluate(() => window.__scrolls.filter((s) => s.name === "scrollTo"));
      ok(`${tag}: "go to pending" scrolls ${reduced ? "instantly" : "smoothly"}`, scrolls.length > 0 && scrolls.at(-1).behavior === (reduced ? "auto" : "smooth"), scrolls);
    } else report.notShown.push(`${tag}: the "go to pending" shortcut was not on screen`);

    // Mori is working: Interrupt never moves.
    await page.locator(".agent-row", { hasText: "Mori" }).first().click();
    await page.waitForTimeout(200);
    const stop = await press(page, ".interrupt-button", shot("press-interrupt.png"), { enable: true });
    if (stop) ok(`${tag}: Interrupt never moves, and takes the pressed colour`, pressedStill(stop), stop);
    else report.notShown.push(`${tag}: Interrupt was not shown for the preview's working Agent`);

    // A dialog: its actions never move; where focus goes on Escape is recorded.
    await page.locator(".add-agent").first().click();
    await page.locator(".modal").first().waitFor();
    await page.waitForTimeout(300);
    const cancel = await press(page, ".modal-actions .secondary-button", shot("press-dialog-action.png"));
    ok(`${tag}: a dialog's action never moves, and takes the pressed colour`, pressedStill(cancel), cancel);
    const layers = await page.evaluate(() => ({ toasts: getComputedStyle(document.querySelector(".toast-stack") || document.body).zIndex,
      overlay: getComputedStyle(document.querySelector(".modal-overlay")).zIndex }));
    ok(`${tag}: the toast layer sits above an open dialog's overlay`, Number(layers.toasts) > Number(layers.overlay), layers);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    report.focus[`${tag}: New agent dialog closed with Escape`] = await describe(page);

    // A theme switch: every colour changes in the same frame, no transition runs.
    const settings = page.locator(".workspace-settings").filter({ visible: true }).first();
    if (await settings.count()) {
      await settings.click();
      await page.locator(".modal").first().waitFor();
      const tab = page.locator('[role="tab"]', { hasText: /^Appearance/ }).first();
      if (await tab.count()) await tab.click();
      const dark = page.locator(".theme-choice-dark").first();
      if (await dark.count()) {
        const tweens = await dark.evaluate(async (label) => {
          label.click();
          let most = 0;
          for (let i = 0; i < 6; i++) {
            most = Math.max(most, document.getAnimations().filter((a) => a instanceof CSSTransition).length);
            await new Promise((r) => requestAnimationFrame(r));
          }
          return most;
        });
        ok(`${tag}: switching to the dark theme runs no colour transition (six frames sampled)`, tweens === 0, tweens);
        if (shot("x")) await page.screenshot({ path: join(output, "theme-dark-settings.png") });
        await page.locator(".theme-choice-light").first().click();
      } else report.notShown.push(`${tag}: the theme choices were not found in Settings`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      report.focus[`${tag}: Settings closed with Escape`] = await describe(page);
    } else report.notShown.push(`${tag}: no Settings entry in the preview toolbar`);

    // A real toast (a reply sent to Hana's draft), then a dialog opened over it: the toast stays visible on top.
    await page.locator(".agent-row", { hasText: "Mikan" }).first().click();
    const sendTo = page.locator(".reply-actions .send-to-agent-button").filter({ visible: true }).first();
    const toHana = page.locator('.send-to-agent-menu [role="menuitem"]', { hasText: "Hana" });
    if (await sendTo.count() && (await sendTo.click(), await toHana.count()) && await toHana.first().isEnabled()) {
      await toHana.first().click();
      report.focus[`${tag}: Send to Agent menu closed by choosing Hana`] = await describe(page);
      await page.locator(".toast").first().waitFor({ timeout: 3000 });
      await page.locator(".add-agent").first().click();
      await page.locator(".modal").first().waitFor();
      await page.waitForTimeout(300);
      const onTop = await page.evaluate(() => {
        const toast = document.querySelector(".toast");
        const r = toast.getBoundingClientRect();
        return toast.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      ok(`${tag}: a toast shown under an open dialog stays on top and visible`, onTop);
      const live = await page.evaluate(() => {
        const stack = document.querySelector(".toast-stack");
        return { live: stack?.getAttribute("aria-live"), hidden: !!stack?.closest('[aria-hidden="true"]') };
      });
      ok(`${tag}: with a dialog open, the toasts stay a live region that is not aria-hidden`, live.live === "polite" && !live.hidden, live);
      if (shot("x")) await page.screenshot({ path: join(output, "toast-over-dialog.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    } else report.notShown.push(`${tag}: Send to Agent → Hana was not available in the preview`);

    // The pressed-in shadow is visible in both themes: rest and pressed pictures of a filled
    // control and a quiet one, and the mean pixel difference along the top edge. Taken with
    // reduced motion so the press scale does not move the edge.
    if (reduced && !baseline) {
      await page.locator(".agent-row", { hasText: "Hana" }).first().click();
      await page.locator(".pending-card").first().waitFor();
      const pairs = [];
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => { document.documentElement.dataset.palette = "garden"; document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(100);
        for (const [kind, selector] of [["filled", ".pending-card .primary-button"], ["quiet", ".reply-actions .quiet-button, .turn .quiet-button"]]) {
          const el = page.locator(selector).filter({ visible: true }).first();
          if (!(await el.count())) continue;
          await el.evaluate((node) => { for (let n = node; n; n = n.parentElement) if (n.disabled) n.disabled = false; });
          await el.scrollIntoViewIfNeeded();
          // Rest is taken under the pointer too, so the pictures differ only by the press.
          const box = await el.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(150);
          const rest = await el.screenshot();
          await page.mouse.down();
          await page.waitForTimeout(150);
          const pressed = await el.screenshot();
          await page.mouse.move(2, 2);
          await page.mouse.up();
          await page.waitForTimeout(150);
          const diff = await page.evaluate(async ([a, b]) => {
            const load = (src) => new Promise((done) => { const i = new Image(); i.onload = () => done(i); i.src = src; });
            const [x, y] = await Promise.all([load(a), load(b)]);
            const read = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height); };
            const [p, q] = [read(x), read(y)];
            const rows = (from, to) => {
              let sum = 0, n = 0;
              for (let r = from; r < to; r++) for (let c = 2; c < p.width - 2; c++) {
                const i = (r * p.width + c) * 4;
                sum += (Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]) + Math.abs(p.data[i + 2] - q.data[i + 2])) / 3;
                n++;
              }
              return +(sum / n).toFixed(2);
            };
            const mid = Math.floor(p.height / 2);
            return { topEdge: rows(0, 3), middle: rows(mid - 1, mid + 1) };
          }, [`data:image/png;base64,${rest.toString("base64")}`, `data:image/png;base64,${pressed.toString("base64")}`]);
          pairs.push({ theme, kind, diff, rest: rest.toString("base64"), pressed: pressed.toString("base64") });
          ok(`${tag}: ${theme}: a pressed ${kind} control shows the pressed-in edge (top-edge pixel difference ${diff.topEdge})`, diff.topEdge >= 3, diff);
          ok(`${tag}: ${theme}: the ${kind} control's middle, behind its text, is unchanged when pressed (difference ${diff.middle})`, diff.middle < 1, diff);
        }
      }
      report.pressPairs = pairs.map(({ theme, kind, diff }) => ({ theme, kind, diff }));
      const cells = pairs.map((p) => `<figure><figcaption>${p.theme} · ${p.kind} · edge Δ ${p.diff.topEdge}</figcaption><img src="data:image/png;base64,${p.rest}"> <img src="data:image/png;base64,${p.pressed}"></figure>`).join("");
      const sheet = await page.context().newPage();
      await sheet.setContent(`<body style="margin:12px;font:12px system-ui;display:grid;grid-template-columns:1fr 1fr;gap:14px"><p style="grid-column:1/-1">Rest | pressed, garden palette, reduced motion (no scale)</p>${cells}</body>`);
      await sheet.screenshot({ path: join(output, "press-theme-pairs.png"), fullPage: true });
      await sheet.close();
      await page.evaluate(() => { document.documentElement.dataset.palette = "garden"; document.documentElement.dataset.theme = "light"; });
    }

    // The pressed tint's text contrast in every palette and theme (desktop, normal motion only).
    if (!reduced && !baseline) {
      await page.locator(".agent-row", { hasText: "Hana" }).first().click();
      await page.waitForTimeout(200);
      for (const palette of ["garden", "graphite", "pine", "sunroom", "yuzu"])
        for (const theme of ["light", "dark"]) {
          await page.evaluate(([p, t]) => { document.documentElement.dataset.palette = p; document.documentElement.dataset.theme = t; }, [palette, theme]);
          await page.waitForTimeout(80);
          const { shadow, reach, rows } = await page.evaluate(measureContrast);
          report.contrast.push({ palette, theme, shadow, reach, rows });
          ok(`${tag}: ${palette}/${theme}: the pressed-in shadow is read (${rows.length} controls measured)`, !!shadow && rows.length > 0, { shadow, rows: rows.length });
          const covering = rows.filter((r) => !r.clear);
          ok(`${tag}: ${palette}/${theme}: the pressed-in shadow stays clear of the text, so pressed contrast is the resting contrast`, covering.length === 0, { reach, covering });
        }
      await page.evaluate(() => { document.documentElement.dataset.palette = "garden"; document.documentElement.dataset.theme = "light"; });
    }
    if (shot("x")) await page.screenshot({ path: join(output, "desktop.png") });
  } else {
    // Phone: open a conversation, press a dock button; open the Agent menu by touch and close it.
    await page.locator(".agent-row", { hasText: "Mori" }).first().tap();
    await page.waitForTimeout(400);
    const dock = await press(page, ".phone-dock-button", baseline ? null : reduced ? "phone-press-dock-reduced.png" : "phone-press-dock.png");
    if (dock) ok(`${tag}: a phone dock button ${reduced ? "keeps its size" : "dips to .97"} with the pressed colour`, reduced ? pressedStill(dock) : pressedScale(dock), dock);
    else report.notShown.push(`${tag}: no visible phone dock button in the preview conversation`);
    if (!baseline) await page.screenshot({ path: join(output, `${tag}-conversation.png`) });
    const menu = page.locator("[aria-haspopup='menu']").filter({ visible: true }).first();
    if (await menu.count()) {
      await menu.tap();
      await page.waitForTimeout(300);
      const opened = await page.locator('[role="menu"]').count();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      report.focus[`${tag}: a menu opened by touch, closed with Escape`] = `${opened ? "opened" : "not opened"} → ${await describe(page)}`;
    } else report.notShown.push(`${tag}: no menu trigger on the phone conversation`);
  }
  await context.close();
}
await browser.close();

// Side by side, mid-press: an ordinary button and the controls that never move.
if (!baseline) {
  const pngs = ["press-ordinary.png", "press-approval.png", "press-interrupt.png", "press-dialog-action.png"];
  const imgs = [];
  for (const name of pngs) {
    try {
      imgs.push(`<figure><img src="data:image/png;base64,${(await readFile(join(output, name))).toString("base64")}"><figcaption>${name}</figcaption></figure>`);
    } catch {}
  }
  const b2 = await launchBrowser();
  const p = await (await b2.newContext({ viewport: { width: 900, height: 220 }, deviceScaleFactor: 2 })).newPage();
  await p.setContent(`<body style="margin:16px;font:12px system-ui;display:flex;gap:18px;align-items:flex-start">${imgs.join("")}</body>`);
  await p.screenshot({ path: join(output, "press-compare.png"), fullPage: true });
  await b2.close();
}

// Focus against the build before this batch: the same places, or a difference to explain.
if (process.env.BASELINE_REPORT) {
  const before = JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).focus;
  for (const [where, after] of Object.entries(report.focus))
    ok(`focus unchanged by this batch: ${where}`, before[where] === after, { before: before[where], after });
}
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1a-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode: report.mode, passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown, focus: report.focus }));
process.exit(report.passed ? 0 : 1);
