// T-200 lab integration: the web side against a real, isolated lab Core with
// T-200's push routes (YUZUNO_LAB_CORE, e.g. http://127.0.0.1:4495). Chromium
// as an iPhone Home Screen app: the user agent, standalone display and the
// notification permission are set; the real worker (/sw.js, served by that
// Core) is registered. Only the browser's push subscription is a stand-in,
// with an Apple-shaped endpoint and synthetic keys, since Chromium's own push
// service is Google's and a real subscription is not authorized.
//
// Nothing is sent: the lab Workspace has no Agents and no Asks, so Core has
// nothing to push; the subscription is removed before the end.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const core = process.env.YUZUNO_LAB_CORE;
assert.match(core ?? "", /^http:\/\/127\.0\.0\.1:\d+$/, "YUZUNO_LAB_CORE: the lab Core's loopback address");
assert.notEqual(new URL(core).port, "4317", "never the daily Core");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/push-lab");
await mkdir(output, { recursive: true });
const report = { core, checks: [], errors: [] };
const check = (name, extra = {}) => { report.checks.push({ name, ...extra }); console.log(`PASS ${name}`); };

// A device's keys as a browser would have them: a P-256 public key and 16 bytes.
const device = createECDH("prime256v1");
device.generateKeys();
const keys = { p256dh: device.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
const endpoint = `https://web.push.apple.com/t200-lab-${randomBytes(8).toString("hex")}`;
const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await context.grantPermissions(["notifications"], { origin: core });
  await context.addInitScript(([endpoint, keys]) => {
    const media = window.matchMedia.bind(window);
    window.matchMedia = (query) => (query === "(display-mode: standalone)" ? { media: query, matches: true, addEventListener() {}, removeEventListener() {} } : media(query));
    // The push subscription stand-in, kept per page, logged for the check.
    window.__push = { subscribed: null, log: [] };
    const subscription = () => ({
      endpoint,
      expirationTime: null,
      toJSON: () => ({ endpoint, expirationTime: null, keys }),
      unsubscribe: async () => { window.__push.log.push("unsubscribe"); window.__push.subscribed = null; return true; },
    });
    PushManager.prototype.getSubscription = async function () { return window.__push.subscribed; };
    PushManager.prototype.subscribe = async function (options) {
      window.__push.log.push(`subscribe ${options.applicationServerKey.byteLength ?? options.applicationServerKey.length}`);
      window.__push.subscribed = subscription();
      return window.__push.subscribed;
    };
  }, [endpoint, keys]);
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  // What Core says of a subscription, without the times and reasons it adds.
  const standing = (body) => ({ state: body.state, ...(body.kinds ? { kinds: body.kinds } : {}) });
  const api = (path, body) => page.evaluate(async ([path, body]) => {
    const response = await fetch(`/api${path}`, body === undefined
      ? { headers: { "X-Yuzuno-Client": "desktop" } }
      : { method: "POST", headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [path, body]);

  // The worker as Core serves it: this file, as JavaScript, never cached.
  const served = await page.request.get(`${core}/sw.js`);
  assert.equal(served.status(), 200);
  assert.match(served.headers()["content-type"] ?? "", /javascript/);
  assert.match(served.headers()["cache-control"] ?? "", /no-store/);
  assert.equal(await served.text(), worker);
  check("Core serves /sw.js as this file, as JavaScript, with no-store", { contentType: served.headers()["content-type"] });

  await page.goto(`${core}/`);
  const workspaceId = (await api("/workspace")).body.workspace.id;
  assert.ok(workspaceId);
  const before = await api("/push");
  assert.deepEqual(before, { status: 200, body: { publicKey: null } }, "opening the page makes no key");
  check("opening Yuzuno makes no push key", before);

  await page.getByRole("button", { name: "Settings and updates" }).click();
  const dialog = page.getByRole("dialog");
  const picker = dialog.getByRole("combobox", { name: "Settings category", exact: true });
  if (await picker.count()) await picker.selectOption({ label: "Notifications & attention" });
  else await dialog.getByRole("tab", { name: "Notifications & attention" }).click();
  const editor = dialog.locator("#settings-notifications");
  const push = editor.getByRole("checkbox", { name: "Push notifications on this device" });
  await push.waitFor();
  assert.equal(await push.isChecked(), false);
  await page.screenshot({ path: resolve(output, "1-off.png") });

  await push.click();
  await page.waitForFunction(() => document.querySelector('#settings-notifications .push-settings')?.dataset.state === "active", null, { timeout: 20_000 });
  assert.equal(await push.isChecked(), true);
  const registration = await page.evaluate(async () => {
    const one = await navigator.serviceWorker.getRegistration("/");
    const script = (one?.active ?? one?.waiting ?? one?.installing)?.scriptURL;
    return { scope: one?.scope, script };
  });
  assert.deepEqual(registration, { scope: `${core}/`, script: `${core}/sw.js` });
  const key = await api("/push");
  assert.equal(Buffer.from(key.body.publicKey, "base64url").length, 65, "Core made its key on the click");
  assert.deepEqual(await page.evaluate(() => window.__push.log), ["subscribe 65"]);
  let state = await api("/push/subscriptions/state", { endpoint });
  assert.deepEqual(standing(state.body), { state: "active", kinds: ["needsYou", "failed", "finished"] });
  await page.screenshot({ path: resolve(output, "2-on.png") });
  check("turning it on registers Core's /sw.js at /, makes the key once and subscribes for the chosen kinds", { registration, state: state.body });

  await editor.getByRole("checkbox", { name: /A Turn finished/ }).click();
  await page.waitForFunction(async (endpoint) => {
    const response = await fetch("/api/push/subscriptions/state", { method: "POST", headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" }, body: JSON.stringify({ endpoint }) });
    const body = await response.json();
    return body.kinds?.length === 2;
  }, endpoint, { timeout: 10_000, polling: 250 });
  state = await api("/push/subscriptions/state", { endpoint });
  assert.deepEqual(standing(state.body), { state: "active", kinds: ["needsYou", "failed"] });
  check("changing a kind tells Core for the same subscription", state.body);

  const google = await api("/push/subscriptions", { endpoint: "https://fcm.googleapis.com/fcm/send/t200-lab", keys, kinds: ["finished"] });
  assert.equal(google.status, 400);
  assert.equal(google.body.code, "push_service_unsupported");
  check("Core refuses a push service other than Apple's", google.body);

  await push.click();
  await page.waitForFunction(() => !document.querySelector('#settings-notifications input[aria-label="Push notifications on this device"]')?.checked, null, { timeout: 10_000 });
  state = await api("/push/subscriptions/state", { endpoint });
  assert.equal(state.body.state, "none");
  assert.deepEqual(await page.evaluate(() => window.__push.log), ["subscribe 65", "unsubscribe"]);
  check("turning it off removes this device's subscription", state.body);

  // A notification click, as the worker posts it to an open window.
  await page.keyboard.press("Escape");
  const toast = () => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  await page.evaluate((href) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "yuzuno:open", href } })), `${core}/#/home?w=another-workspace`);
  await page.waitForFunction(() => /another Workspace/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 5000 });
  check("a click about another Workspace says so", { toast: await toast() });
  await page.evaluate((href) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "yuzuno:open", href } })), `${core}/#/agent?w=${encodeURIComponent(workspaceId)}&a=gone-agent`);
  await page.waitForFunction(() => /no longer in this Workspace/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 5000 });
  check("a click about an Agent this Workspace no longer has says so", { toast: await toast() });
  await page.evaluate((href) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "yuzuno:open", href } })), `${core}/#/home?w=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => document.querySelector(".catchup-nav")?.getAttribute("aria-current") === "page", null, { timeout: 5000 });
  check("a click about this Workspace's Home opens Home");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  if (page) await page.screenshot({ path: resolve(output, "failed.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
