// Opt-in real Codex form acceptance: owned Core, database, browser and drafts only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(new URL("../..", import.meta.url).pathname);
const run =
  process.env.T38_RESUME_RUN ||
  resolve(root, "target/t38/native-" + Date.now());
assert.ok(run.startsWith(resolve(root, "target/t38/native-")));
await mkdir(run, { recursive: true });
const savedReport = process.env.T38_RESUME_RUN
  ? JSON.parse(await readFile(resolve(run, "report.json"), "utf8"))
  : null;
const project = resolve(run, "project");
await mkdir(project, { recursive: true });
const port = Number(process.env.T38_PORT || 4488);
assert.notEqual(port, 4317);
const base = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("YUZUNO_")),
);
env.YUZUNO_RESULT_VALIDATOR = resolve(
  root,
  "runtimes/result-validator/validator.mjs",
);
const log = await open(resolve(run, "core.log"), "w");
const core = spawn(
  resolve(root, "target/debug/yuzuno-workspace"),
  [
    "--port",
    String(port),
    "--data-dir",
    resolve(run, "data"),
    "--web-dir",
    resolve(root, "target/t38/ui"),
    "--cwd",
    project,
    "--codex",
    process.env.T38_CODEX || "codex",
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
  assert.equal(
    (await api("/workspace")).defaultCwd,
    project,
    "Only the owned isolated Core may be mutated",
  );
  const agent = savedReport
    ? (await api("/agents/" + savedReport.agentId + "/reconnect", {})).agent
    : await api("/agents", {
        name: "T38 form acceptance",
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
  let interrupts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/interrupt")) interrupts++;
  });
  await page.goto(base);
  const composer = page.locator("[data-composer-input]");
  await composer.waitFor();
  const { clarificationExample } =
    await import("../src/intelligent-ui/clarification.ts");
  const form = structuredClone(clarificationExample);
  form.fields[0].default.value = project;
  const spec = {
    root: "result",
    elements: {
      result: {
        type: "Result",
        props: {
          title: "Development preview",
          summary: "Confirm these three settings.",
        },
        children: ["form"],
      },
      form: { type: "Clarification", props: form },
    },
  };
  const finished = async (count) =>
    waitFor(async () => {
      const d = await api("/agents/" + agent.id);
      if (d.agent.status === "error" || d.pending.some((p) => !p.stale))
        throw Error(
          "Unexpected native error/approval: " +
            JSON.stringify({ status: d.agent.status, error: d.agent.error }),
        );
      return d.turns.length >= count &&
        d.turns[count - 1].status === "completed"
        ? d
        : false;
    }, 240000);
  if (!savedReport?.resultId) {
    await composer.fill(
      "This is an isolated clarification form acceptance test. Use the yuzuno result_publish tool to publish EXACTLY the spec below in this turn; use peers_list to obtain your yuzuno.activeTurnId if needed. Do not run commands or access files. After publication, finish with 'Form ready'. When I later submit answers, reply briefly with RECEIVED plus the exact directory, theme and checks values from that JSON. Spec: " +
        JSON.stringify(spec),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const first = await finished(1);
    report.resultId = first.turns[0]._yuzunoResults?.[0]?.id;
    assert.ok(
      report.resultId,
      "The real Agent must publish a stored result through MCP",
    );
    report.checks.push(
      "real Codex publishes the requested form through authenticated result_publish",
    );
  }
  const fields = () => page.locator(".clarification");
  await fields().waitFor();
  const submit = () =>
    fields().getByRole("button", { name: "Submit answers", exact: true });
  if (!savedReport?.received) {
    await fields().getByLabel("Working directory").fill("");
    await submit().click();
    await fields().getByText("Enter an answer.", { exact: true }).waitFor();
    await fields().getByLabel("Working directory").fill("MAPLE-482 中文");
    await fields().getByLabel("Dark", { exact: true }).check();
    await fields()
      .getByLabel("Keyboard and Chinese input", { exact: true })
      .check();
    await fields().getByLabel("Working directory").press("Escape");
    assert.equal(interrupts, 0);
    await page.reload();
    await fields().waitFor();
    assert.equal(
      await fields().getByLabel("Working directory").inputValue(),
      "MAPLE-482 中文",
    );
    assert.equal(
      await fields().getByLabel("Dark", { exact: true }).isChecked(),
      true,
    );
    report.checks.push(
      "required validation, Chinese answers, stable option IDs, Escape and reload retention",
    );
    for (const [theme, width] of [
      ["light", 1440],
      ["dark", 1440],
      ["dark", 1024],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "yuzuno.appearance",
            JSON.stringify({ theme, fontSize: 20, palette: "garden" }),
          ),
        theme,
      );
      await page.reload();
      await fields().waitFor();
      await fields().scrollIntoViewIfNeeded();
      const geometry = await fields().evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        fontSize: getComputedStyle(document.documentElement).fontSize,
      }));
      assert.ok(
        geometry.scroll <= geometry.width + 1,
        JSON.stringify(geometry),
      );
      report.layout ||= [];
      report.layout.push({ theme, width, ...geometry });
      await page.screenshot({
        path: resolve(run, `${theme}-${width}-20px.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await composer.fill("UNSENT composer draft");
    await page
      .getByLabel("Choose images")
      .setInputFiles(resolve(root, "acceptance/image-input/card-a.png"));
    await waitFor(
      async () =>
        (await page.locator(".composer .input-image-open").count()) === 1,
    );
    let reject = true,
      release,
      requests = 0;
    await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
      const body = route.request().postDataJSON();
      assert.equal(body.clarification.resultId, report.resultId);
      assert.equal(body.clarification.formId, form.id);
      assert.deepEqual(body.clarification.answers, {
        directory: "MAPLE-482 中文",
        theme: "dark",
        checks: ["keyboard"],
      });
      assert.equal(body.images, undefined);
      requests++;
      if (reject)
        return route.fulfill({
          json: {
            input: body,
            status: "rejected",
            turnId: null,
            error: "Injected definite rejection; draft retained",
          },
        });
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.continue();
    });
    await submit().click();
    await fields()
      .getByText("Injected definite rejection; draft retained", { exact: true })
      .waitFor();
    assert.equal(
      await fields().getByLabel("Working directory").inputValue(),
      "MAPLE-482 中文",
    );
    reject = false;
    await submit().evaluate((button) => {
      button.click();
      button.click();
    });
    await waitFor(async () => !!release);
    await composer.fill("UNSENT draft typed while form sends");
    release();
    await fields()
      .getByRole("button", { name: "Answers sent", exact: true })
      .waitFor();
    assert.equal(
      requests,
      2,
      "One rejected attempt and one actual send, no duplicate click",
    );
    const after = await finished(2);
    report.received = after.turns[1].items
      .filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join("\n");
    for (const text of ["RECEIVED", "MAPLE-482", "中文", "dark", "keyboard"])
      assert.ok(report.received.includes(text), report.received);
    report.receipt = after.messageReceipts.find(
      (r) => r.input.clarification?.resultId === report.resultId,
    );
    assert.equal(report.receipt.status, "accepted");
    const draft = await page.evaluate(
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
    );
    assert.equal(
      draft.parts.map((p) => p.text).join(""),
      "UNSENT draft typed while form sends",
    );
    assert.equal(draft.images.length, 1);
    report.checks.push(
      "explicit form submit reaches original Codex session with real accepted receipt and exact field IDs/answers",
    );
    report.checks.push(
      "definite rejection preserves draft; duplicate click sends once; composer text and images remain independent",
    );
  }
  await page.reload();
  await fields().waitFor();
  assert.equal(
    await fields()
      .getByRole("button", { name: "Answers sent", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await fields().getByLabel("Working directory").inputValue(),
    "MAPLE-482 中文",
  );
  report.checks.push(
    "refresh displays server-confirmed submitted values without resending",
  );
  assert.equal(interrupts, 0);
  assert.deepEqual(report.errors, []);
  report.result = "PASS";
} catch (error) {
  report.failure = String(error);
  throw error;
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
