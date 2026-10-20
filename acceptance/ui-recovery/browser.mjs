// T-36 acceptance: one headless Chromium against an isolated production build
// with a mocked Core (no Core, no Agent, no model). Run from web/:
//   YUZUNO_UI_DIST=../acceptance/ui-recovery/dist node ../acceptance/ui-recovery/browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated production build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.ok(!dist.endsWith("/web/dist"), "never the shared web/dist");
const shots = join(here, "screenshots");
await mkdir(shots, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], chunkRequests: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};

// Identifies the run: its source HEAD, uncommitted changes in web/src, and a
// hash of the dist it served. Not proof of which source built that dist.
const git = (...args) => execFileSync("git", ["-C", here, ...args], { encoding: "utf8" }).trim();
const digest = createHash("sha256");
for (const name of (await readdir(join(dist, "assets"))).sort()) digest.update(name).update(await readFile(join(dist, "assets", name)));
report.source = { head: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "../../web/src").length > 0,
  dist: createHash("sha256").update(await readFile(join(dist, "index.html"))).digest("hex").slice(0, 16), assets: digest.digest("hex").slice(0, 16) };

// A sanitized reply shaped like the real ones of 2026-10-14 whose Table had
// no title. The private originals (samples/, git-ignored) are an optional
// extra check when present.
const untitled = JSON.stringify({ root: "result", elements: {
  result: { type: "Result", props: { title: "输入内容块", summary: "已登记，尚未开工" }, children: ["items"] },
  items: { type: "Table", props: { id: "input-todos", columns: [{ key: "task", label: "任务" }, { key: "experience", label: "交互" }],
    rows: [{ id: "a", cells: { task: "长文本粘贴", experience: "紧凑块显示编号与行数" } }, { id: "b", cells: { task: "图片输入", experience: "粘贴后显示缩略图" } }] } },
} });
const samples = join(here, "samples/daily-replies.json");
const privateReal = existsSync(samples)
  ? JSON.parse(await readFile(samples, "utf8")).find((r) => r.text.includes('"type":"Table","props":{"id":"input-todos"'))?.text
  : null;
const real = `已加入 TODO。\n\n\`\`\`yuzuno-ui\n${untitled}\n\`\`\`\n\n后续建议按顺序推进。`;

const fence = (body, close = true) => "```yuzuno-ui\n" + body + (close ? "\n```" : "");
const valid = JSON.stringify({
  root: "result",
  elements: {
    result: { type: "Result", props: { title: "Two options", summary: "B is cheaper." }, children: ["table"] },
    table: { type: "Table", props: { id: "options", title: "Options", columns: [{ key: "name", label: "Option" }, { key: "cost", label: "Cost" }],
      rows: [{ id: "a", cells: { name: "A", cost: 12 } }, { id: "b", cells: { name: "B", cost: 9 } }] } },
  },
});
const unknown = valid.replace('"type":"Table"', '"type":"Iframe"');
const output = Array.from({ length: 2400 }, (_, i) => `line ${i + 1}`).join("\n");
const message = (id, text) => ({ id, type: "agentMessage", text, _yuzunoCompletedText: text });
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const turn = (id, items, status = "completed") => ({ id, status, items });
const base = { cwd: "/fixture", model: "m", color: "sage", harness: "codex", createdAt: "", updatedAt: "", unreadCount: 0,
  pendingCount: 0, lastSeq: 3, reviewedSeq: 3, connectionState: "connected" };
const agents = [
  { ...base, id: "a", name: "Mori", status: "idle" },
  { ...base, id: "b", name: "Hana", status: "working" },
];
const streaming = `Building the comparison now.\n\n${fence(valid.slice(0, 90), false)}`;
const details = {
  a: { agent: agents[0], pending: [], artifacts: [], turns: [
    turn("t-real", [user("u1", "登记这些输入任务"), message("r-real", real)]),
    ...(privateReal ? [turn("t-private", [user("u0", "Real reply"), message("r-private", privateReal)])] : []),
    turn("t-invalid", [user("u2", "Show it"), message("r-invalid", `Here is the table.\n\n${fence("{ \"root\": \"result\", ")}\n\nThe rest of the reply is still readable.`)]),
    turn("t-unknown", [user("u3", "Chart"), message("r-unknown", `Before.\n\n${fence(unknown)}\n\nAfter.`)]),
    turn("t-code", [user("u4", "How do I write one?"), message("r-code",
      "An ordinary example stays code:\n\n````markdown\n" + fence(valid) + "\n````\n\n```json\n{\"root\": \"x\"}\n```")]),
    turn("t-cut", [user("u5", "Long one"), message("r-cut", `Started a result.\n\n${fence(valid.slice(0, 120), false)}`)], "interrupted"),
    turn("t-large", [user("u6", "Run it"),
      { id: "cmd", type: "commandExecution", command: "seq", status: "completed", exitCode: 0,
        aggregatedOutput: output.slice(-4000), _yuzunoTruncated: { aggregatedOutput: { bytes: output.length, lines: 2400, keep: "tail" } } },
      message("r-large", `Output above.\n\n${fence(valid)}\n\nDone.`)]),
  ] },
  b: { agent: agents[1], pending: [], artifacts: [], turns: [
    turn("t-live", [user("u6", "Compare"), { id: "r-live", type: "agentMessage", text: streaming }], "inProgress"),
  ] },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { constructor() { window.testEvents = this; } close() {} };
  window.__copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
});
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
/** How the viewer chunk is served: "abort" (a dropped connection), "html"
 * (a deploy removed it and the server answers with index.html), "404", "ok". */
let chunkMode = "abort";
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== "yuzuno-recovery.test") return route.abort();
  if (request.method() !== "GET") {
    report.writes.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ json: {} });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({ json: { workspace: { id: "fixture" }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
  if (/^\/api\/agents\/[ab]$/.test(url.pathname)) return route.fulfill({ json: details[url.pathname.at(-1)] });
  if (url.pathname === "/api/agents/a/items/cmd/payload")
    return route.fulfill({ json: { fields: { aggregatedOutput: output } } });
  if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
  if (/\/assets\/InteractiveResult-[^/]+\.js$/.test(url.pathname)) {
    report.chunkRequests.push({ at: Date.now(), mode: chunkMode, query: url.search });
    if (chunkMode === "abort") return route.abort("internetdisconnected");
    if (chunkMode === "html") return route.fulfill({ status: 200, contentType: "text/html", body: await readFile(join(dist, "index.html")) });
    if (chunkMode === "404") return route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
  }
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript",
    ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)] });
});

const visible = () => page.evaluate(() => {
  const clone = document.querySelector(".conversation-body, main")?.cloneNode(true) ?? document.body.cloneNode(true);
  for (const details of clone.querySelectorAll("details:not([open])"))
    for (const child of [...details.childNodes]) if (child.nodeName !== "SUMMARY") child.remove();
  return clone.textContent;
});
const reply = (id) => page.locator(`[data-item-id="${id}"]`);
const select = async (name) => {
  await page.click(`.agent-row:has-text("${name}") .agent-select`);
  await page.waitForTimeout(500);
};
const changed = async (agentId) => {
  await page.evaluate((id) => window.testEvents.onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: id }) }), agentId);
  await page.waitForTimeout(500);
};

try {
  await page.goto("https://yuzuno-recovery.test/");
  await select("Mori");
  // The viewer chunk fails first: valid results say so, nothing else breaks.
  await reply("r-large").locator('[data-result-state="load"]').waitFor();
  const text = await visible();
  check("a failed viewer leaves every reply readable", /Output above\./.test(text) && /The rest of the reply is still readable\./.test(text)
    && /登记|已加入 TODO/.test(text), text.slice(0, 300));
  check("format errors are local notes with folded details, not raw JSON",
    (await reply("r-invalid").locator('[data-result-state="format"]').count()) === 1
      && (await reply("r-unknown").locator('[data-result-state="format"]').count()) === 1
      && !text.includes('"type":"Iframe"') && !text.includes('{ "root": "result", '), null);
  check("an interrupted reply's unclosed block is unfinished, not loading",
    (await reply("r-cut").locator('[data-result-state="unfinished"]').count()) === 1 && !(await reply("r-cut").textContent()).includes("Generating"), null);
  check("ordinary code examples stay code", (await reply("r-code").locator("[data-result-state], .interactive-result").count()) === 0
    && (await reply("r-code").locator("pre").count()) >= 2, null);
  await page.screenshot({ path: join(shots, "load-failed-light.png") });

  // Retry from the keyboard: a real second request for the chunk.
  const retry = reply("r-large").getByRole("button", { name: "Try again" });
  await retry.focus();
  chunkMode = "ok";
  await page.keyboard.press("Enter");
  await reply("r-large").locator(".interactive-result").waitFor({ timeout: 10_000 });
  check("Try again fetches the viewer again and shows the result", report.chunkRequests.length >= 2
    && report.chunkRequests.at(-1).mode === "ok" && report.chunkRequests.at(-1).query === "?retry=1", report.chunkRequests);
  // Other replies are retried by their own button, without another import.
  for (const id of ["r-real", ...(privateReal ? ["r-private"] : [])]) {
    const button = reply(id).getByRole("button", { name: "Try again" });
    if (await button.count()) await button.click();
    await reply(id).locator(".interactive-result").waitFor({ timeout: 10_000 });
  }
  check("an untitled Table (shaped like the real replies) renders with its default title",
    (await reply("r-real").locator(".interactive-result").textContent()).includes("Table") && (await reply("r-real").textContent()).includes("已加入 TODO"), null);
  if (privateReal)
    check("the private real untitled-Table reply renders too", (await reply("r-private").locator(".interactive-result").count()) === 1, null);
  await reply("r-real").screenshot({ path: join(shots, "real-untitled-table.png") });
  const before = report.chunkRequests.length;

  // Large output still expands and copies in full.
  const row = page.locator('[id="item-cmd"]');
  // Tool activity of a finished turn is folded; open it as a reader would.
  await page.evaluate(() => { for (const d of document.querySelectorAll('[id="turn-t-large"] details')) d.open = true; });
  await row.getByRole("button", { name: /^Show full output/ }).click();
  await page.waitForFunction(() => document.querySelector('[id="item-cmd"] pre')?.textContent.startsWith("line 1\n"));
  await page.locator('[id="turn-t-large"] .turn-divider').getByRole("button", { name: "Copy turn" }).click();
  await page.waitForFunction(() => window.__copied.length > 0);
  const copied = await page.evaluate(() => window.__copied.at(-1));
  check("long output still expands and Copy turn copies it whole", copied.includes("line 1\n") && copied.includes("line 2400"), copied.length);
  await reply("r-large").getByRole("button", { name: "Copy reply" }).click();
  const copiedReply = await page.evaluate(() => window.__copied.at(-1));
  check("Copy reply copies the reply exactly as written", copiedReply === details.a.turns.find((t) => t.id === "t-large").items[2].text, copiedReply.slice(0, 80));

  // Streaming: placeholder, then the result once the block closes, then done.
  await select("Hana");
  check("a block still being written shows a placeholder, never partial JSON",
    (await reply("r-live").textContent()).includes("Generating interactive result…") && !(await visible()).includes('"root":"result"'), null);
  await page.screenshot({ path: join(shots, "generating-light.png") });
  details.b.turns[0].items[1].text = `Building the comparison now.\n\n${fence(valid)}\n\nStill writing…`;
  await changed("b");
  await reply("r-live").locator(".interactive-result").waitFor();
  details.b.turns[0].items[1].text = streaming;
  details.b.turns[0].status = "interrupted";
  details.b.agent.status = "idle";
  await changed("b");
  check("once the turn stops, the unclosed block is unfinished, not loading forever",
    (await reply("r-live").locator('[data-result-state="unfinished"]').count()) === 1, await reply("r-live").textContent());

  // Reload and switching keep every state; the chunk is not fetched again.
  await page.reload();
  await select("Mori");
  await reply("r-real").locator(".interactive-result").waitFor();
  check("after a reload and switching Agents the same states show",
    (await reply("r-invalid").locator('[data-result-state="format"]').count()) === 1
      && (await reply("r-cut").locator('[data-result-state="unfinished"]').count()) === 1, null);

  // Details open from the keyboard and show code, path and reason.
  const summary = reply("r-unknown").locator("summary", { hasText: "Details and result JSON" });
  await summary.focus();
  await page.keyboard.press("Enter");
  const details_ = await reply("r-unknown").locator(".result-state-details").textContent();
  check("details open from the keyboard with code, path and reason", /unknown_component/.test(details_) && /elements\.table\.type/.test(details_), details_);
  await reply("r-unknown").scrollIntoViewIfNeeded();
  for (const [name, appearance, width] of [["light", { theme: "light", fontSize: 16 }, 1440], ["dark", { theme: "dark", fontSize: 16 }, 1440],
    ["font20", { theme: "light", fontSize: 20 }, 1440], ["narrow", { theme: "light", fontSize: 16 }, 520]]) {
    await page.evaluate((a) => localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...a, palette: "garden" })), appearance);
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await select("Mori");
    await reply("r-invalid").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    const size = await reply("r-invalid").locator('[data-result-state] p').evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
    check(`${name}: the note is readable and fits`, !overflow && size >= (appearance.fontSize === 20 ? 15 : 12), { overflow, size });
    await page.screenshot({ path: join(shots, `format-${name}.png`) });
  }
  // As after an update, the chunk's URL is answered with index.html (or 404).
  // Try again fails again for real, and Reload is reachable from the keyboard.
  // Then the same chunk (same dist and hash) is served again, and the reload
  // shows the result. A second build with a new hash is not simulated. Text
  // and Copy reply never change.
  for (const mode of ["html", "404"]) {
    chunkMode = mode;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await select("Mori");
    const note = reply("r-large").locator('[data-result-state="load"]');
    await note.waitFor();
    const before = report.chunkRequests.length;
    await note.getByRole("button", { name: "Try again" }).click();
    await page.waitForTimeout(800);
    await note.waitFor();
    const retried = report.chunkRequests.slice(before);
    check(`${mode}: Try again requests the old chunk again and still fails, keeping Reload`,
      retried.length >= 1 && retried.every((r) => r.mode === mode && /^\?retry=\d+$/.test(r.query))
        && (await note.getByRole("button", { name: "Reload Yuzuno" }).count()) === 1, retried);
    check(`${mode}: the reply text stays readable`, /Output above\.[\s\S]*Done\./.test(await reply("r-large").textContent()), null);
    await reply("r-large").getByRole("button", { name: "Copy reply" }).click();
    check(`${mode}: Copy reply is still the reply as written`, (await page.evaluate(() => window.__copied.at(-1))) === details.a.turns.find((t) => t.id === "t-large").items[2].text, null);
    // Reach Reload from the keyboard: Tab from Try again.
    await note.getByRole("button", { name: "Try again" }).focus();
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    check(`${mode}: Reload Yuzuno is reachable from the keyboard`, focused === "Reload Yuzuno", focused);
    chunkMode = "ok"; // the same chunk is served again (one build only)
    await Promise.all([page.waitForEvent("load"), page.keyboard.press("Enter")]);
    await select("Mori");
    await reply("r-large").locator(".interactive-result").waitFor({ timeout: 10_000 });
    check(`${mode}: Reload loads the viewer and shows the result`, true, null);
  }
  check("nothing was written but read receipts; no message or model call", report.writes.every((w) => /\/review$/.test(w)), report.writes);
  check("no page errors", report.errors.length === 0, report.errors);
  report.chunkAfterRetry = report.chunkRequests.length - before;
} catch (error) {
  report.failures.push(String(error?.stack || error));
  console.log("ERROR", error);
  await page.screenshot({ path: join(shots, "error.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(join(here, "browser-result.json"), JSON.stringify(report, null, 2));
}
process.exitCode = report.failures.length || report.checks.some((c) => !c.ok) ? 1 : 0;
