// Controlled UI check (live.py stuck): the real Core, bridge and web, with
// fake-sdk.mjs reporting no prompt uuid and no origin. A prompt's turn then
// cannot be matched to its result. Shows the only exit the user has (Close,
// which ends the connection after the stop is not confirmed), that the old
// bridge process is gone, and that reopening the same session continues.
//   node acceptance/t20/stuck-ui.mjs
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4483";
const lab = join(here, "lab-fake");
const evidence = join(here, "evidence");
await mkdir(evidence, { recursive: true });
const state = JSON.parse(await readFile(join(lab, "state.json"), "utf8"));
const agent = state.agent;
const api = async (path) => (await fetch(`${base}/api${path}`)).json();
const detail = () => api(`/agents/${agent}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
const check = (name, ok, data) => {
  steps.push({ name, ok: !!ok, data });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(data).slice(0, 600)}`}`);
};
async function until(what, ready, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const d = await detail();
    if (ready(d)) return d;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what} :: ${JSON.stringify(d.agent)}`);
    await pause(250);
  }
}
/** The Core's bridge children (pid, start time), from /proc. */
async function bridges() {
  const found = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ");
      if (Number(fields[1]) === state.pid && cmd.includes("bridge.mjs")) found.push({ pid: Number(pid), starttime: fields[19], cmd });
    } catch { /* gone */ }
  }
  return found;
}
const alive = async ({ pid, starttime }) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === starttime;
  } catch { return false; }
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.click(`.agent-row[data-agent-id="${agent}"] .agent-select`);
  const composer = page.locator("[data-composer-input]");
  await composer.fill("T-20 controlled check: please reply.");
  await composer.press("Enter");
  // The fixture's reply arrives, but nothing names the prompt it answers.
  await page.waitForSelector(".native-turn-notice");
  const first = await until("the reply", (d) => d.turns.some((t) => t._yuzunoSource === "native" && t.status !== "inProgress"));
  const prompt = first.turns.find((t) => t.items.some((i) => i.type === "userMessage"));
  check("the unmatched reply is shown apart, labelled", (await page.locator(".native-turn-notice").first().textContent()) === "Claude output not matched to a message", null);
  check("the prompt's turn keeps running", prompt.status === "inProgress" && first.agent.status === "working", { status: prompt.status, agent: first.agent.status });
  await page.locator(".interrupt-button").click();
  await pause(3000);
  const interrupted = await detail();
  const stuck = interrupted.turns.find((t) => t.id === prompt.id);
  check("an acknowledged interrupt does not end it", stuck.status === "inProgress" && stuck.interruptRequested === true, stuck);
  await page.screenshot({ path: join(evidence, "stuck-before-close.png") });

  const owned = await bridges();
  check("one bridge process belongs to this connection", owned.length === 1, owned);
  await page.locator("button[aria-label='Close agent']").click();
  const dialog = page.getByRole("dialog");
  check("Close says what happens without a confirmed stop",
    /does not confirm the stop, closing ends its connection and marks that turn's result as unknown/.test(await dialog.textContent()), null);
  const closingStarted = Date.now();
  await dialog.getByRole("button", { name: "Interrupt & close" }).click();
  const closed = await until("the close", (d) => !!d.agent.closedAt, 40000);
  const ended = closed.turns.find((t) => t.id === prompt.id);
  check("the turn is kept as unknown, not completed", ended.status === "outcomeUnknown" && /不会重发/.test(ended.error?.message || ""), ended);
  check("the session is kept", closed.agent.claudeSessionId === first.agent.claudeSessionId, closed.agent.claudeSessionId);
  check("the connection's process has exited", !(await Promise.all(owned.map(alive))).some(Boolean) && (await bridges()).length === 0,
    { owned, now: await bridges() });
  const explained = page.locator(`article[data-turn-id="${prompt.id}"] .inline-error`);
  await explained.waitFor();
  check("the turn says its result is unknown, readably", /^Claude 未确认停止/.test(await explained.textContent()), await explained.textContent());
  await page.screenshot({ path: join(evidence, "stuck-closed.png") });

  // The same session goes on, here with a producer that names its prompts.
  await writeFile(join(lab, "mode"), "stamped\n");
  await page.locator("button[aria-label='Reopen agent']").click();
  const reopened = await until("the reopen", (d) => !d.agent.closedAt && d.agent.connectionState === "connected", 40000);
  check("reopening resumes the same session", reopened.agent.claudeSessionId === first.agent.claudeSessionId, reopened.agent);
  const fresh = await bridges();
  check("a new bridge process serves it", fresh.length === 1 && fresh[0].pid !== owned[0].pid, fresh);
  await composer.fill("T-20 controlled check: continue after reopening.");
  await composer.press("Enter");
  const done = await until("the next reply", (d) => d.agent.status === "idle"
    && d.turns.filter((t) => t.items.some((i) => i.type === "userMessage")).length === 2);
  const next = done.turns.filter((t) => t.items.some((i) => i.type === "userMessage")).at(-1);
  check("the next message is answered in its own turn", next.status === "completed"
    && next.items.some((i) => i.type === "agentMessage" && /Fixture reply \(stamped\)/.test(i.text || "")), next);
  check("nothing was sent again", done.turns.filter((t) => t.items.some((i) => i.type === "userMessage"
    && /please reply/.test(JSON.stringify(i.content)))).length === 1, null);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(evidence, "stuck-reopened.png") });
  check("closing took the stop wait, not longer", Date.now() - closingStarted < 60000, Date.now() - closingStarted);
  check("no page errors", errors.length === 0, errors);
  await context.close();
} finally {
  await browser.close();
  await writeFile(join(evidence, "stuck-ui.json"), JSON.stringify({ agent, steps, errors }, null, 2));
}
if (steps.some((step) => !step.ok)) process.exit(1);
