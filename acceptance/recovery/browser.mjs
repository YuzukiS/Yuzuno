// T-15 in Chromium against the lab Core (lab.py start). Codex in the light
// theme, Claude in the dark theme at 20 px: the notice, a held send, a failed
// reconnect with its reason, keyboard use, one request per (double) click,
// recovery in the same session, the draft kept and nothing sent again.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/t15/lab");
const shots = path.join(lab, "browser");
await mkdir(shots, { recursive: true });
const state = JSON.parse(await readFile(path.join(lab, "lab.json"), "utf8"));
const failMarker = path.join(lab, "native/fail_resume");
const report = { checks: [], writes: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail: structuredClone(detail) }) });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};
const reconnects = (id) => report.writes.filter((w) => w === `POST /api/agents/${id}/reconnect`).length;
const draft = "A draft written before reconnecting; it must stay.";

async function open(browser, agentId, appearance) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("request", (r) => r.method() !== "GET" && report.writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.addInitScript(([id, look]) => {
    localStorage.setItem("yuzuno.selected", JSON.stringify(id));
    if (look) localStorage.setItem("yuzuno.appearance", JSON.stringify(look));
  }, [agentId, appearance]);
  await page.goto(`${state.base}/?shell=desktop`);
  return page;
}

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  // Codex, light theme.
  let page = await open(browser, state.codex);
  const notice = page.locator(".recovery-notice");
  await notice.getByText("still running when this agent’s connection ended", { exact: false }).waitFor();
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill(draft);
  const send = page.getByRole("button", { name: /Send/ });
  check("Codex: the notice offers Reconnect and check; send is held with the reason",
    (await notice.getByRole("button", { name: "Reconnect and check" }).count()) === 1 && (await send.isDisabled())
      && (await page.getByText("Reconnect above to check the last turn; your draft is kept").count()) === 1,
    { notice: await notice.innerText() });
  await composer.press("Enter");
  await page.waitForTimeout(400);
  check("Codex: Enter sends nothing while the result is unconfirmed", !report.writes.some((w) => /\/(messages|turns)$/.test(w)), report.writes);
  await page.screenshot({ path: path.join(shots, "1-codex-notice-light.png") });

  // A failed reconnect, used from the keyboard.
  await writeFile(failMarker, "");
  await notice.getByRole("button", { name: "Reconnect and check" }).focus();
  await page.keyboard.press("Enter");
  await notice.getByRole("alert").waitFor();
  const failure = await notice.getByRole("alert").innerText();
  check("Codex: a failed reconnect says why and offers Try again; one request",
    /Couldn’t reconnect: .*native session store is busy/.test(failure) && reconnects(state.codex) === 1
      && (await notice.getByRole("button", { name: "Try again" }).count()) === 1, { failure });
  await page.screenshot({ path: path.join(shots, "2-codex-failed-light.png") });

  // A double-clicked retry: one request, then Core's check unlocks input.
  await rm(failMarker);
  const retry = notice.getByRole("button", { name: "Try again" });
  await retry.click();
  await retry.click({ force: true, timeout: 500 }).catch(() => {});
  await notice.waitFor({ state: "detached", timeout: 30000 });
  // In the conversation itself (the rail and inspector quote it too).
  await page.getByText("Finished while Core was away.", { exact: true }).first().waitFor();
  check("Codex: one request for the double click; the same session reports its real result",
    reconnects(state.codex) === 2, { writes: report.writes });
  check("Codex: the draft is kept and sending is open again", (await composer.inputValue()) === draft && !(await send.isDisabled()));
  await page.screenshot({ path: path.join(shots, "3-codex-recovered-light.png") });
  await page.close();

  // Claude, dark theme at 20 px.
  page = await open(browser, state.claude, { theme: "dark", fontSize: 20 });
  const claudeNotice = page.locator(".recovery-notice");
  await claudeNotice.getByText("still running when this agent’s connection ended", { exact: false }).waitFor();
  const look = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
    body: getComputedStyle(document.querySelector(".prose") || document.body).fontSize,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
  const claudeComposer = page.getByRole("textbox", { name: /^Message / });
  await claudeComposer.fill(draft);
  check("Claude: the notice shows in the dark theme at 20 px without overflow", look.theme === "dark" && !look.overflow, look);
  await page.screenshot({ path: path.join(shots, "4-claude-notice-dark-20px.png") });
  const button = claudeNotice.getByRole("button", { name: "Reconnect and check" });
  await button.click();
  await button.click({ force: true, timeout: 500 }).catch(() => {});
  await claudeNotice.waitFor({ state: "detached", timeout: 30000 });
  check("Claude: one request; reconnected in the same session; the draft is kept",
    reconnects(state.claude) === 1 && (await claudeComposer.inputValue()) === draft, { writes: report.writes });
  await page.screenshot({ path: path.join(shots, "5-claude-recovered-dark-20px.png") });
  check("nothing was sent", !report.writes.some((w) => /\/(messages|turns)$/.test(w)), report.writes);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.message || error);
} finally {
  await browser.close();
  await rm(failMarker, { force: true });
  await writeFile(path.join(lab, "browser-report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${report.checks.length} checks; writes ${JSON.stringify(report.writes)}${report.error ? `; ${report.error}` : ""}`);
}
