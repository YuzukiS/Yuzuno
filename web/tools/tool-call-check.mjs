// One capsule per tool call (T-9) in a real browser: each call's icon, name
// and short result on one line, cut short with an ellipsis rather than
// wrapped or scrolled sideways; a few more facts on mouse hover and keyboard
// focus, which Escape hides; on a touch screen a tap opens the row instead,
// leading with the same facts above the raw input and result. Returned,
// refused, failed, queued, to-expand, running and unconfirmed calls.
// Desktop (light, dark, English) and a 393 px touch phone. Production bundle,
// no Core: synthetic data, nothing is sent, and no full item is fetched.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/tool-call-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/tool-calls");
await mkdir(output, { recursive: true });
const report = { task: "T-9", checks: [], shots: [], errors: [], requests: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shoot = async (target, name) => {
  const path = `${output}/${name}.png`;
  await target.screenshot({ path });
  report.shots.push(name);
};

const agent = {
  id: "a", name: "Mori", status: "working", harness: "codex", cwd: "/fixture", model: "test-model",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  connectionState: "connected", goal: "", projectId: null,
};
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const reply = (id, text) => ({ id, type: "agentMessage", text });
// Core's answers as Codex keeps them: the structured answer and its text.
const call = (id, tool, answer, extra = {}) => ({ id, type: "mcpToolCall", server: "yuzuno", tool, status: "completed",
  arguments: { taskId: "T-9" }, result: { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer }, ...extra });
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: [
    { id: "done", status: "completed", items: [
      user("u1", "Record the progress and tell Dev 7."),
      call("read", "peer_read", { messages: [{ seq: 101, sender: { name: "Dev Lead" } }, { seq: 102, sender: { name: "Dev Lead" } },
        { seq: 103, sender: { name: "Dev 2" } }], nextAfterSeq: 103, hasMore: true }),
      call("comment", "task_comment", { task: { id: "T-9", title: "Tool call capsules", status: "doing", version: 49 }, activity: { seq: 640, kind: "comment" } }),
      call("update", "task_update", { task: { id: "T-9", title: "Tool call capsules", status: "review", version: 50 }, activity: { seq: 641, kind: "updated" } }),
      call("index", "brief_get", { projectName: "Example", version: 12, sections: [], index: [{ key: "a" }, { key: "b" }, { key: "c" }], missingKeys: [] }),
      call("brief", "brief_update", { accepted: true, receipt: { kind: "updated" }, version: 13, sections: [{ key: "progress", version: 4 }, { key: "plan", version: 2 }] }),
      call("conflict", "brief_update", { accepted: false, error: "brief_rejected: version_conflict. Nothing was changed", problems: [{ code: "version_conflict" }], latest: { version: 14 } }),
      call("send", "peer_send", { message: { id: "m1", seq: 210, recipient: { id: "d7", name: "Dev 7" }, delivery: { state: "pending" }, firstReadAt: null, taskId: "T-9" } }),
      { id: "lost-mail", type: "mcpToolCall", server: "yuzuno", tool: "peer_send", status: "failed", result: null,
        error: { message: "MCP server closed the connection before it answered; the request may or may not have been handled" } },
      // Codex calls it completed; its MCP result says it is an error.
      call("crash", "peer_read", null, { result: { content: [{ type: "text", text: "Error: mailbox unavailable" }], isError: true } }),
      call("cut", "peer_read", { messages: [], hasMore: false }, { _yuzunoTruncated: { result: { bytes: 96_000, keep: "head" } } }),
      { id: "long", type: "mcpToolCall", server: "a-very-long-documentation-server-name", tool: "search_reference_for_the_current_project_in_full", status: "completed" },
      { id: "sh", type: "commandExecution", command: "npm test -- tools/tool-call-ui.test.mjs", status: "completed", exitCode: 0, aggregatedOutput: "ok\n" },
      reply("a1", "Recorded on T-9; the mail to Dev 7 is queued."),
    ] },
    // A turn that ended with a call still reported as running.
    { id: "lost", status: "completed", items: [
      user("u2", "Read the board again."),
      { id: "gone", type: "mcpToolCall", server: "yuzuno", tool: "peer_read", status: "inProgress", arguments: {} },
      reply("a2", "The connection ended while that call was running."),
    ] },
    { id: "live", status: "inProgress", items: [
      user("u3", "Keep going."),
      { id: "running", type: "mcpToolCall", server: "yuzuno", tool: "task_update", status: "inProgress", arguments: {} },
    ] },
  ],
};

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ width, height, touch, theme, language }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([theme, language]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, [theme, language]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET", `no writes: ${url.pathname}`);
    if (url.pathname.startsWith("/api/")) report.requests.push(url.pathname);
    if (url.pathname === "/api/workspace")
      return route.fulfill({ json: { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (url.pathname === "/api/agents/a") return route.fulfill({ json: detail });
    if (url.pathname === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (url.pathname === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(`${width} ${theme} ${language}: ${error.message}`));
  await page.goto("http://tool-calls.test/");
  if (touch) await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
  else await page.locator('.agent-row[data-agent-id="a"]').click();
  await page.locator("#turn-live").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: ".jump-latest { visibility: hidden }" });
  // Every Tool activity open, as a reader opens it. A group can open on its
  // own as the conversation settles, so each is opened until it stays open.
  for (const turn of ["done", "lost", "live"]) {
    const group = page.locator(`#turn-${turn} .tool-activity`).first();
    await group.waitFor();
    for (let tries = 0; tries < 5 && !(await group.evaluate((el) => el.open)); tries++) {
      await group.locator(":scope > summary").click();
      await page.waitForTimeout(300);
    }
    assert.ok(await group.evaluate((el) => el.open), `${turn}: its Tool activity opens`);
  }
  for (const id of ["long", "gone", "running"]) await page.locator(`#item-${id}`).waitFor({ state: "attached" });
  return { context, page };
}

/** Each capsule as the reader sees it: its words, and whether it is one line
 * inside its row with its end in view. */
const capsules = (page) => page.evaluate(() => [...document.querySelectorAll(".tool-item > summary.tool-call")].map((summary) => {
  const row = summary.closest(".tool-item");
  const box = summary.getBoundingClientRect();
  const holder = row.parentElement.getBoundingClientRect();
  const part = (selector) => summary.querySelector(selector);
  const end = part(".tool-result");
  const note = part(".tool-call-note");
  const line = parseFloat(getComputedStyle(summary).lineHeight) || parseFloat(getComputedStyle(summary).fontSize) * 1.5;
  return {
    id: row.id.replace(/^item-/, ""),
    name: part(".tool-call-name")?.textContent,
    note: note?.textContent ?? null,
    end: end?.textContent ?? null,
    tone: summary.dataset.tone ?? null,
    oneLine: box.height < line * 2 + 8,
    height: Math.round(box.height),
    inside: box.left >= holder.left - 1 && box.right <= holder.right + 1,
    endInView: !end || end.getBoundingClientRect().right <= box.right + 1,
    // The name and the result are one run of text cut at its end: what
    // reaches past that end is what the ellipsis took.
    noteCut: note ? note.getBoundingClientRect().right > part(".tool-call-text").getBoundingClientRect().right + 0.5 : false,
    nameCut: part(".tool-call-name").getBoundingClientRect().right > part(".tool-call-text").getBoundingClientRect().right + 0.5,
    radius: Math.round(parseFloat(getComputedStyle(summary).borderTopLeftRadius)),
  };
}));
const sideways = (page) => page.evaluate(() => {
  const pane = document.querySelector(".conversation-scroll");
  return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, pane: pane ? pane.scrollWidth - pane.clientWidth : null };
});
const tip = (page) => page.locator('body > [role="tooltip"].tool-call-tip');
const tipBox = (page) => tip(page).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, text: el.innerText };
});

const expected = {
  en: [
    ["read", "yuzuno/peer_read", "3 messages · more to read", null, "returned"],
    ["comment", "yuzuno/task_comment", "comment saved on T-9", null, "returned"],
    ["update", "yuzuno/task_update", "T-9 updated · To review", null, "returned"],
    ["index", "yuzuno/brief_get", "Brief v12 · index of 3, no bodies", null, "returned"],
    ["brief", "yuzuno/brief_update", "Brief v13 · 2 sections updated", null, "returned"],
    ["conflict", "yuzuno/brief_update", "version_conflict", "refused", "refused"],
    ["send", "yuzuno/peer_send", "to Dev 7", "queued", "queued"],
    ["lost-mail", "yuzuno/peer_send", "MCP server closed the connection before it answered; the request may or may not have been handled", "failed", "failed"],
    ["crash", "yuzuno/peer_read", "Error: mailbox unavailable", "failed", "failed"],
    ["cut", "yuzuno/peer_read", "result to expand", null, "returned"],
    ["long", "a-very-long-documentation-server-name/search_reference_for_the_current_project_in_full", null, "returned", "returned"],
    ["sh", "npm test -- tools/tool-call-ui.test.mjs", null, "exit 0", "returned"],
    ["gone", "yuzuno/peer_read", null, "Unconfirmed", "unconfirmed"],
    ["running", "yuzuno/task_update", null, "running", "running"],
  ],
};

try {
  for (const view of [
    { name: "desktop-light", width: 1440, height: 900, touch: false, theme: "light", language: "en" },
    { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark", language: "en" },
    { name: "phone-393", width: 393, height: 852, touch: true, theme: "light", language: "en" },
  ]) {
    const { context, page } = await open(view);
    try {
      const shown = await capsules(page);
      assert.deepEqual(shown.map((c) => [c.id, c.name, c.note, c.end, c.tone]), expected.en, `${view.name}: ${JSON.stringify(shown)}`);
      for (const capsule of shown) {
        assert.ok(capsule.oneLine, `${view.name}: one line: ${JSON.stringify(capsule)}`);
        assert.ok(capsule.inside && capsule.endInView, `${view.name}: inside its row, its end in view: ${JSON.stringify(capsule)}`);
        assert.ok(capsule.radius * 2 >= capsule.height, `${view.name}: a capsule: ${JSON.stringify(capsule)}`);
      }
      const over = await sideways(page);
      assert.ok(over.page <= 0 && (over.pane === null || over.pane <= 0), `${view.name}: nothing sideways ${JSON.stringify(over)}`);
      const cut = shown.filter((c) => c.noteCut).map((c) => c.id);
      assert.ok(cut.includes("lost-mail"), `${view.name}: a long result is cut short on its one line: ${JSON.stringify(cut)}`);
      // The result gives way first: a Yuzuno tool's name stays whole beside it.
      const names = shown.filter((c) => c.name.startsWith("yuzuno/") && c.nameCut).map((c) => c.id);
      assert.deepEqual(names, [], `${view.name}: names cut short: ${JSON.stringify(shown)}`);
      // The measure sees a cut: at 393 px the long MCP name is one.
      if (view.touch) assert.ok(shown.find((c) => c.id === "long").nameCut, `${view.name}: the long name is cut short`);
      const overview = await page.locator("#turn-done .tool-activity > summary .tool-overview-part").allTextContents();
      assert.deepEqual(overview, ["12 tool steps", "2 failed", "1 refused"]);
      assert.equal(await page.locator(".tool-activity .tool-count").count(), 0, "no capsule stack in the heading");
      record(`${view.name}: one capsule per call, one line inside its row, nothing sideways; the heading is an overview`, { cut, over, overview });
      await shoot(page.locator("#turn-done .tool-activity").first(), `${view.name}-calls`);
      await shoot(page.locator("#turn-lost .tool-activity").first(), `${view.name}-unconfirmed`);
      await shoot(page.locator("#turn-live .tool-activity").first(), `${view.name}-running`);

      if (!view.touch) {
        // A resting mouse shows the tip; leaving hides it; Escape hides it.
        const update = page.locator("#item-update > summary");
        await update.hover();
        await tip(page).waitFor({ timeout: 2_000 });
        const box = await tipBox(page);
        assert.ok(box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height, `in the window: ${JSON.stringify(box)}`);
        assert.match(box.text, /yuzuno\/task_update/);
        assert.match(box.text, /Status at receipt\s*To review/);
        assert.match(box.text, /doesn't mean code was merged or released/);
        assert.equal(await update.getAttribute("aria-describedby"), await tip(page).getAttribute("id"));
        await shoot(page, `${view.name}-hover`);
        await page.keyboard.press("Escape");
        await tip(page).waitFor({ state: "detached", timeout: 2_000 });
        await page.mouse.move(2, 2);
        await page.locator("#item-send > summary").hover();
        await tip(page).waitFor({ timeout: 2_000 });
        assert.match((await tipBox(page)).text, /Delivered doesn't mean it was read or acted on/);
        await page.mouse.move(2, 2);
        await tip(page).waitFor({ state: "detached", timeout: 2_000 });
        record(`${view.name}: hover shows a few more facts in the window; Escape and leaving hide them`, { box });

        // Keyboard focus: Tab onto a capsule shows its tip at once; Escape
        // hides it and keeps the focus there.
        await page.locator("#item-comment > summary").focus();
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => document.activeElement?.closest(".tool-item")?.id);
        assert.equal(focused, "item-update");
        await tip(page).waitFor({ timeout: 2_000 });
        const ring = await page.locator("#item-update > summary").evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth));
        assert.ok(ring >= 2, `a focus ring: ${ring}`);
        await shoot(page, `${view.name}-focus`);
        await page.keyboard.press("Escape");
        await tip(page).waitFor({ state: "detached", timeout: 2_000 });
        assert.equal(await page.evaluate(() => document.activeElement?.closest(".tool-item")?.id), "item-update", "focus stays");
        // Enter opens the row: its facts lead, the raw input and result follow.
        await page.keyboard.press("Enter");
        const opened = page.locator("#item-update .tool-content");
        await opened.waitFor();
        assert.match(await opened.locator(".tool-call-details").innerText(), /Task\s*T-9 · Tool call capsules/);
        assert.match(await opened.locator("pre").innerText(), /"structuredContent"/);
        await shoot(page.locator("#item-update"), `${view.name}-opened`);
        await page.keyboard.press("Enter");
        record(`${view.name}: keyboard focus shows the tip, Escape hides it and keeps focus, Enter opens the raw row`, { ring });
        // A press opens the row and shows no tip over what it opens.
        await page.locator("#item-conflict > summary").click();
        await page.waitForTimeout(400);
        assert.equal(await tip(page).count(), 0, "no tip over the opened row");
        assert.match(await page.locator("#item-conflict .tool-call-details").innerText(), /Reason\s*brief_rejected: version_conflict/);
        await shoot(page.locator("#item-conflict"), `${view.name}-refused-opened`);
        // An error flag on a call called completed is failed, styled and counted as one.
        // So is a queued mail: each in its own colour, in every theme.
        const colours = await page.evaluate(() => {
          const end = (id) => getComputedStyle(document.querySelector(`#item-${id} > summary .tool-result`)).color;
          return { tone: document.querySelector("#item-crash > summary").dataset.tone, failed: end("crash"), queued: end("send"),
            returned: end("long"), plain: getComputedStyle(document.querySelector("#item-comment > summary .tool-call-note")).color };
        });
        assert.equal(colours.tone, "failed");
        assert.ok(colours.failed !== colours.returned && colours.failed !== colours.plain, `the failure has its own colour: ${JSON.stringify(colours)}`);
        assert.ok(colours.queued !== colours.returned && colours.queued !== colours.failed, `a queued mail has its own colour: ${JSON.stringify(colours)}`);
        await shoot(page.locator("#item-crash"), `${view.name}-error-flag`);
        await page.locator("#item-conflict > summary").click();
        record(`${view.name}: a click opens the row with its facts and no tip`);
      } else {
        // A tap opens the row, which leads with the facts; no tip appears.
        await page.locator("#item-send > summary").tap();
        await page.waitForTimeout(400);
        assert.equal(await tip(page).count(), 0, "no tip from a touch");
        const opened = page.locator("#item-send .tool-content");
        await opened.waitFor();
        assert.match(await opened.locator(".tool-call-details").innerText(), /To\s*Dev 7\s*Delivery when sent\s*queued/);
        assert.match(await opened.locator(".tool-call-details").innerText(), /Delivered doesn't mean it was read or acted on/);
        await shoot(page.locator("#item-send"), `${view.name}-tapped`);
        const after = await sideways(page);
        assert.ok(after.page <= 0 && (after.pane === null || after.pane <= 0), `opened, nothing sideways ${JSON.stringify(after)}`);
        await page.locator("#item-send > summary").tap();
        await page.locator("#item-cut > summary").tap();
        await page.locator("#item-cut .tool-content").waitFor();
        assert.match(await page.locator("#item-cut .tool-content").innerText(), /cut short or doesn't read as Yuzuno's answer/);
        await shoot(page.locator("#item-cut"), `${view.name}-to-expand`);
        record(`${view.name}: a tap opens the row with its facts and no tip; a cut result says so`, { after });
      }
    } catch (error) {
      await page.screenshot({ path: `${output}/failed.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }

  // In Chinese: the capsule's words follow the language; names, IDs and
  // Core's codes stay as given.
  {
    const { context, page } = await open({ width: 1440, height: 900, touch: false, theme: "light", language: "zh-Hans" });
    try {
      const shown = await capsules(page);
      assert.deepEqual(shown.map((c) => [c.id, c.note, c.end]), [
        ["read", "3 条消息 · 还有更多", null],
        ["comment", "T-9 备注已保存", null],
        ["update", "T-9 已更新 · 待审阅", null],
        ["index", "Brief v12 · 索引 3 个区块（无正文）", null],
        ["brief", "Brief v13 · 已更新 2 个区块", null],
        ["conflict", "version_conflict", "被拒绝"],
        ["send", "给 Dev 7", "排队中"],
        ["lost-mail", "MCP server closed the connection before it answered; the request may or may not have been handled", "失败"],
        ["crash", "Error: mailbox unavailable", "失败"],
        ["cut", "结果待展开", null],
        ["long", null, "已返回"],
        ["sh", null, "退出码 0"],
        ["gone", null, "未确认"],
        ["running", null, "运行中"],
      ], JSON.stringify(shown));
      for (const capsule of shown) assert.ok(capsule.oneLine && capsule.inside && capsule.endInView, JSON.stringify(capsule));
      await page.locator("#item-update > summary").hover();
      await tip(page).waitFor({ timeout: 2_000 });
      const box = await tipBox(page);
      assert.match(box.text, /回执时状态\s*待审阅/);
      assert.match(box.text, /不表示代码已合并或发布/);
      await shoot(page.locator("#turn-done .tool-activity").first(), "desktop-zh-calls");
      await shoot(page, "desktop-zh-hover");
      record("desktop zh-Hans: the capsules' and tip's words are Chinese; names, IDs and codes as given", { box });
    } catch (error) {
      await page.screenshot({ path: `${output}/failed.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.deepEqual(report.requests.filter((path) => /\/items\//.test(path)), [], "no full item fetched");
  record("no page errors; no item read in full to say a result");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
