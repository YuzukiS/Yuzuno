// Drive only the real Yuzuno Lab WebView2 through its private DevTools port.
// node update-lab.mjs <refused|install|after> <cdp> <core> <output> <A> <B> <agent>
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const [step, endpoint, core, output, oldVersion, newVersion, agent] = process.argv.slice(2);
const result = { step, at: new Date().toISOString() };
const browser = await chromium.connectOverCDP(endpoint);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((p) => p.url().startsWith(core) || p.url().startsWith("http://tauri.localhost"));
  assert.ok(page, `the lab WebView exists (${pages.map((p) => p.url()).join(", ")})`);
  if (!page.url().startsWith(core)) {
    // A starts with an unavailable address. Select the actual Core in the
    // connection UI so the update must restore selectedCore, not startup args.
    assert.notEqual(step, "after", "B must reconnect automatically");
    await page.locator("#core-url").fill(core);
    await page.locator("#connect-button").click({ timeout: 30000 });
    await page.waitForURL(`${core}/?shell=desktop`, { timeout: 30000 });
    result.selectedCoreInConnectionUI = core;
  }
  result.url = page.url();
  assert.equal(new URL(result.url).origin, core);
  await page.locator('[data-core-status="Core connected"]').first().waitFor({ timeout: 20000 });
  const status = () => page.evaluate(() => window.__TAURI__.core.invoke("desktop_update_status"));
  const desktop = page.locator('[aria-label="Desktop app"]');
  const openSettings = async () => {
    await page.locator('[aria-label="Settings and updates"]').click();
    await desktop.waitFor();
  };
  result.before = await status();
  const composer = page.locator(".pasted-text-composer .cm-content");
  if (step === "refused" || step === "install") {
    assert.equal(result.before.version, oldVersion);
    assert.equal(result.before.channel, "installer");
    assert.equal(result.before.unavailable, null);
    if (step === "install") {
      await composer.waitFor();
      result.draft = `Keep this unsent Windows update draft ${Date.now()}. 草稿不能丢失。`;
      await composer.fill(result.draft);
      await page.waitForFunction(([id, draft]) => {
        const saved = JSON.parse(localStorage.getItem(`yuzuno.composer.v1:${id}`) || "null");
        return saved?.parts?.some((p) => p.kind === "text" && p.text === draft);
      }, [agent, result.draft]);
      result.selectedAgent = await page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.selected") || "null"));
      assert.equal(result.selectedAgent, agent);
      await page.screenshot({ path: resolve(output, "before-draft.png") });
    }
    await openSettings();
    await desktop.getByRole("button", { name: "Check for desktop update" }).click();
    await desktop.getByText(`Version ${newVersion} is available.`).waitFor({ timeout: 30000 });
    await page.screenshot({ path: resolve(output, `${step}-available.png`) });
    const gone = new Promise((done) => {
      browser.once("disconnected", done);
      page.once("close", done);
    });
    await desktop.getByRole("button", { name: `Download and install ${newVersion}` }).click();
    if (step === "refused") {
      const alert = desktop.getByRole("alert");
      await alert.waitFor({ timeout: 60000 });
      result.alert = await alert.textContent();
      assert.match(result.alert, /signature/);
      result.after = await status();
      assert.equal(result.after.version, oldVersion);
      assert.equal(result.after.phase, "failed");
      await page.screenshot({ path: resolve(output, "refused-signature.png") });
    } else {
      let timer;
      try { await Promise.race([gone, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Install did not close A")), 180000); })]); }
      finally { clearTimeout(timer); }
      result.closed = !browser.isConnected() || page.isClosed();
      assert.ok(result.closed, "A closed to install B");
    }
  } else if (step === "after") {
    const before = JSON.parse(await readFile(resolve(output, "install.json"), "utf8"));
    assert.equal(result.before.version, newVersion);
    assert.equal(result.before.channel, "installer");
    await composer.waitFor();
    result.draft = await composer.innerText();
    assert.equal(result.draft, before.draft, "the actual composer draft survived the native update");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.selected") || "null")), agent);
    result.decorated = await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isDecorated());
    assert.equal(result.decorated, false, "B has T44's frameless native window");
    await page.getByRole("button", { name: "Minimize", exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, "after-draft.png") });
    await openSettings();
    await desktop.getByRole("button", { name: "Check for desktop update" }).click();
    await desktop.getByText("The desktop app is up to date.").waitFor({ timeout: 30000 });
    await page.screenshot({ path: resolve(output, "after-current.png") });
  } else throw new Error(`Unknown step ${step}`);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `${step}.json`), JSON.stringify(result, null, 2) + "\n");
  await browser.close().catch(() => {});
  console.log(JSON.stringify(result));
}
