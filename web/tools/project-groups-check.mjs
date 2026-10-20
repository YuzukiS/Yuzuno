// The Agent list by project while it shows All projects (T-82): headings by
// default, cards, colour bands or no grouping from Settings → Appearance.
// - Groups follow the project menu, No project last; each keeps the list's
//   order. One project's list, or one group, is not grouped.
// - A group folds and opens with a smooth animation (none with reduced
//   motion), says what it holds while folded (under the name when the rail
//   is too narrow for both), and remembers it. A search
//   opens every group; choosing an Agent opens its group.
// - Each group's + starts a new Agent in its project (none for No project).
// - The Closed list groups the same way; the narrowest rail draws only a
//   line between groups.
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
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/project-groups");
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
  color: "sage",
  createdAt: "",
  updatedAt: "",
  status: "idle",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  closedAt: null,
};
const projects = [
  { id: "p1", name: "yuzuno-next", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Paper notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
];
// Core's order mixes projects; the list keeps it inside each group.
const agents = [
  { ...base, id: "mori", name: "Mori", projectId: "p1" },
  { ...base, id: "hana", name: "Hana", projectId: "p2", status: "working", unreadCount: 2 },
  { ...base, id: "kaze", name: "Kaze", projectId: "p1", status: "working" },
  { ...base, id: "sora", name: "Sora", projectId: "p2", status: "waiting", pendingCount: 1 },
  { ...base, id: "yuki", name: "Yuki", projectId: null },
  { ...base, id: "ame", name: "Ame", projectId: "p1", status: "waiting", pendingCount: 1 },
  { ...base, id: "old", name: "Old", projectId: "p2", status: "offline", closedAt: "2026-10-16T00:00:00Z" },
  { ...base, id: "gone", name: "Gone", projectId: null, status: "offline", closedAt: "2026-10-16T00:00:00Z" },
];
const detail = (agent) => ({
  agent,
  pending: [],
  messageReceipts: [],
  artifacts: [],
  turns: [{ id: `${agent.id}-t`, status: "completed", items: [{ id: `${agent.id}-r`, type: "agentMessage", text: `${agent.name} 在这里。` }] }],
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const open = async (reducedMotion) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    if (!localStorage.getItem("project-groups-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
      localStorage.setItem("project-groups-fixture", "seeded");
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-project-groups.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
    const json = agent
      ? detail(agent)
      : {
          "/api/workspace": {
            workspace: { id: "ws" },
            projects,
            projectUsage: { p1: { agents: 3, tasks: 0 }, p2: { agents: 3, tasks: 0 } },
            agents,
            runtime: { connected: true },
            defaultCwd: "/fixture",
          },
          "/api/updates": unmanagedUpdates,
          "/api/jobs/budget": idleJobsBudget,
          "/api/jobs": noJobs,
          "/api/jobs/live": noLiveJobs,
          "/api/ci": noCiRuns,
          "/api/reviews": noReviews,
          "/api/backlog": { observedAt: new Date().toISOString(), agents: {} },
          "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] },
          "/api/models": { models: [] },
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
  await page.goto("http://yuzuno-project-groups.test/");
  await page.locator('.agent-row[data-agent-id="yuki"]').waitFor();
  return page;
};

// The list as shown: each group with its rows, or the flat rows.
const layout = (page) =>
  page.evaluate(() => {
    const list = document.querySelector(".agent-list");
    const groups = [...list.querySelectorAll(":scope > .project-group")];
    return {
      groups: groups.map((g) => ({
        key: g.dataset.group,
        style: [...g.classList].find((c) => /^project-group-(headers|cards|bands)$/.test(c)),
        name: g.querySelector(".project-group-name")?.textContent,
        expanded: g.querySelector(".project-group-toggle")?.getAttribute("aria-expanded"),
        count: g.querySelector(".project-group-count")?.textContent,
        summary: g.querySelector(".project-group-summary")?.getAttribute("aria-label") || null,
        rows: [...g.querySelectorAll(".agent-row")].map((r) => r.dataset.agentId),
        height: Math.round(g.querySelector(".project-group-body").getBoundingClientRect().height),
        inert: g.querySelector(".project-group-body").inert,
      })),
      flat: [...list.querySelectorAll(":scope > .agent-row")].map((r) => r.dataset.agentId),
    };
  });
const group = (page, name) => page.locator(".agent-list > .project-group", { has: page.locator(".project-group-name", { hasText: new RegExp(`^${name}$`) }) });
const toggle = (page, name) => group(page, name).locator(".project-group-toggle");
const settled = (page, name, folded) =>
  page.waitForFunction(
    ({ name, folded }) => {
      const g = [...document.querySelectorAll(".agent-list > .project-group")].find((el) => el.querySelector(".project-group-name")?.textContent === name);
      const h = g?.querySelector(".project-group-body").getBoundingClientRect().height;
      // The fold's own motion has ended; a working dot's endless pulse doesn't count.
      const moving = g?.getAnimations({ subtree: true }).some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
      return g && (folded ? h < 0.5 : h > 40) && !moving;
    },
    { name, folded },
  );
const setStyle = async (page, label) => {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await page.locator("#settings-tab-appearance").click();
  const field = page.getByRole("dialog").getByRole("group", { name: "Project groups" });
  await field.getByText(label, { exact: true }).click();
  assert.equal(await field.getByRole("radio", { name: new RegExp(label) }).isChecked(), true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
};
const shot = async (page, name) => {
  await page.locator(".rail").screenshot({ path: resolve(output, name), animations: "disabled" });
  report.screenshots.push(name);
};

let page;
try {
  page = await open("no-preference");

  // Headings by default, in the project menu's order, No project last.
  let seen = await layout(page);
  assert.deepEqual(
    seen.groups.map((g) => [g.key, g.style, g.name, g.count, g.rows]),
    [
      ["p1", "project-group-headers", "yuzuno-next", "3", ["mori", "kaze", "ame"]],
      ["p2", "project-group-headers", "Paper notes", "2", ["hana", "sora"]],
      ["none", "project-group-headers", "No project", "1", ["yuki"]],
    ],
  );
  assert.deepEqual(seen.flat, []);
  assert.equal(await group(page, "yuzuno-next").locator(".project-group-head").evaluate((el) => getComputedStyle(el).position), "sticky");
  await shot(page, "headers-light.png");
  check("headings by default: the project menu's order, No project last, each group in the list's order", seen.groups);

  // Folding animates, says what the group holds, and takes the rows out of
  // the tab order.
  const full = seen.groups[1].height;
  assert.match(await page.locator(".project-group-body").first().evaluate((el) => getComputedStyle(el).transitionProperty), /grid-template-rows/);
  await toggle(page, "Paper notes").click();
  const midway = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(35);
    midway.push((await layout(page)).groups[1].height);
  }
  assert.ok(midway.some((h) => h > 0 && h < full), `the group closes over time, not at once: ${full} → ${midway}`);
  await settled(page, "Paper notes", true);
  seen = await layout(page);
  assert.deepEqual(
    [seen.groups[1].expanded, seen.groups[1].height, seen.groups[1].inert, seen.groups[1].summary],
    ["false", 0, true, "1 needs you, 1 working, 1 unread"],
  );
  await shot(page, "headers-folded-light.png");
  check("a group folds smoothly, says what waits, runs and is unread, and its rows leave the tab order", { full, midway });

  // A folded heading keeps its name readable: the marks sit beside the name
  // while both fit and go under it in a narrower rail, inside the rail.
  const foldedHead = () =>
    group(page, "Paper notes").locator(".project-group-head").evaluate((head) => {
      const box = (el) => el.getBoundingClientRect();
      const nameEl = head.querySelector(".project-group-name");
      const name = box(nameEl);
      const marks = box(head.querySelector(".project-group-summary"));
      const rail = box(document.querySelector(".agent-list"));
      return {
        rail: Math.round(rail.width),
        stacked: head.hasAttribute("data-stacked"),
        truncated: nameEl.scrollWidth > nameEl.clientWidth + 1,
        beside: Math.abs((marks.top + marks.bottom) / 2 - (name.top + name.bottom) / 2) < 3 && marks.left >= name.right,
        under: marks.top >= name.bottom - 1 && Math.abs(marks.left - name.left) < 2,
        inside: marks.right <= rail.right + 0.5 && box(head).right <= rail.right + 0.5,
      };
    });
  const heads = {};
  for (const [label, width] of [["default", null], ["wide", 340], ["narrowest", 180]]) {
    if (width) {
      await page.evaluate((rail) => localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail })), width);
      await page.reload();
      await page.locator('.agent-row[data-agent-id="yuki"]').waitFor({ state: "attached" });
      await page.evaluate(() => document.fonts.ready.then(() => true));
    }
    // The marks fade in from 3 px to the left; measure where they settle.
    await page.waitForFunction(() => {
      const marks = [...document.querySelectorAll(".project-group-summary")];
      return marks.length > 0 && marks.every((el) => el.getAnimations().every((a) => a.playState !== "running"));
    });
    heads[label] = await foldedHead();
    assert.ok(heads[label].inside && (heads[label].beside || heads[label].under), `${label}: marks beside or under the name, inside the rail: ${JSON.stringify(heads[label])}`);
    await shot(page, `headers-folded-${label}-${heads[label].rail}.png`);
  }
  assert.ok(heads.default.stacked && heads.default.under && !heads.default.truncated, `the default rail puts the marks under the whole name: ${JSON.stringify(heads.default)}`);
  assert.ok(!heads.wide.stacked && heads.wide.beside && !heads.wide.truncated, `a wide rail keeps them beside it: ${JSON.stringify(heads.wide)}`);
  assert.ok(heads.narrowest.stacked && heads.narrowest.under, `the narrowest rail puts them under it: ${JSON.stringify(heads.narrowest)}`);
  await page.evaluate(() => localStorage.removeItem("yuzuno.panel-widths"));
  check("a folded heading keeps its name: marks beside it while they fit, under it in a narrower rail", heads);

  // Remembered after a reload; opens smoothly again.
  await page.reload();
  await page.locator('.agent-row[data-agent-id="yuki"]').waitFor({ state: "attached" });
  assert.equal(await toggle(page, "Paper notes").getAttribute("aria-expanded"), "false");
  await toggle(page, "Paper notes").click();
  await settled(page, "Paper notes", false);
  assert.equal((await layout(page)).groups[1].inert, false);
  check("folding is remembered after a reload; the group opens again");

  // A search opens every group; choosing an Agent in a folded group opens it.
  await toggle(page, "Paper notes").click();
  await settled(page, "Paper notes", true);
  await page.getByRole("button", { name: "Search agents" }).click();
  await page.getByRole("textbox", { name: "Search agents" }).fill("Hana");
  seen = await layout(page);
  assert.ok(seen.groups.length === 0 && seen.flat.join() === "hana", `one match, one group: no heading: ${JSON.stringify(seen)}`);
  await page.getByRole("textbox", { name: "Search agents" }).fill("a");
  await page.waitForFunction(() => [...document.querySelectorAll(".project-group-toggle")].every((t) => t.getAttribute("aria-expanded") === "true"));
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page.getByRole("button", { name: "Close search" }).click();
  await settled(page, "Paper notes", false);
  check("a search shows every group open; choosing an Agent in a folded group opens it");

  // Each group's + starts a new Agent there; the toolbar's follows the scope.
  const projectOf = async (opener) => {
    await opener.click();
    const dialog = page.getByRole("dialog");
    const value = await dialog.getByLabel("Project", { exact: true }).inputValue();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    return value;
  };
  assert.equal(await projectOf(page.getByRole("button", { name: "New agent in Paper notes" })), "p2");
  assert.equal(await projectOf(page.getByRole("button", { name: "New agent in No project" })), "");
  assert.equal(await projectOf(page.getByRole("button", { name: "New agent in yuzuno-next" })), "p1");
  assert.equal(await projectOf(page.getByRole("button", { name: "Create agent", exact: true })), "");
  check("each group's + starts a new Agent in its project, No project's without one");

  // Cards, colour bands, and no grouping.
  await setStyle(page, "Cards");
  seen = await layout(page);
  assert.ok(seen.groups.length === 3 && seen.groups.every((g) => g.style === "project-group-cards"), JSON.stringify(seen));
  await shot(page, "cards-light.png");
  await setStyle(page, "Colour bands");
  seen = await layout(page);
  assert.ok(seen.groups.every((g) => g.style === "project-group-bands"), JSON.stringify(seen));
  const dots = await page.locator(".project-group-dot").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  assert.ok(dots[0] !== dots[1], `each project its own colour: ${dots}`);
  await shot(page, "bands-light.png");
  await setStyle(page, "No grouping");
  seen = await layout(page);
  assert.deepEqual([seen.groups.length, seen.flat], [0, ["mori", "hana", "kaze", "sora", "yuki", "ame"]]);
  await setStyle(page, "Headers");
  assert.equal((await layout(page)).groups.length, 3);
  check("Settings chooses cards, colour bands, no grouping (the list as before) or headings");

  // One project's list is not grouped; the Closed list is.
  await page.locator(".workspace-scope").click();
  await page.getByRole("menuitemradio", { name: /^Paper notes/ }).click();
  seen = await layout(page);
  assert.deepEqual([seen.groups.length, seen.flat], [0, ["hana", "sora"]]);
  await page.locator(".workspace-scope").click();
  await page.getByRole("menuitemradio", { name: /^All projects/ }).click();
  await page.getByRole("group", { name: "Show agents" }).getByRole("button", { name: /^Closed/ }).click();
  seen = await layout(page);
  assert.deepEqual(seen.groups.map((g) => [g.key, g.rows]), [["p2", ["old"]], ["none", ["gone"]]]);
  await page.getByRole("group", { name: "Show agents" }).getByRole("button", { name: /^Active/ }).click();
  check("one project's list is not grouped; the Closed list groups the same way");

  // Dark, and the narrowest rail: a line between groups, every group open.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme: "dark" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.appearance" }));
  });
  await toggle(page, "Paper notes").click();
  await settled(page, "Paper notes", true);
  await shot(page, "headers-folded-dark.png");
  await setStyle(page, "Cards");
  await shot(page, "cards-dark.png");
  await setStyle(page, "Colour bands");
  await shot(page, "bands-dark.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(() => {
    const list = document.querySelector(".agent-list");
    return {
      overflow: list.scrollWidth > list.clientWidth + 1,
      heads: [...list.querySelectorAll(".project-group-head")].map((h) => Math.round(h.getBoundingClientRect().height)),
      hidden: [...list.querySelectorAll(".agent-row")].filter((r) => r.getBoundingClientRect().height < 1).length,
    };
  });
  assert.ok(!narrow.overflow && narrow.heads.every((h) => h <= 1) && narrow.hidden === 0, JSON.stringify(narrow));
  await shot(page, "bands-dark-390.png");
  await setStyle(page, "Headers");
  check("dark headings, cards and bands; the narrowest rail draws a line between open groups", narrow);
  assert.deepEqual(report.errors, []);
  await page.close();

  // Reduced motion: no animation at all.
  page = await open("reduce");
  const durations = await page.locator(".project-group-body").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.match(durations, /^0s(, 0s)*$/);
  await toggle(page, "yuzuno-next").click();
  assert.equal((await layout(page)).groups[0].height, 0, "folds at once");
  await toggle(page, "yuzuno-next").click();
  check("with reduced motion a group folds and opens at once", { durations });

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
