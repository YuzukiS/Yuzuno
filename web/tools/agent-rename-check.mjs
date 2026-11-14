// YN-112: renaming an Agent in Chromium, against a disposable fixture server
// (no Core) that applies Core's name rule and announces each rename on the
// event stream as Core does (agent.changed). Desktop 1280 px and phone
// 390 px, English and Chinese:
//  - a row's right-click, the context-menu key (Shift+F10) and a phone's
//    long-press open the menu with Rename…; Enter saves one PATCH of the
//    trimmed name, Escape saves nothing and interrupts nothing;
//  - a refused name says why in place and sends nothing; Core's refusal
//    stays in the dialog;
//  - another open page (a phone) shows the new name without reloading;
//  - in Agent settings the name saves on its own while the model catalog
//    is still loading, and never posts the settings.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/agent-rename-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "YUZUNO_BROWSER_OUTPUT: where screenshots and the report go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });

const base = {
  cwd: "/fixture/project", model: "codex-fixture", color: "sage", harness: "codex", goal: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  settings: { reasoningEffort: "low", approvalPolicy: "on-request", sandbox: "workspace-write" },
};
// Mori is idle and connected; Hana is working.
const fresh = () => [
  { ...base, id: "a", name: "Mori", status: "idle", connectionState: "connected", threadId: "thread-a" },
  { ...base, id: "b", name: "Hana", status: "working", connectionState: "connected", threadId: "thread-b" },
];
let agents = fresh();
const calls = [];
const streams = new Set();
let holdModels = false;
const heldModels = [];
const report = { checks: [], screenshots: [], errors: [], console: [], requests: [] };
const check = (name) => {
  report.checks.push(name);
  console.log(`ok - ${name}`);
};
const patches = (id) => calls.filter((c) => c.method === "PATCH" && c.path === `/api/agents/${id}`);
const posts = (path) => calls.filter((c) => c.method === "POST" && c.path === path).length;
// Core's rule (model.rs agent_name) and its words.
const REFUSED = "请填写名称（最多 100 字节，不含控制字符）";
const refused = (name) => !name || /[\u0000-\u001f\u007f-\u009f]/.test(name) || Buffer.byteLength(name) > 100;
const announce = (event) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
};
const models = { models: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Codex fixture",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, ...(body !== undefined ? { body } : {}) });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    const [, , kind, id, action] = url.pathname.split("/");
    const agent = kind === "agents" ? agents.find((a) => a.id === id) : undefined;
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/workspace") return send(200, { agents, runtime: { connected: true }, defaultCwd: "/fixture/project", workspace: { id: "ws-rename" }, projects: [] });
    if (url.pathname === "/api/machines") return send(200, { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture/project" }] });
    if (url.pathname === "/api/home") return send(200, { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] });
    if (agent && !action && req.method === "PATCH") {
      const name = String(body?.name ?? "").trim();
      if (name === "Refuse me") return send(400, { error: "Fixture: Core refused this name." });
      if (refused(name)) return send(400, { error: REFUSED });
      if (name !== agent.name) {
        agent.name = name;
        announce({ type: "agent.changed", agentId: agent.id });
      }
      return send(200, agent);
    }
    if (agent && action === "models") {
      if (holdModels) {
        heldModels.push(() => send(200, models));
        return;
      }
      return send(200, models);
    }
    if (agent && action) return send(404, { error: "Not served by this fixture" });
    if (agent)
      return send(200, {
        agent, pending: [], artifacts: [],
        turns: [{ id: `${id}-turn`, status: agent.status === "working" ? "inProgress" : "completed",
          items: [{ id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "Please review the layout." }] },
            { id: `${id}-reply`, type: "agentMessage", text: `Saved reply from ${agent.name}` }] }],
      });
    return send(200, {});
  }
  const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  const file = path.startsWith(dist + sep) ? await readFile(path).catch(() => null) : null;
  const served = file ?? (await readFile(resolve(dist, "index.html")));
  res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[file ? extname(path) : ".html"] || "application/octet-stream" });
  res.end(served);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  assert.equal(await page.locator("#app-recovery-title").count(), 0, `${name}: the app fell to its error screen: ${JSON.stringify(report.console)}`);
}
function watch(page) {
  page.on("pageerror", (error) => report.errors.push(String(error)));
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
}
async function open(language, viewport, mobile = false) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: language === "zh" ? "zh-CN" : "en-US",
    ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  const page = await context.newPage();
  watch(page);
  await page.goto(origin);
  await row(page, "a").waitFor();
  return { context, page };
}
const W = {
  en: { rename: "Rename…", settings: "Agent settings…", title: "Rename agent", save: "Save", saveName: "Rename", cancel: "Cancel",
    empty: "A name can’t be empty.", control: "A name can’t contain control characters, such as a tab.", over: /bytes too long/,
    renamed: (name) => `Renamed to “${name}”.` },
  zh: { rename: "重命名…", settings: "Agent 设置…", title: "重命名 Agent", save: "保存", saveName: "重命名", cancel: "取消",
    empty: "名称不能为空。", control: "名称不能包含控制字符（例如制表符）。", over: /超出 \d+ 字节/,
    renamed: (name) => `已重命名为「${name}」。` },
};
const menu = (page) => page.locator('[role="menu"]');
const row = (page, id) => page.locator(`.agent-row[data-agent-id="${id}"]`);
const rowName = (page, id) => row(page, id).locator(".agent-name");
const dialog = (page) => page.locator('[role="dialog"]');
const nameInput = (page) => dialog(page).locator(".rename-agent-form input, .agent-name-setting input").first();
const visible = (page, text) => page.getByText(text, { exact: true }).first().waitFor({ timeout: 3000 });
const waitFor = async (what, test, ms = 3000) => {
  const until = Date.now() + ms;
  while (!(await test())) {
    assert.ok(Date.now() < until, `timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
};
const inside = async (page, locator, width) => {
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `fits ${width} px: ${JSON.stringify(box)}`);
};

let failed = null;
try {
  // Desktop in English, with a phone in Chinese open beside it.
  {
    const desk = await open("en", { width: 1280, height: 820 });
    const phone = await open("zh", { width: 390, height: 844 }, true);
    const t = W.en;
    const page = desk.page;
    await row(page, "a").click({ button: "right", position: { x: 60, y: 18 } });
    await menu(page).waitFor();
    const items = await menu(page).locator('[role="menuitem"]').allTextContents();
    assert.deepEqual(items.slice(items.indexOf(t.rename), items.indexOf(t.rename) + 2), [t.rename, t.settings], JSON.stringify(items));
    await shot(page, "desktop-en-menu");
    await menu(page).getByRole("menuitem", { name: t.rename }).click();
    await dialog(page).waitFor();
    assert.match(await dialog(page).textContent(), new RegExp(t.title));
    const selected = await nameInput(page).evaluate((el) => [el.value, el.selectionStart, el.selectionEnd, document.activeElement === el]);
    assert.deepEqual(selected, ["Mori", 0, 4, true], "the name is focused and selected");
    await shot(page, "desktop-en-dialog");
    check("desktop en: a right-click on Mori's row offers Rename… just before Agent settings…; its dialog opens with the name focused and selected");

    await nameInput(page).fill("  Mori · front  ");
    await page.keyboard.press("Enter");
    await dialog(page).waitFor({ state: "detached" });
    assert.deepEqual(patches("a").map((c) => c.body), [{ name: "Mori · front" }]);
    await visible(page, t.renamed("Mori · front"));
    await waitFor("the row shows the new name", async () => (await rowName(page, "a").textContent()) === "Mori · front");
    assert.ok(await row(page, "a").evaluate((el) => el.contains(document.activeElement)), "focus is back on Mori's row");
    await shot(page, "desktop-en-renamed");
    check("Enter sent one PATCH of the trimmed name; the dialog closed, said so, and the row shows the new name with focus back on it");
    await waitFor("the phone shows the new name", async () => (await rowName(phone.page, "a").textContent()) === "Mori · front");
    await shot(phone.page, "phone-zh-after-desktop-rename");
    check("the phone page, open meanwhile, shows the new name from Core's agent.changed without reloading");

    // The keyboard's way: Shift+F10 on Hana's row, the arrow keys, Enter;
    // Escape leaves her as she was, and interrupts nothing.
    await row(page, "b").locator(".agent-select").focus();
    await page.keyboard.press("Shift+F10");
    await menu(page).waitFor();
    for (let i = 0; i < 8 && (await page.evaluate(() => document.activeElement?.textContent)) !== t.rename; i++) await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), t.rename);
    await page.keyboard.press("Enter");
    await dialog(page).waitFor();
    assert.equal(await nameInput(page).inputValue(), "Hana");
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.deepEqual(patches("b"), []);
    assert.equal(posts("/api/agents/b/interrupt"), 0, "Escape interrupts nothing");
    assert.ok(await row(page, "b").evaluate((el) => el.contains(document.activeElement)), "focus is back on Hana's row");
    check("the keyboard: Shift+F10, the arrow keys and Enter open Rename… for Hana; Escape saves nothing, interrupts nothing and gives focus back to her row");

    // Refused names: the reason in place, nothing sent; Core's refusal stays.
    await row(page, "a").click({ button: "right", position: { x: 60, y: 18 } });
    await menu(page).getByRole("menuitem", { name: t.rename }).click();
    await dialog(page).waitFor();
    const save = dialog(page).getByRole("button", { name: t.save, exact: true });
    for (const [value, says] of [["   ", t.empty], ["Mori\tfront", t.control], [`${"汉".repeat(34)}`, t.over]]) {
      await nameInput(page).fill(value);
      assert.ok(await save.isDisabled(), JSON.stringify(value));
      await (typeof says === "string" ? dialog(page).getByText(says, { exact: true }) : dialog(page).getByText(says)).waitFor({ timeout: 2000 });
      await page.keyboard.press("Enter");
    }
    await shot(page, "desktop-en-too-long");
    assert.equal(patches("a").length, 1, "nothing refused was sent");
    await nameInput(page).fill("Refuse me");
    await save.click();
    await dialog(page).getByRole("alert").filter({ hasText: "Fixture: Core refused this name." }).waitFor();
    assert.equal(await dialog(page).count(), 1, "the dialog stays open");
    await shot(page, "desktop-en-core-refused");
    await dialog(page).getByRole("button", { name: t.cancel, exact: true }).click();
    await dialog(page).waitFor({ state: "detached" });
    assert.equal(await rowName(page, "a").textContent(), "Mori · front");
    check("refused names (blank, a tab, 102 bytes) say why under the field and send nothing; Core's refusal shows in the dialog, which stays open; Cancel keeps the name");

    // Agent settings: the name saves while the model catalog still loads.
    holdModels = true;
    await row(page, "a").click({ button: "right", position: { x: 60, y: 18 } });
    await menu(page).getByRole("menuitem", { name: t.settings }).click();
    await dialog(page).waitFor();
    await waitFor("the catalog is asked for", async () => heldModels.length > 0);
    assert.equal(await nameInput(page).inputValue(), "Mori · front");
    await nameInput(page).fill("Mori · settings");
    await page.keyboard.press("Enter");
    await waitFor("the name was saved", async () => patches("a").length === 3);
    assert.deepEqual(patches("a").at(-1).body, { name: "Mori · settings" });
    assert.equal(posts("/api/agents/a/settings"), 0, "the settings were not posted");
    assert.equal(await dialog(page).count(), 1, "the settings stay open");
    await waitFor("the row shows the new name", async () => (await rowName(page, "a").textContent()) === "Mori · settings");
    await shot(page, "desktop-en-settings-name");
    holdModels = false;
    heldModels.splice(0).forEach((answer) => answer());
    await page.keyboard.press("Escape");
    check("Agent settings: the name saved on Enter while the model catalog was still loading; nothing else was posted and the dialog stayed open");
    await desk.context.close();
    await phone.context.close();
  }

  // Chinese on the desktop, and both languages on a phone.
  agents = fresh();
  for (const [language, width, height, mobile] of [["zh", 1280, 820, false], ["zh", 390, 844, true], ["en", 390, 844, true]]) {
    const t = W[language];
    const tag = `${mobile ? "phone" : "desktop"}-${language}`;
    const { context, page } = await open(language, { width, height }, mobile);
    const openMenu = async (id) => {
      if (mobile) {
        const box = await row(page, id).boundingBox();
        await row(page, id).dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 3, clientX: box.x + 60, clientY: box.y + 18, bubbles: true });
        await page.waitForTimeout(700);
        await menu(page).waitFor();
        await row(page, id).dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, pointerId: 3, clientX: box.x + 60, clientY: box.y + 18, bubbles: true });
      } else {
        await row(page, id).click({ button: "right", position: { x: 60, y: 18 } });
        await menu(page).waitFor();
      }
    };
    await openMenu("b");
    await menu(page).getByRole("menuitem", { name: t.rename }).click();
    await dialog(page).waitFor();
    assert.match(await dialog(page).textContent(), new RegExp(t.title));
    await inside(page, dialog(page), width);
    await nameInput(page).fill("");
    await dialog(page).getByText(t.empty, { exact: true }).waitFor();
    await shot(page, `${tag}-dialog-empty`);
    const next = language === "zh" ? `花 · ${width}` : `Hana · ${width}`;
    await nameInput(page).fill(next);
    await dialog(page).getByRole("button", { name: t.save, exact: true }).click();
    await dialog(page).waitFor({ state: "detached" });
    await visible(page, t.renamed(next));
    await waitFor("the row shows the new name", async () => (await rowName(page, "b").textContent()) === next);
    await shot(page, `${tag}-renamed`);
    check(`${tag}: ${mobile ? "a long-press" : "a right-click"} opens ${t.rename}; the dialog fits ${width} px, says why a blank name can't be saved, and Save renames Hana`);

    await openMenu("a");
    await menu(page).getByRole("menuitem", { name: t.settings }).click();
    await dialog(page).waitFor();
    const field = dialog(page).locator(".agent-name-setting");
    await field.waitFor();
    await inside(page, field, width);
    const [input, button] = [field.locator("input"), field.getByRole("button", { name: t.saveName, exact: true })];
    assert.ok(await button.isDisabled(), "an unchanged name has nothing to save");
    const name = language === "zh" ? `森 · ${width}` : `Mori · ${width}`;
    await input.fill(name);
    if (mobile) {
      // Narrow: the field has its line, the button sits under it.
      const [a, b] = [await input.boundingBox(), await button.boundingBox()];
      assert.ok(b.y >= a.y + a.height - 1, `the button is under the field: ${JSON.stringify([a, b])}`);
    }
    await shot(page, `${tag}-settings-name`);
    await button.click();
    // The dialog's title names the Agent as the page now lists it.
    await waitFor("the settings title shows the new name", async () =>
      (await dialog(page).locator("h2").textContent()).startsWith(`${name} · `), 4000);
    assert.deepEqual(patches("a").at(-1).body, { name });
    assert.equal(posts("/api/agents/a/settings"), 0);
    await page.keyboard.press("Escape");
    check(`${tag}: Agent settings has the name first, with its own ${t.saveName}${mobile ? " under the field" : ""}; it renames Mori and posts no settings`);
    await context.close();
  }
  assert.deepEqual(report.errors, [], "no page errors");
} catch (error) {
  failed = error;
  console.error(error);
} finally {
  report.requests = calls;
  report.passed = !failed;
  if (failed) report.failure = String(failed?.stack ?? failed);
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  server.close();
  for (const stream of streams) stream.destroy();
}
process.exit(failed ? 1 : 0);
