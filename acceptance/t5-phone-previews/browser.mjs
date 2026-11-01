// T-5: previews on the phone, in Chromium, against the lab Core lab.py
// started and its stand-in Serve (serve_proxy.py). Two windows: the
// computer, on Core's own port, and the "phone", through the stand-in
// Serve at https://<node>:<phone port>, with the node's name mapped to
// 127.0.0.1 and the stand-in's certificate ignored.
//   node browser.mjs <lab.json> <out dir>
// Not covered: a real Serve or tailnet, Safari, an iPhone.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const lab = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = process.argv[3];
await mkdir(out, { recursive: true });
const report = { task: "T-5", checks: [], observations: [], screenshots: [], failed: null, passed: false };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const PHONE = `https://${lab.dns}:${lab.phoneServePort}`;
const PREVIEWS = `https://${lab.dns}:${lab.previewServePort}`;
const serve = async () => JSON.parse(await readFile(lab.state, "utf8")).serve;
/** A GET through the stand-in Serve as a browser on the phone would send it: status and body. */
const through = (url, headers = {}) => new Promise((resolve, reject) => {
  const { hostname, port, pathname, search } = new URL(url);
  const req = request({ host: "127.0.0.1", port, path: pathname + search, servername: hostname, rejectUnauthorized: false,
    headers: { Host: `${hostname}:${port}`, ...headers } }, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => resolve([res.statusCode, body]));
  });
  req.on("error", reject);
  req.end();
});
const shot = async (page, name) => {
  await page.screenshot({ path: join(out, name) });
  report.screenshots.push(name);
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  args: [`--host-resolver-rules=MAP ${lab.dns} 127.0.0.1`],
});
const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
const phone = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce", ignoreHTTPSErrors: true });

async function phoneSettings(page) {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 15_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("phone");
  await page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "Phone & remote access" }) }).first()
    .locator("button").click({ timeout: 10_000 });
  const box = page.locator("#settings-editor-remote .remote-access-previews");
  await box.waitFor({ timeout: 15_000 });
  return box;
}
async function closeSettings(page) {
  await page.getByRole("dialog").getByRole("button", { name: /^Close (dialog|settings)$/ }).first().click();
}
/** Home's prototype card, and its attachment's main open button. */
async function openPrototype(page) {
  await page.locator('.toolbar-nav button[title^="Home"]').click({ timeout: 15_000 });
  const card = page.locator(`[id="home-section-${lab.projectId}-${lab.section}"]`);
  await card.waitFor({ timeout: 15_000 });
  // The split's main button; its ▾ beside it shares the class.
  await card.locator(".brief-attachment .open-choice-split .primary-button").first().click();
}
const lines = (box) => box.locator('ul[aria-label="Phone previews status"] li').evaluateAll((items) => items.map((li) => [li.dataset.tone, li.textContent]));

try {
  // ---- On the computer: Settings turns previews on, on the second Serve port.
  const page = await desk.newPage();
  await page.goto(lab.page);
  let box = await phoneSettings(page);
  assert.match(await box.textContent(), /Previews on the phone/);
  assert.deepEqual((await lines(box)).map(([, text]) => text)[0], "Saved settingsNothing saved", "off until turned on");
  await box.locator("summary", { hasText: "Previews' ports" }).click();
  await box.getByLabel("Previews' Serve port").fill(String(lab.previewServePort));
  await box.getByLabel("Core's previews port").fill(String(lab.previewLocalPort));
  await box.getByRole("button", { name: "Turn on previews" }).click();
  await box.getByText("Previews are on.").waitFor({ timeout: 60_000 });
  const on = await lines(box);
  assert.deepEqual(on.map(([tone]) => tone), ["on", "on", "on", "on"], JSON.stringify(on));
  assert.match(await box.textContent(), new RegExp(`Previews open at ${PREVIEWS.replace(/\./g, "\\.")}`));
  let entries = await serve();
  assert.deepEqual(entries.Web[`${lab.dns}:${lab.previewServePort}`], { Handlers: { "/": { Proxy: `http://127.0.0.1:${lab.previewLocalPort}` } } });
  assert.ok(entries.Web[`${lab.dns}:${lab.phoneServePort}`] && entries.Web[`${lab.dns}:443`], "the phone entry and someone else's entry are kept");
  await shot(page, "1-settings-previews-on.png");
  check("Settings turned previews on: their Serve entry beside the phone entry, verified through the stand-in Serve", { lines: on });
  await closeSettings(page);

  // ---- On the phone: the prototype from Home, through the previews' own entry.
  const mobile = await phone.newPage();
  const minted = [];
  mobile.on("response", async (response) => {
    if (response.url().endsWith("/api/previews") && response.request().method() === "POST") minted.push(await response.json().catch(() => null));
  });
  await mobile.goto(`${PHONE}/`);
  await openPrototype(mobile);
  const frameEl = mobile.locator(".portal-panel iframe.portal-frame");
  await frameEl.waitFor({ timeout: 20_000 });
  const src = await frameEl.getAttribute("src");
  assert.ok(src.startsWith(`${PREVIEWS}/v/`), src);
  assert.equal(await frameEl.getAttribute("sandbox"), "allow-scripts");
  const frame = await (await frameEl.elementHandle()).contentFrame();
  await frame.locator("#try").click();
  await frame.waitForFunction(() => document.querySelector("#try").textContent === "clicked");
  await frame.waitForFunction(() => window.done === true, null, { timeout: 20_000 });
  const probes = JSON.parse(await frame.locator("#probes").textContent());
  report.observations.push({ framedProbes: probes });
  assert.equal(probes.origin, "null", "an opaque origin");
  for (const name of ["localStorage", "cookie", "parent", "top", "fetchCore", "fetchHere", "websocket", "image", "popup"]) {
    assert.match(probes[name], /^blocked: /, `${name}: ${probes[name]}`);
  }
  await shot(mobile, "2-phone-preview-framed.png");
  check("on the phone the prototype runs, framed from the previews' own entry; it reaches neither Core nor this page", { src: src.replace(/\/v\/.*/, "/v/…"), probes });

  // Its proof was answered once, to the phone page only.
  const proof = minted.find(Boolean)?.proof;
  assert.ok(proof?.url.startsWith(`${PREVIEWS}/.well-known/yuzuno-preview/`), JSON.stringify(minted));
  // Asked again as the phone page would ask: the answer is gone (a page's fetch can't read that 404, which has no CORS header).
  const [again] = await through(proof.url, { Origin: PHONE });
  assert.equal(again, 404, "a proof is answered once");
  check("the snapshot's proof was answered once, to the phone page's origin");

  // A page that is not the phone's cannot frame it.
  const foreign = await phone.newPage();
  const refusals = [];
  foreign.on("console", (message) => refusals.push(message.text()));
  await foreign.goto(lab.page);
  await foreign.evaluate((url) => {
    const element = document.createElement("iframe");
    element.id = "foreign";
    element.src = url;
    document.body.append(element);
  }, src);
  await foreign.waitForTimeout(2000);
  const framed = await (await foreign.$("#foreign")).contentFrame();
  const foreignText = framed ? await framed.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
  assert.ok(!foreignText.includes("Try"), "the prototype is not shown inside another page");
  report.observations.push({ foreignFrameUrl: framed?.url(), console: refusals.filter((t) => /frame-ancestors|Refused/.test(t)) });
  await foreign.close();
  check("another page (Core's own origin) cannot frame the phone's snapshot", { frameUrl: framed?.url() });

  // Opened in the browser too; closing the Portal leaves that page open (no revoke on close).
  const [outside] = await Promise.all([phone.waitForEvent("page"), mobile.locator(".portal-panel").getByRole("button", { name: "Open in browser" }).first().click()]);
  await outside.waitForLoadState();
  assert.equal(outside.url(), src);
  await outside.locator("#try").click();
  await mobile.getByRole("button", { name: "Close preview" }).first().click();
  await mobile.locator(".portal-panel").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await mobile.locator("iframe.portal-frame").count(), 0, "the inline preview is unmounted");
  const reloaded = await outside.reload();
  assert.equal(reloaded.status(), 200);
  await outside.locator("#try").click();
  assert.equal(await outside.locator("#try").textContent(), "clicked");
  await shot(outside, "3-phone-preview-outside.png");
  check("a preview opened outside keeps working after the inline one closes, which unmounts its frame");

  // ---- Phone access's own page through the phone entry: previews shown, never changed there.
  box = await phoneSettings(mobile);
  assert.match(await box.textContent(), new RegExp(`Previews open at ${PREVIEWS.replace(/\./g, "\\.")}`));
  assert.equal(await box.getByRole("button", { name: /Turn (on|off) previews/ }).count(), 0);
  check("through the phone entry, previews' settings only show");
  await closeSettings(mobile);

  // ---- The computer's own preview is as it was: port P, a loopback address.
  await openPrototype(page);
  const localFrame = page.locator(".portal-panel iframe.portal-frame");
  await localFrame.waitFor({ timeout: 20_000 });
  const localSrc = await localFrame.getAttribute("src");
  assert.match(localSrc, /^http:\/\/127\.0\.0\.1:\d+\/v\//);
  const local = await (await localFrame.elementHandle()).contentFrame();
  await local.locator("#try").click();
  await local.waitForFunction(() => document.querySelector("#try").textContent === "clicked");
  check("on the computer the preview still opens from Core's preview port", { src: localSrc.replace(/\/v\/.*/, "/v/…") });
  await page.getByRole("button", { name: "Close preview" }).first().click();

  // ---- Off from Settings: the phone is told where to turn them on; its entry is gone.
  box = await phoneSettings(page);
  await box.getByRole("button", { name: "Turn off previews" }).click();
  await box.getByText("Previews are off.").waitFor({ timeout: 60_000 });
  entries = await serve();
  assert.equal(entries.Web[`${lab.dns}:${lab.previewServePort}`], undefined, "their Serve entry removed");
  assert.ok(entries.Web[`${lab.dns}:${lab.phoneServePort}`], "the phone entry kept");
  await shot(page, "4-settings-previews-off.png");
  await closeSettings(page);
  await openPrototype(mobile);
  const off = mobile.locator(".portal-panel [role=alert]").first();
  await off.waitFor({ timeout: 20_000 });
  assert.match(await off.textContent(), /open through the phone entry once Previews on the phone is turned on/);
  assert.equal(await mobile.locator("iframe.portal-frame").count(), 0);
  await shot(mobile, "5-phone-previews-off.png");
  const gone = await outside.reload({ timeout: 10_000 }).then((r) => r?.status() ?? "none", (e) => e.message.split("\n")[0]);
  report.observations.push({ outsideAfterOff: gone });
  check("turned off: the phone says where to turn previews on, frames nothing, and their entry is gone", { outsideAfterOff: gone });
  await mobile.getByRole("button", { name: "Close preview" }).first().click();

  // ---- On again, for lab.py's requests through the stand-in Serve.
  box = await phoneSettings(page);
  await box.getByRole("button", { name: "Turn on previews" }).click();
  await box.locator('[role="status"]', { hasText: "Previews are on." }).waitFor({ timeout: 60_000 });
  check("turned on again with the saved ports");
  report.passed = true;
} catch (error) {
  report.failed = String(error?.stack ?? error).slice(0, 2000);
  console.log(`FAIL ${report.failed}`);
  for (const [i, p] of [...desk.pages(), ...phone.pages()].entries()) await p.screenshot({ path: join(out, `fail-${i}.png`) }).catch(() => {});
} finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
process.exit(report.passed ? 0 : 1);
