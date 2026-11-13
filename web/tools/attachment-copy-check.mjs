// YN-102: a Home card's text attachment, Copy all and dragging a kept file
// out, in Chromium on a production build with every API answered here (no
// Core, no GitHub, no model). At 1440 and 390 wide, on an Ask's card on its
// project's page (YN-86: a narrow card) and on a report's page (wide), both
// opened from Home's project glance: Copy all sits in the text
// frame's top corner, inside the frame and clear of its scroll bar, nothing
// runs sideways; clicking it puts the whole file on the clipboard, not the
// last 200 lines shown, over https and over plain http (the copy command).
// At 1440 as Edge on Windows a kept file's icon and name drag out as a
// DownloadURL of that snapshot, and say so on hover; as Chrome on Android
// (390) nothing is draggable. Dropping on a real desktop is the user's to
// check: a page cannot drop outside the browser. Synthetic names and text only.
//   YUZUNO_UI_DIST=<isolated build> node tools/attachment-copy-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/attachment-copy");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const EDGE_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

// The files: a short handoff note (all of it shown) and a long package whose
// frame shows only its last 200 lines, each line wider than any card.
const files = {
  "handoff_notes_v3.md": ["# Handoff notes v3 (synthetic)", "", ...Array.from({ length: 84 }, (_, i) => `- R${i + 1}: answered; see table ${i % 7 + 1}.`)].join("\n") + "\n",
  "ROUND12_FOR_REVIEW_FULL_PACKAGE.md": Array.from({ length: 260 }, (_, i) =>
    `## Line ${i + 1}: review note ${i + 1} (synthetic), long enough to run past the frame's right edge and under its corner button.`).join("\n") + "\n",
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const taken = ago(90);
const base = { status: "idle", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const agents = [{ ...base, id: "a", name: "Mori", harness: "codex" }, { ...base, id: "b", name: "Hana", harness: "claude", color: "rose" }];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
const kept = (name, kind, mime, size) => ({ name, kind, mime, size, snapshot: true, mayChange: false, takenAt: taken });
const text = (name) => kept(name, "text", "text/markdown; charset=utf-8", Buffer.byteLength(files[name]));
const owner = (id) => ({ agentId: id, name: agents.find((a) => a.id === id).name, state: "active" });
let nextId = 11;
const section = (key, kind, title, version, by, body, attachments, extra = {}) => ({ id: nextId++, key, kind, title, version, owner: owner(by),
  updatedAt: ago(5), updatedTurnId: "t1", body, attachments, refs: {}, seen: null, history: false, ...extra });
const sections = [
  section("handoff", "ask", "Hand this to the reviewer?", 2, "a", spec(["files"], {
    files: node("Attachments", { items: [{ name: "handoff_notes_v3.md", caption: "Point-by-point answers for the reviewer" }, { name: "paper_draft_v2.pdf" }] }),
  }), [text("handoff_notes_v3.md"), kept("paper_draft_v2.pdf", "pdf", "application/pdf", 412_000)],
  { ask: { question: "Send these notes on?", state: "open", reply: { options: [{ id: "yes", label: "Send" }, { id: "no", label: "Not yet" }], freeText: true } } }),
  section("round12", "report", "Round 12 review package", 3, "b", spec(["lead", "files"], {
    lead: node("Markdown", { text: "The whole package for the reviewer." }),
    files: node("Attachments", { items: [{ name: "ROUND12_FOR_REVIEW_FULL_PACKAGE.md", caption: "The whole package" }] }),
  }), [text("ROUND12_FOR_REVIEW_FULL_PACKAGE.md")]),
];
const home = {
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections },
  }],
};
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };

/** Where Copy all stands in its frame and card, in CSS pixels. */
const placeOf = (button) => button.evaluate((el) => {
  const frame = el.parentElement.querySelector(".brief-preview-frame");
  const card = el.closest(".home-section, .home-report") || document.body;
  const b = el.getBoundingClientRect(), f = frame.getBoundingClientRect(), c = card.getBoundingClientRect();
  // The frame's content box: inside its border, left of its vertical scroll bar.
  const contentRight = f.left + frame.clientLeft + frame.clientWidth;
  const style = getComputedStyle(el);
  return { inFrame: b.top >= f.top && b.left >= f.left && b.bottom <= f.bottom && b.right <= contentRight + 0.5,
    clearOfBar: b.right <= contentRight + 0.5, bar: frame.offsetWidth - frame.clientWidth - 2 * frame.clientLeft,
    inCard: b.right <= c.right + 0.5 && f.right <= c.right + 0.5, visible: b.width > 0 && b.height > 0 && style.visibility === "visible",
    covered: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest("button") !== el };
});

// Playwright hides scroll bars in headless Chromium by default; this check
// wants them, to see Copy all stand clear of one.
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  ignoreDefaultArgs: ["--hide-scrollbars"] });
try {
  for (const viewport of [
    { name: "wide", width: 1440, height: 900, touch: false, agent: EDGE_WINDOWS },
    { name: "phone", width: 390, height: 844, touch: true, agent: CHROME_ANDROID },
  ]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch,
      isMobile: viewport.touch, reducedMotion: "reduce", userAgent: viewport.agent });
    const reads = [];
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
      assert.ok(url.hostname === "attachment-copy.test", url.href);
      if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
      if (method !== "GET") {
        report.writes.push({ viewport: viewport.name, method, path });
        return route.fulfill({ json: {} });
      }
      const attachment = /^\/api\/projects\/p1\/brief\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
      if (attachment) {
        const name = decodeURIComponent(attachment[2]);
        reads.push({ name, version: url.searchParams.get("version"), range: request.headers().range ?? null, origin: url.origin });
        // As Core: a Range is answered with the whole file (200).
        return files[name] ? route.fulfill({ body: files[name], contentType: "text/plain; charset=utf-8" })
          : route.fulfill({ body: Buffer.alloc(1024), contentType: "application/pdf" });
      }
      const detail = /^\/api\/agents\/([ab])$/.exec(path);
      const json = detail ? { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } : {
        "/api/workspace": { workspace: { id: "ws-copy" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/home": home, "/api/machine-load": machineLoad, "/api/agents/a/reading": { handoff: null }, "/api/agents/b/reading": { handoff: null },
        "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
        "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      }[path];
      if (json) return route.fulfill({ json });
      if (path.startsWith("/api/")) {
        report.unexpected.push(path);
        return route.fulfill({ json: {} });
      }
      const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
      assert.ok(file.startsWith(dist + "/"));
      await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[extname(file)] });
    });
    const secure = "https://attachment-copy.test";
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: secure });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.EventSource = class { close() {} };
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
    try {
      // Home, as a link names it; its project glance opens the project's page, where its cards are (YN-86).
      await page.goto(`${secure}/#/home?w=ws-copy`);
      await page.locator('[data-glance-project="p1"] .project-glance-open').click();
      const project = page.locator('[data-project-home="p1"]');
      await project.waitFor({ timeout: 15_000 });
      const card = (key) => project.locator(`.home-section[data-section-key="${key}"]`);
      // The inner locator of the scope's own page: the plain-http page below has its own.
      const attachment = (scope, name) => scope.locator(".brief-attachment", { has: scope.page().locator(`header strong:text-is("${name}")`) });
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
      // Opening a page may tell Core it was seen or opened; copying and dragging tell it nothing.
      const writesNow = () => report.writes.filter((w) => w.viewport === viewport.name).length;

      // 1. A narrow card on Home: the Ask's text attachment, Copy all in its frame's corner.
      const ask = card("handoff");
      await ask.waitFor();
      const short = attachment(ask, "handoff_notes_v3.md");
      await short.locator(".brief-tail").waitFor();
      const shortCopy = short.locator(".brief-preview > .copy-button");
      await shortCopy.scrollIntoViewIfNeeded();
      assert.equal(await shortCopy.innerText(), "Copy all");
      const shortPlace = await placeOf(shortCopy);
      assert.ok(shortPlace.visible && shortPlace.inFrame && shortPlace.inCard && !shortPlace.covered, JSON.stringify(shortPlace));
      await page.screenshot({ path: resolve(output, `${viewport.name}-home.png`), fullPage: true });
      const beforeCopy = writesNow();
      await shortCopy.click();
      await page.waitForFunction((el) => el.textContent === "Copied", await shortCopy.elementHandle());
      assert.equal(await clipboard(), files["handoff_notes_v3.md"], "the whole note on the clipboard");
      assert.equal(writesNow(), beforeCopy, "copying writes nothing");
      const showAll = ask.locator("button.brief-attachments-more");
      if ((await showAll.count()) && (await showAll.getAttribute("aria-expanded")) === "false") await showAll.click();
      const pdf = attachment(ask, "paper_draft_v2.pdf");
      await pdf.waitFor();
      assert.equal(await pdf.locator(".copy-button").count(), 0, "a PDF has no Copy all");
      check(`${viewport.name}: an Ask's card on its project page: Copy all inside its text frame's corner and the card; copies the whole file; the PDF has none`, shortPlace);

      // 2. A wide report page: the package's last 200 lines shown, all 260 copied.
      await card("round12").locator(".home-report-open").scrollIntoViewIfNeeded();
      await card("round12").locator(".home-report-open").click();
      const opened = page.locator(".home-report");
      await opened.locator(".report-head h1").waitFor();
      const long = attachment(opened, "ROUND12_FOR_REVIEW_FULL_PACKAGE.md");
      await long.locator(".brief-tail").waitFor();
      assert.match(await long.locator(".brief-preview small").innerText(), /Last 200 lines/);
      const longCopy = long.locator(".brief-preview > .copy-button");
      await longCopy.scrollIntoViewIfNeeded();
      const longPlace = await placeOf(longCopy);
      assert.ok(longPlace.visible && longPlace.inFrame && longPlace.clearOfBar && longPlace.inCard && !longPlace.covered, JSON.stringify(longPlace));
      assert.ok(longPlace.bar > 0, `this frame has a scroll bar taking room (${longPlace.bar})`);
      await page.screenshot({ path: resolve(output, `${viewport.name}-report.png`), fullPage: true });
      // By keyboard: from the frame, Tab reaches Copy all; Enter copies.
      await page.evaluate(() => navigator.clipboard.writeText(""));
      await long.locator(".brief-tail").focus();
      await page.keyboard.press("Tab");
      assert.ok(await longCopy.evaluate((el) => el === document.activeElement), "Tab from the frame reaches Copy all");
      const beforeKeyboard = writesNow();
      await page.keyboard.press("Enter");
      await page.waitForFunction((el) => el.textContent === "Copied", await longCopy.elementHandle());
      assert.equal(writesNow(), beforeKeyboard, "copying writes nothing");
      const copied = await clipboard();
      assert.equal(copied, files["ROUND12_FOR_REVIEW_FULL_PACKAGE.md"]);
      assert.equal(copied.trimEnd().split("\n").length, 260, "all 260 lines, not the 200 shown");
      const whole = reads.filter((r) => r.name === "ROUND12_FOR_REVIEW_FULL_PACKAGE.md");
      assert.ok(whole.some((r) => r.range) && whole.some((r) => !r.range), "the tail with a Range, the copy without");
      check(`${viewport.name}: a report page: Copy all clear of the frame's ${longPlace.bar}px scroll bar; reached by Tab; copies all 260 lines, not the 200 shown`, longPlace);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${viewport.name}: no sideways scroll (${overflow})`);
      check(`${viewport.name}: no sideways scroll`);

      // 3. Dragging out: a DownloadURL of the snapshot where Chromium saves one (Edge on Windows), nothing on a phone.
      const chip = long.locator(".brief-file");
      if (viewport.name === "wide") {
        assert.equal(await chip.getAttribute("draggable"), "true");
        assert.equal(await chip.evaluate((el) => getComputedStyle(el).cursor), "grab");
        const beforeDrag = writesNow();
        const transfer = await page.evaluateHandle(() => new DataTransfer());
        await chip.dispatchEvent("dragstart", { dataTransfer: transfer });
        assert.equal(writesNow(), beforeDrag, "dragging writes nothing");
        // Chromium keeps effectAllowed only on a real drag's DataTransfer, not on one made here
        // (it stays "none"); it is recorded, and the jsdom test reads that the page asks for "copy".
        const dropped = await transfer.evaluate((data) => ({ url: data.getData("DownloadURL"), effect: data.effectAllowed }));
        assert.equal(dropped.url,
          `text/markdown:ROUND12_FOR_REVIEW_FULL_PACKAGE.md:${secure}/api/projects/p1/brief/attachments/round12/ROUND12_FOR_REVIEW_FULL_PACKAGE.md?version=3`);
        await chip.hover();
        const tip = page.locator('.tip[role="tooltip"]');
        await tip.waitFor();
        assert.match(await tip.innerText(), /Drag to a folder or an app to save it as a file/);
        await page.screenshot({ path: resolve(output, `${viewport.name}-drag-hint.png`) });
        check(`${viewport.name} as Edge on Windows: the file's icon and name drag out as a DownloadURL of its snapshot (no credential), with a hint on hover`, dropped);
      } else {
        assert.equal(await chip.count(), 0);
        assert.equal(await page.locator('.home-report [draggable="true"]').count(), 0);
        check(`${viewport.name} as Chrome on Android: nothing drags out and no hint shows`);
      }

      // 4. Plain http at a LAN-like address: no Clipboard API, the copy command copies the whole file.
      if (viewport.name === "wide") {
        const plain = await context.newPage();
        await plain.addInitScript(() => {
          window.EventSource = class { close() {} };
          localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
        });
        plain.on("pageerror", (error) => report.errors.push(`plain: ${error.message}`));
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await plain.goto("http://attachment-copy.test/#/home?w=ws-copy");
        assert.equal(await plain.evaluate(() => isSecureContext || !!navigator.clipboard), false, "plain http: no Clipboard API");
        await plain.locator('[data-glance-project="p1"] .project-glance-open').click();
        const plainShort = attachment(plain.locator('[data-project-home="p1"] .home-section[data-section-key="handoff"]'), "handoff_notes_v3.md");
        await plainShort.locator(".brief-tail").waitFor();
        await plainShort.locator(".brief-preview > .copy-button").click();
        await plain.waitForFunction(() => [...document.querySelectorAll(".brief-preview > .copy-button")].some((b) => b.textContent === "Copied"));
        assert.equal(await clipboard(), files["handoff_notes_v3.md"], "the copy command copied the whole note");
        await plain.close();
        check("wide over plain http: Copy all copies the whole file with the copy command");
      }
    } catch (error) {
      // What the page showed when a step failed, for the next run's fix.
      await page.screenshot({ path: resolve(output, `${viewport.name}-failed.png`), fullPage: true }).catch(() => {});
      report.failedPage = { viewport: viewport.name, url: page.url(), text: (await page.locator("body").innerText().catch(() => "")).slice(0, 4000) };
      throw error;
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
console.log(`unexpected reads (answered {}): ${JSON.stringify([...new Set(report.unexpected)])}`);
