// Production bundle in a separate browser, with no connection to the daily Core.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(
  process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/ui-refine",
);
await mkdir(output, { recursive: true });
const report = { checks: [], mutations: [], errors: [] };
const agent = {
  id: "a",
  name: "Mori",
  status: "working",
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  settings: {
    reasoningEffort: "xhigh",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 8,
  reviewedSeq: 8,
  workSummary: {
    text: "已适配五套配色",
    kind: "result",
    source: "agent",
    turnId: "current",
    itemId: "reply",
  },
};
const agents = [
  agent,
  { ...agent, id: "b", name: "Hana", status: "idle", workSummary: undefined },
];
const current = {
  id: "current",
  status: "inProgress",
  items: [
    {
      id: "user",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "把旧版的配色带回来，也让更新更流畅。\n这轮还需要一直提醒我原本的任务，长一点的要求也要能展开查看。\n请保留搜索、文件预览与阅读位置，浅色深色和大字号都要舒服。",
        },
      ],
    },
    {
      id: "edit",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "/fixture/web/src/palettes.css",
          kind: { type: "update" },
          diff: "+/* legacy palettes */",
        },
      ],
    },
    {
      id: "reply",
      type: "agentMessage",
      text: "已适配 **Yuzu、Graphite、Pine、Sunroom** 的浅色与深色。当前一轮的文件放在右侧，历史文件可以展开查看。\n\n[查看配色](web/src/palettes.css:3) · [设计说明](notes.md)",
    },
    {
      // Long enough that the request can scroll out over the top edge, and
      // that a jump to the reply is not held back by the end of the log.
      id: "progress-notes",
      type: "agentMessage",
      text: Array.from(
        { length: 24 },
        (_, i) => `进度 ${i + 1}：逐一检查配色在浅色、深色和大字号下的对比度。`,
      ).join("\n\n"),
    },
  ],
};
const detail = {
  agent,
  pending: [],
  messageReceipts: [],
  turns: [
    ...Array.from({ length: 21 }, (_, i) => ({
      id: `old-${i}`,
      status: "completed",
      items: [
        {
          id: `old-user-${i}`,
          type: "userMessage",
          content: [{ type: "text", text: `此前第 ${i + 1} 轮讨论界面。` }],
        },
        {
          id: `old-reply-${i}`,
          type: "agentMessage",
          text: "消息、工具活动与阅读位置都应当保持稳定。\n\n继续保留搜索、文件预览和字号设置。",
        },
        ...(i === 20
          ? [
              {
                id: "old-mail",
                type: "userMessage",
                _yuzunoSource: "peer",
                content: [{ type: "text", text: "Mailbox has new messages." }],
              },
            ]
          : []),
      ],
    })),
    current,
  ],
  artifacts: [
    {
      name: "palettes.css",
      path: "/fixture/web/src/palettes.css",
      kind: "text",
      sourceItemId: "old-edit",
    },
    {
      name: "notes.md",
      path: "notes.md",
      kind: "text",
      sourceItemId: "old-reply-0",
    },
  ],
};
let releaseMessage;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  // Real scrollbars, so their place beside the turn dock can be measured.
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  window.EventSource = class {
    constructor() {
      window.testEvents = this;
    }
    close() {}
  };
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem(
      "yuzuno.appearance",
      JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }),
    );
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.hostname, "yuzuno-ui-refine.test");
  if (request.method() !== "GET") {
    const input = request.postDataJSON();
    report.mutations.push({ path: url.pathname, input });
    assert.equal(url.pathname, "/api/agents/a/messages");
    await new Promise((resolve) => {
      releaseMessage = resolve;
    });
    const receipt = {
      input,
      status: "accepted",
      turnId: "current",
      error: null,
    };
    detail.messageReceipts.push(receipt);
    return route.fulfill({ json: receipt });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({
      json: { agents, runtime: { connected: true }, defaultCwd: "/fixture" },
    });
  if (/^\/api\/agents\/[ab]$/.test(url.pathname))
    return route.fulfill({
      json: {
        ...detail,
        agent: agents.find((a) => url.pathname.endsWith(a.id)),
      },
    });
  if (url.pathname === "/api/updates")
    return route.fulfill({ json: unmanagedUpdates });
  if (url.pathname === "/api/jobs/budget")
    return route.fulfill({ json: idleJobsBudget });
  if (url.pathname === "/api/jobs") return route.fulfill({ json: noJobs });
  if (url.pathname === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
  if (url.pathname === "/api/ci") return route.fulfill({ json: noCiRuns });
  if (url.pathname === "/api/reviews") return route.fulfill({ json: noReviews });
  // Home (T-85, which replaced Catch up): no projects, nothing waiting.
  if (url.pathname === "/api/home")
    return route.fulfill({
      json: { generatedAt: "", order: [], needsYou: [], projects: [] },
    });
  if (url.pathname === "/api/machine-load")
    return route.fulfill({
      json: {
        at: "2026-10-17T00:00:00Z",
        cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
        memory: { totalMiB: 16384, usedMiB: 4096, availableMiB: 12288, jobsMiB: 0, agentsMiB: null },
        gpus: null,
        jobs: [],
      },
    });
  if (url.pathname === "/api/artifact")
    return route.fulfill({
      body: "# Earlier notes\n\nHistory preview still works.",
      contentType: "text/plain",
    });
  assert.ok(
    !url.pathname.startsWith("/api/"),
    `Unexpected request ${url.pathname}`,
  );
  const file = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".svg": "image/svg+xml",
    }[extname(file)],
  });
});
page.on("pageerror", (error) => report.errors.push(error.message));
const record = (name, extra = {}) => report.checks.push({ name, ...extra });
const refresh = () =>
  page.evaluate(() => window.testEvents.onmessage({ data: "{}" }));
const modal = page.getByRole("dialog");
// Appearance is a category of Settings.
async function openAppearance() {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await page.locator("#settings-tab-appearance").click();
}
try {
  await page.goto("https://yuzuno-ui-refine.test/");
  const composer = page.getByRole("textbox", { name: "Message Mori" });
  const draftOf = () => composerDraft(composer);
  await composer.fill("保留还未发送的草稿");
  const history = page.locator(".artifact-history");
  await page
    .getByRole("group", { name: "Latest turn artifacts" })
    .getByRole("button", { name: /palettes.css/ })
    .waitFor();
  assert.equal(await history.evaluate((el) => el.open), false);
  assert.equal(await history.getByRole("button").isVisible(), false);
  await history.locator("summary").click();
  await history.getByRole("button", { name: /notes.md/ }).click();
  await modal.getByRole("heading", { name: "Earlier notes" }).waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  assert.equal(await draftOf(), "保留还未发送的草稿");
  await refresh();
  assert.equal(await history.evaluate((el) => el.open), true);
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  assert.equal(await history.evaluate((el) => el.open), false);
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await composer.waitFor();
  record(
    "Latest-turn artifacts; collapsed history opens previews; draft survives; Agent switch resets history",
  );

  // Every Yuzu mark answers a tap with a short hop. It moves only the
  // individual scale/rotate/translate properties, so a mark's own transform
  // and the Working bob around it carry on.
  const tapYuzu = async (selector) => {
    const mark = page.locator(selector).first();
    // The Working mark never holds still, so skip the wait for stability.
    await mark.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const before = await mark.evaluate((el) => getComputedStyle(el).transform);
    await mark.click({ force: true });
    return mark.evaluate((el, before) => {
      const hop = el.getAnimations().find((a) => a.id === "yuzu-tap");
      const bob = el.closest(".activity-yuzu");
      return {
        running: hop?.playState === "running",
        moves: hop
          ? Object.keys(hop.effect.getKeyframes()[1])
              .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k))
              .sort()
          : [],
        ownTransformKept: getComputedStyle(el).transform === before,
        bobRunning: bob
          ? bob.getAnimations().some((a) => a.animationName === "activity-bob" && a.playState === "running")
          : null,
      };
    }, before);
  };
  const hopMoves = ["rotate", "scale", "translate"];
  for (const selector of [
    ".toolbar-brand .yuzu-mark",
    ".activity-yuzu .yuzu-mark",
    ".inspector-note .yuzu-mark",
  ]) {
    const tap = await tapYuzu(selector);
    assert.ok(tap.running && tap.ownTransformKept, `${selector}: ${JSON.stringify(tap)}`);
    assert.deepEqual(tap.moves, hopMoves, selector);
    if (selector.startsWith(".activity-yuzu"))
      assert.equal(tap.bobRunning, true, "the Working bob keeps going during a tap");
  }
  // Pictures of the brand and the Working mark as they squash, hop and wiggle.
  for (const [selector, name] of [
    [".toolbar-brand", "yuzu-hop-brand"],
    [".turn-activity", "yuzu-hop-working"],
  ]) {
    const mark = page.locator(`${selector} .yuzu-mark`).first();
    await mark.click({ force: true });
    const box = await mark.boundingBox();
    for (const at of [100, 270, 400]) {
      await mark.evaluate((el, at) => {
        const hop = el.getAnimations().find((a) => a.id === "yuzu-tap");
        hop.pause();
        hop.currentTime = at;
      }, at);
      const pad = Math.max(12, box.height * 0.6);
      await page.screenshot({
        path: `${output}/${name}-${at}ms.png`,
        clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 },
      });
    }
    await mark.evaluate((el) =>
      el.getAnimations().find((a) => a.id === "yuzu-tap")?.finish(),
    );
  }
  // The tilted mark was Catch up's header; Home, which replaced it (T-85),
  // has none, so reduced motion is checked on the brand mark.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await tapYuzu(".toolbar-brand .yuzu-mark");
  assert.deepEqual(still.moves, ["filter"], "reduced motion only brightens");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Home unmounts the conversation; the pin check below needs it mounted again.
  await page.getByRole("button", { name: /^Home/ }).click();
  await page.locator(".home-view").waitFor();
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await composer.waitFor();
  assert.deepEqual(report.mutations, [], "a tap changes nothing");
  record(
    "Yuzu marks hop when tapped, keeping their own transform and the Working bob; reduced motion only brightens",
  );

  // The pin is the original request held at the top edge: hidden while the
  // original is in view or below it, sliding in as the original leaves.
  // The conversation was just mounted again on the way back from Home,
  // pin and scroller together; the pin must still follow the scroller.
  const prompt = page.locator(".current-turn-prompt");
  await prompt.waitFor({ state: "attached" });
  const pane = page.locator(".conversation-scroll");
  // Where the request is, once the pane has stopped moving: a wheel's
  // scroll and the rows' measuring both take a few frames.
  const where = () =>
    pane.evaluate(
      (el) =>
        new Promise((done) => {
          let last = null;
          let still = 0;
          let frames = 0;
          const look = () => {
            const source = document
              .querySelector("#turn-current .user-message")
              ?.getBoundingClientRect();
            const top = el.getBoundingClientRect().top;
            const now = {
              scrollTop: Math.round(el.scrollTop),
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              sourceTop: source ? Math.round(source.top - top) : null,
              sourceBottom: source ? Math.round(source.bottom - top) : null,
            };
            still =
              last && JSON.stringify(last) === JSON.stringify(now)
                ? still + 1
                : 0;
            last = now;
            if (still >= 3 || ++frames > 90) done({ ...now, settled: still >= 3 });
            else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }),
    );
  // Brings the request's bottom to `bottom` px below the top edge with the
  // wheel, as a reader scrolls, and checks it got there before any pin
  // assertion: a few wheel steps at most, never a fixed wait.
  const placements = [];
  const placeRequest = async (bottom) => {
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    let at = await where();
    for (
      let step = 0;
      step < 6 && at.sourceBottom !== null && Math.abs(at.sourceBottom - bottom) > 2;
      step++
    ) {
      await page.mouse.wheel(0, at.sourceBottom - bottom);
      at = await where();
    }
    placements.push({ bottom, ...at });
    assert.ok(
      at.settled && at.sourceBottom !== null && Math.abs(at.sourceBottom - bottom) <= 2,
      `the request's bottom ${bottom}px below the top: ${JSON.stringify(at)}`,
    );
    return at;
  };
  const pinState = () =>
    prompt.evaluate((el) => ({
      pinned: el.dataset.pinned === "true",
      inert: el.inert,
      visible: getComputedStyle(el).visibility === "visible",
      progress: Number(el.style.getPropertyValue("--pin-progress")),
      top:
        el.getBoundingClientRect().top -
        el.parentElement.getBoundingClientRect().top,
      height: el.offsetHeight,
      request:
        document
          .querySelector("#turn-current .user-message")
          ?.getBoundingClientRect().height ?? null,
    }));
  const placed = await placeRequest(400);
  let pin = await pinState();
  assert.ok(!pin.pinned && pin.inert && !pin.visible, JSON.stringify({ pin, placed }));
  // Wholly below the view: the request's top under the bottom edge.
  const below = await placeRequest(
    placed.clientHeight + (placed.sourceBottom - placed.sourceTop) + 40,
  );
  pin = await pinState();
  assert.ok(!pin.pinned && pin.inert, `Request below the view is not pinned: ${JSON.stringify({ pin, below })}`);
  // Halfway: the pin follows the request's top out of view, or a long
  // request's last pin-height or two, so half a pin height has left.
  const halfway = (pin) =>
    Math.min(pin.request, 2 * pin.height) - pin.height / 2;
  await placeRequest(halfway(pin));
  pin = await pinState();
  assert.ok(
    pin.pinned && pin.progress > 0.3 && pin.progress < 0.7,
    JSON.stringify(pin),
  );
  assert.ok(Math.abs(pin.top - (pin.progress - 1) * pin.height) < 2);
  await page.screenshot({
    animations: "disabled",
    path: `${output}/pin-midway.png`,
  });
  await placeRequest(-10);
  pin = await pinState();
  assert.ok(
    pin.pinned && !pin.inert && pin.progress === 1 && Math.abs(pin.top) < 1,
    JSON.stringify(pin),
  );
  await page.screenshot({
    animations: "disabled",
    path: `${output}/pin-held.png`,
  });
  report.pinPlacements = placements;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await placeRequest(halfway(pin));
  assert.equal((await pinState()).progress, 0, "Reduced motion snaps");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await placeRequest(-10);
  await prompt.locator("summary").click();
  assert.equal(await prompt.evaluate((el) => el.open), true);
  assert.match(await prompt.locator("ol").textContent(), /长一点的要求/);
  // Open, it stays while the original comes back into view.
  await placeRequest(400);
  assert.ok((await pinState()).pinned, "An open pin stays");
  await page.keyboard.press("Escape");
  assert.equal(await prompt.evaluate((el) => el.open), false);
  assert.ok((await pinState()).pinned, "Focus stays on the closed pin");
  await composer.focus();
  await page.waitForFunction(
    () =>
      document.querySelector(".current-turn-prompt").dataset.pinned ===
      "false",
  );
  // A jump to a message after the request lands below the pin, whether the
  // pin was hidden, shown or open when it started, and after the pin changes
  // size (T-34 R1 B1).
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const jumpLandsClear = async (via, label) => {
    await page.evaluate(() => document.activeElement?.blur());
    if (via === "search") {
      await page
        .getByRole("button", { name: "Search conversation", exact: true })
        .click();
      await page
        .getByRole("searchbox", { name: "Search loaded messages" })
        .fill("当前一轮的文件放在右侧");
      await page.locator(".conversation-search-result").first().click();
      await page
        .getByRole("dialog", { name: "Search conversation" })
        .waitFor({ state: "detached" });
    } else {
      await page.locator(".inspector-work-source").click();
    }
    await page.waitForFunction(
      () => document.activeElement?.dataset.itemId === "reply",
    );
    await settle();
    await settle();
    const at = await page.evaluate(() => {
      const pin = document.querySelector(".current-turn-prompt");
      const scroller = document.querySelector(".conversation-scroll");
      return {
        pinned: pin.dataset.pinned === "true",
        pinBottom: pin.getBoundingClientRect().bottom,
        targetTop: document
          .querySelector('#turn-current [data-item-id="reply"]')
          .getBoundingClientRect().top,
        // Room left below: the jump was not held up by the end of the log.
        below:
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      };
    });
    assert.ok(
      at.pinned && at.targetTop >= at.pinBottom - 0.5 && at.below > 40,
      `${label}: ${JSON.stringify(at)}`,
    );
  };
  await placeRequest(400);
  await jumpLandsClear("search", "hidden pin, search");
  await placeRequest(400);
  await jumpLandsClear("source", "hidden pin, Current work source");
  await placeRequest(-10);
  await jumpLandsClear("search", "shown pin, search");
  await placeRequest(-10);
  await prompt.locator("summary").click();
  await jumpLandsClear("search", "open pin, search");
  await prompt.evaluate((el) => {
    el.open = false;
  });
  await openAppearance();
  await modal.locator('input[name="appearance-font-size"]').fill("16");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  await placeRequest(400);
  await jumpLandsClear("search", "hidden pin after a text size change");
  await openAppearance();
  await modal.locator('input[name="appearance-font-size"]').fill("20");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1000, height: 1000 });
  await placeRequest(400);
  await jumpLandsClear("search", "hidden pin at 1000px");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".jump-latest").click();
  const dock = page.locator(".turn-dock");
  // Reading the last of 22 Turns: its five numbers and five bars above.
  assert.equal(await dock.locator('li[data-kind="number"]').count(), 5);
  assert.equal(await dock.locator('li[data-kind="bar"]').count(), 5);
  assert.equal(await page.locator(".conversation-meta").count(), 0);
  assert.match(
    await page.locator(".composer-footnote").textContent(),
    /fixture.*test-model · xhigh/,
  );
  // Every part of a rail card opens its agent, its padding included.
  const cardEdge = async (id, edge) => {
    const box = await page.locator(`[data-agent-id="${id}"]`).boundingBox();
    await page.mouse.click(
      box.x + box.width / 2,
      edge === "top" ? box.y + 3 : box.y + box.height - 3,
    );
  };
  // New agent ends the scrolling list rather than staying pinned above it.
  assert.ok(
    await page
      .getByRole("button", { name: /New agent/ })
      .evaluate((el) => el.parentElement.matches(".agent-list") && !el.nextElementSibling),
  );
  await cardEdge("b", "top");
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  await cardEdge("a", "bottom");
  await composer.waitFor();
  // The whole composer box is the input: a press on its status line types
  // at the end of the draft.
  await page.locator(".composer-bottom > span").click();
  assert.ok(
    await composer.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement),
    "the press focuses the editor",
  );
  await page.keyboard.type("!");
  assert.equal(await draftOf(), "保留还未发送的草稿!", "typing lands at the end");
  await page.keyboard.press("Backspace");
  // Focus raises a soft glow behind the whole box (no ring around the editor
  // alone), and it fades when focus leaves. The editor grows with its text up
  // to about a third of the window, then scrolls inside; it shrinks back after.
  const box = page.locator("form.composer");
  const glow = () =>
    box.evaluate((el) => Number(getComputedStyle(el, "::before").opacity));
  const editorRing = () =>
    page.locator(".pasted-text-composer").evaluate((el) =>
      [el.querySelector(".cm-editor"), el.querySelector(".cm-content")].map((part) => {
        const style = getComputedStyle(part);
        return [style.outlineStyle, style.boxShadow];
      }),
    );
  await page.waitForFunction(
    () => Number(getComputedStyle(document.querySelector("form.composer"), "::before").opacity) > 0.65,
  );
  assert.deepEqual(await editorRing(), [["none", "none"], ["none", "none"]], "no ring around the editor alone");
  // A close glow: about 3px out, softened by a 3px blur.
  assert.deepEqual(
    await box.evaluate((el) => {
      const glow = getComputedStyle(el, "::before");
      return [glow.top, glow.left, glow.filter];
    }),
    ["-3px", "-4px", "blur(3px)"],
  );
  const glowShot = async (name) => {
    const form = await box.boundingBox();
    await page.screenshot({
      path: `${output}/${name}.png`,
      clip: { x: form.x - 32, y: form.y - 28, width: form.width + 64, height: form.height + 56 },
    });
  };
  await glowShot("composer-focus-glow");
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForFunction(
    () => Number(getComputedStyle(document.querySelector("form.composer"), "::before").opacity) === 0,
  );
  assert.equal(await glow(), 0);
  const editorHeight = () =>
    page.locator(".pasted-text-composer .cm-scroller").evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrolls: el.scrollHeight > el.clientHeight + 1,
    }));
  const resting = await editorHeight();
  await composer.fill("第一行\n第二行\n第三行\n第四行");
  const grown = await editorHeight();
  assert.ok(grown.height > resting.height + 40 && !grown.scrolls, JSON.stringify({ resting, grown }));
  await composer.fill(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
  const capped = await editorHeight();
  const cap = await page.evaluate(() => Math.min(innerHeight * 0.35, 320));
  assert.ok(capped.height <= cap + 1 && capped.height > cap - 4 && capped.scrolls, JSON.stringify({ capped, cap }));
  await page.locator("form.composer").screenshot({ path: `${output}/composer-grown.png` });
  await composer.fill("保留还未发送的草稿");
  const back = await editorHeight();
  assert.ok(Math.abs(back.height - resting.height) < 2, JSON.stringify({ resting, back }));
  // A mailbox delivery takes one line until it is opened.
  // Far from the latest, an item is mounted only once the reader scrolls
  // near it (T-77's window); the wheel brings it, as a reader would.
  const reveal = async (selector, dy = -800) => {
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 40 && !(await page.locator(selector).count()); step++) {
      await page.mouse.wheel(0, dy);
      await where();
    }
    await page.locator(selector).scrollIntoViewIfNeeded();
  };
  const mail = page.locator('[data-item-id="old-mail"]');
  await reveal('[data-item-id="old-mail"]');
  // One quiet line, said once: what arrived, when, and that it opens. Its
  // contents are T-50's compact notice; here only its single line counts.
  const mailRow = await mail.locator(".mailbox-notice > summary").evaluate((el) => {
    const tops = [...el.children].map((child) => child.getBoundingClientRect().top);
    return {
      mail: /mail/i.test(el.textContent),
      oneLine: Math.max(...tops) - Math.min(...tops) < 10,
      chevron: !!el.querySelector(".mailbox-chevron"),
    };
  });
  assert.deepEqual(mailRow, { mail: true, oneLine: true, chevron: true });
  await mail.locator(".mailbox-notice > summary").click();
  // The chevron turns once the notice is open (after its short transition).
  await page.waitForFunction(
    () =>
      getComputedStyle(
        document.querySelector('[data-item-id="old-mail"] .mailbox-chevron'),
      ).rotate === "90deg",
  );
  assert.match(await mail.locator(".user-text").textContent(), /Mailbox has new messages/);
  await mail.locator(".mailbox-notice > summary").click();
  await mail.screenshot({ path: `${output}/mailbox-one-line.png` });
  // Words streaming onto a reply fade in, a chunk flowing word by word;
  // what was already there stays as it is.
  await reveal('[data-item-id="progress-notes"]', 800);
  const notes = current.items.find((item) => item.id === "progress-notes");
  const streamed = "接下来再看一遍深色主题下的对比度，然后整理结论。";
  notes.text += `\n\n${streamed}`;
  await refresh();
  const tail = page.locator('[data-item-id="progress-notes"] .prose p').last();
  await tail.waitFor();
  await tail.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const fade = await page.locator('[data-item-id="progress-notes"] .prose').evaluate((el) => ({
    words: [...el.querySelectorAll(".stream-word")].map((w) => w.textContent).join(""),
    running: [...el.querySelectorAll(".stream-word")].some((w) =>
      w.getAnimations().some((a) => a.animationName === "stream-word-in"),
    ),
    earlier: el.querySelector("p").querySelectorAll(".stream-word").length,
  }));
  assert.deepEqual(fade, { words: streamed, running: true, earlier: 0 }, JSON.stringify(fade));
  for (const at of [0, 150, 300]) {
    await page.evaluate((at) => {
      for (const a of document.getAnimations())
        if (a.animationName === "stream-word-in") {
          a.pause();
          a.currentTime = at;
        }
    }, at);
    await tail.screenshot({ path: `${output}/stream-fade-${at}ms.png` });
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.animationName === "stream-word-in") a.finish();
  });
  record(
    "Rail cards open from their edges; the composer box focuses its input; mailbox deliveries take one line",
  );
  // The dock has no backdrop and sits left of the conversation scrollbar,
  // which stays on the outer edge.
  const edges = await page.evaluate(() => {
    const scroller = document.querySelector(".conversation-scroll");
    const dock = document.querySelector(".turn-dock");
    const body = scroller.getBoundingClientRect();
    return {
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      dockRight: dock.getBoundingClientRect().right,
      dockLeft: dock.getBoundingClientRect().left,
      scrollerRight: body.right,
      textRight: document
        .querySelector(".conversation-inner")
        .getBoundingClientRect().right,
      background: getComputedStyle(dock).backgroundColor,
    };
  });
  assert.ok(edges.scrollbar > 0, JSON.stringify(edges));
  assert.ok(
    edges.dockRight <= edges.scrollerRight - edges.scrollbar,
    JSON.stringify(edges),
  );
  assert.ok(edges.textRight <= edges.dockLeft, JSON.stringify(edges));
  assert.equal(edges.background, "rgba(0, 0, 0, 0)");
  assert.ok(
    (await page.locator(".conversation-header").boundingBox()).height <= 65,
  );
  assert.ok(
    (await dock.boundingBox()).height <=
      (await page.locator(".conversation-body").boundingBox()).height,
  );
  await dock.locator('[data-turn-choice="current"]').focus();
  await page.keyboard.press("Home");
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.turnChoice),
    "old-0",
  );
  await page.keyboard.press("Escape");
  assert.equal(await dock.getByRole("tooltip").count(), 0);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement.id === "turn-old-0");
  const readingTop = await page
    .locator(".conversation-scroll")
    .evaluate((el) => el.scrollTop);
  current.items.push({
    id: "live-update",
    type: "agentMessage",
    text: "Keep reading where you chose.",
  });
  // The update arrives while an earlier Turn is read. The latest Turn is
  // not mounted that far away (T-77's window), so its arrival is the
  // Agent's answer; the text shows once back at the latest, below.
  const updated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/agents/a");
  await refresh();
  await updated;
  await where();
  assert.equal(
    await page.locator(".conversation-scroll").evaluate((el) => el.scrollTop),
    readingTop,
  );
  assert.equal((await pinState()).pinned, false, "Reading an earlier turn");
  assert.equal(await draftOf(), "保留还未发送的草稿");
  await page
    .getByRole("button", { name: "Back to latest", exact: true })
    .click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  });
  await page.getByText("Keep reading where you chose.", { exact: true }).waitFor();
  record(
    "Request pin hides while the original is in view, slides in with it over the top edge, snaps under reduced motion and stays while open; full request expands; keyboard turn selection focuses the original turn; new events preserve reading position",
  );

  const palettes = ["Garden", "Yuzu", "Graphite", "Pine", "Sunroom"];
  for (const theme of ["light", "dark"])
    for (const palette of palettes) {
      await openAppearance();
      await modal.getByRole("radio", { name: palette, exact: true }).check();
      await modal
        .locator(`input[name="appearance-theme"][value="${theme}"]`)
        .check();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.locator("html").getAttribute("data-font-size"),
        "20",
      );
      const fit = await modal.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return (
          el.scrollWidth <= el.clientWidth + 1 &&
          box.left >= 0 &&
          box.right <= innerWidth + 1 &&
          box.top >= 0 &&
          box.bottom <= innerHeight + 1
        );
      });
      assert.equal(fit, true);
      await page.screenshot({
        animations: "disabled",
        path: `${output}/${palette.toLowerCase()}-${theme}-appearance.png`,
      });
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      await page.screenshot({
        animations: "disabled",
        path: `${output}/${palette.toLowerCase()}-${theme}-conversation.png`,
      });
      await page.locator(".composer-bottom > span").click();
      await page.waitForFunction(
        () => Number(getComputedStyle(document.querySelector("form.composer"), "::before").opacity) > 0.65,
      );
      await glowShot(`${palette.toLowerCase()}-${theme}-composer-glow`);
      // The caret is drawn in the palette's ink, not CodeMirror's black.
      const caret = await page.locator(".pasted-text-composer .cm-content").evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ink)";
        document.body.append(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        return { caret: getComputedStyle(el).caretColor, ink };
      });
      assert.equal(caret.caret, caret.ink, `${palette} ${theme} caret ${JSON.stringify(caret)}`);
      await page.evaluate(() => document.activeElement?.blur());
      await dock.locator('[data-turn-choice="old-19"]').hover();
      await dock.getByRole("tooltip").waitFor();
      const tipFit = await dock.getByRole("tooltip").evaluate((el) => {
        const box = el.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          el.scrollWidth <= el.clientWidth + 1
        );
      });
      assert.equal(tipFit, true);
      await page.screenshot({
        animations: "disabled",
        path: `${output}/${palette.toLowerCase()}-${theme}-turns.png`,
      });
      await page.mouse.move(400, 30);
      await dock.getByRole("tooltip").waitFor({ state: "detached" });
      record("Palette and conversation fit at 20px", { palette, theme });
    }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await openAppearance();
    await modal
      .locator(`input[name="appearance-theme"][value="${theme}"]`)
      .check();
    await modal.locator(".settings-footnote").scrollIntoViewIfNeeded();
    const fit = await modal.evaluate((el) => {
      const right = el.getBoundingClientRect().left + el.clientWidth;
      return {
        fits:
          el.scrollWidth <= el.clientWidth + 1 &&
          el.getBoundingClientRect().right <= innerWidth + 1,
        // What sticks out, to say what to fix.
        wide: [...el.querySelectorAll("*")]
          .filter((child) => child.getBoundingClientRect().right > right + 1)
          .slice(0, 5)
          .map((child) => `${child.tagName.toLowerCase()}.${[...child.classList].join(".")} ${Math.round(child.getBoundingClientRect().right - right)}px`),
      };
    });
    assert.equal(fit.fits, true, JSON.stringify(fit));
    await page.screenshot({
      animations: "disabled",
      path: `${output}/sunroom-${theme}-390-20px.png`,
    });
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    await dock.locator('[data-turn-choice="current"]').hover();
    await dock.getByRole("tooltip").waitFor();
    assert.ok(
      (await page.locator(".conversation-header").boundingBox()).height <= 65,
    );
    const layout = await page.evaluate(() => {
      const selectors = [
        ".conversation-header",
        ".composer-footnote",
        ".conversation-metadata",
        ".turn-dock-preview",
        ".conversation-body",
        ".toolbar",
      ];
      return selectors.map((s) => {
        const el = document.querySelector(s),
          box = el.getBoundingClientRect();
        return {
          selector: s,
          fits:
            box.left >= 0 &&
            box.right <= innerWidth + 1 &&
            el.scrollWidth <= el.clientWidth + 1,
        };
      });
    });
    assert.ok(
      layout.every((entry) => entry.fits),
      JSON.stringify(layout),
    );
    // Narrow widths leave the row to the tools; the keys are for keyboards.
    assert.equal(await page.locator(".composer-keys").isVisible(), false);
    await page.screenshot({
      animations: "disabled",
      path: `${output}/sunroom-${theme}-turns-390.png`,
    });
    await page.mouse.move(100, 25);
  }
  assert.deepEqual(report.mutations, []);
  record("Narrow 390px layout at 20px; Escape does not interrupt or mutate");
  // Workspace views sit in the toolbar, which fits from wide to narrow; the
  // sidebar holds only agents.
  for (const width of [1440, 1101, 1000, 721]) {
    await page.setViewportSize({ width, height: 1000 });
    const bar = await page.evaluate(() => {
      const toolbar = document.querySelector(".toolbar");
      const name = document.querySelector(".workspace-name");
      return {
        fits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
        oneLine: name.scrollHeight <= name.clientHeight + 1,
        inToolbar: toolbar.querySelectorAll(".toolbar-nav .catchup-nav").length,
        inRail: document.querySelectorAll(".rail .catchup-nav").length,
      };
    });
    assert.deepEqual(
      bar,
      // Home, Tasks & messages and (since Jobs arrived) Jobs.
      { fits: true, oneLine: true, inToolbar: 3, inRail: 0 },
      `${width}px`,
    );
  }
  // Icon-only at this width, still named for assistive tech.
  assert.ok(
    await page.getByRole("button", { name: /Tasks & messages/ }).isVisible(),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAppearance();
  await modal.getByRole("radio", { name: "Graphite", exact: true }).check();
  await modal.locator('input[name="appearance-theme"][value="system"]').check();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.reload();
  await composer.waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-palette"),
    "graphite",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator("html").getAttribute("data-font-size"), "20");
  record(
    "Palette, font and system theme persist across reload and device theme changes",
  );

  await composer.fill("现在就出现在会话里");
  await page
    .getByRole("button", { name: "Send while working", exact: true })
    .click();
  await page
    .locator(".outgoing-message")
    .getByText("Sending…", { exact: true })
    .waitFor();
  assert.equal(await draftOf(), "现在就出现在会话里");
  assert.equal(typeof releaseMessage, "function");
  releaseMessage();
  await page
    .locator(".outgoing-message")
    .getByText("Sent · syncing conversation", { exact: true })
    .waitFor();
  const sent = report.mutations[0].input;
  current.items.push({
    id: "native-user",
    clientId: sent.clientMessageId,
    type: "userMessage",
    content: [{ type: "text", text: sent.text }],
  });
  await refresh();
  await page.locator(".outgoing-message").waitFor({ state: "detached" });
  assert.equal(
    await page
      .locator(".conversation-scroll")
      .getByText(sent.text, { exact: true })
      .count(),
    1,
  );
  await placeRequest(-10);
  await prompt.locator("summary").click();
  assert.match(await prompt.locator("ol").textContent(), /现在就出现在会话里/);
  assert.equal(
    await prompt.locator(".current-turn-additions").textContent(),
    "+1",
  );
  await page.keyboard.press("Escape");
  assert.equal(await draftOf(), "");
  record(
    "Immediate sending preview replaces itself with exactly one native message",
  );
  await page.locator(".conversation-scroll").evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
  });
  current.items.push({
    id: "next-reply",
    type: "agentMessage",
    text: "新的进度说明不会把阅读位置拉回底部。",
  });
  // The reply arrives below what is read and far from it, so it is not
  // mounted there (T-77's window): its arrival is the Agent's answer, and
  // its text shows once the reader comes down to it.
  const replied = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/agents/a");
  await refresh();
  await replied;
  await where();
  assert.ok(
    await page
      .locator(".conversation-scroll")
      .evaluate((el) => Math.abs(el.scrollTop - 100) < 3),
  );
  await reveal('[data-item-id="next-reply"]', 800);
  await page
    .getByText("新的进度说明不会把阅读位置拉回底部。", { exact: true })
    .waitFor();
  record("Live updates preserve a historical reading position");
  current.status = "completed";
  agent.status = "idle";
  await refresh();
  await prompt.waitFor({ state: "detached" });
  record(
    "Human follow-ups appear in the pinned request; finishing the turn removes the pin",
  );
  // A long conversation exercises both ends of the dock and variable reading heights.
  for (let i = 22; i < 120; i++)
    detail.turns.push({
      id: `long-${i}`,
      status: "completed",
      items: [
        {
          id: `long-input-${i}`,
          type: "userMessage",
          content: [
            { type: "text", text: `Long conversation request ${i + 1}` },
          ],
        },
      ],
    });
  await refresh();
  await page.locator("#turn-long-119").waitFor({ state: "attached" });
  const scroller = page.locator(".conversation-scroll");
  const numbersOnShow = () =>
    dock.evaluate((el) =>
      [...el.querySelectorAll('li[data-kind="number"] [data-turn-choice]')].map(
        (b) => b.dataset.turnChoice,
      ),
    );
  const span = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => `long-${from + i}`);
  // A Turn far from the reading position is not mounted (T-77's window):
  // the pane scrolls toward it until it is, without moving the pointer,
  // then its top goes to the top edge.
  const toTurn = async (id) => {
    const target = page.locator(`#turn-${id}`);
    const number = Number(id.split("-").pop());
    for (let step = 0; step < 80 && !(await target.count()); step++) {
      const dy = await page.evaluate((n) => {
        const shown = [...document.querySelectorAll('[id^="turn-long-"]')].map((el) => Number(el.id.split("-").pop()));
        return shown.length && n < Math.min(...shown) ? -600 : 600;
      }, number);
      await scroller.evaluate((el, dy) => {
        el.scrollTop += dy;
      }, dy);
      await where();
    }
    await target.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
  };
  await page.mouse.move(400, 30);
  await toTurn("long-69");
  await page.waitForFunction(
    () =>
      document.querySelector('.turn-dock [aria-current="location"]')?.dataset
        .turnChoice === "long-69",
  );
  // 120 Turns: five numbers around the reading position, and five bars on
  // each side that shorten and fade with distance.
  assert.deepEqual(await numbersOnShow(), span(67, 71));
  // The reading Turn is marked apart from the other numbers.
  const looks = await dock.evaluate((el) =>
    [
      el.querySelector('[aria-current="location"] .turn-dock-chip'),
      el.querySelector('li[data-kind="number"] button:not([aria-current]) .turn-dock-chip'),
    ].map((chip) => getComputedStyle(chip).backgroundColor),
  );
  assert.notEqual(looks[0], looks[1], `reading mark: ${JSON.stringify(looks)}`);
  // The dock glides to its new window; measure it once it has arrived.
  await dock.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
  const bars = await dock.evaluate((el) =>
    [...el.querySelectorAll('li[data-kind="bar"] .turn-dock-bar')].map((bar) => {
      const style = getComputedStyle(bar);
      return [parseFloat(style.width), Number(style.opacity)];
    }),
  );
  assert.equal(bars.length, 10);
  const grows = (list) =>
    list.every((v, i) => i === 0 || (v[0] > list[i - 1][0] && v[1] > list[i - 1][1]));
  assert.ok(grows(bars.slice(0, 5)), `bars above get nearer: ${JSON.stringify(bars)}`);
  assert.ok(grows(bars.slice(5).reverse()), `bars below fade away: ${JSON.stringify(bars)}`);
  await dock.screenshot({ path: `${output}/dock-120-turns.png` });
  // The pointer is a lens: the number under it grows most, its neighbours
  // less, and bars near it lengthen and come forward.
  const chipScale = (id) =>
    dock
      .locator(`[data-turn-choice="${id}"] .turn-dock-chip`)
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  await dock.locator('[data-turn-choice="long-69"]').hover();
  await page.waitForFunction(
    () =>
      new DOMMatrix(
        getComputedStyle(
          document.querySelector('[data-turn-choice="long-69"] .turn-dock-chip'),
        ).transform,
      ).a > 1.35,
  );
  const lensScales = [
    await chipScale("long-69"),
    await chipScale("long-70"),
    await chipScale("long-71"),
  ];
  assert.ok(
    lensScales[0] > lensScales[1] && lensScales[1] > lensScales[2],
    `lens: ${JSON.stringify(lensScales)}`,
  );
  await dock.screenshot({ path: `${output}/dock-lens.png` });
  // The wheel walks the dock through Turns: rows glide to their new places and
  // a bar grows into a number. The conversation stays put, and the dock
  // holds its place while the pointer is on it.
  const beforeWheel = await scroller.evaluate((el) => el.scrollTop);
  const dockBox = await dock.boundingBox();
  await page.mouse.move(dockBox.x + dockBox.width / 2, dockBox.y + 20);
  await page.mouse.wheel(0, 60);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".turn-dock-list li")].some((li) =>
      li.getAnimations().some((a) => a.id === "dock-glide"),
    ),
  );
  for (const at of [0, 90, 180]) {
    await dock.evaluate((el, at) => {
      for (const a of el.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = at;
      }
    }, at);
    await dock.screenshot({ path: `${output}/dock-glide-${at}ms.png` });
  }
  await dock.evaluate((el) => {
    for (const a of el.getAnimations({ subtree: true })) a.finish();
  });
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(
    () =>
      document.querySelector('.turn-dock li[data-kind="number"]:nth-child(8) [data-turn-choice]')
        ?.dataset.turnChoice === "long-74",
  );
  assert.deepEqual(await numbersOnShow(), span(72, 76));
  assert.equal(await scroller.evaluate((el) => el.scrollTop), beforeWheel);
  await toTurn("long-99");
  await page.waitForFunction(() =>
    /^100\s*\/ 120$/.test(document.querySelector(".turn-dock-position").textContent),
  );
  assert.deepEqual(await numbersOnShow(), span(72, 76), "held while engaged");
  // Letting go of the dock brings its window back to the reading position.
  await page.mouse.move(400, 30);
  await page.waitForFunction(
    () =>
      document.querySelector('.turn-dock [aria-current="location"]')?.dataset
        .turnChoice === "long-99",
  );
  assert.deepEqual(await numbersOnShow(), span(97, 101));
  await dock.locator('[aria-current="location"]').focus();
  await page.keyboard.press("Home");
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.turnChoice),
    "old-0",
  );
  await page.keyboard.press("End");
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.turnChoice),
    "long-119",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.activeElement.id === "turn-long-119",
  );
  // An absolutely positioned label deep in the log (as a result table's
  // sr-only "Select") stays inside the conversation, and a jump target that
  // cannot reach the top does not scroll the app shell instead. Both left
  // the whole UI shifted up after a dock jump in a real conversation.
  assert.deepEqual(
    await page.evaluate(() => {
      const label = document.createElement("span");
      label.className = "sr-only";
      label.textContent = "Select";
      document.querySelector(".turn:last-of-type").append(label);
      const app = document.querySelector(".app");
      const overflow = app.scrollHeight - app.clientHeight;
      document
        .querySelector(".read-end-marker")
        .scrollIntoView({ behavior: "instant", block: "start" });
      const shellScrolled = app.scrollTop;
      label.remove();
      return { overflow, shellScrolled };
    }),
    { overflow: 0, shellScrolled: 0 },
  );
  // Reduced motion: no glide, no lens, no transitions.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => {
    const bar = document.querySelector(".turn-dock-bar");
    return bar && getComputedStyle(bar).transitionDuration === "0s";
  });
  const stillBox = await dock.boundingBox();
  await page.mouse.move(stillBox.x + stillBox.width / 2, stillBox.y + stillBox.height / 2);
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(50);
  assert.equal(
    await dock.evaluate((el) =>
      [...el.querySelectorAll(".turn-dock-list li")].some((li) =>
        li.getAnimations().some((a) => a.id === "dock-glide"),
      ),
    ),
    false,
  );
  assert.equal(
    await dock
      .locator('li[data-kind="number"] .turn-dock-chip')
      .first()
      .evaluate((el) => getComputedStyle(el).transform),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.mouse.move(400, 30);
  record(
    "120 turns: five numbers and ten fading bars; the pointer lens magnifies progressively; the wheel and keyboard walk the dock with gliding rows without moving the conversation, holding while engaged; letting go follows reading again; Home/End reach both ends; reduced motion has no glide, lens or transitions",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  await page.screenshot({
    animations: "disabled",
    path: `${output}/failure.png`,
  });
  process.exitCode = 1;
} finally {
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
