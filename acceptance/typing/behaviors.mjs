// T-18: the composer still behaves with the fix, against the lab Core while
// the three Agents stream: Chinese IME composition, select-all delete, a
// draft per Agent kept across switching and a reload, and sending.
//   node acceptance/typing/behaviors.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const state = JSON.parse(await readFile(path.join(root, "target/t18/lab/lab.json"), "utf8"));
const api = (method, p, body) => fetch(`${state.base}/api${p}`, {
  method, headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const checks = [];
const check = (name, fn) => fn().then(() => checks.push(name));

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  for (const id of Object.values(state.agents)) {
    // A lab Core restarted between runs leaves its Agents offline; reconnect
    // first so sending below goes to a live connection.
    await api("POST", `/agents/${id}/reconnect`);
    for (let i = 0; i < 50; i++) {
      if ((await api("GET", `/agents/${id}`)).agent.connectionState === "connected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const d = await api("GET", `/agents/${id}`);
    if (!d.turns.some((t) => t.status === "inProgress"))
      await api("POST", `/agents/${id}/messages`, { clientMessageId: `behaviors-${id}-${Date.now()}`, text: "stream:40:20" });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("t18-started")) {
      sessionStorage.setItem("t18-started", "1");
      localStorage.setItem("yuzuno.selected", JSON.stringify(id));
      localStorage.removeItem("yuzuno.drafts");
    }
  }, state.agents.Long);
  await page.goto(`${state.base}/?shell=desktop`);
  const composer = (name) => page.getByRole("textbox", { name: `Message ${name}` });
  await composer("Long").waitFor();
  const cdp = await page.context().newCDPSession(page);

  await check("Chinese IME composition commits into the draft", async () => {
    await composer("Long").click();
    await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.imeSetComposition", { text: "你", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "你好" });
    assert.equal(await composer("Long").inputValue(), "你好");
  });
  await check("select-all and one Backspace clear the draft", async () => {
    await composer("Long").fill("A whole draft to remove at once.");
    await composer("Long").press("Control+A");
    await composer("Long").press("Backspace");
    assert.equal(await composer("Long").inputValue(), "");
  });
  await check("each Agent keeps its own draft across switching and a reload", async () => {
    await composer("Long").fill("Draft for Long");
    await page.locator(".agent-row, [data-agent-id]").filter({ hasText: "Busy one" }).first().click();
    await composer("Busy one").waitFor();
    await composer("Busy one").fill("Draft for Busy one");
    await page.locator(".agent-row, [data-agent-id]").filter({ hasText: "Long" }).first().click();
    assert.equal(await composer("Long").inputValue(), "Draft for Long");
    await page.reload();
    await composer("Long").waitFor();
    assert.equal(await composer("Long").inputValue(), "Draft for Long");
    await page.locator(".agent-row, [data-agent-id]").filter({ hasText: "Busy one" }).first().click();
    assert.equal(await composer("Busy one").inputValue(), "Draft for Busy one");
  });
  await check("Enter sends and clears only that draft", async () => {
    // A fresh Agent, so an unconfirmed message left by an earlier run (which
    // the app rightly refuses to send twice) cannot interfere.
    const name = `Send check ${Date.now()}`;
    const fresh = await api("POST", "/agents", { name, cwd: path.join(root, "target/t18/lab/task"), harness: "codex", model: "" });
    for (let i = 0; i < 50; i++) {
      if ((await api("GET", `/agents/${fresh.id}`)).agent.connectionState === "connected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.evaluate((id) => localStorage.setItem("yuzuno.selected", JSON.stringify(id)), fresh.id);
    await page.reload();
    await composer(name).waitFor();
    const text = `Sent from the T-18 check ${Date.now()}`;
    await composer(name).fill(text);
    await composer(name).press("Enter");
    await page.getByText(text, { exact: true }).first().waitFor();
    for (let i = 0; i < 50 && (await composer(name).inputValue()); i++) await page.waitForTimeout(100);
    assert.equal(await composer(name).inputValue(), "");
    await page.locator(".agent-row, [data-agent-id]").filter({ hasText: "Long" }).first().click();
    assert.equal(await composer("Long").inputValue(), "Draft for Long");
  });
  console.log(`passed: ${checks.length} checks\n- ${checks.join("\n- ")}`);
} catch (error) {
  console.log(`failed after ${checks.length} checks (${checks.join("; ")}): ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
