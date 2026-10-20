// T-18: the held-Backspace injection's own ceiling, on a bare textarea with
// nothing else on the page. profile.mjs cannot report a faster rate than this.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Headless Chromium acknowledges input with frames; keep producing them,
  // as the app (animations, streaming) does.
  await page.setContent(`<textarea>${"x".repeat(1500)}</textarea>
    <script>requestAnimationFrame(function f() { requestAnimationFrame(f); });</script>`);
  await page.locator("textarea").click();
  await page.locator("textarea").press("End");
  await page.evaluate(() => {
    window.counts = { keydown: 0, input: 0 };
    addEventListener("keydown", () => counts.keydown++, true);
    addEventListener("input", () => counts.input++, true);
  });
  const start = Date.now();
  let loops = 0, downMs = 0, waitMs = 0;
  await page.keyboard.down("Backspace");
  while (Date.now() < start + 10000) {
    let t = Date.now();
    await page.keyboard.down("Backspace");
    downMs += Date.now() - t;
    t = Date.now();
    await page.waitForTimeout(33);
    waitMs += Date.now() - t;
    loops++;
  }
  await page.keyboard.up("Backspace");
  const seconds = (Date.now() - start) / 1000;
  const deleted = 1500 - (await page.locator("textarea").inputValue()).length;
  console.log(JSON.stringify({ deleted, seconds, perSecond: Math.round((deleted / seconds) * 10) / 10, loops,
    downMsPerLoop: Math.round(downMs / loops), waitMsPerLoop: Math.round(waitMs / loops), ...(await page.evaluate(() => counts)) }));
} finally {
  await browser.close();
}
