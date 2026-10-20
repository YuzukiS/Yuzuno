// Exercise only the two recorded acceptance Agents on the owned 4387 lab.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { parseResultMessage } from "../src/intelligent-ui/message.ts";

const base = "http://127.0.0.1:4387";
const lab = resolve("../acceptance/intelligent-ui");
const recovered = process.argv.includes("--recovered");
const checks = [],
  errors = [],
  mutations = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  ...(recovered ? { storageState: `${lab}/native-storage.json` } : {}),
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  assert.equal(
    new URL(request.url()).origin,
    base,
    "Native browser must stay on the owned lab",
  );
  if (request.method() !== "GET")
    mutations.push({ url: request.url(), method: request.method() });
});
try {
  if (!recovered)
    await page.addInitScript(() =>
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }),
      ),
    );
  await page.goto(base);
  for (const harness of ["native", "claude"]) {
    const record = JSON.parse(
      await readFile(`${lab}/${harness}-agent.json`, "utf8"),
    );
    const validation = JSON.parse(
      await readFile(`${lab}/${harness}-validation.json`, "utf8"),
    );
    const response = await context.request.get(
      `${base}/api/agents/${record.id}`,
    );
    const detail = await response.json();
    const item = detail.turns
      .find((turn) => turn.id === validation.turnId)
      ?.items.find((item) => item.id === validation.itemId);
    assert.ok(item, "Original native message identity is preserved");
    const result = parseResultMessage(item.text).result;
    assert.ok(result, "Real output passes the same parser used by the UI");
    assert.equal(result.raw, validation.raw);
    await page
      .getByRole("button", { name: `Open ${record.name}`, exact: true })
      .click();
    await page.locator(".interactive-result").waitFor();
    const composer = page.getByRole("textbox", {
      name: `Message ${record.name}`,
      exact: true,
    });
    const checkbox = page
      .locator(".interactive-result input[type=checkbox]")
      .first();
    if (recovered) {
      assert.ok(
        await checkbox.isChecked(),
        "Selection restored in recovered client",
      );
      assert.match(
        await composer.inputValue(),
        /Keep my native acceptance draft\./,
      );
      assert.match(
        await composer.inputValue(),
        /Regarding your interactive result/,
      );
      checks.push(
        `${harness}: Core restart preserves native message/spec; client restores selection and draft`,
      );
    } else {
      await composer.fill("Keep my native acceptance draft.");
      await checkbox.check();
      await page.locator(".result-primary").click();
      const draft = await composer.inputValue();
      assert.ok(draft.startsWith("Keep my native acceptance draft.\n\n"));
      assert.match(draft, /Selected:/);
      assert.equal(
        mutations.filter((request) =>
          /\/(messages|turns|interrupt|respond)$/.test(request.url),
        ).length,
        0,
      );
      await page.locator(".result-source-list button").first().click();
      await page.getByRole("dialog").waitFor();
      const expectedLine = harness === "native" ? "5" : "1";
      assert.equal(
        await page.locator(".source-line-highlight").getAttribute("data-line"),
        expectedLine,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await composer.inputValue(), draft);
      await page.reload();
      await checkbox.waitFor();
      assert.ok(await checkbox.isChecked());
      assert.equal(await composer.inputValue(), draft);
      checks.push(
        `${harness}: genuine result renders, selects, appends without sending, opens exact source line and survives refresh`,
      );
    }
    await page.locator(".interactive-result").scrollIntoViewIfNeeded();
    if (harness === "claude")
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
    await page.screenshot({
      path: `${lab}/${harness}-${recovered ? "recovered" : "live"}.png`,
    });
  }
  await context.storageState({ path: `${lab}/native-storage.json` });
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.stack);
  await page.screenshot({ path: `${lab}/native-failure.png` }).catch(() => {});
  throw error;
} finally {
  const report = {
    checks,
    errors,
    mutations,
    passed: errors.length === 0,
    base,
  };
  await writeFile(
    `${lab}/${recovered ? "recovery-browser" : "native-browser"}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
