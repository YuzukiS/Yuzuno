// T-170: a conversation on a phone, in Chromium (or Playwright's Linux WebKit,
// see browser-engine.mjs), on a production build with every API answered
// here (no Core). Synthetic content only: an Agent with 1408 Turns (four-digit
// Turn numbers), a long Chinese reply, a long link and a Turn's error, jobs,
// CI runs and a sub-agent (three groups in the work dock) and the composer's
// notice to resume the session; a second Agent waiting to be reconnected,
// with the recovery notice; a third asking to run a long command. At 320,
// 375, 390 and 402 px wide, and on a phone held sideways: nothing runs off
// the side, the text has the width the docks used to take, the docks open on
// demand from buttons that cover neither the composer, Send nor Back to
// latest and still reach jobs, the sub-agent, Turns and Back to latest, the
// notices, the error and the approval read in full, the reply's actions keep
// a line of their own above its time and Rewind, and a conversation opened
// again keeps its draft and where it was read. A wide window keeps both docks
// beside the text. An emulated phone is not a real one: no on-screen
// keyboard, iOS Safari or real Core.
//   YUZUNO_UI_DIST=<isolated build> node tools/phone-conversation-check.mjs [--baseline]
// --baseline only measures and takes the screenshots (a build from before),
// and reads the draft and position kept on return, for the comparison.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/phone-conversation");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", viewports: [], checks: [], errors: [], unexpected: [], mutations: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const TURNS = 1408;
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const base = { color: "sage", createdAt: at(9000), updatedAt: at(1), unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", cwd: "/fixture", model: "gpt-6", projectId: "p1" };
// Mori is offline: the composer asks for a message to resume the session.
// Hana was cut off mid-Turn: Reconnect above, and the composer says so.
// Sora asks to run a command.
const agents = [
  { ...base, id: "a", name: "Mori", status: "offline", harness: "codex", connectionState: "disconnected", threadId: "thread-a" },
  { ...base, id: "b", name: "Hana", status: "offline", harness: "codex", connectionState: "disconnected", threadId: "thread-b" },
  { ...base, id: "c", name: "Sora", status: "waiting", harness: "codex", connectionState: "connected", threadId: "thread-c", pendingCount: 1 },
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: at(9000), updatedAt: at(9000) }];
const longChinese = "手机上读这一段时，正文应该占满整个宽度，左右两侧不再留给常驻的竖栏。".repeat(6);
const longLink = "https://example.com/a/very/long/path/that/does/not/break/on/its/own/" + "segment-".repeat(12) + "end";
const errorText = "The previous attempt stopped: the connection to the native session closed before the reply finished; nothing was sent twice.";
// Mori started a sub-agent three Turns before the last.
const child = "01a1418f-0000-7000-8000-000000000001";
const subAgent = (kind) => ({ type: "subAgentActivity", id: `${kind}-child`, kind, agentThreadId: child, agentPath: "/root/child-1", model: kind === "started" ? "gpt-6-astra" : null });
const turn = (who, n, last) => ({
  id: `${who}-t${n}`,
  status: last && who === "Hana" ? "inProgress" : "completed",
  startedAt: at(TURNS - n + 2),
  completedAt: last && who === "Hana" ? undefined : at(TURNS - n + 1),
  items: [
    { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} step ${n + 1}: check the next part.` }] },
    ...(who === "Mori" && n === TURNS - 3 ? [subAgent("started"), subAgent("completed")] : []),
    { id: `${who}-r${n}`, type: "agentMessage", text: last ? `${longChinese}\n\n打开：\n\n${longLink}\n\nThen check it again.` : `${who} reply ${n + 1}.` },
  ],
  ...(n === TURNS - 2 ? { error: { message: errorText } } : {}),
});
const longCommand = "node tools/a-long-script-name-for-the-phone-check.mjs --output=/fixture/" + "nested/".repeat(10) + "report.json";
const approval = {
  id: "req-1", agentId: "c", method: "item/commandExecution/requestApproval", createdAt: at(3),
  params: { command: longCommand, cwd: "/fixture", reason: "Run the check that writes its report", itemId: "cmd-1", turnId: "Sora-t11", availableDecisions: ["accept", "decline", "cancel"] },
};
const detail = (agent) => ({
  agent, pending: agent.id === "c" ? [approval] : [], messageReceipts: [], artifacts: [],
  turns: agent.id === "c"
    ? Array.from({ length: 12 }, (_, n) => ({ ...turn(agent.name, n, false), ...(n === 11 ? { status: "inProgress", completedAt: undefined } : {}) }))
    : Array.from({ length: TURNS }, (_, n) => turn(agent.name, n, n === TURNS - 1)),
});
const childDetail = {
  threadId: child, parentThreadId: "thread-a", nickname: null, role: null, path: "/root/child-1", depth: 1, model: "gpt-6-astra", status: "idle",
  turn: { id: "child-turn", status: "completed", error: null },
  result: { text: "子 agent 的结论：布局在窄屏上不再横向溢出。", truncated: false }, readFrom: "history", readAt: new Date(now).toISOString(),
};
const resources = { cpuMillis: 2000, memoryMiB: 4096, swapMiB: 0 };
const job = (id, name, status, minutes) => ({
  id, requestId: id, name, taskRef: "T-170", agentId: "a", agent: { name: "Mori" }, machine: { name: "Core host" }, status,
  reserved: status === "running", reason: status === "failed" ? "exit-code" : null, resources, reservation: resources,
  cursor: minutes, createdAt: at(minutes + 2), startedAt: at(minutes + 1), finishedAt: status === "running" ? null : at(minutes),
  argv: ["/usr/bin/true"], cwd: "/fixture", env: {}, outputs: [],
});
const jobs = { jobs: [job("j1", "a build with a long name for the phone check", "running", 1), job("j2", "the layout check", "failed", 5), job("j3", "unit tests", "succeeded", 9)], liveJobs: [], hasMore: false, nextBefore: null };
const run = (n, status, conclusion) => ({
  id: `github:1:4${n}:1`, name: `CI ${n}`, repository: "o/r", runId: `4${n}`, attempt: "1", headSha: "a".repeat(40), status,
  rawStatus: status === "running" ? "in_progress" : "completed", conclusion, url: `https://github.com/o/r/actions/runs/4${n}`, observedAt: at(n), cursor: n,
});
const ci = { runs: [run(1, "running", null), run(2, "passed", "success")], subscriptions: [], hasMore: false, nextBefore: null };
const home = { generatedAt: new Date(now).toISOString(), order: ["p1"], needsYou: [], projects: [] };

const browser = await launchBrowser();
async function open(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  page.on("pageerror", (error) => report.errors.push(`${viewport.name}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
    assert.equal(url.hostname, "yuzuno-phone.test");
    const path = url.pathname;
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/agents\/[abc]\/review$/.test(path)) return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[abc]\/reading$/.test(path))
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method !== "GET") {
      report.mutations.push({ viewport: viewport.name, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    if (path === `/api/agents/a/subagents/${child}`) return route.fulfill({ json: childDetail });
    const agent = agents.find((a) => path === `/api/agents/${a.id}`);
    const json = agent ? detail(agent) : {
      "/api/workspace": { workspace: { id: "ws-phone" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": home,
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": jobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": ci, "/api/ci/live": ci, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] });
  });
  await page.goto("http://yuzuno-phone.test/");
  await page.locator(".app").waitFor();
  return { context, page };
}
const composer = (page, name) => page.locator(`[data-composer-input][aria-label="Message ${name}"]`);
async function openAgent(page, name, phone) {
  // On a phone the Agent list is a screen of its own: back to it first.
  if (phone && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
  if (!(await composer(page, name).isVisible().catch(() => false)))
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).click();
  await composer(page, name).waitFor();
  await page.locator(".main-panel .conversation-scroll .turn").last().waitFor();
  await page.waitForTimeout(500);
}
const shot = (page, viewport, what) => page.screenshot({ path: resolve(output, `${report.mode}-${viewport.name}-${what}.png`) });

/** What a person sees of the conversation now: overflow, the text's width,
 * the docks and their buttons, the composer's notice, what is on top at
 * the composer's controls, and where the reply's actions and time are. */
const measure = (page) => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; };
  const main = document.querySelector(".main-panel");
  const overflow = [".conversation-inner", ".composer", ".composer-bottom", ".reply-actions", ".recovery-notice", ".inline-error", ".composer-hint", ".message-content", ".pending-card"]
    .flatMap((selector) => [...main.querySelectorAll(selector)].filter(shown)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "auto" && getComputedStyle(el).overflowX !== "scroll")
      .map((el) => `${selector} ${el.scrollWidth}>${el.clientWidth}`));
  const onTop = (el) => {
    if (!shown(el)) return "hidden";
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? "self" : hit ? (hit.className?.toString() || hit.tagName).slice(0, 60) : "nothing";
  };
  const hint = main.querySelector(".composer-hint[data-notice]");
  const error = [...main.querySelectorAll(".turn .inline-error")].filter(shown).at(-1);
  const card = main.querySelector(".pending-card");
  const buttons = [...main.querySelectorAll(".phone-dock-button")].filter(shown);
  const latest = main.querySelector(".jump-latest");
  const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const replies = [...main.querySelectorAll(".reply-actions")].filter((el) => el.querySelector(":scope > .copy-button") && el.querySelector(":scope > .turn-footer"));
  const reply = replies.at(-1);
  const copy = reply?.querySelector(":scope > .copy-button")?.getBoundingClientRect();
  const footer = reply?.querySelector(":scope > .turn-footer")?.getBoundingClientRect();
  return {
    viewport: [innerWidth, innerHeight],
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    overflow,
    appClass: document.querySelector(".app")?.className,
    textColumn: box(main.querySelector(".conversation-inner")),
    workDock: { shown: shown(main.querySelector(".work-dock")), box: box(main.querySelector(".work-dock")) },
    turnDock: { shown: shown(main.querySelector(".turn-dock")), box: box(main.querySelector(".turn-dock")) },
    buttons: buttons.map((el) => ({ label: el.getAttribute("aria-label"), box: box(el) })),
    composerControls: Object.fromEntries([
      ["input", "[data-composer-input]"], ["send", ".send-button"],
      ["image", '.composer-tools button[aria-label="Add images"]'],
      ["markUp", '.composer-tools button[aria-label="Mark up an image"]'],
      ["mode", ".composer-tools .composer-mode"],
    ].map(([name, selector]) => { const el = main.querySelector(selector); return [name, { onTop: onTop(el), box: box(el) }]; })),
    notice: hint ? { text: hint.textContent.trim(), box: box(hint), whiteSpace: getComputedStyle(hint).whiteSpace, textOverflow: getComputedStyle(hint).textOverflow, clipped: hint.scrollWidth > hint.clientWidth + 1 } : null,
    replyRows: copy && footer ? { actionsBottom: Math.round(copy.bottom), timeTop: Math.round(footer.top), separate: footer.top >= copy.bottom - 1 } : null,
    error: error ? { text: error.textContent.trim(), box: box(error), clipped: error.scrollWidth > error.clientWidth + 1 || error.scrollHeight > error.clientHeight + 1 } : null,
    approval: shown(card) ? {
      box: box(card),
      clipped: [card, ...card.querySelectorAll("pre, code, .mono-small, p")].some((el) => shown(el) && getComputedStyle(el).overflowX !== "auto" && el.scrollWidth > el.clientWidth + 1),
      actions: [...card.querySelectorAll(".button-row button")].map((el) => ({ label: el.textContent.trim(), onTop: onTop(el), box: box(el) })),
    } : null,
    jumpLatest: shown(latest) ? { onTop: onTop(latest), box: box(latest), meetsButton: buttons.some((el) => meets(el.getBoundingClientRect(), latest.getBoundingClientRect())) } : null,
  };
});
/** Where the conversation is being read: the Turn at the top of the view
 * and how far its top is from the view's, and the composer's draft. */
const place = (page) => page.evaluate(() => {
  const view = document.querySelector(".main-panel .conversation-scroll").getBoundingClientRect();
  const top = [...document.querySelectorAll(".main-panel .conversation-scroll [data-turn-id]")].find((el) => el.getBoundingClientRect().bottom > view.top + 1);
  return {
    turn: top?.dataset.turnId ?? null,
    offset: top ? Math.round(top.getBoundingClientRect().top - view.top) : null,
    draft: document.querySelector(".main-panel [data-composer-input]")?.innerText.trim() ?? null,
  };
});
const draftText = "合成草稿：回到这个对话时它还在。";
/** Read further up and leave a draft, open another Agent, come back. */
async function leaveAndReturn(page, phone) {
  await openAgent(page, "Mori", phone);
  await page.locator(".main-panel .conversation-scroll").evaluate((el) => el.scrollBy(0, -1200));
  await page.waitForTimeout(800);
  await composer(page, "Mori").click();
  await page.keyboard.insertText(draftText);
  await page.waitForTimeout(400);
  const before = await place(page);
  await openAgent(page, "Hana", phone);
  await openAgent(page, "Mori", phone);
  await page.waitForTimeout(800);
  return { before, after: await place(page) };
}

const viewports = [
  { name: "phone-320", width: 320, height: 640, touch: true },
  { name: "phone-375", width: 375, height: 667, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "phone-402", width: 402, height: 874, touch: true },
  // Held sideways: a phone by its coarse pointer and short height, not its width.
  { name: "phone-sideways", width: 844, height: 390, touch: true, sideways: true },
  { name: "wide", width: 1280, height: 800, touch: false },
];
try {
  for (const viewport of viewports) {
    const phone = viewport.touch;
    const { context, page } = await open(viewport);
    await openAgent(page, "Mori", phone);
    const mori = await measure(page);
    await shot(page, viewport, "mori");
    await openAgent(page, "Hana", phone);
    const hana = await measure(page);
    await shot(page, viewport, "hana");
    await openAgent(page, "Sora", phone);
    const sora = await measure(page);
    await shot(page, viewport, "sora");
    report.viewports.push({ name: viewport.name, mori, hana, sora });
    console.log(`${viewport.name}: page overflow ${mori.pageOverflow}, overflow ${JSON.stringify(mori.overflow)}, text ${JSON.stringify(mori.textColumn)}, ` +
      `docks work ${mori.workDock.shown} turns ${mori.turnDock.shown}, buttons ${mori.buttons.length}, notice ${JSON.stringify(mori.notice)}, reply rows ${JSON.stringify(mori.replyRows)}`);
    if (baseline) {
      // Where a conversation opened again is read, for the comparison.
      if (phone) report.viewports.at(-1).returned = await leaveAndReturn(page, phone);
      await context.close();
      continue;
    }

    if (!phone) {
      for (const seen of [mori, hana, sora]) {
        assert.ok(seen.workDock.shown && seen.turnDock.shown, "a wide window keeps both docks beside the text");
        assert.equal(seen.buttons.length, 0, "and has no dock buttons");
      }
      check("a wide window keeps the work and turn docks beside the text, without the phone buttons", { text: mori.textColumn });
      await context.close();
      continue;
    }

    for (const [who, seen] of [["Mori", mori], ["Hana", hana], ["Sora", sora]]) {
      assert.match(seen.appClass, /\bphone\b/);
      assert.ok(seen.pageOverflow <= 0, `${who}: the page is ${seen.pageOverflow}px wider than the screen`);
      assert.deepEqual(seen.overflow, [], `${who}: nothing in the conversation runs off its side`);
      assert.ok(!seen.workDock.shown && !seen.turnDock.shown, `${who}: both docks wait to be opened`);
      // The text has the width: no more than the small margins and the
      // scrollbar (sideways, the column's own reading width bounds it).
      if (!viewport.sideways)
        assert.ok(seen.textColumn[2] >= viewport.width - 34, `${who}: the text column is ${seen.textColumn[2]}px of ${viewport.width}`);
      for (const [name, control] of Object.entries(seen.composerControls))
        assert.equal(control.onTop, "self", `${who}: ${name} is not covered (${JSON.stringify(control)})`);
      assert.equal(seen.buttons.length, 2, `${who} has jobs and Turns: both buttons`);
      for (const button of seen.buttons) assert.ok(button.box[2] >= 44 && button.box[3] >= 44, `${button.label} is a 44px target`);
    }
    for (const [who, seen] of [["Mori", mori], ["Hana", hana]])
      assert.ok(seen.notice && !seen.notice.clipped && seen.notice.whiteSpace !== "nowrap", `${who}: the composer's notice reads in full: ${JSON.stringify(seen.notice)}`);
    assert.equal(mori.notice.text, "Send a message to resume this session");
    assert.equal(hana.notice.text, "Reconnect above to check the last turn; your draft is kept");
    assert.ok(mori.replyRows?.separate, `the reply's actions keep their line above its time: ${JSON.stringify(mori.replyRows)}`);
    assert.ok(mori.error && mori.error.text === errorText && !mori.error.clipped, `the Turn's error reads in full: ${JSON.stringify(mori.error)}`);
    assert.ok(sora.approval && !sora.approval.clipped, `the approval reads in full: ${JSON.stringify(sora.approval)}`);
    assert.ok(sora.approval.actions.length >= 2, JSON.stringify(sora.approval.actions));
    for (const action of sora.approval.actions)
      assert.equal(action.onTop, "self", `the approval's ${action.label} is not covered: ${JSON.stringify(action)}`);
    check(`${viewport.name}: the text has the docks' width, nothing runs off the side, the composer and Send are clear, and its notices, the Turn's error and the approval read in full`,
      { text: mori.textColumn, buttons: mori.buttons, notices: [mori.notice.text, hana.notice.text], replyRows: mori.replyRows, approval: sora.approval.actions.map((a) => a.label) });

    // The work dock on demand: a job opens its details, which close the panel.
    await openAgent(page, "Mori", phone);
    await page.locator(".phone-dock-work").click();
    await page.waitForTimeout(250);
    const work = await measure(page);
    await shot(page, viewport, "work-open");
    assert.ok(work.workDock.shown && !work.turnDock.shown, "the work panel opens alone");
    for (const [name, control] of Object.entries(work.composerControls))
      assert.equal(control.onTop, "self", `with the panel open, ${name} is still clear (${JSON.stringify(control)})`);
    const workItems = await page.locator(".work-dock .work-dock-item").evaluateAll((items) => items.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.getAttribute("aria-label"), width: Math.round(r.width), height: Math.round(r.height), within: r.left >= 0 && r.right <= innerWidth };
    }));
    assert.ok(workItems.length >= 4, `jobs and CI runs are listed: ${JSON.stringify(workItems)}`);
    for (const item of workItems) assert.ok(item.height >= 44 && item.within, `a whole-row target on screen: ${JSON.stringify(item)}`);
    assert.ok(work.workDock.box[1] + work.workDock.box[3] <= work.buttons[0].box[1], "the panel opens above its button");
    await page.locator(".phone-dock-scrim").click({ position: { x: viewport.width - 30, y: 20 } });
    await page.waitForTimeout(200);
    assert.ok(!(await measure(page)).workDock.shown, "tapping outside closes it");
    await page.locator(".phone-dock-work").click();
    await page.locator(".work-dock .work-dock-item.conversation-job").first().click();
    await page.locator(".jobs-source.local-jobs").waitFor();
    assert.equal(await page.locator(".conversation-body[data-phone-dock]").count(), 0, "a job opens in the Jobs dialog and the work panel closes");
    await shot(page, viewport, "job-open");
    check(`${viewport.name}: the work panel opens above its button, lists the jobs and runs as whole-row targets, closes outside and opens a job`, { items: workItems.length });
    await page.keyboard.press("Escape");
    await page.locator(".jobs-source.local-jobs").waitFor({ state: "detached" });
    await openAgent(page, "Mori", phone);

    // The sub-agent from the same panel: its card, then its Turn.
    await page.locator(".phone-dock-work").click();
    await page.locator(".work-dock .conversation-subagent").first().click();
    const card = page.locator(".subagent-card[role=dialog]");
    await card.locator(".subagent-answer").waitFor();
    await page.waitForTimeout(200);
    await shot(page, viewport, "subagent-open");
    const cardBox = await card.boundingBox();
    assert.ok(cardBox && cardBox.x >= 0 && cardBox.x + cardBox.width <= viewport.width && cardBox.y >= 0 && cardBox.y + cardBox.height <= viewport.height,
      `the sub-agent's card is on screen: ${JSON.stringify(cardBox)}`);
    await card.getByRole("button", { name: "Go to its Turn" }).click();
    await card.waitFor({ state: "detached" });
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".conversation-body[data-phone-dock]").count(), 0, "going to the sub-agent's Turn closes the panel");
    check(`${viewport.name}: the work panel reaches the sub-agent, whose card is on screen and goes to its Turn`, { card: cardBox });
    await page.locator(".jump-latest").click();
    await page.waitForTimeout(600);

    // The turn dock on demand: a Turn is read, and Back to latest returns.
    await page.locator(".phone-dock-turns").click();
    await page.waitForTimeout(250);
    const turns = await measure(page);
    await shot(page, viewport, "turns-open");
    assert.ok(turns.turnDock.shown && !turns.workDock.shown, "the turn panel opens alone");
    const chips = await page.locator(".turn-dock .turn-dock-chip").allInnerTexts();
    assert.ok(chips.includes(String(TURNS)), `four-digit Turn numbers show: ${chips}`);
    const target = chips.find((chip) => chip !== String(TURNS));
    await page.locator(".turn-dock .turn-dock-stop", { has: page.locator(".turn-dock-chip", { hasText: new RegExp(`^${target}$`) }) }).click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".conversation-body[data-phone-dock]").count(), 0, "choosing a Turn closes the panel");
    const reading = await page.locator(".phone-dock-turns").innerText();
    // Reading back in time, Back to latest shows between the two buttons.
    const back = await measure(page);
    await shot(page, viewport, "reading");
    assert.ok(back.jumpLatest && back.jumpLatest.onTop === "self" && !back.jumpLatest.meetsButton, `Back to latest is clear of the dock buttons: ${JSON.stringify(back.jumpLatest)}`);
    await page.locator(".phone-dock-turns").click();
    await page.waitForTimeout(250);
    const latest = page.locator(".turn-dock .turn-dock-latest");
    const latestBox = await latest.boundingBox();
    assert.ok(latestBox && latestBox.width >= 44 && latestBox.height >= 44, `Back to latest is a 44px target in the panel: ${JSON.stringify(latestBox)}`);
    await latest.click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".conversation-body[data-phone-dock]").count(), 0, "Back to latest closes the panel");
    check(`${viewport.name}: the turn panel shows four-digit Turns, reads one, and Back to latest is a finger's size`, { chips, reading: reading.trim() });

    // With the on-screen keyboard up (keyboard-viewport.ts) the buttons wait.
    await page.evaluate(() => { document.documentElement.dataset.keyboard = ""; });
    await page.waitForTimeout(150);
    const keyboard = await measure(page);
    assert.equal(keyboard.buttons.length, 0, "no dock button while the keyboard is up");
    assert.equal(keyboard.composerControls.send.onTop, "self", "Send stays clear");
    await page.evaluate(() => { delete document.documentElement.dataset.keyboard; });
    await page.waitForTimeout(150);
    assert.equal((await measure(page)).buttons.length, 2, "the buttons are back once the keyboard goes");
    check(`${viewport.name}: with the keyboard up the dock buttons wait and Send stays clear; they are back after it`);

    // A conversation opened again keeps its draft and where it was read.
    const returned = await leaveAndReturn(page, phone);
    report.viewports.at(-1).returned = returned;
    assert.equal(returned.after.draft, draftText, `the draft is kept: ${JSON.stringify(returned)}`);
    assert.ok(returned.before.turn && returned.after.turn === returned.before.turn && Math.abs(returned.after.offset - returned.before.offset) <= 8,
      `it opens where it was read: ${JSON.stringify(returned)}`);
    check(`${viewport.name}: opened again, the conversation keeps its draft and where it was read`, returned);
    await context.close();
  }
  if (!baseline) {
    assert.deepEqual(report.errors, [], "no page errors");
    assert.deepEqual(report.mutations, [], "nothing was changed");
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, `${report.mode}-report.json`), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
