// T-5: previews on the phone, in Chromium, against the lab Core lab.py
// started and its stand-in Serve (serve_proxy.py). Two windows: the
// computer, on Core's own port, and the "phone", through the stand-in
// Serve at https://<node>:<phone port>, with the node's name mapped to
// 127.0.0.1 and the stand-in's certificate ignored. Previews are served on
// that same address, under the path the phone entry keeps for them.
//   node browser.mjs <lab.json> <out dir>
// Not covered: a real Serve or tailnet, Safari, an iPhone or a Home Screen app.
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
const PAGES = `${PHONE}/__yuzuno/preview/v/`;
const serve = async () => JSON.parse(await readFile(lab.state, "utf8")).serve;
/** A request through the stand-in Serve as a browser on the phone would send it: status, headers and body. */
const through = (url, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
  const { hostname, port, pathname, search } = new URL(url);
  const req = request({ host: "127.0.0.1", port, method, path: pathname + search, servername: hostname, rejectUnauthorized: false,
    headers: { Host: `${hostname}:${port}`, ...headers } }, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => resolve([res.statusCode, res.headers, body]));
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

/** Settings → Phone access, open. */
async function phoneSettings(page) {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 15_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("phone");
  await page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "Phone & remote access" }) }).first()
    .locator("button").click({ timeout: 10_000 });
  const section = page.locator("#settings-editor-remote");
  await section.locator(".remote-access-states").waitFor({ timeout: 15_000 });
  return section;
}
async function closeSettings(page) {
  await page.getByRole("dialog").getByRole("button", { name: /^Close (dialog|settings)$/ }).first().click();
}
const previewsLine = (section) => section.locator(".remote-access-previews-line").textContent();
/** Check, then Save and apply with previews included or not, as the page sends it. */
async function saveWith(section, included) {
  const box = section.getByLabel("Phone access includes previews");
  if ((await box.isChecked()) !== included) await box.click();
  await section.getByRole("button", { name: "Check" }).click();
  const apply = section.getByRole("button", { name: "Save and apply" });
  await apply.waitFor({ state: "visible" });
  await section.page().waitForFunction((el) => !el.disabled, await apply.elementHandle(), { timeout: 60_000 });
  await apply.click();
  await section.locator('[role="status"]', { hasText: "Applied." }).waitFor({ timeout: 60_000 });
  await section.locator(".remote-access-previews-line", { hasText: included ? /Included$/ : /Not included$/ }).waitFor({ timeout: 20_000 });
}
/** Home's prototype card, and its attachment's main open button. */
async function openPrototype(page) {
  await page.locator('.toolbar-nav button[title^="Home"]').click({ timeout: 15_000 });
  const card = page.locator(`[id="home-section-${lab.projectId}-${lab.section}"]`);
  await card.waitFor({ timeout: 15_000 });
  // The split's main button; its ▾ beside it shares the class.
  await card.locator(".brief-attachment .open-choice-split .primary-button").first().click();
}
const BLOCKED = ["localStorage", "sessionStorage", "indexedDB", "cookie", "parent", "top", "fetchCore", "fetchHere", "fetchRelative",
  "fetchFromBase", "baseApplied", "worker", "serviceWorker", "websocket", "image", "popup"];
/** The page's own report of what it could reach: every probe blocked, its origin opaque. A page
 * opened on its own is its own parent and top, which say nothing there. */
async function probed(frame, where, topLevel = false) {
  await frame.locator("#try").click();
  await frame.waitForFunction(() => document.querySelector("#try").textContent === "clicked");
  await frame.waitForFunction(() => window.done === true, null, { timeout: 30_000 });
  const probes = JSON.parse(await frame.locator("#probes").textContent());
  assert.equal(probes.origin, "null", `${where}: an opaque origin`);
  for (const name of BLOCKED.filter((n) => !topLevel || !["parent", "top"].includes(n))) {
    assert.match(probes[name] ?? "", /^blocked: /, `${where}: ${name}: ${probes[name]}`);
  }
  return probes;
}

try {
  // ---- On the computer: an older Core's choice holds, and the change that removed its entry says so.
  const page = await desk.newPage();
  await page.goto(lab.page);
  let section = await phoneSettings(page);
  assert.match(await previewsLine(section), /Previews on the phone\s*Included$/);
  assert.equal(await section.getByLabel("Phone access includes previews").isChecked(), true, "their choice is the box's");
  assert.match(await section.textContent(), new RegExp(`Older phone previews: The older phone previews' own Serve port ${lab.legacyServePort} was removed\\.`));
  assert.doesNotMatch(await section.textContent(), /set a Serve entry of its own for phone previews/, "nothing of theirs is left to remove");
  await shot(page, "1-settings-older-previews-removed.png");
  check("Settings: the older Core's previews choice holds; its own Serve entry was removed by the first Save and apply, said apart");

  // ---- Left out: the phone opens none, and Serve is unchanged.
  const before = await serve();
  await saveWith(section, false);
  assert.deepEqual(await serve(), before, "leaving previews out changes nothing in Serve");
  await closeSettings(page);
  const mobile = await phone.newPage();
  const minted = [];
  mobile.on("response", async (response) => {
    if (response.url().endsWith("/api/previews") && response.request().method() === "POST") minted.push(await response.json().catch(() => null));
  });
  await mobile.goto(`${PHONE}/`);
  await openPrototype(mobile);
  const off = mobile.locator(".portal-panel [role=alert]").first();
  await off.waitFor({ timeout: 20_000 });
  assert.match(await off.textContent(), /open through the phone entry once Phone access includes previews/);
  assert.equal(await mobile.locator("iframe.portal-frame").count(), 0);
  await shot(mobile, "2-phone-previews-not-included.png");
  check("left out: Serve unchanged, and the phone frames nothing and says where to include them");
  await mobile.getByRole("button", { name: "Close preview" }).first().click();

  // ---- Included: on the phone, the prototype from Home, on the phone entry's own address.
  section = await phoneSettings(page);
  await saveWith(section, true);
  assert.deepEqual(await serve(), before, "including them changes nothing in Serve: one entry for both");
  await closeSettings(page);
  await openPrototype(mobile);
  const frameEl = mobile.locator(".portal-panel iframe.portal-frame");
  await frameEl.waitFor({ timeout: 20_000 });
  const src = await frameEl.getAttribute("src");
  assert.ok(src.startsWith(PAGES), src);
  assert.equal(await frameEl.getAttribute("sandbox"), "allow-scripts");
  const frame = await (await frameEl.elementHandle()).contentFrame();
  const framed = await probed(frame, "framed");
  assert.ok(await frame.locator("#try").isVisible(), "the frame did not leave for its form");
  report.observations.push({ framedProbes: framed });
  await shot(mobile, "3-phone-preview-framed.png");
  check("on the phone the prototype runs in the Portal, from the phone entry's own address; it reaches no storage, Core, this page or a worker, and its meta policy and base widen nothing",
    { src: src.replace(/\/v\/.*/, "/v/…"), probes: framed });

  // Its proof was asked by POST and answered once.
  // The first answer was the refusal while previews were left out.
  const proof = minted.find((answer) => answer?.proof)?.proof;
  assert.equal(proof?.method, "POST", JSON.stringify(minted));
  assert.ok(proof.url.startsWith(`${PHONE}/__yuzuno/preview/proof/`), proof.url);
  const [again] = await through(proof.url, { method: "POST", headers: { Origin: PHONE, "X-Yuzuno-Client": "desktop" } });
  assert.equal(again, 404, "a proof is answered once");
  const [byGet] = await through(proof.url, { headers: { Origin: PHONE } });
  assert.equal(byGet, 405, "never by GET");
  check("the snapshot's proof was asked by POST and answered once; lab.py reads the browser's own request from the stand-in Serve's log");

  // The page's own headers, and Yuzuno's page and API still refuse framing.
  const [status, heads] = await through(src);
  assert.equal(status, 200);
  assert.match(heads["content-security-policy"], new RegExp(`^sandbox allow-scripts; .*frame-ancestors ${PHONE.replace(/\./g, "\\.")}$`));
  assert.equal(heads["x-frame-options"], undefined);
  for (const [name, value] of [["cross-origin-opener-policy", "same-origin"], ["referrer-policy", "no-referrer"], ["cache-control", "no-store"], ["x-content-type-options", "nosniff"]]) {
    assert.equal(heads[name], value, name);
  }
  for (const path of ["/", "/api/health"]) assert.equal((await through(`${PHONE}${path}`))[1]["x-frame-options"], "DENY", path);
  check("the previewed page carries its own policy and no X-Frame-Options; Yuzuno's page and API keep DENY");

  // Pages that are not the phone's own cannot frame it; nothing frames Yuzuno's page.
  const foreign = await phone.newPage();
  await foreign.goto(lab.page);
  await foreign.evaluate(([preview, app]) => {
    for (const [id, url] of [["preview", preview], ["app", app]]) {
      const element = document.createElement("iframe");
      element.id = id;
      element.src = url;
      document.body.append(element);
    }
  }, [src, `${PHONE}/`]);
  await foreign.waitForTimeout(2500);
  // Shown there only if the frame holds that page's own element (a refused one holds the browser's error page, or nothing).
  const holds = async (id, selector) => {
    const child = await (await foreign.$(`#${id}`)).contentFrame();
    return child ? await child.evaluate((s) => !!document.querySelector(s), selector).catch(() => false) : false;
  };
  assert.equal(await holds("preview", "#try"), false, "the prototype is not shown inside another page");
  assert.equal(await holds("app", "#root"), false, "Yuzuno's page is not shown inside another page");
  await foreign.close();
  check("another page (Core's own origin) can frame neither the phone's snapshot nor Yuzuno's page");

  // Opened in the browser too, and by its address: both work; closing the Portal leaves them open.
  const [outside] = await Promise.all([phone.waitForEvent("page"), mobile.locator(".portal-panel").getByRole("button", { name: "Open in browser" }).first().click()]);
  await outside.waitForLoadState();
  assert.equal(outside.url(), src);
  const opened = await probed(outside, "opened outside", true);
  assert.equal(await outside.evaluate(() => window.opener), null, "no handle on the page that opened it");
  await mobile.getByRole("button", { name: "Close preview" }).first().click();
  await mobile.locator(".portal-panel").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await mobile.locator("iframe.portal-frame").count(), 0, "the inline preview is unmounted");
  const typed = await phone.newPage();
  const direct = await typed.goto(src);
  assert.equal(direct.status(), 200);
  assert.equal(direct.headers()["x-frame-options"], undefined);
  await probed(typed, "its address typed", true);
  await shot(outside, "4-phone-preview-outside.png");
  report.observations.push({ outsideProbes: opened });
  check("opened outside, and by its address, the page runs as in the Portal, with the same limits, and stays after the Portal closes");

  // ---- Phone access's own page through the phone entry: the choice shown, never changed there.
  section = await phoneSettings(mobile);
  assert.match(await previewsLine(section), /Included$/);
  assert.equal(await section.getByLabel("Phone access includes previews").count(), 0);
  check("through the phone entry, the choice only shows");
  await closeSettings(mobile);

  // ---- The computer's own preview is as it was: port P, a loopback address, proven by GET.
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

  // ---- Left out again: what the phone had open stops opening; included again, it stays gone.
  section = await phoneSettings(page);
  await saveWith(section, false);
  const refused = await outside.reload({ timeout: 10_000 });
  assert.equal(refused.status(), 403);
  assert.match(await outside.locator("body").textContent(), /does not include previews/);
  await saveWith(section, true);
  const gone = await outside.reload({ timeout: 10_000 });
  assert.equal(gone.status(), 404, "what was given before they were left out stays gone");
  await shot(page, "5-settings-included-again.png");
  check("left out, the phone's open preview stops opening; included again, it stays gone");
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
