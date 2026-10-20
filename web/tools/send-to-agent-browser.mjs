// Send to Agent (T-152) in Chromium: the production build under `vite preview`
// with the connection fixture for every API call, so nothing reaches a Core and
// any write would throw. Real mouse drags; screenshots and report.json go to
// target/t152/browser/ (not committed). Needs `npm run build` first.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright-core";
import { installConnectionFixture } from "./connection-fixture.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = new URL("../../target/t152/browser/", import.meta.url);
await mkdir(output, { recursive: true });
const port = Number(process.env.T152_PORT || 4486);
const report = { checks: [], errors: [] };
const check = (name, ok, details) => {
  report.checks.push({ name, ok: !!ok, details });
  assert.ok(ok, `${name}: ${JSON.stringify(details)}`);
};
const server = await preview({ root: web, logLevel: "warn", preview: { host: "127.0.0.1", port, strictPort: true } });
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/api/**", (route) => route.abort());
  await context.addInitScript(installConnectionFixture);
  // The other Agent already has a draft, which must be kept.
  await context.addInitScript(() => {
    if (!localStorage.getItem("yuzuno.composer.v1:b"))
      localStorage.setItem("yuzuno.composer.v1:b", JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "Existing note for b." }] }));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const row = (id) => page.locator(`article.agent-row[data-agent-id="${id}"]`);
  const reply = page.locator(".final-message", { hasText: "Codex fixture: initial fixture reply" });
  await reply.waitFor();
  const send = reply.locator(".send-to-agent-button");
  const drafts = () => page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.composer.v1:b") || '{"parts":[]}').parts.map((p) => p.text).join(""));

  // The menu, from the keyboard.
  await send.click();
  const items = page.locator('[role="menu"] [role="menuitem"]');
  check("the menu offers only the other Agent", (await items.allTextContents()).join("|").includes("Claude fixture") && (await items.count()) === 1, await items.allTextContents());
  check("the first Agent has focus", await items.first().evaluate((el) => el === document.activeElement));
  await page.screenshot({ path: fileURLToPath(new URL("menu.png", output)) });
  await page.keyboard.press("Escape");
  check("Escape closes the menu, adds nothing and returns focus", (await page.locator('[role="menu"]').count()) === 0 && (await send.evaluate((el) => el === document.activeElement)) && (await drafts()) === "Existing note for b.");

  // A drop this window did not start (same type, built in the page) is not taken.
  const forged = await row("b").evaluate((target) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-yuzuno-handoff", JSON.stringify({ kind: "task", taskId: "T-9", title: "forged", status: "todo", assignee: null, version: 1, summary: "" }));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(over);
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented];
  });
  await page.waitForTimeout(100);
  check("a forged drop is neither offered a target nor taken", forged.every((taken) => !taken) && (await drafts()) === "Existing note for b.", forged);

  // A real mouse drag of the button: its own Agent refuses, the other lights up and takes it.
  const centre = async (locator) => {
    const box = await locator.boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  // What is under the pointer and how both rows look, for a failed check.
  const scene = (point) => page.evaluate(([x, y]) => ({
    under: document.elementFromPoint(x, y)?.closest("article.agent-row")?.dataset.agentId ?? null,
    a: document.querySelector('article.agent-row[data-agent-id="a"]').className,
    b: document.querySelector('article.agent-row[data-agent-id="b"]').className,
  }), point);
  // Let go away from any Agent: nothing is added and nothing stays lit.
  await page.mouse.move(...(await centre(send)));
  await page.mouse.down();
  await page.mouse.move(...(await centre(row("b"))), { steps: 8 });
  await page.waitForTimeout(100);
  const litBeforeCancel = (await row("b").getAttribute("class")).includes("handoff-accept");
  await page.mouse.move(...(await centre(reply)), { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check("a drag let go away from the Agents changes nothing", litBeforeCancel && !(await row("b").getAttribute("class")).includes("handoff") && (await drafts()) === "Existing note for b.");

  await page.mouse.move(...(await centre(send)));
  await page.mouse.down();
  await page.mouse.move(...(await centre(row("a"))), { steps: 8 });
  await page.waitForTimeout(100);
  check("its own Agent refuses the drop and says why", (await row("a").getAttribute("class")).includes("handoff-refuse") && (await row("a").locator(".handoff-hint").textContent()).includes("already comes from"));
  const target = await centre(row("b"));
  await page.mouse.move(...target, { steps: 8 });
  await page.waitForTimeout(100);
  check("the other Agent lights up as a target", (await row("b").getAttribute("class")).includes("handoff-accept"), await scene(target));
  await page.screenshot({ path: fileURLToPath(new URL("drop-target.png", output)) });
  await page.mouse.up();
  const composer = page.locator('[data-composer-input][aria-label="Message Claude fixture"]');
  await composer.waitFor();
  await page.waitForFunction(() => (localStorage.getItem("yuzuno.composer.v1:b") || "").includes("Forwarded from"));
  check("the opened draft shows the existing note and the handoff", (await composer.textContent()).includes("Existing note for b.") && (await composer.textContent()).includes("initial fixture reply"));
  const first = await drafts();
  check("the drop added the reply after that Agent's existing draft and opened it", first.startsWith("Existing note for b.\n\nForwarded from Codex fixture’s conversation: Codex fixture’s reply") && first.endsWith("> Codex fixture: initial fixture reply"), first);
  check("no highlight is left behind", !(await row("b").getAttribute("class")).includes("handoff"));
  await page.screenshot({ path: fileURLToPath(new URL("draft.png", output)) });

  // Selected text dragged out of the reply: the excerpt goes after what is there.
  await row("a").locator(".agent-select").click();
  await reply.waitFor();
  await reply.locator(".prose").evaluate((prose) => {
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes("initial fixture")) node = walker.nextNode();
    const start = node.textContent.indexOf("initial fixture");
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + "initial fixture".length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const selected = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.move(...selected);
  await page.mouse.down();
  await page.mouse.move(...(await centre(row("b"))), { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForFunction((before) => {
    const parts = JSON.parse(localStorage.getItem("yuzuno.composer.v1:b") || '{"parts":[]}').parts;
    return parts.map((p) => p.text).join("").length > before;
  }, first.length);
  const second = await drafts();
  check("selected text lands as an excerpt after the earlier draft", second.startsWith(first + "\n\n") && second.includes(": an excerpt of Codex fixture’s reply") && second.endsWith("> initial fixture"), second.slice(first.length));

  const writes = await page.evaluate(() => window.connectionFixture.calls.filter((c) => c.method !== "GET").map((c) => c.path));
  check("nothing was sent or written to Core", writes.length === 0, writes);
  check("no page errors", report.errors.length === 0, report.errors);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
console.log(JSON.stringify(report.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`), null, 1));
