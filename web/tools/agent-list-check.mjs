// The Agent list in the left rail (T-82).
// - Unread updates ring the avatar: no dot and no count, so nothing reads
//   as one of the status dots, which are unchanged.
// - The compact list (Settings → Appearance): each row shows its Agent's
//   name and status only, without the "Reported · / Update ·" line; the
//   unread ring and "needs you" still show. The choice stays after a reload and
//   can be undone from the keyboard.
// - The selected row is marked by its background and border, with no accent
//   tab on its left edge.
// - The rail's title line holds YOUR AGENTS, a small Active / Closed pill and
//   the search and create buttons; the pill drops under the title only in a
//   rail too narrow for all three.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/agent-list");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const base = {
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
};
const agents = [
  {
    ...base,
    id: "a",
    name: "Mori",
    status: "idle",
    color: "sage",
    workSummary: { text: "第四批界面调整已合入，验收记录整理好了。", kind: "result", source: "agent", turnId: "t1", itemId: "r1" },
  },
  {
    ...base,
    id: "b",
    name: "Hana",
    status: "working",
    color: "rose",
    unreadCount: 2,
    workSummary: { text: "正在跑候选检查，完成后再汇报结果和截图。", kind: "progress", source: "agent", turnId: "t1", itemId: "r1" },
  },
  {
    ...base,
    id: "c",
    name: "Sora",
    status: "waiting",
    color: "sky",
    pendingCount: 1,
    workSummary: { text: "Approve running npm ci in the worktree?", kind: "pending", source: "runtime", requestId: "q1" },
  },
  { ...base, id: "d", name: "Yuki", status: "idle", color: "sage", unreadCount: 120 },
];
const detail = {
  agent: agents[0],
  pending: [],
  messageReceipts: [],
  artifacts: [],
  turns: [
    {
      id: "t1",
      status: "completed",
      items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "整理一下验收记录" }] },
        { id: "r1", type: "agentMessage", text: "第四批界面调整已合入，验收记录整理好了。" },
      ],
    },
  ],
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class {
      close() {}
    };
    // Seeded once: a reload keeps what Settings saved.
    if (!localStorage.getItem("agent-list-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
      localStorage.setItem("agent-list-fixture", "seeded");
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-agent-list.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const json = {
      "/api/workspace": { agents, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": detail,
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
      "/api/reviews": noReviews,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) {
      report.unexpected.push(url.pathname);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));

  // Each rail row: its height, whether its summary line shows, and what it
  // says otherwise; plus anything wider than the rail.
  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".agent-list .agent-row")].map((row) => {
        const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
        const name = row.querySelector(".agent-name");
        return {
          id: row.dataset.agentId,
          height: Math.round(row.getBoundingClientRect().height),
          name: visible(name) ? name.textContent : null,
          nameClipped: !!name && name.scrollWidth > name.clientWidth + 1,
          status: visible(row.querySelector(".agent-runtime")) ? row.querySelector(".agent-runtime").textContent.trim() : null,
          summary: visible(row.querySelector(".agent-work-summary")) ? row.querySelector(".agent-work-summary").textContent : null,
          needsYou: visible(row.querySelector(".needs-you")) ? row.querySelector(".needs-you").textContent : null,
          unread: !!row.querySelector(".agent-rail-avatar.has-unread"),
          title: row.querySelector(".agent-select").title,
          overflows: row.scrollWidth > row.clientWidth + 1,
        };
      }),
    );
  // The selected row: no tab on its edge, and still apart from the others.
  const selection = () =>
    page.evaluate(() => {
      const selected = document.querySelector(".agent-list .agent-row.selected");
      const other = document.querySelector(".agent-list .agent-row:not(.selected)");
      return {
        id: selected.dataset.agentId,
        tab: getComputedStyle(selected, "::before").content,
        background: getComputedStyle(selected).backgroundColor,
        otherBackground: getComputedStyle(other).backgroundColor,
      };
    });
  const noTab = async (where) => {
    const seen = await selection();
    assert.ok(seen.id === "a" && seen.tab === "none" && seen.background !== seen.otherBackground, `${where}: ${JSON.stringify(seen)}`);
    return seen;
  };
  const shot = async (name) => {
    await page.screenshot({ path: resolve(output, name), animations: "disabled" });
    report.screenshots.push(name);
  };
  const settings = page.getByRole("dialog");
  const openAppearance = async () => {
    await page.getByRole("button", { name: "Settings and updates" }).click();
    await page.locator("#settings-tab-appearance").click();
    await settings.getByRole("heading", { name: "Appearance" }).waitFor();
  };
  const closeSettings = async () => {
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
  };

  await page.goto("http://yuzuno-agent-list.test/");
  await page.locator('.agent-row[data-agent-id="d"]').waitFor();

  // Detailed, as before: the line under each name.
  const detailed = await rows();
  report.detailed = detailed;
  const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));
  let at = byId(detailed);
  assert.match(at.a.summary || "", /^Reported · /, JSON.stringify(at.a));
  assert.match(at.b.summary || "", /^Update · /, JSON.stringify(at.b));
  assert.match(at.c.summary || "", /npm ci/, JSON.stringify(at.c));
  assert.equal(at.d.summary, null);
  assert.match(at.c.needsYou || "", /1 needs you/);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.agentList), "detailed");
  await shot("rail-detailed-light.png");
  report.selection = [await noTab("detailed")];
  check("detailed by default: each Agent's report or update under its name; the selected row has no edge tab", { heights: detailed.map((r) => r.height) });

  // Unread updates ring the avatar: not a dot, no count.
  assert.deepEqual(detailed.map((r) => [r.id, r.unread]), [["a", false], ["b", true], ["c", false], ["d", true]]);
  assert.match(at.b.title, / · 2 unread updates$/, "the count is in the row's tip");
  assert.doesNotMatch(at.a.title, /unread/);
  const marks = () =>
    page.evaluate(() => {
      const list = document.querySelector(".agent-list").getBoundingClientRect();
      const wrap = document.querySelector('[data-agent-id="b"] .agent-rail-avatar');
      const avatar = wrap.querySelector(".avatar").getBoundingClientRect();
      const ring = getComputedStyle(wrap, "::before");
      const box = wrap.getBoundingClientRect();
      const outset = parseFloat(ring.top);
      const dots = [...document.querySelectorAll(".agent-list .status-dot")].map((dot) => ({
        size: Math.round(dot.getBoundingClientRect().width),
        color: getComputedStyle(dot).backgroundColor,
      }));
      return {
        ring: {
          content: ring.content,
          width: Math.round(avatar.width - 2 * outset),
          border: ring.borderTopWidth,
          color: ring.borderTopColor,
        },
        // The ring around the avatar, plus its outset, stays in the list.
        inside: box.left + outset >= list.left && box.right - outset <= list.right && box.top + outset >= list.top,
        // Nothing but the avatar's initial inside it: no count, no dot.
        text: wrap.textContent,
        extra: wrap.querySelectorAll(":scope > :not(.avatar)").length,
        dots,
      };
    });
  let seen = await marks();
  assert.ok(seen.ring.content !== "none" && seen.ring.width >= 32 && parseFloat(seen.ring.border) >= 1, `a ring around the avatar: ${JSON.stringify(seen.ring)}`);
  assert.equal(seen.text, "H");
  assert.equal(seen.extra, 0);
  assert.equal(await page.locator(".agent-list .unread-dot, .agent-list .unread-count").count(), 0);
  assert.ok(seen.dots.length === 4 && seen.dots.every((d) => d.size === 5), `the status dots are unchanged: ${JSON.stringify(seen.dots)}`);
  assert.ok(seen.dots.every((d) => d.color !== seen.ring.color), `no status dot shares the ring's colour: ${JSON.stringify(seen)}`);
  assert.ok(seen.inside, "the ring stays inside the list");
  await page.locator(".agent-list").screenshot({ path: resolve(output, "rail-unread-light.png"), animations: "disabled" });
  report.screenshots.push("rail-unread-light.png");
  report.marks = [seen];
  check("unread updates ring the avatar, with the count in its tip; the status dots are unchanged", seen.ring);

  // The title line at the default rail width, a wide one and the narrowest.
  const heading = () =>
    page.evaluate(() => {
      const el = document.querySelector(".rail-heading");
      const box = (part) => {
        const r = part.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, mid: r.top + r.height / 2 };
      };
      const rail = document.querySelector(".rail").getBoundingClientRect();
      return {
        rail: Math.round(rail.width),
        stacked: el.hasAttribute("data-stacked"),
        title: box(el.querySelector(":scope > span")),
        pill: box(el.querySelector(".agent-scope")),
        actions: box(el.querySelector(".rail-actions")),
        overflow: el.scrollWidth > el.clientWidth + 1,
        inRail: el.querySelector(".agent-scope").getBoundingClientRect().right <= rail.right && el.querySelector(".agent-scope").getBoundingClientRect().left >= rail.left,
      };
    });
  const oneLine = (h) =>
    !h.stacked && Math.abs(h.title.mid - h.pill.mid) < 3 && Math.abs(h.pill.mid - h.actions.mid) < 3 &&
    h.title.right <= h.pill.left && h.pill.right <= h.actions.left;
  const underTitle = (h) =>
    h.stacked && Math.abs(h.title.mid - h.actions.mid) < 3 && h.pill.top >= h.title.bottom && Math.abs(h.pill.left - h.title.left) < 2;
  const railAt = async (width) => {
    await page.evaluate((rail) => {
      if (rail) localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail }));
      else localStorage.removeItem("yuzuno.panel-widths");
    }, width);
    await page.reload();
    await page.locator('.agent-row[data-agent-id="d"]').waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    return heading();
  };
  const titles = {};
  for (const [label, width] of [["default", null], ["wide", 340], ["narrowest", 180]]) {
    const h = label === "default" ? await heading() : await railAt(width);
    titles[label] = h;
    assert.ok(h.pill.height <= 26 && !h.overflow && h.inRail, `${label}: a small pill inside the rail: ${JSON.stringify(h)}`);
    assert.ok(oneLine(h) || underTitle(h), `${label}: one line, or the pill under the title: ${JSON.stringify(h)}`);
    await page.locator(".rail-top").screenshot({ path: resolve(output, `title-line-${label}-${h.rail}.png`), animations: "disabled" });
    report.screenshots.push(`title-line-${label}-${h.rail}.png`);
  }
  assert.ok(oneLine(titles.wide), `a wide rail holds all three on one line: ${JSON.stringify(titles.wide)}`);
  assert.ok(underTitle(titles.narrowest), `the narrowest rail puts the pill under the title: ${JSON.stringify(titles.narrowest)}`);
  // The pill still chooses which agents the rail lists.
  const scopes = page.getByRole("group", { name: "Show agents" });
  await scopes.getByRole("button", { name: "Closed 0", exact: true }).click();
  assert.equal(await scopes.getByRole("button", { name: "Closed 0", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".agent-list .agent-row").count(), 0);
  await scopes.getByRole("button", { name: "Active 4", exact: true }).click();
  await page.locator('.agent-row[data-agent-id="d"]').waitFor();
  await railAt(null);
  report.titles = titles;
  check("YOUR AGENTS, the Active / Closed pill and the buttons share a line, or the pill goes under the title in a narrow rail", {
    default: { rail: titles.default.rail, stacked: titles.default.stacked },
    wide: titles.wide.rail,
    narrowest: titles.narrowest.rail,
  });

  // Choose Compact in Settings → Appearance.
  await openAppearance();
  const field = settings.getByRole("group", { name: "Agent list" });
  await field.scrollIntoViewIfNeeded();
  assert.equal(await field.getByRole("radio", { name: /Detailed/ }).isChecked(), true);
  await field.getByText("Compact", { exact: true }).click();
  assert.equal(await field.getByRole("radio", { name: /Compact/ }).isChecked(), true);
  await settings.locator(".settings-current", { hasText: "Compact list" }).waitFor();
  await field.screenshot({ path: resolve(output, "settings-agent-list-light.png"), animations: "disabled" });
  report.screenshots.push("settings-agent-list-light.png");
  await closeSettings();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.agentList), "compact");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.appearance")));
  assert.deepEqual(saved, { theme: "light", fontSize: 16, palette: "garden", agentList: "compact", projectGroups: "headers" });
  check("Settings → Appearance → Agent list → Compact is saved on this device", { saved });

  // Compact: names and status, no line under them; "needs you" and the
  // unread mark still show; every row is shorter, none wider than the rail.
  const compact = await rows();
  report.compact = compact;
  at = byId(compact);
  const before = byId(detailed);
  for (const row of compact) {
    assert.equal(row.summary, null, `no line under the name: ${JSON.stringify(row)}`);
    assert.ok(row.name && row.status, `name and status show: ${JSON.stringify(row)}`);
    assert.ok(!row.nameClipped && !row.overflows, `nothing clipped: ${JSON.stringify(row)}`);
    assert.ok(row.height < before[row.id].height || (!before[row.id].summary && row.height <= before[row.id].height),
      `the row is no taller: ${before[row.id].height} → ${row.height}`);
  }
  assert.match(at.c.needsYou || "", /1 needs you/, "needs you still shows");
  assert.equal(at.b.unread, true, "the unread ring still shows");
  const railHeight = (list) => list.reduce((sum, r) => sum + r.height, 0);
  assert.ok(railHeight(compact) < railHeight(detailed) * 0.8, `the list is shorter: ${railHeight(detailed)} → ${railHeight(compact)}`);
  await shot("rail-compact-light.png");
  report.selection.push(await noTab("compact"));
  check("compact: name and status only; needs you and the unread ring still show", { heights: compact.map((r) => r.height) });

  // The same in dark and in a shorter, narrower window.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme: "dark" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.appearance" }));
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.agentList), "compact");
  await shot("rail-compact-dark.png");
  seen = await marks();
  assert.ok(seen.dots.every((d) => d.color !== seen.ring.color), `dark: ${JSON.stringify(seen)}`);
  report.marks.push(seen);
  await page.setViewportSize({ width: 940, height: 650 });
  for (const row of await rows()) assert.ok(row.summary === null && !row.overflows, JSON.stringify(row));
  await shot("rail-compact-dark-940.png");
  // The avatar-only rail of the narrowest windows keeps the ring.
  await page.setViewportSize({ width: 390, height: 844 });
  seen = await marks();
  assert.ok(seen.inside && seen.ring.content !== "none", `390 px: ${JSON.stringify(seen)}`);
  report.marks.push(seen);
  await shot("rail-compact-dark-390.png");
  report.selection.push(await noTab("dark, 390 px"));
  // The avatar-only rail: the + button, then the pill as a column, in the rail.
  const narrow = await heading();
  assert.ok(narrow.inRail && narrow.pill.top >= narrow.actions.bottom, `390 px title line: ${JSON.stringify(narrow)}`);
  report.titles.avatarOnly = narrow;
  await openAppearance();
  await settings.getByRole("group", { name: "Agent list" }).screenshot({ path: resolve(output, "settings-agent-list-dark.png"), animations: "disabled" });
  report.screenshots.push("settings-agent-list-dark.png");
  await closeSettings();
  check("compact in dark and at 940 px");

  // A reload keeps it: applied before React mounts.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator('.agent-row[data-agent-id="d"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.agentList), "compact");
  for (const row of await rows()) assert.equal(row.summary, null, JSON.stringify(row));
  check("a reload keeps the compact list");

  // From the keyboard back to Detailed, and the lines return.
  await openAppearance();
  const radio = settings.getByRole("group", { name: "Agent list" }).getByRole("radio", { name: /Compact/ });
  await radio.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await settings.getByRole("group", { name: "Agent list" }).getByRole("radio", { name: /Detailed/ }).isChecked(), true);
  assert.equal(await settings.locator(".settings-current", { hasText: "Compact list" }).count(), 0);
  // At 390 px the Settings column still holds both choices.
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await settings.evaluate((el) => {
    const pane = el.querySelector(".settings-pane") || el;
    const options = el.querySelector(".agent-list-options").getBoundingClientRect();
    const box = pane.getBoundingClientRect();
    return { paneScrolls: pane.scrollWidth > pane.clientWidth + 1, left: options.left >= box.left - 1, right: options.right <= box.right + 1 };
  });
  assert.deepEqual(fits, { paneScrolls: false, left: true, right: true });
  await settings.getByRole("group", { name: "Agent list" }).screenshot({ path: resolve(output, "settings-agent-list-390.png"), animations: "disabled" });
  report.screenshots.push("settings-agent-list-390.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await closeSettings();
  at = byId(await rows());
  assert.match(at.a.summary || "", /^Reported · /);
  assert.match(at.b.summary || "", /^Update · /);
  check("the keyboard brings back the detailed list; the choice fits at 390 px", { fits });

  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
