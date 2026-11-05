// T-45 in Chromium against an isolated lab Core with a scripted Claude bridge (fake_claude.py): no model, no
// CLI, no login, never port 4317. Claude runs a turn of its own, as after a background task's notice. While it
// runs, the composer offers "Add a thought" and "Send while working"; a message sent goes to that turn, is shown
// there marked not read yet, and the mark goes once Claude names it in that same turn. Desktop, 1440×900.
// Chromium is not Safari.
//   node acceptance/t45-native-followup/browser.mjs --core BIN --web DIST --run /var/tmp/<short> --out DIR [--port 4545]
// --run holds the lab's data, task folder, home and the bridge's log; the report and screenshots go to --out.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../web/tools/browser-engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : [])));
const port = Number(args.port || 4545);
if (port === 4317) throw new Error("never 4317");
const [core, web, run, out] = ["core", "web", "run", "out"].map((key) => {
  if (!args[key]) throw new Error(`--${key} is required`);
  return resolve(args[key]);
});
const native = `${run}/native`;
for (const dir of [`${run}/data`, `${run}/task`, `${run}/home`, native, out]) await mkdir(dir, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { core, web, port, checks: [], writes: [], pageErrors: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) throw new Error(name);
};
const NATIVE = "native-wake";
const text = "Also check the CI run before you reply.";

// Only what this lab sets: nothing of the shell's Core (YUZUNO_*) or the user's home reaches it.
const coreLog = [];
const lab = spawn(core, ["--port", String(port), "--data-dir", `${run}/data`, "--web-dir", web, "--cwd", `${run}/task`], {
  env: { HOME: `${run}/home`, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", YUZUNO_NODE: "python3",
    YUZUNO_CLAUDE_BRIDGE: `${HERE}/fake_claude.py`, T45_STATE: native },
  stdio: ["ignore", "pipe", "pipe"],
});
lab.stdout.on("data", (d) => coreLog.push(String(d)));
lab.stderr.on("data", (d) => coreLog.push(String(d)));
process.on("exit", () => lab.kill("SIGKILL"));
const direct = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : {};
};
const until = async (what, test, ms = 20000) => {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(100)) {
    const value = await test().catch(() => null);
    if (value) return value;
  }
  throw new Error(`timed out: ${what}`);
};
const calls = async () => (await readFile(`${native}/calls.jsonl`, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

let browser;
let failed = null;
try {
  await until("Core answers", () => direct("GET", "/api/health"));
  const agent = (await direct("POST", "/api/agents", { name: "Mori", cwd: `${run}/task`, harness: "claude", model: "bench" })).id;
  await direct("POST", `/api/agents/${agent}/reconnect`).catch(() => {});
  await until("the Agent connects", async () => (await direct("GET", `/api/agents/${agent}`)).agent.connectionState === "connected");
  await writeFile(`${native}/wake`, "");
  const running = await until("Claude's own turn runs", async () => {
    const d = await direct("GET", `/api/agents/${agent}`);
    return d.turns.some((t) => t.id === NATIVE && t.status === "inProgress") && d.agent.status === "working" && d;
  });
  check("Core shows a running turn of Claude's own, and nothing of ours", running.turns.length === 1 && running.turns[0]._yuzunoSource === "native",
    running.turns.map((t) => [t.id, t.status, t._yuzunoSource]));

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const posted = [];
  page.on("request", (r) => {
    if (r.method() === "GET") return;
    report.writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    if (new URL(r.url()).pathname === `/api/agents/${agent}/messages`) posted.push(JSON.parse(r.postData() || "{}"));
  });
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/?shell=desktop`);
  const open = page.locator('.agent-row .agent-select[aria-label="Open Mori"]');
  await open.waitFor();
  await open.click();
  const turn = page.locator(`.conversation-scroll [data-turn-id="${NATIVE}"]`);
  await turn.locator(".native-turn-notice").waitFor();
  const composer = page.locator('[data-composer-input][aria-label="Message Mori"]');
  check("the turn shows as Claude's own", /Claude continued on its own/.test(await turn.locator(".native-turn-notice").innerText()));
  check("the composer offers a thought while it works", (await composer.getAttribute("aria-placeholder")) === "Add a thought while your agent works…",
    await composer.getAttribute("aria-placeholder"));
  await page.screenshot({ path: `${out}/1-claude-on-its-own.png` });

  await composer.click();
  await page.keyboard.type(text);
  const send = page.locator('[aria-label="Send while working"]');
  check("Send while working is offered", (await send.count()) === 1 && !(await send.isDisabled()));
  await send.click();
  await until("the message is posted", async () => posted.length === 1);
  check("it is sent as a follow-up to Claude's own turn", posted[0].expectedTurnId === NATIVE && posted[0].text === text, posted);
  const item = `[data-item-id="${NATIVE}:${posted[0].clientMessageId}"]`;
  const mine = turn.locator(item);
  await mine.locator(".message-delivery").waitFor();
  const mark = await mine.locator(".message-delivery").innerText();
  check("it shows in that turn, as yours, marked not read yet", /not read yet/.test(mark) && /You/.test(await mine.innerText()), { mark });
  const sent = await calls();
  check("the bridge got one append to that turn and no prompt",
    sent.filter((c) => c.op === "append").length === 1 && sent.find((c) => c.op === "append").expectedTurnId === NATIVE
      && !sent.some((c) => c.op === "send"), sent.filter((c) => ["append", "send"].includes(c.op)));
  check("the draft is cleared", (await composer.innerText()).trim() === "");
  await page.screenshot({ path: `${out}/2-sent-not-read.png` });

  await writeFile(`${native}/read`, "");
  await mine.locator(".message-delivery").waitFor({ state: "detached" });
  await turn.getByText(`Noted: ${text}`).waitFor();
  check("Claude names it in the same turn: the mark goes, its answer follows there",
    (await page.locator(`.conversation-scroll ${item}`).count()) === 1 && (await mine.count()) === 1);
  const done = await until("the turn ends", async () => {
    const d = await direct("GET", `/api/agents/${agent}`);
    return d.turns.find((t) => t.id === NATIVE)?.status === "completed" && d;
  });
  const receipt = done.messageReceipts.find((r) => r.input.clientMessageId === posted[0].clientMessageId);
  check("Core: one turn, the message read in it, its receipt accepted there",
    done.turns.length === 1 && done.turns[0].items.filter((i) => i.clientId === posted[0].clientMessageId).length === 1
      && receipt?.status === "accepted" && receipt?.turnId === NATIVE,
    { turns: done.turns.map((t) => [t.id, t.status]), receipt });
  await page.screenshot({ path: `${out}/3-read-in-that-turn.png` });
  check("no page errors", report.pageErrors.length === 0, report.pageErrors);
} catch (error) {
  failed = String(error?.stack || error);
  console.log(`FAIL ${failed}`);
} finally {
  await browser?.close().catch(() => {});
  lab.kill("SIGINT");
  await Promise.race([new Promise((done) => lab.once("exit", done)), sleep(10000)]);
  report.bridgeCalls = await calls();
  report.failed = failed;
  report.passed = !failed && report.checks.every((c) => c.ok);
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${out}/core.log`, coreLog.join(""));
  console.log(`${report.passed ? "PASS" : "FAIL"}: ${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks`);
  process.exitCode = report.passed ? 0 : 1;
}
