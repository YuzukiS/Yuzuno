// Isolated browser fixture; all API traffic is intercepted, no daily window/Core.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { installConnectionFixture, FIXTURE_WORKSPACE } from "./connection-fixture.mjs";
const root = resolve(process.env.YUZUNO_UI_DIST || "../target/t31/ui");
const remoteFixture = process.env.T31_REMOTE_FIXTURE === "1";
const output = new URL(remoteFixture ? "../../target/t31/browser-remote/" : "../../target/t31/browser/", import.meta.url);
await mkdir(output, { recursive: true });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    res.writeHead(500);
    res.end("fixture missing");
    return;
  }
  try {
    const file = resolve(
      root,
      "." + (req.url === "/" ? "/index.html" : req.url),
    );
    if (!file.startsWith(root + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".png": "image/png",
      }[extname(file)] || "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const report = { remoteFixture, checks: [], errors: [], layout: [] };
const forkImageId = "f".repeat(64) + ".png";
context.setDefaultTimeout(10000);
context.on("page", (page) =>
  page.on("pageerror", (e) => report.errors.push(e.message)),
);
await context.route("**/api/**", (route) => {
  const url = route.request().url();
  if (!/\/images\//.test(url)) return route.abort();
  // The fork's own directory has no copy; only the source owns this image.
  if (
    url.includes(forkImageId) &&
    !url.includes("/agents/source-agent/images/")
  )
    return route.fulfill({ status: 404, body: "No image in fork directory" });
  return route.fulfill({ contentType: "image/png", body: png });
});
await context.addInitScript(installConnectionFixture);
await context.addInitScript((remoteFixture) => {
  const previous = window.fetch;
  const f = (window.imageFixture = {
    uploads: [],
    sent: [],
    fail: false,
    hold: false,
    release: null,
    interrupts: 0,
    reviews: 0,
    turns: [],
  });
  window.fetch = async (url, init = {}) => {
    const path = new URL(url, location.href).pathname;
    if (init.method === "POST") {
      if (path.endsWith("/images")) {
        const bytes = new Uint8Array(await init.body.arrayBuffer());
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        f.uploads.push(path);
        return {
          ok: true,
          json: async () => ({
            id: hash + ".png",
            width: 1,
            height: 1,
            bytes: bytes.length,
          }),
        };
      }
      if (path.endsWith("/interrupt")) f.interrupts++;
      if (path.endsWith("/review")) f.reviews++;
      if (!path.endsWith("/messages"))
        throw Error("Unexpected mutation " + path);
      const input = JSON.parse(init.body);
      f.sent.push(input);
      if (f.fail) throw new TypeError("fixture connection lost");
      if (f.hold) await new Promise((resolve) => (f.release = resolve));
      f.turns.push({
        id: "sent-" + f.sent.length,
        status: "completed",
        items: [
          {
            id: "user-" + input.clientMessageId,
            clientId: input.clientMessageId,
            type: "userMessage",
            content: [
              { type: "text", text: input.text },
              ...(input.images || []).map((id) => ({
                type: "localImage",
                path: "/input-images/a/" + id,
              })),
            ],
          },
        ],
      });
      return {
        ok: true,
        json: async () => ({
          input,
          status: "accepted",
          turnId: "sent-" + f.sent.length,
          error: null,
        }),
      };
    }
    const response = await previous(url, init);
    if (path === "/api/workspace" || /^\/api\/agents\/[ab]$/.test(path)) {
      const body = await response.json();
      if (remoteFixture) {
        for (const agent of body.agents || [body.agent]) {
          agent.remote = { machine: { id: "fixture-mac", name: "Fixture Mac", target: "test@mac", codex: "/bin/codex", defaultCwd: "/fixture" }, runtime: null };
        }
      }
      if (path === "/api/agents/a") {
        body.pending = [];
        body.agent.pendingCount = 0;
        body.turns.push(...f.turns);
      }
      return { ok: true, json: async () => body };
    }
    return response;
  };
}, remoteFixture);
const page = await context.newPage();
const input = () => page.locator("[data-composer-input]");
const images = () => page.locator(".composer-area .input-image-open");
const choose = async (name = "test.png", bytes = png) => {
  await page
    .getByLabel("Choose images")
    .setInputFiles({ name, mimeType: "image/png", buffer: bytes });
  await page.waitForFunction(
    () => !document.body.textContent.includes("Saving images…"),
  );
};
// Saved under the Workspace and the Agent it was written in (T-195).
const draftKey = `yuzuno.composer.v1:${JSON.stringify([FIXTURE_WORKSPACE, "a"])}`;
const saved = () =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), draftKey);
try {
  await page.goto(base);
  await input().waitFor();
  // Real browser clipboard with PNG, not a synthetic text/path placeholder.
  await page.evaluate(async (bytes) => {
    const blob = new Blob(
      [Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))],
      { type: "image/png" },
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, png.toString("base64"));
  await input().focus();
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => window.imageFixture.uploads.length === 1);
  await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(key) || "{}").images?.length === 1,
    draftKey,
  );
  assert.equal(await images().count(), 1);
  report.checks.push("native PNG clipboard attaches once");
  await choose();
  const count = await images().count();
  await choose();
  assert.equal(await images().count(), count);
  report.checks.push("same picker content deduplicates");
  await images().first().hover();
  await page
    .locator(".input-image-hover")
    .first()
    .waitFor({ state: "visible" });
  await images().first().click();
  await page.getByRole("dialog").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[role="dialog"]')).opacity ===
      "1",
  );
  const previewFits = await page
    .locator(".input-image-dialog")
    .evaluate((el) => {
      const image = el.getBoundingClientRect(),
        dialog = el.closest('[role="dialog"]').getBoundingClientRect();
      return (
        image.left >= dialog.left &&
        image.right <= dialog.right &&
        image.right <= innerWidth
      );
    });
  assert.ok(previewFits, "full preview fits the dialog on a narrow window");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.imageFixture.interrupts), 0);
  report.checks.push("hover/full preview and Escape without Interrupt");
  await input().fill("中文 image caption");
  await page
    .getByRole("button", { name: /Claude fixture/ })
    .first()
    .click();
  await input().waitFor();
  assert.ok(
    await page.getByRole("button", { name: "Add images" }).isEnabled(),
    "a Claude Agent takes images too, including SSH destinations",
  );
  // The composer's image button says in its tooltip that Claude gets large
  // images scaled.
  assert.match(
    (await page.getByRole("button", { name: "Add images" }).getAttribute("title")) || "",
    /scaled or compressed when sent to Claude · originals are kept/,
  );
  await page
    .getByRole("button", { name: /Codex fixture/ })
    .first()
    .click();
  await input().waitFor();
  assert.ok((await saved()).images.length >= 1);
  await page.reload();
  await input().waitFor();
  assert.equal(await images().count(), count);
  assert.equal(await input().innerText(), "中文 image caption");
  report.checks.push("Agent switch + reload preserve caption and image");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty("--reading-size", "20px");
    }, theme);
    await images().first().hover();
    const layout = await page
      .locator(".input-image-hover")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          vw: innerWidth,
          vh: innerHeight,
        };
      });
    assert.ok(
      layout.left >= 0 &&
        layout.right <= layout.vw &&
        layout.top >= 0 &&
        layout.bottom <= layout.vh,
    );
    report.layout.push({ theme, ...layout });
    await page.screenshot({
      path: new URL(`${theme}-20px.png`, output).pathname,
    });
  }
  report.checks.push("light/dark 20px layout");
  await page.evaluate(() => (window.imageFixture.fail = true));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("fixture connection lost", { exact: true }).waitFor();
  const first = await page.evaluate(() => window.imageFixture.sent[0]);
  assert.ok((await saved()).images.length >= 1);
  while (await images().count())
    await page
      .locator(".composer-area")
      .getByLabel("Remove image 1", { exact: true })
      .click();
  await choose(
    "different.png",
    Buffer.concat([png, Buffer.from("different content")]),
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(() => window.imageFixture.sent.length === 2);
  const second = await page.evaluate(() => window.imageFixture.sent[1]);
  assert.notEqual(first.clientMessageId, second.clientMessageId);
  assert.notDeepEqual(first.images, second.images);
  assert.equal(first.text, second.text);
  report.checks.push(
    "failed send retains draft; changing only image uses a new dedup key",
  );
  await page.evaluate(() => {
    window.imageFixture.fail = false;
    window.imageFixture.hold = true;
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(() => !!window.imageFixture.release);
  await input().press("End");
  await page.keyboard.type(" new typing");
  await page.evaluate(() => window.imageFixture.release());
  await page.waitForFunction(
    () => !document.querySelector(".send-button").disabled,
  );
  assert.match(await input().innerText(), /new typing/);
  assert.ok((await saved()).images.length >= 1);
  report.checks.push("accepted immutable snapshot does not clear new typing");
  await page.evaluate(() => (window.imageFixture.hold = false));
  await input().fill("");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    (key) => !JSON.parse(localStorage.getItem(key) || "{}").images?.length,
    draftKey,
  );
  assert.equal(
    await page.evaluate(() => window.imageFixture.sent.at(-1).text),
    "",
  );
  assert.ok(
    (await page.locator(".user-message .input-image-open").count()) >= 1,
  );
  report.checks.push("image-only send and original message image replay");
  await page.evaluate((id) => {
    window.imageFixture.turns.push({
      id: "inherited-turn",
      status: "completed",
      items: [
        {
          id: "inherited-image",
          type: "userMessage",
          content: [
            {
              type: "localImage",
              path: "/core/data/input-images/source-agent/" + id,
            },
          ],
        },
      ],
    });
    window.connectionFixture.refresh();
  }, forkImageId);
  const inherited = page.locator(
    `.user-message .input-image-open:has(img[src*="${forkImageId}"])`,
  );
  await inherited.waitFor();
  await inherited
    .locator("img")
    .first()
    .evaluate((img) => img.decode());
  assert.match(
    await inherited.locator("img").first().getAttribute("src"),
    /\/agents\/source-agent\/images\//,
  );
  await inherited.click();
  const original = page.locator(".input-image-dialog img");
  await original.evaluate((img) => img.decode());
  assert.match(
    await original.getAttribute("src"),
    /\/agents\/source-agent\/images\/[^?]+$/,
  );
  await page.keyboard.press("Escape");
  report.checks.push(
    "fork history loads original-owner thumbnail and full image without a copy in the new Agent",
  );
  await page.getByRole("button", { name: /Claude fixture/ }).first().click();
  await input().waitFor();
  await choose();
  await input().fill("");
  const beforeClaude = await page.evaluate(() => window.imageFixture.sent.length);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction((count) => window.imageFixture.sent.length === count + 1, beforeClaude);
  const claudeInput = await page.evaluate(() => window.imageFixture.sent.at(-1));
  assert.equal(claudeInput.text, "");
  assert.equal(claudeInput.images.length, 1);
  report.checks.push("Claude image-only message passes the same composer and send capability checks");
  assert.deepEqual(report.errors, []);
  report.result = "PASS";
} finally {
  await writeFile(
    new URL("report.json", output),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await new Promise((r) => server.close(r));
}
console.log(JSON.stringify(report, null, 2));
