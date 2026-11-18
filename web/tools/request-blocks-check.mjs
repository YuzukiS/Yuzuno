// YN-212 W3 in a browser, every API answered here (no Core, no daily
// configuration), through the production build, on a Project's page read by
// request, at 1440 and a phone (390), English and Chinese:
//  - R-7 at the design's five moments (§3.3): one block, in its group, with
//    its one fact, its one action and what it delivered;
//  - every request once on the page, and R-7's words once;
//  - W5 (R-20 follow-up): R-7's open Ask is in its first look, answerable
//    there with no Answer before it: in view on load, the focus not taken;
//    Tab reaches it from the block's title; its fold still shows its long
//    evidence; a "Wait, what?" note leaves the picked decision and its
//    words as they were; answered, it stays where it was, once;
//  - Confirm done files R-7 under Done;
//    a joined task's line shows the request its card is under (R-14 → R-12);
//  - nothing is wider than the window, and the composer is in the dock;
//  - W4: R-7's card names who wrote it (Core's author, else its owner); its
//    earlier version, from the card's versions fold, opens on the report
//    page read only, as Core's history keeps it, the current one offered;
//  - See words on R-7's card shows its words in the project's conversation,
//    where a long unbroken word stays inside its bubble (before YN-212,
//    project-talk-check's two columns checked these);
//  - nothing is sent but the reads, the note, the answer and the confirmation.
// With YUZUNO_WEBKIT_WS it runs in Playwright's Linux WebKit instead (browser-engine.mjs).
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-blocks-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { engine, launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-212", slice: "W3", engine, runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47398";
const PROJECT = "p-next";
const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/next", projectId: PROJECT,
};
const exec = (id, name, task, title) => ({ ...base, id, name, kind: "executor", status: "working",
  executor: { state: "running", agentId: id, task: { id: task, title, shortName: title }, dispatchedAt: at(300) } });
// Synthetic names and words, after R-20's example.
const agents = [
  { ...base, id: "lead", name: "Dev Lead", kind: "lead" },
  exec("x181", "YN-181 · 独立核查", "YN-181", "Mac 发布前核查"),
  exec("x197", "YN-197 · 设计先行", "YN-197", "Core CPU 调查"),
];
const projects = [{ id: PROJECT, name: "yuzuno-next", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "lead", name: "Dev Lead", state: "active" };
const desk = { agentId: "lead", name: "Dev Lead" };
const who = (agent) => ({ agentId: agent.id, name: agent.name, kind: "executor", state: "running" });
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (text) => ({ root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: node("Markdown", { text }) } });
const binding = (task, status, responsible) => ({ task: { id: task, title: task, status, archived: false }, responsible });
const QUESTION = "desktop-0.7.0：用 v3 脚本重签一次并发布？";
const REPLY = "批准：用 v3 重签一次并发布";
// What the Ask says to be answered alone (W5 guide): what is decided, what is and is not verified, each choice's
// consequence, the recommendation; the long evidence linked, not copied.
const ASK_BODY = [
  "要决定：用 v3 签名脚本给 desktop-0.7.0 重签一次，然后发布。",
  "已核实：无密钥预演通过，脚本的每一步在不用签名密钥时都跑通了。还没验证：真正用密钥签名，以及发布后的安装与更新。",
  "批准：用 v3 签名并发布；发布后可以撤下下载，但已经装上的用户要等下一版修正。先不发布：0.7.0 不发，用户停在 0.6.x。",
  "推荐批准：v3 只改了签名步骤，预演覆盖了它的每一步。预演日志与逐步对照见报告 yn-181。",
].join("\n\n");

/** The page's facts at one of R-7's moments: the Brief's sections and the requests, as Core would answer. */
function fixtures(stage, confirmed = false) {
  const done = stage === "result" || stage === "confirmed";
  const replyMin = stage === "approved" ? 2 : 9;
  const cardMin = done ? 6 : stage === "working" ? 2 : 52;
  const x181 = done ? null : who(agents[1]);
  const section = (id, key, kind, title, version, minutes, extra = {}) => ({
    id, key, kind, title, version, owner: lead, updatedAt: at(minutes), updatedTurnId: "t", body: spec(`${title}。`),
    attachments: [], refs: {}, seen: null, history: false, ...extra,
  });
  const card = section(901, "yn-181", done ? "report" : "status",
    done ? "R-7 · Mac 桌面版 0.7.0 已发布" : stage === "working" ? "正在用 v3 脚本重签：3/5 个文件已签" : "等你决定是否重签",
    done ? 6 : stage === "working" ? 5 : 4, cardMin, {
      author: { agentId: "x181", name: agents[1].name },
      ...(done ? {} : { status: { asOf: at(cardMin), validFor: 14_400, stale: false } }),
      ...(stage === "working" ? { revisions: [{ version: 4, author: { agentId: "lead", name: "Dev Lead" }, at: at(52) }] } : {}),
      card: { ...binding("YN-181", done ? "done" : "doing", x181),
        handoffs: { requests: [{ n: 7, title: "Mac 桌面版应用内更新", at: at(2900), merged: false, messageId: "m7" }], events: [] } },
    });
  const ask = section(902, "yn-181/sign", "ask", "用 v3 重签？", stage === "asked" ? 1 : 2, stage === "asked" ? 50 : replyMin, {
    body: spec(ASK_BODY),
    owner: { agentId: "x181", name: agents[1].name, state: "active" },
    ask: { question: QUESTION, reply: { options: [{ id: "yes", label: REPLY }], freeText: true },
      state: stage === "asked" ? "open" : stage === "approved" ? "replied" : "resolved",
      ...(stage === "asked" ? {} : { repliedAt: at(replyMin), replyText: REPLY }) },
    card: binding("YN-181", done ? "done" : "doing", x181),
  });
  const cpu = section(903, "yn-197", "status", "Core CPU 调查 · 阶段对照完成", 7, 330, {
    author: { agentId: "x197", name: agents[2].name }, status: { asOf: at(330), validFor: 14_400, stale: false },
    seen: { version: 7, at: at(300) }, card: binding("YN-197", "doing", who(agents[2])),
  });
  const overview = section(904, "development", "status", "开发状态", 12, 75, { status: { asOf: at(75), validFor: 86_400, stale: false } });
  const items = done ? [
    { kind: "report", title: "R-7 · Mac 桌面版 0.7.0 已发布", note: null, key: "yn-181", version: 6, sectionId: 901, state: "live", currentVersion: 6 },
    { kind: "release", title: "Yuzuno Desktop 0.7.0", note: null, url: "https://example.test/releases/desktop-0.7.0", repository: "o/r", tag: "desktop-0.7.0" },
    { kind: "pr", title: "v3 签名脚本", note: null, url: "https://example.test/pull/77", repository: "o/r", number: 77, state: "merged", observedAt: at(20) },
  ] : null;
  const routed = (s, task, status, responsible, deliverables = null) => ({
    sectionId: s.id, key: s.key, title: s.title, live: true, task: { id: task, status, archived: false }, responsible,
    ...(deliverables ? { result: { id: `r-${task}`, status: "review", reportedAt: at(6) }, deliverables: { resultId: `r-${task}`, reportedAt: at(6), items: deliverables } } : {}),
  });
  const request = (n, title, text, minutes, state, cards, extra = {}) => ({
    id: `req-${n}`, n, text, textBlocks: null, images: [], files: [], title, createdAt: at(minutes), frontAgentId: "lead",
    messageId: `m${n}`, delivery: "accepted", replies: [], notes: [{ note: "好，交给执行者。", by: desk, at: at(minutes - 1) }],
    routes: [], cards, state, progress: { cards: cards.length, ended: 0 }, lines: [], ...extra,
  });
  const r7state = done ? (stage === "confirmed" || confirmed ? "done" : "ended") : "doing";
  const requests = [
    request(21, null, `把输入框做成和会话一样一直悬浮在屏幕底部吧。参考 https://example.test/${"a".repeat(160)}`, 1, "waiting", [], { notes: [] }),
    request(14, "检查当前 Core CPU 与在做优化的覆盖", "现在在做的几项优化，能覆盖 CPU 这个问题吗？", 1440, "doing", [routed(cpu, "YN-197", "doing", who(agents[2]))]),
    request(12, "Core 空闲时 CPU 偏高", "Core 什么都不做的时候 CPU 也有 6%，查一下。", 2000, "doing", [routed(cpu, "YN-197", "doing", who(agents[2]))]),
    request(7, "Mac 桌面版应用内更新", "Mac 版也要能在应用里更新，像 Windows 那样。", 2900, r7state, [routed(card, "YN-181", done ? "done" : "doing", x181, items)], {
      lines: [{ kind: "ask", sectionId: 902, key: "yn-181/sign", title: ask.title, state: ask.ask.state, at: at(stage === "asked" ? 50 : replyMin), task: "YN-181", cardSectionId: 901 }],
      ...(r7state === "done" ? { confirmedAt: at(1) } : {}),
    }),
  ];
  const live = [card, ask, cpu, overview].filter((s) => !(done && s.kind === "ask"));
  const history = done ? [{ ...ask, history: true, historyReason: "resolved" }] : [];
  return { sections: live, history, requests };
}

const home = (data) => ({
  generatedAt: at(0), order: [PROJECT],
  needsYou: data.sections.filter((s) => s.ask?.state === "open").map((s) => ({ kind: "ask", projectId: PROJECT, agentId: s.owner.agentId, agentName: s.owner.name, sectionKey: s.key, title: s.title, since: s.updatedAt })),
  projects: [{
    project: { id: PROJECT, name: "yuzuno-next" },
    agents: { working: 2, idle: 1, waiting: 0, error: 0, offline: 0, total: 3 },
    contentEditors: { version: 1, editorAgentIds: ["lead"] },
    errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 2160, sections: data.sections, history: data.history },
  }],
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
// R-7 at each moment (§3.3), as the page should say it.
const expected = {
  en: {
    // W5: its open Ask is the first look, with no line repeating it and no Answer before it.
    asked: { group: "needs", fact: "", action: null, delivered: 0, asks: ["yn-181/sign"] },
    approved: { group: "doing", fact: `You replied “${REPLY}”`, action: "Follow up", delivered: 0, asks: [] },
    working: { group: "doing", fact: "正在用 v3 脚本重签：3/5 个文件已签", action: "Follow up", delivered: 0, asks: [] },
    result: { group: "needs", fact: "YN-181 is done · delivered 3 items", action: "Confirm done", delivered: 3, asks: [] },
    confirmed: { group: "done", fact: "YN-181 is done · delivered 3 items", action: null, delivered: 3, asks: [] },
  },
  "zh-Hans": {
    asked: { group: "needs", fact: "", action: null, delivered: 0, asks: ["yn-181/sign"] },
    approved: { group: "doing", fact: `你已答复「${REPLY}」`, action: "追问", delivered: 0, asks: [] },
    working: { group: "doing", fact: "正在用 v3 脚本重签：3/5 个文件已签", action: "追问", delivered: 0, asks: [] },
    result: { group: "needs", fact: "YN-181 已完成 · 交付 3 项", action: "确认完成", delivered: 3, asks: [] },
    confirmed: { group: "done", fact: "YN-181 已完成 · 交付 3 项", action: null, delivered: 3, asks: [] },
  },
};
const words = {
  en: { joined: "Show →", confirm: "Confirm done", sendNote: "Send to Agent", submit: `Submit: ${REPLY}` },
  "zh-Hans": { joined: "查看 →", confirm: "确认完成", sendNote: "发给 Agent", submit: `提交：${REPLY}` },
};

const browser = await launchBrowser();
const runs = [
  { name: "en-1440", viewport: { width: 1440, height: 900 }, language: "en" },
  { name: "zh-1440", viewport: { width: 1440, height: 900 }, language: "zh-Hans" },
  { name: "en-390", viewport: { width: 390, height: 844 }, language: "en", phone: true },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", phone: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "request-blocks-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.ok(report.posts.every((p) => /\/requests\/7\/confirm$|\/brief\/reply$/.test(p.path)),
  `nothing sent but the confirmation, the note and the answer: ${JSON.stringify(report.posts)}`);
console.log(`request-blocks-check (${engine}): ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${engine} ${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    ...(run.phone ? { isMobile: engine === "chromium", hasTouch: true } : {}),
  });
  await context.addInitScript((language) => {
    if (window !== window.top || location.protocol === "about:") return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, run.language);
  // What the user did to R-7's Ask in this run (W5): its notes, and the answer once sent, as Core keeps them.
  const state = { stage: "asked", confirmed: false, notes: [], answered: null };
  const asAnswered = (data) => {
    for (const s of data.sections) {
      if (s.key !== "yn-181/sign") continue;
      if (state.notes.length) s.ask = { ...s.ask, notes: state.notes };
      if (state.answered) Object.assign(s, { version: 2, updatedAt: state.answered.at, ask: { ...s.ask, state: "replied", repliedAt: state.answered.at, replyText: state.answered.text } });
    }
    return data;
  };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    const data = asAnswered(fixtures(state.stage, state.confirmed));
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-blocks" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home(data) });
    if (path === `/api/projects/${PROJECT}/front-desk`) return route.fulfill({ json: { version: 1, agentId: "lead", effectiveAgentId: "lead" } });
    if (path === `/api/projects/${PROJECT}/requests` && method === "GET") return route.fulfill({ json: { requests: data.requests, hasMore: false } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    // R-7's card's version 4, which its history keeps (C2), as Core reads it by the card's identity.
    if (path === `/api/projects/${PROJECT}/brief/refreshes/901/versions/4` && method === "GET") {
      const now = fixtures("asked").sections.find((s) => s.key === "yn-181");
      return route.fulfill({ json: { ...now, version: 4, author: { agentId: "lead", name: "Dev Lead" }, historyReason: "revised" } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w+\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      if (path === `/api/projects/${PROJECT}/brief/reply`) {
        const sent = JSON.parse(request.postData() || "{}");
        const accepted = { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "x181-t2", error: null };
        assert.equal(sent.key, "yn-181/sign");
        if (sent.intent === "note") state.notes = [{ version: 1, at: new Date().toISOString(), text: sent.text.trim(), agentId: sent.agentId }, ...state.notes];
        else state.answered = { at: new Date().toISOString(), text: sent.text ? `${REPLY}: ${sent.text}` : REPLY };
        return route.fulfill({ json: accepted });
      }
      if (path === `/api/projects/${PROJECT}/requests/7/confirm`) {
        state.confirmed = true;
        return route.fulfill({ json: { request: fixtures(state.stage, true).requests.find((r) => r.n === 7) } });
      }
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] },
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const open = async (stage) => {
    state.stage = stage;
    state.confirmed = false;
    state.notes = [];
    state.answered = null;
    const url = `http://${HOST}/#/home?w=ws-blocks&p=${PROJECT}`;
    // Each moment read afresh, as a reload of the page reads it.
    if (page.url() === url) await page.reload();
    else await page.goto(url);
    try {
      await page.locator(`[data-project-home="${PROJECT}"]`).waitFor({ timeout: 15_000 });
      await page.locator('[data-request-block="7"]').waitFor({ state: "attached", timeout: 15_000 });
    } catch (error) {
      await page.screenshot({ path: join(output, `${engine}-${run.name}-${stage}-failed.png`) }).catch(() => {});
      throw error;
    }
  };
  const shot = async (name, locator) => {
    const file = `${engine}-${run.name}-${name}.png`;
    await (locator ?? page).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const read = () => page.evaluate(() => {
    const block = (n) => document.querySelector(`[data-request-block="${n}"]`);
    const r7 = block(7);
    const view = document.querySelector(".home-view");
    return {
      blocks: [...document.querySelectorAll("[data-request-block]")].map((el) => Number(el.dataset.requestBlock)),
      group: r7.closest(".request-group")?.dataset.group ?? null,
      fact: r7.querySelector(".request-block-fact-line")?.textContent.trim() ?? "",
      meta: r7.querySelector(".request-block-fact-meta")?.textContent.trim() ?? "",
      action: r7.querySelector(".request-block-action")?.textContent.trim() || null,
      delivered: r7.querySelectorAll(".request-block-delivered li").length,
      asks: [...r7.querySelectorAll(".request-block-asks [data-section-key]")].map((el) => el.dataset.sectionKey),
      words: document.body.innerText.split("Mac 版也要能在应用里更新").length - 1,
      pageWidth: document.scrollingElement.scrollWidth, innerWidth,
      viewWidth: view.scrollWidth, viewClient: view.clientWidth,
      dock: !!document.querySelector(".home-dock .project-talk-compose"),
      wider: [...document.querySelectorAll(".request-block, .request-block *")].filter((el) => el.getBoundingClientRect().right > view.getBoundingClientRect().right + 1).length,
    };
  });
  try {
    for (const stage of ["asked", "approved", "working", "result", "confirmed"]) {
      await open(stage);
      const got = await read();
      const want = expected[run.language][stage];
      assert.deepEqual(got.blocks.slice().sort((a, b) => a - b), [7, 12, 14, 21], `${stage}: every request once ${JSON.stringify(got.blocks)}`);
      assert.deepEqual({ group: got.group, fact: got.fact, action: got.action, delivered: got.delivered, asks: got.asks }, want, `${stage}: ${JSON.stringify(got)}`);
      assert.equal(got.words, 0, `${stage}: R-7's words stay in its folded conversation`);
      assert.ok(got.pageWidth <= got.innerWidth + 1 && got.viewWidth <= got.viewClient + 1 && got.wider === 0, `${stage}: nothing wider: ${JSON.stringify(got)}`);
      assert.ok(got.dock, "the composer is in the dock");
      await shot(stage);
      pass(`R-7 ${stage}: one block, ${want.group}, its fact and action`, got);
    }

    // W5: R-7's Ask in its first look, answerable there; nothing opened, the focus not taken.
    await open("asked");
    const askId = `home-section-${PROJECT}-yn-181/sign`;
    const ask = page.locator(`[data-request-block="7"] .request-block-asks [id="${askId}"]`);
    await ask.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const first = await page.evaluate((id) => {
      const card = document.getElementById(id);
      const box = card.getBoundingClientRect();
      const view = document.querySelector(".home-view").getBoundingClientRect();
      const decision = card.querySelector(".home-ask-decision");
      return {
        inView: box.top >= view.top - 1 && box.top < view.bottom - 120,
        opened: !!document.querySelector('[data-request-block="7"][data-open]'),
        cards: document.querySelectorAll(`[id="${id}"]`).length,
        decision: !!decision && decision.getClientRects().length > 0,
        focusTaken: !!document.activeElement && document.activeElement !== document.body && card.contains(document.activeElement),
        keyboardWanted: document.activeElement?.matches?.("textarea, input, [contenteditable='true']") ?? false,
        evidence: card.textContent.includes("还没验证"),
      };
    }, askId);
    assert.ok(first.inView && !first.opened && first.cards === 1 && first.decision && !first.focusTaken && !first.keyboardWanted && first.evidence,
      `the Ask, whole, in the first look: ${JSON.stringify(first)}`);
    await shot("ask-first-look");
    pass("R-7's Ask is answerable in the first look: no Answer, nothing opened, the focus not taken", first);

    // Keyboard: Tab from the block's title goes into the Ask.
    await page.locator('[data-request-block="7"] .request-block-title').focus();
    let reached = false;
    for (let i = 0; i < 4 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate((id) => document.getElementById(id).contains(document.activeElement), askId);
    }
    assert.ok(reached, "Tab reaches the Ask from its block's title");
    // Its fold folds and unfolds it, the long evidence with it.
    const fold = ask.locator(".home-section-head .home-fold").first();
    if (await fold.count()) {
      await fold.click();
      await page.waitForFunction((id) => !document.getElementById(id).querySelector(".home-ask-decision")?.getClientRects().length, askId, { timeout: 5000 });
      await fold.click();
      await page.waitForFunction((id) => document.getElementById(id).querySelector(".home-ask-decision")?.getClientRects().length > 0, askId, { timeout: 5000 });
    }
    pass("Tab reaches R-7's Ask from its title; its fold shows its evidence again", { fold: await fold.count() });

    // A note ("Wait, what?") goes alone; the picked decision and its words stay as they were.
    await ask.locator(".home-ask-decision fieldset label, .clarification label").filter({ hasText: REPLY }).locator("input").check();
    await ask.locator(".home-ask-words [data-composer-input]").click();
    await page.keyboard.insertText("先看签名日志");
    await ask.getByRole("button", { name: "Wait, what?", exact: true }).click();
    await page.keyboard.insertText("预演覆盖了公证这一步吗？");
    await ask.getByRole("button", { name: w.sendNote, exact: true }).click();
    await ask.locator(".home-ask-notes").waitFor({ timeout: 10_000 });
    const noted = await page.evaluate((id) => {
      const card = document.getElementById(id);
      const decision = card.querySelector(".home-ask-decision");
      return {
        picked: [...(decision?.querySelectorAll("input[type=radio]") ?? [])].filter((r) => r.checked).map((r) => r.closest("label").textContent.trim()),
        words: decision?.querySelector(".home-ask-words [data-composer-input]")?.textContent.trim() ?? null,
        replied: !!card.querySelector(".home-ask-replied"),
        cards: document.querySelectorAll(`[id="${id}"]`).length,
      };
    }, askId);
    assert.ok(noted.picked.length === 1 && noted.picked[0].startsWith(REPLY) && noted.words === "先看签名日志" && !noted.replied && noted.cards === 1,
      `after the note, the draft as it was: ${JSON.stringify(noted)}`);
    await shot("ask-noted");
    pass("a note leaves R-7's picked decision and its words as they were", noted);

    // Answered: in its place, once; R-7 stays where it was for the visit.
    // What must not move: the Ask within its block, the block's place among the page's blocks and its group. The page
    // above it may change (a phone's header loses a row when "1 needs you" goes), and an Ask folded to its short form
    // near the page's end lowers how far the page scrolls; either moves the page, not the block. Where it is on the
    // screen is recorded beside: scroll anchoring keeps it there when the page above changes out of view.
    const placed = () => page.evaluate((id) => {
      const view = document.querySelector(".home-view");
      const r7 = document.querySelector('[data-request-block="7"]');
      const ask = document.getElementById(id);
      return {
        askInBlock: Math.round(ask.getBoundingClientRect().top - r7.getBoundingClientRect().top),
        order: [...document.querySelectorAll("[data-request-block], [data-project-block]")].indexOf(r7),
        group: r7.closest(".request-group")?.dataset.group ?? null,
        screen: Math.round(r7.getBoundingClientRect().top),
        page: Math.round(r7.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop),
        upFront: !!r7.querySelector(`.request-block-asks [id="${id}"]`), cards: document.querySelectorAll(`[id="${id}"]`).length,
      };
    }, askId);
    const before = await placed();
    await ask.getByRole("button", { name: w.submit, exact: true }).click();
    await ask.locator(".home-ask-replied").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
    const after = await placed();
    assert.ok(after.group === before.group && after.order === before.order && Math.abs(after.askInBlock - before.askInBlock) <= 2
      && after.upFront && after.cards === 1,
      `answered in place: ${JSON.stringify({ before, after })}`);
    await shot("ask-answered");
    pass("answered, R-7's Ask stays in its place, once, and the block does not move", { before, after });

    // A joined task's line shows the request its card is under.
    await open("working");
    await page.locator('[data-request-block="14"] .request-block-more').click();
    await page.locator('[data-request-block="14"] .request-block-joined button').click();
    await page.waitForFunction(() => document.querySelector('[data-request-block="12"][data-open]'), null, { timeout: 5000 });
    await page.waitForTimeout(400);
    const joined = await page.evaluate(() => {
      const r12 = document.querySelector('[data-request-block="12"]').getBoundingClientRect();
      const view = document.querySelector(".home-view").getBoundingClientRect();
      return { top: r12.top, viewTop: view.top, viewBottom: view.bottom, card: !!document.querySelector('[data-request-block="12"] [data-section-key="yn-197"]') };
    });
    assert.ok(joined.card && joined.top >= joined.viewTop - 1 && joined.top < joined.viewBottom, `R-12 shown with its card: ${JSON.stringify(joined)}`);
    pass("a joined line shows the request its card is under", joined);

    // W4: who wrote R-7's card, and its earlier version opened on the report page, read only, the current one offered.
    await open("working");
    await page.locator('[data-request-block="7"] .request-block-more').click();
    const author = (await page.locator('[data-request-block="7"] [data-section-key="yn-181"] .home-card-author').innerText()).trim();
    assert.equal(author, run.language === "en" ? `Written by ${agents[1].name}` : `${agents[1].name} 写`);
    const versions = page.locator('[data-request-block="7"] .request-task-versions');
    await versions.locator("summary").click();
    await versions.locator("button").first().click();
    await page.locator(".home-report .report-head h1").waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector(".home-report .report-notice")?.textContent.includes("4"), null, { timeout: 10_000 });
    const old = await page.evaluate(() => ({
      hash: location.hash, title: document.querySelector(".home-report .report-head h1")?.textContent.trim() ?? "",
      notice: document.querySelector(".home-report .report-notice")?.textContent.trim() ?? "",
      offered: document.querySelectorAll(".home-report .report-notice button").length,
    }));
    assert.ok(/[?&]v=4\b/.test(old.hash) && old.title === "等你决定是否重签" && old.offered === 1, `version 4 on the report page: ${JSON.stringify(old)}`);
    await shot("earlier-version");
    await page.locator(".report-back").click();
    await page.waitForFunction(() => !document.querySelector(".home-report"), null, { timeout: 10_000 });
    pass("R-7's card names who wrote it; its earlier version opens on the report page", { author, ...old });

    // See words: R-7's card's source line shows its words in the conversation, with the focus; nothing is wider there.
    await open("working");
    await page.locator('[data-request-block="7"] .request-block-more').click();
    const r7card = page.locator(`[data-request-block="7"] [data-section-key="yn-181"]`);
    await r7card.locator(".card-source-line").click();
    await r7card.locator(".card-source-requests .talk-link").first().click();
    await page.waitForFunction(() => document.activeElement?.matches?.('.project-talk-mine[data-words="7"]'), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const chat = await page.evaluate(() => {
      const view = document.querySelector(".home-view").getBoundingClientRect();
      const words = document.querySelector('.project-talk-mine[data-words="7"]').getBoundingClientRect();
      return {
        tab: document.querySelector('[role="tab"][data-tab="chat"]')?.getAttribute("aria-selected"),
        inView: words.top < view.bottom && words.bottom > view.top,
        wider: [...document.querySelectorAll(".project-talk-mine, .project-talk-bubble, .project-talk-project, .project-talk-line")]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > view.right + 1 || r.left < view.left - 1); })
          .map((el) => el.className),
        long: !!document.querySelector('.project-talk-mine[data-words="21"]'),
        pageWidth: document.scrollingElement.scrollWidth, innerWidth,
      };
    });
    assert.ok(chat.tab === "true" && chat.inView && chat.long && chat.wider.length === 0 && chat.pageWidth <= chat.innerWidth + 1,
      `See words in the conversation, nothing wider: ${JSON.stringify(chat)}`);
    await shot("see-words");
    pass("See words shows R-7's words in the conversation; a long word stays in its bubble", chat);

    // Confirm done: R-7 goes to Done, once Core has it.
    await open("result");
    await page.locator('[data-request-block="7"] .request-block-action').click();
    await page.waitForFunction(() => document.querySelector('[data-request-block="7"]')?.closest(".request-group")?.dataset.group === "done", null, { timeout: 5000 });
    pass("Confirm done files the request under Done");
  } finally {
    await context.close();
  }
}
