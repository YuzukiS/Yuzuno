// Settings' shell (YN-8 S1) on the built app in isolated Chromium. Every
// request is answered by synthetic fixtures; no Core, no real storage.
// What the jsdom tests cannot see: the dialog's size against Tasks &
// messages; its layout at 1440, 1280 and 951×669 and on a 390 px phone, in
// English and Chinese, light and dark; the shared slider; and the deep links
// from the Workspace menu (New project, Manage projects, Machines) and the
// status bar's machines. Screenshots go to YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates, noJobs, noCiRuns, noReviews, noLiveJobs, idleJobsBudget } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST && process.env.YUZUNO_BROWSER_OUTPUT, "Explicit isolated assets/output required");
const dist = resolve(process.env.YUZUNO_UI_DIST), output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
assert.ok(!dist.endsWith("/web/dist"), "Use a separate build");
await mkdir(output, { recursive: true });
const origin = "http://settings-shell.test";
const base = { cwd: "/fixture/garden", threadId: "fixture-thread", connectionState: "connected", status: "idle", model: "fixture-model", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const lab = { id: "lab", name: "Lab box", kind: "ssh", target: "lab-box", codex: "/usr/local/bin/codex", defaultCwd: "/srv/lab", lastCheck: null };
const machines = [{ id: "local", name: "Fixture Core", kind: "local", defaultCwd: "/fixture", lastCheck: null }, lab];
const agents = [
  { ...base, id: "cedar", name: "Cedar", harness: "codex", projectId: "garden" },
  { ...base, id: "pine", name: "Pine", harness: "codex", projectId: "orchard" },
  // On an SSH machine, so the status bar shows the machines.
  { ...base, id: "maple", name: "Maple", harness: "claude", projectId: "orchard", cwd: "/srv/lab/x", remote: { machine: { ...lab } } },
];
const projects = [
  { id: "garden", name: "Garden", defaultDirs: { local: "/fixture/garden" }, createdAt: "", updatedAt: "" },
  { id: "orchard", name: "Orchard", defaultDirs: { local: "/fixture/orchard" }, createdAt: "", updatedAt: "" },
];
const checks = [], errors = [], calls = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/bin/chromium" });

/** A fresh page at a size, language and theme; nothing carried over. */
async function open({ width, height, language = "en", theme = "light", phone = false, scope = null }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, deviceScaleFactor: 1, locale: language === "zh-Hans" ? "zh-CN" : "en-US" });
  await context.addInitScript(([language, theme, scope]) => {
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("cedar"));
    if (scope) localStorage.setItem("yuzuno.projectScope.settings-shell", scope);
  }, [language, theme, scope]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, "No real or third-party services");
    if (!url.pathname.startsWith("/api/")) {
      const path = resolve(dist, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      assert.ok(path.startsWith(dist + "/"));
      try { return await route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] || "application/octet-stream" }); }
      catch { return route.fulfill({ status: 404, body: "" }); }
    }
    calls.push({ path: url.pathname, method: request.method() });
    const respond = (value) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
    if (agent) return respond({ agent, turns: [{ id: `turn-${agent.id}`, status: "completed", items: [{ id: `reply-${agent.id}`, type: "agentMessage", text: "Synthetic conversation" }] }], pending: [], artifacts: [], messages: [] });
    if (/\/projects\/[^/]+\/services$/.test(url.pathname)) return respond({ services: [] });
    if (/\/projects\/[^/]+\/home-editors$/.test(url.pathname)) return respond({ version: 0, editorAgentIds: null });
    // A Project's leads: none saved; a save (YN-8 S2b) is taken as sent.
    if (/\/projects\/[^/]+\/leads$/.test(url.pathname))
      return respond(request.method() === "PUT" ? { version: 1, leadAgentIds: request.postDataJSON().leadAgentIds } : { version: 0, leadAgentIds: [] });
    if (url.pathname === "/api/collaboration/github_repositories") return respond({ links: [], repositories: [], refreshing: false });
    switch (url.pathname) {
      case "/api/health": return respond({ product: "yuzuno", application: "yuzuno-next", workspaceId: "settings-shell", releaseId: "fixture" });
      case "/api/workspace": return respond({ agents, projects, projectUsage: {}, runtime: { connected: true }, defaultCwd: "/fixture", workspace: { id: "settings-shell" } });
      case "/api/updates": case "/api/updates/check": return respond(unmanagedUpdates);
      case "/api/models": return respond({ models: [] });
      case "/api/machines": return respond({ machines });
      case "/api/jobs": return respond(noJobs);
      case "/api/jobs/budget": return respond(idleJobsBudget);
      case "/api/jobs/live": return respond(noLiveJobs);
      case "/api/ci": return respond(noCiRuns);
      case "/api/reviews": return respond(noReviews);
      case "/api/catchup": return respond({ items: [], agents: [] });
      default: return respond(url.pathname.includes("/collaboration/") ? { tasks: [], messages: [], agents: [] } : {});
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${width}x${height} ${language} ${theme}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && /TypeError|ReferenceError|Minified React error/.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.locator(".agent-list").waitFor();
  return { page, context };
}
const settings = (page) => page.locator(".modal.settings-modal");
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
async function openSettings(page) {
  await page.locator(".workspace-settings").click();
  await settings(page).locator(".settings-center").waitFor();
  await page.waitForTimeout(250); // the dialog's entrance
}
/** Nothing wider than its box: the dialog, its pane and its sidebar. */
async function noOverflow(page, label) {
  const sizes = await settings(page).evaluate((el) => [el, el.querySelector(".settings-pane"), el.querySelector(".settings-side")]
    .filter(Boolean).map((part) => ({ name: part.className, scroll: part.scrollWidth, client: part.clientWidth })));
  for (const part of sizes) assert.ok(part.scroll <= part.client + 1, `${label}: ${part.name} overflows sideways (${part.scroll} > ${part.client})`);
}
const words = {
  en: { groups: ["This device", "Workspace", "Data", "About"], appearance: "Appearance", machines: "Machines", back: "Settings" },
  "zh-Hans": { groups: ["这台设备", "工作区", "数据", "关于"], appearance: "外观", machines: "机器", back: "设置" },
};

try {
  // ---- Size: at least Tasks & messages', at each desktop size.
  for (const [width, height] of [[1440, 900], [1280, 800], [951, 669]]) {
    const { page, context } = await open({ width, height });
    await page.locator(".collab-nav").click();
    const tasks = page.getByRole("dialog");
    await tasks.waitFor(); await page.waitForTimeout(250);
    const tasksBox = await box(tasks);
    await page.keyboard.press("Escape");
    await tasks.waitFor({ state: "detached" });
    await openSettings(page);
    const own = await box(settings(page));
    assert.ok(own.w >= tasksBox.w - 1 && own.h >= tasksBox.h - 1, `${width}x${height}: Settings ${own.w}x${own.h} is smaller than Tasks & messages ${tasksBox.w}x${tasksBox.h}`);
    assert.equal(own.w, Math.min(1280, width - 40), `${width}x${height}: width min(1280px, 100vw - 40px)`);
    assert.equal(own.h, Math.min(900, height - 48), `${width}x${height}: height min(900px, 100dvh - 48px)`);
    await writeFile(resolve(output, `size-${width}x${height}.json`), JSON.stringify({ settings: own, tasks: tasksBox }, null, 2));
    await context.close();
    check(`${width}x${height}: Settings is ${own.w}x${own.h}, at least Tasks & messages' ${tasksBox.w}x${tasksBox.h}`);
  }

  // ---- The shell at each size, in each language and theme.
  for (const [width, height] of [[1440, 900], [1280, 800], [951, 669]]) {
    for (const language of ["en", "zh-Hans"]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}x${height} ${language} ${theme}`;
        const { page, context } = await open({ width, height, language, theme });
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, `${label}: the theme applies`);
        await openSettings(page);
        const dialog = settings(page);
        assert.equal(await dialog.locator(".settings-center").getAttribute("lang"), language === "en" ? "en" : "zh-Hans");
        assert.deepEqual(await dialog.locator(".settings-nav-heading").allInnerTexts(), words[language].groups.map((g) => language === "en" ? g.toUpperCase() : g), `${label}: four groups`);
        assert.equal(await dialog.getByRole("tab").count(), 18);
        // Opens at Updates, as before.
        assert.equal(await dialog.locator("#settings-tab-updates").getAttribute("aria-selected"), "true");
        await noOverflow(page, `${label} updates`);
        await dialog.locator("#settings-tab-appearance").click();
        await dialog.locator("#settings-editor-appearance:not([hidden])").waitFor();
        assert.equal(await dialog.locator("#settings-tab-appearance .settings-nav-label").innerText(), words[language].appearance);
        // The sidebar stays put while the page scrolls.
        const side = await box(dialog.locator(".settings-side"));
        await dialog.locator(".settings-pane").evaluate((el) => el.scrollTo({ top: 400 }));
        await page.waitForTimeout(100);
        assert.deepEqual(await box(dialog.locator(".settings-side")), side, `${label}: the sidebar does not scroll with the page`);
        await dialog.locator(".settings-pane").evaluate((el) => el.scrollTo({ top: 0 }));
        await noOverflow(page, `${label} appearance`);
        await page.screenshot({ path: resolve(output, `shell-${width}x${height}-${language}-${theme}.png`) });
        await dialog.locator("#settings-tab-machines").click();
        await dialog.locator("#settings-editor-machines:not([hidden]) .machine-row, #settings-editor-machines:not([hidden]) [data-machine-id]").first().waitFor().catch(() => {});
        await dialog.locator("#settings-editor-machines:not([hidden])").getByText("Lab box").first().waitFor();
        await noOverflow(page, `${label} machines`);
        await page.screenshot({ path: resolve(output, `machines-${width}x${height}-${language}-${theme}.png`) });
        await context.close();
        check(`${label}: four groups, 18 pages, Appearance and Machines shown with no sideways overflow; sidebar fixed`);
      }
    }
  }

  // ---- A 390 px phone: the list of pages first, a page with Back.
  for (const language of ["en", "zh-Hans"]) {
    for (const theme of ["light", "dark"]) {
      const label = `390 ${language} ${theme}`;
      const { page, context } = await open({ width: 390, height: 844, language, theme, phone: true });
      await openSettings(page);
      const dialog = settings(page);
      assert.deepEqual(await box(dialog), { x: 0, y: 0, w: 390, h: 844 }, `${label}: Settings fills the screen`);
      assert.match(await dialog.locator(".settings-center").getAttribute("class"), /is-root/);
      assert.equal(await dialog.locator(".settings-editor:not([hidden])").count(), 0, `${label}: no page over the list`);
      for (const tab of await dialog.getByRole("tab").all()) {
        const r = await box(tab);
        assert.ok(r.h >= 44, `${label}: ${await tab.innerText()} is ${r.h}px tall`);
      }
      await noOverflow(page, `${label} list`);
      await page.screenshot({ path: resolve(output, `phone-list-${language}-${theme}.png`), fullPage: false });
      await dialog.locator("#settings-tab-appearance").click();
      await dialog.locator("#settings-editor-appearance:not([hidden])").waitFor();
      const back = dialog.locator(".settings-back");
      assert.equal((await back.innerText()).trim(), words[language].back);
      // Back is in the title's row, the title hidden: "Settings" once.
      const [backBox, closeBox] = [await box(back), await box(dialog.locator(".modal-heading > button"))];
      assert.ok(Math.abs((backBox.y + backBox.h / 2) - (closeBox.y + closeBox.h / 2)) <= 2, `${label}: Back ${JSON.stringify(backBox)} beside Close ${JSON.stringify(closeBox)}`);
      assert.equal(await dialog.locator(".modal-heading h2").evaluate((h) => getComputedStyle(h).visibility), "hidden");
      assert.equal(await dialog.locator(".settings-side").isVisible(), false, `${label}: the list gives way to the page`);
      const slider = dialog.locator('input[type="range"][name="appearance-font-size"]');
      const thumbRow = await box(slider);
      assert.ok(thumbRow.h >= 44, `${label}: the slider is ${thumbRow.h}px tall to touch`);
      await noOverflow(page, `${label} appearance`);
      await page.screenshot({ path: resolve(output, `phone-appearance-${language}-${theme}.png`) });
      await back.click();
      await dialog.locator(".settings-center.is-root").waitFor();
      await context.close();
      check(`${label}: full screen; the list first, 44px rows; a page with Back; no overflow`);
    }
  }

  // ---- The shared slider: the value beside it, typed there too.
  {
    const { page, context } = await open({ width: 1440, height: 900 });
    await openSettings(page);
    const dialog = settings(page);
    await dialog.locator("#settings-tab-appearance").click();
    const size = dialog.locator(".settings-slider", { has: page.locator('input[name="appearance-font-size"]') });
    const typed = size.locator('input[type="number"]');
    await typed.fill("18"); await typed.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.fontSize === "18");
    assert.equal(await size.locator('input[type="range"]').inputValue(), "18");
    await size.locator('input[type="range"]').focus(); await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.documentElement.dataset.fontSize === "19");
    assert.equal(await typed.inputValue(), "19", "the typed field follows the slider");
    await typed.fill("40"); await typed.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.fontSize === "24");
    assert.equal(await typed.inputValue(), "24", "a typed value is kept to the range");
    const dock = dialog.locator(".dock-limit").first();
    await dock.locator('input[type="number"]').fill("0"); await dock.locator('input[type="number"]').press("Enter");
    await page.waitForFunction(() => document.querySelector(".dock-limit output")?.textContent === "Hidden");
    await size.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, "slider-1440.png"), clip: { ...(await box(size)), x: (await box(size)).x - 8, y: (await box(size)).y - 8, width: (await box(size)).w + 16, height: (await box(size)).h + 16 } });
    await context.close();
    check("slider A: typed 18 applies; a key steps it to 19 and the field follows; 40 is kept to 24; 0 says Hidden");
  }

  // ---- Settings › Projects (S2a): the list first, a project's page in four cards.
  for (const [width, height, phone] of [[1440, 900, false], [951, 669, false], [390, 844, true]]) {
    for (const [language, theme] of [["en", "light"], ["zh-Hans", "dark"]]) {
      const label = `projects ${width}x${height} ${language} ${theme}`;
      const { page, context } = await open({ width, height, language, theme, phone });
      await page.locator(".workspace-scope").click();
      await page.getByRole("menuitem", { name: language === "en" ? "Manage projects…" : "管理项目…" }).click();
      const dialog = settings(page);
      const title = dialog.locator("#settings-projects-title");
      await dialog.locator(".settings-projects .settings-list").first().waitFor();
      await page.waitForTimeout(300); // the dialog's entrance
      assert.equal(await title.innerText(), language === "en" ? "Projects" : "项目", `${label}: the list, no project chosen`);
      assert.deepEqual(await dialog.locator(".settings-projects .settings-list-title").allInnerTexts(),
        ["Garden", "Orchard", language === "en" ? "New project" : "新建项目"]);
      await noOverflow(page, `${label} list`);
      await page.screenshot({ path: resolve(output, `projects-list-${width}x${height}-${language}-${theme}.png`) });
      await dialog.locator(".settings-projects .settings-list-row", { hasText: "Orchard" }).click();
      await page.waitForFunction(() => document.querySelector("#settings-projects-title")?.textContent === "Orchard");
      assert.equal(await dialog.locator(".settings-projects > .settings-group").count(), 4, `${label}: four cards`);
      await dialog.locator(".settings-projects .services-panel").waitFor();
      await noOverflow(page, `${label} project`);
      // Nothing inside a card is wider than the card.
      const wide = await dialog.locator(".settings-projects > .settings-group").evaluateAll((cards) => cards.flatMap((card) => {
        const right = card.getBoundingClientRect().right + 1;
        return [...card.querySelectorAll("input, select, textarea, button")].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().right > right)
          .map((el) => el.getAttribute("aria-label") || el.textContent.trim().slice(0, 40));
      }));
      assert.deepEqual(wide, [], `${label}: every control inside its card`);
      await page.screenshot({ path: resolve(output, `projects-page-${width}x${height}-${language}-${theme}.png`) });
      for (const [index, name] of [[0, "members"], [1, "defaults"]]) {
        await dialog.locator(".settings-projects .settings-group-title").nth(index).evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(100);
        await page.screenshot({ path: resolve(output, `projects-${name}-${width}x${height}-${language}-${theme}.png`) });
      }
      await dialog.locator(".settings-projects > .settings-group").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(100);
      await page.screenshot({ path: resolve(output, `projects-archive-${width}x${height}-${language}-${theme}.png`) });
      // S2b: one members block, a Lead switch per member; one save bar for the page, in view at the pane's foot.
      const members = dialog.locator(".project-leads");
      await members.locator("[role=switch]").first().waitFor();
      assert.deepEqual(await members.locator(".project-leads-members li strong").allInnerTexts(), ["Pine", "Maple"], `${label}: Orchard's members`);
      assert.deepEqual(await members.locator("[role=switch]").evaluateAll((list) => list.map((el) => el.getAttribute("aria-checked"))), ["false", "false"]);
      const bar = dialog.locator(".settings-savebar");
      assert.equal(await bar.isVisible(), false, `${label}: no bar before a change`);
      const lead = language === "en" ? "Lead · Pine" : "负责人 · Pine";
      await members.getByRole("switch", { name: lead }).click();
      await bar.waitFor({ state: "visible" });
      assert.equal(await bar.locator("span").first().innerText(), language === "en" ? "1 change not saved" : "1 处更改还没保存");
      const placed = await bar.evaluate((el) => {
        let pane = el.parentElement;
        while (pane && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
        const b = el.getBoundingClientRect(), p = (pane ?? document.documentElement).getBoundingClientRect();
        return { inside: b.top >= p.top - 1 && b.bottom <= Math.min(p.bottom, innerHeight) + 1, atFoot: Math.abs(Math.min(p.bottom, innerHeight) - b.bottom) <= 24, buttons: [...el.querySelectorAll("button")].map((x) => x.getBoundingClientRect().right <= b.right + 1) };
      });
      assert.deepEqual(placed, { inside: true, atFoot: true, buttons: [true, true] }, `${label}: the bar is in view at the foot of the pane, its buttons inside it`);
      await noOverflow(page, `${label} with the bar`);
      await page.screenshot({ path: resolve(output, `projects-savebar-${width}x${height}-${language}-${theme}.png`) });
      await bar.getByRole("button", { name: language === "en" ? "Discard" : "放弃" }).click();
      await bar.waitFor({ state: "hidden" });
      assert.equal(await members.getByRole("switch", { name: lead }).getAttribute("aria-checked"), "false", `${label}: Discard is back to what was saved`);
      await members.getByRole("switch", { name: lead }).click();
      const puts = () => calls.filter((call) => call.method === "PUT" && call.path === "/api/projects/orchard/leads").length;
      const before = puts();
      await bar.getByRole("button", { name: language === "en" ? "Save" : "保存", exact: true }).click();
      await bar.getByText(language === "en" ? "All changes saved." : "所有更改都已保存。").waitFor();
      assert.equal(puts() - before, 1, `${label}: one save of the leads`);
      assert.equal(await members.getByRole("switch", { name: lead }).getAttribute("aria-checked"), "true");
      await dialog.locator(".settings-crumb").click();
      await dialog.locator(".settings-projects .settings-list").first().waitFor();
      assert.equal(await title.innerText(), language === "en" ? "Projects" : "项目", `${label}: Back returns to the list`);
      await context.close();
      check(`${label}: the list first; Orchard's page in four cards, every control inside its card; a Lead switch per member, one save bar in view, Discard and Save; Back to the list`);
    }
  }

  // ---- Settings › Machines (S3a): the list first, a page per machine; the
  // Core host's has its Job budget.
  for (const [width, height, phone] of [[1440, 900, false], [951, 669, false], [390, 844, true]]) {
    for (const [language, theme] of [["en", "light"], ["zh-Hans", "dark"]]) {
      const label = `machines ${width}x${height} ${language} ${theme}`;
      const { page, context } = await open({ width, height, language, theme, phone });
      await page.locator(".workspace-scope").click();
      await page.getByRole("menuitem", { name: language === "en" ? "Machines…" : "机器…" }).click();
      const dialog = settings(page);
      const title = dialog.locator("#settings-machines-title");
      await dialog.locator('[data-machine-row="lab"]').waitFor();
      await page.waitForTimeout(300); // the dialog's entrance
      assert.equal(await title.innerText(), language === "en" ? "Machines" : "机器", `${label}: the list, no machine chosen`);
      await noOverflow(page, `${label} list`);
      await page.screenshot({ path: resolve(output, `machines-list-${width}x${height}-${language}-${theme}.png`) });
      const inCards = (name) => dialog.locator(".settings-machines > .settings-group").evaluateAll((cards) => cards.flatMap((card) => {
        const right = card.getBoundingClientRect().right + 1;
        return [...card.querySelectorAll("input, select, textarea, button")].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().right > right)
          .map((el) => el.getAttribute("aria-label") || el.textContent.trim().slice(0, 40));
      })).then((wide) => assert.deepEqual(wide, [], `${label} ${name}: every control inside its card`));
      await dialog.locator('[data-machine-row="local"]').click();
      await dialog.locator('article[data-machine-id="local"]').waitFor();
      await dialog.locator("#settings-block-jobs #settings-jobs-budget").waitFor();
      await noOverflow(page, `${label} Core host`);
      await inCards("Core host");
      await page.screenshot({ path: resolve(output, `machines-host-${width}x${height}-${language}-${theme}.png`) });
      await dialog.locator("#settings-block-jobs").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(100);
      await page.screenshot({ path: resolve(output, `machines-host-jobs-${width}x${height}-${language}-${theme}.png`) });
      await dialog.locator(".settings-crumb").click();
      await dialog.locator('[data-machine-row="lab"]').click();
      await dialog.locator('article[data-machine-id="lab"]').waitFor();
      assert.equal(await dialog.locator("#settings-block-jobs").count(), 0, `${label}: an SSH machine's Jobs are in its editor`);
      await noOverflow(page, `${label} Lab box`);
      await inCards("Lab box");
      await page.screenshot({ path: resolve(output, `machines-ssh-${width}x${height}-${language}-${theme}.png`) });
      await context.close();
      check(`${label}: the list first; the Core host's page with its Job budget and Lab box's page, every control inside its card`);
    }
  }

  // ---- This device's pages (S4a): Typing & time and Language as Appearance's cards.
  for (const [width, height, phone] of [[1440, 900, false], [951, 669, false], [390, 844, true]]) {
    for (const [language, theme] of [["en", "light"], ["zh-Hans", "dark"]]) {
      const label = `device ${width}x${height} ${language} ${theme}`;
      const { page, context } = await open({ width, height, language, theme, phone });
      await openSettings(page);
      const dialog = settings(page);
      for (const [tab, editor, cards] of [["typing", "input", 5], ["language", "language", 3]]) {
        await dialog.locator(`#settings-tab-${tab}`).click();
        const shown = dialog.locator(`#settings-editor-${editor}:not([hidden])`);
        await shown.waitFor();
        await page.waitForTimeout(150);
        assert.equal(await shown.locator(".settings-choice").count(), cards, `${label} ${tab}: ${cards} choice cards`);
        assert.equal(await shown.locator(".settings-choice input:checked").count(), tab === "typing" ? 2 : 1, `${label} ${tab}: one chosen per block`);
        await noOverflow(page, `${label} ${tab}`);
        const pane = dialog.locator("#settings-page");
        const wide = await pane.evaluate((el) => {
          const right = el.getBoundingClientRect().right + 1;
          return [...el.querySelectorAll(".settings-editor:not([hidden]) :is(label, select, button, .theme-choice)")]
            .filter((c) => c.getBoundingClientRect().width && c.getBoundingClientRect().right > right).map((c) => c.textContent.trim().slice(0, 40));
        });
        assert.deepEqual(wide, [], `${label} ${tab}: nothing wider than the page`);
        await page.screenshot({ path: resolve(output, `device-${tab}-${width}x${height}-${language}-${theme}.png`) });
        if (tab === "typing") {
          await dialog.locator("#settings-editor-time").evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(100);
          await page.screenshot({ path: resolve(output, `device-time-${width}x${height}-${language}-${theme}.png`) });
        }
        if (phone) {
          await dialog.locator(".settings-back").click();
          await dialog.locator(".settings-center.is-root").waitFor();
        }
      }
      // A card chosen by click: the clock's 24-hour applies at once.
      await dialog.locator("#settings-tab-typing").click();
      await dialog.locator('input[name="time-clock-format"][value="h24"]').locator("xpath=..").click();
      assert.equal(await dialog.locator('input[name="time-clock-format"][value="h24"]').isChecked(), true, `${label}: a card's click chooses it`);
      await context.close();
      check(`${label}: Typing & time (5 cards, two chosen) and Language (3 cards) fit; a card's click chooses it`);
    }
  }

  // ---- This device's other pages (S4b): Shortcuts, Notifications and Move to
  // another device in Appearance's cards; notification on/offs are switches.
  for (const [width, height, phone] of [[1440, 900, false], [951, 669, false], [390, 844, true]]) {
    for (const [language, theme] of [["en", "light"], ["zh-Hans", "dark"]]) {
      const label = `device b ${width}x${height} ${language} ${theme}`;
      const { page, context } = await open({ width, height, language, theme, phone });
      await openSettings(page);
      const dialog = settings(page);
      for (const [tab, editor] of [["shortcuts", "shortcuts"], ["notifications", "notifications"], ["transfer", "transfer"]]) {
        await dialog.locator(`#settings-tab-${tab}`).click();
        const shown = dialog.locator(`#settings-editor-${editor}:not([hidden])`);
        await shown.waitFor();
        await page.waitForTimeout(150);
        const cards = await shown.locator(".settings-group").evaluateAll((list) => list.map((el) => el.classList.contains("appearance-group")));
        assert.ok(cards.length > 0 && cards.every(Boolean), `${label} ${tab}: every group is one of Appearance's cards (${cards})`);
        if (tab === "shortcuts") {
          assert.equal(await shown.locator("fieldset.shortcut-keys > legend").count(), 1, `${label}: the letters' block has its legend`);
          assert.equal(await shown.locator(".shortcut-groups > .shortcut-group").count(), 5, `${label}: the five lists in one card`);
        }
        if (tab === "notifications")
          assert.equal(await shown.locator('input[type="checkbox"]:not(.settings-toggle)').count(), 0, `${label}: every on/off is a switch`);
        await noOverflow(page, `${label} ${tab}`);
        const pane = dialog.locator("#settings-page");
        const wide = await pane.evaluate((el) => {
          const right = el.getBoundingClientRect().right + 1;
          return [...el.querySelectorAll(".settings-editor:not([hidden]) :is(label, select, button, input, kbd)")]
            .filter((c) => c.getBoundingClientRect().width && c.getBoundingClientRect().right > right).map((c) => c.textContent.trim().slice(0, 40) || c.tagName);
        });
        assert.deepEqual(wide, [], `${label} ${tab}: nothing wider than the page`);
        await page.screenshot({ path: resolve(output, `device-${tab}-${width}x${height}-${language}-${theme}.png`) });
        if (phone) {
          await dialog.locator(".settings-back").click();
          await dialog.locator(".settings-center.is-root").waitFor();
        }
      }
      await context.close();
      check(`${label}: Shortcuts, Notifications and Move to another device are Appearance's cards and fit; the on/offs are switches`);
    }
  }

  // ---- Deep links: the Workspace menu and the status bar open their pages.
  {
    const { page, context } = await open({ width: 1440, height: 900, scope: JSON.stringify("project:garden") });
    const menu = async (name) => {
      await page.locator(".workspace-scope").click();
      await page.getByRole("menuitem", { name }).click();
      await settings(page).locator(".settings-center").waitFor();
    };
    const close = async () => { await page.keyboard.press("Escape"); await settings(page).waitFor({ state: "detached" }); };
    await menu("New project…");
    const dialog = settings(page);
    assert.equal(await dialog.locator("#settings-tab-projects").getAttribute("aria-selected"), "true");
    const name = dialog.locator("#settings-editor-projects:not([hidden])").getByLabel("Name", { exact: true });
    await name.waitFor();
    assert.equal(await name.inputValue(), "", "a new project's form, empty");
    await page.screenshot({ path: resolve(output, "link-new-project.png") });
    await close();
    check("Workspace menu → New project… opens Settings › Projects at a new project");
    await menu("Manage projects…");
    const projectName = dialog.locator("#settings-editor-projects:not([hidden])").getByLabel("Project name", { exact: true });
    await projectName.waitFor();
    assert.equal(await projectName.inputValue(), "Garden", "the project in scope");
    assert.equal(await dialog.locator("#settings-tab-projects").getAttribute("aria-selected"), "true");
    await page.screenshot({ path: resolve(output, "link-manage-projects.png") });
    await close();
    check("Workspace menu → Manage projects… opens Settings › Projects at the project in scope (Garden)");
    await menu("Machines…");
    assert.equal(await dialog.locator("#settings-tab-machines").getAttribute("aria-selected"), "true");
    await dialog.locator("#settings-editor-machines:not([hidden])").getByText("Lab box").first().waitFor();
    await page.screenshot({ path: resolve(output, "link-machines.png") });
    await close();
    check("Workspace menu → Machines… opens Settings › Machines");
    await page.locator(".statusbar-item", { hasText: /machine/ }).click();
    await settings(page).locator(".settings-center").waitFor();
    assert.equal(await dialog.locator("#settings-tab-machines").getAttribute("aria-selected"), "true");
    await dialog.locator("#settings-editor-machines:not([hidden])").getByText("Lab box").first().waitFor();
    await close();
    check("status bar → 1 machine opens Settings › Machines");
    await context.close();
  }
  {
    // On a phone a link opens its page, not the list.
    const { page, context } = await open({ width: 390, height: 844, phone: true, language: "zh-Hans" });
    await page.locator(".workspace-scope").click();
    await page.getByRole("menuitem", { name: "机器…" }).click();
    const dialog = settings(page);
    await dialog.locator("#settings-editor-machines:not([hidden])").waitFor();
    assert.doesNotMatch(await dialog.locator(".settings-center").getAttribute("class"), /is-root/);
    assert.equal((await dialog.locator(".settings-back").innerText()).trim(), "设置");
    await page.screenshot({ path: resolve(output, "phone-link-machines-zh.png") });
    await context.close();
    check("390 zh: Workspace menu → 机器… opens the Machines page with Back, not the list");
  }

  // Sent by POST but reads, by the panels opened as they always did: Updates'
  // check, Tasks & messages' task list, and a project's GitHub links.
  const reads = ["/api/updates/check", "/api/collaboration/task_list", "/api/collaboration/github_repositories", "/api/collaboration/github_refresh"];
  const leadSaves = (c) => c.method === "PUT" && c.path === "/api/projects/orchard/leads";
  assert.equal(calls.filter(leadSaves).length, 6, "the projects part's one Save per run (S2b) is its only write");
  assert.deepEqual(calls.filter((c) => c.method !== "GET" && !reads.includes(c.path) && !leadSaves(c)), [], "opening and browsing write nothing");
  assert.ok(!calls.some((c) => c.method !== "GET" && !leadSaves(c) && /^\/api\/(projects|machines|settings|jobs\/budget|remote-access)(\/|$)/.test(c.path)), "no other project, machine or setting is written");
  assert.deepEqual(errors, []);
  check("no project, machine or setting writes (only the panels' POST reads) and no page errors");
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify({ checks, errors, writes: calls.filter((c) => c.method !== "GET") }, null, 2));
  await browser.close();
}
