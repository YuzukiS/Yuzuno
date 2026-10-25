// Opt-in real Codex acceptance. Own Core, DB, browser and self-authored images only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(new URL("../..", import.meta.url).pathname);
const run =
  process.env.T31_RESUME_RUN ||
  resolve(root, "target/t31/native-" + Date.now());
assert.ok(run.startsWith(resolve(root, "target/t31/native-")));
await mkdir(run, { recursive: true });
const savedReport = process.env.T31_RESUME_RUN
  ? JSON.parse(await readFile(resolve(run, "report.json"), "utf8"))
  : null;
const project = resolve(run, "project");
await mkdir(project, { recursive: true });
const port = Number(process.env.T31_PORT || 4487);
assert.notEqual(port, 4317);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env };
delete env.YUZUNO_INSTALL_DIR;
const log = await open(resolve(run, "core.log"), "w");
const core = spawn(
  resolve(root, "target/debug/yuzuno-workspace"),
  [
    "--port",
    String(port),
    "--data-dir",
    resolve(run, "data"),
    "--web-dir",
    resolve(root, "target/t31/ui"),
    "--cwd",
    project,
    "--codex",
    process.env.T31_CODEX || "codex",
  ],
  { cwd: root, env, stdio: ["ignore", log.fd, log.fd] },
);
let browser;
const report = savedReport || { run, port, checks: [], errors: [] };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body) {
  const r = await fetch(base + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-yuzuno-client": "desktop",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw Error(JSON.stringify(data));
  return data;
}
async function waitFor(fn, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(400);
  }
  throw Error("acceptance deadline");
}
try {
  await waitFor(async () => {
    if (core.exitCode !== null) throw Error("test Core exited");
    try {
      return await api("/health");
    } catch {
      return false;
    }
  }, 20000);
  const agent = savedReport
    ? (await api("/agents/" + savedReport.agentId + "/reconnect", {})).agent
    : await api("/agents", {
        name: "T31 image acceptance",
        cwd: project,
        model: "",
      });
  report.agentId = agent.id;
  const ready = await waitFor(async () => {
    const d = await api("/agents/" + agent.id);
    if (d.agent.status === "error") throw Error(d.agent.error);
    return d.agent.connectionState === "connected" ? d : false;
  });
  report.model = ready.agent.model;
  const catalog = await api(`/agents/${agent.id}/models`);
  const model = catalog.models.find(
    (m) => m.model === report.model || m.id === report.model,
  );
  report.inputModalities = model?.inputModalities || ["text", "image"];
  assert.ok(report.inputModalities.includes("image"));
  // Keep the model; choose its lowest available reasoning effort for this tiny visual check.
  const effort = model?.supportedReasoningEfforts?.find(
    (e) => e.reasoningEffort === "low",
  )?.reasoningEffort;
  if (effort)
    await api(`/agents/${agent.id}/settings`, {
      model: report.model,
      settings: { ...ready.agent.settings, reasoningEffort: effort },
    });
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(
    (id) => localStorage.setItem("yuzuno.selected", id),
    agent.id,
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(base);
  const input = page.locator("[data-composer-input]");
  await input.waitFor();
  const answer = (d) =>
    d.turns
      .at(-1)
      .items.filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join("\n");
  const finished = async (n) =>
    waitFor(async () => {
      const d = await api("/agents/" + agent.id);
      if (d.agent.status === "error" || d.pending.some((p) => !p.stale))
        throw Error(
          "native failed or unexpectedly requested permission: " +
            JSON.stringify({
              status: d.agent.status,
              error: d.agent.error,
              pending: d.pending.map((p) => p.method),
            }),
        );
      return d.turns.length >= n && d.turns[n - 1].status === "completed"
        ? d
        : false;
    }, 180000);
  if (!savedReport?.firstAnswer) {
    await page
      .getByLabel("Choose images")
      .setInputFiles([
        resolve(root, "acceptance/image-input/card-a.png"),
        resolve(root, "acceptance/image-input/card-b.png"),
      ]);
    await waitFor(
      async () =>
        (await page.locator(".composer .input-image-open").count()) === 2,
    );
    await input.fill(
      "This is a visual input acceptance test. Without using any tools, read the exact large text and describe the colored shape in each attached image, in attachment order. For the next message, also describe its image even if it has no text. Keep each answer brief.",
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const first = await finished(1);

    report.firstAnswer = answer(first);
    assert.match(report.firstAnswer, /ORBIT.?731/i);
    assert.match(report.firstAnswer, /IMAGE.?ONLY.?928/i);
    assert.match(report.firstAnswer, /red|红/i);
    assert.match(report.firstAnswer, /blue|蓝/i);
    const user = first.turns[0].items.find((i) => i.type === "userMessage");
    report.nativeContent = user.content.map((i) => ({
      type: i.type,
      ...(i.path ? { filename: i.path.split("/").pop() } : {}),
    }));
    assert.equal(user.content.filter((i) => i.type === "localImage").length, 2);
    report.checks.push(
      "real UI uploads two PNGs and Codex reads both labels and colors through localImage",
    );
  }
  await waitFor(
    async () =>
      !(await page
        .getByRole("button", { name: "Send message", exact: true })
        .isEnabled()),
  );
  if (!savedReport?.secondAnswer) {
    await page
      .getByLabel("Choose images")
      .setInputFiles(resolve(root, "acceptance/image-input/card-b.png"));
    await waitFor(
      async () =>
        (await page.locator(".composer .input-image-open").count()) === 1,
    );
    assert.ok(
      await page.evaluate(
        (id) => {
          // A draft is saved under the Workspace and the Agent (T-195); this
          // page is in one Workspace, so the key is the one naming this Agent.
          const prefix = "yuzuno.composer.v1:";
          for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith(prefix)) continue;
            let parsed;
            try {
              parsed = JSON.parse(key.slice(prefix.length));
            } catch {
              continue;
            }
            if (Array.isArray(parsed) && parsed.length === 2 && parsed[1] === id)
              return JSON.parse(localStorage.getItem(key) || "null");
          }
          return null;
        },
        agent.id,
      ).then((draft) => !(draft?.parts || []).some((p) => p.text?.trim())),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const second = await finished(2);
    report.secondAnswer = answer(second);
    assert.match(report.secondAnswer, /IMAGE.?ONLY.?928/i);
    report.checks.push("real image-only UI send recognized by Codex");
  }
  await page.reload();
  await input.waitFor();
  await waitFor(
    async () =>
      (await page.locator(".user-message .input-image-open").count()) === 3,
  );
  await page.locator(".user-message .input-image-open").first().click();
  await page.waitForFunction(() => {
    const image = document.querySelector(
      "[role=dialog] .input-image-dialog img",
    );
    return image?.complete && image.naturalWidth === 640;
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"]')).opacity === "1");
  await page.screenshot({ path: resolve(run, "native-image-preview.png") });
  await page.keyboard.press("Escape");
  report.checks.push(
    "reload preserves three native image references and full image preview",
  );
  report.finalReviewedSeq = (
    await api("/agents/" + agent.id)
  ).agent.reviewedSeq;
  report.checks = [...new Set(report.checks)];
  assert.deepEqual(report.errors, []);
  report.result = "PASS";
} finally {
  if (browser) await browser.close();
  core.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => core.once("exit", resolve)),
    delay(15000),
  ]);
  report.coreExit = core.exitCode;
  report.coreStopped = core.exitCode !== null;
  await log.close();
  await writeFile(resolve(run, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
