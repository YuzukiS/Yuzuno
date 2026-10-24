// T-170: phone-fixture-server.mjs and phone-measure.js work for a browser
// that only loads the page: here Chromium, with DevTools giving it a notched
// phone's insets, reaching the server over HTTP like Mobile Safari in an iOS
// Simulator will (no Playwright routing). Held upright and sideways, the
// page's own measurements must arrive: the insets env() resolves to, the
// conversation's composer, focus in it, and a dialog open. A second folder
// is served and measured under /connection/. Chromium is not Safari; this
// checks the fixture, not iOS.
//   YUZUNO_UI_DIST=<isolated build> node tools/phone-fixture-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/phone-fixture");
await mkdir(output, { recursive: true });
const port = Number(process.env.YUZUNO_PORT || 4511);
const work = await mkdtemp(join(tmpdir(), "phone-fixture-"));
const measured = join(output, "measurements.jsonl");
await writeFile(measured, "");
const extra = join(work, "connection");
await mkdir(extra);
await writeFile(join(extra, "index.html"), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Connection</title>
<style>body{margin:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}</style></head>
<body><header class="wordmark">yuzuno.</header><main><h1>Your workspace</h1><input id="core-url" aria-label="Workspace address"></main></body></html>`);

const report = { checks: [], errors: [] };
const check = (name, detail = {}) => {
  report.checks.push({ name, ...detail });
  console.log(`PASS ${name}`);
};
const lines = async () => (await readFile(measured, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const until = async (test, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const found = (await lines()).find(test);
    if (found) return found;
    if (Date.now() > end) throw new Error(`no measurement: ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
};
const status = (host) => new Promise((done, fail) => {
  const req = request({ host: "127.0.0.1", port, path: "/", headers: { Host: host } }, (res) => { res.resume(); done(res.statusCode); });
  req.on("error", fail);
  req.end();
});

const server = spawn(process.execPath, [new URL("./phone-fixture-server.mjs", import.meta.url).pathname], {
  env: { ...process.env, YUZUNO_MEASURE_OUT: measured, YUZUNO_PORT: String(port), YUZUNO_EXTRA: `/connection=${extra}` },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((done, fail) => {
  server.stdout.on("data", (chunk) => String(chunk).includes("phone fixture:") && done());
  server.on("exit", (code) => fail(new Error(`the server exited ${code}`)));
});
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

const phones = [
  { name: "portrait", width: 393, height: 852, insets: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: "landscape", width: 852, height: 393, insets: { top: 0, right: 59, bottom: 21, left: 59 } },
];
const px = ({ top, right, bottom, left }) => [`${top}px`, `${right}px`, `${bottom}px`, `${left}px`];

try {
  assert.equal(await status("example.org"), 421, "another Host is refused");
  check("the fixture answers 127.0.0.1 only");
  for (const phone of phones) {
    const context = await browser.newContext({ viewport: { width: phone.width, height: phone.height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${phone.name}: ${error.message}`));
    await page.addInitScript(() => {
      if (!localStorage.getItem("yuzuno.appearance"))
        localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: phone.insets });
    // This phone's measurements: posted since it opened, at its width.
    const started = Date.now();
    const after = (test, what) => until((line) => line.kind === "measure" && Date.parse(line.at) >= started
      && line.window[0] === phone.width && test(line), `${phone.name}: ${what}`);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
    const input = page.locator('[data-composer-input][aria-label="Message Mori"]');
    await input.waitFor();
    const load = await after((l) => l.why.startsWith("load") && l.page === "/", "load");
    assert.deepEqual(load.insets, px(phone.insets), `${phone.name}: the insets env() resolves to`);
    assert.ok(load.visual && load.visual[0] === phone.width, `${phone.name}: the visual viewport`);
    check(`${phone.name}: the page measures itself on load, with the insets env() resolves to`, { insets: load.insets });

    await input.focus();
    const focus = await after((l) => l.why === "focusin" && l.focused === "Message Mori" && l.boxes.composer && l.boxes.input, "focus in the composer");
    check(`${phone.name}: focus in the composer is measured with its box`, { composer: focus.boxes.composer });

    await page.locator('button[aria-label="Settings and updates"]').click();
    await page.locator(".modal.settings-modal").waitFor();
    const dialog = await after((l) => l.why === "dialog-open" && l.boxes.modal && l.boxes.overlay, "a dialog open");
    check(`${phone.name}: an open dialog is measured with its box`, { modal: dialog.boxes.modal });
    await page.keyboard.press("Escape");
    await after((l) => l.why === "dialog-closed" && !l.boxes.modal, "the dialog closed");

    await page.goto(`http://127.0.0.1:${port}/connection/`);
    const connection = await after((l) => l.page === "/connection/" && l.boxes.wordmark && l.boxes.heading && l.boxes.field, "the connection page");
    assert.deepEqual(connection.insets, px(phone.insets));
    check(`${phone.name}: the second folder is served and measured`, { wordmark: connection.boxes.wordmark });
    await context.close();
  }
  const all = await lines();
  assert.deepEqual(all.filter((l) => l.kind !== "measure"), [], "no refused write and no server error");
  assert.deepEqual(report.errors, [], "no page errors");
  check("no refused writes, server errors or page errors", { measurements: all.length });
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.kill("SIGTERM");
}
