// Actual Chromium checks. No request interception, simulated runtime, or seeded
// workspace. Default mode inspects the explicitly labelled visual specimen.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const live = process.argv.includes("--live");
const exercise = process.argv.includes("--exercise");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "acceptance");
const base = process.env.YUZUNO_CORE_URL || "http://127.0.0.1:4317";
const cwd = process.env.YUZUNO_ACCEPTANCE_CWD;
if (exercise && (!live || !cwd))
  throw new Error(
    "--exercise requires --live and an isolated YUZUNO_ACCEPTANCE_CWD.",
  );
const report = {
  mode: live
    ? exercise
      ? "real-core-exercise"
      : "real-core-readonly"
    : "labelled-design-specimen",
  startedAt: new Date().toISOString(),
  results: [],
  browserErrors: [],
  limitations: [
    "Chromium checks do not verify a native Tauri/WebView2 window.",
    "Real approval and question flows require a harness request; this runner never fabricates or automatically approves one.",
  ],
};
await mkdir(output, { recursive: true });
let browser;
let page;
const record = (name, detail = {}) => report.results.push({ name, ...detail });
const read = async (path) => {
  const response = await page.request.get(new URL(`/api${path}`, base).href);
  assert.equal(response.ok(), true, `${path}: ${await response.text()}`);
  return response.json();
};
async function waitForAgent(id, predicate, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const detail = await read(`/agents/${id}`);
    if (
      detail.pending.some(
        (request) => !request.stale && !request.params._responseSent,
      )
    ) {
      record("real-pending-request", {
        methods: detail.pending.map((r) => r.method),
      });
      throw new Error(
        "Harness needs a response. Review the live GUI, then rerun acceptance; nothing was auto-approved.",
      );
    }
    if (predicate(detail)) return detail;
    // Durable turn intent briefly marks status uncertain before the native
    // start acknowledgement arrives. A recorded error fails immediately;
    // an unresolved intent still fails at the bounded timeout below.
    if (
      detail.agent.status === "error" ||
      (detail.agent.status === "uncertain" && detail.agent.error)
    )
      throw new Error(
        detail.agent.error || `Agent became ${detail.agent.status}`,
      );
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    "Timed out waiting for the real harness; this is not a passing model result.",
  );
}
try {
  browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    ...(process.env.YUZUNO_BROWSER_BIN
      ? { executablePath: process.env.YUZUNO_BROWSER_BIN }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  page = await context.newPage();
  page.on("pageerror", (error) => report.browserErrors.push(error.message));
  await page.goto(
    live
      ? new URL("/?shell=desktop", base).href
      : pathToFileURL(
          resolve(process.env.YUZUNO_UI_DIST || "dist", "design-preview.html"),
        ).href,
  );
  await page.locator(".toolbar-brand").waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (!live) {
    assert.match(await page.locator(".preview-strip").innerText(), /read-only/);
    for (const [width, height] of [
      [1440, 960],
      [1280, 800],
      [940, 650],
    ]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        composer: document
          .querySelector(".composer")
          ?.getBoundingClientRect()
          .toJSON(),
      }));
      assert.ok(
        layout.scrollWidth <= layout.width,
        `Horizontal overflow at ${width}px`,
      );
      assert.ok(
        layout.composer &&
          layout.composer.bottom <= height &&
          layout.composer.width > 280,
      );
      await page.screenshot({
        animations: "disabled",
        path: resolve(output, `specimen-${width}.png`),
      });
      record("specimen-layout", { width, height, layout });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({
      animations: "disabled",
      path: resolve(output, "specimen-create.png"),
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
    // Home replaced Catch up (T-85): the specimen shows its read-only Home.
    await page.getByRole("button", { name: /^Home/ }).click();
    await page.locator(".home-view .home-panel").waitFor();
    assert.match(
      await page.locator(".home-needs-you").innerText(),
      /Ship the onboarding copy today\?/,
    );
    await page.screenshot({
      animations: "disabled",
      path: resolve(output, "specimen-home.png"),
    });
    record("specimen-home");
  } else {
    const health = await read("/health");
    // The product, and the identifier desktop apps up to 0.2.0 require.
    assert.deepEqual([health.product, health.application], ["yuzuno", "yuzuno-next"]);
    await page.locator('.connection[data-core-status="Core connected"]').waitFor();
    await page.screenshot({
      animations: "disabled",
      path: resolve(output, "real-workspace.png"),
    });
    record("real-core-load");
    if (exercise) {
      const name = `Acceptance ${Date.now().toString(36)}`;
      await page
        .getByRole("button", { name: "Create agent", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      await dialog.getByLabel("Working folder").fill(cwd);
      await dialog
        .getByRole("button", { name: "Create agent", exact: true })
        .click();
      await page.getByRole("heading", { name, exact: true }).waitFor();
      const agent = (await read("/workspace")).agents.find(
        (a) => a.name === name,
      );
      assert.ok(agent);
      report.agentId = agent.id;
      record("create-through-gui", { agentId: agent.id });
      const marker = `YUZUNO_ACCEPTANCE_${agent.id}`;
      const prompt = `Work only in your current folder. Use a file-editing tool to create yuzuno-acceptance.md containing exactly "${marker}". Then run one harmless command that prints the file and deliberately exits with status 7; that exit is expected. In the final reply include the marker and a Markdown link to the file. No network, package installs, unrelated files, or extra tasks.`;
      await page.getByRole("textbox", { name: `Message ${name}` }).fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const detail = await waitForAgent(agent.id, (d) =>
        d.turns.some((turn) => turn.status === "completed"),
      );
      const turn = detail.turns.find((t) => t.status === "completed");
      const final = turn.items.find(
        (i) => i.type === "agentMessage" && i.phase === "final_answer",
      );
      assert.ok(
        final?.text.includes(marker),
        "No successful real model final containing the requested marker.",
      );
      assert.ok(
        turn.items.some(
          (i) => i.type === "commandExecution" && i.exitCode === 7,
        ),
        "Expected real tool error was not observed.",
      );
      await page
        .locator(".final-message")
        .filter({ hasText: marker })
        .waitFor();
      const turnView = page.locator(`[data-turn-id="${turn.id}"]`);
      const execution = turnView.locator("details.execution");
      await execution.locator(":scope > summary").click();
      const failedTool = execution.locator("details.tool-item").filter({
        has: page.locator(".tool-result", { hasText: "exit 7" }),
      });
      await failedTool.locator(":scope > summary").click();
      assert.ok(
        (await failedTool.locator(".tool-content").innerText()).includes(
          marker,
        ),
      );
      await page.screenshot({
        animations: "disabled",
        path: resolve(output, "real-execution.png"),
      });
      record("real-structured-execution-and-error-visible");
      await execution.locator(":scope > summary").click();
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(base).origin,
      });
      await page
        .getByRole("button", { name: "Copy reply", exact: true })
        .last()
        .click();
      assert.ok(
        (await page.evaluate(() => navigator.clipboard.readText())).includes(
          marker,
        ),
      );
      await page
        .getByRole("button", { name: "Copy turn", exact: true })
        .last()
        .click();
      assert.ok(
        (await page.evaluate(() => navigator.clipboard.readText())).includes(
          prompt,
        ),
      );
      record("real-task-tools-error-and-copy", { turnId: turn.id });
      await page
        .locator('.final-message a[href*="yuzuno-acceptance.md"]')
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByText(marker, { exact: false })
        .waitFor();
      await page.screenshot({
        animations: "disabled",
        path: resolve(output, "real-artifact.png"),
      });
      await page.getByRole("button", { name: "Close dialog" }).click();
      record("real-artifact-preview");
      await page.reload();
      await page.getByRole("heading", { name, exact: true }).waitFor();
      await page
        .locator(".final-message")
        .filter({ hasText: marker })
        .waitFor();
      record("gui-reopen-preserves-identity-and-turn", {
        agentId: agent.id,
        threadId: detail.agent.threadId,
      });
      await page
        .getByRole("textbox", { name: `Message ${name}` })
        .fill(
          "For the interrupt acceptance test, use your command tool to wait for 45 seconds, without touching files or starting background processes. Then reply WAIT_DONE.",
        );
      await page.getByRole("button", { name: "Send message" }).click();
      await waitForAgent(
        agent.id,
        (d) =>
          d.turns.some(
            (t) =>
              t.status === "inProgress" &&
              t.items.some((i) => i.type === "commandExecution"),
          ),
        90_000,
      );
      await page.keyboard.press("Escape");
      await waitForAgent(
        agent.id,
        (d) => d.turns.some((t) => t.status === "interrupted"),
        30_000,
      );
      await page
        .getByText("Turn interrupted · the conversation is still here.", {
          exact: true,
        })
        .waitFor();
      record("real-tool-interrupt-through-escape");
      await page.screenshot({
        animations: "disabled",
        path: resolve(output, "real-interrupted.png"),
      });
    }
  }
  assert.deepEqual(
    report.browserErrors,
    [],
    "Browser JavaScript errors occurred.",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed-or-blocked";
  report.error = error.stack || String(error);
  if (page)
    await page
      .screenshot({
        animations: "disabled",
        path: resolve(output, "failure.png"),
      })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  const path = resolve(
    output,
    `${live ? "real-core" : "specimen"}-report.json`,
  );
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${path}`);
}
