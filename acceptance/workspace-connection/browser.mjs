import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const base = "http://127.0.0.1:4391";
const output = "acceptance/workspace-connection/browser";
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], requests: [] };
const browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", e => report.errors.push(e.message));
page.on("request", r => report.requests.push({ url: r.url(), method: r.method() }));
await page.addInitScript(() => {
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }));
});
async function status(label) {
  await page.waitForFunction(label => [...document.querySelectorAll("[data-core-status]")].length === 2 && [...document.querySelectorAll("[data-core-status]")].every(e => e.dataset.coreStatus === label), label);
  assert.ok((await page.locator(".workspace-scope [role=img]").getAttribute("aria-label")).startsWith(`${label}.`));
}
async function scenario(value) { await page.getByLabel("Simulated condition").selectOption(value); }
async function preserved() {
  assert.equal(await page.locator("textarea").inputValue(), "我在断线前写的草稿 · keep me");
  assert.match(await page.locator(".statusbar").innerText(), /1 pending/);
  assert.match(await page.locator(".conversation-scroll").innerText(), /fixture reply/);
  assert.equal(await page.evaluate(() => connectionFixture.calls.filter(c => c.method !== "GET").length), 0);
}
try {
  await page.goto(base);
  await status("Core connected");
  await page.locator("textarea").fill("我在断线前写的草稿 · keep me");
  const draft = await page.evaluate(() => localStorage.getItem("yuzuno.drafts"));
  await scenario("catalog");
  await page.getByText("Simulated Codex catalog failure", { exact: true }).waitFor();
  await status("Core connected"); await preserved();
  await page.locator("button").filter({ hasText: "Claude fixture" }).first().click();
  await page.locator(".prose").filter({ hasText: "Claude fixture" }).waitFor();
  await status("Core connected");
  await page.locator("button").filter({ hasText: "Codex fixture" }).first().click();
  await page.locator(".prose").filter({ hasText: "Codex fixture" }).waitFor();
  await preserved();
  report.checks.push("Codex catalog failure does not disconnect Core or Claude; all three Core indicators agree");

  await scenario("sse");
  await page.locator(".event-connection-banner").waitFor();
  await status("Core connected"); await preserved();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.locator(".prose").first().evaluate(el => getComputedStyle(el).fontSize), "20px");
    await page.screenshot({ path: `${output}/${theme}-20px-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const banner = page.locator(".event-connection-banner");
    assert.ok(await banner.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: `${output}/${theme}-20px-narrow.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  report.checks.push("separate SSE reconnect banner; light/dark 20px and 390px layout without horizontal overflow");
  await scenario("http500");
  await status("Core update failed"); await preserved();
  assert.match(await page.locator(".core-connection-banner").innerText(), /HTTP 500/);
  assert.match(await page.locator(".core-connection-banner").innerText(), /Live updates connected/);
  await page.evaluate(() => { connectionFixture.mode = "invalid-json"; connectionFixture.emit("error"); connectionFixture.refresh(); });
  await page.waitForFunction(() => document.querySelector(".core-connection-banner")?.textContent.includes("Could not refresh"));
  await status("Core update failed"); await preserved();
  await scenario("offline");
  await status("Core unreachable"); await preserved();
  await scenario("ok");
  await status("Core connected"); await preserved();
  assert.equal(await page.locator(".core-connection-banner").count(), 0);
  report.checks.push("HTTP 500 and malformed JSON are update failures; full outage recovers while preserving cached conversation, Pending and draft");

  await page.evaluate(() => { connectionFixture.marker = "old fixture reply"; });
  await scenario("hang");
  await status("Core request timed out");
  await preserved();
  assert.ok(await page.evaluate(() => connectionFixture.held.some(h => h.signal.aborted)));
  await page.evaluate(() => { connectionFixture.marker = "fresh fixture reply"; });
  await scenario("ok");
  await status("Core connected");
  await page.locator(".prose").filter({ hasText: "fresh fixture reply" }).waitFor();
  await page.getByRole("button", { name: "释放旧响应" }).click();
  await page.waitForTimeout(200);
  await status("Core connected");
  assert.match(await page.locator(".prose").first().innerText(), /fresh fixture reply/);
  await preserved();
  assert.equal(await page.evaluate(() => localStorage.getItem("yuzuno.drafts")), draft);
  report.checks.push("real 10-second snapshot deadline releases stalled reads; recovery ignores late stale bodies and keeps draft");
  await page.waitForTimeout(6000); // A whole polling interval with zero business SSE messages.
  await status("Core connected");
  assert.equal(await page.locator(".event-connection-banner").count(), 0);
  report.checks.push("quiet open event stream remains healthy across HTTP polling");
  assert.ok(await page.evaluate(() => connectionFixture.calls.every(c => c.method === "GET" && !/models|machines|reconnect|interrupt/.test(c.path))));
  await page.locator(".workspace-scope").click();
  await page.getByRole("menuitem", { name: "Machines" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("Not checked yet", { exact: true }).waitFor();
  await status("Core connected");
  assert.ok(await page.evaluate(() => connectionFixture.calls.some(c => c.path === "/api/machines")));
  assert.ok(await page.evaluate(() => connectionFixture.calls.every(c => c.method === "GET" && !/models|\/check|reconnect|interrupt/.test(c.path))));
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await preserved();
  report.checks.push("integrated T-5 Workspace → Machines entry works; opening it only reads the machine list and performs no checks or Harness probes");
  assert.ok(report.requests.every(r => new URL(r.url).origin === base && !new URL(r.url).pathname.startsWith("/api/") && r.method === "GET"));
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, requests: report.requests.length }, null, 2));
}
