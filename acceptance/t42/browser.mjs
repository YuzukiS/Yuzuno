import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const state = JSON.parse(readFileSync("target/t42/lab/state.json"));
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:4475");
  await page
    .getByRole("button", { name: "Tasks & messages", exact: false })
    .click();
  await page.locator(`button[data-task-id="${state.taskId}"]`).click();
  const panel = page.getByRole("region", { name: "PR reviews" });
  await panel
    .getByText("Review ID: " + state.claude.reviewId, { exact: true })
    .waitFor();
  await page.screenshot({
    path: "target/t42/reviews-browser.png",
    fullPage: true,
  });
  const text = await panel.innerText();
  assert.ok(text.includes("claude-opus-5-5[1m]"));
  assert.ok(text.includes("context reads"));
  assert.ok(await panel.getByLabel("Review result recipient").count());
  const live = await page.request.get(
    "http://127.0.0.1:4475/api/pr-reviews?taskId=" + state.taskId,
  );
  const reviews = (await live.json()).reviews;
  for (const run of reviews) assert.ok(text.includes(run.id));
  writeFileSync(
    "target/t42/browser.json",
    JSON.stringify(
      { sameReviewIds: reviews.map((r) => r.id), errors, text },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ sameReviewIds: reviews.map((r) => r.id), errors }),
  );
} finally {
  await browser.close();
}
