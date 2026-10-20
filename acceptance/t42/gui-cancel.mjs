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
const base = "http://127.0.0.1:4475";
const request = async (path, body) => {
  const r = await page.request.post(base + "/api" + path, {
    headers: { "X-Yuzuno-Client": "desktop" },
    data: body,
  });
  assert.equal(r.ok(), true, await r.text());
  return r.json();
};
try {
  await page.goto(base);
  await request("/pr-reviews/settings", {
    harness: "codex",
    model: "gpt-6.1-sol",
  });
  await page
    .getByRole("button", { name: "Tasks & messages", exact: false })
    .click();
  await page.locator(`button[data-task-id="${state.taskId}"]`).click();
  const panel = page.getByRole("region", { name: "PR reviews" });
  await panel
    .getByText("Review ID: " + state.claude.reviewId, { exact: true })
    .waitFor();
  await panel.getByLabel("Review result recipient").selectOption(state.agentId);
  const accepted = page.waitForResponse(
    (r) =>
      r.url() === base + "/api/pr-reviews" && r.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Review PR", exact: true }).click();
  const response = await accepted;
  assert.ok(response.ok());
  const run = await response.json();
  const payload = response.request().postDataJSON();
  assert.equal(run.notificationRecipient.id, state.agentId);
  const duplicate = await request("/pr-reviews", payload);
  assert.equal(duplicate.id, run.id);
  const article = panel
    .locator("article")
    .filter({ hasText: "Review ID: " + run.id });
  await article
    .getByText("running", { exact: true })
    .waitFor({ timeout: 30000 });
  const changed = await request("/pr-reviews/settings", {
    harness: "claude",
    model: "default",
  });
  assert.equal(changed.harness, "claude");
  await article.getByRole("button", { name: "Cancel review" }).click();
  await article
    .getByText("cancelled", { exact: true })
    .waitFor({ timeout: 20000 });
  const terminal = await request("/collaboration/review_get", {
    taskId: state.taskId,
    reviewId: run.id,
  });
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.requestedHarness, "codex");
  assert.equal(terminal.actualModel, "gpt-6.1-sol");
  assert.equal((await request("/pr-reviews", payload)).id, run.id);
  const mail = await request("/collaboration/peer_read", {
    agentId: state.agentId,
    limit: 100,
  });
  const notices = mail.messages.filter((m) => m.reviewId === run.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sender.kind, "system");
  await article.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "target/t42/gui-cancel.png", fullPage: true });
  writeFileSync(
    "target/t42/gui-cancel.json",
    JSON.stringify(
      {
        run: terminal,
        notification: notices[0],
        duplicateId: duplicate.id,
        errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      id: run.id,
      status: terminal.status,
      actualModel: terminal.actualModel,
      duplicateId: duplicate.id,
      notifications: notices.length,
    }),
  );
} finally {
  await browser.close();
}
